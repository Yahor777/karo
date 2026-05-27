/**
 * Public types for the renderer-local orchestrator transport.
 *
 * Mirrors the canonical shapes from `apps/backend/src/orchestrator/*`,
 * `apps/backend/src/agents/*` and `apps/backend/src/artifacts/*` while
 * staying free of `node:*` imports so it can run inside Tauri's
 * WebView2.
 *
 * Validates: Requirements 7.1, 7.10, 8.1, 8.7, 11.1, 11.2, 11.7, 14.2,
 * 14.4, 14.5.
 */

import type {
  AgentId,
  BuiltinAgentRole,
  ProviderId,
  TaskId,
} from "@ai-agent-orchestrator/shared-core";

import type { ApiKeyMetadata } from "../ui/desktopApiKeySink.js";
import type { ApplyResult } from "../shell/types.js";

/** Status of a single Task. Mirrors the backend `TaskStatus`. */
export type TaskStatus =
  | "created"
  | "researching"
  | "coding"
  | "reviewing"
  | "fixing"
  | "boss_eval"
  | "completed"
  | "stopped_limit"
  | "error"
  | "waiting_consent";

export const TASK_TERMINAL_STATUSES: ReadonlyArray<TaskStatus> = [
  "completed",
  "stopped_limit",
  "error",
];

export function isTerminalStatus(s: TaskStatus): boolean {
  return TASK_TERMINAL_STATUSES.includes(s);
}

/** Discriminated kinds of trace records the renderer surfaces. */
export type TraceRecord =
  | {
      readonly kind: "thought";
      readonly text: string;
    }
  | {
      readonly kind: "tool_call";
      readonly tool: string;
      readonly input: unknown;
      readonly output: unknown;
    }
  | {
      readonly kind: "artifact_change";
      readonly artifactId: string;
      readonly version: number;
    }
  | {
      readonly kind: "status";
      readonly status: "started" | "finished" | "error";
    };

/** Stored trace event in the per-task event log. */
export interface TraceEvent {
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly sequence: number;
  readonly at: string;
  readonly record: TraceRecord;
}

/** Minimal artifact metadata the UI needs. */
export interface ArtifactMetadata {
  readonly id: string;
  readonly taskId: TaskId;
  readonly fileName: string;
  readonly latestVersion: number;
  readonly latestContentHash: string;
  readonly authoredByAgentId: AgentId;
  readonly updatedAt: string;
}

/** Single version of an artifact, including bytes (UTF-8). */
export interface ArtifactVersion {
  readonly artifactId: string;
  readonly version: number;
  readonly fileName: string;
  readonly contentHash: string;
  readonly content: string;
  readonly authoredByAgentId: AgentId;
  readonly createdAt: string;
}

/** Boss verdict surfaced to the UI / Final_Report. */
export interface BossVerdictSummary {
  readonly kind: "approved" | "rejected";
  readonly verdict: "соответствует" | "не соответствует";
  readonly notes: readonly string[];
}

/** Final_Report shape consumed by the renderer. */
export interface FinalReportSummary {
  readonly taskId: TaskId;
  readonly status: "completed" | "stopped_limit" | "error";
  readonly originalPrompt: string;
  readonly bossSummary?: string;
  readonly outstandingIssues?: readonly string[];
  readonly participants: readonly AgentId[];
  readonly reviewCyclesPerformed: number;
  readonly finalArtifacts: ReadonlyArray<{
    readonly artifactId: string;
    readonly version: number;
    readonly fileName: string;
  }>;
  readonly createdAt: string;
}

/** TaskState surfaced via the transport. */
export interface TaskStateSnapshot {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly currentAgentId: AgentId | null;
  readonly reviewCycles: number;
  readonly maxReviewCycles: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly originalPrompt: string;
  readonly modelId: string;
  readonly provider: ProviderId;
  readonly participants: readonly AgentId[];
  readonly errorReason?: string | undefined;
  readonly consentRequest?: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly reason: string;
  } | undefined;
  readonly stagingDirectory?: string | undefined;
  readonly testRunLogPath?: string | undefined;
  readonly testRunLogContent?: string | undefined;
  readonly contextSummary?: TaskContextSummary | undefined;
  readonly isExplainOnly?: boolean | undefined;
  readonly tokenUsage?: TaskUsageSummary | undefined;
  readonly currentContextUsage?: TokenUsageBreakdown | undefined;
  readonly providerDiagnostics?: readonly ProviderCallDiagnostic[] | undefined;
  readonly recoveryState?: TaskRecoveryState | undefined;
  readonly agentCoreEstimate?: AgentCoreEstimate | undefined;
  readonly deterministicValidation?: DeterministicValidationSummary | undefined;
  readonly decision?: TaskDecision | undefined;
  readonly clarificationState?: ClarificationState | undefined;
  readonly commandPermissionMode?: CommandPermissionMode | undefined;
  readonly projectKind?: ProjectKind | undefined;
  readonly runtimeRunId?: string | undefined;
}

