/**
 * Public surface of the Platform Fallback Model Manager backend module.
 *
 * Source: `design.md` → "Platform Fallback Model Manager".
 *
 * Validates: Requirements 5.5, 13.3, 13.4, 13.5, 13.6, 13.7.
 */

export type {
  ConfiguredFallbackModel,
  FallbackAcknowledgement,
  FallbackAllowed,
  FallbackDecision,
  FallbackDenialReason,
  FallbackDenied,
  FallbackPolicy,
  FallbackProposal,
  FallbackUsageStore,
  RequestFallbackResult,
} from "./types.js";
export { DEFAULT_FALLBACK_POLICY, DEFAULT_PROPOSAL_TTL_MS } from "./types.js";

export type { FallbackModelManagerOptions } from "./fallbackModelManager.js";
export { FallbackModelManager } from "./fallbackModelManager.js";

export type { InMemoryFallbackUsageStoreOptions } from "./inMemoryUsageStore.js";
export { InMemoryFallbackUsageStore } from "./inMemoryUsageStore.js";

export type {
  FallbackProposalRecord,
  FallbackProposalStore,
  InMemoryFallbackProposalStoreOptions,
} from "./fallbackProposalStore.js";
export { InMemoryFallbackProposalStore } from "./fallbackProposalStore.js";
