/**
 * Public types and ports for the Platform Fallback Model Manager.
 *
 * Source: `design.md` → "Platform Fallback Model Manager" and the rules:
 *
 *   • Fallback exists only to improve UX when user API_Key fails, hits rate
 *     limit, or is temporarily unavailable.
 *   • Only explicitly configured fallback models are allowed.
 *   • Cheap/free/basic models are preferred.
 *   • Premium fallback models are disabled unless platform owner explicitly
 *     enables them.
 *   • Fallback usage must be rate-limited.
 *   • Platform backup keys are never visible to users or agents.
 *   • The user MUST be notified before switching from the user's API_Key
 *     to a platform fallback (Requirement 13.4).
 *
 * Validates: Requirements 5.5, 13.3, 13.4, 13.5, 13.6, 13.7.
 *
 * Task 19.1 shipped the read side (`getFallbackOptions` /
 * `canUseFallback`). Task 19.2 adds the user-notification gate
 * (`requestFallbackWithNotification` / `acknowledgeAndUseFallback`)
 * and the public `recordFallbackUsage` write path.
 *
 * Module shape rationale:
 *
 *   • `FallbackPolicy` is the only configuration surface platform owners
 *     touch. The fields map 1:1 to Requirements 13.5/13.6/13.7 plus the
 *     proposal TTL that governs how long a notification stays valid
 *     before the user must re-confirm.
 *   • `FallbackUsageStore` is a port so a persistent backend (Postgres,
 *     Redis) can be swapped in without changing the manager. Both
 *     `getUsageCountToday` and `recordUsage` return promises so async
 *     backends are first-class.
 *   • Configured fallback models are passed in by the host. The manager
 *     never invents a model and never reads from the Provider API — that
 *     would defeat Requirement 13.5 ("only explicitly configured
 *     fallback models").
 */

