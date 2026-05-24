/**
 * `ArtifactStore` (tasks 10.1 + 10.2).
 *
 * Implements design.md → "Artifact Store" → "Interface":
 *
 *   • `writeArtifact` (task 10.1) — append-only versioning with content
 *     hashing and idempotency.
 *   • `getArtifact` (task 10.2) — single-version content view.
 *   • `listArtifacts` (task 10.2) — metadata-only listing for a task.
 *   • `getDiff` (task 10.2) — unified diff between two explicit versions
 *     (Requirements 11.4 / 11.5: diff is generated only on explicit
 *     request between two versions; never auto-triggered by other paths).
 *
 * Behaviour summary (design.md → "Artifact Store" → "Rules"):
 *
 *   • Versions are append-only.
 *   • Version numbers start at 1.
 *   • If the latest version for an artifact already has the same
 *     `contentHash` as the bytes being written, the call is a no-op:
 *     the stored record is unchanged and the existing version is
 *     returned. This is what makes Coder/Fixer retries idempotent
 *     (Property 6 in task 10.4).
 *   • Writes are atomic from the caller's perspective: either the new
 *     version is fully appended or no changes are persisted. Within a
 *     single `ArtifactStore` instance we serialise concurrent calls
 *     for the same `(taskId, artifactId)` so backends do not have to
 *     provide their own transaction layer.
 *   • `listArtifacts` returns metadata only — never the byte payloads.
 *   • `getDiff` is a pure derivation from two existing versions and is
 *     only called by paths that explicitly want a diff. The Trace UI
 *     (task 11.3) and File Artifact viewer (task 10.3) MUST NOT call
 *     this method except in response to an explicit user gesture.
 *
 * Out of scope here:
 *
 *   • Trace-bus events on artifact change — task 11.x wires those.
 *   • Final_Report references — task 15.2 builds them on top of this store.
 *
 * Validates: Requirements 7.4, 7.7, 11.4, 11.5, 11.7.
 */

import { randomUUID } from "node:crypto";

import type { AgentId, TaskId } from "@ai-agent-orchestrator/shared-core";
import type {
  DiffPatch,
  FileArtifactContent,
  FileArtifactMetadata,
  FileArtifactVersion,
} from "@ai-agent-orchestrator/validation";

import { computeContentHash } from "./contentHash.js";
import { StagingWorkspaceManager } from "./staging.js";
import type {
  ArtifactRecord,
  ArtifactStore as ArtifactStoreInterface,
  ArtifactStoreBackend,
  GetArtifactInput,
  GetDiffInput,
  WriteArtifactInput,
} from "./types.js";
import { computeUnifiedDiff, type UnifiedDiffOptions } from "./unifiedDiff.js";

/** Optional clock dependency, primarily for deterministic tests. */
export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

/**
 * Signature of the unified-diff helper consumed by `getDiff`.
 *
 * Mirrors {@link computeUnifiedDiff} exactly so the default and any
 * injected implementation are interchangeable. The seam exists for two
 * reasons:
 *
 *   • Property 11 in design.md ("diff is never displayed automatically",
 *     task 10.5) asserts the negative invariant that no `ArtifactStore`
 *     path other than `getDiff` triggers diff computation. Tests inject
 *     a spy through this option and then exercise every other API
 *     surface to confirm the spy stays at zero invocations.
 *   • Future backends (e.g. an encrypted-SQLite store that wants to
 *     pre-compute or memoise diffs) can swap in a custom implementation
 *     without subclassing the store.
 *
 * Production callers MUST NOT inject a custom function — leave the
 * option unset and the system-default {@link computeUnifiedDiff} runs.
 */
export type ComputeUnifiedDiffFn = (
  oldText: string,
  newText: string,
  options?: UnifiedDiffOptions,
) => string;

/**
 * Constructor options for {@link ArtifactStore}.
 *
 * `backend` is required; `clock`, `generateArtifactId` and `computeDiff`
 * are injectable to make timestamps, ids and diff computation
 * deterministic / observable in tests. The defaults are the system
 * clock, `crypto.randomUUID()`, and the in-process
 * {@link computeUnifiedDiff} helper respectively.
 */
export interface ArtifactStoreOptions {
  readonly backend: ArtifactStoreBackend;
  readonly clock?: Clock;
  readonly generateArtifactId?: () => string;
  readonly computeDiff?: ComputeUnifiedDiffFn;
  readonly staging?: StagingWorkspaceManager;
}

