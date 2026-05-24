import { describe, expect, it } from "vitest";

import {
  estimateAgentCoreExecution,
  normalizeStructuredPlan,
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
    expect(estimate.allowsArtifacts).toBe(false);
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
    expect(estimate.stages.map((stage) => stage.id)).toContain("context_analyst");
    expect(estimate.stages.map((stage) => stage.id)).toContain("finalizer");
  });

  it("estimates website generation as chunked coding with deterministic validation before reviewer", () => {
    const estimate = estimateAgentCoreExecution({
      prompt: "Create a landing page website with hero, abilities, characters, energy, features, FAQ, responsive cards.",
      decision: decision({ intent: "create_file", executionMode: "agent", allowFileChanges: true, expectedOutput: "artifacts" }),
      quickEditAvailable: false,
    });

    expect(estimate.mode).toBe("agent");
    expect(estimate.expectedModelCalls).toBe(5);
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

  it("validates complete static website artifacts without model review", () => {
    const result = validateStagedArtifactsDeterministically({
      prompt: "Create a landing page website with hero, abilities, characters, energy, features, FAQ, responsive cards.",
      artifacts: [
        {
          fileName: "src/karo-demo-site/index.html",
          content:
            '<main><section class="hero">Hero</section><section class="abilities">Abilities</section><section class="energy">Characters and energy</section><section class="features">Features</section><section class="faq">FAQ</section></main>',
        },
        { fileName: "src/karo-demo-site/styles.css", content: "body{background:#07070b}.card{} @media (min-width: 800px){.grid{display:grid}}" },
        { fileName: "src/karo-demo-site/script.js", content: "document.documentElement.dataset.ready='true';" },
        { fileName: "src/karo-demo-site/README.md", content: "Apply Changes first, then open index.html in preview." },
      ],
    });

    expect(result.status).toBe("passed");
    expect(result.skipModelReview).toBe(true);
    expect(result.issues).toHaveLength(0);
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
