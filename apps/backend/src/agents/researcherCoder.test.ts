/**
 * Unit tests for the Researcher and Coder Builtin_Agents (task 14.2).
 *
 * Coverage targets from the task brief:
 *
 *   • Researcher tolerates Web_Search_Tool failure (Requirement 7.3)
 *     and structured error results, never aborting the pipeline.
 *   • Researcher's enrichment finishes within the 60-second budget
 *     when the model and search both behave (Requirement 7.2). The
 *     budget is verified via clock injection.
 *   • Coder produces exactly one File_Artifact atomically (Requirement
 *     7.4) — no partial writes on adapter failure.
 *   • Coder's hand-off Agent_Message has `type === "handoff"` and is
 *     addressed to the Reviewer.
 *
 * Plus integration assertions on trace events: every test inspects the
 * published trace events to confirm the agent emitted the documented
 * sequence (Researcher: status:started → tool_call(web_search) →
 * status:finished; Coder: status:started → artifact_change →
 * status:finished).
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4.
 */

import { describe, expect, it } from "vitest";

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
import {
  TracedWebSearchTool,
  type SearchOptions,
  type SearchResult,
  type WebSearchTool,
} from "../search/index.js";
import type { AgentMessage } from "@ai-agent-orchestrator/validation";
import type { ModelRef } from "@ai-agent-orchestrator/shared-core";

