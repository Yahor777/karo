/**
 * Unit tests for {@link AgentRunner}.
 *
 * Covers task 14.1 acceptance criteria:
 *   • Parse-success path — the adapter's well-formed Agent_Message is
 *     returned verbatim. Requirement 10.8.
 *   • Parse-failure path — malformed adapter output is normalised into
 *     a valid Agent_Message (`type: "response"`, `normalized: true`,
 *     `rawOriginal` preserved). Requirement 10.8.
 *   • Unreadable / thrown adapter output is wrapped as
 *     `type: "error"`. Requirement 10.9.
 *   • History trimming at 200 messages — the adapter receives at most
 *     200 messages and only the most recent ones. Requirement 10.7.
 *   • History trimming at 8 MB — the adapter receives a history that
 *     fits within the byte budget. Requirement 10.7.
 *   • Persistence happens before handoff — the runner appends the
 *     outgoing message to the history store before resolving, and
 *     reports its measured latency. Requirement 10.6.
 *
 * Validates: Requirements 10.6, 10.7, 10.8, 10.9.
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_HISTORY_MAX_BYTES,
  AGENT_HISTORY_MAX_MESSAGES,
  AGENT_PERSISTENCE_BUDGET_MS,
  AgentRunner,
  InMemoryMessageHistoryStore,
  type AgentDefinition,
  type AgentRunInput,
  type Clock,
  type MessageHistoryStore,
  type ModelAdapter,
  type ModelInvokeOptions,
  type SecretRef,
  type TaskContext,
} from "./index.js";
import type { AgentMessage } from "@ai-agent-orchestrator/validation";
import type { ModelRef } from "@ai-agent-orchestrator/shared-core";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ISO_AT = "2024-06-15T12:00:00.000Z";
const HANDOFF_TIMESTAMP = "2024-06-15T11:59:59.000Z";

const TASK_ID = "task-1";
const AGENT_ID = "researcher";
const PEER_AGENT_ID = "coder";

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

const agent: AgentDefinition = {
  id: AGENT_ID,
  name: "Researcher",
  systemPrompt: "Enrich the user's prompt.",
  allowedTools: ["web_search"],
};

const incoming: AgentMessage = {
  taskId: TASK_ID,
  sender: "orchestrator",
  recipient: AGENT_ID,
  type: "handoff",
  payload: { kind: "text", text: "Please research X" },
  timestamp: HANDOFF_TIMESTAMP,
};

function buildInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    task: taskContext,
    agent,
    apiKey,
    incoming,
    ...overrides,
  };
}

/**
 * Mutable adapter that returns a configurable raw value. Records the
 * arguments of the most recent call so tests can assert on the
 * trimmed history that was forwarded.
 */
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

/** Adapter that throws — exercises the "thrown exception" branch. */
class ThrowingModelAdapter implements ModelAdapter {
  public constructor(private readonly error: Error) {}

  public async invoke(): Promise<{ raw: unknown }> {
    throw this.error;
  }
}

/**
 * Deterministic clock that emits a sequence of millisecond values on
 * `nowMs()` and a fixed ISO timestamp from `nowIso()`. The constructor
 * accepts either a fixed step or an explicit list of values; tests use
 * the explicit list to control the persistence-latency reading.
 */
class TestClock implements Clock {
  private readonly values: number[];
  private cursor = 0;

  public constructor(values: number[], private readonly iso: string = ISO_AT) {
    this.values = [...values];
  }

  public nowMs(): number {
    if (this.cursor >= this.values.length) {
      // Stay on the last value so any extra reads do not throw.
      return this.values[this.values.length - 1] ?? 0;
    }
    const v = this.values[this.cursor] ?? 0;
    this.cursor += 1;
    return v;
  }

  public nowIso(): string {
    return this.iso;
  }
}

// Helper for building well-formed historical messages of varying sizes.
function buildHistoryMessage(
  index: number,
  payloadSize = 32,
): AgentMessage {
  return {
    taskId: TASK_ID,
    sender: AGENT_ID,
    recipient: "orchestrator",
    type: "response",
    payload: { kind: "text", text: `m${index}-${"x".repeat(payloadSize)}` },
    // Vary timestamps so they remain valid ISO strings; ordering is
    // dictated by insertion order in the history store, not by these
    // values.
    timestamp: ISO_AT,
  };
}

