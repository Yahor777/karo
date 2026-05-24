/**
 * Public types and ports for the backend Auth Service module.
 *
 * Source:
 *   • design.md → "Auth Service" → `validateApiKey`, `createLocalSession`,
 *     `ValidationResult`, `Session`.
 *   • requirements.md → Requirements 2.2, 2.3, 2.4, 2.5, 2.8, 4.2, 4.3, 4.5.
 *
 * This module owns:
 *
 *   • {@link ValidationResult} — discriminated union mirroring
 *     `ValidationResult` in design.md verbatim. Callers MUST handle
 *     both `kind: "ok"` and `kind: "error"` branches; treating an error
 *     as success would defeat Requirement 2.3 (reject login on Provider
 *     auth failure) and Requirement 4.3 (reject API-key save on auth
 *     failure).
 *   • {@link ProviderProbe} — pluggable per-provider port that performs
 *     a lightweight test request against a Provider for a candidate
 *     API_Key. Adapters for OpenAI, Anthropic and a generic adapter are
 *     implemented in `./providerProbe.ts`.
 *   • {@link HttpFetcher} — narrow injectable port the probe adapters
 *     use to make HTTP calls. Production wires this to global `fetch`
 *     (Node ≥ 20); tests pass a stub so no real network call is made.
 *   • {@link LocalApiKeySink} — narrow port the Auth Service uses to
 *     persist an API key in Local Encrypted Storage as part of
 *     `createLocalSession`. The composition root (Desktop Shell wiring,
 *     and later the Settings_Store adapter) provides the concrete
 *     implementation; the auth service itself never sees ciphertext or
 *     storage primitives.
 *   • {@link CreateLocalSessionInput} — input shape mirroring design.md
 *     verbatim, including the literal `confirmedByUser: true` discriminant
 *     that enforces Requirement 2.5 ("explicit user confirmation") at the
 *     type level. Calls without that field are rejected at runtime as
 *     well, so JS callers cannot bypass the gate.
 *   • {@link LocalSessionError} — typed failure modes for
 *     `createLocalSession` so callers can distinguish "user did not
 *     confirm" from "input is invalid" from "storage failed" without
 *     parsing message strings.
 *
 * Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.8, 4.2, 4.3, 4.5.
 */

import type { ProviderId } from "@ai-agent-orchestrator/shared-core";

// Re-export `ProviderId` and `Session` so the rest of the backend can
// import them from the auth barrel without reaching across packages —
// same convention as `settings/types.ts`.
export type { ProviderId, Session } from "@ai-agent-orchestrator/shared-core";

/**
 * Outcome of a Provider validation probe.
 *
 * Mirrors `ValidationResult` from design.md verbatim:
 *
 * ```ts
 * type ValidationResult =
 *   | { kind: "ok"; modelsCount?: number }
 *   | { kind: "error"; providerCode: string; providerMessage: string };
 * ```
 *
 * Design notes:
 *
 *   • `modelsCount` is optional because not every Provider exposes a
 *     model-list endpoint that fits a "lightweight test request"
 *     (Anthropic in particular). When present it gives the UI an
 *     immediate signal that the key works for at least one model; when
 *     absent the UI just shows generic success.
 *   • `providerCode` is the Provider-native error code (e.g.
 *     `"invalid_api_key"`, `"authentication_error"`) when available, or
 *     a stable HTTP-status-derived code (e.g. `"http_401"`) when it
 *     isn't. Either way it is safe to surface in UI per Requirement 2.3
 *     and 4.3 ("сообщение об ошибке с указанием причины, полученной от
 *     Provider").
 *   • `providerMessage` is the Provider-native human-readable error
 *     message when available; otherwise a short, secret-free fallback.
 *     Adapters MUST NOT echo the API_Key back into this field.
 */
export type ValidationResult =
  | {
      readonly kind: "ok";
      readonly modelsCount?: number;
    }
  | {
      readonly kind: "error";
      readonly providerCode: string;
      readonly providerMessage: string;
    };

/**
 * Pluggable per-Provider probe.
 *
 * Each implementation knows how to issue a single, lightweight
 * authenticated request against one Provider and to translate the
 * response into a {@link ValidationResult}.
 *
 * Contract:
 *
 *   • `provider` MUST be the same `ProviderId` used in `ModelRef.provider`
 *     and in `SettingsStore` keys, so that `AuthService` can route
 *     correctly without further mapping.
 *   • `probe` MUST NOT throw under any expected failure mode —
 *     network errors, HTTP non-2xx, malformed bodies, timeouts and
 *     unauthenticated responses MUST all be returned as `kind: "error"`
 *     so the `AuthService` does not have to wrap every call in
 *     try/catch. The auth service still defends with a try/catch as
 *     defence-in-depth, but adapters MUST NOT rely on it.
 *   • `probe` MUST treat `apiKey` as a short-lived secret: do not log
 *     it, do not store it, and do not include it in returned values
 *     (including in `providerMessage`).
 */
