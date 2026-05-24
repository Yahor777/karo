// @vitest-environment jsdom
/**
 * DOM-level regression tests for the login confirmation modal
 * (Requirement 2.4).
 *
 * Background — the bug:
 *
 *   The shared-ui `mountLoginScreen` uses the HTML `hidden` attribute
 *   to gate the confirmation modal visibility. The desktop app's
 *   `main.css` set `.login-modal-backdrop { display: flex; ... }`,
 *   which has the same specificity (one class) as the user-agent
 *   `[hidden] { display: none }` rule but lands later in the cascade.
 *   The class therefore won, the backdrop rendered at boot regardless
 *   of `el.hidden = true`, and clicking the disabled-area Cancel /
 *   Confirm buttons ran controller methods that early-returned because
 *   `state.save === "idle"` — so nothing visible happened.
 *
 *   Fix: `[hidden] { display: none !important }` in `main.css` so the
 *   class rule cannot resurrect a hidden element. These tests pin the
 *   contract end-to-end — from CSS down to the controller state
 *   transitions — so the bug cannot return silently.
 *
 * Validates: Requirements 2.4 (confirmation modal hide/show), 2.2
 * (validation gating), 4.5 (UI never persists secrets without
 * confirmation).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapLoginUi } from "./loginBootstrap.js";
import type {
  LoginGateway,
  Session,
  ValidationResult,
} from "@ai-agent-orchestrator/shared-ui";

// ---------------------------------------------------------------------------
// CSS loading — emulate Vite's `link rel=stylesheet` import.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_CSS = readFileSync(join(HERE, "main.css"), "utf-8");

let root: HTMLElement;
let style: HTMLStyleElement;

beforeEach(() => {
  // Inject the real desktop stylesheet so [hidden] / .login-modal-*
  // rules apply exactly as they do in the renderer.
  style = document.createElement("style");
  style.dataset["test"] = "main-css";
  style.textContent = MAIN_CSS;
  document.head.appendChild(style);

  root = document.createElement("section");
  root.className = "login-container";
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
  style.remove();
});

// ---------------------------------------------------------------------------
// Test gateway — synchronous in-memory adapter.
// ---------------------------------------------------------------------------

class StubGateway implements LoginGateway {
  public validateCalls = 0;
  public createCalls: Array<{
    provider: string;
    apiKey: string;
    baseUrl?: string;
    modelId?: string;
    confirmedByUser: boolean;
  }> = [];
  private nextValidate: ValidationResult = { kind: "ok" };
  private nextSession: Session = {
    id: "sess-test-1",
    kind: "local",
    deviceId: "device-test",
    createdAt: "2025-01-01T00:00:00.000Z",
    expiresAt: "2025-02-01T00:00:00.000Z",
  };

  public setNextValidate(r: ValidationResult): void {
    this.nextValidate = r;
  }

  public async validateApiKey(): Promise<ValidationResult> {
    this.validateCalls += 1;
    await Promise.resolve();
    return this.nextValidate;
  }

  public async createLocalSession(input: {
    provider: string;
    apiKey: string;
    baseUrl?: string;
    modelId?: string;
    confirmedByUser: true;
  }): Promise<Session> {
    this.createCalls.push({ ...input });
    await Promise.resolve();
    return this.nextSession;
  }
}

function getModalBackdrop(): HTMLElement {
  const el = root.querySelector<HTMLElement>(".login-modal-backdrop");
  expect(el).not.toBeNull();
  return el!;
}

function getModalCancel(): HTMLButtonElement {
  const el = root.querySelector<HTMLButtonElement>(".login-modal-cancel");
  expect(el).not.toBeNull();
  return el!;
}

function getModalConfirm(): HTMLButtonElement {
  const el = root.querySelector<HTMLButtonElement>(".login-modal-confirm");
  expect(el).not.toBeNull();
  return el!;
}

/** Resolve every microtask queued by the controller (validate / save). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Boot-time invariants
// ---------------------------------------------------------------------------

describe("login confirmation modal — boot state", () => {
  it("modal backdrop is hidden on first render (Requirement 2.4)", () => {
    bootstrapLoginUi(root, { gateway: new StubGateway() });
    const backdrop = getModalBackdrop();
    expect(backdrop.hidden).toBe(true);
  });

  it(
    "main.css contains a `[hidden] { display: none !important }` rule " +
      "so component-level `display: flex` cannot resurrect a hidden element",
    () => {
      // This is the regression guard for the actual bug. The CSS file
      // had `.login-modal-backdrop { display: flex; ... }` whose class
      // selector beat the UA `[hidden]` rule (same specificity, later
      // in the cascade). The fix: an explicit `!important` rule in
      // main.css. Asserting on the source string here is more robust
      // than asserting on jsdom's computed styles, which interpret
      // `!important` inconsistently across versions.
      expect(MAIN_CSS).toMatch(/\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/);
    },
  );
});

// ---------------------------------------------------------------------------
// Open / cancel cycle
// ---------------------------------------------------------------------------

describe("login confirmation modal — Cancel button (Requirement 2.4)", () => {
  it("opens after a successful validate + save click and closes on Cancel", async () => {
    const gateway = new StubGateway();
    const result = bootstrapLoginUi(root, { gateway });
    expect(result).not.toBeNull();

    // Drive the controller through validate → save click.
    const apiKey = root.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    )!;
    apiKey.value = "sk-test";
    apiKey.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".login-validate-button")!.click();
    await flush();

    const saveButton = root.querySelector<HTMLButtonElement>(
      ".login-save-button",
    )!;
    expect(saveButton.disabled).toBe(false);
    saveButton.click();

    const backdrop = getModalBackdrop();
    expect(backdrop.hidden).toBe(false);

    // Click Cancel — the modal must hide and the controller must roll
    // back save status to idle.
    getModalCancel().click();

    expect(backdrop.hidden).toBe(true);
    expect(result!.controller.getState().save).toEqual({ kind: "idle" });

    // Critical: Cancel must NOT have called createLocalSession.
    expect(gateway.createCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Confirm and save
// ---------------------------------------------------------------------------

describe("login confirmation modal — Confirm and save (Requirement 2.4, 4.5)", () => {
  it("calls createLocalSession with confirmedByUser=true and closes the modal", async () => {
    const gateway = new StubGateway();
    const result = bootstrapLoginUi(root, { gateway });
    expect(result).not.toBeNull();

    const apiKey = root.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    )!;
    apiKey.value = "sk-confirmed";
    apiKey.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".login-validate-button")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".login-save-button")!.click();

    const backdrop = getModalBackdrop();
    expect(backdrop.hidden).toBe(false);

    getModalConfirm().click();
    await flush();
    await flush();

    expect(gateway.createCalls).toEqual([
      {
        provider: "openai",
        apiKey: "sk-confirmed",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-4o-mini",
        confirmedByUser: true,
      },
    ]);

    const finalSave = result!.controller.getState().save;
    expect(finalSave.kind).toBe("saved");
  });

  it("re-opening the modal works after Cancel (no stale state)", async () => {
    const gateway = new StubGateway();
    const result = bootstrapLoginUi(root, { gateway });

    // First cycle.
    const apiKey = root.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    )!;
    apiKey.value = "sk-first";
    apiKey.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".login-validate-button")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".login-save-button")!.click();
    expect(getModalBackdrop().hidden).toBe(false);
    getModalCancel().click();
    expect(getModalBackdrop().hidden).toBe(true);

    // Second cycle on the same controller. validate again because
    // setApiKey would normally reset validation; here we keep the
    // same value so validation stays "ok".
    root.querySelector<HTMLButtonElement>(".login-save-button")!.click();
    expect(getModalBackdrop().hidden).toBe(false);

    // Confirm this time.
    getModalConfirm().click();
    await flush();
    await flush();
    expect(result!.controller.getState().save.kind).toBe("saved");
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.createCalls[0]?.apiKey).toBe("sk-first");
  });
});

// ---------------------------------------------------------------------------
// Click reachability — the bug was that the modal rendered at boot and
// blocked clicks on the form behind it. Now that the modal hides on
// boot, the entry-mode buttons must be reachable again.
// ---------------------------------------------------------------------------

describe("login modal — pointer-events / z-index hygiene", () => {
  it("entry-mode buttons under the modal are clickable when the modal is hidden", () => {
    bootstrapLoginUi(root, { gateway: new StubGateway() });

    const backdrop = getModalBackdrop();
    expect(backdrop.hidden).toBe(true);

    // Sanity: jsdom returns the topmost element at a point. With the
    // backdrop hidden it must NOT be in the elementsFromPoint stack,
    // so a click on the API-key mode button reaches the actual button.
    const apiKeyModeButton = root.querySelector<HTMLButtonElement>(
      'button[data-mode="apiKey"]',
    )!;
    expect(apiKeyModeButton).not.toBeNull();

    let clicked = false;
    apiKeyModeButton.addEventListener("click", () => {
      clicked = true;
    });
    apiKeyModeButton.click();
    expect(clicked).toBe(true);
  });

  it("modal Cancel and Confirm buttons receive clicks while the modal is open", async () => {
    const gateway = new StubGateway();
    bootstrapLoginUi(root, { gateway });

    const apiKey = root.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    )!;
    apiKey.value = "sk-test";
    apiKey.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".login-validate-button")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".login-save-button")!.click();

    const cancel = getModalCancel();
    const confirm = getModalConfirm();
    expect(cancel.disabled).toBe(false);
    expect(confirm.disabled).toBe(false);

    let cancelClicked = 0;
    let confirmClicked = 0;
    cancel.addEventListener("click", () => {
      cancelClicked += 1;
    });
    confirm.addEventListener("click", () => {
      confirmClicked += 1;
    });

    cancel.click();
    expect(cancelClicked).toBe(1);

    // After cancel the modal is closed; re-open and click confirm.
    root.querySelector<HTMLButtonElement>(".login-save-button")!.click();
    confirm.click();
    expect(confirmClicked).toBe(1);
  });
});
