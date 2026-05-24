/**
 * `Orchestrator.createTask` — input validation, participant resolution and
 * initial `TaskState` persistence (task 8.2).
 *
 * Sources:
 * - design.md → "Orchestrator Core" → "Validation rules" (full pre-Task gate).
 * - design.md → "Data Models" → "Task" (`CreateTaskInput`, `TaskState`,
 *   invariants).
 * - requirements.md →
 *     6.4 (empty prompt rejected),
 *     6.5 (UI keeps launch disabled while empty — backend still validates),
 *     6.6 (Manual_Mode requires at least one agent),
 *     6.7 (no Model or no valid API key → reject),
 *     6.8 (on confirmation: create Task with unique id and persist),
 *     5.5 (platform-fallback models must not be silently mixed with user-key),
 *    13.4 (notify before switching to fallback — modeled here as a
 *           `confirmedFallback` precondition the gateway is responsible for
 *           collecting before invoking `createTask`).
 * - tasks.md task 8.2 sub-bullets.
 *
 * Scope of this module:
 * - Validate `CreateTaskInput` plus owner scope and (optional) confirmed
 *   fallback flag.
 * - Verify that `modelRef` is in the user's `ModelCatalog` (a
 *   `status: "ok"` listing for the provider, containing a model whose
 *   `modelId` AND `source` match — so a fallback model does not satisfy
 *   a `user-api-key` request and vice versa, per Requirement 5.5).
 * - For Manual_Mode, require ≥ 1 explicit participant.
 * - For Auto_Mode, delegate participant selection to a pluggable
 *   {@link AutoParticipantResolver} and require a non-empty ordered list.
 * - Persist the initial `TaskState` (status `"created"`, reviewCycles 0,
 *   `maxReviewCycles` defaulted to 5) through a pluggable
 *   {@link TaskStateStore} and return `{ taskId }`.
 *
 * Out of scope (task 15.1 wires these):
 * - Driving the Researcher → Coder → … → Boss pipeline.
 * - Persisting prompts/modelRef/participants alongside `TaskState` for
 *   later replay. The resolved participants flow into the pipeline at
 *   start time; task 15.1 will extend persistence as needed.
 *
 * Validates: Requirements 6.4, 6.6, 6.7, 6.8.
 */

import type {
  AgentId,
  ModelRef,
  Scope,
  TaskId,
} from "@ai-agent-orchestrator/shared-core";
import {
  DEFAULT_MAX_REVIEW_CYCLES,
  type CreateTaskInput,
  type TaskState,
} from "@ai-agent-orchestrator/validation";

import type { ProviderModelsResult } from "../models/index.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Stable error codes returned by {@link Orchestrator.createTask}.
 *
 * They are ordered to match the validation pipeline so a UI that wants to
 * surface a single first-failing reason can rely on the order:
 *
 *   1. `empty_prompt`                      — Requirement 6.4
 *   2. `invalid_input`                     — structural shape of CreateTaskInput
 *   3. `model_unavailable`                 — Requirement 6.7 (no Model)
 *   4. `fallback_not_confirmed`            — Requirement 13.4 (fallback gate)
 *   5. `manual_mode_zero_participants`     — Requirement 6.6
 *   6. `auto_mode_no_participants`         — design.md "Validation rules"
 *   7. `persistence_failed`                — durable store rejected the write
 */
export type CreateTaskErrorCode =
  | "empty_prompt"
  | "invalid_input"
  | "model_unavailable"
  | "fallback_not_confirmed"
  | "manual_mode_zero_participants"
  | "auto_mode_no_participants"
  | "persistence_failed";

/**
 * Typed error class so callers (gateway/RPC layer, UI) can branch on
 * `code` without parsing the message. Extends `Error` so it survives
 * `Promise.catch` and stack traces stay useful.
 */
export class CreateTaskError extends Error {
  public readonly code: CreateTaskErrorCode;
  public override readonly cause: unknown;

