/**
 * Unit tests for the Cloud_Settings_Store (task 17.2).
 *
 * Covers:
 *   • Round-trip per cloud-scoped collection: api_keys, custom_agents,
 *     preferences. Each `upsert/set/get/remove/list` call goes through the
 *     cloud-scoped façade and observes the value via the public listing
 *     surface (no backend-internal peeking on the happy path).
 *   • Isolation between users: two distinct `userId`s cannot observe each
 *     other's records on any of the three collections, even when both are
 *     served by the same cloud-store instance backed by the same
 *     persistent store (the production case).
 *   • Encrypted-blob persistence for API keys: the underlying record kept
 *     by the in-memory backend MUST be a `ciphertext`-bearing
 *     `EncryptedBlob` and MUST NOT contain the plaintext anywhere in its
 *     serialization. This is the task-17.2 "encrypted at rest" assertion
 *     (Requirement 3.7).
 *   • Second-device-login restoration: a fresh `CloudSettingsStore`
 *     instance built over the SAME backends as the original instance —
 *     i.e. simulating a second device that has never seen the user
 *     before — returns the user's previously-stored API key metadata,
 *     custom agents, and preferences via `loadSettingsForSession`
 *     (Requirement 3.4).
 *
 * Validates: Requirements 3.3, 3.4, 3.7.
 */

import { describe, expect, it } from "vitest";

import type { EncryptedBlob, SecretCipher } from "./types.js";

import type {
  CloudSettingsStore} from "./cloudSettingsStore.js";
import {
  createInMemoryCloudSettingsStore,
} from "./cloudSettingsStore.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Reversible base64 cipher. Round-trips through Buffer so the encrypted-blob
 * test can assert that:
 *   • the persisted blob is structurally an `EncryptedBlob` (not the raw
 *     string), AND
 *   • the plaintext bytes do not appear anywhere in the serialized record.
 *
 * Determinism is not required here — we never assert on a specific
 * ciphertext value. We only assert on absence of plaintext and presence
 * of the `EncryptedBlob` shape.
 */
class StubCipher implements SecretCipher {
  public encryptCalls = 0;
  public decryptCalls = 0;

  public async encrypt(plaintext: string): Promise<EncryptedBlob> {
    this.encryptCalls += 1;
    return {
      algorithm: "stub.v1",
      // Base64 is deliberate: it disguises the plaintext bytes inside the
      // ciphertext field so a naive substring check would still trip if
      // someone accidentally also stored the raw plaintext alongside.
      ciphertext: Buffer.from(plaintext, "utf8").toString("base64"),
      createdAt: "2025-01-01T00:00:00.000Z",
    };
  }

  public async decrypt(blob: EncryptedBlob): Promise<string> {
    this.decryptCalls += 1;
    return Buffer.from(blob.ciphertext, "base64").toString("utf8");
  }
}

// ---------------------------------------------------------------------------
// Round-trip per collection
// ---------------------------------------------------------------------------

