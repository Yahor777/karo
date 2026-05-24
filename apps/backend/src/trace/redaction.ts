/**
 * Trace event pre-publish redaction (task 20.1).
 *
 * Sources:
 *   • design.md → "Desktop Shell" → "Security rules": API keys must be
 *     redacted in sensitive logs and never echoed back after the
 *     initial entry time.
 *   • design.md → "Trace Event Bus" → "Rules": Agent_Trace is persisted
 *     and replayed for completed Tasks (Requirement 11.7), so any
 *     secret material that lands in a `tool_call.input` or
 *     `thought.text` would be retained indefinitely.
 *   • requirements.md → 1.6, 3.7, 4.5.
 *
 * Why this lives next to the bus rather than inside it:
 *   keeping the redaction pass as a pure function lets unit tests
 *   exercise the masking logic without standing up a full
 *   {@link TraceEventBus}, and lets future transports (an SSE adapter,
 *   a cross-process forwarder) reuse it. The bus itself calls
 *   {@link redactTraceRecord} from `publish` so every code path that
 *   reaches the persistence layer is covered automatically.
 *
 * What this module redacts:
 *
 *   • `tool_call.input` — the "args" of a tool invocation. This is
 *     where Web_Search_Tool, file tools, and Custom_Agent tool calls
 *     surface user-supplied or model-generated material. A key embedded
 *     in this field would otherwise survive into persisted history.
 *   • `tool_call.output` — defensive: a misbehaving tool that echoed
 *     auth headers back into its result would otherwise leak through
 *     the same channel.
 *   • `thought.text` — agent reasoning text. Treated as a string and
 *     run through `redactString` (the only safe pass we can do on free
 *     text without distorting the agent's reasoning).
 *
 * What this module deliberately does NOT redact:
 *
 *   • `Agent_Message.payload.text` — Agent_Message text bodies
 *     frequently contain quoted code and numbers that look like keys.
 *     The task description for 20.1 explicitly excludes that field
 *     from this pass; secret hygiene for messages is enforced at the
 *     authoring boundary (agents must not echo the API key into a
 *     message), not at the trace boundary.
 *   • `artifact_change` and `status` records — they carry no
 *     secret-shaped fields, so a redaction pass would be pure overhead.
 *
 * Validates: Requirements 1.6, 3.7, 4.5.
 */

import {
  redactRecord,
  redactString,
} from "@ai-agent-orchestrator/shared-core";

import type { TraceRecord } from "./types.js";

/**
 * Returns a copy of `record` with secret-shaped material redacted.
 *
 * The function is total — every variant of the {@link TraceRecord}
 * discriminated union is handled. Variants that carry no redactable
 * fields (`artifact_change`, `status`) are returned verbatim so the
 * caller does not pay an unnecessary clone.
 *
 * Pure: never mutates the input.
 */
export function redactTraceRecord(record: TraceRecord): TraceRecord {
  switch (record.kind) {
    case "thought":
      return {
        kind: "thought",
        text: redactString(record.text),
        at: record.at,
      };
    case "tool_call":
      return {
        kind: "tool_call",
        tool: record.tool,
        input: redactRecord(record.input),
        output: redactRecord(record.output),
        at: record.at,
      };
    case "artifact_change":
    case "status":
      return record;
  }
}
