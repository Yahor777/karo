/**
 * Pending fallback proposal store.
 *
 * Source: `design.md` → "Platform Fallback Model Manager" Rules
 * ("Fallback requires user notification") and Requirement 13.4.
 *
 * Validates: Requirements 13.3, 13.4.
 *
 * The proposal store is the small piece of bookkeeping the
 * notification gate needs: the manager issues a `proposalId` when
 * `requestFallbackWithNotification` decides a switch is allowed, and
 * later confirms — when the caller comes back with an
 * acknowledgement — that the proposal really was issued, hasn't been
 * consumed, and hasn't expired.
 *
 * Why a separate module:
 *
 *   • Keeps the manager focused on policy. The TTL/race semantics live
 *     in one tiny class with its own tests.
 *   • Lets task 19.2 ship an in-memory reference and lets later tasks
 *     swap in a persistent backend (Postgres/Redis) without changing
 *     the manager.
 *
 * TTL semantics:
 *
 *   • A proposal is valid for `ttlMs` milliseconds counted from
 *     `issuedAt`. After the TTL the proposal is treated as if it had
 *     never existed (`get` returns `null`); the late acknowledger gets
 *     `unknown_proposal` so the UI can surface a fresh notification.
 *   • `consume` is one-shot: a successful consume removes the entry.
 *     Replay attempts return `null` and are surfaced as
 *     `unknown_proposal` exactly like an unknown id.
 *   • Expired entries are pruned lazily on read and on insert. The
 *     store does not run a background timer because the manager
 *     instances are short-lived in production composition.
 */

import type {
  ModelRef,
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";

/**
 * Snapshot of an issued proposal returned by
 * {@link FallbackProposalStore.consume}. It carries enough context for
 * the manager to record usage against the right `(scope, provider)`
 * bucket and to verify the model the caller is acknowledging is the
 * one originally proposed.
 */
export interface FallbackProposalRecord {
  readonly proposalId: string;
  readonly scope: Scope;
  readonly provider: ProviderId;
  readonly model: ModelRef;
  readonly issuedAtMs: number;
}

/**
 * Inbound port for storing pending fallback proposals.
 *
 * Methods are all synchronous in the in-memory reference because the
 * store is hit twice per fallback round-trip and the latency budget is
 * tight, but the interface is intentionally small enough that a
 * persistent adapter can implement it as well.
 */
export interface FallbackProposalStore {
  /**
   * Persists `record` so it can be retrieved by `proposalId` until the
   * configured TTL elapses.
   */
  put(record: FallbackProposalRecord): void;
  /**
   * Atomically removes and returns the proposal identified by
   * `proposalId`. Returns `null` if the id is unknown, has already
   * been consumed, or has expired.
   */
  consume(proposalId: string, nowMs: number): FallbackProposalRecord | null;
  /** Test-only diagnostic — number of currently tracked proposals. */
  size(): number;
}

/** Options for {@link InMemoryFallbackProposalStore}. */
export interface InMemoryFallbackProposalStoreOptions {
  /**
   * Time-to-live in milliseconds. Proposals older than `ttlMs` since
   * `issuedAtMs` are treated as expired by `consume`.
   */
  readonly ttlMs: number;
}

/**
 * Minimal in-memory implementation of {@link FallbackProposalStore}.
 *
 * Suitable for single-process backends and tests; for multi-process
 * deployments swap in a shared-storage backed implementation that
 * preserves the same TTL/one-shot semantics.
 */
export class InMemoryFallbackProposalStore implements FallbackProposalStore {
  private readonly proposals = new Map<string, FallbackProposalRecord>();
  private readonly ttlMs: number;

  public constructor(options: InMemoryFallbackProposalStoreOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error(
        "InMemoryFallbackProposalStore.ttlMs must be a positive finite number",
      );
    }
    this.ttlMs = options.ttlMs;
  }

  public put(record: FallbackProposalRecord): void {
    // Lazy prune on insert to keep the map from growing unbounded if
    // proposals are issued but never acknowledged.
    this.pruneExpired(record.issuedAtMs);
    this.proposals.set(record.proposalId, record);
  }

  public consume(
    proposalId: string,
    nowMs: number,
  ): FallbackProposalRecord | null {
    const found = this.proposals.get(proposalId);
    if (found === undefined) {
      return null;
    }
    if (this.isExpired(found, nowMs)) {
      this.proposals.delete(proposalId);
      return null;
    }
    this.proposals.delete(proposalId);
    return found;
  }

  public size(): number {
    return this.proposals.size;
  }

  private isExpired(record: FallbackProposalRecord, nowMs: number): boolean {
    return nowMs - record.issuedAtMs >= this.ttlMs;
  }

  private pruneExpired(nowMs: number): void {
    for (const [id, record] of this.proposals) {
      if (this.isExpired(record, nowMs)) {
        this.proposals.delete(id);
      }
    }
  }
}
