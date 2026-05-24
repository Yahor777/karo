/**
 * Fixer builtin agent (task 14.3).
 *
 * Sources:
 * - design.md → "Agent Runtime" → "Builtin agent permissions" — Fixer
 *   has access to `web_search`, `file_read`, `file_write` and
 *   `artifact_diff`.
 * - design.md → "Pipeline State Machine" / "Task Execution Flow" — the
 *   Fixer receives the Reviewer's defects list together with the current
 *   File_Artifact and writes an updated version back to the Artifact
 *   Store, which routes the next handoff to the Reviewer.
 * - requirements.md →
 *     7.1 (the five Builtin_Agent roles),
 *     7.6 (Orchestrator passes the defects + current File_Artifact to
 *          the Fixer when the Reviewer's list is non-empty),
 *     7.7 (Fixer applies fixes and returns the updated File_Artifact
 *          atomically; Requirement 7.4 establishes "atomic" — a single
 *          File_Artifact production with no intermediate states).
 *
 * Behaviour summary:
 *
 *   1. Emit a `status: "started"` trace event.
 *   2. Read the latest File_Artifact bytes via the Artifact Store
 *      (`file_read`) and emit a `tool_call` trace describing the read.
 *   3. Load the bounded conversation history (Requirement 10.7), append
 *      a synthetic in-memory message that carries the artifact body and
 *      the Reviewer's defects, and invoke the model adapter.
 *   4. Extract the fixed content from the model output. Strings are
 *      treated as UTF-8 file content; JSON objects with a
 *      `content`/`text` field are unwrapped. Unparseable output yields
 *      an error Agent_Message routed back to the Reviewer so the
 *      pipeline can re-evaluate without losing the cycle counter.
 *   5. Write the new bytes via {@link ArtifactStoreInterface.writeArtifact}
 *      — atomic by construction (Requirement 7.4 / 7.7) — and emit an
 *      `artifact_change` trace event.
 *   6. Build the structured outgoing Agent_Message with payload
 *      `{ kind: "json", value: <FixedArtifactPayload> }` and
 *      `type: "handoff"` addressed to the Reviewer.
 *   7. Persist the outgoing Agent_Message before handoff (Requirement
 *      10.6) and emit a `status: "finished"` trace event.
 *
 * Validates: Requirements 7.1, 7.6, 7.7.
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
import type { ArtifactStoreInterface } from "../artifacts/index.js";
import type { TraceEventBusInterface } from "../trace/index.js";
import type { AgentMessage } from "@ai-agent-orchestrator/validation";
import type { AgentId } from "@ai-agent-orchestrator/shared-core";

import type {
  Defect,
  FixedArtifactPayload,
  ReviewerVerdictPayload,
} from "./types.js";

// ---------------------------------------------------------------------------
// Clock injection (for deterministic tests)
// ---------------------------------------------------------------------------

export interface Clock {
  nowIso(): string;
  nowMs(): number;
}

const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Constructor and run-time inputs
// ---------------------------------------------------------------------------

export interface FixerAgentOptions {
  readonly modelAdapter: ModelAdapter;
  readonly messageHistoryStore: MessageHistoryStore;
  readonly artifactStore: ArtifactStoreInterface;
  readonly traceBus: TraceEventBusInterface;
  readonly clock?: Clock;
  /**
   * Optional id generator. Currently unused by the Fixer (the artifact
   * store mints its own version-scoped ids), but kept on the options
   * for API symmetry with the Reviewer/Coder agents and so existing
   * test harnesses that pass `idGenerator: () => "..."` continue to
   * type-check.
   */
  readonly idGenerator?: () => string;
}

/**
 * Input for {@link FixerAgent.run}.
 *
 * `defects` is the Reviewer's list (Requirement 7.6). `artifactRef`
 * targets the version that needs fixing — the Fixer reads it through
 * the Artifact Store rather than trusting a payload-embedded copy.
 *
 * `reviewerAgentId` is the routing target for the resulting handoff
 * (design.md → "Pipeline State Machine": Fixing → Reviewing).
 */
export interface FixerRunInput {
  readonly task: TaskContext;
  readonly agent: AgentDefinition;
  readonly apiKey: SecretRef;
  readonly incoming: AgentMessage;
  readonly artifactRef: { readonly artifactId: string; readonly version: number };
  readonly defects: readonly Defect[];
  readonly reviewerAgentId: AgentId;
  readonly timeoutMs?: number;
}

/** Result of {@link FixerAgent.run}. */
export interface FixerRunResult {
  readonly outgoing: AgentMessage;
  readonly fixed: FixedArtifactPayload;
  readonly recipient: AgentId;
  readonly persistenceLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Fixer Builtin_Agent.
 *
 * Stateless beyond its dependencies — safe to share across concurrent
 * task pipelines. Like the Reviewer, the agent keeps adapter-output
 * coercion local: the orchestrator does not need to know how the
 * model's raw response gets turned into a new artifact version.
 */
export class FixerAgent {
  private readonly modelAdapter: ModelAdapter;
  private readonly messageHistoryStore: MessageHistoryStore;
  private readonly artifactStore: ArtifactStoreInterface;
  private readonly traceBus: TraceEventBusInterface;
  private readonly clock: Clock;

