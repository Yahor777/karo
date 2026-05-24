/**
 * Unit tests for the Custom Agents editor controller and its DOM mount
 * helper (task 6.4).
 *
 * Coverage:
 *
 *   • Happy path: list refresh, save (upsert) → success, delete → success.
 *   • Name conflict path:
 *       — backend throws a `CustomAgentNameConflictError` with
 *         `conflictWith === "builtin"` → controller exposes
 *         `failed/name_conflict_builtin` and the message references "reserved"
 *         / built-in (Requirement 12.3).
 *       — backend throws with `conflictWith === "custom"` → controller exposes
 *         `failed/name_conflict_custom` and the message references "already"
 *         / "custom".
 *   • Client-side validation: empty `systemPrompt` is rejected before any
 *     backend call (Requirement 12.2).
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest";

import {
  createCustomAgentsController,
  mountCustomAgentsScreen,
  type CustomAgentsGateway,
} from "./customAgents.js";
import type {
  CustomAgentInputShape,
  CustomAgentShape,
  Scope,
} from "../../ports/settings.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class StubCustomAgentsGateway implements CustomAgentsGateway {
  public listCalls = 0;
  public upsertCalls: Array<{ scope: Scope; input: CustomAgentInputShape }> = [];
  public deleteCalls: Array<{ scope: Scope; agentId: string }> = [];

  public listResult: CustomAgentShape[] = [];
  public upsertError: unknown = null;
  public upsertResultBuilder:
    | ((scope: Scope, input: CustomAgentInputShape) => CustomAgentShape)
    | null = null;

  async listCustomAgents(_scope: Scope): Promise<readonly CustomAgentShape[]> {
    this.listCalls += 1;
    return [...this.listResult];
  }

  async upsertCustomAgent(
    scope: Scope,
    input: CustomAgentInputShape,
  ): Promise<CustomAgentShape> {
    this.upsertCalls.push({ scope, input });
    if (this.upsertError) throw this.upsertError as Error;
    if (this.upsertResultBuilder) return this.upsertResultBuilder(scope, input);
    return {
      id: `agent-${this.upsertCalls.length}`,
      kind: "custom",
      name: input.name,
      systemPrompt: input.systemPrompt,
      allowedTools: [...input.allowedTools],
      ownerScope: scope,
    };
  }

  async removeCustomAgent(scope: Scope, agentId: string): Promise<void> {
    this.deleteCalls.push({ scope, agentId });
  }
}

/**
 * Reconstructs the structural shape thrown by
 * `apps/backend/src/settings/customAgents.ts → CustomAgentNameConflictError`.
 * We don't import the backend class directly so the controller's
 * structural-guard handling is the thing under test.
 */
function buildConflictError(name: string, conflictWith: "builtin" | "custom"): Error {
  const err = new Error(
    `Custom_Agent name "${name}" conflicts with an existing ${conflictWith} agent in this scope`,
  );
  err.name = "CustomAgentNameConflictError";
  (err as unknown as { conflictWith: "builtin" | "custom" }).conflictWith = conflictWith;
  return err;
}

const SCOPE: Scope = { kind: "local", deviceId: "device-1" };

