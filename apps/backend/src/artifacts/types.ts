/**
 * Artifact Store types (task 10.1).
 *
 * Sources:
 * - design.md → "Artifact Store" → "Interface" (`ArtifactStore.writeArtifact`).
 * - design.md → "Artifact Store" → "Rules" (versions append-only, start at 1,
 *   same `contentHash` is a no-op).
 * - design.md → "Data Models" → "File_Artifact" (`FileArtifact` /
 *   `FileArtifactVersion` / `FileArtifactMetadata` / `FileArtifactContent` /
 *   `DiffPatch`).
 * - requirements.md → 7.4 (Coder produces single File_Artifact atomically),
 *   7.7 (Fixer returns updated File_Artifact atomically),
 *   11.7 (full Agent_Trace and File_Artifact preserved for completed tasks).
 *
 * The public types (`FileArtifact`, `FileArtifactVersion`, ...) come straight
 * from the validation package — re-exported here so other backend modules can
 * write `import { FileArtifactVersion } from "../artifacts"` without reaching
 * across packages.
 *
 * The internal `ArtifactRecord` shape is what the storage backend sees: the
 * full `FileArtifact` (id / taskId / fileName / mimeType / versions) plus an
 * `updatedAt` timestamp used by `listArtifacts` (task 10.2). Keeping it
 * internal lets task 10.2 layer metadata projection without changing the
 * backend port.
 *
 * Subsequent tasks (10.2 — `getArtifact` / `listArtifacts` / `getDiff`) extend
 * the `ArtifactStore` interface defined here without touching the
 * `writeArtifact` shape.
 */

import type { AgentId, TaskId } from "@ai-agent-orchestrator/shared-core";

// Re-export the canonical File_Artifact types from validation so callers have
// a single import surface for the artifact subsystem.
export type {
  DiffPatch,
  FileArtifact,
  FileArtifactContent,
  FileArtifactMetadata,
  FileArtifactVersion,
} from "@ai-agent-orchestrator/validation";

import type {
  DiffPatch,
  FileArtifact,
  FileArtifactContent,
  FileArtifactMetadata,
  FileArtifactVersion,
} from "@ai-agent-orchestrator/validation";

/**
 * Input for {@link ArtifactStore.writeArtifact}.
 *
 * Mirrors the design-doc signature 1:1.
 *
 *   • `artifactId` is optional. When omitted, the store generates a fresh
 *     UUID v4 (Requirement 7.4 mandates atomic creation; the Coder/Fixer
 *     callers do not have to know whether they are creating or extending).
 *   • `mimeType` is optional and may be left unset for binary blobs whose
 *     type the producer cannot determine; UI affordances for unknown types
 *     are handled in task 10.3.
 *   • `bytes` is a `Uint8Array` to keep parity with the in-memory shape used
 *     by the rest of the artifact pipeline. The store hashes it and stores a
 *     defensive copy so caller-side mutation cannot reach back into the
 *     persisted record.
 */
export interface WriteArtifactInput {
  readonly taskId: TaskId;
  readonly artifactId?: string;
  readonly authoredByAgentId: AgentId;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType?: string;
}

/**
 * Internal storage record held by {@link ArtifactStoreBackend}.
 *
 * Strict superset of `FileArtifact`:
 *
 *   • `updatedAt` mirrors the `createdAt` of the latest version. Task 10.2
 *     surfaces it in `FileArtifactMetadata.updatedAt`; the backend stores it
 *     so listing does not have to scan every version.
 */
export type ArtifactRecord = FileArtifact & {
  readonly updatedAt: string;
};

/**
 * Pluggable storage backend for `ArtifactRecord`s.
 *
 * The service layer (`ArtifactStore`) owns:
 *
 *   • content hashing,
 *   • idempotency (same `contentHash` is a no-op),
 *   • version assignment (append-only, starts at 1),
 *   • UUID generation when `artifactId` is omitted,
 *   • atomic write semantics for a single artifact.
 *
 * Backends only have to map `(TaskId, artifactId)` → `ArtifactRecord` and
 * persist updates as a whole record. This split keeps an encrypted-SQLite
 * adapter (later task) trivial — it just persists rows of `ArtifactRecord`
 * shape.
 *
 * Atomicity contract: `put` MUST replace the prior record at
 * `(taskId, record.id)` as a single observable step. Concurrent
 * `writeArtifact` calls for the same `(taskId, artifactId)` are serialised
 * by the service so the backend does not have to provide its own
 * transaction layer in task 10.1.
 */
export interface ArtifactStoreBackend {
  /** Returns the record at `(taskId, artifactId)` or `null` if absent. */
  get(taskId: TaskId, artifactId: string): Promise<ArtifactRecord | null>;
  /** Inserts or replaces the record at `(taskId, record.id)`. */
  put(taskId: TaskId, record: ArtifactRecord): Promise<void>;
  /** Returns every record stored under `taskId`. Order is implementation-defined. */
  list(taskId: TaskId): Promise<ArtifactRecord[]>;
}

/**
 * Input for {@link ArtifactStore.getArtifact}.
 *
 * `version` is optional. When omitted, the store returns the most recent
 * version recorded for `(taskId, artifactId)`. When specified, the store
 * returns that exact version or `null` if it does not exist — see the
 * design rule "Versions are append-only" plus "Diff generation happens
 * only on explicit request".
 */
export interface GetArtifactInput {
  readonly taskId: TaskId;
  readonly artifactId: string;
  readonly version?: number;
}

/**
 * Input for {@link ArtifactStore.getDiff}.
 *
 * Both versions must already exist for the artifact. Validation lives in
 * the service layer; this type only carries data.
 */
export interface GetDiffInput {
  readonly taskId: TaskId;
  readonly artifactId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

/**
 * Public surface of the Artifact Store backend module.
 *
 * Task 10.1 implemented `writeArtifact`; task 10.2 adds the read paths:
 *
 *   • {@link getArtifact}   — single-version content view.
 *   • {@link listArtifacts} — metadata-only listing for a task.
 *   • {@link getDiff}       — textual diff between two explicit versions
 *                             (Requirement 11.4 / 11.5).
 */
export interface ArtifactStore {
  writeArtifact(input: WriteArtifactInput): Promise<FileArtifactVersion>;
  getArtifact(input: GetArtifactInput): Promise<FileArtifactContent | null>;
  listArtifacts(taskId: TaskId): Promise<FileArtifactMetadata[]>;
  getDiff(input: GetDiffInput): Promise<DiffPatch | null>;
}
