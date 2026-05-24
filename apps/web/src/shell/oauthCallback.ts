/**
 * Server-side OAuth callback handler for the Web Shell (task 18.1).
 *
 * Source:
 *   • design.md → "Web Shell" → "Responsibilities":
 *       – OAuth callback handling;
 *       – session cookie usage.
 *   • design.md → "Auth Service" → "Rules":
 *       "For Web App, session should use secure HTTP-only cookie."
 *   • requirements.md → Requirements 1.2, 1.7, 3.1.
 *
 * What this module owns:
 *
 *   • {@link handleOAuthCallback} — given a Node-shaped `req`/`res`
 *     pair plus an injected {@link OAuthCompleter} (satisfied by the
 *     backend's `GoogleOAuthService` from task 17.1), this function
 *     performs the OAuth handshake, writes the `Set-Cookie` header for
 *     the resulting session, and issues a 302 redirect to the
 *     post-login route (`/tasks` by default).
 *
 *   • {@link DEFAULT_POST_LOGIN_REDIRECT} — the route the user lands
 *     on after a successful OAuth callback. Centralised so the router
 *     (`router.ts`) and the callback agree.
 *
 * Important non-goals:
 *
 *   • This handler does NOT mint the session itself. Session creation
 *     is delegated to `GoogleOAuthService.completeGoogleOAuth`, which
 *     already enforces single-use state, validates the code with
 *     Google, and find-or-creates the user (Requirement 3.2). The
 *     web-shell handler is a thin adapter: it bridges Node `req`/`res`
 *     to the OAuth service, then sets the cookie.
 *
 *   • This handler does NOT touch any local storage primitive (per
 *     design.md "Web Shell cannot use Windows Local Encrypted
 *     Storage"). The session lives entirely in the secure HTTP-only
 *     cookie + the backend's session table.
 *
 * Validates: Requirements 1.2, 1.7, 3.1.
 */

import type {
  HttpRequestLike,
  HttpResponseLike,
  OAuthCallbackResult,
  OAuthCompleter,
  Session,
  SessionCookieOptions,
} from "./types.js";
import { writeSessionCookie } from "./sessionCookie.js";
import { isSettingsLoadFailedError } from "@ai-agent-orchestrator/shared-ui";

/**
 * Where to send the user after a successful OAuth callback. The web
 * shell router serves `/tasks` once the cookie is set; if the
 * deployment ever needs to land users on `/dashboard` instead, this
 * constant is the only place to change.
 */
export const DEFAULT_POST_LOGIN_REDIRECT = "/tasks" as const;

/** Options for {@link handleOAuthCallback}. */
export interface HandleOAuthCallbackOptions {
  /** OAuth service. Required. */
  readonly oauth: OAuthCompleter;
  /**
   * Where to redirect after success. Defaults to
   * {@link DEFAULT_POST_LOGIN_REDIRECT}. Must be a same-origin path
   * starting with `/`; cross-origin redirects are rejected to avoid
   * open-redirect bugs.
   */
  readonly successRedirect?: string;
  /**
   * Cookie options forwarded to {@link writeSessionCookie}. Defaults
   * are picked by `sessionCookie.ts` (HttpOnly, Secure, SameSite=Lax,
   * Path=/) — overrides are accepted but production code should leave
   * them alone.
   */
  readonly cookieOptions?: SessionCookieOptions;
  /**
   * Optional callback invoked with the failure {@link OAuthCallbackResult}
   * when the handshake fails. Useful for logging.
   */
  readonly onError?: (result: Extract<OAuthCallbackResult, { kind: "error" }>) => void;
  /**
   * Override "now" for cookie computation. Useful in tests so the
   * `Max-Age` value is deterministic.
   */
  readonly now?: () => Date;
}

/**
 * Handles a `GET /oauth/callback?code=...&state=...` request:
 *
 *   1. Reject anything other than `GET` with 405.
 *   2. Parse `code` / `state` from the query string. Missing → 400.
 *   3. Call `oauth.completeGoogleOAuth({ code, state })`.
 *   4. On success, write the secure HTTP-only session cookie and
 *      redirect (302) to `successRedirect`.
 *   5. On failure from the OAuth service, return 401 with a short
 *      JSON body. `onError` is invoked so callers can log.
 *
 * The function awaits the OAuth completion and the response writes,
 * so callers can `await handleOAuthCallback(req, res, opts)` to know
 * when the response has been fully written.
 *
 * Validates: Requirements 1.2, 1.7, 3.1.
 */
