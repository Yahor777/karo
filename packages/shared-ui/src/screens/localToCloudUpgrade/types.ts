/**
 * Local-to-cloud upgrade screen types and ports (task 17.4).
 *
 * Source:
 *   • design.md → "Session Modes" → "Local-to-cloud upgrade mode":
 *       1. user has local API-key-only session;
 *       2. user chooses Gmail OAuth;
 *       3. app asks whether to sync local settings to cloud;
 *       4. user can confirm or decline;
 *       5. if confirmed, settings_store merges local settings into cloud;
 *       6. API keys are synced only with explicit confirmation;
 *       7. session becomes cloud session.
 *   • design.md → "Auth Service" → `upgradeLocalSessionToGoogle`.
 *   • requirements.md → Requirements 2.7, 2.8, 3.5, 3.6.
 *
 * The screen is the renderer-side counterpart of
 * `apps/backend/src/auth/upgradeLocalSession.ts` (task 17.3). It
 * captures the OAuth callback `code`/`state` from the host, asks the
 * user for explicit per-collection confirmation flags
 * (`syncSettings` and `syncApiKeys`), invokes the upgrade gateway,
 * and renders the resulting {@link UpgradeMergeReport} or a
 * "retry later" notice on Requirement 3.5 failures.
 *
 * Validates: Requirements 2.7, 2.8, 3.5.
 */

import type { Session } from "@ai-agent-orchestrator/shared-core";

import type {
  UpgradeGateway,
  UpgradeMergeReport,
} from "../../ports/auth.js";

export type { Session, UpgradeGateway, UpgradeMergeReport };

/**
 * Raw callback parameters captured by the host shell from the
 * `/oauth/callback` URL.
 */
export interface OAuthCallbackParams {
  readonly code: string;
  readonly state: string;
}

/**
 * Local scope being upgraded. Mirrors the backend's
 * `UpgradeLocalSessionInput.localScope` shape verbatim so the gateway
 * can forward it without a mapping layer.
 */
export interface LocalScopeForUpgrade {
  readonly kind: "local";
  readonly deviceId: string;
}

/**
 * State machine of the local-to-cloud upgrade screen.
 *
 *   • `idle` — initial state when the OAuth callback parameters have
 *     not yet been provided. The renderer typically renders nothing
 *     visible until the host calls `setCallback()`.
 *   • `awaitingConfirmation` — callback params are captured. The
 *     renderer shows the sync-confirmation modal with two
 *     independently-toggleable checkboxes (`syncSettings`,
 *     `syncApiKeys`) and Confirm / Cancel buttons.
 *   • `upgrading` — the gateway's `upgradeLocalSessionToGoogle` is in
 *     flight. The Confirm button is disabled and a spinner / status
 *     line is displayed.
 *   • `completed` — upgrade succeeded. The renderer shows the
 *     {@link UpgradeMergeReport} and a "Continue" button so the host
 *     can transition to the post-login route.
 *   • `settingsLoadFailed` — Requirement 3.5: the upgrade failed
 *     because the cloud settings could not be loaded. The renderer
 *     surfaces a clear "we couldn't load your settings — please try
 *     again later" message and a Retry button that resets to `idle`.
 *   • `error` — any other failure. `code` and `message` are surfaced
 *     for diagnostics; the Retry button resets to `idle`.
 */
export type UpgradeStatus =
  | { readonly kind: "idle" }
  | {
      readonly kind: "awaitingConfirmation";
      readonly callback: OAuthCallbackParams;
      readonly syncSettings: boolean;
      readonly syncApiKeys: boolean;
    }
  | {
      readonly kind: "upgrading";
      readonly callback: OAuthCallbackParams;
      readonly syncSettings: boolean;
      readonly syncApiKeys: boolean;
    }
  | {
      readonly kind: "completed";
      readonly session: Session;
      readonly mergeReport: UpgradeMergeReport;
      readonly syncSettings: boolean;
      readonly syncApiKeys: boolean;
    }
  | {
      readonly kind: "settingsLoadFailed";
      readonly message: string;
    }
  | {
      readonly kind: "error";
      readonly code?: string;
      readonly message: string;
    };

/** Aggregate state of the upgrade screen. */
export interface UpgradeState {
  readonly status: UpgradeStatus;
}

/**
 * Events emitted by the upgrade screen for the host shell.
 *
 *   • `"completed"` — the upgrade succeeded. The host typically
 *     transitions to the post-login route (`/tasks` on web,
 *     Task Builder on desktop) and surfaces the
 *     {@link UpgradeMergeReport} elsewhere if needed.
 *   • `"cancelled"` — the user dismissed the confirmation modal
 *     before invoking the gateway. The host typically returns to
 *     the previous (local) session UI.
 */
export type UpgradeEvent =
  | {
      readonly type: "completed";
      readonly session: Session;
      readonly mergeReport: UpgradeMergeReport;
    }
  | { readonly type: "cancelled" };

/** Subscriber for state updates. */
export type UpgradeStateListener = (state: UpgradeState) => void;
/** Subscriber for emitted events. */
export type UpgradeEventListener = (event: UpgradeEvent) => void;
