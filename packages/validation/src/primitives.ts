/**
 * Shared primitive Zod schemas reused across higher-level domain schemas.
 *
 * Sources:
 * - design.md → "Data Models" → "Provider and Model", "Scope", "Agent",
 *   "Agent_Message".
 * - requirements.md → 10.1 (Task id field), 10.2 (taskId 1..128 chars),
 *   10.5 (ISO 8601 UTC ms timestamp).
 * - tasks.md task 2.2 sub-bullets: "taskId 1..128 chars", "ISO 8601 UTC ms
 *   timestamps".
 *
 * Keeping the atoms in one module avoids accidental drift between, e.g., the
 * `taskId` constraint enforced on Agent_Message and the one enforced on
 * File_Artifact: both must reuse `taskIdSchema` from here.
 */

import { z } from "zod";

/** Bounds for `taskId` per Requirement 10.2 / tasks.md task 2.2. */
export const TASK_ID_MIN_LENGTH = 1;
export const TASK_ID_MAX_LENGTH = 128;

/**
 * `TaskId` schema. Non-empty string from 1..128 characters.
 *
 * Requirement 10.2 explicitly states a non-empty string from 1 to 128
 * characters; we use `min`/`max` rather than a regex so error messages stay
 * specific to the failure mode.
 */
export const taskIdSchema = z
  .string()
  .min(TASK_ID_MIN_LENGTH, "taskId must be at least 1 character")
  .max(TASK_ID_MAX_LENGTH, "taskId must be at most 128 characters");

/**
 * `AgentId` schema. The shared-core type is `string`; we still require
 * non-empty strings here so generators producing zero-length agent ids are
 * rejected.
 */
export const agentIdSchema = z.string().min(1, "agentId must be non-empty");

/**
 * ISO 8601 UTC timestamp with millisecond precision: `YYYY-MM-DDThh:mm:ss.sssZ`.
 *
 * Two checks are layered:
 *  1. Regex shape — fast rejection for obviously malformed inputs.
 *  2. `Date.parse` — rejects inputs that match the shape but contain invalid
 *     calendar values (e.g. month 13, February 30).
 */
const ISO_8601_UTC_MS_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const isoTimestampSchema = z
  .string()
  .regex(
    ISO_8601_UTC_MS_REGEX,
    "timestamp must be ISO 8601 UTC with millisecond precision (YYYY-MM-DDThh:mm:ss.sssZ)",
  )
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: "timestamp must be a valid calendar date",
  });

/**
 * `ProviderId` is an open string union (`"openai" | "anthropic" | (string & {})`).
 * At runtime we can only enforce non-emptiness; specific provider whitelisting
 * happens in higher layers (Settings_Store, Model_Catalog).
 */
export const providerIdSchema = z.string().min(1, "provider must be non-empty");

/** Source of a model: from a user API key or a platform fallback. */
export const modelSourceSchema = z.enum(["user-api-key", "platform-fallback"]);

/**
 * `ModelRef` schema — see design.md → "Provider and Model".
 * `source` distinguishes user-key models from explicitly configured platform
 * fallbacks (Requirement 5.5).
 */
export const modelRefSchema = z.object({
  provider: providerIdSchema,
  modelId: z.string().min(1, "modelId must be non-empty"),
  source: modelSourceSchema,
});

/** `ToolId` schema mirroring the union in shared-core/types/agent. */
export const toolIdSchema = z.enum([
  "web_search",
  "file_read",
  "file_write",
  "artifact_diff",
]);

/**
 * `Scope` schema. Discriminated union on `kind`. Local scope carries a
 * deviceId; cloud scope carries a userId. See design.md → "Data Models" → "Scope".
 */
export const localScopeSchema = z.object({
  kind: z.literal("local"),
  deviceId: z.string().min(1, "deviceId must be non-empty"),
});

export const cloudScopeSchema = z.object({
  kind: z.literal("cloud"),
  userId: z.string().min(1, "userId must be non-empty"),
});

export const scopeSchema = z.discriminatedUnion("kind", [
  localScopeSchema,
  cloudScopeSchema,
]);
