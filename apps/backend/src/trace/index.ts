/**
 * Public surface of the backend Trace Event Bus module.
 *
 * Task 11.1 ships the in-process `publish` / `subscribe` API plus an
 * in-memory persistence backend for tests and bring-up. Task 11.2 layers
 * an SSE streaming endpoint on top:
 *
 *   • {@link TraceEventBus}                       — `publish` + `subscribe`
 *     with monotonic per-task `sequence`. SSE/WebSocket streaming
 *     (task 11.2) and the UI panel (task 11.3) layer on top of this bus.
 *   • {@link InMemoryTraceEventStoreBackend}      — pluggable storage
 *     backend for tests and early bring-up; production swaps in encrypted
 *     SQLite or a cloud-backed store.
 *   • {@link TraceStreamServer} / {@link streamTraceToSink} /
 *     {@link createNodeResponseSink} — SSE streaming endpoint with
 *     per-task and per-agent subscriptions, server-side buffering and
 *     drop-oldest back-pressure for slow clients.
 *   • {@link TraceEventStoreBackend} /
 *     {@link PublishTraceInput} / {@link SubscribeTraceInput} /
 *     {@link TraceEvent} / {@link TraceRecord} (and friends) — public
 *     types and ports.
 *
 * Validates: Requirements 9.5, 11.2, 11.3, 11.6, 11.7.
 */

export { TraceEventBus } from "./traceEventBus.js";
export type { TraceEventBusOptions } from "./traceEventBus.js";

export { InMemoryTraceEventStoreBackend } from "./inMemoryStore.js";

export { redactTraceRecord } from "./redaction.js";

export {
  createNodeResponseSink,
  DEFAULT_TRACE_STREAM_BUFFER_SIZE,
  DEFAULT_TRACE_STREAM_HEARTBEAT_MS,
  streamTraceToSink,
  TraceStreamServer,
} from "./traceStreamServer.js";
export type {
  SseSink,
  StreamTraceToSinkInput,
  TraceStreamServerOptions,
} from "./traceStreamServer.js";

export type {
  ArtifactChangeTraceRecord,
  PublishTraceInput,
  StatusTraceRecord,
  SubscribeTraceInput,
  ThoughtTraceRecord,
  ToolCallTraceRecord,
  TraceAgentStatus,
  TraceEvent,
  TraceEventBus as TraceEventBusInterface,
  TraceEventStoreBackend,
  TraceRecord,
} from "./types.js";
