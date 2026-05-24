/**
 * Boss builtin agent (task 14.4).
 *
 * The Boss is the final reviewer in the orchestrator pipeline. It compares
 * the team's final `File_Artifact` against the user's original prompt and
 * emits one of two verdicts:
 *
 *   • `approved`  — Russian wording: "соответствует".
 *   • `rejected`  — Russian wording: "не соответствует".
 *
 * Sources:
 *  - requirements.md →
 *      7.1   (Boss is one of the five Builtin_Agent roles),
 *      7.10  (Boss compares the result with the user's prompt and outputs
 *             "соответствует" / "не соответствует" with concrete notes),
 *      7.11  (rejection returns the artifact + notes; orchestrator decides
 *             whether to re-enter the pipeline),
 *      14.1  (Boss approval is only permitted after at least one
 *             Review_Cycle has been performed).
 *  - design.md →
 *      "Pipeline State Machine" → "Pipeline rules" — "Boss cannot approve
 *        before at least one Review_Cycle";
 *      "Agent Runtime" → "Builtin agent permissions" — Boss tools are
 *        `file_read` and `artifact_diff`;
 *      "Pipeline State Machine" → "State diagram" — `boss_approved`
 *        transitions to `completed` only when `review_cycles >= 1`.
 *
 * Two-layer guard model:
 *
 *  1. The Orchestrator state-machine gate
 *     (`stateMachine.ts` → `review_cycles_ge_1`) is the structural
 *     enforcement: even if the Boss returns `approved`, the orchestrator
 *     refuses to transition `boss_eval → completed` while
 *     `reviewCycles === 0` (Requirement 14.1, validated by Property 2 in
 *     `bossApproval.property.test.ts`).
 *
 *  2. The Boss agent additionally refuses to *emit* `approved` when
 *     called with `reviewCycles === 0` — even before invoking the model
 *     adapter. This is defence-in-depth: if a future caller forgets the
 *     orchestrator gate, the Boss agent itself still produces a
 *     `rejected` verdict with the explanatory note "Review cycle
 *     required". This is the behaviour the task brief calls out
 *     ("agent itself MUST NOT emit 'approved' if asked to evaluate a
 *      state with `reviewCycles === 0`").
 *
 * The Boss agent uses `AgentRunner` (task 14.1) for the actual model
 * invocation so it inherits:
 *
 *   • history bounding (200 msgs / 8 MB, Requirement 10.7),
 *   • Agent_Message normalisation (Requirements 10.8, 10.9),
 *   • persist-before-handoff (Requirement 10.6).
 *
 * It then layers verdict parsing on top of the runner's outgoing message
 * so the orchestrator and Final_Report builder always see a structured
 * verdict regardless of how the underlying model phrased its answer.
 *
 * Out of scope for task 14.4:
 *   • Wiring the Boss into the pipeline state machine (task 15.1).
 *   • Final_Report assembly (task 15.2).
 *   • Tool implementations beyond declaring `allowedTools`.
 */

import { AgentRunner } from "../agentRuntime/agentRunner.js";
import {
  ORCHESTRATOR_RECIPIENT,
  type AgentDefinition,
  type MessageHistoryStore,
  type ModelAdapter,
  type RoutingTarget,
  type SecretRef,
  type TaskContext,
} from "../agentRuntime/types.js";
import type { Clock } from "../agentRuntime/agentRunner.js";
import type { AgentMessage } from "@ai-agent-orchestrator/validation";
import type { AgentId, ToolId } from "@ai-agent-orchestrator/shared-core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Russian verdict wording from design.md → "Pipeline State Machine" →
 * "State diagram" (`verdict == "соответствует"` / `verdict == "не
 *  соответствует"`). The orchestrator pattern-matches on `kind`; the
 * `verdict` string is preserved verbatim because it is the wording the
 * user-facing UI and Final_Report display (Requirement 7.10).
 */
export const BOSS_VERDICT_RUSSIAN = {
  approved: "соответствует",
  rejected: "не соответствует",
} as const;

export type BossVerdictKind = "approved" | "rejected";
export type BossVerdictWording =
  (typeof BOSS_VERDICT_RUSSIAN)[BossVerdictKind];

/**
 * Boss agent identifier used as the default `AgentId`. The orchestrator
 * may override this when running a custom-named Boss instance, but the
 * default matches the BUILTIN_AGENTS registry in
 * `settings/customAgents.ts` so logs and traces line up.
 */
