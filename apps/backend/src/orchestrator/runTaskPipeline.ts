/**
 * End-to-end pipeline driver (task 15.1).
 *
 * Connects the five Builtin_Agents through the {@link applyEvent}-driven
 * `TaskState` machine so that the orchestrator can take a freshly-created
 * `TaskState` (via task 8.2's `Orchestrator.createTask`) and drive it
 * through the canonical pipeline:
 *
 *   Researcher → Coder → Reviewer → (Fixer → Reviewer)* → Boss
 *
 * Sources:
 *  - design.md → "Pipeline State Machine" / "Task Execution Flow".
 *  - design.md → "Pipeline rules" / "Review cycle definition".
 *  - requirements.md →
 *      7.1  (the five Builtin_Agent roles, exclusive responsibilities),
 *      8.1  (canonical pipeline order),
 *      8.2  (Reviewer→Fixer routing on defects),
 *      8.3  (Boss "не соответствует" → Fixer feedback loop),
 *      8.4  (Fixer feedback re-routes through Reviewer before Boss),
 *      8.7  (`completed` on Boss approval).
 *  - tasks.md task 15.1 sub-bullets.
 *
 * Behaviour summary:
 *  1. Persist the orchestrator → Researcher handoff (carrying the user's
 *     original prompt) so the Researcher's bounded history view contains
 *     the prompt — Requirement 10.6.
 *  2. Emit a single orchestrator-level `status: "started"` trace event on
 *     pipeline entry (Requirement 11.2).
 *  3. Loop, dispatching on `state.status`:
 *       • `created`     → emit `start`       → enter `researching`.
 *       • `researching` → run Researcher     → emit `prompt_enriched`.
 *       • `coding`      → run Coder          → emit `code_produced`,
 *                                              recording the new artifact.
 *       • `reviewing`   → run Reviewer       → emit `defects_found` or
 *                                              `defects_empty`.
 *       • `fixing`      → run Fixer          → emit `defects_fixed`,
 *                                              record the new artifact.
 *       • `boss_eval`   → run Boss           → emit `boss_approved` or
 *                                              `boss_rejected`.
 *  4. Persist the updated `TaskState` after every successful transition
 *     so external consumers see the live status.
 *  5. Emit orchestrator-level `thought` trace records for each transition
 *     so the Agent_Trace UI panel surfaces a per-step audit trail without
 *     duplicating the agents' own status events.
 *  6. Honour the cycle bound and Boss-approval guards encoded in the
 *     state machine. The driver never increments `reviewCycles` itself —
 *     `applyEvent` does — so the cap from Requirement 8.5 is respected
 *     by construction.
 *
 * Atomicity guarantees:
 *  • Agent runners ({@link ResearcherAgent} et al.) are responsible for
 *    persisting their own outgoing Agent_Messages before handoff
 *    (Requirement 10.6) and writing artifact versions atomically
 *    (Requirements 7.4 / 7.7). The driver does not duplicate that work.
 *  • The driver only persists messages it authors itself: the initial
 *    orchestrator → Researcher handoff and any synthetic error message
 *    it emits when an agent fails.
 *
 * Out of scope (handled by later tasks):
 *  • Final_Report assembly — task 15.2 builds it on top of the result
 *    returned here.
 *  • SSE streaming of trace events — task 11.2 already exposes the
 *    streaming endpoint; the driver only publishes through the bus.
 *  • Auto/Manual participant resolution — `Orchestrator.createTask`
 *    (task 8.2) and the resolver port own that selection; the driver
 *    accepts the resolved {@link AgentDefinition}s as input.
 *
 * Validates: Requirements 7.1, 8.1, 8.2, 8.3, 8.4, 8.7.
 */

import type {
  AgentMessage,
  FileArtifactMetadata,
  FinalReport,
} from "@ai-agent-orchestrator/validation";
import type {
  AgentId,
  ModelRef,
} from "@ai-agent-orchestrator/shared-core";

import type {
  AgentDefinition,
  MessageHistoryStore,
  SecretRef,
} from "../agentRuntime/index.js";
import type { ArtifactStoreInterface } from "../artifacts/index.js";
import { StagingWorkspaceManager } from "../artifacts/index.js";
import type { TraceEventBusInterface } from "../trace/index.js";

import type {
  BossAgent,
  BossVerdict,
  CoderAgent,
  Defect,
  FixerAgent,
  ReviewerAgent,
  ReviewerRunInput,
  ResearcherAgent,
  ConsentDecision,
} from "../agents/index.js";
import { ConsentRequiredError } from "../agents/index.js";
import type { ConsentRequest } from "@ai-agent-orchestrator/agent-contracts";

import { buildFinalReport } from "./finalReport.js";
import type { TaskHistoryStore } from "./finalReport.js";
import { applyEvent } from "./reviewCycle.js";
import type { TaskState, TaskStatus } from "./stateMachine.js";
import type { TaskStateStore } from "./createTask.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Bundled (definition, runner) pair for a single role. The driver does
 * not enforce any naming convention — the supplied
 * {@link AgentDefinition.id} is used verbatim as `sender` / `recipient`
 * on emitted Agent_Messages, so tests and production wiring can use
 * either the canonical builtin id (e.g. `"researcher"`) or a Custom_Agent
 * id without changes.
 */
