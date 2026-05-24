/**
 * Model Catalog implementation.
 *
 * Source: `design.md` → "Model Catalog" → "Rules":
 *
 *   • Each provider is queried independently.
 *   • Failure of one provider must not block other providers.
 *   • Results can be cached for a short TTL, for example 60 seconds.
 *   • Cache must be invalidated when API_Key changes.
 *   • Platform fallback models must be clearly labelled.
 *   • Fallback models must not silently replace user's chosen model.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.5.
 *
 * Design notes:
 *
 *   • Adapters are passed in by the host (composition root). The catalog
 *     does not know about OpenAI/Anthropic specifics — it just asks each
 *     adapter for its list and aggregates. This is what lets task 7.1
 *     ship without depending on tasks 6.1/6.3, and what lets later tasks
 *     extend the catalog by registering new adapters.
 *   • Failure isolation is implemented with `Promise.allSettled` so a
 *     thrown error or a rejected promise in one adapter never affects
 *     another. Even within a single adapter run, three distinct failure
 *     modes are surfaced as a `status: "error"` provider entry rather
 *     than a thrown exception:
 *       (a) `ApiKeyResolver` returns `null` (no key configured),
 *       (b) `ApiKeyResolver` throws (resolver failed),
 *       (c) the adapter throws (Provider API failed).
 *   • The cache is keyed by `(scope kind + scope id + provider)`. Local
 *     and cloud scopes are isolated, and one user's invalidation cannot
 *     evict another's cached results. `invalidateProvider` is the
 *     hook task 6.1 calls when a key changes.
 *   • The cache stores the structured `ProviderModelsResult` so error
 *     entries do not get retried at every call (Provider list endpoints
 *     can be rate-limited). The TTL still bounds error cache age, and
 *     `invalidateProvider` clears immediately on key changes.
 */

