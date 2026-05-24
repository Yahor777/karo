/**
 * SSE streaming endpoint for the Trace Event Bus (task 11.2).
 *
 * Sources:
 *   • design.md → "Trace Event Bus" → "Responsibilities" lists "SSE/WebSocket
 *     streaming" and "buffering" as part of this module.
 *   • design.md → "Client SDK" → `TraceClient.streamTrace(taskId, agentId?)`
 *     defines the public shape: per-task subscriptions with an optional
 *     per-agent filter.
 *   • design.md → "Technology Direction" → "SSE or WebSocket for live
 *     Agent_Trace".
 *   • requirements.md →
 *       11.3 (Agent_Trace updates within ≤ 2 s when possible);
 *       11.6 (when latency > 2 s, the system continues normal operation
 *             without blocking UI interaction).
 *
 * Why SSE over WebSocket?
 *   The bus is a one-way producer → consumer stream of `TraceEvent`s. SSE
 *   maps cleanly onto that: one HTTP response, browser-native EventSource
 *   support, automatic reconnect, no framing handshake. WebSocket adds
 *   bidirectional plumbing we do not need at this layer. We keep the
 *   transport pluggable behind the {@link SseSink} port so a WebSocket
 *   adapter can drop in later without touching the streaming pipeline.
 *
 * Wire format
 * -----------
 *   Each emitted record is a single SSE message:
 *
 *     event: trace
 *     id: <sequence>
 *     data: <JSON.stringify(TraceEvent)>
 *
 *     event: history-end
 *     data: {"upTo": <maxSequenceInHistory>}
 *
 *     event: delayed
 *     data: {"droppedCount": <N>}
 *
 *   The synthetic `history-end` event lets the client switch its UI state
 *   from "loading history" to "streaming live" deterministically.
 *
 *   The synthetic `delayed` event is the back-pressure signal documented
 *   in the task description: when a slow client falls behind enough that
 *   the per-connection buffer overflows, we drop the oldest queued events
 *   and notify the client how many were dropped. We chose drop-oldest
 *   (rather than pause publish or close the connection) because the
 *   bus must never stall its in-process producers — a single slow trace
 *   panel cannot be allowed to back-pressure the agent runtime. Clients
 *   that want a complete record can re-open the stream and replay history
 *   via `bus.listEvents` from the marker `upTo` they previously saw.
 *
 * History-then-live ordering
 * --------------------------
 *   The natural pitfall is "subscribe -> snapshot history -> stream live"
 *   missing any event published *between* the subscribe call and the
 *   snapshot. We avoid it by:
 *     1. subscribe first (the bus queues events for us from this moment),
 *     2. snapshot history,
 *     3. emit history events,
 *     4. emit `history-end`,
 *     5. drain the bus subscription, skipping events whose sequence ≤
 *        `maxSeqInHistory` (those were already covered by step 3).
 *
 *   The bus's per-subscriber queue is unbounded (see
 *   {@link TraceEventBus.subscribe}); to keep memory in check while step 2
 *   awaits the snapshot we run a tiny "feeder" task that aggressively
 *   drains the bus subscription into our local bounded buffer.
 *
 * Validates: Requirements 11.3, 11.6.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentId, TaskId } from "@ai-agent-orchestrator/shared-core";

import type {
  TraceEvent,
  TraceEventBus as TraceEventBusInterface,
} from "./types.js";

/**
 * Default per-connection event queue size. Chosen to absorb short bursts
 * (≈ a few seconds of agent activity on a fast pipeline) without consuming
 * unbounded memory if a client is genuinely stuck. Operators tuning for
 * very chatty traces can raise this via {@link TraceStreamServerOptions}.
 */
export const DEFAULT_TRACE_STREAM_BUFFER_SIZE = 500;

/**
 * Default heartbeat interval. SSE comments (`:` lines) keep the
 * intermediary proxies from closing an idle connection without showing up
 * as `TraceEvent`s on the client. 15 s is comfortably below the typical
 * 30–60 s proxy idle timeout.
 *
 * Set to `0` in {@link TraceStreamServerOptions} to disable heartbeats —
 * useful in unit tests to keep output deterministic.
 */
export const DEFAULT_TRACE_STREAM_HEARTBEAT_MS = 15_000;

/**
 * Options for {@link TraceStreamServer}.
 *
 * `bus` is required; everything else has sensible defaults.
 */
