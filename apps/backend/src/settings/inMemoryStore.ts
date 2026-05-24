/**
 * In-memory {@link ApiKeyStoreBackend} implementation.
 *
 * Used by:
 *
 *   • Vitest unit tests for {@link ApiKeyService}.
 *   • Property-based tests in tasks 6.5 and 6.7.
 *   • The early desktop bring-up before encrypted SQLite is wired in.
 *
 * Production replaces this with a SQLCipher-backed backend on the desktop and
 * a Postgres-backed one in the cloud; both implement the same `ApiKeyStoreBackend`
 * port so callers (`ApiKeyService`, future `Settings_Store` methods) don't need
 * to change.
 *
 * Storage layout: a single `Map<string, ApiKeyRecord>` keyed by
 * `<scope-key>::<provider>`. The scope-key encoding is symmetric:
 *
 *   • local scope → `"local:<deviceId>"`
 *   • cloud scope → `"cloud:<userId>"`
 *
 * Records returned from `list`/`get` are deep-cloned so mutating them on the
 * caller side cannot leak back into the store. This mirrors the discipline
 * used by `InMemoryLocalKvStore` in the desktop package.
 *
 * Validates: Requirements 4.1, 4.4, 4.5.
 */

import type {
  ApiKeyRecord,
  ApiKeyStoreBackend,
  ProviderId,
  Scope,
} from "./types.js";

/**
 * Builds the composite Map key for `(scope, provider)`.
 *
 * Exported so a future migration tool, or a debug helper, can compute the
 * same key without duplicating the encoding rules.
 */
export function buildScopeProviderKey(scope: Scope, provider: ProviderId): string {
  const scopeKey = scope.kind === "local"
    ? `local:${scope.deviceId}`
    : `cloud:${scope.userId}`;
  return `${scopeKey}::${provider}`;
}

/** Returns just the scope half of a composite key, used by `list`. */
function buildScopeKey(scope: Scope): string {
  return scope.kind === "local" ? `local:${scope.deviceId}` : `cloud:${scope.userId}`;
}

/** Round-trips a record through JSON so caller mutation can't alter store state. */
function cloneRecord(record: ApiKeyRecord): ApiKeyRecord {
  // `JSON.parse(JSON.stringify(...))` is sufficient because every field on
  // `ApiKeyRecord` is a JSON-safe primitive or plain object. There are no
  // typed arrays here — `encryptedKey.ciphertext` is base64-encoded.
  return JSON.parse(JSON.stringify(record)) as ApiKeyRecord;
}

/**
 * Map-backed {@link ApiKeyStoreBackend}. Constructed empty.
 */
export class InMemoryApiKeyStoreBackend implements ApiKeyStoreBackend {
  private readonly entries = new Map<string, ApiKeyRecord>();

  public put(scope: Scope, record: ApiKeyRecord): Promise<void> {
    // Defensive clone so later mutation by the caller cannot alter what's
    // "persisted". The store is the source of truth from now on.
    this.entries.set(
      buildScopeProviderKey(scope, record.provider),
      cloneRecord(record),
    );
    return Promise.resolve();
  }

  public delete(scope: Scope, provider: ProviderId): Promise<void> {
    // `Map.delete` resolves whether or not the key existed, which is exactly
    // the contract `ApiKeyStoreBackend.delete` advertises (Requirement 4.4).
    this.entries.delete(buildScopeProviderKey(scope, provider));
    return Promise.resolve();
  }

  public list(scope: Scope): Promise<ApiKeyRecord[]> {
    const prefix = `${buildScopeKey(scope)}::`;
    const out: ApiKeyRecord[] = [];
    for (const [key, record] of this.entries) {
      if (key.startsWith(prefix)) {
        out.push(cloneRecord(record));
      }
    }
    return Promise.resolve(out);
  }

  public get(scope: Scope, provider: ProviderId): Promise<ApiKeyRecord | null> {
    const record = this.entries.get(buildScopeProviderKey(scope, provider));
    return Promise.resolve(record === undefined ? null : cloneRecord(record));
  }

  /**
   * Test helper: removes every entry. Production code MUST NOT call this —
   * exposing a "clear all secrets" hatch on the production backend is a
   * footgun. Tests use it to reset state between runs.
   */
  public clearAll(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }
}
