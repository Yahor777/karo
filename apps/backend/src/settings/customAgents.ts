/**
 * Custom_Agent CRUD with name-uniqueness validation (task 6.2).
 *
 * Sources:
 * - requirements.md → Requirement 12 (Custom_Agent rules):
 *     12.1 Required fields: name, system prompt, Model, allowed tools.
 *     12.2 Settings_Store validates name uniqueness within user scope and
 *           non-empty system prompt.
 *     12.3 Conflicts with Builtin_Agent or another Custom_Agent name → reject
 *           with conflict message.
 *     12.4 Edits/deletes apply to the user's current scope.
 * - design.md → "Settings Store" → `SettingsStore` interface (subset:
 *     upsertCustomAgent / removeCustomAgent / listAgents) and
 *     "Data Models" → "Agent" (BuiltinAgent / CustomAgent shapes).
 * - tasks.md task 6.2 sub-bullets.
 *
 * This module deliberately ships a pluggable `CustomAgentStore` interface plus
 * an in-memory implementation. The in-memory store is the default backend for
 * tests; encrypted-local and cloud-backed adapters land in tasks 3.x and 17.x
 * respectively.
 *
 * Coordination with task 6.1 (`apiKeys.ts`): both modules belong to the same
 * `settings/` directory and conceptually share a Settings_Store boundary, but
 * their persistence concerns are independent (API keys carry secrets requiring
 * `resolveApiKeySecret` gating; Custom_Agent records are plain settings). They
 * therefore expose separate stores rather than a single mega-interface.
 */

import { randomUUID } from "node:crypto";

import type { BuiltinAgentRole, Scope, ToolId } from "@ai-agent-orchestrator/shared-core";
import {
  customAgentInputSchema,
  type CustomAgent,
  type CustomAgentInput,
} from "@ai-agent-orchestrator/validation";

// ---------------------------------------------------------------------------
// Builtin agent registry
// ---------------------------------------------------------------------------

/**
 * Local `BuiltinAgent` shape that mirrors design.md → "Data Models" → "Agent".
 *
 * The full type lives only in design.md right now; shared-core exposes the
 * `BuiltinAgentRole` and `ToolId` atoms (task 2.1) but not the composite
 * record. We re-declare the structural shape here so this task is
 * self-contained and the registry below can be consumed by other modules
 * later (Agent Runtime in task 14.x will extend / replace these stubs with
 * real system prompts).
 */
export interface BuiltinAgent {
  id: string;
  kind: "builtin";
  role: BuiltinAgentRole;
  name: string;
  systemPrompt: string;
  allowedTools: ToolId[];
}

/**
 * Reserved Builtin_Agent names that Custom_Agent names must never collide
 * with (Requirement 12.3). Source of truth for the case-insensitive
 * comparison performed in `upsertCustomAgent`.
 */
export const BUILTIN_AGENT_NAMES: readonly BuiltinAgentRole[] = [
  "researcher",
  "coder",
  "reviewer",
  "fixer",
  "boss",
] as const;

/**
 * Builtin agent registry. `systemPrompt` is intentionally an empty string
 * placeholder — the real prompts arrive with the Agent Runtime work in task
 * 14.x. Permissions match design.md → "Agent Runtime" → "Builtin agent
 * permissions" so callers (Orchestrator, Agent Runtime) can read off the
 * `allowedTools` table from this single source.
 */
export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [
  {
    id: "researcher",
    kind: "builtin",
    role: "researcher",
    name: "researcher",
    systemPrompt: "",
    allowedTools: ["web_search"],
  },
  {
    id: "coder",
    kind: "builtin",
    role: "coder",
    name: "coder",
    systemPrompt: "",
    allowedTools: ["web_search", "file_read", "file_write"],
  },
  {
    id: "reviewer",
    kind: "builtin",
    role: "reviewer",
    name: "reviewer",
    systemPrompt: "",
    allowedTools: ["web_search", "file_read", "artifact_diff"],
  },
  {
    id: "fixer",
    kind: "builtin",
    role: "fixer",
    name: "fixer",
    systemPrompt: "",
    allowedTools: ["web_search", "file_read", "file_write", "artifact_diff"],
  },
  {
    id: "boss",
    kind: "builtin",
    role: "boss",
    name: "boss",
    systemPrompt: "",
    allowedTools: ["file_read", "artifact_diff"],
  },
] as const;

