/**
 * Renderer-side OAuth callback view (task 17.4).
 *
 * Pairs with the server-side {@link handleOAuthCallback}: the server
 * mints the cloud session and sets the secure HTTP-only cookie, then
 * redirects the renderer back to `/oauth/callback`. The renderer
 * lands here, mounts {@link GmailLoginScreen} (so the user sees a
 * sensible "Completing sign-in…" status if the redirect was slow)
 * and {@link LocalToCloudUpgradeScreen} (so any local-API-key
 * settings discovered on the device can be optionally merged into
 * the cloud account, with explicit per-collection confirmation per
 * Requirements 2.7, 2.8).
 *
 * Why not the same file as `oauthCallback.ts`?
 *   • `oauthCallback.ts` runs on the server and writes Node response
 *     headers; this file runs in the browser. Keeping the two
 *     surfaces separate avoids accidental cross-boundary imports.
 *
 * Composition rules (task 17.4 deliverables):
 *   • Shared-ui code does not import web internals — instead this
 *     file implements thin gateway adapters and passes them to the
 *     screens.
 *   • The renderer never sees the OAuth `code` directly — the
 *     cookie has already been minted server-side. The Gmail screen
 *     therefore renders only the "completing" + post-success surface
 *     and is wired to a gateway that surfaces the already-minted
 *     session via `completeGoogleOAuth`. Tests use a stub.
 *
 * Validates: Requirements 2.7, 2.8, 3.1, 3.5, 3.6.
 */

import {
  GmailLoginScreen,
  LocalToCloudUpgradeScreen,
  mountGmailLoginScreen,
  mountLocalToCloudUpgradeScreen,
  type GmailLoginEvent,
  type GmailLoginGateway,
  type LocalScopeForUpgrade,
  type Session,
  type UpgradeEvent,
  type UpgradeGateway,
  type UpgradeMergeReport,
} from "@ai-agent-orchestrator/shared-ui";

/**
 * Default "not wired" Gmail gateway used by the web bootstrap when no
 * Client SDK adapter has been wired yet. The renderer doesn't perform
 * the OAuth handshake itself — the server already did — so the
 * gateway's `beginGoogleOAuth` is unreachable in the OAuth-callback
 * route. We surface a structured `gateway_not_wired` error so the
 * Gmail screen renders a precise diagnostic instead of hanging.
 */
export const notWiredGmailLoginGateway: GmailLoginGateway = {
  beginGoogleOAuth(): Promise<{
    authorizationUrl: string;
    state: string;
  }> {
    return Promise.reject(
      Object.assign(
        new Error(
          "Gmail OAuth transport is not yet wired in the web renderer.",
        ),
        { code: "gateway_not_wired" },
      ),
    );
  },
  completeGoogleOAuth(): Promise<Session> {
    return Promise.reject(
      Object.assign(
        new Error(
          "Gmail OAuth transport is not yet wired in the web renderer.",
        ),
        { code: "gateway_not_wired" },
      ),
    );
  },
};

/** Default "not wired" upgrade gateway. */
export const notWiredUpgradeGateway: UpgradeGateway = {
  upgradeLocalSessionToGoogle(): Promise<{
    session: Session;
    mergeReport: UpgradeMergeReport;
  }> {
    return Promise.reject(
      Object.assign(
        new Error(
          "Local-to-cloud upgrade transport is not yet wired in the web renderer.",
        ),
        { code: "gateway_not_wired" },
      ),
    );
  },
};

/** Options for {@link mountOAuthCallbackView}. */
export interface MountOAuthCallbackViewOptions {
  /** Gmail OAuth gateway. Defaults to {@link notWiredGmailLoginGateway}. */
  readonly gmailGateway?: GmailLoginGateway;
  /** Upgrade gateway. Defaults to {@link notWiredUpgradeGateway}. */
  readonly upgradeGateway?: UpgradeGateway;
  /**
   * Local scope to upgrade from. The web shell does not own a local
   * encrypted store, so this is normally absent — the upgrade
   * controller is then mounted but the modal stays hidden until the
   * host calls `setCallback()` (typically only when a desktop ↔ web
   * deep-link delivers OAuth params).
   */
  readonly localScope?: LocalScopeForUpgrade;
  /**
   * The OAuth callback parameters captured from the URL. When present
   * the upgrade screen transitions to `awaitingConfirmation`
   * immediately; when absent the modal stays hidden.
   */
  readonly callback?: { readonly code: string; readonly state: string };
  /** Listener for Gmail-flow events. */
  readonly onGmailEvent?: (event: GmailLoginEvent) => void;
  /** Listener for upgrade-flow events. */
  readonly onUpgradeEvent?: (event: UpgradeEvent) => void;
  /** Optional document override for tests. */
  readonly doc?: Document;
}

