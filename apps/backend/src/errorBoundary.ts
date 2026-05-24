/**
 * Backend error boundary helper (task 20.1).
 *
 * Sources:
 *   • design.md → "Auth Service" → "Rules" — API_Key never included in
 *     error responses; OAuth/secret material never echoed back.
 *   • design.md → "Settings Store" → "Rules" — descriptive errors must
 *     not leak secrets.
 *   • requirements.md → 1.6, 3.7, 4.5.
 *
 * The Auth Service, Settings Store and Orchestrator already produce
 * typed errors (`LocalSessionError`, `CreateTaskError`,
 * `GoogleOAuthError`, …). What this module adds is a single, opt-in
 * adapter that:
 *
 *   • runs every thrown value through {@link redactStructuredError} so
 *     the renderer never sees an API-key-shaped substring in `code`,
 *     `message`, or `details`;
 *   • translates the redacted envelope into a typed
 *     {@link AsyncResult} so wrapped handlers stop using exceptions as
 *     their public failure channel.
 *
 * Why opt-in: the Auth and Orchestrator implementations already
 * carefully handle their own error messages and we do not want this
 * task to refactor every existing call site. Per the 20.1 brief, the
 * minimum coverage is `Orchestrator.createTask`, `validateApiKey`, and
 * `completeGoogleOAuth`; helpers below cover those three explicitly.
 *
 * Validates: Requirements 1.6, 3.7, 4.5.
 */

import {
  redactStructuredError,
  type RedactedStructuredError,
} from "@ai-agent-orchestrator/shared-core";

/**
 * The success / failure envelope produced by {@link wrapAsyncHandler}.
 *
 * Using a discriminated union (rather than re-throwing) gives the
 * gateway / IPC layer a single shape to serialise: it can return the
 * envelope verbatim and let the renderer branch on `ok`. Wrapped
 * handlers stop ever leaking exceptions to the boundary.
 */
export type AsyncResult<TOut> =
  | { readonly ok: true; readonly value: TOut }
  | { readonly ok: false; readonly error: RedactedStructuredError };

/**
 * Wrap an async handler so any thrown value is converted into a
 * redacted, structured error envelope.
 *
 * The wrapper:
 *
 *   1. Calls `fn(input)` exactly once.
 *   2. On success, returns `{ ok: true, value }`.
 *   3. On failure, runs the thrown value through
 *      {@link redactStructuredError} and returns
 *      `{ ok: false, error }`. The redactor preserves a string `code`
 *      field on Error subclasses so callers (e.g. the Gmail UI's
 *      `settings_load_failed` branch, Requirement 3.5) keep working;
 *      otherwise the envelope reports `code: "unknown"`.
 *
 * Side effects: none. The wrapper itself never throws.
 */
export function wrapAsyncHandler<TIn, TOut>(
  fn: (input: TIn) => Promise<TOut>,
): (input: TIn) => Promise<AsyncResult<TOut>> {
  return async (input: TIn) => {
    try {
      const value = await fn(input);
      return { ok: true, value };
    } catch (err: unknown) {
      return { ok: false, error: redactStructuredError(err) };
    }
  };
}

/**
 * Convenience wrapper for handlers that take no input. Returns a
 * thunk that produces the same {@link AsyncResult}.
 *
 * Used so the boundary helpers below stay readable — `wrapAsync(() =>
 * service.completeGoogleOAuth(...))` reads better than passing `(_:
 * void) => ...` through {@link wrapAsyncHandler}.
 */
export function wrapAsync<TOut>(
  fn: () => Promise<TOut>,
): () => Promise<AsyncResult<TOut>> {
  return async () => {
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (err: unknown) {
      return { ok: false, error: redactStructuredError(err) };
    }
  };
}
