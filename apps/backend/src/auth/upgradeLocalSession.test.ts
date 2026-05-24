/**
 * Unit tests for `upgradeLocalSessionToGoogle` (task 17.3).
 *
 * Covers (per task brief):
 *
 *   • Confirmation flags gate the merge per collection:
 *       – `syncSettings: false` AND `syncApiKeys: false` → no collection
 *         is touched, the report is empty, and the cloud session is
 *         returned unchanged.
 *       – `syncApiKeys: true` only → API keys merge runs;
 *         settings (custom agents + preferences) remain untouched.
 *       – `syncSettings: true` only → custom agents and preferences
 *         merge runs; API keys remain untouched (Requirement 2.8).
 *
 *   • Conflict policy applies for API keys:
 *       – Provider with key in BOTH local and cloud → cloud wins, local
 *         is preserved as `local-only` (cloudWonOver + preservedLocalOnly).
 *       – Provider in local only → copied into cloud (copiedToCloud).
 *
 *   • Custom agents conflict preserves local:
 *       – Local agent name matches a cloud agent name → conflict,
 *         reason `"cloud_agent_with_same_name"`, NOT copied to cloud.
 *       – Local agent name matches a builtin name → conflict, reason
 *         `"builtin_name"`, NOT copied to cloud.
 *       – Local agent name with no collision → copied to cloud.
 *
 *   • Returned MergeReport shape:
 *       – Top-level keys: `apiKeys`, `customAgents`, `preferences`.
 *       – `apiKeys`: `copiedToCloud`, `cloudWonOver`, `preservedLocalOnly`.
 *       – `customAgents`: `copiedToCloud`, `conflicts: { agentId, reason }[]`.
 *       – `preferences`: `copiedToCloud`, `cloudWon`.
 *
 * Validates: Requirements 2.7, 2.8, 3.6.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type {
  AgentId,
  ProviderId,
  Session,
} from "@ai-agent-orchestrator/shared-core";
import type { CustomAgent } from "@ai-agent-orchestrator/validation";

import type {
  CloudSettingsStore} from "../settings/cloudSettingsStore.js";
import {
  createInMemoryCloudSettingsStore,
} from "../settings/cloudSettingsStore.js";
import {
  createCustomAgentService,
  InMemoryCustomAgentStore,
  type CustomAgentService,
} from "../settings/customAgents.js";
import type { EncryptedBlob, SecretCipher } from "../settings/types.js";

import {
  createUpgradeLocalSessionToGoogle,
  type LocalScopeReader,
  type MergeReport,
} from "./upgradeLocalSession.js";
import type { GoogleOAuthService } from "./googleOAuth.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** Stub OAuth service: returns a fixed cloud session, never hits Google. */
function stubOAuthService(session: Session): GoogleOAuthService {
  // We intentionally cast through `unknown` — the stub does not
  // implement the full surface, just `completeGoogleOAuth`, which is
  // the only method the upgrade routine calls.
  return {
    completeGoogleOAuth: async () => session,
  } as unknown as GoogleOAuthService;
}

/** Reversible base64 cipher. Same shape as the cloud-store tests use. */
class StubCipher implements SecretCipher {
  public encryptCalls = 0;
  public decryptCalls = 0;

  public async encrypt(plaintext: string): Promise<EncryptedBlob> {
    this.encryptCalls += 1;
    return {
      algorithm: "stub.v1",
      ciphertext: Buffer.from(plaintext, "utf8").toString("base64"),
      createdAt: "2025-01-01T00:00:00.000Z",
    };
  }

  public async decrypt(blob: EncryptedBlob): Promise<string> {
    this.decryptCalls += 1;
    return Buffer.from(blob.ciphertext, "base64").toString("utf8");
  }
}

/**
 * In-memory `LocalScopeReader`. Tracks which methods were called so the
 * "untouched" assertions can verify both the report shape and the access
 * pattern: an untouched collection means literally no read, not just no
 * write.
 */
class StubLocalReader implements LocalScopeReader {
  public apiKeys = new Map<string, string>();
  public customAgents: CustomAgent[] = [];
  public preferences: Record<string, unknown> = {};
  public callLog = {
    readApiKey: 0,
    listLocalProviders: 0,
    listLocalCustomAgents: 0,
    listLocalPreferences: 0,
  };

