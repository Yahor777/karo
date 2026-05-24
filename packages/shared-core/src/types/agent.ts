/**
 * Agent and tool identifier types.
 *
 * Source: design.md → "Agent Runtime" → "Builtin agent permissions" and
 * "Data Models" → "Agent".
 *
 * The five `BuiltinAgentRole` values match the five required Builtin_Agent
 * roles from Requirement 7.1. `ToolId` enumerates the tool identifiers the
 * Agent Runtime knows how to invoke; per-role permission tables live with
 * the Agent Runtime, not on this type.
 *
 * `AgentId` is a branded-style string alias rather than an opaque newtype to
 * keep ergonomics simple while still signalling intent in signatures.
 */

export type AgentId = string;

export type BuiltinAgentRole =
  | "researcher"
  | "coder"
  | "reviewer"
  | "fixer"
  | "boss";

export type ToolId =
  | "web_search"
  | "file_read"
  | "file_write"
  | "artifact_diff";
