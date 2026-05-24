/**
 * Pipeline state machine for `TaskState`.
 *
 * Encodes design.md → "Pipeline State Machine" → "State diagram":
 *
 *   [*] --> Created
 *   Created --> Researching
 *   Researching --> Coding:       enriched prompt
 *   Coding      --> Reviewing:    file_artifact v1
 *   Reviewing   --> Fixing:       defects.length > 0 AND review_cycles < MAX
 *   Fixing      --> Reviewing:    file_artifact v(n+1)
 *   Reviewing   --> BossEval:     defects.length == 0 AND review_cycles >= 1
 *   BossEval    --> Fixing:       verdict == "не соответствует" AND review_cycles < MAX
 *   BossEval    --> Completed:    verdict == "соответствует"   AND review_cycles >= 1
 *   Reviewing   --> StoppedLimit: defects.length > 0 AND review_cycles >= MAX
 *   BossEval    --> StoppedLimit: verdict != "соответствует"   AND review_cycles >= MAX
 *
 * Sources:
 * - requirements.md → 8.1, 8.2, 8.3, 8.4, 8.7 (pipeline order, review-cycle
 *   loop, Boss feedback, completion).
 * - requirements.md → 14.1 (Boss approval requires ≥ 1 Review_Cycle).
 * - design.md → "Pipeline rules", "Review cycle definition".
 *
 * Scope of task 9.1:
 * - encode states and events;
 * - encode structural transitions per the diagram;
 * - encode capacity guards (`< maxReviewCycles` vs `>= maxReviewCycles`)
 *   and the Boss-approval guard (`>= 1`) so each (status, event) pair has
 *   an unambiguous next status;
 * - keep the transition function PURE: it never mutates `reviewCycles`.
 *
 * Out of scope (task 9.2):
 * - incrementing `reviewCycles` on Reviewer→Fixer→Reviewer loops and on
 *   Boss "не соответствует" feedback;
 * - applying the default `maxReviewCycles = 5`.
 *
 * Task 9.2 will compose these primitives with cycle-increment logic; task
 * 15.1 will wire orchestrator timestamps (`updatedAt`) and
 * `currentAgentId` updates around each transition.
 */

import type { TaskState, TaskStatus } from "@ai-agent-orchestrator/validation";

export type { TaskState, TaskStatus };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Pipeline events that drive transitions of {@link TaskState}.
 *
 * The unlabeled `Created → Researching` transition in the design state
 * diagram is modeled here as the {@link TaskEvent} `start`, emitted by the
 * Orchestrator immediately after `Orchestrator.createTask` (task 8.2).
 *
 * The `error` event applies from any non-terminal state and represents an
 * unrecoverable runtime failure.
 */
export type TaskEvent =
  | { kind: "start" }
  | { kind: "prompt_enriched" }
  | { kind: "code_produced" }
  | { kind: "defects_found" }
  | { kind: "defects_fixed" }
  | { kind: "defects_empty" }
  | { kind: "boss_approved" }
  | { kind: "boss_rejected" }
  | { kind: "requires_consent" }
  | { kind: "user_approved_test_command" }
  | { kind: "user_rejected_test_command" }
  | { kind: "user_cancelled" }
  | { kind: "error"; reason?: string };

export type TaskEventKind = TaskEvent["kind"];

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

/**
 * Terminal `TaskStatus` values. A `Task` in any of these statuses has no
 * outgoing transitions: subsequent events return a `terminal_state` error.
 */
export const TASK_TERMINAL_STATUSES = [
  "completed",
  "stopped_limit",
  "error",
] as const satisfies readonly TaskStatus[];

export type TaskTerminalStatus = (typeof TASK_TERMINAL_STATUSES)[number];

