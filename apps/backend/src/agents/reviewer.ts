/**
 * Reviewer builtin agent (task 14.3).
 *
 * Sources:
 * - design.md → "Agent Runtime" → "Builtin agent permissions" — Reviewer
 *   has access to `web_search`, `file_read` and `artifact_diff`.
 * - design.md → "Pipeline State Machine" / "Task Execution Flow" — the
 *   Reviewer reads the latest File_Artifact, returns a list of defects or
 *   an explicit no-defects confirmation, and the orchestrator routes
 *   handoff to Fixer or Boss accordingly.
 * - requirements.md →
 *     7.1 (the five Builtin_Agent roles),
 *     7.5 (Reviewer returns a list of defects or explicit no-defects
 *          confirmation),
 *     7.6 (Orchestrator hands the defects + current File_Artifact to the
 *          Fixer when the list is non-empty).
 *
 * Behaviour summary:
 *
 *   1. Emit a `status: "started"` trace event.
 *   2. Read the latest File_Artifact bytes through the Artifact Store
 *      (`file_read` tool) and emit one `tool_call` trace describing the
 *      read.
 *   3. Load the bounded conversation history (Requirement 10.7), append
 *      a synthetic in-memory message that carries the artifact content,
 *      and invoke the model adapter.
 *   4. Parse the raw model output as a Reviewer verdict — defects list
 *      or no-defects confirmation. If the output is malformed, fall
 *      back to a single critical "could not parse" defect so the
 *      pipeline never silently approves a broken artifact.
 *   5. Build the structured outgoing Agent_Message: `type: "handoff"`,
 *      `payload: { kind: "json", value: <ReviewerVerdictPayload> }`,
 *      and address it to the Fixer (defects found) or Boss (no defects)
 *      per the design's pipeline rules.
 *   6. Persist the outgoing Agent_Message before handoff (Requirement
 *      10.6) and emit a final `status: "finished"` (or `"error"`) trace
 *      event.
 *
 * The Reviewer never touches `file_write`. Calls to
 * `ArtifactStore.writeArtifact` from this module would violate the
 * Reviewer's permission table, so the agent only invokes the read path.
 *
 * Validates: Requirements 7.1, 7.5, 7.6.
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
import type {
  AgentMessage,
} from "@ai-agent-orchestrator/validation";
import type { AgentId } from "@ai-agent-orchestrator/shared-core";

import type {
  Defect,
  DefectSeverity,
  ReviewerVerdictPayload,
} from "./types.js";
import { StagingWorkspaceManager } from "../artifacts/staging.js";
import { ShellRunner, type ShellExecuteInput } from "../utils/shellRunner.js";
import { detectTestCommand, type DetectTestCommandInput } from "../utils/testCommandDetector.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ConsentDecision =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "overrideCommand"; command: string; args: readonly string[] }
  | { kind: "cancel" };

export class ConsentRequiredError extends Error {
  public readonly isConsentRequired = true;
  public readonly command: string;
  public readonly args: readonly string[];
  public readonly cwd: string;
  public readonly reason: string;

  constructor(options: { command: string; args: readonly string[]; cwd: string; reason: string }) {
    super(`User consent required for command: ${options.command} ${options.args.join(" ")}`);
    this.name = "ConsentRequiredError";
    this.command = options.command;
    this.args = options.args;
    this.cwd = options.cwd;
    this.reason = options.reason;
  }
}

// ---------------------------------------------------------------------------
// Clock injection (for deterministic tests)
// ---------------------------------------------------------------------------

export interface Clock {
  /** ISO 8601 UTC ms timestamp for the current moment. */
  nowIso(): string;
  /** Wall-clock milliseconds since the epoch — used to gauge persistence latency. */
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
 * Dependencies for {@link ReviewerAgent}.
 *
 * The Reviewer composes the same primitives the {@link AgentRunner} from
 * task 14.1 uses (`ModelAdapter`, `MessageHistoryStore`) plus the
 * Artifact Store and Trace Event Bus introduced in tasks 10/11. The
 * shared {@link Clock} hook lets unit tests freeze timestamps and
 * persistence-latency readings.
 *
 * `idGenerator` is invoked when the model output omits stable defect
 * ids; the default uses `crypto.randomUUID()`.
 */