  public async readApiKey(
    deviceId: string,
    provider: ProviderId,
  ): Promise<string | null> {
    this.callLog.readApiKey += 1;
    if (deviceId !== this.deviceId) return null;
    return this.apiKeys.get(provider) ?? null;
  }

  public async listLocalProviders(
    deviceId: string,
  ): Promise<readonly ProviderId[]> {
    this.callLog.listLocalProviders += 1;
    if (deviceId !== this.deviceId) return [];
    return Array.from(this.apiKeys.keys());
  }

  public async listLocalCustomAgents(
    deviceId: string,
  ): Promise<readonly CustomAgent[]> {
    this.callLog.listLocalCustomAgents += 1;
    if (deviceId !== this.deviceId) return [];
    return this.customAgents.slice();
  }

  public async listLocalPreferences(
    deviceId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.callLog.listLocalPreferences += 1;
    if (deviceId !== this.deviceId) return {};
    return { ...this.preferences };
  }

  public deviceId = "device-A";
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly upgrade: ReturnType<typeof createUpgradeLocalSessionToGoogle>;
  readonly localReader: StubLocalReader;
  readonly cloudStore: CloudSettingsStore;
  readonly cloudCustomAgentService: CustomAgentService;
  readonly cipher: StubCipher;
}

const FIXED_USER_ID = "user-cloud-1";
const FIXED_DEVICE_ID = "device-A";
const FIXED_SESSION: Session = {
  id: "sess-cloud-1",
  kind: "cloud",
  userId: FIXED_USER_ID,
  createdAt: "2025-01-01T00:00:00.000Z",
  expiresAt: "2025-02-01T00:00:00.000Z",
};

