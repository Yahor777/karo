/**
 * In-memory implementation of {@link FallbackUsageStore}.
 *
 * Source: `design.md` → "Platform Fallback Model Manager" → Rules
 * (rate-limited usage). Task 19.2 wires `recordUsage` through the
 * manager's public `recordFallbackUsage` and the
 * `acknowledgeAndUseFallback` flow.
 *
 * Validates: Requirements 13.6.
 *
 * Boundary semantics:
 *
 *   • "Today" is a UTC calendar day. The decision to use UTC (rather
 *     than the user's local timezone) keeps the boundary deterministic
 *     across distributed backends and matches the rest of the project's
 *     ISO-8601-UTC-millisecond timestamp convention (Requirement 10.5).
 *   • Counts are bucketed by `(scopeKey, provider, dateKey)` so:
 *       — different providers never share a daily budget;
 *       — local and cloud scopes are isolated, even if they happen to
 *         share an identifier;
 *       — old buckets do not influence today's decisions.
 *
 * The store is intentionally tiny — production deployments can replace
 * it with a Postgres- or Redis-backed implementation without touching
 * the policy code.
 */

import type {
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";

import type { FallbackUsageStore } from "./types.js";

/**
 * Options for {@link InMemoryFallbackUsageStore}. The clock is exposed
 * solely so tests can pin "today" to a known date without sleeping.
 */
export interface InMemoryFallbackUsageStoreOptions {
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class InMemoryFallbackUsageStore implements FallbackUsageStore {
  private readonly counters = new Map<string, number>();
  private readonly now: () => number;

  public constructor(options: InMemoryFallbackUsageStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  public getUsageCountToday(input: {
    readonly scope: Scope;
    readonly provider: ProviderId;
  }): Promise<number> {
    return Promise.resolve(
      this.counters.get(this.bucketKey(input.scope, input.provider)) ?? 0,
    );
  }

  /**
   * Records one fallback use against today's bucket for the given
   * `(scope, provider)` pair.
   */
  public recordUsage(input: {
    readonly scope: Scope;
    readonly provider: ProviderId;
  }): Promise<void> {
    const key = this.bucketKey(input.scope, input.provider);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    return Promise.resolve();
  }

  /** Test-only diagnostic: number of distinct (scope, provider, day) buckets. */
  public bucketCount(): number {
    return this.counters.size;
  }

  /**
   * Bucket key shape: `<scope-kind>:<scope-id>::<provider>::<utc-yyyy-mm-dd>`.
   *
   * The double colon separates scope from provider so a provider id
   * containing `:` cannot collide with a different `(scope, provider)`
   * pair. The trailing date segment guarantees yesterday's count never
   * leaks into today's policy decision.
   */
  private bucketKey(scope: Scope, provider: ProviderId): string {
    const dateKey = utcDateKey(new Date(this.now()));
    const scopePart =
      scope.kind === "local"
        ? `local:${scope.deviceId}`
        : `cloud:${scope.userId}`;
    return `${scopePart}::${provider}::${dateKey}`;
  }
}

/** YYYY-MM-DD in UTC, padded. Avoids `toISOString().slice(0,10)` so a future
 * non-Gregorian Date polyfill cannot silently change the format. */
function utcDateKey(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}
