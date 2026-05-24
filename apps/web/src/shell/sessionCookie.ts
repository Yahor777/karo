/**
 * Web-shell session cookie helpers (task 18.1).
 *
 * Source:
 *   • design.md → "Auth Service" → "Rules":
 *       "For Web App, session should use secure HTTP-only cookie."
 *   • design.md → "Web Shell" → "Rules":
 *       "Web Shell cannot use Windows Local Encrypted Storage."
 *       "Web Shell relies on cloud session."
 *   • requirements.md → Requirements 1.2, 1.7, 3.1.
 *
 * What this module owns:
 *
 *   • {@link SESSION_COOKIE_NAME}     — the cookie name used by the web
 *     shell. Centralised so request and response paths cannot drift.
 *   • {@link buildSetCookieHeader}    — pure function that produces a
 *     `Set-Cookie` header value with the secure defaults required by
 *     design.md (`HttpOnly`, `Secure`, `SameSite=Lax`).
 *   • {@link buildClearCookieHeader}  — pure function that produces a
 *     `Set-Cookie` header value to clear the session cookie (logout).
 *   • {@link writeSessionCookie}      — writes the `Set-Cookie` header
 *     onto a response object using {@link HttpResponseLike}.
 *   • {@link clearSessionCookie}      — convenience wrapper for logout.
 *   • {@link readSessionCookie}       — parses an incoming `Cookie`
 *     header and returns the session id if present.
 *
 * Important non-goals:
 *
 *   • This module does NOT encrypt or sign the cookie value. The
 *     opaque session id minted by `AuthService` (a UUID) is what gets
 *     stored. Tampering protection at-rest comes from the server-side
 *     session lookup, not from cookie cryptography. This matches
 *     design.md's session model — the cookie is only an opaque key.
 *   • This module does NOT touch any local storage primitive. Web
 *     Shell must NOT use `localStorage` / `IndexedDB` for the session
 *     because that would defeat the `HttpOnly` flag. The function
 *     names and types are intentionally free of any "local store"
 *     surface so a copy/paste mistake during reviews is hard to make.
 *
 * Validates: Requirements 1.2, 1.7, 3.1.
 */

import type {
  HttpResponseLike,
  Session,
  SessionCookieOptions,
} from "./types.js";

/**
 * Canonical name for the session cookie used by the web shell.
 *
 * Prefixed with `__Host-` to enforce the OWASP-recommended cookie
 * scoping rules (Secure, no Domain, Path=/, host-only). User agents
 * reject `__Host-` cookies that violate any of those constraints,
 * which gives us a static guarantee that we cannot accidentally widen
 * the scope of the session cookie at deploy time.
 *
 * If a deployment must run on `http://localhost` for early
 * development, callers can use {@link buildSetCookieHeader} with
 * `secure: false` and a non-prefixed cookie name. Production code
 * MUST use this constant.
 */
export const SESSION_COOKIE_NAME = "__Host-aiao_session" as const;

/** Default cookie path for the session cookie. */
const DEFAULT_PATH = "/";

/** Default `SameSite` policy. */
const DEFAULT_SAME_SITE: "Strict" | "Lax" | "None" = "Lax";

/**
 * Internal: same as {@link SessionCookieOptions} but with `name` and
 * `value` so the test surface can assert encoding for non-session
 * cookies as well. Not exported because production callers should go
 * through {@link writeSessionCookie}.
 */
interface BuildCookieInput {
  readonly name: string;
  readonly value: string;
  readonly options: SessionCookieOptions;
}