export interface ProviderCallDiagnostic {
  readonly id: string;
  readonly agentId: AgentId;
  readonly stageName: string;
  readonly provider: string;
  readonly modelId: string;
  readonly inputTokenEstimate: number;
  readonly selectedFilesCount: number;
  readonly contextTokens: number;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly errorType?: string | undefined;
  readonly partialOutputReceived: boolean;
  readonly artifactsCreated: boolean;
  readonly createdAt: string;
}

export type RecoveryActionKind =
  | "retry_failed_stage"
  | "retry_reduced_context"
  | "continue_partial"
  | "switch_model"
  | "emergency_fallback";

export interface RecoveryArtifactSummary {
  readonly artifactId: string;
  readonly version: number;
  readonly fileName: string;
}

export interface TaskRecoveryState {
  readonly failedStage: string;
  readonly failedAgent: AgentId;
  readonly failedFile?: string | undefined;
  readonly provider: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly selectedFiles: readonly string[];
  readonly contextTokens: number;
  readonly partialArtifacts: readonly RecoveryArtifactSummary[];
  readonly retryCount: number;
  readonly lastSuccessfulStage?: string | undefined;
  readonly lastSuccessfulArtifact?: RecoveryArtifactSummary | undefined;
  readonly recommendedAction: RecoveryActionKind;
  readonly fallbackUsed: boolean;
  readonly canRetryFailedStage: boolean;
  readonly canRetryReducedContext: boolean;
  readonly canContinueFromPartial: boolean;
  readonly canSwitchModel: boolean;
  readonly recoveryReasonUser: string;
  readonly recoveryReasonInternal: string;
}

export type SelectedContextFileSummary = {
  readonly relativePath: string;
  readonly score: number;
  readonly reason: readonly string[];
  readonly truncated: boolean;
};

export type TaskContextSummary = {
  readonly scannedFilesCount: number;
  readonly selectedFilesCount: number;
  readonly selectedFiles: readonly SelectedContextFileSummary[];
  readonly warnings: readonly string[];
  readonly error?: string | undefined;
  readonly projectRoot?: string | undefined;
  readonly normalizedProjectRoot?: string | undefined;
};

/** Payload submitted from the Task Builder to start a real run. */
export interface StartTaskInput {
  readonly prompt: string;
  readonly metadata: ApiKeyMetadata;
  readonly mode: "auto" | "manual";
  readonly participants: ReadonlyArray<BuiltinAgentRole>;
  readonly maxReviewCycles: number;
  /**
   * Optional per-agent model overrides captured from the Agents screen.
   * Empty / missing values inherit `metadata.modelId`.
   */
  readonly agentModelOverrides?: Partial<Record<BuiltinAgentRole, string>>;
  /**
   * Boss review is enabled by default for Agent Mode. The UI can disable
   * it for faster, lower-cost coding runs while still keeping reviewer
   * validation in place.
   */
  readonly bossEnabled?: boolean | undefined;
  /** Project path is metadata only; the pipeline must not scan or edit it. */
  readonly projectPath?: string | undefined;
  /**
   * Short, token-conscious summary of the active conversation. This is used to
   * keep follow-up tasks grounded without copying the entire chat history into
   * every model request.
   */
  readonly conversationContext?: string | undefined;
  /**
   * Set to `true` once the user has explicitly confirmed that real
   * API usage is about to happen. Required by `createAndRunTask` —
   * a `false` value is rejected with `confirmation_required` so a
   * misconfigured callsite cannot silently spend tokens.
   */
  readonly confirmedByUser: boolean;
}

/** Listener signatures used by the transport's pub/sub surface. */
export type TaskStateListener = (
  taskId: TaskId,
  state: TaskStateSnapshot,
) => void;
export type TraceListener = (
  taskId: TaskId,
  event: TraceEvent,
) => void;
export type ArtifactListener = (
  taskId: TaskId,
  metadata: ArtifactMetadata,
) => void;
export type FinalReportListener = (
  taskId: TaskId,
  report: FinalReportSummary,
) => void;

