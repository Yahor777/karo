/**
 * Framework-free DOM render for the Model Selection screen.
 *
 * Mirrors the imperative style used by
 * `apps/desktop-windows/src/ui/bootstrap.ts`: build elements with
 * `document.createElement`, attach listeners, and re-render on state
 * change. No virtual DOM, no third-party UI library.
 *
 * Behaviour matrix (per Requirements 5.2, 5.3, 5.5):
 *
 *   • Providers are grouped into collapsible sections, in the order the
 *     gateway returned them. A failing provider shows an inline error
 *     banner with its `reason` but does NOT block sibling providers
 *     from rendering their model lists (Requirement 5.3).
 *   • Models with `source === "platform-fallback"` carry a visible
 *     "Platform fallback" badge so users cannot confuse them with their
 *     own keys (Requirement 5.5).
 *   • Clicking a fallback model surfaces a confirmation banner; the
 *     "Use this model" button stays disabled until
 *     `controller.confirmFallback()` runs. User-key models apply
 *     immediately (Requirement 5.5 "no silent substitution").
 *
 * Validates: Requirements 5.2, 5.3, 5.5.
 */

import type {
  ModelInfo,
  ModelRef,
  ProviderModelsResult,
} from "./types.js";
import type {
  ModelSelectionController,
  ModelSelectionState,
} from "./modelSelection.js";

/**
 * Mounts the Model Selection screen into `root`.
 *
 *   • Replaces any existing children of `root`.
 *   • Subscribes to the controller for live updates.
 *   • Returns a teardown function that detaches the listener and
 *     empties `root`. Callers are expected to invoke it before
 *     re-mounting or unloading the screen so listeners do not leak.
 */
export function mountModelSelection(
  root: HTMLElement,
  controller: ModelSelectionController,
): () => void {
  root.innerHTML = "";
  root.classList.add("model-selection");

  // Persist provider expand/collapse state across re-renders. Keyed by
  // provider id so refreshing the catalog does not collapse sections
  // the user explicitly opened.
  const expanded = new Set<string>();

  const heading = document.createElement("h2");
  heading.className = "model-selection__title";
  heading.textContent = "Choose a model";

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "model-selection__refresh";
  refreshButton.textContent = "Refresh";
  refreshButton.addEventListener("click", () => {
    void controller.refresh();
  });

  const statusBar = document.createElement("p");
  statusBar.className = "model-selection__status";
  statusBar.setAttribute("aria-live", "polite");

  const fallbackBanner = document.createElement("div");
  fallbackBanner.className = "model-selection__fallback-banner";
  fallbackBanner.setAttribute("role", "alert");
  fallbackBanner.hidden = true;

  const fallbackText = document.createElement("p");
  fallbackText.className = "model-selection__fallback-text";

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "model-selection__fallback-confirm";
  confirmButton.textContent = "Use platform fallback";
  confirmButton.addEventListener("click", () => {
    controller.confirmFallback();
  });

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "model-selection__fallback-cancel";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => {
    controller.cancelPendingFallback();
  });

  fallbackBanner.append(fallbackText, confirmButton, cancelButton);

  const providersList = document.createElement("ul");
  providersList.className = "model-selection__providers";

  root.append(heading, refreshButton, statusBar, fallbackBanner, providersList);

  function render(state: ModelSelectionState): void {
    renderStatus(statusBar, refreshButton, state);
    renderFallbackBanner(fallbackBanner, fallbackText, confirmButton, state);
    renderProviders(providersList, state, expanded, controller);
  }

  render(controller.getState());
  const unsubscribe = controller.subscribe(render);

  return () => {
    unsubscribe();
    root.innerHTML = "";
    root.classList.remove("model-selection");
  };
}

function renderStatus(
  statusBar: HTMLElement,
  refreshButton: HTMLButtonElement,
  state: ModelSelectionState,
): void {
  switch (state.status.kind) {
    case "idle":
      statusBar.textContent = "";
      refreshButton.disabled = false;
      break;
    case "loading":
      statusBar.textContent = "Loading models…";
      refreshButton.disabled = true;
      break;
    case "ready":
      statusBar.textContent = "";
      refreshButton.disabled = false;
      break;
    case "error":
      statusBar.textContent = `Failed to load models: ${state.status.reason}`;
      statusBar.dataset["state"] = "error";
      refreshButton.disabled = false;
      break;
  }
  if (state.status.kind !== "error") {
    delete statusBar.dataset["state"];
  }
}

function renderFallbackBanner(
  banner: HTMLElement,
  text: HTMLElement,
  confirmButton: HTMLButtonElement,
  state: ModelSelectionState,
): void {
  if (state.pendingFallback === null) {
    banner.hidden = true;
    text.textContent = "";
    confirmButton.disabled = true;
    return;
  }
  banner.hidden = false;
  text.textContent = state.pendingFallback.notice;
  confirmButton.disabled = false;
}

