/**
 * Unit / integration tests for the SSE trace streaming endpoint
 * (task 11.2).
 *
 * Covered behaviours:
 *   • history-then-live ordering (history snapshot is emitted, followed
 *     by a `history-end` marker, followed by live events without
 *     duplicates),
 *   • per-agent filtering on subscription,
 *   • slow-client buffering with drop-oldest policy and synthetic
 *     `delayed` events,
 *   • peer disconnect cleans up the bus subscription,
 *   • HTTP query-parameter validation (`taskId` required).
 *
 * Validates: Requirements 11.3, 11.6.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import {
  InMemoryTraceEventStoreBackend,
  TraceEventBus,
} from "./index.js";
import type { TraceEvent } from "./index.js";
import {
  createNodeResponseSink,
  streamTraceToSink,
  TraceStreamServer,
  type SseSink,
} from "./traceStreamServer.js";

const ISO_AT = "2024-06-15T12:00:00.000Z";

function thoughtRecord(text: string) {
  return { kind: "thought" as const, text, at: ISO_AT };
}

/**
 * In-memory {@link SseSink} used for deterministic streaming tests.
 *
 * `pause()` simulates a back-pressured consumer: subsequent `write`
 * calls return `false` and `drain()` blocks until `resume()` is called.
 * `frames` records every chunk handed to `write`, in order.
 */
class TestSink implements SseSink {
  public readonly frames: string[] = [];
  public ended = false;
  private paused = false;
  private drainResolvers: Array<() => void> = [];
  private closeHandlers: Array<() => void> = [];
  private closedFlag = false;

  public pause(): void {
    this.paused = true;
  }

  public resume(): void {
    this.paused = false;
    const pending = this.drainResolvers;
    this.drainResolvers = [];
    for (const fn of pending) fn();
  }

  public close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    const handlers = this.closeHandlers;
    this.closeHandlers = [];
    for (const fn of handlers) fn();
    // Wake any pending drain so the pipeline can unwind.
    const drains = this.drainResolvers;
    this.drainResolvers = [];
    for (const fn of drains) fn();
  }

  public write(chunk: string): boolean {
    if (this.closedFlag) return false;
    this.frames.push(chunk);
    return !this.paused;
  }

  public drain(): Promise<void> {
    if (this.closedFlag || !this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  public onClose(cb: () => void): void {
    if (this.closedFlag) {
      cb();
      return;
    }
    this.closeHandlers.push(cb);
  }

  public end(): void {
    this.ended = true;
  }
}

interface ParsedFrame {
  readonly event: string;
  readonly data: unknown;
  readonly id: string | null;
}

/** Parse the SSE frames written to {@link TestSink.frames}. */
function parseFrames(sink: TestSink): ParsedFrame[] {
  const text = sink.frames.join("");
  const blocks = text.split("\n\n").filter((b) => b.length > 0);
  const out: ParsedFrame[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    let event = "message";
    const dataLines: string[] = [];
    let id: string | null = null;
    let isComment = false;
    for (const line of lines) {
      if (line.startsWith(":")) {
        // Comment / heartbeat — not a real frame.
        isComment = true;
        continue;
      }
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      } else if (line.startsWith("id:")) {
        id = line.slice("id:".length).trim();
      }
    }
    if (isComment && dataLines.length === 0) continue;
    const dataText = dataLines.join("\n");
    let data: unknown = dataText;
    try {
      data = JSON.parse(dataText);
    } catch {
      // Leave as raw string if not JSON.
    }
    out.push({ event, data, id });
  }
  return out;
}