/**
 * Implements `ArtifactStore.writeArtifact`.
 *
 * The class is deliberately small — it owns no transport or framework
 * concerns. The Orchestrator wraps it behind agent-runtime calls
 * (Coder / Fixer atomic artifact production, Requirements 7.4 / 7.7).
 */
export class ArtifactStore implements ArtifactStoreInterface {
  private readonly backend: ArtifactStoreBackend;
  private readonly clock: Clock;
  private readonly generateArtifactId: () => string;
  private readonly staging?: StagingWorkspaceManager;
  /**
   * Diff helper used exclusively by {@link getDiff}. Injected via
   * {@link ArtifactStoreOptions.computeDiff} for tests that need to
   * observe whether other API paths trigger diff computation; defaults
   * to the in-process {@link computeUnifiedDiff} helper otherwise.
   *
   * Property 11 (task 10.5) treats this seam as a structural assertion:
   * none of `writeArtifact`, `getArtifact`, `listArtifacts` may invoke
   * this function — only `getDiff` may.
   */
  private readonly computeDiff: ComputeUnifiedDiffFn;

  /**
   * Per-artifact serialisation queue. Concurrent `writeArtifact` calls
   * for the same `(taskId, artifactId)` are chained on one promise so
   * the read-modify-write sequence (`backend.get` → mutate → `backend.put`)
   * stays atomic without requiring a transactional backend. Different
   * artifacts proceed in parallel.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  public constructor(options: ArtifactStoreOptions) {
    this.backend = options.backend;
    this.clock = options.clock ?? systemClock;
    this.generateArtifactId =
      options.generateArtifactId ?? (() => randomUUID());
    this.computeDiff = options.computeDiff ?? computeUnifiedDiff;
    this.staging = options.staging;
  }

  /**
   * Writes a new version of `(taskId, artifactId)` and returns the
   * version that now represents the artifact's latest state.
   *
   * Inputs are validated up front (no empty file name, valid byte
   * payload). The artifact id is generated on the fly when the caller
   * does not supply one — Coder and Fixer use this to fold creation
   * and update into a single atomic call (Requirement 7.4 / 7.7).
   *
   * Idempotency rule: if the existing latest version for the artifact
   * has the same `contentHash` as the supplied bytes, the call returns
   * a clone of that version without touching the store. This keeps
   * "same artifact, same content" writes free of side effects, which
   * is what Property 6 in task 10.4 will check.
   */
  public async writeArtifact(
    input: WriteArtifactInput,
  ): Promise<FileArtifactVersion> {
    validateInput(input);

    const artifactId = input.artifactId ?? this.generateArtifactId();
    const queueKey = `${input.taskId}::${artifactId}`;

    // Serialise per-artifact reads/writes. Different artifacts proceed
    // in parallel; same-artifact callers are chained in arrival order.
    // The chain entry is a swallowed-error promise so a failure in one
    // call does not poison the chain for subsequent callers — each
    // caller still sees the real outcome via the returned `next` promise.
    const previous = this.inFlight.get(queueKey) ?? Promise.resolve();
    const next = previous.then(() => this.writeArtifactLocked(artifactId, input));
    const chainEntry = next.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set(queueKey, chainEntry);

    // Drop the chain entry when this call's link is the tail of the
    // queue. If a later caller has already chained on top of us, leave
    // the map alone so their cleanup can run.
    void chainEntry.then(() => {
      if (this.inFlight.get(queueKey) === chainEntry) {
        this.inFlight.delete(queueKey);
      }
    });

    return next;
  }

  /**
   * Performs the actual read-modify-write under the per-artifact lock
   * established by {@link writeArtifact}.
   */
  private async writeArtifactLocked(
    artifactId: string,
    input: WriteArtifactInput,
  ): Promise<FileArtifactVersion> {
    const contentHash = computeContentHash(input.bytes);
    const existing = await this.backend.get(input.taskId, artifactId);

    if (existing !== null) {
      const latest = existing.versions[existing.versions.length - 1];

      if (latest !== undefined && latest.contentHash === contentHash) {
        // Idempotent path: byte-identical retry from the same agent
        // (or any agent — Requirement 7.7 lets Fixer reissue an
        // unchanged artifact). Return a defensive clone of the
        // existing latest version so the caller cannot mutate stored
        // state through it.
        return cloneVersion(latest);
      }
    }

    const nowIso = this.clock.now().toISOString();
    const nextVersionNumber =
      existing === null
        ? 1
        : (existing.versions[existing.versions.length - 1]?.version ?? 0) + 1;

    const newVersion: FileArtifactVersion = {
      version: nextVersionNumber,
      authoredByAgentId: input.authoredByAgentId,
      contentHash,
      // Defensive copy: the caller still owns `input.bytes`. Storing a
      // copy means later mutation by the caller does not leak into the
      // persisted record.
      bytes: input.bytes.slice(),
      createdAt: nowIso,
    };

    const updatedRecord: ArtifactRecord = buildRecord(
      artifactId,
      input,
      existing,
      newVersion,
      nowIso,
    );

    await this.backend.put(input.taskId, updatedRecord);

    if (this.staging !== undefined) {
      await this.staging.writeArtifactFile(input.taskId, input.fileName, newVersion.bytes);
    }

    return cloneVersion(newVersion);
  }

