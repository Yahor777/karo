/**
 * Unit tests for {@link buildFinalReport} / {@link InMemoryTaskHistoryStore}
 * and the runner wiring smoke test (task 15.2).
 *
 * Coverage required by the task brief:
 *   (a) `completed` Final_Report carrying a Boss summary.
 *   (b) `stopped_limit` Final_Report carrying outstanding issues.
 *   (c) `TaskHistoryStore.save` / `get` / `list` round-trip with
 *       defensive deep-clone semantics.
 *   (d) Smoke test verifying the {@link TaskPipeline} runner builds and
 *       persists a Final_Report on terminal state when the optional
 *       `artifactStore` and `taskHistoryStore` are wired in.
 *
 * Validates: Requirements 8.6, 8.7, 14.2, 14.3, 14.4, 14.5.
 */

import { describe, expect, it } from "vitest";

import type {
  AgentMessage,
  FileArtifactMetadata,
  FinalReport,
} from "@ai-agent-orchestrator/validation";
import type { ModelRef } from "@ai-agent-orchestrator/shared-core";

import {
  ArtifactStore,
  InMemoryArtifactStoreBackend,
} from "../artifacts/index.js";
import {
  InMemoryMessageHistoryStore,
  type AgentDefinition,
  type ModelAdapter,
  type ModelInvokeOptions,
  type SecretRef,
} from "../agentRuntime/index.js";
import {
  InMemoryTraceEventStoreBackend,
  TraceEventBus,
} from "../trace/index.js";
import {
  BOSS_VERDICT_RUSSIAN,
  BossAgent,
  CoderAgent,
  FixerAgent,
  ResearcherAgent,
  ReviewerAgent,
  type BossVerdict,
} from "../agents/index.js";

import {
  InMemoryTaskHistoryStore,
  STOPPED_LIMIT_GENERIC_ISSUE,
  buildFinalReport,
} from "./finalReport.js";
import {
  InMemoryTaskStateStore,
  TaskPipeline,
  type TaskPipelineOptions,
} from "./index.js";
import type { TaskState } from "./stateMachine.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TASK_ID = "task-final-report";
const ISO_AT = "2024-06-15T12:00:00.000Z";

const fixedClock = { nowIso: () => ISO_AT };

const sampleArtifact: FileArtifactMetadata = {
  id: "artifact-1",
  taskId: TASK_ID,
  fileName: "main.rs",
  latestVersion: 2,
  latestContentHash: "deadbeef",
  updatedAt: ISO_AT,
};

const approvedVerdict: BossVerdict = {
  kind: "approved",
  verdict: BOSS_VERDICT_RUSSIAN.approved,
  notes: ["Looks good"],
};

const rejectedVerdict: BossVerdict = {
  kind: "rejected",
  verdict: BOSS_VERDICT_RUSSIAN.rejected,
  notes: ["Tests are missing", "Documentation is incomplete"],
};

// ---------------------------------------------------------------------------
// (a) Builder — completed report with Boss summary
// ---------------------------------------------------------------------------