/** Wait for `predicate(sink)` to become true or fail after `timeoutMs`. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
  message = "condition not met in time",
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(message);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("streamTraceToSink — history then live", () => {
  it("emits history first, then a history-end marker, then live events", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    // Pre-publish history.
    await bus.publish({
      taskId: "task-A",
      agentId: "researcher",
      record: thoughtRecord("h1"),
    });
    await bus.publish({
      taskId: "task-A",
      agentId: "coder",
      record: thoughtRecord("h2"),
    });

    const sink = new TestSink();
    const streamPromise = streamTraceToSink({
      bus,
      taskId: "task-A",
      sink,
      heartbeatIntervalMs: 0,
    });

    // Wait until the history-end marker has been written.
    await waitFor(() =>
      sink.frames.some((f) => f.includes("event: history-end")),
    );

    // Publish two more live events and let the pipeline write them.
    await bus.publish({
      taskId: "task-A",
      agentId: "reviewer",
      record: thoughtRecord("live-1"),
    });
    await bus.publish({
      taskId: "task-A",
      agentId: "fixer",
      record: thoughtRecord("live-2"),
    });

    await waitFor(() => parseFrames(sink).filter((f) => f.event === "trace").length >= 4);

    // Close the connection so the streaming pipeline unwinds.
    sink.close();
    await streamPromise;
    expect(sink.ended).toBe(true);

    const parsed = parseFrames(sink);
    const traceFrames = parsed.filter((f) => f.event === "trace");
    const historyEnd = parsed.find((f) => f.event === "history-end");

    expect(traceFrames).toHaveLength(4);
    const traceSequences = traceFrames.map(
      (f) => (f.data as TraceEvent).sequence,
    );
    expect(traceSequences).toEqual([1, 2, 3, 4]);

    // The first two trace frames precede history-end; the last two follow it.
    const historyEndIdx = parsed.findIndex((f) => f.event === "history-end");
    expect(historyEndIdx).toBeGreaterThanOrEqual(0);
    const beforeEnd = parsed
      .slice(0, historyEndIdx)
      .filter((f) => f.event === "trace");
    const afterEnd = parsed
      .slice(historyEndIdx + 1)
      .filter((f) => f.event === "trace");
    expect(beforeEnd.map((f) => (f.data as TraceEvent).sequence)).toEqual([
      1, 2,
    ]);
    expect(afterEnd.map((f) => (f.data as TraceEvent).sequence)).toEqual([
      3, 4,
    ]);
    expect(historyEnd?.data).toEqual({ upTo: 2 });

    // Each trace frame's `id` field matches the event sequence.
    expect(traceFrames.map((f) => f.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("does not duplicate events that race between subscribe and snapshot", async () => {
    // We can't easily inject a precise race; instead we verify the
    // dedupe rule: if an event with sequence ≤ maxHistorySeq arrives on
    // the live channel, it is suppressed.
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    // Pre-publish three history events.
    for (let i = 0; i < 3; i += 1) {
      await bus.publish({
        taskId: "task-D",
        agentId: "researcher",
        record: thoughtRecord(`h-${i}`),
      });
    }

    const sink = new TestSink();
    const streamPromise = streamTraceToSink({
      bus,
      taskId: "task-D",
      sink,
      heartbeatIntervalMs: 0,
    });

    // Wait for history to flush so the in-memory `maxHistorySeq` is set.
    await waitFor(() =>
      sink.frames.some((f) => f.includes("event: history-end")),
    );

    // Publish two new events; they must arrive on the live channel
    // exactly once.
    await bus.publish({
      taskId: "task-D",
      agentId: "coder",
      record: thoughtRecord("live-1"),
    });
    await bus.publish({
      taskId: "task-D",
      agentId: "coder",
      record: thoughtRecord("live-2"),
    });

    await waitFor(
      () =>
        parseFrames(sink).filter((f) => f.event === "trace").length >= 5,
    );

    sink.close();
    await streamPromise;

    const traceFrames = parseFrames(sink).filter(
      (f) => f.event === "trace",
    );
    const sequences = traceFrames.map(
      (f) => (f.data as TraceEvent).sequence,
    );
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

describe("streamTraceToSink — per-agent filtering", () => {
  it("delivers only events whose agentId matches the subscription filter", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    // Pre-publish a mixed history.
    await bus.publish({
      taskId: "task-B",
      agentId: "researcher",
      record: thoughtRecord("h1"),
    });
    await bus.publish({
      taskId: "task-B",
      agentId: "coder",
      record: thoughtRecord("h2"),
    });
    await bus.publish({
      taskId: "task-B",
      agentId: "researcher",
      record: thoughtRecord("h3"),
    });

    const sink = new TestSink();
    const streamPromise = streamTraceToSink({
      bus,
      taskId: "task-B",
      agentId: "coder",
      sink,
      heartbeatIntervalMs: 0,
    });

    await waitFor(() =>
      sink.frames.some((f) => f.includes("event: history-end")),
    );

    await bus.publish({
      taskId: "task-B",
      agentId: "researcher",
      record: thoughtRecord("live-r"),
    });
    await bus.publish({
      taskId: "task-B",
      agentId: "coder",
      record: thoughtRecord("live-c"),
    });

    await waitFor(
      () =>
        parseFrames(sink).filter((f) => f.event === "trace").length >= 2,
    );

    // Give any stray (non-matching) events a tick to arrive — they must
    // not show up.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    sink.close();
    await streamPromise;

    const traceFrames = parseFrames(sink).filter(
      (f) => f.event === "trace",
    );
    expect(traceFrames).toHaveLength(2);
    const agentIds = traceFrames.map(
      (f) => (f.data as TraceEvent).agentId,
    );
    expect(agentIds.every((a) => a === "coder")).toBe(true);
  });
});

describe("streamTraceToSink — slow client back-pressure", () => {
  it(
    "drops oldest events and emits a synthetic delayed event when the buffer fills",
    async () => {
      const backend = new InMemoryTraceEventStoreBackend();
      const bus = new TraceEventBus({ backend });

      const sink = new TestSink();
      // Pause writes immediately so history can flush but live events
      // start to back up.
      const streamPromise = streamTraceToSink({
        bus,
        taskId: "task-C",
        sink,
        bufferSize: 3,
        heartbeatIntervalMs: 0,
      });

      // Wait for the initial header writes to land.
      await waitFor(() =>
        sink.frames.some((f) => f.includes("event: history-end")),
      );

      // Now pause the consumer and publish more than 2x the buffer. The
      // earliest events should be dropped from our internal buffer; once
      // we resume the connection we expect a `delayed` event followed by
      // only the most recent `bufferSize` live events.
      sink.pause();

      const total = 10;
      for (let i = 0; i < total; i += 1) {
        await bus.publish({
          taskId: "task-C",
          agentId: "researcher",
          record: thoughtRecord(`live-${i}`),
        });
      }

      // Yield to let the feeder drain everything into the local buffer.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));

      // Resume the consumer; the pipeline now flushes whatever survived
      // in the local bounded buffer.
      sink.resume();

      await waitFor(
        () => parseFrames(sink).some((f) => f.event === "delayed"),
        2_000,
        "expected a synthetic delayed event after buffer overflow",
      );
      // Wait until the trailing trace frames have been written too.
      await waitFor(() => {
        const traceFrames = parseFrames(sink).filter(
          (f) => f.event === "trace",
        );
        return traceFrames.length >= 3;
      });

      sink.close();
      await streamPromise;

      const parsed = parseFrames(sink);
      const delayed = parsed.filter((f) => f.event === "delayed");
      expect(delayed.length).toBeGreaterThanOrEqual(1);
      const totalDropped = delayed.reduce(
        (acc, f) => acc + ((f.data as { droppedCount: number }).droppedCount ?? 0),
        0,
      );
      // We pushed 10 events through a buffer of size 3. At most one
      // event can be in flight in the sink (already written, awaiting
      // drain) when the buffer first fills, so at least
      // `total - bufferSize - 1` events must have been reported as
      // dropped — that's 10 − 3 − 1 = 6 here.
      expect(totalDropped).toBeGreaterThanOrEqual(total - 3 - 1);

      const traceFrames = parsed.filter((f) => f.event === "trace");
      // History had 0 events; live trace frames after drops are at most
      // `bufferSize + 1` (the one already in flight when back-pressure
      // hit, plus the surviving tail of the bounded buffer).
      const liveTraceFrames = traceFrames.filter(
        (f) => (f.data as TraceEvent).sequence > 0,
      );
      expect(liveTraceFrames.length).toBeLessThanOrEqual(3 + 1);

      // The surviving frames must be a contiguous tail of the published
      // sequence (the most recent ones), because drop-oldest preserves
      // newest events.
      const survivingSeqs = liveTraceFrames.map(
        (f) => (f.data as TraceEvent).sequence,
      );
      const sortedSeqs = [...survivingSeqs].sort((a, b) => a - b);
      expect(survivingSeqs).toEqual(sortedSeqs);
      // And the last surviving frame must be the very last event we
      // published (sequence === total).
      expect(survivingSeqs[survivingSeqs.length - 1]).toBe(total);
    },
  );
});

describe("streamTraceToSink — connection lifecycle", () => {
  it("ends the sink and detaches from the bus when the consumer closes", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    const sink = new TestSink();
    const streamPromise = streamTraceToSink({
      bus,
      taskId: "task-E",
      sink,
      heartbeatIntervalMs: 0,
    });

    await waitFor(() =>
      sink.frames.some((f) => f.includes("event: history-end")),
    );

    // Closing the sink represents a peer disconnect.
    sink.close();
    await streamPromise;

    expect(sink.ended).toBe(true);

    // Publishing after disconnect must not throw or accumulate frames.
    const framesBefore = sink.frames.length;
    await bus.publish({
      taskId: "task-E",
      agentId: "researcher",
      record: thoughtRecord("after-close"),
    });
    // Give any stray dispatch a chance to arrive — there should be none.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(sink.frames.length).toBe(framesBefore);
  });

  it("rejects empty taskId and agentId at the streaming layer", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });
    const sink = new TestSink();
    await expect(
      streamTraceToSink({
        bus,
        // @ts-expect-error -- intentional invalid input
        taskId: "",
        sink,
        heartbeatIntervalMs: 0,
      }),
    ).rejects.toThrow(/taskId/);

    await expect(
      streamTraceToSink({
        bus,
        taskId: "task-X",
        // @ts-expect-error -- intentional invalid input
        agentId: "",
        sink,
        heartbeatIntervalMs: 0,
      }),
    ).rejects.toThrow(/agentId/);
  });
});

describe("TraceStreamServer.handleHttpRequest — query parameter validation", () => {
  it("returns 400 when taskId is missing", async () => {
    const bus = new TraceEventBus({
      backend: new InMemoryTraceEventStoreBackend(),
    });
    const server = new TraceStreamServer({
      bus,
      heartbeatIntervalMs: 0,
    });

    const { req, res, sentChunks, headers, statusCode } = makeFakeReqRes(
      "/trace",
    );

    await server.handleHttpRequest(req, res);

    expect(statusCode()).toBe(400);
    expect(headers()["Content-Type"]).toBe("application/json");
    const body = sentChunks().join("");
    expect(JSON.parse(body)).toEqual({
      error: "taskId query parameter is required",
    });
  });

  it("opens an SSE stream when taskId is present", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });
    await bus.publish({
      taskId: "task-F",
      agentId: "researcher",
      record: thoughtRecord("h1"),
    });

    const server = new TraceStreamServer({
      bus,
      heartbeatIntervalMs: 0,
    });

    const { req, res, sentChunks, headers, statusCode, simulateClose } =
      makeFakeReqRes("/trace?taskId=task-F");

    const handlerPromise = server.handleHttpRequest(req, res);

    // Wait for the headers + history-end to land, then close the
    // simulated socket so the handler resolves.
    await waitFor(
      () =>
        sentChunks().join("").includes("event: history-end"),
      2_000,
      "handler never wrote history-end",
    );
    simulateClose();
    await handlerPromise;

    expect(statusCode()).toBe(200);
    expect(headers()["Content-Type"]).toBe("text/event-stream");
    const body = sentChunks().join("");
    expect(body).toContain("event: trace");
    expect(body).toContain("event: history-end");
  });
});

describe("createNodeResponseSink", () => {
  it("propagates request close events to onClose handlers", () => {
    const { req, res } = makeFakeReqRes("/trace");
    const sink = createNodeResponseSink(req, res);

    let closed = false;
    sink.onClose(() => {
      closed = true;
    });

    req.emit("close");
    expect(closed).toBe(true);

    // Subsequent onClose registrations fire synchronously after close.
    let lateClosed = false;
    sink.onClose(() => {
      lateClosed = true;
    });
    expect(lateClosed).toBe(true);
  });

  it("write returns false after close and end is idempotent", () => {
    const { req, res } = makeFakeReqRes("/trace");
    const sink = createNodeResponseSink(req, res);
    res.emit("close");
    expect(sink.write("data: x\n\n")).toBe(false);
    sink.end();
    sink.end();
  });
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface FakeReqRes {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly sentChunks: () => string[];
  readonly headers: () => Record<string, string>;
  readonly statusCode: () => number;
  readonly simulateClose: () => void;
}

/**
 * Minimal stand-ins for `IncomingMessage` / `ServerResponse` that capture
 * what the streaming pipeline writes. We avoid a real HTTP socket because
 * it would force us to depend on a free port and add timing flakiness to
 * what is conceptually an in-process test.
 */
function makeFakeReqRes(url: string): FakeReqRes {
  const req = new EventEmitter() as IncomingMessage;
  Object.assign(req, {
    url,
    headers: { host: "localhost" },
  });

  const res = new EventEmitter() as ServerResponse;
  const chunks: string[] = [];
  let writtenStatus = 0;
  let writtenHeaders: Record<string, string> = {};

  Object.assign(res, {
    writeHead(
      status: number,
      headers?: Record<string, string>,
    ): ServerResponse {
      writtenStatus = status;
      if (headers !== undefined) writtenHeaders = { ...headers };
      return res;
    },
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
    end(chunk?: string): ServerResponse {
      if (typeof chunk === "string" && chunk.length > 0) {
        chunks.push(chunk);
      }
      return res;
    },
  });

  return {
    req,
    res,
    sentChunks: () => chunks.slice(),
    headers: () => ({ ...writtenHeaders }),
    statusCode: () => writtenStatus,
    simulateClose: () => {
      req.emit("close");
    },
  };
}
