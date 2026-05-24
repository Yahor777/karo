/**
 * Public surface of the backend Web Search module.
 *
 * Source: design.md → "Web Search Tool" and tasks.md → 13.1.
 *
 * Consumers (Agent Runtime, orchestrator wiring in 13.2) import
 * exclusively through this barrel:
 *
 * ```ts
 * import {
 *   WebSearchToolImpl,
 *   DuckDuckGoSearch,
 *   SlidingWindowRateLimiter,
 * } from "../search/index.js";
 * ```
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4.
 */

export type {
  SearchHit,
  SearchOptions,
  SearchResult,
  WebSearchTool,
} from "./types.js";

export {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_LIMIT,
} from "./types.js";

export type { HttpClient, HttpRequest, HttpResponse } from "./httpClient.js";
export { fetchHttpClient } from "./httpClient.js";

export type {
  Clock,
  RateLimiter,
  RateLimiterOptions,
  RateLimitDecision,
} from "./rateLimiter.js";
export {
  NoopRateLimiter,
  SlidingWindowRateLimiter,
  defaultClock,
} from "./rateLimiter.js";

export type { DuckDuckGoSearchOptions } from "./duckduckgoAdapter.js";
export { DuckDuckGoSearch } from "./duckduckgoAdapter.js";

export type {
  BucketKeyStrategy,
  WebSearchToolImplOptions,
} from "./webSearchTool.js";
export { WebSearchToolImpl } from "./webSearchTool.js";

export type {
  TraceContext,
  TracedWebSearchToolOptions,
} from "./tracedWebSearchTool.js";
export { TracedWebSearchTool } from "./tracedWebSearchTool.js";
