/**
 * Property test for empty-prompt rejection in
 * {@link Orchestrator.createTask} (task 8.3).
 *
 * **Property 3: Empty prompt can never create Task.**
 *   For any "empty-equivalent" prompt — the empty string, any
 *   whitespace-only string (incl. Unicode whitespace `String.prototype.trim`
 *   strips), or `null`/`undefined` (which the orchestrator coerces to
 *   "empty after trim" via its `typeof` guard) — and for any otherwise
 *   well-formed `CreateTaskArgs`, calling `Orchestrator.createTask`:
 *
 *     1. rejects with a `CreateTaskError` whose `code` is `"empty_prompt"`,
 *        and
 *     2. leaves the persistent `TaskStateStore` unchanged (no partial
 *        write, no `taskId` minted).
 *
 *   The property holds regardless of the rest of the input: mode (auto /
 *   manual), modelRef shape, participants, maxReviewCycles, ownerScope
 *   kind, fallback confirmation, etc. The empty-prompt gate is the very
 *   first check in the validation pipeline (see
 *   `createTask.ts` → step 1 of the `CreateTaskErrorCode` order), so any
 *   downstream rule's verdict is irrelevant.
 *
 * Validates: Requirements 6.4, 6.5.
 *
 * Sources:
 *  - requirements.md →
 *      6.4 ("IF пользователь пытается запустить Task без введённого
 *           промта, THEN ... SHALL отклонить запуск..."),
 *      6.5 ("WHILE поле промта пусто, ... блокировать инициирование
 *           Task." — UI-side; the backend gate enforces the same
 *           invariant for any non-UI caller).
 *  - design.md → "Orchestrator Core" → "Validation rules"
 *      ("prompt must be non-empty after trim", "UI must disable launch
 *       button when prompt is empty, but backend must still validate
 *       empty prompt").
 *  - tasks.md task 8.3:
 *      "Use fast-check against `Orchestrator.createTask` ... Generate
 *       arbitrary 'empty-equivalent' prompts (`""`, whitespace-only,
 *       null/undefined coerced to empty after trim) and assert that for
 *       every such input, `createTask` rejects with
 *       CreateTaskError('empty_prompt') AND the persistent store
 *       remains unchanged."
 *
 * Generator notes:
 *  - `arbitraryEmptyPrompt` mixes:
 *      • the empty string,
 *      • strings made entirely from JS-trim whitespace (incl. `\u00a0`
 *        NBSP and `\ufeff` ZWNBSP — chars `String.prototype.trim` strips
 *        but a naive `=== ""` check would not),
 *      • `null` and `undefined`, which `createTask`'s `typeof input.prompt`
 *        guard treats as "empty after trim".
 *    Without the Unicode-whitespace arm, the test would silently miss
 *    cases where a UI inserts non-breaking spaces that look empty but
 *    parse as a non-empty string at the JSON boundary.
 *  - `arbitraryWellFormedRest` produces the rest of the `CreateTaskArgs`
 *    so that, were the prompt non-empty, the call would pass *every*
 *    other validation step (catalog match, manual participants, fallback
 *    confirmation, etc.). This isolates rejection cause to the prompt
 *    gate alone — a counter-example that fails this property cannot
 *    blame any other rule.
 *  - The generator deliberately includes both `auto` and `manual` modes,
 *    both `user-api-key` and `platform-fallback` model sources, and both
 *    local and cloud `Scope` kinds, because Property 3 must hold across
 *    all combinations.
 *  - 200 runs gives broad coverage of the (4 prompt-equivalents × 2 modes
 *    × 2 sources × 2 scopes × resolver/catalog combinations) space while
 *    keeping the test brisk.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type {
  AgentId,
  ModelRef,
  Scope,
} from "@ai-agent-orchestrator/shared-core";

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

/**
 * Fixed-response `ModelCatalogPort`. The property test fixes the catalog
 * shape per-run to mirror the requested `modelRef`, so a hypothetical
 * non-empty-prompt run would pass step 3 of the validation pipeline.
 */
class FixedCatalog implements ModelCatalogPort {
  public constructor(
    private readonly response: readonly ProviderModelsResult[],
  ) {}
  public async listModelsForUser(
    _scope: Scope,
  ): Promise<ProviderModelsResult[]> {
    return [...this.response];
  }
}

/** Always returns a non-empty ordered list, so Auto_Mode would pass. */
class FixedAutoResolver implements AutoParticipantResolver {
  public constructor(private readonly response: readonly AgentId[]) {}
  public async resolveAutoParticipants(_input: {
    readonly prompt: string;
    readonly modelRef: ModelRef;
    readonly ownerScope: Scope;
  }): Promise<readonly AgentId[]> {
    return [...this.response];
  }
}

/**
 * Counter-based id generator that ALSO records every call. Property 3
 * requires that no taskId is minted on rejection: we assert
 * `idGen.calls === 0` after the rejected call to catch any future bug
 * that allowed id generation to happen before validation.
 */
class RecordingIdGenerator implements TaskIdGenerator {
  public calls = 0;
  public next(): string {
    this.calls += 1;
    return `task-${this.calls}`;
  }
}

