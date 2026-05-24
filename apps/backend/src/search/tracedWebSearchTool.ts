/**
 * `TracedWebSearchTool` — wires {@link WebSearchTool} invocations into the
 * Trace Event Bus (task 13.2).
 *
 * Source:
 * - design.md → "Web Search Tool" → "Rules" ("Every call is recorded in
 *   Agent_Trace").
 * - design.md → "Data Models" → "Agent_Trace" (`tool_call` TraceRecord
 *   shape).
 * - requirements.md → 9.5 ("THE Orchestrator SHALL фиксировать каждый
 *   вызов Web_Search_Tool в Agent_Trace соответствующего Agent с
 *   указанием запроса и краткого результата").
 *
 * Design notes:
 *
 * - The wrapper does not change the `WebSearchTool` interface: callers
 *   that don't need tracing keep depending on `WebSearchTool.search`.
 * - The calling Task's `taskId` and the calling Agent's `agentId` are
 *   passed through a per-invocation context object. The agent runtime
 *   obtains a context-bound `WebSearchTool` via
 *   {@link TracedWebSearchTool.forContext} and invokes it like any other
 *   `WebSearchTool`. **No global state**.
 * - Every call emits exactly one `tool_call` trace record. Both the
 *   success path (`{ kind: "ok" }`) and the error path
 *   (`{ kind: "error" }`) are observable; callers see the original
 *   {@link SearchResult} unchanged (the adapter's user-facing error
 *   semantics are preserved per Requirement 9.4).
 * - The trace `output` carries a short summary — result count plus the
 *   top three `{ title, url }` pairs — never the full payload. This keeps
 *   trace storage bounded (Requirement 11.7) and the UI panel readable
 *   (Requirement 11.2).
 * - If the trace bus itself rejects (storage outage, validation error),
 *   the search call MUST still return the original result. We forward
 *   such failures to an optional `onTraceError` hook so callers can log
 *   them; we never let trace publishing crash the agent runtime.
 *
 * Validates: Requirement 9.5.
 */

import type {
  TraceEventBusInterface,
  ToolCallTraceRecord,
} from "../trace/index.js";

import type {
  SearchOptions,
  SearchResult,
  WebSearchTool,
} from "./types.js";

/**
 * Per-invocation trace context. Supplied by the Agent Runtime when it
 * binds a context-specific {@link WebSearchTool} via
 * {@link TracedWebSearchTool.forContext}.
 */
export interface TraceContext {
  /** Calling Task's id. */
  readonly taskId: string;
  /** Calling Agent's id. */
  readonly agentId: string;
}

/**
 * Configuration for {@link TracedWebSearchTool}.
 *
 * - `inner`: The underlying tool (typically a {@link WebSearchToolImpl}
 *   that already composes a backend adapter and a rate limiter).
 * - `traceBus`: Bus to publish `tool_call` records on.
 * - `now`: Optional clock injection for deterministic tests. Defaults to
 *   `() => new Date().toISOString()`.
 * - `onTraceError`: Optional sink for trace-bus errors. Defaults to a
 *   noop. The original search result is always returned regardless.
 * - `topResults`: Cap on the number of top hits embedded in the trace
 *   summary. Defaults to 3 per the task's "cap to ~3 entries" hint.
 */
export interface TracedWebSearchToolOptions {
  readonly inner: WebSearchTool;
  readonly traceBus: TraceEventBusInterface;
  readonly now?: () => string;
  readonly onTraceError?: (err: unknown) => void;
  readonly topResults?: number;
}

const DEFAULT_TOP_RESULTS = 3;

/** Canonical tool id for the Web Search Tool. Matches `ToolId` enum. */
const WEB_SEARCH_TOOL_ID = "web_search" as const;

/**
 * Decorator that publishes one `tool_call` trace record per `search`
 * invocation made through a context-bound view.
 *
 * Usage from the Agent Runtime:
 *
 * ```ts
 * const traced = new TracedWebSearchTool({ inner: webSearch, traceBus });
 * const tool = traced.forContext({ taskId, agentId });
 * await tool.search("query"); // → emits one tool_call trace
 * ```
 */
export class TracedWebSearchTool {
  private readonly inner: WebSearchTool;
  private readonly traceBus: TraceEventBusInterface;
  private readonly now: () => string;
  private readonly onTraceError: (err: unknown) => void;
  private readonly topResults: number;

