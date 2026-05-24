/**
 * Researcher builtin agent (task 14.2).
 *
 * Sources:
 * - design.md → "Agent Runtime" → "Builtin agent permissions" — Researcher
 *   has access to `web_search` only.
 * - design.md → "Pipeline State Machine" / "Task Execution Flow" — the
 *   Researcher receives the user's prompt, optionally queries the web,
 *   and hands an enriched prompt to the Coder.
 * - requirements.md →
 *     7.1 (the five Builtin_Agent roles),
 *     7.2 (Researcher enriches the prompt within 60 seconds using the
 *          model and Web_Search_Tool, then hands the enriched prompt to
 *          the next agent),
 *     7.3 (when Web_Search_Tool is unavailable or returns an error, the
 *          Researcher builds the enriched prompt from the model alone
 *          and includes a marker indicating the missing search results,
 *          without aborting the pipeline),
 *     9.5 (every Web_Search_Tool call is recorded in Agent_Trace).
 *
 * Behaviour summary:
 *
 *   1. Emit a `status: "started"` trace event.
 *   2. Extract the original prompt from the incoming message (text
 *      payload, or a `{ prompt | text }` JSON payload). Empty prompts
 *      flow through as-is — the orchestrator's input validation already
 *      rejected truly empty prompts (Requirement 6.4).
 *   3. Call the Web_Search_Tool once, tolerating errors and exceptions.
 *      The tool is itself traced — `TracedWebSearchTool.forContext`
 *      publishes the `tool_call` record so the Researcher does not
 *      double-emit one. Requirement 9.5 + 7.3.
 *   4. Build the synthetic in-memory message that hands the model the
 *      original prompt plus the search summary, load the bounded
 *      conversation history (Requirement 10.7), and invoke the model
 *      adapter.
 *   5. Treat the model output as the enriched prompt body. Adapter
 *      exceptions or unparseable output fall back to a safe
 *      "search-summary-only" enrichment so the pipeline can keep
 *      flowing — Requirement 7.3 forbids aborting the pipeline on
 *      Researcher failure.
 *   6. Build the structured outgoing Agent_Message with payload
 *      `{ kind: "json", value: <EnrichedPromptPayload> }` and
 *      `type: "handoff"` addressed to the Coder.
 *   7. Persist the outgoing Agent_Message before handoff (Requirement
 *      10.6) and emit a `status: "finished"` trace event.
 *
 * 60-second budget (Requirement 7.2):
 *   The agent measures elapsed wall-clock time from the start of `run`
 *   to the moment it persists the outgoing message. The elapsed reading
 *   is exposed on both the result (`elapsedMs`) and the payload
 *   (`elapsedMs`) so the orchestrator and tests can verify the soft
 *   60-second cap. The budget is *soft* — we do not abort late
 *   responses, since killing the agent mid-call would either leave the
 *   pipeline without an enriched prompt or risk losing trace events.
 *   The orchestrator owns the hard cap by inspecting the elapsed value
 *   on result and surfacing a "delayed" indicator (Requirement 11.6).
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4 (the Coder's atomic write
 * is in `coder.ts`; the Researcher hands off to it through the
 * persisted Agent_Message).
 */

import {
  AGENT_PERSISTENCE_BUDGET_MS,
  boundAgentHistory,
  type AgentDefinition,
  type MessageHistoryStore,
  type ModelAdapter,
  type ModelInvokeOptions,
  type SecretRef,
  type TaskContext,
} from "../agentRuntime/index.js";
import type { TraceEventBusInterface } from "../trace/index.js";
import type {
  SearchResult,
  WebSearchTool,
} from "../search/index.js";
import type { AgentMessage } from "@ai-agent-orchestrator/validation";
import type { AgentId } from "@ai-agent-orchestrator/shared-core";

import type { EnrichedPromptPayload } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Soft cap on the Researcher's wall-clock budget per Requirement 7.2.
 *
 * Exposed so the orchestrator and tests can compare against the
 * `elapsedMs` reading reported by `run`. The value is enforced by
 * observation rather than by abortion — see the file-level comment.
 */
