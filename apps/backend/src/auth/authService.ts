/**
 * Backend Auth Service.
 *
 * Source:
 *   • design.md → "Auth Service" → `validateApiKey`, `createLocalSession`.
 *   • requirements.md → Requirements 2.2, 2.3, 2.4, 2.5, 2.8, 4.2, 4.3, 4.5.
 *
 * Tasks 4.1 and 4.2 ship the API-key login portion of `AuthService`:
 *
 *   • {@link AuthService.validateApiKey}     — performs a lightweight
 *     test request against the Provider for the supplied API key and
 *     returns a structured {@link ValidationResult} (Requirements 2.2,
 *     2.3, 4.2, 4.3).
 *   • {@link AuthService.createLocalSession} — gates secret persistence
 *     behind an explicit `confirmedByUser: true` payload (Requirement
 *     2.5), forwards plaintext exactly once to a {@link LocalApiKeySink}
 *     for encrypted persistence via the Desktop Shell's Local Encrypted
 *     Storage (Requirement 4.5), and returns a {@link Session} of kind
 *     `local` that NEVER includes the API key (Requirement 2.5).
 *     Local-only scope is implied by the session shape — there is no
 *     `userId` and no cloud sync hook here, which honors Requirement 2.8
 *     ("never sync API_Key to cloud without explicit user confirmation").
 *
 * Probes are pluggable via {@link ProviderProbe} so the service is
 * unit-testable without touching the network and so additional
 * providers (beyond OpenAI and Anthropic) can be added without
 * touching this file. Persistence is pluggable via {@link LocalApiKeySink}
 * for the same reasons — the Auth Service never sees ciphertext.
 *
 * Subsequent tasks (4.3, 17.x) extend this class with OAuth flows and
 * session upgrade.
 *
 * Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.8, 4.2, 4.3, 4.5.
 */

import type { ProviderId, Session } from "@ai-agent-orchestrator/shared-core";

import {
  LocalSessionError,
  type CreateLocalSessionInput,
  type LocalApiKeySink,
  type ProviderProbe,
  type ValidationResult,
} from "./types.js";

/** Optional clock dependency, primarily for deterministic tests. */
export interface AuthClock {
  now(): Date;
}

const systemAuthClock: AuthClock = {
  now: () => new Date(),
};

/** Optional session-id source, primarily for deterministic tests. */
export interface SessionIdSource {
  next(): string;
}

const defaultSessionIdSource: SessionIdSource = {
  next: () => {
    // `crypto.randomUUID` is available on Node ≥ 19 and in the Tauri
    // WebView runtime. Falling back to a timestamp-suffixed counter is
    // deliberately avoided: a non-unique session id would silently
    // collide across local sessions and we'd rather fail loudly.
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      throw new Error(
        "AuthService requires globalThis.crypto.randomUUID for session ids. " +
          "Pass `sessionIdSource` in AuthServiceOptions on hosts without it.",
      );
    }
    return globalThis.crypto.randomUUID();
  },
};

/**
 * Constructor options for {@link AuthService}.
 */
export interface AuthServiceOptions {
  /**
   * Pluggable per-Provider probes. Order is not significant — the
   * service routes by `provider` ID, not position.
   *
   * Production composition wires `OpenAiProbe`, `AnthropicProbe` and any
   * configured `GenericProbe` instances. Tests pass stubs.
   */
  readonly probes: readonly ProviderProbe[];
  /**
   * Sink used by {@link AuthService.createLocalSession} to persist the
   * supplied API key in Local Encrypted Storage. Optional at construction
   * time so deployments that only need `validateApiKey` (e.g. an early
   * gateway bring-up before storage exists) can skip it; calls to
   * `createLocalSession` will then fail with `LocalSessionError` code
   * `"storage_failed"` so the wiring problem is loud rather than silent.
   */
  readonly localApiKeySink?: LocalApiKeySink;
  /** Clock injection point. Defaults to the system clock. */
  readonly clock?: AuthClock;
  /** Session-id source. Defaults to `crypto.randomUUID()`. */
  readonly sessionIdSource?: SessionIdSource;
}

/**
 * Backend Auth Service.
 *
 * Tasks 4.1 and 4.2: implements `validateApiKey` and `createLocalSession`.
 * The class is sealed-ish (no inheritance assumptions) and free of any
 * direct HTTP, storage or cipher access — those concerns live in the
 * injected probes (for validation) and in the {@link LocalApiKeySink}
 * (for persistence). The Settings_Store / Desktop Shell wiring composes
 * the sink in production.
 */
