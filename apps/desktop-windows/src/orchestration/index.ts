/**
 * Public surface of the renderer-local orchestrator transport.
 *
 * The Task Builder, Agent Trace, Artifacts and Final Report screens
 * import only from this barrel — never from the implementation files
 * directly — so the transport seam stays explicit.
 *
 * Validates: Requirements 6.4, 6.6, 7.1, 7.10, 8.1, 8.7, 11.1, 11.2,
 * 11.7, 14.2, 14.4, 14.5.
 */

export {
  DesktopOrchestratorTransport,
  type DesktopOrchestratorTransportOptions,
  classifyTaskIntent,
  classifyPromptIntent,
} from "./desktopOrchestratorTransport.js";

export { ChatModelClient } from "./modelClient.js";
export type {
  ChatMessage,
  ChatModelClientOptions,
  ChatRequest,
  ChatResponse,
} from "./modelClient.js";

export {
  isTerminalStatus,
  StartTaskError,
  TASK_TERMINAL_STATUSES,
} from "./types.js";
export type {
  ArtifactListener,
  ArtifactMetadata,
  ArtifactVersion,
  BossVerdictSummary,
  FinalReportListener,
  FinalReportSummary,
  LogEntry,
  LogListener,
  OrchestratorTransport,
  StartTaskErrorCode,
  StartTaskInput,
  StartTaskResult,
  TaskStateListener,
  TaskRecoveryState,
  TaskStateSnapshot,
  TaskStatus,
  TraceEvent,
  TraceListener,
  TraceRecord,
  ConsentDecision,
} from "./types.js";

export {
  runCommandPolicy,
  type CommandPermissionMode,
  type CommandRiskLevel,
  type CommandDecision,
  type CommandPolicyInput,
} from "./commandPolicy.js";

export {
  runDecisionEngine,
  runDecisionEngineSync,
  type TaskIntent,
  type TaskExecutionMode,
  type TaskRiskLevel,
  type ProjectKind,
  type ClarificationOption,
  type TaskDecision,
  type DecisionEngineInput,
} from "./decisionEngine.js";

export {
  getPresetForModel,
  PRESETS as presets,
  type PromptPreset,
} from "./promptPresets.js";

export {
  probeModelCapability,
  type ModelCapabilityProfile,
} from "./modelCapabilityProbe.js";

export {
  estimateTokens,
  estimateMessagesTokens,
  estimateFileContextTokens,
  buildTokenUsageBreakdown,
} from "./tokenEstimator.js";
