/**
 * DOM render shell for {@link GmailLoginScreen} (task 17.4).
 *
 * Source:
 *   • design.md → "Session Modes" → "Gmail cloud-sync mode".
 *   • requirements.md → Requirements 3.1, 3.5.
 *
 * Framework-free renderer that mirrors the style of
 * `screens/login/mountLoginScreen.ts`. The controller owns the state
 * machine and gateway calls; this module owns the DOM and listens to
 * the controller's state stream.
 *
 * What this function renders:
 *
 *   • A heading + intro paragraph explaining the flow.
 *   • A "Continue with Google" button (visible while `status.kind` is
 *     `idle | starting | redirecting`).
 *   • A live status line wired to `aria-live="polite"` that surfaces
 *     "Redirecting to Google…" / "Completing sign-in…" / final
 *     outcomes (Requirements 3.1, 3.5).
 *   • A "retry later" notice + Retry button when the status reaches
 *     `settingsLoadFailed` (Requirement 3.5).
 *   • A generic error notice + Retry button for other failures.
 *
 * Validates: Requirements 3.1, 3.5.
 */

import type { GmailLoginScreen } from "./gmailLoginScreen.js";
import type { GmailLoginState, GmailLoginStatus } from "./types.js";

/** Options for {@link mountGmailLoginScreen}. */
export interface MountGmailLoginScreenOptions {
  /**
   * Optional override for the document the renderer uses. Defaults to
   * `globalThis.document`. Tests pass a JSDOM `document` to render
   * into a detached root.
   */
  readonly doc?: Document;
}

/** Result of {@link mountGmailLoginScreen}. */
export interface MountGmailLoginScreenResult {
  unmount(): void;
}

/**
 * Renders the Gmail login flow into `root` and wires it to
 * `controller`.
 */
export function mountGmailLoginScreen(
  root: HTMLElement,
  controller: GmailLoginScreen,
  options: MountGmailLoginScreenOptions = {},
): MountGmailLoginScreenResult {
  const doc = options.doc ?? root.ownerDocument ?? globalThis.document;
  if (doc === undefined) {
    throw new Error(
      "mountGmailLoginScreen: no document available. Pass `options.doc` " +
        "in test/jsdom hosts.",
    );
  }

  root.innerHTML = "";

  // -------------------------------------------------------------------------
  // Static structure
  // -------------------------------------------------------------------------

  const heading = doc.createElement("h2");
  heading.className = "gmail-login-heading";
  heading.textContent = "Sign in with Google";

  const subtitle = doc.createElement("p");
  subtitle.className = "gmail-login-subtitle";
  subtitle.textContent =
    "We will open Google to verify your account, then sync your settings between this device and the web app.";

  const continueButton = doc.createElement("button");
  continueButton.type = "button";
  continueButton.className = "gmail-login-continue";
  continueButton.textContent = "Continue with Google";

  const statusLine = doc.createElement("p");
  statusLine.className = "gmail-login-status";
  statusLine.setAttribute("aria-live", "polite");
  statusLine.textContent = "";

  // Settings-load-failed surface (Requirement 3.5). A dedicated region
  // so screen readers announce the retry-later message even when the
  // status line is also updated.
  const retrySurface = doc.createElement("section");
  retrySurface.className = "gmail-login-retry";
  retrySurface.setAttribute("role", "alert");
  retrySurface.hidden = true;

  const retryMessage = doc.createElement("p");
  retryMessage.className = "gmail-login-retry-message";
  retryMessage.textContent = "";

  const retryButton = doc.createElement("button");
  retryButton.type = "button";
  retryButton.className = "gmail-login-retry-button";
  retryButton.textContent = "Try again later";

  retrySurface.append(retryMessage, retryButton);

  // Generic error surface (anything other than settings_load_failed).
  const errorSurface = doc.createElement("section");
  errorSurface.className = "gmail-login-error";
  errorSurface.setAttribute("role", "alert");
  errorSurface.hidden = true;

  const errorMessage = doc.createElement("p");
  errorMessage.className = "gmail-login-error-message";
  errorMessage.textContent = "";

  const errorRetryButton = doc.createElement("button");
  errorRetryButton.type = "button";
  errorRetryButton.className = "gmail-login-error-retry";
  errorRetryButton.textContent = "Retry";

  errorSurface.append(errorMessage, errorRetryButton);

  root.append(heading, subtitle, continueButton, statusLine, retrySurface, errorSurface);

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  const onContinue = (): void => {
    void controller.start();
  };
  const onRetryLater = (): void => controller.reset();
  const onErrorRetry = (): void => controller.reset();

  continueButton.addEventListener("click", onContinue);
  retryButton.addEventListener("click", onRetryLater);
  errorRetryButton.addEventListener("click", onErrorRetry);

  // -------------------------------------------------------------------------
  // State → DOM bridge
  // -------------------------------------------------------------------------

  function applyState(state: GmailLoginState): void {
    const status = state.status;
    statusLine.dataset["status"] = status.kind;
    statusLine.textContent = renderStatusLine(status);

    // Continue button gating.
    const showContinue =
      status.kind === "idle" ||
      status.kind === "starting" ||
      status.kind === "redirecting";
    continueButton.hidden = !showContinue;
    continueButton.disabled =
      status.kind === "starting" || status.kind === "redirecting";
    continueButton.textContent =
      status.kind === "starting"
        ? "Starting…"
        : status.kind === "redirecting"
          ? "Redirecting to Google…"
          : "Continue with Google";

    // Settings-load-failed surface.
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
    continueButton.removeEventListener("click", onContinue);
    retryButton.removeEventListener("click", onRetryLater);
    errorRetryButton.removeEventListener("click", onErrorRetry);
    root.innerHTML = "";
  }

  return { unmount };
}

function renderStatusLine(status: GmailLoginStatus): string {
  switch (status.kind) {
    case "idle":
      return "";
    case "starting":
      return "Starting Google sign-in…";
    case "redirecting":
      return "Redirecting to Google…";
    case "completing":
      return "Completing sign-in…";
    case "completed":
      return "Signed in. Loading workspace…";
    case "settingsLoadFailed":
      return "Couldn't load your settings. Please try again later.";
    case "error":
      return `Sign-in failed: ${status.message}`;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
