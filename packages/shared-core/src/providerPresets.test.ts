/**
 * Provider preset registry tests.
 *
 * Pins the contract every other layer (login screen, client SDK,
 * model catalog, agent runtime) reads off:
 *
 *   • Fireworks AI is registered with the right baseUrl and shape.
 *   • Custom OpenAI-compatible preset exists and demands a user
 *     baseUrl.
 *   • `findProviderPreset` is total over the registry.
 *   • `resolveBaseUrl` enforces the "Custom requires user override"
 *     rule and trims trailing slashes.
 *   • `joinProviderPath` builds well-formed URLs.
 *
 * Validates: Requirements 2.1, 2.2, 5.1.
 */

import { describe, expect, it } from "vitest";

import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  findProviderPreset,
  joinProviderPath,
  resolveBaseUrl,
} from "./providerPresets.js";

describe("PROVIDER_PRESETS", () => {
  it("includes OpenAI, Anthropic, Fireworks AI and Custom OpenAI-compatible", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("fireworks");
    expect(ids).toContain(CUSTOM_PROVIDER_ID);
  });

  it("Fireworks AI uses the correct baseUrl, shape and auth style", () => {
    const fw = findProviderPreset("fireworks");
    expect(fw).toBeDefined();
    expect(fw!.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
    expect(fw!.apiShape).toBe("openai-compatible");
    expect(fw!.authStyle).toBe("bearer");
    expect(fw!.listModelsPath).toBe("/models");
    expect(fw!.chatCompletionsPath).toBe("/chat/completions");
    // Fireworks must require the user to supply / confirm a model id.
    expect(fw!.requiresUserModelId).toBe(true);
    // …but not require them to supply a baseUrl (it's well-known).
    expect(fw!.requiresUserBaseUrl).toBe(false);
  });

  it("Custom preset has empty baseUrl and demands a user override", () => {
    const c = findProviderPreset(CUSTOM_PROVIDER_ID);
    expect(c).toBeDefined();
    expect(c!.baseUrl).toBe("");
    expect(c!.requiresUserBaseUrl).toBe(true);
    expect(c!.requiresUserModelId).toBe(true);
    expect(c!.apiShape).toBe("openai-compatible");
  });

  it("OpenAI and Anthropic do not require user baseUrl or modelId", () => {
    const oai = findProviderPreset("openai")!;
    const anthr = findProviderPreset("anthropic")!;
    expect(oai.requiresUserBaseUrl).toBe(false);
    expect(oai.requiresUserModelId).toBe(false);
    expect(anthr.requiresUserBaseUrl).toBe(false);
    expect(anthr.requiresUserModelId).toBe(false);
    // Anthropic uses x-api-key style.
    expect(anthr.authStyle).toBe("x-api-key");
  });
});

describe("findProviderPreset", () => {
  it("returns undefined for unknown ids", () => {
    expect(findProviderPreset("not-a-provider")).toBeUndefined();
  });
});

describe("resolveBaseUrl", () => {
  it("returns the preset baseUrl when user override is empty for well-known presets", () => {
    expect(resolveBaseUrl("openai", null)).toBe("https://api.openai.com/v1");
    expect(resolveBaseUrl("openai", "")).toBe("https://api.openai.com/v1");
    expect(resolveBaseUrl("fireworks", null)).toBe(
      "https://api.fireworks.ai/inference/v1",
    );
  });

  it("returns null for Custom presets when no user override is supplied", () => {
    expect(resolveBaseUrl(CUSTOM_PROVIDER_ID, null)).toBeNull();
    expect(resolveBaseUrl(CUSTOM_PROVIDER_ID, "")).toBeNull();
    expect(resolveBaseUrl(CUSTOM_PROVIDER_ID, "   ")).toBeNull();
  });

  it("strips a trailing slash from the user override", () => {
    expect(
      resolveBaseUrl(CUSTOM_PROVIDER_ID, "https://gw.example.com/v1/"),
    ).toBe("https://gw.example.com/v1");
  });

  it("user override takes precedence over the preset default", () => {
    expect(resolveBaseUrl("openai", "https://staging.openai.example/v1")).toBe(
      "https://staging.openai.example/v1",
    );
  });
});

describe("joinProviderPath", () => {
  it("composes baseUrl and relative path with a single slash", () => {
    expect(joinProviderPath("https://api.example.com/v1", "/models")).toBe(
      "https://api.example.com/v1/models",
    );
    expect(joinProviderPath("https://api.example.com/v1/", "/models")).toBe(
      "https://api.example.com/v1/models",
    );
    expect(joinProviderPath("https://api.example.com/v1", "models")).toBe(
      "https://api.example.com/v1/models",
    );
  });
});
