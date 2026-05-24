/**
 * Property test for {@link ModelCatalog} provider isolation.
 *
 * **Property 7: Provider failure in Model_Catalog does not remove other
 * providers' models.**
 *
 * Validates: Requirements 5.3.
 *
 * Source:
 * - `design.md` → "Testing Strategy" → "Property-based tests" → property 7.
 * - `tasks.md` → task 7.3 ("Write property test for Model_Catalog provider
 *   isolation").
 * - `requirements.md` →
 *     5.3 "IF Provider возвращает ошибку при запросе списка моделей, THEN
 *          THE Model_Catalog SHALL отобразить пользователю сообщение об
 *          ошибке с указанием Provider и причины и SHALL не блокировать
 *          отображение моделей других Provider."
 *
 * The test asserts that for **any** multi-provider catalog configuration
 * with **any** subset of providers configured to fail, calling
 * `listModelsForUser` returns:
 *
 *   1. exactly one entry per configured adapter, in adapter order,
 *   2. an `ok` entry with the adapter's full model list for every healthy
 *      provider — irrespective of how many siblings failed,
 *   3. an `error` entry with a non-empty `reason` for every failing
 *      provider — and nothing else (in particular: no thrown exception
 *      escapes `listModelsForUser`).
 *
 * The combination of (1) + (2) + (3) is the precise content of Requirement
 * 5.3: a failing provider produces a structured error specific to that
 * provider, while sibling providers' results are preserved in full.
 *
 * Generator design notes:
 *
 *   • Providers are drawn from a small fixed alphabet so collisions are
 *     possible; we then dedupe to a unique list, since the catalog rejects
 *     duplicate adapter registrations at construction time.
 *   • Each provider is assigned a `behavior` independently, mixing success
 *     with every documented failure mode (adapter throws Error, adapter
 *     throws non-Error, resolver throws, resolver returns `null`). Without
 *     all four failure buckets the property would only exercise the easy
 *     paths.
 *   • Model lists are kept short (0..3 entries) so shrinking produces tiny,
 *     readable counter-examples while still exercising the empty-list
 *     branch (a successful provider with zero models is still `ok`, not
 *     `error`).
 *   • Both `local` and `cloud` scopes are generated to confirm cache keying
 *     and isolation semantics do not depend on scope kind.
 */

import { describe, it } from "vitest";
import * as fc from "fast-check";