describe("buildFinalReport — completed", () => {
  it("assembles a 'completed' report with Boss approval summary and artifact refs (Validates: Requirements 8.7, 14.2)", () => {
    const report = buildFinalReport({
      taskId: TASK_ID,
      terminalStatus: "completed",
      originalPrompt: "Write a hello-world program",
      participants: ["researcher", "coder", "reviewer", "fixer", "boss"],
      reviewCyclesPerformed: 1,
      finalArtifacts: [sampleArtifact],
      bossVerdict: approvedVerdict,
      clock: fixedClock,
    });

    expect(report.taskId).toBe(TASK_ID);
    expect(report.status).toBe("completed");
    expect(report.originalPrompt).toBe("Write a hello-world program");
    expect(report.participants).toEqual([
      "researcher",
      "coder",
      "reviewer",
      "fixer",
      "boss",
    ]);
    expect(report.reviewCyclesPerformed).toBe(1);
    expect(report.createdAt).toBe(ISO_AT);

    // Artifact ref strips the bytes/hashes and keeps only what the UI
    // needs to fetch the latest version on demand (Requirement 14.3).
    expect(report.finalArtifacts).toEqual([
      { artifactId: "artifact-1", version: 2, fileName: "main.rs" },
    ]);

    // Boss summary uses the Russian wording verbatim (Requirement 7.10
    // / 14.2) and appends the verdict notes.
    expect(report.bossSummary).toBe(
      `${BOSS_VERDICT_RUSSIAN.approved}: Looks good`,
    );
    // Completed reports never carry outstanding issues.
    expect(report.outstandingIssues).toBeUndefined();
  });

  it("rejects 'completed' without an approved Boss verdict", () => {
    expect(() =>
      buildFinalReport({
        taskId: TASK_ID,
        terminalStatus: "completed",
        originalPrompt: "Prompt",
        participants: ["researcher"],
        reviewCyclesPerformed: 1,
        finalArtifacts: [],
        clock: fixedClock,
      }),
    ).toThrow(/completed Final_Report requires a bossVerdict/);

    expect(() =>
      buildFinalReport({
        taskId: TASK_ID,
        terminalStatus: "completed",
        originalPrompt: "Prompt",
        participants: ["researcher"],
        reviewCyclesPerformed: 1,
        finalArtifacts: [],
        bossVerdict: rejectedVerdict,
        clock: fixedClock,
      }),
    ).toThrow(/bossVerdict\.kind === 'approved'/);
  });

  it("drops caller-supplied outstanding issues on a 'completed' report", () => {
    const report = buildFinalReport({
      taskId: TASK_ID,
      terminalStatus: "completed",
      originalPrompt: "Prompt",
      participants: ["boss"],
      reviewCyclesPerformed: 1,
      finalArtifacts: [],
      bossVerdict: approvedVerdict,
      // The builder explicitly drops these on `completed` — Boss
      // approval is by definition an "all clear" signal.
      outstandingIssues: ["Should be dropped"],
      clock: fixedClock,
    });

    expect(report.outstandingIssues).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (b) Builder — stopped_limit report with outstanding issues
// ---------------------------------------------------------------------------

describe("buildFinalReport — stopped_limit", () => {
  it("assembles a 'stopped_limit' report with caller-supplied outstanding issues (Validates: Requirements 8.6, 14.4)", () => {
    const report = buildFinalReport({
      taskId: TASK_ID,
      terminalStatus: "stopped_limit",
      originalPrompt: "Build a parser",
      participants: ["researcher", "coder", "reviewer", "fixer"],
      reviewCyclesPerformed: 5,
      finalArtifacts: [sampleArtifact],
      outstandingIssues: ["Edge case A unresolved", "Edge case B unresolved"],
      clock: fixedClock,
    });

    expect(report.status).toBe("stopped_limit");
    expect(report.reviewCyclesPerformed).toBe(5);
    expect(report.outstandingIssues).toEqual([
      "Edge case A unresolved",
      "Edge case B unresolved",
    ]);
    // No Boss verdict supplied → no summary on the report.
    expect(report.bossSummary).toBeUndefined();
  });

  it("falls back to Boss rejection notes when no outstanding issues are supplied", () => {
    const report = buildFinalReport({
      taskId: TASK_ID,
      terminalStatus: "stopped_limit",
      originalPrompt: "Prompt",
      participants: ["boss"],
      reviewCyclesPerformed: 5,
      finalArtifacts: [],
      bossVerdict: rejectedVerdict,
      clock: fixedClock,
    });

    expect(report.outstandingIssues).toEqual([
      "Tests are missing",
      "Documentation is incomplete",
    ]);
    // Boss summary survives even on stopped_limit when a verdict was
    // captured (the cap may have been reached during Boss review).
    expect(report.bossSummary).toBe(
      `${BOSS_VERDICT_RUSSIAN.rejected}: Tests are missing; Documentation is incomplete`,
    );
  });

  it("uses the generic stopped-limit fallback when nothing is supplied", () => {
    const report = buildFinalReport({
      taskId: TASK_ID,
      terminalStatus: "stopped_limit",
      originalPrompt: "Prompt",
      participants: ["researcher"],
      reviewCyclesPerformed: 5,
      finalArtifacts: [],
      clock: fixedClock,
    });

    expect(report.outstandingIssues).toEqual([STOPPED_LIMIT_GENERIC_ISSUE]);
  });
});

// ---------------------------------------------------------------------------
// (c) Store — round-trip and defensive deep clones
// ---------------------------------------------------------------------------

describe("InMemoryTaskHistoryStore", () => {
  function makeReport(taskId: string, createdAt: string): FinalReport {
    return buildFinalReport({
      taskId,
      terminalStatus: "completed",
      originalPrompt: "Prompt",
      participants: ["researcher", "boss"],
      reviewCyclesPerformed: 1,
      finalArtifacts: [],
      bossVerdict: approvedVerdict,
      clock: { nowIso: () => createdAt },
    });
  }

  it("round-trips a saved report through save → get (Validates: Requirement 14.5)", async () => {
    const store = new InMemoryTaskHistoryStore();
    const report = makeReport("task-A", "2024-06-15T10:00:00.000Z");

    await store.save(report);
    const loaded = await store.get("task-A");

    expect(loaded).not.toBeNull();
    expect(loaded?.taskId).toBe("task-A");
    expect(loaded?.status).toBe("completed");
    expect(loaded?.bossSummary).toBe(report.bossSummary);
  });

  it("returns null for unknown task ids without throwing", async () => {
    const store = new InMemoryTaskHistoryStore();
    expect(await store.get("does-not-exist")).toBeNull();
  });

  it("orders list() most-recent first with deterministic taskId tiebreak", async () => {
    const store = new InMemoryTaskHistoryStore();
    await store.save(makeReport("task-old", "2024-01-01T00:00:00.000Z"));
    await store.save(makeReport("task-new", "2024-12-01T00:00:00.000Z"));
    await store.save(makeReport("task-tie-b", "2024-06-15T10:00:00.000Z"));
    await store.save(makeReport("task-tie-a", "2024-06-15T10:00:00.000Z"));

    const listed = await store.list();
    expect(listed.map((r) => r.taskId)).toEqual([
      "task-new",
      "task-tie-a", // ascending taskId tiebreak
      "task-tie-b",
      "task-old",
    ]);
    expect(store.size()).toBe(4);
  });

  it("returns defensive deep copies so caller mutation cannot leak back", async () => {
    const store = new InMemoryTaskHistoryStore();
    const report = makeReport("task-A", "2024-06-15T10:00:00.000Z");
    await store.save(report);

    // Mutate the local handle — the store must keep its own copy.
    (report as unknown as { originalPrompt: string }).originalPrompt =
      "MUTATED";

    const loaded = await store.get("task-A");
    expect(loaded?.originalPrompt).toBe("Prompt");

    // Mutate the loaded handle — subsequent reads must still be clean.
    (loaded as unknown as { originalPrompt: string }).originalPrompt =
      "MUTATED-AGAIN";
    const reloaded = await store.get("task-A");
    expect(reloaded?.originalPrompt).toBe("Prompt");
  });
});

// ---------------------------------------------------------------------------
// (d) Runner wiring smoke test
// ---------------------------------------------------------------------------

const RESEARCHER_ID = "researcher";
const CODER_ID = "coder";
const REVIEWER_ID = "reviewer";
const FIXER_ID = "fixer";
const BOSS_ID = "boss";

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

const initialState: TaskState = {
  id: TASK_ID,
  ownerScope: { kind: "local", deviceId: "device-1" },
  status: "created",
  reviewCycles: 0,
  maxReviewCycles: 5,
  createdAt: ISO_AT,
  updatedAt: ISO_AT,
};

const researcherAgent: AgentDefinition = {
  id: RESEARCHER_ID,
  name: "Researcher",
  systemPrompt: "Enrich.",
  allowedTools: ["web_search"],
};
const coderAgent: AgentDefinition = {
  id: CODER_ID,
  name: "Coder",
  systemPrompt: "Code.",
  allowedTools: ["web_search", "file_read", "file_write"],
};
const reviewerAgent: AgentDefinition = {
  id: REVIEWER_ID,
  name: "Reviewer",
  systemPrompt: "Review.",
  allowedTools: ["web_search", "file_read", "artifact_diff"],
};
const fixerAgent: AgentDefinition = {
  id: FIXER_ID,
  name: "Fixer",
  systemPrompt: "Fix.",
  allowedTools: ["web_search", "file_read", "file_write", "artifact_diff"],
};
const bossAgent: AgentDefinition = {
  id: BOSS_ID,
  name: "Boss",
  systemPrompt: "Judge.",
  allowedTools: ["file_read", "artifact_diff"],
};

class ScriptedAdapter implements ModelAdapter {
  private readonly callsByAgent = new Map<string, number>();

  public constructor(
    private readonly responses: Record<string, unknown[]>,
  ) {}

  public async invoke(
    _modelRef: ModelRef,
    _messages: readonly AgentMessage[],
    options: ModelInvokeOptions,
  ): Promise<{ raw: unknown }> {
    const key = options.systemPrompt;
    const queue = this.responses[key];
    const seen = this.callsByAgent.get(key) ?? 0;
    this.callsByAgent.set(key, seen + 1);
    if (queue === undefined || seen >= queue.length) {
      throw new Error(
        `ScriptedAdapter has no response for "${key}" at index ${seen}`,
      );
    }
    return { raw: queue[seen] };
  }
}

interface Harness {
  pipelineOptions: TaskPipelineOptions;
  artifactStore: ArtifactStore;
  taskHistoryStore: InMemoryTaskHistoryStore;
}

function buildHarness(adapter: ModelAdapter): Harness {
  const taskStore = new InMemoryTaskStateStore();
  const history = new InMemoryMessageHistoryStore();
  const artifactStore = new ArtifactStore({
    backend: new InMemoryArtifactStoreBackend(),
  });
  const traceBus = new TraceEventBus({
    backend: new InMemoryTraceEventStoreBackend(),
  });
  const taskHistoryStore = new InMemoryTaskHistoryStore();

  const research = new ResearcherAgent({
    modelAdapter: adapter,
    messageHistoryStore: history,
    traceBus,
  });
  const coder = new CoderAgent({
    modelAdapter: adapter,
    messageHistoryStore: history,
    artifactStore,
    traceBus,
    idGenerator: () => "artifact-1",
    defaultFileName: "main.txt",
  });
  const reviewer = new ReviewerAgent({
    modelAdapter: adapter,
    messageHistoryStore: history,
    artifactStore,
    traceBus,
    idGenerator: () => "defect-id",
  });
  const fixer = new FixerAgent({
    modelAdapter: adapter,
    messageHistoryStore: history,
    artifactStore,
    traceBus,
  });
  const boss = new BossAgent({
    modelAdapter: adapter,
    messageHistoryStore: history,
    agent: bossAgent,
  });

  return {
    pipelineOptions: {
      store: taskStore,
      messageHistoryStore: history,
      traceBus,
      participants: {
        researcher: { agent: researcherAgent, runner: research },
        coder: { agent: coderAgent, runner: coder },
        reviewer: { agent: reviewerAgent, runner: reviewer },
        fixer: { agent: fixerAgent, runner: fixer },
        boss: { agent: bossAgent, runner: boss },
      },
      artifactStore,
      taskHistoryStore,
    },
    artifactStore,
    taskHistoryStore,
  };
}

describe("TaskPipeline — Final_Report wiring smoke test (task 15.2)", () => {
  it("builds and persists a 'completed' Final_Report on Boss approval (Validates: Requirements 8.7, 14.2, 14.5)", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [
        { content: "fn main() {}\n", fileName: "main.rs" },
      ],
      [reviewerAgent.systemPrompt]: [
        {
          defects: [{ id: "d-1", description: "needs polish", severity: "low" }],
        },
        { kind: "noDefects" },
      ],
      [fixerAgent.systemPrompt]: [{ content: "fn main() { /* ok */ }\n" }],
      [bossAgent.systemPrompt]: [
        {
          kind: "approved",
          verdict: BOSS_VERDICT_RUSSIAN.approved,
          notes: ["Implementation is correct"],
        },
      ],
    });

    const harness = buildHarness(adapter);
    const pipeline = new TaskPipeline(harness.pipelineOptions);

    const result = await pipeline.runTask({
      state: initialState,
      prompt: "Write a hello-world program in Rust",
      apiKey,
      defaultModel,
      participants: [RESEARCHER_ID, CODER_ID, REVIEWER_ID, FIXER_ID, BOSS_ID],
    });

    expect(result.finalState.status).toBe("completed");
    expect(result.finalReport).not.toBeNull();
    const report = result.finalReport!;
    expect(report.taskId).toBe(TASK_ID);
    expect(report.status).toBe("completed");
    expect(report.originalPrompt).toBe("Write a hello-world program in Rust");
    expect(report.reviewCyclesPerformed).toBe(1);
    expect(report.participants).toEqual([
      RESEARCHER_ID,
      CODER_ID,
      REVIEWER_ID,
      FIXER_ID,
      BOSS_ID,
    ]);
    // Boss summary preserves the Russian wording.
    expect(report.bossSummary).toContain(BOSS_VERDICT_RUSSIAN.approved);
    expect(report.bossSummary).toContain("Implementation is correct");
    // Final artifacts are referenced (not embedded) and point at the
    // latest version.
    expect(report.finalArtifacts).toHaveLength(1);
    expect(report.finalArtifacts[0]?.artifactId).toBe("artifact-1");
    expect(report.finalArtifacts[0]?.version).toBe(2);
    expect(report.outstandingIssues).toBeUndefined();

    // The report is persisted in the Task History store
    // (Requirement 14.5).
    const stored = await harness.taskHistoryStore.get(TASK_ID);
    expect(stored).not.toBeNull();
    expect(stored?.taskId).toBe(TASK_ID);
    expect(stored?.status).toBe("completed");
    const listed = await harness.taskHistoryStore.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.taskId).toBe(TASK_ID);
  });

  it("builds a 'stopped_limit' Final_Report with outstanding issues when the cycle cap is reached (Validates: Requirements 8.6, 14.4)", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [{ content: "v0\n", fileName: "main.txt" }],
      // Reviewer always finds a defect; cap is 2 so we need 3 reviewer
      // calls (2 successful → fixer; 3rd pushes over the cap).
      [reviewerAgent.systemPrompt]: [
        { defects: [{ id: "d-1", description: "issue 1", severity: "low" }] },
        { defects: [{ id: "d-2", description: "issue 2", severity: "low" }] },
        { defects: [{ id: "d-3", description: "issue 3", severity: "low" }] },
      ],
      [fixerAgent.systemPrompt]: [
        { content: "v1\n" },
        { content: "v2\n" },
      ],
      [bossAgent.systemPrompt]: [],
    });

    const cappedState: TaskState = { ...initialState, maxReviewCycles: 2 };
    const harness = buildHarness(adapter);
    const pipeline = new TaskPipeline(harness.pipelineOptions);

    const result = await pipeline.runTask({
      state: cappedState,
      prompt: "Build a parser",
      apiKey,
      defaultModel,
    });

    expect(result.finalState.status).toBe("stopped_limit");
    expect(result.finalState.reviewCycles).toBe(2);
    expect(result.finalReport).not.toBeNull();
    const report = result.finalReport!;
    expect(report.status).toBe("stopped_limit");
    expect(report.reviewCyclesPerformed).toBe(2);
    expect(report.bossSummary).toBeUndefined();
    // No Boss verdict captured during the Reviewer→Fixer loop —
    // outstandingIssues falls back to the generic marker
    // (Requirement 14.4).
    expect(report.outstandingIssues).toEqual([STOPPED_LIMIT_GENERIC_ISSUE]);

    // Default-participant fallback covers all five canonical agents.
    expect(report.participants).toEqual([
      RESEARCHER_ID,
      CODER_ID,
      REVIEWER_ID,
      FIXER_ID,
      BOSS_ID,
    ]);

    // Persisted in Task History.
    const stored = await harness.taskHistoryStore.get(TASK_ID);
    expect(stored?.status).toBe("stopped_limit");
  });

  it("returns finalReport: null when artifactStore is not wired in", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [
        { content: "fn main() {}\n", fileName: "main.rs" },
      ],
      [reviewerAgent.systemPrompt]: [
        { defects: [{ id: "d-1", description: "x", severity: "low" }] },
        { kind: "noDefects" },
      ],
      [fixerAgent.systemPrompt]: [{ content: "fn main() { /* ok */ }\n" }],
      [bossAgent.systemPrompt]: [
        {
          kind: "approved",
          verdict: BOSS_VERDICT_RUSSIAN.approved,
          notes: [],
        },
      ],
    });

    const harness = buildHarness(adapter);
    // Drop the artifact store + history store so we behave as a pre-15.2
    // caller would.
    const optsWithoutFinalReport: TaskPipelineOptions = {
      store: harness.pipelineOptions.store,
      messageHistoryStore: harness.pipelineOptions.messageHistoryStore,
      traceBus: harness.pipelineOptions.traceBus,
      participants: harness.pipelineOptions.participants,
    };
    const pipeline = new TaskPipeline(optsWithoutFinalReport);

    const result = await pipeline.runTask({
      state: initialState,
      prompt: "Hello",
      apiKey,
      defaultModel,
    });

    expect(result.finalState.status).toBe("completed");
    expect(result.finalReport).toBeNull();
  });
});
