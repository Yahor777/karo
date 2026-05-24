/**
 * Public types for the Agent_Trace panel (task 11.3).
 *
 * Sources:
 *   • design.md → "Trace Event Bus" — `TraceEvent` shape and the SSE
 *     wire format (`trace`, `history-end`, `delayed`) defined in
 *     `apps/backend/src/trace/traceStreamServer.ts`.
 *   • design.md → "Data Models" → "Agent_Trace" — `TraceRecord`
 *     discriminated union (`thought`, `tool_call`, `artifact_change`,
 *     `status`).
 *   • requirements.md →
 *       11.1 (participating agents with current status),
 *       11.2 (per-agent reasoning, tool calls and artifact changes),
 *       11.3 (live updates with ≤ 2 s latency),
 *       11.6 (delayed updates surface "Updating..." but never block UI),
 *       11.8 (UI parity between Desktop and Web).
 *
 * The shapes here mirror the backend trace types so the renderer does
 * not have to import from `apps/backend`. They are structurally
 * compatible with `apps/backend/src/trace/types.ts`.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.6, 11.8.
 */

import type { AgentId, TaskId } from "@ai-agent-orchestrator/shared-core";
import type {
  TraceAgentStatus,
  TraceEvent,
  TraceRecord,
} from "@ai-agent-orchestrator/validation";

/**
 * A single message yielded by the trace stream.
 *
 * The shape mirrors the SSE wire format documented in
 * `apps/backend/src/trace/traceStreamServer.ts`:
 *
 *   • `event: trace`        → `{ kind: "event", event }`
 *   • `event: history-end`  → `{ kind: "history-end", upTo }`
 *   • `event: delayed`      → `{ kind: "delayed", droppedCount }`
 *
 * Concrete `TraceStreamGateway` implementations parse the SSE frames
 * (or use the browser's `EventSource`) and yield these structured
 * records so tests can stub the stream without speaking SSE.
 */
export type TraceStreamMessage =
  | { readonly kind: "event"; readonly event: TraceEvent }
  | { readonly kind: "history-end"; readonly upTo: number }
  | { readonly kind: "delayed"; readonly droppedCount: number };

/**
 * Open subscription to the trace stream for a single task (optionally
 * filtered by agent). Implementations MUST yield `TraceStreamMessage`s
 * in arrival order until either:
 *
 *   • the iterator is closed by the consumer (via `close()` or
 *     `return()` on the `for await` loop), OR
 *   • the underlying transport closes (e.g. SSE peer disconnect).
 *
 * The iterable contract is preferred over a callback so tests can
 * deterministically drive the controller via a manually-fed queue and
 * the production EventSource adapter can drop in unchanged.
 */
export interface TraceStreamSubscription
  extends AsyncIterable<TraceStreamMessage> {
  /**
   * Close the subscription. Idempotent. After `close()`, the iterator
   * MUST eventually report `done: true` so consumers can unwind their
   * `for await` loop.
   */
  close(): void;
}

/**
 * Inbound port for the controller.
 *
 * In production this is wired to a Client SDK call that ultimately
 * connects to `TraceStreamServer.handleHttpRequest` via SSE. In tests
 * we stub it with a manually-fed queue.
 */
export interface TraceStreamGateway {
  open(input: {
    readonly taskId: TaskId;
    readonly agentId?: AgentId;
  }): TraceStreamSubscription;
}

/**
 * A timer port. Carved out so tests can drive the "no event for > 2 s"
 * detection deterministically without `vi.useFakeTimers()`.
 *
 * Default implementation forwards to `globalThis.setTimeout` /
 * `clearTimeout`.
 */
export interface TimerPort {
  /** Returns the current monotonic-ish time in milliseconds. */
  now(): number;
  /**
   * Schedule `cb` to run after `ms` milliseconds. Return a handle
   * exposing `cancel()`; calling `cancel()` after the callback has
   * fired is a no-op.
   */
  setTimeout(cb: () => void, ms: number): TimerHandle;
}

export interface TimerHandle {
  cancel(): void;
}

/**
 * Lifecycle status of a single agent observed in the trace.
 *
 *   • `pending`  — we have seen the agent (any record), but no
 *                  `status` record yet. The orchestrator publishes a
 *                  `status: started` first thing, so this state should
 *                  be brief in practice.
 *   • `started`  — last `status` record was `started`.
 *   • `finished` — last `status` record was `finished`.
 *   • `error`    — last `status` record was `error`.
 */
export type AgentTraceLifecycle =
  | "pending"
  | TraceAgentStatus; // "started" | "finished" | "error"

/**
 * A per-agent summary used to render the sidebar.
 */
export interface TraceAgentSummary {
  readonly agentId: AgentId;
  readonly status: AgentTraceLifecycle;
  /** Sequence of the first event seen for this agent. */
  readonly firstSequence: number;
  /** Sequence of the most recent event seen for this agent. */
  readonly lastSequence: number;
}

/**
 * A gap notice surfaced when the server reports it dropped events
 * behind a slow client. Mapped 1:1 from the SSE `delayed` event.
 */
export interface TraceGapNotice {
  readonly droppedCount: number;
  /** Wall-clock time (ms) at which the gap was reported. */
  readonly at: number;
}

/**
 * Connection status reported by the controller.
 */
export type TraceConnectionStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading-history" }
  | { readonly kind: "live" }
  | { readonly kind: "closed" }
  | { readonly kind: "error"; readonly reason: string };

/**
 * Top-level controller snapshot. The DOM mount renders directly from
 * this shape; tests assert against it.
 */
export interface AgentTraceState {
  readonly taskId: TaskId;
  /** All trace records received so far, ordered by `sequence`. */
  readonly records: readonly TraceEvent[];
  /** Records visible after applying `selectedAgentId` filter. */
  readonly visibleRecords: readonly TraceEvent[];
  /** Per-agent summary rows for the sidebar. */
  readonly agents: readonly TraceAgentSummary[];
  /** Currently selected agent for the filter, or `null` for "all". */
  readonly selectedAgentId: AgentId | null;
  /** Whether the server has emitted the `history-end` marker. */
  readonly historyEnded: boolean;
  /**
   * `true` when no message (live event, history-end, delayed) has
   * arrived for longer than the configured threshold (default 2 s).
   * Drives the "Updating..." / "Delayed" indicator. The UI MUST stay
   * usable while delayed (Requirement 11.6).
   */
  readonly delayed: boolean;
  /** Server-reported gaps (drop-oldest events behind a slow client). */
  readonly gapNotices: readonly TraceGapNotice[];
  readonly connection: TraceConnectionStatus;
}

/** Convenience re-exports so consumers can import in one place. */
export type { AgentId, TaskId, TraceAgentStatus, TraceEvent, TraceRecord };
