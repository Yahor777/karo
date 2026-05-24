/**
 * Shared secret/PII redaction utilities (task 20.1).
 *
 * The redaction logic was first introduced in the Desktop Shell
 * (`apps/desktop-windows/src/shell/redaction.ts`, task 3.4) so that
 * `LocalLogEntry`s could not carry API-key-shaped material to disk.
 * Task 20.1 extends that policy to the backend gateway (HTTP/IPC error
 * responses) and to the Trace Event Bus (`tool_call.input` /
 * `tool_call.output` / `thought.text` carried in
 * {@link TraceRecord}s) so the same masking applies on every boundary
 * a secret could plausibly cross.
 *
 * Sources:
 *   • design.md → "Desktop Shell" → "Security rules" — "Sensitive logs
 *     must redact API keys", "Full API keys must never be displayed
 *     after initial entry time".
 *   • design.md → "Auth Service" → "Rules" — "API_Key must never be
 *     included in Session response".
 *   • design.md → "Settings Store" → "Rules" — "Decrypted API_Key must
 *     not be returned to client".
 *   • requirements.md → 1.6, 3.7, 4.5.
 *
 * Public API (intentionally narrow):
 *
 *   • {@link redactString}            — masks API-key-shaped substrings
 *     (`sk-…`, OpenAI organisation ids, Anthropic keys (which share the
 *     `sk-ant-` prefix), Stripe keys, GitHub tokens, AWS access key
 *     ids, JWTs, Google OAuth access/refresh tokens, generic
 *     `Bearer …` headers, any 40+ char opaque alphanumeric run, email
 *     addresses) with `[REDACTED:<tag>]` placeholders.
 *   • {@link redactValue}             — recursive redactor preserving the
 *     legacy Desktop Shell behaviour (`[REDACTED:cycle]`,
 *     `[REDACTED:unsupported]`, no depth bound). Re-exported by the
 *     Desktop Shell barrel so existing call sites keep working.
 *   • {@link redactRecord}            — task-20.1 deep-clone-and-redact
 *     for arbitrary JSON-shaped values used by backend boundaries
 *     (Trace Event Bus, error envelopes). Bounded by `maxDepth`,
 *     replaces `Uint8Array` / `ArrayBuffer` payloads with
 *     `[redacted-binary:<n>-bytes]` so logs cannot accidentally embed
 *     arbitrary bytes that may contain key material.
 *   • {@link redactStructuredError}   — turns any thrown value into a
 *     `{ code, message, details? }` envelope with secrets redacted.
 *     Preserves a string `code` field if present; otherwise classifies
 *     the failure as `"unknown"`. Never throws.
 *
 * Validates: Requirements 1.6, 3.7, 4.5.
 */

const REDACTION_PREFIX = "[REDACTED:";
const REDACTION_SUFFIX = "]";

/** Builds a placeholder of the form `[REDACTED:<tag>]`. */
function placeholder(tag: string): string {
  return `${REDACTION_PREFIX}${tag}${REDACTION_SUFFIX}`;
}

/** Sentinel for binary payloads — `[redacted-binary:<n>-bytes]`. */
function binaryPlaceholder(byteLength: number): string {
  return `[redacted-binary:${byteLength}-bytes]`;
}

/**
 * A single redaction rule. Rule order matters: more specific patterns
 * (provider-prefixed keys) run before broad catch-alls (any 40+ char
 * alphanumeric run) so that a Stripe-shaped key reports as
 * `api_key:stripe`, not the generic `token:opaque`.
 */
type RedactionRule = {
  readonly tag: string;
  readonly pattern: RegExp;
};

/**
 * Ordered redaction rules. Each pattern uses the global flag so
 * `String.prototype.replace` rewrites every occurrence in a single
 * pass.
 */
