/**
 * `Final_Report` schema.
 *
 * Sources:
 * - design.md → "Data Models" → "Final_Report".
 * - requirements.md →
 *     8.6 (stopped_limit Final_Report when review-cycle limit exhausted),
 *     8.7 (completed Final_Report on Boss approval),
 *     14.2 (Final_Report carries: original prompt, final artifacts, Boss
 *           summary, participants list, review cycles performed),
 *     14.4 (status "не завершено" → mapped to `stopped_limit` with outstanding
 *           issues),
 *     14.5 (Final_Report persisted for later viewing).
 * - tasks.md task 2.2: Final_Report schema.
 *
 * Status mapping:
 *  - `"completed"`     → Boss approved (Requirement 8.7).
 *  - `"stopped_limit"` → review cycles exhausted without approval
 *    (Requirement 8.6 / 14.4). The Russian phrasing "не завершено" in 14.4
 *    maps to this code; outstanding issues are listed in `outstandingIssues`.
 *
 * `bossSummary` is optional because a Final_Report may be produced without a
 * Boss summary in `stopped_limit` outcomes (no successful Boss verdict).
 */

import { z } from "zod";

import {
  agentIdSchema,
  isoTimestampSchema,
  taskIdSchema,
} from "./primitives";
import { FILE_ARTIFACT_MIN_VERSION } from "./file-artifact";
import { promptSchema } from "./task";

export const finalReportStatusSchema = z.enum(["completed", "stopped_limit"]);

/** Reference to a specific version of a `File_Artifact`. */
export const fileArtifactRefSchema = z.object({
  artifactId: z.string().min(1, "artifactId must be non-empty"),
  version: z
    .number()
    .int("version must be an integer")
    .min(
      FILE_ARTIFACT_MIN_VERSION,
      `version must be >= ${FILE_ARTIFACT_MIN_VERSION}`,
    ),
  fileName: z.string().min(1, "fileName must be non-empty"),
});

/**
 * `Final_Report` schema.
 *
 * Requirement 14.2 lists the mandatory fields. We additionally require:
 *  - `originalPrompt` to satisfy the same non-empty-after-trim rule as the
 *    original Task input (it is just the Task's prompt copied for archival).
 *  - `participants` to be non-empty: a Task that produced a Final_Report
 *    must have had at least one participating agent.
 *  - `reviewCyclesPerformed >= 0` and integer.
 */
export const finalReportSchema = z.object({
  taskId: taskIdSchema,
  status: finalReportStatusSchema,
  originalPrompt: promptSchema,
  finalArtifacts: z.array(fileArtifactRefSchema),
  bossSummary: z.string().optional(),
  outstandingIssues: z.array(z.string()).optional(),
  participants: z
    .array(agentIdSchema)
    .min(1, "Final_Report must list at least one participating agent"),
  reviewCyclesPerformed: z
    .number()
    .int("reviewCyclesPerformed must be an integer")
    .min(0, "reviewCyclesPerformed must be >= 0"),
  createdAt: isoTimestampSchema,
});

export type FinalReportStatus = z.infer<typeof finalReportStatusSchema>;
export type FileArtifactRef = z.infer<typeof fileArtifactRefSchema>;
export type FinalReport = z.infer<typeof finalReportSchema>;