const BUILTIN_NAME_SET: ReadonlySet<string> = new Set(
  BUILTIN_AGENT_NAMES.map((n) => n.toLowerCase()),
);

// ---------------------------------------------------------------------------
// Pluggable storage backend
// ---------------------------------------------------------------------------

/**
 * Storage backend abstraction for `Custom_Agent` records.
 *
 * The service layer (`createCustomAgentService`) owns name-uniqueness
 * validation and id assignment; the store only persists. This split keeps
 * encrypted-local / cloud adapters trivial — they just have to map
 * `(Scope, agentId)` → `CustomAgent`.
 */
export interface CustomAgentStore {
  /** Return all `Custom_Agent` records for a scope (no defensive copy required). */
  list(scope: Scope): Promise<CustomAgent[]>;
  /** Insert or replace a `Custom_Agent` record by `agent.id` within `agent.ownerScope`. */
  put(agent: CustomAgent): Promise<void>;
  /** Delete by id. Returns `true` if a record was removed, `false` if it did not exist. */
  remove(scope: Scope, agentId: string): Promise<boolean>;
}

/**
 * In-memory `CustomAgentStore` for tests and for the default development
 * backend. Records are deep-cloned on read/write to prevent callers from
 * mutating the internal map.
 */
export class InMemoryCustomAgentStore implements CustomAgentStore {
  // Keyed by scope (`local:deviceId` / `cloud:userId`); inner map keyed by id.
  private readonly buckets = new Map<string, Map<string, CustomAgent>>();

  list(scope: Scope): Promise<CustomAgent[]> {
    return Promise.resolve(Array.from(this.bucket(scope).values()).map(cloneAgent));
  }

  put(agent: CustomAgent): Promise<void> {
    this.bucket(agent.ownerScope).set(agent.id, cloneAgent(agent));
    return Promise.resolve();
  }

  remove(scope: Scope, agentId: string): Promise<boolean> {
    return Promise.resolve(this.bucket(scope).delete(agentId));
  }

  private bucket(scope: Scope): Map<string, CustomAgent> {
    const key = scopeKey(scope);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(key, bucket);
    }
    return bucket;
  }
}

function scopeKey(scope: Scope): string {
  return scope.kind === "local"
    ? `local:${scope.deviceId}`
    : `cloud:${scope.userId}`;
}

function cloneAgent(agent: CustomAgent): CustomAgent {
  return JSON.parse(JSON.stringify(agent)) as CustomAgent;
}

// ---------------------------------------------------------------------------
// Service errors
// ---------------------------------------------------------------------------

/**
 * Thrown when `upsertCustomAgent` rejects a write because the proposed
 * `Custom_Agent` name collides with a Builtin_Agent name or with another
 * Custom_Agent in the same scope (Requirement 12.3).
 *
 * Carrying `conflictWith` lets the UI render a more specific message
 * ("conflicts with builtin agent" vs. "another custom agent") without
 * having to re-scan the registry.
 */
export class CustomAgentNameConflictError extends Error {
  readonly conflictWith: "builtin" | "custom";

  constructor(name: string, conflictWith: "builtin" | "custom") {
    super(
      `Custom_Agent name "${name}" conflicts with an existing ${conflictWith} agent in this scope`,
    );
    this.name = "CustomAgentNameConflictError";
    this.conflictWith = conflictWith;
  }
}

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