describe("CloudSettingsStore — round-trip per collection", () => {
  it("api_keys: upsert is observable through listApiKeyMetadata", async () => {
    const { store } = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });

    await store.upsertApiKey("user-A", {
      provider: "openai",
      apiKey: "sk-aaa-secret-value-1",
    });
    await store.upsertApiKey("user-A", {
      provider: "anthropic",
      apiKey: "sk-bbb-secret-value-2",
    });

    const metadata = await store.listApiKeyMetadata("user-A");
    expect(metadata.map((m) => m.provider).sort()).toEqual(["anthropic", "openai"]);
    for (const entry of metadata) {
      expect(entry.fingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(entry.createdAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }
  });

  it("api_keys: removeApiKey resolves successfully and erases from listing", async () => {
    const { store } = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });
    await store.upsertApiKey("user-A", { provider: "openai", apiKey: "sk-x" });
    await expect(store.removeApiKey("user-A", "openai")).resolves.toBeUndefined();
    await expect(store.listApiKeyMetadata("user-A")).resolves.toEqual([]);
    // Removing again still resolves (Requirement 4.4).
    await expect(store.removeApiKey("user-A", "openai")).resolves.toBeUndefined();
  });

  it("custom_agents: upsert is observable through listCustomAgents", async () => {
    const { store } = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });

    const agent = await store.upsertCustomAgent("user-A", {
      name: "Architect",
      systemPrompt: "You are an architect.",
      allowedTools: ["web_search"],
    });

    expect(agent.id.length).toBeGreaterThan(0);
    expect(agent.kind).toBe("custom");
    expect(agent.ownerScope).toEqual({ kind: "cloud", userId: "user-A" });

    const list = await store.listCustomAgents("user-A");
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(agent);
  });

  it("custom_agents: removeCustomAgent erases from listing", async () => {
    const { store } = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });
    const agent = await store.upsertCustomAgent("user-A", {
      name: "Architect",
      systemPrompt: "You are an architect.",
      allowedTools: [],
    });
    await store.removeCustomAgent("user-A", agent.id);
    await expect(store.listCustomAgents("user-A")).resolves.toEqual([]);
  });

  it("preferences: set / get / remove / list round-trip", async () => {
    const { store } = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });

    await store.setPreference("user-A", "theme", "dark");
    await store.setPreference("user-A", "default_model", {
      provider: "openai",
      modelId: "gpt-4",
    });

    await expect(store.getPreference("user-A", "theme")).resolves.toBe("dark");
    await expect(store.getPreference("user-A", "default_model")).resolves.toEqual({
      provider: "openai",
      modelId: "gpt-4",
    });

    await expect(store.listPreferences("user-A")).resolves.toEqual({
      theme: "dark",
      default_model: { provider: "openai", modelId: "gpt-4" },
    });

    await expect(store.removePreference("user-A", "theme")).resolves.toBe(true);
    await expect(store.getPreference("user-A", "theme")).resolves.toBeUndefined();
    // Removing absent key returns false.
    await expect(store.removePreference("user-A", "theme")).resolves.toBe(false);
  });

  it("preferences: stored values are deep-cloned (no shared references)", async () => {
    const { store } = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });
    const value = { nested: { count: 1 } };
    await store.setPreference("user-A", "deep", value);

    // Mutating the original after-the-fact must not change persisted state.
    value.nested.count = 999;
    const observed = (await store.getPreference("user-A", "deep")) as {
      nested: { count: number };
    };
    expect(observed.nested.count).toBe(1);

    // Mutating the returned snapshot must not affect future reads either.
    observed.nested.count = -1;
    const reread = (await store.getPreference("user-A", "deep")) as {
      nested: { count: number };
    };
    expect(reread.nested.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Isolation between users
// ---------------------------------------------------------------------------

describe("CloudSettingsStore — isolation between users", () => {
  it("two userIds do not observe each other's API keys", async () => {
    const { store } = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });
    await store.upsertApiKey("alice", { provider: "openai", apiKey: "sk-alice" });
    await store.upsertApiKey("bob", { provider: "anthropic", apiKey: "sk-bob" });

    await expect(store.listApiKeyMetadata("alice")).resolves.toEqual([
      expect.objectContaining({ provider: "openai" }),
    ]);
    await expect(store.listApiKeyMetadata("bob")).resolves.toEqual([
      expect.objectContaining({ provider: "anthropic" }),
    ]);
    // Removing alice's key must not affect bob's.
    await store.removeApiKey("alice", "openai");
    await expect(store.listApiKeyMetadata("alice")).resolves.toEqual([]);
    await expect(store.listApiKeyMetadata("bob")).resolves.toHaveLength(1);
  });

  it("two userIds do not observe each other's custom agents", async () => {
    const { store } = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });
    await store.upsertCustomAgent("alice", {
      name: "Architect",
      systemPrompt: "Alice's agent.",
      allowedTools: [],
    });
    await store.upsertCustomAgent("bob", {
      name: "Reviewer-Pro",
      systemPrompt: "Bob's agent.",
      allowedTools: ["file_read"],
    });

    const aliceAgents = await store.listCustomAgents("alice");
    const bobAgents = await store.listCustomAgents("bob");
    expect(aliceAgents.map((a) => a.name)).toEqual(["Architect"]);
    expect(bobAgents.map((a) => a.name)).toEqual(["Reviewer-Pro"]);
  });

  it("two userIds do not observe each other's preferences", async () => {
    const { store } = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });
    await store.setPreference("alice", "theme", "dark");
    await store.setPreference("bob", "theme", "light");

    await expect(store.getPreference("alice", "theme")).resolves.toBe("dark");
    await expect(store.getPreference("bob", "theme")).resolves.toBe("light");

    // Removing alice's preference must not touch bob's.
    await store.removePreference("alice", "theme");
    await expect(store.getPreference("alice", "theme")).resolves.toBeUndefined();
    await expect(store.getPreference("bob", "theme")).resolves.toBe("light");
  });

  it("loadSettingsForSession returns only the requested user's records", async () => {
    const { store } = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });

    await store.upsertApiKey("alice", { provider: "openai", apiKey: "sk-alice" });
    await store.upsertCustomAgent("alice", {
      name: "Architect",
      systemPrompt: "Alice's agent.",
      allowedTools: [],
    });
    await store.setPreference("alice", "theme", "dark");

    await store.upsertApiKey("bob", { provider: "anthropic", apiKey: "sk-bob" });
    await store.setPreference("bob", "theme", "light");

    const aliceSettings = await store.loadSettingsForSession({ userId: "alice" });
    expect(aliceSettings.apiKeys.map((k) => k.provider)).toEqual(["openai"]);
    expect(aliceSettings.customAgents.map((a) => a.name)).toEqual(["Architect"]);
    expect(aliceSettings.preferences).toEqual({ theme: "dark" });

    const bobSettings = await store.loadSettingsForSession({ userId: "bob" });
    expect(bobSettings.apiKeys.map((k) => k.provider)).toEqual(["anthropic"]);
    expect(bobSettings.customAgents).toEqual([]);
    expect(bobSettings.preferences).toEqual({ theme: "light" });
  });
});

