/**
 * Unit tests for {@link ArtifactStore} read paths (task 10.2).
 *
 * Covers the three methods added in this task:
 *
 *   • `getArtifact` — returns the latest version when `version` is
 *     omitted, returns the explicit version when supplied, returns
 *     `null` for missing artifacts and missing versions.
 *   • `listArtifacts` — returns metadata only (id, taskId, fileName,
 *     latestVersion, latestContentHash, updatedAt) and never the raw
 *     byte payloads.
 *   • `getDiff` — produces a unified-diff `DiffPatch` between two
 *     explicit versions, validates against the schema, and returns
 *     `null` when either version is missing.
 *
 * The write-path semantics (idempotency, version assignment, atomicity)
 * are exercised in passing here because read tests need data to read,
 * but the property test in task 10.4 owns the canonical idempotency
 * coverage. This file deliberately avoids re-testing it.
 *
 * Validates: Requirements 11.4, 11.5, 11.7.
 */

import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { diffPatchSchema } from "@ai-agent-orchestrator/validation";

import {
  ArtifactStore,
  InMemoryArtifactStoreBackend,
  computeContentHash,
  StagingWorkspaceManager,
} from "./index.js";
import type { Clock } from "./artifactStore.js";

const TASK_ID = "task-artifacts-1";
const ARTIFACT_ID = "artifact-001";
const AGENT_ID = "coder";

/**
 * Deterministic clock used to give every write a distinct, ordered
 * `createdAt` / `updatedAt` timestamp. The tests then assert on listing
 * order without relying on real wall-clock timing.
 */
function fixedClock(initialIso: string): Clock & { advance(): void } {
  let current = new Date(initialIso).getTime();
  return {
    now() {
      return new Date(current);
    },
    advance() {
      current += 1_000;
    },
  };
}

function makeStore(clockIso = "2024-01-01T00:00:00.000Z") {
  const backend = new InMemoryArtifactStoreBackend();
  const clock = fixedClock(clockIso);
  const store = new ArtifactStore({
    backend,
    clock,
    generateArtifactId: () => "generated-id",
  });
  return { backend, clock, store };
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("ArtifactStore.getArtifact", () => {
  it("returns the latest version when `version` is omitted", async () => {
    const { store, clock } = makeStore();

    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      authoredByAgentId: AGENT_ID,
      bytes: utf8("hello\n"),
      fileName: "greeting.txt",
    });

    clock.advance();
    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      authoredByAgentId: AGENT_ID,
      bytes: utf8("hello world\n"),
      fileName: "greeting.txt",
    });

    const got = await store.getArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
    });

    expect(got).not.toBeNull();
    expect(got?.id).toBe(ARTIFACT_ID);
    expect(got?.taskId).toBe(TASK_ID);
    expect(got?.fileName).toBe("greeting.txt");
    expect(got?.version).toBe(2);
    expect(new TextDecoder().decode(got?.bytes)).toBe("hello world\n");
    expect(got?.contentHash).toBe(computeContentHash(utf8("hello world\n")));
  });

  it("returns the requested explicit version", async () => {
    const { store, clock } = makeStore();

    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      authoredByAgentId: AGENT_ID,
      bytes: utf8("v1\n"),
      fileName: "doc.txt",
    });
    clock.advance();
    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      authoredByAgentId: AGENT_ID,
      bytes: utf8("v2\n"),
      fileName: "doc.txt",
    });
    clock.advance();
    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      authoredByAgentId: AGENT_ID,
      bytes: utf8("v3\n"),
      fileName: "doc.txt",
    });

    const v1 = await store.getArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      version: 1,
    });
    expect(v1?.version).toBe(1);
    expect(new TextDecoder().decode(v1?.bytes)).toBe("v1\n");

    const v2 = await store.getArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      version: 2,
    });
    expect(v2?.version).toBe(2);
    expect(new TextDecoder().decode(v2?.bytes)).toBe("v2\n");
  });

  it("returns null when the requested version does not exist", async () => {
    const { store } = makeStore();

    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      authoredByAgentId: AGENT_ID,
      bytes: utf8("only v1\n"),
      fileName: "doc.txt",
    });

    const missing = await store.getArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      version: 5,
    });
    expect(missing).toBeNull();
  });

  it("returns null when the artifact does not exist at all", async () => {
    const { store } = makeStore();
    const got = await store.getArtifact({
      taskId: TASK_ID,
      artifactId: "does-not-exist",
    });
    expect(got).toBeNull();
  });

  it("returns a defensive copy of bytes so callers cannot mutate stored state", async () => {
    const { store } = makeStore();

    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      authoredByAgentId: AGENT_ID,
      bytes: utf8("immutable\n"),
      fileName: "doc.txt",
    });

    const first = await store.getArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
    });
    // Mutate the returned bytes; the store must not be affected.
    first!.bytes[0] = 0xff;

    const second = await store.getArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
    });
    expect(new TextDecoder().decode(second!.bytes)).toBe("immutable\n");
  });
});

