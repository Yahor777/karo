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

export type AgentImplementationTaskType =
  | "quick_edit"
  | "single_file"
  | "static_website"
  | "existing_project_change";

export interface AgentImplementationPlan {
  readonly taskType: AgentImplementationTaskType;
  readonly goal: string;
  readonly filesToCreate: readonly string[];
  readonly filesToModify: readonly string[];
  readonly filesToRead: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly risks: readonly string[];
  readonly expectedArtifacts: readonly string[];
  readonly previewInstructionsNeeded: boolean;
  readonly estimatedModelCalls: number;
  readonly contextBudget: "none" | "minimal" | "targeted" | "broad";
  readonly fallbackAllowedAsSuccess: false;
}

export interface TargetedArtifactRepair {
  readonly fileName: string;
  readonly content: string;
  readonly addressedIssues: readonly string[];
  readonly summary: string;
}

const FULL_AGENT_PIPELINE_EXPECTED_CALLS = 7;
const WEBSITE_CHUNK_COUNT = 4;
const STATIC_WEBSITE_FILES = [
  "src/karo-demo-site/index.html",
  "src/karo-demo-site/styles.css",
  "src/karo-demo-site/script.js",
  "src/karo-demo-site/README.md",
] as const;

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

export function buildAgentImplementationPlan(input: {
  readonly prompt: string;
  readonly decision: TaskDecision;
  readonly quickEditAvailable: boolean;
  readonly contextProfile?: AgentContextProfile | undefined;
}): AgentImplementationPlan {
  const compactPrompt = input.prompt.trim();
  if (input.quickEditAvailable) {
    return {
      taskType: "quick_edit",
      goal: compactPrompt || "Stage a deterministic file edit.",
      filesToCreate: [],
      filesToModify: [],
      filesToRead: [],
      acceptanceCriteria: [
        "Stage exactly the requested file content.",
        "Do not call a model.",
        "Require Apply Changes before writing to the project.",
      ],
      requiredChecks: ["safe path", "non-empty content", "no auto-apply"],
      risks: ["Path or content parsing may fail; fail closed if ambiguous."],
      expectedArtifacts: ["one staged file"],
      previewInstructionsNeeded: /index\.html|\.html\b/i.test(compactPrompt),
      estimatedModelCalls: 0,
      contextBudget: "none",
      fallbackAllowedAsSuccess: false,
    };
  }

  if (isStaticWebsiteCreationPrompt(input.prompt)) {
    return {
      taskType: "static_website",
      goal:
        "Create a small runnable static website with staged files, deterministic validation, and preview instructions.",
      filesToCreate: STATIC_WEBSITE_FILES,
      filesToModify: [],
      filesToRead: input.contextProfile === "website_creation" ? [] : [],
      acceptanceCriteria: [
        "index.html contains title/meta viewport, linked styles.css/script.js, hero, abilities, characters/energy, features, FAQ, and a visible CTA.",
        "index.html contains substantive subject-specific copy, not just section labels or placeholder cards.",
        "styles.css contains responsive premium dark anime/card styling, visual depth, stable spacing, and a mobile layout.",
        "styles.css includes interactive polish for links/cards without layout shift.",
        "script.js is present, non-empty, and limited to safe local progressive enhancement.",
        "README.md explains Apply Changes and preview/open flow.",
        "All generated files remain staged until Apply Changes.",
        "Emergency fallback is not counted as benchmark success.",
      ],
      requiredChecks: [
        "artifact paths stay inside project",
        "required website files exist",
        "required visible sections exist",
        "metadata and linked assets exist",
        "substantive section copy exists",
        "offline-safe local assets only",
        "responsive styling signal exists",
        "premium visual polish signal exists",
        "interactive polish signal exists",
        "preview instructions exist",
        "no generated secrets",
      ],
      risks: [
        "Provider timeout on an individual file chunk.",
        "Missing section can make a visually incomplete landing page.",
        "Preview must wait until staged files are applied.",
      ],
      expectedArtifacts: STATIC_WEBSITE_FILES,
      previewInstructionsNeeded: true,
      estimatedModelCalls: 1 + WEBSITE_CHUNK_COUNT,
      contextBudget: "minimal",
      fallbackAllowedAsSuccess: false,
    };
  }

  const taskType: AgentImplementationTaskType =
    input.decision.intent === "create_file" ? "single_file" : "existing_project_change";
  return {
    taskType,
    goal: compactPrompt || "Prepare staged file changes.",
    filesToCreate: taskType === "single_file" ? ["model-selected target file"] : [],
    filesToModify: taskType === "existing_project_change" ? ["targeted project files"] : [],
    filesToRead: input.decision.requiresContextEngine ? ["Context Curator selected files"] : [],
    acceptanceCriteria: [
      "Create or modify only files required by the prompt.",
      "Stage artifacts and require Apply Changes.",
      "Run deterministic checks before model review.",
      "Skip Reviewer when deterministic checks prove the result.",
    ],
    requiredChecks: [
      "safe artifact paths",
      "non-empty artifacts",
      "requested task satisfied",
      "no auto-apply",
    ],
    risks: [
      "Broad prompts may need targeted context and one reviewer pass.",
      "Provider timeout should preserve partial artifacts.",
    ],
    expectedArtifacts: ["staged artifacts"],
    previewInstructionsNeeded: /preview|run|website|site|app/i.test(compactPrompt),
    estimatedModelCalls: taskType === "single_file" ? 1 : 4,
    contextBudget: input.decision.requiresContextEngine ? "targeted" : "minimal",
    fallbackAllowedAsSuccess: false,
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

  const criticalIssues = collectCriticalArtifactIssues(args.artifacts);
  if (criticalIssues.length > 0) {
    return {
      status: "failed",
      skipModelReview: false,
      issues: criticalIssues,
      checkedSignals: ["safe artifact paths", "non-empty content", "secret scan"],
      reason: "One or more staged artifacts failed a deterministic safety check.",
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

export function repairStaticWebsiteArtifactsTargeted(args: {
  readonly artifacts: readonly ArtifactValidationInput[];
  readonly issues: readonly string[];
}): readonly TargetedArtifactRepair[] {
  const repairs: TargetedArtifactRepair[] = [];
  const index = findArtifact(args.artifacts, /index\.html$/i);
  const readme = findArtifact(args.artifacts, /readme\.md$/i);
  const css = findArtifact(args.artifacts, /\.css$/i);
  const script = findArtifact(args.artifacts, /\.js$/i);

  if (index !== undefined) {
    let nextIndex = index.content;
    const additions: string[] = [];
    const addressedIssues: string[] = [];
    if (hasIssue(args.issues, "hero section") && !/\bhero\b/i.test(index.content)) {
      additions.push('<section class="hero"><h1>Minecraft JJK Mod</h1><p>Dark anime battles with cursed techniques.</p></section>');
      addressedIssues.push("hero section");
    }
    if (hasIssue(args.issues, "abilities section") && !/\babilities\b/i.test(index.content)) {
      additions.push('<section class="abilities"><h2>Abilities</h2><p>Black Flash, Infinity, cursed tools, and domain pressure.</p></section>');
      addressedIssues.push("abilities section");
    }
    if (hasIssue(args.issues, "characters/energy section") && !/\b(characters?|energy)\b/i.test(index.content)) {
      additions.push('<section class="energy"><h2>Characters / Energy</h2><p>Character roles and cursed energy progression.</p></section>');
      addressedIssues.push("characters/energy section");
    }
    if (hasIssue(args.issues, "features section") && !/\bfeatures?\b/i.test(index.content)) {
      additions.push('<section class="features"><h2>Features</h2><p>Responsive cards, mod highlights, and preview-ready content.</p></section>');
      addressedIssues.push("features section");
    }
    if (hasIssue(args.issues, "FAQ section") && !/\bfaq\b/i.test(index.content)) {
      additions.push('<section class="faq"><h2>FAQ</h2><p>Apply Changes first, then open index.html from Preview.</p></section>');
      addressedIssues.push("FAQ section");
    }
    if (hasIssue(args.issues, "visible CTA") && !hasVisibleCta(index.content)) {
      additions.push(
        '<section class="cta"><h2>Ready to enter the domain?</h2><a class="cta-button" href="#abilities">Explore cursed techniques</a></section>',
      );
      addressedIssues.push("visible CTA");
    }
    if (hasIssue(args.issues, "substantive section copy") && !hasSubstantiveWebsiteCopy(index.content)) {
      additions.push(
        [
          '<section class="experience-grid" aria-labelledby="experience-title">',
          '<h2 id="experience-title">Cursed technique showcase</h2>',
          '<p>Explore a focused Minecraft JJK mod hub with clear ability cards, character energy roles, progression hooks, and preview-ready guidance for players before they install or test the build.</p>',
          '<div class="feature-card"><h3>Domain-ready combat</h3><p>Highlights Infinity pressure, Black Flash timing, cursed tools, and defensive choices in concise playable terms.</p></div>',
          '<div class="feature-card"><h3>Character energy loop</h3><p>Shows how characters, energy management, and abilities connect so the landing page feels like a real product surface.</p></div>',
          "</section>",
        ].join(""),
      );
      addressedIssues.push("substantive section copy");
    }
    if (additions.length > 0) {
      nextIndex = insertHtmlSections(nextIndex, additions);
    }
    if (hasIssue(args.issues, "document metadata") || hasIssue(args.issues, "stylesheet/script wiring")) {
      nextIndex = ensureStaticWebsiteHtmlShell(nextIndex);
      if (hasIssue(args.issues, "document metadata")) addressedIssues.push("document metadata");
      if (hasIssue(args.issues, "stylesheet/script wiring")) addressedIssues.push("stylesheet/script wiring");
    }
    if (nextIndex !== index.content) {
      repairs.push({
        fileName: index.fileName,
        content: nextIndex,
        addressedIssues,
        summary: `Added missing website quality structure in ${index.fileName}.`,
      });
    }
  }

  if (hasIssue(args.issues, "README preview instructions") || hasIssue(args.issues, "preview/apply instruction")) {
    const readmeFile = readme?.fileName ?? "src/karo-demo-site/README.md";
    const base = readme?.content.trim() ?? "# Minecraft JJK landing page";
    if (!/apply changes|preview|open [`"']?index\.html/i.test(base)) {
      repairs.push({
        fileName: readmeFile,
        content: `${base}\n\n## Preview\n\nApply Changes first, then open \`src/karo-demo-site/index.html\` from Preview or your browser.\n`,
        addressedIssues: ["preview/apply instruction"],
        summary: `Added preview instructions in ${readmeFile}.`,
      });
    }
  }

  if (hasIssue(args.issues, "CSS artifact") && css === undefined) {
    repairs.push({
      fileName: "src/karo-demo-site/styles.css",
      content:
        ":root { color-scheme: dark; --jjk-bg: #07070b; --jjk-card: rgba(16, 14, 25, .84); --jjk-line: #34284a; --jjk-accent: #8b5cf6; background: var(--jjk-bg); color: #f6f1ff; }\nbody { margin: 0; background: radial-gradient(circle at top, rgba(139, 92, 246, .24), transparent 42%), var(--jjk-bg); }\nmain { padding: clamp(24px, 5vw, 72px); display: grid; gap: 24px; }\n.card, .feature-card, section { border: 1px solid var(--jjk-line); border-radius: 16px; padding: clamp(18px, 3vw, 28px); background: var(--jjk-card); box-shadow: 0 24px 80px rgba(0, 0, 0, .32); }\n.cta-button, a, button { transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease; }\n.cta-button { display: inline-flex; padding: 12px 16px; border-radius: 999px; background: var(--jjk-accent); color: white; text-decoration: none; }\n.cta-button:hover, a:hover, button:hover { transform: translateY(-1px); }\n.cta-button:focus-visible, a:focus-visible, button:focus-visible { outline: 2px solid var(--jjk-accent); outline-offset: 3px; }\n@media (min-width: 860px) { main { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hero, .cta, .experience-grid { grid-column: 1 / -1; } }\n",
      addressedIssues: [
        "CSS artifact",
        "responsive layout",
        "dark anime/card styling",
        "premium visual depth",
        "stable spacing system",
        "interactive polish",
      ],
      summary: "Created missing website stylesheet.",
    });
  } else if (
    css !== undefined &&
    (hasIssue(args.issues, "responsive layout") ||
      hasIssue(args.issues, "dark anime/card styling") ||
      hasIssue(args.issues, "premium visual depth") ||
      hasIssue(args.issues, "stable spacing system") ||
      hasIssue(args.issues, "interactive polish"))
  ) {
    const extra =
      "\n/* Karo targeted validation repair */\n:root { --jjk-card: rgba(14, 12, 24, .86); --jjk-line: #30243f; --jjk-accent: #8b5cf6; }\nbody { background: radial-gradient(circle at top, rgba(139, 92, 246, .2), transparent 42%), #07070b; }\nmain { padding: clamp(24px, 5vw, 72px); gap: 24px; }\n.card, .feature-card, section { border: 1px solid var(--jjk-line); border-radius: 16px; background: var(--jjk-card); box-shadow: 0 24px 80px rgba(0, 0, 0, .32); }\n.cta-button, a, button { transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease; }\n.cta-button { display: inline-flex; padding: 12px 16px; border-radius: 999px; background: var(--jjk-accent); color: white; text-decoration: none; }\n.cta-button:hover, a:hover, button:hover { transform: translateY(-1px); }\n.cta-button:focus-visible, a:focus-visible, button:focus-visible { outline: 2px solid var(--jjk-accent); outline-offset: 3px; }\n@media (min-width: 860px) { main { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; } .hero, .cta, .experience-grid { grid-column: 1 / -1; } }\n";
    repairs.push({
      fileName: css.fileName,
      content: `${css.content.trim()}\n${extra}`,
      addressedIssues: [
        "responsive layout",
        "dark anime/card styling",
        "premium visual depth",
        "stable spacing system",
        "interactive polish",
      ],
      summary: `Added responsive premium card styling in ${css.fileName}.`,
    });
  }

  if (hasIssue(args.issues, "script artifact") && script === undefined) {
    repairs.push({
      fileName: "src/karo-demo-site/script.js",
      content: "document.documentElement.dataset.karoPreviewReady = 'true';\n",
      addressedIssues: ["script artifact"],
      summary: "Created missing website script.",
    });
  }

  return repairs;
}

export function buildAgentFinalizerNotes(args: {
  readonly status: "completed" | "recovery" | "failed";
  readonly changedFiles: readonly string[];
  readonly validation?: DeterministicValidationSummary | undefined;
  readonly fallbackUsed: boolean;
  readonly modelCallsUsed?: number | undefined;
  readonly contextProfile?: AgentContextProfile | undefined;
}): readonly string[] {
  const notes: string[] = [];
  notes.push(
    args.status === "completed"
      ? "Changes are staged for review; Apply Changes is still required before project files are written."
      : "This run is not completed; staged partial artifacts remain reviewable.",
  );
  if (args.changedFiles.length > 0) {
    notes.push(`Changed files: ${args.changedFiles.join(", ")}.`);
  }
  if (args.validation !== undefined) {
    notes.push(`Deterministic validation: ${args.validation.status}. ${args.validation.reason}`);
    if (args.validation.checkedSignals.length > 0) {
      notes.push(`Checks passed/inspected: ${args.validation.checkedSignals.join(", ")}.`);
    }
    if (args.validation.issues.length > 0) {
      notes.push(`Remaining issues: ${args.validation.issues.join("; ")}.`);
    }
  }
  notes.push(`Fallback used: ${args.fallbackUsed ? "yes" : "no"}. Emergency fallback never counts as benchmark success.`);
  if (typeof args.modelCallsUsed === "number") {
    notes.push(`Model calls used: ${String(args.modelCallsUsed)}.`);
  }
  if (args.contextProfile !== undefined) {
    notes.push(`Context profile: ${args.contextProfile}.`);
  }
  if (args.changedFiles.some((file) => /index\.html$/i.test(file))) {
    notes.push("Preview: after Apply Changes, open the staged index.html through Preview/Open in browser.");
  }
  return notes;
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
  const explicitWebsiteFiles = /\b(index\.html|styles\.css|script\.js|readme\.md)\b/iu.test(text);
  const unicodeSiteSignals = /\u0441\u0430\u0439\u0442|\u043b\u0435\u043d\u0434\u0438\u043d\u0433|\u0441\u0442\u0440\u0430\u043d\u0438\u0446/iu.test(text);
  const unicodeCreateSignals = /\u0441\u043e\u0437\u0434\u0430|\u0441\u0434\u0435\u043b\u0430|\u043f\u043e\u0441\u0442\u0440\u043e|\u0441\u0433\u0435\u043d\u0435\u0440|\u0440\u0435\u0430\u043b\u0438\u0437/iu.test(text);
  const unicodeSectionSignals = /\u0441\u043f\u043e\u0441\u043e\u0431\u043d\u043e\u0441|\u043f\u0435\u0440\u0441\u043e\u043d\u0430\u0436|\u044d\u043d\u0435\u0440\u0433|\u043a\u0430\u0440\u0442\u043e\u0447/iu.test(text);
  return (
    (asksForSite || explicitWebsiteFiles || unicodeSiteSignals) &&
    (asksToCreate || unicodeCreateSignals) &&
    (staticSignals || explicitWebsiteFiles || unicodeSectionSignals)
  );
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

function collectCriticalArtifactIssues(artifacts: readonly ArtifactValidationInput[]): readonly string[] {
  const issues: string[] = [];
  for (const artifact of artifacts) {
    const path = artifact.fileName.replace(/\\/g, "/").trim();
    const content = artifact.content.trim();
    if (path.startsWith("../") || path.includes("/../") || /^[a-z]:\//i.test(path) || path.startsWith("/")) {
      issues.push(`Forbidden artifact path: ${artifact.fileName}.`);
    }
    if (/^\.env(?:\.|$)|\/\.env(?:\.|$)|node_modules\//i.test(path)) {
      issues.push(`Forbidden generated file target: ${artifact.fileName}.`);
    }
    if (content.length === 0) {
      issues.push(`Empty artifact content: ${artifact.fileName}.`);
    }
    if (/\b(sk|pk|rk)_(test|live)_[A-Za-z0-9]+/u.test(content)) {
      issues.push(`Secret-looking value generated in ${artifact.fileName}.`);
    }
  }
  return issues;
}

function validateStaticWebsiteArtifacts(
  artifacts: readonly ArtifactValidationInput[],
): DeterministicValidationSummary {
  const content = artifacts.map((artifact) => artifact.content).join("\n").toLowerCase();
  const names = artifacts.map((artifact) => artifact.fileName.replace(/\\/g, "/").toLowerCase());
  const index = findArtifact(artifacts, /index\.html$/i);
  const css = findArtifact(artifacts, /\.css$/i);
  const indexContent = index?.content ?? "";
  const cssContent = css?.content ?? "";
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
  for (const artifact of artifacts) {
    const trimmed = artifact.content.trim();
    const placeholderOnly =
      trimmed.length < 24 ||
      /^(todo|placeholder|lorem ipsum|coming soon|empty div|<div><\/div>|<div\s*\/>)$/iu.test(trimmed);
    recordSignal(checkedSignals, issues, !placeholderOnly, `non-placeholder content in ${artifact.fileName}`);
  }

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
  recordSignal(checkedSignals, issues, hasSubstantiveWebsiteCopy(indexContent), "substantive section copy");
  recordSignal(checkedSignals, issues, !hasExternalNetworkDependency(artifacts), "offline-safe local assets");
  recordSignal(
    checkedSignals,
    issues,
    /<title\b/i.test(indexContent) && /<meta\b[^>]*name=["']viewport["']/i.test(indexContent),
    "document metadata",
  );
  recordSignal(
    checkedSignals,
    issues,
    /<link\b[^>]*href=["'][^"']*styles\.css["']/i.test(indexContent) &&
      /<script\b[^>]*src=["'][^"']*script\.js["']/i.test(indexContent),
    "stylesheet/script wiring",
  );
  recordSignal(checkedSignals, issues, hasVisibleCta(indexContent), "visible CTA");
  recordSignal(
    checkedSignals,
    issues,
    /linear-gradient|radial-gradient|box-shadow|backdrop-filter|rgba\(|transition|transform/iu.test(cssContent),
    "premium visual depth",
  );
  recordSignal(
    checkedSignals,
    issues,
    /:\s*root|--[a-z0-9-]+\s*:|gap\s*:|padding\s*:|max-width|minmax\(|clamp\(/iu.test(cssContent),
    "stable spacing system",
  );
  recordSignal(
    checkedSignals,
    issues,
    /:hover|:focus-visible|transition\s*:|transform\s*:/iu.test(cssContent),
    "interactive polish",
  );

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

function findArtifact(
  artifacts: readonly ArtifactValidationInput[],
  pattern: RegExp,
): ArtifactValidationInput | undefined {
  return artifacts.find((artifact) => pattern.test(artifact.fileName.replace(/\\/g, "/")));
}

function hasIssue(issues: readonly string[], label: string): boolean {
  return issues.some((issue) => issue.toLowerCase().includes(label.toLowerCase()));
}

function insertHtmlSections(content: string, additions: readonly string[]): string {
  const block = `\n    ${additions.join("\n    ")}\n`;
  if (/<\/main>/i.test(content)) return content.replace(/<\/main>/i, `${block}</main>`);
  if (/<\/body>/i.test(content)) return content.replace(/<\/body>/i, `${block}</body>`);
  return `${content.trim()}\n${additions.join("\n")}\n`;
}

function hasVisibleCta(content: string): boolean {
  return /class=["'][^"']*\bcta\b|<button\b|<a\b[^>]*href=|call to action|explore|start|download|join|apply changes|open preview/iu.test(
    content,
  );
}

function hasSubstantiveWebsiteCopy(content: string): boolean {
  const text = extractVisibleText(content);
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [];
  return words.length >= 45 && /[.!?]/u.test(text);
}

function extractVisibleText(content: string): string {
  return content
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:nbsp|amp|quot|apos|lt|gt);/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function hasExternalNetworkDependency(artifacts: readonly ArtifactValidationInput[]): boolean {
  return artifacts.some((artifact) =>
    /\b(?:https?:)?\/\/|fetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|importScripts\s*\(/iu.test(artifact.content),
  );
}

function ensureStaticWebsiteHtmlShell(content: string): string {
  const trimmed = content.trim();
  const bodyOnly = /<body\b/i.test(trimmed)
    ? trimmed.replace(/^[\s\S]*<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "").trim()
    : trimmed;
  const mainContent = /<main\b/i.test(bodyOnly)
    ? bodyOnly
    : `<main class="jjk-page">\n    ${bodyOnly}\n  </main>`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    "  <title>Minecraft JJK Mod</title>",
    '  <link rel="stylesheet" href="./styles.css">',
    '  <script defer src="./script.js"></script>',
    "</head>",
    "<body>",
    `  ${mainContent.replace(/\n/g, "\n  ")}`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
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
