/**
 * Top-level UI bootstrap for the KARO desktop renderer.
 *
 * Routes the renderer between three screens:
 *
 *   1. **Welcome back** — when a previous session is still on disk
 *      (`apiKeyMeta:<provider>` is present), surface a one-click
 *      "Continue with saved <provider>" button so the user does not
 *      have to validate again on every launch. The screen also lets
 *      the user pick a different key (clears local state) or jump
 *      straight into Manage settings (mounts the workspace and routes
 *      to Settings).
 *   2. **Login**     — the Provider / API-key form. Default for first
 *      launch and after Sign out.
 *   3. **Workspace** — authenticated app shell with sidebar navigation
 *      (Dashboard / Task Builder / Model Selection / Agent Trace /
 *      Artifacts / Final Report / Settings) implemented in
 *      `./workspaceShell.ts`. Mounted after a successful save and on
 *      boot when the user clicks Continue. Continue lands on the
 *      Dashboard, never the Task Builder, so the user sees session
 *      context first.
 *
 * Validates: Requirements 1.1, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 4.4.
 */

import type { ProviderId, Session } from "@ai-agent-orchestrator/shared-core";

import { desktopShell } from "../shell/index.js";
import { DesktopOrchestratorTransport } from "../orchestration/index.js";

import { bootstrapLoginUi } from "./loginBootstrap.js";
import {
  API_KEY_META_PREFIX,
  type ApiKeyMetadata,
} from "./desktopApiKeySink.js";
import {
  mountWorkspaceShell,
  type WorkspaceRouteId,
  type WorkspaceShellHandle,
} from "./workbench.js";
import {
  clearSavedSession,
  readSavedSession,
} from "./sessionPersistence.js";

export function bootstrapUi(root: HTMLElement | null): void {
  if (root === null) {
    return;
  }
  void renderInitialScreen(root);
}

async function renderInitialScreen(root: HTMLElement): Promise<void> {
  let saved: Awaited<ReturnType<typeof readSavedSession>> = null;
  try {
    saved = await readSavedSession(desktopShell);
  } catch {
    saved = null;
  }

  if (saved !== null) {
    renderContinueScreen(root, saved);
    return;
  }
  renderLoginScreen(root);
}

function renderLoginScreen(root: HTMLElement): void {
  root.innerHTML = "";
  root.dataset["screen"] = "login";

  const loginContainer = document.createElement("section");
  loginContainer.className = "login-container";
  root.appendChild(loginContainer);

  bootstrapLoginUi(loginContainer, {
    onEvent: (event) => {
      if (event.type === "saved") {
        void switchToWorkspaceFromLogin(root, event.session);
      }
    },
  });

  // Developer diagnostic affordance — only on the login screen, never
  // in the authenticated workspace.
  const probeSection = buildShellProbeSection();
  root.appendChild(probeSection);
}

function renderContinueScreen(
  root: HTMLElement,
  saved: { provider: ProviderId; metadata: ApiKeyMetadata },
): void {
  root.innerHTML = "";
  root.dataset["screen"] = "continue";

  const wrap = document.createElement("section");
  wrap.className = "login-container welcome-back";

  const brand = document.createElement("p");
  brand.className = "welcome-brand";
  brand.textContent = "KARO";

  const heading = document.createElement("h1");
  heading.className = "login-heading";
  heading.textContent = "Welcome back";

  const subtitle = document.createElement("p");
  subtitle.className = "login-subtitle";
  subtitle.textContent =
    `You're signed in with ${formatProvider(saved.provider)}. ` +
    `Continue or pick a different key.`;

  // Session facts (provider, fingerprint, model id).
  const facts = document.createElement("dl");
  facts.className = "ws-kv-list welcome-facts";
  appendKv(facts, "Provider", formatProvider(saved.provider));
  appendKv(facts, "Key fingerprint", saved.metadata.fingerprint);
  appendKv(
    facts,
    "Model",
    saved.metadata.modelId !== undefined
      ? saved.metadata.modelId
      : "(provider default)",
  );

  const continueBtn = document.createElement("button");
  continueBtn.type = "button";
  continueBtn.className = "ws-button ws-button-primary login-save-button welcome-continue";
  continueBtn.textContent = `Continue with saved ${formatProvider(saved.provider)}`;
  continueBtn.addEventListener("click", () => {
    void switchToWorkspaceFromContinue(root, saved, "chat");
  });

  const manageBtn = document.createElement("button");
  manageBtn.type = "button";
  manageBtn.className = "ws-button ws-button-secondary login-mode-button welcome-manage";
  manageBtn.textContent = "Manage settings";
  manageBtn.addEventListener("click", () => {
    void switchToWorkspaceFromContinue(root, saved, "settings");
  });

  const switchAccountBtn = document.createElement("button");
  switchAccountBtn.type = "button";
  switchAccountBtn.className = "ws-button ws-button-ghost login-mode-button welcome-switch";
  switchAccountBtn.textContent = "Use a different key";
  switchAccountBtn.addEventListener("click", () => {
    void clearSavedSession(desktopShell, saved.provider).then(() => {
      renderLoginScreen(root);
    });
  });

  const actionsRow = document.createElement("div");
  actionsRow.className = "welcome-actions";
  actionsRow.append(continueBtn, manageBtn, switchAccountBtn);

  wrap.append(brand, heading, subtitle, facts, actionsRow);
  root.appendChild(wrap);
}

