/**
 * Unit tests for {@link ModelSelectionController}.
 *
 * Covers the contract the orchestrator task description calls out:
 *
 *   1. Provider isolation — a `status: "error"` entry from one provider
 *      does NOT remove the other providers' models from the snapshot.
 *      This mirrors Requirement 5.3 / Property 7 at the UI layer.
 *   2. Fallback selection requires explicit `confirmFallback()` —
 *      `setSelectedModel` on a `platform-fallback` model parks it in
 *      `pendingFallback` and leaves the active selection alone, per
 *      Requirement 5.5 ("fallback must not silently replace user's
 *      chosen model").
 *   3. Model selection persists across `refresh()` so long as the model
 *      is still in the catalog snapshot, and is cleared when the model
 *      disappears (e.g. user removed the API key).
 *
 * Validates: Requirements 5.2, 5.3, 5.5.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  ModelCatalogGateway,
  ModelInfo,
  ProviderModelsResult,
  Scope,
} from "./types.js";
import { ModelSelectionController } from "./modelSelection.js";

const SCOPE: Scope = { kind: "local", deviceId: "dev-1" };

function userKeyModel(
  provider: string,
  modelId: string,
  displayName = modelId,
): ModelInfo {
  return {
    provider,
    modelId,
    displayName,
    source: "user-api-key",
  };
}

function fallbackModel(
  provider: string,
  modelId: string,
  displayName = modelId,
): ModelInfo {
  return {
    provider,
    modelId,
    displayName,
    source: "platform-fallback",
    qualityTier: "basic",
  };
}

function gatewayReturning(
  ...batches: readonly (readonly ProviderModelsResult[])[]
): ModelCatalogGateway {
  let call = 0;
  return {
    async listModelsForUser(_scope: Scope) {
      const idx = Math.min(call, batches.length - 1);
      call += 1;
      // The controller is expected to receive a fresh copy each call,
      // so clone shallowly to catch accidental mutation of the snapshot.
      // batches is non-empty by construction in every test below.
      const batch = batches[idx] ?? [];
      return batch.map((p) => ({ ...p }));
    },
  };
}

describe("ModelSelectionController — provider isolation (Property 7)", () => {
  it("keeps healthy providers when one provider returns an error", async () => {
    const gateway = gatewayReturning([
      {
        provider: "openai",
        status: "ok",
        models: [userKeyModel("openai", "gpt-4o")],
      },
      {
        provider: "anthropic",
        status: "error",
        reason: "401 invalid api key",
      },
      {
        provider: "mistral",
        status: "ok",
        models: [userKeyModel("mistral", "small")],
      },
    ]);

    const controller = new ModelSelectionController({ gateway, scope: SCOPE });
    await controller.refresh();

    const state = controller.getState();
    expect(state.status).toEqual({ kind: "ready" });
    expect(state.providers).toHaveLength(3);

    const openai = state.providers[0];
    const anthropic = state.providers[1];
    const mistral = state.providers[2];

    expect(openai?.provider).toBe("openai");
    expect(openai?.status).toBe("ok");
    if (openai?.status === "ok") {
      expect(openai.models.map((m) => m.modelId)).toEqual(["gpt-4o"]);
    }

    expect(anthropic?.status).toBe("error");
    if (anthropic?.status === "error") {
      expect(anthropic.reason).toBe("401 invalid api key");
    }

    expect(mistral?.status).toBe("ok");
    if (mistral?.status === "ok") {
      expect(mistral.models.map((m) => m.modelId)).toEqual(["small"]);
    }
  });

  it("can select a model on a healthy provider while a sibling is in error", async () => {
    const gateway = gatewayReturning([
      {
        provider: "openai",
        status: "error",
        reason: "rate limited",
      },
      {
        provider: "anthropic",
        status: "ok",
        models: [userKeyModel("anthropic", "claude-3-5-sonnet")],
      },
    ]);

    const controller = new ModelSelectionController({ gateway, scope: SCOPE });
    await controller.refresh();

    controller.setSelectedModel({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
      source: "user-api-key",
    });

    expect(controller.getState().selectedModelRef).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
      source: "user-api-key",
    });
  });
});

describe("ModelSelectionController — fallback confirmation (Requirement 5.5)", () => {
  it("does not apply a platform-fallback selection until confirmFallback() runs", async () => {
    const gateway = gatewayReturning([
      {
        provider: "platform",
        status: "ok",
        models: [fallbackModel("platform", "free-tier-1", "Free Tier 1")],
      },
    ]);

    const controller = new ModelSelectionController({ gateway, scope: SCOPE });
    await controller.refresh();

    expect(controller.getState().selectedModelRef).toBeNull();

    controller.setSelectedModel({
      provider: "platform",
      modelId: "free-tier-1",
      source: "platform-fallback",
    });

    const pendingState = controller.getState();
    expect(pendingState.selectedModelRef).toBeNull();
    expect(pendingState.pendingFallback).not.toBeNull();
    expect(pendingState.pendingFallback?.modelRef).toEqual({
      provider: "platform",
      modelId: "free-tier-1",
      source: "platform-fallback",
    });
    expect(pendingState.pendingFallback?.notice).toContain(
      "Platform fallback",
    );

    controller.confirmFallback();

    const confirmed = controller.getState();
    expect(confirmed.pendingFallback).toBeNull();
    expect(confirmed.selectedModelRef).toEqual({
      provider: "platform",
      modelId: "free-tier-1",
      source: "platform-fallback",
    });
  });

  it("does not change the active selection when a fallback is pending", async () => {
    const gateway = gatewayReturning([
      {
        provider: "openai",
        status: "ok",
        models: [userKeyModel("openai", "gpt-4o")],
      },
      {
        provider: "platform",
        status: "ok",
        models: [fallbackModel("platform", "fallback-a")],
      },
    ]);

    const controller = new ModelSelectionController({ gateway, scope: SCOPE });
    await controller.refresh();

    controller.setSelectedModel({
      provider: "openai",
      modelId: "gpt-4o",
      source: "user-api-key",
    });

    expect(controller.getState().selectedModelRef?.modelId).toBe("gpt-4o");

    controller.setSelectedModel({
      provider: "platform",
      modelId: "fallback-a",
      source: "platform-fallback",
    });

    const state = controller.getState();
    expect(state.selectedModelRef?.modelId).toBe("gpt-4o");
    expect(state.pendingFallback?.modelRef.modelId).toBe("fallback-a");

    // Cancel: still on the original selection.
    controller.cancelPendingFallback();
    const cancelled = controller.getState();
    expect(cancelled.pendingFallback).toBeNull();
    expect(cancelled.selectedModelRef?.modelId).toBe("gpt-4o");
  });

  it("treats user-key selections as immediate (no confirmation required)", async () => {
    const gateway = gatewayReturning([
      {
        provider: "openai",
        status: "ok",
        models: [userKeyModel("openai", "gpt-4o")],
      },
    ]);

    const controller = new ModelSelectionController({ gateway, scope: SCOPE });
    await controller.refresh();

    controller.setSelectedModel({
      provider: "openai",
      modelId: "gpt-4o",
      source: "user-api-key",
    });

    const state = controller.getState();
    expect(state.pendingFallback).toBeNull();
    expect(state.selectedModelRef).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
      source: "user-api-key",
    });
  });

  it("rejects selecting a model that is not present in the snapshot", async () => {
    const gateway = gatewayReturning([
      {
        provider: "openai",
        status: "ok",
        models: [userKeyModel("openai", "gpt-4o")],
      },
    ]);

    const controller = new ModelSelectionController({ gateway, scope: SCOPE });
    await controller.refresh();

    expect(() =>
      controller.setSelectedModel({
        provider: "openai",
        modelId: "nonexistent",
        source: "user-api-key",
      }),
    ).toThrow(/not found/i);
  });
});

describe("ModelSelectionController — selection persistence across refresh()", () => {
  it("preserves the active selection when the model is still listed", async () => {
    const first: readonly ProviderModelsResult[] = [
      {
        provider: "openai",
        status: "ok",
        models: [
          userKeyModel("openai", "gpt-4o"),
          userKeyModel("openai", "gpt-4o-mini"),
        ],
      },
    ];
    const second: readonly ProviderModelsResult[] = [
      {
        provider: "openai",
        status: "ok",
        models: [
          userKeyModel("openai", "gpt-4o"),
          userKeyModel("openai", "gpt-4o-mini"),
          userKeyModel("openai", "gpt-4o-2024"),
        ],
      },
    ];
    const gateway = gatewayReturning(first, second);

    const controller = new ModelSelectionController({ gateway, scope: SCOPE });
    await controller.refresh();

    controller.setSelectedModel({
      provider: "openai",
      modelId: "gpt-4o",
      source: "user-api-key",
    });

    await controller.refresh();
    expect(controller.getState().selectedModelRef).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
      source: "user-api-key",
    });
  });

  it("clears the active selection when the model disappears (e.g. key removed)", async () => {
    const first: readonly ProviderModelsResult[] = [
      {
        provider: "openai",
        status: "ok",
        models: [userKeyModel("openai", "gpt-4o")],
      },
    ];
    const second: readonly ProviderModelsResult[] = [
      {
        provider: "openai",
        status: "error",
        reason: "no api key configured",
      },
    ];
    const gateway = gatewayReturning(first, second);

    const controller = new ModelSelectionController({ gateway, scope: SCOPE });
    await controller.refresh();
    controller.setSelectedModel({
      provider: "openai",
      modelId: "gpt-4o",
      source: "user-api-key",
    });
    expect(controller.getState().selectedModelRef).not.toBeNull();

    await controller.refresh();
    expect(controller.getState().selectedModelRef).toBeNull();
  });

  it("notifies subscribers on every state transition", async () => {
    const gateway = gatewayReturning([
      {
        provider: "openai",
        status: "ok",
        models: [userKeyModel("openai", "gpt-4o")],
      },
    ]);
    const controller = new ModelSelectionController({ gateway, scope: SCOPE });

    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    await controller.refresh();
    controller.setSelectedModel({
      provider: "openai",
      modelId: "gpt-4o",
      source: "user-api-key",
    });

    // loading + ready + selection = 3 notifications
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();

    controller.clearSelection();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("surfaces a top-level error when the gateway rejects", async () => {
    const gateway: ModelCatalogGateway = {
      async listModelsForUser(_scope) {
        throw new Error("network down");
      },
    };
    const controller = new ModelSelectionController({ gateway, scope: SCOPE });

    await controller.refresh();
    const state = controller.getState();
    expect(state.status).toEqual({ kind: "error", reason: "network down" });
    // Empty providers list is fine here; the important thing is we did
    // not crash and the screen can show an actionable error.
    expect(state.providers).toEqual([]);
  });
});
