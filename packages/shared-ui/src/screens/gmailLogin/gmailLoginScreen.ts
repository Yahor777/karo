/**
 * GmailLoginScreen controller (task 17.4).
 *
 * Source:
 *   • design.md → "Auth Service" → `beginGoogleOAuth`, `completeGoogleOAuth`.
 *   • design.md → "Session Modes" → "Gmail cloud-sync mode" flow:
 *       1. user chooses "Sign in with Gmail";
 *       2. Auth_Service starts OAuth;
 *       3. Google returns authorization code;
 *       4. Auth_Service completes OAuth;
 *       5. Settings_Store loads Cloud_Settings_Store;
 *       6. if load succeeds, user enters cloud session.
 *   • requirements.md → Requirements 3.1, 3.5.
 *
 * State machine (mirrors design.md):
 *
 *   1. `idle` — user has not yet pressed "Continue with Google".
 *   2. `start()` → `starting`:
 *      • call `gateway.beginGoogleOAuth()`;
 *      • on success transition to `redirecting` with the authorization
 *        URL and call `redirector.redirect(authorizationUrl)`. The
 *        renderer typically navigates away before any further state is
 *        observed.
 *      • on failure transition to `error`.
 *   3. After Google calls back, the host invokes
 *      `complete({ code, state })`:
 *      • transition to `completing`;
 *      • call `gateway.completeGoogleOAuth(...)`;
 *      • on success transition to `completed` and emit a `"completed"`
 *        event with the Session. The host transitions to the
 *        post-login route.
 *      • on failure with `code === "settings_load_failed"`
 *        (Requirement 3.5) transition to `settingsLoadFailed` so the
 *        renderer can surface the "retry later" line and a Retry
 *        button.
 *      • on any other failure transition to `error`.
 *
 * Concurrency:
 *   • Multiple in-flight `start()` or `complete()` calls are bounded
 *     by per-call sequence numbers. Only the most recent one applies
 *     its result, mirroring the same approach used by
 *     `loginScreen.ts`.
 *
 * Validates: Requirements 3.1, 3.5.
 */

import type {
  GmailLoginEvent,
  GmailLoginEventListener,
  GmailLoginGateway,
  GmailLoginState,
  GmailLoginStateListener,
  GmailLoginStatus,
  Session,
  UserAgentRedirector,
} from "./types.js";
import { isSettingsLoadFailedError } from "../../ports/auth.js";

/** Constructor options. */
export interface GmailLoginScreenOptions {
  readonly gateway: GmailLoginGateway;
  /**
   * Outbound navigation port. Defaults to `window.location.assign` when
   * a `globalThis.window` is present, or to a no-op shim that
   * transitions the controller to `redirecting` without leaving the
   * page (useful for tests and for web builds that intercept top-level
   * navigation). Production composition normally passes an explicit
   * adapter.
   */
  readonly redirector?: UserAgentRedirector;
}

/**
 * Framework-free Gmail login screen controller.
 */
export class GmailLoginScreen {
  private readonly gateway: GmailLoginGateway;
  private readonly redirector: UserAgentRedirector;
  private state: GmailLoginState = { status: { kind: "idle" } };
  private readonly stateListeners = new Set<GmailLoginStateListener>();
  private readonly eventListeners = new Set<GmailLoginEventListener>();
  private startSeq = 0;
  private completeSeq = 0;

  public constructor(options: GmailLoginScreenOptions) {
    this.gateway = options.gateway;
    this.redirector = options.redirector ?? defaultRedirector();
  }

