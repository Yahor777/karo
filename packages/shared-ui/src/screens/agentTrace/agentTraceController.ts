/**
 * Agent_Trace panel controller (task 11.3).
 *
 * Sources:
 *   • design.md → "Trace Event Bus" — transport, history-then-live
 *     ordering and `delayed` drop-oldest semantics. Wire format lives
 *     in `apps/backend/src/trace/traceStreamServer.ts`.
 *   • requirements.md →
 *       11.1 (participating agents with statuses),
 *       11.2 (per-agent reasoning, tool calls, artifact changes),
 *       11.3 (≤ 2 s update latency target),
 *       11.6 (latency > 2 s surfaces an indicator without blocking UI),
 *       11.8 (UI parity between Desktop and Web).
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.6, 11.8.
 *
 * Design notes
 * ------------
 *   • The controller is framework-free. It exposes a tiny
 *     subscribe/getState API so the DOM mount in
 *     `mountAgentTracePanel` can re-render imperatively. A future
 *     React/Vue host can adapt the same controller.
 *   • Snapshots are immutable: `getState()` returns a frozen object.
 *     The mount uses reference equality on the `state` object to skip
 *     redundant work; on every change we hand out a new top-level
 *     reference so subscribers always observe the latest values.
 *   • Stream consumption runs in a background async loop. Calling
 *     `start()` is idempotent — it returns the existing promise if a
 *     stream is already open. `dispose()` closes the subscription and
 *     cancels the delayed-update timer.
 *   • Per Requirement 11.6 the controller must NEVER block the UI: all
 *     network/timer work happens on the gateway/timer ports, and the
 *     synchronous controller methods (`selectAgent`, `getState`,
 *     `subscribe`) never await anything.
 *   • The `delayed` flag is set when no stream message has arrived for
 *     longer than `delayThresholdMs` (default 2_000 ms). The flag is
 *     cleared as soon as any new message arrives (event, history-end,
 *     or delayed-from-server), because the server emitting `delayed`
 *     itself counts as a sign that the channel is alive but lossy —
 *     we still want the UI to leave the "frozen feed" state and show
 *     the gap notice instead.
 */

import type { AgentId, TaskId } from "@ai-agent-orchestrator/shared-core";
import type { TraceEvent } from "@ai-agent-orchestrator/validation";

import type {
  AgentTraceLifecycle,
  AgentTraceState,
  TimerHandle,
  TimerPort,
  TraceAgentSummary,
  TraceConnectionStatus,
  TraceGapNotice,
  TraceStreamGateway,
  TraceStreamMessage,
  TraceStreamSubscription,
} from "./types.js";

/** Default delay threshold per Requirement 11.6. */
export const DEFAULT_DELAY_THRESHOLD_MS = 2_000;

export interface AgentTraceControllerOptions {
  readonly taskId: TaskId;
  readonly gateway: TraceStreamGateway;
  /**
   * Latency threshold (ms) above which {@link AgentTraceState.delayed}
   * flips to `true`. Defaults to {@link DEFAULT_DELAY_THRESHOLD_MS}.
   * Must be ≥ 0.
   */
  readonly delayThresholdMs?: number;
  /**
   * Optional agent filter applied initially. Useful for deep-links
   * like "show only the Reviewer". Defaults to `null` (all agents).
   */
  readonly initialSelectedAgentId?: AgentId | null;
  /**
   * Timer port. Defaults to a `globalThis.setTimeout` adapter; tests
   * inject a fake to drive the delayed-update detection without real
   * wall-clock waits.
   */
  readonly timer?: TimerPort;
}

type Listener = (state: AgentTraceState) => void;

/**
 * Default {@link TimerPort} backed by `globalThis.setTimeout`.
 *
 * We avoid `performance.now()` so the same code works under jsdom and
 * Node without polyfills.
 */
const realTimer: TimerPort = {
  now(): number {
    return Date.now();
  },
  setTimeout(cb: () => void, ms: number): TimerHandle {
    const handle = setTimeout(cb, ms);
    return {
      cancel(): void {
        clearTimeout(handle);
      },
    };
  },
};

/**
 * Controller for the Agent_Trace panel.
 */
export class AgentTraceController {
  private readonly taskId: TaskId;
  private readonly gateway: TraceStreamGateway;
  private readonly delayThresholdMs: number;
  private readonly timer: TimerPort;
  private readonly listeners = new Set<Listener>();

  private state: AgentTraceState;
  private subscription: TraceStreamSubscription | null = null;
  private consumePromise: Promise<void> | null = null;
  private delayHandle: TimerHandle | null = null;
  private disposed = false;

  /**
   * Mutable index of agents → summary; rebuilt into the immutable
   * `state.agents` array on every change so we don't pay an O(n)
   * rebuild on each event.
   */
  private readonly agentIndex = new Map<AgentId, TraceAgentSummary>();

