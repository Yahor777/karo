import type {
  AgentContextProfile,
  AgentCoreEstimate,
  AgentCoreStageEstimate,
  DeterministicValidationSummary,
  TaskDecision,
} from "./types.js";
import { estimateTokens } from "./tokenEstimator.js";

export interface AgentCoreEstimateInput {
  readonly prompt: string;
  readonly decision: TaskDecision;
  readonly quickEditAvailable: boolean;
  readonly contextTokensEstimate?: number | undefined;
  readonly selectedFilesEstimate?: number | undefined;
}

export interface ArtifactValidationInput {
  readonly fileName: string;
  readonly content: string;
}

export interface StructuredPlan {
  readonly goal: string;
  readonly assumptions: readonly string[];
  readonly fileAreas: readonly string[];
  readonly implementationSteps: readonly string[];
  readonly risks: readonly string[];
  readonly tests: readonly string[];
  readonly estimatedComplexity: "low" | "medium" | "high";
  readonly suggestedExecutionMode: "chat" | "plan" | "agent";
}

const FULL_AGENT_PIPELINE_EXPECTED_CALLS = 7;
const WEBSITE_CHUNK_COUNT = 4;

export function estimateAgentCoreExecution(input: AgentCoreEstimateInput): AgentCoreEstimate {
  const contextTokensEstimate = input.contextTokensEstimate ?? 0;
  const selectedFilesEstimate = input.selectedFilesEstimate ?? 0;
  const contextProfile = inferContextProfile(input);
  const base = {
    contextTokensEstimate,
    expectedContextTokens: contextTokensEstimate,
    selectedFilesEstimate,
    requiresProjectContext: input.decision.requiresContextEngine,
    allowsCommands: false,
    riskLevel: input.decision.riskLevel,
    contextProfile,
    fallbackCountsAsSuccess: false as const,
  };

  if (input.decision.executionMode === "clarify") {
    const routeReason = "The router needs user clarification before spending model calls.";
    return {
      ...base,
      mode: "clarify",
      routeReason,
      routeReasonUser: "I need one clarification before choosing Chat, Plan, or Agent.",
      routeReasonInternal: routeReason,
      expectedModelCalls: 0,
      maxExpectedModelCalls: 0,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS,
      requiresProjectContext: false,
      allowsArtifacts: false,
      timeoutRisk: "low",
      timeoutPolicy: "No provider call is made before clarification.",
      recoveryPolicy: "Ask the user to narrow scope; do not run an agent pipeline.",
      stages: [stage("router", "Route clarification", false, true)],
      warnings: [],
    };
  }

  if (input.decision.intent === "run_command" && input.decision.riskLevel === "destructive") {
    const routeReason = "Dangerous command detected; Karo must produce a Safety Check without executing it.";
    return {
      ...base,
      mode: "safety",
      routeReason,
      routeReasonUser: "This looks dangerous, so I will explain the risk and suggest a dry run instead of executing it.",
      routeReasonInternal: routeReason,
      expectedModelCalls: 0,
      maxExpectedModelCalls: 0,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS,
      requiresProjectContext: false,
      allowsArtifacts: false,
      timeoutRisk: "low",
      timeoutPolicy: "No provider call is required for the command safety block.",
      recoveryPolicy: "Keep command blocked; offer a safe dry-run command or explicit approval path.",
      stages: [
        stage("router", "Route dangerous command", false, true),
        stage("safety_check", "Produce Safety Check", false, true),
      ],
      warnings: ["Command execution remains blocked until explicit safe approval policy is satisfied."],
    };
  }

  if (input.quickEditAvailable) {
    const routeReason = "The request is a deterministic single-file edit; no model call is needed.";
    return {
      ...base,
      mode: "quick_edit",
      routeReason,
      routeReasonUser: "This is a simple deterministic edit, so I can stage it without using a model.",
      routeReasonInternal: routeReason,
      expectedModelCalls: 0,
      maxExpectedModelCalls: 0,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS,
      requiresProjectContext: false,
      allowsArtifacts: true,
      timeoutRisk: "low",
      timeoutPolicy: "No provider timeout is possible because no model call is made.",
      recoveryPolicy: "Regenerate the deterministic staged artifact if validation fails.",
      stages: [
        stage("router", "Detect Quick Edit", false, true),
        stage("deterministic_validator", "Validate path and content", false, true),
        stage("finalizer", "Stage one reviewable file", false, true),
      ],
      warnings: [],
    };
  }

  if (!input.decision.allowFileChanges && !input.decision.requiresContextEngine) {
    const routeReason = "Conversational task; use current chat history and avoid project scanning.";
    return {
      ...base,
      mode: "chat",
      routeReason,
      routeReasonUser: "This is a chat request, so I will answer from the current conversation without scanning the project.",
      routeReasonInternal: routeReason,
      expectedModelCalls: 1,
      maxExpectedModelCalls: 1,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS - 1,
      requiresProjectContext: false,
      allowsArtifacts: false,
      timeoutRisk: "low",
      timeoutPolicy: "Single short provider call with conversation history under budget.",
      recoveryPolicy: "Retry the same answer request or switch model; never create artifacts from Chat Mode.",
      stages: [
        stage("router", "Route to Chat", false, true),
        stage("chat_assistant", "Answer from conversation context", true, false),
      ],
      warnings: [],
    };
  }

  if (input.decision.executionMode === "plan") {
    const routeReason = "Planning request; produce a structured read-only plan without staged artifacts.";
    return {
      ...base,
      mode: "plan",
      routeReason,
      routeReasonUser: "This is planning work, so I will produce a structured read-only plan before any file changes.",
      routeReasonInternal: `${routeReason} Context profile: ${contextProfile}.`,
      expectedModelCalls: 1,
      maxExpectedModelCalls: 1,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS - 1,
      allowsArtifacts: false,
      timeoutRisk: "medium",
      timeoutPolicy: "One bounded planning call; timeout becomes a recoverable Plan error, not success.",
      recoveryPolicy: "Retry plan, reduce context, or switch to Chat for clarification; do not stage files.",
      stages: [
        stage("router", "Route to Plan", false, true),
        stage("context_analyst", "Select minimal context", false, true),
        stage("planner", "Draft structured plan", true, false, 60_000),
        stage("reviewer", "Review plan risks", false, true),
        stage("finalizer", "Format Plan Result", false, true),
      ],
      warnings: [],
    };
  }

  if (!input.decision.allowFileChanges && input.decision.requiresContextEngine) {
    const routeReason = "Read-only project analysis; use targeted Context Engine files and create no artifacts.";
    return {
      ...base,
      mode: "read_only_context",
      routeReason,
      routeReasonUser: "This needs project context, but it is read-only, so I will select targeted files and not stage changes.",
      routeReasonInternal: `${routeReason} Context profile: ${contextProfile}; selected files estimate: ${selectedFilesEstimate}.`,
      expectedModelCalls: 1,
      maxExpectedModelCalls: 1,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS - 1,
      allowsArtifacts: false,
      timeoutRisk: contextTokensEstimate > 48_000 ? "high" : "medium",
      timeoutPolicy: "One analysis call; high context estimates should reduce context before retry.",
      recoveryPolicy: "Preserve selected files, offer retry/reduced context/switch model, and never fake completion.",
      stages: [
        stage("router", "Route read-only analysis", false, true),
        stage("context_analyst", "Select targeted files", false, true),
        stage("chat_assistant", "Explain selected context", true, false, 75_000),
        stage("finalizer", "Return read-only result", false, true),
      ],
      warnings: selectedFilesEstimate === 0 ? ["Project context has not selected files yet."] : [],
    };
  }

  if (isStaticWebsiteCreationPrompt(input.prompt)) {
    const expectedModelCalls = 1 + WEBSITE_CHUNK_COUNT;
    const routeReason = "Static website creation benefits from chunked file generation and deterministic validation.";
    return {
      ...base,
      mode: "agent",
      routeReason,
      routeReasonUser: "This is a website-building task, so I will use Agent Mode with minimal context, staged files, and validation before Apply.",
      routeReasonInternal: `${routeReason} Generate one file at a time and do not let emergency fallback pass the benchmark.`,
      expectedModelCalls,
      maxExpectedModelCalls: expectedModelCalls + WEBSITE_CHUNK_COUNT,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: 2,
      allowsArtifacts: true,
      timeoutRisk: "medium",
      timeoutPolicy: "Chunked Coder gets a longer per-file timeout; failed files can retry with reduced context.",
      recoveryPolicy: "Preserve partial artifacts, retry failed file, reduce context once, then require explicit emergency fallback.",
      stages: [
        stage("router", "Route website task", false, true),
        stage("context_curator", "Keep context minimal for new site", false, true),
        stage("planner", "Create file plan", false, true),
        stage("chunked_coder", "Generate website files one by one", true, false, 120_000),
        stage("deterministic_validator", "Check required sections before model review", false, true),
        stage("reviewer", "Use model review only if deterministic checks are inconclusive", true, false, 45_000),
        stage("targeted_fixer", "Repair only concrete issues", true, false, 45_000),
        stage("finalizer", "Summarize staged changes", false, true),
      ],
      warnings: ["Fallback scaffold is recovery-only and never counts as benchmark success."],
    };
  }

  const routeReason = "File-changing task; use full pipeline only where deterministic checks are insufficient.";
  return {
    ...base,
    mode: "agent",
    routeReason,
    routeReasonUser: "This requires file changes, so I will stage artifacts in Agent Mode and wait for Apply Changes.",
    routeReasonInternal: `${routeReason} Expected model calls depend on deterministic validation and targeted repair needs.`,
    expectedModelCalls: 4,
    maxExpectedModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS,
    baselineSingleModelCalls: 1,
    avoidedFullPipelineModelCalls: 0,
    allowsArtifacts: true,
    timeoutRisk: contextTokensEstimate > 64_000 ? "high" : "medium",
    timeoutPolicy: "Planner/Coder calls are bounded; review/fix stages use shorter timeouts and can be skipped.",
    recoveryPolicy: "Preserve staged artifacts, retry failed stage, reduce context once, and avoid fallback success.",
    stages: [
      stage("router", "Route file-changing task", false, true),
      stage("context_curator", "Find minimal relevant context", false, true),
      stage("planner", "Create implementation plan", true, false, 75_000),
      stage("chunked_coder", "Prepare staged artifacts", true, false),
      stage("deterministic_validator", "Run deterministic checks first", false, true),
      stage("reviewer", "Review only when needed", true, false, 45_000),
      stage("targeted_fixer", "Repair concrete issues", true, false, 45_000),
      stage("finalizer", "Summarize result", true, false, 45_000),
    ],
    warnings: [],
  };
}

