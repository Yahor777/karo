/**
 * Login screen types and ports for the framework-free LoginScreen
 * controller (task 4.3).
 *
 * Source:
 *   • design.md → "Auth Service" → `validateApiKey`, `createLocalSession`,
 *     `ValidationResult`, `Session`.
 *   • requirements.md → Requirements 2.1, 2.2, 2.3, 2.4.
 *
 * The shared-ui package has no UI framework dependency. The login
 * screen is implemented as a small framework-free controller (form
 * state machine + injectable {@link LoginGateway} port) plus a thin
 * DOM render shell that mirrors the style of
 * `apps/desktop-windows/src/ui/bootstrap.ts`. Pure logic lives here so
 * both the desktop renderer and the future web shell can reuse it.
 *
 * `ValidationResult` is mirrored verbatim from design.md to avoid
 * coupling the shared-ui package to the backend. The desktop login
 * gateway adapter (in `apps/desktop-windows`) bridges this interface
 * to `AuthService.validateApiKey` / `AuthService.createLocalSession`.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4.
 */

import type { ProviderId, Session } from "@ai-agent-orchestrator/shared-core";

// Re-export so consumers of the screen don't need to know about
// `shared-core` directly.
export type { ProviderId, Session } from "@ai-agent-orchestrator/shared-core";

/**
 * Outcome of a Provider validation probe. Mirrors design.md →
 * "Auth Service" → `ValidationResult`.
 *
 *   • `kind: "ok"` — Provider accepted the key. `modelsCount`, when
 *     present, is shown as a soft confirmation in the UI ("works for
 *     N models").
 *   • `kind: "error"` — Provider rejected the key (or the call failed).
 *     `providerCode`/`providerMessage` are surfaced verbatim per
 *     Requirement 2.3 ("сообщение об ошибке с указанием причины,
 *     полученной от Provider").
 */
export type ValidationResult =
  | {
      readonly kind: "ok";
      readonly modelsCount?: number;
    }
  | {
      readonly kind: "error";
      readonly providerCode: string;
      readonly providerMessage: string;
    };

/**
 * Narrow port the LoginScreen controller uses to talk to the Auth
 * Service. The port is intentionally smaller than `AuthClient` from
 * the design — the controller cares about exactly two operations:
 *
 *   • `validateApiKey`     — issued from the "Validate" button before
 *     any persistence happens (Requirement 2.2).
 *   • `createLocalSession` — issued from the explicit save-confirmation
 *     modal (Requirement 2.4). The literal `confirmedByUser: true`
 *     field is the structural type-level guard mirrored from the
 *     backend's `CreateLocalSessionInput`.
 *
 * Both operations carry an optional `baseUrl` (for OpenAI-compatible
 * gateways such as Fireworks AI or self-hosted Custom providers) and
 * an optional `modelId` (to record the user-picked default model
 * alongside the key). The desktop / web shells fill these from the
 * provider preset + the user-entered overrides.
 *
 * `deviceId` is intentionally NOT in `createLocalSession`'s input —
 * the desktop adapter resolves it from `desktopShell.getDeviceId()`
 * before forwarding to the backend. Keeping device identity out of the
 * UI controller means the same controller works unchanged in the web
 * shell when the latter wires a different gateway implementation.
 */
export interface LoginGateway {
  validateApiKey(input: {
    readonly provider: ProviderId;
    readonly apiKey: string;
    /**
     * Optional explicit base URL — required for the Custom preset and
     * useful for staging gateways. Adapters fall back to the
     * provider's preset `baseUrl` when omitted.
     */
    readonly baseUrl?: string;
    /**
     * Optional default model id for the user. Probes ignore this
     * field; the UI persists it alongside the key so subsequent
     * screens can pre-select the user's chosen model.
     */
    readonly modelId?: string;
    readonly signal?: AbortSignal;
  }): Promise<ValidationResult>;

  createLocalSession(input: {
    readonly provider: ProviderId;
    readonly apiKey: string;
    /** Effective base URL stored alongside the encrypted key. */
    readonly baseUrl?: string;
    /** Default model id stored alongside the encrypted key. */
    readonly modelId?: string;
    readonly confirmedByUser: true;
  }): Promise<Session>;
}

/**
 * Top-level entry mode the user picks on the login screen.
 *
 *   • `"apiKey"` — Requirement 2.1, "Ввести API-ключ" path.
 *   • `"google"` — Requirement 2.1, "Войти через Gmail" path. The
 *     actual OAuth wiring lands in task 17.4; until then the UI emits
 *     a `requestGoogleOAuth` event for hosts to handle.
 */
export type LoginEntryMode = "apiKey" | "google";

/** Status of the API-key Provider validation probe. */
export type LoginValidationStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "validating" }
  | { readonly kind: "ok"; readonly modelsCount?: number }
  | {
      readonly kind: "error";
      readonly providerCode: string;
      readonly providerMessage: string;
    };

/**
 * Status of the save side of the form.
 *
 *   • `"idle"`                 — nothing to save (no successful
 *     validation yet, or the user has not yet asked to save).
 *   • `"awaitingConfirmation"` — Requirement 2.4 modal is open;
 *     `confirmAndSave()` has not yet been called. No backend call has
 *     happened.
 *   • `"saving"`               — `createLocalSession` is in flight.
 *   • `"saved"`                — Backend returned a Session.
 *   • `"error"`                — Save failed; `message` is safe to
 *     surface in UI (it never carries the API-key plaintext, by
 *     contract with the backend `LocalSessionError`).
 */
export type LoginSaveStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "awaitingConfirmation" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly session: Session }
  | {
      readonly kind: "error";
      readonly code?: string;
      readonly message: string;
    };

/**
 * Form state for the login screen. The shape mirrors the task
 * description verbatim:
 *
 *   `{ entryMode, provider, apiKey, validation, savePending, saved }`
 *
 * with `savePending`/`saved` collapsed into a single
 * {@link LoginSaveStatus} discriminated union so callers cannot
 * accidentally render contradictory states (e.g. "saving" and "saved"
 * at the same time).
 */
export interface LoginState {
  readonly entryMode: LoginEntryMode;
  readonly provider: ProviderId;
  readonly apiKey: string;
  /**
   * User-entered base URL override. Empty string when the user has
   * not typed anything yet. The controller resolves the effective
   * base URL via `shared-core`'s `resolveBaseUrl` before forwarding
   * to the gateway.
   */
  readonly baseUrl: string;
  /**
   * User-entered model id. The controller forwards it to
   * `validateApiKey` / `createLocalSession` so the shell can persist
   * it alongside the key.
   */
  readonly modelId: string;
  readonly validation: LoginValidationStatus;
  readonly save: LoginSaveStatus;
}

/**
 * Events emitted by the LoginScreen controller for the host shell.
 *
 *   • `"requestGoogleOAuth"` — user pressed "Sign in with Gmail". The
 *     desktop / web shell is responsible for calling
 *     `AuthClient.beginGoogleOAuth` and routing the callback (task
 *     17.4). The controller does not own that flow.
 *   • `"saved"`              — local session was successfully created.
 *     The host typically transitions to the Task Builder screen.
 */
export type LoginEvent =
  | { readonly type: "requestGoogleOAuth" }
  | { readonly type: "saved"; readonly session: Session };

/** Subscriber for state updates. */
export type LoginStateListener = (state: LoginState) => void;

/** Subscriber for emitted events. */
export type LoginEventListener = (event: LoginEvent) => void;