export interface ResearcherParticipant {
  readonly agent: AgentDefinition;
  readonly runner: ResearcherAgent;
}
export interface CoderParticipant {
  readonly agent: AgentDefinition;
  readonly runner: CoderAgent;
}
export interface ReviewerParticipant {
  readonly agent: AgentDefinition;
  readonly runner: ReviewerAgent;
}
export interface FixerParticipant {
  readonly agent: AgentDefinition;
  readonly runner: FixerAgent;
}
export interface BossParticipant {
  readonly agent: AgentDefinition;
  readonly runner: BossAgent;
}

export interface PipelineParticipants {
  readonly researcher: ResearcherParticipant;
  readonly coder: CoderParticipant;
  readonly reviewer: ReviewerParticipant;
  readonly fixer: FixerParticipant;
  readonly boss: BossParticipant;
}

/** Optional clock dependency, primarily for deterministic tests. */
export interface PipelineClock {
  /** ISO 8601 UTC ms timestamp for the current moment. */
  nowIso(): string;
}

const systemClock: PipelineClock = {
  nowIso: () => new Date().toISOString(),
};

/**
 * Constructor options for {@link TaskPipeline}. The driver does not own
 * any storage backends or agents itself — it composes them. Production
 * wiring builds these once at backend boot and reuses the same
 * {@link TaskPipeline} instance across concurrent task runs (the driver
 * is stateless beyond its dependencies).
 *
 * `artifactStore` and `taskHistoryStore` are optional — when both are
 * supplied (and an `originalPrompt` reaches a terminal state), the
 * driver assembles a {@link FinalReport} via {@link buildFinalReport}
 * and persists it through `taskHistoryStore.save` (task 15.2).
 * Omitting either dependency keeps the driver behaving exactly as task
 * 15.1 specified — useful for the existing pipeline integration tests
 * that predate the Final_Report wiring.
 */
export interface TaskPipelineOptions {
  readonly store: TaskStateStore;
  readonly messageHistoryStore: MessageHistoryStore;
  readonly traceBus: TraceEventBusInterface;
  readonly participants: PipelineParticipants;
  readonly clock?: PipelineClock;
  /**
   * Read-only port the driver consults to enumerate the artifacts that
   * survived the run when assembling a Final_Report. Only the
   * `listArtifacts(taskId)` method is invoked, so a partial stub is
   * acceptable in tests.
   */
  readonly artifactStore?: Pick<ArtifactStoreInterface, "listArtifacts">;
  /**
   * Persistence target for assembled Final_Reports. Required for
   * Task History (Requirement 14.5); when omitted, the report is still
   * returned on {@link RunTaskPipelineResult.finalReport} but never
   * saved.
   */
  readonly taskHistoryStore?: TaskHistoryStore;
  /**
   * Optional staging workspace manager.
   */
  readonly staging?: StagingWorkspaceManager;
}

/**
 * Input for a single pipeline run.
 *
 * `state` is the freshly-persisted {@link TaskState} returned by
 * `Orchestrator.createTask`. `prompt` is the user's original prompt —
 * carried separately from the state because `TaskState` does not embed
 * the prompt today (task 8.2 leaves prompt persistence to a future
 * extension). `apiKey` is the resolved server-side
 * {@link SecretRef} for the chosen Provider; the driver never sees the
 * decrypted secret directly. `defaultModel` is forwarded as the
 * `TaskContext.defaultModel` to every agent run, honouring
 * Requirement 5.4 (selected Model is the Task default unless an agent
 * pins its own).
 *
 * `participants` is the resolved Auto/Manual selection
 * (`Orchestrator.createTask` builds this list and passes it through).
 * It MUST be non-empty when supplied — `Final_Report.participants` is a
 * non-empty array per the validation schema. When omitted, the driver
 * falls back to the five canonical builtin agent ids in pipeline order
 * (`researcher`, `coder`, `reviewer`, `fixer`, `boss` — keyed by the
 * supplied {@link AgentDefinition}s).
 */
export interface RunTaskPipelineInput {
  readonly state: TaskState;
  readonly prompt: string;
  readonly apiKey: SecretRef;
  readonly defaultModel: ModelRef;
  readonly participants?: readonly AgentId[];
  readonly consentDecision?: ConsentDecision;
}

export const activeConsentRequests = new Map<string, ConsentRequest>();

/**
 * Result of a pipeline run. `finalState` is the persisted terminal
 * state — `completed`, `stopped_limit`, or `error`. Callers that need
 * the bounded message history or artifact list can read them through
 * the same backends they passed in (`messageHistoryStore.list`,
 * `artifactStore.listArtifacts`).
 *
 * `currentArtifactId` / `currentArtifactVersion` reference the most
 * recent artifact written during the run. They are the input to the
 * Final_Report builder (task 15.2). When the pipeline never reached
 * the Coder stage successfully (e.g. the Researcher errored) both
 * fields are `null`.
 *
 * `finalReport` is populated when the run reaches a terminal status
 * supported by the Final_Report schema (`completed` or `stopped_limit`)
 * AND the caller supplied an `artifactStore`. The driver also persists
 * the report via {@link TaskHistoryStore.save} when a `taskHistoryStore`
 * is supplied. For `error` outcomes — a runtime failure that the design
 * does not surface as a Final_Report status — this field stays `null`.
 */
export interface RunTaskPipelineResult {
  readonly finalState: TaskState;
  readonly currentArtifactId: string | null;
  readonly currentArtifactVersion: number | null;
  readonly finalReport: FinalReport | null;
}

/** Identifier used when the orchestrator itself emits trace records. */
export const ORCHESTRATOR_AGENT_ID: AgentId = "orchestrator";

