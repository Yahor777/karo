/**
 * Builtin_Agent permission enforcement tests (task 14.6).
 *
 * Coverage required by the task brief:
 *
 *   • Each Builtin_Agent role exposes only the tools listed in
 *     design.md → "Agent Runtime" → "Builtin agent permissions":
 *
 *         Researcher : web_search
 *         Coder      : web_search, file_read, file_write
 *         Reviewer   : web_search, file_read, artifact_diff
 *         Fixer      : web_search, file_read, file_write, artifact_diff
 *         Boss       : file_read, artifact_diff
 *
 *   • Custom_Agent equivalence with Builtin_Agent in terms of access to
 *     Web_Search_Tool, Agent_Message and Agent_Trace surfaces — i.e. a
 *     Custom_Agent advertising the same tools is treated identically by
 *     the Settings_Store + Custom_Agent schema and ends up alongside
 *     the Builtin_Agents in `listAgents` (Requirement 12.6).
 *
 * Validates: Requirements 7.1, 12.6.
 *
 * Sources:
 *   - design.md → "Agent Runtime" → "Builtin agent permissions"
 *     (canonical permission map per role).
 *   - design.md → "Data Models" → "Agent" (`BuiltinAgentRole`,
 *     `ToolId`, `Custom_Agent` shape).
 *   - apps/backend/src/settings/customAgents.ts → `BUILTIN_AGENTS`
 *     registry that callers (Orchestrator, Agent Runtime) read off.
 *   - apps/backend/src/agents/boss.ts → `BOSS_ALLOWED_TOOLS`, the
 *     constant `boss.ts` exposes for downstream consumers.
 *
 * The test deliberately pins the registry values rather than asserting
 * via the tools constant in any single agent module: the Builtin_Agent
 * registry in `customAgents.ts` is the single source of truth for the
 * `allowedTools` table, so a regression that drifts any role's tools
 * away from the design must fail here loudly. The Boss-specific
 * cross-check confirms `BOSS_ALLOWED_TOOLS` (used by the Boss agent
 * itself) and the registry stay in lockstep.
 */

import { describe, expect, it } from "vitest";

import type {
  BuiltinAgentRole,
  ToolId,
} from "@ai-agent-orchestrator/shared-core";
import {
  customAgentInputSchema,
  customAgentSchema,
} from "@ai-agent-orchestrator/validation";

import {
  BUILTIN_AGENTS,
  BUILTIN_AGENT_NAMES,
  createCustomAgentService,
  InMemoryCustomAgentStore,
} from "../settings/customAgents.js";
import { BOSS_ALLOWED_TOOLS } from "./boss.js";

// ---------------------------------------------------------------------------
// Expected permission map (design.md → "Agent Runtime" →
// "Builtin agent permissions").
// ---------------------------------------------------------------------------

/**
 * Order matters here only as a consistency anchor against the design
 * document; the assertions below compare as sorted sets so a future
 * registry refactor that reorders the array does not break the test.
 */
const EXPECTED_BUILTIN_TOOLS: Record<BuiltinAgentRole, readonly ToolId[]> = {
  researcher: ["web_search"],
  coder: ["web_search", "file_read", "file_write"],
  reviewer: ["web_search", "file_read", "artifact_diff"],
  fixer: ["web_search", "file_read", "file_write", "artifact_diff"],
  boss: ["file_read", "artifact_diff"],
};

function sortedTools(tools: readonly ToolId[]): ToolId[] {
  return [...tools].sort();
}

// ---------------------------------------------------------------------------
// Builtin agent permission assertions
// ---------------------------------------------------------------------------

describe("Builtin_Agent permission enforcement (task 14.6)", () => {
  it("exposes exactly the five Builtin_Agent roles (Validates: Requirement 7.1)", () => {
    const registryRoles = BUILTIN_AGENTS.map((a) => a.role).sort();
    const expectedRoles = [...BUILTIN_AGENT_NAMES].sort();
    expect(registryRoles).toEqual(expectedRoles);
    expect(registryRoles).toEqual(
      ["boss", "coder", "fixer", "researcher", "reviewer"].sort(),
    );
  });

  for (const role of BUILTIN_AGENT_NAMES) {
    it(
      `pins ${role} permissions to the design's Builtin agent permissions table ` +
        "(Validates: Requirement 7.1)",
      () => {
        const entry = BUILTIN_AGENTS.find((a) => a.role === role);
        expect(entry, `missing builtin entry for role ${role}`).toBeDefined();
        expect(sortedTools(entry!.allowedTools)).toEqual(
          sortedTools(EXPECTED_BUILTIN_TOOLS[role]),
        );
      },
    );
  }

  it("does not advertise unexpected tool ids on any builtin role", () => {
    const knownToolIds: readonly ToolId[] = [
      "web_search",
      "file_read",
      "file_write",
      "artifact_diff",
    ];
    for (const entry of BUILTIN_AGENTS) {
      for (const tool of entry.allowedTools) {
        expect(knownToolIds).toContain(tool);
      }
    }
  });

  it(
    "Boss agent BOSS_ALLOWED_TOOLS matches the registry entry " +
      "(Validates: Requirement 7.1)",
    () => {
      const registryBoss = BUILTIN_AGENTS.find((a) => a.role === "boss");
      expect(registryBoss).toBeDefined();
      expect(sortedTools(registryBoss!.allowedTools)).toEqual(
        sortedTools(BOSS_ALLOWED_TOOLS),
      );
      // Defence-in-depth: pin the constant itself so a Boss-only refactor
      // cannot quietly grow tools (e.g. file_write) that the design does
      // not allow.
      expect(sortedTools(BOSS_ALLOWED_TOOLS)).toEqual(
        sortedTools(EXPECTED_BUILTIN_TOOLS.boss),
      );
    },
  );

  it(
    "Researcher and Boss never carry write/diff or web-search permissions " +
      "they are not entitled to (Validates: Requirement 7.1)",
    () => {
      const researcher = BUILTIN_AGENTS.find((a) => a.role === "researcher")!;
      expect(researcher.allowedTools).not.toContain("file_read");
      expect(researcher.allowedTools).not.toContain("file_write");
      expect(researcher.allowedTools).not.toContain("artifact_diff");

      const boss = BUILTIN_AGENTS.find((a) => a.role === "boss")!;
      expect(boss.allowedTools).not.toContain("web_search");
      expect(boss.allowedTools).not.toContain("file_write");
    },
  );
});

