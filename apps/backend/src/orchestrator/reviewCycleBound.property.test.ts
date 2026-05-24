/**
 * Property test for the Review_Cycle bound (task 9.3).
 *
 * **Property 1: Review_Cycle never exceeds maxReviewCycles.**
 *   For any starting `TaskState` that satisfies the schema invariants
 *   (`0 <= reviewCycles <= maxReviewCycles`, `maxReviewCycles >= 1`) and
 *   any sequence of `TaskEvent`s driven through {@link applyEvent}, every
 *   reachable state — including the initial state and the state after each
 *   successful transition — satisfies
 *
 *       state.reviewCycles <= state.maxReviewCycles
 *
 *   regardless of how many events are applied or which kinds are supplied.
 *
 * Validates: Requirements 7.8, 8.5, 8.6.
 *
 * Source pointers:
 *  - requirements.md →
 *      7.8  ("ограничить количество итераций исправления значением не более 5"),
 *      8.5  (default `maxReviewCycles = 5`),
 *      8.6  (Task stops with the limit-reached report once the cap is hit).
 *  - design.md → "Pipeline rules", "Review cycle definition".
 *  - tasks.md task 9.3:
 *      "Drive arbitrary sequences of TaskEvents via applyEvent /
 *       applyEventOrThrow and assert that for any reachable state
 *       state.reviewCycles <= state.maxReviewCycles. Also vary
 *       maxReviewCycles over a small range (e.g. 1..7) to make sure the
 *       bound generalises."
 *
 * Generator notes:
 *  - `arbitraryEvent` covers every `TaskEventKind` so the search space
 *    includes structurally invalid transitions (e.g. `boss_approved` from
 *    `created`). Such events return `ok: false` from `applyEvent` and are
 *    skipped via the early-exit branch in {@link runSequence}; the
 *    invariant check still runs against the unchanged state. This is
 *    intentional: the bound must hold even when callers supply garbage.
 *  - `arbitraryMaxReviewCycles` is constrained to 1..7. The lower bound
 *    matches `maxReviewCyclesSchema.min(1)`. The upper bound is small
 *    enough to keep counter-examples readable while large enough to
 *    exercise sequences that cross the cap several times over.
 *  - `arbitraryEvents` caps the sequence length at 64. Each Reviewer →
 *    Fixer round needs two events, so 64 events comfortably exceed
 *    `maxReviewCycles=7` and force the state machine into `stopped_limit`
 *    on most runs, where the invariant is most likely to leak.
 *  - The initial `reviewCycles` is allowed to start anywhere in
 *    `[0, maxReviewCycles]` (the schema-permitted range) so we also
 *    exercise transitions originating from at-cap states without having
 *    to first drive the pipeline there.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type { TaskState } from "@ai-agent-orchestrator/validation";

import { applyEvent } from "./reviewCycle";
import type { TaskEvent, TaskStatus } from "./stateMachine";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * The fixed status set defined in `taskStatusSchema`. Repeating the literal
 * values here keeps the test independent of import order quirks (the
 * Zod-derived `TaskStatus` type is used for the constant's static check
 * only).
 */
const ALL_STATUSES = [
  "created",
  "researching",
  "coding",
  "reviewing",
  "fixing",
  "boss_eval",
  "completed",
  "stopped_limit",
  "error",
] as const satisfies readonly TaskStatus[];

const arbitraryStatus: fc.Arbitrary<TaskStatus> = fc.constantFrom(
  ...ALL_STATUSES,
);

/**
 * Arbitrary `TaskEvent`. `error` carries an optional reason; we generate
 * both arms (with and without a reason) so the property is exercised
 * against both.
 */
const arbitraryEvent: fc.Arbitrary<TaskEvent> = fc.oneof(
  fc.constantFrom<TaskEvent>(
    { kind: "start" },
    { kind: "prompt_enriched" },
    { kind: "code_produced" },
    { kind: "defects_found" },
    { kind: "defects_fixed" },
    { kind: "defects_empty" },
    { kind: "boss_approved" },
    { kind: "boss_rejected" },
    { kind: "error" },
  ),
  fc
    .string({ minLength: 0, maxLength: 16 })
    .map<TaskEvent>((reason) => ({ kind: "error", reason })),
);

/**
 * Sequence of events. 64 is more than enough to push past
 * `maxReviewCycles=7` several times while keeping shrunken
 * counter-examples readable.
 */
const arbitraryEvents: fc.Arbitrary<readonly TaskEvent[]> = fc.array(
  arbitraryEvent,
  { minLength: 0, maxLength: 64 },
);