export function normalizeStructuredPlan(text: string): StructuredPlan {
  const compact = text.trim();
  const lines = compact.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const fallbackGoal = compact.slice(0, 180) || "Prepare a safe implementation plan.";
  return {
    goal: firstNonEmpty(lines) ?? fallbackGoal,
    assumptions: extractSection(lines, ["assumption", "assumptions", "допущ"]),
    fileAreas: extractSection(lines, ["file", "files", "area", "areas", "файл"]),
    implementationSteps: extractSection(lines, ["step", "steps", "implementation", "шаг"]),
    risks: extractSection(lines, ["risk", "risks", "риск"]),
    tests: extractSection(lines, ["test", "tests", "провер"]),
    estimatedComplexity: estimatePlanComplexity(compact),
    suggestedExecutionMode: /\b(create|implement|change|modify|fix|создай|измени|исправь|реализуй)\b/iu.test(compact)
      ? "agent"
      : "plan",
  };
}

export function validateStagedArtifactsDeterministically(args: {
  readonly prompt: string;
  readonly artifacts: readonly ArtifactValidationInput[];
}): DeterministicValidationSummary {
  if (args.artifacts.length === 0) {
    return {
      status: "failed",
      skipModelReview: false,
      issues: ["No staged artifacts were produced."],
      checkedSignals: [],
      reason: "There is nothing to validate.",
    };
  }

  if (isStaticWebsiteCreationPrompt(args.prompt)) {
    return validateStaticWebsiteArtifacts(args.artifacts);
  }

  return {
    status: "needs_model_review",
    skipModelReview: false,
    issues: [],
    checkedSignals: ["artifact presence"],
    reason: "Generic file-changing task needs model review after deterministic checks.",
  };
}

export function isStaticWebsiteCreationPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const asksForSite =
    /\b(landing|landing page|website|site|web app|homepage)\b/iu.test(text) ||
    text.includes("лендинг") ||
    text.includes("сайт") ||
    text.includes("страниц");
  const asksToCreate =
    /\b(create|build|make|generate|implement|write)\b/iu.test(text) ||
    text.includes("создай") ||
    text.includes("сделай") ||
    text.includes("построй") ||
    text.includes("сгенер");
  const staticSignals =
    /\b(hero|features|faq|responsive|cards|pricing|abilities|characters)\b/iu.test(text) ||
    text.includes("способност") ||
    text.includes("персонаж") ||
    text.includes("карточ");
  return asksForSite && asksToCreate && staticSignals;
}

function inferContextProfile(input: AgentCoreEstimateInput): AgentContextProfile {
  const text = input.prompt.toLowerCase();

  if (
    input.quickEditAvailable ||
    (input.decision.intent === "run_command" && input.decision.riskLevel === "destructive") ||
    input.decision.executionMode === "clarify"
  ) {
    return "none";
  }

  if (isStaticWebsiteCreationPrompt(input.prompt)) return "website_creation";
  if (input.decision.intent === "security_review") return "security_review";
  if (isApplyChangesQuestion(text)) return "apply_changes_explain";
  if (isUiWorkPrompt(text)) return "ui_work";

  if (!input.decision.requiresContextEngine && asksAboutConversationHistory(text)) {
    return "conversation_memory";
  }

  if (!input.decision.requiresContextEngine && !input.decision.allowFileChanges) {
    return "casual_chat";
  }

  if (input.decision.requiresContextEngine || input.decision.intent === "explain_project") {
    return "project_explain";
  }

  return "project_explain";
}

