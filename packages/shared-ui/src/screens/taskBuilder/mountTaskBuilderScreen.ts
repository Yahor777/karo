/**
 * DOM render shell for {@link TaskBuilderController} (task 8.1).
 *
 * Source:
 *   • design.md → "Orchestrator Core" → "Validation rules".
 *   • requirements.md → 6.1, 6.2, 6.3, 6.5.
 *
 * Framework-free renderer that mirrors the style of
 * `apps/desktop-windows/src/ui/bootstrap.ts` (vanilla
 * `document.createElement` + `addEventListener`). The shell owns the
 * DOM and listens to the controller's state stream; the controller
 * owns the form state machine and the gateway calls. Splitting them
 * this way keeps the controller unit-testable without JSDOM.
 *
 * What this function renders:
 *
 *   • A multi-line `<textarea>` for the prompt (Requirement 6.1).
 *   • A flat `<select>` model picker grouped by provider via
 *     `<optgroup>`. The list is supplied by the host as
 *     `availableModels` so the Task Builder doesn't depend on the
 *     model-catalog controller (per the task brief).
 *   • An Auto/Manual radio toggle (Requirement 6.1).
 *   • An agent picker (multi-select) shown only in Manual_Mode
 *     (Requirement 6.2). The list is supplied by the host as
 *     `availableAgents` so the Task Builder doesn't depend on the
 *     custom-agents controller.
 *   • A platform-fallback notice with an "I understand" checkbox
 *     shown only when the chosen model is `source:
 *     "platform-fallback"`.
 *   • A "Launch" button disabled while `controller.canLaunch()` is
 *     `false` (Requirement 6.5).
 *   • An inline error surface for `CreateTaskError`-shaped codes
 *     surfaced through `submit.kind === "error"`.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.5.
 */

import type {
  AgentPickerOption,
  ModelInfo,
  ModelRef,
  ProviderModelsResult,
  TaskBuilderErrorCode,
  TaskBuilderState,
  TaskBuilderSubmitStatus,
} from "./types.js";
import type { TaskBuilderController } from "./taskBuilder.js";

/** Options for {@link mountTaskBuilderScreen}. */
export interface MountTaskBuilderScreenOptions {
  readonly root: HTMLElement;
  readonly controller: TaskBuilderController;
  /**
   * Available models grouped by provider. Hosts pass the snapshot
   * from their model-catalog source (e.g. the
   * `ModelSelectionController.getState().providers` array). Error
   * provider entries are surfaced inline so the user can tell a
   * provider failed to load.
   */
  readonly availableModels: readonly ProviderModelsResult[];
  /**
   * Agents the user can pick from in Manual_Mode. Hosts typically
   * compose this from the five Builtin_Agent roles plus the user's
   * Custom_Agents.
   */
  readonly availableAgents: readonly AgentPickerOption[];
  /**
   * Optional override for the document the renderer uses. Defaults
   * to `globalThis.document`. Tests pass a JSDOM `document` to
   * render into a detached root.
   */
  readonly document?: Document;
}

/**
 * Result of {@link mountTaskBuilderScreen}. The host calls
 * `unmount()` to detach DOM listeners and stop receiving state
 * updates (used when the shell transitions to the next screen).
 */
export interface MountTaskBuilderScreenResult {
  unmount(): void;
}

/**
 * Renders the Task Builder screen into `root` and wires it to
 * `controller`.
 */