describe("ArtifactStore.listArtifacts", () => {
  it("returns metadata for every artifact under the task without byte payloads", async () => {
    const { store, clock } = makeStore();

    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: "art-A",
      authoredByAgentId: AGENT_ID,
      bytes: utf8("alpha\n"),
      fileName: "alpha.txt",
      mimeType: "text/plain",
    });
    clock.advance();
    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: "art-A",
      authoredByAgentId: AGENT_ID,
      bytes: utf8("alpha v2\n"),
      fileName: "alpha.txt",
      mimeType: "text/plain",
    });
    clock.advance();
    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: "art-B",
      authoredByAgentId: AGENT_ID,
      bytes: utf8("beta\n"),
      fileName: "beta.txt",
    });

    const list = await store.listArtifacts(TASK_ID);
    expect(list).toHaveLength(2);

    // Listing entries must expose only the metadata projection. Asserting
    // on the exact key set guards against accidental byte leakage.
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual([
        "fileName",
        "id",
        "latestContentHash",
        "latestVersion",
        "taskId",
        "updatedAt",
      ]);
      expect("bytes" in entry).toBe(false);
    }

    const byId = new Map(list.map((m) => [m.id, m] as const));
    expect(byId.get("art-A")?.latestVersion).toBe(2);
    expect(byId.get("art-A")?.latestContentHash).toBe(
      computeContentHash(utf8("alpha v2\n")),
    );
    expect(byId.get("art-A")?.fileName).toBe("alpha.txt");
    expect(byId.get("art-B")?.latestVersion).toBe(1);
    expect(byId.get("art-B")?.latestContentHash).toBe(
      computeContentHash(utf8("beta\n")),
    );
  });

  it("scopes results to the requested task", async () => {
    const { store, clock } = makeStore();

    await store.writeArtifact({
      taskId: "task-one",
      artifactId: "art-A",
      authoredByAgentId: AGENT_ID,
      bytes: utf8("one\n"),
      fileName: "one.txt",
    });
    clock.advance();
    await store.writeArtifact({
      taskId: "task-two",
      artifactId: "art-B",
      authoredByAgentId: AGENT_ID,
      bytes: utf8("two\n"),
      fileName: "two.txt",
    });

    const oneList = await store.listArtifacts("task-one");
    expect(oneList.map((m) => m.id)).toEqual(["art-A"]);
    const twoList = await store.listArtifacts("task-two");
    expect(twoList.map((m) => m.id)).toEqual(["art-B"]);
  });

  it("returns an empty list for a task with no artifacts", async () => {
    const { store } = makeStore();
    expect(await store.listArtifacts("empty-task")).toEqual([]);
  });
});