export function isTerminalStatus(status: TaskStatus): status is TaskTerminalStatus {
  return (TASK_TERMINAL_STATUSES as readonly TaskStatus[]).includes(status);
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Named guards evaluated against the current {@link TaskState} when more than
 * one edge fires on the same event (e.g. `defects_found` from `reviewing`
 * splits between `fixing` and `stopped_limit`).
 *
 * - `review_cycles_lt_max` — `state.reviewCycles < state.maxReviewCycles`.
 * - `review_cycles_ge_max` — `state.reviewCycles >= state.maxReviewCycles`.
 * - `review_cycles_ge_1`   — `state.reviewCycles >= 1` (Requirement 14.1).
 */
export type TransitionGuardName =
  | "review_cycles_lt_max"
  | "review_cycles_ge_max"
  | "review_cycles_ge_1";

export type TaskStatusTransitionEdge = {
  readonly on: TaskEventKind;
  readonly to: TaskStatus;
  readonly guard?: TransitionGuardName;
};

/**
 * Static map of status → list of outgoing edges. Exposed for clarity (tests,
 * diagrams, debug tooling) and used by {@link transition} for lookup.
 *
 * Edge ordering matters for `defects_found` and `boss_rejected`: the
 * narrower `*_lt_max` guards come before the `*_ge_max` fallbacks so that
 * the limit-reached branch only triggers when the under-limit branch fails.
 * Both branches have mutually exclusive guards, so the ordering is purely
 * a readability convention.
 */
export const TASK_STATUS_TRANSITIONS: {
  readonly [S in TaskStatus]: readonly TaskStatusTransitionEdge[];
} = {
  created: [{ on: "start", to: "researching" }],
  researching: [{ on: "prompt_enriched", to: "coding" }],
  coding: [{ on: "code_produced", to: "reviewing" }],
  reviewing: [
    { on: "defects_found", to: "fixing", guard: "review_cycles_lt_max" },
    { on: "defects_found", to: "stopped_limit", guard: "review_cycles_ge_max" },
    { on: "defects_empty", to: "boss_eval" },
    { on: "requires_consent", to: "waiting_consent" },
  ],
  fixing: [{ on: "defects_fixed", to: "reviewing" }],
  boss_eval: [
    { on: "boss_approved", to: "completed" },
    { on: "boss_rejected", to: "fixing", guard: "review_cycles_lt_max" },
    { on: "boss_rejected", to: "stopped_limit", guard: "review_cycles_ge_max" },
  ],
  completed: [],
  stopped_limit: [],
  error: [],
  waiting_consent: [
    { on: "user_approved_test_command", to: "reviewing" },
    { on: "user_rejected_test_command", to: "reviewing" },
    { on: "user_cancelled", to: "stopped_limit" },
  ],
};

// ---------------------------------------------------------------------------
// Transition function
// ---------------------------------------------------------------------------

export type TransitionErrorCode =
  | "invalid_transition"
  | "terminal_state"
  | "guard_failed";

export type TransitionError = {
  readonly code: TransitionErrorCode;
  readonly from: TaskStatus;
  readonly event: TaskEventKind;
  readonly message: string;
};

export type TransitionResult =
  | { readonly ok: true; readonly next: TaskState }
  | { readonly ok: false; readonly error: TransitionError };

/**
 * Apply `event` to `state` and return the next `TaskState`.
 *
 * The function is pure: it does not mutate `state`, does not increment
 * `reviewCycles`, and does not advance timestamps. Counter and timestamp
 * bookkeeping are owned by task 9.2 and the orchestrator runtime
 * respectively.
 *
 * Rules:
 * - `error` is accepted from any non-terminal status and transitions to
 *   `error`.
 * - Other events are looked up in {@link TASK_STATUS_TRANSITIONS}.
 * - When multiple edges share an event, the first edge whose guard
 *   evaluates to true wins. Guards are mutually exclusive in the design
 *   diagram, so the result is deterministic.
 * - From any terminal status (`completed`, `stopped_limit`, `error`)
 *   every event returns a `terminal_state` error.
 */
export function transition(state: TaskState, event: TaskEvent): TransitionResult {
  if (event.kind === "error") {
    if (isTerminalStatus(state.status)) {
      return failure(state, event, "terminal_state");
    }
    return { ok: true, next: { ...state, status: "error" } };
  }

  if (isTerminalStatus(state.status)) {
    return failure(state, event, "terminal_state");
  }

  const candidates = TASK_STATUS_TRANSITIONS[state.status].filter(
    (edge) => edge.on === event.kind,
  );

  if (candidates.length === 0) {
    return failure(state, event, "invalid_transition");
  }

  for (const edge of candidates) {
    if (evaluateGuard(edge.guard, state)) {
      return { ok: true, next: { ...state, status: edge.to } };
    }
  }

  return failure(state, event, "guard_failed");
}

/**
 * Convenience wrapper that throws on transition error. Useful in places where
 * a failed transition is genuinely a programmer error (e.g. orchestrator
 * code paths that have already validated their preconditions). For
 * user-facing flows prefer {@link transition} so the error code can drive
 * structured error responses.
 */
export function transitionOrThrow(state: TaskState, event: TaskEvent): TaskState {
  const result = transition(state, event);
  if (!result.ok) {
    throw new TaskTransitionError(result.error);
  }
  return result.next;
}

export class TaskTransitionError extends Error {
  public readonly code: TransitionErrorCode;
  public readonly from: TaskStatus;
  public readonly event: TaskEventKind;

  constructor(error: TransitionError) {
    super(error.message);
    this.name = "TaskTransitionError";
    this.code = error.code;
    this.from = error.from;
    this.event = error.event;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function evaluateGuard(
  guard: TransitionGuardName | undefined,
  state: TaskState,
): boolean {
  if (guard === undefined) return true;
  switch (guard) {
    case "review_cycles_lt_max":
      return state.reviewCycles < state.maxReviewCycles;
    case "review_cycles_ge_max":
      return state.reviewCycles >= state.maxReviewCycles;
    case "review_cycles_ge_1":
      return state.reviewCycles >= 1;
  }
}

function failure(
  state: TaskState,
  event: TaskEvent,
  code: TransitionErrorCode,
): TransitionResult {
  return {
    ok: false,
    error: {
      code,
      from: state.status,
      event: event.kind,
      message: buildFailureMessage(code, state, event),
    },
  };
}

function buildFailureMessage(
  code: TransitionErrorCode,
  state: TaskState,
  event: TaskEvent,
): string {
  switch (code) {
    case "terminal_state":
      return `Cannot apply event '${event.kind}' from terminal status '${state.status}'`;
    case "invalid_transition":
      return `No transition is defined for event '${event.kind}' from status '${state.status}'`;
    case "guard_failed":
      return (
        `Event '${event.kind}' from status '${state.status}' has no edge ` +
        `whose guard is satisfied (reviewCycles=${state.reviewCycles}, ` +
        `maxReviewCycles=${state.maxReviewCycles})`
      );
  }
}
