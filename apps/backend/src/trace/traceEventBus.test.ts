/**
 * Unit tests for {@link TraceEventBus}.
 *
 * Covers task 11.1 acceptance criteria:
 *   • Persists `TraceRecord` entries (thought, tool_call, artifact_change,
 *     status) — Requirements 9.5, 11.2, 11.7.
 *   • Per-task monotonic `sequence` numbering.
 *   • Isolation between tasks (each task has its own counter).
 *   • Basic subscribe-receives-published-records semantics, including
 *     agent-scoped subscriptions and post-subscribe-only delivery.
 *
 * The companion property test for ordered task history lives in task 11.4
 * (Property 12) and is intentionally not duplicated here.
 *
 * Validates: Requirements 9.5, 11.2, 11.7.
 */

import { describe, expect, it } from "vitest";

import {
  type ArtifactChangeTraceRecord,
  type StatusTraceRecord,
  type ThoughtTraceRecord,
  type ToolCallTraceRecord,
  type TraceEvent,
  type TraceRecord,
  InMemoryTraceEventStoreBackend,
  TraceEventBus,
} from "./index.js";

const ISO_AT = "2024-06-15T12:00:00.000Z";

function thought(text: string): ThoughtTraceRecord {
  return { kind: "thought", text, at: ISO_AT };
}

function toolCall(): ToolCallTraceRecord {
  return {
    kind: "tool_call",
    tool: "web_search",
    input: { query: "duckduckgo" },
    output: { results: [] },
    at: ISO_AT,
  };
}

function artifactChange(
  artifactId: string,
  version: number,
): ArtifactChangeTraceRecord {
  return { kind: "artifact_change", artifactId, version, at: ISO_AT };
}

function status(s: StatusTraceRecord["status"]): StatusTraceRecord {
  return { kind: "status", status: s, at: ISO_AT };
}

/** Pull `n` events from a subscription, with a generous timeout. */
async function take(
  iter: AsyncIterable<TraceEvent>,
  n: number,
  timeoutMs = 1_000,
): Promise<TraceEvent[]> {
  const out: TraceEvent[] = [];
  const it = iter[Symbol.asyncIterator]();
  for (let i = 0; i < n; i += 1) {
    const next = await Promise.race([
      it.next(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`timed out waiting for event ${i + 1}/${n}`)),
          timeoutMs,
        ),
      ),
    ]);
    if (next.done) {
      throw new Error(`subscription ended after ${out.length}/${n} events`);
    }
    out.push(next.value);
  }
  // Cancel the iterator so the bus can detach the subscriber promptly.
  await it.return?.();
  return out;
}

