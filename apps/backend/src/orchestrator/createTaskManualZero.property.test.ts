/**
 * Property test for Manual_Mode zero-agents rejection at the orchestrator
 * boundary (task 8.4).
 *
 * **Property 4: Manual_Mode with zero agents can never create Task.**
 *   For any well-formed `CreateTaskInput` with `mode: "manual"` and
 *   `participants` either omitted entirely or supplied as an empty array,
 *   `Orchestrator.createTask` rejects with a `CreateTaskError` whose `code`
 *   is `"manual_mode_zero_participants"`, and the underlying
 *   `TaskStateStore` remains empty (no partial state is persisted).
 *
 *   This is the orchestrator-side complement to the schema-level Property
 *   4 test in `packages/validation/src/task.test.ts`. The schema test
 *   guards `createTaskInputSchema`; this test guards the runtime entry
 *   point that the gateway calls and is the surface Requirement 6.6
 *   actually targets ("THE Orchestrator SHALL отклонить запуск и
 *   потребовать выбрать хотя бы одного Agent").
 *
 * Validates: Requirements 6.6.
 *
 * Sources:
 *  - design.md → "Orchestrator Core" → "Validation rules"
 *    ("Manual_Mode must include at least one agent").
 *  - tasks.md task 8.4: "Generate arbitrary valid CreateTaskInput shapes
 *    with `mode: 'manual'` and `participants` either undefined OR an empty
 *    array, and assert: every call rejects with
 *    `CreateTaskError('manual_mode_zero_participants')` AND the persistent
 *    store remains empty."
 *
 * Generator notes:
 *  - `arbitraryNonEmptyPrompt` always trims to a non-empty string so the
 *    rejection cannot be `empty_prompt`. We sandwich a printable character
 *    between two arbitrary fragments to guarantee that invariant.
 *  - The model is drawn from a small fixed pool that the stubbed
 *    `ModelCatalog` always reports as available with `source: "user-api-key"`,
 *    so the rejection cannot be `model_unavailable` or
 *    `fallback_not_confirmed`. Property 4 is solely about the Manual_Mode
 *    gate; orthogonal failures would muddle the counter-example.
 *  - `participants` is restricted to `undefined` or `[]` — the two shapes
 *    that count as "zero agents" per Requirement 6.6 and the validation
 *    schema. A non-empty array is intentionally out of the support so
 *    every generated input MUST be rejected.
 *  - `maxReviewCycles` is `undefined` or any integer ≥ 1, so the
 *    `invalid_input` branch in `createTask` cannot fire.
 *  - `ownerScope` toggles between `local` and `cloud` so the property
 *    holds for both scopes (the `cloud` scope is fed an arbitrary userId
 *    drawn from a small pool — the orchestrator does not inspect it).
 *  - A fresh `InMemoryTaskStateStore` is constructed inside each fc run
 *    so the "store remains empty" assertion has a clean baseline. We do
 *    not share a store across runs because a single accidental successful
 *    persist would leak across iterations and mask the property.
 *
 * The test additionally pins the error to `CreateTaskError` (via
 * `instanceof`) and re-asserts the failing-call store size after the
 * rejection, mirroring the unit-test convention in
 * `createTask.test.ts` ("Manual_Mode (Requirement 6.6)") so a regression
 * that, say, persisted a task before validating participants would be
 * caught by both the property and the unit suite.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type {
  AgentId,
  ModelRef,
  Scope,
} from "@ai-agent-orchestrator/shared-core";
import type { CreateTaskInput } from "@ai-agent-orchestrator/validation";

import type {
  ModelInfo,
  ProviderModelsResult,
} from "../models/index.js";
import {
  CreateTaskError,
  InMemoryTaskStateStore,
  Orchestrator,
  type AutoParticipantResolver,
  type ModelCatalogPort,
  type OrchestratorClock,
  type TaskIdGenerator,
} from "./index.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2024-06-15T12:00:00.000Z");
const fixedClock: OrchestratorClock = { now: () => FIXED_NOW };

/**
 * Set of (provider, modelId) pairs the stub catalog reports as available
 * with `source: "user-api-key"`. Mirroring this as a constant keeps the
 * generator and the catalog stub in sync — a generator that produced a
 * model not in this list would surface as `model_unavailable`, which is
 * the wrong rejection cause for Property 4.
 */
