/**
 * Public surface of the backend Auth Service module.
 *
 * Tasks 4.1 and 4.2 ship the API-key login portion of `AuthService`:
 *
 *   • {@link AuthService}              — entry point used by the API
 *     gateway and (later) by `SettingsStore.upsertApiKey` to validate a
 *     candidate key before saving (Requirement 4.2). Also implements
 *     `createLocalSession` (Requirements 2.4, 2.5, 2.8, 4.5).
 *   • {@link OpenAiProbe},
 *     {@link AnthropicProbe},
 *     {@link GenericProbe}             — concrete `ProviderProbe`
 *     adapters wired into production composition.
 *   • {@link fetchHttpFetcher}         — default HTTP transport. Tests
 *     pass a stub `HttpFetcher` instead.
 *   • {@link LocalApiKeySink},
 *     {@link CreateLocalSessionInput},
 *     {@link LocalSessionError}        — public types/ports for
 *     `createLocalSession` (task 4.2). The composition root provides
 *     the sink; Auth never sees ciphertext or storage primitives.
 *   • {@link ValidationResult},
 *     {@link ProviderProbe},
 *     {@link HttpFetcher},
 *     {@link HttpRequest},
 *     {@link HttpResponse},
 *     {@link Session},
 *     {@link DEFAULT_PROBE_TIMEOUT_MS} — public types and constants.
 *
 * Subsequent tasks (4.3, 17.x) extend this barrel with OAuth and
 * session upgrade.
 *
 * Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.8, 4.2, 4.3, 4.5.
 */

export { AuthService } from "./authService.js";
export type {
  AuthClock,
  AuthServiceOptions,
  SessionIdSource,
} from "./authService.js";

export {
  AnthropicProbe,
  GenericProbe,
  OpenAiProbe,
  fetchHttpFetcher,
} from "./providerProbe.js";
export type {
  AnthropicProbeOptions,
  GenericProbeOptions,
  OpenAiProbeOptions,
  ProviderProbeOptions,
} from "./providerProbe.js";

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  LocalSessionError,
} from "./types.js";
export type {
  CreateLocalSessionInput,
  HttpFetcher,
  HttpRequest,
  HttpResponse,
  LocalApiKeySink,
  LocalSessionErrorCode,
  ProviderId,
  ProviderProbe,
  Session,
  ValidationResult,
} from "./types.js";

// Google OAuth (task 17.1).
export {
  GoogleOAuthError,
  GoogleOAuthService,
  InMemoryOAuthStateStore,
  InMemoryUserStore,
  MINIMAL_GOOGLE_SCOPES,
} from "./googleOAuth.js";
export type {
  GoogleOAuthClient,
  GoogleOAuthErrorCode,
  GoogleOAuthServiceOptions,
  GoogleTokenResponse,
  GoogleUserInfo,
  OAuthStateStore,
  UserStore,
} from "./googleOAuth.js";

// Local-to-cloud upgrade with merge report (task 17.3).
export { createUpgradeLocalSessionToGoogle } from "./upgradeLocalSession.js";
export type {
  LocalScopeReader,
  MergeReport,
  UpgradeLocalSessionDependencies,
  UpgradeLocalSessionInput,
  UpgradeLocalSessionResult,
} from "./upgradeLocalSession.js";