const RULES: readonly RedactionRule[] = [
  // OpenAI keys — `sk-...`, `sk-proj-...`, plus Anthropic `sk-ant-...`
  // which shares the prefix. The tag stays `api_key:openai` for
  // backwards compatibility with the existing Desktop Shell tests; the
  // shape itself is what matters for redaction.
  {
    tag: "api_key:openai",
    pattern: /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g,
  },
  // OpenAI organisation ids — `org-` followed by 20+ alphanumerics.
  // Not strictly secret, but design.md treats anything user-scoped
  // and Provider-bound as redactable in logs/error payloads.
  {
    tag: "api_key:openai_org",
    pattern: /\borg-[A-Za-z0-9]{20,}\b/g,
  },
  // Stripe-style keys: `pk_test_...`, `sk_live_...`, etc.
  {
    tag: "api_key:stripe",
    pattern: /\b[ps]k_(?:test|live)_[A-Za-z0-9]{16,}\b/g,
  },
  // GitHub tokens: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`.
  {
    tag: "api_key:github",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  },
  // AWS access key id: `AKIA` + 16 uppercase alphanumerics.
  {
    tag: "api_key:aws",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  // Google OAuth access tokens — `ya29.<base64url>`.
  {
    tag: "token:google_oauth",
    pattern: /\bya29\.[A-Za-z0-9_-]{20,}/g,
  },
  // Google OAuth refresh tokens — `1//<base64url>`. Anchored on a
  // word boundary so the leading `1` does not match standalone digits.
  {
    tag: "token:google_refresh",
    pattern: /\b1\/\/[A-Za-z0-9_-]{20,}/g,
  },
  // JWT-shaped values: three base64url segments joined by dots.
  {
    tag: "token:jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // `Authorization: Bearer ...` and `Bearer ...` headers.
  {
    tag: "token:bearer",
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._\-+/=]+/g,
  },
  // Generic long alphanumeric tokens (40+ chars). This covers hex
  // secrets, raw API tokens and similar opaque strings that do not
  // match any of the prefixed rules above.
  {
    tag: "token:opaque",
    pattern: /\b[A-Za-z0-9]{40,}\b/g,
  },
  // Email addresses. Local-part allows the standard subset; the
  // domain requires at least one dot to avoid matching things like
  // `user@host` which is rarely PII in this codebase.
  {
    tag: "email",
    pattern:
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,
  },
];

/**
 * Returns the input string with all known secret/PII shapes replaced
 * by `[REDACTED:<tag>]` placeholders. Pure and never throws.
 */
export function redactString(value: string): string {
  let result = value;
  for (const rule of RULES) {
    // Reset `lastIndex` defensively; the global flag persists state
    // when a pattern is reused with `.exec`. Using `replace` resets
    // it implicitly, but the explicit reset makes the intent visible
    // and is cheap.
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, placeholder(rule.tag));
  }
  return result;
}

/**
 * Recursively redacts strings inside arbitrary structured data, in the
 * shape expected by the Desktop Shell's `redactLogEntry` (task 3.4).
 *
 * Behaviour:
 *   • Strings → `redactString`.
 *   • Arrays / plain objects → walked element-wise, keys preserved.
 *   • Cycles → `[REDACTED:cycle]`.
 *   • Functions / symbols → `[REDACTED:unsupported]`.
 *   • Other primitives (`number`, `boolean`, `bigint`, `null`,
 *     `undefined`) → returned as-is.
 *
 * No depth bound. Use {@link redactRecord} when a depth bound or
 * binary handling is required (server-side logging/trace boundaries).
 */
export function redactValue(value: unknown): unknown {
  return redactValueInner(value, new WeakSet<object>());
}

function redactValueInner(
  value: unknown,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || value === undefined) {
    return value;
  }
  const valueType = typeof value;
  if (
    valueType === "number" ||
    valueType === "boolean" ||
    valueType === "bigint"
  ) {
    return value;
  }
  if (valueType === "function" || valueType === "symbol") {
    return placeholder("unsupported");
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return placeholder("cycle");
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => redactValueInner(item, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactValueInner(child, seen);
    }
    return out;
  }
  // Fallback: stringify and redact. Hits exotic prototypes only —
  // anything reaching this branch is neither a primitive, an array,
  // nor a plain object, so we use `safeStringify` to avoid relying on
  // the value's `toString` (which could itself embed secrets via a
  // misbehaving accessor).
  return redactString(safeStringify(value));
}

/**
 * Default depth bound for {@link redactRecord}. The trace bus and
 * error boundary call sites carry shallow JSON-shaped payloads (most
 * objects nest 1–2 levels); 4 lets us walk reasonable structures while
 * still terminating fast on accidental megagraphs.
 */
export const DEFAULT_REDACT_RECORD_MAX_DEPTH = 4;

/**
 * Deep-clone-and-redact for arbitrary JSON-shaped values used at
 * backend boundaries (Trace Event Bus, error envelopes, gateway
 * responses).
 *
 * Differs from {@link redactValue} in three ways:
 *
 *   1. **Depth bound** — guards against accidentally walking deeply
 *      nested or rapidly-fanning structures. Anything below the bound
 *      is replaced with `[REDACTED:max_depth]`.
 *   2. **Binary handling** — `Uint8Array` / `ArrayBuffer` payloads are
 *      replaced with `[redacted-binary:<n>-bytes]` so callers cannot
 *      smuggle arbitrary bytes through trace records or error details.
 *   3. **Tag stability** — the cycle and unsupported markers match
 *      `redactValue` so a payload moved between Desktop Shell logs and
 *      the backend boundary produces the same redaction shape.
 *
 * Cycles short-circuit. Functions, symbols and exotic prototypes are
 * replaced with `[REDACTED:unsupported]`. The function never throws
 * for any input.
 */
export function redactRecord(
  value: unknown,
  maxDepth: number = DEFAULT_REDACT_RECORD_MAX_DEPTH,
): unknown {
  // A negative or non-finite depth is treated as `0` so the caller
  // gets a deterministic top-level placeholder rather than a stack
  // overflow.
  const safeDepth =
    Number.isFinite(maxDepth) && maxDepth >= 0 ? Math.floor(maxDepth) : 0;
  return redactRecordInner(value, safeDepth, new WeakSet<object>());
}

