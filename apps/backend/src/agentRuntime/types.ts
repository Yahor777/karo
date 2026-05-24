/**
 * Agent Runtime types and ports (task 14.1).
 *
 * Sources:
 * - design.md → "Agent Runtime" → "Interface" (`AgentRunner.run` signature
 *   and `AgentRunResult` shape).
 * - design.md → "Data Models" → "Agent_Message" (`Agent_Message` carries
 *   taskId / sender / recipient / type / payload / timestamp; `normalized`
 *   and `rawOriginal` used for normalisation).
 * - design.md → "Pipeline State Machine" → message persistence within
 *   500 ms before handoff (Requirement 10.6).
 * - requirements.md →
 *     10.6 (Orchestrator persists Agent_Message in Task history within
 *           500 ms before handing control to the next Agent),
 *     10.7 (Orchestrator passes Agent the full message history bounded
 *           by latest 200 messages or 8 MB total),
 *     10.8 (malformed agent output is wrapped into a valid Agent_Message
 *           with the normalisation flag set and the original payload
 *           preserved),
 *     10.9 (unreadable agent output becomes an Agent_Message of
 *           type "error" describing the communication failure).
 *
 * Scope of task 14.1:
 *   • Define the `ModelAdapter` port that the agent runtime uses to invoke
 *     a Provider model — concrete adapters land in tasks 14.2–14.4.
 *   • Define the `MessageHistoryStore` port for persisting Agent_Messages
 *     in chronological order — production swaps the in-memory backend
 *     for encrypted SQLite later.
 *   • Define the input / result types consumed by the `AgentRunner`.
 *
 * Out of scope (handled by later tasks):
 *   • Specific Builtin_Agent behaviours (Researcher / Coder / Reviewer /
 *     Fixer / Boss) — tasks 14.2–14.4.
 *   • Trace-bus emission and artifact writes during a run — tasks 14.2+
 *     wire those on top of the runner.
 */

import type {
  AgentId,
  ModelRef,
  ProviderId,
  Scope,
  TaskId,
  ToolId,
} from "@ai-agent-orchestrator/shared-core";
import type { AgentMessage } from "@ai-agent-orchestrator/validation";

// ---------------------------------------------------------------------------
// History bounds (Requirement 10.7)
// ---------------------------------------------------------------------------

/**
 * Maximum number of Agent_Messages handed to an agent on a single run.
 * Requirement 10.7 caps the history at the latest 200 messages.
 */
export const AGENT_HISTORY_MAX_MESSAGES = 200;

/**
 * Maximum total serialised size of the history in bytes.
 * Requirement 10.7 caps the total at 8 MB.
 */
export const AGENT_HISTORY_MAX_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Persistence bound (Requirement 10.6)
// ---------------------------------------------------------------------------

/**
 * Soft upper bound on the time the runner is allowed to spend persisting
 * the outgoing Agent_Message before handing it back to the orchestrator.
 * Requirement 10.6 says "within 500 ms before handoff".
 *
 * The runner does not enforce this bound by aborting — the persistence
 * call must complete for correctness — but exposes the measured latency
 * on `AgentRunResult.persistenceLatencyMs` so the orchestrator and tests
 * can detect violations.
 */
export const AGENT_PERSISTENCE_BUDGET_MS = 500;

// ---------------------------------------------------------------------------
// Secrets (design.md → "Agent Runtime" → SecretRef)
// ---------------------------------------------------------------------------

/**
 * Reference to a server-resolved API key. The runner never sees the
 * decrypted secret directly; the model adapter pulls it from the Settings
 * Store gateway when invoking the Provider.
 */
export interface SecretRef {
  readonly provider: ProviderId;
  readonly scope: Scope;
  readonly expiresAt: string;
}

// ---------------------------------------------------------------------------
// Agent definition (design.md → "Data Models" → "Agent")
// ---------------------------------------------------------------------------

