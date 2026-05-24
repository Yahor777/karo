import type {
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
  const base = {
    contextTokensEstimate,
    selectedFilesEstimate,
    requiresProjectContext: input.decision.requiresContextEngine,
    fallbackCountsAsSuccess: false as const,
  };

  if (input.decision.executionMode === "clarify") {
    return {
      ...base,
      mode: "clarify",
      routeReason: "The router needs user clarification before spending model calls.",
      expectedModelCalls: 0,
      maxExpectedModelCalls: 0,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS,
      allowsArtifacts: false,
      timeoutRisk: "low",
      stages: [stage("router", "Route clarification", false, true)],
      warnings: [],
    };
  }

  if (input.decision.intent === "run_command" && input.decision.riskLevel === "destructive") {
    return {
      ...base,
      mode: "safety",
      routeReason: "Dangerous command detected; Karo must produce a Safety Check without executing it.",
      expectedModelCalls: 0,
      maxExpectedModelCalls: 0,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS,
      allowsArtifacts: false,
      timeoutRisk: "low",
      stages: [
        stage("router", "Route dangerous command", false, true),
        stage("safety_check", "Produce Safety Check", false, true),
      ],
      warnings: ["Command execution remains blocked until explicit safe approval policy is satisfied."],
    };
  }

  if (input.quickEditAvailable) {
    return {
      ...base,
      mode: "quick_edit",
      routeReason: "The request is a deterministic single-file edit; no model call is needed.",
      expectedModelCalls: 0,
      maxExpectedModelCalls: 0,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS,
      allowsArtifacts: true,
      timeoutRisk: "low",
      stages: [
        stage("router", "Detect Quick Edit", false, true),
        stage("deterministic_validator", "Validate path and content", false, true),
        stage("finalizer", "Stage one reviewable file", false, true),
      ],
      warnings: [],
    };
  }

  if (!input.decision.allowFileChanges && !input.decision.requiresContextEngine) {
    return {
      ...base,
      mode: "chat",
      routeReason: "Conversational task; use current chat history and avoid project scanning.",
      expectedModelCalls: 1,
      maxExpectedModelCalls: 1,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS - 1,
      allowsArtifacts: false,
      timeoutRisk: "low",
      stages: [
        stage("router", "Route to Chat", false, true),
        stage("chat_assistant", "Answer from conversation context", true, false),
      ],
      warnings: [],
    };
  }

  if (input.decision.executionMode === "plan") {
    return {
      ...base,
      mode: "plan",
      routeReason: "Planning request; produce a structured read-only plan without staged artifacts.",
      expectedModelCalls: 1,
      maxExpectedModelCalls: 1,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS - 1,
      allowsArtifacts: false,
      timeoutRisk: "medium",
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
    return {
      ...base,
      mode: "read_only_context",
      routeReason: "Read-only project analysis; use targeted Context Engine files and create no artifacts.",
      expectedModelCalls: 1,
      maxExpectedModelCalls: 1,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS - 1,
      allowsArtifacts: false,
      timeoutRisk: contextTokensEstimate > 48_000 ? "high" : "medium",
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
    return {
      ...base,
      mode: "agent",
      routeReason: "Static website creation benefits from chunked file generation and deterministic validation.",
      expectedModelCalls,
      maxExpectedModelCalls: expectedModelCalls + WEBSITE_CHUNK_COUNT,
      baselineSingleModelCalls: 1,
      avoidedFullPipelineModelCalls: 2,
      allowsArtifacts: true,
      timeoutRisk: "medium",
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

  return {
    ...base,
    mode: "agent",
    routeReason: "File-changing task; use full pipeline only where deterministic checks are insufficient.",
    expectedModelCalls: 4,
    maxExpectedModelCalls: FULL_AGENT_PIPELINE_EXPECTED_CALLS,
    baselineSingleModelCalls: 1,
    avoidedFullPipelineModelCalls: 0,
    allowsArtifacts: true,
    timeoutRisk: contextTokensEstimate > 64_000 ? "high" : "medium",
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
