/**
 * LocalToCloudUpgradeScreen controller (task 17.4).
 *
 * Source:
 *   • design.md → "Session Modes" → "Local-to-cloud upgrade mode".
 *   • design.md → "Auth Service" → `upgradeLocalSessionToGoogle`.
 *   • requirements.md → Requirements 2.7, 2.8, 3.5.
 *
 * Framework-free controller that mirrors the structure of
 * {@link GmailLoginScreen}: the controller owns the state machine and
 * the gateway calls; the DOM render shell (a separate file) listens
 * for state changes and renders the modal.
 *
 * State machine (see types.ts for the discriminated union):
 *
 *   1. `idle` — initial state.
 *   2. `setCallback({ code, state })` → `awaitingConfirmation` with
 *      both confirmation flags defaulting to `false` (Requirement 2.8:
 *      sync requires explicit user confirmation).
 *   3. `setSyncSettings(boolean)` / `setSyncApiKeys(boolean)` toggle
 *      the per-collection flags while in `awaitingConfirmation`.
 *   4. `confirm()` → `upgrading` → `gateway.upgradeLocalSessionToGoogle`
 *      → `completed | settingsLoadFailed | error`.
 *      • On success the merge report is stored in the state and a
 *        `"completed"` event is emitted.
 *      • On `settings_load_failed` (Requirement 3.5) the controller
 *        transitions to `settingsLoadFailed` so the renderer can
 *        surface the "retry later" notice.
 *      • On any other failure the controller transitions to `error`.
 *   5. `cancel()` → returns to `idle` and emits `"cancelled"`.
 *   6. `reset()` → returns to `idle`. Used to retry after a failure.
 *
 * Concurrency:
 *   • Only one upgrade can be in flight at a time. A second `confirm()`
 *     while one is `upgrading` is a no-op. Per-call sequence numbers
 *     guard against stale resolutions overwriting fresh state after
 *     `reset()` / `cancel()`.
 *
 * Validates: Requirements 2.7, 2.8, 3.5.
 */

import type {
  LocalScopeForUpgrade,
  OAuthCallbackParams,
  UpgradeEvent,
  UpgradeEventListener,
  UpgradeGateway,
  UpgradeMergeReport,
  UpgradeState,
  UpgradeStateListener,
  UpgradeStatus,
} from "./types.js";
import type { Session } from "@ai-agent-orchestrator/shared-core";
import { isSettingsLoadFailedError } from "../../ports/auth.js";

/** Constructor options. */
export interface LocalToCloudUpgradeScreenOptions {
  readonly gateway: UpgradeGateway;
  readonly localScope: LocalScopeForUpgrade;
  /**
   * Optional initial defaults for the confirmation flags. Both default
   * to `false` so Requirement 2.8 ("API_Key must never sync to cloud
   * without explicit user confirmation") is honoured even if the host
   * skips the toggle UI. A host MAY pass `true` for `syncSettings` if
   * the design decides to default settings sync on; that is a UX
   * decision and is not part of the controller's defaults.
   */
  readonly defaults?: {
    readonly syncSettings?: boolean;
    readonly syncApiKeys?: boolean;
  };
}

/**
 * Framework-free local-to-cloud upgrade controller.
 */
export class LocalToCloudUpgradeScreen {
  private readonly gateway: UpgradeGateway;
  private readonly localScope: LocalScopeForUpgrade;
  private readonly defaults: {
    readonly syncSettings: boolean;
    readonly syncApiKeys: boolean;
  };
  private state: UpgradeState = { status: { kind: "idle" } };
  private readonly stateListeners = new Set<UpgradeStateListener>();
  private readonly eventListeners = new Set<UpgradeEventListener>();
  private upgradeSeq = 0;

