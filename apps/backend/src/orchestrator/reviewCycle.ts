/**
 * Review_Cycle counting, limits and Boss approval constraints.
 *
 * Task 9.2 layers cycle bookkeeping on top of the pure transition function
 * exposed by `stateMachine.ts` (task 9.1). Where `transition` is concerned
 * only with structural status changes, {@link applyEvent} additionally:
 *
 *  - increments `state.reviewCycles` whenever the pipeline enters `fixing`
 *    (either via Reviewer→Fixer on `defects_found` or via Boss→Fixer on
 *    `boss_rejected`), modeling design.md → "Pipeline rules" / "Review cycle
 *    definition" — each entry into Fixing represents one Reviewer–Fixer–
 *    Reviewer pass that counts toward the cap;
 *  - relies on the existing structural guards
 *    (`review_cycles_lt_max` / `review_cycles_ge_max`) to redirect to
 *    `stopped_limit` when the next pass would exceed the cap;
 *  - relies on the existing `review_cycles_ge_1` guard to reject a Boss
 *    `соответствует` verdict when no Review_Cycle has been performed yet
 *    (Requirement 14.1).
 *
 * Sources:
 *  - requirements.md →
 *      7.8  ("ограничить количество итераций исправления значением не более 5"),
 *      8.5  (default `maxReviewCycles = 5`),
 *      8.6  (stopped task on cap reached),
 *      14.1 (Boss approval requires ≥ 1 Review_Cycle),
 *      14.4 (Final_Report status when cap is hit).
 *  - design.md → "Pipeline rules", "Review cycle definition".
 *  - tasks.md → task 9.2 sub-bullets.
 *
 * Out of scope of this module:
 *  - Property tests for the cap and Boss precondition (tasks 9.3, 9.4).
 *  - End-to-end orchestrator wiring of timestamps, persistence and trace
 *    emission (task 15.1).
 */

import {
  TaskTransitionError,
  transition,
  type TaskEvent,
  type TaskState,
  type TransitionError,
  type TransitionResult,
} from "./stateMachine.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Apply `event` to `state`, returning the next `TaskState` with both the
 * updated `status` (delegated to {@link transition}) and the updated
 * `reviewCycles` counter.
 *
 * Cycle accounting rule: increment `reviewCycles` by exactly one whenever
 * the resulting status is `fixing` and the originating status was not
 * `fixing` itself. In the design state diagram only two edges have `fixing`
 * as their target — `reviewing → fixing` (`defects_found`) and
 * `boss_eval → fixing` (`boss_rejected`) — so this single rule covers both
 * the "Reviewer→Fixer→Reviewer loop" case and the "Boss не соответствует
 * feedback" case called out in tasks.md task 9.2.
 *
 * The function is pure: it never mutates `state`. On structural failure
 * (e.g. an event with no matching edge, or a guard that blocks entry to
 * `fixing` because the cap has been reached) it returns the underlying
 * `TransitionResult` unchanged so callers can surface the original error
 * code (`invalid_transition` / `terminal_state` / `guard_failed`).
 */
export function applyEvent(state: TaskState, event: TaskEvent): TransitionResult {
  const result = transition(state, event);
  if (!result.ok) {
    return result;
  }

  const enteringFixing =
    result.next.status === "fixing" && state.status !== "fixing";

  if (!enteringFixing) {
    return result;
  }

  return {
    ok: true,
    next: { ...result.next, reviewCycles: state.reviewCycles + 1 },
  };
}

/**
 * Convenience wrapper that throws on transition failure. Mirrors
 * `transitionOrThrow` from `stateMachine.ts` and is intended for orchestrator
 * code paths that have already validated their preconditions.
 *
 * For user-facing flows prefer {@link applyEvent} so the typed error code
 * can drive structured error responses (Requirement 8.6 — surfacing
 * "stopped_limit" cleanly to the Final_Report; Requirement 14.1 —
 * differentiating "guard_failed" from "invalid_transition" when the Boss
 * tries to approve too early).
 */
export function applyEventOrThrow(state: TaskState, event: TaskEvent): TaskState {
  const result = applyEvent(state, event);
  if (!result.ok) {
    throw new TaskTransitionError(result.error);
  }
  return result.next;
}

export type { TaskEvent, TaskState, TransitionError, TransitionResult };