describe("TraceEventBus", () => {
  it("persists each TraceRecord variant with a monotonic per-task sequence", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    const records: TraceRecord[] = [
      thought("planning"),
      toolCall(),
      artifactChange("artifact-1", 1),
      status("started"),
    ];

    const published: TraceEvent[] = [];
    for (const record of records) {
      const ev = await bus.publish({
        taskId: "task-A",
        agentId: "researcher",
        record,
      });
      published.push(ev);
    }

    // Each call increments by exactly one, starting at 1.
    expect(published.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);

    // Each variant's `kind` round-trips through the backend.
    const persisted = await bus.listEvents("task-A");
    expect(persisted).toHaveLength(4);
    expect(persisted.map((e) => e.record.kind)).toEqual([
      "thought",
      "tool_call",
      "artifact_change",
      "status",
    ]);

    // Sequence numbers are strictly increasing.
    const seqs = persisted.map((e) => e.sequence);
    for (let i = 1; i < seqs.length; i += 1) {
      const previous = seqs[i - 1];
      const current = seqs[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect(current as number).toBeGreaterThan(previous as number);
    }
  });

  it("isolates sequence counters between tasks", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    const a1 = await bus.publish({
      taskId: "task-A",
      agentId: "researcher",
      record: thought("a-1"),
    });
    const b1 = await bus.publish({
      taskId: "task-B",
      agentId: "researcher",
      record: thought("b-1"),
    });
    const a2 = await bus.publish({
      taskId: "task-A",
      agentId: "researcher",
      record: thought("a-2"),
    });
    const b2 = await bus.publish({
      taskId: "task-B",
      agentId: "coder",
      record: thought("b-2"),
    });

    expect(a1.sequence).toBe(1);
    expect(b1.sequence).toBe(1);
    expect(a2.sequence).toBe(2);
    expect(b2.sequence).toBe(2);

    const aLog = await bus.listEvents("task-A");
    const bLog = await bus.listEvents("task-B");
    expect(aLog.map((e) => e.sequence)).toEqual([1, 2]);
    expect(bLog.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("preserves order under concurrent publishes for the same task", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    // Fire 25 publishes without awaiting individually — the bus serialises
    // per-task work, so the resulting sequence must be 1..25 with no gaps.
    const N = 25;
    const promises: Promise<TraceEvent>[] = [];
    for (let i = 0; i < N; i += 1) {
      promises.push(
        bus.publish({
          taskId: "task-C",
          agentId: "researcher",
          record: thought(`step-${i}`),
        }),
      );
    }
    const events = await Promise.all(promises);

    expect(events.map((e) => e.sequence)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );

    const persisted = await bus.listEvents("task-C");
    expect(persisted.map((e) => e.sequence)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });

  it("delivers published events to a subscriber on the same task", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    const sub = bus.subscribe({ taskId: "task-D" });

    // Publish three records after subscribing.
    const publishing = (async () => {
      await bus.publish({
        taskId: "task-D",
        agentId: "researcher",
        record: thought("first"),
      });
      await bus.publish({
        taskId: "task-D",
        agentId: "coder",
        record: artifactChange("a-1", 1),
      });
      await bus.publish({
        taskId: "task-D",
        agentId: "reviewer",
        record: status("started"),
      });
    })();

    const received = await take(sub, 3);
    await publishing;

    expect(received.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(received.map((e) => e.agentId)).toEqual([
      "researcher",
      "coder",
      "reviewer",
    ]);
    expect(received.map((e) => e.record.kind)).toEqual([
      "thought",
      "artifact_change",
      "status",
    ]);
  });

  it("filters by agentId when subscribe specifies one", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    const sub = bus.subscribe({ taskId: "task-E", agentId: "coder" });

    const publishing = (async () => {
      await bus.publish({
        taskId: "task-E",
        agentId: "researcher",
        record: thought("ignored"),
      });
      await bus.publish({
        taskId: "task-E",
        agentId: "coder",
        record: thought("first-coder"),
      });
      await bus.publish({
        taskId: "task-E",
        agentId: "researcher",
        record: thought("ignored-2"),
      });
      await bus.publish({
        taskId: "task-E",
        agentId: "coder",
        record: thought("second-coder"),
      });
    })();

    const received = await take(sub, 2);
    await publishing;

    expect(received.map((e) => e.sequence)).toEqual([2, 4]);
    expect(received.every((e) => e.agentId === "coder")).toBe(true);
  });

  it("does not replay events published before subscribe", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    // Publish two events before any subscriber attaches.
    await bus.publish({
      taskId: "task-F",
      agentId: "researcher",
      record: thought("pre-1"),
    });
    await bus.publish({
      taskId: "task-F",
      agentId: "researcher",
      record: thought("pre-2"),
    });

    const sub = bus.subscribe({ taskId: "task-F" });
    const publishing = bus.publish({
      taskId: "task-F",
      agentId: "researcher",
      record: thought("post"),
    });

    const received = await take(sub, 1);
    await publishing;

    // The subscriber should only see the post-subscribe event. History is
    // available via `listEvents` for callers that need replay.
    expect(received).toHaveLength(1);
    expect(received[0]?.sequence).toBe(3);

    const persisted = await bus.listEvents("task-F");
    expect(persisted.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it("isolates subscribers across tasks", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    const subA = bus.subscribe({ taskId: "task-G" });
    const subB = bus.subscribe({ taskId: "task-H" });

    const publishing = (async () => {
      await bus.publish({
        taskId: "task-G",
        agentId: "researcher",
        record: thought("g-1"),
      });
      await bus.publish({
        taskId: "task-H",
        agentId: "researcher",
        record: thought("h-1"),
      });
    })();

    const [aEvents, bEvents] = await Promise.all([
      take(subA, 1),
      take(subB, 1),
    ]);
    await publishing;

    expect(aEvents).toHaveLength(1);
    expect(aEvents[0]?.taskId).toBe("task-G");
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0]?.taskId).toBe("task-H");
  });

  it("releases the subscriber when iteration is cancelled", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    const sub = bus.subscribe({ taskId: "task-I" });
    const it = sub[Symbol.asyncIterator]();

    await bus.publish({
      taskId: "task-I",
      agentId: "researcher",
      record: thought("only"),
    });

    const first = await it.next();
    expect(first.done).toBe(false);
    if (!first.done) {
      expect(first.value.sequence).toBe(1);
    }

    // Cancel the iterator. After this, no further reads should hang.
    await it.return?.();

    // Publishing more events must not throw and must still return.
    const post = await bus.publish({
      taskId: "task-I",
      agentId: "researcher",
      record: thought("after-cancel"),
    });
    expect(post.sequence).toBe(2);
  });

  it("recovers the next sequence from the backend on first publish", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    // Simulate a process restart: pre-seed the backend with two events.
    await backend.append({
      taskId: "task-J",
      agentId: "researcher",
      record: thought("pre-1"),
      sequence: 1,
    });
    await backend.append({
      taskId: "task-J",
      agentId: "researcher",
      record: thought("pre-2"),
      sequence: 2,
    });

    const bus = new TraceEventBus({ backend });
    const next = await bus.publish({
      taskId: "task-J",
      agentId: "researcher",
      record: thought("post-restart"),
    });
    expect(next.sequence).toBe(3);
  });

  it("rolls back the counter when the backend rejects an append", async () => {
    let rejectNext = false;
    const inner = new InMemoryTraceEventStoreBackend();
    const flakyBackend = {
      async append(event: TraceEvent): Promise<void> {
        if (rejectNext) {
          rejectNext = false;
          throw new Error("backend down");
        }
        await inner.append(event);
      },
      async list(taskId: string): Promise<readonly TraceEvent[]> {
        return inner.list(taskId);
      },
      async latestSequence(taskId: string): Promise<number> {
        return inner.latestSequence(taskId);
      },
    };

    const bus = new TraceEventBus({ backend: flakyBackend });

    const ok = await bus.publish({
      taskId: "task-K",
      agentId: "researcher",
      record: thought("first"),
    });
    expect(ok.sequence).toBe(1);

    rejectNext = true;
    await expect(
      bus.publish({
        taskId: "task-K",
        agentId: "researcher",
        record: thought("will-fail"),
      }),
    ).rejects.toThrow(/backend down/);

    // The counter rolled back, so the next successful publish reuses
    // sequence 2 — there are no gaps.
    const recovered = await bus.publish({
      taskId: "task-K",
      agentId: "researcher",
      record: thought("retry"),
    });
    expect(recovered.sequence).toBe(2);

    const persisted = await bus.listEvents("task-K");
    expect(persisted.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("rejects empty taskId and agentId in publish", async () => {
    const bus = new TraceEventBus({
      backend: new InMemoryTraceEventStoreBackend(),
    });
    await expect(
      bus.publish({
        taskId: "",
        agentId: "researcher",
        record: thought("x"),
      }),
    ).rejects.toThrow(/taskId/);
    await expect(
      bus.publish({
        taskId: "task-X",
        agentId: "",
        record: thought("x"),
      }),
    ).rejects.toThrow(/agentId/);
  });
});
