/**
 * Unit tests for the File_Artifact viewer controller (task 10.3).
 *
 * Sources:
 *   • design.md → "Artifact Store" → "Rules" ("Diff generation happens
 *     only on explicit request").
 *   • design.md → "Trace Event Bus" → "Rules" ("Diff must not open
 *     automatically. Diff opens only after explicit user selection of
 *     File_Artifact").
 *   • requirements.md → 11.4, 11.5, 11.7.
 *
 * Validates: Requirements 11.4, 11.5, 11.7.
 *
 * Coverage matrix
 * ---------------
 *
 *   1. `listArtifacts` excludes byte payloads (Requirement 11.7,
 *      property-style structural assertion at the gateway boundary).
 *   2. Selecting an artifact loads its content via `getArtifact` and
 *      does NOT call `getDiff` — neither directly nor indirectly
 *      (Requirement 11.5 / Property 11). The same invariant is
 *      asserted across `selectArtifact`, `selectVersion`, and
 *      `refresh()` to cover every non-diff entry point.
 *   3. `requestDiff(from, to)` is the sole entry point that calls
 *      `gateway.getDiff`. It does so exactly once per call with the
 *      chosen versions, on the active artifact.
 *   4. Error surfacing: gateway rejections are surfaced through the
 *      `listStatus` / `content` / `diff` slots and never escape as
 *      thrown promises into the caller.
 *   5. Selection-change resets diff state and exits compare mode so a
 *      future render cannot show a stale diff against a different
 *      artifact (defends Requirement 11.5 against UI regressions).
 *
 * Structural coverage of Property 11 ("diff is never displayed
 * automatically") at the controller layer: every test that does not
 * call `requestDiff(...)` asserts `gateway.getDiff` saw zero calls. The
 * full property-based test against the backend Artifact Store lives in
 * `apps/backend/src/artifacts/diffNoAuto.property.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createArtifactViewerController,
  type ArtifactViewerController,
} from "./artifactViewerController.js";
import type {
  ArtifactGateway,
  DiffPatch,
  FileArtifactContent,
  FileArtifactMetadata,
} from "../../ports/artifacts.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TASK_ID = "task-viewer-1";

function metadata(
  id: string,
  fileName: string,
  latestVersion = 1,
  updatedAt = "2024-01-01T00:00:00.000Z",
): FileArtifactMetadata {
  return {
    id,
    taskId: TASK_ID,
    fileName,
    latestVersion,
    latestContentHash: `${id}-hash-v${latestVersion}`,
    updatedAt,
  };
}

function content(
  id: string,
  fileName: string,
  version: number,
  body: string,
): FileArtifactContent {
  return {
    id,
    taskId: TASK_ID,
    fileName,
    version,
    bytes: new TextEncoder().encode(body),
    contentHash: `${id}-hash-v${version}`,
  };
}

function diffPatch(
  artifactId: string,
  from: number,
  to: number,
  patchText = `--- ${artifactId}@v${from}\n+++ ${artifactId}@v${to}\n`,
): DiffPatch {
  return { artifactId, fromVersion: from, toVersion: to, patchText };
}

/**
 * Counting gateway: tracks call counts per method so structural
 * "no-other-method-called-getDiff" assertions are concise. All
 * methods support per-call programming via the public arrays.
 */
class CountingGateway implements ArtifactGateway {
  public listCalls = 0;
  public getCalls: Array<{
    taskId: string;
    artifactId: string;
    version?: number;
  }> = [];
  public diffCalls: Array<{
    taskId: string;
    artifactId: string;
    fromVersion: number;
    toVersion: number;
  }> = [];

  /** Programmable list of return values for `listArtifacts`. */
  public listResults: ReadonlyArray<readonly FileArtifactMetadata[]> = [[]];
  public listError: Error | null = null;

  /** Map of `(artifactId|version)` → content. Missing keys yield `null`. */
  public contentMap = new Map<string, FileArtifactContent>();
  public getError: Error | null = null;

  /** Map of `(artifactId|from|to)` → diff. Missing keys yield `null`. */
  public diffMap = new Map<string, DiffPatch>();
  public diffError: Error | null = null;

  async listArtifacts(_taskId: string) {
    this.listCalls += 1;
    if (this.listError) throw this.listError;
    const idx = Math.min(this.listCalls - 1, this.listResults.length - 1);
    const batch = this.listResults[idx] ?? [];
    return batch.slice();
  }