async function seedHistory(
  store: MessageHistoryStore,
  count: number,
  payloadSize = 32,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await store.append(TASK_ID, buildHistoryMessage(i, payloadSize));
  }
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("AgentRunner.run — parse-success path", () => {
  it("returns the adapter's well-formed Agent_Message verbatim and persists it", async () => {
    const store = new InMemoryMessageHistoryStore();
    const expectedTimestamp = "2024-06-15T12:34:56.789Z";

    const wellFormed: AgentMessage = {
      taskId: TASK_ID,
      sender: AGENT_ID,
      recipient: PEER_AGENT_ID,
      type: "handoff",
      payload: { kind: "text", text: "enriched prompt" },
      timestamp: expectedTimestamp,
    };

    const adapter = new StubModelAdapter(wellFormed);
    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: store,
    });

    const result = await runner.run(buildInput());

    // No normalisation flag because the input was already a valid Agent_Message.
    expect(result.normalized).toBe(false);
    expect(result.outgoing.type).toBe("handoff");
    expect(result.outgoing.recipient).toBe(PEER_AGENT_ID);
    expect(result.outgoing.timestamp).toBe(expectedTimestamp);
    if (result.outgoing.payload.kind !== "text") {
      throw new Error("expected text payload");
    }
    expect(result.outgoing.payload.text).toBe("enriched prompt");

    // Persisted to the history store (Requirement 10.6).
    const persisted = await store.list(TASK_ID);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.type).toBe("handoff");
  });
});

describe("AgentRunner.run — parse-failure path", () => {
  it("normalises malformed-but-readable output into type 'response' with rawOriginal preserved", async () => {
    const store = new InMemoryMessageHistoryStore();
    const adapter = new StubModelAdapter("free-form agent reply");

    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: store,
      clock: new TestClock([0, 0]),
    });

    const result = await runner.run(buildInput({ recipient: PEER_AGENT_ID }));

    expect(result.normalized).toBe(true);
    expect(result.outgoing.type).toBe("response");
    expect(result.outgoing.normalized).toBe(true);
    expect(result.outgoing.rawOriginal).toBe("free-form agent reply");
    expect(result.outgoing.recipient).toBe(PEER_AGENT_ID);
    expect(result.outgoing.timestamp).toBe(ISO_AT);
    if (result.outgoing.payload.kind !== "text") {
      throw new Error("expected text payload");
    }
    expect(result.outgoing.payload.text).toBe("free-form agent reply");

    // Still persisted before handoff returns.
    const persisted = await store.list(TASK_ID);
    expect(persisted).toHaveLength(1);
  });

  it("normalises a JSON-shaped output into a 'response' message with rawOriginal", async () => {
    const store = new InMemoryMessageHistoryStore();
    const adapter = new StubModelAdapter({
      thoughts: ["a", "b"],
      enrichedPrompt: "longer prompt",
    });

    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: store,
    });

    const result = await runner.run(buildInput());

    expect(result.normalized).toBe(true);
    expect(result.outgoing.type).toBe("response");
    if (result.outgoing.payload.kind !== "json") {
      throw new Error("expected json payload");
    }
    expect(result.outgoing.payload.value).toEqual({
      thoughts: ["a", "b"],
      enrichedPrompt: "longer prompt",
    });
    expect(result.outgoing.rawOriginal).toEqual({
      thoughts: ["a", "b"],
      enrichedPrompt: "longer prompt",
    });
  });
});

describe("AgentRunner.run — unreadable / error path (Requirement 10.9)", () => {
  it("wraps a thrown adapter exception as an Agent_Message of type 'error'", async () => {
    const store = new InMemoryMessageHistoryStore();
    const adapter = new ThrowingModelAdapter(new Error("provider down"));

    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: store,
    });

    const result = await runner.run(buildInput());

    expect(result.outgoing.type).toBe("error");
    expect(result.normalized).toBe(true);
    if (result.outgoing.payload.kind !== "text") {
      throw new Error("error payload must be text");
    }
    expect(result.outgoing.payload.text).toMatch(/failed to invoke model adapter/i);
    expect(result.outgoing.payload.text).toMatch(/provider down/);

    const persisted = await store.list(TASK_ID);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.type).toBe("error");
  });

  it("wraps unreadable raw output (BigInt) as an Agent_Message of type 'error'", async () => {
    const store = new InMemoryMessageHistoryStore();
    const adapter = new StubModelAdapter(BigInt(123));

    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: store,
    });

    const result = await runner.run(buildInput());
    expect(result.outgoing.type).toBe("error");
    expect(result.normalized).toBe(true);

    const persisted = await store.list(TASK_ID);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.type).toBe("error");
  });

  it("wraps an unreadable circular structure as an Agent_Message of type 'error'", async () => {
    const store = new InMemoryMessageHistoryStore();
    const cycle: Record<string, unknown> = { name: "cycle" };
    cycle.self = cycle;
    const adapter = new StubModelAdapter(cycle);

    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: store,
    });

    const result = await runner.run(buildInput());
    expect(result.outgoing.type).toBe("error");
    expect(result.normalized).toBe(true);
  });
});

