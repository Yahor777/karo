/**
 * `TraceRecord` and `TraceEvent` schemas (task 11.1).
 *
 * Sources:
 * - design.md → "Data Models" → "Agent_Trace" (`TraceRecord` discriminated
 *   union with `thought`, `tool_call`, `artifact_change`, `status`).
 * - design.md → "Trace Event Bus" → "Interface" (`TraceEvent` carries the
 *   record together with `taskId`, `agentId` and a per-task `sequence`).
 * - requirements.md →
 *     9.5  (every Web_Search_Tool call is recorded in Agent_Trace as a
 *           `tool_call`),
 *     11.2 (Agent_Trace shows reasoning, tool calls and artifact changes),
 *     11.7 (full Agent_Trace preserved for completed tasks).
 *
 * Notes on `tool_call.input` / `tool_call.output`:
 * The design types these fields as `unknown`. We mirror that with
 * `z.unknown()` so the schema does not block agent runtimes from carrying
 * arbitrary structured tool I/O. Higher-level callers (Web_Search_Tool,
 * file tools) are free to constrain the shape of their own tool I/O via
 * dedicated schemas.
 *
 * Notes on `sequence`:
 * Sequence numbers are 1-indexed and monotonically increasing per `taskId`.
 * The Trace Event Bus owns the counter (task 11.1 implementation); this
 * schema only enforces `sequence >= 1`. Strict cross-event monotonicity is
 * a runtime property of the bus, not a single-event invariant, so it is
 * checked by the property test in task 11.4 (Property 12) rather than here.
 */

import { z } from "zod";

import {
  agentIdSchema,
  isoTimestampSchema,
  taskIdSchema,
  toolIdSchema,
} from "./primitives";

/** Minimum trace event sequence number per task. */
export const TRACE_EVENT_MIN_SEQUENCE = 1;

/** "Agent thought" trace record: free-form reasoning text. */
export const thoughtTraceRecordSchema = z.object({
  kind: z.literal("thought"),
  text: z.string(),
  at: isoTimestampSchema,
});

/** "Tool call" trace record: a tool invocation with inputs and outputs. */
export const toolCallTraceRecordSchema = z.object({
  kind: z.literal("tool_call"),
  tool: toolIdSchema,
  input: z.unknown(),
  output: z.unknown(),
  at: isoTimestampSchema,
});

/**
 * "Artifact change" trace record: produced/updated File_Artifact version.
 * Mirrors the shape consumed by the UI's File_Artifact viewer (task 10.3)
 * so the Agent_Trace panel can wire artifact links without a join.
 */
export const artifactChangeTraceRecordSchema = z.object({
  kind: z.literal("artifact_change"),
  artifactId: z.string().min(1, "artifactId must be non-empty"),
  version: z
    .number()
    .int("version must be an integer")
    .min(1, "version must be >= 1"),
  at: isoTimestampSchema,
});

/** Lifecycle statuses an agent can publish. */
export const traceAgentStatusSchema = z.enum([
  "started",
  "finished",
  "error",
]);

/** "Status" trace record: agent-level lifecycle marker. */
export const statusTraceRecordSchema = z.object({
  kind: z.literal("status"),
  status: traceAgentStatusSchema,
  at: isoTimestampSchema,
});

/**
 * `TraceRecord` discriminated union.
 *
 * `kind` is the discriminator so consumers can `switch` exhaustively without
 * runtime type guards. The four variants cover everything the design's
 * Agent_Trace data model defines; new variants must be added here so both
 * the schema and the inferred static type stay in sync.
 */
export const traceRecordSchema = z.discriminatedUnion("kind", [
  thoughtTraceRecordSchema,
  toolCallTraceRecordSchema,
  artifactChangeTraceRecordSchema,
  statusTraceRecordSchema,
]);

/**
 * `TraceEvent` schema. Wraps a `TraceRecord` with the addressing fields the
 * Trace Event Bus assigns at publish time:
 *   - `taskId`  — which Task this event belongs to (Requirement 11.1).
 *   - `agentId` — which Agent emitted the record (Requirement 11.1).
 *   - `sequence` — per-task monotonic ordering (task 11.1, used by the
 *     ordered-history property in task 11.4 / Property 12).
 */
export const traceEventSchema = z.object({
  taskId: taskIdSchema,
  agentId: agentIdSchema,
  record: traceRecordSchema,
  sequence: z
    .number()
    .int("sequence must be an integer")
    .min(
      TRACE_EVENT_MIN_SEQUENCE,
      `sequence must be >= ${TRACE_EVENT_MIN_SEQUENCE}`,
    ),
});

export type ThoughtTraceRecord = z.infer<typeof thoughtTraceRecordSchema>;
export type ToolCallTraceRecord = z.infer<typeof toolCallTraceRecordSchema>;
export type ArtifactChangeTraceRecord = z.infer<
  typeof artifactChangeTraceRecordSchema
>;
export type TraceAgentStatus = z.infer<typeof traceAgentStatusSchema>;
export type StatusTraceRecord = z.infer<typeof statusTraceRecordSchema>;
export type TraceRecord = z.infer<typeof traceRecordSchema>;
export type TraceEvent = z.infer<typeof traceEventSchema>;