// ---------------------------------------------------------------------------
// Custom_Agent equivalence assertions (Requirement 12.6)
// ---------------------------------------------------------------------------

describe(
  "Custom_Agent equivalence with Builtin_Agent for tool/message/trace access " +
    "(Validates: Requirement 12.6)",
  () => {
    it("Custom_Agent input schema accepts any combination of the same ToolIds builtins use", () => {
      // The four ToolIds available to Builtin_Agents (web_search, file_read,
      // file_write, artifact_diff) must all be valid on a Custom_Agent
      // input. This pins the contract that Custom_Agent and Builtin_Agent
      // share a single tool universe — the Orchestrator can therefore
      // grant tool access to a Custom_Agent identically to a Builtin_Agent.
      for (const tools of [
        ["web_search"],
        ["web_search", "file_read", "file_write"],
        ["web_search", "file_read", "artifact_diff"],
        ["web_search", "file_read", "file_write", "artifact_diff"],
        ["file_read", "artifact_diff"],
        [], // Custom_Agent may legitimately request no tools.
      ] as const) {
        const result = customAgentInputSchema.safeParse({
          name: "Custom-Helper",
          systemPrompt: "Help the user.",
          allowedTools: tools,
        });
        expect(result.success, `expected ${JSON.stringify(tools)} to parse`).toBe(true);
      }
    });

    it(
      "a Custom_Agent advertising web_search produces a record indistinguishable from " +
        "a Builtin_Agent in terms of allowedTools shape",
      async () => {
        const service = createCustomAgentService(new InMemoryCustomAgentStore());
        const scope = { kind: "local", deviceId: "device-permissions" } as const;

        const created = await service.upsertCustomAgent(scope, {
          name: "Search-Helper",
          systemPrompt: "Look things up using the Web_Search_Tool.",
          allowedTools: ["web_search"],
        });

        // The schema on the persisted record validates — i.e. the
        // Custom_Agent record carries the same ToolId universe a
        // Builtin_Agent does.
        const parsed = customAgentSchema.safeParse(created);
        expect(parsed.success).toBe(true);
        expect(created.allowedTools).toEqual(["web_search"]);

        // listAgents returns the Builtin_Agents alongside the Custom_Agent;
        // both shapes carry `allowedTools: ToolId[]`. The Orchestrator
        // (Requirement 12.6) treats them uniformly when granting access
        // to Web_Search_Tool / Agent_Message / Agent_Trace surfaces.
        const all = await service.listAgents(scope);
        expect(all.builtin.length).toBe(BUILTIN_AGENTS.length);
        expect(all.custom).toHaveLength(1);
        expect(all.custom[0]!.allowedTools).toEqual(["web_search"]);
      },
    );

    it(
      "a Custom_Agent may mirror any Builtin_Agent's exact allowedTools set " +
        "without schema or service rejecting it (tool-level equivalence)",
      async () => {
        const service = createCustomAgentService(new InMemoryCustomAgentStore());
        const scope = { kind: "local", deviceId: "device-mirror" } as const;

        // Mirror Coder's tools onto a non-conflicting Custom_Agent name.
        // Requirement 12.3 forbids using a Builtin_Agent name; the tool
        // set itself is not reserved (Requirement 12.6: Custom_Agent is
        // treated equally for tool access).
        const coder = BUILTIN_AGENTS.find((a) => a.role === "coder")!;
        const created = await service.upsertCustomAgent(scope, {
          name: "Coder-Like-Helper",
          systemPrompt: "Behaves like a coder but is user-defined.",
          allowedTools: [...coder.allowedTools],
        });

        expect(sortedTools(created.allowedTools)).toEqual(
          sortedTools(coder.allowedTools),
        );
      },
    );
  },
);
