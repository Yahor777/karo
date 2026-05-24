/**
 * DOM render shell for {@link LocalToCloudUpgradeScreen} (task 17.4).
 *
 * Source:
 *   • design.md → "Session Modes" → "Local-to-cloud upgrade mode".
 *   • requirements.md → Requirements 2.7, 2.8, 3.5.
 *
 * Framework-free renderer that mirrors the style of
 * `screens/login/mountLoginScreen.ts` and
 * `screens/gmailLogin/mountGmailLoginScreen.ts`. The controller owns
 * the state machine and gateway calls; this module owns the DOM and
 * listens to the controller's state stream.
 *
 * What this function renders:
 *
 *   • A heading + subtitle explaining the upgrade.
 *   • A confirmation modal (`role="dialog"` + `aria-modal="true"`)
 *     with two checkboxes:
 *       – "Sync local settings to my Google account"
 *       – "Sync local API keys to my Google account"
 *     Both default to UNCHECKED (Requirement 2.8). The Confirm button
 *     becomes the primary action; Cancel returns to the previous UI.
 *   • A status line wired to `aria-live="polite"` that surfaces
 *     "Upgrading…" while the gateway call is in flight.
 *   • A merge result section visible after success that lists the
 *     numbers of items copied / replaced / preserved per collection.
 *   • A "retry later" notice + Retry button when the status reaches
 *     `settingsLoadFailed` (Requirement 3.5).
 *   • A generic error notice + Retry button for other failures.
 *
 * Validates: Requirements 2.7, 2.8, 3.5.
 */

import type { LocalToCloudUpgradeScreen } from "./localToCloudUpgradeScreen.js";
import type {
  UpgradeMergeReport,
  UpgradeState,
  UpgradeStatus,
} from "./types.js";

/** Options for {@link mountLocalToCloudUpgradeScreen}. */
export interface MountLocalToCloudUpgradeScreenOptions {
  /**
   * Optional override for the document the renderer uses. Defaults to
   * `globalThis.document`. Tests pass a JSDOM `document` to render
   * into a detached root.
   */
  readonly doc?: Document;
}

/** Result of {@link mountLocalToCloudUpgradeScreen}. */
export interface MountLocalToCloudUpgradeScreenResult {
  unmount(): void;
}

/**
 * Renders the upgrade flow into `root` and wires it to `controller`.
 */
