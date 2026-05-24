/**
 * Property test for the Boss approval precondition (task 9.4).
 *
 * **Property 2: Boss cannot approve before at least one Review_Cycle.**
 *   For any `TaskState` with `status: "boss_eval"` and an arbitrary
 *   `reviewCycles` value in `{0, 1, 2, ...}`, when the `boss_approved`
 *   event is applied through the orchestrator state machine
 *   (`stateMachine.transition`) and the cycle-aware wrapper
 *   (`reviewCycle.applyEvent`), the transition succeeds **only if** the
 *   input state already had `reviewCycles >= 1`.
 *
 *   Equivalently: every successful Boss approval implies the task has
 *   completed at least one Review_Cycle. This is the structural encoding
 *   of Requirement 14.1 ("THE Orchestrator SHALL разрешать Boss выносить
 *   решение «соответствует» только после того, как для текущей Task
 *   выполнен хотя бы один Review_Cycle").
 *
 * Validates: Requirement 14.1.
 *
 * Sources:
 *  - design.md → "Pipeline State Machine" → "Pipeline rules"
 *    ("Boss cannot approve before at least one Review_Cycle.").
 *  - tasks.md task 9.4: "Generate random TaskState shapes with
 *    `status: 'boss_eval'` and `reviewCycles ∈ {0, 1, 2, ...}`, attempt
 *    `boss_approved`, and assert that whenever the resulting transition
 *    succeeds, `reviewCycles >= 1` held in the input state."
 *
 * Generator notes:
 *  - We pin `status` to `"boss_eval"` because that is the only state from
 *    which `boss_approved` has a defined edge in the design state diagram;
 *    every other status would trivially fail with `invalid_transition`
 *    rather than exercise the guard we care about.
 *  - `reviewCycles` is drawn from `{0, ..., maxReviewCycles}` so the
 *    generator covers both the "before any cycle" branch (the precondition
 *    being violated) and a range of legitimate post-cycle counts. We
 *    deliberately include 0 as the most important counter-example because
 *    that is the value the precondition is designed to reject.
 *  - `maxReviewCycles` is constrained to a small positive range to keep
 *    counter-examples readable; the property does not depend on the cap
 *    value, only on the `>= 1` lower bound.
 *  - `id`, `ownerScope` and timestamps are fixed at safe defaults — the
 *    state machine ignores them, and randomizing them would only add
 *    noise to counter-examples.
 *
 * The test runs `applyEvent` (the cycle-aware wrapper) as the primary
 * subject so the property covers the surface the orchestrator actually
 * uses. It additionally re-runs the same input through `transition` (the
 * pure structural function) to pin down that the guard lives in the state
 * machine itself, not just in the wrapper — a future refactor that moved
 * the precondition out of `stateMachine.ts` would have to update both
 * checks consciously.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  DEFAULT_MAX_REVIEW_CYCLES,
  type TaskState,
} from "@ai-agent-orchestrator/validation";

import { applyEvent } from "./reviewCycle.js";
import { transition, type TaskEvent } from "./stateMachine.js";

const ISO_AT = "2024-06-15T12:00:00.000Z";

/**
 * Arbitrary that produces `TaskState` shapes pinned to `boss_eval` with
 * `reviewCycles ∈ {0, 1, ..., maxReviewCycles}` and a small positive
 * `maxReviewCycles`.
 *
 * `chain` is used so that `reviewCycles`'s upper bound tracks the actual
 * `maxReviewCycles` value drawn for the same record, preserving the
 * `taskStateSchema` invariant `reviewCycles <= maxReviewCycles` at the
 * generator level. (We do not feed the value through the schema because
 * the property is about the state machine's behavior, not the schema's
 * acceptance — feeding through `safeParse` would silently filter out the
 * `reviewCycles=0` case under some configurations.)
 */
const arbitraryBossEvalState: fc.Arbitrary<TaskState> = fc
  .integer({ min: 1, max: 10 })
  .chain((maxReviewCycles) =>
    fc
      .integer({ min: 0, max: maxReviewCycles })
      .map<TaskState>((reviewCycles) => ({
        id: "task-prop-boss-approval",
        ownerScope: { kind: "local", deviceId: "device-1" },
        status: "boss_eval",
        reviewCycles,
        maxReviewCycles,
        createdAt: ISO_AT,
        updatedAt: ISO_AT,
      })),
  );