  public constructor(options: LocalToCloudUpgradeScreenOptions) {
    this.gateway = options.gateway;
    this.localScope = options.localScope;
    this.defaults = {
      syncSettings: options.defaults?.syncSettings ?? false,
      syncApiKeys: options.defaults?.syncApiKeys ?? false,
    };
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  public getState(): UpgradeState {
    return this.state;
  }

  public subscribeState(listener: UpgradeStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public subscribeEvents(listener: UpgradeEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  /**
   * Provides the OAuth callback parameters and transitions to
   * `awaitingConfirmation`. The host (Desktop loginBootstrap or web
   * shell oauthCallback) calls this once it has captured `code` and
   * `state` from the post-Google redirect.
   */
  public setCallback(callback: OAuthCallbackParams): void {
    if (callback.code.length === 0 || callback.state.length === 0) {
      const next: UpgradeStatus = {
        kind: "error",
        code: "missing_callback_params",
        message: "OAuth callback is missing 'code' or 'state'",
      };
      this.update(next);
      return;
    }
    const next: UpgradeStatus = {
      kind: "awaitingConfirmation",
      callback,
      syncSettings: this.defaults.syncSettings,
      syncApiKeys: this.defaults.syncApiKeys,
    };
    this.update(next);
  }

  /** Toggles the "sync local settings to cloud" confirmation flag. */
  public setSyncSettings(value: boolean): void {
    if (this.state.status.kind !== "awaitingConfirmation") return;
    if (this.state.status.syncSettings === value) return;
    this.update({
      ...this.state.status,
      syncSettings: value,
    });
  }

  /**
   * Toggles the "sync local API keys to cloud" confirmation flag.
   * Requirement 2.8: this MUST default to `false` and only flip on a
   * deliberate user action.
   */
  public setSyncApiKeys(value: boolean): void {
    if (this.state.status.kind !== "awaitingConfirmation") return;
    if (this.state.status.syncApiKeys === value) return;
    this.update({
      ...this.state.status,
      syncApiKeys: value,
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * User pressed "Confirm" in the modal. Invokes the gateway with the
   * captured callback + the per-collection confirmation flags.
   */
  public async confirm(): Promise<UpgradeStatus> {
    const status = this.state.status;
    if (status.kind !== "awaitingConfirmation") {
      // Defence-in-depth: a `confirm()` outside the modal state is a
      // host bug. Returning the current status keeps the controller
      // tolerant.
      return status;
    }

    const seq = ++this.upgradeSeq;
    const upgrading: UpgradeStatus = {
      kind: "upgrading",
      callback: status.callback,
      syncSettings: status.syncSettings,
      syncApiKeys: status.syncApiKeys,
    };
    this.update(upgrading);

    let result: { session: Session; mergeReport: UpgradeMergeReport };
    try {
      result = await this.gateway.upgradeLocalSessionToGoogle({
        localScope: this.localScope,
        code: status.callback.code,
        state: status.callback.state,
        syncSettings: status.syncSettings,
        syncApiKeys: status.syncApiKeys,
      });
    } catch (err: unknown) {
      if (seq !== this.upgradeSeq) {
        // A reset/cancel/setCallback raced ahead — drop this result.
        return this.state.status;
      }
      // Requirement 3.5: special-case "settings load failed".
      if (isSettingsLoadFailedError(err)) {
        const next: UpgradeStatus = {
          kind: "settingsLoadFailed",
          message:
            "We couldn't load your saved settings. This is usually temporary — please retry later.",
        };
        this.update(next);
        return next;
      }
      const code = readErrorCode(err);
      const next: UpgradeStatus = {
        kind: "error",
        ...(code !== undefined ? { code } : {}),
        message: describeError(err),
      };
      this.update(next);
      return next;
    }

    if (seq !== this.upgradeSeq) {
      return this.state.status;
    }
    const completed: UpgradeStatus = {
      kind: "completed",
      session: result.session,
      mergeReport: result.mergeReport,
      syncSettings: status.syncSettings,
      syncApiKeys: status.syncApiKeys,
    };
    this.update(completed);
    this.emit({
      type: "completed",
      session: result.session,
      mergeReport: result.mergeReport,
    });
    return completed;
  }

  /**
   * User pressed "Cancel" in the modal. Returns to `idle` and emits
   * `"cancelled"`. Calling `cancel()` while `upgrading` cancels the
   * in-flight call's effect on the controller (the gateway promise is
   * not aborted — there is no AbortController port at this layer —
   * but its resolution will be discarded by the sequence-number
   * check).
   */
  public cancel(): void {
    if (this.state.status.kind === "idle") return;
    this.upgradeSeq += 1;
    this.update({ kind: "idle" });
    this.emit({ type: "cancelled" });
  }

  /**
   * Resets to `idle` after a `settingsLoadFailed` or `error`. Does NOT
   * emit `"cancelled"` — this is a recovery action, not a deliberate
   * user dismissal of the flow.
   */
  public reset(): void {
    if (this.state.status.kind === "idle") return;
    this.upgradeSeq += 1;
    this.update({ kind: "idle" });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private update(nextStatus: UpgradeStatus): void {
    if (this.state.status === nextStatus) return;
    const next: UpgradeState = { status: nextStatus };
    this.state = next;
    for (const listener of this.stateListeners) {
      listener(next);
    }
  }

  private emit(event: UpgradeEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return m.length > 0 ? m : err.name;
  }
  if (typeof err === "string") return err;
  return "unknown error";
}

function readErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return undefined;
}