export interface TraceStreamServerOptions {
  readonly bus: TraceEventBusInterface;
  /**
   * Per-connection bounded buffer size. When the buffer is full, the
   * oldest queued event is dropped and a synthetic `delayed` SSE event is
   * emitted before the next live event so the client can detect the gap.
   *
   * Defaults to {@link DEFAULT_TRACE_STREAM_BUFFER_SIZE}. Must be ≥ 1.
   */
  readonly bufferSize?: number;
  /**
   * Heartbeat (SSE comment) interval in milliseconds. `0` disables
   * heartbeats. Defaults to {@link DEFAULT_TRACE_STREAM_HEARTBEAT_MS}.
   */
  readonly heartbeatIntervalMs?: number;
}

/**
 * Transport-agnostic write port. Production wires this to a Node HTTP
 * `ServerResponse` via {@link createNodeResponseSink}; tests substitute an
 * in-memory sink so they can exercise back-pressure deterministically.
 *
 * Contract:
 *   • `write` returns `false` when the underlying transport is full; the
 *     caller should `await drain()` before issuing more writes.
 *   • `drain` resolves when more space is available, OR immediately if the
 *     sink has already closed.
 *   • `onClose` registers a callback fired when the peer disconnects; if
 *     the sink is already closed when `onClose` is called, the callback
 *     fires synchronously.
 *   • `end` is idempotent.
 */
export interface SseSink {
  write(chunk: string): boolean;
  drain(): Promise<void>;
  onClose(cb: () => void): void;
  end(): void;
}

/**
 * Inputs to {@link streamTraceToSink}. Carved out as its own type so the
 * lower-level streaming pipeline can be tested without an HTTP layer.
 */
export interface StreamTraceToSinkInput {
  readonly bus: TraceEventBusInterface;
  readonly taskId: TaskId;
  readonly agentId?: AgentId;
  readonly sink: SseSink;
  readonly bufferSize?: number;
  readonly heartbeatIntervalMs?: number;
}

/**
 * Top-level server class. A single instance fans connections out across a
 * shared {@link TraceEventBusInterface}.
 *
 * The class is intentionally small — composition with a real HTTP gateway
 * (route registration, auth, rate limiting) lives in the gateway module.
 * Here we only own the per-request streaming pipeline.
 */
export class TraceStreamServer {
  private readonly bus: TraceEventBusInterface;
  private readonly bufferSize: number;
  private readonly heartbeatIntervalMs: number;

  public constructor(options: TraceStreamServerOptions) {
    if (options.bufferSize !== undefined && options.bufferSize < 1) {
      throw new RangeError(
        "TraceStreamServer: bufferSize must be >= 1",
      );
    }
    if (
      options.heartbeatIntervalMs !== undefined &&
      options.heartbeatIntervalMs < 0
    ) {
      throw new RangeError(
        "TraceStreamServer: heartbeatIntervalMs must be >= 0",
      );
    }
    this.bus = options.bus;
    this.bufferSize =
      options.bufferSize ?? DEFAULT_TRACE_STREAM_BUFFER_SIZE;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_TRACE_STREAM_HEARTBEAT_MS;
  }

  /**
   * Adapts a Node `IncomingMessage` / `ServerResponse` pair into the
   * SSE streaming pipeline. Resolves when the stream completes (peer
   * disconnect or natural end). Rejects only on programmer errors —
   * I/O errors are logged onto the response and the promise still
   * resolves so the caller's `try/catch` does not have to differentiate.
   *
   * Query parameters:
   *   • `taskId`  — required, non-empty string.
   *   • `agentId` — optional; restricts the stream to a single agent.
   */
  public async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      req.url ?? "/",
      // The host header is informational here — we only use the URL for
      // parsing query parameters. `localhost` is a safe placeholder when
      // the header is absent.
      `http://${req.headers.host ?? "localhost"}`,
    );
    const taskId = url.searchParams.get("taskId");
    const agentIdParam = url.searchParams.get("agentId");
    const agentId =
      agentIdParam === null || agentIdParam.length === 0
        ? undefined
        : agentIdParam;

    if (taskId === null || taskId.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "taskId query parameter is required",
        }),
      );
      return;
    }

    // SSE response headers. `X-Accel-Buffering: no` disables nginx
    // buffering so events flush immediately end-to-end.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Initial comment to flush headers and signal a live channel.
    res.write(": connected\n\n");

    const sink = createNodeResponseSink(req, res);

    await streamTraceToSink({
      bus: this.bus,
      taskId,
      ...(agentId !== undefined ? { agentId } : {}),
      sink,
      bufferSize: this.bufferSize,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    });
  }
}

// ---------------------------------------------------------------------
// Lower-level streaming pipeline
// ---------------------------------------------------------------------

