/**
 * In-memory {@link ArtifactStoreBackend} (task 10.1).
 *
 * Used by:
 *
 *   • Vitest unit tests for `ArtifactStore`.
 *   • The property test in task 10.4 (`File_Artifact same-content write
 *     is idempotent`).
 *   • Early backend bring-up before encrypted SQLite is wired in.
 *
 * Production replaces this with a SQL-backed backend; both implement the
 * same `ArtifactStoreBackend` port so callers (`ArtifactStore`, future
 * Final_Report builder, etc.) do not change.
 *
 * Storage layout: a `Map<string, ArtifactRecord>` keyed by
 * `<taskId>::<artifactId>`. Records are deep-cloned (including the
 * `bytes` of every version) on read and write so caller-side mutation
 * never reaches into the persisted state. This mirrors the discipline
 * used by `InMemoryApiKeyStoreBackend` in `settings/`.
 */

import type { TaskId } from "@ai-agent-orchestrator/shared-core";

import type {
  ArtifactRecord,
  ArtifactStoreBackend,
} from "./types.js";

/**
 * Builds the composite Map key for `(taskId, artifactId)`.
 *
 * Exported so debug helpers can reproduce the encoding without
 * duplicating the rule.
 */
export function buildArtifactKey(taskId: TaskId, artifactId: string): string {
  return `${taskId}::${artifactId}`;
}

/** Returns just the task half of a composite key, used by `list`. */
function buildTaskPrefix(taskId: TaskId): string {
  return `${taskId}::`;
}

/**
 * Round-trips a record through a manual deep clone so callers cannot
 * mutate persisted state.
 *
 * `JSON.parse(JSON.stringify(...))` is unsafe here because `bytes` is a
 * `Uint8Array` — `JSON.stringify` would serialise it as `{ "0": ..., "1": ...}`
 * and lose the typed-array shape. We therefore copy the bytes manually
 * and shallow-clone the surrounding scalar fields.
 */
function cloneRecord(record: ArtifactRecord): ArtifactRecord {
  return {
    id: record.id,
    taskId: record.taskId,
    fileName: record.fileName,
    ...(record.mimeType !== undefined ? { mimeType: record.mimeType } : {}),
    versions: record.versions.map((v) => ({
      version: v.version,
      authoredByAgentId: v.authoredByAgentId,
      contentHash: v.contentHash,
      // `slice()` returns a fresh Uint8Array backed by a fresh ArrayBuffer.
      bytes: v.bytes.slice(),
      createdAt: v.createdAt,
    })),
    updatedAt: record.updatedAt,
  };
}

/** Map-backed in-memory implementation. Constructed empty. */
export class InMemoryArtifactStoreBackend implements ArtifactStoreBackend {
  private readonly entries = new Map<string, ArtifactRecord>();

  public get(
    taskId: TaskId,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    const record = this.entries.get(buildArtifactKey(taskId, artifactId));
    return Promise.resolve(record === undefined ? null : cloneRecord(record));
  }

  public put(taskId: TaskId, record: ArtifactRecord): Promise<void> {
    // Defensive clone on write: the caller still owns the object it
    // handed us; from this point the store is the source of truth.
    this.entries.set(buildArtifactKey(taskId, record.id), cloneRecord(record));
    return Promise.resolve();
  }

  public list(taskId: TaskId): Promise<ArtifactRecord[]> {
    const prefix = buildTaskPrefix(taskId);
    const out: ArtifactRecord[] = [];
    for (const [key, record] of this.entries) {
      if (key.startsWith(prefix)) {
        out.push(cloneRecord(record));
      }
    }
    return Promise.resolve(out);
  }

  /**
   * Test helper: removes every entry. Production code MUST NOT call this —
   * mirrors the `clearAll` hatch on `InMemoryApiKeyStoreBackend`.
   */
  public clearAll(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }
}
