/**
 * DOM render shell for {@link LoginScreen} (task 4.3).
 *
 * Source:
 *   • design.md → "Session Modes" → "Local API-key-only mode".
 *   • requirements.md → Requirements 2.1, 2.2, 2.3, 2.4.
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
 *   • Entry-mode toggle (Requirement 2.1) — two buttons; the active
 *     one is marked with `aria-pressed="true"`.
 *   • API-key form (Requirement 2.2) — provider `<select>`, masked
 *     `<input type="password">` for the key, "Validate" button and a
 *     `<p>` validation feedback line.
 *   • Validation error surface (Requirement 2.3) — a dedicated `<p>`
 *     with `role="alert"` showing the Provider's
 *     `code: message` verbatim.
 *   • Save button + confirmation modal (Requirement 2.4) — Save is
 *     disabled until `validation.kind === "ok"`; pressing it opens a
 *     modal that explains what will be persisted and asks the user to
 *     confirm before any backend call happens.
 *   • "Sign in with Gmail" button — emits `requestGoogleOAuth` via the
 *     controller; the actual OAuth wiring lands in task 17.4.
 *
 * Accessibility:
 *
 *   • Validation feedback uses `aria-live="polite"`.
 *   • The confirmation modal uses `role="dialog"` + `aria-modal="true"`.
 *   • The error surface uses `role="alert"` so it is announced.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4.
 */

import { findProviderPreset } from "@ai-agent-orchestrator/shared-core";

import type { LoginScreen } from "./loginScreen.js";
import type {
  LoginEntryMode,
  LoginSaveStatus,
  LoginState,
  LoginValidationStatus,
  ProviderId,
} from "./types.js";

/** Options for {@link mountLoginScreen}. */
export interface MountLoginScreenOptions {
  /** Provider IDs to expose in the dropdown. */
  readonly providerOptions?: readonly ProviderId[];
  /**
   * Optional override for the document the renderer uses. Defaults to
   * `globalThis.document`. Tests pass a JSDOM `document` to render
   * into a detached root.
   */
  readonly doc?: Document;
}

const DEFAULT_PROVIDER_OPTIONS: readonly ProviderId[] = [
  "openai",
  "anthropic",
  "fireworks",
  "custom-openai",
];

/**
 * Result of {@link mountLoginScreen}. The host calls `unmount()` to
 * detach DOM listeners and stop receiving state updates (used when the
 * shell transitions to the next screen).
 */
export interface MountLoginScreenResult {
  unmount(): void;
}

/**
 * Renders the login screen into `root` and wires it to `controller`.
 *
 * The function is intentionally framework-free; every DOM mutation is
 * a `createElement`/`append`/property-set so a reviewer can read the
 * markup top-to-bottom without React/Vue context.
 */