function buildHarness(
  overrides: { sharedCustomAgentStore?: InMemoryCustomAgentStore } = {},
): Harness {
  const cipher = new StubCipher();
  const sharedCustomAgentStore =
    overrides.sharedCustomAgentStore ?? new InMemoryCustomAgentStore();
  const bundle = createInMemoryCloudSettingsStore({
    cipher,
    customAgentStore: sharedCustomAgentStore,
  });
  // Cloud-side custom agent service shares the same backend so the
  // upgrade routine and the cloud store see the same cloud agents.
  const cloudCustomAgentService = createCustomAgentService(
    sharedCustomAgentStore,
  );
  const localReader = new StubLocalReader();
  localReader.deviceId = FIXED_DEVICE_ID;

  const upgrade = createUpgradeLocalSessionToGoogle({
    googleOAuthService: stubOAuthService(FIXED_SESSION),
    cloudSettingsStore: bundle.store,
    cloudCustomAgentService,
    localReader,
  });

  return {
    upgrade,
    localReader,
    cloudStore: bundle.store,
    cloudCustomAgentService,
    cipher,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upgradeLocalSessionToGoogle — confirmation flags gate the merge", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
    // Seed local scope with one of each collection.
    h.localReader.apiKeys.set("openai", "sk-local-openai");
    h.localReader.customAgents.push({
      id: "local-agent-1",
      kind: "custom",
      name: "Architect",
      systemPrompt: "Local architect.",
      allowedTools: ["web_search"],
      ownerScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
    });
    h.localReader.preferences = { theme: "dark" };
  });

  it("syncSettings=false AND syncApiKeys=false: no collection is touched, report is empty", async () => {
    const result = await h.upgrade({
      localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
      code: "auth-code",
      state: "state-A",
      syncSettings: false,
      syncApiKeys: false,
    });

    // Session is the cloud session returned by Google OAuth.
    expect(result.session).toEqual(FIXED_SESSION);

    // Report shape: every list empty.
    expect(result.mergeReport).toEqual({
      apiKeys: {
        copiedToCloud: [],
        cloudWonOver: [],
        preservedLocalOnly: [],
      },
      customAgents: { copiedToCloud: [], conflicts: [] },
      preferences: { copiedToCloud: [], cloudWon: [] },
    });

    // Local reader was NEVER called for any collection (Requirement 2.8
    // strictness: untouched means literally not read).
    expect(h.localReader.callLog).toEqual({
      readApiKey: 0,
      listLocalProviders: 0,
      listLocalCustomAgents: 0,
      listLocalPreferences: 0,
    });

    // Cloud was not populated either.
    await expect(h.cloudStore.listApiKeyMetadata(FIXED_USER_ID)).resolves.toEqual(
      [],
    );
    await expect(h.cloudStore.listCustomAgents(FIXED_USER_ID)).resolves.toEqual(
      [],
    );
    await expect(h.cloudStore.listPreferences(FIXED_USER_ID)).resolves.toEqual(
      {},
    );
  });

  it("syncApiKeys=true only: API keys merge runs; settings remain untouched (Requirement 2.8)", async () => {
    const result = await h.upgrade({
      localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
      code: "auth-code",
      state: "state-A",
      syncSettings: false,
      syncApiKeys: true,
    });

    // API key was copied.
    expect(result.mergeReport.apiKeys.copiedToCloud).toEqual(["openai"]);
    expect(result.mergeReport.apiKeys.cloudWonOver).toEqual([]);
    expect(result.mergeReport.apiKeys.preservedLocalOnly).toEqual([]);
    // Cloud now has the API key (metadata-only — no plaintext leak).
    const cloudMeta = await h.cloudStore.listApiKeyMetadata(FIXED_USER_ID);
    expect(cloudMeta.map((m) => m.provider)).toEqual(["openai"]);

    // Settings collections were NOT read or written.
    expect(h.localReader.callLog.listLocalCustomAgents).toBe(0);
    expect(h.localReader.callLog.listLocalPreferences).toBe(0);
    expect(result.mergeReport.customAgents).toEqual({
      copiedToCloud: [],
      conflicts: [],
    });
    expect(result.mergeReport.preferences).toEqual({
      copiedToCloud: [],
      cloudWon: [],
    });
    await expect(h.cloudStore.listCustomAgents(FIXED_USER_ID)).resolves.toEqual(
      [],
    );
    await expect(h.cloudStore.listPreferences(FIXED_USER_ID)).resolves.toEqual(
      {},
    );
  });

  it("syncSettings=true only: settings merge runs; API keys remain untouched (Requirement 2.8)", async () => {
    const result = await h.upgrade({
      localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
      code: "auth-code",
      state: "state-A",
      syncSettings: true,
      syncApiKeys: false,
    });

    // API key collection was NEVER read or written.
    expect(h.localReader.callLog.listLocalProviders).toBe(0);
    expect(h.localReader.callLog.readApiKey).toBe(0);
    expect(result.mergeReport.apiKeys).toEqual({
      copiedToCloud: [],
      cloudWonOver: [],
      preservedLocalOnly: [],
    });
    await expect(h.cloudStore.listApiKeyMetadata(FIXED_USER_ID)).resolves.toEqual(
      [],
    );

    // Custom agent + preference were copied.
    expect(result.mergeReport.customAgents.copiedToCloud).toEqual([
      "local-agent-1",
    ]);
    expect(result.mergeReport.preferences.copiedToCloud).toEqual(["theme"]);
    expect(result.mergeReport.preferences.cloudWon).toEqual([]);
    const cloudAgents = await h.cloudStore.listCustomAgents(FIXED_USER_ID);
    expect(cloudAgents.map((a) => a.name)).toEqual(["Architect"]);
    await expect(h.cloudStore.listPreferences(FIXED_USER_ID)).resolves.toEqual(
      { theme: "dark" },
    );
  });
});