export const BOSS_AGENT_ID: AgentId = "boss";

/**
 * Boss tool permissions per design.md → "Agent Runtime" →
 * "Builtin agent permissions": Boss reads files and inspects diffs, but
 * never writes (it has no `file_write`) and never searches the web (it
 * has no `web_search`). This is structural: the Boss's job is to judge
 * the existing artifact, not to extend it.
 */
export const BOSS_ALLOWED_TOOLS: readonly ToolId[] = [
  "file_read",
  "artifact_diff",
] as const;

/**
 * Default Boss system prompt. Asks the model to emit a strict JSON
 * verdict shape so the parser in `parseVerdictFromMessage` has a
 * predictable target. The prompt spells out both the English `kind`
 * tags and the Russian wording so:
 *
 *   • the orchestrator's `boss_approved`/`boss_rejected` events
 *     (`stateMachine.ts`) are easy to drive from `kind`;
 *   • the user-facing UI/Final_Report can show the Russian wording
 *     verbatim (Requirement 7.10).
 *
 * Real model adapters (task 14.1+) are free to override this prompt for
 * provider-specific phrasing — `BossAgentOptions.agent` accepts a
 * caller-supplied `AgentDefinition`.
 */
export const BOSS_SYSTEM_PROMPT = [
  "You are the Boss agent in an AI Agent Orchestrator pipeline.",
  "",
  "Your task is to compare the final File_Artifact produced by the team",
  "against the user's original prompt and decide whether it fulfils the",
  "prompt completely and without contradictions.",
  "",
  "You MUST emit a single JSON object with this shape:",
  "",
  '  { "kind": "approved", "verdict": "соответствует", "notes": [string] }',
  "",
  "or",
  "",
  '  { "kind": "rejected", "verdict": "не соответствует", "notes": [string, ...] }',
  "",
  "Rules:",
  '- Use "approved" / "соответствует" only when the artifact fully',
  "  satisfies the prompt and contains no contradictions.",
  '- Use "rejected" / "не соответствует" otherwise. The "notes" array',
  "  MUST list one or more concrete remaining issues.",
  "- Do not wrap the JSON in markdown fences or commentary.",
].join("\n");

/**
 * Default Boss `AgentDefinition`. Concrete provider model selection is
 * left to the caller (the task-level default model is used when this
 * definition's `model` is undefined — see `AgentRunner` and Requirement
 * 6.4). Custom Boss agents can override this via
 * `BossAgentOptions.agent`.
 */
export const DEFAULT_BOSS_AGENT: AgentDefinition = {
  id: BOSS_AGENT_ID,
  name: "Boss",
  systemPrompt: BOSS_SYSTEM_PROMPT,
  allowedTools: BOSS_ALLOWED_TOOLS,
};

/**
 * Note text used both when the gate refuses approval pre-emptively and
 * (defence in depth) when post-validation rewrites a model-returned
 * approval that violates Requirement 14.1.
 */
export const BOSS_REVIEW_CYCLE_REQUIRED_NOTE =
  "Review cycle required: Boss approval is only permitted after at least one Review_Cycle has been performed.";

const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured Boss verdict.
 *
 *   • `kind`     — machine-readable approval state used by the orchestrator
 *                  to drive `boss_approved` / `boss_rejected` events.
 *   • `verdict`  — Russian wording from the design state diagram, displayed
 *                  in the UI and in Final_Report.bossSummary.
 *   • `notes`    — list of concrete remarks. For `rejected` verdicts the
 *                  list is guaranteed non-empty (Requirement 7.10:
 *                  "перечнем конкретных замечаний").
 */
export interface BossVerdict {
  readonly kind: BossVerdictKind;
  readonly verdict: BossVerdictWording;
  readonly notes: readonly string[];
}

export interface BossAgentOptions {
  readonly modelAdapter: ModelAdapter;
  readonly messageHistoryStore: MessageHistoryStore;
  readonly clock?: Clock;
  /** Override for the default Boss `AgentDefinition` (e.g. custom prompt). */
  readonly agent?: AgentDefinition;
}

