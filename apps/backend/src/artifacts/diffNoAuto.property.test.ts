/**
 * Property test for `ArtifactStore` diff non-auto-display (task 10.5).
 *
 * **Property 11: Diff is never displayed automatically.**
 *
 * Validates: Requirement 11.5.
 *
 * Source:
 *  - design.md → "Testing Strategy" → "Property-based tests" → property 11
 *    ("Diff is never displayed automatically").
 *  - design.md → "Artifact Store" → "Rules":
 *      • "Diff generation happens only on explicit request."
 *  - design.md → "UI Design" → "Agent Trace UI" → "Rules":
 *      • "diff never opens automatically".
 *  - tasks.md → task 10.5 ("Write property test for diff non-auto-display").
 *  - requirements.md →
 *      11.5 (THE Orchestrator SHALL не отображать диф File_Artifact
 *            автоматически или по иным триггерам, кроме явного выбора
 *            пользователем).
 *
 * Property statement (backend-side):
 *
 *   Requirement 11.5 is fundamentally a UI rule: the *display* of a diff
 *   must happen only in response to an explicit user gesture. The
 *   backend's contribution to that rule is structural — none of the
 *   non-diff API paths (`writeArtifact`, `getArtifact`, `listArtifacts`)
 *   may compute, fetch or otherwise materialise a diff as a side effect.
 *   If they did, the UI could not honour 11.5 even with perfect
 *   client-side discipline because diffs would already be flowing through
 *   the trace / artifact streams.
 *
 *   Concretely: for any sequence of `writeArtifact` / `getArtifact` /
 *   `listArtifacts` calls (in arbitrary order, on artifacts with any
 *   number of versions), the unified-diff helper used by the store MUST
 *   be invoked exactly zero times. Only `getDiff` may invoke it — and we
 *   verify that positive direction in the same property by sampling
 *   `getDiff` at the end of every run and asserting the counter advanced.
 *
 *   This catches regressions such as:
 *     • a future "auto-show latest diff" optimisation in `writeArtifact`,
 *     • a `listArtifacts` projection that silently embeds the latest diff
 *       alongside metadata,
 *     • a `getArtifact` short-circuit that pre-renders diffs against the
 *       previous version when `version === undefined`.
 *
 * Implementation strategy:
 *
 *   The store accepts an injectable `computeDiff` function (see
 *   `ArtifactStoreOptions.computeDiff` in `artifactStore.ts`). The
 *   property installs a counting spy in that slot so call counts are
 *   observable from outside the store. The default of the field stays
 *   `computeUnifiedDiff` for production, so the public API is backwards
 *   compatible — callers that do not know about the seam are unaffected.
 *
 * Generator design notes:
 *
 *  - We model an arbitrary sequence of operations as a tagged union so
 *    fast-check can shrink the *kind* of operation independently from
 *    its parameters. The shrinker quickly localises any failure to the
 *    minimal offending op.
 *  - `writeArtifact` operations are biased toward the existing artifact
 *    pool (when one exists) so we naturally produce multi-version
 *    artifacts. Without that bias the property would mostly exercise
 *    fresh, single-version writes and miss regressions in the version-
 *    bumping branch (which is the most plausible place for an
 *    accidental diff invocation).
 *  - `getArtifact` operations occasionally request explicit versions,
 *    including out-of-range ones, so the `null` return paths are
 *    covered too — those paths are the most tempting place to add a
 *    "show last successful diff" fallback in the future.
 *  - `listArtifacts` operations occasionally target the empty case
 *    (a task with no artifacts) and the populated case.
 *
 * The companion unit tests in `artifactStore.test.ts` already cover the
 * positive `getDiff` example. This file owns the universal "no other
 * path triggers diff" invariant and only sanity-checks `getDiff` at the
 * end of every run.
 */

import { describe, it } from "vitest";
import * as fc from "fast-check";

import {
  ArtifactStore,
  InMemoryArtifactStoreBackend,
} from "./index.js";
import type { Clock, ComputeUnifiedDiffFn } from "./artifactStore.js";

/**
 * Deterministic clock used by every property run. Each `now()` advances
 * by 1 ms so version `createdAt` / `updatedAt` are strictly ordered;
 * shrunken counter-examples are reproducible across runs.
 */