function isApplyChangesQuestion(text: string): boolean {
  return /\b(apply changes|apply|staging|staged|artifact|artifacts|nativebindings|desktoporchestratortransport|workbench)\b/iu.test(text) ||
    /\u043f\u0440\u0438\u043c\u0435\u043d|\u0441\u0442\u0435\u0439\u0434\u0436|\u0430\u0440\u0442\u0435\u0444\u0430\u043a\u0442/iu.test(text);
}

function isUiWorkPrompt(text: string): boolean {
  return /\b(ui|ux|interface|composer|sidebar|right panel|inspector|workbench|main\.css|playwright|mcp|scenario)\b/iu.test(text) ||
    /\u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441|\u043a\u043e\u043c\u043f\u043e\u0437\u0435\u0440|\u0441\u0430\u0439\u0434\u0431\u0430\u0440/iu.test(text);
}

function asksAboutConversationHistory(text: string): boolean {
  return /\b(above|previous|earlier|before|history|last message|what did i write)\b/iu.test(text) ||
    /\u0447\u0442\u043e\s+\u044f\s+\u043f\u0438\u0441\u0430\u043b|\u0432\u044b\u0448\u0435|\u043f\u0440\u0435\u0434\u044b\u0434\u0443\u0449/iu.test(text);
}

function validateStaticWebsiteArtifacts(
  artifacts: readonly ArtifactValidationInput[],
): DeterministicValidationSummary {
  const content = artifacts.map((artifact) => artifact.content).join("\n").toLowerCase();
  const names = artifacts.map((artifact) => artifact.fileName.replace(/\\/g, "/").toLowerCase());
  const checkedSignals: string[] = [];
  const issues: string[] = [];

  const hasIndex = names.some((name) => name.endsWith("index.html"));
  const hasCss = names.some((name) => name.endsWith(".css"));
  const hasScript = names.some((name) => name.endsWith(".js"));
  const hasReadme = names.some((name) => name.endsWith("readme.md"));
  recordSignal(checkedSignals, issues, hasIndex, "index.html artifact");
  recordSignal(checkedSignals, issues, hasCss, "CSS artifact");
  recordSignal(checkedSignals, issues, hasScript, "script artifact");
  recordSignal(checkedSignals, issues, hasReadme, "README preview instructions");

  const sectionSignals = [
    ["hero section", /\bhero\b|герой|главн/iu],
    ["abilities section", /\babilities\b|ability|способност/iu],
    ["characters/energy section", /\b(characters?|energy)\b|персонаж|энерг/iu],
    ["features section", /\bfeatures?\b|преимущ|возможност/iu],
    ["FAQ section", /\bfaq\b|question|вопрос/iu],
    ["responsive layout", /@media|\bresponsive\b|viewport|clamp\(|flex-wrap|grid-template/iu],
    ["dark anime/card styling", /\b(card|cards|anime|dark|curse|violet|purple|background)\b|#[0-1][0-9a-f]{2,6}|карточ|аниме|тёмн|темн/iu],
    ["preview/apply instruction", /apply changes|open [`"']?index\.html|preview|открыть|примен/iu],
  ] as const;

  for (const [label, regex] of sectionSignals) {
    recordSignal(checkedSignals, issues, regex.test(content), label);
  }

  if (issues.length > 0) {
    return {
      status: "needs_model_review",
      skipModelReview: false,
      issues,
      checkedSignals,
      reason: "Static website artifacts are present but deterministic acceptance signals are incomplete.",
    };
  }

  return {
    status: "passed",
    skipModelReview: true,
    issues: [],
    checkedSignals,
    reason: "Chunked website artifacts include runnable files and required user-visible sections.",
  };
}

function stage(
  id: AgentCoreStageEstimate["id"],
  label: string,
  modelCall: boolean,
  deterministic: boolean,
  timeoutMs?: number,
): AgentCoreStageEstimate {
  return {
    id,
    label,
    modelCall,
    deterministic,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function recordSignal(checked: string[], issues: string[], ok: boolean, label: string): void {
  checked.push(label);
  if (!ok) issues.push(`Missing ${label}.`);
}

function extractSection(lines: readonly string[], labels: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const line of lines) {
    const normalized = line.toLowerCase();
    if (labels.some((label) => normalized.includes(label))) {
      const cleaned = line.replace(/^[-*#\d.)\s]+/u, "").trim();
      if (cleaned.length > 0) found.push(cleaned);
    }
  }
  return found.slice(0, 8);
}

function firstNonEmpty(lines: readonly string[]): string | undefined {
  return lines.find((line) => line.length > 0);
}

function estimatePlanComplexity(text: string): StructuredPlan["estimatedComplexity"] {
  const tokens = estimateTokens(text);
  if (tokens > 1800) return "high";
  if (tokens > 700) return "medium";
  return "low";
}