const FIXED_NOW = new Date("2024-06-15T12:00:00.000Z");
const fixedClock: OrchestratorClock = { now: () => FIXED_NOW };

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Whitespace characters that `String.prototype.trim` removes. Includes the
 * common ASCII set plus a couple of Unicode codepoints (NBSP, ZWNBSP) so
 * the generator covers cases where a UI might silently insert
 * non-breaking spaces.
 */
const TRIM_WHITESPACE_CHARS = [
  " ",
  "\t",
  "\n",
  "\r",
  "\v",
  "\f",
  "\u00a0",
  "\ufeff",
] as const;

/** Arbitrary string whose `.trim()` is empty. Includes `""`. */
const arbitraryWhitespaceOnly: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...TRIM_WHITESPACE_CHARS), {
    minLength: 0,
    maxLength: 16,
  })
  .map((chars) => chars.join(""));

/**
 * Arbitrary "empty-equivalent" prompt:
 *   - "" or whitespace-only string,
 *   - `null`,
 *   - `undefined`.
 * The orchestrator's first guard is
 *   `typeof input?.prompt !== "string" || input.prompt.trim().length === 0`
 * so all four shapes must be rejected as `empty_prompt`.
 */
const arbitraryEmptyPrompt: fc.Arbitrary<string | null | undefined> = fc.oneof(
  arbitraryWhitespaceOnly,
  fc.constant<null>(null),
  fc.constant<undefined>(undefined),
);

const arbitraryProvider = fc.constantFrom(
  "openai",
  "anthropic",
  "custom-provider",
);

/** A non-empty model id; used both in catalog entries and in `modelRef`. */
const arbitraryModelId = fc.string({ minLength: 1, maxLength: 24 });

const arbitraryModelSource = fc.constantFrom<
  "user-api-key" | "platform-fallback"
>("user-api-key", "platform-fallback");

/** Local or cloud scope; the gate must reject in both. */
const arbitraryScope: fc.Arbitrary<Scope> = fc.oneof(
  fc.record({
    kind: fc.constant<"local">("local"),
    deviceId: fc.string({ minLength: 1, maxLength: 24 }),
  }),
  fc.record({
    kind: fc.constant<"cloud">("cloud"),
    userId: fc.string({ minLength: 1, maxLength: 24 }),
  }),
);

const arbitraryMode = fc.constantFrom<"auto" | "manual">("auto", "manual");

const arbitraryMaxReviewCycles = fc.option(
  fc.integer({ min: 1, max: 10 }),
  { nil: undefined },
);

const arbitraryParticipants = fc.array(
  fc
    .string({ minLength: 1, maxLength: 16 })
    .map<AgentId>((s) => `agent-${s}`),
  { minLength: 0, maxLength: 4 },
);

/**
 * Bundle that produces the rest of `CreateTaskArgs` so a hypothetical
 * non-empty prompt would pass every other validation step. We pin the
 * catalog response to match the chosen `modelRef` and pass
 * `confirmedFallback: true` whenever the source is `platform-fallback`.
 */
