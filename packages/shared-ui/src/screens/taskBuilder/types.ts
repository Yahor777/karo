/**
 * Task Builder screen types (task 8.1).
 *
 * Source:
 *   • design.md → "Orchestrator Core" → "Validation rules".
 *   • design.md → "Components and Interfaces" → "Client SDK" →
 *     `TaskClient.createTask`.
 *   • requirements.md → 6.1, 6.2, 6.3, 6.5.
 *   • Backend integration via `Orchestrator.createTask` from
 *     `apps/backend/src/orchestrator/createTask.ts` (its
 *     `CreateTaskErrorCode` drives the inline error surface here).
 *
 * The Task Builder screen is framework-free, mirroring the login and
 * model-selection screens. Pure form state lives in
 * {@link TaskBuilderState}; gateway calls go through the narrow
 * {@link TaskBuilderGateway} port (declared in
 * `packages/shared-ui/src/ports/orchestrator.ts`) so tests can swap a
 * stub without spinning up the whole backend.
 *
 * The model selector is composed, not imported: hosts pass a flat list
 * of `ModelInfo` (already grouped by provider as
 * {@link ProviderModelsResult} entries) into the mount helper. Keeping
 * the catalog controller out of the Task Builder lets each screen
 * evolve independently — and it lets a future web shell wire its own
 * catalog source without touching this module.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.5.
 */

import type {
  AgentId,
  ModelRef,
} from "@ai-agent-orchestrator/shared-core";

import type {
  CreateTaskErrorCode,
  CreateTaskInput,
  TaskBuilderGateway,
} from "../../ports/orchestrator.js";

import type {
  ModelInfo,
  ProviderModelsResult,
} from "../models/types.js";

// Re-export types consumers commonly need so they don't have to reach
// into shared-core / validation / ports directly.
export type { AgentId, ModelRef, CreateTaskInput, TaskBuilderGateway };
export type { ModelInfo, ProviderModelsResult };

/**
 * Task mode discriminant.
 *
 *   • `"auto"`    — Orchestrator picks participants (Requirement 6.3).
 *   • `"manual"`  — User picks participants explicitly (Requirement 6.2).
 */
export type TaskMode = "auto" | "manual";

/**
 * Stable error codes the controller surfaces inline when `submit()`
 * rejects. Mirrors {@link CreateTaskErrorCode} plus a synthetic
 * `unknown` for anything the gateway throws that does not carry a
 * `code`.
 */
export type TaskBuilderErrorCode = CreateTaskErrorCode | "unknown";

/**
 * Submit-side discriminated union. The render layer reads `kind` to
 * decide what to show under the launch button:
 *
 *   • `"idle"`       — nothing in flight, no error.
 *   • `"submitting"` — gateway call in progress; the launch button is
 *     disabled.
 *   • `"submitted"`  — gateway returned a `taskId`; the host shell
 *     typically navigates away to the task view.
 *   • `"error"`      — gateway rejected. `code` is one of
 *     {@link TaskBuilderErrorCode} so the UI can render a precise
 *     message; `message` is safe to surface verbatim (the backend
 *     `CreateTaskError.message` never carries secrets).
 */
export type TaskBuilderSubmitStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "submitted"; readonly taskId: string }
  | {
      readonly kind: "error";
      readonly code: TaskBuilderErrorCode;
      readonly message: string;
    };

/**
 * Full Task Builder form state. Snapshots are immutable; the
 * controller swaps the whole object on every change so subscribers can
 * use referential equality to short-circuit redundant renders.
 */
export interface TaskBuilderState {
  readonly prompt: string;
  readonly modelRef: ModelRef | null;
  readonly mode: TaskMode;
  /**
   * Participant agent ids selected in Manual_Mode. The array is kept
   * even when `mode === "auto"` so toggling the mode does not lose
   * the user's previous selection (Requirement 6.2).
   */
  readonly participants: readonly AgentId[];
  /**
   * Set to `true` once the user has been notified about platform
   * fallback usage and explicitly confirmed (Requirement 13.4 via
   * design "Validation rules"). The controller forwards this flag
   * to the gateway when `modelRef.source === "platform-fallback"`.
   */
  readonly confirmedFallback: boolean;
  readonly submit: TaskBuilderSubmitStatus;
}

/**
 * Events emitted to the host shell. Today the controller emits
 * exactly one event — `taskCreated` — when `submit()` succeeds; the
 * host typically uses it to navigate to the task overview screen.
 *
 * Modelled as a discriminated union so future events (e.g. "model
 * picker requested") can be added without breaking listeners.
 */
export type TaskBuilderEvent = {
  readonly type: "taskCreated";
  readonly taskId: string;
};

export type TaskBuilderStateListener = (state: TaskBuilderState) => void;
export type TaskBuilderEventListener = (event: TaskBuilderEvent) => void;

/**
 * Lightweight description of a participant the agent picker can offer.
 * The controller stores `AgentId` strings only; the mount helper
 * accepts the richer shape so it can render display names without a
 * separate lookup.
 */
export interface AgentPickerOption {
  readonly id: AgentId;
  readonly displayName: string;
  /**
   * Optional short description rendered next to the checkbox. Useful
   * for distinguishing builtin roles ("Reviewer — checks for defects")
   * from custom agents.
   */
  readonly description?: string;
}
