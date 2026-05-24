/**
 * `AgentRunner` (task 14.1).
 *
 * Implements design.md → "Agent Runtime" → "Interface" with the
 * normalisation rules from design.md → "Agent_Message" / "Agent errors":
 *
 *   • Provider call adapter (port — see {@link ModelAdapter}).
 *   • Structured output parsing through `normalizeAgentMessage`.
 *   • Wrap unreadable adapter output as a valid Agent_Message of
 *     `type: "error"` so handoff cannot pass garbage downstream
 *     (Requirement 10.9).
 *   • Persist the resulting Agent_Message before handoff and surface
 *     the measured persistence latency so callers can verify the
 *     500 ms budget (Requirement 10.6).
 *   • Pass message history bounded by the latest 200 messages or
 *     8 MB total (Requirement 10.7), oldest first.
 *
 * Out of scope (handled by tasks 14.2–14.4):
 *   • Specific Builtin_Agent behaviours.
 *   • Trace-bus emission of agent thoughts / tool calls.
 *   • File_Artifact writes.
 *
 * The runner deliberately keeps no role-specific state: it is a thin
 * orchestration layer over the model adapter, the normaliser and the
 * history store. Subsequent tasks compose tools (Web_Search_Tool,
 * Artifact Store) around it without changing this surface.
 */

import {
  normalizeAgentMessage,
  type AgentMessage,
} from "@ai-agent-orchestrator/validation";
import type { ModelRef } from "@ai-agent-orchestrator/shared-core";

import { boundAgentHistory } from "./historyBounds.js";
import {
  ORCHESTRATOR_RECIPIENT,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunner as AgentRunnerInterface,
  type MessageHistoryStore,
  type ModelAdapter,
  type ModelInvokeOptions,
  type RoutingTarget,
} from "./types.js";

// ---------------------------------------------------------------------------
// Optional dependencies (clock, perf)
// ---------------------------------------------------------------------------

/** Wall-clock abstraction, primarily for deterministic tests. */
export interface Clock {
  /**
   * Current time in milliseconds since the Unix epoch. Used both for
   * the outgoing message `timestamp` (via {@link nowIso}) and for
   * measuring the persistence-latency budget — task 14.1 unit tests
   * inject a deterministic clock to verify the 500 ms cap.
   */
  nowMs(): number;
  /** ISO 8601 UTC ms timestamp for the current moment. */
  nowIso(): string;
}

const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/** Options accepted by {@link AgentRunner}. */
export interface AgentRunnerOptions {
  readonly modelAdapter: ModelAdapter;
  readonly messageHistoryStore: MessageHistoryStore;
  readonly clock?: Clock;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Default `AgentRunner` implementation. Stateless — safe to share
 * across concurrent task pipelines.
 */
export class AgentRunner implements AgentRunnerInterface {
  private readonly modelAdapter: ModelAdapter;
  private readonly messageHistoryStore: MessageHistoryStore;
  private readonly clock: Clock;

  public constructor(options: AgentRunnerOptions) {
    this.modelAdapter = options.modelAdapter;
    this.messageHistoryStore = options.messageHistoryStore;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Run the agent against the current task history and return its
   * outgoing Agent_Message.
   *
   * Pipeline:
   *   1. Load the conversation log via the history store.
   *   2. Trim to the latest 200 messages / 8 MB (Requirement 10.7).
   *   3. Resolve the agent's effective model — Requirement 6.4 says the
   *      task's default model is used when the agent does not pin one.
   *   4. Invoke the adapter; on any thrown exception, fall back to a
   *      synthetic raw output describing the failure so step 5 can
   *      normalise it into a `type: "error"` Agent_Message.
   *   5. Normalise the adapter output into a valid Agent_Message
   *      (Requirements 10.8 / 10.9).
   *   6. Persist the outgoing message via the store and measure the
   *      latency (Requirement 10.6).
   */
  public async run(input: AgentRunInput): Promise<AgentRunResult> {
    validateInput(input);

    const history = await this.messageHistoryStore.list(input.task.id);
    const boundedHistory = boundAgentHistory(history);

    const effectiveModel: ModelRef =
      input.agent.model ?? input.task.defaultModel;

    const adapterOptions: ModelInvokeOptions = {
      systemPrompt: input.agent.systemPrompt,
      apiKey: input.apiKey,
      allowedTools: input.agent.allowedTools,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };

    const recipient: RoutingTarget =
      input.recipient ?? ORCHESTRATOR_RECIPIENT;
    const baseTimestamp = this.clock.nowIso();

    let outgoing: AgentMessage;
    try {
      const result = await this.modelAdapter.invoke(
        effectiveModel,
        boundedHistory,
        adapterOptions,
      );
      outgoing = normalizeAgentMessage(result?.raw, {
        taskId: input.task.id,
        sender: input.agent.id,
        recipient,
        timestamp: baseTimestamp,
      });
    } catch (err) {
      // Adapter exceptions are a communication failure with no
      // model output to normalise. Requirement 10.9 mandates a
      // `type: "error"` Agent_Message describing the cause; we
      // cannot route through the normaliser because a JSON-shaped
      // synthetic value would otherwise be coerced into a
      // `type: "response"`.
      outgoing = {
        taskId: input.task.id,
        sender: input.agent.id,
        recipient,
        type: "error",
        payload: {
          kind: "text",
          text: `Agent runtime failed to invoke model adapter: ${describeError(err)}`,
        },
        timestamp: baseTimestamp,
        normalized: true,
      };
    }

    // Persistence is the synchronisation point with the orchestrator's
    // 500 ms budget (Requirement 10.6). We measure the latency of the
    // append call itself rather than the whole run because the
    // requirement's intent is "persist before handoff", not "the
    // entire agent must finish within 500 ms".
    const persistStart = this.clock.nowMs();
    await this.messageHistoryStore.append(input.task.id, outgoing);
    const persistenceLatencyMs = this.clock.nowMs() - persistStart;

    return {
      outgoing,
      persistenceLatencyMs,
      normalized: outgoing.normalized === true,
    };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function validateInput(input: AgentRunInput): void {
  assertNonEmptyString(input.task.id, "task.id");
  assertNonEmptyString(input.agent.id, "agent.id");
  assertNonEmptyString(input.agent.name, "agent.name");
  assertNonEmptyString(input.agent.systemPrompt, "agent.systemPrompt");
  if (input.recipient !== undefined) {
    assertNonEmptyString(input.recipient, "recipient");
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `AgentRunner.run: ${field} must be a non-empty string`,
    );
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message =
      err.message.length > 256 ? `${err.message.slice(0, 256)}…` : err.message;
    return `${err.name}: ${message}`;
  }
  return "unknown error";
}

// Type-only re-exports keep the public surface importable from the
// runner module directly — convenient for tests that only need the
// runner and its options.
export type { AgentMessage } from "@ai-agent-orchestrator/validation";
