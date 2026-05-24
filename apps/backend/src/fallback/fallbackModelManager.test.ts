/**
 * Unit tests for {@link FallbackModelManager}.
 *
 * Covers tasks 19.1 and 19.2:
 *
 *   • Read-side policy (19.1):
 *     — Only free-tier models are returned by default.
 *     — Premium opt-in surfaces premium models.
 *     — Rate limit denies with `rate_limited`.
 *     — No configured fallback returns `not_configured`.
 *   • Write-side notification gate (19.2):
 *     — Notification gate blocks usage without ack.
 *     — Ack with `true` invokes record exactly once.
 *     — Ack with anything else returns `ack_required`.
 *     — Per-scope and per-provider isolation.
 *     — Proposal expiry returns `unknown_proposal`.
 *     — Day rollover: yesterday's usage doesn't count today.
 *     — `recordFallbackUsage` advances the counter and feeds back into
 *       `canUseFallback`.
 *
 * The companion property test for fallback policy enforcement lives in
 * task 19.3 and is intentionally not duplicated here.
 *
 * Validates: Requirements 5.5, 13.3, 13.4, 13.5, 13.6, 13.7.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";

import type { ModelInfo } from "../models/index.js";

import {
  FallbackModelManager,
  InMemoryFallbackUsageStore,
  type ConfiguredFallbackModel,
  type FallbackPolicy,
  type FallbackUsageStore,
} from "./index.js";

function localScope(deviceId = "device-1"): Scope {
  return { kind: "local", deviceId };
}

function model(
  provider: ProviderId,
  modelId: string,
  tier?: "basic" | "standard" | "premium",
): ModelInfo {
  const m: ModelInfo = {
    provider,
    modelId,
    displayName: modelId,
    source: "platform-fallback",
    ...(tier !== undefined ? { qualityTier: tier } : {}),
  };
  return m;
}

function entry(m: ModelInfo, notice = "Platform fallback"): ConfiguredFallbackModel {
  return { model: m, notice };
}

/**
 * Mutable clock helper for proposal-TTL and day-rollover tests.
 * Returning a method bound to the closure avoids accidentally pinning
 * `this` when the function is passed to the manager.
 */
function makeClock(initialMs: number): {
  now: () => number;
  advance: (ms: number) => void;
  set: (ms: number) => void;
} {
  let current = initialMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

/** Convenience: build a manager with sensible test defaults. */
function buildManager(options: {
  policy?: Partial<FallbackPolicy>;
  configured?: Record<ProviderId, readonly ConfiguredFallbackModel[]>;
  usageStore?: FallbackUsageStore;
  now?: () => number;
  generateProposalId?: () => string;
}): {
  manager: FallbackModelManager;
  store: InMemoryFallbackUsageStore;
} {
  const store =
    (options.usageStore as InMemoryFallbackUsageStore | undefined) ??
    new InMemoryFallbackUsageStore({
      now: options.now ?? (() => 1_700_000_000_000),
    });
  const manager = new FallbackModelManager({
    policy: {
      allowFreeTierFallback: false,
      allowPremiumFallback: false,
      perDayLimit: 0,
      ...options.policy,
    },
    configuredModels: options.configured ?? {},
    usageStore: store,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.generateProposalId !== undefined
      ? { generateProposalId: options.generateProposalId }
      : {}),
  });
  return { manager, store };
}