function redactRecordInner(
  value: unknown,
  remainingDepth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || value === undefined) {
    return value;
  }
  const valueType = typeof value;
  if (
    valueType === "number" ||
    valueType === "boolean" ||
    valueType === "bigint"
  ) {
    return value;
  }
  if (valueType === "function" || valueType === "symbol") {
    return placeholder("unsupported");
  }
  // Binary payloads: surface only the byte length.
  if (value instanceof Uint8Array) {
    return binaryPlaceholder(value.byteLength);
  }
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
    return binaryPlaceholder(value.byteLength);
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return placeholder("cycle");
    }
    if (remainingDepth <= 0) {
      return placeholder("max_depth");
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) =>
        redactRecordInner(item, remainingDepth - 1, seen),
      );
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactRecordInner(child, remainingDepth - 1, seen);
    }
    return out;
  }
  return redactString(safeStringify(value));
}

/**
 * Structured error envelope returned by {@link redactStructuredError}.
 *
 * `code` is always a string — preserved verbatim from the input when it
 * already exposed one as a string field; otherwise `"unknown"`.
 * `message` is always a redacted string. `details` is only present
 * when the input carried a `details` field; it is recursively redacted
 * via {@link redactRecord}.
 */
export interface RedactedStructuredError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

/**
 * Turns any thrown value into a structured envelope with secrets
 * redacted. Used at HTTP/IPC error boundaries (gateway responses,
 * desktop-shell error reporting) so a thrown `Error` whose message
 * embeds an API key cannot leak that key back to the renderer.
 *
 * Rules:
 *   • If `err` is an `Error` (or otherwise carries a string `code`
 *     property), the `code` is preserved verbatim. Otherwise the
 *     envelope reports `"unknown"`.
 *   • `message` is sourced from `err.message` (when `err instanceof
 *     Error`) or from `err.message` on plain objects, and run through
 *     {@link redactString}. Strings are used directly. Everything else
 *     stringifies to an empty message rather than risk leaking a
 *     toString implementation that embeds secrets.
 *   • `details` is included only when the input carried a `details`
 *     field, in which case it is run through {@link redactRecord}.
 *   • The function never throws — a final `try/catch` wraps the entire
 *     flow as a defence-in-depth so error boundaries cannot themselves
 *     fail and surface a partially-formed reply.
 */
export function redactStructuredError(err: unknown): RedactedStructuredError {
  try {
    if (err instanceof Error) {
      const code = readStringField(err, "code") ?? "unknown";
      const message = redactString(err.message);
      const details = readUnknownField(err, "details");
      if (details !== undefined) {
        return { code, message, details: redactRecord(details) };
      }
      return { code, message };
    }
    if (typeof err === "string") {
      return { code: "unknown", message: redactString(err) };
    }
    if (err === null || err === undefined) {
      return { code: "unknown", message: "" };
    }
    if (typeof err === "object") {
      const code = readStringField(err, "code") ?? "unknown";
      const messageRaw = readUnknownField(err, "message");
      const message =
        typeof messageRaw === "string" ? redactString(messageRaw) : "";
      const details = readUnknownField(err, "details");
      if (details !== undefined) {
        return { code, message, details: redactRecord(details) };
      }
      return { code, message };
    }
    // Numbers, booleans, bigints, symbols, functions — none of these
    // are typical thrown shapes; surface them as a redacted string.
    // We have already excluded Error / string / null / undefined /
    // object above, so `String()` here only sees primitives or
    // functions whose `toString` is well-defined.
    return { code: "unknown", message: redactString(safeStringify(err)) };
  } catch {
    // Last-resort: never throw. A misbehaving accessor on the input
    // (a getter that throws) would otherwise crash the boundary.
    return { code: "unknown", message: "" };
  }
}

/**
 * Returns the value of `key` on `source` when it is a string, otherwise
 * `undefined`. Tolerates accessors that throw via the `try/catch`
 * inside {@link redactStructuredError}.
 */
function readStringField(source: unknown, key: string): string | undefined {
  if (source === null || source === undefined) return undefined;
  if (typeof source !== "object") return undefined;
  const candidate = (source as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Returns the value of `key` on `source`, or `undefined` if `source`
 * is not an indexable object.
 */
function readUnknownField(source: unknown, key: string): unknown {
  if (source === null || source === undefined) return undefined;
  if (typeof source !== "object") return undefined;
  return (source as Record<string, unknown>)[key];
}

/**
 * Coerces an unknown value to a short, predictable string for the
 * fallback paths inside {@link redactValueInner}, {@link redactRecordInner}
 * and {@link redactStructuredError}. We deliberately avoid relying on
 * the value's own `toString` (which could embed secrets via a
 * misbehaving getter) and on `JSON.stringify` (which throws on
 * cycles). Returns the empty string when no safe representation can
 * be derived; the redactor's calling site is itself bounded by the
 * outer `try/catch`, so an empty fallback is acceptable.
 */
function safeStringify(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return value.toString();
    case "symbol":
      return value.description ?? "Symbol";
    case "function":
      return "[function]";
    case "undefined":
      return "";
    default:
      // Object / null path.
      if (value === null) return "null";
      try {
        return JSON.stringify(value) ?? "[object]";
      } catch {
        return "[object]";
      }
  }
}