  /** Returns a snapshot of the current state. */
  public getState(): GmailLoginState {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  public subscribeState(listener: GmailLoginStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public subscribeEvents(listener: GmailLoginEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * User pressed "Continue with Google". Begins the OAuth handshake
   * and, on success, hands the authorization URL to the redirector.
   *
   * Returns the resulting status so callers (tests) can `await` it.
   */
  public async start(): Promise<GmailLoginStatus> {
    if (this.state.status.kind === "starting") {
      // Already in flight — caller will see the result via subscribeState.
      return this.state.status;
    }
    const seq = ++this.startSeq;
    this.update({ status: { kind: "starting" } });

    let result: { authorizationUrl: string; state: string };
    try {
      result = await this.gateway.beginGoogleOAuth();
    } catch (err: unknown) {
      if (seq !== this.startSeq) {
        return this.state.status;
      }
      const code = readErrorCode(err);
      const next: GmailLoginStatus = {
        kind: "error",
        ...(code !== undefined ? { code } : {}),
        message: describeError(err),
      };
      this.update({ status: next });
      return next;
    }

    if (seq !== this.startSeq) {
      return this.state.status;
    }
    if (result.authorizationUrl.length === 0) {
      const next: GmailLoginStatus = {
        kind: "error",
        code: "invalid_response",
        message: "Auth service returned an empty authorizationUrl",
      };
      this.update({ status: next });
      return next;
    }

    const next: GmailLoginStatus = {
      kind: "redirecting",
      authorizationUrl: result.authorizationUrl,
    };
    this.update({ status: next });
    this.emit({ type: "redirecting", authorizationUrl: result.authorizationUrl });
    // Hand off to the user-agent. The renderer typically navigates
    // away here. We do this AFTER the state update so subscribers see
    // the `redirecting` state at least once.
    try {
      this.redirector.redirect(result.authorizationUrl);
    } catch (err: unknown) {
      const errStatus: GmailLoginStatus = {
        kind: "error",
        code: "redirect_failed",
        message: describeError(err),
      };
      this.update({ status: errStatus });
      return errStatus;
    }
    return next;
  }

  /**
   * Host invokes this with the `code` / `state` recovered from the
   * `/oauth/callback` URL. Drives the completion side of the
   * handshake.
   */
  public async complete(input: {
    readonly code: string;
    readonly state: string;
  }): Promise<GmailLoginStatus> {
    if (input.code.length === 0 || input.state.length === 0) {
      const next: GmailLoginStatus = {
        kind: "error",
        code: "missing_callback_params",
        message: "OAuth callback is missing 'code' or 'state'",
      };
      this.update({ status: next });
      return next;
    }

    const seq = ++this.completeSeq;
    this.update({ status: { kind: "completing" } });

    let session: Session;
    try {
      session = await this.gateway.completeGoogleOAuth({
        code: input.code,
        state: input.state,
      });
    } catch (err: unknown) {
      if (seq !== this.completeSeq) {
        return this.state.status;
      }
      // Requirement 3.5: special-case the "settings load failed" path.
      if (isSettingsLoadFailedError(err)) {
        const next: GmailLoginStatus = {
          kind: "settingsLoadFailed",
          message:
            "We couldn't load your saved settings. This is usually temporary — please retry later.",
        };
        this.update({ status: next });
        return next;
      }
      const code = readErrorCode(err);
      const next: GmailLoginStatus = {
        kind: "error",
        ...(code !== undefined ? { code } : {}),
        message: describeError(err),
      };
      this.update({ status: next });
      return next;
    }

    if (seq !== this.completeSeq) {
      return this.state.status;
    }
    const completed: GmailLoginStatus = { kind: "completed", session };
    this.update({ status: completed });
    this.emit({ type: "completed", session });
    return completed;
  }

  /**
   * Resets the controller to `idle` so the user can try the flow again
   * after a `settingsLoadFailed` or `error`.
   *
   * Bumping both sequence counters guarantees that any in-flight calls
   * cannot resurrect the previous status after the reset.
   */
  public reset(): void {
    this.startSeq += 1;
    this.completeSeq += 1;
    this.update({ status: { kind: "idle" } });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private update(patch: Partial<GmailLoginState>): void {
    const next: GmailLoginState = { ...this.state, ...patch };
    if (this.state.status === next.status) {
      return;
    }
    this.state = next;
    for (const listener of this.stateListeners) {
      listener(next);
    }
  }

  private emit(event: GmailLoginEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

/**
 * Default redirector. Uses `window.location.assign` when available;
 * falls back to a no-op shim outside a browser. Production composition
 * normally passes an explicit redirector so the desktop shell can
 * route through `shell.openExternal` instead.
 */
function defaultRedirector(): UserAgentRedirector {
  return {
    redirect(url: string): void {
      const w = (globalThis as { window?: { location?: { assign?: (u: string) => void } } })
        .window;
      if (w && w.location && typeof w.location.assign === "function") {
        w.location.assign(url);
      }
      // Otherwise: silently no-op. The controller has already
      // transitioned to `redirecting`; the host can read the URL from
      // the state and act on it.
    },
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return m.length > 0 ? m : err.name;
  }
  if (typeof err === "string") {
    return err;
  }
  return "unknown error";
}

function readErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return undefined;
}
