/**
 * Gmail login flow types and ports (task 17.4).
 *
 * Source:
 *   • design.md → "Auth Service" → `beginGoogleOAuth`,
 *     `completeGoogleOAuth`.
 *   • design.md → "Session Modes" → "Gmail cloud-sync mode".
 *   • requirements.md → Requirements 3.1, 3.5.
 *
 * The shared-ui package has no UI framework dependency. The Gmail
 * login screen mirrors the framework-free pattern established by
 * `screens/login/loginScreen.ts` (task 4.3): a small controller owns
 * the state machine and gateway calls, a separate DOM mount renders
 * vanilla HTML and listens for state changes.
 *
 * Validates: Requirements 3.1, 3.5.
 */

import type { Session } from "@ai-agent-orchestrator/shared-core";

import type {
  CompleteGoogleOAuthErrorLike,
  GmailLoginGateway,
  UserAgentRedirector,
} from "../../ports/auth.js";

export type {
  CompleteGoogleOAuthErrorLike,
  GmailLoginGateway,
  Session,
  UserAgentRedirector,
};

/**
 * State of the Gmail login flow.
 *
 *   • `idle`              — initial state. The screen shows the
 *     "Continue with Google" button.
 *   • `starting`          — `gateway.beginGoogleOAuth` is in flight.
 *     The button shows a spinner.
 *   • `redirecting`       — the controller has handed an authorization
 *     URL to the {@link UserAgentRedirector}. The renderer typically
 *     navigates away before this state is observed; it is exposed so
 *     the host can render a "Redirecting to Google…" line for
 *     deployments where navigation is asynchronous (test stubs, web
 *     builds that intercept top-level navigation).
 *   • `completing`        — the user has come back from Google with
 *     `code` / `state`. `completeGoogleOAuth` is in flight. The screen
 *     shows the "Completing sign-in…" status mandated by the task
 *     brief.
 *   • `completed`         — `completeGoogleOAuth` returned a Session.
 *     The host should transition to the post-login route.
 *   • `settingsLoadFailed` — `completeGoogleOAuth` rejected with the
 *     "settings load failed" code path (Requirement 3.5). The screen
 *     surfaces a clear "retry later" message with a Retry button.
 *   • `error`             — any other failure, including transport
 *     errors and OAuth-state failures. `code`/`message` are surfaced
 *     for diagnostics.
 */
export type GmailLoginStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "redirecting"; readonly authorizationUrl: string }
  | { readonly kind: "completing" }
  | { readonly kind: "completed"; readonly session: Session }
  | {
      readonly kind: "settingsLoadFailed";
      readonly message: string;
    }
  | {
      readonly kind: "error";
      readonly code?: string;
      readonly message: string;
    };

/** Aggregate state. */
export interface GmailLoginState {
  readonly status: GmailLoginStatus;
}

/** Events emitted for the host shell. */
export type GmailLoginEvent =
  | { readonly type: "redirecting"; readonly authorizationUrl: string }
  | { readonly type: "completed"; readonly session: Session };

/** Subscriber for state updates. */
export type GmailLoginStateListener = (state: GmailLoginState) => void;
/** Subscriber for emitted events. */
export type GmailLoginEventListener = (event: GmailLoginEvent) => void;