const AVAILABLE_MODELS: ReadonlyArray<{ provider: string; modelId: string }> = [
  { provider: "openai", modelId: "gpt-4o" },
  { provider: "openai", modelId: "gpt-3.5" },
  { provider: "anthropic", modelId: "claude-3-haiku" },
];

/**
 * Stub `ModelCatalog` that always returns every entry from
 * `AVAILABLE_MODELS` as a healthy `user-api-key` model. The orchestrator
 * therefore cannot reject on `model_unavailable` for any generator
 * output.
 */
class AlwaysAvailableCatalog implements ModelCatalogPort {
  public async listModelsForUser(
    _scope: Scope,
  ): Promise<ProviderModelsResult[]> {
    void _scope;
    // Group by provider so the response matches the production
    // `ModelCatalog` shape (one `ProviderModelsResult` per provider).
    const grouped = new Map<string, ModelInfo[]>();
    for (const { provider, modelId } of AVAILABLE_MODELS) {
      const list = grouped.get(provider) ?? [];
      list.push({
        provider,
        modelId,
        displayName: modelId,
        source: "user-api-key",
      });
      grouped.set(provider, list);
    }
    return Array.from(grouped.entries()).map(([provider, models]) => ({
      provider,
      status: "ok",
      models,
    }));
  }
}

/**
 * Stub Auto_Mode resolver that throws if invoked. Property 4 exercises
 * Manual_Mode only, so any call to the auto resolver indicates the
 * orchestrator took the wrong branch and the test should fail loudly
 * rather than silently produce a different rejection cause.
 */
class UnusedAutoResolver implements AutoParticipantResolver {
  public async resolveAutoParticipants(): Promise<readonly AgentId[]> {
    throw new Error(
      "Auto resolver called during Manual_Mode property test — Property 4 must not reach Auto_Mode branch",
    );
  }
}

/** Counter-based id generator so a successful create (which must NOT happen) would yield a deterministic id we can spot in failure messages. */
class CounterIdGenerator implements TaskIdGenerator {
  private n = 0;
  public next(): string {
    this.n += 1;
    return `task-${this.n}`;
  }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * A non-empty-after-trim prompt. We surround a guaranteed printable
 * character with arbitrary string fragments so the `.trim().length > 0`
 * invariant is preserved without unduly constraining the shape of the
 * prompt body.
 */
const arbitraryNonEmptyPrompt: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ maxLength: 32 }),
    fc.constantFrom("A", "x", "1", "?"),
    fc.string({ maxLength: 32 }),
  )
  .map(([prefix, mid, suffix]) => `${prefix}${mid}${suffix}`);

/**
 * A `ModelRef` drawn from `AVAILABLE_MODELS` and pinned to
 * `source: "user-api-key"` so the request is satisfiable by the stub
 * catalog and does not require `confirmedFallback`.
 */
const arbitraryModelRef: fc.Arbitrary<ModelRef> = fc
  .integer({ min: 0, max: AVAILABLE_MODELS.length - 1 })
  .map((idx) => {
    const m = AVAILABLE_MODELS[idx]!;
    return {
      provider: m.provider,
      modelId: m.modelId,
      source: "user-api-key" as const,
    };
  });

/**
 * The two shapes that count as "zero agents" per Requirement 6.6:
 *   • field omitted entirely
 *   • field present as an empty array
 * Anything else is out of the property's support.
 */
const arbitraryZeroParticipants: fc.Arbitrary<undefined | readonly AgentId[]> =
  fc.oneof(
    fc.constant<undefined>(undefined),
    fc.constant<readonly AgentId[]>([]),
  );

/** `undefined` or any integer ≥ 1 — keeps the `invalid_input` branch closed. */
const arbitraryMaxReviewCycles: fc.Arbitrary<number | undefined> = fc.option(
  fc.integer({ min: 1, max: 100 }),
  { nil: undefined },
);

/**
 * Owner scope: either a local device session or a cloud user session.
 * The orchestrator does not inspect the scope's contents for Manual_Mode
 * validation, but exercising both arms guards against a hypothetical
 * future regression that special-cased one scope kind.
 */