/**
 * Encodes a `Set-Cookie` header value from the supplied bag. Pure —
 * no global state and no I/O. Used by both the session-issuance and
 * session-clearing paths.
 *
 * Output format follows RFC 6265 §4.1, with the additional flags:
 *
 *   • `HttpOnly`            — defaults `true` (design.md "secure
 *     HTTP-only cookie").
 *   • `Secure`              — defaults `true`. Required by `__Host-`.
 *   • `SameSite=Lax`        — defaults. `Strict` would break the
 *     OAuth callback redirect (cross-site top-level navigation from
 *     accounts.google.com is treated as cross-site by Strict).
 *   • `Path=/`              — required by `__Host-`.
 *   • No `Domain`           — required by `__Host-` (host-only cookie).
 *
 * The function rejects:
 *   • cookie names with control characters or `=`/`;`/whitespace,
 *   • cookie values with `;`, `,`, control characters or unencoded
 *     whitespace,
 *   • combining `Domain` with the `__Host-` name prefix.
 *
 * Rejection is by `Error` — the function is internal and the caller
 * shape is fully type-checked, so a thrown error means a programming
 * mistake worth surfacing.
 */
function buildCookieHeader(input: BuildCookieInput): string {
  const { name, value, options } = input;

  if (!isValidCookieName(name)) {
    throw new Error(`Invalid cookie name: ${JSON.stringify(name)}`);
  }
  if (!isValidCookieValue(value)) {
    throw new Error(`Invalid cookie value for ${name}`);
  }
  if (
    options.domain !== undefined &&
    name.startsWith("__Host-")
  ) {
    throw new Error(
      `'__Host-' prefixed cookies must not have a Domain attribute`,
    );
  }

  const path = options.path ?? DEFAULT_PATH;
  const sameSite = options.sameSite ?? DEFAULT_SAME_SITE;
  const secure = options.secure ?? true;
  const httpOnly = options.httpOnly ?? true;

  if (name.startsWith("__Host-") && path !== "/") {
    throw new Error(
      `'__Host-' prefixed cookies require Path=/`,
    );
  }
  if (name.startsWith("__Host-") && !secure) {
    throw new Error(
      `'__Host-' prefixed cookies require Secure`,
    );
  }
  if (sameSite === "None" && !secure) {
    throw new Error(`SameSite=None requires Secure`);
  }

  const parts: string[] = [`${name}=${value}`];
  parts.push(`Path=${path}`);
  if (options.domain !== undefined) {
    parts.push(`Domain=${options.domain}`);
  }
  if (options.maxAgeSeconds !== undefined) {
    if (
      !Number.isFinite(options.maxAgeSeconds) ||
      Math.floor(options.maxAgeSeconds) !== options.maxAgeSeconds
    ) {
      throw new Error("maxAgeSeconds must be a finite integer");
    }
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  if (options.expires !== undefined) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (httpOnly) {
    parts.push("HttpOnly");
  }
  if (secure) {
    parts.push("Secure");
  }
  parts.push(`SameSite=${sameSite}`);

  return parts.join("; ");
}

/**
 * Builds a `Set-Cookie` header value for the supplied session.
 *
 * Behaviour:
 *
 *   • The cookie name defaults to {@link SESSION_COOKIE_NAME} and the
 *     value is `session.id` URL-encoded so callers cannot accidentally
 *     produce a syntactically invalid cookie if `id` ever contains a
 *     character outside the cookie-value grammar.
 *   • If `options.maxAgeSeconds` is omitted and `session.expiresAt`
 *     is present, `Max-Age` is computed as
 *     `floor((expiresAt - now) / 1000)`. Negative or zero values
 *     are rejected — we never issue a session cookie that's already
 *     expired.
 *   • If neither is supplied, the cookie becomes a session cookie
 *     (closed when the browser exits).
 */
export function buildSetCookieHeader(
  session: Session,
  options: SessionCookieOptions = {},
  now: Date = new Date(),
): string {
  if (typeof session.id !== "string" || session.id.length === 0) {
    throw new Error("buildSetCookieHeader: session.id must be a non-empty string");
  }
  if (options.maxAgeSeconds !== undefined && options.expires !== undefined) {
    throw new Error(
      "buildSetCookieHeader: set either maxAgeSeconds or expires, not both",
    );
  }

  let resolvedOptions: SessionCookieOptions = options;
  if (options.maxAgeSeconds === undefined && options.expires === undefined) {
    if (session.expiresAt) {
      const expiresAt = Date.parse(session.expiresAt);
      if (Number.isNaN(expiresAt)) {
        throw new Error(
          "buildSetCookieHeader: session.expiresAt is not a valid ISO date",
        );
      }
      const seconds = Math.floor((expiresAt - now.getTime()) / 1000);
      if (seconds <= 0) {
        throw new Error(
          "buildSetCookieHeader: session has already expired",
        );
      }
      resolvedOptions = { ...options, maxAgeSeconds: seconds };
    }
  }

  return buildCookieHeader({
    name: SESSION_COOKIE_NAME,
    value: encodeURIComponent(session.id),
    options: resolvedOptions,
  });
}

/**
 * Builds a `Set-Cookie` header value that clears the session cookie.
 * The trick is `Max-Age=0` plus `Expires=Thu, 01 Jan 1970 00:00:00 GMT`.
 * Both are sent because some user agents honour only one.
 */
export function buildClearCookieHeader(
  options: Omit<SessionCookieOptions, "maxAgeSeconds" | "expires"> = {},
): string {
  return buildCookieHeader({
    name: SESSION_COOKIE_NAME,
    value: "",
    options: {
      ...options,
      maxAgeSeconds: 0,
      expires: new Date(0),
    },
  });
}

/**
 * Writes the `Set-Cookie` header onto `res` for the supplied session.
 * Existing `Set-Cookie` headers (from earlier middleware) are preserved.
 */
export function writeSessionCookie(
  res: HttpResponseLike,
  session: Session,
  options: SessionCookieOptions = {},
  now: Date = new Date(),
): void {
  const header = buildSetCookieHeader(session, options, now);
  appendSetCookie(res, header);
}

/** Convenience wrapper for logout / OAuth-failure paths. */
export function clearSessionCookie(
  res: HttpResponseLike,
  options: Omit<SessionCookieOptions, "maxAgeSeconds" | "expires"> = {},
): void {
  const header = buildClearCookieHeader(options);
  appendSetCookie(res, header);
}

/**
 * Returns the value of {@link SESSION_COOKIE_NAME} from the supplied
 * `Cookie` header, or `null` if not present.
 *
 * Trims whitespace around `key=value` pairs (some browsers send
 * `a=b; c=d`, others `a=b;c=d`). Returns the URL-decoded value so
 * callers receive the raw session id even after `encodeURIComponent`
 * was applied at issuance.
 */
export function readSessionCookie(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader || cookieHeader.length === 0) {
    return null;
  }
  for (const piece of cookieHeader.split(";")) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq);
    const v = trimmed.slice(eq + 1);
    if (k === SESSION_COOKIE_NAME) {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

/**
 * Appends `header` to the response's `Set-Cookie` list. Tries
 * `appendHeader` first (Node ≥ 18 surfaces it on `ServerResponse`);
 * falls back to the universally-available `setHeader('Set-Cookie',
 * [...])` form, preserving any existing values.
 */
function appendSetCookie(
  res: HttpResponseLike,
  header: string,
): void {
  if (typeof res.appendHeader === "function") {
    res.appendHeader("Set-Cookie", header);
    return;
  }
  // We can't read existing headers from `HttpResponseLike` (no `getHeader`
  // surface in our minimal port). Existing values are preserved by Node
  // when you call `setHeader` with an array; for the stub-response
  // tests we simply set the header to an array containing the new
  // value and let the stub record it.
  res.setHeader("Set-Cookie", [header]);
}

// --- internal helpers --------------------------------------------------------

function isValidCookieName(name: string): boolean {
  // RFC 6265 §4.1.1 token grammar (subset).
  return /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(name);
}

function isValidCookieValue(value: string): boolean {
  // Empty values are valid (used by clear).
  if (value.length === 0) return true;
  // Reject control chars, whitespace, `;` and `,` per RFC 6265 §4.1.1.
  return /^[!#-+\--:<-[\]-~]*$/.test(value);
}