/**
 * Public surface implemented by the Custom_Agent slice of the Settings_Store
 * (subset of the `SettingsStore` interface in design.md → "Settings Store").
 */
export interface CustomAgentService {
  upsertCustomAgent(scope: Scope, input: CustomAgentInput): Promise<CustomAgent>;
  removeCustomAgent(scope: Scope, agentId: string): Promise<void>;
  listCustomAgents(scope: Scope): Promise<CustomAgent[]>;
  listAgents(scope: Scope): Promise<{
    builtin: BuiltinAgent[];
    custom: CustomAgent[];
  }>;
}

/**
 * Options for `createCustomAgentService`.
 *
 * `generateId` is injectable to make ids deterministic in tests and to allow
 * the storage adapter to assign provider-specific ids (e.g., a SQL primary
 * key) if it wishes. Defaults to `crypto.randomUUID()`.
 */
export interface CreateCustomAgentServiceOptions {
  generateId?: () => string;
}

/**
 * Build a `CustomAgentService` over a pluggable `CustomAgentStore`.
 *
 * Behavior summary (Requirement 12):
 * - `upsertCustomAgent` validates input via `customAgentInputSchema` (12.1,
 *    12.2 non-empty fields), rejects builtin-name collisions (12.3), and
 *    treats a same-name custom record in the same scope as the upsert target
 *    (preserving its id) — collision rejection is reserved for *other*
 *    Custom_Agent records, matching the "no conflict with self" reading of
 *    12.3 ("conflicts with another custom agent").
 * - `removeCustomAgent` is a no-op when the id does not exist (matches the
 *    shape of `removeApiKey` in 6.1; deletion success path is symmetrical).
 * - `listCustomAgents` / `listAgents` return scope-local results only (12.4).
 */
export function createCustomAgentService(
  store: CustomAgentStore,
  options: CreateCustomAgentServiceOptions = {},
): CustomAgentService {
  const generateId = options.generateId ?? (() => randomUUID());

  return {
    async upsertCustomAgent(scope, rawInput) {
      // Structural validation: name non-empty after trim, systemPrompt
      // non-empty after trim, allowedTools is a (possibly empty) array of
      // valid ToolId values, optional model has provider/modelId/source.
      // Schema errors propagate as ZodError to the caller.
      const input = customAgentInputSchema.parse(rawInput);

      const normalized = normalizeName(input.name);

      // Builtin name collision (Requirement 12.3).
      if (BUILTIN_NAME_SET.has(normalized)) {
        throw new CustomAgentNameConflictError(input.name, "builtin");
      }

      // Look for an existing Custom_Agent with this name (case-insensitive)
      // in the current scope. If found, treat the upsert as an update of
      // that record (preserve id). Otherwise create a fresh id. This is
      // what allows "upsert" semantics without a separate `updateCustomAgent`
      // operation, while still rejecting collisions with *other* records.
      const existing = await store.list(scope);
      const sameName = existing.find(
        (a) => normalizeName(a.name) === normalized,
      );

      const id = sameName?.id ?? generateId();
      const record: CustomAgent = {
        id,
        kind: "custom",
        name: input.name,
        systemPrompt: input.systemPrompt,
        // exactOptionalPropertyTypes: only attach `model` when present.
        ...(input.model !== undefined ? { model: input.model } : {}),
        allowedTools: input.allowedTools,
        ownerScope: scope,
      };

      await store.put(record);
      return record;
    },

    async removeCustomAgent(scope, agentId) {
      await store.remove(scope, agentId);
    },

    async listCustomAgents(scope) {
      return store.list(scope);
    },

    async listAgents(scope) {
      const custom = await store.list(scope);
      return {
        builtin: BUILTIN_AGENTS.map(cloneBuiltin),
        custom,
      };
    },
  };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function cloneBuiltin(b: BuiltinAgent): BuiltinAgent {
  return { ...b, allowedTools: [...b.allowedTools] };
}