import type {
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";

import type {
  ApiKeyResolver,
  ModelInfo,
  ProviderModelsAdapter,
  ProviderModelsResult,
} from "./types.js";
import { DEFAULT_MODEL_CATALOG_TTL_MS } from "./types.js";

/**
 * Options accepted by {@link ModelCatalog}.
 */
export interface ModelCatalogOptions {
  /** Pluggable per-provider adapters. Order is preserved in results. */
  readonly adapters: readonly ProviderModelsAdapter[];
  /**
   * Inbound port for fetching a decrypted API_Key. Composition wires
   * this to `SettingsStore.resolveApiKeySecret` (task 6.3); tests pass
   * a stub.
   */
  readonly apiKeyResolver: ApiKeyResolver;
  /**
   * Cache TTL in milliseconds. Defaults to
   * {@link DEFAULT_MODEL_CATALOG_TTL_MS} (60 seconds) per the design.
   */
  readonly ttlMs?: number;
  /**
   * Clock used for cache expiry. Tests pass a deterministic clock; in
   * production the default `Date.now` is used.
   */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly value: ProviderModelsResult;
  readonly expiresAt: number;
}

/**
 * In-process Model Catalog.
 *
 * One instance is intended per backend process. Cache entries live in
 * memory; restarting the backend wipes them, which is acceptable for the
 * 60-second TTL design note.
 */
export class ModelCatalog {
  private readonly adapters: readonly ProviderModelsAdapter[];
  private readonly apiKeyResolver: ApiKeyResolver;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  public constructor(options: ModelCatalogOptions) {
    if (options.adapters.length === 0) {
      // The catalog is still callable with zero adapters — it just
      // returns an empty array — but this is almost certainly a wiring
      // bug, so flag it loudly. Throwing here keeps the failure visible
      // in tests and at startup, not at first user-facing call.
      throw new Error(
        "ModelCatalog requires at least one ProviderModelsAdapter",
      );
    }
    // Detect duplicate provider IDs early; otherwise the cache key
    // collisions would silently overwrite results.
    const seen = new Set<ProviderId>();
    for (const a of options.adapters) {
      if (seen.has(a.provider)) {
        throw new Error(
          `ModelCatalog received duplicate adapter for provider "${a.provider}"`,
        );
      }
      seen.add(a.provider);
    }

    this.adapters = options.adapters;
    this.apiKeyResolver = options.apiKeyResolver;
    this.ttlMs = options.ttlMs ?? DEFAULT_MODEL_CATALOG_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Returns one {@link ProviderModelsResult} per configured adapter,
   * preserving adapter order.
   *
   * Per Requirement 5.3, a provider failure surfaces as a single
   * `status: "error"` entry without removing other providers' results.
   * Per Requirement 5.5 each model carries `source: "user-api-key"` or
   * `source: "platform-fallback"` exactly as the adapter reports — the
   * catalog never relabels.
   */
  public async listModelsForUser(
    scope: Scope,
  ): Promise<ProviderModelsResult[]> {
    const settled = await Promise.allSettled(
      this.adapters.map((adapter) => this.runForProvider(scope, adapter)),
    );

    return settled.map((s, i) => {
      // `runForProvider` is written so it never throws — every error
      // path returns a structured `status: "error"`. The defensive
      // branch below exists purely so a future bug that does throw
      // still cannot poison sibling provider results.
      if (s.status === "fulfilled") {
        return s.value;
      }
      const adapter = this.adapters[i];
      // The duplicate/zero-adapter checks in the constructor guarantee
      // every index has a matching adapter, but `noUncheckedIndexedAccess`
      // forces us to widen the type here.
      const provider: ProviderId = adapter ? adapter.provider : "unknown";
      return {
        provider,
        status: "error",
        reason: describeUnexpectedError(s.reason),
      };
    });
  }

  /**
   * Drops cached results for `(scope, provider)`. Task 6.1 must call this
   * whenever an API_Key for that provider is added, updated or removed
   * so a stale model list does not survive a key change.
   *
   * Calls for unknown `(scope, provider)` pairs are no-ops; this matches
   * the design note about delete-success behaviour and keeps the
   * settings-store flow free of extra error handling.
   */
  public invalidateProvider(scope: Scope, provider: ProviderId): void {
    this.cache.delete(cacheKey(scope, provider));
  }

  /**
   * Drops every cached entry for `scope`. Useful when the user signs out,
   * upgrades a local session to a cloud session, or rotates every key
   * at once.
   */
  public invalidateScope(scope: Scope): void {
    const prefix = scopePrefix(scope);
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Test/diagnostics only — visible cache size. */
  public cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Per-provider pipeline.
   *
   * 1. Return a fresh cache entry if available.
   * 2. Resolve the API key. `null` ⇒ "not configured" error result.
   *    Thrown ⇒ "key resolver failed" error result.
   * 3. Call the adapter. Thrown ⇒ "provider failed" error result.
   * 4. Cache and return whatever result we built.
   *
   * This function is intentionally `try/catch`-heavy at every boundary
   * because Requirement 5.3 forbids one provider's bad day from blocking
   * others.
   */
  private async runForProvider(
    scope: Scope,
    adapter: ProviderModelsAdapter,
  ): Promise<ProviderModelsResult> {
    const key = cacheKey(scope, adapter.provider);
    const cached = this.cache.get(key);
    const now = this.now();
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.value;
    }

    const result = await this.fetchForProvider(scope, adapter);
    this.cache.set(key, {
      value: result,
      expiresAt: now + this.ttlMs,
    });
    return result;
  }

  private async fetchForProvider(
    scope: Scope,
    adapter: ProviderModelsAdapter,
  ): Promise<ProviderModelsResult> {
    let apiKey: string | null;
    try {
      apiKey = await this.apiKeyResolver.resolveApiKey(
        scope,
        adapter.provider,
      );
    } catch (err) {
      return {
        provider: adapter.provider,
        status: "error",
        reason: `Failed to resolve API key: ${describeUnexpectedError(err)}`,
      };
    }

    if (apiKey === null) {
      return {
        provider: adapter.provider,
        status: "error",
        reason: "No API key configured for this provider",
      };
    }

    let models: readonly ModelInfo[];
    try {
      models = await adapter.listModels({ apiKey });
    } catch (err) {
      return {
        provider: adapter.provider,
        status: "error",
        reason: describeUnexpectedError(err),
      };
    }

    // Defensive: ensure the adapter did not relabel models for a
    // different provider. This catches misconfigured adapters early.
    for (const m of models) {
      if (m.provider !== adapter.provider) {
        return {
          provider: adapter.provider,
          status: "error",
          reason: `Adapter for "${adapter.provider}" returned a model labelled "${m.provider}"`,
        };
      }
    }

    return {
      provider: adapter.provider,
      status: "ok",
      models,
    };
  }
}

/**
 * Cache key shape: `<scope-kind>:<scope-id>::<provider>`. The double
 * colon separates the scope half from the provider half so a provider
 * that contains `:` cannot collide with a different `(scope, provider)`
 * pair.
 */
function cacheKey(scope: Scope, provider: ProviderId): string {
  return `${scopePrefix(scope)}${provider}`;
}

function scopePrefix(scope: Scope): string {
  switch (scope.kind) {
    case "local":
      return `local:${scope.deviceId}::`;
    case "cloud":
      return `cloud:${scope.userId}::`;
  }
}

/**
 * Renders an unknown error value as a short, key-free string. Adapter
 * code is trusted not to embed secrets, but this still strips structured
 * payloads in case a future adapter passes one through.
 */
function describeUnexpectedError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || "Unknown error";
  }
  if (typeof err === "string") {
    return err;
  }
  return "Unknown error";
}