/**
 * Free-form log line emitted by the transport. Used to surface raw
 * model previews / repair-retry diagnostics into the right-panel Logs
 * tab without polluting the agent timeline shown inside chat.
 *
 * MUST NEVER carry plaintext API keys or other secrets — the transport
 * truncates raw model previews to 500 characters before publishing,
 * which is also enforced by the workbench Logs view.
 */
export interface LogEntry {
  readonly at: string;
  readonly level: "info" | "warn" | "error";
  readonly source: AgentId;
  readonly text: string;
}

export type LogListener = (taskId: TaskId, entry: LogEntry) => void;

/**
 * Stable error codes the renderer transport surfaces. Mirrors the
 * spirit of the backend's `CreateTaskError.code` so the UI can branch
 * deterministically.
 */
export type StartTaskErrorCode =
  | "empty_prompt"
  | "invalid_input"
  | "missing_provider_metadata"
  | "missing_model_id"
  | "manual_mode_zero_participants"
  | "auto_mode_no_participants"
  | "confirmation_required"
  | "api_key_decrypt_failed"
  | "transport_unavailable";

export class StartTaskError extends Error {
  public readonly code: StartTaskErrorCode;
  public override readonly cause?: unknown;

  public constructor(
    code: StartTaskErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "StartTaskError";
    this.code = code;
    this.cause = cause;
  }
}

/** Result returned by `createAndRunTask`. */
export interface StartTaskResult {
  readonly taskId: TaskId;
}

/**
 * Public surface of the renderer-local orchestrator transport.
 *
 * The Task Builder calls `createAndRunTask` to kick off a real
 * pipeline run. The Agent Trace / Artifacts / Final Report screens
 * subscribe to the corresponding listeners (or pull a snapshot via the
 * `get…` methods).
 *
 * The transport is single-process and single-host: the renderer owns
 * both the orchestrator pipeline and the UI. There is no IPC layer.
 * For the MVP this keeps wiring trivial; production deployments would
 * move the same code path behind a Tauri command or a backend service.
 */
export type ConsentDecision =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "overrideCommand"; command: string; args: readonly string[] }
  | { kind: "cancel" }
  | { kind: "clarify"; selectedOptionId?: string | undefined; customAnswer?: string | undefined }
  | { kind: "retryFailedStage" }
  | { kind: "retryReducedContext" }
  | { kind: "continuePartial" };

export interface OrchestratorTransport {
  createAndRunTask(input: StartTaskInput): Promise<StartTaskResult>;
  resumeTask(taskId: TaskId, decision: ConsentDecision): Promise<void>;
  applyStagedChanges(taskId: TaskId, approval: boolean): Promise<ApplyResult>;

  getTaskState(taskId: TaskId): TaskStateSnapshot | null;
  getTraceEvents(taskId: TaskId): readonly TraceEvent[];
  getArtifacts(taskId: TaskId): readonly ArtifactMetadata[];
  getArtifactVersion(
    taskId: TaskId,
    artifactId: string,
    version: number,
  ): ArtifactVersion | null;
  getFinalReport(taskId: TaskId): FinalReportSummary | null;

  listTasks(): readonly TaskStateSnapshot[];

  subscribeTaskState(listener: TaskStateListener): () => void;
  subscribeTrace(listener: TraceListener): () => void;
  subscribeArtifacts(listener: ArtifactListener): () => void;
  subscribeFinalReport(listener: FinalReportListener): () => void;
}

export type TaskIntent =
  | "casual_chat"
  | "explain_general"
  | "explain_project"
  | "analyze_project"
  | "security_review"
  | "create_file"
  | "modify_file"
  | "fix_bug"
  | "refactor"
  | "run_command"
  | "search_web"
  | "unknown";

export type TaskExecutionMode = "chat" | "plan" | "assist" | "agent" | "clarify";

export type TaskRiskLevel = "low" | "medium" | "high" | "destructive" | "unknown";

export type ProjectKind =
  | "static_site"
  | "node_web"
  | "tauri_desktop"
  | "minecraft_mod_gradle"
  | "rust"
  | "generic";