function makeSteppingClock(initialIso = "2024-01-01T00:00:00.000Z"): Clock {
  let current = new Date(initialIso).getTime();
  return {
    now() {
      const at = new Date(current);
      current += 1;
      return at;
    },
  };
}

/**
 * Counting diff spy. Returns a benign placeholder so when `getDiff` does
 * call it the unified-diff structure is still valid. The body of the
 * patch is irrelevant for this property — we only care about the call
 * count.
 */
function makeCountingDiff(): ComputeUnifiedDiffFn & { calls: number } {
  let calls = 0;
  const fn = ((oldText: string, newText: string) => {
    calls += 1;
    if (oldText === newText) return "";
    return `--- spy\n+++ spy\n@@ -1,1 +1,1 @@\n-${oldText}\n+${newText}\n`;
  }) as ComputeUnifiedDiffFn & { calls: number };
  Object.defineProperty(fn, "calls", {
    get: () => calls,
    enumerable: true,
  });
  return fn;
}

/**
 * Operation grammar. The property runs a freshly-shuffled sequence of
 * these against a shared store and asserts the spy stays at zero.
 */
type Op =
  | {
      readonly kind: "write";
      /** Index into the artifact pool, modulo current pool size. */
      readonly artifactIndex: number;
      /** Force a fresh artifact id when true (and pool is empty or chosen so). */
      readonly fresh: boolean;
      readonly bytes: Uint8Array;
      readonly fileName: string;
      readonly mimeType: string | undefined;
      readonly authoredByAgentId: string;
    }
  | {
      readonly kind: "get";
      readonly artifactIndex: number;
      /** When `undefined`, request the latest version. */
      readonly version: number | undefined;
      /** Occasionally targets a non-existent artifact id. */
      readonly missLookup: boolean;
    }
  | {
      readonly kind: "list";
      /** When true, list a task that has no artifacts. */
      readonly emptyTask: boolean;
    };

const arbitraryBytes = fc.uint8Array({ minLength: 0, maxLength: 256 });
const arbitraryFileName = fc.string({ minLength: 1, maxLength: 32 });
const arbitraryMimeType = fc.oneof(
  fc.constant<string | undefined>(undefined),
  fc.constantFrom(
    "text/plain",
    "application/json",
    "application/octet-stream",
  ),
);
const arbitraryAgentId = fc.constantFrom(
  "coder",
  "fixer",
  "researcher",
  "reviewer",
  "boss",
);

const writeOp = fc.record({
  kind: fc.constant<"write">("write"),
  artifactIndex: fc.nat(15),
  fresh: fc.boolean(),
  bytes: arbitraryBytes,
  fileName: arbitraryFileName,
  mimeType: arbitraryMimeType,
  authoredByAgentId: arbitraryAgentId,
});

const getOp = fc.record({
  kind: fc.constant<"get">("get"),
  artifactIndex: fc.nat(15),
  version: fc.oneof(
    fc.constant<number | undefined>(undefined),
    fc.integer({ min: 1, max: 8 }),
  ),
  missLookup: fc.boolean(),
});

const listOp = fc.record({
  kind: fc.constant<"list">("list"),
  emptyTask: fc.boolean(),
});

/**
 * Bias toward writes so we naturally accumulate multi-version artifacts;
 * otherwise the operation mix would be dominated by reads against a
 * largely-empty pool and miss the version-bump branch entirely.
 */
const arbitraryOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: writeOp },
  { weight: 3, arbitrary: getOp },
  { weight: 2, arbitrary: listOp },
);

/**
 * Sequence length range. Sequences shorter than 2 are uninteresting
 * (most won't even trigger the version-bump branch); >40 wastes time
 * for the same coverage.
 */
const arbitraryOps = fc.array(arbitraryOp, { minLength: 2, maxLength: 40 });

const arbitraryShortId = fc.string({ minLength: 1, maxLength: 16 });

