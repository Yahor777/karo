/**
 * TaskBuilder controller (task 8.1).
 *
 * Source:
 *   • design.md → "Orchestrator Core" → "Validation rules":
 *       - prompt non-empty after trim,
 *       - model selected and available,
 *       - Manual_Mode requires ≥ 1 participant,
 *       - Auto_Mode produces a non-empty ordered set (orchestrator
 *         enforces; UI exposes the toggle).
 *   • design.md → "Components and Interfaces" → "Client SDK" →
 *     `TaskClient.createTask`.
 *   • requirements.md → 6.1, 6.2, 6.3, 6.5.
 *   • Backend integration: `apps/backend/src/orchestrator/createTask.ts`
 *     (`CreateTaskError` + `CreateTaskErrorCode`).
 *
 * The controller is framework-free, in line with the other shared-ui
 * screen controllers (`screens/login/loginScreen.ts`,
 * `screens/models/modelSelection.ts`, `screens/settings/customAgents.ts`).
 * It owns the form state machine and gateway orchestration; the DOM
 * mount helper (`mountTaskBuilderScreen.ts`) reads from it and wires
 * user events.
 *
 * State machine (mirrors design.md → "Orchestrator Core" →
 * "Validation rules"):
 *
 *   1. The user types a prompt, picks a model, picks Auto_Mode or
 *      Manual_Mode, and (in Manual_Mode) selects participants.
 *   2. `canLaunch()` returns `true` only when:
 *        • prompt is non-empty after trim,
 *        • a `modelRef` is set,
 *        • in Manual_Mode, ≥ 1 participant is selected,
 *        • a submit is not already in flight.
 *      The DOM mount helper mirrors this on the launch button's
 *      disabled attribute (Requirement 6.5).
 *   3. The user presses "Launch" → `submit = "submitting"` →
 *      `gateway.createTask(...)` → `submit = "submitted" | "error"`.
 *   4. On `"submitted"`, the controller emits a
 *      `{ type: "taskCreated", taskId }` event for the host shell to
 *      navigate to the task overview.
 *
 * Backend defence-in-depth still validates everything server-side
 * (`Orchestrator.createTask`), so a bypassed UI gate cannot create an
 * invalid Task. The controller maps `CreateTaskError.code` onto the
 * inline error surface verbatim.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.5.
 */

import type {
  AgentId,
  CreateTaskInput,
  ModelRef,
  TaskBuilderEvent,
  TaskBuilderEventListener,
  TaskBuilderGateway,
  TaskBuilderState,
  TaskBuilderStateListener,
  TaskBuilderSubmitStatus,
  TaskBuilderErrorCode,
  TaskMode,
} from "./types.js";

import { isCreateTaskError } from "../../ports/orchestrator.js";

/** Constructor options for {@link TaskBuilderController}. */
export interface TaskBuilderControllerOptions {
  readonly gateway: TaskBuilderGateway;
  /**
   * Optional override for the initial form state. Useful for tests
   * (e.g. seed a prompt to focus on submit-path behaviour) and for
   * hosts that pre-fill the screen from a "duplicate task" action.
   */
  readonly initialState?: Partial<TaskBuilderState>;
}

/** Default initial state used when no override is supplied. */
const DEFAULT_INITIAL_STATE: TaskBuilderState = {
  prompt: "",
  modelRef: null,
  mode: "auto",
  participants: [],
  confirmedFallback: false,
  submit: { kind: "idle" },
};

/**
 * Framework-free Task Builder controller.
 *
 * The controller exposes a small imperative API the DOM render layer
 * (or any other host) calls in response to user actions:
 *
 *   • `setPrompt(value)`           — react to the prompt textarea.
 *   • `setModel(ref)`              — react to the model selector.
 *   • `setMode(mode)`              — react to the Auto/Manual toggle.
 *   • `addParticipant(id)`         — react to the agent picker.
 *   • `removeParticipant(id)`      — react to deselecting an agent.
 *   • `setConfirmedFallback(v)`    — react to the fallback notice's
 *      "I understand and accept" checkbox; required before submit
 *      when the chosen model is `source: "platform-fallback"`.
 *   • `submit()`                   — react to the Launch button.
 *
 * Subscribers receive new state via `subscribeState` (and events via
 * `subscribeEvents`). The controller never reads from the DOM, so unit
 * tests can drive it without a JSDOM environment.
 */
export class TaskBuilderController {
  private readonly gateway: TaskBuilderGateway;
  private state: TaskBuilderState;
  private readonly stateListeners = new Set<TaskBuilderStateListener>();
  private readonly eventListeners = new Set<TaskBuilderEventListener>();
  /**
   * Tracks the in-flight submit call so a stale resolution cannot
   * overwrite a newer one. Each `submit()` call increments the
   * sequence; a result is only applied when its sequence still matches
   * at resolution time.
   */
  private submitSeq = 0;

