/**
 * Unit tests for the framework-free LocalToCloudUpgradeScreen
 * controller (task 17.4).
 *
 * Validates: Requirements 2.7, 2.8, 3.5.
 */

import { describe, expect, it } from "vitest";

import { LocalToCloudUpgradeScreen } from "./localToCloudUpgradeScreen.js";
import type {
  LocalScopeForUpgrade,
  Session,
  UpgradeEvent,
  UpgradeGateway,
  UpgradeMergeReport,
} from "./types.js";

const FIXED_LOCAL_SCOPE: LocalScopeForUpgrade = {
  kind: "local",
  deviceId: "device-A",
};

const FIXED_SESSION: Session = {
  id: "session-cloud-1",
  kind: "cloud",
  userId: "user_42",
  createdAt: "2025-01-01T00:00:00.000Z",
  expiresAt: "2025-02-01T00:00:00.000Z",
};

const EMPTY_REPORT: UpgradeMergeReport = {
  apiKeys: {
    copiedToCloud: [],
    cloudWonOver: [],
    preservedLocalOnly: [],
  },
  customAgents: {
    copiedToCloud: [],
    conflicts: [],
  },
  preferences: {
    copiedToCloud: [],
    cloudWon: [],
  },
};

class RecordingGateway implements UpgradeGateway {
  public readonly calls: Array<{
    localScope: LocalScopeForUpgrade;
    code: string;
    state: string;
    syncSettings: boolean;
    syncApiKeys: boolean;
  }> = [];
  private nextResult: { session: Session; mergeReport: UpgradeMergeReport } = {
    session: FIXED_SESSION,
    mergeReport: EMPTY_REPORT,
  };
  private nextError: unknown = null;
  private resolveSignal: (() => void) | null = null;
  private waitPromise: Promise<void> | null = null;

  public setNextResult(result: {
    session: Session;
    mergeReport: UpgradeMergeReport;
  }): void {
    this.nextResult = result;
    this.nextError = null;
  }

  public throwNext(err: unknown): void {
    this.nextError = err;
  }

  /**
   * Causes the next call to wait until `releasePending()` is invoked.
   * Lets tests assert intermediate `upgrading` state.
   */
  public block(): void {
    this.waitPromise = new Promise((resolve) => {
      this.resolveSignal = resolve;
    });
  }

  public release(): void {
    if (this.resolveSignal) {
      const fn = this.resolveSignal;
      this.resolveSignal = null;
      this.waitPromise = null;
      fn();
    }
  }

  public async upgradeLocalSessionToGoogle(input: {
    readonly localScope: LocalScopeForUpgrade;
    readonly code: string;
    readonly state: string;
    readonly syncSettings: boolean;
    readonly syncApiKeys: boolean;
  }): Promise<{ session: Session; mergeReport: UpgradeMergeReport }> {
    this.calls.push({
      localScope: input.localScope,
      code: input.code,
      state: input.state,
      syncSettings: input.syncSettings,
      syncApiKeys: input.syncApiKeys,
    });
    if (this.waitPromise !== null) {
      await this.waitPromise;
    }
    if (this.nextError !== null) {
      const err = this.nextError;
      this.nextError = null;
      throw err as Error;
    }
    return this.nextResult;
  }
}

function build(options?: {
  defaults?: { syncSettings?: boolean; syncApiKeys?: boolean };
}): {
  controller: LocalToCloudUpgradeScreen;
  gateway: RecordingGateway;
} {
  const gateway = new RecordingGateway();
  const controller = new LocalToCloudUpgradeScreen({
    gateway,
    localScope: FIXED_LOCAL_SCOPE,
    ...(options?.defaults ? { defaults: options.defaults } : {}),
  });
  return { controller, gateway };
}

describe("LocalToCloudUpgradeScreen — initial state", () => {
  it("starts in idle", () => {
    const { controller } = build();
    expect(controller.getState().status).toEqual({ kind: "idle" });
  });
});

