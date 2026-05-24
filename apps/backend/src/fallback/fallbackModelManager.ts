/**
 * Platform Fallback Model Manager.
 *
 * Source: `design.md` → "Platform Fallback Model Manager".
 *
 * Validates: Requirements 5.5, 13.3, 13.4, 13.5, 13.6, 13.7.
 *
 * Responsibilities:
 *
 *   • {@link FallbackModelManager.getFallbackOptions} — return the
 *     {@link ModelInfo}s currently allowed by policy for a provider.
 *     Premium-tier models are filtered out unless
 *     `allowPremiumFallback === true` (Requirement 13.7). If no tier
 *     is enabled, the result is empty (Requirement 13.5).
 *   • {@link FallbackModelManager.canUseFallback} — decide whether a
 *     specific scope may use a fallback right now, returning a
 *     structured allow/deny result (Requirements 13.5, 13.6, 13.7).
 *   • {@link FallbackModelManager.requestFallbackWithNotification} —
 *     run the policy check and, on allow, issue a `FallbackProposal`
 *     the caller MUST surface to the user before any provider call
 *     (Requirement 13.4).
 *   • {@link FallbackModelManager.acknowledgeAndUseFallback} —
 *     consume a previously-issued proposal once the user has
 *     explicitly acknowledged the switch. Verifies the ack flag, the
 *     proposal id and TTL, and only then records usage against the
 *     daily budget.
 *   • {@link FallbackModelManager.recordFallbackUsage} — public
 *     write-side passthrough to {@link FallbackUsageStore.recordUsage}
 *     for callers that already enforce their own notification gate
 *     (e.g., a server-side replay path) but still need the daily
 *     counter to advance (Requirement 13.6).
 *
 * Design notes:
 *
 *   • The manager never sees a `Platform_Backup_Key`. Per the design
 *     rule "Platform backup keys are never visible to users or
 *     agents", key resolution lives in a downstream component (the
 *     Agent Runtime, when it actually issues a fallback Provider call)
 *     and uses the same `ServerComponentToken`-gated flow as user
 *     keys.
 *   • The manager is constructed with an *immutable* set of configured
 *     fallback models per provider. Reconfiguration in production is a
 *     deploy-time concern; runtime mutation would invite race
 *     conditions between policy reads and the daily-counter writes.
 *   • The denial-reason precedence is fixed and exposed in tests:
 *       1. `not_configured` — nothing to even consider for this provider.
 *       2. `policy_disabled` — every tier is off.
 *       3. `premium_disabled` — only premium options remain and they
 *          are gated.
 *       4. `rate_limited` — at least one model would be allowed but
 *          today's budget is exhausted.
 *       5. allowed — the first matching configured model is returned.
 *     This ordering is the most informative-first ordering the UI can
 *     surface: the deepest reason ("you forgot to configure anything")
 *     beats more transient reasons ("we ran out of free calls today").
 *   • `recordFallbackUsage` does NOT bypass `canUseFallback`. It
 *     advances the daily counter; the next `canUseFallback` for the
 *     same `(scope, provider)` will see the increment and may return
 *     `rate_limited`. Callers that want a single-shot allow-and-record
 *     should go through `acknowledgeAndUseFallback`.
 */

import { randomUUID } from "node:crypto";