describe("upgradeLocalSessionToGoogle — API key conflict policy (cloud wins)", () => {
  it("same provider in cloud → cloud wins, local preserved as local-only", async () => {
    const h = buildHarness();
    // Seed cloud with an OpenAI key first.
    await h.cloudStore.upsertApiKey(FIXED_USER_ID, {
      provider: "openai",
      apiKey: "sk-cloud-openai",
    });
    // Seed local with a different OpenAI key (cloud should still win) AND
    // an Anthropic key that has no cloud counterpart.
    h.localReader.apiKeys.set("openai", "sk-local-openai");
    h.localReader.apiKeys.set("anthropic", "sk-local-anthropic");

    const result = await h.upgrade({
      localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
      code: "code",
      state: "state",
      syncSettings: false,
      syncApiKeys: true,
    });

    // openai conflict: cloud wins, local preserved as local-only.
    expect(result.mergeReport.apiKeys.cloudWonOver).toEqual(["openai"]);
    expect(result.mergeReport.apiKeys.preservedLocalOnly).toEqual(["openai"]);
    // anthropic copied to cloud.
    expect(result.mergeReport.apiKeys.copiedToCloud).toEqual(["anthropic"]);

    // Cloud has both keys, but the openai one is the ORIGINAL cloud key
    // (cloud won). We can verify that by checking the cloud's stored
    // ciphertext decrypts back to the cloud plaintext, not the local one.
    const cloudMeta = await h.cloudStore.listApiKeyMetadata(FIXED_USER_ID);
    expect(cloudMeta.map((m) => m.provider).sort()).toEqual([
      "anthropic",
      "openai",
    ]);
  });

  it("provider in local only → copied to cloud", async () => {
    const h = buildHarness();
    h.localReader.apiKeys.set("openai", "sk-local");

    const result = await h.upgrade({
      localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
      code: "code",
      state: "state",
      syncSettings: false,
      syncApiKeys: true,
    });

    expect(result.mergeReport.apiKeys.copiedToCloud).toEqual(["openai"]);
    expect(result.mergeReport.apiKeys.cloudWonOver).toEqual([]);
    expect(result.mergeReport.apiKeys.preservedLocalOnly).toEqual([]);
  });
});

describe("upgradeLocalSessionToGoogle — custom agent conflict preserves local", () => {
  it("conflict with cloud agent of the same name → local preserved (not copied)", async () => {
    const h = buildHarness();
    // Seed cloud with an Architect agent.
    await h.cloudStore.upsertCustomAgent(FIXED_USER_ID, {
      name: "Architect",
      systemPrompt: "Cloud architect.",
      allowedTools: [],
    });
    // Seed local with the same name (case-insensitive match).
    h.localReader.customAgents.push({
      id: "local-architect",
      kind: "custom",
      name: "  architect  ", // whitespace + different case
      systemPrompt: "Local architect.",
      allowedTools: ["web_search"],
      ownerScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
    });
    // Add a non-conflicting one too so we know the loop continues past
    // a conflict and the report can carry both arms.
    h.localReader.customAgents.push({
      id: "local-summarizer",
      kind: "custom",
      name: "Summarizer",
      systemPrompt: "Local summarizer.",
      allowedTools: [],
      ownerScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
    });

    const result = await h.upgrade({
      localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
      code: "code",
      state: "state",
      syncSettings: true,
      syncApiKeys: false,
    });

    expect(result.mergeReport.customAgents.copiedToCloud).toEqual([
      "local-summarizer",
    ]);
    expect(result.mergeReport.customAgents.conflicts).toEqual([
      { agentId: "local-architect", reason: "cloud_agent_with_same_name" },
    ]);

    // Cloud agents: the original cloud Architect untouched, plus the
    // newly copied Summarizer.
    const cloudAgents = await h.cloudStore.listCustomAgents(FIXED_USER_ID);
    const cloudAgentNames = cloudAgents.map((a) => a.name).sort();
    expect(cloudAgentNames).toEqual(["Architect", "Summarizer"]);
    // The local Architect's content did NOT overwrite the cloud one.
    const cloudArch = cloudAgents.find((a) => a.name === "Architect");
    expect(cloudArch?.systemPrompt).toBe("Cloud architect.");
  });

  it("conflict with builtin agent name → local preserved (not copied)", async () => {
    const h = buildHarness();
    h.localReader.customAgents.push({
      id: "local-agent-builtin-conflict",
      kind: "custom",
      // 'researcher' is a builtin; the upsert path will reject this and we
      // expect the upgrade to surface it as a "builtin_name" conflict
      // rather than propagating the rejection.
      name: "Researcher",
      systemPrompt: "Should fail.",
      allowedTools: [],
      ownerScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
    });

    const result = await h.upgrade({
      localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
      code: "code",
      state: "state",
      syncSettings: true,
      syncApiKeys: false,
    });

    expect(result.mergeReport.customAgents.copiedToCloud).toEqual([]);
    expect(result.mergeReport.customAgents.conflicts).toEqual([
      { agentId: "local-agent-builtin-conflict", reason: "builtin_name" },
    ]);
    await expect(h.cloudStore.listCustomAgents(FIXED_USER_ID)).resolves.toEqual(
      [],
    );
  });

  it("two local agents with the same normalized name → second one becomes a conflict", async () => {
    const h = buildHarness();
    h.localReader.customAgents.push({
      id: "local-1",
      kind: "custom",
      name: "Twin",
      systemPrompt: "First Twin.",
      allowedTools: [],
      ownerScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
    });
    h.localReader.customAgents.push({
      id: "local-2",
      kind: "custom",
      name: "twin", // same normalized name as 'Twin'
      systemPrompt: "Second Twin.",
      allowedTools: [],
      ownerScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
    });

    const result = await h.upgrade({
      localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
      code: "code",
      state: "state",
      syncSettings: true,
      syncApiKeys: false,
    });

    expect(result.mergeReport.customAgents.copiedToCloud).toEqual(["local-1"]);
    expect(result.mergeReport.customAgents.conflicts).toEqual([
      { agentId: "local-2", reason: "cloud_agent_with_same_name" },
    ]);
  });
});