describe("ArtifactStore.getDiff", () => {
  it("produces a unified diff between two explicit versions", async () => {
    const { store, clock } = makeStore();

    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      authoredByAgentId: AGENT_ID,
      bytes: utf8("line one\nline two\nline three\n"),
      fileName: "doc.txt",
    });
    clock.advance();
    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      authoredByAgentId: AGENT_ID,
      bytes: utf8("line one\nline TWO\nline three\nline four\n"),
      fileName: "doc.txt",
    });

    const diff = await store.getDiff({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      fromVersion: 1,
      toVersion: 2,
    });

    expect(diff).not.toBeNull();
    expect(diff!.artifactId).toBe(ARTIFACT_ID);
    expect(diff!.fromVersion).toBe(1);
    expect(diff!.toVersion).toBe(2);

    // Headers are present and identify the labelled versions.
    expect(diff!.patchText).toContain("--- doc.txt@v1");
    expect(diff!.patchText).toContain("+++ doc.txt@v2");
    // Content changes are reflected with `-` / `+` markers.
    expect(diff!.patchText).toContain("-line two");
    expect(diff!.patchText).toContain("+line TWO");
    expect(diff!.patchText).toContain("+line four");

    // The result satisfies the public DiffPatch schema — important for
    // any caller that re-validates payloads at the network boundary.
    expect(diffPatchSchema.safeParse(diff).success).toBe(true);
  });

  it("returns null when the artifact is missing", async () => {
    const { store } = makeStore();
    const diff = await store.getDiff({
      taskId: TASK_ID,
      artifactId: "missing",
      fromVersion: 1,
      toVersion: 2,
    });
    expect(diff).toBeNull();
  });

  it("returns null when one of the versions is missing", async () => {
    const { store } = makeStore();

    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      authoredByAgentId: AGENT_ID,
      bytes: utf8("only v1\n"),
      fileName: "doc.txt",
    });

    const diff = await store.getDiff({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      fromVersion: 1,
      toVersion: 5,
    });
    expect(diff).toBeNull();
  });

  it("rejects a request where fromVersion equals toVersion", async () => {
    const { store } = makeStore();

    await store.writeArtifact({
      taskId: TASK_ID,
      artifactId: ARTIFACT_ID,
      authoredByAgentId: AGENT_ID,
      bytes: utf8("v1\n"),
      fileName: "doc.txt",
    });

    await expect(
      store.getDiff({
        taskId: TASK_ID,
        artifactId: ARTIFACT_ID,
        fromVersion: 1,
        toVersion: 1,
      }),
    ).rejects.toThrow(/must differ/);
  });

  it("rejects non-positive integer versions", async () => {
    const { store } = makeStore();
    await expect(
      store.getDiff({
        taskId: TASK_ID,
        artifactId: ARTIFACT_ID,
        fromVersion: 0,
        toVersion: 1,
      }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      store.getDiff({
        taskId: TASK_ID,
        artifactId: ARTIFACT_ID,
        fromVersion: 1,
        // @ts-expect-error: deliberately invalid input.
        toVersion: 1.5,
      }),
    ).rejects.toThrow(/positive integer/);
  });
});

const TEST_PROJECT_ROOT = path.resolve(process.cwd(), ".karo", "test-run-artifact-store-staging");

describe("ArtifactStore with Staging Workspace integration", () => {
  const staging = new StagingWorkspaceManager(TEST_PROJECT_ROOT);

  afterAll(async () => {
    // Cleanup staging test files.
    await fs.rm(TEST_PROJECT_ROOT, { recursive: true, force: true });
  });

  it("writes artifact to memory store AND to disk staging when staging is supplied", async () => {
    const backend = new InMemoryArtifactStoreBackend();
    const store = new ArtifactStore({
      backend,
      generateArtifactId: () => "staged-art",
      staging,
    });

    const taskId = "task-staged-1";
    const fileName = "src/components/Button.tsx";
    const content = utf8("export const Button = () => <button>Click</button>;");

    await store.writeArtifact({
      taskId,
      authoredByAgentId: AGENT_ID,
      bytes: content,
      fileName,
    });

    // 1. Verify it was written to the backend memory store.
    const got = await store.getArtifact({
      taskId,
      artifactId: "staged-art",
    });
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got?.bytes)).toBe("export const Button = () => <button>Click</button>;");

    // 2. Verify it is physically present in the staging workspace on disk.
    const resolvedPath = staging.resolveArtifactPath(taskId, fileName);
    const diskBytes = await fs.readFile(resolvedPath);
    expect(new TextDecoder().decode(diskBytes)).toBe("export const Button = () => <button>Click</button>;");
  });

  it("functions correctly without a staging manager (optional dependency)", async () => {
    const backend = new InMemoryArtifactStoreBackend();
    const store = new ArtifactStore({
      backend,
      generateArtifactId: () => "non-staged-art",
    });

    const taskId = "task-non-staged-1";
    const fileName = "test.txt";
    const content = utf8("no staging");

    await store.writeArtifact({
      taskId,
      authoredByAgentId: AGENT_ID,
      bytes: content,
      fileName,
    });

    const got = await store.getArtifact({
      taskId,
      artifactId: "non-staged-art",
    });
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got?.bytes)).toBe("no staging");
  });

  it("propagates errors safely if staging write fails", async () => {
    const backend = new InMemoryArtifactStoreBackend();
    const store = new ArtifactStore({
      backend,
      generateArtifactId: () => "fail-art",
      staging,
    });

    const taskId = "task-fail-1";
    // Passing a path-traversal filename to force a failure inside resolveArtifactPath
    const fileName = "../evil.ts";
    const content = utf8("evil content");

    await expect(
      store.writeArtifact({
        taskId,
        authoredByAgentId: AGENT_ID,
        bytes: content,
        fileName,
      }),
    ).rejects.toThrow("Path traversal detected");
  });
});