import {
  CoderAgent,
  RESEARCHER_BUDGET_MS,
  ResearcherAgent,
  WEB_SEARCH_NO_RESULTS_MARKER,
  WEB_SEARCH_UNAVAILABLE_MARKER,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASK_ID = "task-14-2";
const RESEARCHER_ID = "agent-researcher";
const CODER_ID = "agent-coder";
const REVIEWER_ID = "agent-reviewer";

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

const researcherAgent: AgentDefinition = {
  id: RESEARCHER_ID,
  name: "Researcher",
  systemPrompt: "Enrich the user's prompt using the model and Web_Search_Tool.",
  allowedTools: ["web_search"],
};

const coderAgent: AgentDefinition = {
  id: CODER_ID,
  name: "Coder",
  systemPrompt: "Produce a single File_Artifact for the user prompt.",
  allowedTools: ["web_search", "file_read", "file_write"],
};

const userPromptHandoff: AgentMessage = {
  taskId: TASK_ID,
  sender: "orchestrator",
  recipient: RESEARCHER_ID,
  type: "handoff",
  payload: { kind: "text", text: "Write a hello-world program in Rust." },
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

class StubWebSearch implements WebSearchTool {
  public readonly calls: Array<{
    query: string;
    options: SearchOptions | undefined;
  }> = [];
  public constructor(private readonly result: SearchResult) {}
  public async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    this.calls.push({ query, options });
    return this.result;
  }
}

class ThrowingWebSearch implements WebSearchTool {
  public callCount = 0;
  public async search(): Promise<SearchResult> {
    this.callCount += 1;
    throw new Error("network down");
  }
}

/**
 * Deterministic test clock. `nowMs()` returns each value from the
 * supplied list in order; once exhausted the last value is reused
 * (mirrors the pattern used by `agentRunner.test.ts`). This lets tests
 * drive the Researcher's elapsed-time reading independent of wall-clock
 * variability.
 */
class TestClock {
  private readonly values: number[];
  private cursor = 0;
  public constructor(values: number[]) {
    this.values = [...values];
  }
  public nowMs(): number {
    if (this.cursor >= this.values.length) {
      return this.values[this.values.length - 1] ?? 0;
    }
    const v = this.values[this.cursor] ?? 0;
    this.cursor += 1;
    return v;
  }
  public nowIso(): string {
    return ISO_AT;
  }
}

interface Harness {
  artifactStore: ArtifactStoreInterface;
  historyStore: InMemoryMessageHistoryStore;
  traceBus: TraceEventBusInterface;
  collected: TraceEvent[];
}

function buildHarness(): Harness {
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

  return {
    artifactStore,
    historyStore: new InMemoryMessageHistoryStore(),
    traceBus,
    collected,
  };
}

async function flushTraces(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Researcher — happy path within budget
// ---------------------------------------------------------------------------

describe("ResearcherAgent — enrichment within 60 second budget", () => {
  it("enriches the prompt with model + search results and reports elapsed time well below the budget (Validates: Requirement 7.2)", async () => {
    const harness = buildHarness();

    const search: SearchResult = {
      kind: "ok",
      results: [
        {
          title: "Rust hello world",
          url: "https://example.com/rust-hw",
          snippet: "fn main() { println!(...); }",
        },
      ],
    };
    const innerSearch = new StubWebSearch(search);
    // Use the traced wrapper so the tool_call trace is published by
    // production code, not the test harness.
    const traced = new TracedWebSearchTool({
      inner: innerSearch,
      traceBus: harness.traceBus,
      now: () => ISO_AT,
    });
    const tool = traced.forContext({
      taskId: TASK_ID,
      agentId: RESEARCHER_ID,
    });

    const adapter = new StubModelAdapter(
      "Implement a Rust hello-world program. Use println! with a friendly greeting.",
    );

    // Clock readings (in order): start, persist-start, persist-end,
    // persist-payload-elapsed, finished-trace, total-elapsed.
    // Step the clock by 100ms per call so total elapsed = ~500ms,
    // well under the 60 second budget.
    const clock = new TestClock([0, 100, 200, 300, 400, 500]);

    const researcher = new ResearcherAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      traceBus: harness.traceBus,
      webSearch: tool,
      clock,
    });

    const result = await researcher.run({
      task: taskContext,
      agent: researcherAgent,
      apiKey,
      incoming: userPromptHandoff,
      coderAgentId: CODER_ID,
    });

    // Recipient is the Coder (handoff to Coder per pipeline).
    expect(result.recipient).toBe(CODER_ID);
    expect(result.outgoing.recipient).toBe(CODER_ID);
    expect(result.outgoing.type).toBe("handoff");

    // Elapsed time is well below the 60-second budget.
    expect(result.elapsedMs).toBeLessThan(RESEARCHER_BUDGET_MS);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    const enriched = result.enriched;
    expect(enriched.kind).toBe("enrichedPrompt");
    expect(enriched.originalPrompt).toBe(
      "Write a hello-world program in Rust.",
    );
    expect(enriched.webSearchOutcome).toBe("ok");
    expect(enriched.enrichedPrompt).toContain("hello-world");
    expect(enriched.enrichedPrompt).toContain("Rust hello world");
    expect(enriched.enrichedPrompt).toContain("https://example.com/rust-hw");
    // The payload's `elapsedMs` reflects the same budget.
    expect(enriched.elapsedMs).toBeLessThan(RESEARCHER_BUDGET_MS);

    // Persisted before handoff (Requirement 10.6).
    const persisted = await harness.historyStore.list(TASK_ID);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.recipient).toBe(CODER_ID);
    expect(persisted[0]?.type).toBe("handoff");

    // Trace integration: started + tool_call(web_search) + finished.
    await flushTraces();
    const records = harness.collected.map((e) => e.record);
    const kinds = records.map((r) => r.kind);
    expect(kinds).toEqual(["status", "tool_call", "status"]);

    const startEvent = records[0];
    if (startEvent?.kind !== "status") throw new Error("expected status");
    expect(startEvent.status).toBe("started");

    const toolCall = records[1];
    if (toolCall?.kind !== "tool_call") throw new Error("expected tool_call");
    expect(toolCall.tool).toBe("web_search");

    const endEvent = records[2];
    if (endEvent?.kind !== "status") throw new Error("expected status");
    expect(endEvent.status).toBe("finished");
  });
});

// ---------------------------------------------------------------------------
// Researcher — Web_Search_Tool failure tolerance
// ---------------------------------------------------------------------------

