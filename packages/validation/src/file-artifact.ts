/**
 * `File_Artifact` schemas.
 *
 * Sources:
 * - design.md → "Data Models" → "File_Artifact" (FileArtifact, FileArtifactVersion,
 *   FileArtifactMetadata, FileArtifactContent, DiffPatch).
 * - design.md → "Artifact Store" → "Rules" (versions append-only, start at 1,
 *   same content hash is a no-op).
 * - requirements.md →
 *     7.4 (Coder produces single File_Artifact atomically),
 *     7.7 (Fixer returns updated File_Artifact atomically),
 *     11.7 (full Agent_Trace and File_Artifact preserved for completed tasks).
 * - tasks.md task 2.2 sub-bullets: ISO 8601 UTC ms timestamps.
 *
 * Note on `version`:
 * The design states version numbers start at 1 and are append-only; we enforce
 * `version >= 1` as a static rule. Strict monotonic ordering across the
 * `versions` array is checked by the Artifact Store at write time (task 10.1)
 * — the schema only enforces it on a per-element basis.
 *
 * `bytes` is a `Uint8Array` to keep parity with the in-memory representation
 * used by the Artifact Store. Validation at the network boundary (e.g.
 * SSE/JSON encoded) will need a separate schema variant.
 */

import { z } from "zod";

import {
  agentIdSchema,
  isoTimestampSchema,
  taskIdSchema,
} from "./primitives";

/** Minimum version number per design.md → "Artifact Store" → "Rules". */
export const FILE_ARTIFACT_MIN_VERSION = 1;

/** A single artifact version. */
export const fileArtifactVersionSchema = z.object({
  version: z
    .number()
    .int("version must be an integer")
    .min(
      FILE_ARTIFACT_MIN_VERSION,
      `version must be >= ${FILE_ARTIFACT_MIN_VERSION}`,
    ),
  authoredByAgentId: agentIdSchema,
  contentHash: z.string().min(1, "contentHash must be non-empty"),
  bytes: z.instanceof(Uint8Array),
  createdAt: isoTimestampSchema,
});

/** Aggregate `File_Artifact` (artifact + all versions). */
export const fileArtifactSchema = z.object({
  id: z.string().min(1, "artifact id must be non-empty"),
  taskId: taskIdSchema,
  fileName: z.string().min(1, "fileName must be non-empty"),
  mimeType: z.string().min(1, "mimeType must be non-empty").optional(),
  versions: z.array(fileArtifactVersionSchema),
});

/** Lightweight metadata listing entry (for `ArtifactStore.listArtifacts`). */
export const fileArtifactMetadataSchema = z.object({
  id: z.string().min(1, "artifact id must be non-empty"),
  taskId: taskIdSchema,
  fileName: z.string().min(1, "fileName must be non-empty"),
  latestVersion: z
    .number()
    .int("latestVersion must be an integer")
    .min(
      FILE_ARTIFACT_MIN_VERSION,
      `latestVersion must be >= ${FILE_ARTIFACT_MIN_VERSION}`,
    ),
  latestContentHash: z.string().min(1, "latestContentHash must be non-empty"),
  updatedAt: isoTimestampSchema,
});

/** Single-version content view (for `ArtifactStore.getArtifact`). */
export const fileArtifactContentSchema = z.object({
  id: z.string().min(1, "artifact id must be non-empty"),
  taskId: taskIdSchema,
  fileName: z.string().min(1, "fileName must be non-empty"),
  version: z
    .number()
    .int("version must be an integer")
    .min(
      FILE_ARTIFACT_MIN_VERSION,
      `version must be >= ${FILE_ARTIFACT_MIN_VERSION}`,
    ),
  bytes: z.instanceof(Uint8Array),
  contentHash: z.string().min(1, "contentHash must be non-empty"),
});

/** Diff between two versions (for `ArtifactStore.getDiff`). */
export const diffPatchSchema = z
  .object({
    artifactId: z.string().min(1, "artifactId must be non-empty"),
    fromVersion: z
      .number()
      .int("fromVersion must be an integer")
      .min(
        FILE_ARTIFACT_MIN_VERSION,
        `fromVersion must be >= ${FILE_ARTIFACT_MIN_VERSION}`,
      ),
    toVersion: z
      .number()
      .int("toVersion must be an integer")
      .min(
        FILE_ARTIFACT_MIN_VERSION,
        `toVersion must be >= ${FILE_ARTIFACT_MIN_VERSION}`,
      ),
    patchText: z.string(),
  })
  .superRefine((diff, ctx) => {
    if (diff.fromVersion === diff.toVersion) {
      ctx.addIssue({
        code: "custom",
        path: ["toVersion"],
        message: "fromVersion and toVersion must differ",
      });
    }
  });

export type FileArtifactVersion = z.infer<typeof fileArtifactVersionSchema>;
export type FileArtifact = z.infer<typeof fileArtifactSchema>;
export type FileArtifactMetadata = z.infer<typeof fileArtifactMetadataSchema>;
export type FileArtifactContent = z.infer<typeof fileArtifactContentSchema>;
export type DiffPatch = z.infer<typeof diffPatchSchema>;