const arbitraryWellFormedArgs = fc
  .tuple(
    arbitraryProvider,
    arbitraryModelId,
    arbitraryModelSource,
    arbitraryScope,
    arbitraryMode,
    arbitraryParticipants,
    arbitraryMaxReviewCycles,
  )
  .map(([provider, modelId, source, ownerScope, mode, participants, maxRC]) => {
    const modelRef: ModelRef = { provider, modelId, source };
    const modelInfo: ModelInfo = {
      provider,
      modelId,
      displayName: modelId,
      source,
    };
    const catalog: readonly ProviderModelsResult[] = [
      { provider, status: "ok", models: [modelInfo] },
    ];
    return {
      modelRef,
      ownerScope,
      mode,
      participants,
      maxReviewCycles: maxRC,
      catalog,
      confirmedFallback: source === "platform-fallback" ? true : undefined,
    };
  });

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe("Orchestrator.createTask — empty prompt rejection (Property 3)", () => {
  it(
    "Property 3: every empty-equivalent prompt is rejected with code 'empty_prompt' and leaves the store unchanged (Validates: Requirements 6.4, 6.5)",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryEmptyPrompt,
          arbitraryWellFormedArgs,
          async (prompt, rest) => {
            const catalog = new FixedCatalog(rest.catalog);
            const resolver = new FixedAutoResolver([
              "agent-researcher",
              "agent-coder",
            ]);
            const store = new InMemoryTaskStateStore();
            const idGen = new RecordingIdGenerator();
            const orchestrator = new Orchestrator({
              modelCatalog: catalog,
              autoResolver: resolver,
              store,
              idGenerator: idGen,
              clock: fixedClock,
            });

            // Build the input. We bypass `CreateTaskInput`'s type so the
            // generator can supply `null`/`undefined` for `prompt`; the
            // orchestrator's `typeof` guard is what we are exercising.
            const input = {
              prompt,
              modelRef: rest.modelRef,
              mode: rest.mode,
              participants: rest.participants,
              ...(rest.maxReviewCycles === undefined
                ? {}
                : { maxReviewCycles: rest.maxReviewCycles }),
            } as unknown as Parameters<
              typeof orchestrator.createTask
            >[0]["input"];

            const args: Parameters<typeof orchestrator.createTask>[0] = {
              ownerScope: rest.ownerScope,
              input,
              ...(rest.confirmedFallback === undefined
                ? {}
                : { confirmedFallback: rest.confirmedFallback }),
            };

            // 1. The call MUST reject.
            let thrown: unknown;
            try {
              await orchestrator.createTask(args);
              throw new Error(
                `Empty-equivalent prompt unexpectedly accepted: prompt=${JSON.stringify(prompt)}`,
              );
            } catch (e) {
              thrown = e;
            }

            // 2. The error MUST be a CreateTaskError with code "empty_prompt".
            if (!(thrown instanceof CreateTaskError)) {
              throw new Error(
                `Expected CreateTaskError, got: ${
                  thrown instanceof Error ? thrown.message : String(thrown)
                }`,
              );
            }
            expect(thrown.code).toBe("empty_prompt");
            expect(thrown.name).toBe("CreateTaskError");

            // 3. The persistent store MUST remain unchanged. No taskId
            //    must have been minted either — the gate is the very
            //    first check, so id generation must not have run.
            expect(store.size()).toBe(0);
            expect(idGen.calls).toBe(0);
          },
        ),
        { numRuns: 200 },
      );
    },
  );

  // ---- minimal sanity examples ---------------------------------------------
  // These confirm the property is not vacuously true: each shape covered
  // by `arbitraryEmptyPrompt` is rejected for the documented reason, and
  // a control case with a non-empty prompt does NOT produce
  // `empty_prompt` (so the gate is genuinely rejecting on prompt content,
  // not on something else).

  it("rejects the empty string", async () => {
    const orchestrator = buildPassThroughOrchestrator().orchestrator;
    await expect(
      orchestrator.createTask({
        ownerScope: { kind: "local", deviceId: "d1" },
        input: {
          prompt: "",
          modelRef: { provider: "openai", modelId: "gpt-4o", source: "user-api-key" },
          mode: "manual",
          participants: ["agent-coder"],
        },
      }),
    ).rejects.toMatchObject({ code: "empty_prompt" });
  });

  it("rejects a whitespace-only string (incl. Unicode whitespace)", async () => {
    const orchestrator = buildPassThroughOrchestrator().orchestrator;
    await expect(
      orchestrator.createTask({
        ownerScope: { kind: "local", deviceId: "d1" },
        input: {
          prompt: " \t\n\u00a0\ufeff ",
          modelRef: { provider: "openai", modelId: "gpt-4o", source: "user-api-key" },
          mode: "manual",
          participants: ["agent-coder"],
        },
      }),
    ).rejects.toMatchObject({ code: "empty_prompt" });
  });

  it("rejects null and undefined prompts as empty_prompt", async () => {
    const { orchestrator } = buildPassThroughOrchestrator();

    for (const v of [null, undefined]) {
      const input = {
        prompt: v,
        modelRef: { provider: "openai", modelId: "gpt-4o", source: "user-api-key" },
        mode: "manual",
        participants: ["agent-coder"],
      } as unknown as Parameters<typeof orchestrator.createTask>[0]["input"];
      await expect(
        orchestrator.createTask({
          ownerScope: { kind: "local", deviceId: "d1" },
          input,
        }),
      ).rejects.toMatchObject({ code: "empty_prompt" });
    }
  });

  it("a non-empty prompt is NOT rejected as empty_prompt (control case)", async () => {
    // Control: confirms the gate is not rejecting unconditionally.
    const { orchestrator, store } = buildPassThroughOrchestrator();
    const out = await orchestrator.createTask({
      ownerScope: { kind: "local", deviceId: "d1" },
      input: {
        prompt: "Write a hello-world script.",
        modelRef: { provider: "openai", modelId: "gpt-4o", source: "user-api-key" },
        mode: "manual",
        participants: ["agent-coder"],
      },
    });
    expect(typeof out.taskId).toBe("string");
    expect(store.size()).toBe(1);
  });
});

/**
 * Helper: Orchestrator wired with a catalog/resolver/store that would let
 * a non-empty-prompt request succeed. Used by the sanity examples so they
 * isolate the empty-prompt gate from every other rule.
 */
function buildPassThroughOrchestrator(): {
  orchestrator: Orchestrator;
  store: InMemoryTaskStateStore;
} {
  const catalog = new FixedCatalog([
    {
      provider: "openai",
      status: "ok",
      models: [
        {
          provider: "openai",
          modelId: "gpt-4o",
          displayName: "gpt-4o",
          source: "user-api-key",
        },
      ],
    },
  ]);
  const resolver = new FixedAutoResolver(["agent-coder"]);
  const store = new InMemoryTaskStateStore();
  const idGen = new RecordingIdGenerator();
  const orchestrator = new Orchestrator({
    modelCatalog: catalog,
    autoResolver: resolver,
    store,
    idGenerator: idGen,
    clock: fixedClock,
  });
  return { orchestrator, store };
}
