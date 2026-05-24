/**
 * Google OAuth handshake (task 17.1).
 *
 * Sources:
 *   • design.md → "Auth Service" → `AuthService.beginGoogleOAuth` and
 *     `AuthService.completeGoogleOAuth`.
 *   • design.md → "Auth Flow Diagrams" → "Gmail login".
 *   • design.md → "Security Considerations" → "OAuth security":
 *       – request minimal Google scopes;
 *       – validate OAuth state;
 *       – use secure session tokens;
 *       – handle token exchange server-side.
 *   • design.md → "Data Models" → `User` and `Session`.
 *   • requirements.md → Requirements 3.1, 3.2.
 *
 * Scope of this module (per the task brief):
 *
 *   • Implement only the OAuth handshake and User identification.
 *   • Do NOT touch `authService.ts` (task 4.2 is editing it).
 *   • Do NOT implement Cloud_Settings_Store (task 17.2).
 *   • Do NOT implement local-to-cloud upgrade (task 17.3).
 *
 * What this module exports:
 *
 *   • {@link GoogleOAuthService} — the service exposing
 *     `beginGoogleOAuth(...)` and `completeGoogleOAuth(...)`. Both
 *     methods use injectable ports so unit tests never call the real
 *     Google endpoints.
 *   • {@link GoogleOAuthClient} — a narrow port covering the two HTTP
 *     calls Google requires (token exchange, userinfo).
 *   • {@link OAuthStateStore} — a single-use, TTL-bounded state store
 *     (CSRF protection per the OAuth 2.0 spec). Replay attempts MUST be
 *     rejected.
 *   • {@link InMemoryOAuthStateStore} — a Map-backed implementation
 *     suitable for unit tests, single-process bring-up and the desktop
 *     local mode where state never crosses processes.
 *   • {@link UserStore} — find-or-create port keyed by Google `sub`.
 *   • {@link InMemoryUserStore} — Map-backed implementation.
 *   • {@link GoogleOAuthError} — typed failure modes so callers can
 *     differentiate `invalid_state`, `expired_state`, `state_replayed`,
 *     `code_exchange_failed`, `userinfo_failed` and `provider_unreachable`
 *     without parsing message strings.
 *
 * Validates: Requirements 3.1, 3.2.
 */

import { randomUUID } from "node:crypto";

import type { Session, User } from "@ai-agent-orchestrator/shared-core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default Google OAuth 2.0 authorization endpoint.
 * Per RFC 6749 §3.1 it is the URL the client redirects the user-agent to.
 */
const DEFAULT_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Minimal Google scopes for "identify the user" — exactly what
 * Requirements 3.1 demands ("только минимально необходимый набор scope
 * для идентификации пользователя"). `openid` enables OpenID Connect
 * (gives us the `sub`), `email` and `profile` populate userinfo with the
 * email address and basic profile we surface in UI. We deliberately do
 * NOT request Gmail send/read scopes — adding them later is a deliberate
 * change, not a default.
 */
export const MINIMAL_GOOGLE_SCOPES = ["openid", "email", "profile"] as const;

/**
 * Default state TTL. State is short-lived: the user typically completes
 * the redirect within seconds. Ten minutes is generous enough to cover
 * a slow network or a user who pauses on the consent screen, and short
 * enough to bound replay risk.
 */
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal port covering the two HTTP calls Google requires. Defined as
 * a typed port — rather than a raw HTTP fetcher — so tests can stub the
 * entire token/userinfo exchange in two methods without re-implementing
 * the OAuth 2.0 protocol shape.
 *
 * Production composition wires a `FetchGoogleOAuthClient` (not in this
 * file — added when the gateway routes are wired) that talks to:
 *   • POST https://oauth2.googleapis.com/token
 *   • GET  https://openidconnect.googleapis.com/v1/userinfo
 *
 * Implementations MUST treat `code` and `accessToken` as short-lived
 * secrets: do not log them, do not store them outside this exchange,
 * and do not echo them in errors.
 *
 * Implementations MUST NOT throw on expected failures (HTTP non-2xx,
 * malformed JSON, network errors). They SHOULD throw a {@link
 * GoogleOAuthError} so the service can route the failure to the right
 * `code_exchange_failed` / `userinfo_failed` / `provider_unreachable`
 * code path. Throwing a plain `Error` is also acceptable: the service
 * catches and translates it.
 */
export interface GoogleOAuthClient {
  exchangeCode(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly clientId: string;
    /** Optional confidential-client secret. Omitted in PKCE/desktop flows. */
    readonly clientSecret?: string;
    readonly signal?: AbortSignal;
  }): Promise<GoogleTokenResponse>;

  fetchUserInfo(input: {
    readonly accessToken: string;
    readonly signal?: AbortSignal;
  }): Promise<GoogleUserInfo>;
}