const arbitraryOwnerScope: fc.Arbitrary<Scope> = fc.oneof(
  fc
    .constantFrom("device-1", "device-2", "device-prop")
    .map<Scope>((deviceId) => ({ kind: "local", deviceId })),
  fc
    .constantFrom("user-a", "user-b", "user-prop")
    .map<Scope>((userId) => ({ kind: "cloud", userId })),
);

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Orchestrator.createTask Manual_Mode zero-agents rejection (Property 4)", () => {
  it(
    "Property 4: Manual_Mode with zero/omitted participants always rejects with code manual_mode_zero_participants and never persists state (Validates: Requirements 6.6)",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryNonEmptyPrompt,
          arbitraryModelRef,
          arbitraryZeroParticipants,
          arbitraryMaxReviewCycles,
          arbitraryOwnerScope,
          async (prompt, modelRef, participants, maxReviewCycles, ownerScope) => {
            // Fresh store + orchestrator per run so the "store remains
            // empty" check has a clean baseline. Reusing fixtures across
            // fast-check iterations would let one accidental success
            // poison every later run.
            const store = new InMemoryTaskStateStore();
            const orchestrator = new Orchestrator({
              modelCatalog: new AlwaysAvailableCatalog(),
              autoResolver: new UnusedAutoResolver(),
              store,
              idGenerator: new CounterIdGenerator(),
              clock: fixedClock,
            });

            // Build the input. We assemble it as a plain object and only
            // attach `participants` / `maxReviewCycles` when they are
            // defined, so the "field omitted entirely" arm of
            // `arbitraryZeroParticipants` actually omits the field rather
            // than stamping `participants: undefined` on the payload.
            const input: Record<string, unknown> = {
              prompt,
              modelRef,
              mode: "manual",
            };
            if (participants !== undefined) {
              input.participants = participants;
            }
            if (maxReviewCycles !== undefined) {
              input.maxReviewCycles = maxReviewCycles;
            }

            let thrown: unknown;
            try {
              await orchestrator.createTask({
                ownerScope,
                input: input as CreateTaskInput,
              });
            } catch (e) {
              thrown = e;
            }

            // The promise MUST reject — otherwise the property is
            // violated. Using a tagged error message so a counter-example
            // makes it clear which generator output slipped through.
            if (thrown === undefined) {
              throw new Error(
                `createTask unexpectedly resolved for Manual_Mode zero-agents input: ${JSON.stringify(
                  { prompt, modelRef, participants, maxReviewCycles, ownerScope },
                )}`,
              );
            }

            // Pin both the class identity and the stable error code.
            // `code` is the contract the gateway/UI branch on; `instanceof`
            // guards against accidentally throwing a plain `Error`.
            expect(thrown).toBeInstanceOf(CreateTaskError);
            expect((thrown as CreateTaskError).code).toBe(
              "manual_mode_zero_participants",
            );

            // Persistent store remains empty: no `TaskState` should be
            // saved on a rejected create. This is the second half of the
            // tasks.md task 8.4 assertion.
            expect(store.size()).toBe(0);
          },
        ),
        { numRuns: 200 },
      );
    },
  );

  // ---- minimal sanity examples -------------------------------------------
  // Confirm the property is not vacuously true: the orchestrator does
  // accept Manual_Mode inputs that include at least one participant. If a
  // future change accidentally rejected every Manual_Mode input the
  // property above would still hold (since its support is restricted to
  // zero-agents shapes), but these sanity checks would fail.

  it("accepts Manual_Mode with one participant (sanity)", async () => {
    const store = new InMemoryTaskStateStore();
    const orchestrator = new Orchestrator({
      modelCatalog: new AlwaysAvailableCatalog(),
      autoResolver: new UnusedAutoResolver(),
      store,
      idGenerator: new CounterIdGenerator(),
      clock: fixedClock,
    });

    const out = await orchestrator.createTask({
      ownerScope: { kind: "local", deviceId: "device-sanity" },
      input: {
        prompt: "Write a hello-world script.",
        modelRef: {
          provider: "openai",
          modelId: "gpt-4o",
          source: "user-api-key",
        },
        mode: "manual",
        participants: ["agent-coder"],
      },
    });

    expect(out.taskId).toBe("task-1");
    expect(store.size()).toBe(1);
  });
});
