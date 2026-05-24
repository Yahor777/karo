/**
 * Cloud_Settings_Store adapter (task 17.2).
 *
 * Sources:
 *   • design.md → "Cloud Storage" → cloud tables include `users`,
 *     `cloud_sessions`, `api_keys`, `custom_agents`, `preferences`, etc.
 *   • design.md → "Settings Store" → "Responsibilities":
 *       – API key storage, local settings, cloud settings, custom agents,
 *         preferences, local-to-cloud merge, secret resolution for server
 *         components.
 *   • design.md → "Settings Store" → "Rules":
 *       – Local scope uses Local Encrypted Storage.
 *       – Cloud scope uses Cloud Settings Store.
 *       – Encrypted secret storage: API_Key never stored as plaintext;
 *         decrypted only via `resolveApiKeySecret`.
 *   • requirements.md →
 *       3.3 (`Settings_Store SHALL хранить API_Key … в зашифрованном виде …
 *             привязав к учётной записи пользователя.`),
 *       3.4 (second-device login returns previously saved API keys and
 *             user settings without re-entry),
 *       3.7 (encrypted at rest; plaintext only via explicit server-side
 *             component request).
 *   • tasks.md task 17.2 sub-bullets: cloud-scoped tables for `api_keys`,
 *     `custom_agents`, `preferences`; `loadSettingsForSession` returns
 *     stored settings to authorized session on second-device login.
 *
 * What this module ships
 * ----------------------
 *   • {@link CloudSettingsStore}             — cloud-scoped façade composing
 *     `ApiKeyService` (task 6.1), `CustomAgentService` (task 6.2), and a
 *     pluggable {@link PreferencesBackend}. Methods accept `userId` and
 *     internally construct `Scope = { kind: "cloud", userId }`, so callers
 *     never have to spell the scope out.
 *   • {@link PreferencesBackend} / {@link InMemoryPreferencesBackend} —
 *     port + in-memory implementation for the third cloud collection
 *     (`preferences`). Uses the same `Scope`-keyed shape as the other
 *     backends so a future SQL-backed implementation drops in behind the
 *     same port.
 *   • {@link createInMemoryCloudSettingsStore} — convenience factory that
 *     wires the three in-memory backends together for tests and early
 *     bring-up. Production composition supplies real SQL/HSM-backed
 *     adapters behind the same ports.
 *   • {@link loadSettingsForSession} — second-device-login restoration:
 *     returns the user's API key metadata, custom agents, and preferences
 *     in one call.
 *
 * Boundaries
 * ----------
 *   • This file does NOT implement local↔cloud merge — that is task 17.3.
 *   • This file does NOT decrypt or expose API key plaintext. The cloud
 *     store sees ciphertext only, exactly as the local-scope path does;
 *     callers that need plaintext go through {@link createSecretGateway}
 *     (task 6.3) over an `ApiKeyEncryptedRecordReader` adapter.
 *   • This file does NOT depend on any HTTP/IPC code; it is a server-side
 *     façade that the gateway/route layer wraps in a later task.
 *
 * Coordination with task 6.x
 * --------------------------
 *   • `ApiKeyStoreBackend` (and its in-memory implementation) already
 *     supports both `local` and `cloud` scopes — the scope is part of the
 *     composite key. The cloud store therefore reuses it unchanged and
 *     only injects `Scope = { kind: "cloud", userId }` at the call site.
 *   • `InMemoryCustomAgentStore` is similarly scope-aware via `scopeKey`
 *     and is reused as-is for cloud scope.
 *
 * Validates: Requirements 3.3, 3.4, 3.7.
 */