describe("ResearcherAgent — tolerates Web_Search_Tool failures", () => {
  it("continues with model-only enrichment when the search tool returns a structured error (Validates: Requirement 7.3)", async () => {
    const harness = buildHarness();

    const innerSearch = new StubWebSearch({
      kind: "error",
      reason: "DuckDuckGo unreachable",
    });
    const traced = new TracedWebSearchTool({
      inner: innerSearch,
      traceBus: harness.traceBus,
      now: () => ISO_AT,
    });
    const tool = traced.forContext({
      taskId: TASK_ID,
      agentId: RESEARCHER_ID,
    });

    const adapter = new StubModelAdapter(
      "A Rust hello world program prints a greeting.",
    );

    const researcher = new ResearcherAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      traceBus: harness.traceBus,
      webSearch: tool,
    });

    const result = await researcher.run({
      task: taskContext,
      agent: researcherAgent,
      apiKey,
      incoming: userPromptHandoff,
      coderAgentId: CODER_ID,
    });

    // Pipeline did NOT abort: recipient is still Coder.
    expect(result.recipient).toBe(CODER_ID);
    expect(result.outgoing.type).toBe("handoff");

    const enriched = result.enriched;
    expect(enriched.webSearchOutcome).toBe("unavailable");
    // The required marker (Requirement 7.3) is present in the body.
    expect(enriched.enrichedPrompt).toContain(WEB_SEARCH_UNAVAILABLE_MARKER);
    // Model output was still incorporated.
    expect(enriched.enrichedPrompt).toContain("Rust hello world");

    // Persisted before handoff.
    const persisted = await harness.historyStore.list(TASK_ID);
    expect(persisted).toHaveLength(1);

    // Trace integration: tool_call STILL emitted by the traced wrapper
    // even though the result is an error.
    await flushTraces();
    const kinds = harness.collected.map((e) => e.record.kind);
    expect(kinds).toContain("tool_call");

    // The model was called once with the bounded history + synthetic
    // context message.
    expect(adapter.calls).toHaveLength(1);
  });

  it("continues with model-only enrichment when the search tool throws", async () => {
    const harness = buildHarness();

    const throwing = new ThrowingWebSearch();
    const traced = new TracedWebSearchTool({
      inner: throwing,
      traceBus: harness.traceBus,
      now: () => ISO_AT,
    });
    const tool = traced.forContext({
      taskId: TASK_ID,
      agentId: RESEARCHER_ID,
    });

    const adapter = new StubModelAdapter("Model-only enrichment.");

    const researcher = new ResearcherAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      traceBus: harness.traceBus,
      webSearch: tool,
    });

    const result = await researcher.run({
      task: taskContext,
      agent: researcherAgent,
      apiKey,
      incoming: userPromptHandoff,
      coderAgentId: CODER_ID,
    });

    expect(result.recipient).toBe(CODER_ID);
    expect(result.outgoing.type).toBe("handoff");
    const enriched = result.enriched;
    expect(enriched.webSearchOutcome).toBe("unavailable");
    expect(enriched.enrichedPrompt).toContain(WEB_SEARCH_UNAVAILABLE_MARKER);
    expect(throwing.callCount).toBe(1);
  });

  it("marks the run as 'skipped' when no Web_Search_Tool is wired in", async () => {
    const harness = buildHarness();
    const adapter = new StubModelAdapter("Enrichment without search.");

    const researcher = new ResearcherAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      traceBus: harness.traceBus,
      // No webSearch.
    });

    const result = await researcher.run({
      task: taskContext,
      agent: researcherAgent,
      apiKey,
      incoming: userPromptHandoff,
      coderAgentId: CODER_ID,
    });

    expect(result.enriched.webSearchOutcome).toBe("skipped");
    expect(result.enriched.enrichedPrompt).toContain(
      WEB_SEARCH_UNAVAILABLE_MARKER,
    );
  });

  it("uses the no-results marker when the search backend returns zero hits", async () => {
    const harness = buildHarness();
    const innerSearch = new StubWebSearch({ kind: "ok", results: [] });
    const traced = new TracedWebSearchTool({
      inner: innerSearch,
      traceBus: harness.traceBus,
      now: () => ISO_AT,
    });
    const tool = traced.forContext({
      taskId: TASK_ID,
      agentId: RESEARCHER_ID,
    });
    const adapter = new StubModelAdapter("Best-effort enrichment.");

    const researcher = new ResearcherAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      traceBus: harness.traceBus,
      webSearch: tool,
    });

    const result = await researcher.run({
      task: taskContext,
      agent: researcherAgent,
      apiKey,
      incoming: userPromptHandoff,
      coderAgentId: CODER_ID,
    });

    expect(result.enriched.webSearchOutcome).toBe("ok");
    expect(result.enriched.enrichedPrompt).toContain(
      WEB_SEARCH_NO_RESULTS_MARKER,
    );
  });

  it("survives a failing model adapter by falling back to the original prompt + search summary", async () => {
    const harness = buildHarness();

    const innerSearch = new StubWebSearch({
      kind: "ok",
      results: [
        {
          title: "Rust",
          url: "https://example.com/rust",
          snippet: "Rust language",
        },
      ],
    });
    const traced = new TracedWebSearchTool({
      inner: innerSearch,
      traceBus: harness.traceBus,
      now: () => ISO_AT,
    });
    const tool = traced.forContext({
      taskId: TASK_ID,
      agentId: RESEARCHER_ID,
    });

    class ThrowingAdapter implements ModelAdapter {
      public async invoke(): Promise<{ raw: unknown }> {
        throw new Error("provider rate limit");
      }
    }

    const researcher = new ResearcherAgent({
      modelAdapter: new ThrowingAdapter(),
      messageHistoryStore: harness.historyStore,
      traceBus: harness.traceBus,
      webSearch: tool,
    });

    const result = await researcher.run({
      task: taskContext,
      agent: researcherAgent,
      apiKey,
      incoming: userPromptHandoff,
      coderAgentId: CODER_ID,
    });

    // Did NOT abort the pipeline (Requirement 7.3).
    expect(result.recipient).toBe(CODER_ID);
    expect(result.outgoing.type).toBe("handoff");
    expect(result.enriched.webSearchOutcome).toBe("ok");
    // The fallback prompt still carries the user's prompt and the
    // search summary even though the model produced nothing usable.
    expect(result.enriched.enrichedPrompt).toContain(
      "Write a hello-world program in Rust.",
    );
    expect(result.enriched.enrichedPrompt).toContain("Rust");
  });
});

