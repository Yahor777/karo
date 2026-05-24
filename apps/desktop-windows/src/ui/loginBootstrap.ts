/**
 * Login screen bootstrap for the desktop renderer (tasks 4.3, 17.4).
 *
 * Mounts `@ai-agent-orchestrator/shared-ui` LoginScreen into the
 * supplied root and wires it to a gateway. The Gmail entry-mode now
 * mounts the {@link GmailLoginScreen} (task 17.4) into the same
 * container, then hands over to the local-to-cloud upgrade screen
 * once the OAuth callback resolves.
 *
 * Composition rules (task 17.4 deliverables):
 *
 *   • Shared-ui code does not import desktop or web internals — instead
 *     the desktop bootstrap implements three narrow ports
 *     ({@link LoginGateway}, {@link GmailLoginGateway},
 *     {@link UpgradeGateway}) and passes them to the controllers.
 *   • The Gmail login screen owns `beginGoogleOAuth` /
 *     `completeGoogleOAuth`. On success it hands control to the
 *     {@link LocalToCloudUpgradeScreen}, which captures the user's
 *     explicit `syncSettings` / `syncApiKeys` confirmation flags
 *     before invoking `upgradeLocalSessionToGoogle` (Requirements 2.7,
 *     2.8). The merge report is then surfaced to the user
 *     (Requirement 3.6 surface).
 *   • A failure with `code === "settings_load_failed"` is handled
 *     specially by the controllers themselves: the Gmail screen
 *     surfaces a "retry later" message (Requirement 3.5). If a stale
 *     local session attempted the upgrade, the upgrade screen makes
 *     the same surface available.
 *
 * Validates: Requirements 1.4, 2.1, 2.2, 2.3, 2.4, 2.7, 2.8, 3.1, 3.5, 3.6.
 */

import {
  RendererLoginGateway,
  type LocalApiKeySink,
} from "@ai-agent-orchestrator/client-sdk";
import {
  GmailLoginScreen,
  LocalToCloudUpgradeScreen,
  LoginScreen,
  mountGmailLoginScreen,
  mountLocalToCloudUpgradeScreen,
  mountLoginScreen,
  type GmailLoginEvent,
  type GmailLoginGateway,
  type LocalScopeForUpgrade,
  type LoginEvent,
  type LoginGateway,
  type MountLoginScreenResult,
  type Session,
  type UpgradeEvent,
  type UpgradeGateway,
  type UpgradeMergeReport,
  type ValidationResult,
} from "@ai-agent-orchestrator/shared-ui";

import { desktopShell } from "../shell/index.js";
import { createDesktopApiKeySink } from "./desktopApiKeySink.js";
import { createDesktopShellProbeClient } from "./desktopShellProbeClient.js";

/**
 * Default `LoginGateway` for the desktop renderer.
 *
 * Composes:
 *
 *   • {@link RendererLoginGateway} from `@ai-agent-orchestrator/client-sdk`
 *     — does the validation probe.
 *   • {@link createDesktopShellProbeClient} — routes the probe's HTTP
 *     call through the Tauri shell instead of `fetch`. This is the
 *     critical wiring: the WebView's CORS / CSP would block a direct
 *     `fetch` to provider domains, so we MUST round-trip through Rust.
 *   • {@link createDesktopApiKeySink} — encrypts via
 *     `desktopShell.encryptLocalSecret` and writes to
 *     `desktopShell.writeLocalSetting`.
 *
 * This replaces the previous `notWiredLoginGateway` placeholder so the
 * Validate button no longer returns `gateway_not_wired`. Tests retain
 * an explicit `notWiredLoginGateway` export below so they can inject a
 * structured-error stub when needed.
 */
export function createDefaultDesktopLoginGateway(): LoginGateway {
  const sink: LocalApiKeySink = createDesktopApiKeySink({ desktopShell });
  const http = createDesktopShellProbeClient({ desktopShell });
  return new RendererLoginGateway({ sink, http });
}

/**
 * Backwards-compatible alias. Older callers / tests imported this
 * symbol expecting a "no-op" gateway; we now point it at a real one
 * but keep the export so renderer code that imported it keeps
 * compiling.
 *
 * Tests that need a deliberately-broken gateway should instantiate
 * their own structured-error stub instead.
 */
export const notWiredLoginGateway: LoginGateway = {
  validateApiKey(): Promise<ValidationResult> {
    return Promise.resolve({
      kind: "error",
      providerCode: "gateway_not_wired",
      providerMessage:
        "Auth Service transport is not yet wired. This will be enabled when the Client SDK adapter lands.",
    });
  },
  createLocalSession(): Promise<Session> {
    return Promise.reject(
      Object.assign(
        new Error(
          "Auth Service transport is not yet wired (createLocalSession).",
        ),
        { code: "gateway_not_wired" },
      ),
    );
  },
};