describe("upgradeLocalSessionToGoogle — preferences merge (cloud wins on collision)", () => {
  it("non-conflicting local prefs are copied; collisions go to cloudWon", async () => {
    const h = buildHarness();
    // Cloud already has `theme = "dark"`.
    await h.cloudStore.setPreference(FIXED_USER_ID, "theme", "dark");
    // Local has a colliding `theme` and a non-conflicting `default_model`.
    h.localReader.preferences = {
      theme: "light",
      default_model: { provider: "openai", modelId: "gpt-4" },
    };

    const result = await h.upgrade({
      localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
      code: "code",
      state: "state",
      syncSettings: true,
      syncApiKeys: false,
    });

    expect(new Set(result.mergeReport.preferences.copiedToCloud)).toEqual(
      new Set(["default_model"]),
    );
    expect(new Set(result.mergeReport.preferences.cloudWon)).toEqual(
      new Set(["theme"]),
    );

    // Cloud values: theme stayed "dark" (cloud won), default_model copied.
    const prefs = await h.cloudStore.listPreferences(FIXED_USER_ID);
    expect(prefs).toEqual({
      theme: "dark",
      default_model: { provider: "openai", modelId: "gpt-4" },
    });
  });
});

describe("upgradeLocalSessionToGoogle — MergeReport shape", () => {
  it("returns a fully populated MergeReport with all six counters present", async () => {
    const h = buildHarness();
    // Seed enough state to populate every list at least once.
    await h.cloudStore.upsertApiKey(FIXED_USER_ID, {
      provider: "openai",
      apiKey: "sk-cloud",
    });
    await h.cloudStore.upsertCustomAgent(FIXED_USER_ID, {
      name: "Architect",
      systemPrompt: "Cloud Architect.",
      allowedTools: [],
    });
    await h.cloudStore.setPreference(FIXED_USER_ID, "theme", "dark");

    h.localReader.apiKeys.set("openai", "sk-local"); // cloudWonOver + preservedLocalOnly
    h.localReader.apiKeys.set("anthropic", "sk-local-a"); // copiedToCloud
    h.localReader.customAgents.push({
      id: "local-architect",
      kind: "custom",
      name: "Architect", // conflict with cloud
      systemPrompt: "Local Architect.",
      allowedTools: [],
      ownerScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
    });
    h.localReader.customAgents.push({
      id: "local-summarizer",
      kind: "custom",
      name: "Summarizer", // copied
      systemPrompt: "Local Summarizer.",
      allowedTools: [],
      ownerScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
    });
    h.localReader.preferences = { theme: "light", language: "en" };

    const result = await h.upgrade({
      localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
      code: "code",
      state: "state",
      syncSettings: true,
      syncApiKeys: true,
    });

    const r: MergeReport = result.mergeReport;

    // Top-level keys.
    expect(Object.keys(r).sort()).toEqual([
      "apiKeys",
      "customAgents",
      "preferences",
    ]);

    // apiKeys subkeys.
    expect(Object.keys(r.apiKeys).sort()).toEqual([
      "cloudWonOver",
      "copiedToCloud",
      "preservedLocalOnly",
    ]);

    // customAgents subkeys.
    expect(Object.keys(r.customAgents).sort()).toEqual([
      "conflicts",
      "copiedToCloud",
    ]);
    // Conflict entries carry both fields.
    for (const conflict of r.customAgents.conflicts) {
      expect(Object.keys(conflict).sort()).toEqual(["agentId", "reason"]);
      expect(typeof conflict.agentId).toBe("string");
      expect(["builtin_name", "cloud_agent_with_same_name"]).toContain(
        conflict.reason,
      );
    }

    // preferences subkeys.
    expect(Object.keys(r.preferences).sort()).toEqual([
      "cloudWon",
      "copiedToCloud",
    ]);

    // Concrete values: each arm populated.
    expect(r.apiKeys.copiedToCloud).toEqual(["anthropic"]);
    expect(r.apiKeys.cloudWonOver).toEqual(["openai"]);
    expect(r.apiKeys.preservedLocalOnly).toEqual(["openai"]);
    expect(r.customAgents.copiedToCloud).toEqual(["local-summarizer"]);
    expect(r.customAgents.conflicts).toEqual([
      { agentId: "local-architect", reason: "cloud_agent_with_same_name" },
    ]);
    expect(new Set(r.preferences.copiedToCloud)).toEqual(new Set(["language"]));
    expect(new Set(r.preferences.cloudWon)).toEqual(new Set(["theme"]));
  });
});

