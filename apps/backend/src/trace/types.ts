/**
 * Trace Event Bus types (task 11.1).
 *
 * Sources:
 * - design.md → "Trace Event Bus" → "Interface" (`publish` / `subscribe`,
 *   `TraceEvent` carrying `sequence`).
 * - design.md → "Data Models" → "Agent_Trace" (`TraceRecord` discriminated
 *   union: `thought`, `tool_call`, `artifact_change`, `status`).
 * - requirements.md →
 *     9.5  (Web_Search_Tool calls are recorded as `tool_call`),
 *     11.2 (UI shows reasoning, tool calls and artifact changes from the
 *           Agent_Trace),
 *     11.7 (full Agent_Trace preserved for completed tasks).
 *
 * Public surface from the validation package — `TraceRecord` and
 * `TraceEvent` — is re-exported here so other backend modules can write
 * `import { TraceEvent } from "../trace"` without reaching across packages.
 *
 * Task 11.1 implements only the in-process `publish` / `subscribe` API and
 * the persistence model. Live SSE/WebSocket streaming endpoints land in
 * task 11.2 on top of this same backend port; the UI panel lands in task
 * 11.3.
 */

import type { AgentId, TaskId } from "@ai-agent-orchestrator/shared-core";

// Re-export the canonical Trace types from validation so callers have a
// single import surface for the trace subsystem.
export type {
  ArtifactChangeTraceRecord,
  StatusTraceRecord,
  ThoughtTraceRecord,
  ToolCallTraceRecord,
  TraceAgentStatus,
  TraceEvent,
  TraceRecord,
} from "@ai-agent-orchestrator/validation";

import type {
  TraceEvent,
  TraceRecord,
} from "@ai-agent-orchestrator/validation";

/**
 * Input for {@link TraceEventBus.publish}.
 *
 * Mirrors the design-doc signature 1:1. The bus assigns the per-task
 * `sequence` at publish time so callers do not coordinate counters across
 * agents.
 */
export interface PublishTraceInput {
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly record: TraceRecord;
}

/**
 * Input for {@link TraceEventBus.subscribe}. `agentId` is optional — when
 * supplied, the subscription only receives events for that agent within the
 * task. This matches the design's per-task / per-agent split (Requirement
 * 11.2: clicking a single agent in the UI shows only that agent's trace).
 */
export interface SubscribeTraceInput {
  readonly taskId: TaskId;
  readonly agentId?: AgentId;
}

/**
 * Pluggable persistence backend for trace events.
 *
 * The service layer ({@link TraceEventBus}) owns:
 *   • per-task monotonic `sequence` assignment,
 *   • in-process subscriber fan-out,
 *   • input validation.
 *
 * Backends only have to provide append-and-read semantics over an ordered
 * per-task log of `TraceEvent`s. Records are append-only; the bus never
 * mutates a previously-published event. This split keeps an
 * encrypted-SQLite adapter (later task) trivial — it just persists rows of
 * `TraceEvent` shape.
 *
 * Atomicity contract: `append` MUST persist the supplied event before
 * returning. Concurrent `publish` calls for the same `taskId` are
 * serialised by the service so the backend does not have to provide its
 * own transaction layer in task 11.1.
 */
export interface TraceEventStoreBackend {
  /**
   * Append a single event to the task's trace log.
   *
   * Implementations MUST NOT modify the event after persisting it; the
   * service hands over a frozen-by-convention record so concurrent
   * subscribers can read the same value safely.
   */
  append(event: TraceEvent): Promise<void>;

  /**
   * List all events for `taskId` in ascending sequence order. Returns an
   * empty array when no events have been published for the task.
   */
  list(taskId: TaskId): Promise<readonly TraceEvent[]>;

  /**
   * Returns the highest `sequence` previously persisted for `taskId`, or
   * `0` when the task has no events yet. Used by the service to recover
   * the next sequence number after a restart without scanning the full
   * log.
   */
  latestSequence(taskId: TaskId): Promise<number>;
}

/**
 * Public surface of the Trace Event Bus.
 *
 * The bus is in-process for task 11.1. Subscribers receive events via an
 * `AsyncIterable<TraceEvent>` so callers can pipe them into HTTP streaming
 * adapters (task 11.2) or test harnesses without changing the contract.
 *
 * Cancellation:
 *   • Calling `return()` on the iterator (e.g. via `break` inside a
 *     `for await` loop) detaches the subscriber from the bus and frees
 *     any internal buffers.
 *   • The bus does not close subscribers on its own; long-lived
 *     consumers are expected to manage their own lifetimes.
 */
export interface TraceEventBus {
  /**
   * Persist a {@link TraceRecord} as a {@link TraceEvent} and broadcast it
   * to every active subscriber whose filter matches.
   */
  publish(input: PublishTraceInput): Promise<TraceEvent>;

  /**
   * Subscribe to events for `taskId` (optionally filtered to a single
   * `agentId`). The returned iterable yields events as they are published.
   *
   * Subscriptions never replay historical events — the orchestrator owns
   * "load history then stream" by combining {@link listEvents} with
   * `subscribe` (task 11.3 builds that flow for the UI). Keeping the
   * primitive simple here avoids re-delivery hazards on the boundary
   * between the historical and live windows.
   */
  subscribe(input: SubscribeTraceInput): AsyncIterable<TraceEvent>;

  /**
   * Snapshot of all persisted events for `taskId` in ascending sequence
   * order. Exposed on the bus so the orchestrator and UI can pull the
   * history without reaching into the backend directly.
   */
  listEvents(taskId: TaskId): Promise<readonly TraceEvent[]>;
}