function buildAgent(overrides: Partial<CustomAgentShape> = {}): CustomAgentShape {
  return {
    id: "agent-1",
    kind: "custom",
    name: "summarizer",
    systemPrompt: "Summarize input text.",
    allowedTools: [],
    ownerScope: SCOPE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Controller — happy path
// ---------------------------------------------------------------------------

describe("createCustomAgentsController — happy path", () => {
  it(
    "lists custom agents (Validates: Requirements 12.4)",
    async () => {
      const gateway = new StubCustomAgentsGateway();
      gateway.listResult = [buildAgent({ id: "a", name: "alpha" })];

      const controller = createCustomAgentsController({ scope: SCOPE, gateway });
      await controller.refresh();

      const state = controller.getState();
      expect(state.list.status).toBe("loaded");
      if (state.list.status === "loaded") {
        expect(state.list.entries.map((e) => e.name)).toEqual(["alpha"]);
      }
    },
  );

  it(
    "saves a valid agent and refreshes (Validates: Requirements 12.1, 12.4)",
    async () => {
      const gateway = new StubCustomAgentsGateway();
      const controller = createCustomAgentsController({ scope: SCOPE, gateway });

      // Post-save listing reflects the new agent.
      gateway.listResult = [
        buildAgent({ id: "agent-1", name: "summarizer" }),
      ];

      const result = await controller.saveCustomAgent({
        name: "summarizer",
        systemPrompt: "Summarize input text.",
        allowedTools: ["web_search"],
      });

      expect(result.status).toBe("success");
      expect(gateway.upsertCalls).toHaveLength(1);
      expect(gateway.upsertCalls[0]?.input.name).toBe("summarizer");
      expect(gateway.listCalls).toBe(1);
    },
  );

  it(
    "rejects empty systemPrompt client-side (Validates: Requirements 12.2)",
    async () => {
      const gateway = new StubCustomAgentsGateway();
      const controller = createCustomAgentsController({ scope: SCOPE, gateway });

      const result = await controller.saveCustomAgent({
        name: "summarizer",
        systemPrompt: "   ",
        allowedTools: [],
      });

      expect(result).toMatchObject({
        status: "failed",
        reason: "empty_system_prompt",
      });
      expect(gateway.upsertCalls).toEqual([]);
    },
  );

  it(
    "rejects empty name client-side (Validates: Requirements 12.1)",
    async () => {
      const gateway = new StubCustomAgentsGateway();
      const controller = createCustomAgentsController({ scope: SCOPE, gateway });

      const result = await controller.saveCustomAgent({
        name: "   ",
        systemPrompt: "Do the thing.",
        allowedTools: [],
      });

      expect(result).toMatchObject({ status: "failed", reason: "empty_name" });
      expect(gateway.upsertCalls).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Controller — name conflict path (Requirement 12.3)
// ---------------------------------------------------------------------------

describe("createCustomAgentsController — name conflict feedback", () => {
  it(
    "surfaces builtin-name conflict with a builtin-specific message " +
      "(Validates: Requirements 12.3)",
    async () => {
      const gateway = new StubCustomAgentsGateway();
      gateway.upsertError = buildConflictError("Researcher", "builtin");
      const controller = createCustomAgentsController({ scope: SCOPE, gateway });

      const result = await controller.saveCustomAgent({
        name: "Researcher",
        systemPrompt: "Investigate things.",
        allowedTools: [],
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.reason).toBe("name_conflict_builtin");
      expect(result.message.toLowerCase()).toContain("built-in");
      // Sanity: not the custom-conflict message.
      expect(result.message.toLowerCase()).not.toContain("another custom");
    },
  );

  it(
    "surfaces custom-name conflict with a custom-specific message " +
      "(Validates: Requirements 12.3)",
    async () => {
      const gateway = new StubCustomAgentsGateway();
      gateway.upsertError = buildConflictError("summarizer", "custom");
      const controller = createCustomAgentsController({ scope: SCOPE, gateway });

      const result = await controller.saveCustomAgent({
        name: "summarizer",
        systemPrompt: "Summarize text.",
        allowedTools: [],
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.reason).toBe("name_conflict_custom");
      expect(result.message.toLowerCase()).toContain("another custom");
      expect(result.message.toLowerCase()).not.toContain("built-in");
    },
  );

  it(
    "treats other errors as transport failures rather than name conflicts",
    async () => {
      const gateway = new StubCustomAgentsGateway();
      gateway.upsertError = new Error("network down");
      const controller = createCustomAgentsController({ scope: SCOPE, gateway });

      const result = await controller.saveCustomAgent({
        name: "summarizer",
        systemPrompt: "Summarize text.",
        allowedTools: [],
      });

      expect(result).toMatchObject({ status: "failed", reason: "transport" });
    },
  );
});

// ---------------------------------------------------------------------------
// Controller — delete success path
// ---------------------------------------------------------------------------

describe("createCustomAgentsController — successful delete", () => {
  it(
    "ends in delete:'success' with no error message",
    async () => {
      const gateway = new StubCustomAgentsGateway();
      gateway.listResult = [buildAgent({ id: "a", name: "alpha" })];
      const controller = createCustomAgentsController({ scope: SCOPE, gateway });
      await controller.refresh();

      gateway.listResult = [];
      const result = await controller.deleteCustomAgent("a");
      expect(result.status).toBe("success");

      const state = controller.getState();
      expect(state.delete.status).toBe("success");
      if (state.delete.status === "success") {
        expect(state.delete).not.toHaveProperty("message");
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Mount helper — name conflict rendering (jsdom)
// ---------------------------------------------------------------------------

describe("mountCustomAgentsScreen — name conflict rendering", () => {
  it(
    "renders a builtin-conflict message in the form status region",
    async () => {
      const gateway = new StubCustomAgentsGateway();
      gateway.upsertError = buildConflictError("Reviewer", "builtin");
      const controller = createCustomAgentsController({ scope: SCOPE, gateway });

      const root = document.createElement("div");
      document.body.append(root);
      const dispose = mountCustomAgentsScreen({ root, controller });

      await controller.saveCustomAgent({
        name: "Reviewer",
        systemPrompt: "Review code.",
        allowedTools: [],
      });

      const status = root.querySelector(".custom-agents-form-status") as HTMLElement;
      expect(status).not.toBeNull();
      expect(status.textContent?.toLowerCase()).toContain("built-in");

      dispose();
      root.remove();
    },
  );
});