  public constructor(
    code: CreateTaskErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "CreateTaskError";
    this.code = code;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Narrow read-only port the orchestrator uses to consult the Model
 * Catalog. The full {@link import("../models/index.js").ModelCatalog}
 * class implements this; tests can stub it without instantiating
 * adapters or a resolver.
 *
 * Returning a fresh array per call is sufficient — caching is the
 * catalog's concern (Requirement 5.1) and the orchestrator does not
 * need to invalidate it.
 */
export interface ModelCatalogPort {
  listModelsForUser(scope: Scope): Promise<ProviderModelsResult[]>;
}

/**
 * Auto_Mode participant selection port (design.md → "Validation rules":
 * "Auto_Mode must produce non-empty ordered agent set"; Requirement
 * 6.3).
 *
 * The resolver receives the full prompt and target model so it can pick
 * a context-appropriate set of agents. The orchestrator does NOT inspect
 * the prompt itself — agent selection is intentionally a separate
 * concern so it can be swapped out (heuristic now, model-driven later)
 * without touching createTask validation.
 *
 * Contract:
 *   • MUST return at least one `AgentId` for any well-formed input. If
 *     the resolver decides no agent fits, it MUST return `[]` so
 *     `createTask` can surface a clear `auto_mode_no_participants`
 *     error rather than the resolver throwing.
 *   • Order of returned agents MUST be the order in which they should
 *     execute. The orchestrator preserves this order verbatim (no
 *     reordering, no deduplication).
 *   • `Promise` rejections propagate as `auto_mode_no_participants`
 *     wrapping the underlying cause; the resolver SHOULD prefer
 *     returning `[]` over throwing for predictable error UX.
 */
export interface AutoParticipantResolver {
  resolveAutoParticipants(input: {
    readonly prompt: string;
    readonly modelRef: ModelRef;
    readonly ownerScope: Scope;
  }): Promise<readonly AgentId[]>;
}

/**
 * Pluggable durable store for `TaskState`. Task 8.2 only needs `save`;
 * later tasks (9.1 transitions, 15.1 pipeline driver) extend this port
 * with `load` / `update` once they need to read state back.
 *
 * Implementations:
 *   • MUST treat `state.id` as the primary key. A `save` for an existing
 *     id is implementation-defined; for the initial-create flow used
 *     here the id comes from {@link TaskIdGenerator} and is assumed
 *     unique.
 *   • SHOULD preserve a defensive copy so caller mutation cannot alter
 *     persisted state (matches the convention used by
 *     `InMemoryApiKeyStoreBackend`).
 */
export interface TaskStateStore {
  save(state: TaskState): Promise<void>;
  load(id: string): Promise<TaskState | null>;
}

/**
 * Generator port for `TaskId` values. Defaults to `crypto.randomUUID()`
 * in production composition; tests inject a deterministic counter.
 *
 * The id is required to be non-empty; an empty id surfaces as
 * `invalid_input` because a `Task` with no id cannot satisfy the unique-
 * identifier contract from Requirement 6.8.
 */
export interface TaskIdGenerator {
  next(): TaskId;
}

const defaultTaskIdGenerator: TaskIdGenerator = {
  next: () => {
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      throw new Error(
        "Orchestrator.createTask requires globalThis.crypto.randomUUID for taskId generation. " +
          "Pass `idGenerator` in OrchestratorOptions on hosts without it.",
      );
    }
    return globalThis.crypto.randomUUID();
  },
};

/** Optional clock dependency, primarily for deterministic tests. */
export interface OrchestratorClock {
  now(): Date;
}

const systemClock: OrchestratorClock = {
  now: () => new Date(),
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Constructor options for {@link Orchestrator}.
 *
 * `modelCatalog`, `autoResolver` and `store` are required. `idGenerator`
 * and `clock` default to the production system implementations.
 */
export interface OrchestratorOptions {
  readonly modelCatalog: ModelCatalogPort;
  readonly autoResolver: AutoParticipantResolver;
  readonly store: TaskStateStore;
  readonly idGenerator?: TaskIdGenerator;
  readonly clock?: OrchestratorClock;
}

/**
 * Input for {@link Orchestrator.createTask}.
 *
 * Wraps the canonical `CreateTaskInput` from the validation package with
 * the owner scope (which the gateway derives from the caller's session)
 * and an optional `confirmedFallback` flag. Keeping the wrapper here —
 * rather than embedding `ownerScope` into `CreateTaskInput` — lets the
 * shared validation schema stay client-facing while still letting the
 * orchestrator gate fallback usage server-side.
 */
export interface CreateTaskArgs {
  readonly ownerScope: Scope;
  readonly input: CreateTaskInput;
  /**
   * Set to `true` once the user has been notified about platform fallback
   * usage and explicitly confirmed (Requirement 13.4). Required when
   * `input.modelRef.source === "platform-fallback"`; ignored otherwise.
   */
  readonly confirmedFallback?: boolean;
}

/**
 * Orchestrator entry point for creating a `Task`.
 *
 * The class is intentionally thin: it owns input validation and initial
 * persistence only. Agent invocation, pipeline driving and trace emission
 * land in task 15.1.
 */
export class Orchestrator {
  private readonly modelCatalog: ModelCatalogPort;
  private readonly autoResolver: AutoParticipantResolver;
  private readonly store: TaskStateStore;
  private readonly idGenerator: TaskIdGenerator;
  private readonly clock: OrchestratorClock;

  public constructor(options: OrchestratorOptions) {
    this.modelCatalog = options.modelCatalog;
    this.autoResolver = options.autoResolver;
    this.store = options.store;
    this.idGenerator = options.idGenerator ?? defaultTaskIdGenerator;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Validates `args`, resolves participants for Auto_Mode, persists the
   * initial `TaskState` and returns its id.
   *
   * Throws {@link CreateTaskError} on the first failing check, in the
   * order documented on {@link CreateTaskErrorCode}. Persistence errors
   * propagate as `persistence_failed` so the UI can show a "couldn't
   * save your task" message without leaking internals.
   *
   * Validates: Requirements 6.4, 6.6, 6.7, 6.8.
   */
  public async createTask(args: CreateTaskArgs): Promise<{ taskId: TaskId }> {
    const { ownerScope, input } = args;

    // 1. Empty-prompt gate (Requirement 6.4). Done before structural
    //    validation so the error UX matches the dedicated test in
    //    tasks.md task 8.3.
    if (typeof input?.prompt !== "string" || input.prompt.trim().length === 0) {
      throw new CreateTaskError(
        "empty_prompt",
        "createTask: prompt must be non-empty after trim",
      );
    }

    // 2. Structural validation. Each check uses `invalid_input` so a
    //    misshapen request is distinguishable from semantically-valid
    //    requests that fail downstream business rules.
    if (input.mode !== "auto" && input.mode !== "manual") {
      throw new CreateTaskError(
        "invalid_input",
        `createTask: mode must be "auto" or "manual"`,
      );
    }
    if (
      input.modelRef === undefined ||
      input.modelRef === null ||
      typeof input.modelRef !== "object"
    ) {
      throw new CreateTaskError(
        "invalid_input",
        "createTask: modelRef is required",
      );
    }
    if (
      typeof input.modelRef.provider !== "string" ||
      input.modelRef.provider.length === 0 ||
      typeof input.modelRef.modelId !== "string" ||
      input.modelRef.modelId.length === 0 ||
      (input.modelRef.source !== "user-api-key" &&
        input.modelRef.source !== "platform-fallback")
    ) {
      throw new CreateTaskError(
        "invalid_input",
        "createTask: modelRef must include non-empty provider, modelId and a recognised source",
      );
    }
    if (ownerScope === undefined || ownerScope === null) {
      throw new CreateTaskError(
        "invalid_input",
        "createTask: ownerScope is required",
      );
    }
    const maxReviewCycles =
      input.maxReviewCycles ?? DEFAULT_MAX_REVIEW_CYCLES;
    if (!Number.isInteger(maxReviewCycles) || maxReviewCycles < 1) {
      throw new CreateTaskError(
        "invalid_input",
        "createTask: maxReviewCycles must be an integer >= 1",
      );
    }

    // 3. Model availability via the Model Catalog. We intentionally
    //    match on (provider, modelId, source) so a `platform-fallback`
    //    entry does NOT satisfy a `user-api-key` request and vice
    //    versa (Requirement 5.5: fallback models must not be silently
    //    mixed with user-key models). The catalog already enforces
    //    "no API key" → `status: "error"` for that provider, so a
    //    user-api-key request without a configured key naturally falls
    //    through to `model_unavailable`.
    let catalog: ProviderModelsResult[];
    try {
      catalog = await this.modelCatalog.listModelsForUser(ownerScope);
    } catch (cause) {
      // The catalog is contractually non-throwing (every per-provider
      // failure surfaces as a `status: "error"` entry). If a future bug
      // does throw, treat it as a model_unavailable signal rather than
      // letting the user see an opaque stack trace.
      throw new CreateTaskError(
        "model_unavailable",
        `createTask: model catalog could not be queried: ${describeError(cause)}`,
        cause,
      );
    }

    const providerEntry = catalog.find(
      (r) => r.provider === input.modelRef.provider,
    );
    const modelMatched =
      providerEntry !== undefined &&
      providerEntry.status === "ok" &&
      providerEntry.models.some(
        (m) =>
          m.modelId === input.modelRef.modelId &&
          m.source === input.modelRef.source,
      );
    if (!modelMatched) {
      // Build the most useful reason we can without leaking secrets.
      // When the provider returned an error (typically: no API key
      // configured, Requirement 6.7) we surface its reason verbatim;
      // otherwise we report the generic "not in catalog" case.
      const reason =
        providerEntry !== undefined && providerEntry.status === "error"
          ? providerEntry.reason
          : `model "${input.modelRef.modelId}" is not available for provider "${input.modelRef.provider}"`;
      throw new CreateTaskError(
        "model_unavailable",
        `createTask: ${reason}`,
      );
    }

    // 4. Fallback confirmation gate. The catalog already labels
    //    fallback entries (`source: "platform-fallback"`); here we
    //    insist on an explicit user confirmation flag before letting
    //    a Task run on a platform-backup key.
    if (
      input.modelRef.source === "platform-fallback" &&
      args.confirmedFallback !== true
    ) {
      throw new CreateTaskError(
        "fallback_not_confirmed",
        "createTask: platform-fallback model selected but confirmedFallback flag is not set",
      );
    }

    // 5. Per-mode participant rules.
    let participants: readonly AgentId[];
    if (input.mode === "manual") {
      const provided = input.participants ?? [];
      if (provided.length < 1) {
        throw new CreateTaskError(
          "manual_mode_zero_participants",
          "createTask: Manual_Mode requires at least one participant agent",
        );
      }
      participants = provided;
    } else {
      let resolved: readonly AgentId[];
      try {
        resolved = await this.autoResolver.resolveAutoParticipants({
          prompt: input.prompt,
          modelRef: input.modelRef,
          ownerScope,
        });
      } catch (cause) {
        throw new CreateTaskError(
          "auto_mode_no_participants",
          `createTask: Auto_Mode resolver failed: ${describeError(cause)}`,
          cause,
        );
      }
      if (!Array.isArray(resolved) || resolved.length < 1) {
        throw new CreateTaskError(
          "auto_mode_no_participants",
          "createTask: Auto_Mode produced an empty participant set",
        );
      }
      participants = resolved;
    }
    // The resolved participants feed the pipeline driver in task 15.1.
    // We bind them to a local for clarity even though `TaskState` does
    // not currently carry them.
    void participants;

    // 6. Mint a unique taskId and persist the initial TaskState
    //    (Requirement 6.8).
    const taskId = this.idGenerator.next();
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new CreateTaskError(
        "invalid_input",
        "createTask: TaskIdGenerator returned an empty id",
      );
    }
    const nowIso = this.clock.now().toISOString();
    const initial: TaskState = {
      id: taskId,
      ownerScope,
      status: "created",
      reviewCycles: 0,
      maxReviewCycles,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    try {
      await this.store.save(initial);
    } catch (cause) {
      throw new CreateTaskError(
        "persistence_failed",
        `createTask: failed to persist initial TaskState: ${describeError(cause)}`,
        cause,
      );
    }

    return { taskId };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Renders an unknown error value as a short, secret-free string. Mirrors
 * the helper in `authService.ts` so the orchestrator does not have to
 * trust upstream error messages to exclude API keys.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message =
      err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return message.length > 0 ? message : err.name;
  }
  if (typeof err === "string") {
    return err;
  }
  return "unknown error";
}