export class AuthService {
  private readonly probesByProvider: Map<ProviderId, ProviderProbe>;
  private readonly localApiKeySink: LocalApiKeySink | undefined;
  private readonly clock: AuthClock;
  private readonly sessionIdSource: SessionIdSource;

  public constructor(options: AuthServiceOptions) {
    if (options.probes.length === 0) {
      // The service is technically callable with zero probes — every
      // call would just return a "no probe configured" error — but this
      // is almost certainly a wiring bug, so flag it loudly at startup.
      // Same defensive pattern as ModelCatalog.
      throw new Error("AuthService requires at least one ProviderProbe");
    }
    const map = new Map<ProviderId, ProviderProbe>();
    for (const probe of options.probes) {
      if (map.has(probe.provider)) {
        throw new Error(
          `AuthService received duplicate probe for provider "${probe.provider}"`,
        );
      }
      map.set(probe.provider, probe);
    }
    this.probesByProvider = map;
    this.localApiKeySink = options.localApiKeySink;
    this.clock = options.clock ?? systemAuthClock;
    this.sessionIdSource = options.sessionIdSource ?? defaultSessionIdSource;
  }

  /**
   * Validates `input.apiKey` for `input.provider` by issuing a
   * lightweight authenticated test request.
   *
   * Behaviour:
   *
   *   • Empty or whitespace-only `apiKey` → `kind: "error"` with code
   *     `"invalid_api_key"`. Catches obvious UI bugs without making a
   *     network call.
   *   • Unknown `provider` (no probe registered) → `kind: "error"` with
   *     code `"unsupported_provider"`. Lets the UI render a clear
   *     "configure this Provider first" message rather than a generic
   *     network failure.
   *   • Any unexpected exception thrown by a probe → `kind: "error"`
   *     with code `"unexpected_error"`. Probes are documented not to
   *     throw, but defence-in-depth ensures Requirement 2.3 ("reject
   *     login on auth failure") never relies on probe correctness.
   *
   * Validates: Requirements 2.2, 2.3, 4.2, 4.3.
   */
  public async validateApiKey(input: {
    readonly provider: ProviderId;
    readonly apiKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ValidationResult> {
    if (input.apiKey.trim().length === 0) {
      return {
        kind: "error",
        providerCode: "invalid_api_key",
        providerMessage: "API key is empty",
      };
    }

    const probe = this.probesByProvider.get(input.provider);
    if (!probe) {
      return {
        kind: "error",
        providerCode: "unsupported_provider",
        providerMessage: `No validator is configured for provider "${input.provider}"`,
      };
    }

    try {
      const probeInput: Parameters<ProviderProbe["probe"]>[0] = {
        apiKey: input.apiKey,
      };
      if (input.signal) {
        // Forward caller cancellation only when present so probe
        // adapters that don't accept `signal` still work cleanly.
        return await probe.probe({ ...probeInput, signal: input.signal });
      }
      return await probe.probe(probeInput);
    } catch (err: unknown) {
      // Adapters are documented not to throw, but if one does we still
      // honour the "reject on auth failure" requirement instead of
      // bubbling the exception to the gateway.
      return {
        kind: "error",
        providerCode: "unexpected_error",
        providerMessage: describeError(err),
      };
    }
  }

  /**
   * Creates a local-only Session and persists `input.apiKey` in Local
   * Encrypted Storage as a side effect.
   *
   * Behaviour, in order:
   *
   *   1. Confirmation gate (Requirement 2.5, 2.8): if `confirmedByUser`
   *      is not the literal `true`, the call rejects with
   *      {@link LocalSessionError} `"missing_confirmation"` BEFORE any
   *      sink interaction. The literal-`true` type also catches the
   *      same mistake at compile time for TS callers; the runtime check
   *      protects JS callers and any future RPC unmarshalling.
   *   2. Structural input validation (Requirement 4.2 hygiene): empty
   *      or non-string `deviceId`, `provider`, or `apiKey` rejects with
   *      `"invalid_input"`. The Provider-side validity of the key is
   *      already covered by `validateApiKey`; here we only catch
   *      obvious wiring bugs that would otherwise persist garbage.
   *   3. Persistence (Requirement 4.5): `apiKey` is forwarded EXACTLY
   *      ONCE to the configured {@link LocalApiKeySink}. The sink
   *      encrypts and persists via the Desktop Shell's Local Encrypted
   *      Storage. Auth never sees ciphertext, never logs the plaintext,
   *      and never retains it past this method's stack frame. Sink
   *      failures rewrap as `"storage_failed"` so callers can show a
   *      "couldn't save your key" message without leaking internals.
   *   4. Session minting (Requirement 2.5): returns a `Session` of
   *      kind `"local"` with a fresh id and `deviceId` from the input.
   *      `userId` is intentionally absent — there is no Gmail account
   *      attached. The session response intentionally has NO field
   *      that could carry the API key, so the Requirement-2.5 invariant
   *      ("API_Key must never be included in Session response") holds
   *      structurally.
   *
   * Errors thrown:
   *
   *   • {@link LocalSessionError} with `code = "missing_confirmation"` |
   *     `"invalid_input"` | `"storage_failed"`. No other error type is
   *     thrown by this method; callers can handle the gateway response
   *     by switching on `code`.
   *
   * Validates: Requirements 2.4, 2.5, 2.8, 4.5.
   */
  public async createLocalSession(
    input: CreateLocalSessionInput,
  ): Promise<Session> {
    // 1. Confirmation gate. Use a strict `=== true` check so any other
    //    truthy value (1, "true", a non-empty object) is also rejected
    //    — the design rule is "explicit user confirmation", not "any
    //    truthy proxy for confirmation".
    if ((input as { confirmedByUser: unknown }).confirmedByUser !== true) {
      throw new LocalSessionError(
        "missing_confirmation",
        "createLocalSession requires confirmedByUser === true.",
      );
    }

    // 2. Structural input validation. Trimmed-empty values count as
    //    empty for `deviceId` and `provider`; for `apiKey` we only
    //    reject the empty string itself — leading/trailing whitespace
    //    is technically valid for some Provider key formats and it's
    //    not Auth's job to second-guess `validateApiKey`'s upstream
    //    decision.
    if (
      typeof input.deviceId !== "string" ||
      input.deviceId.trim().length === 0
    ) {
      throw new LocalSessionError(
        "invalid_input",
        "createLocalSession: deviceId must be a non-empty string.",
      );
    }
    if (
      typeof input.provider !== "string" ||
      input.provider.trim().length === 0
    ) {
      throw new LocalSessionError(
        "invalid_input",
        "createLocalSession: provider must be a non-empty string.",
      );
    }
    if (typeof input.apiKey !== "string" || input.apiKey.length === 0) {
      throw new LocalSessionError(
        "invalid_input",
        "createLocalSession: apiKey must be a non-empty string.",
      );
    }

    // 3. Persistence. The sink is the only path through which plaintext
    //    leaves this method; we never copy it into a local field, log
    //    it, or include it in the Session.
    if (this.localApiKeySink === undefined) {
      throw new LocalSessionError(
        "storage_failed",
        "createLocalSession: no LocalApiKeySink is configured on AuthService.",
      );
    }
    try {
      await this.localApiKeySink.persistApiKey({
        deviceId: input.deviceId,
        provider: input.provider,
        apiKey: input.apiKey,
      });
    } catch (cause) {
      // Carefully avoid embedding `input.apiKey` into the message —
      // `describeError` only ever inspects `Error.message`, which is
      // produced by the sink (not by Auth) and which the sink contract
      // forbids from carrying the plaintext.
      throw new LocalSessionError(
        "storage_failed",
        `createLocalSession: failed to persist API key locally: ${describeError(cause)}`,
        cause,
      );
    }

    // 4. Mint a local-only Session. The shape mirrors design.md →
    //    "Auth Service" → `Session`. `userId` is omitted because this
    //    is a local-only session; `expiresAt` is omitted because local
    //    sessions on the user's own device do not expire on the auth
    //    side (the shell can revoke by deleting the encrypted blob).
    const session: Session = {
      id: this.sessionIdSource.next(),
      kind: "local",
      deviceId: input.deviceId,
      createdAt: this.clock.now().toISOString(),
    };
    return session;
  }
}

/** Renders an unknown error value as a short, key-free string. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message =
      err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return message.length > 0 ? message : err.name;
  }
  if (typeof err === "string") {
    return err;
  }
  return "unknown error";
}
