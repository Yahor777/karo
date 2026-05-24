// @vitest-environment jsdom
/**
 * Renderer-side OAuth callback view tests (task 17.4).
 *
 * Validates: Requirements 2.7, 2.8, 3.1, 3.5, 3.6.
 *
 * Covers:
 *   • The Gmail screen + upgrade screen mount into the supplied root.
 *   • The view dispatches the captured OAuth `code`/`state` to both
 *     controllers when constructed with `callback`.
 *   • The upgrade modal honours the "user must explicitly consent"
 *     rule: both checkboxes default to UNCHECKED (Requirement 2.8).
 *   • Confirming with both flags ticked invokes the upgrade gateway
 *     with `syncSettings: true` and `syncApiKeys: true` and renders
 *     the merge report (Requirement 3.6 surface).
 *   • A `settings_load_failed` rejection from either gateway surfaces
 *     the dedicated retry-later notice (Requirement 3.5).
 *   • `parseOAuthCallbackParams` parses well-formed query strings and
 *     rejects malformed ones.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  mountOAuthCallbackView,
  parseOAuthCallbackParams,
} from "./oauthCallbackView.js";
import type {
  GmailLoginGateway,
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
    cloudWonOver: [],
    preservedLocalOnly: [],
  },
  customAgents: {
    copiedToCloud: ["agent-1"],
    conflicts: [],
  },
  preferences: {
    copiedToCloud: ["theme"],
    cloudWon: [],
  },
};

class StubGmailGateway implements GmailLoginGateway {
  public completeCalls: Array<{ code: string; state: string }> = [];
  private nextCompleteError: unknown = null;

  public setCompleteError(err: unknown): void {
    this.nextCompleteError = err;
  }

  public async beginGoogleOAuth(): Promise<{
    authorizationUrl: string;
    state: string;
  }> {
    return { authorizationUrl: "https://accounts.google.com/test", state: "s" };
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
    return SAMPLE_CLOUD_SESSION;
  }
}

class StubUpgradeGateway implements UpgradeGateway {
  public calls: Array<{
    code: string;
    state: string;
    syncSettings: boolean;
    syncApiKeys: boolean;
  }> = [];
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
    return { session: SAMPLE_CLOUD_SESSION, mergeReport: SAMPLE_REPORT };
  }
}

describe("mountOAuthCallbackView", () => {
  it("renders both the Gmail status surface and the upgrade modal containers", () => {
    const result = mountOAuthCallbackView(root);
    expect(root.querySelector(".oauth-callback-gmail")).not.toBeNull();
    expect(root.querySelector(".oauth-callback-upgrade")).not.toBeNull();
    expect(root.querySelector(".gmail-login-continue")).not.toBeNull();
    expect(root.querySelector(".upgrade-confirm-modal")).not.toBeNull();
    result.unmount();
    expect(root.children.length).toBe(0);
  });

  it("dispatches the captured callback to both controllers when provided via options", async () => {
    const gmailGateway = new StubGmailGateway();
    const upgradeGateway = new StubUpgradeGateway();
    const result = mountOAuthCallbackView(root, {
      gmailGateway,
      upgradeGateway,
      callback: { code: "g-code", state: "g-state" },
      localScope: { kind: "local", deviceId: "device-Z" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(gmailGateway.completeCalls).toEqual([
      { code: "g-code", state: "g-state" },
    ]);

    const upgradeStatus = result.upgradeController.getState().status.kind;
    expect(upgradeStatus).toBe("awaitingConfirmation");
  });

  it("starts the upgrade modal with both consent checkboxes UNCHECKED (Req. 2.8)", async () => {
    const result = mountOAuthCallbackView(root, {
      gmailGateway: new StubGmailGateway(),
      upgradeGateway: new StubUpgradeGateway(),
      callback: { code: "c", state: "s" },
    });
    await Promise.resolve();
    await Promise.resolve();
    const settingsCheckbox = root.querySelector<HTMLInputElement>(
      'input[name="syncSettings"]',
    )!;
    const apiKeysCheckbox = root.querySelector<HTMLInputElement>(
      'input[name="syncApiKeys"]',
    )!;
    expect(settingsCheckbox.checked).toBe(false);
    expect(apiKeysCheckbox.checked).toBe(false);
    result.unmount();
  });

  it("surfaces the merge report after explicit confirmation (Req. 2.7, 3.6)", async () => {
    const upgradeGateway = new StubUpgradeGateway();
    const events: UpgradeEvent[] = [];

    mountOAuthCallbackView(root, {
      gmailGateway: new StubGmailGateway(),
      upgradeGateway,
      callback: { code: "c", state: "s" },
      onUpgradeEvent: (e) => events.push(e),
    });
    await Promise.resolve();
    await Promise.resolve();

    const settingsCheckbox = root.querySelector<HTMLInputElement>(
      'input[name="syncSettings"]',
    )!;
    settingsCheckbox.checked = true;
    settingsCheckbox.dispatchEvent(new Event("change"));
    const apiKeysCheckbox = root.querySelector<HTMLInputElement>(
      'input[name="syncApiKeys"]',
    )!;
    apiKeysCheckbox.checked = true;
    apiKeysCheckbox.dispatchEvent(new Event("change"));

    const confirm = root.querySelector<HTMLButtonElement>(
      ".upgrade-confirm-button",
    )!;
    confirm.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(upgradeGateway.calls).toEqual([
      {
        code: "c",
        state: "s",
        syncSettings: true,
        syncApiKeys: true,
      },
    ]);

    const mergeSurface = root.querySelector<HTMLElement>(
      ".upgrade-merge-report",
    );
    expect(mergeSurface).not.toBeNull();
    expect(mergeSurface!.hidden).toBe(false);
    expect(
      mergeSurface!.querySelector('dd[data-merge-key="apiKeys.copied"]')
        ?.textContent,
    ).toBe("1");

    expect(events).toContainEqual({
      type: "completed",
      session: SAMPLE_CLOUD_SESSION,
      mergeReport: SAMPLE_REPORT,
    });
  });

  it("surfaces the retry-later notice if the upgrade gateway throws settings_load_failed (Req. 3.5)", async () => {
    const upgradeGateway = new StubUpgradeGateway();
    upgradeGateway.setError({
      name: "SettingsLoadError",
      code: "settings_load_failed",
      message: "cloud settings backend unreachable",
    });
    mountOAuthCallbackView(root, {
      gmailGateway: new StubGmailGateway(),
      upgradeGateway,
      callback: { code: "c", state: "s" },
    });
    await Promise.resolve();
    await Promise.resolve();

    const confirm = root.querySelector<HTMLButtonElement>(
      ".upgrade-confirm-button",
    )!;
    confirm.click();
    await Promise.resolve();
    await Promise.resolve();

    const retryNotice = root.querySelector<HTMLElement>(".upgrade-retry");
    expect(retryNotice).not.toBeNull();
    expect(retryNotice!.hidden).toBe(false);
    expect(
      retryNotice!.querySelector(".upgrade-retry-message")?.textContent
        ?.toLowerCase(),
    ).toContain("retry later");
  });

  it("Gmail screen surfaces retry-later if completeGoogleOAuth throws settings_load_failed", async () => {
    const gmailGateway = new StubGmailGateway();
    gmailGateway.setCompleteError({
      name: "SettingsLoadError",
      code: "settings_load_failed",
      message: "cloud settings backend unreachable",
    });
    mountOAuthCallbackView(root, {
      gmailGateway,
      upgradeGateway: new StubUpgradeGateway(),
      callback: { code: "c", state: "s" },
    });
    await Promise.resolve();
    await Promise.resolve();

    const retryNotice = root.querySelector<HTMLElement>(".gmail-login-retry");
    expect(retryNotice).not.toBeNull();
    expect(retryNotice!.hidden).toBe(false);
    expect(
      retryNotice!.querySelector(".gmail-login-retry-message")?.textContent
        ?.toLowerCase(),
    ).toContain("retry later");
  });
});

describe("parseOAuthCallbackParams", () => {
  it("parses ?code=...&state=... into an object", () => {
    expect(parseOAuthCallbackParams("?code=AAA&state=BBB")).toEqual({
      code: "AAA",
      state: "BBB",
    });
  });

  it("accepts the search string without a leading '?'", () => {
    expect(parseOAuthCallbackParams("code=AAA&state=BBB")).toEqual({
      code: "AAA",
      state: "BBB",
    });
  });

  it("returns null when code is missing", () => {
    expect(parseOAuthCallbackParams("?state=only-state")).toBeNull();
  });

  it("returns null when state is missing", () => {
    expect(parseOAuthCallbackParams("?code=only-code")).toBeNull();
  });

  it("returns null for empty / null / undefined input", () => {
    expect(parseOAuthCallbackParams(null)).toBeNull();
    expect(parseOAuthCallbackParams(undefined)).toBeNull();
    expect(parseOAuthCallbackParams("")).toBeNull();
    expect(parseOAuthCallbackParams("?")).toBeNull();
  });
});