  public constructor(options: AgentTraceControllerOptions) {
    if (
      options.delayThresholdMs !== undefined &&
      options.delayThresholdMs < 0
    ) {
      throw new RangeError(
        "AgentTraceController: delayThresholdMs must be >= 0",
      );
    }
    this.taskId = options.taskId;
    this.gateway = options.gateway;
    this.delayThresholdMs =
      options.delayThresholdMs ?? DEFAULT_DELAY_THRESHOLD_MS;
    this.timer = options.timer ?? realTimer;

    this.state = freeze({
      taskId: options.taskId,
      records: [],
      visibleRecords: [],
      agents: [],
      selectedAgentId: options.initialSelectedAgentId ?? null,
      historyEnded: false,
      delayed: false,
      gapNotices: [],
      connection: { kind: "idle" },
    });
  }

  /** Returns the current snapshot. Stable until next change. */
  public getState(): AgentTraceState {
    return this.state;
  }

  /**
   * Registers a listener. The returned function unsubscribes.
   * Listeners are invoked synchronously after each state change.
   */
  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Opens the trace subscription and starts consuming messages.
   * Idempotent — repeated calls return the same in-flight promise.
   *
   * The returned promise resolves when the stream ends or the
   * controller is disposed; it never rejects (transport errors are
   * surfaced via {@link AgentTraceState.connection}).
   */
  public start(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.consumePromise !== null) {
      return this.consumePromise;
    }
    this.update((s) => ({ ...s, connection: { kind: "loading-history" } }));
    this.armDelayTimer();
    this.subscription = this.gateway.open({ taskId: this.taskId });
    this.consumePromise = this.consume(this.subscription);
    return this.consumePromise;
  }

  /**
   * Sets the agent filter. `null` means "show all agents". Pure UI
   * state — does not touch the network.
   */
  public selectAgent(agentId: AgentId | null): void {
    if (this.state.selectedAgentId === agentId) {
      return;
    }
    this.update((s) => {
      const visibleRecords =
        agentId === null
          ? s.records
          : s.records.filter((r) => r.agentId === agentId);
      return {
        ...s,
        selectedAgentId: agentId,
        visibleRecords,
      };
    });
  }

  /**
   * Clears any acknowledged gap notices from the state. The mount
   * helper calls this when the user dismisses the gap banner.
   */
  public dismissGapNotices(): void {
    if (this.state.gapNotices.length === 0) return;
    this.update((s) => ({ ...s, gapNotices: [] }));
  }

  /**
   * Closes the underlying subscription and cancels the delayed-update
   * timer. After dispose, `start()` is a no-op.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.delayHandle !== null) {
      this.delayHandle.cancel();
      this.delayHandle = null;
    }
    if (this.subscription !== null) {
      try {
        this.subscription.close();
      } catch {
        // Closing a stream must never throw into UI code.
      }
    }
    this.update((s) => ({ ...s, connection: { kind: "closed" } }));
  }

  // ----------------------------------------------------------------
  // Internal: stream consumption
  // ----------------------------------------------------------------

  private async consume(
    subscription: TraceStreamSubscription,
  ): Promise<void> {
    try {
      for await (const message of subscription) {
        if (this.disposed) break;
        this.handleMessage(message);
      }
    } catch (err) {
      if (!this.disposed) {
        this.update((s) => ({
          ...s,
          connection: { kind: "error", reason: describeError(err) },
        }));
      }
    } finally {
      // The stream may have ended naturally (e.g. server closed). If we
      // are not already in error/closed state, mark as closed so the UI
      // can render an appropriate indicator.
      const conn = this.state.connection;
      if (
        !this.disposed &&
        conn.kind !== "error" &&
        conn.kind !== "closed"
      ) {
        this.update((s) => ({ ...s, connection: { kind: "closed" } }));
      }
      // Cancel the delay timer once the stream is finished — no further
      // messages can arrive so the "Updating..." flag would never clear.
      if (this.delayHandle !== null) {
        this.delayHandle.cancel();
        this.delayHandle = null;
      }
    }
  }

  private handleMessage(message: TraceStreamMessage): void {
    // Any message resets the delayed-watchdog: the channel is alive.
    this.armDelayTimer();
    if (this.state.delayed) {
      this.update((s) => ({ ...s, delayed: false }));
    }

    switch (message.kind) {
      case "event":
        this.applyEvent(message.event);
        return;
      case "history-end":
        this.update((s) => ({
          ...s,
          historyEnded: true,
          connection:
            s.connection.kind === "loading-history"
              ? { kind: "live" }
              : s.connection,
        }));
        return;
      case "delayed": {
        const notice: TraceGapNotice = {
          droppedCount: message.droppedCount,
          at: this.timer.now(),
        };
        this.update((s) => ({
          ...s,
          gapNotices: [...s.gapNotices, notice],
        }));
        return;
      }
    }
  }

  private applyEvent(event: TraceEvent): void {
    // Defence-in-depth: the gateway is supposed to filter to the
    // current taskId, but if a misconfigured stream slips a stray
    // event through we'd rather drop it than corrupt state.
    if (event.taskId !== this.taskId) return;

    // Update the per-agent summary index.
    this.upsertAgentSummary(event);

    this.update((s) => {
      // Records are inserted ordered by sequence. The bus emits in
      // ascending order, but a `delayed`/reconnect could interleave;
      // do a binary insertion to keep the array sorted.
      const records = insertOrdered(s.records, event);
      const agents = snapshotAgents(this.agentIndex);
      const visibleRecords =
        s.selectedAgentId === null
          ? records
          : records.filter((r) => r.agentId === s.selectedAgentId);
      return {
        ...s,
        records,
        visibleRecords,
        agents,
        connection:
          s.connection.kind === "loading-history" && !s.historyEnded
            ? { kind: "loading-history" }
            : ({ kind: "live" } satisfies TraceConnectionStatus),
      };
    });
  }

  private upsertAgentSummary(event: TraceEvent): void {
    const prev = this.agentIndex.get(event.agentId);
    const status = computeLifecycle(prev?.status, event);
    const summary: TraceAgentSummary = {
      agentId: event.agentId,
      status,
      firstSequence: prev ? prev.firstSequence : event.sequence,
      lastSequence:
        prev && prev.lastSequence > event.sequence
          ? prev.lastSequence
          : event.sequence,
    };
    this.agentIndex.set(event.agentId, summary);
  }

  // ----------------------------------------------------------------
  // Internal: delayed-update watchdog (Requirement 11.6)
  // ----------------------------------------------------------------

  private armDelayTimer(): void {
    if (this.disposed) return;
    if (this.delayHandle !== null) {
      this.delayHandle.cancel();
      this.delayHandle = null;
    }
    if (this.delayThresholdMs === 0) return;
    this.delayHandle = this.timer.setTimeout(() => {
      this.delayHandle = null;
      if (this.disposed) return;
      if (this.state.delayed) return;
      this.update((s) => ({ ...s, delayed: true }));
    }, this.delayThresholdMs);
  }

  // ----------------------------------------------------------------
  // Internal: state plumbing
  // ----------------------------------------------------------------

  private update(
    updater: (s: AgentTraceState) => AgentTraceState,
  ): void {
    const next = updater(this.state);
    if (next === this.state) return;
    this.state = freeze(next);
    for (const l of this.listeners) {
      l(this.state);
    }
  }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/**
 * Compute the agent's lifecycle after seeing `event`. Lifecycle is
 * driven by `status` records; non-status events leave the previous
 * value unchanged (or `pending` if this is the first sighting).
 */
