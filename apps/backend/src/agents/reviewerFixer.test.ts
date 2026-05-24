/**
 * Unit tests for the Reviewer and Fixer Builtin_Agents (task 14.3).
 *
 * Coverage targets from the task brief:
 *
 *   • Reviewer no-defects path → handoff to Boss.
 *   • Reviewer defects-found path → handoff to Fixer.
 *   • Fixer creates a new artifact version atomically (via stubbed
 *     model returning fixed content).
 *
 * Plus the trace-integration assertions called out by the brief
 * ("emit appropriate `tool_call` / `artifact_change` / `status`
 * trace events"): every test inspects the published trace events to
 * confirm the agent emitted the documented sequence.
 *
 * Validates: Requirements 7.1, 7.5, 7.6, 7.7.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  ArtifactStore,
  InMemoryArtifactStoreBackend,
  type ArtifactStoreInterface,
} from "../artifacts/index.js";
import {
  InMemoryMessageHistoryStore,
  type AgentDefinition,
  type ModelAdapter,
  type ModelInvokeOptions,
  type SecretRef,
  type TaskContext,
} from "../agentRuntime/index.js";
import {
  InMemoryTraceEventStoreBackend,
  TraceEventBus,
  type TraceEvent,
  type TraceEventBusInterface,
} from "../trace/index.js";
import type { AgentMessage } from "@ai-agent-orchestrator/validation";
import type { ModelRef } from "@ai-agent-orchestrator/shared-core";

import { FixerAgent } from "./fixer.js";
import { ReviewerAgent, ConsentRequiredError } from "./reviewer.js";
import type {
  Defect,
  DefectsFoundPayload,
  NoDefectsPayload,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASK_ID = "task-14-3";
const REVIEWER_ID = "agent-reviewer";
const FIXER_ID = "agent-fixer";
const BOSS_ID = "agent-boss";
const CODER_ID = "agent-coder";

const ISO_AT = "2024-06-15T12:00:00.000Z";

const defaultModel: ModelRef = {
  provider: "openai",
  modelId: "gpt-4o-mini",
  source: "user-api-key",
};

const apiKey: SecretRef = {
  provider: "openai",
  scope: { kind: "local", deviceId: "device-1" },
  expiresAt: "2099-12-31T23:59:59.999Z",
};

const taskContext: TaskContext = {
  id: TASK_ID,
  defaultModel,
};

const reviewerAgent: AgentDefinition = {
  id: REVIEWER_ID,
  name: "Reviewer",
  systemPrompt: "Review the artifact and return defects.",
  allowedTools: ["web_search", "file_read", "artifact_diff"],
};

const fixerAgent: AgentDefinition = {
  id: FIXER_ID,
  name: "Fixer",
  systemPrompt: "Apply the supplied defects to the artifact.",
  allowedTools: ["web_search", "file_read", "file_write", "artifact_diff"],
};

const incomingHandoff: AgentMessage = {
  taskId: TASK_ID,
  sender: CODER_ID,
  recipient: REVIEWER_ID,
  type: "handoff",
  payload: { kind: "text", text: "Please review v1." },
  timestamp: ISO_AT,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class StubModelAdapter implements ModelAdapter {
  public readonly calls: Array<{
    modelRef: ModelRef;
    messages: readonly AgentMessage[];
    options: ModelInvokeOptions;
  }> = [];

  public constructor(
    private readonly raw: unknown,
  ) {}

  public async invoke(
    modelRef: ModelRef,
    messages: readonly AgentMessage[],
    options: ModelInvokeOptions,
  ): Promise<{ raw: unknown }> {
    this.calls.push({ modelRef, messages, options });
    const value =
      typeof this.raw === "function"
        ? await (this.raw as () => Promise<unknown>)()
        : this.raw;
    return { raw: value };
  }
}

interface Harness {
  artifactStore: ArtifactStoreInterface;
  artifactBackend: InMemoryArtifactStoreBackend;
  historyStore: InMemoryMessageHistoryStore;
  traceBackend: InMemoryTraceEventStoreBackend;
  traceBus: TraceEventBusInterface;
  collected: TraceEvent[];
  artifactId: string;
}

async function buildHarness(initialContent: string): Promise<Harness> {
  const artifactBackend = new InMemoryArtifactStoreBackend();
  const artifactStore: ArtifactStoreInterface = new ArtifactStore({
    backend: artifactBackend,
  });

  const traceBackend = new InMemoryTraceEventStoreBackend();
  const traceBus: TraceEventBusInterface = new TraceEventBus({
    backend: traceBackend,
  });

  const collected: TraceEvent[] = [];
  // Drain the live subscription into `collected`. We start the
  // subscription *before* publishing so every event is captured.
  const iterator = traceBus.subscribe({ taskId: TASK_ID });
  void (async () => {
    for await (const event of iterator) {
      collected.push(event);
    }
  })();

  // Seed v1 of the artifact (the Coder's atomic write equivalent).
  const _v1 = await artifactStore.writeArtifact({
    taskId: TASK_ID,
    authoredByAgentId: CODER_ID,
    bytes: new TextEncoder().encode(initialContent),
    fileName: "main.ts",
    mimeType: "text/typescript",
  });

  return {
    artifactStore,
    artifactBackend,
    historyStore: new InMemoryMessageHistoryStore(),
    traceBackend,
    traceBus,
    collected,
    // Recover the generated artifact id by listing once.
    artifactId: (await artifactStore.listArtifacts(TASK_ID))[0]!.id,
  };
}

// Allow the trace iterator to flush queued events.
async function flushTraces(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Reviewer — no-defects path → handoff to Boss
// ---------------------------------------------------------------------------

describe("ReviewerAgent — no defects", () => {
  it("hands off to Boss when the model reports zero defects", async () => {
    const harness = await buildHarness("export const value = 1;\n");

    const adapter = new StubModelAdapter({
      kind: "noDefects",
      summary: "All good.",
    });

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
    });

    const result = await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(result.recipient).toBe(BOSS_ID);
    expect(result.outgoing.recipient).toBe(BOSS_ID);
    expect(result.outgoing.type).toBe("handoff");

    const verdict = result.verdict as NoDefectsPayload;
    expect(verdict.kind).toBe("noDefects");
    expect(verdict.artifactId).toBe(harness.artifactId);
    expect(verdict.artifactVersion).toBe(1);
    expect(verdict.summary).toBe("All good.");

    // Persisted before handoff (Requirement 10.6).
    const persisted = await harness.historyStore.list(TASK_ID);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.recipient).toBe(BOSS_ID);

    // Trace integration: started + tool_call(file_read) + finished.
    await flushTraces();
    const kinds = harness.collected.map((e) => e.record.kind);
    expect(kinds).toEqual(["status", "tool_call", "status"]);

    const startEvent = harness.collected[0]?.record;
    if (startEvent?.kind !== "status") throw new Error("expected status");
    expect(startEvent.status).toBe("started");

    const toolCall = harness.collected[1]?.record;
    if (toolCall?.kind !== "tool_call") throw new Error("expected tool_call");
    expect(toolCall.tool).toBe("file_read");

    const endEvent = harness.collected[2]?.record;
    if (endEvent?.kind !== "status") throw new Error("expected status");
    expect(endEvent.status).toBe("finished");
  });

  it("treats an empty defects array as no-defects (handoff to Boss)", async () => {
    const harness = await buildHarness("export const value = 1;\n");

    const adapter = new StubModelAdapter({ defects: [] });
    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
    });

    const result = await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(result.recipient).toBe(BOSS_ID);
    expect(result.verdict.kind).toBe("noDefects");
  });
});

// ---------------------------------------------------------------------------
// Reviewer — defects-found path → handoff to Fixer
// ---------------------------------------------------------------------------

describe("ReviewerAgent — defects found", () => {
  it("hands off to Fixer with a structured defects list", async () => {
    const harness = await buildHarness("export const value = 1;\n");

    const adapter = new StubModelAdapter({
      defects: [
        {
          id: "d-1",
          description: "Missing newline at end of file",
          severity: "low",
          location: "main.ts:1",
        },
        {
          description: "value should be a const tuple",
          severity: "medium",
        },
      ],
      summary: "Two findings.",
    });

    let nextId = 0;
    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      idGenerator: () => `gen-${++nextId}`,
    });

    const result = await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(result.recipient).toBe(FIXER_ID);
    expect(result.outgoing.recipient).toBe(FIXER_ID);

    const verdict = result.verdict as DefectsFoundPayload;
    expect(verdict.kind).toBe("defectsFound");
    expect(verdict.defects).toHaveLength(2);
    expect(verdict.defects[0]?.id).toBe("d-1");
    expect(verdict.defects[0]?.severity).toBe("low");
    expect(verdict.defects[0]?.location).toBe("main.ts:1");
    expect(verdict.defects[1]?.id).toBe("gen-1"); // generated id
    expect(verdict.defects[1]?.severity).toBe("medium");
    expect(verdict.summary).toBe("Two findings.");

    // The outgoing message is persisted to the history store.
    const persisted = await harness.historyStore.list(TASK_ID);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.recipient).toBe(FIXER_ID);
    if (persisted[0]?.payload.kind !== "json") {
      throw new Error("expected json payload");
    }
    expect((persisted[0].payload.value as DefectsFoundPayload).kind).toBe(
      "defectsFound",
    );

    // Trace integration: started + tool_call(file_read) + finished.
    await flushTraces();
    const kinds = harness.collected.map((e) => e.record.kind);
    expect(kinds).toEqual(["status", "tool_call", "status"]);
  });

  it("falls back to a critical defect when the model output is malformed", async () => {
    const harness = await buildHarness("ok\n");

    const adapter = new StubModelAdapter("not json at all");
    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      idGenerator: () => "gen-1",
    });

    const result = await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(result.recipient).toBe(FIXER_ID);
    const verdict = result.verdict as DefectsFoundPayload;
    expect(verdict.kind).toBe("defectsFound");
    expect(verdict.defects).toHaveLength(1);
    expect(verdict.defects[0]?.severity).toBe("critical");
    expect(verdict.defects[0]?.id).toBe("gen-1");
  });
});

// ---------------------------------------------------------------------------
// Fixer — atomic new-version write
// ---------------------------------------------------------------------------

describe("FixerAgent — atomic artifact update", () => {
  it("writes the fixed content as a NEW version through ArtifactStore.writeArtifact", async () => {
    const harness = await buildHarness("export const value = 1;\n");

    const fixedSource = "export const value = 1 as const;\n";
    const adapter = new StubModelAdapter({
      content: fixedSource,
      summary: "Tightened the type",
    });

    const fixer = new FixerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
    });

    const defects: readonly Defect[] = [
      {
        id: "d-1",
        description: "Tighten the value type",
        severity: "medium",
      },
    ];

    const result = await fixer.run({
      task: taskContext,
      agent: fixerAgent,
      apiKey,
      incoming: { ...incomingHandoff, recipient: FIXER_ID, sender: REVIEWER_ID },
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      defects,
      reviewerAgentId: REVIEWER_ID,
    });

    expect(result.recipient).toBe(REVIEWER_ID);
    expect(result.outgoing.type).toBe("handoff");
    expect(result.outgoing.recipient).toBe(REVIEWER_ID);

    const fixed = result.fixed;
    expect(fixed.kind).toBe("fixedArtifact");
    expect(fixed.version).toBe(2);
    expect(fixed.fileName).toBe("main.ts");
    expect(fixed.addressedDefectIds).toEqual(["d-1"]);
    expect(fixed.summary).toBe("Tightened the type");

    // Verify the artifact store actually has v2 with the new content.
    const v2 = await harness.artifactStore.getArtifact({
      taskId: TASK_ID,
      artifactId: harness.artifactId,
      version: 2,
    });
    expect(v2).not.toBeNull();
    expect(new TextDecoder().decode(v2!.bytes)).toBe(fixedSource);
    expect(v2!.contentHash).toBe(fixed.contentHash);

    // v1 must remain intact (append-only versioning).
    const v1 = await harness.artifactStore.getArtifact({
      taskId: TASK_ID,
      artifactId: harness.artifactId,
      version: 1,
    });
    expect(v1).not.toBeNull();
    expect(new TextDecoder().decode(v1!.bytes)).toBe(
      "export const value = 1;\n",
    );

    // Outgoing message is persisted before handoff.
    const persisted = await harness.historyStore.list(TASK_ID);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.recipient).toBe(REVIEWER_ID);

    // Trace integration:
    //   status:started + tool_call(file_read) + artifact_change(v2) + status:finished.
    await flushTraces();
    const records = harness.collected.map((e) => e.record);
    expect(records.map((r) => r.kind)).toEqual([
      "status",
      "tool_call",
      "artifact_change",
      "status",
    ]);

    const change = records[2];
    if (change?.kind !== "artifact_change") {
      throw new Error("expected artifact_change");
    }
    expect(change.artifactId).toBe(harness.artifactId);
    expect(change.version).toBe(2);

    const finished = records[3];
    if (finished?.kind !== "status") throw new Error("expected status");
    expect(finished.status).toBe("finished");
  });

  it("accepts a bare string from the model as the fixed content", async () => {
    const harness = await buildHarness("v = 1\n");

    const adapter = new StubModelAdapter("v = 2\n");
    const fixer = new FixerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
    });

    const result = await fixer.run({
      task: taskContext,
      agent: fixerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      defects: [
        {
          id: "d-1",
          description: "bump value",
          severity: "low",
        },
      ],
      reviewerAgentId: REVIEWER_ID,
    });

    expect(result.fixed.version).toBe(2);
    const v2 = await harness.artifactStore.getArtifact({
      taskId: TASK_ID,
      artifactId: harness.artifactId,
      version: 2,
    });
    expect(new TextDecoder().decode(v2!.bytes)).toBe("v = 2\n");
  });

  it("does not increment the version when the fix is byte-identical to v1", async () => {
    const harness = await buildHarness("same\n");

    const adapter = new StubModelAdapter("same\n");
    const fixer = new FixerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
    });

    const result = await fixer.run({
      task: taskContext,
      agent: fixerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      defects: [
        {
          id: "d-1",
          description: "no-op",
          severity: "low",
        },
      ],
      reviewerAgentId: REVIEWER_ID,
    });

    // Idempotent write: the store returns v1 unchanged.
    expect(result.fixed.version).toBe(1);
    const meta = await harness.artifactStore.listArtifacts(TASK_ID);
    expect(meta[0]?.latestVersion).toBe(1);
  });

  it("returns an error handoff when the model output cannot be turned into content", async () => {
    const harness = await buildHarness("v = 1\n");

    // BigInts cannot be turned into content by `extractFixedContent`.
    const adapter = new StubModelAdapter(BigInt(123));
    const fixer = new FixerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
    });

    const result = await fixer.run({
      task: taskContext,
      agent: fixerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      defects: [
        {
          id: "d-1",
          description: "anything",
          severity: "low",
        },
      ],
      reviewerAgentId: REVIEWER_ID,
    });

    expect(result.outgoing.type).toBe("error");
    expect(result.recipient).toBe(REVIEWER_ID);

    // No new artifact version was written — atomicity preserved.
    const meta = await harness.artifactStore.listArtifacts(TASK_ID);
    expect(meta[0]?.latestVersion).toBe(1);

    // Final trace event is status:error.
    await flushTraces();
    const last = harness.collected[harness.collected.length - 1]?.record;
    if (last?.kind !== "status") throw new Error("expected status");
    expect(last.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Lightweight smoke-test harness sanity (catch fixture regressions early).
// ---------------------------------------------------------------------------

describe("test harness", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await buildHarness("seed\n");
  });

  it("exposes the artifact via getArtifact at v1", async () => {
    const v1 = await harness.artifactStore.getArtifact({
      taskId: TASK_ID,
      artifactId: harness.artifactId,
      version: 1,
    });
    expect(v1).not.toBeNull();
    expect(new TextDecoder().decode(v1!.bytes)).toBe("seed\n");
  });
});

// ---------------------------------------------------------------------------
// ReviewerAgent — ShellRunner Integration (Phase 3.4b)
// ---------------------------------------------------------------------------

import { StagingWorkspaceManager } from "../artifacts/staging.js";
import { ShellRunner } from "../utils/shellRunner.js";

describe("ReviewerAgent — ShellRunner Integration (Phase 3.4b)", () => {
  it("keeps old behavior without shellRunner/staging/testCommand", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });
    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    const lastCall = adapter.calls[adapter.calls.length - 1];
    expect(lastCall?.messages).toBeDefined();
    const promptMessage = lastCall.messages.find(
      (m) => m.sender === "orchestrator" && m.type === "request"
    );
    expect(promptMessage?.payload.kind).toBe("text");
    expect(promptMessage?.payload.text).not.toContain("<test_execution_results>");
  });

  it("calls shellRunner with staging cwd when dependencies are provided", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: (taskId: string) => `/mock/staging/${taskId}`,
    } as unknown as StagingWorkspaceManager;

    let shellRunnerCalled = false;
    let shellRunnerCwd = "";
    const mockShellRunner = {
      execute: async (input: any) => {
        shellRunnerCalled = true;
        shellRunnerCwd = input.cwd;
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "test stdout",
          stderr: "test stderr",
        };
      },
    } as unknown as ShellRunner;

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommand: {
        command: "npm",
        args: ["test"],
      },
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(shellRunnerCalled).toBe(true);
    expect(shellRunnerCwd).toBe(`/mock/staging/${TASK_ID}`);
  });

  it("includes passing test result in model prompt", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    const mockShellRunner = {
      execute: async () => ({
        exitCode: 0,
        timedOut: false,
        stdout: "PASS  src/index.test.ts",
        stderr: "",
      }),
    } as unknown as ShellRunner;

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommand: {
        command: "npm",
        args: ["test"],
      },
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    const promptMessage = adapter.calls[0].messages.find(
      (m) => m.sender === "orchestrator" && m.type === "request"
    );
    const text = promptMessage?.payload.text || "";
    expect(text).toContain("<test_execution_results>");
    expect(text).toContain("Command: npm");
    expect(text).toContain("Args: test");
    expect(text).toContain("Exit Code: 0");
    expect(text).toContain("Timed Out: false");
    expect(text).toContain("PASS  src/index.test.ts");
  });

  it("includes failing test result stdout/stderr in model prompt", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    const mockShellRunner = {
      execute: async () => ({
        exitCode: 1,
        timedOut: false,
        stdout: "FAIL  src/index.test.ts",
        stderr: "AssertionError: expected 1 to be 2",
      }),
    } as unknown as ShellRunner;

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommand: {
        command: "npm",
        args: ["test"],
      },
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    const promptMessage = adapter.calls[0].messages.find(
      (m) => m.sender === "orchestrator" && m.type === "request"
    );
    const text = promptMessage?.payload.text || "";
    expect(text).toContain("<test_execution_results>");
    expect(text).toContain("Exit Code: 1");
    expect(text).toContain("FAIL  src/index.test.ts");
    expect(text).toContain("AssertionError: expected 1 to be 2");
  });

  it("includes timeout result in model prompt as timed out", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    const mockShellRunner = {
      execute: async () => ({
        exitCode: null,
        timedOut: true,
        stdout: "",
        stderr: "",
      }),
    } as unknown as ShellRunner;

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommand: {
        command: "npm",
        args: ["test"],
      },
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    const promptMessage = adapter.calls[0].messages.find(
      (m) => m.sender === "orchestrator" && m.type === "request"
    );
    const text = promptMessage?.payload.text || "";
    expect(text).toContain("<test_execution_results>");
    expect(text).toContain("Timed Out: true");
    expect(text).toContain("Test execution timed out");
  });

  it("includes ShellRunner thrown error as infrastructure error and does not crash Reviewer", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    const mockShellRunner = {
      execute: async () => {
        throw new Error("Disk read error");
      },
    } as unknown as ShellRunner;

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommand: {
        command: "npm",
        args: ["test"],
      },
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    const promptMessage = adapter.calls[0].messages.find(
      (m) => m.sender === "orchestrator" && m.type === "request"
    );
    const text = promptMessage?.payload.text || "";
    expect(text).toContain("<test_execution_results>");
    expect(text).toContain("Test execution infrastructure error: Disk read error");
  });

  it("does not call ShellRunner when testCommand is missing", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    let shellRunnerCalled = false;
    const mockShellRunner = {
      execute: async () => {
        shellRunnerCalled = true;
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      },
    } as unknown as ShellRunner;

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(shellRunnerCalled).toBe(false);
  });

  it("does not call ShellRunner when staging is missing", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    let shellRunnerCalled = false;
    const mockShellRunner = {
      execute: async () => {
        shellRunnerCalled = true;
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      },
    } as unknown as ShellRunner;

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      shellRunner: mockShellRunner,
      testCommand: {
        command: "npm",
        args: ["test"],
      },
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(shellRunnerCalled).toBe(false);
  });

  it("does not call ShellRunner when shellRunner is missing", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      testCommand: {
        command: "npm",
        args: ["test"],
      },
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    const promptMessage = adapter.calls[0].messages.find(
      (m) => m.sender === "orchestrator" && m.type === "request"
    );
    const text = promptMessage?.payload.text || "";
    expect(text).not.toContain("<test_execution_results>");
  });
});

// ---------------------------------------------------------------------------
// ReviewerAgent — Auto-Detection Integration (Phase 3.4d)
// ---------------------------------------------------------------------------

import type { DetectTestCommandResult } from "../utils/testCommandDetector.js";

describe("ReviewerAgent — Auto-Detection Integration (Phase 3.4d)", () => {
  it("explicit testCommand still works", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    let shellRunnerCalled = false;
    const mockShellRunner = {
      execute: async (input: any) => {
        shellRunnerCalled = true;
        expect(input.command).toBe("npm");
        expect(input.args).toEqual(["test"]);
        return { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
      },
    } as unknown as ShellRunner;

    const mockDetector = async () => {
      return {
        kind: "detected",
        command: "pnpm",
        args: ["test"],
        source: "package-json",
        packageManager: "pnpm",
        requiresConsent: false,
        reason: "pnpm lock found",
      } as DetectTestCommandResult;
    };

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommand: {
        command: "npm",
        args: ["test"],
      },
      testCommandDetector: mockDetector,
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(shellRunnerCalled).toBe(true);
  });

  it("auto-detected command requires consent and is NOT executed by default", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    let shellRunnerCalled = false;
    const mockShellRunner = {
      execute: async () => {
        shellRunnerCalled = true;
        return { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
      },
    } as unknown as ShellRunner;

    const mockDetector = async () => {
      return {
        kind: "detected",
        command: "npm",
        args: ["test"],
        source: "package-json",
        packageManager: "npm",
        requiresConsent: true,
        reason: "Consent required",
      } as DetectTestCommandResult;
    };

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommandDetector: mockDetector,
    });

    await expect(
      reviewer.run({
        task: taskContext,
        agent: reviewerAgent,
        apiKey,
        incoming: incomingHandoff,
        artifactRef: { artifactId: harness.artifactId, version: 1 },
        fixerAgentId: FIXER_ID,
        bossAgentId: BOSS_ID,
      })
    ).rejects.toThrow(ConsentRequiredError);

    expect(shellRunnerCalled).toBe(false);
  });

  it("auto-detected command executes when allowAutoDetectedTestCommand true", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    let shellRunnerCalled = false;
    const mockShellRunner = {
      execute: async (input: any) => {
        shellRunnerCalled = true;
        expect(input.command).toBe("pnpm");
        expect(input.args).toEqual(["test"]);
        return { exitCode: 0, timedOut: false, stdout: "all green", stderr: "" };
      },
    } as unknown as ShellRunner;

    const mockDetector = async () => {
      return {
        kind: "detected",
        command: "pnpm",
        args: ["test"],
        source: "package-json",
        packageManager: "pnpm",
        requiresConsent: false,
        reason: "auto-detect enabled",
      } as DetectTestCommandResult;
    };

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommandDetector: mockDetector,
      allowAutoDetectedTestCommand: true,
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(shellRunnerCalled).toBe(true);

    const promptMessage = adapter.calls[0].messages.find(
      (m) => m.sender === "orchestrator" && m.type === "request"
    );
    const text = promptMessage?.payload.text || "";
    expect(text).toContain("<test_execution_results>");
    expect(text).toContain("Command: pnpm");
    expect(text).toContain("all green");
  });

  it("blocked dangerous command is included in prompt and not executed", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    let shellRunnerCalled = false;
    const mockShellRunner = {
      execute: async () => {
        shellRunnerCalled = true;
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      },
    } as unknown as ShellRunner;

    const mockDetector = async () => {
      return {
        kind: "blocked",
        reason: "Dangerous command execution signs detected in scripts.test",
      } as DetectTestCommandResult;
    };

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommandDetector: mockDetector,
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(shellRunnerCalled).toBe(false);

    const promptMessage = adapter.calls[0].messages.find(
      (m) => m.sender === "orchestrator" && m.type === "request"
    );
    const text = promptMessage?.payload.text || "";
    expect(text).toContain("<test_command_blocked>");
    expect(text).toContain("Reason: Dangerous command execution signs detected in scripts.test");
  });

  it("not_found keeps old behavior", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    const mockDetector = async () => {
      return {
        kind: "not_found",
        reason: "No package.json found",
      } as DetectTestCommandResult;
    };

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: {} as ShellRunner,
      testCommandDetector: mockDetector,
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    const promptMessage = adapter.calls[0].messages.find(
      (m) => m.sender === "orchestrator" && m.type === "request"
    );
    const text = promptMessage?.payload.text || "";
    expect(text).toContain("No test command detected");
  });

  it("detector exception does not crash Reviewer", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    const mockDetector = async () => {
      throw new Error("File system read failure");
    };

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: {} as ShellRunner,
      testCommandDetector: mockDetector,
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    const promptMessage = adapter.calls[0].messages.find(
      (m) => m.sender === "orchestrator" && m.type === "request"
    );
    const text = promptMessage?.payload.text || "";
    expect(text).toContain("<test_execution_results>");
    expect(text).toContain("Test execution infrastructure error: File system read failure");
  });

  it("explicit testCommand has priority over detector", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    let executedCommand = "";
    const mockShellRunner = {
      execute: async (input: any) => {
        executedCommand = input.command;
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      },
    } as unknown as ShellRunner;

    let detectorCalled = false;
    const mockDetector = async () => {
      detectorCalled = true;
      return {
        kind: "detected",
        command: "pnpm",
        args: ["test"],
        source: "package-json",
        packageManager: "pnpm",
        requiresConsent: false,
        reason: "detector",
      } as DetectTestCommandResult;
    };

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommand: {
        command: "npm",
        args: ["test"],
      },
      testCommandDetector: mockDetector,
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(executedCommand).toBe("npm");
    expect(detectorCalled).toBe(false);
  });

  it("ShellRunner is not called if detector requires consent", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    let shellRunnerCalled = false;
    const mockShellRunner = {
      execute: async () => {
        shellRunnerCalled = true;
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      },
    } as unknown as ShellRunner;

    const mockDetector = async () => {
      return {
        kind: "detected",
        command: "pnpm",
        args: ["test"],
        source: "package-json",
        packageManager: "pnpm",
        requiresConsent: true,
        reason: "consent required",
      } as DetectTestCommandResult;
    };

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommandDetector: mockDetector,
    });

    await expect(
      reviewer.run({
        task: taskContext,
        agent: reviewerAgent,
        apiKey,
        incoming: incomingHandoff,
        artifactRef: { artifactId: harness.artifactId, version: 1 },
        fixerAgentId: FIXER_ID,
        bossAgentId: BOSS_ID,
      })
    ).rejects.toThrow(ConsentRequiredError);

    expect(shellRunnerCalled).toBe(false);
  });

  it("ShellRunner is called with staging cwd when auto-detect is allowed", async () => {
    const harness = await buildHarness("export const value = 1;\n");
    const adapter = new StubModelAdapter({ kind: "noDefects" });

    const mockStaging = {
      getStagingRoot: () => "/mock/staging",
    } as unknown as StagingWorkspaceManager;

    let executedCwd = "";
    const mockShellRunner = {
      execute: async (input: any) => {
        executedCwd = input.cwd;
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      },
    } as unknown as ShellRunner;

    const mockDetector = async () => {
      return {
        kind: "detected",
        command: "pnpm",
        args: ["test"],
        source: "package-json",
        packageManager: "pnpm",
        requiresConsent: false,
        reason: "detector",
      } as DetectTestCommandResult;
    };

    const reviewer = new ReviewerAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      staging: mockStaging,
      shellRunner: mockShellRunner,
      testCommandDetector: mockDetector,
      allowAutoDetectedTestCommand: true,
    });

    await reviewer.run({
      task: taskContext,
      agent: reviewerAgent,
      apiKey,
      incoming: incomingHandoff,
      artifactRef: { artifactId: harness.artifactId, version: 1 },
      fixerAgentId: FIXER_ID,
      bossAgentId: BOSS_ID,
    });

    expect(executedCwd).toBe("/mock/staging");
  });
});