  public constructor(options: TracedWebSearchToolOptions) {
    this.inner = options.inner;
    this.traceBus = options.traceBus;
    this.now = options.now ?? defaultNow;
    this.onTraceError = options.onTraceError ?? noopTraceError;
    const requestedTop = options.topResults ?? DEFAULT_TOP_RESULTS;
    this.topResults = clampTopResults(requestedTop);
  }

  /**
   * Bind the tool to a particular `(taskId, agentId)` context. The
   * returned object is a plain {@link WebSearchTool}: every `search`
   * call is forwarded to the underlying tool and produces one trace
   * event addressed to `ctx.taskId` / `ctx.agentId`.
   */
  public forContext(ctx: TraceContext): WebSearchTool {
    assertNonEmptyString(ctx.taskId, "taskId");
    assertNonEmptyString(ctx.agentId, "agentId");

    const search = (
      query: string,
      options?: SearchOptions,
    ): Promise<SearchResult> => this.searchWithContext(ctx, query, options);

    return { search };
  }

  /**
   * Internal helper used by the bound view. Captures the timestamp,
   * delegates to the inner tool, then publishes a single `tool_call`
   * trace event covering both success and failure outcomes.
   */
  private async searchWithContext(
    ctx: TraceContext,
    query: string,
    options: SearchOptions | undefined,
  ): Promise<SearchResult> {
    const at = this.now();
    const input = buildTraceInput(query, options);

    let result: SearchResult;
    let thrownError: unknown = null;
    try {
      result = await this.inner.search(query, options);
    } catch (err: unknown) {
      thrownError = err;
      result = {
        kind: "error",
        reason: `Web search threw: ${describeError(err)}`,
      };
    }

    const output =
      thrownError !== null
        ? buildErrorOutputFromThrow(thrownError)
        : buildOutputSummary(result, this.topResults);

    const record: ToolCallTraceRecord = {
      kind: "tool_call",
      tool: WEB_SEARCH_TOOL_ID,
      input,
      output,
      at,
    };

    try {
      await this.traceBus.publish({
        taskId: ctx.taskId,
        agentId: ctx.agentId,
        record,
      });
    } catch (err: unknown) {
      // Tracing must never alter the agent's user-facing error semantics
      // (Requirement 9.4). Forward the failure to the configured sink and
      // continue.
      this.onTraceError(err);
    }

    if (thrownError !== null) {
      // Preserve the inner tool's user-facing throw semantics. In practice
      // `WebSearchToolImpl` never throws, but defensive code paths in tests
      // and future adapters might.
      throw thrownError as Error;
    }
    return result;
  }
}

/**
 * Normalised input shape for the `tool_call` trace record. We pass the
 * query verbatim and surface `limit` only when the caller specified one
 * — empty options become a tidy `{ query }`.
 */
interface TraceCallInput {
  readonly query: string;
  readonly limit?: number;
}

function buildTraceInput(
  query: string,
  options: SearchOptions | undefined,
): TraceCallInput {
  const out: { query: string; limit?: number } = { query };
  if (options?.limit !== undefined) {
    out.limit = options.limit;
  }
  return out;
}

/**
 * Output summary embedded in the `tool_call` trace record.
 *
 * For a successful search we record the result count and up to
 * `topResults` `{ title, url }` pairs — _never_ the full result payload
 * (which can run to tens of KB). For an error result we record the
 * structured failure shape unchanged so observers can see exactly what
 * the agent received.
 */
type TraceCallOutput =
  | {
      readonly kind: "ok";
      readonly resultCount: number;
      readonly results: ReadonlyArray<{ readonly title: string; readonly url: string }>;
    }
  | {
      readonly kind: "error";
      readonly reason: string;
    };

function buildOutputSummary(
  result: SearchResult,
  topResults: number,
): TraceCallOutput {
  if (result.kind === "error") {
    return { kind: "error", reason: result.reason };
  }
  const top = result.results
    .slice(0, topResults)
    .map((hit) => ({ title: hit.title, url: hit.url }));
  return {
    kind: "ok",
    resultCount: result.results.length,
    results: top,
  };
}

function buildErrorOutputFromThrow(err: unknown): TraceCallOutput {
  return {
    kind: "error",
    reason: `Web search threw: ${describeError(err)}`,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message =
      err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return `${err.name}: ${message}`;
  }
  return "unknown error";
}

function clampTopResults(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_TOP_RESULTS;
  }
  return Math.floor(value);
}

function defaultNow(): string {
  return new Date().toISOString();
}

function noopTraceError(_err: unknown): void {
  // Intentionally empty; callers can opt in via `onTraceError`.
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `TracedWebSearchTool: ${field} must be a non-empty string`,
    );
  }
}
