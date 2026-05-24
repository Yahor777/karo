/**
 * Coder builtin agent (task 14.2).
 *
 * Sources:
 * - design.md → "Agent Runtime" → "Builtin agent permissions" — Coder
 *   has access to `web_search`, `file_read`, and `file_write`.
 * - design.md → "Pipeline State Machine" / "Task Execution Flow" — the
 *   Coder receives the Researcher's enriched prompt and writes a single
 *   File_Artifact (v1) atomically, then hands off to the Reviewer.
 * - design.md → "Artifact Store" — versions are append-only, start at
 *   1; same `contentHash` is a no-op (idempotent retry).
 * - requirements.md →
 *     7.1 (the five Builtin_Agent roles),
 *     7.4 (Coder atomically forms a single File_Artifact and hands it
 *          to the Reviewer as a single action without intermediate
 *          states visible to other agents).
 *
 * Behaviour summary:
 *
 *   1. Emit a `status: "started"` trace event.
 *   2. Extract the enriched prompt from the incoming message — JSON
 *      payloads carrying an `enrichedPrompt` string are preferred (this
 *      is the shape produced by the Researcher in `researcher.ts`),
 *      with text payloads accepted as a fallback.
 *   3. Load the bounded conversation history (Requirement 10.7), feed
 *      the model adapter, and extract the new artifact's content.
 *      Adapter exceptions or unparseable output yield an error
 *      Agent_Message routed back to the orchestrator — the Coder MUST
 *      NOT write a partial artifact, since a partial write would
 *      violate Requirement 7.4's atomicity contract.
 *   4. Atomically write the new bytes via
 *      {@link ArtifactStoreInterface.writeArtifact}. The store guarantees
 *      a single observable transition (Requirement 7.4 — "without
 *      intermediate states visible to other agents") even if the
 *      caller retries with byte-identical content
 *      (idempotent same-content writes are no-ops at version level).
 *   5. Emit an `artifact_change` trace event for the new version.
 *   6. Build the structured outgoing Agent_Message with payload
 *      `{ kind: "json", value: <CodedArtifactPayload> }` and
 *      `type: "handoff"` addressed to the Reviewer.
 *   7. Persist the outgoing Agent_Message before handoff (Requirement
 *      10.6) and emit a `status: "finished"` trace event.
 *
 * Validates: Requirements 7.1, 7.2 (the Researcher's handoff is the
 * Coder's input contract), 7.3, 7.4.
 */

import { randomUUID } from "node:crypto";

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

import type { CodedArtifactPayload } from "./types.js";

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

/**
 * Dependencies for {@link CoderAgent}.
 *
 * The Coder composes the same primitives as the Reviewer/Fixer:
 * {@link ModelAdapter}, {@link MessageHistoryStore},
 * {@link ArtifactStoreInterface}, and {@link TraceEventBusInterface}. The
 * shared {@link Clock} hook lets unit tests freeze timestamps.
 *
 * `idGenerator` is invoked when callers do not supply an artifact id;
 * the default uses `crypto.randomUUID()`.
 */
export interface CoderAgentOptions {
  readonly modelAdapter: ModelAdapter;
  readonly messageHistoryStore: MessageHistoryStore;
  readonly artifactStore: ArtifactStoreInterface;
  readonly traceBus: TraceEventBusInterface;
  readonly clock?: Clock;
  readonly idGenerator?: () => string;
  /**
   * Default file name used when the model output does not carry one.
   * Falls back to a generic placeholder rather than guessing from the
   * prompt — naming the artifact is the model's responsibility, not
   * the agent's.
   */
  readonly defaultFileName?: string;
  /**
   * Default MIME type. Optional; when undefined the artifact is written
   * without a `mimeType` field, which the Artifact Store accepts.
   */
  readonly defaultMimeType?: string;
}

/**
 * Input for {@link CoderAgent.run}.
 *
 * `incoming` is the handoff from the Researcher (or a manual handoff
 * during testing). `reviewerAgentId` is the routing target for the
 * resulting handoff (design.md → "Pipeline State Machine":
 * Coding → Reviewing).
 *
 * `artifactId` is optional; when omitted the agent creates a fresh
 * artifact id via the injected generator. The Coder typically creates
 * a new artifact (v1), but accepting an explicit id lets future flows
 * (e.g. multi-pass generation) extend an existing one without changing
 * the surface.
 */
export interface CoderRunInput {
  readonly task: TaskContext;
  readonly agent: AgentDefinition;
  readonly apiKey: SecretRef;
  readonly incoming: AgentMessage;
  readonly reviewerAgentId: AgentId;
  readonly artifactId?: string;
  readonly timeoutMs?: number;
}