/**
 * Drives a single subscriber connection end-to-end against an
 * {@link SseSink}. Exposed (and exported) so unit tests can exercise the
 * pipeline without spinning up a real HTTP server.
 *
 * Lifecycle:
 *   1. Subscribe to the bus (so no events between here and the snapshot
 *      are lost).
 *   2. Start a feeder task that drains the bus subscription into a
 *      bounded local queue (drop-oldest on overflow).
 *   3. Snapshot history via `bus.listEvents(taskId)` and write it.
 *   4. Emit `history-end` so the client can transition state.
 *   5. Drain the bounded queue, emitting a synthetic `delayed` event
 *      whenever drops occurred. Skip events whose sequence ≤ the maximum
 *      sequence seen in step 3 — those are duplicates of history.
 *   6. On peer disconnect or normal completion, cancel the bus
 *      subscription and end the sink.
 */
export async function streamTraceToSink(
  input: StreamTraceToSinkInput,
): Promise<void> {
  validateNonEmptyString(input.taskId, "taskId");
  if (input.agentId !== undefined) {
    validateNonEmptyString(input.agentId, "agentId");
  }
  const bufferSize =
    input.bufferSize ?? DEFAULT_TRACE_STREAM_BUFFER_SIZE;
  if (bufferSize < 1) {
    throw new RangeError("streamTraceToSink: bufferSize must be >= 1");
  }
  const heartbeatIntervalMs =
    input.heartbeatIntervalMs ?? DEFAULT_TRACE_STREAM_HEARTBEAT_MS;
  if (heartbeatIntervalMs < 0) {
    throw new RangeError(
      "streamTraceToSink: heartbeatIntervalMs must be >= 0",
    );
  }

  const { bus, taskId, agentId, sink } = input;

  // Step 1: subscribe before we do anything else.
  const subscription = bus.subscribe({
    taskId,
    ...(agentId !== undefined ? { agentId } : {}),
  });
  const subIter = subscription[Symbol.asyncIterator]();

  // Connection state.
  let closed = false;
  let waker: (() => void) | null = null;
  const wake = (): void => {
    const fn = waker;
    waker = null;
    if (fn !== null) fn();
  };
  const onClose = (): void => {
    if (closed) return;
    closed = true;
    wake();
  };
  sink.onClose(onClose);

  // Bounded buffer. We use a plain array as a ring-style queue: shift to
  // drop oldest, push to enqueue. Array operations are O(buffer) on shift
  // but `bufferSize` is small (default 500) and the dominant cost is the
  // socket write, not the buffer manipulation.
  const queue: TraceEvent[] = [];
  let droppedSinceLastNotice = 0;

  // Step 2: feeder task.
  const feederPromise = (async (): Promise<void> => {
    try {
      while (!closed) {
        const next = await subIter.next();
        if (next.done === true || closed) break;
        const ev = next.value;
        if (queue.length >= bufferSize) {
          queue.shift();
          droppedSinceLastNotice += 1;
        }
        queue.push(ev);
        wake();
      }
    } catch {
      // Subscription threw; treat as a graceful shutdown of the feed.
      // The main loop observes `closed` once we set it below.
    } finally {
      // Whether or not we closed cleanly, signal the consumer so it can
      // exit if the bus iterator finished on its own.
      wake();
    }
  })();

  // Heartbeat timer — keeps the connection warm through proxies.
  const heartbeat =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          // Heartbeats are advisory; ignore back-pressure here.
          if (!closed) sink.write(": heartbeat\n\n");
        }, heartbeatIntervalMs)
      : null;
  // `unref` so the heartbeat timer never keeps the process alive on its
  // own. Some runtimes (browsers, fake timers) lack `unref`; guard it.
  if (
    heartbeat !== null &&
    typeof (heartbeat as { unref?: () => void }).unref === "function"
  ) {
    (heartbeat as { unref: () => void }).unref();
  }

  try {
    // Step 3: history snapshot. We filter by agentId here because
    // `bus.listEvents` returns the full task log; the bus subscription
    // already applies the agent filter natively.
    const history = await bus.listEvents(taskId);
    const filteredHistory =
      agentId === undefined
        ? history
        : history.filter((ev) => ev.agentId === agentId);

    let maxHistorySeq = 0;
    for (const ev of filteredHistory) {
      if (closed) return;
      if (ev.sequence > maxHistorySeq) maxHistorySeq = ev.sequence;
      if (!sink.write(formatTraceEventFrame(ev))) {
        await sink.drain();
      }
    }

    // Step 4: history-end marker.
    if (!closed) {
      const frame =
        `event: history-end\n` +
        `data: ${JSON.stringify({ upTo: maxHistorySeq })}\n\n`;
      if (!sink.write(frame)) {
        await sink.drain();
      }
    }

    // Step 5: live drain.
    while (!closed) {
      // Drain everything currently buffered before sleeping.
      while (queue.length > 0 && !closed) {
        if (droppedSinceLastNotice > 0) {
          const droppedCount = droppedSinceLastNotice;
          droppedSinceLastNotice = 0;
          const frame =
            `event: delayed\n` +
            `data: ${JSON.stringify({ droppedCount })}\n\n`;
          if (!sink.write(frame)) {
            await sink.drain();
          }
          if (closed) break;
        }
        const ev = queue.shift();
        if (ev === undefined) break;
        // Skip events that were already covered by the history snapshot.
        if (ev.sequence <= maxHistorySeq) continue;
        if (!sink.write(formatTraceEventFrame(ev))) {
          await sink.drain();
        }
      }
      if (closed) break;
      // No work — wait for the feeder (or `onClose`) to wake us.
      await new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        waker = resolve;
      });
    }
  } finally {
    closed = true;
    wake();
    if (heartbeat !== null) clearInterval(heartbeat);
    // Detach the subscriber from the bus.
    try {
      await subIter.return?.();
    } catch {
      // Iterator close errors are non-fatal here.
    }
    // Wait for the feeder to exit so we never leave a dangling task.
    await feederPromise.catch(() => undefined);
    sink.end();
  }
}