  /**
   * Returns the requested version of `(taskId, artifactId)`.
   *
   * When `version` is omitted, the latest stored version is returned.
   * When `version` is supplied, the matching entry is returned or
   * `null` if it does not exist (e.g. a request for v3 of an artifact
   * that only has v1 and v2). Missing artifacts also resolve to
   * `null`. Callers MUST NOT treat `null` as an error condition; per
   * design.md → "Artifact Store" → "Rules" the read paths are pure
   * lookups.
   *
   * The returned `bytes` are a defensive copy — caller-side mutation
   * cannot reach into the persisted record. Validates: Requirement 11.7.
   */
  public async getArtifact(
    input: GetArtifactInput,
  ): Promise<FileArtifactContent | null> {
    assertNonEmptyString(input.taskId, "taskId");
    assertNonEmptyString(input.artifactId, "artifactId");

    if (input.version !== undefined) {
      assertPositiveInteger(input.version, "version");
    }

    const record = await this.backend.get(input.taskId, input.artifactId);
    if (record === null || record.versions.length === 0) {
      return null;
    }

    const target =
      input.version === undefined
        ? record.versions[record.versions.length - 1]
        : record.versions.find((v) => v.version === input.version);

    if (target === undefined) {
      return null;
    }

    return {
      id: record.id,
      taskId: record.taskId,
      fileName: record.fileName,
      version: target.version,
      // Defensive copy mirrors what `cloneVersion` does for the write
      // path — keeps the public API symmetric.
      bytes: target.bytes.slice(),
      contentHash: target.contentHash,
    };
  }

  /**
   * Returns metadata for every artifact stored under `taskId`.
   *
   * Metadata is the public-safe projection: `id`, `taskId`,
   * `fileName`, `latestVersion`, `latestContentHash`, `updatedAt`. The
   * byte payloads are deliberately omitted — listing must never return
   * raw artifact contents (design.md → "Artifact Store" rules + task
   * 10.2 brief). Callers that want bytes call `getArtifact`.
   *
   * Output is sorted by `updatedAt` ascending, with `id` as a stable
   * tiebreaker so listings are deterministic across backends.
   * Validates: Requirement 11.7.
   */
  public async listArtifacts(
    taskId: TaskId,
  ): Promise<FileArtifactMetadata[]> {
    assertNonEmptyString(taskId, "taskId");

    const records = await this.backend.list(taskId);
    const metadata: FileArtifactMetadata[] = [];
    for (const record of records) {
      const latest = record.versions[record.versions.length - 1];
      if (latest === undefined) {
        // A record with no versions should never exist in practice —
        // `writeArtifact` always creates v1 atomically — but defending
        // against it here keeps `listArtifacts` total.
        continue;
      }
      metadata.push({
        id: record.id,
        taskId: record.taskId,
        fileName: record.fileName,
        latestVersion: latest.version,
        latestContentHash: latest.contentHash,
        updatedAt: record.updatedAt,
      });
    }

    metadata.sort((a, b) => {
      if (a.updatedAt < b.updatedAt) return -1;
      if (a.updatedAt > b.updatedAt) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });

    return metadata;
  }

