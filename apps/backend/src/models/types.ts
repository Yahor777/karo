/**
 * Public types and ports for the Model Catalog backend module.
 *
 * Source: `design.md` → "Model Catalog" and "Components and Interfaces" →
 * "Model Catalog".
 *
 * This module owns:
 *
 *   • {@link ModelInfo} — the per-model description surfaced to UI.
 *   • {@link ProviderModelsResult} — discriminated union per provider so a
 *     single failing provider does not erase results from healthy providers
 *     (Requirement 5.3).
 *   • {@link ProviderModelsAdapter} — pluggable per-provider port. The
 *     catalog talks only to adapters, so OpenAI, Anthropic and any future
 *     provider can be added without touching catalog logic.
 *   • {@link ApiKeyResolver} — narrow inbound port the catalog uses to
 *     fetch a decrypted API_Key for a `(scope, provider)` pair. The actual
 *     wiring to `SettingsStore.resolveApiKeySecret` (task 6.3) happens
 *     during composition; the catalog itself MUST NOT call any
 *     storage/secret API directly.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.5.
 */

import type { ProviderId, Scope } from "@ai-agent-orchestrator/shared-core";

/**
 * Re-exports the canonical model source labels from shared-core so
 * downstream consumers (Backend, Web App, Desktop App) all agree on the
 * literal values. Per Requirement 5.5 fallback models MUST be labelled
 * distinctly from user-key models — that distinction is carried by this
 * field.
 */
export type ModelSource = "user-api-key" | "platform-fallback";

/**
 * Quality tier surfaced to the user. Optional because not every Provider
 * exposes a comparable tier; the UI groups by `qualityTier` when present
 * and falls back to provider-native ordering otherwise.
 */
export type ModelQualityTier = "basic" | "standard" | "premium";

/**
 * Model description shown in the catalog UI.
 *
 * Mirrors `ModelInfo` from `design.md` → "Model Catalog" verbatim. The
 * catalog never invents fields here — adapters are responsible for
 * populating `displayName`, `contextWindow`, etc. from Provider metadata.
 */
export interface ModelInfo {
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly displayName: string;
  readonly source: ModelSource;
  readonly qualityTier?: ModelQualityTier;
  readonly contextWindow?: number;
  readonly supportsTools?: boolean;
}

/**
 * Per-provider listing outcome. Discriminated by `status` so callers must
 * handle both branches and cannot accidentally treat an error as an empty
 * model list (which would silently hide provider failures from the UI).
 */
export type ProviderModelsResult =
  | {
      readonly provider: ProviderId;
      readonly status: "ok";
      readonly models: readonly ModelInfo[];
    }
  | {
      readonly provider: ProviderId;
      readonly status: "error";
      readonly reason: string;
    };

/**
 * Pluggable per-provider adapter. Each implementation knows how to query
 * a single Provider's "list models" endpoint and to translate the
 * response into {@link ModelInfo}.
 *
 * Contract:
 *
 *   • `provider` MUST be the same `ProviderId` used in `ModelRef.provider`
 *     so cache keys and UI grouping line up.
 *   • `listModels` MUST NOT cache; caching is a catalog-level concern so
 *     all adapters share the same TTL semantics and `invalidateProvider`
 *     behaviour.
 *   • Thrown errors are caught by the catalog and rendered as a
 *     `status: "error"` result for that provider only — they MUST NOT
 *     contain the API_Key in the message (catalog-level redaction is a
 *     defence-in-depth, but adapters should not rely on it).
 *   • Adapters that represent platform fallback options MUST return
 *     `ModelInfo` entries with `source: "platform-fallback"`. Adapters
 *     that hit a Provider via the user's key MUST return
 *     `source: "user-api-key"`.
 */
export interface ProviderModelsAdapter {
  readonly provider: ProviderId;
  /**
   * Fetches the models a user can call with `apiKey`.
   *
   * The adapter receives a decrypted key only because the catalog has to
   * make the Provider call on the user's behalf. Implementations MUST
   * treat `apiKey` as a short-lived secret: do not log it, do not store
   * it, and do not include it in returned values.
   */
  listModels(input: { readonly apiKey: string }): Promise<readonly ModelInfo[]>;
}

/**
 * Inbound port the catalog uses to obtain a decrypted API_Key for a
 * `(scope, provider)` pair.
 *
 * Real wiring happens in later tasks (6.1 stores keys, 6.3 implements
 * `resolveApiKeySecret`). The catalog accepts an injectable
 * implementation so:
 *
 *   • Production composition can plug in a `ServerComponentToken`-aware
 *     wrapper around `SettingsStore.resolveApiKeySecret`.
 *   • Tests can plug in a deterministic in-memory resolver.
 *
 * Returning `null` MUST be used to signal "no key configured for this
 * provider in this scope"; throwing MUST be used for unexpected errors
 * (network, decrypt failure, etc.). The catalog distinguishes these:
 * `null` becomes a structured `status: "error"` with a no-key reason,
 * a thrown error becomes a structured `status: "error"` with the
 * resolver's failure message.
 */
export interface ApiKeyResolver {
  resolveApiKey(scope: Scope, provider: ProviderId): Promise<string | null>;
}

/**
 * Default short TTL for cache entries (60 seconds), matching the design
 * note that "Results can be cached for a short TTL, for example 60
 * seconds." Tasks that want a different value can pass `ttlMs` to the
 * `ModelCatalog` constructor — for example tests use a much smaller
 * value.
 */
export const DEFAULT_MODEL_CATALOG_TTL_MS = 60_000;