import type {
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";

import {
  type ApiKeyResolver,
  type ModelInfo,
  type ProviderModelsAdapter,
  ModelCatalog,
} from "./index.js";

/**
 * One of the documented failure modes the catalog must isolate.
 *
 * Each variant maps to a distinct error path in
 * `ModelCatalog.fetchForProvider`:
 *
 *   • `success`            — the happy path; adapter returns models.
 *   • `adapter-throws`     — adapter rejects with an `Error`.
 *   • `adapter-throws-raw` — adapter rejects with a non-Error (string).
 *     This exercises the `describeUnexpectedError` fallback so a misbehaving
 *     adapter still produces a structured `status: "error"`.
 *   • `resolver-throws`    — `apiKeyResolver.resolveApiKey` rejects.
 *   • `no-key`             — resolver returns `null`, meaning the user has
 *     no API key for that provider.
 */
type ProviderBehavior =
  | { kind: "success"; models: readonly ModelInfo[] }
  | { kind: "adapter-throws"; message: string }
  | { kind: "adapter-throws-raw"; message: string }
  | { kind: "resolver-throws"; message: string }
  | { kind: "no-key" };

interface ProviderSpec {
  readonly provider: ProviderId;
  readonly behavior: ProviderBehavior;
}

/**
 * Arbitrary provider id drawn from a small alphabet so collisions occur
 * frequently. Duplicates are removed downstream.
 */
const arbProviderId: fc.Arbitrary<ProviderId> = fc.constantFrom(
  "openai",
  "anthropic",
  "mistral",
  "google",
  "platform",
  "cohere",
);

/**
 * Arbitrary `ModelInfo`. The provider field is filled in by the caller so
 * each model lines up with the adapter that owns it; here we only generate
 * the per-model fields.
 */
function arbModelInfoFor(provider: ProviderId): fc.Arbitrary<ModelInfo> {
  return fc.record({
    modelId: fc
      .stringMatching(/^[a-zA-Z0-9_-]{1,16}$/)
      .filter((s) => s.length > 0),
    displayName: fc.string({ minLength: 1, maxLength: 32 }),
    source: fc.constantFrom("user-api-key", "platform-fallback"),
  }).map((m) => ({
    provider,
    modelId: m.modelId,
    displayName: m.displayName,
    source: m.source as ModelInfo["source"],
  }));
}

function arbBehaviorFor(provider: ProviderId): fc.Arbitrary<ProviderBehavior> {
  // Non-empty error messages so the catalog's reason field stays meaningful.
  const arbMessage = fc.string({ minLength: 1, maxLength: 32 });
  return fc.oneof(
    fc.array(arbModelInfoFor(provider), { maxLength: 3 }).map(
      (models) => ({ kind: "success" as const, models }),
    ),
    arbMessage.map((message) => ({
      kind: "adapter-throws" as const,
      message,
    })),
    arbMessage.map((message) => ({
      kind: "adapter-throws-raw" as const,
      message,
    })),
    arbMessage.map((message) => ({
      kind: "resolver-throws" as const,
      message,
    })),
    fc.constant({ kind: "no-key" as const }),
  );
}

function arbProviderSpec(): fc.Arbitrary<ProviderSpec> {
  return arbProviderId.chain((provider) =>
    arbBehaviorFor(provider).map((behavior) => ({ provider, behavior })),
  );
}

/**
 * Generates a non-empty list of provider specs with unique provider ids.
 * Duplicate ids are dropped (keeping the first occurrence) because
 * `ModelCatalog` rejects duplicate adapters at construction.
 */
const arbProviderSpecs: fc.Arbitrary<readonly ProviderSpec[]> = fc
  .array(arbProviderSpec(), { minLength: 1, maxLength: 6 })
  .map((specs) => {
    const seen = new Set<ProviderId>();
    const unique: ProviderSpec[] = [];
    for (const s of specs) {
      if (!seen.has(s.provider)) {
        seen.add(s.provider);
        unique.push(s);
      }
    }
    return unique;
  })
  .filter((specs) => specs.length >= 1);

const arbScope: fc.Arbitrary<Scope> = fc.oneof(
  fc
    .string({ minLength: 1, maxLength: 16 })
    .map((deviceId) => ({ kind: "local" as const, deviceId })),
  fc
    .string({ minLength: 1, maxLength: 16 })
    .map((userId) => ({ kind: "cloud" as const, userId })),
);

/**
 * Builds the resolver + adapters that realise a given list of specs.
 *
 * The returned objects honour the `ProviderModelsAdapter` and
 * `ApiKeyResolver` contracts but inject the configured failure modes.
 */
function buildCatalog(specs: readonly ProviderSpec[]): {
  catalog: ModelCatalog;
  expectedOk: Map<ProviderId, readonly ModelInfo[]>;
  expectedErr: Set<ProviderId>;
} {
  const expectedOk = new Map<ProviderId, readonly ModelInfo[]>();
  const expectedErr = new Set<ProviderId>();
  const behaviorByProvider = new Map<ProviderId, ProviderBehavior>();

  for (const spec of specs) {
    behaviorByProvider.set(spec.provider, spec.behavior);
    if (spec.behavior.kind === "success") {
      expectedOk.set(spec.provider, spec.behavior.models);
    } else {
      expectedErr.add(spec.provider);
    }
  }

  const resolver: ApiKeyResolver = {
    async resolveApiKey(_scope, provider) {
      const b = behaviorByProvider.get(provider);
      if (!b) throw new Error(`unknown provider ${provider}`);
      switch (b.kind) {
        case "no-key":
          return null;
        case "resolver-throws":
          throw new Error(b.message);
        case "success":
        case "adapter-throws":
        case "adapter-throws-raw":
          // Any non-empty key is fine; the adapter does not validate it.
          return "stub-key";
      }
    },
  };

  const adapters: ProviderModelsAdapter[] = specs.map((spec) => ({
    provider: spec.provider,
    async listModels(_input) {
      const b = spec.behavior;
      switch (b.kind) {
        case "success":
          return b.models;
        case "adapter-throws":
          throw new Error(b.message);
        case "adapter-throws-raw":
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw b.message;
        case "no-key":
        case "resolver-throws":
          // The catalog short-circuits before reaching the adapter, so
          // these branches must never run. Surface a loud failure if they
          // do — that would indicate a regression in catalog ordering.
          throw new Error(
            `adapter for ${spec.provider} called for ${b.kind}; catalog must short-circuit`,
          );
      }
    },
  }));

  const catalog = new ModelCatalog({
    adapters,
    apiKeyResolver: resolver,
    // A long TTL keeps cache behaviour out of scope for this property; the
    // dedicated cache tests live in `catalog.test.ts`.
    ttlMs: 60_000,
    // Frozen clock so cache state is fully deterministic.
    now: () => 0,
  });

  return { catalog, expectedOk, expectedErr };
}

describe("ModelCatalog provider isolation (Property 7)", () => {
  it("preserves successful providers regardless of which siblings fail", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbProviderSpecs,
        arbScope,
        async (specs, scope) => {
          const { catalog, expectedOk, expectedErr } = buildCatalog(specs);

          // The catalog must never throw, no matter how many providers fail.
          const out = await catalog.listModelsForUser(scope);

          // (1) exactly one entry per configured adapter, in adapter order.
          if (out.length !== specs.length) {
            throw new Error(
              `expected ${specs.length} results, got ${out.length}`,
            );
          }
          for (let i = 0; i < specs.length; i++) {
            const spec = specs[i];
            const entry = out[i];
            if (!spec || !entry) {
              throw new Error(`missing spec/entry at index ${i}`);
            }
            if (entry.provider !== spec.provider) {
              throw new Error(
                `provider order broken at ${i}: expected ${spec.provider}, got ${entry.provider}`,
              );
            }
          }

          // (2) every healthy provider yields `ok` with its full model list,
          //     unchanged by sibling failures.
          for (const entry of out) {
            const expected = expectedOk.get(entry.provider);
            if (expected !== undefined) {
              if (entry.status !== "ok") {
                throw new Error(
                  `provider ${entry.provider}: expected ok, got error "${
                    entry.status === "error" ? entry.reason : "?"
                  }"`,
                );
              }
              if (entry.models.length !== expected.length) {
                throw new Error(
                  `provider ${entry.provider}: model count drift (expected ${expected.length}, got ${entry.models.length})`,
                );
              }
              for (let j = 0; j < expected.length; j++) {
                const a = expected[j];
                const b = entry.models[j];
                if (!a || !b) {
                  throw new Error(
                    `provider ${entry.provider}: missing model at ${j}`,
                  );
                }
                if (
                  a.modelId !== b.modelId ||
                  a.displayName !== b.displayName ||
                  a.source !== b.source ||
                  a.provider !== b.provider
                ) {
                  throw new Error(
                    `provider ${entry.provider}: model ${j} altered by catalog`,
                  );
                }
              }
            }
          }

          // (3) every failing provider yields a structured `error` entry
          //     with a non-empty reason; failures never collapse into an
          //     empty `ok` list.
          for (const entry of out) {
            if (expectedErr.has(entry.provider)) {
              if (entry.status !== "error") {
                throw new Error(
                  `provider ${entry.provider}: expected error, got ok`,
                );
              }
              if (typeof entry.reason !== "string" || entry.reason.length === 0) {
                throw new Error(
                  `provider ${entry.provider}: error reason missing`,
                );
              }
            }
          }

          // (4) ok-count + error-count must equal total providers — i.e. no
          //     provider was silently dropped because of a sibling.
          const okCount = out.filter((e) => e.status === "ok").length;
          const errCount = out.filter((e) => e.status === "error").length;
          if (okCount + errCount !== specs.length) {
            throw new Error(
              `provider count mismatch: ok=${okCount}, err=${errCount}, total=${specs.length}`,
            );
          }
          if (okCount !== expectedOk.size) {
            throw new Error(
              `ok provider count drift: expected ${expectedOk.size}, got ${okCount}`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
