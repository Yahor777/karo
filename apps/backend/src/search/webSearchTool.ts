/**
 * Web Search Tool wrapper.
 *
 * Composes a backend adapter (e.g. {@link DuckDuckGoSearch}) with a
 * {@link RateLimiter} so the orchestrator and Agent Runtime can depend
 * on a single `WebSearchTool` instance regardless of which backend is
 * active.
 *
 * The wrapper is responsible for:
 *
 * - Enforcing the configured rate limit per bucket key (defaults to a
 *   shared `"global"` bucket; callers can override via the
 *   `bucketKeyFor` strategy to scope per-task or per-agent).
 * - Translating limiter denials and unexpected adapter exceptions into
 *   `{ kind: "error" }` results, never throwing into the agent runtime
 *   (Requirement 9.4).
 * - Leaving the backend adapter responsible for timeouts and structured
 *   errors so this layer stays thin.
 *
 * Validates: Requirements 9.1, 9.4.
 */

import { NoopRateLimiter, type RateLimiter } from "./rateLimiter.js";
import type {
  SearchOptions,
  SearchResult,
  WebSearchTool,
} from "./types.js";

/**
 * Strategy for deriving a rate-limit bucket key from a search call.
 *
 * The wrapper passes the query and options through so callers can scope
 * the bucket per task/agent (see backend gateway in task 13.2 wiring).
 * When omitted, all calls share the `"global"` bucket — a safe default
 * for early development and tests.
 */
export type BucketKeyStrategy = (
  query: string,
  options: SearchOptions | undefined,
) => string;

/**
 * Configuration for {@link WebSearchToolImpl}.
 *
 * - `adapter`: Concrete backend (DuckDuckGo today).
 * - `rateLimiter`: Limiter to consult before each call. When omitted,
 *   a {@link NoopRateLimiter} is used so existing call sites are not
 *   forced to opt into limiting.
 * - `bucketKeyFor`: Optional strategy (defaults to `"global"`).
 */
export interface WebSearchToolImplOptions {
  readonly adapter: WebSearchTool;
  readonly rateLimiter?: RateLimiter;
  readonly bucketKeyFor?: BucketKeyStrategy;
}

const DEFAULT_BUCKET_KEY = "global";

const defaultBucketKeyStrategy: BucketKeyStrategy = () => DEFAULT_BUCKET_KEY;

/**
 * The default {@link WebSearchTool} composition used by the orchestrator.
 *
 * Note that this class never throws from `search`: every failure mode
 * (rate-limit denial, adapter exception, malformed adapter result) is
 * surfaced as `{ kind: "error", reason }`.
 */
export class WebSearchToolImpl implements WebSearchTool {
  private readonly adapter: WebSearchTool;
  private readonly rateLimiter: RateLimiter;
  private readonly bucketKeyFor: BucketKeyStrategy;

  public constructor(options: WebSearchToolImplOptions) {
    this.adapter = options.adapter;
    this.rateLimiter = options.rateLimiter ?? new NoopRateLimiter();
    this.bucketKeyFor = options.bucketKeyFor ?? defaultBucketKeyStrategy;
  }

  public async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    const bucketKey = this.bucketKeyFor(query, options);
    const decision = this.rateLimiter.tryAcquire(bucketKey);
    if (!decision.allowed) {
      return {
        kind: "error",
        reason: `Web search rate limit exceeded (retry in ${String(decision.retryAfterMs)}ms)`,
      };
    }

    try {
      return await this.adapter.search(query, options);
    } catch (err: unknown) {
      // Defensive: a well-behaved adapter never throws, but we honor the
      // "no throws into agent runtime" contract regardless.
      return {
        kind: "error",
        reason: `Web search backend threw: ${describeError(err)}`,
      };
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message =
      err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return `${err.name}: ${message}`;
  }
  return "unknown error";
}
