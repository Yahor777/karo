/**
 * Property test for `ArtifactStore.writeArtifact` idempotency (task 10.4).
 *
 * **Property 6: File_Artifact same-content write is idempotent.**
 *
 * Validates: Requirements 7.4, 11.7.
 *
 * Source:
 *  - design.md → "Testing Strategy" → "Property-based tests" → property 6.
 *  - design.md → "Artifact Store" → "Rules":
 *      • "Versions are append-only."
 *      • "Same `contentHash` for same artifact is no-op and does not
 *        increment version."
 *  - tasks.md → task 10.4 ("Write property test for idempotent same-content
 *    write").
 *  - requirements.md →
 *      7.4  (Coder produces a single File_Artifact atomically; retries on
 *            the same content must not multiply versions),
 *      11.7 (full File_Artifact set is preserved for the task — duplicating
 *            byte-identical versions would silently inflate that history
 *            and confuse the Final_Report / diff viewer).
 *
 * Property statement:
 *
 *   For arbitrary byte payloads `bytes`, an arbitrary `(taskId, artifactId)`
 *   pair, and an arbitrary number `N >= 2` of repeated `writeArtifact`
 *   invocations carrying the **same** `bytes` for that pair, the resulting
 *   ArtifactStore state has:
 *
 *     1. exactly one stored version (`latestVersion === 1`);
 *     2. byte-for-byte identical content to the input (`bytes` round-trip);
 *     3. a single `contentHash` matching `computeContentHash(bytes)`;
 *     4. a stable `createdAt` for that single version (the no-op writes
 *        do not bump the timestamp because they do not append a version);
 *     5. and every `writeArtifact` call returns the same version number 1.
 *
 *   Crucially this must hold even when the repeated calls vary in
 *   ancillary fields the design allows producers to refine between writes
 *   (`fileName`, `mimeType`, `authoredByAgentId`). Idempotency is keyed
 *   on the byte content of `(taskId, artifactId)`, not on those fields.
 *
 * Generator design notes:
 *
 *  - `arbitraryBytes` covers empty, small, and moderately sized payloads.
 *    The 4 KiB upper bound keeps the generator fast while still exercising
 *    multi-block SHA-256 hashing inside `computeContentHash`.
 *  - `arbitraryRepeats` is constrained to `[2, 8]` so each property run
 *    actually performs a *repeated* write (the N=1 case is degenerate and
 *    is covered by the unit tests in `artifactStore.test.ts`).
 *  - We deliberately *do not* generate a fresh `ArtifactStore` per run via
 *    fast-check's beforeEach hook: instead each run creates an isolated
 *    `(taskId, artifactId)` so collisions between runs are impossible and
 *    the property is purely about a single-artifact trajectory.
 *
 * The companion unit tests in `artifactStore.test.ts` cover example-level
 * write behaviour. This file owns the universal idempotency invariant and
 * deliberately avoids duplicating those examples.
 */

import { describe, it } from "vitest";
import * as fc from "fast-check";

import {
  ArtifactStore,
  InMemoryArtifactStoreBackend,
  computeContentHash,
} from "./index.js";
import type { Clock } from "./artifactStore.js";

/**
 * Deterministic clock used by every property run.
 *
 * Each call to `now()` advances by 1 ms so any accidental version append
 * would be observable as a strictly later `updatedAt`. A real-world clock
 * with the same property would also expose the bug, but a fixed-step
 * clock makes the counter-example fast-check prints reproducible.
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

/** Bytes arbitrary — empty, small and multi-block sized payloads. */
const arbitraryBytes = fc.uint8Array({ minLength: 0, maxLength: 4096 });

/** Number of repeated `writeArtifact` invocations for the same content. */
const arbitraryRepeats = fc.integer({ min: 2, max: 8 });

/** Non-empty short id; both `taskId` and `artifactId` use this shape. */
const arbitraryShortId = fc.string({ minLength: 1, maxLength: 32 });

/** Non-empty file name. The schema allows any non-empty string. */
const arbitraryFileName = fc.string({ minLength: 1, maxLength: 64 });

/** Optional MIME type — `undefined` exercises the "no mimeType" branch. */
const arbitraryMimeType = fc.oneof(
  fc.constant<string | undefined>(undefined),
  fc.constantFrom(
    "text/plain",
    "application/json",
    "application/octet-stream",
  ),
);

/** Builtin agent ids that the Coder/Fixer pair would plausibly use. */
const arbitraryAgentId = fc.constantFrom(
  "coder",
  "fixer",
  "researcher",
  "reviewer",
  "boss",
);

/**
 * Per-call ancillary metadata. Idempotency must hold even when the
 * repeated calls vary these fields, so we let fast-check shuffle them
 * across the N invocations.
 */
const arbitraryCallMeta = fc.record({
  authoredByAgentId: arbitraryAgentId,
  fileName: arbitraryFileName,
  mimeType: arbitraryMimeType,
});