export function mountLocalToCloudUpgradeScreen(
  root: HTMLElement,
  controller: LocalToCloudUpgradeScreen,
  options: MountLocalToCloudUpgradeScreenOptions = {},
): MountLocalToCloudUpgradeScreenResult {
  const doc = options.doc ?? root.ownerDocument ?? globalThis.document;
  if (doc === undefined) {
    throw new Error(
      "mountLocalToCloudUpgradeScreen: no document available. Pass " +
        "`options.doc` in test/jsdom hosts.",
    );
  }

  root.innerHTML = "";

  // ---------------------------------------------------------------------
  // Static structure
  // ---------------------------------------------------------------------

  const heading = doc.createElement("h2");
  heading.className = "upgrade-heading";
  heading.textContent = "Sync your settings to Google";

  const subtitle = doc.createElement("p");
  subtitle.className = "upgrade-subtitle";
  subtitle.textContent =
    "We can copy your local settings and API keys to your Google account so you can keep working from the web app.";

  // Confirmation modal.
  const modal = doc.createElement("section");
  modal.className = "upgrade-confirm-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "upgrade-modal-title");
  modal.hidden = true;

  const modalTitle = doc.createElement("h3");
  modalTitle.id = "upgrade-modal-title";
  modalTitle.className = "upgrade-modal-title";
  modalTitle.textContent = "Confirm what you want to sync";

  const settingsLabel = doc.createElement("label");
  settingsLabel.className = "upgrade-confirm-settings";
  const settingsCheckbox = doc.createElement("input");
  settingsCheckbox.type = "checkbox";
  settingsCheckbox.name = "syncSettings";
  settingsCheckbox.checked = false;
  const settingsText = doc.createElement("span");
  settingsText.textContent = "Sync local settings (custom agents, preferences)";
  settingsLabel.append(settingsCheckbox, settingsText);

  const apiKeysLabel = doc.createElement("label");
  apiKeysLabel.className = "upgrade-confirm-api-keys";
  const apiKeysCheckbox = doc.createElement("input");
  apiKeysCheckbox.type = "checkbox";
  apiKeysCheckbox.name = "syncApiKeys";
  apiKeysCheckbox.checked = false;
  const apiKeysText = doc.createElement("span");
  apiKeysText.textContent = "Sync local API keys";
  apiKeysLabel.append(apiKeysCheckbox, apiKeysText);

  const apiKeysHint = doc.createElement("p");
  apiKeysHint.className = "upgrade-confirm-hint";
  apiKeysHint.textContent =
    "API keys never leave this device unless you tick the box above.";

  const confirmButton = doc.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "upgrade-confirm-button";
  confirmButton.textContent = "Confirm";

  const cancelButton = doc.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "upgrade-cancel-button";
  cancelButton.textContent = "Cancel";

  modal.append(
    modalTitle,
    settingsLabel,
    apiKeysLabel,
    apiKeysHint,
    confirmButton,
    cancelButton,
  );

  // Live status line.
  const statusLine = doc.createElement("p");
  statusLine.className = "upgrade-status";
  statusLine.setAttribute("aria-live", "polite");

  // Merge report.
  const mergeSurface = doc.createElement("section");
  mergeSurface.className = "upgrade-merge-report";
  mergeSurface.hidden = true;

  const mergeHeading = doc.createElement("h3");
  mergeHeading.textContent = "Sync complete";
  mergeHeading.className = "upgrade-merge-heading";

  const mergeSummary = doc.createElement("dl");
  mergeSummary.className = "upgrade-merge-summary";

  const mergeContinueButton = doc.createElement("button");
  mergeContinueButton.type = "button";
  mergeContinueButton.className = "upgrade-merge-continue";
  mergeContinueButton.textContent = "Continue";

  mergeSurface.append(mergeHeading, mergeSummary, mergeContinueButton);

  // Retry-later surface (Requirement 3.5).
  const retrySurface = doc.createElement("section");
  retrySurface.className = "upgrade-retry";
  retrySurface.setAttribute("role", "alert");
  retrySurface.hidden = true;

  const retryMessage = doc.createElement("p");
  retryMessage.className = "upgrade-retry-message";

  const retryButton = doc.createElement("button");
  retryButton.type = "button";
  retryButton.className = "upgrade-retry-button";
  retryButton.textContent = "Try again later";

  retrySurface.append(retryMessage, retryButton);

  // Generic error surface.
  const errorSurface = doc.createElement("section");
  errorSurface.className = "upgrade-error";
  errorSurface.setAttribute("role", "alert");
  errorSurface.hidden = true;

  const errorMessage = doc.createElement("p");
  errorMessage.className = "upgrade-error-message";

  const errorRetryButton = doc.createElement("button");
  errorRetryButton.type = "button";
  errorRetryButton.className = "upgrade-error-retry";
  errorRetryButton.textContent = "Retry";

  errorSurface.append(errorMessage, errorRetryButton);

  root.append(
    heading,
    subtitle,
    modal,
    statusLine,
    mergeSurface,
    retrySurface,
    errorSurface,
  );

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------

  const onSettingsToggle = (): void => {
    controller.setSyncSettings(settingsCheckbox.checked);
  };
  const onApiKeysToggle = (): void => {
    controller.setSyncApiKeys(apiKeysCheckbox.checked);
  };
  const onConfirm = (): void => {
    void controller.confirm();
  };
  const onCancel = (): void => controller.cancel();
  const onRetryLater = (): void => controller.reset();
  const onErrorRetry = (): void => controller.reset();
  const onMergeContinue = (): void => controller.reset();

  settingsCheckbox.addEventListener("change", onSettingsToggle);
  apiKeysCheckbox.addEventListener("change", onApiKeysToggle);
  confirmButton.addEventListener("click", onConfirm);
  cancelButton.addEventListener("click", onCancel);
  retryButton.addEventListener("click", onRetryLater);
  errorRetryButton.addEventListener("click", onErrorRetry);
  mergeContinueButton.addEventListener("click", onMergeContinue);

  // ---------------------------------------------------------------------
  // State → DOM bridge
  // ---------------------------------------------------------------------

  function applyState(state: UpgradeState): void {
    const status = state.status;
    statusLine.dataset["status"] = status.kind;
    statusLine.textContent = renderStatusLine(status);

    // Modal.
    if (status.kind === "awaitingConfirmation" || status.kind === "upgrading") {
      modal.hidden = false;
      settingsCheckbox.checked = status.syncSettings;
      apiKeysCheckbox.checked = status.syncApiKeys;
      const busy = status.kind === "upgrading";
      settingsCheckbox.disabled = busy;
      apiKeysCheckbox.disabled = busy;
      confirmButton.disabled = busy;
      cancelButton.disabled = busy;
      confirmButton.textContent = busy ? "Syncing…" : "Confirm";
    } else {
      modal.hidden = true;
      // Reset checkboxes when the modal is hidden so the next opening
      // starts from the controller's defaults rather than whatever the
      // user toggled previously.
      settingsCheckbox.disabled = false;
      apiKeysCheckbox.disabled = false;
      confirmButton.disabled = false;
      cancelButton.disabled = false;
    }

    // Merge report.
    if (status.kind === "completed") {
      mergeSurface.hidden = false;
      mergeSummary.innerHTML = "";
      for (const row of summarizeReport(status.mergeReport)) {
        const dt = doc.createElement("dt");
        dt.textContent = row.label;
        const dd = doc.createElement("dd");
        dd.textContent = String(row.value);
        dd.dataset["mergeKey"] = row.key;
        mergeSummary.append(dt, dd);
      }
    } else {
      mergeSurface.hidden = true;
      mergeSummary.innerHTML = "";
    }

    // Retry-later surface.
    if (status.kind === "settingsLoadFailed") {
      retrySurface.hidden = false;
      retryMessage.textContent = status.message;
    } else {
      retrySurface.hidden = true;
      retryMessage.textContent = "";
    }

    // Generic error surface.
    if (status.kind === "error") {
      errorSurface.hidden = false;
      const code = status.code ?? "error";
      errorMessage.textContent = `${code}: ${status.message}`;
      errorMessage.dataset["code"] = code;
    } else {
      errorSurface.hidden = true;
      errorMessage.textContent = "";
      delete errorMessage.dataset["code"];
    }
  }

  const unsubscribe = controller.subscribeState(applyState);

  function unmount(): void {
    unsubscribe();
    settingsCheckbox.removeEventListener("change", onSettingsToggle);
    apiKeysCheckbox.removeEventListener("change", onApiKeysToggle);
    confirmButton.removeEventListener("click", onConfirm);
    cancelButton.removeEventListener("click", onCancel);
    retryButton.removeEventListener("click", onRetryLater);
    errorRetryButton.removeEventListener("click", onErrorRetry);
    mergeContinueButton.removeEventListener("click", onMergeContinue);
    root.innerHTML = "";
  }

  return { unmount };
}