/**
 * Result of {@link CoderAgent.run}.
 *
 * `outgoing` is the persisted Agent_Message routed to the Reviewer;
 * `coded` is the structured payload extracted from it for convenience.
 * `recipient` is the routed downstream agent id.
 *
 * `persistenceLatencyMs` mirrors the field {@link AgentRunner} exposes
 * so callers can verify the 500 ms persistence budget from
 * Requirement 10.6.
 */
export interface CoderRunResult {
  readonly outgoing: AgentMessage;
  readonly coded: CodedArtifactPayload;
  readonly recipient: AgentId;
  readonly persistenceLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Coder Builtin_Agent.
 *
 * Stateless beyond its dependencies — safe to share across concurrent
 * task pipelines. The class deliberately keeps adapter-output coercion
 * local: the orchestrator does not need to know how the model's raw
 * response gets turned into an artifact write.
 */
export class CoderAgent {
  private readonly modelAdapter: ModelAdapter;
  private readonly messageHistoryStore: MessageHistoryStore;
  private readonly artifactStore: ArtifactStoreInterface;
  private readonly traceBus: TraceEventBusInterface;
  private readonly clock: Clock;
  private readonly idGenerator: () => string;
  private readonly defaultFileName: string;
  private readonly defaultMimeType: string | undefined;

  public constructor(options: CoderAgentOptions) {
    this.modelAdapter = options.modelAdapter;
    this.messageHistoryStore = options.messageHistoryStore;
    this.artifactStore = options.artifactStore;
    this.traceBus = options.traceBus;
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
    this.defaultFileName = options.defaultFileName ?? "main.txt";
    this.defaultMimeType = options.defaultMimeType;
  }

