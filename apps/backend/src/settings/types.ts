/**
 * Settings Store types for API-key management (task 6.1).
 *
 * Source: design.md → "Settings Store" and "Data Models" → "API Key".
 *
 * The `SettingsStore` interface in the design covers API keys, custom agents,
 * preferences and local-to-cloud merge. Task 6.1 implements only the three
 * API-key methods; later tasks (6.2, 6.3, 17.x) extend the surface.
 *
 * Two ports are defined here so the implementation stays decoupled from any
 * particular cipher or storage backend:
 *
 *   • {@link SecretCipher}        — wraps API-key plaintext into an
 *     `EncryptedBlob`. Matches the abstraction used by Desktop Shell's
 *     Local Encrypted Storage; the production backend wires the same
 *     AES-256-GCM cipher behind this port.
 *   • {@link ApiKeyStoreBackend}  — durable key/value store for
 *     `ApiKeyRecord`s. The in-memory implementation in `inMemoryStore.ts`
 *     covers tests; production wires this to encrypted SQLite (task 6.x
 *     and beyond).
 *
 * Validates: Requirements 4.1, 4.2, 4.4, 4.5.
 */

import type { ProviderId, Scope } from "@ai-agent-orchestrator/shared-core";

// Re-export `Scope` (and friends) from shared-core so the rest of the backend
// can `import { Scope } from "../settings"` without reaching across packages.
export type {
  CloudScope,
  LocalScope,
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";

/**
 * Opaque ciphertext envelope produced by {@link SecretCipher.encrypt}.
 *
 * Structurally compatible with `EncryptedBlob` from the Desktop Shell so the
 * same cipher implementation can sit on either side of the bridge.
 *
 *   • `algorithm` — stable identifier (e.g. `"aes-256-gcm.v1"`); cipher
 *     implementations refuse to decrypt blobs whose algorithm tag they
 *     don't recognise.
 *   • `ciphertext` — base64 of `IV || GCM ciphertext+tag` (or whatever shape
 *     the chosen cipher defines). Treat as opaque outside the cipher.
 *   • `createdAt` — ISO 8601 UTC timestamp; useful for audit but does not
 *     affect decryption.
 */
export type EncryptedBlob = {
  readonly algorithm: string;
  readonly ciphertext: string;
  readonly createdAt: string;
};

/**
 * Public, UI-safe view of a stored API key.
 *
 * MUST NOT include the encrypted blob or anything derived from the plaintext
 * beyond the truncated SHA-256 fingerprint. Callers that need to render a
 * "Provider X is configured" affordance read this; callers that need the
 * decrypted secret (e.g. `Orchestrator`, `Model_Catalog`) go through the
 * server-only `resolveApiKeySecret` path defined in task 6.3.
 *
 * Validates: Requirement 3.7 (no plaintext to client), 4.1 (metadata listing).
 */
export type ApiKeyMetadata = {
  readonly provider: ProviderId;
  /** SHA-256 of the plaintext, truncated to the first 12 hex chars. */
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly lastValidatedAt: string;
};

/**
 * Internal record persisted by the {@link ApiKeyStoreBackend}.
 *
 * Mirrors `ApiKeyRecord` from design.md → "Data Models" → "API Key", with the
 * difference that `encryptedKey` is an `EncryptedBlob` (not a raw `Uint8Array`)
 * because the cipher already encodes the IV/tag layout into the blob fields.
 *
 * Never returned to client-facing code: only the `ApiKeyStoreBackend` and (in
 * task 6.3) `resolveApiKeySecret` ever see this shape.
 */
export type ApiKeyRecord = ApiKeyMetadata & {
  readonly encryptedKey: EncryptedBlob;
  readonly scope: Scope;
};

/**
 * AEAD cipher port. Implementations MUST:
 *
 *   • use a fresh random IV per `encrypt` call;
 *   • include an authentication tag so tampering surfaces as a decrypt error,
 *     never silent corruption;
 *   • populate `algorithm` with a stable identifier so future migrations can
 *     branch on it.
 */
export interface SecretCipher {
  encrypt(plaintext: string): Promise<EncryptedBlob>;
  decrypt(blob: EncryptedBlob): Promise<string>;
}

/**
 * Pluggable storage backend for `ApiKeyRecord`s.
 *
 * The in-memory implementation in `inMemoryStore.ts` is used by tests and
 * by the desktop shell during early bring-up; production wires this to the
 * encrypted SQLite (or cloud Postgres) store. The interface is intentionally
 * small — fingerprint computation, metadata projection and cipher orchestration
 * all live in {@link ApiKeyService} so backends only have to handle persistence.
 *
 * Scoping rule: a backend instance is responsible for at most one logical
 * store (local on this device, or cloud for this user). The `scope` argument
 * disambiguates entries within that store; backends MUST treat records under
 * different `scope` values as independent rows even when they share the same
 * `provider`.
 */
export interface ApiKeyStoreBackend {
  /**
   * Persists `record` under `(scope, record.provider)`, replacing any prior
   * record at that coordinate.
   */
  put(scope: Scope, record: ApiKeyRecord): Promise<void>;

  /**
   * Removes the record at `(scope, provider)`. MUST resolve normally whether
   * or not an entry existed — Requirement 4.4 forbids surfacing an error
   * when the user-visible deletion is logically successful.
   */
  delete(scope: Scope, provider: ProviderId): Promise<void>;

  /** Returns every record in `scope`. Order is implementation-defined. */
  list(scope: Scope): Promise<ApiKeyRecord[]>;

  /**
   * Returns the record at `(scope, provider)` or `null` if absent.
   *
   * Used by `resolveApiKeySecret` (task 6.3); included on the backend port
   * so future implementations don't have to load the entire scope just to
   * answer a single-provider question. `ApiKeyService` (task 6.1) only
   * relies on `put`/`delete`/`list`.
   */
  get(scope: Scope, provider: ProviderId): Promise<ApiKeyRecord | null>;
}
