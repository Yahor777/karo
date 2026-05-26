import { describe, expect, it } from "vitest";

import {
  buildAgentFinalizerNotes,
  buildAgentImplementationPlan,
  estimateAgentCoreExecution,
  normalizeStructuredPlan,
  repairStaticWebsiteArtifactsTargeted,
  validateStagedArtifactsDeterministically,
} from "./agentCore.js";
import type { TaskDecision } from "./types.js";

function decision(overrides: Partial<TaskDecision>): TaskDecision {
  return {
    intent: "casual_chat",
    executionMode: "chat",
    confidence: 0.95,
    needsClarification: false,
    clarificationOptions: [],
    allowWebSearch: false,
    allowFileChanges: false,
    allowCommands: false,
    requiresContextEngine: false,
    expectedOutput: "chat",
    riskLevel: "low",
    reasoningSummary: "test",
    ...overrides,
  };
}

describe("Agent Core v1", () => {
  it("estimates Quick Edit as zero model calls", () => {
    const estimate = estimateAgentCoreExecution({
      prompt: "create file src/hello.txt with text hello",
      decision: decision({ intent: "create_file", executionMode: "agent", allowFileChanges: true, expectedOutput: "artifacts" }),
      quickEditAvailable: true,
    });

    expect(estimate.mode).toBe("quick_edit");
    expect(estimate.expectedModelCalls).toBe(0);
    expect(estimate.allowsArtifacts).toBe(true);
    expect(estimate.requiresProjectContext).toBe(false);
    expect(estimate.contextProfile).toBe("none");
    expect(estimate.avoidedFullPipelineModelCalls).toBeGreaterThan(0);
    expect(estimate.fallbackCountsAsSuccess).toBe(false);
  });

  it("estimates simple chat as one model call and no project context", () => {
    const estimate = estimateAgentCoreExecution({
      prompt: "привет кто ты",
      decision: decision({ intent: "casual_chat", executionMode: "chat" }),
      quickEditAvailable: false,
    });

    expect(estimate.mode).toBe("chat");
    expect(estimate.expectedModelCalls).toBeLessThanOrEqual(1);
    expect(estimate.requiresProjectContext).toBe(false);
    expect(estimate.contextProfile).toBe("casual_chat");
    expect(estimate.allowsArtifacts).toBe(false);
  });

  it("profiles conversation memory without project context", () => {
    const estimate = estimateAgentCoreExecution({
      prompt: "what did i write above?",
      decision: decision({ intent: "casual_chat", executionMode: "chat" }),
      quickEditAvailable: false,
    });

    expect(estimate.mode).toBe("chat");
    expect(estimate.contextProfile).toBe("conversation_memory");
    expect(estimate.requiresProjectContext).toBe(false);
    expect(estimate.expectedContextTokens).toBe(0);
  });

  it("estimates Plan Mode as structured read-only work without artifacts", () => {
    const estimate = estimateAgentCoreExecution({
      prompt: "сделай план улучшения UI Karo",
      decision: decision({ intent: "analyze_project", executionMode: "plan", requiresContextEngine: true, expectedOutput: "analysis" }),
      quickEditAvailable: false,
    });

    expect(estimate.mode).toBe("plan");
    expect(estimate.expectedModelCalls).toBe(1);
    expect(estimate.allowsArtifacts).toBe(false);
    expect(estimate.contextProfile).toBe("ui_work");
    expect(estimate.stages.map((stage) => stage.id)).toContain("context_analyst");
    expect(estimate.stages.map((stage) => stage.id)).toContain("finalizer");
  });

  it("profiles Apply Changes explanations as targeted read-only context", () => {
    const estimate = estimateAgentCoreExecution({
      prompt: "Explain how Apply Changes and staged artifacts work",
      decision: decision({
        intent: "explain_project",
        executionMode: "chat",
        requiresContextEngine: true,
        expectedOutput: "explanation",
      }),
      quickEditAvailable: false,
      selectedFilesEstimate: 6,
      contextTokensEstimate: 12_000,
    });

    expect(estimate.mode).toBe("read_only_context");
    expect(estimate.contextProfile).toBe("apply_changes_explain");
    expect(estimate.allowsArtifacts).toBe(false);
    expect(estimate.expectedContextTokens).toBe(12_000);
  });

  it("profiles security review as read-only security context", () => {
    const estimate = estimateAgentCoreExecution({
      prompt: "review project security and command execution",
      decision: decision({
        intent: "security_review",
        executionMode: "chat",
        requiresContextEngine: true,
        expectedOutput: "analysis",
        riskLevel: "high",
      }),
      quickEditAvailable: false,
    });

    expect(estimate.mode).toBe("read_only_context");
    expect(estimate.contextProfile).toBe("security_review");
    expect(estimate.riskLevel).toBe("high");
    expect(estimate.recoveryPolicy).toContain("never fake completion");
  });

  it("keeps dangerous command routing commandless and deterministic", () => {
    const estimate = estimateAgentCoreExecution({
      prompt: "git clean -fdx",
      decision: decision({
        intent: "run_command",
        executionMode: "chat",
        allowCommands: false,
        expectedOutput: "command_result",
        riskLevel: "destructive",
      }),
      quickEditAvailable: false,
    });

    expect(estimate.mode).toBe("safety");
    expect(estimate.allowsCommands).toBe(false);
    expect(estimate.expectedModelCalls).toBe(0);
    expect(estimate.contextProfile).toBe("none");
  });

  it("estimates website generation as chunked coding with deterministic validation before reviewer", () => {
    const estimate = estimateAgentCoreExecution({
      prompt: "Create a landing page website with hero, abilities, characters, energy, features, FAQ, responsive cards.",
      decision: decision({ intent: "create_file", executionMode: "agent", allowFileChanges: true, expectedOutput: "artifacts" }),
      quickEditAvailable: false,
    });

    expect(estimate.mode).toBe("agent");
    expect(estimate.contextProfile).toBe("website_creation");
    expect(estimate.expectedModelCalls).toBe(5);
    expect(estimate.recoveryPolicy).toContain("explicit emergency fallback");
    expect(estimate.stages.map((stage) => stage.id)).toEqual([
      "router",
      "context_curator",
      "planner",
      "chunked_coder",
      "deterministic_validator",
      "reviewer",
      "targeted_fixer",
      "finalizer",
    ]);
    expect(estimate.warnings.join(" ")).toContain("Fallback scaffold");
  });

  it("builds a machine-readable website implementation plan with fallback disqualified", () => {
    const plan = buildAgentImplementationPlan({
      prompt: "Create a landing page website with hero, abilities, characters, energy, features, FAQ, responsive cards.",
      decision: decision({ intent: "create_file", executionMode: "agent", allowFileChanges: true, expectedOutput: "artifacts" }),
      quickEditAvailable: false,
      contextProfile: "website_creation",
    });

    expect(plan.taskType).toBe("static_website");
    expect(plan.filesToCreate).toEqual([
      "src/karo-demo-site/index.html",
      "src/karo-demo-site/styles.css",
      "src/karo-demo-site/script.js",
      "src/karo-demo-site/README.md",
    ]);
    expect(plan.fallbackAllowedAsSuccess).toBe(false);
    expect(plan.previewInstructionsNeeded).toBe(true);
    expect(plan.acceptanceCriteria.join("\n")).toContain("FAQ");
  });

  it("validates complete static website artifacts without model review", () => {
    const result = validateStagedArtifactsDeterministically({
      prompt: "Create a landing page website with hero, abilities, characters, energy, features, FAQ, responsive cards.",
      artifacts: [
        {
          fileName: "src/karo-demo-site/index.html",
          content:
            '<!doctype html><html><head><title>Minecraft JJK Mod</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="./styles.css"><script defer src="./script.js"></script></head><body><main><section class="hero">Hero <a class="cta-button" href="#abilities">Explore abilities</a></section><section id="abilities" class="abilities">Abilities</section><section class="energy">Characters and energy</section><section class="features">Features</section><section class="faq">FAQ</section></main></body></html>',
        },
        {
          fileName: "src/karo-demo-site/styles.css",
          content:
            ":root{--card:rgba(17,17,26,.86)}body{background:radial-gradient(circle at top,#211334,#07070b)}main{display:grid;gap:24px;padding:clamp(24px,5vw,72px)}.card,section{background:var(--card);box-shadow:0 20px 70px rgba(0,0,0,.35)}@media (min-width: 800px){.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}}",
        },
        { fileName: "src/karo-demo-site/script.js", content: "document.documentElement.dataset.ready='true';" },
        { fileName: "src/karo-demo-site/README.md", content: "Apply Changes first, then open index.html in preview." },
      ],
    });

    expect(result.status).toBe("passed");
    expect(result.skipModelReview).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("fails deterministic validation for unsafe artifact paths and generated secrets", () => {
    const result = validateStagedArtifactsDeterministically({
      prompt: "Create a file",
      artifacts: [
        { fileName: "../.env", content: `sk_${"test"}_abcdefghijklmnopqrstuvwxyz` },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.issues.join("\n")).toContain("Forbidden artifact path");
    expect(result.issues.join("\n")).toContain("Secret-looking value");
  });

  it("does not pass incomplete website output as benchmark success", () => {
    const result = validateStagedArtifactsDeterministically({
      prompt: "Create a landing page website with hero, abilities, characters, energy, features, FAQ, responsive cards.",
      artifacts: [{ fileName: "src/karo-demo-site/index.html", content: "<main><section>Hero</section></main>" }],
    });

    expect(result.status).toBe("needs_model_review");
    expect(result.skipModelReview).toBe(false);
    expect(result.issues.join("\n")).toContain("FAQ");
  });

  it("repairs a missing website FAQ by touching only index.html", () => {
    const artifacts = [
      {
        fileName: "src/karo-demo-site/index.html",
        content:
          '<!doctype html><html><head><title>Minecraft JJK Mod</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="./styles.css"><script defer src="./script.js"></script></head><body><main><section class="hero">Hero <a class="cta-button" href="#abilities">Explore abilities</a></section><section id="abilities" class="abilities">Abilities</section><section class="energy">Characters and energy</section><section class="features">Features</section></main></body></html>',
      },
      {
        fileName: "src/karo-demo-site/styles.css",
        content:
          ":root{--card:rgba(17,17,26,.86)}body{background:radial-gradient(circle at top,#211334,#07070b)}main{display:grid;gap:24px;padding:clamp(24px,5vw,72px)}.card,section{background:var(--card);box-shadow:0 20px 70px rgba(0,0,0,.35)}@media (min-width: 800px){.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}}",
      },
      { fileName: "src/karo-demo-site/script.js", content: "document.documentElement.dataset.ready='true';" },
      { fileName: "src/karo-demo-site/README.md", content: "Apply Changes first, then open index.html in preview." },
    ];
    const validation = validateStagedArtifactsDeterministically({
      prompt: "Create a landing page website with hero, abilities, characters, energy, features, FAQ, responsive cards.",
      artifacts,
    });
    const repairs = repairStaticWebsiteArtifactsTargeted({
      artifacts,
      issues: validation.issues,
    });

    expect(validation.status).toBe("needs_model_review");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.fileName).toBe("src/karo-demo-site/index.html");
    expect(repairs[0]?.content).toContain("faq");
  });

  it("repairs low-quality website shell signals without using fallback success", () => {
    const artifacts = [
      {
        fileName: "src/karo-demo-site/index.html",
        content:
          '<main><section class="hero">Hero</section><section class="abilities">Abilities</section><section class="energy">Characters and energy</section><section class="features">Features</section><section class="faq">FAQ</section></main>',
      },
      { fileName: "src/karo-demo-site/styles.css", content: "body{background:#07070b}.card{} @media (min-width: 800px){.grid{display:grid}}" },
      { fileName: "src/karo-demo-site/script.js", content: "document.documentElement.dataset.ready='true';" },
      { fileName: "src/karo-demo-site/README.md", content: "Apply Changes first, then open index.html in preview." },
    ];
    const validation = validateStagedArtifactsDeterministically({
      prompt: "Create a landing page website with hero, abilities, characters, energy, features, FAQ, responsive cards.",
      artifacts,
    });
    const repairs = repairStaticWebsiteArtifactsTargeted({
      artifacts,
      issues: validation.issues,
    });

    expect(validation.status).toBe("needs_model_review");
    expect(validation.issues.join("\n")).toContain("document metadata");
    expect(validation.issues.join("\n")).toContain("visible CTA");
    expect(validation.issues.join("\n")).toContain("premium visual depth");
    expect(repairs.map((repair) => repair.fileName).sort()).toEqual([
      "src/karo-demo-site/index.html",
      "src/karo-demo-site/styles.css",
    ]);
    expect(repairs.find((repair) => repair.fileName.endsWith("index.html"))?.content).toContain("<title>Minecraft JJK Mod</title>");
    expect(repairs.find((repair) => repair.fileName.endsWith("index.html"))?.content).toContain("cta-button");
    expect(repairs.find((repair) => repair.fileName.endsWith("styles.css"))?.content).toContain("box-shadow");
  });

  it("finalizer notes stay honest about staged state and fallback", () => {
    const notes = buildAgentFinalizerNotes({
      status: "completed",
      changedFiles: ["src/karo-demo-site/index.html"],
      fallbackUsed: false,
      modelCallsUsed: 5,
      contextProfile: "website_creation",
    });

    expect(notes.join("\n")).toContain("Apply Changes is still required");
    expect(notes.join("\n")).toContain("Fallback used: no");
    expect(notes.join("\n")).toContain("Model calls used: 5");
  });

  it("normalizes free-form plan text into a typed internal plan", () => {
    const plan = normalizeStructuredPlan(
      [
        "Goal: improve the Karo composer",
        "- Assumptions: keep runtime stable",
        "- File areas: workbench.ts, main.css",
        "- Steps: inspect, patch, test",
        "- Risks: layout regression",
        "- Tests: gui:check",
      ].join("\n"),
    );

    expect(plan.goal).toContain("Goal");
    expect(plan.fileAreas.join(" ")).toContain("workbench.ts");
    expect(plan.risks.join(" ")).toContain("layout");
    expect(plan.tests.join(" ")).toContain("gui:check");
    expect(plan.suggestedExecutionMode).toBe("plan");
  });
});
