/**
 * Public surface for `@ai-agent-orchestrator/validation`.
 *
 * Each module here defines the runtime Zod schema and re-exports the inferred
 * static type. Consumers should import the schema for validation
 * (`agentMessageSchema.parse(...)`) and the type for compile-time annotations
 * (`AgentMessage`).
 *
 * Module map:
 * - `primitives`     — taskId, agentId, ISO timestamp, ProviderId, ModelRef,
 *                       ToolId, Scope.
 * - `agent-message`  — Agent_Message + payload + 1 MB size guard
 *                       (Requirements 10.1–10.5).
 * - `task`           — Task / CreateTaskInput / TaskState
 *                       (Requirements 6.4, 6.6, 8.5, 14.1).
 * - `file-artifact`  — File_Artifact + version, metadata, content, diff
 *                       (Requirements 7.4, 7.7, 11.7).
 * - `final-report`   — Final_Report (Requirements 8.6, 8.7, 14.2, 14.4).
 * - `custom-agent`   — Custom_Agent + Custom_Agent input
 *                       (Requirements 12.1, 12.2).
 * - `trace`          — TraceRecord + TraceEvent for the Trace Event Bus
 *                       (Requirements 9.5, 11.2, 11.7).
 */

export * from "./primitives";
export * from "./agent-message";
export * from "./task";
export * from "./file-artifact";
export * from "./final-report";
export * from "./custom-agent";
export * from "./trace";
