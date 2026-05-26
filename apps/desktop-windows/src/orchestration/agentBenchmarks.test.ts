import { describe, expect, it } from "vitest";

import {
  canFallbackPassBenchmark,
  getAgentBenchmarkContract,
  listAgentBenchmarkContracts,
} from "./agentBenchmarks.js";

describe("Agent benchmark contracts", () => {
  it("defines the required MVP benchmark cases", () => {
    expect(listAgentBenchmarkContracts().map((contract) => contract.id)).toEqual([
      "quick_edit_create_file",
      "casual_chat",
      "conversation_memory",
      "plan_mode",
      "project_explanation_apply_changes",
      "security_review_code",
      "website_generation",
      "dangerous_command",
      "provider_timeout_recovery",
    ]);
  });

  it("does not allow fallback to pass the website benchmark", () => {
    const contract = getAgentBenchmarkContract("website_generation");

    expect(contract.allowsFallbackAsSuccess).toBe(false);
    expect(canFallbackPassBenchmark("website_generation")).toBe(false);
    expect(contract.passConditions.join("\n")).toContain("fallback-only result cannot pass");
  });

  it("keeps Quick Edit at zero model calls", () => {
    const contract = getAgentBenchmarkContract("quick_edit_create_file");

    expect(contract.mode).toBe("quick_edit");
    expect(contract.expectedMaxModelCalls).toBe(0);
    expect(contract.requiresProjectContext).toBe(false);
  });

  it("keeps casual Chat at one model call or less", () => {
    const contract = getAgentBenchmarkContract("casual_chat");

    expect(contract.mode).toBe("chat");
    expect(contract.expectedMaxModelCalls).toBeLessThanOrEqual(1);
    expect(contract.allowsArtifacts).toBe(false);
  });

  it("marks Plan Mode as read-only without artifacts", () => {
    const contract = getAgentBenchmarkContract("plan_mode");

    expect(contract.mode).toBe("plan");
    expect(contract.allowsArtifacts).toBe(false);
    expect(contract.allowsCommands).toBe(false);
  });

  it("marks Security Review as read-only without artifacts", () => {
    const contract = getAgentBenchmarkContract("security_review_code");

    expect(contract.mode).toBe("read_only_context");
    expect(contract.expectedContextProfile).toBe("security_review");
    expect(contract.allowsArtifacts).toBe(false);
  });

  it("blocks command execution for dangerous command benchmark", () => {
    const contract = getAgentBenchmarkContract("dangerous_command");

    expect(contract.mode).toBe("safety");
    expect(contract.allowsCommands).toBe(false);
    expect(contract.expectedMaxModelCalls).toBe(0);
  });

  it("requires artifacts for website benchmark while keeping fallback disqualified", () => {
    const contract = getAgentBenchmarkContract("website_generation");

    expect(contract.mode).toBe("agent");
    expect(contract.allowsArtifacts).toBe(true);
    expect(contract.expectedContextProfile).toBe("website_creation");
    expect(contract.allowsFallbackAsSuccess).toBe(false);
    expect(contract.passConditions.join("\n")).toContain("hero visual");
  });

  it("keeps provider timeout recovery as recovery rather than success", () => {
    const contract = getAgentBenchmarkContract("provider_timeout_recovery");

    expect(contract.mode).toBe("agent");
    expect(contract.allowsFallbackAsSuccess).toBe(false);
    expect(contract.passConditions.join("\n")).toContain("not completed");
  });
});
