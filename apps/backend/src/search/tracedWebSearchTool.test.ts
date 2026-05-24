/**
 * Unit tests for {@link TracedWebSearchTool} (task 13.2).
 *
 * Verifies:
 *   • Success path emits exactly one `tool_call` trace event.
 *   • Error path (`{ kind: "error" }` from inner tool) emits exactly
 *     one `tool_call` trace event with an error-shaped output.
 *   • Inner-tool throw is wrapped into an error trace AND re-thrown,
 *     preserving the adapter's user-facing throw semantics.
 *   • Trace fields (`taskId`, `agentId`, `tool`, `input.query`) match
 *     the calling context and the requested query.
 *   • Trace bus failures do not propagate to the agent runtime.
 *   • Top-results summary caps at 3 and never carries the full payload.
 *
 * Validates: Requirement 9.5.
 */

import { describe, expect, it, vi } from "vitest";

import {
  InMemoryTraceEventStoreBackend,
  TraceEventBus,
  type TraceEvent,
  type ToolCallTraceRecord,
} from "../trace/index.js";

import {
  TracedWebSearchTool,
  type SearchOptions,
  type SearchResult,
  type WebSearchTool,
} from "./index.js";

const FROZEN_NOW = "2024-06-15T12:00:00.000Z";

function createBus(): TraceEventBus {
  return new TraceEventBus({ backend: new InMemoryTraceEventStoreBackend() });
}

/** Stub adapter that returns a fixed `SearchResult` and records calls. */
class StubInner implements WebSearchTool {
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

class ThrowingInner implements WebSearchTool {
  public callCount = 0;
  public constructor(private readonly err: unknown) {}
  public async search(): Promise<SearchResult> {
    this.callCount += 1;
    throw this.err;
  }
}

function asToolCall(event: TraceEvent): ToolCallTraceRecord {
  if (event.record.kind !== "tool_call") {
    throw new Error(`expected tool_call record, got ${event.record.kind}`);
  }
  return event.record;
}

describe("TracedWebSearchTool", () => {
  it("emits exactly one tool_call trace on the success path with matching fields", async () => {
    const bus = createBus();
    const inner = new StubInner({
      kind: "ok",
      results: [
        { title: "T1", url: "https://example.com/1", snippet: "s1" },
        { title: "T2", url: "https://example.com/2", snippet: "s2" },
      ],
    });
    const traced = new TracedWebSearchTool({
      inner,
      traceBus: bus,
      now: () => FROZEN_NOW,
    });

    const tool = traced.forContext({ taskId: "task-1", agentId: "researcher" });
    const result = await tool.search("typescript zod docs");

    // Inner tool was called once with the original arguments.
    expect(inner.calls).toEqual([
      { query: "typescript zod docs", options: undefined },
    ]);

    // Caller observes the inner tool's result unchanged.
    expect(result).toEqual({
      kind: "ok",
      results: [
        { title: "T1", url: "https://example.com/1", snippet: "s1" },
        { title: "T2", url: "https://example.com/2", snippet: "s2" },
      ],
    });

    // Exactly one trace event was published, addressed to (task, agent).
    const events = await bus.listEvents("task-1");
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev).toBeDefined();
    expect(ev!.taskId).toBe("task-1");
    expect(ev!.agentId).toBe("researcher");
    expect(ev!.sequence).toBe(1);

    const call = asToolCall(ev!);
    expect(call.tool).toBe("web_search");
    expect(call.at).toBe(FROZEN_NOW);
    expect(call.input).toEqual({ query: "typescript zod docs" });
    // Output is a short summary, not the full payload.
    expect(call.output).toEqual({
      kind: "ok",
      resultCount: 2,
      results: [
        { title: "T1", url: "https://example.com/1" },
        { title: "T2", url: "https://example.com/2" },
      ],
    });
  });

  it("includes limit in trace input when caller supplies it", async () => {
    const bus = createBus();
    const inner = new StubInner({ kind: "ok", results: [] });
    const traced = new TracedWebSearchTool({
      inner,
      traceBus: bus,
      now: () => FROZEN_NOW,
    });

    await traced
      .forContext({ taskId: "task-1", agentId: "coder" })
      .search("q", { limit: 7 });

    const events = await bus.listEvents("task-1");
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev).toBeDefined();
    const call = asToolCall(ev!);
    expect(call.input).toEqual({ query: "q", limit: 7 });
    // Empty results path still produces an `ok` summary with count 0.
    expect(call.output).toEqual({
      kind: "ok",
      resultCount: 0,
      results: [],
    });
  });