/**
 * Soft cap on the number of agent invocations the driver is willing to
 * perform within a single `runTask` call. The state machine's cycle
 * bound (`maxReviewCycles`) provides the primary protection against
 * runaway pipelines, but the driver's outer loop also bounds itself
 * defensively in case a future state machine extension introduces a
 * silent loop. The cap is intentionally generous — for the canonical
 * pipeline at the documented `maxReviewCycles = 5` we make
 * roughly `1 + 1 + 1 + (1 + 1) * 5 + 1 = 14` agent invocations, so
 * `64` provides plenty of headroom.
 */
const PIPELINE_MAX_TURNS = 64;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * `TaskPipeline` — composes the orchestrator state machine with the five
 * Builtin_Agent roles. Stateless beyond its constructor dependencies;
 * safe to share across concurrent task runs as long as the underlying
 * stores and agents are themselves concurrency-safe.
 */
export class TaskPipeline {
  private readonly store: TaskStateStore;
  private readonly messageHistoryStore: MessageHistoryStore;
  private readonly traceBus: TraceEventBusInterface;
  private readonly participants: PipelineParticipants;
  private readonly clock: PipelineClock;
  private readonly artifactStore?: Pick<ArtifactStoreInterface, "listArtifacts">;
  private readonly taskHistoryStore?: TaskHistoryStore;
  private readonly staging: StagingWorkspaceManager | undefined;

  public constructor(options: TaskPipelineOptions) {
    this.store = options.store;
    this.messageHistoryStore = options.messageHistoryStore;
    this.traceBus = options.traceBus;
    this.participants = options.participants;
    this.clock = options.clock ?? systemClock;
    if (options.artifactStore !== undefined) {
      this.artifactStore = options.artifactStore;
    }
    if (options.taskHistoryStore !== undefined) {
      this.taskHistoryStore = options.taskHistoryStore;
    }
    this.staging = options.staging;
  }

