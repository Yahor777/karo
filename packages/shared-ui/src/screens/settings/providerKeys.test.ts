/**
 * Unit tests for the provider/API-key management screen controller and
 * its DOM mount helper (task 6.4).
 *
 * Coverage:
 *
 *   • Happy path: refresh → list, add (validate + persist) → success,
 *     delete → success.
 *   • Validation rejection: a Provider-side `kind: "error"` from
 *     `validateApiKey` produces `validation_failed` with the verbatim
 *     `providerCode` / `providerMessage` (Requirements 2.3, 4.3) AND
 *     `upsertApiKey` is NOT called.
 *   • Property 15 / Requirement 4.4: a successful delete never produces
 *     an error UI — the state ends in `delete: { status: "success" }`,
 *     the rendered DOM contains a non-error confirmation, and no element
 *     bearing "fail"/"error" wording appears.
 *
 * The controller is exercised directly; the mount helper is exercised
 * against jsdom for the delete-success no-error rendering.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest";

import {
  createProviderKeysController,
  mountProviderKeysScreen,
  type ProviderKeysApiKeyGateway,
  type ProviderKeysAuthGateway,
} from "./providerKeys.js";
import type {
  ApiKeyMetadata,
  ProviderId,
  Scope,
  ValidationResult,
} from "../../ports/settings.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class StubApiKeyGateway implements ProviderKeysApiKeyGateway {
  public listCalls = 0;
  public upsertCalls: Array<{ scope: Scope; provider: ProviderId; apiKey: string }> = [];
  public deleteCalls: Array<{ scope: Scope; provider: ProviderId }> = [];
  public listResult: ApiKeyMetadata[] = [];
  public listError: Error | null = null;
  public upsertError: Error | null = null;
  public deleteError: Error | null = null;

  async listApiKeyMetadata(_scope: Scope): Promise<readonly ApiKeyMetadata[]> {
    this.listCalls += 1;
    if (this.listError) throw this.listError;
    return [...this.listResult];
  }

  async upsertApiKey(
    scope: Scope,
    input: { readonly provider: ProviderId; readonly apiKey: string },
  ): Promise<void> {
    this.upsertCalls.push({ scope, provider: input.provider, apiKey: input.apiKey });
    if (this.upsertError) throw this.upsertError;
  }

  async removeApiKey(scope: Scope, provider: ProviderId): Promise<void> {
    this.deleteCalls.push({ scope, provider });
    if (this.deleteError) throw this.deleteError;
  }
}

class StubAuthGateway implements ProviderKeysAuthGateway {
  public calls: Array<{ provider: ProviderId; apiKey: string }> = [];
  public result: ValidationResult = { kind: "ok", modelsCount: 3 };

  async validateApiKey(input: {
    readonly provider: ProviderId;
    readonly apiKey: string;
  }): Promise<ValidationResult> {
    this.calls.push({ provider: input.provider, apiKey: input.apiKey });
    return this.result;
  }
}

const SCOPE: Scope = { kind: "local", deviceId: "device-1" };

function buildMetadata(provider: ProviderId, fingerprint = "abcdef012345"): ApiKeyMetadata {
  return {
    provider,
    fingerprint,
    createdAt: "2025-01-01T00:00:00.000Z",
    lastValidatedAt: "2025-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Controller — happy path
// ---------------------------------------------------------------------------

describe("createProviderKeysController — happy path", () => {
  it(
    "refreshes the metadata listing and exposes only metadata fields " +
      "(Validates: Requirements 4.1, 3.7)",
    async () => {
      const apiKeys = new StubApiKeyGateway();
      apiKeys.listResult = [buildMetadata("openai"), buildMetadata("anthropic", "111122223333")];
      const auth = new StubAuthGateway();

      const controller = createProviderKeysController({ scope: SCOPE, apiKeys, auth });
      await controller.refresh();

      const state = controller.getState();
      expect(state.list.status).toBe("loaded");
      if (state.list.status !== "loaded") return;
      expect(state.list.entries).toHaveLength(2);
      // Metadata is plaintext-free by construction (Property 9 / 3.7).
      // We re-state the surface here as a regression guard so a future
      // change adding an "encryptedKey" or "apiKey" field gets caught.
      for (const entry of state.list.entries) {
        expect(Object.keys(entry).sort()).toEqual([
          "createdAt",
          "fingerprint",
          "lastValidatedAt",
          "provider",
        ]);
      }
    },
  );

  it(
    "validates the key, persists, and refreshes on add " +
      "(Validates: Requirements 4.2)",
    async () => {
      const apiKeys = new StubApiKeyGateway();
      apiKeys.listResult = [];
      const auth = new StubAuthGateway();
      auth.result = { kind: "ok", modelsCount: 5 };

      const controller = createProviderKeysController({ scope: SCOPE, apiKeys, auth });

      // Refresh sequence triggered by addOrUpdateApiKey will pick this up.
      apiKeys.listResult = [buildMetadata("openai")];

      const result = await controller.addOrUpdateApiKey({
        provider: "openai",
        apiKey: "sk-live-test-123",
      });

      expect(result.status).toBe("success");
      expect(auth.calls).toEqual([{ provider: "openai", apiKey: "sk-live-test-123" }]);
      expect(apiKeys.upsertCalls).toEqual([
        { scope: SCOPE, provider: "openai", apiKey: "sk-live-test-123" },
      ]);
      // List was refreshed after save.
      expect(apiKeys.listCalls).toBe(1);
      const state = controller.getState();
      expect(state.list.status).toBe("loaded");
      if (state.list.status === "loaded") {
        expect(state.list.entries.map((e) => e.provider)).toEqual(["openai"]);
      }
    },
  );

  it(
    "rejects empty plaintext before issuing any backend call " +
      "(Validates: Requirements 4.2 hygiene)",
    async () => {
      const apiKeys = new StubApiKeyGateway();
      const auth = new StubAuthGateway();
      const controller = createProviderKeysController({ scope: SCOPE, apiKeys, auth });

      const result = await controller.addOrUpdateApiKey({ provider: "openai", apiKey: "" });
      expect(result.status).toBe("validation_failed");
      expect(auth.calls).toEqual([]);
      expect(apiKeys.upsertCalls).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Controller — validation failure path (Requirements 2.3, 4.3)
// ---------------------------------------------------------------------------

describe("createProviderKeysController — validation failure", () => {
  it(
    "surfaces providerCode/providerMessage and skips upsert on validation error " +
      "(Validates: Requirements 2.3, 4.3)",
    async () => {
      const apiKeys = new StubApiKeyGateway();
      const auth = new StubAuthGateway();
      auth.result = {
        kind: "error",
        providerCode: "invalid_api_key",
        providerMessage: "Incorrect API key provided",
      };

      const controller = createProviderKeysController({ scope: SCOPE, apiKeys, auth });

      const result = await controller.addOrUpdateApiKey({
        provider: "openai",
        apiKey: "sk-bogus",
      });

      expect(result).toEqual({
        status: "validation_failed",
        providerCode: "invalid_api_key",
        providerMessage: "Incorrect API key provided",
      });
      expect(apiKeys.upsertCalls).toEqual([]);
      // The listing was never refreshed on a failed validation.
      expect(apiKeys.listCalls).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Controller — delete-success no-error (Property 15 / Requirement 4.4)
// ---------------------------------------------------------------------------

describe("createProviderKeysController — successful delete produces no error UI", () => {
  it(
    "ends in delete:'success' with no error message (Validates: Requirements 4.4)",
    async () => {
      const apiKeys = new StubApiKeyGateway();
      apiKeys.listResult = [buildMetadata("openai")];
      const auth = new StubAuthGateway();

      const controller = createProviderKeysController({ scope: SCOPE, apiKeys, auth });
      await controller.refresh();

      // Drop the provider from the next list response so the post-delete
      // refresh shows it really is gone.
      apiKeys.listResult = [];

      const result = await controller.removeApiKey("openai");
      expect(result.status).toBe("success");

      const state = controller.getState();
      expect(state.delete.status).toBe("success");
      // Critical invariant: the state shape itself does not carry an
      // error string on a successful delete (Property 15).
      if (state.delete.status === "success") {
        expect(state.delete).not.toHaveProperty("message");
      }
      expect(apiKeys.deleteCalls).toEqual([{ scope: SCOPE, provider: "openai" }]);
    },
  );
});

// ---------------------------------------------------------------------------
// Mount helper — delete-success no-error rendering (jsdom)
// ---------------------------------------------------------------------------

describe("mountProviderKeysScreen — delete success rendering", () => {
  it(
    "renders a non-error confirmation and no failure copy after a successful delete " +
      "(Validates: Requirements 4.4)",
    async () => {
      const apiKeys = new StubApiKeyGateway();
      apiKeys.listResult = [buildMetadata("openai")];
      const auth = new StubAuthGateway();

      const controller = createProviderKeysController({ scope: SCOPE, apiKeys, auth });
      const root = document.createElement("div");
      document.body.append(root);

      const dispose = mountProviderKeysScreen({ root, controller });
      await controller.refresh();

      // The list should now show one entry with a delete button.
      const deleteButton = root.querySelector(
        ".provider-keys-entry-delete",
      );
      expect(deleteButton).not.toBeNull();

      // Drop the entry from the next refresh so the post-delete listing
      // reflects the removal.
      apiKeys.listResult = [];

      // Trigger the same path the user would.
      const removeResult = controller.removeApiKey("openai");
      // (Exercise the click event path too; it dispatches the same call.)
      deleteButton?.click();
      await removeResult;

      const deleteStatusEl = root.querySelector(
        ".provider-keys-delete-status",
      ) as HTMLElement;
      expect(deleteStatusEl).not.toBeNull();
      const statusText = deleteStatusEl.textContent ?? "";
      // Property 15 / Requirement 4.4: no error wording on a successful delete.
      expect(statusText.toLowerCase()).not.toContain("fail");
      expect(statusText.toLowerCase()).not.toContain("error");
      // The non-error confirmation references the provider that was removed.
      expect(statusText).toContain("openai");

      // Final list should be empty (the entry is gone).
      const remainingEntries = root.querySelectorAll(".provider-keys-entry");
      expect(remainingEntries.length).toBe(0);

      dispose();
      root.remove();
    },
  );
});