function renderStatusLine(status: UpgradeStatus): string {
  switch (status.kind) {
    case "idle":
      return "";
    case "awaitingConfirmation":
      return "Choose what to sync, then press Confirm.";
    case "upgrading":
      return "Syncing your settings to Google…";
    case "completed":
      return "Sync complete.";
    case "settingsLoadFailed":
      return "Couldn't load your settings. Please try again later.";
    case "error":
      return `Sync failed: ${status.message}`;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

interface MergeRow {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

/**
 * Flattens the merge report into a small dl-friendly summary. Numbers
 * mirror the per-collection categories defined by
 * `apps/backend/src/auth/upgradeLocalSession.ts → MergeReport`.
 */
function summarizeReport(report: UpgradeMergeReport): readonly MergeRow[] {
  return [
    {
      key: "apiKeys.copied",
      label: "API keys copied to cloud",
      value: report.apiKeys.copiedToCloud.length,
    },
    {
      key: "apiKeys.cloudWon",
      label: "API keys where cloud already had a value",
      value: report.apiKeys.cloudWonOver.length,
    },
    {
      key: "apiKeys.preservedLocalOnly",
      label: "API keys preserved as local-only",
      value: report.apiKeys.preservedLocalOnly.length,
    },
    {
      key: "customAgents.copied",
      label: "Custom agents copied to cloud",
      value: report.customAgents.copiedToCloud.length,
    },
    {
      key: "customAgents.conflicts",
      label: "Custom agents with name conflicts",
      value: report.customAgents.conflicts.length,
    },
    {
      key: "preferences.copied",
      label: "Preferences copied to cloud",
      value: report.preferences.copiedToCloud.length,
    },
    {
      key: "preferences.cloudWon",
      label: "Preferences where cloud already had a value",
      value: report.preferences.cloudWon.length,
    },
  ];
}