import type {
  CloudScope,
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";
import type {
  CustomAgent,
  CustomAgentInput,
} from "@ai-agent-orchestrator/validation";

import { ApiKeyService } from "./apiKeys.js";
import {
  createCustomAgentService,
  InMemoryCustomAgentStore,
  type CustomAgentService,
  type CustomAgentStore,
} from "./customAgents.js";
import { InMemoryApiKeyStoreBackend } from "./inMemoryStore.js";
import type {
  ApiKeyMetadata,
  ApiKeyStoreBackend,
  SecretCipher,
} from "./types.js";

// ---------------------------------------------------------------------------
// Preferences port and in-memory backend
// ---------------------------------------------------------------------------

/**
 * Read-only snapshot of a user's preferences map.
 *
 * Preferences are arbitrary JSON-serializable values keyed by string —
 * the design lists `preferences` as one of the cloud tables but does not
 * fix a schema. Concrete keys (e.g. `"theme"`, `"default_model"`) are
 * defined by callers. The backend MUST treat values as opaque and MUST
 * NOT mutate the snapshot it returns from `list`.
 */
export type Preferences = Readonly<Record<string, unknown>>;

/**
 * Pluggable storage port for the `preferences` collection.
 *
 * Mirrors the shape of `ApiKeyStoreBackend` and `CustomAgentStore`:
 *   • Scope-keyed so the same port serves both local and cloud users.
 *   • The {@link CloudSettingsStore} only ever passes a cloud scope; the
 *     port itself is scope-agnostic so a future local-scope implementation
 *     (or a unified backend) can plug in unchanged.
 */
export interface PreferencesBackend {
  /** Sets `key` to a deep-cloned copy of `value` within `scope`. */
  set(scope: Scope, key: string, value: unknown): Promise<void>;
  /** Returns the stored value for `key` or `undefined` if absent. */
  get(scope: Scope, key: string): Promise<unknown>;
  /** Removes `key`. Returns `true` iff a value existed. */
  remove(scope: Scope, key: string): Promise<boolean>;
  /** Returns a plain-object snapshot of all preferences in `scope`. */
  list(scope: Scope): Promise<Preferences>;
}

/**
 * Map-backed {@link PreferencesBackend}. Used by tests and by the early
 * bring-up cloud store. Production swaps in a SQL-backed implementation
 * behind the same port.
 *
 * Values are deep-cloned on read and write so callers cannot mutate
 * persisted state by retaining references to returned snapshots.
 */
export class InMemoryPreferencesBackend implements PreferencesBackend {
  private readonly buckets = new Map<string, Map<string, unknown>>();

  public set(scope: Scope, key: string, value: unknown): Promise<void> {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("InMemoryPreferencesBackend.set: key must be non-empty.");
    }
    this.bucket(scope).set(key, deepClone(value));
    return Promise.resolve();
  }

  public get(scope: Scope, key: string): Promise<unknown> {
    const bucket = this.buckets.get(scopeKey(scope));
    if (bucket === undefined) return Promise.resolve(undefined);
    if (!bucket.has(key)) return Promise.resolve(undefined);
    return Promise.resolve(deepClone(bucket.get(key)));
  }

  public remove(scope: Scope, key: string): Promise<boolean> {
    const bucket = this.buckets.get(scopeKey(scope));
    if (bucket === undefined) return Promise.resolve(false);
    return Promise.resolve(bucket.delete(key));
  }

  public list(scope: Scope): Promise<Preferences> {
    const bucket = this.buckets.get(scopeKey(scope));
    if (bucket === undefined) return Promise.resolve({});
    const out: Record<string, unknown> = {};
    for (const [k, v] of bucket) {
      out[k] = deepClone(v);
    }
    return Promise.resolve(out);
  }

  private bucket(scope: Scope): Map<string, unknown> {
    const key = scopeKey(scope);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(key, bucket);
    }
    return bucket;
  }
}

function scopeKey(scope: Scope): string {
  return scope.kind === "local"
    ? `local:${scope.deviceId}`
    : `cloud:${scope.userId}`;
}