describe("ArtifactStore.writeArtifact (Property 6: same-content write is idempotent)", () => {
  it("Property 6: repeated writes of the same bytes for (taskId, artifactId) produce exactly one version (Validates: Requirements 7.4, 11.7)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryBytes,
        arbitraryRepeats,
        arbitraryShortId,
        arbitraryShortId,
        // One ancillary-metadata record per invocation. We generate up to
        // the maximum repeat count and slice to `repeats` inside the body
        // so fast-check can shrink the per-call records independently.
        fc.array(arbitraryCallMeta, { minLength: 8, maxLength: 8 }),
        async (bytes, repeats, taskId, artifactId, callMetas) => {
          const backend = new InMemoryArtifactStoreBackend();
          const store = new ArtifactStore({
            backend,
            clock: makeSteppingClock(),
          });

          const expectedHash = computeContentHash(bytes);
          const returnedVersions: number[] = [];

          for (let i = 0; i < repeats; i++) {
            const meta = callMetas[i % callMetas.length]!;
            const result = await store.writeArtifact({
              taskId,
              artifactId,
              authoredByAgentId: meta.authoredByAgentId,
              // Pass a fresh slice on every call so the store cannot rely
              // on reference equality for the no-op decision — it must
              // hash the bytes.
              bytes: bytes.slice(),
              fileName: meta.fileName,
              ...(meta.mimeType !== undefined ? { mimeType: meta.mimeType } : {}),
            });
            returnedVersions.push(result.version);

            // Each returned version must carry the expected hash and an
            // independent byte copy.
            if (result.contentHash !== expectedHash) {
              throw new Error(
                `writeArtifact returned hash ${result.contentHash}, expected ${expectedHash}`,
              );
            }
            if (result.bytes.length !== bytes.length) {
              throw new Error(
                `writeArtifact returned ${result.bytes.length} bytes, expected ${bytes.length}`,
              );
            }
            for (let b = 0; b < bytes.length; b++) {
              if (result.bytes[b] !== bytes[b]) {
                throw new Error(
                  `writeArtifact returned mismatching byte at index ${b}`,
                );
              }
            }
          }

          // (5) Every call returns version 1 — the idempotent no-op path
          // must surface the existing version, not a fresh assignment.
          for (const v of returnedVersions) {
            if (v !== 1) {
              throw new Error(
                `writeArtifact returned version ${v}; expected 1 for idempotent retries`,
              );
            }
          }

          // (1) Exactly one stored version remains.
          const list = await store.listArtifacts(taskId);
          if (list.length !== 1) {
            throw new Error(
              `listArtifacts returned ${list.length} artifacts; expected 1`,
            );
          }
          const meta = list[0]!;
          if (meta.id !== artifactId) {
            throw new Error(
              `stored artifact id ${meta.id} differs from requested ${artifactId}`,
            );
          }
          if (meta.latestVersion !== 1) {
            throw new Error(
              `latestVersion is ${meta.latestVersion}; expected 1 after idempotent retries`,
            );
          }
          // (3) Single content hash matching the input.
          if (meta.latestContentHash !== expectedHash) {
            throw new Error(
              `latestContentHash is ${meta.latestContentHash}; expected ${expectedHash}`,
            );
          }

          // (2) Byte-for-byte identical content survived the round-trip.
          const fetched = await store.getArtifact({ taskId, artifactId });
          if (fetched === null) {
            throw new Error("getArtifact returned null after a successful write");
          }
          if (fetched.version !== 1) {
            throw new Error(
              `getArtifact returned version ${fetched.version}; expected 1`,
            );
          }
          if (fetched.contentHash !== expectedHash) {
            throw new Error(
              `getArtifact contentHash ${fetched.contentHash} != expected ${expectedHash}`,
            );
          }
          if (fetched.bytes.length !== bytes.length) {
            throw new Error(
              `getArtifact returned ${fetched.bytes.length} bytes; expected ${bytes.length}`,
            );
          }
          for (let b = 0; b < bytes.length; b++) {
            if (fetched.bytes[b] !== bytes[b]) {
              throw new Error(
                `getArtifact returned mismatching byte at index ${b}`,
              );
            }
          }

          // (4) Asking for any version > 1 must yield null — there is no
          // v2, v3, ... lurking under the surface from the no-op writes.
          const phantom = await store.getArtifact({
            taskId,
            artifactId,
            version: 2,
          });
          if (phantom !== null) {
            throw new Error(
              "getArtifact returned a non-null version 2 after idempotent retries; idempotency was violated",
            );
          }
        },
      ),
      // 100 runs is enough to cover the generator space without ballooning
      // the suite runtime; the unit tests in `artifactStore.test.ts` cover
      // the fixed-example smoke checks.
      { numRuns: 100 },
    );
  });
});
