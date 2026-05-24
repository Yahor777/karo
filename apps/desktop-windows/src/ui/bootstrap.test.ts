// @vitest-environment jsdom
/**
 * Boot-flow tests for the KARO desktop renderer (`bootstrap.ts`).
 *
 * Covers the post-redesign workbench:
 *   • Boot with no saved session → login screen renders.
 *   • Boot with saved session → Welcome back screen renders.
 *   • Continue lands on the Chat route (not Task Builder).
 *   • Manage settings lands on the Settings pane.
 *   • Use a different key clears the saved session and returns to
 *     login (no stale fingerprint left in the UI).
 *   • Sidebar nav switches the center pane.
 *   • Sign out from the topbar clears local session and returns to
 *     login.
 *   • Diagnostics is rendered ONLY on the login screen — never inside
 *     the authenticated workspace.
 *
 * Validates: Requirements 1.4, 2.5, 4.4, 4.5.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapUi } from "./bootstrap.js";
import {
  createApplicationShell,
  installDesktopShell,
  resetInvoke,
  setInvoke,
  nativeDesktopShell,
} from "../shell/index.js";
import {
  createInvokeForLocalStorage,
  createInMemoryEncryptedStorage,
} from "../storage/index.js";
import {
  API_KEY_META_PREFIX,
  API_KEY_SECRET_PREFIX,
  type ApiKeyMetadata,
} from "./desktopApiKeySink.js";

const SAMPLE_META: ApiKeyMetadata = {
  provider: "fireworks",
  fingerprint: "ab12cd34",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  modelId: "accounts/fireworks/models/llama-v3p1-8b-instruct",
  savedAt: "2026-05-17T12:00:00.000Z",
};

let appRoot: HTMLElement;

beforeEach(() => {
  appRoot = document.createElement("div");
  appRoot.id = "app";
  appRoot.className = "app-root";
  document.body.appendChild(appRoot);

  const storage = createInMemoryEncryptedStorage();
  const invoke = createInvokeForLocalStorage({
    storage,
    getDeviceId: async () => "device-test",
    writeLocalLog: () => undefined,
    showNotification: () => undefined,
  });
  setInvoke(invoke);
  installDesktopShell(createApplicationShell({ inner: nativeDesktopShell }));
});

afterEach(() => {
  appRoot.remove();
  resetInvoke();
});

async function waitForScreen(
  expected: "login" | "continue" | "workspace",
  timeoutTicks = 64,
): Promise<void> {
  for (let i = 0; i < timeoutTicks; i += 1) {
    if (appRoot.dataset["screen"] === expected) return;
    await Promise.resolve();
  }
}

async function persistSavedSession(): Promise<void> {
  const { desktopShell } = await import("../shell/index.js");
  await desktopShell.writeLocalSetting(
    `${API_KEY_META_PREFIX}fireworks`,
    SAMPLE_META,
  );
  await desktopShell.writeLocalSetting(`${API_KEY_SECRET_PREFIX}fireworks`, {
    algorithm: "aes-256-gcm",
    ciphertext: "AA==",
    createdAt: SAMPLE_META.savedAt,
  });
}

describe("bootstrap — first launch (no saved session)", () => {
  it("renders the login screen, not the welcome-back screen", async () => {
    bootstrapUi(appRoot);
    await waitForScreen("login");

    expect(appRoot.dataset["screen"]).toBe("login");
    expect(appRoot.querySelector(".welcome-back")).toBeNull();
    expect(appRoot.querySelector(".login-container")).not.toBeNull();
  });

  it("renders Shell diagnostics on the login screen", async () => {
    bootstrapUi(appRoot);
    await waitForScreen("login");
    expect(appRoot.querySelector(".shell-probe-section")).not.toBeNull();
  });

  it("does not stay stuck on a 'loading' message", async () => {
    bootstrapUi(appRoot);
    await waitForScreen("login");
    expect(appRoot.textContent).not.toMatch(/loading workspace/i);
  });
});

describe("bootstrap — Welcome back screen (saved session present)", () => {
  beforeEach(async () => {
    await persistSavedSession();
  });

  it("renders Welcome back with provider, fingerprint and model", async () => {
    bootstrapUi(appRoot);
    await waitForScreen("continue");

    expect(appRoot.dataset["screen"]).toBe("continue");
    const wb = appRoot.querySelector(".welcome-back")!;
    expect(wb.textContent).toContain("Welcome back");
    expect(wb.textContent).toContain("Fireworks AI");
    expect(wb.textContent).toContain("ab12cd34");
    expect(wb.textContent).toContain(
      "accounts/fireworks/models/llama-v3p1-8b-instruct",
    );
  });

  it("offers Continue / Manage settings / Use a different key", async () => {
    bootstrapUi(appRoot);
    await waitForScreen("continue");
    const buttons = appRoot.querySelectorAll<HTMLButtonElement>(
      ".welcome-actions button",
    );
    const labels = Array.from(buttons).map((b) => b.textContent);
    expect(labels).toContain("Continue with saved Fireworks AI");
    expect(labels).toContain("Manage settings");
    expect(labels).toContain("Use a different key");
  });

  it("Continue mounts the workbench and lands on Chat", async () => {
    bootstrapUi(appRoot);
    await waitForScreen("continue");
    appRoot.querySelector<HTMLButtonElement>(".welcome-continue")!.click();
    await waitForScreen("workspace");

    expect(appRoot.dataset["screen"]).toBe("workspace");
    const center = appRoot.querySelector<HTMLElement>(".kw-center");
    expect(center?.dataset["routeId"]).toBe("chat");
  });

  it("Manage settings lands directly on the Settings pane", async () => {
    bootstrapUi(appRoot);
    await waitForScreen("continue");
    appRoot.querySelector<HTMLButtonElement>(".welcome-manage")!.click();
    await waitForScreen("workspace");

    expect(appRoot.dataset["screen"]).toBe("workspace");
    const center = appRoot.querySelector<HTMLElement>(".kw-center");
    expect(center?.dataset["routeId"]).toBe("settings");
  });

  it("Use a different key clears the saved session and returns to login", async () => {
    bootstrapUi(appRoot);
    await waitForScreen("continue");
    expect(appRoot.dataset["screen"]).toBe("continue");
    appRoot.querySelector<HTMLButtonElement>(".welcome-switch")!.click();
    await waitForScreen("login");

    expect(appRoot.dataset["screen"]).toBe("login");
    expect(appRoot.textContent).not.toContain("ab12cd34");

    const { desktopShell } = await import("../shell/index.js");
    const stillThere = await desktopShell.readLocalSetting(
      `${API_KEY_META_PREFIX}fireworks`,
    );
    expect(stillThere).toBeNull();
  });

  it("does NOT render Shell diagnostics inside the workbench", async () => {
    bootstrapUi(appRoot);
    await waitForScreen("continue");
    appRoot.querySelector<HTMLButtonElement>(".welcome-continue")!.click();
    await waitForScreen("workspace");
    expect(appRoot.querySelector(".shell-probe-section")).toBeNull();
  });
});

describe("bootstrap — workbench navigation and sign out", () => {
  beforeEach(async () => {
    await persistSavedSession();
  });

  it("clicking sidebar items changes the active center pane", async () => {
    bootstrapUi(appRoot);
    await waitForScreen("continue");
    appRoot.querySelector<HTMLButtonElement>(".welcome-continue")!.click();
    await waitForScreen("workspace");

    const settingsBtn = appRoot.querySelector<HTMLButtonElement>(
      '.kw-sidebar-button[data-route-id="settings"]',
    )!;
    settingsBtn.click();
    expect(
      appRoot.querySelector<HTMLElement>(".kw-center")?.dataset["routeId"],
    ).toBe("settings");

    const modelsBtn = appRoot.querySelector<HTMLButtonElement>(
      '.kw-sidebar-button[data-route-id="models"]',
    )!;
    modelsBtn.click();
    expect(
      appRoot.querySelector<HTMLElement>(".kw-center")?.dataset["routeId"],
    ).toBe("models");
  });

  it("Sign out from the sidebar asks for confirmation, clears local session and returns to login", async () => {
    bootstrapUi(appRoot);
    await waitForScreen("continue");
    appRoot.querySelector<HTMLButtonElement>(".welcome-continue")!.click();
    await waitForScreen("workspace");
    expect(appRoot.dataset["screen"]).toBe("workspace");

    expect(appRoot.querySelector(".kw-topbar-signout")).toBeNull();
    appRoot.querySelector<HTMLButtonElement>(".kw-sidebar-signout")!.click();
    expect(appRoot.querySelector(".kw-modal")?.textContent).toContain("Sign out");
    appRoot.querySelector<HTMLButtonElement>(".kw-signout-confirm")!.click();
    await waitForScreen("login");

    expect(appRoot.dataset["screen"]).toBe("login");
    const { desktopShell } = await import("../shell/index.js");
    const meta = await desktopShell.readLocalSetting(
      `${API_KEY_META_PREFIX}fireworks`,
    );
    expect(meta).toBeNull();
  });
});
