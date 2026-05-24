/**
 * `Custom_Agent` schemas (input + persisted record).
 *
 * Sources:
 * - design.md → "Data Models" → "Agent" (CustomAgent, CustomAgentInput).
 * - requirements.md →
 *     12.1 (mandatory fields: name, system prompt, Model selection, allowed
 *           tools),
 *     12.2 (non-empty system prompt, name uniqueness within user scope),
 *     12.4 (edits/deletes apply to the user's current scope).
 * - tasks.md task 2.2 sub-bullets: name non-empty, systemPrompt non-empty,
 *   modelRef, allowedTools.
 *
 * Name-uniqueness vs Builtin_Agent and other Custom_Agent records (Requirement
 * 12.3) is enforced by the Settings_Store (task 6.2) at write time, since it
 * requires lookup against the user's stored agents. The schema only enforces
 * structural rules.
 *
 * `model` is optional because Requirement 6.4 of the Orchestrator says the
 * Task's selected Model is used by default for any agent that does not
 * specify one. Per design.md, Custom_Agent inherits `AgentDefinition` which
 * has `model?: ModelRef`.
 */

import { z } from "zod";

import { modelRefSchema, scopeSchema, toolIdSchema } from "./primitives";

/**
 * Non-empty system prompt schema. Requirement 12.2 explicitly states the
 * system prompt must be non-empty; we require non-empty after trim to reject
 * whitespace-only prompts that would otherwise have zero useful content.
 */
export const systemPromptSchema = z
  .string()
  .refine((v) => v.trim().length > 0, {
    message: "systemPrompt must be non-empty after trim",
  });

/**
 * Non-empty agent name schema. Trim-non-empty for the same reason as
 * `systemPromptSchema` — whitespace-only names cannot satisfy the uniqueness
 * intent of Requirement 12.3 in any meaningful way.
 */
export const customAgentNameSchema = z
  .string()
  .refine((v) => v.trim().length > 0, {
    message: "name must be non-empty after trim",
  });

/**
 * `CustomAgentInput` — payload accepted by `Settings_Store.upsertCustomAgent`.
 *
 * `allowedTools` is required and may be empty: a user may legitimately create
 * a Custom_Agent that only relies on the model with no tool access (e.g., a
 * pure summarization agent). The orchestrator enforces per-tool access at
 * runtime; the schema only enforces shape.
 */
export const customAgentInputSchema = z.object({
  name: customAgentNameSchema,
  systemPrompt: systemPromptSchema,
  model: modelRefSchema.optional(),
  allowedTools: z.array(toolIdSchema),
});

/**
 * `CustomAgent` — persisted record returned by the Settings_Store.
 *
 * Adds the assigned `id`, the discriminating `kind: "custom"`, and the
 * `ownerScope` (matches design.md → "Data Models" → "Agent" → CustomAgent).
 */
export const customAgentSchema = z.object({
  id: z.string().min(1, "agent id must be non-empty"),
  kind: z.literal("custom"),
  name: customAgentNameSchema,
  systemPrompt: systemPromptSchema,
  model: modelRefSchema.optional(),
  allowedTools: z.array(toolIdSchema),
  ownerScope: scopeSchema,
});

export type CustomAgentInput = z.infer<typeof customAgentInputSchema>;
export type CustomAgent = z.infer<typeof customAgentSchema>;