describe("upgradeLocalSessionToGoogle — wiring", () => {
  it("propagates errors from completeGoogleOAuth without touching local state", async () => {
    const cipher = new StubCipher();
    const bundle = createInMemoryCloudSettingsStore({ cipher });
    const localReader = new StubLocalReader();
    localReader.deviceId = FIXED_DEVICE_ID;
    localReader.apiKeys.set("openai", "sk-local");

    const failingOAuthService = {
      completeGoogleOAuth: async () => {
        throw new Error("invalid_state");
      },
    } as unknown as GoogleOAuthService;

    const upgrade = createUpgradeLocalSessionToGoogle({
      googleOAuthService: failingOAuthService,
      cloudSettingsStore: bundle.store,
      cloudCustomAgentService: createCustomAgentService(
        new InMemoryCustomAgentStore(),
      ),
      localReader,
    });

    await expect(
      upgrade({
        localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
        code: "bad",
        state: "bad",
        syncSettings: true,
        syncApiKeys: true,
      }),
    ).rejects.toThrow(/invalid_state/);

    // Critically: no local data was read after the OAuth failure (the
    // failure path runs before the merge phase).
    expect(localReader.callLog).toEqual({
      readApiKey: 0,
      listLocalProviders: 0,
      listLocalCustomAgents: 0,
      listLocalPreferences: 0,
    });
  });

  it("rejects an empty deviceId", async () => {
    const h = buildHarness();
    await expect(
      h.upgrade({
        localScope: { kind: "local", deviceId: "" },
        code: "c",
        state: "s",
        syncSettings: false,
        syncApiKeys: false,
      }),
    ).rejects.toThrow(/deviceId/);
  });

  it("uses the explicit cloudUserId override when supplied", async () => {
    const h = buildHarness();
    h.localReader.preferences = { theme: "dark" };
    const result = await h.upgrade({
      localScope: { kind: "local", deviceId: FIXED_DEVICE_ID },
      code: "c",
      state: "s",
      cloudUserId: "user-override",
      syncSettings: true,
      syncApiKeys: false,
    });
    // Preferences should appear under the override user id, not the
    // session's userId.
    await expect(
      h.cloudStore.listPreferences("user-override"),
    ).resolves.toEqual({ theme: "dark" });
    await expect(h.cloudStore.listPreferences(FIXED_USER_ID)).resolves.toEqual(
      {},
    );
    expect(result.session).toEqual(FIXED_SESSION);
  });
});

// Used implicitly by the `AgentId` import to make sure the tests don't
// drift away from the exported type. Suppress the unused-import warning
// for environments where TypeScript doesn't see the import elsewhere.
const _agentIdAlias: AgentId = "x";
void _agentIdAlias;
