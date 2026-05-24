/**
 * Public surface of the backend Settings module.
 *
 * Task 6.1 ships the API-key portion of `SettingsStore`:
 *
 *   • {@link ApiKeyService}                — `upsertApiKey`, `removeApiKey`,
 *     `listApiKeyMetadata` for any `Scope` (used by the local-scope flow today;
 *     same code paths serve cloud scope via the task 17.2 cloud store).
 *   • {@link InMemoryApiKeyStoreBackend}   — pluggable storage backend for
 *     tests and early bring-up; production swaps in encrypted SQLite/Postgres.
 *   • {@link ApiKeyMetadata} / {@link ApiKeyRecord} / {@link SecretCipher} /
 *     {@link ApiKeyStoreBackend} — public types and ports.
 *
 * Task 6.3 adds the server-side decrypted-key gateway:
 *
 *   • {@link createSecretGateway} / {@link SecretGateway} — `resolveApiKeySecret`
 *     gated on a signed {@link ServerComponentToken}.
 *   • {@link createServerComponentToken} / {@link verifyServerComponentToken} —
 *     HMAC-SHA-256 token signer/verifier.
 *   • {@link ApiKeyEncryptedRecordReader} — narrow read-only port the gateway
 *     uses; composition adapts task 6.1's `ApiKeyStoreBackend.get` into it
 *     without modifying `apiKeys.ts`.
 *   • {@link SecretResolutionError} / {@link SERVER_COMPONENTS} and friends.
 *
 * Task 17.2 adds the cloud-scoped `Cloud_Settings_Store`:
 *
 *   • {@link CloudSettingsStore} — cloud-scoped façade composing
 *     `ApiKeyService`, `CustomAgentService`, and a {@link PreferencesBackend}.
 *   • {@link InMemoryPreferencesBackend} / {@link PreferencesBackend} —
 *     in-memory backend + port for the third cloud collection.
 *   • {@link createInMemoryCloudSettingsStore} — composition helper that
 *     wires the three in-memory backends behind a single facade.
 *   • {@link CloudSessionSettings} — aggregate result returned by
 *     `loadSettingsForSession` for the second-device-login restoration path.
 *
 * Custom agents (task 6.2) and the rest of the `SettingsStore` interface land
 * in subsequent tasks and extend this barrel.
 *
 * Validates: Requirements 3.3, 3.4, 3.7, 4.1, 4.2, 4.4, 4.5.
 */

export {
  ApiKeyService,
  API_KEY_FINGERPRINT_LENGTH,
  computeApiKeyFingerprint,
  toApiKeyMetadata,
} from "./apiKeys.js";
export type { ApiKeyServiceOptions, Clock } from "./apiKeys.js";

export {
  InMemoryApiKeyStoreBackend,
  buildScopeProviderKey,
} from "./inMemoryStore.js";

export type {
  ApiKeyMetadata,
  ApiKeyRecord,
  ApiKeyStoreBackend,
  CloudScope,
  EncryptedBlob,
  LocalScope,
  ProviderId,
  Scope,
  SecretCipher,
} from "./types.js";

export {
  createSecretGateway,
  createServerComponentToken,
  isServerComponent,
  SecretResolutionError,
  SERVER_COMPONENTS,
  verifyServerComponentToken,
} from "./secretGateway.js";
export type {
  ApiKeyEncryptedRecordReader,
  CreateServerComponentTokenInput,
  SecretGateway,
  SecretGatewayOptions,
  SecretResolutionErrorCode,
  ServerComponent,
  ServerComponentToken,
  TokenVerificationFailure,
  TokenVerificationResult,
  VerifyServerComponentTokenOptions,
} from "./secretGateway.js";

export {
  CloudSettingsStore,
  InMemoryPreferencesBackend,
  createInMemoryCloudSettingsStore,
} from "./cloudSettingsStore.js";
export type {
  CloudSessionSettings,
  CloudSettingsStoreOptions,
  CreateInMemoryCloudSettingsStoreOptions,
  InMemoryCloudSettingsStoreBundle,
  Preferences,
  PreferencesBackend,
} from "./cloudSettingsStore.js";