/**
 * `maxReviewCycles` over the small range called out by tasks.md task 9.3
 * (1..7). The lower bound mirrors the schema's `min(1)`.
 */
const arbitraryMaxReviewCycles: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: 7,
});

/**
 * Build an initial `TaskState` consistent with the schema invariants:
 *   - `reviewCycles` ∈ [0, maxReviewCycles]
 *   - `maxReviewCycles` ≥ 1
 *
 * We pin `id`, `ownerScope`, and timestamps to safe constants because the
 * state machine ignores them; the property is about counter and status
 * mechanics only.
 */
const arbitraryInitialState: fc.Arbitrary<TaskState> = fc
  .tuple(arbitraryStatus, arbitraryMaxReviewCycles)
  .chain(([status, maxReviewCycles]) =>
    fc.integer({ min: 0, max: maxReviewCycles }).map((reviewCycles) => {
      const at = "2024-06-15T12:00:00.000Z";
      const state: TaskState = {
        id: "task-prop",
        ownerScope: { kind: "local", deviceId: "device-prop" },
        status,
        reviewCycles,
        maxReviewCycles,
        createdAt: at,
        updatedAt: at,
      };
      return state;
    }),
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drive `events` through {@link applyEvent} starting from `initial`.
 *
 * Returns the array of all observed states (including `initial`) so the
 * caller can assert the invariant at every reachable point. Failed
 * transitions (`ok: false`) leave the current state unchanged; this models
 * how a real orchestrator would surface a `TransitionError` and continue
 * to hold the previous state.
 */
function runSequence(
  initial: TaskState,
  events: readonly TaskEvent[],
): readonly TaskState[] {
  const observed: TaskState[] = [initial];
  let current = initial;
  for (const event of events) {
    const result = applyEvent(current, event);
    if (result.ok) {
      current = result.next;
      observed.push(current);
    }
  }
  return observed;
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe("Review_Cycle bound (Property 1)", () => {
  it("Property 1: Review_Cycle never exceeds maxReviewCycles (Validates: Requirements 7.8, 8.5, 8.6)", () => {
    fc.assert(
      fc.property(
        arbitraryInitialState,
        arbitraryEvents,
        (initial, events) => {
          const observed = runSequence(initial, events);
          for (const state of observed) {
            // Schema invariant: counter must never breach the cap on any
            // reachable state. A failure here surfaces the exact (initial,
            // events) tuple via fast-check's shrinking.
            if (state.reviewCycles > state.maxReviewCycles) {
              throw new Error(
                `Review_Cycle bound violated: reviewCycles=${state.reviewCycles}, ` +
                  `maxReviewCycles=${state.maxReviewCycles}, status=${state.status}`,
              );
            }
            // Sanity: the cap must remain ≥ 1 across transitions; the
            // state machine has no edge that mutates this field, but
            // pinning the assertion keeps a future regression honest.
            expect(state.maxReviewCycles).toBeGreaterThanOrEqual(1);
            expect(state.reviewCycles).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      // 300 runs gives ample coverage of the 9-state × 9-event × 1..7-cap
      // space without making the test noticeably slow.
      { numRuns: 300 },
    );
  });

  // Companion sanity checks. They are NOT the property; they ensure the
  // property is not vacuously true (the cap is actually reachable in the
  // generated space) and that the canonical pipeline saturates exactly at
  // `maxReviewCycles`.

  it("the bound is tight: a deterministic loop saturates at maxReviewCycles", () => {
    const max = 5;
    const at = "2024-06-15T12:00:00.000Z";
    const initial: TaskState = {
      id: "task-tight",
      ownerScope: { kind: "local", deviceId: "device-tight" },
      status: "created",
      reviewCycles: 0,
      maxReviewCycles: max,
      createdAt: at,
      updatedAt: at,
    };

    const setup: readonly TaskEvent[] = [
      { kind: "start" },
      { kind: "prompt_enriched" },
      { kind: "code_produced" },
    ];
    const oneLoop: readonly TaskEvent[] = [
      { kind: "defects_found" },
      { kind: "defects_fixed" },
    ];

    const events: TaskEvent[] = [...setup];
    for (let i = 0; i < max; i += 1) events.push(...oneLoop);
    // One more attempt to push past the cap; should redirect to
    // stopped_limit without bumping the counter.
    events.push({ kind: "defects_found" });

    const observed = runSequence(initial, events);
    const final = observed[observed.length - 1];

    expect(final.status).toBe("stopped_limit");
    expect(final.reviewCycles).toBe(max);
    expect(final.reviewCycles).toBeLessThanOrEqual(final.maxReviewCycles);
  });
});