export function mountTaskBuilderScreen(
  options: MountTaskBuilderScreenOptions,
): MountTaskBuilderScreenResult {
  const doc =
    options.document ?? options.root.ownerDocument ?? globalThis.document;
  if (!doc) {
    throw new Error(
      "mountTaskBuilderScreen: no Document available. Pass `options.document` " +
        "in test/jsdom hosts.",
    );
  }
  const root = options.root;
  const controller = options.controller;
  const availableModels = options.availableModels;
  const availableAgents = options.availableAgents;

  root.innerHTML = "";
  root.classList.add("task-builder");

  // -------------------------------------------------------------------------
  // Static structure
  // -------------------------------------------------------------------------

  const heading = doc.createElement("h2");
  heading.className = "task-builder__heading";
  heading.textContent = "New task";

  const form = doc.createElement("form");
  form.className = "task-builder__form";
  form.setAttribute("novalidate", "novalidate");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (controller.canLaunch()) {
      void controller.submit();
    }
  });

  // ---- Prompt ----
  const promptLabel = doc.createElement("label");
  promptLabel.className = "task-builder__field";
  const promptLabelText = doc.createElement("span");
  promptLabelText.className = "task-builder__field-label";
  promptLabelText.textContent = "Prompt";
  const promptTextarea = doc.createElement("textarea");
  promptTextarea.className = "task-builder__prompt";
  promptTextarea.name = "prompt";
  promptTextarea.rows = 6;
  promptTextarea.placeholder =
    "Describe what you want the agents to do…";
  promptTextarea.required = true;
  promptLabel.append(promptLabelText, promptTextarea);

  // ---- Model selector ----
  const modelLabel = doc.createElement("label");
  modelLabel.className = "task-builder__field";
  const modelLabelText = doc.createElement("span");
  modelLabelText.className = "task-builder__field-label";
  modelLabelText.textContent = "Model";
  const modelSelect = doc.createElement("select");
  modelSelect.className = "task-builder__model-select";
  modelSelect.name = "model";

  // Index from option-value → ModelRef so the change handler can
  // resolve the chosen `<option>` back to a structured ref without
  // re-walking `availableModels`.
  const modelByValue = new Map<string, ModelRef>();
  populateModelOptions(doc, modelSelect, availableModels, modelByValue);
  modelLabel.append(modelLabelText, modelSelect);

  // Inline notice rendered when a model could not be loaded for one
  // of the providers (per Requirement 5.3 — provider isolation).
  const modelErrors = doc.createElement("ul");
  modelErrors.className = "task-builder__model-errors";
  renderModelProviderErrors(doc, modelErrors, availableModels);

  // ---- Mode toggle ----
  const modeFieldset = doc.createElement("fieldset");
  modeFieldset.className = "task-builder__mode";
  const modeLegend = doc.createElement("legend");
  modeLegend.className = "task-builder__field-label";
  modeLegend.textContent = "Mode";
  modeFieldset.append(modeLegend);

  const autoLabel = doc.createElement("label");
  autoLabel.className = "task-builder__mode-option";
  const autoRadio = doc.createElement("input");
  autoRadio.type = "radio";
  autoRadio.name = "mode";
  autoRadio.value = "auto";
  const autoText = doc.createElement("span");
  autoText.textContent = "Auto — orchestrator picks agents";
  autoLabel.append(autoRadio, autoText);

  const manualLabel = doc.createElement("label");
  manualLabel.className = "task-builder__mode-option";
  const manualRadio = doc.createElement("input");
  manualRadio.type = "radio";
  manualRadio.name = "mode";
  manualRadio.value = "manual";
  const manualText = doc.createElement("span");
  manualText.textContent = "Manual — I pick agents";
  manualLabel.append(manualRadio, manualText);

  modeFieldset.append(autoLabel, manualLabel);

  // ---- Agent picker (manual only) ----
  const agentsFieldset = doc.createElement("fieldset");
  agentsFieldset.className = "task-builder__agents";
  const agentsLegend = doc.createElement("legend");
  agentsLegend.className = "task-builder__field-label";
  agentsLegend.textContent = "Agents";
  agentsFieldset.append(agentsLegend);

  const agentCheckboxes = new Map<string, HTMLInputElement>();
  if (availableAgents.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "task-builder__agents-empty";
    empty.textContent = "No agents available.";
    agentsFieldset.append(empty);
  } else {
    for (const agent of availableAgents) {
      const row = doc.createElement("label");
      row.className = "task-builder__agent-option";
      row.dataset["agentId"] = agent.id;
      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "participants";
      checkbox.value = agent.id;
      const label = doc.createElement("span");
      label.className = "task-builder__agent-label";
      label.textContent = agent.displayName;
      row.append(checkbox, label);
      if (agent.description !== undefined && agent.description.length > 0) {
        const desc = doc.createElement("span");
        desc.className = "task-builder__agent-description";
        desc.textContent = agent.description;
        row.append(desc);
      }
      agentsFieldset.append(row);
      agentCheckboxes.set(agent.id, checkbox);
    }
  }

  // ---- Fallback confirmation ----
  const fallbackNotice = doc.createElement("div");
  fallbackNotice.className = "task-builder__fallback-notice";
  fallbackNotice.setAttribute("role", "alert");
  fallbackNotice.hidden = true;
  const fallbackText = doc.createElement("p");
  fallbackText.className = "task-builder__fallback-text";
  fallbackText.textContent =
    "You're about to launch with a platform fallback model. Quality may be reduced; usage is rate-limited.";
  const fallbackConfirmLabel = doc.createElement("label");
  fallbackConfirmLabel.className = "task-builder__fallback-confirm";
  const fallbackConfirmCheckbox = doc.createElement("input");
  fallbackConfirmCheckbox.type = "checkbox";
  fallbackConfirmCheckbox.name = "confirmedFallback";
  const fallbackConfirmText = doc.createElement("span");
  fallbackConfirmText.textContent = "I understand and want to use the fallback model.";
  fallbackConfirmLabel.append(fallbackConfirmCheckbox, fallbackConfirmText);
  fallbackNotice.append(fallbackText, fallbackConfirmLabel);

  // ---- Launch button ----
  const actions = doc.createElement("div");
  actions.className = "task-builder__actions";
  const launchButton = doc.createElement("button");
  launchButton.type = "submit";
  launchButton.className = "task-builder__launch";
  launchButton.textContent = "Launch";
  launchButton.disabled = true;
  actions.append(launchButton);

  // ---- Inline status / error surface ----
  const statusLine = doc.createElement("p");
  statusLine.className = "task-builder__status";
  statusLine.setAttribute("aria-live", "polite");
  statusLine.textContent = "";

  const errorSurface = doc.createElement("p");
  errorSurface.className = "task-builder__error-surface";
  errorSurface.setAttribute("role", "alert");
  errorSurface.hidden = true;

  form.append(
    promptLabel,
    modelLabel,
    modelErrors,
    modeFieldset,
    agentsFieldset,
    fallbackNotice,
    actions,
    statusLine,
    errorSurface,
  );

  root.append(heading, form);

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  const onPromptInput = (): void =>
    controller.setPrompt(promptTextarea.value);
  const onModelChange = (): void => {
    const ref = modelByValue.get(modelSelect.value) ?? null;
    controller.setModel(ref);
  };
  const onAutoMode = (): void => controller.setMode("auto");
  const onManualMode = (): void => controller.setMode("manual");
  const onFallbackToggle = (): void =>
    controller.setConfirmedFallback(fallbackConfirmCheckbox.checked);

  const agentChangeHandlers = new Map<string, (e: Event) => void>();
  for (const [agentId, checkbox] of agentCheckboxes.entries()) {
    const handler = (): void => {
      if (checkbox.checked) {
        controller.addParticipant(agentId);
      } else {
        controller.removeParticipant(agentId);
      }
    };
    checkbox.addEventListener("change", handler);
    agentChangeHandlers.set(agentId, handler);
  }

  promptTextarea.addEventListener("input", onPromptInput);
  modelSelect.addEventListener("change", onModelChange);
  autoRadio.addEventListener("change", onAutoMode);
  manualRadio.addEventListener("change", onManualMode);
  fallbackConfirmCheckbox.addEventListener("change", onFallbackToggle);

  // -------------------------------------------------------------------------
  // State → DOM bridge
  // -------------------------------------------------------------------------

  function applyState(state: TaskBuilderState): void {
    // Prompt textarea (avoid clobbering uncommitted IME composition by
    // diffing first).
    if (promptTextarea.value !== state.prompt) {
      promptTextarea.value = state.prompt;
    }

    // Model selector.
    const modelValue = state.modelRef ? modelRefToValue(state.modelRef) : "";
    if (modelSelect.value !== modelValue) {
      modelSelect.value = modelValue;
    }

    // Mode radios.
    autoRadio.checked = state.mode === "auto";
    manualRadio.checked = state.mode === "manual";

    // Agent picker visibility (Requirement 6.2 — only relevant in Manual).
    agentsFieldset.hidden = state.mode !== "manual";

    // Sync agent checkboxes from state. We compare each checkbox's
    // current state to the controller's list so the renderer keeps
    // working when the controller is driven externally (e.g. tests
    // pre-seeding the participants).
    for (const [agentId, checkbox] of agentCheckboxes.entries()) {
      const shouldBeChecked = state.participants.includes(agentId);
      if (checkbox.checked !== shouldBeChecked) {
        checkbox.checked = shouldBeChecked;
      }
    }

    // Fallback notice.
    const isFallback =
      state.modelRef !== null &&
      state.modelRef.source === "platform-fallback";
    fallbackNotice.hidden = !isFallback;
    if (fallbackConfirmCheckbox.checked !== state.confirmedFallback) {
      fallbackConfirmCheckbox.checked = state.confirmedFallback;
    }

    // Launch gating.
    launchButton.disabled = !controller.canLaunch();
    launchButton.textContent =
      state.submit.kind === "submitting" ? "Launching…" : "Launch";

    // Status / error surface.
    renderSubmitSurface(state.submit, statusLine, errorSurface);
  }

  const unsubscribe = controller.subscribeState(applyState);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  function unmount(): void {
    unsubscribe();
    promptTextarea.removeEventListener("input", onPromptInput);
    modelSelect.removeEventListener("change", onModelChange);
    autoRadio.removeEventListener("change", onAutoMode);
    manualRadio.removeEventListener("change", onManualMode);
    fallbackConfirmCheckbox.removeEventListener("change", onFallbackToggle);
    for (const [agentId, checkbox] of agentCheckboxes.entries()) {
      const handler = agentChangeHandlers.get(agentId);
      if (handler) checkbox.removeEventListener("change", handler);
    }
    root.innerHTML = "";
    root.classList.remove("task-builder");
  }

  return { unmount };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encodes a `ModelRef` as a stable `<option value>` string.
 *
 * Uses `\u0001` as a separator so it cannot collide with characters
 * found in a typical provider/modelId. The mount helper round-trips
 * through {@link modelRefToValue} when applying state.
 */
