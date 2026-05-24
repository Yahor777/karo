/**
 * Web Search Tool contracts.
 *
 * Source: design.md → "Web Search Tool" → "Interface", and
 * requirements.md → Requirement 9 ("Веб-поиск как бесплатный инструмент агентов").
 *
 * The tool exposes a single `search(query, options?)` operation returning a
 * structured `SearchResult` discriminated union. Per Requirement 9.4, an error
 * from the underlying backend (DuckDuckGo) is surfaced as
 * `{ kind: "error", reason }` rather than thrown — agents must never crash on
 * a search failure.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4.
 */

/**
 * A single search hit. Field set is fixed by Requirement 9.3 (title, URL,
 * snippet) so agents have a stable shape to work against.
 */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * Discriminated union returned by `WebSearchTool.search`.
 *
 * - `ok`: The search completed and produced zero or more hits. An empty
 *   `results` array is a valid success — the underlying backend simply
 *   returned no matches.
 * - `error`: The search failed. `reason` is a short, human-readable
 *   description suitable for inclusion in `Agent_Trace` and downstream
 *   prompts. It MUST NOT include secrets or stack traces.
 */
export type SearchResult =
  | { readonly kind: "ok"; readonly results: ReadonlyArray<SearchHit> }
  | { readonly kind: "error"; readonly reason: string };

/**
 * Options accepted by `WebSearchTool.search`. Mirrors the design.md
 * interface; only `limit` is defined today, additional knobs (e.g. region,
 * safe-search) can be added without breaking callers.
 */
export interface SearchOptions {
  /** Maximum number of hits to return. Implementations clamp to a sane upper bound. */
  readonly limit?: number;
}

/**
 * The contract every web-search backend (DuckDuckGo today, others later)
 * must satisfy. The orchestrator and Agent Runtime depend on this interface,
 * not on a concrete adapter.
 */
export interface WebSearchTool {
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
}

/**
 * Default upper bound on hits returned by an adapter when the caller does
 * not specify `limit`. Kept conservative so trace records stay readable.
 */
export const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Hard cap to protect against pathological `limit` values from agents.
 */
export const MAX_SEARCH_LIMIT = 25;

/**
 * Default per-call timeout in milliseconds. Matches design.md ("for example
 * 5 seconds") and Requirement 9.4 (descriptive error on backend failure).
 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 5_000;
