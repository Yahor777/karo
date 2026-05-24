/**
 * `SettingsStore` API-key methods for the local scope (task 6.1).
 *
 * Implements three of the methods on the `SettingsStore` interface from
 * design.md → "Settings Store":
 *
 *   • {@link ApiKeyService.upsertApiKey}        — encrypt before persistence,
 *     compute fingerprint, preserve `createdAt` across updates.
 *   • {@link ApiKeyService.removeApiKey}        — resolves successfully whether
 *     or not an entry exists (Requirement 4.4).
 *   • {@link ApiKeyService.listApiKeyMetadata}  — projects `ApiKeyRecord`s to
 *     `ApiKeyMetadata` so the encrypted blob and plaintext NEVER leak to
 *     the caller (Requirement 3.7).
 *
 * Cipher and storage are injected through the {@link SecretCipher} and
 * {@link ApiKeyStoreBackend} ports defined in `./types.ts`, keeping this
 * service portable between the in-memory test backend and the production
 * encrypted SQLite/Postgres backends added in later tasks.
 *
 * Out of scope here:
 *
 *   • `resolveApiKeySecret` (task 6.3) — server-side decrypted-key gateway.
 *   • Custom agents and other settings (task 6.2 and beyond).
 *   • API-key validation against the Provider (task 4.1, Auth Service).
 *     `upsertApiKey` records the supplied key as already-validated; the Auth
 *     Service is expected to call `validateApiKey` before invoking this.
 *
 * Validates: Requirements 4.1, 4.2, 4.4, 4.5.
 */

import { createHash } from "node:crypto";

import type {
  ApiKeyMetadata,
  ApiKeyRecord,
  ApiKeyStoreBackend,
  ProviderId,
  Scope,
  SecretCipher,
} from "./types.js";

/**
 * Length of the truncated SHA-256 fingerprint, in hex characters.
 *
 * 12 hex chars = 48 bits of entropy, comfortably enough to disambiguate the
 * handful of API keys a single user holds while remaining short enough to
 * render in a settings list. Matches the value mentioned in the task brief.
 */
export const API_KEY_FINGERPRINT_LENGTH = 12;

/**
 * Computes the public fingerprint for an API-key plaintext.
 *
 * Defined as the first {@link API_KEY_FINGERPRINT_LENGTH} hex characters of
 * `SHA-256(plaintext)`. The plaintext is consumed only by this hash and the
 * cipher; it never reaches the on-disk record or the metadata projection.
 *
 * @param plaintext  raw API-key string. Treated as UTF-8.
 */
export function computeApiKeyFingerprint(plaintext: string): string {
  return createHash("sha256")
    .update(plaintext, "utf8")
    .digest("hex")
    .slice(0, API_KEY_FINGERPRINT_LENGTH);
}

/**
 * Projects an `ApiKeyRecord` to its UI-safe `ApiKeyMetadata` view.
 *
 * Exported so other backend components (and tests) can re-use the exact
 * projection without duplicating field lists.
 */
export function toApiKeyMetadata(record: ApiKeyRecord): ApiKeyMetadata {
  return {
    provider: record.provider,
    fingerprint: record.fingerprint,
    createdAt: record.createdAt,
    lastValidatedAt: record.lastValidatedAt,
  };
}

/** Optional clock dependency, primarily for deterministic tests. */
export interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * Constructor options for {@link ApiKeyService}.
 *
 * `backend` and `cipher` are required; `clock` is optional and defaults to
 * the system clock. Tests inject a fixed clock to assert on `createdAt` /
 * `lastValidatedAt` values.
 */
export interface ApiKeyServiceOptions {
  readonly backend: ApiKeyStoreBackend;
  readonly cipher: SecretCipher;
  readonly clock?: Clock;
}

/**
 * Implements the API-key portion of `SettingsStore`.
 *
 * The class is deliberately small — it owns no transport or framework
 * concerns. The Gateway (later task) wraps it behind HTTP/IPC handlers and
 * passes the appropriate `Scope` derived from the caller's session.
 */
export class ApiKeyService {
  private readonly backend: ApiKeyStoreBackend;
  private readonly cipher: SecretCipher;
  private readonly clock: Clock;

  public constructor(options: ApiKeyServiceOptions) {
    this.backend = options.backend;
    this.cipher = options.cipher;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Stores or replaces the API key for `input.provider` in `scope`.
   *
   * Behaviour:
   *
   *   • Plaintext is encrypted via `SecretCipher.encrypt` before it ever
   *     reaches the backend; the plaintext is not retained on the service
   *     after this method returns.
   *   • `fingerprint` is recomputed from the new plaintext.
   *   • On a fresh insert, `createdAt = lastValidatedAt = now()`.
   *   • On replacing an existing entry for the same `(scope, provider)`,
   *     `createdAt` is preserved from the prior record and `lastValidatedAt`
   *     is set to `now()`. This keeps "added on" stable for the UI while
   *     still tracking the most recent validation moment.
   *   • Empty plaintext is rejected — an empty API key cannot have been
   *     successfully validated upstream and storing it would silently leave
   *     the user without a working key.
   *
   * Validates: Requirements 4.1, 4.2, 4.5.
   */
  public async upsertApiKey(
    scope: Scope,
    input: { readonly provider: ProviderId; readonly apiKey: string },
  ): Promise<void> {
    if (typeof input.apiKey !== "string" || input.apiKey.length === 0) {
      throw new Error("ApiKeyService.upsertApiKey: apiKey must be a non-empty string.");
    }
    if (typeof input.provider !== "string" || input.provider.length === 0) {
      throw new Error("ApiKeyService.upsertApiKey: provider must be a non-empty string.");
    }

    const fingerprint = computeApiKeyFingerprint(input.apiKey);
    const encryptedKey = await this.cipher.encrypt(input.apiKey);
    const nowIso = this.clock.now().toISOString();

    const existing = await this.backend.get(scope, input.provider);
    const createdAt = existing?.createdAt ?? nowIso;

    const record: ApiKeyRecord = {
      provider: input.provider,
      fingerprint,
      createdAt,
      lastValidatedAt: nowIso,
      encryptedKey,
      scope,
    };

    await this.backend.put(scope, record);
  }

  /**
   * Removes the API key for `provider` in `scope`.
   *
   * Resolves normally whether or not an entry existed — Requirement 4.4
   * states that successful deletion must not surface an error in the UI.
   * The backend port enforces the same guarantee.
   *
   * Errors raised by the backend (e.g. database unavailable) propagate so
   * the caller can distinguish "logically deleted" from "delete attempt
   * failed"; the design rule is about absence-vs-deletion, not about
   * transport failures.
   *
   * Validates: Requirement 4.4.
   */
  public async removeApiKey(scope: Scope, provider: ProviderId): Promise<void> {
    if (typeof provider !== "string" || provider.length === 0) {
      throw new Error("ApiKeyService.removeApiKey: provider must be a non-empty string.");
    }
    await this.backend.delete(scope, provider);
  }

  /**
   * Lists the metadata for every API key stored in `scope`.
   *
   * Returns ONLY the {@link ApiKeyMetadata} projection — the encrypted blob
   * and plaintext are never observable through this method. The list is
   * sorted by `provider` ascending so callers (and snapshot tests) get a
   * stable order regardless of backend insertion order.
   *
   * Validates: Requirements 3.7, 4.1.
   */
  public async listApiKeyMetadata(scope: Scope): Promise<ApiKeyMetadata[]> {
    const records = await this.backend.list(scope);
    const metadata = records.map(toApiKeyMetadata);
    metadata.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
    return metadata;
  }
}