/**
 * Minimal Agent_Definition shape consumed by the runner. Mirrors
 * `AgentDefinition` from design.md → "Data Models" → "Agent" without
 * pulling in the discriminated `builtin` / `custom` shapes — the runner
 * treats both uniformly.
 */
export interface AgentDefinition {
  readonly id: AgentId;
  readonly name: string;
  readonly systemPrompt: string;
  readonly model?: ModelRef;
  readonly allowedTools: readonly ToolId[];
}

// ---------------------------------------------------------------------------
// Task context
// ---------------------------------------------------------------------------

/**
 * Subset of task state the runner needs. The full `TaskState` lives in
 * `@ai-agent-orchestrator/validation`; the runner only depends on the id
 * and the default model so future state-machine extensions do not ripple
 * into this module.
 */
export interface TaskContext {
  readonly id: TaskId;
  /**
   * Default model for the task (Requirement 6.4: when an agent does not
   * pin its own model, the orchestrator falls back to the task model).
   */
  readonly defaultModel: ModelRef;
}

// ---------------------------------------------------------------------------
// Model adapter port
// ---------------------------------------------------------------------------

/**
 * Options the runner passes to the model adapter.
 *
 * The system prompt is the agent's own (`AgentDefinition.systemPrompt`),
 * not part of the message history. Requirement 10.7 bounds the *history*;
 * the system prompt is always included so the agent's role survives any
 * trimming of older messages.
 */