  async getArtifact(input: {
    taskId: string;
    artifactId: string;
    version?: number;
  }) {
    this.getCalls.push({ ...input });
    if (this.getError) throw this.getError;
    const key = contentKey(input.artifactId, input.version);
    return this.contentMap.get(key) ?? null;
  }

  async getDiff(input: {
    taskId: string;
    artifactId: string;
    fromVersion: number;
    toVersion: number;
  }) {
    this.diffCalls.push({ ...input });
    if (this.diffError) throw this.diffError;
    const key = `${input.artifactId}|${input.fromVersion}|${input.toVersion}`;
    return this.diffMap.get(key) ?? null;
  }
}

function contentKey(artifactId: string, version: number | undefined): string {
  return `${artifactId}|${version ?? "latest"}`;
}

function makeController(gateway: ArtifactGateway): ArtifactViewerController {
  return createArtifactViewerController({ gateway, taskId: TASK_ID });
}

// ---------------------------------------------------------------------------
// Listing — metadata only (Requirement 11.7)
// ---------------------------------------------------------------------------

describe("ArtifactViewerController — listArtifacts excludes byte payloads", () => {
  it(
    "exposes only metadata fields after refresh (Validates: Requirements 11.7)",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [[metadata("a-1", "greeting.txt", 2)]];

      const controller = makeController(gateway);
      await controller.refresh();

      const state = controller.getState();
      expect(state.listStatus).toEqual({ status: "loaded" });
      expect(state.artifacts).toHaveLength(1);
      const entry = state.artifacts[0]!;
      // Metadata-only by construction. We re-state the surface here as
      // a regression guard so a future change adding a `bytes` or
      // `payload` field breaks this test loudly.
      expect(Object.keys(entry).sort()).toEqual([
        "fileName",
        "id",
        "latestContentHash",
        "latestVersion",
        "taskId",
        "updatedAt",
      ]);
      // Critical invariant: refresh did not trigger any diff or content
      // fetch as a side effect.
      expect(gateway.getCalls).toEqual([]);
      expect(gateway.diffCalls).toEqual([]);
    },
  );

  it(
    "surfaces a list error without crashing the controller",
    async () => {
      const gateway = new CountingGateway();
      gateway.listError = new Error("network down");

      const controller = makeController(gateway);
      await controller.refresh();

      expect(controller.getState().listStatus).toEqual({
        status: "error",
        message: "network down",
      });
      expect(gateway.diffCalls).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Selection — never auto-opens a diff (Requirement 11.5 / Property 11)
// ---------------------------------------------------------------------------

describe("ArtifactViewerController — selecting an artifact does not call getDiff", () => {
  it(
    "selectArtifact loads content via getArtifact and never calls getDiff " +
      "(Validates: Requirements 11.5)",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [[metadata("a-1", "greeting.txt", 3)]];
      gateway.contentMap.set(
        contentKey("a-1", 3),
        content("a-1", "greeting.txt", 3, "hello v3\n"),
      );

      const controller = makeController(gateway);
      await controller.refresh();
      await controller.selectArtifact("a-1");

      const state = controller.getState();
      expect(state.selectedArtifactId).toBe("a-1");
      expect(state.selectedVersion).toBe(3);
      expect(state.content.status).toBe("loaded");

      // The single call to getArtifact targets the latest version.
      expect(gateway.getCalls).toEqual([
        { taskId: TASK_ID, artifactId: "a-1", version: 3 },
      ]);

      // CRITICAL: no diff request on selection (Property 11).
      expect(gateway.diffCalls).toEqual([]);
      expect(state.diff).toEqual({ status: "idle" });
      expect(state.comparing).toBe(false);
    },
  );

  it(
    "selectVersion loads the requested version and never calls getDiff",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [[metadata("a-1", "greeting.txt", 5)]];
      gateway.contentMap.set(
        contentKey("a-1", 5),
        content("a-1", "greeting.txt", 5, "hello v5\n"),
      );
      gateway.contentMap.set(
        contentKey("a-1", 2),
        content("a-1", "greeting.txt", 2, "hello v2\n"),
      );

      const controller = makeController(gateway);
      await controller.refresh();
      await controller.selectArtifact("a-1");
      await controller.selectVersion(2);

      const state = controller.getState();
      expect(state.selectedVersion).toBe(2);
      expect(
        state.content.status === "loaded" ? state.content.content.version : -1,
      ).toBe(2);

      // Two getArtifact calls (latest then v2). Zero getDiff calls.
      expect(gateway.getCalls).toHaveLength(2);
      expect(gateway.diffCalls).toEqual([]);
    },
  );

  it(
    "refresh after selection does not call getDiff and preserves a still-present selection",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [
        [metadata("a-1", "greeting.txt", 1)],
        [
          metadata("a-1", "greeting.txt", 2, "2024-01-02T00:00:00.000Z"),
          metadata("a-2", "second.txt", 1, "2024-01-02T00:00:00.000Z"),
        ],
      ];
      gateway.contentMap.set(
        contentKey("a-1", 1),
        content("a-1", "greeting.txt", 1, "hello v1\n"),
      );

      const controller = makeController(gateway);
      await controller.refresh();
      await controller.selectArtifact("a-1");

      const beforeDiffCalls = gateway.diffCalls.length;
      await controller.refresh();
      const afterDiffCalls = gateway.diffCalls.length;

      expect(afterDiffCalls).toBe(beforeDiffCalls);
      expect(afterDiffCalls).toBe(0);
      expect(controller.getState().selectedArtifactId).toBe("a-1");
    },
  );

  it(
    "refresh that drops the selected artifact clears selection and stays clear of getDiff",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [
        [metadata("a-1", "greeting.txt", 1)],
        [metadata("a-2", "second.txt", 1)],
      ];
      gateway.contentMap.set(
        contentKey("a-1", 1),
        content("a-1", "greeting.txt", 1, "hello\n"),
      );

      const controller = makeController(gateway);
      await controller.refresh();
      await controller.selectArtifact("a-1");
      await controller.refresh();

      const state = controller.getState();
      expect(state.selectedArtifactId).toBeNull();
      expect(state.selectedVersion).toBeNull();
      expect(state.content).toEqual({ status: "idle" });
      expect(state.diff).toEqual({ status: "idle" });
      expect(state.comparing).toBe(false);
      expect(gateway.diffCalls).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// requestDiff — single explicit entry point (Requirement 11.5)
// ---------------------------------------------------------------------------

describe("ArtifactViewerController — requestDiff", () => {
  it(
    "calls gateway.getDiff exactly once with the chosen versions and surfaces the result " +
      "(Validates: Requirements 11.4, 11.5)",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [[metadata("a-1", "greeting.txt", 3)]];
      gateway.contentMap.set(
        contentKey("a-1", 3),
        content("a-1", "greeting.txt", 3, "hello v3\n"),
      );
      gateway.diffMap.set(
        "a-1|1|3",
        diffPatch("a-1", 1, 3, "--- a-1@v1\n+++ a-1@v3\n@@ ..."),
      );

      const controller = makeController(gateway);
      await controller.refresh();
      await controller.selectArtifact("a-1");

      // Pre-condition: zero diff calls so far.
      expect(gateway.diffCalls).toEqual([]);

      await controller.requestDiff(1, 3);

      // EXACTLY ONE diff call.
      expect(gateway.diffCalls).toHaveLength(1);
      expect(gateway.diffCalls[0]).toEqual({
        taskId: TASK_ID,
        artifactId: "a-1",
        fromVersion: 1,
        toVersion: 3,
      });

      const state = controller.getState();
      expect(state.comparing).toBe(true);
      expect(state.diff.status).toBe("ready");
      if (state.diff.status === "ready") {
        expect(state.diff.diff.fromVersion).toBe(1);
        expect(state.diff.diff.toVersion).toBe(3);
        expect(state.diff.diff.patchText).toContain("a-1@v1");
      }
    },
  );

  it(
    "throws synchronously when no artifact is selected",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [[metadata("a-1", "greeting.txt", 2)]];
      const controller = makeController(gateway);
      await controller.refresh();

      await expect(controller.requestDiff(1, 2)).rejects.toThrow(
        /no artifact selected/i,
      );
      expect(gateway.diffCalls).toEqual([]);
    },
  );

  it(
    "rejects identical versions and never reaches gateway.getDiff",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [[metadata("a-1", "greeting.txt", 2)]];
      gateway.contentMap.set(
        contentKey("a-1", 2),
        content("a-1", "greeting.txt", 2, "hi\n"),
      );

      const controller = makeController(gateway);
      await controller.refresh();
      await controller.selectArtifact("a-1");

      await expect(controller.requestDiff(2, 2)).rejects.toThrow(
        /must differ/i,
      );
      expect(gateway.diffCalls).toEqual([]);
    },
  );

  it(
    "surfaces a getDiff error in the diff slot without throwing into the caller",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [[metadata("a-1", "greeting.txt", 2)]];
      gateway.contentMap.set(
        contentKey("a-1", 2),
        content("a-1", "greeting.txt", 2, "hi\n"),
      );
      gateway.diffError = new Error("diff backend down");

      const controller = makeController(gateway);
      await controller.refresh();
      await controller.selectArtifact("a-1");

      // Should resolve, not reject.
      await controller.requestDiff(1, 2);

      const state = controller.getState();
      expect(state.diff).toEqual({
        status: "error",
        message: "diff backend down",
      });
      expect(state.comparing).toBe(true);
      expect(gateway.diffCalls).toHaveLength(1);
    },
  );

  it(
    "selecting a different artifact after requestDiff resets compare mode",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [
        [
          metadata("a-1", "greeting.txt", 2),
          metadata("a-2", "second.txt", 1),
        ],
      ];
      gateway.contentMap.set(
        contentKey("a-1", 2),
        content("a-1", "greeting.txt", 2, "hello v2\n"),
      );
      gateway.contentMap.set(
        contentKey("a-2", 1),
        content("a-2", "second.txt", 1, "second v1\n"),
      );
      gateway.diffMap.set("a-1|1|2", diffPatch("a-1", 1, 2));

      const controller = makeController(gateway);
      await controller.refresh();
      await controller.selectArtifact("a-1");
      await controller.requestDiff(1, 2);

      expect(controller.getState().comparing).toBe(true);
      const diffCallsBefore = gateway.diffCalls.length;

      await controller.selectArtifact("a-2");

      const state = controller.getState();
      expect(state.selectedArtifactId).toBe("a-2");
      expect(state.comparing).toBe(false);
      expect(state.diff).toEqual({ status: "idle" });
      // Selection MUST NOT have triggered another getDiff call.
      expect(gateway.diffCalls).toHaveLength(diffCallsBefore);
    },
  );
});