export interface BossEvaluateInput {
  readonly task: TaskContext;
  readonly apiKey: SecretRef;
  /**
   * Number of Review_Cycle iterations completed before the orchestrator
   * routed control to the Boss. Mirrors `TaskState.reviewCycles` from
   * `validation/task.ts` and is the same counter the orchestrator's
   * `review_cycles_ge_1` guard checks (Requirement 14.1).
   */
  readonly reviewCycles: number;
  /**
   * Handoff message describing the original prompt and the final
   * File_Artifact. The orchestrator assembles this from the task state
   * before calling `evaluate` — Boss does not access the artifact store
   * directly; it relies on the model to read tool-mediated content.
   */
  readonly incoming: AgentMessage;
  readonly recipient?: RoutingTarget;
  readonly timeoutMs?: number;
}

export interface BossEvaluateResult {
  /**
   * The verdict-shaped `Agent_Message` persisted to the task history.
   * Always has `type: "response"` and a JSON payload matching the
   * `BossVerdict` shape so downstream consumers (Final_Report builder,
   * UI) have a stable structure to decode.
   */
  readonly outgoing: AgentMessage;
  readonly verdict: BossVerdict;
  /**
   * Wall-clock latency of the final persistence call. Mirrors
   * `AgentRunResult.persistenceLatencyMs` so the orchestrator can
   * surface 500 ms-budget violations (Requirement 10.6) regardless of
   * which path the Boss took.
   */
  readonly persistenceLatencyMs: number;
  /**
   * `true` when the persisted outgoing message was synthesised by the
   * Boss (gate rejection, or model output that did not already match
   * the verdict shape). Mirrors `AgentRunResult.normalized`.
   */
  readonly normalized: boolean;
}

// ---------------------------------------------------------------------------
// Boss agent
// ---------------------------------------------------------------------------

/**
 * Boss builtin agent.
 *
 * Stateless across calls; safe to share across concurrent task pipelines
 * as long as the underlying `MessageHistoryStore` and `ModelAdapter` are
 * themselves concurrency-safe.
 */
export class BossAgent {
  private readonly runner: AgentRunner;
  private readonly messageHistoryStore: MessageHistoryStore;
  private readonly clock: Clock;
  private readonly agent: AgentDefinition;

  public constructor(options: BossAgentOptions) {
    this.messageHistoryStore = options.messageHistoryStore;
    this.clock = options.clock ?? systemClock;
    this.agent = options.agent ?? DEFAULT_BOSS_AGENT;
    this.runner = new AgentRunner({
      modelAdapter: options.modelAdapter,
      messageHistoryStore: options.messageHistoryStore,
      ...(options.clock ? { clock: options.clock } : {}),
    });
  }