async function switchToWorkspaceFromLogin(
  root: HTMLElement,
  session: Session,
): Promise<void> {
  // Re-read metadata so we always pick up `baseUrl` / `modelId` /
  // `fingerprint` straight from storage rather than reconstructing
  // them from the in-memory login state.
  const candidates: ProviderId[] = [
    "openai",
    "anthropic",
    "fireworks",
    "custom-openai",
  ];
  let provider: ProviderId | null = null;
  let metadata: ApiKeyMetadata | null = null;
  for (const p of candidates) {
    const m = await desktopShell.readLocalSetting<ApiKeyMetadata>(
      `${API_KEY_META_PREFIX}${p}`,
    );
    if (m !== null && typeof m === "object" && typeof m.provider === "string") {
      provider = p;
      metadata = m;
      break;
    }
  }
  if (metadata === null || provider === null) {
    metadata = {
      provider: "openai",
      fingerprint: "(unknown)",
      savedAt: new Date().toISOString(),
    };
  }
  mountWorkspace(root, session, metadata, "chat");
}

async function switchToWorkspaceFromContinue(
  root: HTMLElement,
  saved: { provider: ProviderId; metadata: ApiKeyMetadata },
  initialRoute: WorkspaceRouteId,
): Promise<void> {
  const session = await synthesiseLocalSession();
  mountWorkspace(root, session, saved.metadata, initialRoute);
}

function mountWorkspace(
  root: HTMLElement,
  session: Session,
  metadata: ApiKeyMetadata,
  initialRoute: WorkspaceRouteId,
): void {
  root.innerHTML = "";
  root.dataset["screen"] = "workspace";

  const transport = new DesktopOrchestratorTransport({ desktopShell });

  let handle: WorkspaceShellHandle | null = null;
  handle = mountWorkspaceShell(root, {
    session,
    metadata,
    desktopShell,
    initialRoute,
    transport,
    onSignOut: () => {
      void clearSavedSession(desktopShell, metadata.provider)
        .catch(() => {
          // Even on failure we still want to return to login —
          // partial cleanup is better than locking the user in.
        })
        .then(() => {
          handle?.unmount();
          renderLoginScreen(root);
        });
    },
    onChangeKey: () => {
      void clearSavedSession(desktopShell, metadata.provider)
        .catch(() => {
          /* fall through to login */
        })
        .then(() => {
          handle?.unmount();
          renderLoginScreen(root);
        });
    },
  });
}

async function synthesiseLocalSession(): Promise<Session> {
  const deviceId = await desktopShell.getDeviceId();
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `sess-${String(Date.now())}`;
  return {
    id,
    kind: "local",
    deviceId,
    createdAt: new Date().toISOString(),
  };
}

function buildShellProbeSection(): HTMLElement {
  const probeSection = document.createElement("section");
  probeSection.className = "shell-probe-section";

  const probeHeading = document.createElement("h2");
  probeHeading.textContent = "Shell diagnostics";
  probeHeading.className = "shell-probe-heading";

  const probeButton = document.createElement("button");
  probeButton.textContent = "Probe shell: get device id";
  probeButton.type = "button";
  probeButton.className = "app-probe-button";

  const probeOutput = document.createElement("pre");
  probeOutput.className = "app-probe-output";
  probeOutput.setAttribute("aria-live", "polite");
  probeOutput.textContent = "";

  probeButton.addEventListener("click", () => {
    probeOutput.textContent = "calling desktopShell.getDeviceId()...";
    desktopShell
      .getDeviceId()
      .then((deviceId) => {
        // Always JSON-stringify diagnostics so an unexpected payload
        // shape cannot smuggle raw HTML / script-like text into the
        // renderer.
        probeOutput.textContent = JSON.stringify({ deviceId }, null, 2);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : JSON.stringify(error, null, 2);
        probeOutput.textContent = message;
      });
  });

  probeSection.append(probeHeading, probeButton, probeOutput);
  return probeSection;
}

function appendKv(list: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement("dt");
  dt.className = "ws-kv-key";
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.className = "ws-kv-value";
  dd.textContent = value;
  list.append(dt, dd);
}

function formatProvider(p: ProviderId): string {
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