  public constructor(options: TaskBuilderControllerOptions) {
    this.gateway = options.gateway;
    this.state = { ...DEFAULT_INITIAL_STATE, ...options.initialState };
  }

  /** Returns the current state snapshot. */
  public getState(): TaskBuilderState {
    return this.state;
  }

  /**
   * Returns `true` when the form is ready to launch a Task.
   *
   * The rule is the conjunction of:
   *   • prompt non-empty after trim (Requirement 6.5);
   *   • a `modelRef` is set (design "Validation rules");
   *   • in Manual_Mode, ≥ 1 participant is selected (Requirement 6.2);
   *   • a submit is not already in flight (UI hygiene — prevents
   *     double-launches while the gateway call is pending).
   *
   * The renderer mirrors this directly on the Launch button's
   * `disabled` attribute. The backend still validates every condition
   * as defence-in-depth.
   */
  public canLaunch(): boolean {
    if (this.state.submit.kind === "submitting") return false;
    if (this.state.prompt.trim().length === 0) return false;
    if (this.state.modelRef === null) return false;
    if (this.state.mode === "manual" && this.state.participants.length < 1) {
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  public subscribeState(listener: TaskBuilderStateListener): () => void {
    this.stateListeners.add(listener);
    // Eager push so subscribers don't need a separate "give me current"
    // call. Mirrors the conventions used by `LoginScreen`.
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public subscribeEvents(listener: TaskBuilderEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Field setters
  // -------------------------------------------------------------------------

  /**
   * Updates the prompt. Editing the prompt resets a prior submit
   * error so the inline error surface clears as soon as the user
   * starts addressing the cause.
   */
  public setPrompt(prompt: string): void {
    if (this.state.prompt === prompt) {
      return;
    }
    this.update({
      prompt,
      submit: clearTransientError(this.state.submit),
    });
  }

  /**
   * Updates the selected model. Switching models clears the
   * `confirmedFallback` flag — the user must explicitly accept
   * fallback usage for the new model before submit, even if they had
   * already accepted it for a previous fallback choice.
   */
  public setModel(modelRef: ModelRef | null): void {
    if (sameModelRef(this.state.modelRef, modelRef)) {
      return;
    }
    this.update({
      modelRef,
      confirmedFallback: false,
      submit: clearTransientError(this.state.submit),
    });
  }

  /**
   * Switches between Auto_Mode and Manual_Mode (Requirements 6.2,
   * 6.3). The participant list is preserved so toggling back and
   * forth doesn't lose the user's prior picks.
   */
  public setMode(mode: TaskMode): void {
    if (this.state.mode === mode) {
      return;
    }
    this.update({
      mode,
      submit: clearTransientError(this.state.submit),
    });
  }

  /**
   * Adds a participant. Deduplicates so the same agent cannot be
   * added twice (the backend would reject duplicates anyway, but
   * the UI list looks broken if it shows the same row twice).
   */
  public addParticipant(id: AgentId): void {
    if (this.state.participants.includes(id)) {
      return;
    }
    this.update({
      participants: [...this.state.participants, id],
      submit: clearTransientError(this.state.submit),
    });
  }

  /** Removes a participant. No-op if the id is not currently selected. */
  public removeParticipant(id: AgentId): void {
    if (!this.state.participants.includes(id)) {
      return;
    }
    this.update({
      participants: this.state.participants.filter((p) => p !== id),
      submit: clearTransientError(this.state.submit),
    });
  }

  /**
   * Toggles the "I have read the platform-fallback notice" flag.
   * Required before `submit()` will succeed when the chosen model is
   * `source: "platform-fallback"`.
   */
  public setConfirmedFallback(confirmed: boolean): void {
    if (this.state.confirmedFallback === confirmed) {
      return;
    }
    this.update({
      confirmedFallback: confirmed,
      submit: clearTransientError(this.state.submit),
    });
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  /**
   * Validates the form, calls `gateway.createTask`, and transitions
   * the `submit` slice through `submitting` → `submitted` | `error`.
   * Emits a `taskCreated` event on success.
   *
   * On validation failure (locally before the gateway call), the
   * controller produces a `submit.kind === "error"` slice with the
   * matching {@link TaskBuilderErrorCode} so the UI can render the
   * same inline error surface as for backend-side rejections.
   * The relevant local checks mirror the backend's order so a host
   * that consumes both layers sees consistent codes.
   *
   * Concurrency: only the most recent in-flight submit may apply its
   * result. This matches UI behaviour where a user double-clicks the
   * Launch button before the network call completes.
   *
   * Returns the new submit status so callers can `await` the outcome.
   */
  public async submit(): Promise<TaskBuilderSubmitStatus> {
    // Local pre-flight validation. We surface backend-aligned error
    // codes so the renderer's error surface is the same regardless of
    // whether the failure was caught locally or remotely.
    const local = this.localValidate();
    if (local !== null) {
      this.update({ submit: local });
      return local;
    }
    // canLaunch + localValidate together imply both modelRef and a
    // non-empty prompt. Re-narrow for the type system:
    if (this.state.modelRef === null) {
      // Defensive: should be unreachable given localValidate above.
      const submit: TaskBuilderSubmitStatus = {
        kind: "error",
        code: "model_unavailable",
        message: "createTask: modelRef is required",
      };
      this.update({ submit });
      return submit;
    }

    const seq = ++this.submitSeq;
    this.update({ submit: { kind: "submitting" } });

    const input: CreateTaskInput = {
      prompt: this.state.prompt,
      modelRef: this.state.modelRef,
      mode: this.state.mode,
      ...(this.state.mode === "manual"
        ? { participants: [...this.state.participants] }
        : {}),
    };

    let taskId: string;
    try {
      const result = await this.gateway.createTask(input, {
        confirmedFallback: this.state.confirmedFallback,
      });
      taskId = result.taskId;
    } catch (err: unknown) {
      if (seq !== this.submitSeq) {
        return this.state.submit;
      }
      const submit = mapErrorToSubmit(err);
      this.update({ submit });
      return submit;
    }

    if (seq !== this.submitSeq) {
      return this.state.submit;
    }
    const submit: TaskBuilderSubmitStatus = { kind: "submitted", taskId };
    this.update({ submit });
    this.emit({ type: "taskCreated", taskId });
    return submit;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private localValidate(): TaskBuilderSubmitStatus | null {
    if (this.state.prompt.trim().length === 0) {
      return {
        kind: "error",
        code: "empty_prompt",
        message: "Prompt is required.",
      };
    }
    if (this.state.modelRef === null) {
      return {
        kind: "error",
        code: "model_unavailable",
        message: "Select a model before launching the task.",
      };
    }
    if (this.state.mode === "manual" && this.state.participants.length < 1) {
      return {
        kind: "error",
        code: "manual_mode_zero_participants",
        message: "Manual mode requires at least one participant agent.",
      };
    }
    if (
      this.state.modelRef.source === "platform-fallback" &&
      !this.state.confirmedFallback
    ) {
      return {
        kind: "error",
        code: "fallback_not_confirmed",
        message:
          "Confirm platform fallback usage before launching with a fallback model.",
      };
    }
    return null;
  }

  private update(patch: Partial<TaskBuilderState>): void {
    const next: TaskBuilderState = { ...this.state, ...patch };
    if (statesEqual(this.state, next)) {
      return;
    }
    this.state = next;
    for (const listener of this.stateListeners) {
      listener(next);
    }
  }

  private emit(event: TaskBuilderEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Shallow equality on the slices that matter for re-render avoidance.
 * Submit/state are nested objects, so a referential check is enough
 * here — the controller always allocates a new object for transitions.
 */
function statesEqual(a: TaskBuilderState, b: TaskBuilderState): boolean {
  return (
    a.prompt === b.prompt &&
    a.modelRef === b.modelRef &&
    a.mode === b.mode &&
    a.participants === b.participants &&
    a.confirmedFallback === b.confirmedFallback &&
    a.submit === b.submit
  );
}

/**
 * Field-by-field equality for `ModelRef`. Avoids an unnecessary state
 * notification when the host re-emits the same model selection (e.g.
 * after a `refresh()` on the model catalog).
 */
function sameModelRef(a: ModelRef | null, b: ModelRef | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.provider === b.provider &&
    a.modelId === b.modelId &&
    a.source === b.source
  );
}

/**
 * Resets a `submit.error` back to `idle` when the user starts editing
 * the form. Keeps a `submitting` or `submitted` state intact so a
 * concurrent edit doesn't accidentally cancel the in-flight call or
 * the success indicator.
 */
function clearTransientError(
  current: TaskBuilderSubmitStatus,
): TaskBuilderSubmitStatus {
  return current.kind === "error" ? { kind: "idle" } : current;
}

/**
 * Maps a thrown gateway error onto the controller's submit-error
 * slice. Recognises the `CreateTaskError`-shaped object from the
 * backend (via {@link isCreateTaskError}) so its `code` field flows
 * through verbatim. Unknown errors fall back to `code: "unknown"`.
 */
function mapErrorToSubmit(err: unknown): TaskBuilderSubmitStatus {
  if (isCreateTaskError(err)) {
    return {
      kind: "error",
      code: err.code,
      message: err.message,
    };
  }
  const code: TaskBuilderErrorCode = "unknown";
  return {
    kind: "error",
    code,
    message: describeError(err),
  };
}

/** Renders an unknown error value as a short, secret-free string. */
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