  /**
   * Returns a unified diff between two explicit versions of the same
   * artifact.
   *
   * Behaviour:
   *
   *   • Both `fromVersion` and `toVersion` must already exist for the
   *     artifact. If the artifact is missing or either version is not
   *     present, returns `null` so callers can render a "no diff
   *     available" affordance without exception handling.
   *   • `fromVersion` and `toVersion` must differ. The validation
   *     schema (`diffPatchSchema`) also enforces this, but rejecting
   *     it here lets us return a clear `TypeError` instead of an
   *     opaque schema violation.
   *   • The diff is computed only when this method is called. The
   *     Trace UI (task 11.3) and File Artifact viewer (task 10.3) MUST
   *     call `getDiff` only in response to an explicit user gesture
   *     (Requirement 11.5: diff is never displayed automatically).
   *   • Bytes are decoded as UTF-8 before diffing. Binary artifacts
   *     produce undefined output for the diff body; callers that need
   *     binary diffs should use `getArtifact` for both versions and
   *     compare bytes directly. The unified-diff helper handles the
   *     "identical content" case by returning the empty string, which
   *     `diffPatchSchema` accepts.
   *
   * Validates: Requirements 11.4, 11.5.
   */
  public async getDiff(input: GetDiffInput): Promise<DiffPatch | null> {
    assertNonEmptyString(input.taskId, "taskId");
    assertNonEmptyString(input.artifactId, "artifactId");
    assertPositiveInteger(input.fromVersion, "fromVersion");
    assertPositiveInteger(input.toVersion, "toVersion");

    if (input.fromVersion === input.toVersion) {
      throw new TypeError(
        "ArtifactStore.getDiff: fromVersion and toVersion must differ",
      );
    }

    const record = await this.backend.get(input.taskId, input.artifactId);
    if (record === null) {
      return null;
    }

    const from = record.versions.find((v) => v.version === input.fromVersion);
    const to = record.versions.find((v) => v.version === input.toVersion);
    if (from === undefined || to === undefined) {
      return null;
    }

    const oldText = utf8Decoder.decode(from.bytes);
    const newText = utf8Decoder.decode(to.bytes);
    const patchText = this.computeDiff(oldText, newText, {
      oldLabel: `${record.fileName}@v${from.version}`,
      newLabel: `${record.fileName}@v${to.version}`,
    });

    return {
      artifactId: record.id,
      fromVersion: from.version,
      toVersion: to.version,
      patchText,
    };
  }
}

/** Reused decoder so we don't allocate a new TextDecoder per `getDiff`. */
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Composes the next `ArtifactRecord` for persistence.
 *
 * On a fresh artifact (`existing === null`) the record contains a single
 * version. On an extension, the new version is appended and the
 * top-level metadata (`fileName`, `mimeType`) follows the latest write
 * — producers may rename a file or refine the MIME type between
 * versions, and the design does not forbid this.
 */
function buildRecord(
  artifactId: string,
  input: WriteArtifactInput,
  existing: ArtifactRecord | null,
  newVersion: FileArtifactVersion,
  nowIso: string,
): ArtifactRecord {
  if (existing === null) {
    return {
      id: artifactId,
      taskId: input.taskId,
      fileName: input.fileName,
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      versions: [newVersion],
      updatedAt: nowIso,
    };
  }

  return {
    id: existing.id,
    taskId: existing.taskId,
    fileName: input.fileName,
    ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
    versions: [...existing.versions, newVersion],
    updatedAt: nowIso,
  };
}

function cloneVersion(version: FileArtifactVersion): FileArtifactVersion {
  return {
    version: version.version,
    authoredByAgentId: version.authoredByAgentId,
    contentHash: version.contentHash,
    bytes: version.bytes.slice(),
    createdAt: version.createdAt,
  };
}

/**
 * Up-front validation for {@link WriteArtifactInput}.
 *
 * Errors here represent programmer mistakes (empty agent id, empty file
 * name, missing bytes) — the surrounding validation schemas in
 * `packages/validation` already cover the on-the-wire shape; these
 * checks defend the in-process API from accidental misuse.
 */
function validateInput(input: WriteArtifactInput): void {
  assertNonEmptyString(input.taskId, "taskId");
  assertNonEmptyString(input.authoredByAgentId, "authoredByAgentId");
  assertNonEmptyString(input.fileName, "fileName");

  if (input.artifactId !== undefined) {
    assertNonEmptyString(input.artifactId, "artifactId");
  }
  if (input.mimeType !== undefined) {
    assertNonEmptyString(input.mimeType, "mimeType");
  }

  if (!(input.bytes instanceof Uint8Array)) {
    throw new TypeError("ArtifactStore.writeArtifact: bytes must be a Uint8Array");
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `ArtifactStore.writeArtifact: ${field} must be a non-empty string`,
    );
  }
}

/**
 * Validates a positive integer field for the read paths. Mirrors the
 * shape of `assertNonEmptyString` but emits a method-agnostic error
 * label since multiple read methods share this guard.
 */
function assertPositiveInteger(value: unknown, field: string): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new TypeError(
      `ArtifactStore: ${field} must be a positive integer (>= 1)`,
    );
  }
}

// `AgentId` and `TaskId` are imported only for documentation linkage; mark
// them as type-only references so the runtime bundle stays clean.
export type { AgentId, TaskId };