/** Result of {@link mountOAuthCallbackView}. */
export interface MountOAuthCallbackViewResult {
  readonly gmailController: GmailLoginScreen;
  readonly upgradeController: LocalToCloudUpgradeScreen;
  /** Manually dispatch an OAuth callback to both controllers. */
  dispatchOAuthCallback(params: { code: string; state: string }): void;
  unmount(): void;
}

/**
 * Mounts the renderer-side OAuth callback view. Renders the Gmail
 * login status (so the "completing" line is visible while the
 * redirect settles) and the local-to-cloud upgrade modal in a single
 * container. Wiring is deliberately small — this is a view, not a
 * full page; the host bootstrap composes it with the rest of the
 * page chrome.
 */
export function mountOAuthCallbackView(
  root: HTMLElement,
  options: MountOAuthCallbackViewOptions = {},
): MountOAuthCallbackViewResult {
  const doc = options.doc ?? root.ownerDocument ?? globalThis.document;
  const gmailGateway = options.gmailGateway ?? notWiredGmailLoginGateway;
  const upgradeGateway = options.upgradeGateway ?? notWiredUpgradeGateway;
  // The web shell does not own a local device id by design (the local
  // encrypted storage is desktop-only). We use a synthetic placeholder
  // so the upgrade gateway can still be invoked when the renderer is
  // bridging a desktop-issued local scope (e.g. via deep-link).
  const localScope: LocalScopeForUpgrade =
    options.localScope ?? { kind: "local", deviceId: "web-no-local-scope" };

  root.innerHTML = "";

  const gmailContainer = doc.createElement("section");
  gmailContainer.className = "oauth-callback-gmail";
  root.appendChild(gmailContainer);

  const upgradeContainer = doc.createElement("section");
  upgradeContainer.className = "oauth-callback-upgrade";
  root.appendChild(upgradeContainer);

  const gmailController = new GmailLoginScreen({ gateway: gmailGateway });
  const upgradeController = new LocalToCloudUpgradeScreen({
    gateway: upgradeGateway,
    localScope,
  });

  if (options.onGmailEvent) gmailController.subscribeEvents(options.onGmailEvent);
  if (options.onUpgradeEvent) upgradeController.subscribeEvents(options.onUpgradeEvent);

  const gmailMount = mountGmailLoginScreen(gmailContainer, gmailController, { doc });
  const upgradeMount = mountLocalToCloudUpgradeScreen(
    upgradeContainer,
    upgradeController,
    { doc },
  );

  let mounted = true;
  const dispatchOAuthCallback = (params: {
    code: string;
    state: string;
  }): void => {
    if (!mounted) return;
    void gmailController.complete(params);
    upgradeController.setCallback(params);
  };

  if (options.callback) {
    dispatchOAuthCallback(options.callback);
  }

  return {
    gmailController,
    upgradeController,
    dispatchOAuthCallback,
    unmount(): void {
      mounted = false;
      upgradeMount.unmount();
      gmailMount.unmount();
      gmailContainer.remove();
      upgradeContainer.remove();
    },
  };
}

/**
 * Parses the search-string of an OAuth callback URL into
 * `{ code, state }` values. Returns `null` when either is missing or
 * empty so callers can short-circuit to the placeholder UI.
 */
export function parseOAuthCallbackParams(
  search: string | null | undefined,
): { code: string; state: string } | null {
  if (!search) return null;
  const trimmed = search.startsWith("?") ? search.slice(1) : search;
  if (trimmed.length === 0) return null;
  const params = new URLSearchParams(trimmed);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return null;
  return { code, state };
}