  /**
   * Drive `input.state` through the canonical pipeline until it reaches
   * a terminal status (`completed`, `stopped_limit`, or `error`).
   *
   * The method returns even on terminal failure — it never throws on
   * agent or state-machine errors. Programmer errors (empty prompt,
   * malformed input) still throw; the typical orchestrator caller
   * treats the result's `finalState.status` as the pipeline outcome.
   */
  public async runTask(
    input: RunTaskPipelineInput,
  ): Promise<RunTaskPipelineResult> {
    validateInput(input);

    const taskId = input.state.id;
    let state = input.state;

    if (this.staging !== undefined && input.state.status === "created") {
      try {
        await this.staging.initializeWorkspace(taskId);
      } catch (err) {
        state = await this.transitionAndPersist(state, {
          kind: "error",
          reason: `Staging workspace initialization failed: ${describeError(err)}`,
        });
        await this.publishOrchestratorTrace(taskId, {
          kind: "status",
          status: "error",
          at: this.clock.nowIso(),
        });
        return {
          finalState: state,
          currentArtifactId: null,
          currentArtifactVersion: null,
          finalReport: null,
        };
      }
    }

    let lastMessage: AgentMessage;
    let currentArtifact: { artifactId: string; version: number } | null = null;

    if (input.state.status === "created") {
      // 1. Persist the orchestrator → Researcher handoff. The Researcher
      //    derives `originalPrompt` by inspecting the bounded history,
      //    so this message both seeds the prompt and provides a stable
      //    audit-trail entry.
      const initialMessage: AgentMessage = {
        taskId,
        sender: ORCHESTRATOR_AGENT_ID,
        recipient: this.participants.researcher.agent.id,
        type: "handoff",
        payload: { kind: "text", text: input.prompt },
        timestamp: this.clock.nowIso(),
      };
      await this.messageHistoryStore.append(taskId, initialMessage);

      // 2. Orchestrator-level "started" status event (Requirement 11.2).
      await this.publishOrchestratorTrace(taskId, {
        kind: "status",
        status: "started",
        at: this.clock.nowIso(),
      });

      lastMessage = initialMessage;
    } else {
      // Resume logic: load last message and current artifact
      const history = await this.messageHistoryStore.list(taskId);
      if (history.length > 0) {
        lastMessage = history[history.length - 1]!;
      } else {
        lastMessage = {
          taskId,
          sender: ORCHESTRATOR_AGENT_ID,
          recipient: this.participants.researcher.agent.id,
          type: "handoff",
          payload: { kind: "text", text: input.prompt || "" },
          timestamp: this.clock.nowIso(),
        };
      }

      if (this.artifactStore !== undefined) {
        try {
          const artifacts = await this.artifactStore.listArtifacts(taskId);
          if (artifacts.length > 0) {
            const firstArtifact = artifacts[0]!;
            let maxVer = -1;
            let bestArt = firstArtifact;
            for (const art of artifacts) {
              if (art.latestVersion > maxVer) {
                maxVer = art.latestVersion;
                bestArt = art;
              }
            }
            currentArtifact = {
              artifactId: bestArt.id,
              version: bestArt.latestVersion,
            };
          }
        } catch (err) {
          // Ignore
        }
      }
    }

    let lastDefects: readonly Defect[] = [];
    /**
     * Most recent Boss verdict produced during the run, or `null` if
     * the Boss never evaluated the artifact (e.g. the cycle cap fired
     * during the Reviewer→Fixer loop). Final_Report assembly uses this
     * verbatim — `completed` runs require an `approved` verdict, and
     * `stopped_limit` runs prefer the latest `rejected` verdict's notes
     * over the generic stopped-limit fallback.
     */
    let lastBossVerdict: BossVerdict | null = null;

    // 3. Drive the state machine.
    let turn = 0;
    while (!isTerminalStatus(state.status)) {
      if (turn >= PIPELINE_MAX_TURNS) {
        state = await this.transitionAndPersist(state, {
          kind: "error",
          reason: `pipeline exceeded the safety cap of ${PIPELINE_MAX_TURNS} turns`,
        });
        break;
      }
      turn += 1;

      try {
        const next = await this.advance(state, {
          input,
          lastMessage,
          currentArtifact,
          lastDefects,
          lastBossVerdict,
        });
        state = next.state;
        lastMessage = next.lastMessage;
        currentArtifact = next.currentArtifact;
        lastDefects = next.lastDefects;
        lastBossVerdict = next.lastBossVerdict;
      } catch (err) {
        if (err instanceof ConsentRequiredError) {
          const req: ConsentRequest = {
            taskId,
            command: err.command,
            args: err.args,
            cwd: err.cwd,
            reason: err.reason,
            source: "test-command-autodetect",
            createdAt: this.clock.nowIso(),
          };
          activeConsentRequests.set(taskId, req);

          state = await this.transitionAndPersist(state, {
            kind: "requires_consent",
          });

          await this.publishOrchestratorTrace(taskId, {
            kind: "thought",
            text: `[orchestrator] transition reviewing → waiting_consent on requires_consent (command detected: ${err.command} ${err.args.join(" ")})`,
            at: this.clock.nowIso(),
          });

          break;
        }
        // Defence-in-depth: an agent runner that throws unexpectedly
        // (i.e. its built-in error path failed) must not leave the
        // pipeline running. Drive into `error`, persist, and report.
        console.error("PIPELINE AGENT STEP THREW:", err);
        state = await this.transitionAndPersist(state, {
          kind: "error",
          reason: `agent step threw: ${describeError(err)}`,
        });
        break;
      }
    }

    if (
      state.status === "completed" &&
      this.staging !== undefined &&
      this.artifactStore !== undefined
    ) {
      let applySuccess = false;
      try {
        const artifacts = await this.artifactStore.listArtifacts(taskId);
        const fileNames = artifacts.map((item) => item.fileName);
        await this.staging.applyToProject(taskId, fileNames);
        applySuccess = true;
      } catch (err) {
        const errorReason = `Failed to apply staging artifacts to project: ${describeError(err)}`;
        state = {
          ...state,
          status: "error",
          updatedAt: this.clock.nowIso(),
        };
        await this.store.save(state);
        await this.publishOrchestratorTrace(taskId, {
          kind: "thought",
          text: `[orchestrator] transition completed → error on applyToProject failure (reviewCycles=${state.reviewCycles}/${state.maxReviewCycles}): ${errorReason}`,
          at: this.clock.nowIso(),
        });
      }

      if (applySuccess) {
        try {
          await this.staging.cleanStagingDir(taskId);
        } catch (err: any) {
          await this.publishOrchestratorTrace(taskId, {
            kind: "thought",
            text: `[orchestrator] trace warning: cleanStagingDir failed with ${err.code || err.message || String(err)}`,
            at: this.clock.nowIso(),
          });
        }
      }
    }

    // 4. Orchestrator-level terminal event.
    if (state.status === "error") {
      await this.publishOrchestratorTrace(taskId, {
        kind: "status",
        status: "error",
        at: this.clock.nowIso(),
      });
    } else {
      await this.publishOrchestratorTrace(taskId, {
        kind: "status",
        status: "finished",
        at: this.clock.nowIso(),
      });
    }

    // 5. Final_Report assembly + Task History persistence (task 15.2).
    //    Only `completed` / `stopped_limit` are valid Final_Report
    //    statuses (Requirements 8.6 / 8.7); `error` outcomes are not
    //    surfaced through Final_Report so the field stays `null`.
    const finalReport = await this.assembleAndPersistFinalReport({
      state,
      input,
      lastBossVerdict,
    });

    return {
      finalState: state,
      currentArtifactId: currentArtifact?.artifactId ?? null,
      currentArtifactVersion: currentArtifact?.version ?? null,
      finalReport,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Per-step dispatcher. Each branch runs the appropriate agent and
   * applies the resulting event to the state machine. Returning a
   * structured "next" record keeps the outer loop simple and lets each
   * branch update only the bookkeeping it cares about.
   */
  private async advance(
    state: TaskState,
    ctx: AdvanceContext,
  ): Promise<AdvanceResult> {
    const { input } = ctx;
    const taskId = state.id;
    const taskCtx = { id: taskId, defaultModel: input.defaultModel } as const;

    switch (state.status) {
      case "created": {
        const next = await this.transitionAndPersist(state, { kind: "start" });
        return {
          state: next,
          lastMessage: ctx.lastMessage,
          currentArtifact: ctx.currentArtifact,
          lastDefects: ctx.lastDefects,
          lastBossVerdict: ctx.lastBossVerdict,
        };
      }

      case "researching": {
        const result = await this.participants.researcher.runner.run({
          task: taskCtx,
          agent: this.participants.researcher.agent,
          apiKey: input.apiKey,
          incoming: ctx.lastMessage,
          coderAgentId: this.participants.coder.agent.id,
        });
        const next = await this.transitionAndPersist(state, {
          kind: "prompt_enriched",
        });
        return {
          state: next,
          lastMessage: result.outgoing,
          currentArtifact: ctx.currentArtifact,
          lastDefects: ctx.lastDefects,
          lastBossVerdict: ctx.lastBossVerdict,
        };
      }

      case "coding": {
        const result = await this.participants.coder.runner.run({
          task: taskCtx,
          agent: this.participants.coder.agent,
          apiKey: input.apiKey,
          incoming: ctx.lastMessage,
          reviewerAgentId: this.participants.reviewer.agent.id,
        });
        // The Coder's atomic write semantics surface an
        // `outgoing.type === "error"` when the model failed. In that
        // case the artifact store is unchanged (Requirement 7.4) and
        // the pipeline cannot proceed.
        if (result.outgoing.type === "error") {
          const next = await this.transitionAndPersist(state, {
            kind: "error",
            reason: "Coder failed to produce an artifact",
          });
          return {
            state: next,
            lastMessage: result.outgoing,
            currentArtifact: ctx.currentArtifact,
            lastDefects: ctx.lastDefects,
            lastBossVerdict: ctx.lastBossVerdict,
          };
        }
        const next = await this.transitionAndPersist(state, {
          kind: "code_produced",
        });
        return {
          state: next,
          lastMessage: result.outgoing,
          currentArtifact: {
            artifactId: result.coded.artifactId,
            version: result.coded.version,
          },
          lastDefects: ctx.lastDefects,
          lastBossVerdict: ctx.lastBossVerdict,
        };
      }

      case "reviewing": {
        if (ctx.currentArtifact === null) {
          console.error("ERROR: Reviewer invoked without a current artifact!");
          // Defensive: the state machine only enters `reviewing` after
          // `coding`, which guarantees an artifact ref. If the ref is
          // somehow missing, surface it as an error rather than calling
          // the Reviewer with bogus input.
          const next = await this.transitionAndPersist(state, {
            kind: "error",
            reason: "Reviewer invoked without a current artifact",
          });
          return {
            state: next,
            lastMessage: ctx.lastMessage,
            currentArtifact: ctx.currentArtifact,
            lastDefects: ctx.lastDefects,
            lastBossVerdict: ctx.lastBossVerdict,
          };
        }
        let changedFileNames: string[] | undefined;
        if (this.artifactStore !== undefined) {
          try {
            const artifacts = await this.artifactStore.listArtifacts(taskId);
            changedFileNames = artifacts.map((item) => item.fileName);
          } catch (err) {
            // Ignore error retrieving changed file names
          }
        }

        const reviewerInput: ReviewerRunInput = {
          task: taskCtx,
          agent: this.participants.reviewer.agent,
          apiKey: input.apiKey,
          incoming: ctx.lastMessage,
          artifactRef: ctx.currentArtifact,
          fixerAgentId: this.participants.fixer.agent.id,
          bossAgentId: this.participants.boss.agent.id,
          ...(changedFileNames !== undefined ? { changedFileNames } : {}),
          ...(input.consentDecision !== undefined ? { consentDecision: input.consentDecision } : {}),
        };

        const result = await this.participants.reviewer.runner.run(reviewerInput);

        if (result.verdict.kind === "defectsFound") {
          // `defects_found` from `reviewing` either advances to
          // `fixing` (under cap) or short-circuits to `stopped_limit`
          // (at cap). Both branches are handled inside `applyEvent` —
          // we just apply the event and persist whatever it returns.
          const next = await this.transitionAndPersist(state, {
            kind: "defects_found",
          });
          return {
            state: next,
            lastMessage: result.outgoing,
            currentArtifact: ctx.currentArtifact,
            // Keep the defects so the next `fixing` step can pass
            // them to the Fixer agent.
            lastDefects: (result.verdict).defects,
            lastBossVerdict: ctx.lastBossVerdict,
          };
        }

        // noDefects → defects_empty. Guarded by `review_cycles_ge_1`.
        const attempt = applyEvent(state, { kind: "defects_empty" });
        if (!attempt.ok) {
          console.error("DEFECTS EMPTY TRANSITION FAILED:", attempt.error);
        }
        if (attempt.ok) {
          await this.persistTransition(state, attempt.next, "defects_empty");
          return {
            state: attempt.next,
            lastMessage: result.outgoing,
            currentArtifact: ctx.currentArtifact,
            lastDefects: ctx.lastDefects,
            lastBossVerdict: ctx.lastBossVerdict,
          };
        }
        // Guard failed: Reviewer reported no defects on the first pass.
        // The design forbids skipping the Review_Cycle, so we surface
        // an explanatory error rather than looping silently.
        const next = await this.transitionAndPersist(state, {
          kind: "error",
          reason:
            "Reviewer returned no defects before any Review_Cycle was performed",
        });
        return {
          state: next,
          lastMessage: result.outgoing,
          currentArtifact: ctx.currentArtifact,
          lastDefects: ctx.lastDefects,
          lastBossVerdict: ctx.lastBossVerdict,
        };
      }

      case "fixing": {
        if (ctx.currentArtifact === null) {
          const next = await this.transitionAndPersist(state, {
            kind: "error",
            reason: "Fixer invoked without a current artifact",
          });
          return {
            state: next,
            lastMessage: ctx.lastMessage,
            currentArtifact: ctx.currentArtifact,
            lastDefects: ctx.lastDefects,
            lastBossVerdict: ctx.lastBossVerdict,
          };
        }
        const result = await this.participants.fixer.runner.run({
          task: taskCtx,
          agent: this.participants.fixer.agent,
          apiKey: input.apiKey,
          incoming: ctx.lastMessage,
          artifactRef: ctx.currentArtifact,
          defects: ctx.lastDefects,
          reviewerAgentId: this.participants.reviewer.agent.id,
        });
        if (result.outgoing.type === "error") {
          const next = await this.transitionAndPersist(state, {
            kind: "error",
            reason: "Fixer failed to apply defects",
          });
          return {
            state: next,
            lastMessage: result.outgoing,
            currentArtifact: ctx.currentArtifact,
            lastDefects: ctx.lastDefects,
            lastBossVerdict: ctx.lastBossVerdict,
          };
        }
        const next = await this.transitionAndPersist(state, {
          kind: "defects_fixed",
        });
        return {
          state: next,
          lastMessage: result.outgoing,
          currentArtifact: {
            artifactId: result.fixed.artifactId,
            version: result.fixed.version,
          },
          lastDefects: ctx.lastDefects,
          lastBossVerdict: ctx.lastBossVerdict,
        };
      }

      case "boss_eval": {
        const evalResult = await this.participants.boss.runner.evaluate({
          task: taskCtx,
          apiKey: input.apiKey,
          reviewCycles: state.reviewCycles,
          incoming: ctx.lastMessage,
        });

        if (evalResult.verdict.kind === "approved") {
          // The Boss agent already enforces the Requirement 14.1 gate
          // (it would have flipped to `rejected` on `reviewCycles < 1`),
          // and the state machine guards `boss_approved → completed`
          // with the same precondition. Both checks should agree.
          const next = await this.transitionAndPersist(state, {
            kind: "boss_approved",
          });
          return {
            state: next,
            lastMessage: evalResult.outgoing,
            currentArtifact: ctx.currentArtifact,
            lastDefects: ctx.lastDefects,
            lastBossVerdict: evalResult.verdict,
          };
        }

        // Rejection routes back to the Fixer (Requirement 8.3) — or to
        // `stopped_limit` if the cap has been reached.
        const next = await this.transitionAndPersist(state, {
          kind: "boss_rejected",
        });
        // When the cap is hit, the state machine routes to
        // `stopped_limit` directly. When the cap is not yet hit, the
        // state machine routes to `fixing`; in that case we want to
        // pass the Boss's rejection notes to the Fixer as defects on
        // the next loop iteration.
        const bossDefects: readonly Defect[] =
          next.status === "fixing"
            ? bossNotesToDefects(evalResult.verdict.notes)
            : ctx.lastDefects;
        return {
          state: next,
          lastMessage: evalResult.outgoing,
          currentArtifact: ctx.currentArtifact,
          lastDefects: bossDefects,
          // Capture the rejection — Final_Report's stopped_limit path
          // prefers the latest Boss notes over the generic fallback.
          lastBossVerdict: evalResult.verdict,
        };
      }

      // Terminal states are filtered before `advance` is called.
      // Defensive default: surface an explicit error so a future
      // state-machine extension cannot silently bypass the loop.
      case "completed":
      case "stopped_limit":
      case "error":
      default: {
        const next = await this.transitionAndPersist(state, {
          kind: "error",
          reason: `unexpected status '${state.status}' inside pipeline driver`,
        });
        return {
          state: next,
          lastMessage: ctx.lastMessage,
          currentArtifact: ctx.currentArtifact,
          lastDefects: ctx.lastDefects,
          lastBossVerdict: ctx.lastBossVerdict,
        };
      }
    }
  }

  /**
   * Apply a {@link TaskEvent} to `state`, persist the resulting state and
   * publish a `thought` trace describing the transition. Used for every
   * structurally-defined transition (`start`, `prompt_enriched`,
   * `code_produced`, `defects_fixed`, `boss_approved`, `error`, …).
   *
   * Failed transitions short-circuit into an `error` state with the
   * underlying message so callers always observe a forward-progress
   * step (no infinite re-tries on the same event).
   */
  private async transitionAndPersist(
    state: TaskState,
    event:
      | { kind: "start" }
      | { kind: "prompt_enriched" }
      | { kind: "code_produced" }
      | { kind: "defects_found" }
      | { kind: "defects_fixed" }
      | { kind: "defects_empty" }
      | { kind: "boss_approved" }
      | { kind: "boss_rejected" }
      | { kind: "requires_consent" }
      | { kind: "user_approved_test_command" }
      | { kind: "user_rejected_test_command" }
      | { kind: "user_cancelled" }
      | { kind: "error"; reason?: string },
  ): Promise<TaskState> {
    const result = applyEvent(state, event);
    if (!result.ok) {
      // The transition we requested is illegal in the current state.
      // If we're already trying to drive into `error`, persist as-is to
      // avoid re-entering this path; otherwise force an `error` event
      // so the pipeline always reaches a terminal state.
      if (event.kind === "error" || isTerminalStatus(state.status)) {
        return state;
      }
      const fallback = applyEvent(state, {
        kind: "error",
        reason: `state machine rejected '${event.kind}': ${result.error.message}`,
      });
      if (!fallback.ok) {
        return state;
      }
      await this.persistTransition(state, fallback.next, "error");
      return fallback.next;
    }
    await this.persistTransition(state, result.next, event.kind);
    return result.next;
  }

  /**
   * Persist the new state and publish the orchestrator's thought trace
   * for the transition. `eventKind` is included in the trace text so a
   * UI panel can render the audit trail without re-deriving it.
   */
  private async persistTransition(
    previous: TaskState,
    next: TaskState,
    eventKind: string,
  ): Promise<void> {
    await this.store.save(next);
    await this.publishOrchestratorTrace(next.id, {
      kind: "thought",
      text: `[orchestrator] transition ${previous.status} → ${next.status} on ${eventKind} (reviewCycles=${next.reviewCycles}/${next.maxReviewCycles})`,
      at: this.clock.nowIso(),
    });
  }

  /**
   * Publish a trace record under the orchestrator's pseudo-agent id.
   * Bus failures are swallowed: trace emission is best-effort and
   * MUST NOT alter pipeline outcomes (design.md → "Trace delays" /
   * "Trace Event Bus" → "Rules").
   */
  private async publishOrchestratorTrace(
    taskId: string,
    record: Parameters<TraceEventBusInterface["publish"]>[0]["record"],
  ): Promise<void> {
    try {
      await this.traceBus.publish({
        taskId,
        agentId: ORCHESTRATOR_AGENT_ID,
        record,
      });
    } catch {
      // Trace failures must never alter the pipeline.
    }
  }

  /**
   * Build a {@link FinalReport} from the run's terminal state and persist
   * it to {@link TaskHistoryStore.save} when both an `artifactStore` and
   * a `taskHistoryStore` are configured.
   *
   * Behaviour:
   *   • If `state.status` is not a Final_Report status (`completed` /
   *     `stopped_limit`), or no `artifactStore` is supplied, returns
   *     `null` — `error` outcomes are not surfaced as Final_Reports
   *     (Requirements 8.6 / 8.7), and the builder needs an artifact
   *     listing to assemble `finalArtifacts`.
   *   • Calls `artifactStore.listArtifacts(taskId)` and feeds the result
   *     into {@link buildFinalReport} along with the resolved
   *     `participants` list (defaulting to the five canonical agent ids
   *     when the caller did not supply one).
   *   • When a `taskHistoryStore` is configured, persists the assembled
   *     report so the Task History UI (Requirement 14.5) can later look
   *     it up by `taskId`. Persistence failures are surfaced — Task
   *     History is the user-facing record of work performed and silent
   *     drops would be misleading.
   *
   * Validates: Requirements 8.6, 8.7, 14.2, 14.4, 14.5.
   */
  private async assembleAndPersistFinalReport(args: {
    readonly state: TaskState;
    readonly input: RunTaskPipelineInput;
    readonly lastBossVerdict: BossVerdict | null;
  }): Promise<FinalReport | null> {
    const { state, input, lastBossVerdict } = args;
    if (this.artifactStore === undefined) {
      return null;
    }
    if (state.status !== "completed" && state.status !== "stopped_limit") {
      return null;
    }

    let metadata: readonly FileArtifactMetadata[];
    try {
      metadata = await this.artifactStore.listArtifacts(state.id);
    } catch {
      // Artifact listing failures must not crash the pipeline result —
      // surface a Final_Report with an empty artifact list so the user
      // still sees the Boss summary / outstanding issues.
      metadata = [];
    }

    const participants = resolveReportParticipants(
      input.participants,
      this.participants,
    );

    const report = buildFinalReport({
      taskId: state.id,
      terminalStatus: state.status,
      originalPrompt: input.prompt,
      participants,
      reviewCyclesPerformed: state.reviewCycles,
      finalArtifacts: metadata,
      ...(lastBossVerdict !== null ? { bossVerdict: lastBossVerdict } : {}),
      clock: { nowIso: () => this.clock.nowIso() },
    });

    if (this.taskHistoryStore !== undefined) {
      await this.taskHistoryStore.save(report);
    }

    return report;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the participants list used by Final_Report assembly.
 *
 * Precedence:
 *   1. `explicit` — caller-supplied list (the resolved Auto/Manual
 *      selection from `Orchestrator.createTask`). Empty arrays fall
 *      through so a misconfigured caller does not produce an invalid
 *      Final_Report (the validation schema requires at least one
 *      participant).
 *   2. The five canonical agent ids in pipeline order, taken from the
 *      runner's {@link PipelineParticipants}. The driver always has
 *      these agents wired, so this is always a non-empty list.
 *
 * Duplicate ids are dropped while preserving first-occurrence order so
 * the report participant list reads as a clean execution-order list.
 */
function resolveReportParticipants(
  explicit: readonly AgentId[] | undefined,
  participants: PipelineParticipants,
): readonly AgentId[] {
  const candidate =
    explicit !== undefined && explicit.length > 0
      ? explicit
      : [
          participants.researcher.agent.id,
          participants.coder.agent.id,
          participants.reviewer.agent.id,
          participants.fixer.agent.id,
          participants.boss.agent.id,
        ];
  const seen = new Set<AgentId>();
  const out: AgentId[] = [];
  for (const id of candidate) {
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Convert Boss rejection notes into Reviewer-style defects so the
 * Fixer agent (which expects {@link Defect}s) can consume them on the
 * Boss → Fixer feedback path (Requirement 8.3). Severity is `high`
 * because Boss-level rejections are by design more substantive than
 * Reviewer nits.
 */
function bossNotesToDefects(notes: readonly string[]): readonly Defect[] {
  return notes
    .map((note) => note.trim())
    .filter((note) => note.length > 0)
    .map<Defect>((note, index) => ({
      id: `boss-note-${index + 1}`,
      description: note,
      severity: "high",
    }));
}

const TERMINAL_STATUSES = new Set<TaskStatus>([
  "completed",
  "stopped_limit",
  "error",
]);

function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

interface AdvanceContext {
  readonly input: RunTaskPipelineInput;
  readonly lastMessage: AgentMessage;
  readonly currentArtifact: { artifactId: string; version: number } | null;
  readonly lastDefects: readonly Defect[];
  readonly lastBossVerdict: BossVerdict | null;
}

interface AdvanceResult {
  readonly state: TaskState;
  readonly lastMessage: AgentMessage;
  readonly currentArtifact: { artifactId: string; version: number } | null;
  readonly lastDefects: readonly Defect[];
  readonly lastBossVerdict: BossVerdict | null;
}

function validateInput(input: RunTaskPipelineInput): void {
  if (typeof input?.state?.id !== "string" || input.state.id.length === 0) {
    throw new TypeError("runTaskPipeline: state.id must be a non-empty string");
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new TypeError(
      "runTaskPipeline: prompt must be a non-empty string after trim",
    );
  }
  if (input.apiKey === undefined || input.apiKey === null) {
    throw new TypeError("runTaskPipeline: apiKey is required");
  }
  if (
    input.defaultModel === undefined ||
    typeof input.defaultModel.modelId !== "string" ||
    input.defaultModel.modelId.length === 0
  ) {
    throw new TypeError(
      "runTaskPipeline: defaultModel.modelId must be a non-empty string",
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

// ---------------------------------------------------------------------------
// Free-function form
// ---------------------------------------------------------------------------

/**
 * Free-function entry point — wraps {@link TaskPipeline} for callers
 * that prefer a single call site over instantiating a class. Identical
 * semantics: validates the input, drives the pipeline to a terminal
 * status, persists state at every transition, and emits trace events
 * along the way.
 *
 * Validates: Requirements 7.1, 8.1, 8.2, 8.3, 8.4, 8.7.
 */
export async function runTaskPipeline(
  input: RunTaskPipelineInput,
  options: TaskPipelineOptions,
): Promise<RunTaskPipelineResult> {
  const pipeline = new TaskPipeline(options);
  return pipeline.runTask(input);
}

export async function resumeTask(
  taskId: string,
  decision: ConsentDecision,
  options: TaskPipelineOptions & { apiKey?: SecretRef; defaultModel?: ModelRef },
): Promise<RunTaskPipelineResult> {
  const state = await options.store.load(taskId);
  if (!state) {
    throw new Error(`Task with id ${taskId} not found`);
  }

  if (state.status !== "waiting_consent") {
    throw new Error(`Task with id ${taskId} is not in waiting_consent status (current status: ${state.status})`);
  }

  // Remove active consent request
  activeConsentRequests.delete(taskId);

  const pipeline = new TaskPipeline(options);

  // Retrieve prompt from history
  const history = await options.messageHistoryStore.list(taskId);
  const handoff = history.find(
    (m) => m.type === "handoff" && m.sender === ORCHESTRATOR_AGENT_ID
  );
  const prompt = (handoff?.payload as any)?.text ?? "";

  const apiKey: SecretRef = options.apiKey ?? {
    provider: "stub",
    scope: { kind: "local", deviceId: "stub" },
    expiresAt: new Date(0).toISOString(),
  };
  const defaultModel: ModelRef = options.defaultModel ?? {
    provider: "stub",
    modelId: "stub",
    source: "user-api-key",
  };

  if (decision.kind === "cancel") {
    // Transition using user_cancelled to stopped_limit
    const result = applyEvent(state, { kind: "user_cancelled" });
    if (!result.ok) {
      throw new Error(`Failed to transition task ${taskId} on user_cancelled: ${result.error.message}`);
    }
    const nextState = result.next;
    nextState.updatedAt = options.clock?.nowIso() ?? new Date().toISOString();
    await options.store.save(nextState);

    await pipeline["publishOrchestratorTrace"](taskId, {
      kind: "thought",
      text: `[orchestrator] transition waiting_consent → stopped_limit on user_cancelled`,
      at: options.clock?.nowIso() ?? new Date().toISOString(),
    });

    await pipeline["publishOrchestratorTrace"](taskId, {
      kind: "status",
      status: "finished",
      at: options.clock?.nowIso() ?? new Date().toISOString(),
    });

    const finalReport = await pipeline["assembleAndPersistFinalReport"]({
      state: nextState,
      input: { state: nextState, prompt, apiKey, defaultModel },
      lastBossVerdict: null,
    });

    return {
      finalState: nextState,
      currentArtifactId: null,
      currentArtifactVersion: null,
      finalReport,
    };
  }

  let eventKind: "user_approved_test_command" | "user_rejected_test_command";
  if (decision.kind === "reject") {
    eventKind = "user_rejected_test_command";
  } else {
    eventKind = "user_approved_test_command";
  }

  const transitionResult = applyEvent(state, { kind: eventKind });
  if (!transitionResult.ok) {
    throw new Error(`Failed to transition task ${taskId} on ${eventKind}: ${transitionResult.error.message}`);
  }

  const nextState = transitionResult.next;
  nextState.updatedAt = options.clock?.nowIso() ?? new Date().toISOString();
  await options.store.save(nextState);

  await pipeline["publishOrchestratorTrace"](taskId, {
    kind: "thought",
    text: `[orchestrator] transition waiting_consent → reviewing on ${eventKind}`,
    at: options.clock?.nowIso() ?? new Date().toISOString(),
  });

  // Run the pipeline onwards from the new state
  return pipeline.runTask({
    state: nextState,
    prompt,
    apiKey,
    defaultModel,
    consentDecision: decision,
  });
}