function deepClone<T>(value: T): T {
  if (value === undefined) return value;
  // Round-trip through JSON to produce a structurally independent copy.
  // Preferences values are required to be JSON-serializable so this is safe.
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Cloud settings store
// ---------------------------------------------------------------------------

/**
 * Aggregate result returned by `CloudSettingsStore.loadSettingsForSession`.
 *
 * Designed for the second-device-login restoration path (Requirement 3.4):
 * one round-trip returns API key metadata, custom agents, and preferences,
 * which is everything a fresh client needs to render the settings UI on a
 * device that has never seen this user before.
 *
 * `apiKeys` is the public, plaintext-free `ApiKeyMetadata[]` projection
 * — never the encrypted blob and never the plaintext (Requirement 3.7).
 * Plaintext is reachable only via {@link createSecretGateway} on the
 * server side.
 */
export interface CloudSessionSettings {
  readonly apiKeys: readonly ApiKeyMetadata[];
  readonly customAgents: readonly CustomAgent[];
  readonly preferences: Preferences;
}

/**
 * Construction options for {@link CloudSettingsStore}.
 *
 * Three pre-built services are supplied so the cloud store stays a thin
 * façade and its dependencies remain independently testable. The factory
 * helper {@link createInMemoryCloudSettingsStore} below assembles them
 * for tests and bring-up.
 */
export interface CloudSettingsStoreOptions {
  readonly apiKeyService: ApiKeyService;
  readonly customAgentService: CustomAgentService;
  readonly preferencesBackend: PreferencesBackend;
}

/**
 * Cloud-scoped façade over the three Settings_Store collections that
 * design.md tags as cloud tables: `api_keys`, `custom_agents`,
 * `preferences`.
 *
 * The store is multi-tenant: every method takes a `userId` and constructs
 * a `Scope = { kind: "cloud", userId }` internally. This matches reality
 * in the cloud, where one server services many users; per-user binding
 * happens at the gateway/session layer that holds the authenticated
 * `userId` for the current request.
 *
 * Encryption discipline:
 *   • The cloud store NEVER sees API key plaintext. `upsertApiKey`
 *     forwards the supplied plaintext to {@link ApiKeyService}, which
 *     encrypts via the injected `SecretCipher` BEFORE persisting through
 *     the `ApiKeyStoreBackend`. The cloud store's only contact with the
 *     value is this single forward call.
 *   • `listApiKeyMetadata` returns the plaintext-free
 *     {@link ApiKeyMetadata} projection — exactly what the UI needs.
 *   • Decryption belongs to {@link createSecretGateway} (task 6.3), not
 *     here.
 *
 * Validates: Requirements 3.3, 3.4, 3.7.
 */
export class CloudSettingsStore {
  private readonly apiKeyService: ApiKeyService;
  private readonly customAgentService: CustomAgentService;
  private readonly preferencesBackend: PreferencesBackend;

  public constructor(options: CloudSettingsStoreOptions) {
    this.apiKeyService = options.apiKeyService;
    this.customAgentService = options.customAgentService;
    this.preferencesBackend = options.preferencesBackend;
  }

  // -----------------------------------------------------------------------
  // API keys (cloud-scoped)
  // -----------------------------------------------------------------------

  /**
   * Stores or replaces the API key for `provider` under the user's cloud
   * scope. Plaintext is encrypted by the underlying `ApiKeyService` before
   * any persistence; the cloud store does not retain it.
   *
   * Validates: Requirements 3.3, 3.7.
   */
  public async upsertApiKey(
    userId: string,
    input: { readonly provider: ProviderId; readonly apiKey: string },
  ): Promise<void> {
    await this.apiKeyService.upsertApiKey(scopeFor(userId), input);
  }

  /**
   * Removes the API key for `provider` under the user's cloud scope.
   * Resolves normally whether or not an entry existed (Requirement 4.4).
   */
  public async removeApiKey(
    userId: string,
    provider: ProviderId,
  ): Promise<void> {
    await this.apiKeyService.removeApiKey(scopeFor(userId), provider);
  }

  /**
   * Returns the user's API key metadata. Plaintext-free and
   * encrypted-blob-free; only the `ApiKeyMetadata` projection is exposed.
   *
   * Validates: Requirement 3.7.
   */
  public async listApiKeyMetadata(userId: string): Promise<ApiKeyMetadata[]> {
    return await this.apiKeyService.listApiKeyMetadata(scopeFor(userId));
  }

  // -----------------------------------------------------------------------
  // Custom agents (cloud-scoped)
  // -----------------------------------------------------------------------

  /**
   * Creates or updates a Custom_Agent under the user's cloud scope.
   * Builtin-name collisions and same-scope name conflicts are enforced
   * by `CustomAgentService` (task 6.2).
   */
  public async upsertCustomAgent(
    userId: string,
    input: CustomAgentInput,
  ): Promise<CustomAgent> {
    return await this.customAgentService.upsertCustomAgent(scopeFor(userId), input);
  }

  /** Removes a Custom_Agent by id under the user's cloud scope. No-op if absent. */
  public async removeCustomAgent(
    userId: string,
    agentId: string,
  ): Promise<void> {
    await this.customAgentService.removeCustomAgent(scopeFor(userId), agentId);
  }

  /** Returns every Custom_Agent stored under the user's cloud scope. */
  public async listCustomAgents(userId: string): Promise<CustomAgent[]> {
    return await this.customAgentService.listCustomAgents(scopeFor(userId));
  }

  // -----------------------------------------------------------------------
  // Preferences (cloud-scoped)
  // -----------------------------------------------------------------------

  /** Sets a preference value (must be JSON-serializable). */
  public async setPreference(
    userId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    await this.preferencesBackend.set(scopeFor(userId), key, value);
  }

  /** Returns a preference value or `undefined` if not set. */
  public async getPreference(
    userId: string,
    key: string,
  ): Promise<unknown> {
    return await this.preferencesBackend.get(scopeFor(userId), key);
  }

  /** Removes a preference. Returns `true` iff a value existed. */
  public async removePreference(
    userId: string,
    key: string,
  ): Promise<boolean> {
    return await this.preferencesBackend.remove(scopeFor(userId), key);
  }

  /** Returns a snapshot of all preferences for the user. */
  public async listPreferences(userId: string): Promise<Preferences> {
    return await this.preferencesBackend.list(scopeFor(userId));
  }

  // -----------------------------------------------------------------------
  // Second-device-login restoration
  // -----------------------------------------------------------------------

  /**
   * Loads the user's three cloud collections in one call, for the
   * second-device-login restoration path (Requirement 3.4).
   *
   * Returns:
   *   • `apiKeys`       — `ApiKeyMetadata[]` (plaintext-free).
   *   • `customAgents`  — every Custom_Agent in the user's cloud scope.
   *   • `preferences`   — snapshot of all preference key/value pairs.
   *
   * The three reads happen in parallel because they target independent
   * backends; ordering between collections is not observable to callers.
   *
   * Validates: Requirements 3.3, 3.4, 3.7.
   */
  public async loadSettingsForSession(input: {
    readonly userId: string;
  }): Promise<CloudSessionSettings> {
    const scope = scopeFor(input.userId);
    const [apiKeys, customAgents, preferences] = await Promise.all([
      this.apiKeyService.listApiKeyMetadata(scope),
      this.customAgentService.listCustomAgents(scope),
      this.preferencesBackend.list(scope),
    ]);
    return { apiKeys, customAgents, preferences };
  }
}

/** Builds the cloud `Scope` for `userId`. Centralised to avoid drift. */
function scopeFor(userId: string): CloudScope {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("CloudSettingsStore: userId must be a non-empty string.");
  }
  return { kind: "cloud", userId };
}

