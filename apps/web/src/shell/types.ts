/**
 * Public types for the Web Shell (task 18.1).
 *
 * Source:
 *   • design.md → "Web Shell" → "Responsibilities" / "Rules":
 *       – web routing;
 *       – OAuth callback handling;
 *       – session cookie usage;
 *       – Web Shell cannot use Windows Local Encrypted Storage.
 *   • design.md → "Auth Service" → "Rules":
 *       – "For Web App, session should use secure HTTP-only cookie."
 *   • requirements.md → Requirements 1.2, 1.7, 3.1.
 *
 * Validates: Requirements 1.2, 1.7, 3.1.
 */

import type { Session } from "@ai-agent-orchestrator/shared-core";

// Re-export `Session` so consumers can import the web-shell surface
// from a single barrel.
export type { Session };

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Bag of named path parameters extracted from a route pattern. */
export type RouteParams = Readonly<Record<string, string>>;

/** Bag of query-string values. */
export type QueryParams = Readonly<Record<string, string>>;

/**
 * Result of resolving a path against the registered routes.
 *
 *   • `found` — the path matched a registered pattern. `params` and
 *     `query` are populated.
 *   • `not_found` — no pattern matched. The router does not throw — it
 *     hands control to the application's `onNotFound` handler so the UI
 *     can render a 404 instead of crashing the renderer.
 */
export type RouteMatch =
  | {
      readonly kind: "found";
      readonly pattern: string;
      readonly path: string;
      readonly params: RouteParams;
      readonly query: QueryParams;
    }
  | {
      readonly kind: "not_found";
      readonly path: string;
      readonly query: QueryParams;
    };

/** Handler invoked when a route is entered. */
export type RouteHandler = (
  match: Extract<RouteMatch, { kind: "found" }>,
) => void;

/** Handler invoked when no registered route matches. */
export type NotFoundHandler = (
  match: Extract<RouteMatch, { kind: "not_found" }>,
) => void;

/**
 * Narrow `History`-shaped port. Lets unit tests run without `jsdom` by
 * supplying a stub.
 */
export interface HistoryLike {
  pushState(data: unknown, unused: string, url: string): void;
  replaceState(data: unknown, unused: string, url: string): void;
}

/**
 * Narrow `Location`-shaped port. Only the fields the router reads are
 * surfaced — `pathname` and `search`.
 */
export interface LocationLike {
  readonly pathname: string;
  readonly search: string;
}

/**
 * Narrow `EventTarget`-shaped port for `popstate`. The browser's
 * `window` satisfies this; tests pass a small stub.
 */
export interface PopStateTargetLike {
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

/**
 * Options for {@link buildSetCookieHeader}.
 *
 * Defaults reflect design.md's web-session rule
 *   "session should use secure HTTP-only cookie"
 * plus the OWASP-recommended `SameSite=Lax` baseline:
 *
 *   • `httpOnly` — defaults to `true`. Cannot be disabled at the type
 *     level for `SessionCookieOptions`; the more permissive
 *     `BuildCookieOptions` type below allows callers (tests, future
 *     non-session cookies) to override it explicitly.
 *   • `secure`   — defaults to `true`. Same rationale.
 *   • `sameSite` — defaults to `"Lax"`. `"Strict"` would break the
 *     OAuth callback (top-level navigation from accounts.google.com);
 *     `"None"` would require third-party context which we do not need.
 */
export interface SessionCookieOptions {
  /** Cookie path. Defaults to `"/"`. */
  readonly path?: string;
  /** Optional explicit cookie domain. Omit for host-only cookies. */
  readonly domain?: string;
  /** Maximum lifetime in seconds. Computed from `session.expiresAt` when set. */
  readonly maxAgeSeconds?: number;
  /** Absolute expiry timestamp. Mutually exclusive with `maxAgeSeconds`. */
  readonly expires?: Date;
  /**
   * Override the SameSite flag. Web shell defaults to `"Lax"`; tests
   * can pass `"Strict"` or `"None"` to verify the encoding.
   */
  readonly sameSite?: "Strict" | "Lax" | "None";
  /**
   * Override `Secure`. Web shell defaults to `true`. Disabling this is
   * supported only so tests can verify the encoding — production code
   * MUST leave it on, per design.md ("secure HTTP-only cookie").
   */
  readonly secure?: boolean;
  /**
   * Override `HttpOnly`. Web shell defaults to `true`. Disabling is
   * supported only for tests.
   */
  readonly httpOnly?: boolean;
}

/**
 * Narrow response port used by {@link writeSessionCookie} and
 * {@link handleOAuthCallback}.
 *
 * Implementations:
 *
 *   • Node `http.ServerResponse` already exposes `statusCode`,
 *     `setHeader`, `appendHeader` and `end`.
 *   • A stub `{ statusCode, headers: {}, setHeader, end }` is enough
 *     for unit tests.
 *
 * `appendHeader` is optional because `setHeader('Set-Cookie', [...])`
 * is universally supported and is what we use; `appendHeader` is
 * surfaced only as an opt-in optimization.
 */
export interface HttpResponseLike {
  statusCode: number;
  setHeader(name: string, value: string | readonly string[]): void;
  appendHeader?(name: string, value: string | readonly string[]): void;
  end(body?: string): void;
}

/** Narrow request port. Only the fields the OAuth handler reads. */
export interface HttpRequestLike {
  /**
   * Request URL including the query string. Node's
   * `IncomingMessage.url` is path+query (no host); a full URL also
   * works because `URL` parses it.
   */
  readonly url: string | undefined;
  readonly method?: string | undefined;
}

// ---------------------------------------------------------------------------
// OAuth callback handler ports
// ---------------------------------------------------------------------------

/**
 * Narrow port the web shell uses to complete the Google OAuth
 * handshake. Satisfied directly by `GoogleOAuthService` from the
 * backend's `auth` module — but defined here so the web app does NOT
 * have to depend on the backend package directly.
 *
 * The composition root passes the actual `GoogleOAuthService` instance.
 */
export interface OAuthCompleter {
  completeGoogleOAuth(input: {
    readonly code: string;
    readonly state: string;
  }): Promise<Session>;
}

/**
 * Result of {@link handleOAuthCallback}, returned for callers that
 * want to inspect the outcome (e.g. tests). The handler ALSO writes
 * the response, so most production callers can ignore the return.
 */
export type OAuthCallbackResult =
  | {
      readonly kind: "ok";
      readonly session: Session;
      readonly redirectTo: string;
    }
  | {
      readonly kind: "settings_load_failed";
      readonly status: number;
      readonly message: string;
    }
  | {
      readonly kind: "error";
      readonly status: number;
      readonly code:
        | "missing_code"
        | "missing_state"
        | "invalid_method"
        | "oauth_failed"
        | "internal_error";
      readonly message: string;
    };
