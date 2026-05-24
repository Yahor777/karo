/**
 * `Task` and `CreateTaskInput` schemas.
 *
 * Sources:
 * - design.md → "Data Models" → "Task" (CreateTaskInput, TaskState, invariants).
 * - design.md → "Orchestrator Core" → "Validation rules".
 * - requirements.md →
 *     6.4 (empty prompt rejected),
 *     6.5 (launch button disabled while prompt empty — backend still validates),
 *     6.6 (Manual_Mode requires at least one agent),
 *     7.1 (five Builtin_Agent roles exist),
 *     8.5 (default maxReviewCycles = 5),
 *     14.1 (Boss can approve only after at least one Review_Cycle).
 * - tasks.md task 2.2 sub-bullets: "non-empty prompt after trim",
 *   "maxReviewCycles >= 1", "Manual_Mode requires participants".
 *
 * Note on `participants`:
 * Auto_Mode does not require the user to supply participants — the Orchestrator
 * derives them at runtime (Requirement 6.3). Therefore validation here only
 * enforces the Manual_Mode constraint. Auto_Mode is allowed to omit
 * `participants` or supply an empty array; the orchestrator's runtime check
 * (task 8.2) will reject an Auto_Mode run that produces an empty agent set.
 */

import { z } from "zod";

import {
  agentIdSchema,
  isoTimestampSchema,
  modelRefSchema,
  scopeSchema,
  taskIdSchema,
} from "./primitives";

/**
 * Default review-cycle limit per design.md → "Pipeline rules" and
 * Requirement 8.5.
 */
export const DEFAULT_MAX_REVIEW_CYCLES = 5;

/** Task mode: orchestrator-chosen agents vs user-chosen agents. */
export const taskModeSchema = z.enum(["auto", "manual"]);

/** Task lifecycle status; states drive the Pipeline state machine (task 9.1). */
export const taskStatusSchema = z.enum([
  "created",
  "researching",
  "coding",
  "reviewing",
  "fixing",
  "boss_eval",
  "completed",
  "stopped_limit",
  "error",
  "waiting_consent",
]);

/**
 * Trimmed-non-empty prompt schema.
 *
 * Requirement 6.4 explicitly says an empty prompt cannot create a Task and
 * tasks.md task 2.2 spells out "non-empty prompt after trim". We use a
 * `refine` rather than `z.string().trim().min(1)` so that the validated value
 * keeps the user's original whitespace (the orchestrator may still want to
 * preserve significant trailing newlines inside the prompt body).
 */
export const promptSchema = z
  .string()
  .refine((v) => v.trim().length > 0, {
    message: "prompt must be non-empty after trim",
  });

/**
 * `maxReviewCycles` schema. Must be an integer ≥ 1.
 * Requirement 8.5 gives a default of 5, but any value ≥ 1 is permitted to
 * support tightening or relaxing the limit per Task.
 */
export const maxReviewCyclesSchema = z
  .number()
  .int("maxReviewCycles must be an integer")
  .min(1, "maxReviewCycles must be >= 1");

/**
 * `CreateTaskInput` schema.
 *
 * The Manual_Mode → ≥1 participant rule is encoded as a `superRefine` so the
 * error path points at `participants` (better UX than a discriminated union
 * here, because Auto_Mode is permitted to omit the field entirely).
 */
export const createTaskInputSchema = z
  .object({
    prompt: promptSchema,
    modelRef: modelRefSchema,
    mode: taskModeSchema,
    participants: z.array(agentIdSchema).optional(),
    maxReviewCycles: maxReviewCyclesSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.mode === "manual") {
      const count = input.participants?.length ?? 0;
      if (count < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["participants"],
          message: "Manual_Mode requires at least one participant agent",
        });
      }
    }
  });

/**
 * `TaskState` schema. Invariants from design.md → "Data Models" → "Task":
 *   - `0 <= reviewCycles <= maxReviewCycles`
 *   - `maxReviewCycles >= 1`
 */
export const taskStateSchema = z
  .object({
    id: taskIdSchema,
    ownerScope: scopeSchema,
    status: taskStatusSchema,
    currentAgentId: agentIdSchema.optional(),
    reviewCycles: z
      .number()
      .int("reviewCycles must be an integer")
      .min(0, "reviewCycles must be >= 0"),
    maxReviewCycles: maxReviewCyclesSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .superRefine((state, ctx) => {
    if (state.reviewCycles > state.maxReviewCycles) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewCycles"],
        message: "reviewCycles must not exceed maxReviewCycles",
      });
    }
  });

export type TaskMode = z.infer<typeof taskModeSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
