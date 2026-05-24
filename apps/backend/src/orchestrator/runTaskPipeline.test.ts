/**
 * Integration tests for {@link TaskPipeline} / {@link runTaskPipeline}
 * (task 15.1).
 *
 * Coverage required by the task brief:
 *   1. Full happy path — Researcher → Coder → Reviewer (defects) →
 *      Fixer → Reviewer (no defects) → Boss (approve) → `completed`.
 *   2. Defects-fixing loop terminates with `stopped_limit` at the cap.
 *   3. Boss rejection routes back through Fixer → Reviewer → Boss and,
 *      on second-pass approval, ends `completed`.
 *
 * Plus integration assertions on:
 *   • `TaskState` persistence at every transition.
 *   • Agent_Message persistence — every step's outgoing message lands
 *     in the message history store (Requirement 10.6).
 *   • Trace events — at minimum, orchestrator-level `started` /
 *     `finished` are emitted, and every per-step transition publishes
 *     a `thought` record (Requirement 11.2).
 *
 * Validates: Requirements 7.1, 8.1, 8.2, 8.3, 8.4, 8.7.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ShellRunner } from "../utils/shellRunner.js";
import { detectTestCommand } from "../utils/testCommandDetector.js";

import { describe, expect, it } from "vitest";

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
  type TraceEvent,
} from "../trace/index.js";
import {
  BossAgent,
  CoderAgent,
  FixerAgent,
  ResearcherAgent,
  ReviewerAgent,
  BOSS_VERDICT_RUSSIAN,
} from "../agents/index.js";
import type { AgentMessage } from "@ai-agent-orchestrator/validation";
import type { ModelRef } from "@ai-agent-orchestrator/shared-core";

import {
  InMemoryTaskStateStore,
  TaskPipeline,
  runTaskPipeline,
  resumeTask,
  activeConsentRequests,
  type RunTaskPipelineInput,
  type TaskPipelineOptions,
} from "./index.js";
import type { TaskState } from "./stateMachine.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASK_ID = "task-pipeline";
const ISO_AT = "2024-06-15T12:00:00.000Z";

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
  systemPrompt: "Enrich the user prompt.",
  allowedTools: ["web_search"],
};

const coderAgent: AgentDefinition = {
  id: CODER_ID,
  name: "Coder",
  systemPrompt: "Produce a file artifact.",
  allowedTools: ["web_search", "file_read", "file_write"],
};

const reviewerAgent: AgentDefinition = {
  id: REVIEWER_ID,
  name: "Reviewer",
  systemPrompt: "Find defects.",
  allowedTools: ["web_search", "file_read", "artifact_diff"],
};

const fixerAgent: AgentDefinition = {
  id: FIXER_ID,
  name: "Fixer",
  systemPrompt: "Fix defects.",
  allowedTools: ["web_search", "file_read", "file_write", "artifact_diff"],
};

const bossAgent: AgentDefinition = {
  id: BOSS_ID,
  name: "Boss",
  systemPrompt: "Compare the artifact to the prompt.",
  allowedTools: ["file_read", "artifact_diff"],
};

// ---------------------------------------------------------------------------
// Stub model adapter
// ---------------------------------------------------------------------------

/**
 * Scripted model adapter that picks a response based on the system
 * prompt of the agent invoking it. The pipeline drives all five agents
 * through the same adapter, so this lets a single test customise per
 * agent without tracking call counters across agents.
 */
class ScriptedAdapter implements ModelAdapter {
  public readonly callsByAgent = new Map<string, number>();
  public readonly observed: Array<{ agent: string; index: number }> = [];
  public readonly calls: Array<{
    modelRef: ModelRef;
    messages: readonly AgentMessage[];
    options: ModelInvokeOptions;
  }> = [];

  public constructor(
    private readonly responses: Record<
      string,
      Array<unknown>
    >,
  ) {}

  public async invoke(
    modelRef: ModelRef,
    messages: readonly AgentMessage[],
    options: ModelInvokeOptions,
  ): Promise<{ raw: unknown }> {
    const key = options.systemPrompt;
    const queue = this.responses[key];
    const seen = this.callsByAgent.get(key) ?? 0;
    this.callsByAgent.set(key, seen + 1);
    this.observed.push({ agent: key, index: seen });
    this.calls.push({ modelRef, messages, options });

    if (queue === undefined || seen >= queue.length) {
      throw new Error(
        `ScriptedAdapter has no response for agent prompt "${key}" at index ${seen}`,
      );
    }
    const value = queue[seen];
    const raw = typeof value === "function" ? (value as () => unknown)() : value;
    return { raw };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  pipelineOptions: TaskPipelineOptions;
  store: InMemoryTaskStateStore;
  history: InMemoryMessageHistoryStore;
  collected: TraceEvent[];
  artifactStore: ArtifactStore;
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
  const collected: TraceEvent[] = [];
  const iterator = traceBus.subscribe({ taskId: TASK_ID });
  void (async () => {
    for await (const event of iterator) {
      collected.push(event);
    }
  })();

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
    },
    store: taskStore,
    history,
    collected,
    artifactStore,
  };
}

