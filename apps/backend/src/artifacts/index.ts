/**
 * Public surface of the backend Artifact Store module.
 *
 * Tasks 10.1 + 10.2 ship the full `ArtifactStore` read/write surface:
 *
 *   • {@link ArtifactStore}                       — `writeArtifact`,
 *     `getArtifact`, `listArtifacts`, `getDiff`.
 *   • {@link InMemoryArtifactStoreBackend}        — pluggable storage backend
 *     for tests and early bring-up; production swaps in encrypted SQLite or
 *     a cloud-backed store.
 *   • {@link computeContentHash}                  — SHA-256 hex digest helper
 *     reused by Final_Report (task 15.2) and any future migration tooling.
 *   • {@link computeUnifiedDiff}                  — pure unified-diff helper
 *     used by `getDiff` and available to Final_Report tooling.
 *   • {@link ArtifactStoreBackend} / {@link WriteArtifactInput} /
 *     {@link GetArtifactInput} / {@link GetDiffInput} /
 *     {@link ArtifactRecord} / {@link FileArtifactVersion} (and friends) —
 *     public types and ports.
 *
 * Validates: Requirements 7.4, 7.7, 11.4, 11.5, 11.7.
 */

export { ArtifactStore } from "./artifactStore.js";
export type {
  ArtifactStoreOptions,
  Clock,
} from "./artifactStore.js";

export {
  InMemoryArtifactStoreBackend,
  buildArtifactKey,
} from "./inMemoryStore.js";

export { computeContentHash } from "./contentHash.js";

export type {
  ArtifactRecord,
  ArtifactStore as ArtifactStoreInterface,
  ArtifactStoreBackend,
  DiffPatch,
  FileArtifact,
  FileArtifactContent,
  FileArtifactMetadata,
  FileArtifactVersion,
  GetArtifactInput,
  GetDiffInput,
  WriteArtifactInput,
} from "./types.js";

export { computeUnifiedDiff } from "./unifiedDiff.js";
export type { UnifiedDiffOptions } from "./unifiedDiff.js";

export { StagingWorkspaceManager } from "./staging.js";