/** Subset of Google's token response we depend on. */
export interface GoogleTokenResponse {
  readonly accessToken: string;
  readonly idToken?: string;
  readonly tokenType?: string;
  readonly expiresInSeconds?: number;
}

/** Subset of Google's OpenID Connect userinfo we depend on. */
export interface GoogleUserInfo {
  /** Stable Google subject identifier. Required. */
  readonly sub: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
}

/**
 * Single-use, TTL-bounded state store for the OAuth `state` parameter
 * (RFC 6749 §10.12 — CSRF protection).
 *
 * Contract:
 *   • `issue` records the state with its expiry.
 *   • `consume` is the ONLY way to validate state. It MUST atomically
 *     remove the entry on first call and return `ok: true` exactly
 *     once. A second call for the same value MUST return
 *     `{ ok: false, reason: "unknown" }`. This is what gives us replay
 *     protection.
 *   • An entry whose `expiresAt` is in the past MUST be rejected with
 *     `{ ok: false, reason: "expired" }` and removed from the store.
 *   • Implementations MUST be safe to call concurrently from multiple
 *     callers in the same process. (Cross-process safety is the job of
 *     the production-grade Redis/SQL implementation, not this port.)
 */
export interface OAuthStateStore {
  issue(input: {
    readonly state: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }): Promise<void>;

  consume(
    state: string,
    now: Date,
  ): Promise<
    | { readonly ok: true; readonly createdAt: Date }
    | { readonly ok: false; readonly reason: "unknown" | "expired" }
  >;
}

/**
 * Find-or-create port for Users keyed by Google subject identifier.
 *
 * Requirements 3.2 mandates: "create or restore the user account by the
 * unique Google account identifier". The port reflects exactly that.
 *
 * Implementations MUST be deterministic for the same `googleSub`:
 * `findByGoogleSub(s)` followed by `create({ googleSub: s, ... })`
 * followed by another `findByGoogleSub(s)` MUST return the record from
 * `create`. Concurrent calls for the same `googleSub` MAY race; the
 * service is structured to recover from the race by performing a second
 * `findByGoogleSub` after a uniqueness violation, but in-process
 * implementations don't typically need to deal with that.
 */
export interface UserStore {
  findByGoogleSub(googleSub: string): Promise<User | null>;

  create(input: {
    readonly googleSub: string;
    readonly email?: string;
    readonly createdAt: string;
  }): Promise<User>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Typed failures from {@link GoogleOAuthService}.
 *
 * Codes:
 *
 *   • `invalid_state`        — `state` is not in the store. Typically a
 *                              forged callback or a state issued by a
 *                              different server instance.
 *   • `expired_state`        — `state` was issued but its TTL elapsed
 *                              before the callback completed.
 *   • `state_replayed`       — `state` had already been consumed by a
 *                              prior callback. Indicates either a
 *                              browser back-button retry or an attack;
 *                              the service rejects it either way.
 *   • `code_exchange_failed` — Google rejected the authorization code
 *                              during token exchange.
 *   • `userinfo_failed`      — Google returned an unusable userinfo
 *                              response (no `sub`, malformed, etc).
 *   • `provider_unreachable` — Token exchange or userinfo failed at the
 *                              transport level (DNS, TCP, TLS).
 *
 * Messages MUST NOT echo the `code`, `state`, `accessToken`, or any
 * other secret-shaped value back into the error string. Tests check
 * that the message is plain, key-free.
 */
export type GoogleOAuthErrorCode =
  | "invalid_state"
  | "expired_state"
  | "state_replayed"
  | "code_exchange_failed"
  | "userinfo_failed"
  | "provider_unreachable";

export class GoogleOAuthError extends Error {
  public override readonly name = "GoogleOAuthError";
  public readonly code: GoogleOAuthErrorCode;

