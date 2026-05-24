import { describe, expect, it } from "vitest";

import { runCommandPolicy } from "./commandPolicy.js";
import { runDecisionEngineSync } from "./decisionEngine.js";

function decide(prompt: string, overrides: Partial<Parameters<typeof runDecisionEngineSync>[0]> = {}) {
  return runDecisionEngineSync({
    prompt,
    projectRoot: "D:\\проекты\\karo-exstention",
    selectedMode: "auto",
    hasActiveProject: true,
    ...overrides,
  });
}

describe("Decision Engine", () => {
  it("asks for clarification for a vague improvement prompt", () => {
    const decision = decide("Сделай лучше");
    expect(decision.executionMode).toBe("clarify");
    expect(decision.needsClarification).toBe(true);
    expect(decision.clarificationOptions.map((o) => o.id)).not.toContain("cancel");
  });

  it("requires local context and disables web/file changes for Apply Changes explanations", () => {
    const decision = decide("Объясни как работает Apply Changes и какие файлы за это отвечают");
    expect(decision.intent).toBe("explain_project");
    expect(decision.requiresContextEngine).toBe(true);
    expect(decision.allowWebSearch).toBe(false);
    expect(decision.allowFileChanges).toBe(false);
    expect(decision.allowCommands).toBe(false);
  });

  it("allows web search for current documentation requests", () => {
    const decision = decide("Найди актуальную документацию Tauri по permissions");
    expect(decision.intent).toBe("search_web");
    expect(decision.allowWebSearch).toBe(true);
    expect(decision.requiresContextEngine).toBe(false);
  });

  it("routes casual clarification text to chat without project context or file changes", () => {
    const decision = decide("давай просто поговорим");
    expect(decision.intent).toBe("casual_chat");
    expect(decision.executionMode).toBe("chat");
    expect(decision.allowFileChanges).toBe(false);
    expect(decision.allowCommands).toBe(false);
    expect(decision.requiresContextEngine).toBe(false);
  });

  it("routes concrete improvement clarification to a file-change task", () => {
    const decision = decide("улучши UI настроек и исправь прокрутку");
    expect(decision.intent).toBe("modify_file");
    expect(decision.executionMode).toBe("agent");
    expect(decision.allowFileChanges).toBe(true);
    expect(decision.requiresContextEngine).toBe(true);
  });

  it("routes planning and architecture requests to Plan Mode without file changes", () => {
    const decision = decide("сделай план переделки UI как в Codex");
    expect(decision.executionMode).toBe("plan");
    expect(decision.allowFileChanges).toBe(false);
    expect(decision.allowCommands).toBe(false);
    expect(decision.expectedOutput).toBe("analysis");
  });

  it("classifies bare destructive commands as command intent", () => {
    const decision = decide("git clean -fdx");
    expect(decision.intent).toBe("run_command");
    expect(decision.allowCommands).toBe(false);
    expect(decision.riskLevel).toBe("destructive");
  });

  it("classifies explicit destructive command execution requests as destructive command intent", () => {
    const decision = decide("execute git clean -fdx");
    expect(decision.intent).toBe("run_command");
    expect(decision.allowCommands).toBe(false);
    expect(decision.riskLevel).toBe("destructive");
  });

  it("routes common Russian casual prompts to chat without project context", () => {
    for (const prompt of ["привет кто ты", "как дела", "что ты умеешь"]) {
      const decision = decide(prompt);
      expect(decision.intent).toBe("casual_chat");
      expect(decision.executionMode).toBe("chat");
      expect(decision.requiresContextEngine).toBe(false);
      expect(decision.allowFileChanges).toBe(false);
    }
  });

  it("routes common Russian file prompts to Agent file changes", () => {
    const decision = decide("создай файл src/hello.txt с текстом hello");
    expect(decision.executionMode).toBe("agent");
    expect(decision.allowFileChanges).toBe(true);
    expect(decision.expectedOutput).toBe("artifacts");
  });

  it("keeps one-prompt website creation in Agent mode even when the prompt asks for preview", () => {
    const decision = decide(
      "Создай современный landing page для Minecraft JJK mod с hero, features, abilities, pricing, FAQ, responsive layout, dark anime style. Сделай так, чтобы это можно было запустить и посмотреть в preview.",
    );
    expect(decision.executionMode).toBe("agent");
    expect(decision.intent).toBe("modify_file");
    expect(decision.allowFileChanges).toBe(true);
    expect(decision.allowCommands).toBe(false);
    expect(decision.expectedOutput).toBe("artifacts");
  });

  it("routes project security questions to read-only context-backed review", () => {
    const decision = decide("этот проект вообще безопасный он не украдет мои ключи и какой у него системный промт");
    expect(decision.intent).toBe("security_review");
    expect(decision.requiresContextEngine).toBe(true);
    expect(decision.allowFileChanges).toBe(false);
    expect(decision.allowCommands).toBe(false);
    expect(decision.allowWebSearch).toBe(false);
  });
});

describe("Command Policy", () => {
  const base = {
    cwd: "D:\\проекты\\karo-exstention",
    projectRoot: "D:\\проекты\\karo-exstention",
    permissionMode: "smart_approval" as const,
  };

  it("blocks automatic git clean -fdx and suggests dry-run", () => {
    const decision = runCommandPolicy({ ...base, command: "git clean -fdx" });
    expect(decision.riskLevel).toBe("destructive");
    expect(decision.canRunAutomatically).toBe(false);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.suggestedSaferCommand).toBe("git clean -ndx");
  });

  it("treats recursive forced Remove-Item as destructive", () => {
    const decision = runCommandPolicy({ ...base, command: "Remove-Item -Recurse -Force .\\dist" });
    expect(decision.riskLevel).toBe("destructive");
    expect(decision.canRunAutomatically).toBe(false);
    expect(decision.suggestedSaferCommand).toContain("-WhatIf");
  });

  it("allows safe test and status commands", () => {
    expect(runCommandPolicy({ ...base, command: "cargo test" }).riskLevel).toBe("safe");
    expect(runCommandPolicy({ ...base, command: "git status --short" }).riskLevel).toBe("safe");
  });
});