async function flushTraces(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeInput(state: TaskState = initialState): RunTaskPipelineInput {
  return {
    state,
    prompt: "Write a hello-world program in Rust.",
    apiKey,
    defaultModel,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — happy path → completed
// ---------------------------------------------------------------------------

describe("TaskPipeline — happy path completes after one Review_Cycle", () => {
  it("drives Researcher → Coder → Reviewer (defects) → Fixer → Reviewer (no defects) → Boss (approve) → completed", async () => {
    // Adapter scripts: one response per agent invocation.
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched: write hello-world rust"],
      [coderAgent.systemPrompt]: [
        { content: "fn main() { println!(\"hi\"); }\n", fileName: "main.rs" },
      ],
      [reviewerAgent.systemPrompt]: [
        // First Review pass: one defect → triggers Reviewer→Fixer.
        {
          defects: [
            {
              id: "d-1",
              description: "Use a friendlier greeting",
              severity: "low",
            },
          ],
        },
        // Second Review pass after Fixer: no defects → Boss.
        { kind: "noDefects", summary: "All good" },
      ],
      [fixerAgent.systemPrompt]: [
        { content: "fn main() { println!(\"hello, world\"); }\n" },
      ],
      [bossAgent.systemPrompt]: [
        {
          kind: "approved",
          verdict: BOSS_VERDICT_RUSSIAN.approved,
          notes: ["Looks good"],
        },
      ],
    });

    const harness = buildHarness(adapter);
    const result = await runTaskPipeline(makeInput(), harness.pipelineOptions);

    // Final outcome is completed and exactly one Review_Cycle was performed.
    expect(result.finalState.status).toBe("completed");
    expect(result.finalState.reviewCycles).toBe(1);
    expect(result.currentArtifactId).toBe("artifact-1");
    expect(result.currentArtifactVersion).toBe(2);

    // Persisted state matches the returned state.
    const persisted = harness.store.get(TASK_ID);
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe("completed");
    expect(persisted?.reviewCycles).toBe(1);

    // Every participating agent was called the expected number of times.
    expect(adapter.callsByAgent.get(researcherAgent.systemPrompt)).toBe(1);
    expect(adapter.callsByAgent.get(coderAgent.systemPrompt)).toBe(1);
    expect(adapter.callsByAgent.get(reviewerAgent.systemPrompt)).toBe(2);
    expect(adapter.callsByAgent.get(fixerAgent.systemPrompt)).toBe(1);
    expect(adapter.callsByAgent.get(bossAgent.systemPrompt)).toBe(1);

    // Persisted Agent_Messages: orchestrator handoff + every agent's
    // outgoing message (Requirement 10.6).
    const messages = await harness.history.list(TASK_ID);
    // 1 (orchestrator → researcher) + 1 (researcher → coder)
    //   + 1 (coder → reviewer) + 1 (reviewer → fixer)
    //   + 1 (fixer → reviewer) + 1 (reviewer → boss) + 1 (boss verdict)
    expect(messages).toHaveLength(7);
    // Sender chain spot-checks.
    expect(messages[0]?.sender).toBe("orchestrator");
    expect(messages[0]?.recipient).toBe(RESEARCHER_ID);
    expect(messages[1]?.sender).toBe(RESEARCHER_ID);
    expect(messages[1]?.recipient).toBe(CODER_ID);
    expect(messages[2]?.sender).toBe(CODER_ID);
    expect(messages[2]?.recipient).toBe(REVIEWER_ID);
    expect(messages[3]?.sender).toBe(REVIEWER_ID);
    expect(messages[3]?.recipient).toBe(FIXER_ID);
    expect(messages[4]?.sender).toBe(FIXER_ID);
    expect(messages[4]?.recipient).toBe(REVIEWER_ID);
    expect(messages[5]?.sender).toBe(REVIEWER_ID);
    expect(messages[5]?.recipient).toBe(BOSS_ID);
    expect(messages[6]?.sender).toBe(BOSS_ID);

    // Trace events include orchestrator-level `started` / `finished`.
    await flushTraces();
    const orchestratorStatuses = harness.collected
      .filter((e) => e.agentId === "orchestrator")
      .filter((e) => e.record.kind === "status")
      .map((e) => (e.record.kind === "status" ? e.record.status : ""));
    expect(orchestratorStatuses[0]).toBe("started");
    expect(orchestratorStatuses[orchestratorStatuses.length - 1]).toBe(
      "finished",
    );
    // At least one transition `thought` published per turn.
    const thoughts = harness.collected.filter(
      (e) => e.record.kind === "thought" && e.agentId === "orchestrator",
    );
    expect(thoughts.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — defects loop terminates at stopped_limit
// ---------------------------------------------------------------------------

describe("TaskPipeline — defects-fixing loop saturates at maxReviewCycles", () => {
  it("ends with stopped_limit when the Reviewer keeps finding defects", async () => {
    // Arrange a small cap (3) and a Reviewer that always finds defects.
    const cappedState: TaskState = {
      ...initialState,
      maxReviewCycles: 3,
    };

    const reviewerDefect = (id: string) => ({
      defects: [
        {
          id,
          description: `defect ${id}`,
          severity: "medium",
        },
      ],
    });

    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [{ content: "v0\n", fileName: "main.txt" }],
      // We expect at most 3 successful Review→Fixer hops; after that
      // the state machine routes the next `defects_found` to
      // `stopped_limit` so the Reviewer is invoked for the 4th and
      // final time and the script needs a 4th response.
      [reviewerAgent.systemPrompt]: [
        reviewerDefect("d-1"),
        reviewerDefect("d-2"),
        reviewerDefect("d-3"),
        reviewerDefect("d-4"),
      ],
      [fixerAgent.systemPrompt]: [
        { content: "v1\n" },
        { content: "v2\n" },
        { content: "v3\n" },
      ],
      [bossAgent.systemPrompt]: [],
    });

    const harness = buildHarness(adapter);
    const result = await runTaskPipeline(
      makeInput(cappedState),
      harness.pipelineOptions,
    );

    expect(result.finalState.status).toBe("stopped_limit");
    expect(result.finalState.reviewCycles).toBe(3);
    // Boss was never invoked.
    expect(adapter.callsByAgent.get(bossAgent.systemPrompt) ?? 0).toBe(0);
    // Reviewer ran 4 times: once per fixer pass + the final pass that
    // pushed the cycle over the cap.
    expect(adapter.callsByAgent.get(reviewerAgent.systemPrompt)).toBe(4);
    expect(adapter.callsByAgent.get(fixerAgent.systemPrompt)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Boss rejection routes back to fixing
// ---------------------------------------------------------------------------

describe("TaskPipeline — Boss rejection re-enters the fixing loop", () => {
  it("routes Boss 'не соответствует' back to Fixer → Reviewer → Boss and ends completed on the second pass", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [
        { content: "v0\n", fileName: "main.txt" },
      ],
      [reviewerAgent.systemPrompt]: [
        // Pass 1: defects → fixer.
        {
          defects: [
            { id: "r-1", description: "first nit", severity: "low" },
          ],
        },
        // Pass 2: no defects → boss.
        { kind: "noDefects" },
        // Pass 3 (after boss rejection routes back through fixer):
        // no defects → boss again.
        { kind: "noDefects" },
      ],
      [fixerAgent.systemPrompt]: [
        { content: "v1\n" }, // Reviewer-driven fix.
        { content: "v2\n" }, // Boss-driven fix.
      ],
      [bossAgent.systemPrompt]: [
        // First evaluation: rejected, kicks back to fixing.
        {
          kind: "rejected",
          verdict: BOSS_VERDICT_RUSSIAN.rejected,
          notes: ["Tests are missing"],
        },
        // Second evaluation: approved.
        {
          kind: "approved",
          verdict: BOSS_VERDICT_RUSSIAN.approved,
          notes: [],
        },
      ],
    });

    const harness = buildHarness(adapter);
    const result = await runTaskPipeline(makeInput(), harness.pipelineOptions);

    expect(result.finalState.status).toBe("completed");
    // Two cycles consumed: one Reviewer→Fixer, one Boss→Fixer.
    expect(result.finalState.reviewCycles).toBe(2);
    expect(adapter.callsByAgent.get(bossAgent.systemPrompt)).toBe(2);
    expect(adapter.callsByAgent.get(fixerAgent.systemPrompt)).toBe(2);
    expect(adapter.callsByAgent.get(reviewerAgent.systemPrompt)).toBe(3);

    // The latest artifact version is v3 (v1 = Coder, v2 = Reviewer-fix,
    // v3 = Boss-fix).
    expect(result.currentArtifactVersion).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — direct TaskPipeline class usage
// ---------------------------------------------------------------------------

describe("TaskPipeline — class form mirrors runTaskPipeline", () => {
  it("produces the same outcome whether invoked via the class or the free function", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [
        { content: "fn main() {}\n", fileName: "main.rs" },
      ],
      [reviewerAgent.systemPrompt]: [
        { defects: [{ id: "d", description: "x", severity: "low" }] },
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
    const pipeline = new TaskPipeline(harness.pipelineOptions);
    const result = await pipeline.runTask(makeInput());

    expect(result.finalState.status).toBe("completed");
    expect(result.finalState.reviewCycles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Staging Workspace Integration (Phase 3.3a)
// ---------------------------------------------------------------------------

import { StagingWorkspaceManager } from "../artifacts/staging.js";

describe("TaskPipeline — Staging Workspace Integration (Phase 3.3a)", () => {
  it("pipeline calls initializeWorkspace when staging is provided", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [
        { content: "fn main() {}\n", fileName: "main.rs" },
      ],
      [reviewerAgent.systemPrompt]: [
        { defects: [{ id: "d", description: "x", severity: "low" }] },
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

    let initWorkspaceCalled = false;
    let initWorkspaceTaskId = "";

    // Create a mock staging manager that intercepts initializeWorkspace
    const mockStaging = {
      initializeWorkspace: async (taskId: string) => {
        initWorkspaceCalled = true;
        initWorkspaceTaskId = taskId;
        return "/mocked/staging/path";
      },
    } as unknown as StagingWorkspaceManager;

    const pipeline = new TaskPipeline({
      ...harness.pipelineOptions,
      staging: mockStaging,
    });
    const result = await pipeline.runTask(makeInput());

    expect(result.finalState.status).toBe("completed");
    expect(initWorkspaceCalled).toBe(true);
    expect(initWorkspaceTaskId).toBe(TASK_ID);
  });

  it("pipeline works without staging", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [
        { content: "fn main() {}\n", fileName: "main.rs" },
      ],
      [reviewerAgent.systemPrompt]: [
        { defects: [{ id: "d", description: "x", severity: "low" }] },
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
    const pipeline = new TaskPipeline({
      ...harness.pipelineOptions,
      // No staging option provided
    });
    const result = await pipeline.runTask(makeInput());

    expect(result.finalState.status).toBe("completed");
  });

  it("pipeline fails safely if initializeWorkspace throws", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [
        { content: "fn main() {}\n", fileName: "main.rs" },
      ],
      [reviewerAgent.systemPrompt]: [
        { defects: [{ id: "d", description: "x", severity: "low" }] },
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

    const mockStaging = {
      initializeWorkspace: async () => {
        throw new Error("Staging disk full or permission error");
      },
    } as unknown as StagingWorkspaceManager;

    const pipeline = new TaskPipeline({
      ...harness.pipelineOptions,
      staging: mockStaging,
    });
    const result = await pipeline.runTask(makeInput());

    // Should fail safely and transition to 'error' status
    expect(result.finalState.status).toBe("error");
    
    // No agent calls should have been made
    expect(adapter.callsByAgent.get(researcherAgent.systemPrompt) ?? 0).toBe(0);
    expect(adapter.callsByAgent.get(coderAgent.systemPrompt) ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Staging Workspace Apply on Complete (Phase 3.3b)
// ---------------------------------------------------------------------------

describe("TaskPipeline — Staging Workspace Apply on Complete (Phase 3.3b)", () => {
  it("completed path calls applyToProject with artifact fileNames", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [
        { content: "fn main() {}\n", fileName: "main.rs" },
      ],
      [reviewerAgent.systemPrompt]: [
        { defects: [{ id: "d", description: "x", severity: "low" }] },
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

    let applyToProjectCalled = false;
    let appliedFileNames: string[] = [];

    const mockStaging = {
      initializeWorkspace: async () => "/mock/path",
      applyToProject: async (taskId: string, fileNames: string[]) => {
        applyToProjectCalled = true;
        appliedFileNames = fileNames;
      },
    } as unknown as StagingWorkspaceManager;

    const pipeline = new TaskPipeline({
      ...harness.pipelineOptions,
      staging: mockStaging,
      artifactStore: harness.artifactStore,
    });
    const result = await pipeline.runTask(makeInput());

    expect(result.finalState.status).toBe("completed");
    expect(applyToProjectCalled).toBe(true);
    expect(appliedFileNames).toContain("main.rs");
  });

  it("completed path does not call applyToProject when staging is missing", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [
        { content: "fn main() {}\n", fileName: "main.rs" },
      ],
      [reviewerAgent.systemPrompt]: [
        { defects: [{ id: "d", description: "x", severity: "low" }] },
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
    const pipeline = new TaskPipeline({
      ...harness.pipelineOptions,
      staging: undefined,
      artifactStore: harness.artifactStore,
    });
    const result = await pipeline.runTask(makeInput());

    expect(result.finalState.status).toBe("completed");
  });

  it("completed path does not call applyToProject when artifactStore is missing", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [
        { content: "fn main() {}\n", fileName: "main.rs" },
      ],
      [reviewerAgent.systemPrompt]: [
        { defects: [{ id: "d", description: "x", severity: "low" }] },
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

    let applyToProjectCalled = false;
    const mockStaging = {
      initializeWorkspace: async () => "/mock/path",
      applyToProject: async () => {
        applyToProjectCalled = true;
      },
    } as unknown as StagingWorkspaceManager;

    const pipeline = new TaskPipeline({
      ...harness.pipelineOptions,
      staging: mockStaging,
      artifactStore: undefined,
    });
    const result = await pipeline.runTask(makeInput());

    expect(result.finalState.status).toBe("completed");
    expect(applyToProjectCalled).toBe(false);
  });

  it("error path does not call applyToProject", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: new Error("Researcher broke"),
    });

    const harness = buildHarness(adapter);

    let applyToProjectCalled = false;
    const mockStaging = {
      initializeWorkspace: async () => "/mock/path",
      applyToProject: async () => {
        applyToProjectCalled = true;
      },
    } as unknown as StagingWorkspaceManager;

    const pipeline = new TaskPipeline({
      ...harness.pipelineOptions,
      staging: mockStaging,
      artifactStore: harness.artifactStore,
    });
    const result = await pipeline.runTask(makeInput());

    expect(result.finalState.status).toBe("error");
    expect(applyToProjectCalled).toBe(false);
  });

  it("stopped_limit path does not call applyToProject", async () => {
    const cappedState: TaskState = {
      ...initialState,
      maxReviewCycles: 1,
    };

    const reviewerDefect = (id: string) => ({
      defects: [
        {
          id,
          description: `defect ${id}`,
          severity: "medium",
        },
      ],
    });

    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [{ content: "v0\n", fileName: "main.txt" }],
      [reviewerAgent.systemPrompt]: [
        reviewerDefect("d-1"),
        reviewerDefect("d-2"),
      ],
      [fixerAgent.systemPrompt]: [
        { content: "v1\n" },
      ],
      [bossAgent.systemPrompt]: [],
    });

    const harness = buildHarness(adapter);

    let applyToProjectCalled = false;
    const mockStaging = {
      initializeWorkspace: async () => "/mock/path",
      applyToProject: async () => {
        applyToProjectCalled = true;
      },
    } as unknown as StagingWorkspaceManager;

    const pipeline = new TaskPipeline({
      ...harness.pipelineOptions,
      staging: mockStaging,
      artifactStore: harness.artifactStore,
    });
    const result = await pipeline.runTask(makeInput(cappedState));

    expect(result.finalState.status).toBe("stopped_limit");
    expect(applyToProjectCalled).toBe(false);
  });

  it("applyToProject failure returns safe error result", async () => {
    const adapter = new ScriptedAdapter({
      [researcherAgent.systemPrompt]: ["enriched"],
      [coderAgent.systemPrompt]: [
        { content: "fn main() {}\n", fileName: "main.rs" },
      ],
      [reviewerAgent.systemPrompt]: [
        { defects: [{ id: "d", description: "x", severity: "low" }] },
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

    const mockStaging = {
      initializeWorkspace: async () => "/mock/path",
      applyToProject: async () => {
        throw new Error("Disk permission denied during apply");
      },
    } as unknown as StagingWorkspaceManager;

    const pipeline = new TaskPipeline({
      ...harness.pipelineOptions,
      staging: mockStaging,
      artifactStore: harness.artifactStore,
    });
    const result = await pipeline.runTask(makeInput());

    expect(result.finalState.status).toBe("error");
    expect(result.finalReport).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 7 — End-to-End Staging Pipeline (Phase 3.5)
// ---------------------------------------------------------------------------

describe("TaskPipeline — End-to-End Staging Pipeline (Phase 3.5)", () => {
  const getTestDir = () => path.resolve(process.cwd(), ".karo", `temp-e2e-project-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);

  async function createE2EProject(testDir: string, testCommandOverride?: string) {
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(path.join(testDir, "src"), { recursive: true });

    const packageJson = {
      name: "e2e-test-project",
      version: "1.0.0",
      type: "commonjs",
      scripts: {
        test: testCommandOverride || "node src/math.test.js",
      }
    };

    const mathJs = `
function add(a, b) {
  return a + b;
}
module.exports = { add };
`;

    const mathTestJs = `
const { add } = require('./math.js');
if (add(2, 2) !== 4) {
  console.error('Test failed: 2 + 2 !== 4');
  process.exit(1);
}
console.log('All tests passed');
process.exit(0);
`;

    await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify(packageJson, null, 2));
    await fs.writeFile(path.join(testDir, "src", "math.js"), mathJs);
    await fs.writeFile(path.join(testDir, "src", "math.test.js"), mathTestJs);
  }

  async function cleanupE2EProject(testDir: string) {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }

  it("E2E happy path: failing -> fixing -> passing with actual ShellRunner and StagingWorkspaceManager", async () => {
    const testDir = getTestDir();
    await createE2EProject(testDir);

    try {
      const staging = new StagingWorkspaceManager(testDir);
      const shellRunner = new ShellRunner();
      const traceBus = new TraceEventBus({
        backend: new InMemoryTraceEventStoreBackend(),
      });
      const artifactStore = new ArtifactStore({
        backend: new InMemoryArtifactStoreBackend(),
        staging,
      });

      const adapter = new ScriptedAdapter({
        [researcherAgent.systemPrompt]: ["enriched: update math.js"],
        [coderAgent.systemPrompt]: [
          {
            content: `
function add(a, b) {
  return a + b + 999; // Coder writes broken implementation!
}
module.exports = { add };
`,
            fileName: "src/math.js",
          },
        ],
        [reviewerAgent.systemPrompt]: [
          // 1st review pass: One defect found because tests failed.
          {
            defects: [
              {
                id: "def-1",
                description: "The add function is incorrect",
                severity: "high",
              },
            ],
          },
          // 2nd review pass: No defects because tests passed.
          { kind: "noDefects", summary: "All green" },
        ],
        [fixerAgent.systemPrompt]: [
          // Fixer writes correct implementation!
          {
            content: `
function add(a, b) {
  return a + b;
}
module.exports = { add };
`,
          },
        ],
        [bossAgent.systemPrompt]: [
          {
            kind: "approved",
            verdict: BOSS_VERDICT_RUSSIAN.approved,
            notes: ["Excellent fix!"],
          },
        ],
      });

      const history = new InMemoryMessageHistoryStore();
      const taskStore = new InMemoryTaskStateStore();

      const actualReviewer = new ReviewerAgent({
        modelAdapter: adapter,
        messageHistoryStore: history,
        artifactStore,
        traceBus,
        idGenerator: () => "defect-id",
        staging,
        shellRunner,
        testCommandDetector: detectTestCommand,
        allowAutoDetectedTestCommand: true,
      });

      const research = new ResearcherAgent({ modelAdapter: adapter, messageHistoryStore: history, traceBus });
      const coder = new CoderAgent({
        modelAdapter: adapter,
        messageHistoryStore: history,
        artifactStore,
        traceBus,
        idGenerator: () => "art-1",
        defaultFileName: "src/math.js",
      });
      const fixer = new FixerAgent({ modelAdapter: adapter, messageHistoryStore: history, artifactStore, traceBus });
      const boss = new BossAgent({ modelAdapter: adapter, messageHistoryStore: history, agent: bossAgent });

      const pipelineOptions: TaskPipelineOptions = {
        store: taskStore,
        messageHistoryStore: history,
        traceBus,
        staging,
        artifactStore,
        participants: {
          researcher: { agent: researcherAgent, runner: research },
          coder: { agent: coderAgent, runner: coder },
          reviewer: { agent: reviewerAgent, runner: actualReviewer },
          fixer: { agent: fixerAgent, runner: fixer },
          boss: { agent: bossAgent, runner: boss },
        },
      };

      // Verify that the real project is NOT modified before completed
      const originalRealContent = await fs.readFile(path.join(testDir, "src", "math.js"), "utf8");
      expect(originalRealContent).toContain("return a + b;");

      const result = await runTaskPipeline(makeInput(), pipelineOptions);

      expect(result.finalState.status).toBe("completed");

      // Verify that after completed, the correct math.js is written back
      const finalRealContent = await fs.readFile(path.join(testDir, "src", "math.js"), "utf8");
      expect(finalRealContent).toContain("module.exports = { add };");
      expect(finalRealContent).not.toContain("a + b + 999");

      // Verify staging directory is cleaned up
      const stagingPath = staging.getStagingRoot(TASK_ID);
      const stagingExists = await fs.access(stagingPath).then(() => true).catch(() => false);
      expect(stagingExists).toBe(false);

    } finally {
      await cleanupE2EProject(testDir);
    }
  });

  it("E2E negative: pipeline stopped_limit (failing tests) -> projectRoot not modified, staging preserved", async () => {
    const testDir = getTestDir();
    await createE2EProject(testDir);

    try {
      const staging = new StagingWorkspaceManager(testDir);
      const shellRunner = new ShellRunner();
      const traceBus = new TraceEventBus({
        backend: new InMemoryTraceEventStoreBackend(),
      });
      const artifactStore = new ArtifactStore({
        backend: new InMemoryArtifactStoreBackend(),
        staging,
      });

      const adapter = new ScriptedAdapter({
        [researcherAgent.systemPrompt]: ["enriched: update math.js"],
        [coderAgent.systemPrompt]: [
          {
            content: `
function add(a, b) {
  return a + b + 999; // BROKEN!
}
module.exports = { add };
`,
            fileName: "src/math.js",
          },
        ],
        [reviewerAgent.systemPrompt]: [
          {
            defects: [
              {
                id: "def-1",
                description: "Broken add function",
                severity: "high",
              },
            ],
          },
          {
            defects: [
              {
                id: "def-2",
                description: "Still broken",
                severity: "high",
              },
            ],
          },
        ],
        [fixerAgent.systemPrompt]: [
          {
            content: `
function add(a, b) {
  return a + b + 999; // Still broken!
}
module.exports = { add };
`,
          },
        ],
        [bossAgent.systemPrompt]: [],
      });

      const history = new InMemoryMessageHistoryStore();
      const taskStore = new InMemoryTaskStateStore();

      const actualReviewer = new ReviewerAgent({
        modelAdapter: adapter,
        messageHistoryStore: history,
        artifactStore,
        traceBus,
        staging,
        shellRunner,
        testCommandDetector: detectTestCommand,
        allowAutoDetectedTestCommand: true,
      });

      const research = new ResearcherAgent({ modelAdapter: adapter, messageHistoryStore: history, traceBus });
      const coder = new CoderAgent({
        modelAdapter: adapter,
        messageHistoryStore: history,
        artifactStore,
        traceBus,
        idGenerator: () => "art-1",
        defaultFileName: "src/math.js",
      });
      const fixer = new FixerAgent({ modelAdapter: adapter, messageHistoryStore: history, artifactStore, traceBus });
      const boss = new BossAgent({ modelAdapter: adapter, messageHistoryStore: history, agent: bossAgent });

      const cappedState = {
        ...initialState,
        maxReviewCycles: 1, // Stop early
      };

      const pipelineOptions: TaskPipelineOptions = {
        store: taskStore,
        messageHistoryStore: history,
        traceBus,
        staging,
        artifactStore,
        participants: {
          researcher: { agent: researcherAgent, runner: research },
          coder: { agent: coderAgent, runner: coder },
          reviewer: { agent: reviewerAgent, runner: actualReviewer },
          fixer: { agent: fixerAgent, runner: fixer },
          boss: { agent: bossAgent, runner: boss },
        },
      };

      const result = await runTaskPipeline(makeInput(cappedState), pipelineOptions);

      expect(result.finalState.status).toBe("stopped_limit");

      // Verify that the real project is NOT modified (original returns a + b)
      const realContent = await fs.readFile(path.join(testDir, "src", "math.js"), "utf8");
      expect(realContent).toContain("return a + b;");
      expect(realContent).not.toContain("a + b + 999");

      // Verify staging directory is PRESERVED for debugging
      const stagingPath = staging.getStagingRoot(TASK_ID);
      const stagingExists = await fs.access(stagingPath).then(() => true).catch(() => false);
      expect(stagingExists).toBe(true);

    } finally {
      await cleanupE2EProject(testDir);
    }
  });

  it("E2E negative: auto-detected command requires consent -> transitions to waiting_consent and can be resumed", async () => {
    const testDir = getTestDir();
    await createE2EProject(testDir);

    try {
      const staging = new StagingWorkspaceManager(testDir);
      const shellRunner = new ShellRunner();
      const traceBus = new TraceEventBus({
        backend: new InMemoryTraceEventStoreBackend(),
      });
      const artifactStore = new ArtifactStore({
        backend: new InMemoryArtifactStoreBackend(),
        staging,
      });

      const adapter1 = new ScriptedAdapter({
        [researcherAgent.systemPrompt]: ["enriched: update math.js"],
        [coderAgent.systemPrompt]: [
          {
            content: `
function add(a, b) {
  return a + b + 999;
}
module.exports = { add };
`,
            fileName: "src/math.js",
          },
        ],
        [reviewerAgent.systemPrompt]: [], // Will fail before reviewer is called
      });

      const history = new InMemoryMessageHistoryStore();
      const taskStore = new InMemoryTaskStateStore();

      const actualReviewer = new ReviewerAgent({
        modelAdapter: adapter1,
        messageHistoryStore: history,
        artifactStore,
        traceBus,
        staging,
        shellRunner,
        testCommandDetector: detectTestCommand,
        allowAutoDetectedTestCommand: false, // DO NOT ALLOW package scripts -> requires consent
      });

      const research = new ResearcherAgent({ modelAdapter: adapter1, messageHistoryStore: history, traceBus });
      const coder = new CoderAgent({
        modelAdapter: adapter1,
        messageHistoryStore: history,
        artifactStore,
        traceBus,
        idGenerator: () => "art-1",
        defaultFileName: "src/math.js",
      });
      const fixer = new FixerAgent({ modelAdapter: adapter1, messageHistoryStore: history, artifactStore, traceBus });
      const boss = new BossAgent({ modelAdapter: adapter1, messageHistoryStore: history, agent: bossAgent });

      const cappedState1 = {
        ...initialState,
        id: "task-pipeline-1",
        maxReviewCycles: 2,
      };

      const pipelineOptions: TaskPipelineOptions = {
        store: taskStore,
        messageHistoryStore: history,
        traceBus,
        staging,
        artifactStore,
        participants: {
          researcher: { agent: researcherAgent, runner: research },
          coder: { agent: coderAgent, runner: coder },
          reviewer: { agent: reviewerAgent, runner: actualReviewer },
          fixer: { agent: fixerAgent, runner: fixer },
          boss: { agent: bossAgent, runner: boss },
        },
      };

      const result = await runTaskPipeline(makeInput(cappedState1), pipelineOptions);

      // Verify task status is waiting_consent
      expect(result.finalState.status).toBe("waiting_consent");

      // Verify that activeConsentRequests has a entry for this task
      const req = activeConsentRequests.get(result.finalState.id);
      expect(req).toBeDefined();
      expect(req?.command).toBe("npm");
      expect(req?.args).toContain("test");
      expect(req?.cwd).toContain(".karo");

      // Verify that Reviewer model was NOT called yet
      let reviewerCalls = adapter1.calls.filter(c => c.options.systemPrompt === reviewerAgent.systemPrompt);
      expect(reviewerCalls.length).toBe(0);

      // 1. Resume with reject
      // We will create a fresh run that also requires consent, then resume with reject
      const adapter2 = new ScriptedAdapter({
        [researcherAgent.systemPrompt]: ["enriched: update math.js"],
        [coderAgent.systemPrompt]: [
          {
            content: `
function add(a, b) {
  return a + b + 999;
}
module.exports = { add };
`,
            fileName: "src/math.js",
          },
        ],
        [reviewerAgent.systemPrompt]: [
          {
            defects: [
              {
                id: "def-1",
                description: "Static analysis defect",
                severity: "high",
              },
            ],
          },
          { kind: "noDefects", summary: "All good on static review" },
        ],
        [fixerAgent.systemPrompt]: [
          {
            content: `
function add(a, b) {
  return a + b;
}
module.exports = { add };
`,
          },
        ],
        [bossAgent.systemPrompt]: [
          {
            kind: "approved",
            verdict: BOSS_VERDICT_RUSSIAN.approved,
            notes: ["Looks good"],
          },
        ],
      });

      const taskStore2 = new InMemoryTaskStateStore();
      const history2 = new InMemoryMessageHistoryStore();
      const actualReviewer2 = new ReviewerAgent({
        modelAdapter: adapter2,
        messageHistoryStore: history2,
        artifactStore,
        traceBus,
        staging,
        shellRunner,
        testCommandDetector: detectTestCommand,
        allowAutoDetectedTestCommand: false,
      });

      const research2 = new ResearcherAgent({ modelAdapter: adapter2, messageHistoryStore: history2, traceBus });
      const coder2 = new CoderAgent({
        modelAdapter: adapter2,
        messageHistoryStore: history2,
        artifactStore,
        traceBus,
        idGenerator: () => "art-2",
        defaultFileName: "src/math.js",
      });
      const fixer2 = new FixerAgent({ modelAdapter: adapter2, messageHistoryStore: history2, artifactStore, traceBus });
      const boss2 = new BossAgent({ modelAdapter: adapter2, messageHistoryStore: history2, agent: bossAgent });

      const cappedState2 = {
        ...initialState,
        id: "task-pipeline-2",
        maxReviewCycles: 2,
      };
      const pipelineOptions2 = {
        ...pipelineOptions,
        store: taskStore2,
        messageHistoryStore: history2,
        participants: {
          researcher: { agent: researcherAgent, runner: research2 },
          coder: { agent: coderAgent, runner: coder2 },
          reviewer: { agent: reviewerAgent, runner: actualReviewer2 },
          fixer: { agent: fixerAgent, runner: fixer2 },
          boss: { agent: bossAgent, runner: boss2 },
        },
      };

      const result2 = await runTaskPipeline(makeInput(cappedState2), pipelineOptions2);
      expect(result2.finalState.status).toBe("waiting_consent");

      const resumeRejectResult = await resumeTask(result2.finalState.id, { kind: "reject" }, {
        ...pipelineOptions2,
        apiKey,
        defaultModel,
      });

      expect(resumeRejectResult.finalState.status).toBe("completed");

      // 2. Resume with cancel
      const adapter3 = new ScriptedAdapter({
        [researcherAgent.systemPrompt]: ["enriched: update math.js"],
        [coderAgent.systemPrompt]: [
          {
            content: `
function add(a, b) {
  return a + b + 999;
}
module.exports = { add };
`,
            fileName: "src/math.js",
          },
        ],
      });

      const taskStore3 = new InMemoryTaskStateStore();
      const history3 = new InMemoryMessageHistoryStore();
      const actualReviewer3 = new ReviewerAgent({
        modelAdapter: adapter3,
        messageHistoryStore: history3,
        artifactStore,
        traceBus,
        staging,
        shellRunner,
        testCommandDetector: detectTestCommand,
        allowAutoDetectedTestCommand: false,
      });

      const research3 = new ResearcherAgent({ modelAdapter: adapter3, messageHistoryStore: history3, traceBus });
      const coder3 = new CoderAgent({
        modelAdapter: adapter3,
        messageHistoryStore: history3,
        artifactStore,
        traceBus,
        idGenerator: () => "art-3",
        defaultFileName: "src/math.js",
      });
      const fixer3 = new FixerAgent({ modelAdapter: adapter3, messageHistoryStore: history3, artifactStore, traceBus });
      const boss3 = new BossAgent({ modelAdapter: adapter3, messageHistoryStore: history3, agent: bossAgent });

      const cappedState3 = {
        ...initialState,
        id: "task-pipeline-3",
        maxReviewCycles: 2,
      };
      const pipelineOptions3 = {
        ...pipelineOptions,
        store: taskStore3,
        messageHistoryStore: history3,
        participants: {
          researcher: { agent: researcherAgent, runner: research3 },
          coder: { agent: coderAgent, runner: coder3 },
          reviewer: { agent: reviewerAgent, runner: actualReviewer3 },
          fixer: { agent: fixerAgent, runner: fixer3 },
          boss: { agent: bossAgent, runner: boss3 },
        },
      };

      const result3 = await runTaskPipeline(makeInput(cappedState3), pipelineOptions3);
      expect(result3.finalState.status).toBe("waiting_consent");

      const resumeCancelResult = await resumeTask(result3.finalState.id, { kind: "cancel" }, {
        ...pipelineOptions3,
        apiKey,
        defaultModel,
      });
      expect(resumeCancelResult.finalState.status).toBe("stopped_limit");

      // Verify that the real project is NOT modified
      const realContent = await fs.readFile(path.join(testDir, "src", "math.js"), "utf8");
      expect(realContent).toContain("return a + b;");

    } finally {
      await cleanupE2EProject(testDir);
    }
  });

  it("E2E negative: testCommandDetector blocks dangerous script -> ShellRunner not executed", async () => {
    const testDir = getTestDir();
    // Test command with illegal chained shell sequences (blocked by testCommandDetector)
    await createE2EProject(testDir, "node src/math.test.js && rm -rf /");

    try {
      const staging = new StagingWorkspaceManager(testDir);
      const shellRunner = new ShellRunner();
      const traceBus = new TraceEventBus({
        backend: new InMemoryTraceEventStoreBackend(),
      });
      const artifactStore = new ArtifactStore({
        backend: new InMemoryArtifactStoreBackend(),
        staging,
      });

      const adapter = new ScriptedAdapter({
        [researcherAgent.systemPrompt]: ["enriched: update math.js"],
        [coderAgent.systemPrompt]: [
          {
            content: `
function add(a, b) {
  return a + b + 999;
}
module.exports = { add };
`,
            fileName: "src/math.js",
          },
        ],
        [reviewerAgent.systemPrompt]: [
          {
            defects: [
              {
                id: "def-1",
                description: "Broken add function",
                severity: "high",
              },
            ],
          },
        ],
        [fixerAgent.systemPrompt]: [],
        [bossAgent.systemPrompt]: [],
      });

      const history = new InMemoryMessageHistoryStore();
      const taskStore = new InMemoryTaskStateStore();

      const actualReviewer = new ReviewerAgent({
        modelAdapter: adapter,
        messageHistoryStore: history,
        artifactStore,
        traceBus,
        staging,
        shellRunner,
        testCommandDetector: detectTestCommand,
        allowAutoDetectedTestCommand: true, // Allow, but the script is dangerous so detector will block it!
      });

      const research = new ResearcherAgent({ modelAdapter: adapter, messageHistoryStore: history, traceBus });
      const coder = new CoderAgent({
        modelAdapter: adapter,
        messageHistoryStore: history,
        artifactStore,
        traceBus,
        idGenerator: () => "art-1",
        defaultFileName: "src/math.js",
      });
      const fixer = new FixerAgent({ modelAdapter: adapter, messageHistoryStore: history, artifactStore, traceBus });
      const boss = new BossAgent({ modelAdapter: adapter, messageHistoryStore: history, agent: bossAgent });

      const cappedState = {
        ...initialState,
        maxReviewCycles: 1,
      };

      const pipelineOptions: TaskPipelineOptions = {
        store: taskStore,
        messageHistoryStore: history,
        traceBus,
        staging,
        artifactStore,
        participants: {
          researcher: { agent: researcherAgent, runner: research },
          coder: { agent: coderAgent, runner: coder },
          reviewer: { agent: reviewerAgent, runner: actualReviewer },
          fixer: { agent: fixerAgent, runner: fixer },
          boss: { agent: bossAgent, runner: boss },
        },
      };

      await runTaskPipeline(makeInput(cappedState), pipelineOptions);

      // Verify that Reviewer received the <test_command_blocked> block in messages context
      const reviewerCalls = adapter.calls.filter(c => c.options.systemPrompt === reviewerAgent.systemPrompt);
      expect(reviewerCalls.length).toBeGreaterThan(0);
      const messages = reviewerCalls[0].messages;
      const lastMessage = messages[messages.length - 1];
      expect(lastMessage.payload.kind).toBe("text");
      expect(lastMessage.payload.text).toContain("<test_command_blocked>");
      expect(lastMessage.payload.text).toContain("Reason:");

      // Verify that the real project is NOT modified (original returns a + b)
      const realContent = await fs.readFile(path.join(testDir, "src", "math.js"), "utf8");
      expect(realContent).toContain("return a + b;");
      expect(realContent).not.toContain("a + b + 999");

    } finally {
      await cleanupE2EProject(testDir);
    }
  });
});

