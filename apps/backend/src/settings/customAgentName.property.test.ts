/**
 * Property test for `customAgents.upsertCustomAgent` name uniqueness (task 6.6).
 *
 * **Property 13: Custom_Agent cannot use duplicate Builtin_Agent name.**
 *
 * Validates: Requirements 12.3.
 *
 * Sources:
 *   - design.md → "Testing Strategy" → "Property-based tests" → Property 13.
 *   - design.md → "Settings Store" → `SettingsStore` interface;
 *     `upsertCustomAgent` rules (name uniqueness within scope, rejection on
 *     conflicts with Builtin_Agent or other Custom_Agent records).
 *   - requirements.md →
 *       12.2 ("THE Settings_Store SHALL валидировать уникальность имени в
 *              пределах учётной записи пользователя ..."),
 *       12.3 ("IF имя Custom_Agent совпадает с именем существующего
 *              Builtin_Agent или другого Custom_Agent пользователя, THEN
 *              THE Settings_Store SHALL отклонить сохранение и сообщить о
 *              конфликте имён.").
 *   - tasks.md → 6.6 sub-bullets ("API rejects names colliding with built-in
 *     agent names (Researcher, Coder, Reviewer, Fixer, Boss — case-insensitive
 *     if the design allows it ...) AND with other `Custom_Agent`s in the
 *     same scope.").
 *
 * Property statement
 * ------------------
 * The five Builtin_Agent names — researcher, coder, reviewer, fixer, boss —
 * are reserved. The `customAgents.ts` implementation normalizes names by
 * trimming and lowercasing before comparison, so the case-insensitive reading
 * of Requirement 12.3 is the one in force.
 *
 * Drive `CustomAgentService` with an arbitrary sequence of `upsertCustomAgent`
 * calls across one or more scopes, where each call is one of:
 *
 *   • `valid`        — name freely chosen but normalized to something
 *                      outside the builtin set.
 *   • `builtin`      — name picked as a (possibly case-perturbed,
 *                      whitespace-padded) variation of a Builtin_Agent name.
 *
 * For every action, assert:
 *
 *   (P1)  Every `builtin`-action upsert throws
 *         `CustomAgentNameConflictError` with `conflictWith === "builtin"`.
 *         No `builtin`-action call ever succeeds.
 *
 *   (P2)  Every `valid`-action upsert resolves to a `CustomAgent` whose
 *         `name` round-trips the input and whose normalized name is NOT a
 *         builtin name.
 *
 * After replaying the full action stream, assert (per scope):
 *
 *   (P3)  `listCustomAgents(scope)` contains no record whose normalized
 *         name equals any Builtin_Agent name. This is the post-condition
 *         form of (P1): no successful path can have leaked a builtin
 *         collision into the store.
 *
 *   (P4)  `listCustomAgents(scope)` contains no two records with the same
 *         normalized name. This is the "name uniqueness within scope"
 *         half of Requirement 12.3 — the API is "upsert", so a second
 *         call with the same normalized name in the same scope updates
 *         the existing record instead of creating a duplicate, but either
 *         way the store invariant is "≤ 1 record per normalized name per
 *         scope".
 *
 * Generator design notes
 * ----------------------
 *  - `arbitraryBuiltinName` deliberately mixes case and pads whitespace so
 *    counter-examples will tell us whether normalization (trim + lowercase)
 *    is the part that's broken vs. the conflict check itself.
 *  - `arbitraryNonBuiltinName` filters out anything that normalizes to a
 *    Builtin_Agent name so the `valid` arm cannot accidentally trigger the
 *    builtin-conflict path.
 *  - The action stream is bounded (≤ 12 actions, ≤ 3 distinct scopes)
 *    to keep individual runs fast while still exercising sequences with
 *    repeated names (which exercise the upsert-vs-create path) and
 *    cross-scope independence.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type { Scope } from "@ai-agent-orchestrator/shared-core";
import type { CustomAgentInput } from "@ai-agent-orchestrator/validation";

import {
  BUILTIN_AGENT_NAMES,
  CustomAgentNameConflictError,
  InMemoryCustomAgentStore,
  createCustomAgentService,
} from "./customAgents.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Match the normalization rule used inside `customAgents.ts`. */
function normalize(name: string): string {
  return name.trim().toLowerCase();
}

const BUILTIN_NAME_SET: ReadonlySet<string> = new Set(
  BUILTIN_AGENT_NAMES.map((n) => n.toLowerCase()),
);