describe("ArtifactStore (Property 11: diff is never displayed automatically)", () => {
  it("Property 11: writeArtifact, getArtifact and listArtifacts never trigger diff computation; only getDiff does (Validates: Requirement 11.5)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryOps,
        arbitraryShortId,
        async (ops, taskId) => {
          const backend = new InMemoryArtifactStoreBackend();
          const computeDiff = makeCountingDiff();
          const store = new ArtifactStore({
            backend,
            clock: makeSteppingClock(),
            computeDiff,
          });

          // The pool is the canonical list of artifact ids the store has
          // ever held in this run. New writes either pick an existing id
          // (extending it with a new version) or push a fresh id.
          const pool: string[] = [];
          let freshCounter = 0;

          for (const op of ops) {
            switch (op.kind) {
              case "write": {
                const useFreshId = op.fresh || pool.length === 0;
                const artifactId = useFreshId
                  ? `art-${freshCounter++}`
                  : (pool[op.artifactIndex % pool.length] as string);
                if (useFreshId) {
                  pool.push(artifactId);
                }
                await store.writeArtifact({
                  taskId,
                  artifactId,
                  authoredByAgentId: op.authoredByAgentId,
                  bytes: op.bytes.slice(),
                  fileName: op.fileName,
                  ...(op.mimeType !== undefined ? { mimeType: op.mimeType } : {}),
                });
                break;
              }
              case "get": {
                const artifactId = op.missLookup || pool.length === 0
                  ? "art-does-not-exist"
                  : (pool[op.artifactIndex % pool.length] as string);
                await store.getArtifact({
                  taskId,
                  artifactId,
                  ...(op.version !== undefined ? { version: op.version } : {}),
                });
                break;
              }
              case "list": {
                const target = op.emptyTask ? "task-does-not-exist" : taskId;
                await store.listArtifacts(target);
                break;
              }
            }

            // Tightest possible invariant: the spy never advances during
            // the read/write loop. Re-checking after every op lets a
            // shrunken counter-example pinpoint the exact offender.
            if (computeDiff.calls !== 0) {
              throw new Error(
                `${op.kind} triggered diff computation (calls=${computeDiff.calls}); only getDiff may invoke computeDiff (Requirement 11.5)`,
              );
            }
          }

          // Final whole-run check (defence-in-depth in case the inner
          // loop above is ever silenced by a refactor).
          if (computeDiff.calls !== 0) {
            throw new Error(
              `non-diff API paths invoked computeDiff ${computeDiff.calls} times; expected 0`,
            );
          }

          // Positive control: getDiff *must* exercise the seam — that's
          // how we know the spy is wired into the path that should call
          // it. We need at least two distinct versions on a single
          // artifact to make a meaningful call. If the run did not
          // produce that situation, manufacture it deterministically so
          // every run still validates the positive direction.
          let probeArtifactId: string | undefined;
          for (const id of pool) {
            const list = await store.listArtifacts(taskId);
            const meta = list.find((m) => m.id === id);
            if (meta !== undefined && meta.latestVersion >= 2) {
              probeArtifactId = id;
              break;
            }
          }
          if (probeArtifactId === undefined) {
            // Force a two-version artifact under a fresh id so the
            // pre-existing pool is untouched.
            probeArtifactId = `art-probe-${freshCounter++}`;
            await store.writeArtifact({
              taskId,
              artifactId: probeArtifactId,
              authoredByAgentId: "coder",
              bytes: new TextEncoder().encode("v1\n"),
              fileName: "probe.txt",
            });
            await store.writeArtifact({
              taskId,
              artifactId: probeArtifactId,
              authoredByAgentId: "fixer",
              bytes: new TextEncoder().encode("v2\n"),
              fileName: "probe.txt",
            });
            // The forced writes themselves must not have triggered diff
            // computation — re-check before the positive control.
            if (computeDiff.calls !== 0) {
              throw new Error(
                `forced probe writes triggered diff computation (calls=${String(computeDiff.calls)}); only getDiff may invoke computeDiff (Requirement 11.5)`,
              );
            }
          }

          const before = computeDiff.calls;
          const diff = await store.getDiff({
            taskId,
            artifactId: probeArtifactId,
            fromVersion: 1,
            toVersion: 2,
          });
          if (diff === null) {
            throw new Error(
              "getDiff returned null for an artifact known to have v1 and v2; positive control failed",
            );
          }
          if (computeDiff.calls !== before + 1) {
            throw new Error(
              `getDiff did not invoke computeDiff exactly once; before=${before}, after=${computeDiff.calls}`,
            );
          }
        },
      ),
      // 100 runs covers the operation grammar without ballooning runtime;
      // each run already exercises up to 40 mixed ops against the spy.
      { numRuns: 100 },
    );
  });
});