export const RESEARCHER_BUDGET_MS = 60_000;

/** Maximum number of search hits requested from the Web_Search_Tool. */
const RESEARCHER_SEARCH_LIMIT = 5;

// ---------------------------------------------------------------------------
// Clock injection (for deterministic tests)
// ---------------------------------------------------------------------------

export interface Clock {
  /** ISO 8601 UTC ms timestamp for the current moment. */
  nowIso(): string;
  /** Wall-clock milliseconds since the epoch. */
  nowMs(): number;
}

const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Constructor and run-time inputs
// ---------------------------------------------------------------------------

/**
 * Dependencies for {@link ResearcherAgent}.
 *
 * The Researcher composes the same primitives the {@link AgentRunner}
 * from task 14.1 uses (`ModelAdapter`, `MessageHistoryStore`) plus the
 * Trace Event Bus and a `WebSearchTool`. The shared {@link Clock} hook
 * lets unit tests freeze timestamps and exercise the 60-second budget
 * deterministically.
 *
 * `webSearch` is OPTIONAL: production wiring always passes a
 * `TracedWebSearchTool`-bound view, but tests that exercise the
 * unavailable / skipped path can omit it. When `webSearch` is undefined
 * the agent records `webSearchOutcome: "skipped"` and proceeds with
 * model-only enrichment (Requirement 7.3).
 */
export interface ResearcherAgentOptions {
  readonly modelAdapter: ModelAdapter;
  readonly messageHistoryStore: MessageHistoryStore;
  readonly traceBus: TraceEventBusInterface;
  readonly webSearch?: WebSearchTool;
  readonly clock?: Clock;
}

/**
 * Input for {@link ResearcherAgent.run}.
 *
 * `incoming` is the handoff message that triggered the research. The
 * orchestrator is responsible for having persisted it before calling
 * `run` — the Researcher's contract is to persist the *outgoing*
 * enriched prompt.
 *
 * `coderAgentId` is the routing target for the resulting handoff
 * (design.md → "Pipeline State Machine": Researching → Coding).
 */
export interface ResearcherRunInput {
  readonly task: TaskContext;
  readonly agent: AgentDefinition;
  readonly apiKey: SecretRef;
  readonly incoming: AgentMessage;
  readonly coderAgentId: AgentId;
  /** Optional per-call timeout forwarded to the model adapter. */
  readonly timeoutMs?: number;
}

/**
 * Result of {@link ResearcherAgent.run}.
 *
 * `outgoing` is the persisted Agent_Message routed to the Coder;
 * `enriched` is the structured payload extracted from it for
 * convenience. `elapsedMs` is the total wall-clock time the agent
 * spent on the run, exposed so the orchestrator can compare against
 * {@link RESEARCHER_BUDGET_MS} (Requirement 7.2).
 *
 * `persistenceLatencyMs` mirrors the field {@link AgentRunner} exposes
 * so callers can verify the 500 ms persistence budget from
 * Requirement 10.6.
 */
export interface ResearcherRunResult {
  readonly outgoing: AgentMessage;
  readonly enriched: EnrichedPromptPayload;
  readonly recipient: AgentId;
  readonly elapsedMs: number;
  readonly persistenceLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Researcher Builtin_Agent.
 *
 * Stateless beyond its dependencies — safe to share across concurrent
 * task pipelines. The class deliberately keeps the search-tolerance and
 * prompt-shaping logic local: the orchestrator does not need to know
 * how the model's raw output gets coerced into an
 * {@link EnrichedPromptPayload}.
 */
export class ResearcherAgent {
  private readonly modelAdapter: ModelAdapter;
  private readonly messageHistoryStore: MessageHistoryStore;
  private readonly traceBus: TraceEventBusInterface;
  private readonly webSearch: WebSearchTool | undefined;
  private readonly clock: Clock;