function modelRefToValue(ref: ModelRef): string {
  return `${ref.provider}\u0001${ref.modelId}\u0001${ref.source}`;
}

function populateModelOptions(
  doc: Document,
  select: HTMLSelectElement,
  providers: readonly ProviderModelsResult[],
  index: Map<string, ModelRef>,
): void {
  // First option is a placeholder so the user has to make an explicit
  // choice — the controller's `modelRef === null` invariant relies on
  // this.
  const placeholder = doc.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a model…";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.append(placeholder);

  for (const provider of providers) {
    if (provider.status !== "ok") continue;
    if (provider.models.length === 0) continue;
    const group = doc.createElement("optgroup");
    group.label = provider.provider;
    for (const model of provider.models) {
      group.append(buildModelOption(doc, model, index));
    }
    select.append(group);
  }
}

function buildModelOption(
  doc: Document,
  model: ModelInfo,
  index: Map<string, ModelRef>,
): HTMLOptionElement {
  const option = doc.createElement("option");
  const ref: ModelRef = {
    provider: model.provider,
    modelId: model.modelId,
    source: model.source,
  };
  const value = modelRefToValue(ref);
  index.set(value, ref);
  option.value = value;
  // Visually mark fallback models so users cannot confuse them with
  // their own keys (Requirement 5.5).
  const suffix = model.source === "platform-fallback" ? " — Platform fallback" : "";
  option.textContent = `${model.displayName}${suffix}`;
  option.dataset["source"] = model.source;
  return option;
}