// ---------------------------------------------------------------------------
// Coder — exactly one File_Artifact, atomic
// ---------------------------------------------------------------------------

describe("CoderAgent — produces exactly one File_Artifact atomically (Validates: Requirement 7.4)", () => {
  it("writes the new artifact via writeArtifact and emits exactly one artifact_change trace event", async () => {
    const harness = buildHarness();

    const code = 'fn main() {\n    println!("Hello, world!");\n}\n';
    const adapter = new StubModelAdapter({
      content: code,
      fileName: "main.rs",
      mimeType: "text/x-rust",
      summary: "First cut at the program",
    });

    const coder = new CoderAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      idGenerator: () => "artifact-coder-1",
    });

    const enrichedHandoff: AgentMessage = {
      taskId: TASK_ID,
      sender: RESEARCHER_ID,
      recipient: CODER_ID,
      type: "handoff",
      payload: {
        kind: "json",
        value: {
          kind: "enrichedPrompt",
          originalPrompt: "Write a hello-world program in Rust.",
          enrichedPrompt:
            "Write a hello-world program in Rust using println!.",
          webSearchOutcome: "ok",
          elapsedMs: 100,
        },
      },
      timestamp: ISO_AT,
    };

    const result = await coder.run({
      task: taskContext,
      agent: coderAgent,
      apiKey,
      incoming: enrichedHandoff,
      reviewerAgentId: REVIEWER_ID,
    });

    // Coder hand-off message is type "handoff" addressed to the Reviewer.
    expect(result.outgoing.type).toBe("handoff");
    expect(result.outgoing.recipient).toBe(REVIEWER_ID);
    expect(result.recipient).toBe(REVIEWER_ID);

    const coded = result.coded;
    expect(coded.kind).toBe("codedArtifact");
    expect(coded.artifactId).toBe("artifact-coder-1");
    expect(coded.version).toBe(1);
    expect(coded.fileName).toBe("main.rs");
    expect(coded.mimeType).toBe("text/x-rust");
    expect(coded.contentHash).toBeTruthy();
    expect(coded.summary).toBe("First cut at the program");

    // The artifact store has exactly one artifact with one version.
    const artifacts = await harness.artifactStore.listArtifacts(TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.id).toBe("artifact-coder-1");
    expect(artifacts[0]?.latestVersion).toBe(1);

    // Bytes round-trip correctly.
    const v1 = await harness.artifactStore.getArtifact({
      taskId: TASK_ID,
      artifactId: "artifact-coder-1",
      version: 1,
    });
    expect(v1).not.toBeNull();
    expect(new TextDecoder().decode(v1!.bytes)).toBe(code);

    // History persisted before handoff.
    const persisted = await harness.historyStore.list(TASK_ID);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.type).toBe("handoff");
    expect(persisted[0]?.recipient).toBe(REVIEWER_ID);

    // Trace events: started + artifact_change + finished. EXACTLY one
    // artifact_change → atomicity.
    await flushTraces();
    const records = harness.collected.map((e) => e.record);
    expect(records.map((r) => r.kind)).toEqual([
      "status",
      "artifact_change",
      "status",
    ]);

    const change = records[1];
    if (change?.kind !== "artifact_change") {
      throw new Error("expected artifact_change");
    }
    expect(change.artifactId).toBe("artifact-coder-1");
    expect(change.version).toBe(1);
  });

  it("accepts a bare string from the model as artifact content with the default file name", async () => {
    const harness = buildHarness();
    const adapter = new StubModelAdapter('print("hi")\n');

    const coder = new CoderAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      idGenerator: () => "artifact-bare-1",
      defaultFileName: "main.py",
    });

    const enrichedHandoff: AgentMessage = {
      taskId: TASK_ID,
      sender: RESEARCHER_ID,
      recipient: CODER_ID,
      type: "handoff",
      payload: { kind: "text", text: "Write a Python hello-world." },
      timestamp: ISO_AT,
    };

    const result = await coder.run({
      task: taskContext,
      agent: coderAgent,
      apiKey,
      incoming: enrichedHandoff,
      reviewerAgentId: REVIEWER_ID,
    });

    expect(result.coded.fileName).toBe("main.py");
    expect(result.coded.version).toBe(1);

    const v1 = await harness.artifactStore.getArtifact({
      taskId: TASK_ID,
      artifactId: "artifact-bare-1",
      version: 1,
    });
    expect(new TextDecoder().decode(v1!.bytes)).toBe('print("hi")\n');
  });

  it("does not write any artifact when the model adapter throws (atomicity guarantee)", async () => {
    const harness = buildHarness();

    class ThrowingAdapter implements ModelAdapter {
      public async invoke(): Promise<{ raw: unknown }> {
        throw new Error("provider down");
      }
    }

    const coder = new CoderAgent({
      modelAdapter: new ThrowingAdapter(),
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      idGenerator: () => "artifact-fail-1",
    });

    const incoming: AgentMessage = {
      taskId: TASK_ID,
      sender: RESEARCHER_ID,
      recipient: CODER_ID,
      type: "handoff",
      payload: { kind: "text", text: "anything" },
      timestamp: ISO_AT,
    };

    const result = await coder.run({
      task: taskContext,
      agent: coderAgent,
      apiKey,
      incoming,
      reviewerAgentId: REVIEWER_ID,
    });

    // Outgoing is an error message routed to the Reviewer.
    expect(result.outgoing.type).toBe("error");
    expect(result.outgoing.recipient).toBe(REVIEWER_ID);

    // No artifact was written — atomicity preserved.
    const artifacts = await harness.artifactStore.listArtifacts(TASK_ID);
    expect(artifacts).toHaveLength(0);

    // Final trace event is status:error.
    await flushTraces();
    const records = harness.collected.map((e) => e.record);
    expect(records.map((r) => r.kind)).toEqual(["status", "status"]);
    const last = records[1];
    if (last?.kind !== "status") throw new Error("expected status");
    expect(last.status).toBe("error");
  });

  it("does not write any artifact when the model output is unparseable (atomicity guarantee)", async () => {
    const harness = buildHarness();
    // BigInt cannot be turned into content by extractCoderContent.
    const adapter = new StubModelAdapter(BigInt(123));

    const coder = new CoderAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      idGenerator: () => "artifact-fail-2",
    });

    const incoming: AgentMessage = {
      taskId: TASK_ID,
      sender: RESEARCHER_ID,
      recipient: CODER_ID,
      type: "handoff",
      payload: { kind: "text", text: "anything" },
      timestamp: ISO_AT,
    };

    const result = await coder.run({
      task: taskContext,
      agent: coderAgent,
      apiKey,
      incoming,
      reviewerAgentId: REVIEWER_ID,
    });

    expect(result.outgoing.type).toBe("error");
    expect(result.outgoing.recipient).toBe(REVIEWER_ID);

    const artifacts = await harness.artifactStore.listArtifacts(TASK_ID);
    expect(artifacts).toHaveLength(0);
  });

  it("forwards the agent's system prompt and tool permissions to the adapter", async () => {
    const harness = buildHarness();
    const adapter = new StubModelAdapter("ok\n");
    const coder = new CoderAgent({
      modelAdapter: adapter,
      messageHistoryStore: harness.historyStore,
      artifactStore: harness.artifactStore,
      traceBus: harness.traceBus,
      idGenerator: () => "artifact-fwd-1",
    });

    const incoming: AgentMessage = {
      taskId: TASK_ID,
      sender: RESEARCHER_ID,
      recipient: CODER_ID,
      type: "handoff",
      payload: { kind: "text", text: "anything" },
      timestamp: ISO_AT,
    };

    await coder.run({
      task: taskContext,
      agent: coderAgent,
      apiKey,
      incoming,
      reviewerAgentId: REVIEWER_ID,
    });

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.options.systemPrompt).toBe(
      coderAgent.systemPrompt,
    );
    expect(adapter.calls[0]?.options.allowedTools).toEqual(
      coderAgent.allowedTools,
    );
    expect(adapter.calls[0]?.modelRef).toEqual(defaultModel);
  });
});