function computeLifecycle(
  prev: AgentTraceLifecycle | undefined,
  event: TraceEvent,
): AgentTraceLifecycle {
  if (event.record.kind === "status") {
    return event.record.status;
  }
  return prev ?? "pending";
}

/**
 * Insert `event` into `records` so the result remains sorted by
 * `sequence`. The common path (in-order arrival) appends in O(1);
 * out-of-order arrivals fall back to a binary insertion.
 */
function insertOrdered(
  records: readonly TraceEvent[],
  event: TraceEvent,
): TraceEvent[] {
  const len = records.length;
  if (len === 0) return [event];
  const last = records[len - 1];
  if (last !== undefined && event.sequence > last.sequence) {
    return [...records, event];
  }
  // Binary search for the first index whose sequence >= event.sequence.
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cur = records[mid];
    if (cur !== undefined && cur.sequence < event.sequence) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // Skip duplicates: the same `(taskId, sequence)` is published at most
  // once. If the bus replays history and live overlaps, we de-dupe here.
  const at = records[lo];
  if (at !== undefined && at.sequence === event.sequence) {
    return records as TraceEvent[];
  }
  const next = records.slice();
  next.splice(lo, 0, event);
  return next;
}

function snapshotAgents(
  index: Map<AgentId, TraceAgentSummary>,
): readonly TraceAgentSummary[] {
  // Stable order by first-sighting sequence so the sidebar does not
  // reorder rows as new events arrive for an agent we already showed.
  const arr = Array.from(index.values());
  arr.sort((a, b) => a.firstSequence - b.firstSequence);
  return arr;
}

function freeze<T>(value: T): T {
  // Object.freeze is shallow but enough for the snapshot contract:
  // arrays inside are reassigned, never mutated in place.
  return Object.freeze(value);
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  if (typeof err === "string") return err;
  return "unknown error";
}