export interface ReviewerAgentOptions {
  readonly modelAdapter: ModelAdapter;
  readonly messageHistoryStore: MessageHistoryStore;
  readonly artifactStore: ArtifactStoreInterface;
  readonly traceBus: TraceEventBusInterface;
  readonly clock?: Clock;
  readonly idGenerator?: () => string;
  readonly staging?: StagingWorkspaceManager;
  readonly shellRunner?: ShellRunner;
  readonly testCommand?: {
    readonly command: string;
    readonly args: readonly string[];
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  };
  readonly testCommandDetector?: typeof detectTestCommand;
  readonly allowAutoDetectedTestCommand?: boolean;
  readonly changedFileNames?: readonly string[];
}

/**
 * Input for {@link ReviewerAgent.run}.
 *
 * `incoming` is the handoff message that triggered the review. The
 * caller is responsible for having persisted it before calling `run` —
 * the Reviewer's contract is to persist the *outgoing* verdict.
 *
 * `artifactRef` points at the version the model should review. The
 * Reviewer always reads through {@link ArtifactStoreInterface.getArtifact}
 * so the model receives byte-accurate content, regardless of any
 * handoff payload mutations upstream.
 *
 * `fixerAgentId` and `bossAgentId` are the routing targets: defects →
 * Fixer, no defects → Boss (design.md → "Pipeline State Machine").
 */
export interface ReviewerRunInput {
  readonly task: TaskContext;
  readonly agent: AgentDefinition;
  readonly apiKey: SecretRef;
  readonly incoming: AgentMessage;
  readonly artifactRef: { readonly artifactId: string; readonly version: number };
  readonly fixerAgentId: AgentId;
  readonly bossAgentId: AgentId;
  /** Optional per-call timeout forwarded to the model adapter. */
  readonly timeoutMs?: number;
  /** Optional list of changed files, dynamically provided during task execution. */
  readonly changedFileNames?: readonly string[];
  /** Optional user consent decision on test command execution. */
  readonly consentDecision?: ConsentDecision;
}

/**
 * Result of {@link ReviewerAgent.run}.
 *
 * `outgoing` is the persisted Agent_Message routed to the Fixer or
 * Boss; `verdict` is the structured payload extracted from it for
 * convenience. `recipient` is the routed downstream agent id.
 *
 * `persistenceLatencyMs` mirrors the field {@link AgentRunner} exposes
 * so the orchestrator and tests can verify the 500 ms persistence
 * budget from Requirement 10.6.
 */
export interface ReviewerRunResult {
  readonly outgoing: AgentMessage;
  readonly verdict: ReviewerVerdictPayload;
  readonly recipient: AgentId;
  readonly persistenceLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Reviewer Builtin_Agent.
 *
 * Stateless beyond its dependencies — safe to share across concurrent
 * task pipelines. The class deliberately keeps the verdict-shaping
 * logic local: the orchestrator does not need to know how the model's
 * raw JSON gets coerced into a {@link ReviewerVerdictPayload}.
 */
export class ReviewerAgent {
  private readonly modelAdapter: ModelAdapter;
  private readonly messageHistoryStore: MessageHistoryStore;
  private readonly artifactStore: ArtifactStoreInterface;
  private readonly traceBus: TraceEventBusInterface;
  private readonly clock: Clock;
  private readonly idGenerator: () => string;
  private readonly staging: StagingWorkspaceManager | undefined;
  private readonly shellRunner: ShellRunner | undefined;
  private readonly testCommand: {
    readonly command: string;
    readonly args: readonly string[];
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  } | undefined;
  private readonly testCommandDetector: typeof detectTestCommand | undefined;
  private readonly allowAutoDetectedTestCommand: boolean | undefined;
  private readonly changedFileNames: readonly string[] | undefined;

  public constructor(options: ReviewerAgentOptions) {
    this.modelAdapter = options.modelAdapter;
    this.messageHistoryStore = options.messageHistoryStore;
    this.artifactStore = options.artifactStore;
    this.traceBus = options.traceBus;
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
    this.staging = options.staging;
    this.shellRunner = options.shellRunner;
    this.testCommand = options.testCommand;
    this.testCommandDetector = options.testCommandDetector;
    this.allowAutoDetectedTestCommand = options.allowAutoDetectedTestCommand;
    this.changedFileNames = options.changedFileNames;
  }