  public constructor(options: ResearcherAgentOptions) {
    this.modelAdapter = options.modelAdapter;
    this.messageHistoryStore = options.messageHistoryStore;
    this.traceBus = options.traceBus;
    this.webSearch = options.webSearch;
    this.clock = options.clock ?? systemClock;
  }

  public async run(input: ResearcherRunInput): Promise<ResearcherRunResult> {
    validateInput(input);

    const taskId = input.task.id;
    const agentId = input.agent.id;
    const startMs = this.clock.nowMs();

    await this.publishTrace(taskId, agentId, {
      kind: "status",
      status: "started",
      at: this.clock.nowIso(),
    });

    // Step 2: extract the original prompt.
    const originalPrompt = extractOriginalPrompt(input.incoming);

    // Step 3: tolerate web-search failure (Requirement 7.3).
    const search = await this.runWebSearch(originalPrompt);

    // Step 4: invoke the model with the prompt + search context.
    const history = await this.messageHistoryStore.list(taskId);
    const bounded = boundAgentHistory(history);
    const augmentedHistory: readonly AgentMessage[] = [
      ...bounded,
      this.buildResearcherContextMessage(input, originalPrompt, search),
    ];

    const adapterOptions: ModelInvokeOptions = {
      systemPrompt: input.agent.systemPrompt,
      apiKey: input.apiKey,
      allowedTools: input.agent.allowedTools,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };

    const effectiveModel = input.agent.model ?? input.task.defaultModel;

    let modelEnrichment: string | null = null;
    try {
      const result = await this.modelAdapter.invoke(
        effectiveModel,
        augmentedHistory,
        adapterOptions,
      );
      modelEnrichment = extractModelText(result?.raw);
    } catch (err) {
      // Per Requirement 7.3 the Researcher MUST NOT abort the pipeline
      // on enrichment failure. Fall through with `modelEnrichment ===
      // null`; the assembled prompt below uses the search summary or
      // the original prompt verbatim.
      modelEnrichment = null;
      void err;
    }

    // Step 5: assemble the enriched prompt body.
    const enrichedPrompt = assembleEnrichedPrompt({
      originalPrompt,
      modelEnrichment,
      search,
    });

    // Persistence happens AFTER the model call so `elapsedMs` reflects
    // the total time the user observes between handoff arrival and
    // handoff departure.
    const persistStart = this.clock.nowMs();

    const enriched: EnrichedPromptPayload = {
      kind: "enrichedPrompt",
      originalPrompt,
      enrichedPrompt,
      webSearchOutcome: search.outcome,
      ...(search.summary !== undefined ? { searchSummary: search.summary } : {}),
      // We patch elapsedMs into the payload after the persist call so
      // the value reflects the full run; placeholder zero here.
      elapsedMs: 0,
    };

    // Compute the eventual elapsed time so the persisted payload
    // carries the exact value reported on the result. The persistence
    // call itself is short relative to the 60-second budget, so we can
    // estimate elapsed-at-persist by reading the clock once more.
    const elapsedAtPersistMs = this.clock.nowMs() - startMs;
    const enrichedWithElapsed: EnrichedPromptPayload = {
      ...enriched,
      elapsedMs: elapsedAtPersistMs,
    };

    const outgoing: AgentMessage = {
      taskId,
      sender: agentId,
      recipient: input.coderAgentId,
      type: "handoff",
      payload: { kind: "json", value: enrichedWithElapsed },
      timestamp: this.clock.nowIso(),
    };

    await this.messageHistoryStore.append(taskId, outgoing);
    const persistenceLatencyMs = this.clock.nowMs() - persistStart;

    await this.publishTrace(taskId, agentId, {
      kind: "status",
      status: "finished",
      at: this.clock.nowIso(),
    });

    const elapsedMs = this.clock.nowMs() - startMs;

    return {
      outgoing,
      enriched: enrichedWithElapsed,
      recipient: input.coderAgentId,
      elapsedMs,
      persistenceLatencyMs,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Run the Web_Search_Tool and translate its result into a normalised
   * envelope.
   *
   * Per Requirement 7.3 the Researcher tolerates every failure mode:
   *
   *   • The injected tool is undefined           → outcome `skipped`.
   *   • The tool returns `{ kind: "error" }`     → outcome `unavailable`.
   *   • The tool throws                          → outcome `unavailable`.
   *   • The original prompt is empty             → outcome `skipped`.
   *
   * The {@link TracedWebSearchTool} wrapper publishes the `tool_call`
   * trace record on its own (Requirement 9.5) — the Researcher does not
   * emit a second one.
   */
  private async runWebSearch(originalPrompt: string): Promise<SearchEnvelope> {
    if (this.webSearch === undefined) {
      return { outcome: "skipped" };
    }
    const trimmed = originalPrompt.trim();
    if (trimmed.length === 0) {
      return { outcome: "skipped" };
    }
    let result: SearchResult;
    try {
      result = await this.webSearch.search(trimmed, {
        limit: RESEARCHER_SEARCH_LIMIT,
      });
    } catch {
      // Tool throw is treated identically to a structured error result
      // (Requirement 9.4 mandates structured errors, but we defend
      // against future adapters that violate that contract).
      return { outcome: "unavailable" };
    }

    if (result.kind === "error") {
      return { outcome: "unavailable" };
    }

    if (result.results.length === 0) {
      return { outcome: "ok", summary: "" };
    }

    const summary = result.results
      .map(
        (hit, i) =>
          `${i + 1}. ${hit.title} — ${hit.url}\n   ${hit.snippet}`,
      )
      .join("\n");
    return { outcome: "ok", summary };
  }

  /**
   * Build the synthetic Agent_Message that carries the original prompt
   * and search summary into the model's prompt context.
   *
   * Not persisted — production history reflects only real inter-agent
   * traffic, not the agent's per-call context window.
   */
  private buildResearcherContextMessage(
    input: ResearcherRunInput,
    originalPrompt: string,
    search: SearchEnvelope,
  ): AgentMessage {
    const sections: string[] = [];
    sections.push(
      `Original user prompt:\n<prompt>\n${originalPrompt}\n</prompt>`,
    );
    if (search.outcome === "ok" && search.summary !== undefined) {
      sections.push(
        search.summary.length > 0
          ? `Web search results:\n<results>\n${search.summary}\n</results>`
          : `Web search returned no results.`,
      );
    } else if (search.outcome === "unavailable") {
      sections.push(
        "Web_Search_Tool was unavailable for this run; rely on the model only.",
      );
    } else {
      sections.push(
        "Web_Search_Tool was not invoked for this run; rely on the model only.",
      );
    }
    sections.push(
      "Produce an enriched version of the prompt that combines the original prompt with any useful context. " +
        "Output the enriched prompt as plain text only — no JSON wrapper, no commentary.",
    );

    return {
      taskId: input.task.id,
      sender: "orchestrator",
      recipient: input.agent.id,
      type: "request",
      payload: {
        kind: "text",
        text: sections.join("\n\n"),
      },
      timestamp: this.clock.nowIso(),
    };
  }

  private async publishTrace(
    taskId: string,
    agentId: AgentId,
    record: Parameters<TraceEventBusInterface["publish"]>[0]["record"],
  ): Promise<void> {
    try {
      await this.traceBus.publish({ taskId, agentId, record });
    } catch {
      // Trace failures must never alter the agent's contribution.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SearchEnvelope {
  readonly outcome: "ok" | "unavailable" | "skipped";
  readonly summary?: string;
}

/**
 * Pull the user's original prompt out of the incoming Agent_Message.
 *
 * Accepted shapes:
 *   • `payload.kind === "text"`  → `payload.text`.
 *   • `payload.kind === "json"`  → `value.prompt | value.text |
 *      value.originalPrompt` (first non-empty string wins).
 *
 * Anything else (binary, missing, malformed) collapses to the empty
 * string. The orchestrator's input validation rejects empty user
 * prompts before reaching the Researcher (Requirement 6.4), so an
 * empty result here only happens with synthetic test inputs or
 * malformed handoffs — both safe to feed back into the pipeline as
 * "no prompt" rather than crashing.
 */
function extractOriginalPrompt(incoming: AgentMessage): string {
  if (incoming.payload.kind === "text") {
    return incoming.payload.text;
  }
  if (incoming.payload.kind === "json") {
    const value = incoming.payload.value;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const key of ["prompt", "text", "originalPrompt"] as const) {
        const v = obj[key];
        if (typeof v === "string" && v.length > 0) return v;
      }
    }
    return "";
  }
  return "";
}

/**
 * Coerce raw model output into a plain-text enrichment.
 *
 * Strings pass through unchanged; objects with `text`, `content`, or a
 * `prompt` field are unwrapped. Anything else returns null so the
 * caller can fall back to a search-summary-only enrichment. We do not
 * try to `JSON.stringify` arbitrary objects — that would inject a
 * structural artefact into the user-facing prompt body and is more
 * surprising than dropping back to the model-less path.
 */
function extractModelText(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  for (const key of ["enrichedPrompt", "text", "content", "prompt"] as const) {
    const v = obj[key];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

interface AssembleEnrichedPromptInput {
  readonly originalPrompt: string;
  readonly modelEnrichment: string | null;
  readonly search: SearchEnvelope;
}

/**
 * Build the user-facing enriched prompt body.
 *
 * Strategy:
 *   • If the model produced text, use it as the spine and add a search
 *     section when results were retrieved.
 *   • If the model produced nothing usable, fall back to the original
 *     prompt and the search summary (if any).
 *   • When the search was unavailable / skipped, the body MUST contain
 *     a marker (Requirement 7.3). Marker text is canonical so callers
 *     and tests can detect it via substring matching.
 */
function assembleEnrichedPrompt(input: AssembleEnrichedPromptInput): string {
  const { originalPrompt, modelEnrichment, search } = input;
  const sections: string[] = [];

  if (modelEnrichment !== null) {
    sections.push(modelEnrichment);
  } else {
    sections.push(
      originalPrompt.length > 0
        ? `Original prompt: ${originalPrompt}`
        : "Original prompt: (empty)",
    );
  }

  if (search.outcome === "ok") {
    if (search.summary !== undefined && search.summary.length > 0) {
      sections.push(`Web search context:\n${search.summary}`);
    } else {
      sections.push(WEB_SEARCH_NO_RESULTS_MARKER);
    }
  } else {
    sections.push(WEB_SEARCH_UNAVAILABLE_MARKER);
  }

  return sections.join("\n\n");
}

/**
 * Marker inserted into the enriched prompt when the Web_Search_Tool
 * could not be reached or returned an error (Requirement 7.3).
 *
 * Exposed so tests and downstream consumers can match on it without
 * relying on the exact phrasing.
 */
export const WEB_SEARCH_UNAVAILABLE_MARKER =
  "[web-search-unavailable] Web_Search_Tool did not return results for this run.";

/**
 * Marker inserted when the search backend completed normally but
 * returned an empty result set. Distinguishes "no results" from
 * "tool failure" so the Coder can decide how much to trust the
 * enrichment.
 */
export const WEB_SEARCH_NO_RESULTS_MARKER =
  "[web-search-empty] Web_Search_Tool returned zero results for this run.";

function validateInput(input: ResearcherRunInput): void {
  assertNonEmptyString(input.task.id, "task.id");
  assertNonEmptyString(input.agent.id, "agent.id");
  assertNonEmptyString(input.agent.systemPrompt, "agent.systemPrompt");
  assertNonEmptyString(input.coderAgentId, "coderAgentId");
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `ResearcherAgent.run: ${field} must be a non-empty string`,
    );
  }
}

// Mark the persistence budget as referenced from the public API so the
// unused-import lint rule allows the import — tests assert against it.
export const RESEARCHER_PERSISTENCE_BUDGET_MS = AGENT_PERSISTENCE_BUDGET_MS;
