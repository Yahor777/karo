/**
 * Unit tests for the Agent_Trace panel controller and DOM mount
 * helper (task 11.3).
 *
 * Coverage matrix:
 *
 *   • An agent appears in the sidebar as soon as its first event
 *     arrives (Requirement 11.1).
 *   • Selecting an agent narrows `visibleRecords` and the rendered
 *     main pane (Requirement 11.2).
 *   • The delayed indicator appears after `delayThresholdMs` of
 *     silence and clears as soon as a new message arrives
 *     (Requirement 11.6). The DOM is interactive throughout — the
 *     test asserts that the agent filter still works while delayed.
 *   • A `delayed` SSE event from the server surfaces a gap notice
 *     in `state.gapNotices` and a banner in the DOM
 *     (Requirement 11.6).
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.6, 11.8.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest";

import {
  AgentTraceController,
  DEFAULT_DELAY_THRESHOLD_MS,
} from "./agentTraceController.js";
import { mountAgentTracePanel } from "./mountAgentTracePanel.js";
import type {
  TimerHandle,
  TimerPort,
  TraceStreamGateway,
  TraceStreamMessage,
  TraceStreamSubscription,
} from "./types.js";
import type { TraceEvent } from "@ai-agent-orchestrator/validation";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Fake timer port. `advance(ms)` runs every scheduled callback whose
 * deadline has elapsed in registration order.
 */
class FakeTimer implements TimerPort {
  private current = 0;
  private nextId = 1;
  private readonly tasks = new Map<
    number,
    { readonly cb: () => void; readonly fireAt: number }
  >();

  public now(): number {
    return this.current;
  }

  public setTimeout(cb: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.tasks.set(id, { cb, fireAt: this.current + ms });
    return {
      cancel: () => {
        this.tasks.delete(id);
      },
    };
  }

  public advance(ms: number): void {
    const target = this.current + ms;
    while (true) {
      // Find the next task whose fireAt is <= target.
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, task] of this.tasks) {
        if (task.fireAt <= target && task.fireAt < nextAt) {
          nextAt = task.fireAt;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const t = this.tasks.get(nextId);
      this.tasks.delete(nextId);
      if (!t) break;
      this.current = t.fireAt;
      t.cb();
    }
    this.current = target;
  }
}

/**
 * Manually-fed trace stream subscription. `push()` enqueues a message;
 * the consumer's `for await` loop receives it on the next tick.
 */
class ManualSubscription implements TraceStreamSubscription {
  private readonly buffer: TraceStreamMessage[] = [];
  private resolveNext: ((v: IteratorResult<TraceStreamMessage>) => void) | null =
    null;
  private closed = false;

