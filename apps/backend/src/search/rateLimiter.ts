/**
 * Sliding-window rate limiter for the Web Search Tool.
 *
 * Source: design.md → "Web Search Tool" → "Rules" ("Has rate limiting") and
 * requirements.md → Requirement 9.4 (descriptive error on failure without
 * crashing the Task).
 *
 * The limiter is intentionally tiny and dependency-free: it tracks recent
 * call timestamps per bucket key (e.g. `taskId`, `agentId`, or a global
 * key) inside a sliding window. When the count of timestamps within the
 * window reaches `maxCalls`, additional calls are denied until the oldest
 * timestamp ages out.
 *
 * The clock is injectable so unit tests can drive time deterministically
 * without `setTimeout`.
 *
 * Validates: Requirements 9.1, 9.4.
 */

/**
 * Returns the current wall-clock time in milliseconds. Pluggable so tests
 * can advance time deterministically.
 */
export type Clock = () => number;

/** Default real-time clock used when none is injected. */
export const defaultClock: Clock = () => Date.now();

/**
 * Configuration for {@link SlidingWindowRateLimiter}.
 *
 * - `maxCalls`: Max calls allowed within `windowMs` for a single bucket.
 * - `windowMs`: Length of the sliding window in milliseconds.
 * - `clock`: Optional clock override for tests.
 */
export interface RateLimiterOptions {
  readonly maxCalls: number;
  readonly windowMs: number;
  readonly clock?: Clock;
}

/**
 * Outcome of a {@link RateLimiter.tryAcquire} call.
 *
 * - `allowed: true` — caller may proceed; the call has been recorded.
 * - `allowed: false` — caller must back off; `retryAfterMs` is the soonest
 *   time at which a follow-up `tryAcquire` could succeed (≥ 0).
 */
export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

/**
 * Minimal rate-limiter contract used by the Web Search Tool wrapper.
 */
export interface RateLimiter {
  /**
   * Attempt to acquire a slot for `bucketKey`. The decision is atomic:
   * an `allowed: true` response always records the call against the
   * window; an `allowed: false` response never does.
   */
  tryAcquire(bucketKey: string): RateLimitDecision;
}

/**
 * Sliding-window rate limiter with per-bucket history.
 *
 * Defaults (`maxCalls=10`, `windowMs=60_000`) match the task description
 * ("e.g. 10 calls / minute per task or per agent"). Buckets are created
 * on demand and pruned lazily inside `tryAcquire`.
 */
export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly maxCalls: number;
  private readonly windowMs: number;
  private readonly clock: Clock;
  private readonly buckets = new Map<string, number[]>();

  public constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.maxCalls) || options.maxCalls < 1) {
      throw new RangeError(
        `SlidingWindowRateLimiter: maxCalls must be a positive integer, got ${String(options.maxCalls)}`,
      );
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError(
        `SlidingWindowRateLimiter: windowMs must be > 0, got ${String(options.windowMs)}`,
      );
    }
    this.maxCalls = Math.floor(options.maxCalls);
    this.windowMs = options.windowMs;
    this.clock = options.clock ?? defaultClock;
  }

  public tryAcquire(bucketKey: string): RateLimitDecision {
    const now = this.clock();
    const windowStart = now - this.windowMs;

    const history = this.buckets.get(bucketKey);
    const pruned = pruneOlderThan(history, windowStart);

    if (pruned.length >= this.maxCalls) {
      // Oldest still-in-window timestamp determines when the next slot frees.
      const oldest = pruned[0] ?? now;
      const retryAfterMs = Math.max(0, oldest + this.windowMs - now);
      // Persist pruned history so the next `tryAcquire` doesn't re-walk
      // already-expired entries.
      this.buckets.set(bucketKey, pruned);
      return { allowed: false, retryAfterMs };
    }

    pruned.push(now);
    this.buckets.set(bucketKey, pruned);
    return { allowed: true };
  }
}

/**
 * Always-allow limiter. Useful as a default when callers don't want to
 * enforce rate limiting (e.g. low-volume integration tests) and as a
 * type-stable null object.
 */
export class NoopRateLimiter implements RateLimiter {
  public tryAcquire(_bucketKey: string): RateLimitDecision {
    return { allowed: true };
  }
}

/**
 * Returns a fresh, ascending-order array containing only timestamps that
 * are strictly greater than `cutoff`. Existing bucket arrays are kept in
 * insertion order (which is also chronological because `tryAcquire`
 * appends `now`), so a single linear scan is enough.
 */
function pruneOlderThan(
  history: ReadonlyArray<number> | undefined,
  cutoff: number,
): number[] {
  if (!history || history.length === 0) {
    return [];
  }
  // Find the first index whose timestamp is still in window.
  let firstFresh = 0;
  while (firstFresh < history.length) {
    const value = history[firstFresh];
    if (value !== undefined && value > cutoff) {
      break;
    }
    firstFresh += 1;
  }
  if (firstFresh === 0) {
    return history.slice();
  }
  return history.slice(firstFresh);
}