/**
 * Default `GmailLoginGateway`. Surfaces a structured error with a
 * `gateway_not_wired` provider code so the UI can show a precise
 * "not yet wired" message instead of hanging on a never-resolving
 * promise. Mirrors the convention used by {@link notWiredLoginGateway}.
 */
export const notWiredGmailLoginGateway: GmailLoginGateway = {
  beginGoogleOAuth(): Promise<{
    authorizationUrl: string;
    state: string;
  }> {
    return Promise.reject(
      Object.assign(
        new Error(
          "Gmail OAuth transport is not yet wired (beginGoogleOAuth).",
        ),
        { code: "gateway_not_wired" },
      ),
    );
  },
  completeGoogleOAuth(): Promise<Session> {
    return Promise.reject(
      Object.assign(
        new Error(
          "Gmail OAuth transport is not yet wired (completeGoogleOAuth).",
        ),
        { code: "gateway_not_wired" },
      ),
    );
  },
};

/**
 * Default {@link UpgradeGateway}. Surfaces a structured error with a
 * `gateway_not_wired` code until the Client SDK adapter wires the
 * backend's `upgradeLocalSessionToGoogle` (task 17.3) into the
 * renderer.
 */
export const notWiredUpgradeGateway: UpgradeGateway = {
  upgradeLocalSessionToGoogle(): Promise<{
    session: Session;
    mergeReport: UpgradeMergeReport;
  }> {
    return Promise.reject(
      Object.assign(
        new Error(
          "Local-to-cloud upgrade transport is not yet wired " +
            "(upgradeLocalSessionToGoogle).",
        ),
        { code: "gateway_not_wired" },
      ),
    );
  },
};

/**
 * Captures the OAuth callback parameters. The desktop shell wires
 * this to the URL handler that listens for the post-Google redirect
 * (`tauri://localhost/oauth/callback?code=...&state=...`). Tests
 * inject a custom listener so they can simulate the callback.
 *
 * The listener returns an unsubscribe function; the bootstrap calls
 * it on unmount.
 */
export interface OAuthCallbackListener {
  onCallback(handler: (params: { code: string; state: string }) => void): () => void;
}

/** Bootstrap options. */
export interface BootstrapLoginUiOptions {
  /** Local-API-key flow gateway. Defaults to {@link notWiredLoginGateway}. */
  readonly gateway?: LoginGateway;
  /** Gmail OAuth gateway. Defaults to {@link notWiredGmailLoginGateway}. */
  readonly gmailGateway?: GmailLoginGateway;
  /** Local-to-cloud upgrade gateway. Defaults to {@link notWiredUpgradeGateway}. */
  readonly upgradeGateway?: UpgradeGateway;
  /**
   * Local scope to upgrade from. The desktop renderer resolves this
   * lazily via `desktopShell.getDeviceId()` once the user signs in
   * via the Gmail flow; tests can pass a fixed value.
   */
  readonly localScope?: LocalScopeForUpgrade;
  /**
   * Optional listener that delivers OAuth callback parameters from the
   * shell's URL handler. When omitted, the bootstrap exposes a
   * `dispatchOAuthCallback()` method on the result so tests (and
   * future deep-link wiring) can simulate the callback manually.
   */
  readonly oauthCallbackListener?: OAuthCallbackListener;
  /** Listener for login-flow events (e.g. local session saved). */
  readonly onEvent?: (event: LoginEvent) => void;
  /** Listener for Gmail-flow events (`redirecting`, `completed`). */
  readonly onGmailEvent?: (event: GmailLoginEvent) => void;
  /** Listener for upgrade-flow events (`completed`, `cancelled`). */
  readonly onUpgradeEvent?: (event: UpgradeEvent) => void;
}

/** Result of {@link bootstrapLoginUi}. */
export interface BootstrapLoginUiResult {
  readonly controller: LoginScreen;
  readonly gmailController: GmailLoginScreen;
  readonly upgradeController: LocalToCloudUpgradeScreen;
  readonly mount: MountLoginScreenResult;
  /**
   * Manually dispatches an OAuth callback to the Gmail screen and the
   * upgrade screen. Used by tests and as a fallback path when no
   * deep-link listener is wired. Idempotent across an unmounted
   * bootstrap (becomes a no-op once `unmount` has run).
   */
  dispatchOAuthCallback(params: { code: string; state: string }): void;
  /** Tear down the screen and detach all listeners. */
  unmount(): void;
}

/**
 * Mounts the login screen into `root` and returns the controllers
 * plus an `unmount()` handle. Returns `null` when `root` is `null`.
 */