  public async run(input: ReviewerRunInput): Promise<ReviewerRunResult> {
    validateInput(input);

    const taskId = input.task.id;
    const agentId = input.agent.id;

    // Step 1: status:started.
    await this.publishTrace(taskId, agentId, {
      kind: "status",
      status: "started",
      at: this.clock.nowIso(),
    });

    // Step 2: read the artifact via the Artifact Store. A missing
    // artifact is an unrecoverable input error — emit an error verdict
    // so the orchestrator can react, and short-circuit before invoking
    // the model.
    const content = await this.artifactStore.getArtifact({
      taskId,
      artifactId: input.artifactRef.artifactId,
      version: input.artifactRef.version,
    });

    if (content === null) {
      const reason = `Reviewer could not load artifact ${input.artifactRef.artifactId}@v${input.artifactRef.version}`;
      return this.failOut(input, reason);
    }

    // Emit the file_read tool_call trace AFTER the read succeeds so the
    // recorded `output` reflects what the agent actually saw.
    await this.publishTrace(taskId, agentId, {
      kind: "tool_call",
      tool: "file_read",
      input: {
        artifactId: input.artifactRef.artifactId,
        version: input.artifactRef.version,
      },
      output: {
        version: content.version,
        contentHash: content.contentHash,
        byteLength: content.bytes.byteLength,
      },
      at: this.clock.nowIso(),
    });

    // Step 3: execute tests if staging, shellRunner and testCommand are available (or auto-detected)
    let testResultsContext = "";
    let activeTestCommand = this.testCommand;
    let autoDetectContext = "";

    const limitString = (str: string, limit = 4096) => {
      return str.length > limit ? str.slice(0, limit) + "... [truncated]" : str;
    };

    if (input.consentDecision && input.consentDecision.kind === "reject") {
      await this.publishTrace(taskId, agentId, {
        kind: "thought",
        text: `[reviewer] test command execution was rejected by user; performing static review only`,
        at: this.clock.nowIso(),
      });
      testResultsContext = "<test_command_rejected_by_user />";
    } else {
      if (input.consentDecision && input.consentDecision.kind === "overrideCommand") {
        activeTestCommand = {
          command: input.consentDecision.command,
          args: input.consentDecision.args,
        };
      }

      if (!activeTestCommand && this.staging && this.shellRunner && this.testCommandDetector) {
        try {
          const stagingCwd = this.staging.getStagingRoot(taskId);
          const changedFiles = input.changedFileNames
            ? [...input.changedFileNames]
            : (this.changedFileNames ? [...this.changedFileNames] : []);
          const detectInput: DetectTestCommandInput = {
            cwd: stagingCwd,
            changedFileNames: changedFiles,
          };
          if (this.allowAutoDetectedTestCommand !== undefined) {
            detectInput.allowPackageScripts = this.allowAutoDetectedTestCommand;
          }
          const detectResult = await this.testCommandDetector(detectInput);

          if (detectResult.kind === "detected") {
            const hasApprove = input.consentDecision && input.consentDecision.kind === "approve";
            if (detectResult.requiresConsent && !hasApprove) {
              await this.publishTrace(taskId, agentId, {
                kind: "thought",
                text: `[reviewer] command detected but requires consent: ${detectResult.command} ${detectResult.args.join(" ")} (reason: User consent required)`,
                at: this.clock.nowIso(),
              });
              throw new ConsentRequiredError({
                command: detectResult.command,
                args: detectResult.args,
                cwd: stagingCwd,
                reason: "User consent required",
              });
            } else {
              activeTestCommand = {
                command: detectResult.command,
                args: detectResult.args,
              };
            }
          } else if (detectResult.kind === "blocked") {
            await this.publishTrace(taskId, agentId, {
              kind: "thought",
              text: `[reviewer] command blocked: ${detectResult.reason}`,
              at: this.clock.nowIso(),
            });
            autoDetectContext = `<test_command_blocked>\n` +
              `Reason: ${detectResult.reason}\n` +
              `</test_command_blocked>`;
          } else if (detectResult.kind === "not_found") {
            autoDetectContext = "No test command detected";
          }
        } catch (err: any) {
          if (err instanceof ConsentRequiredError) {
            throw err;
          }
          await this.publishTrace(taskId, agentId, {
            kind: "thought",
            text: `[reviewer] test execution infrastructure error: ${err.message || String(err)}`,
            at: this.clock.nowIso(),
          });
          autoDetectContext = `<test_execution_results>\n` +
            `Test execution infrastructure error: ${err.message || String(err)}\n` +
            `</test_execution_results>`;
        }
      }

      if (autoDetectContext) {
        testResultsContext = autoDetectContext;
      }

      if (activeTestCommand && this.staging && this.shellRunner) {
        try {
          const stagingCwd = this.staging.getStagingRoot(taskId);
          const { command, args, timeoutMs = 20000, maxOutputBytes } = activeTestCommand;

          const shellInput: ShellExecuteInput = {
            command,
            args: [...args],
            cwd: stagingCwd,
            timeoutMs,
          };
          if (maxOutputBytes !== undefined) {
            shellInput.maxOutputBytes = maxOutputBytes;
          }
          const shellResult = await this.shellRunner.execute(shellInput);

          // Write debug log to staging
          try {
            const logDir = path.join(stagingCwd, ".karo");
            await fs.mkdir(logDir, { recursive: true });
            const logData = {
              command,
              args,
              cwd: stagingCwd,
              exitCode: shellResult.exitCode,
              timedOut: shellResult.timedOut,
              stdout: shellResult.stdout,
              stderr: shellResult.stderr,
              timestamp: this.clock.nowIso(),
            };
            await fs.writeFile(
              path.join(logDir, "test-run.log"),
              JSON.stringify(logData, null, 2),
              "utf-8"
            );
          } catch (logErr) {
            // Ignore log writing errors to keep review working
          }

          const formattedArgs = args.join(" ");
          const exitCodeText = shellResult.exitCode !== null ? String(shellResult.exitCode) : "null";
          const timedOutText = String(shellResult.timedOut);

          testResultsContext = `<test_execution_results>\n` +
            `Command: ${command}\n` +
            `Args: ${formattedArgs}\n` +
            `Cwd: ${stagingCwd}\n` +
            `Exit Code: ${exitCodeText}\n` +
            `Timed Out: ${timedOutText}\n\n` +
            `Stdout:\n` +
            `---\n` +
            `${shellResult.stdout}\n` +
            `---\n\n` +
            `Stderr:\n` +
            `---\n` +
            `${shellResult.stderr}\n` +
            `---\n` +
            `</test_execution_results>`;

          if (shellResult.timedOut) {
            testResultsContext += `\n\nTest execution timed out`;
          }

          // Publish rich trace events
          const testOutcome = shellResult.timedOut
            ? "timed out"
            : shellResult.exitCode === 0
              ? "passed"
              : `failed (exitCode: ${shellResult.exitCode})`;

          await this.publishTrace(taskId, agentId, {
            kind: "thought",
            text: `[reviewer] tests ${testOutcome}. command: ${command} ${formattedArgs}\n` +
              `stdout: ${limitString(shellResult.stdout)}\n` +
              `stderr: ${limitString(shellResult.stderr)}`,
            at: this.clock.nowIso(),
          });
        } catch (err: any) {
          await this.publishTrace(taskId, agentId, {
            kind: "thought",
            text: `[reviewer] test execution infrastructure error: ${err.message || String(err)}`,
            at: this.clock.nowIso(),
          });
          testResultsContext = `<test_execution_results>\n` +
            `Test execution infrastructure error: ${err.message || String(err)}\n` +
            `</test_execution_results>`;
        }
      }
    }

    // Step 4: load bounded history and feed the artifact body to the
    // model through a synthetic in-memory message. The synthetic
    // message is NOT persisted — only real Agent_Messages live in the
    // history store.
    const history = await this.messageHistoryStore.list(taskId);
    const bounded = boundAgentHistory(history);
    const augmentedHistory: readonly AgentMessage[] = [
      ...bounded,
      this.buildArtifactContextMessage(input, content, testResultsContext),
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
      const reason = `Reviewer model invocation failed: ${describeError(err)}`;
      return this.failOut(input, reason);
    }

    // Step 5: parse the model's output into a verdict. On unparseable
    // output we fall back to a defectsFound payload so the pipeline
    // does NOT inadvertently route a broken artifact straight to Boss.
    const verdict = this.parseVerdict(raw, input);

    // Step 6: route handoff per the pipeline rules.
    const recipient =
      verdict.kind === "defectsFound" ? input.fixerAgentId : input.bossAgentId;

    const outgoing: AgentMessage = {
      taskId,
      sender: agentId,
      recipient,
      type: "handoff",
      payload: { kind: "json", value: verdict },
      timestamp: this.clock.nowIso(),
    };

    // Step 7: persist before handoff and measure latency
    // (Requirement 10.6).
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
      verdict,
      recipient,
      persistenceLatencyMs,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Build the synthetic Agent_Message that carries the artifact body
   * into the model's prompt context.
   *
   * The message is shaped like a real `request` from the orchestrator
   * to the agent so the model adapter sees an unambiguous "here is the
   * artifact" turn. It is intentionally NOT persisted: production
   * history must reflect only real inter-agent traffic, not the
   * agent's per-call context window.
   */
  private buildArtifactContextMessage(
    input: ReviewerRunInput,
    content: { fileName: string; version: number; bytes: Uint8Array },
    testResultsContext?: string,
  ): AgentMessage {
    const text = decodeContent(content.bytes);
    let promptText = `Artifact under review: ${content.fileName} (version ${content.version}).\n` +
      `<artifact>\n${text}\n</artifact>`;

    if (testResultsContext) {
      promptText += `\n\n${testResultsContext}`;
    }

    return {
      taskId: input.task.id,
      sender: "orchestrator",
      recipient: input.agent.id,
      type: "request",
      payload: {
        kind: "text",
        text: promptText,
      },
      timestamp: this.clock.nowIso(),
    };
  }

  /**
   * Coerce raw model output into a {@link ReviewerVerdictPayload}.
   *
   * Accepted shapes:
   *
   *   • `{ defects: [...], summary?: string }` — defects array drives
   *     the discriminator: empty → noDefects, non-empty → defectsFound.
   *   • `{ kind: "defectsFound", defects: [...] }` / `{ kind: "noDefects" }`
   *     — explicit discriminator from the adapter.
   *   • A JSON string carrying either of the above.
   *
   * Any other shape (or an unparseable string) collapses to a single
   * critical defect so the orchestrator keeps the artifact in the
   * Reviewer→Fixer loop until it sees a structurally valid response.
   */
  private parseVerdict(
    raw: unknown,
    input: ReviewerRunInput,
  ): ReviewerVerdictPayload {
    const value = unwrapJsonString(raw);
    const baseRef = {
      artifactId: input.artifactRef.artifactId,
      artifactVersion: input.artifactRef.version,
    };

    if (isObject(value)) {
      const summary =
        typeof value.summary === "string" ? value.summary : undefined;

      // Explicit discriminator wins.
      if (value.kind === "noDefects") {
        return {
          kind: "noDefects",
          ...baseRef,
          ...(summary !== undefined ? { summary } : {}),
        };
      }
      if (value.kind === "defectsFound" || Array.isArray(value.defects)) {
        const rawDefects = Array.isArray(value.defects)
          ? value.defects
          : [];
        const normalised = rawDefects
          .map((d) => this.normaliseDefect(d))
          .filter((d): d is Defect => d !== null);
        if (normalised.length === 0) {
          // An empty `defects` array is the canonical no-defects shape.
          return {
            kind: "noDefects",
            ...baseRef,
            ...(summary !== undefined ? { summary } : {}),
          };
        }
        return {
          kind: "defectsFound",
          defects: normalised,
          ...baseRef,
          ...(summary !== undefined ? { summary } : {}),
        };
      }
    }

    // Fallback: treat unparseable output as a critical structural defect.
    return {
      kind: "defectsFound",
      defects: [
        {
          id: this.idGenerator(),
          description:
            "Reviewer model output could not be parsed as a verdict; treat as defective until reviewer produces structured output.",
          severity: "critical",
        },
      ],
      ...baseRef,
    };
  }

  /**
   * Coerce one raw defect entry into a {@link Defect}.
   *
   * Accepts strings (treated as `description`) and objects with
   * `description` / `severity` / `id` / `location` keys. Returns null
   * when the entry has no usable description so the verdict does not
   * fill up with empty placeholders.
   */
  private normaliseDefect(raw: unknown): Defect | null {
    if (typeof raw === "string") {
      const description = raw.trim();
      if (description.length === 0) return null;
      return {
        id: this.idGenerator(),
        description,
        severity: "medium",
      };
    }
    if (!isObject(raw)) return null;
    const description =
      typeof raw.description === "string" && raw.description.trim().length > 0
        ? raw.description
        : typeof raw.message === "string" && raw.message.trim().length > 0
          ? raw.message
          : null;
    if (description === null) return null;

    const severity: DefectSeverity = isSeverity(raw.severity)
      ? raw.severity
      : "medium";
    const id =
      typeof raw.id === "string" && raw.id.trim().length > 0
        ? raw.id
        : this.idGenerator();
    const location =
      typeof raw.location === "string" && raw.location.trim().length > 0
        ? raw.location
        : undefined;
    return {
      id,
      description,
      severity,
      ...(location !== undefined ? { location } : {}),
    };
  }

  /**
   * Build, persist and trace an error-flavoured outgoing Agent_Message
   * routed to the Fixer (the conservative target — keep the artifact
   * in the correction loop). Used when the artifact cannot be read or
   * the model adapter fails before producing any output.
   */
  private async failOut(
    input: ReviewerRunInput,
    reason: string,
  ): Promise<ReviewerRunResult> {
    const taskId = input.task.id;
    const agentId = input.agent.id;
    const verdict: ReviewerVerdictPayload = {
      kind: "defectsFound",
      defects: [
        {
          id: this.idGenerator(),
          description: reason,
          severity: "critical",
        },
      ],
      artifactId: input.artifactRef.artifactId,
      artifactVersion: input.artifactRef.version,
    };

    const outgoing: AgentMessage = {
      taskId,
      sender: agentId,
      recipient: input.fixerAgentId,
      type: "error",
      payload: { kind: "json", value: verdict },
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
      verdict,
      recipient: input.fixerAgentId,
      persistenceLatencyMs,
    };
  }

  /**
   * Publish a trace event without letting bus failures crash the
   * agent. Mirrors the `onTraceError` discipline used by
   * `TracedWebSearchTool`.
   */
  private async publishTrace(
    taskId: string,
    agentId: AgentId,
    record: Parameters<TraceEventBusInterface["publish"]>[0]["record"],
  ): Promise<void> {
    try {
      await this.traceBus.publish({ taskId, agentId, record });
    } catch {
      // Trace failures must never alter the agent's verdict (design.md
      // → "Trace delays" / "Trace Event Bus" → "Rules"). Swallowing here
      // matches `TracedWebSearchTool.onTraceError`'s default.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function decodeContent(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message =
      err.message.length > 256 ? `${err.message.slice(0, 256)}…` : err.message;
    return `${err.name}: ${message}`;
  }
  return "unknown error";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeverity(value: unknown): value is DefectSeverity {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "critical"
  );
}

/**
 * Some adapters return a JSON string instead of a parsed object. Try
 * once to unwrap it; on failure return the original value so the
 * caller's structural checks still see something to inspect.
 */
function unwrapJsonString(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function validateInput(input: ReviewerRunInput): void {
  assertNonEmptyString(input.task.id, "task.id");
  assertNonEmptyString(input.agent.id, "agent.id");
  assertNonEmptyString(input.agent.systemPrompt, "agent.systemPrompt");
  assertNonEmptyString(input.fixerAgentId, "fixerAgentId");
  assertNonEmptyString(input.bossAgentId, "bossAgentId");
  assertNonEmptyString(input.artifactRef.artifactId, "artifactRef.artifactId");
  if (
    !Number.isInteger(input.artifactRef.version) ||
    input.artifactRef.version < 1
  ) {
    throw new TypeError(
      "ReviewerAgent.run: artifactRef.version must be a positive integer",
    );
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `ReviewerAgent.run: ${field} must be a non-empty string`,
    );
  }
}

// Mark the persistence budget as referenced from the public API so the
// unused-import lint rule allows the import — tests assert against it.
export const REVIEWER_PERSISTENCE_BUDGET_MS = AGENT_PERSISTENCE_BUDGET_MS;