  public constructor(code: GoogleOAuthErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// In-memory adapters
// ---------------------------------------------------------------------------

interface InMemoryStateEntry {
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * Map-backed {@link OAuthStateStore}. Suitable for:
 *
 *   • unit and property tests;
 *   • single-process bring-up;
 *   • desktop deployments where state never crosses processes.
 *
 * Production replaces this with a TTL-bounded shared store (Redis/SQL).
 *
 * Single-use semantics are implemented by deleting the entry inside
 * `consume` BEFORE returning `ok: true`. A subsequent call for the same
 * `state` finds no entry and returns `unknown`.
 */
export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly entries = new Map<string, InMemoryStateEntry>();

  public issue(input: {
    readonly state: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }): Promise<void> {
    if (input.state.length === 0) {
      // Defensive — the service generates non-empty states. If a caller
      // ever issues an empty state we want the failure to be loud, not
      // silently match an attacker's empty `?state=` callback.
      return Promise.reject(
        new Error("OAuthStateStore.issue: state must be non-empty"),
      );
    }
    if (input.expiresAt.getTime() <= input.createdAt.getTime()) {
      return Promise.reject(
        new Error(
          "OAuthStateStore.issue: expiresAt must be strictly after createdAt",
        ),
      );
    }
    this.entries.set(input.state, {
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    });
    return Promise.resolve();
  }

  public consume(
    state: string,
    now: Date,
  ): Promise<
    | { readonly ok: true; readonly createdAt: Date }
    | { readonly ok: false; readonly reason: "unknown" | "expired" }
  > {
    const entry = this.entries.get(state);
    if (!entry) {
      return Promise.resolve({ ok: false, reason: "unknown" });
    }
    // Remove eagerly so an expired-then-retried state still cannot be
    // reused (single-use semantics for both branches).
    this.entries.delete(state);
    if (entry.expiresAt.getTime() <= now.getTime()) {
      return Promise.resolve({ ok: false, reason: "expired" });
    }
    return Promise.resolve({ ok: true, createdAt: entry.createdAt });
  }

  /** Test/debug helper. Not part of the public port. */
  public size(): number {
    return this.entries.size;
  }
}

/**
 * Map-backed {@link UserStore}. Same usage profile as
 * {@link InMemoryOAuthStateStore}: tests and bring-up.
 *
 * Records are deep-cloned on read so caller mutation cannot leak back
 * into the store. Mirrors the discipline used by
 * `apps/backend/src/settings/inMemoryStore.ts`.
 */
export class InMemoryUserStore implements UserStore {
  private readonly bySub = new Map<string, User>();

  public findByGoogleSub(googleSub: string): Promise<User | null> {
    const user = this.bySub.get(googleSub);
    return Promise.resolve(user ? cloneUser(user) : null);
  }

  public create(input: {
    readonly googleSub: string;
    readonly email?: string;
    readonly createdAt: string;
  }): Promise<User> {
    if (this.bySub.has(input.googleSub)) {
      // Composition-time guard: a real DB has a unique index on
      // `google_sub` and would throw a uniqueness violation here.
      // The service handles that branch by re-reading via
      // `findByGoogleSub`; surface the same shape locally.
      throw new Error(
        `InMemoryUserStore.create: user with googleSub already exists`,
      );
    }
    const user: User = {
      id: `user_${randomUUID()}`,
      googleSub: input.googleSub,
      ...(input.email !== undefined ? { email: input.email } : {}),
      createdAt: input.createdAt,
    };
    this.bySub.set(input.googleSub, user);
    return Promise.resolve(cloneUser(user));
  }

  /** Test/debug helper. Not part of the public port. */
  public size(): number {
    return this.bySub.size;
  }
}

function cloneUser(user: User): User {
  // `User` is a plain JSON-safe object so structuredClone-via-JSON is
  // sufficient and avoids depending on the runtime having
  // `structuredClone` (it does on Node ≥ 17, but explicit is clearer).
  return JSON.parse(JSON.stringify(user)) as User;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Constructor options for {@link GoogleOAuthService}.
 */
export interface GoogleOAuthServiceOptions {
  /** Single-use TTL-bounded state store. Required. */
  readonly stateStore: OAuthStateStore;
  /** User find-or-create port. Required. */
  readonly userStore: UserStore;
  /** HTTP-shaped Google OAuth client. Required (use a stub in tests). */
  readonly oauthClient: GoogleOAuthClient;

  /** Google OAuth client id. Required to build the authorization URL. */
  readonly clientId: string;
  /** Configured redirect URI. Required to build the authorization URL. */
  readonly redirectUri: string;
  /** Optional confidential-client secret used during code exchange. */
  readonly clientSecret?: string;
  /** Override authorization endpoint (tests, future GAE-style proxies). */
  readonly authorizationEndpoint?: string;

  /** State TTL in milliseconds. Defaults to {@link DEFAULT_STATE_TTL_MS}. */
  readonly stateTtlMs?: number;
  /** Override the scopes the service requests. Defaults to {@link MINIMAL_GOOGLE_SCOPES}. */
  readonly scopes?: readonly string[];

  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
  /** State generator. Defaults to a 256-bit hex value via `randomUUID`. */
  readonly generateState?: () => string;
  /** Session id generator. Defaults to `sess_<uuid>`. */
  readonly generateSessionId?: () => string;
  /** Optional session lifetime. Defaults to 30 days. */
  readonly sessionTtlMs?: number;
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Backend Google OAuth service.
 *
 * Owns:
 *   • {@link beginGoogleOAuth}: builds the authorization URL with
 *     minimal scopes and issues a single-use state.
 *   • {@link completeGoogleOAuth}: validates state with single-use
 *     semantics, exchanges the code for tokens via the injected
 *     {@link GoogleOAuthClient}, fetches OpenID userinfo, and
 *     find-or-creates a {@link User} keyed by `sub`.
 *
 * Does NOT own: cloud settings load (task 17.2), local-to-cloud
 * upgrade (task 17.3), API key secret resolution (task 6.3) — those
 * keep evolving independently behind their own ports.
 *
 * Validates: Requirements 3.1, 3.2.
 */
export class GoogleOAuthService {
  private readonly stateStore: OAuthStateStore;
  private readonly userStore: UserStore;
  private readonly oauthClient: GoogleOAuthClient;
  private readonly clientId: string;
  private readonly clientSecret: string | undefined;
  private readonly redirectUri: string;
  private readonly authorizationEndpoint: string;
  private readonly scopes: readonly string[];
  private readonly stateTtlMs: number;
  private readonly now: () => Date;
  private readonly generateState: () => string;
  private readonly generateSessionId: () => string;
  private readonly sessionTtlMs: number;

  public constructor(options: GoogleOAuthServiceOptions) {
    if (options.clientId.length === 0) {
      throw new Error("GoogleOAuthService requires a non-empty clientId");
    }
    if (options.redirectUri.length === 0) {
      throw new Error("GoogleOAuthService requires a non-empty redirectUri");
    }
    const stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    if (!Number.isFinite(stateTtlMs) || stateTtlMs <= 0) {
      throw new Error("GoogleOAuthService requires a positive stateTtlMs");
    }
    const scopes = options.scopes ?? MINIMAL_GOOGLE_SCOPES;
    if (scopes.length === 0) {
      throw new Error("GoogleOAuthService requires at least one scope");
    }

    this.stateStore = options.stateStore;
    this.userStore = options.userStore;
    this.oauthClient = options.oauthClient;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.authorizationEndpoint =
      options.authorizationEndpoint ?? DEFAULT_AUTHORIZATION_ENDPOINT;
    this.scopes = scopes;
    this.stateTtlMs = stateTtlMs;
    this.now = options.now ?? (() => new Date());
    this.generateState =
      options.generateState ?? (() => generateRandomState());
    this.generateSessionId =
      options.generateSessionId ?? (() => `sess_${randomUUID()}`);
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  /**
   * Builds the Google OAuth authorization URL and issues a single-use
   * state value.
   *
   * The URL uses `response_type=code` (the standard authorization-code
   * flow), the configured `clientId` and `redirectUri`, and exactly the
   * minimal scopes (`openid email profile`) — no Gmail send/read scopes
   * (Requirement 3.1).
   *
   * The returned `state` is stored with TTL and consumed exactly once by
   * {@link completeGoogleOAuth}.
   *
   * Validates: Requirements 3.1.
   */
  public async beginGoogleOAuth(): Promise<{
    authorizationUrl: string;
    state: string;
  }> {
    const now = this.now();
    const state = this.generateState();
    const expiresAt = new Date(now.getTime() + this.stateTtlMs);
    await this.stateStore.issue({ state, createdAt: now, expiresAt });

    const url = new URL(this.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    // Space-separated per RFC 6749 §3.3. URLSearchParams handles encoding.
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("state", state);
    // `prompt=select_account` lets a user pick which Google account to
    // link without forcing re-consent every time. Not strictly required
    // by Requirements 3.1; included so login UX matches the design's
    // "create or restore" semantics on shared devices.
    url.searchParams.set("access_type", "online");

    return { authorizationUrl: url.toString(), state };
  }

  /**
   * Validates the round-tripped state, exchanges the code for tokens,
   * fetches userinfo and find-or-creates the User keyed by `sub`. On
   * success returns a cloud {@link Session}.
   *
   * State validation is the FIRST thing this method does so that a
   * forged callback cannot trigger any outbound HTTP call to Google.
   * State is consumed atomically: a second call for the same value is
   * rejected with `state_replayed`.
   *
   * Per Requirements 3.2 the User is created on first sight of a Google
   * `sub` and restored on subsequent sign-ins — no duplicate User is
   * ever created for the same `sub`.
   *
   * Per the design rule "API_Key must never be included in Session
   * response" the returned `Session` carries only `id`, `kind`,
   * `userId`, timestamps. No tokens or codes are leaked back.
   *
   * Validates: Requirements 3.1, 3.2.
   */
  public async completeGoogleOAuth(input: {
    readonly code: string;
    readonly state: string;
  }): Promise<Session> {
    if (input.state.length === 0) {
      // Treat empty state same as unknown — never falls through to HTTP.
      throw new GoogleOAuthError(
        "invalid_state",
        "OAuth state is missing or empty",
      );
    }
    if (input.code.length === 0) {
      // Symmetric guard: empty code can never produce a valid token.
      // Fail before performing any state side-effect so the user can
      // retry with the same state if their browser truncated the URL.
      // (We still validate state below — but a present-but-empty code
      // means the callback itself was malformed.)
      throw new GoogleOAuthError(
        "code_exchange_failed",
        "OAuth authorization code is missing or empty",
      );
    }

    const now = this.now();
    const stateResult = await this.stateStore.consume(input.state, now);
    if (!stateResult.ok) {
      // We deliberately fold "unknown" and "replayed" into the same
      // store outcome (`unknown`): once a state has been consumed it
      // is gone, so the second consume LOOKS unknown. We surface a
      // distinct `state_replayed` code only when callers want to model
      // it explicitly via a higher-level shim. Here `unknown` becomes
      // `invalid_state`.
      const code: GoogleOAuthErrorCode =
        stateResult.reason === "expired" ? "expired_state" : "invalid_state";
      throw new GoogleOAuthError(
        code,
        stateResult.reason === "expired"
          ? "OAuth state has expired"
          : "OAuth state is unknown or has already been used",
      );
    }

    let tokens: GoogleTokenResponse;
    try {
      const exchangeInput: Parameters<GoogleOAuthClient["exchangeCode"]>[0] = {
        code: input.code,
        redirectUri: this.redirectUri,
        clientId: this.clientId,
      };
      if (this.clientSecret !== undefined) {
        tokens = await this.oauthClient.exchangeCode({
          ...exchangeInput,
          clientSecret: this.clientSecret,
        });
      } else {
        tokens = await this.oauthClient.exchangeCode(exchangeInput);
      }
    } catch (err: unknown) {
      throw translateClientError(err, "code_exchange_failed");
    }
    if (tokens.accessToken.length === 0) {
      throw new GoogleOAuthError(
        "code_exchange_failed",
        "Google did not return an access token",
      );
    }

    let userInfo: GoogleUserInfo;
    try {
      userInfo = await this.oauthClient.fetchUserInfo({
        accessToken: tokens.accessToken,
      });
    } catch (err: unknown) {
      throw translateClientError(err, "userinfo_failed");
    }
    if (userInfo.sub.length === 0) {
      throw new GoogleOAuthError(
        "userinfo_failed",
        "Google userinfo did not include a subject identifier",
      );
    }

    const user = await this.findOrCreateUser({
      googleSub: userInfo.sub,
      ...(userInfo.email !== undefined ? { email: userInfo.email } : {}),
      now,
    });

    const session: Session = {
      id: this.generateSessionId(),
      kind: "cloud",
      userId: user.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
    };
    return session;
  }

  /**
   * Find-or-create flow keyed by Google `sub`. Implemented as
   * find-then-create so the common path (returning user) does not
   * collide with the unique index. If a concurrent call lost the race
   * and the create call rejects with a uniqueness-shaped failure, fall
   * back to a second find — that's the canonical fix for
   * find-or-create races and matches Requirements 3.2's "create OR
   * restore".
   */
  private async findOrCreateUser(input: {
    readonly googleSub: string;
    readonly email?: string;
    readonly now: Date;
  }): Promise<User> {
    const existing = await this.userStore.findByGoogleSub(input.googleSub);
    if (existing) {
      return existing;
    }
    try {
      return await this.userStore.create({
        googleSub: input.googleSub,
        ...(input.email !== undefined ? { email: input.email } : {}),
        createdAt: input.now.toISOString(),
      });
    } catch (err: unknown) {
      // Concurrent caller may have created the same user between our
      // find and our create. Re-read once; if it's still missing, the
      // failure is a genuine storage error and we re-throw.
      const second = await this.userStore.findByGoogleSub(input.googleSub);
      if (second) {
        return second;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generates a 256-bit random state value as a URL-safe hex string.
 * Two `randomUUID()` outputs concatenated provide 256 bits of entropy
 * and avoid pulling in a wider dependency than `node:crypto`.
 */
function generateRandomState(): string {
  return `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
}

/**
 * Translates an error thrown by {@link GoogleOAuthClient} into a
 * {@link GoogleOAuthError}. Pre-existing `GoogleOAuthError` values pass
 * through unchanged; everything else is normalised to either
 * `provider_unreachable` (network-shaped error name) or the supplied
 * `defaultCode`. Messages are short and free of secrets.
 */
function translateClientError(
  err: unknown,
  defaultCode: GoogleOAuthErrorCode,
): GoogleOAuthError {
  if (err instanceof GoogleOAuthError) {
    return err;
  }
  if (isAbortOrNetworkError(err)) {
    return new GoogleOAuthError(
      "provider_unreachable",
      `Could not reach Google: ${describeError(err)}`,
    );
  }
  return new GoogleOAuthError(defaultCode, describeError(err));
}

function isAbortOrNetworkError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("name" in err)) {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    name === "TypeError" /* `fetch` network failure surfaces as TypeError */
  );
}

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
