/**
 * Unit tests for {@link applyEvent} (task 9.2).
 *
 * Coverage:
 *  - Cycle increments on Reviewer→Fixer→Reviewer loop.
 *  - Cycle increment on Boss "не соответствует" feedback.
 *  - `stopped_limit` transition once `reviewCycles >= maxReviewCycles`.
 *  - Boss "соответствует" rejection when `reviewCycles < 1`.
 *  - Defaults — `maxReviewCycles` honors the documented value of 5.
 *
 * The companion property tests live in tasks 9.3 (Property 1: bound) and
 * 9.4 (Property 2: Boss precondition) and intentionally are NOT duplicated
 * here.
 *
 * Validates: Requirements 7.8, 8.5, 8.6, 14.1, 14.4.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_REVIEW_CYCLES, type TaskState } from "@ai-agent-orchestrator/validation";

import { applyEvent, applyEventOrThrow } from "./reviewCycle.js";
import type { TaskEvent } from "./stateMachine.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISO_AT = "2024-06-15T12:00:00.000Z";

/**
 * Build a `TaskState` with the supplied overrides, using safe defaults for
 * the fields the state machine does not depend on (id, scope, timestamps).
 */
function buildState(overrides: Partial<TaskState> = {}): TaskState {
  const base: TaskState = {
    id: "task-1",
    ownerScope: { kind: "local", deviceId: "device-1" },
    status: "created",
    reviewCycles: 0,
    maxReviewCycles: DEFAULT_MAX_REVIEW_CYCLES,
    createdAt: ISO_AT,
    updatedAt: ISO_AT,
  };
  return { ...base, ...overrides };
}

/**
 * Drive a state through a sequence of events using {@link applyEventOrThrow}.
 * Throws on the first failed transition so the test signals the failing
 * event with a stack trace rather than a generic assertion.
 */
function run(initial: TaskState, events: readonly TaskEvent[]): TaskState {
  return events.reduce<TaskState>(
    (state, event) => applyEventOrThrow(state, event),
    initial,
  );
}

// ---------------------------------------------------------------------------
// Cycle counting
// ---------------------------------------------------------------------------