import type {
  ModelRef,
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";

import type { ModelInfo } from "../models/index.js";

/**
 * Policy controlling which fallback models the manager may surface and
 * how often they may be used.
 *
 * Each field maps to a specific design rule:
 *
 *   • `allowFreeTierFallback` — master switch for free/basic/standard
 *     fallback models. Defaults to `false` in production composition so
 *     that a misconfigured deployment never silently routes traffic to
 *     a platform backup key (Requirement 13.5).
 *   • `allowPremiumFallback` — independent opt-in for `premium` tier
 *     fallback models. Per Requirement 13.7, this MUST default to
 *     `false`; the manager refuses premium models unless the platform
 *     owner has explicitly flipped this on.
 *   • `perDayLimit` — non-negative integer. The manager treats today's
 *     usage count `>= perDayLimit` as rate-limited (Requirement 13.6).
 *     A value of `0` effectively disables fallback usage even when both
 *     allow flags are true; this is intentional and lets operators
 *     pause fallback without changing the model registry.
 *   • `proposalTtlMs` — how long an issued proposal remains
 *     acknowledgeable. Defaults to 5 minutes
 *     ({@link DEFAULT_PROPOSAL_TTL_MS}). After the TTL, the proposal is
 *     forgotten and the manager returns `unknown_proposal` to any late
 *     acknowledgement, forcing a fresh notification round-trip.
 */
export interface FallbackPolicy {
  readonly allowFreeTierFallback: boolean;
  readonly allowPremiumFallback: boolean;
  readonly perDayLimit: number;
  readonly proposalTtlMs?: number;
}

/**
 * A model that the platform owner has explicitly configured as a
 * fallback option.
 *
 * It carries a {@link ModelInfo} (so the UI can render it identically to
 * any other catalog entry — see Requirement 5.5: "Platform fallback
 * models must be clearly labeled") plus a `notice` string the
 * notification flow surfaces to the user before switching.
 *
 * Invariants enforced by `FallbackModelManager`:
 *
 *   • `model.source` MUST be `"platform-fallback"`. The constructor
 *     rejects any other value so a typo cannot turn a user-key model
 *     into a fallback by accident.
 *   • `model.qualityTier`, when present, controls the policy gate.
 *     `premium` is gated by `allowPremiumFallback`; everything else
 *     (`basic`, `standard`, undefined) is gated by
 *     `allowFreeTierFallback`. Treating "undefined tier" as free is
 *     deliberate: an adapter that forgot to label its tier MUST NOT
 *     accidentally bypass the premium gate.
 */
export interface ConfiguredFallbackModel {
  readonly model: ModelInfo;
  readonly notice: string;
}

/**
 * Inbound port for reading and recording per-day fallback usage counts.
 * The manager uses this to enforce {@link FallbackPolicy.perDayLimit}.
 *
 * Contract:
 *
 *   • `getUsageCountToday` MUST return a non-negative integer. The
 *     manager treats negative or non-integer responses as `0` (defence
 *     in depth — a buggy backend MUST NOT open a fallback denial loop).
 *   • `recordUsage` increments today's bucket for the given
 *     `(scope, provider)` pair. Implementations MUST partition by both
 *     so different providers do not share a budget and `local` /
 *     `cloud` scopes remain isolated.
 *   • The "today" boundary is left to the implementation. The in-memory
 *     reference uses UTC midnight; production implementations are free
 *     to use a different boundary as long as it is documented.
 */
export interface FallbackUsageStore {
  /** Returns today's recorded fallback uses for the given scope/provider. */
  getUsageCountToday(input: {
    readonly scope: Scope;
    readonly provider: ProviderId;
  }): Promise<number>;
  /** Records one fallback use for the given scope/provider. */
  recordUsage(input: {
    readonly scope: Scope;
    readonly provider: ProviderId;
  }): Promise<void>;
}

/**
 * Successful `canUseFallback` outcome — the caller may proceed with
 * `model`. The chosen `ModelRef` carries `source: "platform-fallback"`
 * so downstream code (Agent Runtime, billing) can keep distinguishing
 * platform calls from user-key calls without touching the policy code.
 */
export interface FallbackAllowed {
  readonly ok: true;
  readonly model: ModelRef;
}

/**
 * Refusal outcome. The four reasons are intentionally narrow so that
 * UI messaging and tests can switch on a finite set.
 *
 *   • `policy_disabled` — neither tier is enabled in the policy, so no
 *     fallback can ever fire regardless of configuration or usage.
 *   • `rate_limited` — today's usage has reached `perDayLimit`.
 *   • `premium_disabled` — the only configured options for this
 *     provider are premium and `allowPremiumFallback === false`.
 *   • `not_configured` — no fallback models are registered for this
 *     provider at all.
 *
 * The order in which the manager evaluates these reasons is part of
 * the contract; see `FallbackModelManager.canUseFallback`.
 */
export type FallbackDenialReason =
  | "policy_disabled"
  | "rate_limited"
  | "premium_disabled"
  | "not_configured";

export interface FallbackDenied {
  readonly ok: false;
  readonly reason: FallbackDenialReason;
}

export type FallbackDecision = FallbackAllowed | FallbackDenied;

/**
 * Pending fallback proposal returned by
 * `FallbackModelManager.requestFallbackWithNotification` when policy
 * and rate limit allow a switch.
 *
 * The caller MUST surface the proposal to the user (notification step
 * required by Requirement 13.4) and round-trip back through
 * `acknowledgeAndUseFallback` with `ack.acknowledgedByUser === true`
 * before any provider call is made against a platform backup key.
 *
 * `requiresUserAcknowledgement` is a literal `true` so the caller's
 * type system flags any code path that tries to skip the ack step.
 */
export interface FallbackProposal {
  readonly kind: "proposal";
  readonly proposalId: string;
  readonly model: ModelRef;
  readonly requiresUserAcknowledgement: true;
}

/**
 * Outcome of `requestFallbackWithNotification`.
 *
 *   • {@link FallbackProposal} — policy and rate limit agreed; the
 *     caller now needs explicit user acknowledgement.
 *   • {@link FallbackDenied} — same denial shape `canUseFallback`
 *     returned, surfaced unchanged so the UI can keep one switch on
 *     `reason`.
 */
export type RequestFallbackResult = FallbackProposal | FallbackDenied;

/**
 * Outcome of `acknowledgeAndUseFallback`.
 *
 *   • `accepted` — ack was valid, proposal was known and unexpired,
 *     usage has been recorded against today's budget.
 *   • `rejected` with `code: "ack_required"` — ack flag was anything
 *     other than the literal `true`. Usage is NOT recorded; the
 *     proposal remains valid so the caller can retry.
 *   • `rejected` with `code: "unknown_proposal"` — the proposal id was
 *     never issued, was already consumed, or has expired past
 *     `proposalTtlMs`. Usage is NOT recorded.
 */
export type FallbackAcknowledgement =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly code: "ack_required" }
  | { readonly kind: "rejected"; readonly code: "unknown_proposal" };

/**
 * Default policy used by composition when no override is provided.
 * Both opt-ins are `false` so a misconfigured deployment never silently
 * routes to a platform backup key, and the daily limit is `0` so even
 * a future code path that flips a flag without setting a budget cannot
 * burn through credits.
 */
export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = {
  allowFreeTierFallback: false,
  allowPremiumFallback: false,
  perDayLimit: 0,
};

/**
 * Default proposal TTL — 5 minutes. Long enough for a UI to surface a
 * confirmation dialog and survive a brief tab switch, short enough that
 * a forgotten proposal cannot be acknowledged hours later when the
 * underlying provider state may be stale.
 */
export const DEFAULT_PROPOSAL_TTL_MS = 5 * 60 * 1000;