function renderProviders(
  list: HTMLElement,
  state: ModelSelectionState,
  expanded: Set<string>,
  controller: ModelSelectionController,
): void {
  list.innerHTML = "";

  if (state.providers.length === 0) {
    const empty = document.createElement("li");
    empty.className = "model-selection__empty";
    empty.textContent =
      state.status.kind === "loading"
        ? "Loading providers…"
        : "No providers configured. Add an API key to see models.";
    list.append(empty);
    return;
  }

  for (const provider of state.providers) {
    list.append(renderProviderSection(provider, state, expanded, controller));
  }
}

function renderProviderSection(
  provider: ProviderModelsResult,
  state: ModelSelectionState,
  expanded: Set<string>,
  controller: ModelSelectionController,
): HTMLElement {
  const section = document.createElement("li");
  section.className = "model-selection__provider";
  section.dataset["provider"] = provider.provider;
  section.dataset["status"] = provider.status;

  const isOpen = expanded.has(provider.provider);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "model-selection__provider-toggle";
  toggle.setAttribute("aria-expanded", String(isOpen));
  toggle.textContent = `${isOpen ? "▾" : "▸"} ${provider.provider}`;
  toggle.addEventListener("click", () => {
    if (expanded.has(provider.provider)) {
      expanded.delete(provider.provider);
    } else {
      expanded.add(provider.provider);
    }
    // Force a re-render by re-reading current state.
    const parent = section.parentElement;
    if (parent) {
      renderProviders(parent, controller.getState(), expanded, controller);
    }
  });

  section.append(toggle);

  if (provider.status === "error") {
    // Provider isolation: a failing provider shows an inline banner but
    // its section still renders so the user knows which provider broke.
    const errorBanner = document.createElement("p");
    errorBanner.className = "model-selection__provider-error";
    errorBanner.setAttribute("role", "alert");
    errorBanner.textContent = `Could not load ${provider.provider} models: ${provider.reason}`;
    section.append(errorBanner);
    return section;
  }

  if (!isOpen) {
    return section;
  }

  const modelsList = document.createElement("ul");
  modelsList.className = "model-selection__models";

  if (provider.models.length === 0) {
    const empty = document.createElement("li");
    empty.className = "model-selection__models-empty";
    empty.textContent = `No models available for ${provider.provider}.`;
    modelsList.append(empty);
  } else {
    for (const model of provider.models) {
      modelsList.append(renderModelRow(model, state, controller));
    }
  }

  section.append(modelsList);
  return section;
}

function renderModelRow(
  model: ModelInfo,
  state: ModelSelectionState,
  controller: ModelSelectionController,
): HTMLElement {
  const row = document.createElement("li");
  row.className = "model-selection__model";
  row.dataset["modelId"] = model.modelId;
  row.dataset["source"] = model.source;

  const isSelected =
    state.selectedModelRef !== null &&
    state.selectedModelRef.provider === model.provider &&
    state.selectedModelRef.modelId === model.modelId &&
    state.selectedModelRef.source === model.source;

  const isPending =
    state.pendingFallback !== null &&
    state.pendingFallback.modelRef.provider === model.provider &&
    state.pendingFallback.modelRef.modelId === model.modelId &&
    state.pendingFallback.modelRef.source === model.source;

  if (isSelected) {
    row.dataset["selected"] = "true";
  }
  if (isPending) {
    row.dataset["pending"] = "true";
  }

  const label = document.createElement("span");
  label.className = "model-selection__model-name";
  label.textContent = model.displayName;
  row.append(label);

  if (model.source === "platform-fallback") {
    const badge = document.createElement("span");
    badge.className = "model-selection__badge model-selection__badge--fallback";
    badge.textContent = "Platform fallback";
    row.append(badge);
  }

  if (model.qualityTier === "basic") {
    const badge = document.createElement("span");
    badge.className = "model-selection__badge model-selection__badge--basic";
    badge.textContent = "Basic tier";
    row.append(badge);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "model-selection__model-select";
  if (model.source === "platform-fallback") {
    button.textContent = isPending
      ? "Pending confirmation…"
      : "Choose (requires confirmation)";
    // Disabled once already pending, so the renderer doesn't push the
    // same model into the pending slot twice.
    button.disabled = isPending;
  } else {
    button.textContent = isSelected ? "Selected" : "Select";
    button.disabled = isSelected;
  }

  button.addEventListener("click", () => {
    const ref: ModelRef = {
      provider: model.provider,
      modelId: model.modelId,
      source: model.source,
    };
    controller.setSelectedModel(ref);
  });

  row.append(button);
  return row;
}