export async function handleOAuthCallback(
  req: HttpRequestLike,
  res: HttpResponseLike,
  options: HandleOAuthCallbackOptions,
): Promise<OAuthCallbackResult> {
  const successRedirect = options.successRedirect ?? DEFAULT_POST_LOGIN_REDIRECT;
  validateRedirect(successRedirect);

  // 1. Method gate.
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    return finishError(res, options, {
      kind: "error",
      status: 405,
      code: "invalid_method",
      message: `Method ${method} is not allowed for /oauth/callback`,
    });
  }

  // 2. Parse query string.
  const { code, state } = parseQuery(req.url);
  if (code === null) {
    return finishError(res, options, {
      kind: "error",
      status: 400,
      code: "missing_code",
      message: "OAuth callback is missing 'code' query parameter",
    });
  }
  if (state === null) {
    return finishError(res, options, {
      kind: "error",
      status: 400,
      code: "missing_state",
      message: "OAuth callback is missing 'state' query parameter",
    });
  }

  // 3. Complete OAuth via injected port.
  let session: Session;
  try {
    session = await options.oauth.completeGoogleOAuth({ code, state });
  } catch (err: unknown) {
    // Requirement 3.5: a `settings_load_failed` failure means
    // `Cloud_Settings_Store` couldn't load the user's saved settings
    // and API keys. The Auth_Service must abort the login and offer a
    // "retry later" message rather than a generic 401 JSON. We surface
    // a small HTML page with `Retry-After` so the browser shows
    // something sensible if the user lands on `/oauth/callback`
    // directly (e.g. via a back-button) instead of being redirected.
    if (isSettingsLoadFailedError(err)) {
      return finishSettingsLoadFailed(res, options, err);
    }
    return finishError(res, options, {
      kind: "error",
      status: 401,
      code: "oauth_failed",
      message: describeError(err),
    });
  }

  // 4. Set the secure HTTP-only session cookie + redirect.
  try {
    writeSessionCookie(
      res,
      session,
      options.cookieOptions ?? {},
      options.now ? options.now() : new Date(),
    );
  } catch (err: unknown) {
    return finishError(res, options, {
      kind: "error",
      status: 500,
      code: "internal_error",
      message: `Failed to set session cookie: ${describeError(err)}`,
    });
  }

  res.statusCode = 302;
  res.setHeader("Location", successRedirect);
  // Hint shared caches not to store the redirect — the cookie is per-
  // user and contains a session secret.
  res.setHeader("Cache-Control", "no-store");
  res.end();

  return {
    kind: "ok",
    session,
    redirectTo: successRedirect,
  };
}

// --- internal helpers --------------------------------------------------------

function parseQuery(url: string | undefined): {
  code: string | null;
  state: string | null;
} {
  if (!url) {
    return { code: null, state: null };
  }
  // `URL` requires an absolute base; the incoming `req.url` from Node
  // is path+query only. We pad with a synthetic origin so we can use
  // the standard parser.
  const parsed = new URL(url, "http://localhost");
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  return {
    code: code && code.length > 0 ? code : null,
    state: state && state.length > 0 ? state : null,
  };
}

function validateRedirect(target: string): void {
  if (!target.startsWith("/") || target.startsWith("//")) {
    throw new Error(
      `successRedirect must be a same-origin path starting with '/': ${target}`,
    );
  }
}

function finishError(
  res: HttpResponseLike,
  options: HandleOAuthCallbackOptions,
  result: Extract<OAuthCallbackResult, { kind: "error" }>,
): OAuthCallbackResult {
  res.statusCode = result.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    JSON.stringify({
      error: result.code,
      message: result.message,
    }),
  );
  options.onError?.(result);
  return result;
}

/**
 * Specific failure path for Requirement 3.5: when the cloud settings
 * cannot be loaded during OAuth completion the user must be told to
 * "retry later" rather than seeing a generic OAuth error. We respond
 * with HTTP 503 (service unavailable) plus a short HTML page that
 * the user agent renders directly when the callback URL is opened in
 * a top-level navigation. The page contains a static link back to
 * `/login` so the user can retry.
 */
function finishSettingsLoadFailed(
  res: HttpResponseLike,
  options: HandleOAuthCallbackOptions,
  err: unknown,
): OAuthCallbackResult {
  const message =
    "We couldn't load your saved settings. This is usually temporary — please retry later.";
  res.statusCode = 503;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // 60 seconds is generous enough to cover most transient outages
  // without making the user wait too long if they retry by hand.
  res.setHeader("Retry-After", "60");
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Try again later</title></head>` +
      `<body><h1>Try again later</h1>` +
      `<p>${escapeHtml(message)}</p>` +
      `<p><a href="/login">Back to sign in</a></p>` +
      `</body></html>`,
  );
  const result: Extract<OAuthCallbackResult, { kind: "settings_load_failed" }> = {
    kind: "settings_load_failed",
    status: 503,
    message,
  };
  // Surface to onError as a sentinel so logging captures the underlying
  // failure without leaking secrets. We synthesize a minimal `error`
  // shape so the onError listener can keep its existing handler.
  options.onError?.({
    kind: "error",
    status: 503,
    code: "internal_error",
    message: `settings_load_failed: ${describeError(err)}`,
  });
  return result;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return m.length > 0 ? m : err.name;
  }
  if (typeof err === "string") {
    return err;
  }
  return "unknown error";
}