  public async run(input: CoderRunInput): Promise<CoderRunResult> {
    validateInput(input);

    const taskId = input.task.id;
    const agentId = input.agent.id;

    await this.publishTrace(taskId, agentId, {
      kind: "status",
      status: "started",
      at: this.clock.nowIso(),
    });

    // Step 2: load bounded history.
    const history = await this.messageHistoryStore.list(taskId);
    const bounded = boundAgentHistory(history);

    const adapterOptions: ModelInvokeOptions = {
      systemPrompt: input.agent.systemPrompt,
      apiKey: input.apiKey,
      allowedTools: input.agent.allowedTools,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };

    const effectiveModel = input.agent.model ?? input.task.defaultModel;

    // Step 3: invoke the model.
    let raw: unknown;
    try {
      const result = await this.modelAdapter.invoke(
        effectiveModel,
        bounded,
        adapterOptions,
      );
      raw = result?.raw;
    } catch (err) {
      const reason = `Coder model invocation failed: ${describeError(err)}`;
      return this.failOut(input, reason);
    }

    // Step 4: extract the artifact content. Atomicity contract: we
    // refuse to write anything unless the model produced usable bytes.
    const extracted = extractCoderContent(raw, {
      defaultFileName: this.defaultFileName,
      defaultMimeType: this.defaultMimeType,
    });
    if (extracted === null) {
      const reason =
        "Coder model output did not contain usable artifact content; expected text or { content: string, fileName?: string }.";
      return this.failOut(input, reason);
    }

    // Step 5: atomically write the artifact (Requirement 7.4). The
    // store enforces append-only versioning and idempotent same-content
    // writes — this single call is the "single action without
    // intermediate states" the requirement demands.
    const artifactId = input.artifactId ?? this.idGenerator();
    const writtenVersion = await this.artifactStore.writeArtifact({
      taskId,
      artifactId,
      authoredByAgentId: agentId,
      bytes: utf8Encoder.encode(extracted.content),
      fileName: extracted.fileName,
      ...(extracted.mimeType !== undefined
        ? { mimeType: extracted.mimeType }
        : {}),
    });

    await this.publishTrace(taskId, agentId, {
      kind: "artifact_change",
      artifactId,
      version: writtenVersion.version,
      at: this.clock.nowIso(),
    });

    // Step 6: assemble the handoff payload.
    const coded: CodedArtifactPayload = {
      kind: "codedArtifact",
      artifactId,
      version: writtenVersion.version,
      fileName: extracted.fileName,
      contentHash: writtenVersion.contentHash,
      ...(extracted.mimeType !== undefined
        ? { mimeType: extracted.mimeType }
        : {}),
      ...(extracted.summary !== undefined ? { summary: extracted.summary } : {}),
    };

    const outgoing: AgentMessage = {
      taskId,
      sender: agentId,
      recipient: input.reviewerAgentId,
      type: "handoff",
      payload: { kind: "json", value: coded },
      timestamp: this.clock.nowIso(),
    };

    // Step 7: persist before handoff (Requirement 10.6).
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
      coded,
      recipient: input.reviewerAgentId,
      persistenceLatencyMs,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Build, persist and trace an error-flavoured outgoing Agent_Message
   * routed to the Reviewer. Used when the model fails before producing
   * any output or its output cannot be turned into artifact content.
   *
   * Atomicity guarantee: this path NEVER calls
   * `ArtifactStore.writeArtifact`, so the artifact store is
   * unaffected by a Coder failure (Requirement 7.4: no intermediate
   * states visible to other agents).
   */
  private async failOut(
    input: CoderRunInput,
    reason: string,
  ): Promise<CoderRunResult> {
    const taskId = input.task.id;
    const agentId = input.agent.id;
    const placeholderArtifactId = input.artifactId ?? this.idGenerator();

    const coded: CodedArtifactPayload = {
      kind: "codedArtifact",
      artifactId: placeholderArtifactId,
      version: 0,
      fileName: this.defaultFileName,
      contentHash: "",
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
      coded,
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

interface ExtractCoderContentOptions {
  readonly defaultFileName: string;
  readonly defaultMimeType: string | undefined;
}

interface ExtractedCoderContent {
  readonly content: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly summary?: string;
}

/**
 * Pull the new artifact's content out of the model's raw response.
 *
 * Accepted shapes:
 *
 *   • `string`                                          → content only,
 *     uses default file name and MIME type.
 *   • `Uint8Array`                                      → decoded as UTF-8.
 *   • `{ content: string, fileName?: string,            → unwrapped fully.
 *       mimeType?: string, summary?: string }`
 *   • `{ text:    string, ... }`                        → same as above.
 *   • `{ bytes: Uint8Array, ... }`                      → bytes decoded as UTF-8.
 *
 * Anything else returns null so the Coder falls back to the error path.
 */
function extractCoderContent(
  raw: unknown,
  options: ExtractCoderContentOptions,
): ExtractedCoderContent | null {
  if (typeof raw === "string") {
    return {
      content: raw,
      fileName: options.defaultFileName,
      ...(options.defaultMimeType !== undefined
        ? { mimeType: options.defaultMimeType }
        : {}),
    };
  }
  if (raw instanceof Uint8Array) {
    return {
      content: utf8Decoder.decode(raw),
      fileName: options.defaultFileName,
      ...(options.defaultMimeType !== undefined
        ? { mimeType: options.defaultMimeType }
        : {}),
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;

  // Unwrap a single-key { raw: "..." } container some adapters wrap
  // outputs in.
  if (typeof obj.raw === "string" && Object.keys(obj).length === 1) {
    return {
      content: obj.raw,
      fileName: options.defaultFileName,
      ...(options.defaultMimeType !== undefined
        ? { mimeType: options.defaultMimeType }
        : {}),
    };
  }

  let content: string | null = null;
  if (typeof obj.content === "string") {
    content = obj.content;
  } else if (typeof obj.text === "string") {
    content = obj.text;
  } else if (typeof obj.code === "string") {
    content = obj.code;
  } else if (obj.bytes instanceof Uint8Array) {
    content = utf8Decoder.decode(obj.bytes);
  }
  if (content === null) return null;

  const fileName =
    typeof obj.fileName === "string" && obj.fileName.trim().length > 0
      ? obj.fileName
      : options.defaultFileName;
  const summary =
    typeof obj.summary === "string" && obj.summary.trim().length > 0
      ? obj.summary
      : undefined;
  const mimeType =
    typeof obj.mimeType === "string" && obj.mimeType.trim().length > 0
      ? obj.mimeType
      : options.defaultMimeType;
  return {
    content,
    fileName,
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

function validateInput(input: CoderRunInput): void {
  assertNonEmptyString(input.task.id, "task.id");
  assertNonEmptyString(input.agent.id, "agent.id");
  assertNonEmptyString(input.agent.systemPrompt, "agent.systemPrompt");
  assertNonEmptyString(input.reviewerAgentId, "reviewerAgentId");
  if (input.artifactId !== undefined) {
    assertNonEmptyString(input.artifactId, "artifactId");
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `CoderAgent.run: ${field} must be a non-empty string`,
    );
  }
}

// Re-export the persistence budget from the runtime so callers and
// tests can import it from this module.
export const CODER_PERSISTENCE_BUDGET_MS = AGENT_PERSISTENCE_BUDGET_MS;