describe("AgentRunner.run — history trimming at 200 messages (Requirement 10.7)", () => {
  it("forwards at most AGENT_HISTORY_MAX_MESSAGES messages and keeps the most recent ones", async () => {
    const store = new InMemoryMessageHistoryStore();
    const totalSeeded = AGENT_HISTORY_MAX_MESSAGES + 50;
    await seedHistory(store, totalSeeded, 32);

    const adapter = new StubModelAdapter("ok");
    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: store,
    });

    await runner.run(buildInput());

    expect(adapter.calls).toHaveLength(1);
    const forwarded = adapter.calls[0]?.messages ?? [];
    expect(forwarded.length).toBe(AGENT_HISTORY_MAX_MESSAGES);

    // First forwarded message corresponds to seed index `totalSeeded - 200`.
    const firstForwarded = forwarded[0];
    if (firstForwarded === undefined || firstForwarded.payload.kind !== "text") {
      throw new Error("expected text payload");
    }
    expect(firstForwarded.payload.text.startsWith(`m${totalSeeded - AGENT_HISTORY_MAX_MESSAGES}-`)).toBe(true);

    // Last forwarded message is the most recent one.
    const lastForwarded = forwarded[forwarded.length - 1];
    if (lastForwarded === undefined || lastForwarded.payload.kind !== "text") {
      throw new Error("expected text payload");
    }
    expect(lastForwarded.payload.text.startsWith(`m${totalSeeded - 1}-`)).toBe(true);
  });

  it("forwards the entire history when the count is at or below the cap", async () => {
    const store = new InMemoryMessageHistoryStore();
    await seedHistory(store, AGENT_HISTORY_MAX_MESSAGES);

    const adapter = new StubModelAdapter("ok");
    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: store,
    });

    await runner.run(buildInput());

    expect(adapter.calls[0]?.messages.length).toBe(AGENT_HISTORY_MAX_MESSAGES);
  });
});

describe("AgentRunner.run — history trimming at 8 MB (Requirement 10.7)", () => {
  it("trims oldest messages until the byte budget is satisfied", async () => {
    const store = new InMemoryMessageHistoryStore();

    // Each payload is ~512 KB of text. With 30 messages we are well
    // above 8 MB, but well below the 200-message cap, so the byte
    // bound is the driver here.
    const halfMb = 512 * 1024;
    const messageCount = 30;
    await seedHistory(store, messageCount, halfMb);

    const adapter = new StubModelAdapter("ok");
    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: store,
    });

    await runner.run(buildInput());

    const forwarded = adapter.calls[0]?.messages ?? [];
    // We expect strictly fewer than messageCount, because the byte
    // budget kicked in.
    expect(forwarded.length).toBeLessThan(messageCount);
    expect(forwarded.length).toBeGreaterThan(0);

    // The most recent message must always be present.
    const lastForwarded = forwarded[forwarded.length - 1];
    if (lastForwarded === undefined || lastForwarded.payload.kind !== "text") {
      throw new Error("expected text payload");
    }
    expect(lastForwarded.payload.text.startsWith(`m${messageCount - 1}-`)).toBe(true);

    // Aggregate forwarded payload bytes must not exceed the cap by
    // more than one message worth (the runner keeps a message that
    // would push the total slightly over only when it is the single
    // most recent message — see historyBounds.ts for the rule).
    let totalBytes = 0;
    for (const msg of forwarded) {
      if (msg.payload.kind === "text") {
        totalBytes += msg.payload.text.length;
      }
    }
    expect(totalBytes).toBeLessThanOrEqual(AGENT_HISTORY_MAX_BYTES);
  });
});

