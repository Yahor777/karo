/**
 * Public surface of the backend Agent Runtime module.
 *
 * Task 14.1 ships:
 *
 *   • {@link AgentRunner}                          — the runtime itself.
 *     Loads the conversation log, bounds it to the latest 200 messages
 *     / 8 MB (Requirement 10.7), invokes the model adapter, normalises
 *     the raw output into a valid Agent_Message (Requirements 10.8 /
 *     10.9), and persists it before handoff (Requirement 10.6).
 *   • {@link InMemoryMessageHistoryStore}         — pluggable history
 *     backend for tests and early bring-up; production swaps in
 *     encrypted SQLite or a cloud-backed store.
 *   • {@link ModelAdapter} / {@link MessageHistoryStore} — ports for
 *     the Provider call and the Agent_Message log.
 *   • {@link boundAgentHistory}                    — pure helper used by
 *     the runner; exposed so the property tests in tasks 11.4 / 14.5
 *     can exercise the trimming rule directly.
 *
 * Subsequent tasks (14.2–14.4) compose role-specific behaviour
 * (Researcher / Coder / Reviewer / Fixer / Boss) on top of this
 * module without changing the runner's surface.
 *
 * Validates: Requirements 10.6, 10.7, 10.8, 10.9.
 */

export { AgentRunner } from "./agentRunner.js";
export type { AgentRunnerOptions, Clock } from "./agentRunner.js";

export { InMemoryMessageHistoryStore } from "./inMemoryMessageHistoryStore.js";

export {
  boundAgentHistory,
  estimateAgentMessageSize,
} from "./historyBounds.js";

export {
  AGENT_HISTORY_MAX_BYTES,
  AGENT_HISTORY_MAX_MESSAGES,
  AGENT_PERSISTENCE_BUDGET_MS,
} from "./types.js";

export type {
  AgentDefinition,
  AgentRunInput,
  AgentRunResult,
  AgentRunner as AgentRunnerInterface,
  MessageHistoryStore,
  ModelAdapter,
  ModelInvokeOptions,
  RoutingTarget,
  SecretRef,
  TaskContext,
} from "./types.js";

export { ORCHESTRATOR_RECIPIENT } from "./types.js";

export { OpenAiCompatibleModelAdapter } from "./openAiCompatibleModelAdapter.js";
export type {
  ChatHttpClient,
  OpenAiCompatibleModelAdapterOptions,
  ProviderBaseUrlResolver,
  ProviderKeyResolver,
} from "./openAiCompatibleModelAdapter.js";

export { ToolCallingModelAdapter } from "./toolCallingModelAdapter.js";
export type {
  ToolCallingModelAdapterClock,
  ToolCallingModelAdapterOptions,
} from "./toolCallingModelAdapter.js";