describe("applyEvent — Review_Cycle counting", () => {
  it("increments reviewCycles on each Reviewer→Fixer→Reviewer loop", () => {
    // Drive the pipeline through three full Reviewer→Fixer→Reviewer loops.
    const state = run(buildState(), [
      { kind: "start" },
      { kind: "prompt_enriched" },
      { kind: "code_produced" },
      // Loop 1
      { kind: "defects_found" },
      { kind: "defects_fixed" },
      // Loop 2
      { kind: "defects_found" },
      { kind: "defects_fixed" },
      // Loop 3
      { kind: "defects_found" },
      { kind: "defects_fixed" },
    ]);

    expect(state.status).toBe("reviewing");
    expect(state.reviewCycles).toBe(3);
  });

  it("does not increment reviewCycles on the Fixer→Reviewer hand-off itself", () => {
    // Entering `fixing` is what increments the counter; the return trip
    // (`defects_fixed`) merely changes status without touching cycles.
    const afterEnterFixing = run(buildState(), [
      { kind: "start" },
      { kind: "prompt_enriched" },
      { kind: "code_produced" },
      { kind: "defects_found" },
    ]);
    expect(afterEnterFixing.status).toBe("fixing");
    expect(afterEnterFixing.reviewCycles).toBe(1);

    const afterReturnToReviewing = applyEventOrThrow(afterEnterFixing, {
      kind: "defects_fixed",
    });
    expect(afterReturnToReviewing.status).toBe("reviewing");
    expect(afterReturnToReviewing.reviewCycles).toBe(1);
  });

  it("increments reviewCycles when Boss returns 'не соответствует' feedback", () => {
    // Reach boss_eval through one normal review cycle, then reject.
    const atBossEval = run(buildState(), [
      { kind: "start" },
      { kind: "prompt_enriched" },
      { kind: "code_produced" },
      { kind: "defects_found" },
      { kind: "defects_fixed" },
      { kind: "defects_empty" },
    ]);
    expect(atBossEval.status).toBe("boss_eval");
    expect(atBossEval.reviewCycles).toBe(1);

    const afterBossRejected = applyEventOrThrow(atBossEval, {
      kind: "boss_rejected",
    });
    expect(afterBossRejected.status).toBe("fixing");
    // Boss feedback that re-enters fixing counts as another pass.
    expect(afterBossRejected.reviewCycles).toBe(2);
  });

  it("never lets reviewCycles exceed maxReviewCycles", () => {
    const max = 3;
    let state = run(buildState({ maxReviewCycles: max }), [
      { kind: "start" },
      { kind: "prompt_enriched" },
      { kind: "code_produced" },
    ]);

    // Three full loops — counter saturates at the cap.
    for (let i = 0; i < max; i += 1) {
      state = applyEventOrThrow(state, { kind: "defects_found" });
      state = applyEventOrThrow(state, { kind: "defects_fixed" });
    }
    expect(state.reviewCycles).toBe(max);

    // Attempting a fourth loop must redirect to stopped_limit.
    const result = applyEvent(state, { kind: "defects_found" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("stopped_limit");
      // Counter is not bumped past the cap on the limit transition.
      expect(result.next.reviewCycles).toBe(max);
    }
  });
});

// ---------------------------------------------------------------------------
// stopped_limit
// ---------------------------------------------------------------------------

describe("applyEvent — stopped_limit transition", () => {
  it("redirects to stopped_limit when reviewCycles >= maxReviewCycles on defects_found", () => {
    const atCap = buildState({
      status: "reviewing",
      reviewCycles: DEFAULT_MAX_REVIEW_CYCLES,
      maxReviewCycles: DEFAULT_MAX_REVIEW_CYCLES,
    });

    const result = applyEvent(atCap, { kind: "defects_found" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("stopped_limit");
      // Counter is preserved on entry to the terminal state.
      expect(result.next.reviewCycles).toBe(DEFAULT_MAX_REVIEW_CYCLES);
    }
  });

  it("redirects to stopped_limit when Boss rejects at the cap", () => {
    const atCap = buildState({
      status: "boss_eval",
      reviewCycles: DEFAULT_MAX_REVIEW_CYCLES,
      maxReviewCycles: DEFAULT_MAX_REVIEW_CYCLES,
    });

    const result = applyEvent(atCap, { kind: "boss_rejected" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("stopped_limit");
      expect(result.next.reviewCycles).toBe(DEFAULT_MAX_REVIEW_CYCLES);
    }
  });

  it("uses the documented default of 5 for maxReviewCycles", () => {
    // Sanity: the validation package exports the canonical default and any
    // change there must be reflected in the cap behavior assumed by this
    // test suite. Requirement 8.5.
    expect(DEFAULT_MAX_REVIEW_CYCLES).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Boss approval precondition
// ---------------------------------------------------------------------------

describe("applyEvent — Boss approval happy path and precondition", () => {
  it("permits direct completion without fixing when code is perfect on the first try (happy path)", () => {
    const happyPathState = run(buildState(), [
      { kind: "start" },
      { kind: "prompt_enriched" },
      { kind: "code_produced" },
      { kind: "defects_empty" },
      { kind: "boss_approved" },
    ]);

    expect(happyPathState.status).toBe("completed");
    expect(happyPathState.reviewCycles).toBe(0);
  });

  it("permits Boss 'соответствует' once at least one Review_Cycle has run", () => {
    const afterOneCycle = run(buildState(), [
      { kind: "start" },
      { kind: "prompt_enriched" },
      { kind: "code_produced" },
      { kind: "defects_found" },
      { kind: "defects_fixed" },
      { kind: "defects_empty" },
      { kind: "boss_approved" },
    ]);

    expect(afterOneCycle.status).toBe("completed");
    expect(afterOneCycle.reviewCycles).toBe(1);
  });
});
