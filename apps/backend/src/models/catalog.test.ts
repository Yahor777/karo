/**
 * Unit tests for {@link ModelCatalog}.
 *
 * Covers the four design rules called out in task 7.1:
 *   • per-provider isolation (Requirement 5.3),
 *   • TTL caching of both ok and error results (Requirement 5.1),
 *   • cache invalidation on key change (Requirement 5.1),
 *   • fallback labelling preserved end-to-end (Requirement 5.5).
 *
 * The companion property test for Provider isolation lives in task 7.3
 * and is intentionally not duplicated here.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.5.
 */

import { describe, expect, it } from "vitest";

import type {
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";

import {
  type ApiKeyResolver,
  type ModelInfo,
  type ProviderModelsAdapter,
  ModelCatalog,
} from "./index.js";

/** Builds a deterministic local scope for tests. */
function localScope(deviceId = "device-1"): Scope {
  return { kind: "local", deviceId };
}

function cloudScope(userId = "user-1"): Scope {
  return { kind: "cloud", userId };
}

/** Mutable resolver that lets tests script per-provider responses. */
class StubApiKeyResolver implements ApiKeyResolver {
  public calls: Array<{ scope: Scope; provider: ProviderId }> = [];
  private readonly keys = new Map<string, string | null>();
  private readonly throwers = new Map<string, Error>();

  public set(provider: ProviderId, value: string | null): void {
    this.keys.set(provider, value);
  }

  public throwFor(provider: ProviderId, err: Error): void {
    this.throwers.set(provider, err);
  }

  public async resolveApiKey(
    scope: Scope,
    provider: ProviderId,
  ): Promise<string | null> {
    this.calls.push({ scope, provider });
    const t = this.throwers.get(provider);
    if (t) throw t;
    return this.keys.get(provider) ?? null;
  }
}

/** Adapter that returns a fixed list and counts invocations. */
class StubAdapter implements ProviderModelsAdapter {
  public listCalls = 0;
  public lastApiKey: string | null = null;
  public constructor(
    public readonly provider: ProviderId,
    private readonly response: readonly ModelInfo[] | (() => never),
  ) {}

  public async listModels(input: {
    readonly apiKey: string;
  }): Promise<readonly ModelInfo[]> {
    this.listCalls += 1;
    this.lastApiKey = input.apiKey;
    if (typeof this.response === "function") {
      this.response();
    }
    return this.response;
  }
}

function userModel(provider: ProviderId, modelId: string): ModelInfo {
  return {
    provider,
    modelId,
    displayName: modelId,
    source: "user-api-key",
  };
}

function fallbackModel(provider: ProviderId, modelId: string): ModelInfo {
  return {
    provider,
    modelId,
    displayName: modelId,
    source: "platform-fallback",
    qualityTier: "basic",
  };
}

describe("ModelCatalog", () => {
  it("rejects construction with no adapters", () => {
    expect(
      () =>
        new ModelCatalog({
          adapters: [],
          apiKeyResolver: new StubApiKeyResolver(),
        }),
    ).toThrow(/at least one/i);
  });

  it("rejects duplicate adapters for the same provider", () => {
    expect(
      () =>
        new ModelCatalog({
          adapters: [
            new StubAdapter("openai", []),
            new StubAdapter("openai", []),
          ],
          apiKeyResolver: new StubApiKeyResolver(),
        }),
    ).toThrow(/duplicate adapter/i);
  });

  it("returns ok results from each provider in adapter order", async () => {
    const resolver = new StubApiKeyResolver();
    resolver.set("openai", "sk-openai");
    resolver.set("anthropic", "sk-anthropic");

    const openai = new StubAdapter("openai", [userModel("openai", "gpt-4o")]);
    const anthropic = new StubAdapter("anthropic", [
      userModel("anthropic", "claude-3-5-sonnet"),
    ]);
    const catalog = new ModelCatalog({
      adapters: [openai, anthropic],
      apiKeyResolver: resolver,
    });

    const out = await catalog.listModelsForUser(localScope());
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ provider: "openai", status: "ok" });
    expect(out[1]).toMatchObject({ provider: "anthropic", status: "ok" });
    expect(openai.lastApiKey).toBe("sk-openai");
    expect(anthropic.lastApiKey).toBe("sk-anthropic");
  });

  it("isolates one provider's failure from another (Requirement 5.3)", async () => {
    const resolver = new StubApiKeyResolver();
    resolver.set("openai", "sk-openai");
    resolver.set("anthropic", "sk-anthropic");

    const openai = new StubAdapter("openai", [userModel("openai", "gpt-4o")]);
    const anthropic = new StubAdapter("anthropic", () => {
      throw new Error("provider down");
    });
    const catalog = new ModelCatalog({
      adapters: [openai, anthropic],
      apiKeyResolver: resolver,
    });

    const out = await catalog.listModelsForUser(localScope());
    expect(out[0]).toMatchObject({ provider: "openai", status: "ok" });
    expect(out[1]).toEqual({
      provider: "anthropic",
      status: "error",
      reason: "provider down",
    });
  });

  it("surfaces a missing API key as a structured error", async () => {
    const resolver = new StubApiKeyResolver();
    // openai key absent on purpose.
    resolver.set("anthropic", "sk-anthropic");
    const openai = new StubAdapter("openai", [userModel("openai", "gpt-4o")]);
    const anthropic = new StubAdapter("anthropic", [
      userModel("anthropic", "claude"),
    ]);
    const catalog = new ModelCatalog({
      adapters: [openai, anthropic],
      apiKeyResolver: resolver,
    });

    const out = await catalog.listModelsForUser(localScope());
    expect(out[0]).toMatchObject({
      provider: "openai",
      status: "error",
    });
    if (out[0]?.status === "error") {
      expect(out[0].reason).toMatch(/no api key/i);
    }
    expect(openai.listCalls).toBe(0);
    expect(out[1]).toMatchObject({ provider: "anthropic", status: "ok" });
  });

  it("treats resolver failures as provider errors, not fatal", async () => {
    const resolver = new StubApiKeyResolver();
    resolver.throwFor("openai", new Error("kms unreachable"));
    resolver.set("anthropic", "sk-anthropic");
    const openai = new StubAdapter("openai", []);
    const anthropic = new StubAdapter("anthropic", [
      userModel("anthropic", "claude"),
    ]);
    const catalog = new ModelCatalog({
      adapters: [openai, anthropic],
      apiKeyResolver: resolver,
    });

    const out = await catalog.listModelsForUser(localScope());
    expect(out[0]).toEqual({
      provider: "openai",
      status: "error",
      reason: "Failed to resolve API key: kms unreachable",
    });
    expect(out[1]).toMatchObject({ provider: "anthropic", status: "ok" });
  });

  it("preserves source labels including platform-fallback (Requirement 5.5)", async () => {
    const resolver = new StubApiKeyResolver();
    resolver.set("openai", "sk-openai");
    resolver.set("platform", "platform-token");

    const openai = new StubAdapter("openai", [userModel("openai", "gpt-4o")]);
    const platform = new StubAdapter("platform", [
      fallbackModel("platform", "free-tier"),
    ]);
    const catalog = new ModelCatalog({
      adapters: [openai, platform],
      apiKeyResolver: resolver,
    });

    const out = await catalog.listModelsForUser(localScope());
    if (out[0]?.status === "ok") {
      expect(out[0].models[0]?.source).toBe("user-api-key");
    } else {
      throw new Error("expected openai ok");
    }
    if (out[1]?.status === "ok") {
      expect(out[1].models[0]?.source).toBe("platform-fallback");
      expect(out[1].models[0]?.qualityTier).toBe("basic");
    } else {
      throw new Error("expected platform ok");
    }
  });

  it("rejects a misbehaving adapter that mislabels the provider", async () => {
    const resolver = new StubApiKeyResolver();
    resolver.set("openai", "sk-openai");
    const openai = new StubAdapter("openai", [
      userModel("anthropic", "claude"), // wrong provider!
    ]);
    const catalog = new ModelCatalog({
      adapters: [openai],
      apiKeyResolver: resolver,
    });
    const out = await catalog.listModelsForUser(localScope());
    expect(out[0]).toMatchObject({ provider: "openai", status: "error" });
  });

  it("caches results within the TTL and skips redundant adapter/resolver calls", async () => {
    const resolver = new StubApiKeyResolver();
    resolver.set("openai", "sk");
    const openai = new StubAdapter("openai", [userModel("openai", "gpt-4o")]);

    let now = 1_000;
    const catalog = new ModelCatalog({
      adapters: [openai],
      apiKeyResolver: resolver,
      ttlMs: 60_000,
      now: () => now,
    });

    await catalog.listModelsForUser(localScope());
    await catalog.listModelsForUser(localScope());
    expect(openai.listCalls).toBe(1);
    expect(resolver.calls).toHaveLength(1);

    // Advance past TTL — should refetch.
    now += 60_001;
    await catalog.listModelsForUser(localScope());
    expect(openai.listCalls).toBe(2);
  });

  it("caches error entries too so failing providers are not hammered", async () => {
    const resolver = new StubApiKeyResolver();
    resolver.set("openai", "sk");
    let invocations = 0;
    const openai = new StubAdapter("openai", () => {
      invocations += 1;
      throw new Error("rate-limited");
    });
    const catalog = new ModelCatalog({
      adapters: [openai],
      apiKeyResolver: resolver,
      ttlMs: 60_000,
      now: () => 1_000,
    });

    await catalog.listModelsForUser(localScope());
    await catalog.listModelsForUser(localScope());
    await catalog.listModelsForUser(localScope());
    expect(invocations).toBe(1);
  });

  it("invalidateProvider drops cached entries for that scope+provider only", async () => {
    const resolver = new StubApiKeyResolver();
    resolver.set("openai", "sk-1");
    resolver.set("anthropic", "sk-a");
    const openai = new StubAdapter("openai", [userModel("openai", "gpt-4o")]);
    const anthropic = new StubAdapter("anthropic", [
      userModel("anthropic", "claude"),
    ]);
    const catalog = new ModelCatalog({
      adapters: [openai, anthropic],
      apiKeyResolver: resolver,
    });

    const scope = localScope();
    await catalog.listModelsForUser(scope);
    expect(openai.listCalls).toBe(1);
    expect(anthropic.listCalls).toBe(1);

    catalog.invalidateProvider(scope, "openai");

    await catalog.listModelsForUser(scope);
    expect(openai.listCalls).toBe(2); // refetched
    expect(anthropic.listCalls).toBe(1); // still cached
  });

  it("invalidateProvider for a different scope does not affect this one", async () => {
    const resolver = new StubApiKeyResolver();
    resolver.set("openai", "sk-1");
    const openai = new StubAdapter("openai", [userModel("openai", "gpt-4o")]);
    const catalog = new ModelCatalog({
      adapters: [openai],
      apiKeyResolver: resolver,
    });

    const a = localScope("device-A");
    const b = localScope("device-B");
    await catalog.listModelsForUser(a);
    await catalog.listModelsForUser(b);
    expect(openai.listCalls).toBe(2);

    catalog.invalidateProvider(b, "openai");
    await catalog.listModelsForUser(a);
    expect(openai.listCalls).toBe(2); // a still cached
    await catalog.listModelsForUser(b);
    expect(openai.listCalls).toBe(3); // b refetched
  });

  it("invalidateProvider on an unknown entry is a no-op", () => {
    const resolver = new StubApiKeyResolver();
    const catalog = new ModelCatalog({
      adapters: [new StubAdapter("openai", [])],
      apiKeyResolver: resolver,
    });
    expect(() =>
      catalog.invalidateProvider(localScope(), "openai"),
    ).not.toThrow();
  });

  it("invalidateScope drops every entry under that scope, leaving others", async () => {
    const resolver = new StubApiKeyResolver();
    resolver.set("openai", "sk-1");
    resolver.set("anthropic", "sk-a");
    const openai = new StubAdapter("openai", [userModel("openai", "gpt-4o")]);
    const anthropic = new StubAdapter("anthropic", [
      userModel("anthropic", "claude"),
    ]);
    const catalog = new ModelCatalog({
      adapters: [openai, anthropic],
      apiKeyResolver: resolver,
    });

    const local = localScope();
    const cloud = cloudScope();
    await catalog.listModelsForUser(local);
    await catalog.listModelsForUser(cloud);
    expect(catalog.cacheSize()).toBe(4);

    catalog.invalidateScope(local);
    expect(catalog.cacheSize()).toBe(2);

    // Cloud entries still serve from cache.
    await catalog.listModelsForUser(cloud);
    expect(openai.listCalls).toBe(2); // local + cloud, no refetch from cloud
    expect(anthropic.listCalls).toBe(2);
  });

  it("never lets a single provider's exception throw out of listModelsForUser", async () => {
    const resolver = new StubApiKeyResolver();
    resolver.set("openai", "sk-1");
    resolver.set("anthropic", "sk-a");
    const openai = new StubAdapter("openai", () => {
      throw new Error("boom");
    });
    const anthropic = new StubAdapter("anthropic", () => {
      // Adapter that throws a non-Error value to verify ModelCatalog
      // surfaces it as an isolation failure rather than crashing.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "non-error string";
    });
    const catalog = new ModelCatalog({
      adapters: [openai, anthropic],
      apiKeyResolver: resolver,
    });

    const out = await catalog.listModelsForUser(localScope());
    expect(out[0]).toEqual({
      provider: "openai",
      status: "error",
      reason: "boom",
    });
    expect(out[1]).toEqual({
      provider: "anthropic",
      status: "error",
      reason: "non-error string",
    });
  });
});