function renderModelProviderErrors(
  doc: Document,
  list: HTMLElement,
  providers: readonly ProviderModelsResult[],
): void {
  list.innerHTML = "";
  for (const provider of providers) {
    if (provider.status !== "error") continue;
    const item = doc.createElement("li");
    item.className = "task-builder__model-error";
    item.dataset["provider"] = provider.provider;
    item.textContent = `Could not load ${provider.provider}: ${provider.reason}`;
    list.append(item);
  }
}

function renderSubmitSurface(
  submit: TaskBuilderSubmitStatus,
  statusLine: HTMLElement,
  errorSurface: HTMLElement,
): void {
  switch (submit.kind) {
    case "idle":
      statusLine.textContent = "";
      delete statusLine.dataset["state"];
      errorSurface.hidden = true;
      errorSurface.textContent = "";
      delete errorSurface.dataset["code"];
      return;
    case "submitting":
      statusLine.textContent = "Launching task…";
      statusLine.dataset["state"] = "submitting";
      errorSurface.hidden = true;
      errorSurface.textContent = "";
      delete errorSurface.dataset["code"];
      return;
    case "submitted":
      statusLine.textContent = `Task ${submit.taskId} created.`;
      statusLine.dataset["state"] = "submitted";
      errorSurface.hidden = true;
      errorSurface.textContent = "";
      delete errorSurface.dataset["code"];
      return;
    case "error":
      statusLine.textContent = "";
      delete statusLine.dataset["state"];
      errorSurface.hidden = false;
      errorSurface.textContent = renderErrorMessage(submit.code, submit.message);
      errorSurface.dataset["code"] = submit.code;
      return;
  }
}

/**
 * Renders an inline error string for a `CreateTaskError`-shaped code.
 * Falls back to the gateway's verbatim message for codes the UI does
 * not have a specialised wording for.
 */
function renderErrorMessage(
  code: TaskBuilderErrorCode,
  message: string,
): string {
  switch (code) {
    case "empty_prompt":
      return "Prompt is required.";
    case "manual_mode_zero_participants":
      return "Manual mode requires at least one participant agent.";
    case "model_unavailable":
      return `Selected model is not available: ${message}`;
    case "fallback_not_confirmed":
      return "Confirm fallback usage before launching.";
    case "auto_mode_no_participants":
      return "Auto mode could not pick any agents for this prompt.";
    case "persistence_failed":
      return `Could not save the task: ${message}`;
    case "invalid_input":
      return `Invalid input: ${message}`;
    case "unknown":
      return message.length > 0 ? message : "Unknown error.";
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}