import type {
  ModelRef,
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";

import type { ModelInfo } from "../models/index.js";

import {
  InMemoryFallbackProposalStore,
  type FallbackProposalStore,
} from "./fallbackProposalStore.js";
import {
  DEFAULT_PROPOSAL_TTL_MS,
  type ConfiguredFallbackModel,
  type FallbackAcknowledgement,
  type FallbackDecision,
  type FallbackPolicy,
  type FallbackUsageStore,
  type RequestFallbackResult,
} from "./types.js";

/**
 * Options accepted by {@link FallbackModelManager}.
 *
 * Per-provider grouping is required at construction so the manager can
 * answer `getFallbackOptions(provider)` in O(1) without scanning every
 * configured model on each request.
 */
export interface FallbackModelManagerOptions {
  /** Active policy. Required so the default-deny posture is explicit. */
  readonly policy: FallbackPolicy;
  /**
   * Configured fallback models keyed by provider. Empty arrays are
   * acceptable but signalled as `not_configured` to callers; the
   * constructor rejects entries whose `ModelInfo.source` is not
   * `"platform-fallback"` (Requirement 5.5).
   */
  readonly configuredModels: Readonly<
    Record<ProviderId, readonly ConfiguredFallbackModel[]>
  >;
  /** Pluggable usage store; see `FallbackUsageStore`. */
  readonly usageStore: FallbackUsageStore;
  /**
   * Pluggable proposal store. Defaults to an
   * {@link InMemoryFallbackProposalStore} configured with the
   * policy's `proposalTtlMs` (or {@link DEFAULT_PROPOSAL_TTL_MS} if
   * unset).
   */
  readonly proposalStore?: FallbackProposalStore;
  /**
   * Clock for proposal expiry. Defaults to `Date.now`. Tests inject a
   * controllable clock so they can advance time without sleeping.
   */
  readonly now?: () => number;
  /**
   * Generator for proposal ids. Defaults to `crypto.randomUUID()`.
   * Tests inject a deterministic counter for stable assertions.
   */
  readonly generateProposalId?: () => string;
}

export class FallbackModelManager {
  private readonly policy: FallbackPolicy;
  private readonly configuredByProvider: Map<
    ProviderId,
    readonly ConfiguredFallbackModel[]
  >;
  private readonly usageStore: FallbackUsageStore;
  private readonly proposalStore: FallbackProposalStore;
  private readonly now: () => number;
  private readonly generateProposalId: () => string;

  public constructor(options: FallbackModelManagerOptions) {
    if (!Number.isFinite(options.policy.perDayLimit)) {
      throw new Error("FallbackPolicy.perDayLimit must be a finite number");
    }
    if (options.policy.perDayLimit < 0) {
      throw new Error("FallbackPolicy.perDayLimit must be >= 0");
    }
    if (
      options.policy.proposalTtlMs !== undefined &&
      (!Number.isFinite(options.policy.proposalTtlMs) ||
        options.policy.proposalTtlMs <= 0)
    ) {
      throw new Error(
        "FallbackPolicy.proposalTtlMs must be a positive finite number when provided",
      );
    }

    this.policy = options.policy;
    this.usageStore = options.usageStore;
    this.now = options.now ?? (() => Date.now());
    this.generateProposalId = options.generateProposalId ?? (() => randomUUID());
    this.proposalStore =
      options.proposalStore ??
      new InMemoryFallbackProposalStore({
        ttlMs: options.policy.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS,
      });

    const map = new Map<ProviderId, readonly ConfiguredFallbackModel[]>();
    for (const [provider, entries] of Object.entries(options.configuredModels)) {
      // Defensive: a misconfigured deployment that registers a
      // user-key model as a fallback would silently bypass labelling
      // (Requirement 5.5). Reject at construction time so the failure
      // is loud at startup, not at first user-facing call.
      for (const e of entries) {
        if (e.model.source !== "platform-fallback") {
          throw new Error(
            `Configured fallback model for "${provider}" must have source "platform-fallback" (got "${e.model.source}")`,
          );
        }
        if (e.model.provider !== provider) {
          throw new Error(
            `Configured fallback model registered under "${provider}" but labelled "${e.model.provider}"`,
          );
        }
      }
      map.set(provider, [...entries]);
    }
    this.configuredByProvider = map;
  }

  /**
   * Returns the configured fallback {@link ModelInfo}s allowed by the
   * current policy for `provider`.
   *
   * Filtering rules:
   *
   *   • If `allowFreeTierFallback === false`, all non-premium models
   *     (including untiered ones) are dropped.
   *   • If `allowPremiumFallback === false`, premium models are
   *     dropped.
   *   • If both are false, the result is always `[]` regardless of
   *     configuration (Requirement 13.5).
   *
   * Order is preserved from `configuredModels[provider]` so the host
   * controls preference ordering. Cheap/free options should come first
   * per the design rule "Cheap/free/basic models are preferred."
   */
  public getFallbackOptions(provider: ProviderId): ModelInfo[] {
    const configured = this.configuredByProvider.get(provider) ?? [];
    return configured
      .map((e) => e.model)
      .filter((m) => this.modelAllowedByPolicy(m));
  }

  /**
   * Decides whether the given `scope` may currently use a fallback for
   * `provider`. See class-level comment for the precedence of denial
   * reasons.
   */
  public async canUseFallback(input: {
    readonly scope: Scope;
    readonly provider: ProviderId;
  }): Promise<FallbackDecision> {
    return this.evaluatePolicy(input);
  }

  /**
   * Notification gate (Requirement 13.4). Runs the same policy check
   * `canUseFallback` runs and, when it allows, issues a one-shot
   * proposal the caller must round-trip back through
   * {@link FallbackModelManager.acknowledgeAndUseFallback}. On any
   * denial, the original {@link FallbackDecision} shape is returned
   * unchanged so callers can keep a single switch on `reason`.
   *
   * The proposal is NOT recorded as usage; the daily counter only
   * advances when a corresponding ack succeeds.
   */
  public async requestFallbackWithNotification(input: {
    readonly scope: Scope;
    readonly provider: ProviderId;
  }): Promise<RequestFallbackResult> {
    const decision = await this.evaluatePolicy(input);
    if (!decision.ok) {
      return decision;
    }

    const proposalId = this.generateProposalId();
    const issuedAtMs = this.now();
    this.proposalStore.put({
      proposalId,
      scope: input.scope,
      provider: input.provider,
      model: decision.model,
      issuedAtMs,
    });

    return {
      kind: "proposal",
      proposalId,
      model: decision.model,
      requiresUserAcknowledgement: true,
    };
  }

  /**
   * Consumes a previously-issued proposal. Returns `accepted` only if:
   *
   *   • `ack.acknowledgedByUser === true` exactly; any other value
   *     yields `rejected: ack_required` and does NOT advance the
   *     daily counter (Requirement 13.4).
   *   • The `proposalId` matches a proposal that hasn't been consumed
   *     and hasn't expired past `proposalTtlMs`. Otherwise the result
   *     is `rejected: unknown_proposal`.
   *
   * On accept, exactly one usage is recorded against today's bucket.
   */
  public async acknowledgeAndUseFallback(input: {
    readonly proposalId: string;
    readonly ack: { readonly acknowledgedByUser: boolean };
    readonly scope: Scope;
    readonly provider: ProviderId;
    readonly model: ModelRef;
  }): Promise<FallbackAcknowledgement> {
    // Ack flag is verified BEFORE touching the proposal store so that
    // a user who clicks "no" on the dialog can be retried with a
    // proper "yes" without losing the proposal.
    if (input.ack.acknowledgedByUser !== true) {
      return { kind: "rejected", code: "ack_required" };
    }

    const record = this.proposalStore.consume(input.proposalId, this.now());
    if (record === null) {
      return { kind: "rejected", code: "unknown_proposal" };
    }

    // Defensive: the caller-provided scope/provider/model should match
    // the proposal we issued. A mismatch means either a bug or an
    // attempt to redirect a proposal at a different target; either way
    // we refuse and treat it as if the proposal had never existed.
    if (
      !scopesEqual(record.scope, input.scope) ||
      record.provider !== input.provider ||
      !modelRefsEqual(record.model, input.model)
    ) {
      return { kind: "rejected", code: "unknown_proposal" };
    }

    await this.usageStore.recordUsage({
      scope: record.scope,
      provider: record.provider,
    });
    return { kind: "accepted" };
  }

  /**
   * Public passthrough to {@link FallbackUsageStore.recordUsage}.
   * Intended for hosts that have already enforced their own
   * notification gate (e.g., a replay/audit path) but still need the
   * daily counter to advance so subsequent `canUseFallback` calls see
   * the new total.
   *
   * Does NOT bypass `canUseFallback`'s rate-limit check — the next
   * `canUseFallback` for the same `(scope, provider)` will observe
   * the increment and may return `rate_limited`.
   */
  public async recordFallbackUsage(input: {
    readonly scope: Scope;
    readonly provider: ProviderId;
  }): Promise<void> {
    await this.usageStore.recordUsage(input);
  }

  /** Test/diagnostic helper — visible policy snapshot. */
  public getPolicy(): FallbackPolicy {
    return { ...this.policy };
  }

  /**
   * Internal policy evaluation shared by {@link canUseFallback} and
   * {@link requestFallbackWithNotification}. Centralising the
   * precedence here keeps the two public entry points in lock-step.
   */
  private async evaluatePolicy(input: {
    readonly scope: Scope;
    readonly provider: ProviderId;
  }): Promise<FallbackDecision> {
    const configured = this.configuredByProvider.get(input.provider) ?? [];

    if (configured.length === 0) {
      return { ok: false, reason: "not_configured" };
    }

    if (
      !this.policy.allowFreeTierFallback &&
      !this.policy.allowPremiumFallback
    ) {
      return { ok: false, reason: "policy_disabled" };
    }

    const allowedByPolicy = configured.filter((e) =>
      this.modelAllowedByPolicy(e.model),
    );

    if (allowedByPolicy.length === 0) {
      // Configuration exists but every option needs an opt-in we
      // don't have. The only way this branch fires (given the
      // earlier `policy_disabled` guard) is the premium gate.
      const everyConfiguredIsPremium = configured.every(
        (e) => e.model.qualityTier === "premium",
      );
      if (everyConfiguredIsPremium && !this.policy.allowPremiumFallback) {
        return { ok: false, reason: "premium_disabled" };
      }
      // Defensive fallthrough: if we somehow reach here with a non-
      // premium-only configuration, surface as policy_disabled rather
      // than silently allowing.
      return { ok: false, reason: "policy_disabled" };
    }

    const used = await this.readUsageCount(input);
    if (used >= this.policy.perDayLimit) {
      return { ok: false, reason: "rate_limited" };
    }

    // Pick the first policy-allowed configured model. The host has
    // already ordered preferences (cheap/free first), so the manager
    // does not re-rank here.
    const chosen = allowedByPolicy[0];
    if (!chosen) {
      // Unreachable under the length check above, but TypeScript's
      // `noUncheckedIndexedAccess` requires a guard.
      return { ok: false, reason: "not_configured" };
    }

    const ref: ModelRef = {
      provider: chosen.model.provider,
      modelId: chosen.model.modelId,
      source: "platform-fallback",
    };
    return { ok: true, model: ref };
  }

  /**
   * Policy gate for a single model. `premium` is allowed only when the
   * dedicated opt-in is set; everything else (including untiered
   * models) requires `allowFreeTierFallback`.
   */
  private modelAllowedByPolicy(model: ModelInfo): boolean {
    if (model.qualityTier === "premium") {
      return this.policy.allowPremiumFallback;
    }
    return this.policy.allowFreeTierFallback;
  }

  /**
   * Reads today's usage with light defence in depth: a buggy backend
   * returning negatives or non-integers MUST NOT permanently lock the
   * fallback open. Anything not a non-negative finite integer is
   * treated as `0`.
   */
  private async readUsageCount(input: {
    readonly scope: Scope;
    readonly provider: ProviderId;
  }): Promise<number> {
    const raw = await this.usageStore.getUsageCountToday(input);
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return 0;
    }
    return Math.floor(raw);
  }
}

function scopesEqual(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "local" && b.kind === "local") {
    return a.deviceId === b.deviceId;
  }
  if (a.kind === "cloud" && b.kind === "cloud") {
    return a.userId === b.userId;
  }
  return false;
}

function modelRefsEqual(a: ModelRef, b: ModelRef): boolean {
  return (
    a.provider === b.provider &&
    a.modelId === b.modelId &&
    a.source === b.source
  );
}