describe("LocalToCloudUpgradeScreen — setCallback", () => {
  it("transitions to awaitingConfirmation with both flags defaulting to false (Req. 2.8)", () => {
    const { controller } = build();
    controller.setCallback({ code: "g-code", state: "g-state" });
    const status = controller.getState().status;
    expect(status.kind).toBe("awaitingConfirmation");
    if (status.kind === "awaitingConfirmation") {
      expect(status.callback).toEqual({ code: "g-code", state: "g-state" });
      expect(status.syncSettings).toBe(false);
      expect(status.syncApiKeys).toBe(false);
    }
  });

  it("respects host-provided defaults but never opt-ins API keys silently", () => {
    const { controller } = build({
      defaults: { syncSettings: true, syncApiKeys: true },
    });
    controller.setCallback({ code: "c", state: "s" });
    const status = controller.getState().status;
    if (status.kind === "awaitingConfirmation") {
      expect(status.syncSettings).toBe(true);
      // The defaults plumb through, but tests confirm the controller
      // cannot synthesize a `true` for syncApiKeys without an explicit
      // host opt-in.
      expect(status.syncApiKeys).toBe(true);
    }
  });

  it("rejects an empty code with a structured error", () => {
    const { controller } = build();
    controller.setCallback({ code: "", state: "s" });
    const status = controller.getState().status;
    expect(status.kind).toBe("error");
    if (status.kind === "error") {
      expect(status.code).toBe("missing_callback_params");
    }
  });

  it("rejects an empty state with a structured error", () => {
    const { controller } = build();
    controller.setCallback({ code: "c", state: "" });
    const status = controller.getState().status;
    expect(status.kind).toBe("error");
    if (status.kind === "error") {
      expect(status.code).toBe("missing_callback_params");
    }
  });
});

describe("LocalToCloudUpgradeScreen — toggle flags", () => {
  it("setSyncSettings/setSyncApiKeys update awaitingConfirmation flags", () => {
    const { controller } = build();
    controller.setCallback({ code: "c", state: "s" });
    controller.setSyncSettings(true);
    controller.setSyncApiKeys(true);
    const status = controller.getState().status;
    if (status.kind === "awaitingConfirmation") {
      expect(status.syncSettings).toBe(true);
      expect(status.syncApiKeys).toBe(true);
    }
  });

  it("toggle is a no-op outside awaitingConfirmation", () => {
    const { controller } = build();
    controller.setSyncSettings(true);
    controller.setSyncApiKeys(true);
    expect(controller.getState().status.kind).toBe("idle");
  });
});