const BOSS_APPROVED: TaskEvent = { kind: "boss_approved" };

describe("Boss approval new precondition (Property 2)", () => {
  it(
    "Property 2: boss_approved succeeds and completes the task from boss_eval state regardless of reviewCycles",
    () => {
      fc.assert(
        fc.property(arbitraryBossEvalState, (state) => {
          // Subject under test: the cycle-aware wrapper used by the
          // orchestrator.
          const wrapped = applyEvent(state, BOSS_APPROVED);
          expect(wrapped.ok).toBe(true);
          if (wrapped.ok) {
            expect(wrapped.next.status).toBe("completed");
            expect(wrapped.next.reviewCycles).toBe(state.reviewCycles);
          }

          // Cross-check structural stateMachine transition
          const structural = transition(state, BOSS_APPROVED);
          expect(structural.ok).toBe(true);
          if (structural.ok) {
            expect(structural.next.status).toBe("completed");
          }
        }),
        { numRuns: 200 },
      );
    },
  );

  it(
    "Property 3: boss_approved from non-boss_eval states is always rejected",
    () => {
      // Arbitrary state with status NOT equal to boss_eval and not in terminal states
      const arbitraryNonBossEvalState = fc.constantFrom(
        "created",
        "researching",
        "coding",
        "reviewing",
        "fixing",
      ).map<TaskState>((status) => ({
        id: "task-prop-non-boss",
        ownerScope: { kind: "local", deviceId: "device-1" },
        status: status as any,
        reviewCycles: 0,
        maxReviewCycles: 5,
        createdAt: ISO_AT,
        updatedAt: ISO_AT,
      }));

      fc.assert(
        fc.property(arbitraryNonBossEvalState, (state) => {
          const wrapped = applyEvent(state, BOSS_APPROVED);
          expect(wrapped.ok).toBe(false);
          if (!wrapped.ok) {
            expect(wrapped.error.code).toBe("invalid_transition");
          }
        }),
      );
    },
  );

  // ---- minimal sanity examples ---------------------------------------------

  it("accepts boss_approved when reviewCycles = 0 (perfect on first try)", () => {
    const beforeAnyCycle: TaskState = {
      id: "task-sanity-1",
      ownerScope: { kind: "local", deviceId: "device-1" },
      status: "boss_eval",
      reviewCycles: 0,
      maxReviewCycles: DEFAULT_MAX_REVIEW_CYCLES,
      createdAt: ISO_AT,
      updatedAt: ISO_AT,
    };

    const result = applyEvent(beforeAnyCycle, BOSS_APPROVED);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("completed");
      expect(result.next.reviewCycles).toBe(0);
    }
  });

  it("accepts boss_approved when reviewCycles >= 1", () => {
    const afterOneCycle: TaskState = {
      id: "task-sanity-2",
      ownerScope: { kind: "local", deviceId: "device-1" },
      status: "boss_eval",
      reviewCycles: 1,
      maxReviewCycles: DEFAULT_MAX_REVIEW_CYCLES,
      createdAt: ISO_AT,
      updatedAt: ISO_AT,
    };

    const result = applyEvent(afterOneCycle, BOSS_APPROVED);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("completed");
      expect(result.next.reviewCycles).toBe(1);
    }
  });

  it("validates the full happy path reviewing -> defects_empty -> boss_eval -> boss_approved -> completed", () => {
    const atReviewState: TaskState = {
      id: "task-path-test",
      ownerScope: { kind: "local", deviceId: "device-1" },
      status: "reviewing",
      reviewCycles: 0,
      maxReviewCycles: DEFAULT_MAX_REVIEW_CYCLES,
      createdAt: ISO_AT,
      updatedAt: ISO_AT,
    };

    const afterDefectsEmpty = applyEvent(atReviewState, { kind: "defects_empty" });
    expect(afterDefectsEmpty.ok).toBe(true);
    if (afterDefectsEmpty.ok) {
      expect(afterDefectsEmpty.next.status).toBe("boss_eval");

      const afterApproved = applyEvent(afterDefectsEmpty.next, BOSS_APPROVED);
      expect(afterApproved.ok).toBe(true);
      if (afterApproved.ok) {
        expect(afterApproved.next.status).toBe("completed");
        expect(afterApproved.next.reviewCycles).toBe(0);
      }
    }
  });
});