  public push(message: TraceStreamMessage): void {
    if (this.closed) return;
    if (this.resolveNext !== null) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: message, done: false });
      return;
    }
    this.buffer.push(message);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.resolveNext !== null) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: undefined, done: true });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<TraceStreamMessage> {
    return {
      next: (): Promise<IteratorResult<TraceStreamMessage>> => {
        if (this.buffer.length > 0) {
          const value = this.buffer.shift() as TraceStreamMessage;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<TraceStreamMessage>>((resolve) => {
          this.resolveNext = resolve;
        });
      },
      return: (): Promise<IteratorResult<TraceStreamMessage>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

class StubGateway implements TraceStreamGateway {
  public readonly subscriptions: ManualSubscription[] = [];

  public open(): TraceStreamSubscription {
    const sub = new ManualSubscription();
    this.subscriptions.push(sub);
    return sub;
  }

  public latest(): ManualSubscription {
    const last = this.subscriptions[this.subscriptions.length - 1];
    if (!last) throw new Error("no subscriptions opened yet");
    return last;
  }
}

// ---------------------------------------------------------------------------
// Trace event builders
// ---------------------------------------------------------------------------

const TASK_ID = "task-1";
const ISO_AT = "2024-06-15T12:00:00.000Z";

function thoughtEvent(
  agentId: string,
  sequence: number,
  text = "thinking",
): TraceEvent {
  return {
    taskId: TASK_ID,
    agentId,
    sequence,
    record: { kind: "thought", text, at: ISO_AT },
  };
}

function statusEvent(
  agentId: string,
  sequence: number,
  status: "started" | "finished" | "error",
): TraceEvent {
  return {
    taskId: TASK_ID,
    agentId,
    sequence,
    record: { kind: "status", status, at: ISO_AT },
  };
}

/**
 * Yields control to the event loop so the controller's async-iterator
 * `for await` loop can process freshly-pushed messages.
 */
async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Controller — agents and filtering
// ---------------------------------------------------------------------------

describe("AgentTraceController — participating agents (Requirement 11.1)", () => {
  it("adds an agent to the summary as soon as its first event arrives", async () => {
    const gateway = new StubGateway();
    const timer = new FakeTimer();
    const controller = new AgentTraceController({
      taskId: TASK_ID,
      gateway,
      timer,
    });
    void controller.start();

    expect(controller.getState().agents).toEqual([]);

    gateway.latest().push({
      kind: "event",
      event: statusEvent("researcher", 1, "started"),
    });
    await flushMicrotasks();

    const state = controller.getState();
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]).toMatchObject({
      agentId: "researcher",
      status: "started",
      firstSequence: 1,
      lastSequence: 1,
    });

    controller.dispose();
  });

  it("tracks lifecycle from started → finished", async () => {
    const gateway = new StubGateway();
    const timer = new FakeTimer();
    const controller = new AgentTraceController({
      taskId: TASK_ID,
      gateway,
      timer,
    });
    void controller.start();

    gateway.latest().push({
      kind: "event",
      event: statusEvent("coder", 1, "started"),
    });
    gateway.latest().push({
      kind: "event",
      event: thoughtEvent("coder", 2, "writing code"),
    });
    gateway.latest().push({
      kind: "event",
      event: statusEvent("coder", 3, "finished"),
    });
    await flushMicrotasks();

    expect(controller.getState().agents[0]?.status).toBe("finished");

    controller.dispose();
  });
});

describe("AgentTraceController — filter-by-agent (Requirement 11.2)", () => {
  it("narrows visibleRecords when an agent is selected", async () => {
    const gateway = new StubGateway();
    const timer = new FakeTimer();
    const controller = new AgentTraceController({
      taskId: TASK_ID,
      gateway,
      timer,
    });
    void controller.start();

    gateway.latest().push({
      kind: "event",
      event: thoughtEvent("researcher", 1, "looking up sources"),
    });
    gateway.latest().push({
      kind: "event",
      event: thoughtEvent("coder", 2, "writing code"),
    });
    gateway.latest().push({
      kind: "event",
      event: thoughtEvent("researcher", 3, "second thought"),
    });
    await flushMicrotasks();

    expect(controller.getState().visibleRecords).toHaveLength(3);

    controller.selectAgent("researcher");
    const filtered = controller.getState();
    expect(filtered.selectedAgentId).toBe("researcher");
    expect(filtered.visibleRecords.map((e) => e.sequence)).toEqual([1, 3]);

    controller.selectAgent(null);
    expect(controller.getState().visibleRecords).toHaveLength(3);

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Controller — delayed indicator (Requirement 11.6)
// ---------------------------------------------------------------------------

describe("AgentTraceController — delayed indicator (Requirement 11.6)", () => {
  it("flips delayed=true after > 2s without an event and clears on next message", async () => {
    const gateway = new StubGateway();
    const timer = new FakeTimer();
    const controller = new AgentTraceController({
      taskId: TASK_ID,
      gateway,
      timer,
      delayThresholdMs: DEFAULT_DELAY_THRESHOLD_MS,
    });
    void controller.start();

    expect(controller.getState().delayed).toBe(false);

    // Just under the threshold — still not delayed.
    timer.advance(DEFAULT_DELAY_THRESHOLD_MS - 1);
    expect(controller.getState().delayed).toBe(false);

    // Cross the threshold.
    timer.advance(2);
    expect(controller.getState().delayed).toBe(true);

    // A live event clears the indicator.
    gateway.latest().push({
      kind: "event",
      event: thoughtEvent("researcher", 1, "back online"),
    });
    await flushMicrotasks();
    expect(controller.getState().delayed).toBe(false);

    controller.dispose();
  });

  it("does not block UI interactions while delayed", async () => {
    const gateway = new StubGateway();
    const timer = new FakeTimer();
    const controller = new AgentTraceController({
      taskId: TASK_ID,
      gateway,
      timer,
    });
    void controller.start();

    gateway.latest().push({
      kind: "event",
      event: thoughtEvent("researcher", 1, "thinking"),
    });
    gateway.latest().push({
      kind: "event",
      event: thoughtEvent("coder", 2, "coding"),
    });
    await flushMicrotasks();

    timer.advance(DEFAULT_DELAY_THRESHOLD_MS + 50);
    expect(controller.getState().delayed).toBe(true);

    // Filter still applies while delayed.
    controller.selectAgent("coder");
    const state = controller.getState();
    expect(state.delayed).toBe(true);
    expect(state.selectedAgentId).toBe("coder");
    expect(state.visibleRecords.map((e) => e.sequence)).toEqual([2]);

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Controller — gap notice from server `delayed` event
// ---------------------------------------------------------------------------

describe("AgentTraceController — gap notice (Requirement 11.6)", () => {
  it("records a gap notice when a delayed SSE event arrives", async () => {
    const gateway = new StubGateway();
    const timer = new FakeTimer();
    const controller = new AgentTraceController({
      taskId: TASK_ID,
      gateway,
      timer,
    });
    void controller.start();

    gateway.latest().push({ kind: "delayed", droppedCount: 7 });
    await flushMicrotasks();

    const state = controller.getState();
    expect(state.gapNotices).toHaveLength(1);
    expect(state.gapNotices[0]).toMatchObject({ droppedCount: 7 });

    // Dismissing clears them.
    controller.dismissGapNotices();
    expect(controller.getState().gapNotices).toEqual([]);

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Controller — history-end transitions to live
// ---------------------------------------------------------------------------

describe("AgentTraceController — history-end marker", () => {
  it("transitions connection from loading-history to live", async () => {
    const gateway = new StubGateway();
    const timer = new FakeTimer();
    const controller = new AgentTraceController({
      taskId: TASK_ID,
      gateway,
      timer,
    });
    void controller.start();

    expect(controller.getState().connection).toEqual({
      kind: "loading-history",
    });

    gateway.latest().push({ kind: "history-end", upTo: 0 });
    await flushMicrotasks();

    expect(controller.getState().historyEnded).toBe(true);
    expect(controller.getState().connection).toEqual({ kind: "live" });

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// DOM mount
// ---------------------------------------------------------------------------

describe("mountAgentTracePanel — DOM rendering", () => {
  it("renders agents in the sidebar and surfaces the delayed banner", async () => {
    const gateway = new StubGateway();
    const timer = new FakeTimer();
    const controller = new AgentTraceController({
      taskId: TASK_ID,
      gateway,
      timer,
    });
    void controller.start();

    const root = document.createElement("div");
    document.body.append(root);
    const teardown = mountAgentTracePanel({ root, controller });

    // Initially no agents.
    expect(root.querySelectorAll("[data-agent-id]").length).toBe(0);
    expect(
      (root.querySelector(".agent-trace__delayed"))
        ?.hidden,
    ).toBe(true);

    gateway.latest().push({
      kind: "event",
      event: statusEvent("researcher", 1, "started"),
    });
    gateway.latest().push({
      kind: "event",
      event: thoughtEvent("researcher", 2, "thinking…"),
    });
    await flushMicrotasks();

    const agentRow = root.querySelector(
      'li[data-agent-id="researcher"]',
    );
    expect(agentRow).not.toBeNull();
    expect(agentRow?.dataset["status"]).toBe("started");

    const recordItems = root.querySelectorAll(".agent-trace__record");
    expect(recordItems.length).toBe(2);

    // Click the agent row → filter narrows.
    const button = agentRow?.querySelector("button");
    expect(button).not.toBeNull();
    button?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(controller.getState().selectedAgentId).toBe("researcher");

    // Cross the delay threshold → banner appears.
    timer.advance(DEFAULT_DELAY_THRESHOLD_MS + 1);
    const delayed = root.querySelector(
      ".agent-trace__delayed",
    );
    expect(delayed?.hidden).toBe(false);
    expect(delayed?.textContent).toContain("Updating");

    teardown();
    controller.dispose();
    root.remove();
  });

  it("surfaces a gap notice banner when the server drops events", async () => {
    const gateway = new StubGateway();
    const timer = new FakeTimer();
    const controller = new AgentTraceController({
      taskId: TASK_ID,
      gateway,
      timer,
    });
    void controller.start();

    const root = document.createElement("div");
    document.body.append(root);
    const teardown = mountAgentTracePanel({ root, controller });

    gateway.latest().push({ kind: "delayed", droppedCount: 3 });
    await flushMicrotasks();

    const banner = root.querySelector(
      ".agent-trace__gap-banner",
    );
    expect(banner?.hidden).toBe(false);
    expect(banner?.textContent ?? "").toContain("3");

    teardown();
    controller.dispose();
    root.remove();
  });
});
