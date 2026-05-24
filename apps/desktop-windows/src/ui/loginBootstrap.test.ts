// @vitest-environment jsdom
/**
 * Smoke tests for the desktop login bootstrap (tasks 4.3, 17.4).
 *
 * Covers:
 *   • Local API-key login wiring (task 4.3) — entry-mode toggle,
 *     not-wired error surfacing, "requestGoogleOAuth" event emission.
 *   • Gmail login + local-to-cloud upgrade wiring (task 17.4) — happy
 *     path through OAuth callback to merge report display, the
 *     "settings_load_failed" → "retry later" message
 *     (Requirement 3.5), and the explicit per-collection
 *     confirmation flags (Requirements 2.7, 2.8).
 *
 * Validates: Requirements 1.4, 2.1, 2.3, 2.4, 2.7, 2.8, 3.1, 3.5, 3.6.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrapLoginUi,
  notWiredLoginGateway,
  type OAuthCallbackListener,
} from "./loginBootstrap.js";
import type {
  GmailLoginEvent,
  GmailLoginGateway,
  LoginEvent,
  Session,
  UpgradeEvent,
  UpgradeGateway,
  UpgradeMergeReport,
} from "@ai-agent-orchestrator/shared-ui";

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
});

// ---------------------------------------------------------------------------
// Task 4.3 coverage (kept verbatim — the wiring still has to support the
// local API-key flow alongside the new Gmail screens).
// ---------------------------------------------------------------------------

describe("bootstrapLoginUi — local API-key flow", () => {
  it("returns null when root is null", () => {
    expect(bootstrapLoginUi(null)).toBeNull();
  });

  it("renders the entry-mode toggle, provider select, key input and save button", () => {
    const result = bootstrapLoginUi(root);
    expect(result).not.toBeNull();

    expect(root.querySelector(".login-mode-toggle")).not.toBeNull();
    expect(
      root.querySelectorAll<HTMLButtonElement>(".login-mode-button"),
    ).toHaveLength(2);

    const providerSelect = root.querySelector<HTMLSelectElement>(
      'select[name="provider"]',
    );
    expect(providerSelect).not.toBeNull();
    expect(providerSelect!.options.length).toBeGreaterThanOrEqual(2);

    const apiKeyInput = root.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    );
    expect(apiKeyInput).not.toBeNull();
    expect(apiKeyInput!.type).toBe("password");

    const saveButton = root.querySelector<HTMLButtonElement>(
      ".login-save-button",
    );
    expect(saveButton).not.toBeNull();
    expect(saveButton!.disabled).toBe(true);
  });

  it("surfaces the not-wired error code/message in the alert surface after pressing Validate", async () => {
    const result = bootstrapLoginUi(root, { gateway: notWiredLoginGateway });
    expect(result).not.toBeNull();
    const { controller } = result!;

    const apiKeyInput = root.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    )!;
    apiKeyInput.value = "sk-test";
    apiKeyInput.dispatchEvent(new Event("input"));

    await controller.validate();

    const errorSurface = root.querySelector<HTMLElement>(
      ".login-error-surface",
    );
    expect(errorSurface).not.toBeNull();
    expect(errorSurface!.hidden).toBe(false);
    expect(errorSurface!.textContent).toContain("gateway_not_wired");
    expect(errorSurface!.dataset["code"]).toBe("gateway_not_wired");

    const saveButton = root.querySelector<HTMLButtonElement>(
      ".login-save-button",
    )!;
    expect(saveButton.disabled).toBe(true);
  });

  it("emits requestGoogleOAuth when the user presses 'Sign in with Gmail'", () => {
    const events: LoginEvent[] = [];
    const result = bootstrapLoginUi(root, {
      onEvent: (e) => events.push(e),
    });
    expect(result).not.toBeNull();

    const googleModeButton = root.querySelector<HTMLButtonElement>(
      'button[data-mode="google"]',
    )!;
    googleModeButton.click();
    const continueButton = root.querySelector<HTMLButtonElement>(
      ".login-google-button",
    )!;
    continueButton.click();

    expect(events.some((e) => e.type === "requestGoogleOAuth")).toBe(true);
  });

  it("notWiredLoginGateway returns a structured error for validateApiKey", async () => {
    const result = await notWiredLoginGateway.validateApiKey({
      provider: "openai",
      apiKey: "sk-test",
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.providerCode).toBe("gateway_not_wired");
    }
  });

  it("notWiredLoginGateway rejects createLocalSession with code=gateway_not_wired", async () => {
    let caught: unknown;
    try {
      await notWiredLoginGateway.createLocalSession({
        provider: "openai",
        apiKey: "sk-test",
        confirmedByUser: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe("gateway_not_wired");
  });
});

// ---------------------------------------------------------------------------
// Task 17.4 coverage — Gmail flow + local-to-cloud upgrade.
// ---------------------------------------------------------------------------

const SAMPLE_CLOUD_SESSION: Session = {
  id: "sess_cloud_1",
  kind: "cloud",
  userId: "user_99",
  createdAt: "2025-01-01T00:00:00.000Z",
  expiresAt: "2025-02-01T00:00:00.000Z",
};

const SAMPLE_REPORT: UpgradeMergeReport = {
  apiKeys: {
    copiedToCloud: ["openai"],
    cloudWonOver: ["anthropic"],
    preservedLocalOnly: ["anthropic"],
  },
  customAgents: {
    copiedToCloud: ["agent-1", "agent-2"],
    conflicts: [{ agentId: "agent-3", reason: "builtin_name" }],
  },
  preferences: {
    copiedToCloud: ["theme"],
    cloudWon: ["language"],
  },
};

class StubGmailGateway implements GmailLoginGateway {
  public beginCalls = 0;
  public completeCalls: Array<{ code: string; state: string }> = [];
  private nextSession: Session = SAMPLE_CLOUD_SESSION;
  private nextCompleteError: unknown = null;

  public setCompleteError(err: unknown): void {
    this.nextCompleteError = err;
  }

  public async beginGoogleOAuth(): Promise<{
    authorizationUrl: string;
    state: string;
  }> {
    this.beginCalls += 1;
    return {
      authorizationUrl: "https://accounts.google.com/test?state=abc",
      state: "abc",
    };
  }
  public async completeGoogleOAuth(input: {
    code: string;
    state: string;
  }): Promise<Session> {
    this.completeCalls.push(input);
    if (this.nextCompleteError !== null) {
      const err = this.nextCompleteError;
      this.nextCompleteError = null;
      throw err as Error;
    }
    return this.nextSession;
  }
}

class StubUpgradeGateway implements UpgradeGateway {
  public calls: Array<{
    code: string;
    state: string;
    syncSettings: boolean;
    syncApiKeys: boolean;
  }> = [];
  private nextResult: { session: Session; mergeReport: UpgradeMergeReport } = {
    session: SAMPLE_CLOUD_SESSION,
    mergeReport: SAMPLE_REPORT,
  };
  private nextError: unknown = null;

  public setError(err: unknown): void {
    this.nextError = err;
  }

  public async upgradeLocalSessionToGoogle(input: {
    code: string;
    state: string;
    syncSettings: boolean;
    syncApiKeys: boolean;
  }): Promise<{ session: Session; mergeReport: UpgradeMergeReport }> {
    this.calls.push({
      code: input.code,
      state: input.state,
      syncSettings: input.syncSettings,
      syncApiKeys: input.syncApiKeys,
    });
    if (this.nextError !== null) {
      const err = this.nextError;
      this.nextError = null;
      throw err as Error;
    }
    return this.nextResult;
  }
}

class FakeOAuthCallbackListener implements OAuthCallbackListener {
  private handler: ((params: { code: string; state: string }) => void) | null =
    null;

  public onCallback(
    handler: (params: { code: string; state: string }) => void,
  ): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  public dispatch(params: { code: string; state: string }): void {
    this.handler?.(params);
  }
}

describe("bootstrapLoginUi — Gmail flow surfaces", () => {
  it("renders the Gmail Continue button when the user picks the Google entry mode", () => {
    bootstrapLoginUi(root);
    const continueGmail = root.querySelector<HTMLButtonElement>(
      ".gmail-login-continue",
    );
    expect(continueGmail).not.toBeNull();
  });

  it("renders the upgrade modal in a hidden container until the OAuth callback arrives", () => {
    bootstrapLoginUi(root);
    const upgradePhase = root.querySelector<HTMLElement>(
      ".login-phase-upgrade",
    );
    expect(upgradePhase).not.toBeNull();
    // Hidden until we dispatch a callback.
    expect(upgradePhase!.hidden).toBe(true);
    // Confirm modal exists in the DOM.
    expect(upgradePhase!.querySelector(".upgrade-confirm-modal")).not.toBeNull();
  });
});

describe("bootstrapLoginUi — Gmail happy path through merge report", () => {
  it("dispatches the OAuth callback to both the Gmail screen and the upgrade screen", async () => {
    const gmailGateway = new StubGmailGateway();
    const upgradeGateway = new StubUpgradeGateway();
    const listener = new FakeOAuthCallbackListener();

    const result = bootstrapLoginUi(root, {
      gmailGateway,
      upgradeGateway,
      localScope: { kind: "local", deviceId: "device-A" },
      oauthCallbackListener: listener,
    });
    expect(result).not.toBeNull();

    listener.dispatch({ code: "g-code", state: "g-state" });
    // Allow the gmail completeGoogleOAuth promise chain to flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(gmailGateway.completeCalls).toHaveLength(1);
    expect(gmailGateway.completeCalls[0]).toEqual({
      code: "g-code",
      state: "g-state",
    });

    // Upgrade screen has captured the same callback and is awaiting
    // confirmation.
    const upgradeStatus = result!.upgradeController.getState().status.kind;
    expect(upgradeStatus).toBe("awaitingConfirmation");
  });

  it("surfaces the merge report after the user confirms with explicit sync flags (Req. 2.7, 2.8, 3.6)", async () => {
    const gmailGateway = new StubGmailGateway();
    const upgradeGateway = new StubUpgradeGateway();
    const listener = new FakeOAuthCallbackListener();
    const upgradeEvents: UpgradeEvent[] = [];

    const result = bootstrapLoginUi(root, {
      gmailGateway,
      upgradeGateway,
      localScope: { kind: "local", deviceId: "device-A" },
      oauthCallbackListener: listener,
      onUpgradeEvent: (e) => upgradeEvents.push(e),
    });
    expect(result).not.toBeNull();

    listener.dispatch({ code: "g-code", state: "g-state" });
    await Promise.resolve();
    await Promise.resolve();

    // Tick on the user's explicit consent toggles.
    const settingsCheckbox = root.querySelector<HTMLInputElement>(
      'input[name="syncSettings"]',
    )!;
    const apiKeysCheckbox = root.querySelector<HTMLInputElement>(
      'input[name="syncApiKeys"]',
    )!;
    expect(settingsCheckbox.checked).toBe(false);
    expect(apiKeysCheckbox.checked).toBe(false);

    settingsCheckbox.checked = true;
    settingsCheckbox.dispatchEvent(new Event("change"));
    apiKeysCheckbox.checked = true;
    apiKeysCheckbox.dispatchEvent(new Event("change"));

    const confirmButton = root.querySelector<HTMLButtonElement>(
      ".upgrade-confirm-button",
    )!;
    confirmButton.click();
    // Let the upgrade promise resolve.
    await Promise.resolve();
    await Promise.resolve();

    expect(upgradeGateway.calls).toEqual([
      {
        code: "g-code",
        state: "g-state",
        syncSettings: true,
        syncApiKeys: true,
      },
    ]);

    // Merge report rendered.
    const mergeSurface = root.querySelector<HTMLElement>(
      ".upgrade-merge-report",
    );
    expect(mergeSurface).not.toBeNull();
    expect(mergeSurface!.hidden).toBe(false);
    const apiKeysCopied = mergeSurface!.querySelector<HTMLElement>(
      'dd[data-merge-key="apiKeys.copied"]',
    );
    expect(apiKeysCopied?.textContent).toBe("1");
    const customAgentsCopied = mergeSurface!.querySelector<HTMLElement>(
      'dd[data-merge-key="customAgents.copied"]',
    );
    expect(customAgentsCopied?.textContent).toBe("2");
    const customAgentsConflicts = mergeSurface!.querySelector<HTMLElement>(
      'dd[data-merge-key="customAgents.conflicts"]',
    );
    expect(customAgentsConflicts?.textContent).toBe("1");

    // Completed event fired with the merge report.
    expect(upgradeEvents).toContainEqual({
      type: "completed",
      session: SAMPLE_CLOUD_SESSION,
      mergeReport: SAMPLE_REPORT,
    });
  });

  it("never silently sets syncApiKeys=true if the user did not tick the checkbox (Req. 2.8)", async () => {
    const gmailGateway = new StubGmailGateway();
    const upgradeGateway = new StubUpgradeGateway();
    const listener = new FakeOAuthCallbackListener();

    bootstrapLoginUi(root, {
      gmailGateway,
      upgradeGateway,
      localScope: { kind: "local", deviceId: "device-A" },
      oauthCallbackListener: listener,
    });

    listener.dispatch({ code: "g-code", state: "g-state" });
    await Promise.resolve();
    await Promise.resolve();

    const confirmButton = root.querySelector<HTMLButtonElement>(
      ".upgrade-confirm-button",
    )!;
    confirmButton.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(upgradeGateway.calls[0]?.syncApiKeys).toBe(false);
    expect(upgradeGateway.calls[0]?.syncSettings).toBe(false);
  });
});

describe("bootstrapLoginUi — settings_load_failed (Requirement 3.5)", () => {
  it("surfaces the retry-later message when the upgrade gateway throws settings_load_failed", async () => {
    const gmailGateway = new StubGmailGateway();
    const upgradeGateway = new StubUpgradeGateway();
    upgradeGateway.setError({
      name: "SettingsLoadError",
      code: "settings_load_failed",
      message: "cloud settings backend unreachable",
    });
    const listener = new FakeOAuthCallbackListener();

    bootstrapLoginUi(root, {
      gmailGateway,
      upgradeGateway,
      localScope: { kind: "local", deviceId: "device-A" },
      oauthCallbackListener: listener,
    });

    listener.dispatch({ code: "g-code", state: "g-state" });
    await Promise.resolve();
    await Promise.resolve();

    const confirmButton = root.querySelector<HTMLButtonElement>(
      ".upgrade-confirm-button",
    )!;
    confirmButton.click();
    await Promise.resolve();
    await Promise.resolve();

    const retryNotice = root.querySelector<HTMLElement>(".upgrade-retry");
    expect(retryNotice).not.toBeNull();
    expect(retryNotice!.hidden).toBe(false);
    const retryMessage = retryNotice!.querySelector<HTMLElement>(
      ".upgrade-retry-message",
    );
    expect(retryMessage?.textContent?.toLowerCase()).toContain("retry later");

    // The error surface stays hidden because settings_load_failed has
    // its own dedicated branch.
    const errorSurface = root.querySelector<HTMLElement>(".upgrade-error");
    expect(errorSurface!.hidden).toBe(true);
  });

  it("Gmail screen surfaces retry-later when completeGoogleOAuth itself fails with settings_load_failed", async () => {
    const gmailGateway = new StubGmailGateway();
    gmailGateway.setCompleteError({
      name: "SettingsLoadError",
      code: "settings_load_failed",
      message: "cloud settings backend unreachable",
    });
    const upgradeGateway = new StubUpgradeGateway();
    const listener = new FakeOAuthCallbackListener();
    const gmailEvents: GmailLoginEvent[] = [];

    bootstrapLoginUi(root, {
      gmailGateway,
      upgradeGateway,
      localScope: { kind: "local", deviceId: "device-A" },
      oauthCallbackListener: listener,
      onGmailEvent: (e) => gmailEvents.push(e),
    });

    listener.dispatch({ code: "g-code", state: "g-state" });
    await Promise.resolve();
    await Promise.resolve();

    // Gmail screen surfaces the retry-later notice.
    const retryNotice = root.querySelector<HTMLElement>(".gmail-login-retry");
    expect(retryNotice).not.toBeNull();
    expect(retryNotice!.hidden).toBe(false);
    expect(retryNotice!.querySelector(".gmail-login-retry-message")
      ?.textContent?.toLowerCase()).toContain("retry later");
    // No 'completed' event because OAuth itself failed.
    expect(gmailEvents.find((e) => e.type === "completed")).toBeUndefined();
    // Upgrade gateway must NOT have been called — we never reached the
    // sync confirmation.
    expect(upgradeGateway.calls).toEqual([]);
  });
});

describe("bootstrapLoginUi — cancel restores the previous phase", () => {
  it("cancelling the sync modal hides the upgrade phase and emits 'cancelled'", async () => {
    const gmailGateway = new StubGmailGateway();
    const upgradeGateway = new StubUpgradeGateway();
    const listener = new FakeOAuthCallbackListener();
    const upgradeEvents: UpgradeEvent[] = [];

    const result = bootstrapLoginUi(root, {
      gmailGateway,
      upgradeGateway,
      localScope: { kind: "local", deviceId: "device-A" },
      oauthCallbackListener: listener,
      onUpgradeEvent: (e) => upgradeEvents.push(e),
    });
    expect(result).not.toBeNull();

    listener.dispatch({ code: "g-code", state: "g-state" });
    await Promise.resolve();
    await Promise.resolve();

    const cancelButton = root.querySelector<HTMLButtonElement>(
      ".upgrade-cancel-button",
    )!;
    cancelButton.click();

    expect(result!.upgradeController.getState().status.kind).toBe("idle");
    expect(upgradeEvents).toContainEqual({ type: "cancelled" });
    // The gateway was never called because the user cancelled before
    // confirming.
    expect(upgradeGateway.calls).toEqual([]);
  });
});