  /**
   * Evaluate the final artifact against the user's original prompt and
   * return the Boss's verdict.
   *
   * Pipeline:
   *
   *   1. Validate the gate. If `reviewCycles < 1` (or not a non-negative
   *      integer), short-circuit with a `rejected` verdict and persist
   *      the rejection message directly — no model call is made.
   *      Requirement 14.1.
   *   2. Otherwise, invoke the underlying `AgentRunner` to call the
   *      model adapter. The runner persists its raw outgoing message
   *      via the shared history store.
   *   3. Parse the runner's outgoing message into a `BossVerdict`.
   *   4. If the parsed verdict is structurally identical to the
   *      runner's outgoing message, return it as-is — a single record
   *      already represents the verdict.
   *   5. Otherwise, persist a follow-up verdict-shaped message so the
   *      Final_Report builder can rely on a stable schema.
   *
   * Defence in depth: even if the model emits an `approved` verdict on
   * a call where the gate would have rejected (e.g. a future refactor
   * forgets the gate), the verdict is rewritten to `rejected` with the
   * standard "Review cycle required" note before persistence.
   */
  public async evaluate(
    input: BossEvaluateInput,
  ): Promise<BossEvaluateResult> {
    const recipient: RoutingTarget =
      input.recipient ?? ORCHESTRATOR_RECIPIENT;

    if (!isReviewCycleSatisfied(input.reviewCycles)) {
      return this.persistGateRejection(input, recipient);
    }

    const runResult = await this.runner.run({
      task: input.task,
      agent: this.agent,
      apiKey: input.apiKey,
      incoming: input.incoming,
      recipient,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });

    const parsedVerdict = parseVerdictFromMessage(runResult.outgoing);

    // Defence in depth (Requirement 14.1): a future change in the
    // pre-call gate above must not be able to leak an `approved` verdict.
    const enforcedVerdict: BossVerdict =
      parsedVerdict.kind === "approved" &&
      !isReviewCycleSatisfied(input.reviewCycles)
        ? buildRejectedVerdict([BOSS_REVIEW_CYCLE_REQUIRED_NOTE])
        : parsedVerdict;

    if (verdictMatchesMessage(runResult.outgoing, enforcedVerdict)) {
      return {
        outgoing: runResult.outgoing,
        verdict: enforcedVerdict,
        persistenceLatencyMs: runResult.persistenceLatencyMs,
        normalized: runResult.normalized,
      };
    }

    return this.persistVerdict(input, recipient, enforcedVerdict, {
      rawOriginal: runResult.outgoing.payload,
      normalized: true,
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async persistGateRejection(
    input: BossEvaluateInput,
    recipient: RoutingTarget,
  ): Promise<BossEvaluateResult> {
    const verdict = buildRejectedVerdict([BOSS_REVIEW_CYCLE_REQUIRED_NOTE]);
    return this.persistVerdict(input, recipient, verdict, { normalized: false });
  }

  private async persistVerdict(
    input: BossEvaluateInput,
    recipient: RoutingTarget,
    verdict: BossVerdict,
    flags: { normalized: boolean; rawOriginal?: unknown },
  ): Promise<BossEvaluateResult> {
    const outgoing = buildVerdictMessage({
      taskId: input.task.id,
      sender: this.agent.id,
      recipient,
      verdict,
      timestamp: this.clock.nowIso(),
      ...(flags.normalized ? { normalized: true } : {}),
      ...(flags.rawOriginal !== undefined
        ? { rawOriginal: flags.rawOriginal }
        : {}),
    });

    const persistStart = this.clock.nowMs();
    await this.messageHistoryStore.append(input.task.id, outgoing);
    const persistenceLatencyMs = this.clock.nowMs() - persistStart;

    return {
      outgoing,
      verdict,
      persistenceLatencyMs,
      normalized: flags.normalized,
    };
  }
}

// ---------------------------------------------------------------------------
// Verdict helpers
// ---------------------------------------------------------------------------

/**
 * Boolean form of the Requirement 14.1 gate.
 *
 * Treats negative numbers, NaN, fractional values and non-numbers as
 * unsatisfied. Mirrors `taskStateSchema`'s `0 <= reviewCycles <=
 * maxReviewCycles` invariant: any value outside the integer range is
 * either malformed input or an attempt to bypass the gate, both of
 * which must produce a `rejected` verdict.
 */
function isReviewCycleSatisfied(reviewCycles: number): boolean {
  return Number.isInteger(reviewCycles) && reviewCycles >= 1;
}

function buildRejectedVerdict(notes: readonly string[]): BossVerdict {
  const trimmed = notes
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter((n) => n.length > 0);
  return {
    kind: "rejected",
    verdict: BOSS_VERDICT_RUSSIAN.rejected,
    notes:
      trimmed.length > 0
        ? trimmed
        : ["Boss did not provide rejection notes."],
  };
}

function buildApprovedVerdict(notes: readonly string[]): BossVerdict {
  const trimmed = notes
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter((n) => n.length > 0);
  return {
    kind: "approved",
    verdict: BOSS_VERDICT_RUSSIAN.approved,
    notes: trimmed,
  };
}

interface BuildVerdictMessageInput {
  taskId: string;
  sender: AgentId;
  recipient: RoutingTarget;
  verdict: BossVerdict;
  timestamp: string;
  normalized?: boolean;
  rawOriginal?: unknown;
}

function buildVerdictMessage(input: BuildVerdictMessageInput): AgentMessage {
  return {
    taskId: input.taskId,
    sender: input.sender,
    recipient: input.recipient,
    type: "response",
    payload: {
      kind: "json",
      // Spread to a fresh object so callers cannot mutate the persisted
      // record by holding a reference to the verdict.
      value: {
        kind: input.verdict.kind,
        verdict: input.verdict.verdict,
        notes: [...input.verdict.notes],
      },
    },
    timestamp: input.timestamp,
    ...(input.normalized !== undefined
      ? { normalized: input.normalized }
      : {}),
    ...(input.rawOriginal !== undefined
      ? { rawOriginal: input.rawOriginal }
      : {}),
  };
}

/**
 * Returns true when `msg`'s payload already encodes `verdict` exactly.
 * Used to avoid double-persistence when the model returned a
 * verdict-shaped JSON message of its own accord.
 */
function verdictMatchesMessage(
  msg: AgentMessage,
  verdict: BossVerdict,
): boolean {
  if (msg.type !== "response") return false;
  if (msg.payload.kind !== "json") return false;
  const value = msg.payload.value;
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.kind !== verdict.kind) return false;
  if (obj.verdict !== verdict.verdict) return false;
  if (!Array.isArray(obj.notes)) return false;
  if (obj.notes.length !== verdict.notes.length) return false;
  for (let i = 0; i < obj.notes.length; i += 1) {
    if (obj.notes[i] !== verdict.notes[i]) return false;
  }
  return true;
}

/**
 * Parse a `BossVerdict` from an Agent_Message produced by the model.
 *
 * Strategy:
 *
 *   1. JSON payloads → look for `kind` / `verdict` field.
 *   2. Text payloads → look for the Russian wording (rejected check
 *      first because "не соответствует" contains "соответствует" as a
 *      substring), with English `approved` / `rejected` fallback.
 *   3. Error messages → return `rejected` with the failure reason in
 *      the notes (Requirement 7.10 still demands concrete notes).
 *   4. Anything else → `rejected` with a generic "could not interpret"
 *      note. We never produce an `approved` verdict from ambiguous
 *      output — silent approval is the most dangerous failure mode for
 *      a final reviewer.
 */
function parseVerdictFromMessage(msg: AgentMessage): BossVerdict {
  if (msg.payload.kind === "json") {
    const fromJson = parseVerdictFromJsonValue(msg.payload.value);
    if (fromJson !== null) return fromJson;
  }
  if (msg.payload.kind === "text") {
    const fromText = parseVerdictFromText(msg.payload.text);
    if (fromText !== null) return fromText;
  }
  if (msg.type === "error") {
    const reason =
      msg.payload.kind === "text" && msg.payload.text.trim().length > 0
        ? msg.payload.text.trim()
        : "model error";
    return buildRejectedVerdict([
      `Boss could not produce a verdict: ${reason}`,
    ]);
  }
  return buildRejectedVerdict([
    "Boss could not interpret model output as an approval/rejection verdict.",
  ]);
}

function parseVerdictFromJsonValue(value: unknown): BossVerdict | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;

  const kind = obj.kind;
  const wording = obj.verdict;

  const notes = normalizeNotesField(obj.notes);

  // Approved: requires either an explicit "approved" kind or the exact
  // Russian wording, AND must NOT also carry a rejection signal. This
  // guards against ambiguous payloads like
  // `{ kind: "approved", verdict: "не соответствует" }` where the
  // safer interpretation is rejection.
  const isApprovedByKind = kind === "approved";
  const isApprovedByWording = wording === BOSS_VERDICT_RUSSIAN.approved;
  const isRejectedByKind = kind === "rejected";
  const isRejectedByWording = wording === BOSS_VERDICT_RUSSIAN.rejected;

  if (isRejectedByKind || isRejectedByWording) {
    return buildRejectedVerdict(notes);
  }
  if (isApprovedByKind || isApprovedByWording) {
    return buildApprovedVerdict(notes);
  }
  return null;
}

function parseVerdictFromText(text: string): BossVerdict | null {
  // "не соответствует" includes "соответствует" — check rejection first.
  if (text.includes(BOSS_VERDICT_RUSSIAN.rejected)) {
    return buildRejectedVerdict([text.trim()]);
  }
  if (text.includes(BOSS_VERDICT_RUSSIAN.approved)) {
    return buildApprovedVerdict(text.trim().length > 0 ? [text.trim()] : []);
  }
  if (/\brejected\b/i.test(text)) {
    return buildRejectedVerdict([text.trim()]);
  }
  if (/\bapproved\b/i.test(text)) {
    return buildApprovedVerdict(text.trim().length > 0 ? [text.trim()] : []);
  }
  return null;
}

function normalizeNotesField(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value) {
      if (typeof v === "string") {
        const trimmed = v.trim();
        if (trimmed.length > 0) out.push(trimmed);
      }
    }
    return out;
  }
  return [];
}
