/**
 * Artifact-viewer port shapes for shared-ui screens (task 10.3).
 *
 * `shared-ui` cannot depend on `apps/backend/...` directly — that would
 * couple the UI package to backend internals. The artifact viewer
 * controller therefore depends on the *shapes* defined here. Composition
 * adapters in the renderer (and stubs in tests) wire the concrete
 * `ArtifactStore` (or its Client SDK proxy) into objects matching these
 * interfaces.
 *
 * The shapes mirror, verbatim, the public contracts already documented
 * in:
 *
 *   • design.md → "Artifact Store" → "Interface" (`getArtifact`,
 *     `listArtifacts`, `getDiff`).
 *   • design.md → "Data Models" → "File_Artifact"
 *     (`FileArtifactMetadata`, `FileArtifactContent`, `DiffPatch`).
 *   • requirements.md → 11.4, 11.5, 11.7.
 *
 * This file deliberately only re-states the static contract. It does NOT
 * pull from `@ai-agent-orchestrator/validation` (which is a runtime Zod
 * schema package); shared-ui consumers only need static types, and
 * lifting the runtime dependency keeps the bundle smaller — same
 * convention as `./settings.ts`.
 *
 * Critical invariant (Requirement 11.5 / Property 11): the artifact
 * viewer MUST NOT auto-open a diff in response to selection or any
 * other UI event. Diffs are produced only via `ArtifactGateway.getDiff`
 * and the controller calls `getDiff` only from `requestDiff(...)`.
 * Encoding that invariant in the gateway port keeps the constraint
 * explicit at the seam between UI and backend.
 */

import type { TaskId } from "@ai-agent-orchestrator/shared-core";

export type { TaskId } from "@ai-agent-orchestrator/shared-core";

/**
 * UI-safe metadata view of a stored artifact.
 *
 * Mirrors `apps/backend/src/artifacts/types.ts` → `FileArtifactMetadata`
 * (which is itself re-exported from `@ai-agent-orchestrator/validation`).
 * MUST NOT grow a `bytes` field — listing must never return raw artifact
 * contents (design.md → "Artifact Store" rules).
 */
export interface FileArtifactMetadata {
  readonly id: string;
  readonly taskId: TaskId;
  readonly fileName: string;
  readonly latestVersion: number;
  readonly latestContentHash: string;
  readonly updatedAt: string;
}

/**
 * Single-version content view of an artifact.
 *
 * Mirrors `FileArtifactContent` from the validation package. `bytes` is
 * a `Uint8Array` (matches the in-memory representation used by the
 * Artifact Store and by the network transport once the SDK lands).
 */
export interface FileArtifactContent {
  readonly id: string;
  readonly taskId: TaskId;
  readonly fileName: string;
  readonly version: number;
  readonly bytes: Uint8Array;
  readonly contentHash: string;
}

/**
 * Unified-diff result between two explicit versions of an artifact.
 *
 * Mirrors `DiffPatch` from the validation package. The controller
 * surfaces `patchText` verbatim — formatting / colourisation is the
 * mount helper's job.
 */
export interface DiffPatch {
  readonly artifactId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly patchText: string;
}

/**
 * Narrow gateway port the artifact viewer controller depends on.
 *
 * In production this is wired (through the Client SDK) to the backend
 * `ArtifactStore` defined in `apps/backend/src/artifacts/artifactStore.ts`.
 * In tests it's stubbed.
 *
 * Behaviour rules:
 *
 *   • `listArtifacts` returns metadata only — no `bytes` payloads
 *     (Requirement 11.7). The shape of `FileArtifactMetadata` enforces
 *     this at the type level.
 *   • `getArtifact` returns the requested version's content; `null`
 *     when the artifact or version does not exist.
 *   • `getDiff` returns a `DiffPatch` between two explicit versions;
 *     `null` when either version is missing. The caller (controller)
 *     MUST invoke `getDiff` only in response to an explicit user
 *     gesture (Requirement 11.5: diff is never displayed automatically).
 *     `listArtifacts` and `getArtifact` MUST NOT trigger a diff
 *     computation as a side effect — neither in the gateway nor in the
 *     controller built on top of it. Property 11 in
 *     `apps/backend/src/artifacts/diffNoAuto.property.test.ts` polices
 *     this on the backend side; the controller's unit tests in this
 *     package police it on the UI side.
 */
export interface ArtifactGateway {
  listArtifacts(taskId: TaskId): Promise<readonly FileArtifactMetadata[]>;
  getArtifact(input: {
    readonly taskId: TaskId;
    readonly artifactId: string;
    readonly version?: number;
  }): Promise<FileArtifactContent | null>;
  getDiff(input: {
    readonly taskId: TaskId;
    readonly artifactId: string;
    readonly fromVersion: number;
    readonly toVersion: number;
  }): Promise<DiffPatch | null>;
}