// ---------------------------------------------------------------------------
// Encrypted-blob persistence (Requirement 3.7)
// ---------------------------------------------------------------------------

describe("CloudSettingsStore — encrypted secret fields", () => {
  it("persists API keys as EncryptedBlob and never as plaintext", async () => {
    const cipher = new StubCipher();
    const { store, apiKeyBackend } = createInMemoryCloudSettingsStore({ cipher });

    const PLAINTEXT = "sk-super-secret-cloud-value-xyz";
    await store.upsertApiKey("user-A", { provider: "openai", apiKey: PLAINTEXT });

    // The cipher MUST have run on the write path.
    expect(cipher.encryptCalls).toBe(1);

    const records = await apiKeyBackend.list({ kind: "cloud", userId: "user-A" });
    expect(records).toHaveLength(1);
    const record = records[0]!;

    // Structural shape: encryptedKey is an EncryptedBlob.
    expect(record.encryptedKey).toEqual(
      expect.objectContaining({
        algorithm: expect.any(String),
        ciphertext: expect.any(String),
        createdAt: expect.any(String),
      }),
    );
    expect(typeof record.encryptedKey.ciphertext).toBe("string");
    expect(record.encryptedKey.ciphertext.length).toBeGreaterThan(0);
    // Cipher must NOT echo plaintext; algorithm tag is fixed to the stub.
    expect(record.encryptedKey.algorithm).toBe("stub.v1");

    // Absence of plaintext anywhere in the serialized record.
    const serialized = JSON.stringify(record);
    expect(serialized.includes(PLAINTEXT)).toBe(false);

    // The ciphertext is recoverable through the cipher; this confirms the
    // value really was wrapped (not, e.g., set to the empty string).
    await expect(cipher.decrypt(record.encryptedKey)).resolves.toBe(PLAINTEXT);
  });

  it("listApiKeyMetadata returns only the plaintext-free metadata projection", async () => {
    const cipher = new StubCipher();
    const { store } = createInMemoryCloudSettingsStore({ cipher });
    const PLAINTEXT = "sk-leaky-cloud-value";

    await store.upsertApiKey("user-A", { provider: "openai", apiKey: PLAINTEXT });
    const metadata = await store.listApiKeyMetadata("user-A");
    expect(metadata).toHaveLength(1);
    const entry = metadata[0]!;
    expect(Object.keys(entry).sort()).toEqual([
      "createdAt",
      "fingerprint",
      "lastValidatedAt",
      "provider",
    ]);
    // Plaintext is not embedded in any metadata field.
    const serialized = JSON.stringify(entry);
    expect(serialized.includes(PLAINTEXT)).toBe(false);
    // No ciphertext leak via metadata either.
    expect(serialized.includes("stub.v1")).toBe(false);
  });

  it("loadSettingsForSession returns metadata only — no plaintext, no encrypted blob", async () => {
    const cipher = new StubCipher();
    const { store } = createInMemoryCloudSettingsStore({ cipher });
    const PLAINTEXT = "sk-restoration-secret";

    await store.upsertApiKey("user-A", { provider: "openai", apiKey: PLAINTEXT });
    await store.setPreference("user-A", "theme", "dark");

    const settings = await store.loadSettingsForSession({ userId: "user-A" });
    const serialized = JSON.stringify(settings);
    expect(serialized.includes(PLAINTEXT)).toBe(false);
    expect(serialized.includes("stub.v1")).toBe(false);

    // Cipher MUST NOT have been asked to decrypt for this read path.
    expect(cipher.decryptCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Second-device-login restoration (Requirement 3.4)
// ---------------------------------------------------------------------------

describe("CloudSettingsStore — second-device login", () => {
  it("a fresh service instance backed by the same persisted store returns the user's data", async () => {
    // Device 1: fresh cloud store, user does some setup.
    const cipher = new StubCipher();
    const bundle1 = createInMemoryCloudSettingsStore({ cipher });
    await bundle1.store.upsertApiKey("user-A", {
      provider: "openai",
      apiKey: "sk-device-1-secret",
    });
    await bundle1.store.upsertApiKey("user-A", {
      provider: "anthropic",
      apiKey: "sk-device-1-anth",
    });
    await bundle1.store.upsertCustomAgent("user-A", {
      name: "Architect",
      systemPrompt: "Cross-device architect.",
      allowedTools: ["web_search"],
    });
    await bundle1.store.setPreference("user-A", "theme", "dark");
    await bundle1.store.setPreference("user-A", "default_model", {
      provider: "openai",
      modelId: "gpt-4",
    });

    // Device 2: fresh CloudSettingsStore *INSTANCE* — but pointed at the
    // same backends. This simulates a second device whose process has
    // never seen this user before; the persistent storage has, though.
    // Production composition: the SQL-backed adapters are shared because
    // they connect to the same Postgres cluster.
    const bundle2 = createInMemoryCloudSettingsStore({
      cipher: new StubCipher(),
      apiKeyBackend: bundle1.apiKeyBackend,
      customAgentStore: bundle1.customAgentStore,
      preferencesBackend: bundle1.preferencesBackend,
    });
    const fresh: CloudSettingsStore = bundle2.store;

    const settings = await fresh.loadSettingsForSession({ userId: "user-A" });

    // API keys: present, plaintext-free, both providers visible.
    expect(settings.apiKeys.map((k) => k.provider).sort()).toEqual([
      "anthropic",
      "openai",
    ]);
    for (const m of settings.apiKeys) {
      expect(m.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    }
    // Custom agents: present.
    expect(settings.customAgents.map((a) => a.name)).toEqual(["Architect"]);
    expect(settings.customAgents[0]!.ownerScope).toEqual({
      kind: "cloud",
      userId: "user-A",
    });
    // Preferences: full snapshot.
    expect(settings.preferences).toEqual({
      theme: "dark",
      default_model: { provider: "openai", modelId: "gpt-4" },
    });
  });

  it("second-device cipher does not need to decrypt API keys for restoration", async () => {
    const cipher1 = new StubCipher();
    const bundle1 = createInMemoryCloudSettingsStore({ cipher: cipher1 });
    await bundle1.store.upsertApiKey("user-A", {
      provider: "openai",
      apiKey: "sk-device-1",
    });

    const cipher2 = new StubCipher();
    const bundle2 = createInMemoryCloudSettingsStore({
      cipher: cipher2,
      apiKeyBackend: bundle1.apiKeyBackend,
      customAgentStore: bundle1.customAgentStore,
      preferencesBackend: bundle1.preferencesBackend,
    });

    await bundle2.store.loadSettingsForSession({ userId: "user-A" });
    // Restoration is a metadata-only read; the second device's cipher is
    // never invoked, which is exactly the design rule (Requirement 3.7:
    // plaintext only via explicit server-component request).
    expect(cipher2.encryptCalls).toBe(0);
    expect(cipher2.decryptCalls).toBe(0);
  });

  it("second-device login from a user who never stored anything returns empty collections", async () => {
    const bundle = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });
    const settings = await bundle.store.loadSettingsForSession({ userId: "ghost" });
    expect(settings.apiKeys).toEqual([]);
    expect(settings.customAgents).toEqual([]);
    expect(settings.preferences).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Construction-time argument validation
// ---------------------------------------------------------------------------

describe("CloudSettingsStore — argument validation", () => {
  it("rejects empty userId on every method", async () => {
    const { store } = createInMemoryCloudSettingsStore({ cipher: new StubCipher() });

    await expect(
      store.upsertApiKey("", { provider: "openai", apiKey: "sk-x" }),
    ).rejects.toThrow(/userId/);
    await expect(store.removeApiKey("", "openai")).rejects.toThrow(/userId/);
    await expect(store.listApiKeyMetadata("")).rejects.toThrow(/userId/);
    await expect(
      store.upsertCustomAgent("", {
        name: "n",
        systemPrompt: "p",
        allowedTools: [],
      }),
    ).rejects.toThrow(/userId/);
    await expect(store.removeCustomAgent("", "id")).rejects.toThrow(/userId/);
    await expect(store.listCustomAgents("")).rejects.toThrow(/userId/);
    await expect(store.setPreference("", "k", "v")).rejects.toThrow(/userId/);
    await expect(store.getPreference("", "k")).rejects.toThrow(/userId/);
    await expect(store.removePreference("", "k")).rejects.toThrow(/userId/);
    await expect(store.listPreferences("")).rejects.toThrow(/userId/);
    await expect(
      store.loadSettingsForSession({ userId: "" }),
    ).rejects.toThrow(/userId/);
  });
});