/** Stable string key for a `Scope`, used to bucket records by scope. */
function scopeKey(scope: Scope): string {
  return scope.kind === "local"
    ? `local:${scope.deviceId}`
    : `cloud:${scope.userId}`;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Local-or-cloud scope with a short alphanumeric identifier. */
const arbitraryScope: fc.Arbitrary<Scope> = fc.oneof(
  fc
    .stringMatching(/^[a-zA-Z0-9-]{1,8}$/)
    .filter((s) => s.length > 0)
    .map((deviceId) => ({ kind: "local", deviceId } as const)),
  fc
    .stringMatching(/^[a-zA-Z0-9-]{1,8}$/)
    .filter((s) => s.length > 0)
    .map((userId) => ({ kind: "cloud", userId } as const)),
);

/**
 * A name that — after trim + lowercase — matches one of the five
 * Builtin_Agent names. Generates case-perturbed and whitespace-padded
 * variants to exercise the normalization in the conflict check.
 */
const arbitraryBuiltinName: fc.Arbitrary<string> = fc
  .constantFrom(...BUILTIN_AGENT_NAMES)
  .chain((base) =>
    fc
      .tuple(
        // Random per-character casing.
        fc.array(fc.boolean(), { minLength: base.length, maxLength: base.length }),
        // Optional whitespace padding on either side.
        fc.string({ unit: fc.constantFrom(" ", "\t"), maxLength: 3 }),
        fc.string({ unit: fc.constantFrom(" ", "\t"), maxLength: 3 }),
      )
      .map(([casing, prefix, suffix]) => {
        const cased = Array.from(base)
          .map((ch, i) => (casing[i] ? ch.toUpperCase() : ch.toLowerCase()))
          .join("");
        return `${prefix}${cased}${suffix}`;
      }),
  );

/**
 * A name that, after normalization, is NOT a Builtin_Agent name. Filters out
 * accidental matches so the `valid` arm cleanly tests the success path. Also
 * required to be non-empty after trim to satisfy `customAgentNameSchema`.
 */
const arbitraryNonBuiltinName: fc.Arbitrary<string> = fc
  .stringMatching(/^[ \t]*[A-Za-z0-9 _\t-]{1,20}[ \t]*$/)
  .filter((s) => {
    const trimmed = s.trim();
    if (trimmed.length === 0) return false;
    return !BUILTIN_NAME_SET.has(trimmed.toLowerCase());
  });

/** Minimal `CustomAgentInput` factory. */
function buildInput(name: string): CustomAgentInput {
  return {
    name,
    systemPrompt: "do the thing",
    allowedTools: [],
  };
}

type Action =
  | {
      readonly kind: "builtin";
      readonly scope: Scope;
      readonly name: string;
    }
  | {
      readonly kind: "valid";
      readonly scope: Scope;
      readonly name: string;
    };

const arbitraryBuiltinAction: fc.Arbitrary<Action> = fc.record({
  kind: fc.constant("builtin" as const),
  scope: arbitraryScope,
  name: arbitraryBuiltinName,
});

const arbitraryValidAction: fc.Arbitrary<Action> = fc.record({
  kind: fc.constant("valid" as const),
  scope: arbitraryScope,
  name: arbitraryNonBuiltinName,
});

/**
 * Action stream: balanced 1:1 between the two arms so each run typically
 * exercises both the rejection path and the success path. Bounded length so
 * fast-check shrinkage stays cheap.
 */
const arbitraryActions: fc.Arbitrary<readonly Action[]> = fc.array(
  fc.oneof(
    { weight: 1, arbitrary: arbitraryBuiltinAction },
    { weight: 1, arbitrary: arbitraryValidAction },
  ),
  { minLength: 1, maxLength: 12 },
);

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("customAgents.upsertCustomAgent", () => {
  it(
    "Property 13: rejects names colliding with Builtin_Agent names " +
      "(case-insensitive, trim-tolerant) and never permits duplicate names " +
      "within a scope (Validates: Requirements 12.3)",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryActions, async (actions) => {
          const store = new InMemoryCustomAgentStore();
          const service = createCustomAgentService(store);

          const touchedScopes = new Map<string, Scope>();

          for (const action of actions) {
            touchedScopes.set(scopeKey(action.scope), action.scope);

            if (action.kind === "builtin") {
              // (P1) Every builtin-named upsert MUST be rejected with
              // CustomAgentNameConflictError(conflictWith="builtin").
              let thrown: unknown = null;
              try {
                await service.upsertCustomAgent(action.scope, buildInput(action.name));
              } catch (err) {
                thrown = err;
              }
              expect(
                thrown,
                `expected CustomAgentNameConflictError for builtin-name upsert (name="${action.name}")`,
              ).toBeInstanceOf(CustomAgentNameConflictError);
              const err = thrown as CustomAgentNameConflictError;
              expect(
                err.conflictWith,
                `expected conflictWith="builtin" for name="${action.name}"`,
              ).toBe("builtin");
            } else {
              // (P2) Every non-builtin upsert MUST succeed and round-trip
              // the original name.
              const result = await service.upsertCustomAgent(
                action.scope,
                buildInput(action.name),
              );
              expect(result.kind).toBe("custom");
              expect(result.name).toBe(action.name);
              expect(
                BUILTIN_NAME_SET.has(normalize(result.name)),
                `non-builtin upsert produced a record whose normalized name is reserved (name="${action.name}")`,
              ).toBe(false);
            }
          }

          // (P3) and (P4): per-scope post-conditions over the persisted
          // records, regardless of which actions touched the scope.
          for (const [, scope] of touchedScopes) {
            const records = await service.listCustomAgents(scope);

            // (P3) No persisted record uses a Builtin_Agent name.
            for (const record of records) {
              expect(
                BUILTIN_NAME_SET.has(normalize(record.name)),
                `store contains a record whose normalized name is reserved: id="${record.id}", name="${record.name}"`,
              ).toBe(false);
            }

            // (P4) No two persisted records share a normalized name.
            const seen = new Set<string>();
            for (const record of records) {
              const norm = normalize(record.name);
              expect(
                seen.has(norm),
                `store contains duplicate normalized names within scope: "${norm}"`,
              ).toBe(false);
              seen.add(norm);
            }
          }
        }),
        { numRuns: 200 },
      );
    },
  );
});