  it("caps the top results in the trace output at 3 by default", async () => {
    const bus = createBus();
    const inner = new StubInner({
      kind: "ok",
      results: [
        { title: "T1", url: "u1", snippet: "" },
        { title: "T2", url: "u2", snippet: "" },
        { title: "T3", url: "u3", snippet: "" },
        { title: "T4", url: "u4", snippet: "" },
        { title: "T5", url: "u5", snippet: "" },
      ],
    });
    const traced = new TracedWebSearchTool({
      inner,
      traceBus: bus,
      now: () => FROZEN_NOW,
    });

    await traced.forContext({ taskId: "t", agentId: "researcher" }).search("q");

    const events = await bus.listEvents("t");
    const call = asToolCall(events[0]!);
    expect(call.output).toEqual({
      kind: "ok",
      resultCount: 5,
      results: [
        { title: "T1", url: "u1" },
        { title: "T2", url: "u2" },
        { title: "T3", url: "u3" },
      ],
    });
  });

  it("emits exactly one tool_call trace with error info when inner tool returns error", async () => {
    const bus = createBus();
    const inner = new StubInner({
      kind: "error",
      reason: "DuckDuckGo returned no results",
    });
    const traced = new TracedWebSearchTool({
      inner,
      traceBus: bus,
      now: () => FROZEN_NOW,
    });

    const result = await traced
      .forContext({ taskId: "task-err", agentId: "researcher" })
      .search("nothing-here");

    // Caller still receives the original error result; semantics unchanged.
    expect(result).toEqual({
      kind: "error",
      reason: "DuckDuckGo returned no results",
    });

    const events = await bus.listEvents("task-err");
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev).toBeDefined();
    const call = asToolCall(ev!);
    expect(call.tool).toBe("web_search");
    expect(call.input).toEqual({ query: "nothing-here" });
    expect(call.output).toEqual({
      kind: "error",
      reason: "DuckDuckGo returned no results",
    });
  });

  it("emits a single error-shaped trace and re-throws when inner tool throws", async () => {
    const bus = createBus();
    const boom = new Error("network down");
    const inner = new ThrowingInner(boom);
    const traced = new TracedWebSearchTool({
      inner,
      traceBus: bus,
      now: () => FROZEN_NOW,
    });

    await expect(
      traced
        .forContext({ taskId: "task-thr", agentId: "fixer" })
        .search("crash"),
    ).rejects.toBe(boom);

    expect(inner.callCount).toBe(1);

    const events = await bus.listEvents("task-thr");
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev).toBeDefined();
    expect(ev!.taskId).toBe("task-thr");
    expect(ev!.agentId).toBe("fixer");
    const call = asToolCall(ev!);
    expect(call.tool).toBe("web_search");
    expect(call.input).toEqual({ query: "crash" });
    expect(call.output).toMatchObject({ kind: "error" });
    if (call.output && typeof call.output === "object" && "reason" in call.output) {
      expect(String((call.output as { reason: string }).reason)).toContain(
        "network down",
      );
    } else {
      throw new Error("error output missing `reason`");
    }
  });

  it("does not crash the agent when the trace bus rejects publish", async () => {
    const okResult: SearchResult = {
      kind: "ok",
      results: [{ title: "T", url: "u", snippet: "s" }],
    };
    const inner = new StubInner(okResult);
    const onTraceError = vi.fn();
    const failingBus = {
      publish: () => Promise.reject(new Error("bus down")),
      subscribe(): AsyncIterable<TraceEvent> {
        return { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) };
      },
      listEvents: async () => [],
    };

    const traced = new TracedWebSearchTool({
      inner,
      traceBus: failingBus,
      now: () => FROZEN_NOW,
      onTraceError,
    });

    const result = await traced
      .forContext({ taskId: "task-bus", agentId: "researcher" })
      .search("ok-query");

    // The original result is preserved even though publish failed.
    expect(result).toEqual(okResult);
    expect(onTraceError).toHaveBeenCalledTimes(1);
    const arg = onTraceError.mock.calls[0]?.[0];
    expect(arg).toBeInstanceOf(Error);
    expect((arg as Error).message).toBe("bus down");
  });

  it("rejects context with empty taskId or agentId", () => {
    const inner = new StubInner({ kind: "ok", results: [] });
    const traced = new TracedWebSearchTool({
      inner,
      traceBus: createBus(),
      now: () => FROZEN_NOW,
    });

    expect(() => traced.forContext({ taskId: "", agentId: "a" })).toThrow(
      /taskId/,
    );
    expect(() => traced.forContext({ taskId: "t", agentId: "" })).toThrow(
      /agentId/,
    );
  });

  it("publishes one trace per call across multiple search invocations", async () => {
    const bus = createBus();
    const inner = new StubInner({
      kind: "ok",
      results: [{ title: "x", url: "x", snippet: "x" }],
    });
    const traced = new TracedWebSearchTool({
      inner,
      traceBus: bus,
      now: () => FROZEN_NOW,
    });

    const tool = traced.forContext({ taskId: "task-multi", agentId: "researcher" });
    await tool.search("q1");
    await tool.search("q2");
    await tool.search("q3");

    const events = await bus.listEvents("task-multi");
    expect(events).toHaveLength(3);
    expect(events.map((e) => asToolCall(e).input)).toEqual([
      { query: "q1" },
      { query: "q2" },
      { query: "q3" },
    ]);
    // Sequence numbers are dense and increasing per task.
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });
});
