/**
 * Orchestrator-related port shapes for shared-ui screens (task 8.1).
 *
 * `shared-ui` cannot depend on `apps/backend/...` directly — that would
 * couple the UI package to backend internals and to its build graph.
 * The Task Builder controller therefore depends on the *shape* defined
 * here. Composition adapters in the renderer (and stubs in tests) wire
 * a concrete `Orchestrator.createTask` (or its Client SDK proxy) into
 * an object matching this interface.
 *
 * The shape mirrors, verbatim, the public contract already documented
 * in:
 *
 *   • design.md → "Orchestrator Core" → "Validation rules" plus the
 *     `createTask` interface.
 *   • design.md → "Components and Interfaces" → "Client SDK" →
 *     `TaskClient.createTask`.
 *   • requirements.md → 6.1, 6.2, 6.3, 6.5, 6.7, 6.8, 13.4.
 *   • Backend reference: `apps/backend/src/orchestrator/createTask.ts`
 *     (`CreateTaskError` + `CreateTaskErrorCode`).
 *
 * This file deliberately only re-states the static contract. It does
 * NOT pull from `@ai-agent-orchestrator/validation` runtime schemas —
 * shared-ui consumers only need static types, and lifting the runtime
 * dependency keeps the bundle smaller. Same convention as
 * `./settings.ts` and `./artifacts.ts`.
 *
 * The gateway intentionally does NOT carry `ownerScope`: the desktop
 * renderer / web shell adapter derives it from the active session
 * before forwarding to the backend. Keeping scope out of the UI port
 * mirrors the login gateway's "no deviceId in the controller"
 * convention so the same controller works unchanged across hosts.
 */

import type { CreateTaskInput } from "@ai-agent-orchestrator/validation";

export type { CreateTaskInput } from "@ai-agent-orchestrator/validation";

/**
 * Stable error codes the Task Builder surfaces inline when
 * {@link TaskBuilderGateway.createTask} rejects. Mirrors
 * `CreateTaskErrorCode` from
 * `apps/backend/src/orchestrator/createTask.ts`, plus a synthetic
 * `unknown` for anything the gateway throws that does not carry a
 * `code`.
 *
 * Listing the codes locally (rather than importing from the backend
 * package) keeps the shared-ui package free of a backend dependency —
 * the desktop and web hosts wire whatever transport they like as long
 * as it surfaces the same string codes on its rejection error.
 *
 * Order matches the backend's documented validation pipeline so a UI
 * that wants to surface only the first-failing reason can rely on it.
 */
export type CreateTaskErrorCode =
  | "empty_prompt"
  | "invalid_input"
  | "model_unavailable"
  | "fallback_not_confirmed"
  | "manual_mode_zero_participants"
  | "auto_mode_no_participants"
  | "persistence_failed";

/**
 * Structural shape of the rejection error thrown by a
 * {@link TaskBuilderGateway.createTask} implementation on a
 * validation/business failure.
 *
 * The desktop adapter typically forwards the backend
 * `CreateTaskError` instance verbatim; an over-IPC web adapter
 * reconstructs an object that satisfies this shape (since class
 * identity does not survive the boundary). The controller checks for
 * the structural shape, so both wirings work.
 */
export interface CreateTaskErrorLike {
  readonly name: "CreateTaskError";
  readonly code: CreateTaskErrorCode;
  readonly message: string;
}

/**
 * Type guard for the structural error shape returned by
 * {@link TaskBuilderGateway.createTask}. Lives next to the type so
 * controllers in this package can branch on `code` without importing
 * the backend class at runtime.
 */
export function isCreateTaskError(err: unknown): err is CreateTaskErrorLike {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name !== "CreateTaskError") return false;
  if (typeof e.message !== "string") return false;
  if (typeof e.code !== "string") return false;
  return (
    e.code === "empty_prompt" ||
    e.code === "invalid_input" ||
    e.code === "model_unavailable" ||
    e.code === "fallback_not_confirmed" ||
    e.code === "manual_mode_zero_participants" ||
    e.code === "auto_mode_no_participants" ||
    e.code === "persistence_failed"
  );
}

/**
 * Narrow gateway port the Task Builder controller depends on.
 *
 * In production this is wired (through the Client SDK) to the backend
 * `Orchestrator.createTask` defined in
 * `apps/backend/src/orchestrator/createTask.ts`. In tests it is
 * stubbed.
 *
 * Behaviour rules mirror the backend contract:
 *
 *   • On success, returns `{ taskId }` (Requirement 6.8).
 *   • On a validation/business failure, throws an error satisfying
 *     {@link CreateTaskErrorLike}. The controller branches on `code`
 *     to produce a precise inline message (Requirement 6.4 / 6.5 /
 *     6.6 / 6.7).
 *   • On any other failure (network down, etc.), the gateway may
 *     throw a plain `Error`; the controller maps it to `code:
 *     "unknown"` for the UI surface.
 *   • `confirmedFallback` is required when the chosen
 *     `input.modelRef.source === "platform-fallback"` (Requirement
 *     13.4 / `fallback_not_confirmed`); the host adapter is expected
 *     to collect the user's confirmation before invoking this method.
 */
export interface TaskBuilderGateway {
  createTask(
    input: CreateTaskInput,
    options?: { readonly confirmedFallback?: boolean },
  ): Promise<{ readonly taskId: string }>;
}