export interface ClarificationOption {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface TaskDecision {
  readonly intent: TaskIntent;
  readonly executionMode: TaskExecutionMode;
  readonly confidence: number;
  readonly needsClarification: boolean;
  readonly clarificationQuestion?: string | undefined;
  readonly clarificationOptions: readonly ClarificationOption[];
  readonly allowWebSearch: boolean;
  readonly allowFileChanges: boolean;
  readonly allowCommands: boolean;
  readonly requiresContextEngine: boolean;
  readonly expectedOutput: "chat" | "explanation" | "analysis" | "artifacts" | "command_result";
  readonly riskLevel: TaskRiskLevel;
  readonly reasoningSummary: string;
}

export interface ClarificationState {
  readonly question: string;
  readonly options: readonly ClarificationOption[];
  readonly selectedOptionId?: string | undefined;
  readonly customAnswer: string;
  readonly resolved: boolean;
}

export interface ClarificationResolution {
  readonly originalPrompt: string;
  readonly selectedOption?: string | undefined;
  readonly customAnswer?: string | undefined;
  readonly resolvedPrompt: string;
}

export type CommandPermissionMode = "safe_commands" | "smart_approval" | "full_access_smart";

export type CommandRiskLevel = "safe" | "low" | "medium" | "high" | "destructive" | "unknown";

export interface CommandDecision {
  readonly command: string;
  readonly riskLevel: CommandRiskLevel;
  readonly permissionMode: CommandPermissionMode;
  readonly canRunAutomatically: boolean;
  readonly requiresApproval: boolean;
  readonly blocked: boolean;
  readonly reason: string;
  readonly rollbackAvailable: boolean;
  readonly rollbackPlan?: string;
  readonly suggestedSaferCommand?: string;
  readonly warnings: readonly string[];
}

export interface TokenUsageBreakdown {
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly usedTokens: number;
  readonly usageRatio: number;
  readonly systemPromptTokens: number;
  readonly userPromptTokens: number;
  readonly conversationTokens: number;
  readonly projectContextTokens: number;
  readonly selectedFilesTokens: number;
  readonly toolResultTokens: number;
  readonly outputTokens: number;
  readonly reservedOutputTokens: number;
  readonly estimatedCostUsd?: number | undefined;
  readonly isEstimated: boolean;
  readonly updatedAt: string;
}

export interface AgentTokenUsage {
  readonly agentId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly modelId: string;
  readonly isEstimated: boolean;
}

export interface TaskUsageSummary {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly contextUsageRatio: number;
  readonly estimatedCostUsd?: number | undefined;
  readonly perAgent: readonly AgentTokenUsage[];
  readonly warnings: readonly string[];
}

export type AgentCoreMode =
  | "chat"
  | "plan"
  | "agent"
  | "quick_edit"
  | "read_only_context"
  | "safety"
  | "clarify";

export type AgentContextProfile =
  | "casual_chat"
  | "conversation_memory"
  | "project_explain"
  | "apply_changes_explain"
  | "security_review"
  | "website_creation"
  | "minecraft_mod"
  | "software_project"
  | "ui_work"
  | "none";

export type AgentCoreStageId =
  | "router"
  | "chat_assistant"
  | "context_analyst"
  | "context_curator"
  | "planner"
  | "chunked_coder"
  | "deterministic_validator"
  | "reviewer"
  | "targeted_fixer"
  | "finalizer"
  | "safety_check";

export interface AgentCoreStageEstimate {
  readonly id: AgentCoreStageId;
  readonly label: string;
  readonly modelCall: boolean;
  readonly deterministic: boolean;
  readonly timeoutMs?: number | undefined;
}

export interface AgentCoreEstimate {
  readonly mode: AgentCoreMode;
  readonly routeReason: string;
  readonly routeReasonUser: string;
  readonly routeReasonInternal: string;
  readonly expectedModelCalls: number;
  readonly maxExpectedModelCalls: number;
  readonly baselineSingleModelCalls: number;
  readonly avoidedFullPipelineModelCalls: number;
  readonly expectedContextTokens: number;
  readonly contextTokensEstimate: number;
  readonly selectedFilesEstimate: number;
  readonly contextProfile: AgentContextProfile;
  readonly requiresProjectContext: boolean;
  readonly allowsCommands: boolean;
  readonly riskLevel: TaskRiskLevel;
  readonly allowsArtifacts: boolean;
  readonly timeoutRisk: "low" | "medium" | "high";
  readonly timeoutPolicy: string;
  readonly recoveryPolicy: string;
  readonly fallbackCountsAsSuccess: false;
  readonly stages: readonly AgentCoreStageEstimate[];
  readonly warnings: readonly string[];
}

export interface DeterministicValidationSummary {
  readonly status: "passed" | "needs_model_review" | "failed";
  readonly skipModelReview: boolean;
  readonly issues: readonly string[];
  readonly checkedSignals: readonly string[];
  readonly reason: string;
}