export function mountLoginScreen(
  root: HTMLElement,
  controller: LoginScreen,
  options: MountLoginScreenOptions = {},
): MountLoginScreenResult {
  const doc = options.doc ?? globalThis.document;
  if (doc === undefined) {
    throw new Error(
      "mountLoginScreen: no document available. Pass `options.doc` " +
        "in test/jsdom hosts.",
    );
  }
  const providers = options.providerOptions ?? DEFAULT_PROVIDER_OPTIONS;

  root.innerHTML = "";

  // -------------------------------------------------------------------------
  // Static structure
  // -------------------------------------------------------------------------

  const heading = doc.createElement("h1");
  heading.textContent = "Sign in to AI Agent Orchestrator";
  heading.className = "login-heading";

  const subtitle = doc.createElement("p");
  subtitle.textContent =
    "Use your own LLM provider API key, or sign in with Gmail to sync settings.";
  subtitle.className = "login-subtitle";

  // Entry-mode toggle.
  const modeToggle = doc.createElement("div");
  modeToggle.className = "login-mode-toggle";
  modeToggle.setAttribute("role", "group");
  modeToggle.setAttribute("aria-label", "Choose login method");

  const modeApiKeyButton = doc.createElement("button");
  modeApiKeyButton.type = "button";
  modeApiKeyButton.className = "login-mode-button";
  modeApiKeyButton.dataset["mode"] = "apiKey";
  modeApiKeyButton.textContent = "Enter API key";

  const modeGoogleButton = doc.createElement("button");
  modeGoogleButton.type = "button";
  modeGoogleButton.className = "login-mode-button";
  modeGoogleButton.dataset["mode"] = "google";
  modeGoogleButton.textContent = "Sign in with Gmail";

  modeToggle.append(modeApiKeyButton, modeGoogleButton);

  // -------------------------------------------------------------------------
  // API-key form
  // -------------------------------------------------------------------------

  const apiKeyForm = doc.createElement("form");
  apiKeyForm.className = "login-apikey-form";
  apiKeyForm.setAttribute("aria-label", "API key sign-in form");
  // Prevent the default GET submission — we drive validate/save
  // through controller methods.
  apiKeyForm.addEventListener("submit", (e) => e.preventDefault());

  const providerLabel = doc.createElement("label");
  providerLabel.className = "login-field";
  const providerLabelText = doc.createElement("span");
  providerLabelText.textContent = "Provider";
  providerLabelText.className = "login-field-label";
  const providerSelect = doc.createElement("select");
  providerSelect.className = "login-field-input";
  providerSelect.name = "provider";
  for (const p of providers) {
    const opt = doc.createElement("option");
    opt.value = p;
    opt.textContent = providerDisplayName(p);
    providerSelect.appendChild(opt);
  }
  providerLabel.append(providerLabelText, providerSelect);

  const apiKeyLabel = doc.createElement("label");
  apiKeyLabel.className = "login-field";
  const apiKeyLabelText = doc.createElement("span");
  apiKeyLabelText.textContent = "API key";
  apiKeyLabelText.className = "login-field-label";
  const apiKeyInput = doc.createElement("input");
  apiKeyInput.type = "password";
  apiKeyInput.autocomplete = "off";
  apiKeyInput.spellcheck = false;
  apiKeyInput.className = "login-field-input";
  apiKeyInput.name = "apiKey";
  apiKeyInput.placeholder = "sk-…";
  apiKeyLabel.append(apiKeyLabelText, apiKeyInput);

  // Optional baseURL field — surfaced only for providers that allow
  // overrides (Custom always; well-known presets accept overrides for
  // staging gateways but the UI hides the field unless the user
  // explicitly enables it via the data-baseurl-toggle button).
  const baseUrlLabel = doc.createElement("label");
  baseUrlLabel.className = "login-field login-field-baseurl";
  const baseUrlLabelText = doc.createElement("span");
  baseUrlLabelText.textContent = "Base URL";
  baseUrlLabelText.className = "login-field-label";
  const baseUrlInput = doc.createElement("input");
  baseUrlInput.type = "url";
  baseUrlInput.autocomplete = "off";
  baseUrlInput.spellcheck = false;
  baseUrlInput.className = "login-field-input";
  baseUrlInput.name = "baseUrl";
  baseUrlInput.placeholder = "https://your-gateway.example.com/v1";
  baseUrlLabel.append(baseUrlLabelText, baseUrlInput);

  // Optional model id field — required for Fireworks AI / Custom
  // presets where there is no curated default. For OpenAI / Anthropic
  // the field is hidden because the catalog screen handles model
  // selection separately.
  const modelIdLabel = doc.createElement("label");
  modelIdLabel.className = "login-field login-field-modelid";
  const modelIdLabelText = doc.createElement("span");
  modelIdLabelText.textContent = "Model id";
  modelIdLabelText.className = "login-field-label";
  const modelIdInput = doc.createElement("input");
  modelIdInput.type = "text";
  modelIdInput.autocomplete = "off";
  modelIdInput.spellcheck = false;
  modelIdInput.className = "login-field-input";
  modelIdInput.name = "modelId";
  modelIdInput.placeholder = "e.g. accounts/fireworks/models/llama-v3p1-8b-instruct";
  modelIdLabel.append(modelIdLabelText, modelIdInput);

  // Action buttons row.
  const actionsRow = doc.createElement("div");
  actionsRow.className = "login-actions";

  const validateButton = doc.createElement("button");
  validateButton.type = "button";
  validateButton.className = "login-validate-button";
  validateButton.textContent = "Validate";

  const saveButton = doc.createElement("button");
  saveButton.type = "button";
  saveButton.className = "login-save-button";
  saveButton.textContent = "Save & continue";
  saveButton.disabled = true;

  actionsRow.append(validateButton, saveButton);

  // Validation feedback line.
  const validationLine = doc.createElement("p");
  validationLine.className = "login-validation-line";
  validationLine.setAttribute("aria-live", "polite");
  validationLine.textContent = "";

  // Provider error surface (Requirement 2.3). Distinct from the
  // validation feedback line so the UI can show, e.g., a "validating…"
  // status next to a still-visible last error without overlapping.
  const errorSurface = doc.createElement("p");
  errorSurface.className = "login-error-surface";
  errorSurface.setAttribute("role", "alert");
  errorSurface.hidden = true;

  apiKeyForm.append(
    providerLabel,
    apiKeyLabel,
    baseUrlLabel,
    modelIdLabel,
    actionsRow,
    validationLine,
    errorSurface,
  );

  // -------------------------------------------------------------------------
  // Google entry pane
  // -------------------------------------------------------------------------

  const googlePane = doc.createElement("div");
  googlePane.className = "login-google-pane";
  googlePane.hidden = true;
  const googleHelp = doc.createElement("p");
  googleHelp.className = "login-google-help";
  googleHelp.textContent =
    "We will open Google to verify your account, then sync settings between this device and the web app.";
  const googleButton = doc.createElement("button");
  googleButton.type = "button";
  googleButton.className = "login-google-button";
  googleButton.textContent = "Continue with Google";
  googlePane.append(googleHelp, googleButton);

  // -------------------------------------------------------------------------
  // Confirmation modal (Requirement 2.4)
  // -------------------------------------------------------------------------

  const modalBackdrop = doc.createElement("div");
  modalBackdrop.className = "login-modal-backdrop";
  modalBackdrop.hidden = true;

  const modal = doc.createElement("div");
  modal.className = "login-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "login-modal-title");

  const modalTitle = doc.createElement("h2");
  modalTitle.id = "login-modal-title";
  modalTitle.className = "login-modal-title";
  modalTitle.textContent = "Save API key on this device?";

  const modalBody = doc.createElement("p");
  modalBody.className = "login-modal-body";
  modalBody.textContent =
    "Your API key will be encrypted and stored locally on this Windows device. " +
    "It will not be uploaded to any cloud account.";

  const modalActions = doc.createElement("div");
  modalActions.className = "login-modal-actions";
  const modalCancel = doc.createElement("button");
  modalCancel.type = "button";
  modalCancel.className = "login-modal-cancel";
  modalCancel.textContent = "Cancel";
  const modalConfirm = doc.createElement("button");
  modalConfirm.type = "button";
  modalConfirm.className = "login-modal-confirm";
  modalConfirm.textContent = "Confirm and save";
  modalActions.append(modalCancel, modalConfirm);

  modal.append(modalTitle, modalBody, modalActions);
  modalBackdrop.appendChild(modal);

  // -------------------------------------------------------------------------
  // Mount
  // -------------------------------------------------------------------------

  root.append(heading, subtitle, modeToggle, apiKeyForm, googlePane, modalBackdrop);

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  const onModeApiKey = (): void => controller.setEntryMode("apiKey");
  const onModeGoogle = (): void => controller.setEntryMode("google");
  const onProviderChange = (): void =>
    controller.setProvider(providerSelect.value);
  const onApiKeyInput = (): void => controller.setApiKey(apiKeyInput.value);
  const onBaseUrlInput = (): void => controller.setBaseUrl(baseUrlInput.value);
  const onModelIdInput = (): void => controller.setModelId(modelIdInput.value);
  const onValidate = (): void => {
    void controller.validate();
  };
  const onRequestSave = (): void => controller.requestSave();
  const onCancelSave = (): void => controller.cancelSave();
  const onConfirmSave = (): void => {
    void controller.confirmAndSave();
  };
  const onGoogle = (): void => controller.requestGoogleOAuth();

  modeApiKeyButton.addEventListener("click", onModeApiKey);
  modeGoogleButton.addEventListener("click", onModeGoogle);
  providerSelect.addEventListener("change", onProviderChange);
  apiKeyInput.addEventListener("input", onApiKeyInput);
  baseUrlInput.addEventListener("input", onBaseUrlInput);
  modelIdInput.addEventListener("input", onModelIdInput);
  validateButton.addEventListener("click", onValidate);
  saveButton.addEventListener("click", onRequestSave);
  modalCancel.addEventListener("click", onCancelSave);
  modalConfirm.addEventListener("click", onConfirmSave);
  googleButton.addEventListener("click", onGoogle);

  // -------------------------------------------------------------------------
  // State → DOM bridge
  // -------------------------------------------------------------------------

  function applyState(state: LoginState): void {
    // Mode toggle.
    setPressed(modeApiKeyButton, state.entryMode === "apiKey");
    setPressed(modeGoogleButton, state.entryMode === "google");
    apiKeyForm.hidden = state.entryMode !== "apiKey";
    googlePane.hidden = state.entryMode !== "google";

    // Form fields.
    if (providerSelect.value !== state.provider) {
      providerSelect.value = state.provider;
    }
    if (apiKeyInput.value !== state.apiKey) {
      apiKeyInput.value = state.apiKey;
    }
    if (baseUrlInput.value !== state.baseUrl) {
      baseUrlInput.value = state.baseUrl;
    }
    if (modelIdInput.value !== state.modelId) {
      modelIdInput.value = state.modelId;
    }
    // Show baseURL only for presets that require it (Custom). Show
    // model id field for presets that require it (Fireworks, Custom).
    const preset = findProviderPreset(state.provider);
    baseUrlLabel.hidden = !(preset?.requiresUserBaseUrl === true);
    modelIdLabel.hidden = !(preset?.requiresUserModelId === true);

    // Validation feedback line.
    validationLine.textContent = renderValidationLine(state.validation);
    validationLine.dataset["status"] = state.validation.kind;

    // Provider error surface (Requirement 2.3).
    if (state.validation.kind === "error") {
      errorSurface.hidden = false;
      errorSurface.textContent =
        `${state.validation.providerCode}: ${state.validation.providerMessage}`;
      errorSurface.dataset["code"] = state.validation.providerCode;
    } else {
      errorSurface.hidden = true;
      errorSurface.textContent = "";
      delete errorSurface.dataset["code"];
    }

    // Save button gating (Requirement 2.4 — disable until validation succeeded).
    const canSave = controller.canRequestSave();
    saveButton.disabled =
      !canSave ||
      state.save.kind === "saving" ||
      state.save.kind === "saved";

    // Validate button can be in flight.
    validateButton.disabled =
      state.validation.kind === "validating" ||
      state.entryMode !== "apiKey";

    // Confirmation modal.
    const modalOpen =
      state.save.kind === "awaitingConfirmation" || state.save.kind === "saving";
    modalBackdrop.hidden = !modalOpen;
    modalConfirm.disabled = state.save.kind === "saving";
    modalCancel.disabled = state.save.kind === "saving";
    modalConfirm.textContent =
      state.save.kind === "saving" ? "Saving…" : "Confirm and save";

    // Save status surfaced beneath the actions row by reusing the
    // error surface for save errors and the validation line for the
    // "saved" success line.
    if (state.save.kind === "saved") {
      validationLine.textContent = "Signed in. Loading workspace…";
      validationLine.dataset["status"] = "saved";
    } else if (state.save.kind === "error") {
      errorSurface.hidden = false;
      const code = state.save.code ?? "save_failed";
      errorSurface.textContent = `${code}: ${state.save.message}`;
      errorSurface.dataset["code"] = code;
    }
  }

  const unsubscribe = controller.subscribeState(applyState);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  function unmount(): void {
    unsubscribe();
    modeApiKeyButton.removeEventListener("click", onModeApiKey);
    modeGoogleButton.removeEventListener("click", onModeGoogle);
    providerSelect.removeEventListener("change", onProviderChange);
    apiKeyInput.removeEventListener("input", onApiKeyInput);
    baseUrlInput.removeEventListener("input", onBaseUrlInput);
    modelIdInput.removeEventListener("input", onModelIdInput);
    validateButton.removeEventListener("click", onValidate);
    saveButton.removeEventListener("click", onRequestSave);
    modalCancel.removeEventListener("click", onCancelSave);
    modalConfirm.removeEventListener("click", onConfirmSave);
    googleButton.removeEventListener("click", onGoogle);
    root.innerHTML = "";
  }

  return { unmount };
}

function setPressed(button: HTMLButtonElement, pressed: boolean): void {
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
  if (pressed) {
    button.classList.add("is-active");
  } else {
    button.classList.remove("is-active");
  }
}

function providerDisplayName(p: ProviderId): string {
  switch (p) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "fireworks":
      return "Fireworks AI";
    case "custom-openai":
      return "Custom OpenAI-compatible";
    default:
      return p;
  }
}

function renderValidationLine(status: LoginValidationStatus): string {
  switch (status.kind) {
    case "idle":
      return "";
    case "validating":
      return "Validating with provider…";
    case "ok":
      return status.modelsCount === undefined
        ? "API key looks good."
        : `API key looks good. ${String(status.modelsCount)} model(s) available.`;
    case "error":
      return `Validation failed: ${status.providerMessage}`;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// Re-export entry-mode type for hosts that import directly from this
// module rather than through the package barrel.
export type { LoginEntryMode, LoginSaveStatus };