// ---------------------------------------------------------------------------
// Composition helper
// ---------------------------------------------------------------------------

/**
 * Construction options for {@link createInMemoryCloudSettingsStore}.
 *
 * Required:
 *   • `cipher` — the AEAD cipher used to wrap API keys before they reach
 *     the in-memory backend. Production composition supplies a KMS-backed
 *     cipher; tests typically supply a deterministic stub.
 *
 * Optional (each defaults to a fresh in-memory backend):
 *   • `apiKeyBackend`         — pre-existing `ApiKeyStoreBackend` to share
 *     across instances. Critical for the second-device-login test: a
 *     fresh `CloudSettingsStore` instance pointed at the SAME backends as
 *     the previous instance must surface the user's previously stored
 *     records.
 *   • `customAgentStore`      — pre-existing `CustomAgentStore`.
 *   • `preferencesBackend`    — pre-existing `PreferencesBackend`.
 */
export interface CreateInMemoryCloudSettingsStoreOptions {
  readonly cipher: SecretCipher;
  readonly apiKeyBackend?: ApiKeyStoreBackend;
  readonly customAgentStore?: CustomAgentStore;
  readonly preferencesBackend?: PreferencesBackend;
}

/**
 * Result of {@link createInMemoryCloudSettingsStore}: the assembled
 * cloud store plus references to its three backends. Returning the
 * backends lets callers thread the SAME backend instances into a second
 * `CloudSettingsStore` to simulate a second-device login.
 */
export interface InMemoryCloudSettingsStoreBundle {
  readonly store: CloudSettingsStore;
  readonly apiKeyBackend: ApiKeyStoreBackend;
  readonly customAgentStore: CustomAgentStore;
  readonly preferencesBackend: PreferencesBackend;
}

/**
 * Wires an in-memory `CloudSettingsStore` over the three default
 * in-memory backends (or caller-supplied ones). Suitable for tests and
 * for early backend bring-up before SQL-backed adapters land.
 */
export function createInMemoryCloudSettingsStore(
  options: CreateInMemoryCloudSettingsStoreOptions,
): InMemoryCloudSettingsStoreBundle {
  const apiKeyBackend = options.apiKeyBackend ?? new InMemoryApiKeyStoreBackend();
  const customAgentStore =
    options.customAgentStore ?? new InMemoryCustomAgentStore();
  const preferencesBackend =
    options.preferencesBackend ?? new InMemoryPreferencesBackend();

  const apiKeyService = new ApiKeyService({
    backend: apiKeyBackend,
    cipher: options.cipher,
  });
  const customAgentService = createCustomAgentService(customAgentStore);

  const store = new CloudSettingsStore({
    apiKeyService,
    customAgentService,
    preferencesBackend,
  });

  return { store, apiKeyBackend, customAgentStore, preferencesBackend };
}