export interface ProviderProbe {
  readonly provider: ProviderId;
  /**
   * Issues the test request and returns a structured result.
   *
   * Implementations MAY honor `signal` for caller-side cancellation.
   * They MUST honor their own configured timeout regardless of `signal`,
   * because Requirement 2.2 expects a bounded validation latency.
   */
  probe(input: {
    readonly apiKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ValidationResult>;
}

/**
 * Subset of `fetch`'s `Request` shape that the probe adapters rely on.
 * Mirrors `apps/backend/src/search/httpClient.ts` so probe code looks
 * the same as search code and tests can reuse the same mental model.
 */
export interface HttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/**
 * Subset of `Response` that probe adapters consume.
 *
 * `text()` is sufficient — adapters parse JSON themselves so a malformed
 * body cannot throw inside the HTTP layer.
 */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

/**
 * Injectable HTTP port. Implementations MUST honor `request.signal` for
 * timeout/cancellation and SHOULD throw an `AbortError`-shaped error
 * when the signal aborts mid-flight so probe adapters can recognise
 * timeouts.
 */
export interface HttpFetcher {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * Default per-probe timeout. Provider list/key-check endpoints are
 * lightweight; 10 s is generous enough to cover a slow TLS handshake
 * but short enough to keep the login flow responsive.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// createLocalSession (task 4.2) — types and ports
// ---------------------------------------------------------------------------

/**
 * Input shape accepted by `AuthService.createLocalSession`.
 *
 * Mirrors design.md → "Auth Service" → `createLocalSession` verbatim,
 * including the literal `confirmedByUser: true` field. Encoding the
 * literal at the type level means a TypeScript caller that omits the
 * confirmation, or sets it to `false`, fails to compile — surfacing
 * Requirement 2.5 ("explicit user confirmation before saving the
 * secret") as a static guarantee. The runtime path enforces the same
 * rule for JS callers and any future RPC unmarshalling.
 *
 * Field semantics:
 *
 *   • `deviceId`        — stable per-device identifier produced by the
 *     Desktop Shell's `getDeviceId()` (Requirement 1.4). Used both as
 *     the `Session.deviceId` and as the persistence scope so the same
 *     key never bleeds across devices.
 *   • `provider`        — `ProviderId` already validated by `validateApiKey`.
 *     Re-validated on this side as a non-empty string to stop wiring bugs.
 *   • `apiKey`          — plaintext API key. The auth service forwards
 *     it to {@link LocalApiKeySink.persistApiKey} exactly once and never
 *     retains, logs, or echoes it. The returned {@link Session} must
 *     not contain it (Requirement 2.5, "API_Key must never be included
 *     in Session response").
 *   • `confirmedByUser` — must be the literal `true`. Any other value
 *     is rejected with {@link LocalSessionError} code
 *     `"missing_confirmation"`.
 */
export interface CreateLocalSessionInput {
  readonly deviceId: string;
  readonly provider: ProviderId;
  readonly apiKey: string;
  readonly confirmedByUser: true;
}

/**
 * Narrow port the Auth Service uses to persist an API key in Local
 * Encrypted Storage as part of `createLocalSession`.
 *
 * Why a custom port rather than reusing `ApiKeyStoreBackend` from
 * `apps/backend/src/settings/types.ts`: Auth must not depend on
 * Settings' surface, and Settings must not depend on Auth's. The
 * composition root (Desktop Shell wiring, and the Settings_Store
 * adapter introduced in task 6.x) glues the two together by passing a
 * thin sink that calls `ApiKeyService.upsertApiKey` (which itself
 * encrypts via the cipher and persists via the store). This keeps the
 * "where" of encryption and persistence out of `authService.ts`.
 *
 * Contract:
 *
 *   • `persistApiKey` MUST encrypt `apiKey` and persist the resulting
 *     blob in the local-scoped Encrypted Storage for `deviceId`. It
 *     MUST NOT return the plaintext or the encrypted blob to the
 *     caller — Auth never sees ciphertext.
 *   • Throwing is the signal for "save failed". The Auth Service wraps
 *     thrown errors as a {@link LocalSessionError} with
 *     `code = "storage_failed"` so callers can distinguish "the user
 *     did not confirm" from "we couldn't save the key".
 *   • The sink MUST be invoked at most once per successful
 *     `createLocalSession` call. The Auth Service unit tests assert
 *     this directly.
 */
export interface LocalApiKeySink {
  persistApiKey(input: {
    readonly deviceId: string;
    readonly provider: ProviderId;
    readonly apiKey: string;
  }): Promise<void>;
}

/**
 * Failure modes surfaced by `AuthService.createLocalSession`.
 *
 *   • `"missing_confirmation"` — `confirmedByUser` was not the literal
 *     `true`. The call did NOT touch the sink, so no plaintext was
 *     handed off and no record was created (Requirement 2.5, 2.8).
 *   • `"invalid_input"`        — a structural problem in `deviceId`,
 *     `provider`, or `apiKey` (empty/whitespace, wrong type). Detected
 *     before the sink is called.
 *   • `"storage_failed"`       — the sink threw. The original error is
 *     attached as `cause` for diagnostics; the message itself does not
 *     carry the API key.
 */
export type LocalSessionErrorCode =
  | "missing_confirmation"
  | "invalid_input"
  | "storage_failed";

export class LocalSessionError extends Error {
  public readonly code: LocalSessionErrorCode;

  public constructor(code: LocalSessionErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.name = "LocalSessionError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}