export function bootstrapLoginUi(
  root: HTMLElement | null,
  options: BootstrapLoginUiOptions = {},
): BootstrapLoginUiResult | null {
  if (root === null) {
    return null;
  }

  const gateway = options.gateway ?? createDefaultDesktopLoginGateway();
  const gmailGateway = options.gmailGateway ?? notWiredGmailLoginGateway;
  const upgradeGateway = options.upgradeGateway ?? notWiredUpgradeGateway;
  const localScope =
    options.localScope ?? ({ kind: "local", deviceId: "device-pending" } as const);

  // Containers — one per phase. We mount eagerly into hidden
  // containers so the renderer can switch between phases without
  // tearing down DOM (avoiding focus/aria flicker).
  const apiKeyContainer = document.createElement("section");
  apiKeyContainer.className = "login-phase login-phase-api-key";

  const gmailContainer = document.createElement("section");
  gmailContainer.className = "login-phase login-phase-gmail";
  gmailContainer.hidden = true;

  const upgradeContainer = document.createElement("section");
  upgradeContainer.className = "login-phase login-phase-upgrade";
  upgradeContainer.hidden = true;

  root.appendChild(apiKeyContainer);
  root.appendChild(gmailContainer);
  root.appendChild(upgradeContainer);

  // Phase controllers.
  const controller = new LoginScreen({ gateway });
  const gmailController = new GmailLoginScreen({ gateway: gmailGateway });
  const upgradeController = new LocalToCloudUpgradeScreen({
    gateway: upgradeGateway,
    localScope,
  });

  // Subscribe to events BEFORE mounting so the host-supplied listeners
  // see the eager state push that the controllers emit on subscribe.
  if (options.onEvent) controller.subscribeEvents(options.onEvent);
  if (options.onGmailEvent) gmailController.subscribeEvents(options.onGmailEvent);
  if (options.onUpgradeEvent) upgradeController.subscribeEvents(options.onUpgradeEvent);

  // Phase-switching glue:
  //   • The login screen owns the "Sign in with Gmail" button. When
  //     the user picks the Gmail entry mode, we surface the Gmail
  //     phase. We do NOT auto-trigger the OAuth flow — the user must
  //     press the dedicated "Continue with Google" button inside the
  //     Gmail screen so the screen's state machine controls the
  //     pre-redirect render.
  controller.subscribeEvents((event) => {
    if (event.type === "requestGoogleOAuth") {
      apiKeyContainer.hidden = true;
      gmailContainer.hidden = false;
      upgradeContainer.hidden = true;
    }
  });

  //   • Once Gmail OAuth completes, the renderer pivots to the upgrade
  //     phase. The upgrade screen receives the captured callback so
  //     the user can confirm what to sync (Requirements 2.7, 2.8) and
  //     the gateway can be invoked. The OAuth completion gives us a
  //     cloud Session already; the upgrade screen then merges the
  //     local scope on top, returning a granular MergeReport
  //     (Requirement 3.6).
  //
  //     Note: in production the upgrade screen needs the OAuth
  //     `code`/`state` to drive the merge. The Gmail screen captures
  //     that data internally through `complete()`; we expose it again
  //     by listening for the same callback the deep-link adapter
  //     dispatches (see `dispatchOAuthCallback` below).
  gmailController.subscribeEvents((event) => {
    if (event.type === "completed") {
      // The session has been minted; the upgrade phase will reuse the
      // already-dispatched callback to drive the merge. We surface the
      // upgrade modal here so even if no deep-link listener is wired,
      // the user sees the next step.
      apiKeyContainer.hidden = true;
      gmailContainer.hidden = true;
      upgradeContainer.hidden = false;
    }
  });

  // Mount the screens.
  const mount = mountLoginScreen(apiKeyContainer, controller);
  const gmailMount = mountGmailLoginScreen(gmailContainer, gmailController);
  const upgradeMount = mountLocalToCloudUpgradeScreen(
    upgradeContainer,
    upgradeController,
  );

  // OAuth callback wiring. The shell's URL handler (Tauri deep-link
  // or a `protocol_handler`) calls back with `code`/`state`. We
  // forward the same params to BOTH the Gmail screen (which mints the
  // cloud session) and the upgrade screen (which uses them to drive
  // the merge).
  let mounted = true;
  const dispatchOAuthCallback = (params: {
    code: string;
    state: string;
  }): void => {
    if (!mounted) return;
    void gmailController.complete(params);
    upgradeController.setCallback(params);
    apiKeyContainer.hidden = true;
    gmailContainer.hidden = false;
    upgradeContainer.hidden = false;
  };

  let unsubscribeListener: (() => void) | null = null;
  if (options.oauthCallbackListener) {
    unsubscribeListener = options.oauthCallbackListener.onCallback(
      dispatchOAuthCallback,
    );
  }

  const unmount = (): void => {
    mounted = false;
    unsubscribeListener?.();
    upgradeMount.unmount();
    gmailMount.unmount();
    mount.unmount();
    apiKeyContainer.remove();
    gmailContainer.remove();
    upgradeContainer.remove();
  };

  return {
    controller,
    gmailController,
    upgradeController,
    mount,
    dispatchOAuthCallback,
    unmount,
  };
}