export interface ModelInvokeOptions {
  /** Agent system prompt — always included regardless of history trimming. */
  readonly systemPrompt: string;
  /** API-key reference, resolved server-side at invocation time. */
  readonly apiKey: SecretRef;
  /** Tools the agent is allowed to call (advisory metadata for the adapter). */
  readonly allowedTools: readonly ToolId[];
  /** Optional per-call timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * Port for invoking a Provider model. Concrete adapters land in tasks
 * 14.2–14.4 (and provider-specific adapters in subsequent waves). The
 * shape matches the task spec exactly:
 *
 *   `invoke(modelRef, messages, options) -> Promise<{ raw: unknown }>`
 *
 * Adapters MUST NOT throw for normal model failures; they should embed
 * provider error details inside `raw` so the runner can normalise them
 * into Agent_Messages of type "error" via the standard pipeline. The
 * runner still handles thrown exceptions defensively (Requirement 10.9).
 */
export interface ModelAdapter {
  invoke(
    modelRef: ModelRef,
    messages: readonly AgentMessage[],
    options: ModelInvokeOptions,
  ): Promise<{ raw: unknown }>;
}

// ---------------------------------------------------------------------------
// Message history store port
// ---------------------------------------------------------------------------

/**
 * Append-and-list port for persisting Agent_Messages.
 *
 * The runner depends on this port for two reasons:
 *
 *   • Requirement 10.6 — every outgoing Agent_Message must be persisted
 *     before handoff. The store is the persistence target.
 *   • Requirement 10.7 — the orchestrator passes the agent its full
 *     message history bounded by 200 / 8 MB. The runner reads the
 *     history through `list` and trims it before invoking the adapter.
 *
 * Implementations:
 *
 *   • {@link InMemoryMessageHistoryStore} — the default, used for tests
 *     and bring-up. Production replaces it with persistent storage
 *     (encrypted SQLite for local scope, SQL for cloud scope).
 *
 * Atomicity contract: `append` MUST persist the message before resolving.
 * Concurrent appends for the same `taskId` are serialised by the runner
 * itself (per-call `await`), so the backend does not have to provide
 * its own locking layer.
 */
export interface MessageHistoryStore {
  /** Append a single message to `taskId`'s log. */
  append(taskId: TaskId, message: AgentMessage): Promise<void>;
  /** Return the full chronological log for `taskId`, oldest first. */
  list(taskId: TaskId): Promise<readonly AgentMessage[]>;
}

// ---------------------------------------------------------------------------
// Runner inputs / outputs
// ---------------------------------------------------------------------------

/**
 * Routing target for an outgoing Agent_Message.
 *
 * Conceptually a discriminated value: either the literal sentinel
 * {@link ORCHESTRATOR_RECIPIENT} (route back to the orchestrator) or
 * an `AgentId` (route directly to a peer agent). At the type level
 * this is `AgentId` (== `string`) because `AgentId | "orchestrator"`
 * collapses to `string`; the distinction is enforced by convention
 * and by the constant below being the only legal non-AgentId value.
 */
export type RoutingTarget = AgentId;

/**
 * Sentinel string the runner uses when it has not been told which
 * peer agent should receive the outgoing message. Code paths that
 * compare against this constant document the intent explicitly even
 * though `RoutingTarget` is structurally a plain string.
 */
export const ORCHESTRATOR_RECIPIENT = "orchestrator" as const;

/**
 * Input to {@link AgentRunner.run}.
 *
 * `incoming` is the message that triggered this agent invocation
 * (typically a `handoff` from the previous agent). The orchestrator
 * is expected to have persisted `incoming` before calling `run` — the
 * runner's contract is to persist the *outgoing* message it produces.
 *
 * `recipient` lets the orchestrator override the default routing of the
 * outgoing message. When omitted, the runner sends the result to the
 * orchestrator (`"orchestrator"`); the orchestrator then decides which
 * agent — if any — receives the next handoff.
 */
export interface AgentRunInput {
  readonly task: TaskContext;
  readonly agent: AgentDefinition;
  readonly apiKey: SecretRef;
  readonly incoming: AgentMessage;
  readonly recipient?: RoutingTarget;
  /** Optional per-call timeout forwarded to the model adapter. */
  readonly timeoutMs?: number;
}

/**
 * Result of a single agent run.
 *
 * `outgoing` is always a valid Agent_Message (Requirements 10.8 / 10.9 —
 * the runner normalises malformed output and wraps unreadable output as
 * `type: "error"`).
 *
 * `persistenceLatencyMs` is the elapsed wall-clock time the runner spent
 * inside `MessageHistoryStore.append` for the outgoing message. Exposed
 * so the orchestrator and tests can verify the 500 ms budget from
 * Requirement 10.6.
 */
export interface AgentRunResult {
  readonly outgoing: AgentMessage;
  readonly persistenceLatencyMs: number;
  /**
   * `true` when the outgoing message was synthesised from malformed or
   * unreadable adapter output (Requirements 10.8 / 10.9). Mirrors
   * `outgoing.normalized` — exposed at the top level so callers do not
   * have to inspect the message body to detect normalisation.
   */
  readonly normalized: boolean;
}

// ---------------------------------------------------------------------------
// Agent runner port
// ---------------------------------------------------------------------------

/**
 * Public surface of the agent runtime.
 *
 * Task 14.1 ships a single `run(input)` method that:
 *   1. Loads the conversation log via {@link MessageHistoryStore.list}.
 *   2. Bounds it to the latest 200 messages / 8 MB (Requirement 10.7).
 *   3. Invokes the model adapter with the bounded history + the agent's
 *      system prompt.
 *   4. Normalises the adapter's raw output into a valid Agent_Message
 *      (Requirements 10.8 / 10.9).
 *   5. Persists the outgoing message via the store (Requirement 10.6)
 *      and returns it together with the measured persistence latency.
 *
 * Tasks 14.2–14.4 build on this with role-specific behaviour
 * (Researcher uses Web_Search_Tool, Coder writes File_Artifacts, etc.).
 */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

// Type-only re-exports keep the public surface importable from a single
// `agentRuntime/types.ts` file.
export type { AgentMessage } from "@ai-agent-orchestrator/validation";
export type {
  AgentId,
  ModelRef,
  ProviderId,
  Scope,
  TaskId,
  ToolId,
} from "@ai-agent-orchestrator/shared-core";