// ---------------------------------------------------------------------------
// Error surfacing on getArtifact
// ---------------------------------------------------------------------------

describe("ArtifactViewerController — content error surfacing", () => {
  it(
    "surfaces a getArtifact rejection in the content slot",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [[metadata("a-1", "greeting.txt", 1)]];
      gateway.getError = new Error("storage offline");

      const controller = makeController(gateway);
      await controller.refresh();
      await controller.selectArtifact("a-1");

      const state = controller.getState();
      expect(state.content).toEqual({
        status: "error",
        message: "storage offline",
      });
      expect(state.diff).toEqual({ status: "idle" });
      expect(gateway.diffCalls).toEqual([]);
    },
  );

  it(
    "treats a null content response as a not-found error",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [[metadata("a-1", "greeting.txt", 2)]];
      // No content registered for v2 → gateway returns null.

      const controller = makeController(gateway);
      await controller.refresh();
      await controller.selectArtifact("a-1");

      const state = controller.getState();
      expect(state.content.status).toBe("error");
      if (state.content.status === "error") {
        expect(state.content.message).toMatch(/not found/i);
      }
      expect(gateway.diffCalls).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Subscriber notifications
// ---------------------------------------------------------------------------

describe("ArtifactViewerController — subscribers", () => {
  it(
    "notifies subscribers on every state transition and unsubscribes cleanly",
    async () => {
      const gateway = new CountingGateway();
      gateway.listResults = [[metadata("a-1", "greeting.txt", 1)]];
      gateway.contentMap.set(
        contentKey("a-1", 1),
        content("a-1", "greeting.txt", 1, "hello\n"),
      );

      const controller = makeController(gateway);
      const listener = vi.fn();
      const unsubscribe = controller.subscribe(listener);

      await controller.refresh();
      await controller.selectArtifact("a-1");

      // refresh: loading + loaded; selectArtifact: loading + loaded = 4 emits.
      expect(listener).toHaveBeenCalledTimes(4);

      unsubscribe();
      await controller.refresh();
      // No further notifications after unsubscribe.
      expect(listener).toHaveBeenCalledTimes(4);
      // Still no diff calls.
      expect(gateway.diffCalls).toEqual([]);
    },
  );
});