describe("AgentRunner.run — persistence-before-handoff (Requirement 10.6)", () => {
  it("appends the outgoing message to the store before resolving", async () => {
    const callOrder: string[] = [];

    const trackingStore: MessageHistoryStore = {
      async append(taskId, message) {
        callOrder.push("append");
        await new InMemoryMessageHistoryStore().append(taskId, message);
      },
      async list() {
        return [];
      },
    };

    const adapter: ModelAdapter = {
      async invoke(): Promise<{ raw: unknown }> {
        callOrder.push("invoke");
        return { raw: "agent reply" };
      },
    };

    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: trackingStore,
    });

    const result = await runner.run(buildInput());

    expect(callOrder).toEqual(["invoke", "append"]);
    expect(result.outgoing).toBeDefined();
  });

  it("reports the measured persistence latency", async () => {
    const realStore = new InMemoryMessageHistoryStore();

    // Slow store that defers append by an injected duration.
    const slowStore: MessageHistoryStore = {
      async append(taskId, message) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await realStore.append(taskId, message);
      },
      list: realStore.list.bind(realStore),
    };

    // Clock returns 1000 ms before append, 1023 ms after — gives a
    // deterministic measured latency of 23 ms regardless of the real
    // wall clock.
    const clock = new TestClock([1000, 1023]);

    const runner = new AgentRunner({
      modelAdapter: new StubModelAdapter("payload"),
      messageHistoryStore: slowStore,
      clock,
    });

    const result = await runner.run(buildInput());
    expect(result.persistenceLatencyMs).toBe(23);
  });

  it("stays under the 500 ms persistence budget on the in-memory backend", async () => {
    const store = new InMemoryMessageHistoryStore();
    // Add some history so the append is not trivially the first item.
    await seedHistory(store, 50);

    const runner = new AgentRunner({
      modelAdapter: new StubModelAdapter("ok"),
      messageHistoryStore: store,
    });

    const result = await runner.run(buildInput());
    expect(result.persistenceLatencyMs).toBeLessThan(
      AGENT_PERSISTENCE_BUDGET_MS,
    );
  });

  it("rolls forward — outgoing message is in the persisted log when run resolves", async () => {
    const store = new InMemoryMessageHistoryStore();
    const runner = new AgentRunner({
      modelAdapter: new StubModelAdapter("agent reply"),
      messageHistoryStore: store,
    });

    await runner.run(buildInput());

    const persisted = await store.list(TASK_ID);
    expect(persisted).toHaveLength(1);
    if (persisted[0]?.payload.kind !== "text") {
      throw new Error("expected text payload");
    }
    expect(persisted[0].payload.text).toBe("agent reply");
  });
});

describe("AgentRunner.run — input handling", () => {
  it("uses the agent's pinned model when present", async () => {
    const customModel: ModelRef = {
      provider: "anthropic",
      modelId: "claude-3-haiku",
      source: "user-api-key",
    };
    const customAgent: AgentDefinition = { ...agent, model: customModel };

    const adapter = new StubModelAdapter("ok");
    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: new InMemoryMessageHistoryStore(),
    });

    await runner.run(buildInput({ agent: customAgent }));
    expect(adapter.calls[0]?.modelRef).toEqual(customModel);
  });

  it("falls back to the task's default model when the agent has none (Requirement 6.4)", async () => {
    const adapter = new StubModelAdapter("ok");
    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: new InMemoryMessageHistoryStore(),
    });

    await runner.run(buildInput());
    expect(adapter.calls[0]?.modelRef).toEqual(defaultModel);
  });

  it("forwards the agent's system prompt to the adapter (not in the history)", async () => {
    const store = new InMemoryMessageHistoryStore();
    await seedHistory(store, 5);

    const adapter = new StubModelAdapter("ok");
    const runner = new AgentRunner({
      modelAdapter: adapter,
      messageHistoryStore: store,
    });

    await runner.run(buildInput());

    // System prompt is in options, not in the history payloads.
    expect(adapter.calls[0]?.options.systemPrompt).toBe(agent.systemPrompt);
    for (const msg of adapter.calls[0]?.messages ?? []) {
      if (msg.payload.kind === "text") {
        expect(msg.payload.text).not.toBe(agent.systemPrompt);
      }
    }
  });

  it("rejects invalid inputs (empty agent id)", async () => {
    const runner = new AgentRunner({
      modelAdapter: new StubModelAdapter("ok"),
      messageHistoryStore: new InMemoryMessageHistoryStore(),
    });

    await expect(
      runner.run(
        buildInput({
          agent: { ...agent, id: "" },
        }),
      ),
    ).rejects.toThrow(/agent\.id/);
  });
});