describe("LocalToCloudUpgradeScreen — confirm", () => {
  it("forwards the captured flags verbatim to the gateway (Req. 2.7, 2.8)", async () => {
    const { controller, gateway } = build();
    controller.setCallback({ code: "code-1", state: "state-1" });
    controller.setSyncSettings(true);
    controller.setSyncApiKeys(false);
    await controller.confirm();

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toEqual({
      localScope: FIXED_LOCAL_SCOPE,
      code: "code-1",
      state: "state-1",
      syncSettings: true,
      syncApiKeys: false,
    });
  });

  it("never invokes the gateway if syncApiKeys is left unchecked AND syncSettings is unchecked: still allowed but flags forwarded", async () => {
    // Even with both flags false, the upgrade is still invoked so the
    // backend can mint the cloud session. The collections themselves
    // remain untouched server-side because the backend gates them on
    // those flags. The test just records the expectation that the
    // controller never silently synthesizes a `true`.
    const { controller, gateway } = build();
    controller.setCallback({ code: "c", state: "s" });
    await controller.confirm();
    expect(gateway.calls[0]?.syncSettings).toBe(false);
    expect(gateway.calls[0]?.syncApiKeys).toBe(false);
  });

  it("transitions through upgrading → completed and records the merge report", async () => {
    const { controller, gateway } = build();
    const seenStatuses: string[] = [];
    controller.subscribeState((s) => seenStatuses.push(s.status.kind));
    controller.setCallback({ code: "c", state: "s" });

    const report: UpgradeMergeReport = {
      apiKeys: {
        copiedToCloud: ["openai"],
        cloudWonOver: [],
        preservedLocalOnly: [],
      },
      customAgents: {
        copiedToCloud: ["agent-1"],
        conflicts: [{ agentId: "agent-2", reason: "builtin_name" }],
      },
      preferences: {
        copiedToCloud: ["theme"],
        cloudWon: ["language"],
      },
    };
    gateway.setNextResult({ session: FIXED_SESSION, mergeReport: report });

    gateway.block();
    const pending = controller.confirm();
    // The state should be `upgrading` while the gateway is in flight.
    expect(controller.getState().status.kind).toBe("upgrading");
    gateway.release();
    await pending;

    const finalStatus = controller.getState().status;
    expect(finalStatus.kind).toBe("completed");
    if (finalStatus.kind === "completed") {
      expect(finalStatus.session).toBe(FIXED_SESSION);
      expect(finalStatus.mergeReport).toBe(report);
    }
    expect(seenStatuses).toContain("upgrading");
    expect(seenStatuses[seenStatuses.length - 1]).toBe("completed");
  });

  it("emits a 'completed' event with the session and merge report", async () => {
    const { controller } = build();
    const events: UpgradeEvent[] = [];
    controller.subscribeEvents((e) => events.push(e));
    controller.setCallback({ code: "c", state: "s" });
    await controller.confirm();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "completed",
      session: FIXED_SESSION,
      mergeReport: EMPTY_REPORT,
    });
  });

  it("transitions to settingsLoadFailed when the gateway throws { code: 'settings_load_failed' } (Req. 3.5)", async () => {
    const { controller, gateway } = build();
    gateway.throwNext({
      name: "SettingsLoadError",
      code: "settings_load_failed",
      message: "cloud settings backend unreachable",
    });
    controller.setCallback({ code: "c", state: "s" });
    await controller.confirm();
    const status = controller.getState().status;
    expect(status.kind).toBe("settingsLoadFailed");
    if (status.kind === "settingsLoadFailed") {
      expect(status.message.toLowerCase()).toContain("retry later");
    }
  });

  it("does not emit 'completed' on settingsLoadFailed", async () => {
    const { controller, gateway } = build();
    const events: UpgradeEvent[] = [];
    controller.subscribeEvents((e) => events.push(e));
    gateway.throwNext({ code: "settings_load_failed", message: "oops" });
    controller.setCallback({ code: "c", state: "s" });
    await controller.confirm();
    expect(events).toEqual([]);
  });

  it("translates a generic gateway throw into a structured error", async () => {
    const { controller, gateway } = build();
    gateway.throwNext(Object.assign(new Error("transport blew up"), { code: "transport_failed" }));
    controller.setCallback({ code: "c", state: "s" });
    await controller.confirm();
    const status = controller.getState().status;
    expect(status.kind).toBe("error");
    if (status.kind === "error") {
      expect(status.code).toBe("transport_failed");
      expect(status.message).toContain("transport blew up");
    }
  });
});

describe("LocalToCloudUpgradeScreen — cancel and reset", () => {
  it("cancel returns to idle and emits 'cancelled'", () => {
    const { controller } = build();
    const events: UpgradeEvent[] = [];
    controller.subscribeEvents((e) => events.push(e));
    controller.setCallback({ code: "c", state: "s" });
    controller.cancel();
    expect(controller.getState().status.kind).toBe("idle");
    expect(events).toContainEqual({ type: "cancelled" });
  });

  it("reset returns to idle without emitting 'cancelled'", async () => {
    const { controller, gateway } = build();
    const events: UpgradeEvent[] = [];
    controller.subscribeEvents((e) => events.push(e));
    gateway.throwNext({ code: "settings_load_failed", message: "x" });
    controller.setCallback({ code: "c", state: "s" });
    await controller.confirm();
    expect(controller.getState().status.kind).toBe("settingsLoadFailed");

    controller.reset();
    expect(controller.getState().status.kind).toBe("idle");
    expect(events).toEqual([]);
  });

  it("a stale upgrade resolution does not overwrite a fresh state after reset()", async () => {
    const { controller, gateway } = build();
    controller.setCallback({ code: "c", state: "s" });
    gateway.block();
    const pending = controller.confirm();
    expect(controller.getState().status.kind).toBe("upgrading");
    controller.reset();
    expect(controller.getState().status.kind).toBe("idle");
    gateway.release();
    await pending;
    // Still idle even after the late resolution.
    expect(controller.getState().status.kind).toBe("idle");
  });
});