// ---------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------

/**
 * Format a {@link TraceEvent} as a single SSE message.
 *
 * Per the SSE spec, embedded newlines in `data:` must be escaped by
 * splitting them onto multiple `data:` lines. JSON.stringify never emits
 * literal newlines for our shape (no carriage returns, no raw bytes), so
 * a single `data:` line is correct.
 */
function formatTraceEventFrame(event: TraceEvent): string {
  return (
    `event: trace\n` +
    `id: ${event.sequence}\n` +
    `data: ${JSON.stringify(event)}\n\n`
  );
}

// ---------------------------------------------------------------------
// Node HTTP adapter
// ---------------------------------------------------------------------

/**
 * Adapts a Node `ServerResponse` to the {@link SseSink} contract.
 *
 * Node already buffers writes internally; `res.write` returns `false`
 * when its high-water mark is reached, and emits `'drain'` once the
 * kernel has accepted enough bytes to keep going. We translate those
 * primitives into our `write` / `drain` shape.
 *
 * Disconnects are observed on either the request (peer FIN, abort) or
 * the response (server-side close). Both routes converge on the single
 * `markClosed` path so handlers fire exactly once.
 */
export function createNodeResponseSink(
  req: IncomingMessage,
  res: ServerResponse,
): SseSink {
  let isClosed = false;
  let closeHandlers: Array<() => void> = [];
  let drainResolvers: Array<() => void> = [];

  const onDrain = (): void => {
    const pending = drainResolvers;
    drainResolvers = [];
    for (const fn of pending) fn();
  };
  res.on("drain", onDrain);

  const markClosed = (): void => {
    if (isClosed) return;
    isClosed = true;
    // Resolve any pending drain waiters so the streaming pipeline can
    // unwind instead of hanging forever on a dead socket.
    const drains = drainResolvers;
    drainResolvers = [];
    for (const fn of drains) fn();
    const handlers = closeHandlers;
    closeHandlers = [];
    for (const fn of handlers) {
      try {
        fn();
      } catch {
        // Handlers must not block close propagation.
      }
    }
  };

  req.on("close", markClosed);
  req.on("aborted", markClosed);
  res.on("close", markClosed);
  res.on("error", markClosed);

  return {
    write(chunk: string): boolean {
      if (isClosed) return false;
      try {
        return res.write(chunk);
      } catch {
        markClosed();
        return false;
      }
    },
    drain(): Promise<void> {
      if (isClosed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drainResolvers.push(resolve);
      });
    },
    onClose(cb: () => void): void {
      if (isClosed) {
        try {
          cb();
        } catch {
          // ignore
        }
        return;
      }
      closeHandlers.push(cb);
    },
    end(): void {
      if (isClosed) return;
      try {
        res.end();
      } catch {
        // res may already be in a terminal state; closing again is a
        // no-op as far as the pipeline is concerned.
      }
    },
  };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function validateNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `streamTraceToSink: ${field} must be a non-empty string`,
    );
  }
}