describe("FallbackModelManager", () => {
  describe("constructor validation", () => {
    it("rejects non-finite perDayLimit", () => {
      expect(
        () =>
          new FallbackModelManager({
            policy: {
              allowFreeTierFallback: true,
              allowPremiumFallback: false,
              perDayLimit: Number.POSITIVE_INFINITY,
            },
            configuredModels: {},
            usageStore: new InMemoryFallbackUsageStore(),
          }),
      ).toThrow(/finite/i);
    });

    it("rejects negative perDayLimit", () => {
      expect(
        () =>
          new FallbackModelManager({
            policy: {
              allowFreeTierFallback: true,
              allowPremiumFallback: false,
              perDayLimit: -1,
            },
            configuredModels: {},
            usageStore: new InMemoryFallbackUsageStore(),
          }),
      ).toThrow(/>= 0/);
    });

    it("rejects non-positive proposalTtlMs when provided", () => {
      expect(
        () =>
          new FallbackModelManager({
            policy: {
              allowFreeTierFallback: true,
              allowPremiumFallback: false,
              perDayLimit: 1,
              proposalTtlMs: 0,
            },
            configuredModels: {},
            usageStore: new InMemoryFallbackUsageStore(),
          }),
      ).toThrow(/proposalTtlMs/);
    });

    it("rejects configured models with non-fallback source", () => {
      const wrong: ModelInfo = {
        provider: "openai",
        modelId: "gpt-4o-mini",
        displayName: "gpt-4o-mini",
        source: "user-api-key", // wrong on purpose
      };
      expect(
        () =>
          new FallbackModelManager({
            policy: {
              allowFreeTierFallback: true,
              allowPremiumFallback: false,
              perDayLimit: 1,
            },
            configuredModels: {
              openai: [{ model: wrong, notice: "x" }],
            },
            usageStore: new InMemoryFallbackUsageStore(),
          }),
      ).toThrow(/platform-fallback/);
    });

    it("rejects configured models registered under the wrong provider", () => {
      const m = model("anthropic", "haiku", "basic");
      expect(
        () =>
          new FallbackModelManager({
            policy: {
              allowFreeTierFallback: true,
              allowPremiumFallback: false,
              perDayLimit: 1,
            },
            configuredModels: {
              openai: [entry(m)],
            },
            usageStore: new InMemoryFallbackUsageStore(),
          }),
      ).toThrow(/registered under/);
    });
  });

  describe("getFallbackOptions", () => {
    it("returns only free-tier models when allowFreeTierFallback is on (default premium off)", () => {
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {
          openai: [
            entry(model("openai", "free-tier", "basic")),
            entry(model("openai", "standard-tier", "standard")),
            entry(model("openai", "premium-tier", "premium")),
          ],
        },
      });

      const out = manager.getFallbackOptions("openai");
      expect(out.map((m) => m.modelId)).toEqual([
        "free-tier",
        "standard-tier",
      ]);
    });

    it("returns nothing when both opt-ins are off (default policy)", () => {
      const { manager } = buildManager({
        configured: {
          openai: [
            entry(model("openai", "free-tier", "basic")),
            entry(model("openai", "premium-tier", "premium")),
          ],
        },
      });

      expect(manager.getFallbackOptions("openai")).toEqual([]);
    });

    it("includes premium models when allowPremiumFallback is on", () => {
      const { manager } = buildManager({
        policy: {
          allowFreeTierFallback: true,
          allowPremiumFallback: true,
          perDayLimit: 5,
        },
        configured: {
          openai: [
            entry(model("openai", "free-tier", "basic")),
            entry(model("openai", "premium-tier", "premium")),
          ],
        },
      });

      const out = manager.getFallbackOptions("openai");
      expect(out.map((m) => m.modelId)).toEqual([
        "free-tier",
        "premium-tier",
      ]);
    });

    it("does not return premium-only models when only allowFreeTierFallback is on", () => {
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {
          openai: [entry(model("openai", "premium-tier", "premium"))],
        },
      });

      expect(manager.getFallbackOptions("openai")).toEqual([]);
    });

    it("treats untiered models as free-tier (gated by allowFreeTierFallback)", () => {
      const { manager } = buildManager({
        policy: {
          allowFreeTierFallback: false,
          allowPremiumFallback: true, // premium on, free off
          perDayLimit: 5,
        },
        configured: {
          openai: [entry(model("openai", "no-tier"))], // qualityTier undefined
        },
      });

      // Untiered model must NOT slip through the premium gate.
      expect(manager.getFallbackOptions("openai")).toEqual([]);
    });

    it("returns empty array for unknown provider", () => {
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
      });

      expect(manager.getFallbackOptions("anthropic")).toEqual([]);
    });

    it("preserves configured order so cheap/free can be preferred", () => {
      const { manager } = buildManager({
        policy: {
          allowFreeTierFallback: true,
          allowPremiumFallback: true,
          perDayLimit: 5,
        },
        configured: {
          openai: [
            entry(model("openai", "free-1", "basic")),
            entry(model("openai", "free-2", "basic")),
            entry(model("openai", "premium-1", "premium")),
          ],
        },
      });

      const out = manager.getFallbackOptions("openai");
      expect(out.map((m) => m.modelId)).toEqual([
        "free-1",
        "free-2",
        "premium-1",
      ]);
    });
  });

  describe("canUseFallback", () => {
    it("returns not_configured when the provider has no entries", async () => {
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {},
      });

      const decision = await manager.canUseFallback({
        scope: localScope(),
        provider: "openai",
      });
      expect(decision).toEqual({ ok: false, reason: "not_configured" });
    });

    it("returns policy_disabled when both opt-ins are off but options exist", async () => {
      const { manager } = buildManager({
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
      });

      const decision = await manager.canUseFallback({
        scope: localScope(),
        provider: "openai",
      });
      expect(decision).toEqual({ ok: false, reason: "policy_disabled" });
    });

    it("returns premium_disabled when only premium options exist and premium is off", async () => {
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {
          openai: [entry(model("openai", "premium-tier", "premium"))],
        },
      });

      const decision = await manager.canUseFallback({
        scope: localScope(),
        provider: "openai",
      });
      expect(decision).toEqual({ ok: false, reason: "premium_disabled" });
    });

    it("allows a free-tier model when policy permits and budget remains", async () => {
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 3 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
      });

      const decision = await manager.canUseFallback({
        scope: localScope(),
        provider: "openai",
      });
      expect(decision).toEqual({
        ok: true,
        model: {
          provider: "openai",
          modelId: "free-tier",
          source: "platform-fallback",
        },
      });
    });

    it("allows a premium model only when allowPremiumFallback is on", async () => {
      const { manager: gated } = buildManager({
        policy: {
          allowFreeTierFallback: false,
          allowPremiumFallback: false,
          perDayLimit: 1,
        },
        configured: {
          openai: [entry(model("openai", "premium-tier", "premium"))],
        },
      });
      expect(
        await gated.canUseFallback({ scope: localScope(), provider: "openai" }),
      ).toEqual({ ok: false, reason: "policy_disabled" });

      const { manager: opened } = buildManager({
        policy: {
          allowFreeTierFallback: false,
          allowPremiumFallback: true,
          perDayLimit: 1,
        },
        configured: {
          openai: [entry(model("openai", "premium-tier", "premium"))],
        },
      });
      expect(
        await opened.canUseFallback({ scope: localScope(), provider: "openai" }),
      ).toEqual({
        ok: true,
        model: {
          provider: "openai",
          modelId: "premium-tier",
          source: "platform-fallback",
        },
      });
    });

    it("returns rate_limited once today's usage hits perDayLimit", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 2 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
      });
      const scope = localScope();

      // Two calls allowed.
      await store.recordUsage({ scope, provider: "openai" });
      await store.recordUsage({ scope, provider: "openai" });

      const decision = await manager.canUseFallback({
        scope,
        provider: "openai",
      });
      expect(decision).toEqual({ ok: false, reason: "rate_limited" });
    });

    it("treats perDayLimit=0 as fully rate-limited even with policy enabled", async () => {
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 0 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
      });

      const decision = await manager.canUseFallback({
        scope: localScope(),
        provider: "openai",
      });
      expect(decision).toEqual({ ok: false, reason: "rate_limited" });
    });

    it("isolates daily counters between scopes", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 1 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
      });

      const a = localScope("device-A");
      const b = localScope("device-B");
      await store.recordUsage({ scope: a, provider: "openai" });

      // a is at limit, b should still be allowed.
      expect(
        await manager.canUseFallback({ scope: a, provider: "openai" }),
      ).toEqual({ ok: false, reason: "rate_limited" });
      expect(
        await manager.canUseFallback({ scope: b, provider: "openai" }),
      ).toMatchObject({ ok: true });
    });

    it("isolates daily counters between providers", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 1 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
          anthropic: [entry(model("anthropic", "haiku", "basic"))],
        },
        usageStore: store,
      });

      const scope = localScope();
      await store.recordUsage({ scope, provider: "openai" });

      expect(
        await manager.canUseFallback({ scope, provider: "openai" }),
      ).toEqual({ ok: false, reason: "rate_limited" });
      expect(
        await manager.canUseFallback({ scope, provider: "anthropic" }),
      ).toMatchObject({ ok: true });
    });

    it("treats malformed usage counts as zero (defence in depth)", async () => {
      // Hand-rolled malicious store: returns NaN, then a negative.
      const seq: number[] = [Number.NaN, -7];
      const buggyStore: FallbackUsageStore = {
        async getUsageCountToday() {
          // shift returns undefined when exhausted, so coerce
          const v = seq.shift();
          return v === undefined ? 0 : v;
        },
        async recordUsage() {
          // not exercised in this test
        },
      };

      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 1 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: buggyStore,
      });

      // First call: usage=NaN → treated as 0 → allowed.
      expect(
        await manager.canUseFallback({
          scope: localScope(),
          provider: "openai",
        }),
      ).toMatchObject({ ok: true });

      // Second call: usage=-7 → treated as 0 → still allowed.
      expect(
        await manager.canUseFallback({
          scope: localScope(),
          provider: "openai",
        }),
      ).toMatchObject({ ok: true });
    });

    it("picks the first policy-allowed model in configured order", async () => {
      const { manager } = buildManager({
        policy: {
          allowFreeTierFallback: true,
          allowPremiumFallback: true,
          perDayLimit: 5,
        },
        configured: {
          openai: [
            entry(model("openai", "first", "basic")),
            entry(model("openai", "second", "standard")),
            entry(model("openai", "third", "premium")),
          ],
        },
      });

      const decision = await manager.canUseFallback({
        scope: localScope(),
        provider: "openai",
      });
      expect(decision).toMatchObject({
        ok: true,
        model: { modelId: "first", source: "platform-fallback" },
      });
    });
  });

  describe("requestFallbackWithNotification", () => {
    it("returns the same denial shape as canUseFallback when policy denies", async () => {
      const { manager } = buildManager({
        // both opt-ins off
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
      });

      const result = await manager.requestFallbackWithNotification({
        scope: localScope(),
        provider: "openai",
      });
      expect(result).toEqual({ ok: false, reason: "policy_disabled" });
    });

    it("returns rate_limited when budget is exhausted", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 1 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
      });
      await store.recordUsage({ scope: localScope(), provider: "openai" });

      const result = await manager.requestFallbackWithNotification({
        scope: localScope(),
        provider: "openai",
      });
      expect(result).toEqual({ ok: false, reason: "rate_limited" });
    });

    it("issues a proposal with requiresUserAcknowledgement=true on allow", async () => {
      let counter = 0;
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        generateProposalId: () => `p-${++counter}`,
      });

      const result = await manager.requestFallbackWithNotification({
        scope: localScope(),
        provider: "openai",
      });

      expect(result).toEqual({
        kind: "proposal",
        proposalId: "p-1",
        model: {
          provider: "openai",
          modelId: "free-tier",
          source: "platform-fallback",
        },
        requiresUserAcknowledgement: true,
      });
    });

    it("does NOT advance the daily counter when only proposing", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const recordSpy = vi.spyOn(store, "recordUsage");
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 1 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
      });

      await manager.requestFallbackWithNotification({
        scope: localScope(),
        provider: "openai",
      });

      expect(recordSpy).not.toHaveBeenCalled();
      // Subsequent canUseFallback should still allow because nothing
      // has been recorded yet.
      expect(
        await manager.canUseFallback({
          scope: localScope(),
          provider: "openai",
        }),
      ).toMatchObject({ ok: true });
    });
  });

  describe("acknowledgeAndUseFallback", () => {
    it("rejects with ack_required when ack flag is not literally true", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const recordSpy = vi.spyOn(store, "recordUsage");
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
        generateProposalId: () => "p-A",
      });

      const proposal = await manager.requestFallbackWithNotification({
        scope: localScope(),
        provider: "openai",
      });
      if (proposal.ok === false) {
        throw new Error("expected proposal");
      }

      const result = await manager.acknowledgeAndUseFallback({
        proposalId: proposal.proposalId,
        ack: { acknowledgedByUser: false },
        scope: localScope(),
        provider: "openai",
        model: proposal.model,
      });

      expect(result).toEqual({ kind: "rejected", code: "ack_required" });
      expect(recordSpy).not.toHaveBeenCalled();
    });

    it("records exactly one usage when ack is true", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const recordSpy = vi.spyOn(store, "recordUsage");
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
        generateProposalId: () => "p-B",
      });

      const proposal = await manager.requestFallbackWithNotification({
        scope: localScope(),
        provider: "openai",
      });
      if (proposal.ok === false) {
        throw new Error("expected proposal");
      }

      const result = await manager.acknowledgeAndUseFallback({
        proposalId: proposal.proposalId,
        ack: { acknowledgedByUser: true },
        scope: localScope(),
        provider: "openai",
        model: proposal.model,
      });

      expect(result).toEqual({ kind: "accepted" });
      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy).toHaveBeenCalledWith({
        scope: localScope(),
        provider: "openai",
      });
    });

    it("rejects unknown proposalId with unknown_proposal", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const recordSpy = vi.spyOn(store, "recordUsage");
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
      });

      const result = await manager.acknowledgeAndUseFallback({
        proposalId: "not-issued",
        ack: { acknowledgedByUser: true },
        scope: localScope(),
        provider: "openai",
        model: {
          provider: "openai",
          modelId: "free-tier",
          source: "platform-fallback",
        },
      });

      expect(result).toEqual({ kind: "rejected", code: "unknown_proposal" });
      expect(recordSpy).not.toHaveBeenCalled();
    });

    it("rejects a second ack of the same proposal as unknown_proposal (one-shot)", async () => {
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        generateProposalId: () => "p-C",
      });

      const proposal = await manager.requestFallbackWithNotification({
        scope: localScope(),
        provider: "openai",
      });
      if (proposal.ok === false) {
        throw new Error("expected proposal");
      }

      const first = await manager.acknowledgeAndUseFallback({
        proposalId: proposal.proposalId,
        ack: { acknowledgedByUser: true },
        scope: localScope(),
        provider: "openai",
        model: proposal.model,
      });
      expect(first).toEqual({ kind: "accepted" });

      const second = await manager.acknowledgeAndUseFallback({
        proposalId: proposal.proposalId,
        ack: { acknowledgedByUser: true },
        scope: localScope(),
        provider: "openai",
        model: proposal.model,
      });
      expect(second).toEqual({ kind: "rejected", code: "unknown_proposal" });
    });

    it("rejects an expired proposal as unknown_proposal", async () => {
      const clock = makeClock(1_700_000_000_000);
      const { manager } = buildManager({
        policy: {
          allowFreeTierFallback: true,
          perDayLimit: 5,
          proposalTtlMs: 60_000, // 1 minute for the test
        },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        now: clock.now,
        generateProposalId: () => "p-EXP",
      });

      const proposal = await manager.requestFallbackWithNotification({
        scope: localScope(),
        provider: "openai",
      });
      if (proposal.ok === false) {
        throw new Error("expected proposal");
      }

      // Advance past the TTL.
      clock.advance(120_000);

      const result = await manager.acknowledgeAndUseFallback({
        proposalId: proposal.proposalId,
        ack: { acknowledgedByUser: true },
        scope: localScope(),
        provider: "openai",
        model: proposal.model,
      });
      expect(result).toEqual({ kind: "rejected", code: "unknown_proposal" });
    });

    it("rejects a proposal redirected to a different scope as unknown_proposal", async () => {
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
      });

      const proposal = await manager.requestFallbackWithNotification({
        scope: localScope("device-A"),
        provider: "openai",
      });
      if (proposal.ok === false) {
        throw new Error("expected proposal");
      }

      const result = await manager.acknowledgeAndUseFallback({
        proposalId: proposal.proposalId,
        ack: { acknowledgedByUser: true },
        scope: localScope("device-B"), // different scope
        provider: "openai",
        model: proposal.model,
      });
      expect(result).toEqual({ kind: "rejected", code: "unknown_proposal" });
    });
  });

  describe("notification gate end-to-end", () => {
    it("blocks usage entirely without a successful ack", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const recordSpy = vi.spyOn(store, "recordUsage");
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 5 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
      });

      // Three failed attempts: missing ack flag, false flag, wrong id.
      const proposal = await manager.requestFallbackWithNotification({
        scope: localScope(),
        provider: "openai",
      });
      if (proposal.ok === false) {
        throw new Error("expected proposal");
      }

      await manager.acknowledgeAndUseFallback({
        proposalId: proposal.proposalId,
        ack: { acknowledgedByUser: false },
        scope: localScope(),
        provider: "openai",
        model: proposal.model,
      });
      await manager.acknowledgeAndUseFallback({
        proposalId: "garbage",
        ack: { acknowledgedByUser: true },
        scope: localScope(),
        provider: "openai",
        model: proposal.model,
      });

      expect(recordSpy).not.toHaveBeenCalled();
    });

    it("hits rate_limited on the next canUseFallback after limit is reached via ack", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      let counter = 0;
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 1 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
        generateProposalId: () => `p-${++counter}`,
      });

      const proposal = await manager.requestFallbackWithNotification({
        scope: localScope(),
        provider: "openai",
      });
      if (proposal.ok === false) {
        throw new Error("expected proposal");
      }

      const acked = await manager.acknowledgeAndUseFallback({
        proposalId: proposal.proposalId,
        ack: { acknowledgedByUser: true },
        scope: localScope(),
        provider: "openai",
        model: proposal.model,
      });
      expect(acked).toEqual({ kind: "accepted" });

      const next = await manager.canUseFallback({
        scope: localScope(),
        provider: "openai",
      });
      expect(next).toEqual({ ok: false, reason: "rate_limited" });
    });
  });

  describe("recordFallbackUsage", () => {
    it("delegates to the usage store and feeds back into canUseFallback", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const recordSpy = vi.spyOn(store, "recordUsage");
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 1 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
      });

      await manager.recordFallbackUsage({
        scope: localScope(),
        provider: "openai",
      });

      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy).toHaveBeenCalledWith({
        scope: localScope(),
        provider: "openai",
      });

      // recordFallbackUsage does NOT bypass the rate-limit check —
      // the next canUseFallback for the same (scope, provider)
      // observes the increment.
      expect(
        await manager.canUseFallback({
          scope: localScope(),
          provider: "openai",
        }),
      ).toEqual({ ok: false, reason: "rate_limited" });
    });

    it("isolates per-scope when called with different scopes", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 1 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
      });

      await manager.recordFallbackUsage({
        scope: localScope("device-A"),
        provider: "openai",
      });

      expect(
        await manager.canUseFallback({
          scope: localScope("device-A"),
          provider: "openai",
        }),
      ).toEqual({ ok: false, reason: "rate_limited" });
      expect(
        await manager.canUseFallback({
          scope: localScope("device-B"),
          provider: "openai",
        }),
      ).toMatchObject({ ok: true });
    });

    it("isolates per-provider when called with different providers", async () => {
      const store = new InMemoryFallbackUsageStore({
        now: () => 1_700_000_000_000,
      });
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 1 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
          anthropic: [entry(model("anthropic", "haiku", "basic"))],
        },
        usageStore: store,
      });

      await manager.recordFallbackUsage({
        scope: localScope(),
        provider: "openai",
      });

      expect(
        await manager.canUseFallback({
          scope: localScope(),
          provider: "openai",
        }),
      ).toEqual({ ok: false, reason: "rate_limited" });
      expect(
        await manager.canUseFallback({
          scope: localScope(),
          provider: "anthropic",
        }),
      ).toMatchObject({ ok: true });
    });

    it("forgets yesterday's usage after a UTC day rollover", async () => {
      // Pin the store's clock so we control "today" precisely.
      const day1Ms = Date.UTC(2024, 0, 1, 12, 0, 0); // 2024-01-01 12:00:00 UTC
      const day2Ms = Date.UTC(2024, 0, 2, 0, 0, 1); // 2024-01-02 00:00:01 UTC
      let nowMs = day1Ms;
      const store = new InMemoryFallbackUsageStore({ now: () => nowMs });
      const { manager } = buildManager({
        policy: { allowFreeTierFallback: true, perDayLimit: 1 },
        configured: {
          openai: [entry(model("openai", "free-tier", "basic"))],
        },
        usageStore: store,
      });

      // Day 1: hit the limit.
      await manager.recordFallbackUsage({
        scope: localScope(),
        provider: "openai",
      });
      expect(
        await manager.canUseFallback({
          scope: localScope(),
          provider: "openai",
        }),
      ).toEqual({ ok: false, reason: "rate_limited" });

      // Day 2: rollover, the previous day's bucket no longer counts.
      nowMs = day2Ms;
      expect(
        await manager.canUseFallback({
          scope: localScope(),
          provider: "openai",
        }),
      ).toMatchObject({ ok: true });
    });
  });

  describe("getPolicy", () => {
    it("returns a snapshot detached from internal state", () => {
      const { manager } = buildManager({
        policy: {
          allowFreeTierFallback: true,
          allowPremiumFallback: false,
          perDayLimit: 4,
        },
      });
      const snap = manager.getPolicy();
      expect(snap).toEqual({
        allowFreeTierFallback: true,
        allowPremiumFallback: false,
        perDayLimit: 4,
      });
      // Mutating the snapshot doesn't change subsequent reads.
      (snap as { perDayLimit: number }).perDayLimit = 999;
      expect(manager.getPolicy().perDayLimit).toBe(4);
    });
  });
});