  public constructor(options: FixerAgentOptions) {
    this.modelAdapter = options.modelAdapter;
    this.messageHistoryStore = options.messageHistoryStore;
    this.artifactStore = options.artifactStore;
    this.traceBus = options.traceBus;
    this.clock = options.clock ?? systemClock;
  }

  public async run(input: FixerRunInput): Promise<FixerRunResult> {
    validateInput(input);

    const taskId = input.task.id;
    const agentId = input.agent.id;

    await this.publishTrace(taskId, agentId, {
      kind: "status",
      status: "started",
      at: this.clock.nowIso(),
    });

    // Step 2: read the current artifact.
    const current = await this.artifactStore.getArtifact({
      taskId,
      artifactId: input.artifactRef.artifactId,
      version: input.artifactRef.version,
    });

    if (current === null) {
      const reason = `Fixer could not load artifact ${input.artifactRef.artifactId}@v${input.artifactRef.version}`;
      return this.failOut(input, reason);
    }

    await this.publishTrace(taskId, agentId, {
      kind: "tool_call",
      tool: "file_read",
      input: {
        artifactId: input.artifactRef.artifactId,
        version: input.artifactRef.version,
      },
      output: {
        version: current.version,
        contentHash: current.contentHash,
        byteLength: current.bytes.byteLength,
      },
      at: this.clock.nowIso(),
    });

    // Step 3: invoke the model with the artifact + defects context.
    const history = await this.messageHistoryStore.list(taskId);
    const bounded = boundAgentHistory(history);
    const augmentedHistory: readonly AgentMessage[] = [
      ...bounded,
      this.buildFixerContextMessage(input, current),
    ];

    const adapterOptions: ModelInvokeOptions = {
      systemPrompt: input.agent.systemPrompt,
      apiKey: input.apiKey,
      allowedTools: input.agent.allowedTools,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };

    const effectiveModel = input.agent.model ?? input.task.defaultModel;

    let raw: unknown;
    try {
      const result = await this.modelAdapter.invoke(
        effectiveModel,
        augmentedHistory,
        adapterOptions,
      );
      raw = result?.raw;
    } catch (err) {
      const reason = `Fixer model invocation failed: ${describeError(err)}`;
      return this.failOut(input, reason);
    }

    // Step 4: extract the fixed bytes.
    const extracted = extractFixedContent(raw);
    if (extracted === null) {
      const reason =
        "Fixer model output did not contain usable fixed content; expected text or { content: string }.";
      return this.failOut(input, reason);
    }

    // Step 5: atomically write the new version. Same-content writes
    // are idempotent (`ArtifactStore` rules) — if the model returns
    // bytes identical to the current version, the store hands back
    // the existing version and no version increment occurs. The Fixer
    // still returns a structurally valid handoff so the Reviewer can
    // re-evaluate; the next pipeline pass surfaces the no-progress
    // condition.
    const fixedBytes = utf8Encoder.encode(extracted.content);
    const fileName = current.fileName;
    const newVersion = await this.artifactStore.writeArtifact({
      taskId,
      artifactId: input.artifactRef.artifactId,
      authoredByAgentId: agentId,
      bytes: fixedBytes,
      fileName,
      ...(extracted.mimeType !== undefined
        ? { mimeType: extracted.mimeType }
        : {}),
    });

    await this.publishTrace(taskId, agentId, {
      kind: "artifact_change",
      artifactId: input.artifactRef.artifactId,
      version: newVersion.version,
      at: this.clock.nowIso(),
    });

    // Step 6: assemble and persist the handoff message.
    const fixed: FixedArtifactPayload = {
      kind: "fixedArtifact",
      artifactId: input.artifactRef.artifactId,
      version: newVersion.version,
      fileName,
      contentHash: newVersion.contentHash,
      addressedDefectIds: input.defects.map((d) => d.id),
      ...(extracted.summary !== undefined ? { summary: extracted.summary } : {}),
    };

    const outgoing: AgentMessage = {
      taskId,
      sender: agentId,
      recipient: input.reviewerAgentId,
      type: "handoff",
      payload: { kind: "json", value: fixed },
      timestamp: this.clock.nowIso(),
    };

    const persistStart = this.clock.nowMs();
    await this.messageHistoryStore.append(taskId, outgoing);
    const persistenceLatencyMs = this.clock.nowMs() - persistStart;

    await this.publishTrace(taskId, agentId, {
      kind: "status",
      status: "finished",
      at: this.clock.nowIso(),
    });

    return {
      outgoing,
      fixed,
      recipient: input.reviewerAgentId,
      persistenceLatencyMs,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Build the synthetic in-memory message that hands the model the
   * artifact body and the Reviewer's defects list. Not persisted —
   * matches the Reviewer's discipline.
   */
  private buildFixerContextMessage(
    input: FixerRunInput,
    current: { fileName: string; version: number; bytes: Uint8Array },
  ): AgentMessage {
    const text = utf8Decoder.decode(current.bytes);
    const defectsBlock = input.defects
      .map(
        (d, i) =>
          `${i + 1}. [${d.severity}] (id=${d.id})${
            d.location !== undefined ? ` @ ${d.location}` : ""
          } — ${d.description}`,
      )
      .join("\n");

    return {
      taskId: input.task.id,
      sender: "orchestrator",
      recipient: input.agent.id,
      type: "request",
      payload: {
        kind: "text",
        text:
          `Fix the following defects in ${current.fileName} (version ${current.version}).\n` +
          `<defects>\n${defectsBlock}\n</defects>\n` +
          `<artifact>\n${text}\n</artifact>`,
      },
      timestamp: this.clock.nowIso(),
    };
  }

  /**
   * Build, persist and trace an error-flavoured outgoing Agent_Message
   * routed back to the Reviewer. Used when the artifact cannot be
   * read, the adapter throws, or the model output cannot be turned
   * into a new artifact version. The orchestrator can pick up the
   * error message and decide whether to count this as another review
   * cycle or stop the task.
   */
  private async failOut(
    input: FixerRunInput,
    reason: string,
  ): Promise<FixerRunResult> {
    const taskId = input.task.id;
    const agentId = input.agent.id;
    const fixed: FixedArtifactPayload = {
      kind: "fixedArtifact",
      artifactId: input.artifactRef.artifactId,
      version: input.artifactRef.version,
      fileName: "",
      contentHash: "",
      addressedDefectIds: [],
      summary: reason,
    };

    const outgoing: AgentMessage = {
      taskId,
      sender: agentId,
      recipient: input.reviewerAgentId,
      type: "error",
      payload: { kind: "text", text: reason },
      timestamp: this.clock.nowIso(),
    };

    const persistStart = this.clock.nowMs();
    await this.messageHistoryStore.append(taskId, outgoing);
    const persistenceLatencyMs = this.clock.nowMs() - persistStart;

    await this.publishTrace(taskId, agentId, {
      kind: "status",
      status: "error",
      at: this.clock.nowIso(),
    });

    return {
      outgoing,
      fixed,
      recipient: input.reviewerAgentId,
      persistenceLatencyMs,
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

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Pull the fixed file content out of the model's raw response.
 *
 * Accepted shapes:
 *
 *   • `string`                                  → `{ content: <string> }`
 *   • `{ content: string, summary?: string }`   → unwrapped
 *   • `{ text:    string, summary?: string }`   → unwrapped
 *   • `{ bytes: Uint8Array, ... }`              → decoded as UTF-8
 *
 * Anything else (bigints, functions, objects without a recognised
 * field) returns null so the Fixer falls back to the error path.
 */
function extractFixedContent(raw: unknown): {
  readonly content: string;
  readonly mimeType?: string;
  readonly summary?: string;
} | null {
  if (typeof raw === "string") {
    return { content: raw };
  }
  if (raw instanceof Uint8Array) {
    return { content: utf8Decoder.decode(raw) };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  // Unwrap the common JSON-string container.
  if (typeof obj.raw === "string" && Object.keys(obj).length === 1) {
    return { content: obj.raw };
  }

  let content: string | null = null;
  if (typeof obj.content === "string") {
    content = obj.content;
  } else if (typeof obj.text === "string") {
    content = obj.text;
  } else if (obj.bytes instanceof Uint8Array) {
    content = utf8Decoder.decode(obj.bytes);
  }
  if (content === null) {
    // Fall back to JSON-string parsing once.
    return null;
  }

  const summary =
    typeof obj.summary === "string" && obj.summary.trim().length > 0
      ? obj.summary
      : undefined;
  const mimeType =
    typeof obj.mimeType === "string" && obj.mimeType.trim().length > 0
      ? obj.mimeType
      : undefined;
  return {
    content,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message =
      err.message.length > 256 ? `${err.message.slice(0, 256)}…` : err.message;
    return `${err.name}: ${message}`;
  }
  return "unknown error";
}

function validateInput(input: FixerRunInput): void {
  assertNonEmptyString(input.task.id, "task.id");
  assertNonEmptyString(input.agent.id, "agent.id");
  assertNonEmptyString(input.agent.systemPrompt, "agent.systemPrompt");
  assertNonEmptyString(input.reviewerAgentId, "reviewerAgentId");
  assertNonEmptyString(input.artifactRef.artifactId, "artifactRef.artifactId");
  if (
    !Number.isInteger(input.artifactRef.version) ||
    input.artifactRef.version < 1
  ) {
    throw new TypeError(
      "FixerAgent.run: artifactRef.version must be a positive integer",
    );
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `FixerAgent.run: ${field} must be a non-empty string`,
    );
  }
}

// Re-export the verdict type so callers can flow Reviewer output
// straight into the Fixer without reaching across module boundaries.
export type { ReviewerVerdictPayload };
export const FIXER_PERSISTENCE_BUDGET_MS = AGENT_PERSISTENCE_BUDGET_MS;
