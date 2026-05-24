/**
 * LoginScreen controller (task 4.3).
 *
 * Source:
 *   • design.md → "Auth Service" → `validateApiKey`, `createLocalSession`.
 *   • design.md → "Session Modes" → "Local API-key-only mode".
 *   • requirements.md → Requirements 2.1, 2.2, 2.3, 2.4.
 *
 * This module owns the form state machine and gateway orchestration
 * for the login screen. It is framework-free and lives in shared-ui so
 * the desktop renderer and the future web shell share the same logic.
 *
 * State machine (mirrors design.md → "Session Modes" → "Local API-key-only mode"):
 *
 *   1. User picks an entry mode.
 *      • `"apiKey"` → continue with provider/key form.
 *      • `"google"` → emit `requestGoogleOAuth` event; controller does
 *        NOT call any gateway (Requirement 2.1, design 17.x scope).
 *   2. User picks `provider`, types `apiKey`. Both are required for
 *      validation. Editing either field after a previous validation
 *      result resets `validation` back to `idle` so stale results are
 *      never used to gate save (Requirement 2.4, "WHEN API_Key
 *      successfully validated").
 *   3. User presses "Validate" → `validation = "validating"` →
 *      `gateway.validateApiKey` → `validation = "ok" | "error"`.
 *      • On `error`, `providerCode`/`providerMessage` are surfaced
 *        verbatim (Requirement 2.3).
 *   4. User presses "Save" → `save = "awaitingConfirmation"`. This
 *      opens the confirmation modal in the DOM render layer. NO
 *      backend call has happened yet (Requirement 2.4).
 *   5. User confirms in modal → `confirmAndSave()` → `save = "saving"`
 *      → `gateway.createLocalSession({ confirmedByUser: true })` →
 *      `save = "saved" | "error"`.
 *   6. On `saved`, controller emits a `"saved"` event with the Session.
 *
 * Save-button gating: `canRequestSave()` is `true` ONLY when
 * `validation.kind === "ok"`. The render layer mirrors this by setting
 * the disabled attribute on the save button. Backend defence-in-depth
 * (the `confirmedByUser` literal-true gate inside
 * `AuthService.createLocalSession`) catches anything that slips
 * through.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4.
 */

import {
  PROVIDER_PRESETS,
  findProviderPreset,
  resolveBaseUrl,
} from "@ai-agent-orchestrator/shared-core";
import type {
  LoginEntryMode,
  LoginEvent,
  LoginEventListener,
  LoginGateway,
  LoginState,
  LoginStateListener,
  LoginValidationStatus,
  ProviderId,
  Session,
  ValidationResult,
} from "./types.js";

/** Default provider shown on first render. */
export const DEFAULT_PROVIDER: ProviderId = "openai";

/** List of providers offered in the dropdown by default. */
export const DEFAULT_PROVIDER_OPTIONS: readonly ProviderId[] =
  PROVIDER_PRESETS.map((p) => p.id);

/** Constructor options for {@link LoginScreen}. */
export interface LoginScreenOptions {
  readonly gateway: LoginGateway;
  /**
   * Optional override for the initial entry mode. Defaults to
   * `"apiKey"` because that is the path that completes locally without
   * extra wiring; the Gmail entry is selected explicitly by the user.
   */
  readonly initialEntryMode?: LoginEntryMode;
  /**
   * Optional override for the default provider. Defaults to
   * {@link DEFAULT_PROVIDER}. The render layer typically populates the
   * provider dropdown from {@link DEFAULT_PROVIDER_OPTIONS}.
   */
  readonly initialProvider?: ProviderId;
}

/**
 * Framework-free login screen controller.
 *
 * The controller exposes a small imperative API the DOM render layer
 * (or any other host) calls in response to user actions:
 *
 *   • `setEntryMode(mode)` — react to the entry-mode toggle.
 *   • `setProvider(p)`     — react to the provider dropdown.
 *   • `setApiKey(k)`       — react to the API-key input.
 *   • `validate()`         — react to the "Validate" button.
 *   • `requestSave()`      — react to the "Save" button. Opens modal.
 *   • `cancelSave()`       — react to "Cancel" inside the modal.
 *   • `confirmAndSave()`   — react to "Confirm" inside the modal.
 *   • `requestGoogleOAuth()` — react to the "Sign in with Gmail"
 *     button. Emits a `requestGoogleOAuth` event for the host shell.
 *
 * Subscribers receive the new state via `subscribeState` (and events
 * via `subscribeEvents`). The controller never reads from the DOM, so
 * unit tests can drive it without a JSDOM environment.
 */
export class LoginScreen {
  private readonly gateway: LoginGateway;
  private state: LoginState;
  private readonly stateListeners = new Set<LoginStateListener>();
  private readonly eventListeners = new Set<LoginEventListener>();
  /**
   * Tracks the in-flight validate call so a stale resolution cannot
   * overwrite a newer one. Each `validate()` call increments the
   * sequence; a probe result is only applied when its sequence matches
   * the current value at resolution time.
   */
  private validateSeq = 0;
  /** Same idea for `confirmAndSave`. */
  private saveSeq = 0;

  public constructor(options: LoginScreenOptions) {
    this.gateway = options.gateway;
    const initialProvider = options.initialProvider ?? DEFAULT_PROVIDER;
    const preset = findProviderPreset(initialProvider);
    this.state = {
      entryMode: options.initialEntryMode ?? "apiKey",
      provider: initialProvider,
      apiKey: "",
      // Empty string means "use the preset default". The controller
      // resolves the effective base URL via `resolveBaseUrl` before
      // any gateway call, so the user can leave this blank for
      // OpenAI/Anthropic and only fill it for Custom presets.
      baseUrl: "",
      // Pre-fill the model id with the preset's suggested default so
      // the placeholder is meaningful. Users can edit freely.
      modelId: preset?.defaultModelId ?? "",
      validation: { kind: "idle" },
      save: { kind: "idle" },
    };
  }

  /** Returns a snapshot of the current state. */
  public getState(): LoginState {
    return this.state;
  }

  /**
   * Convenience: the render layer disables the Save button unless
   * validation succeeded. Exposed as an explicit method (rather than
   * leaving callers to inspect the state) so the gating rule lives in
   * one place.
   */
  public canRequestSave(): boolean {
    return this.state.validation.kind === "ok";
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  public subscribeState(listener: LoginStateListener): () => void {
    this.stateListeners.add(listener);
    // Eager push so subscribers don't need a separate "give me current"
    // call. Mirrors the conventions used by `applicationShell`.
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public subscribeEvents(listener: LoginEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Form transitions
  // -------------------------------------------------------------------------

  public setEntryMode(mode: LoginEntryMode): void {
    if (this.state.entryMode === mode) {
      return;
    }
    // Switching modes resets transient validation/save state so a
    // stale "ok" from the previous mode cannot accidentally enable
    // save under the new mode.
    this.update({
      entryMode: mode,
      validation: { kind: "idle" },
      save: { kind: "idle" },
    });
  }

  public setProvider(provider: ProviderId): void {
    if (this.state.provider === provider) {
      return;
    }
    // A provider change invalidates any prior validation result —
    // an "ok" for OpenAI must not enable save under Anthropic. The
    // suggested model id is reset to the new preset's default so the
    // form mirrors the user's intent without forcing them to clear
    // it manually.
    const preset = findProviderPreset(provider);
    this.update({
      provider,
      baseUrl: "",
      modelId: preset?.defaultModelId ?? "",
      validation: { kind: "idle" },
      save: { kind: "idle" },
    });
  }

  public setBaseUrl(baseUrl: string): void {
    if (this.state.baseUrl === baseUrl) {
      return;
    }
    // Editing the base URL invalidates any prior validation. The
    // controller deliberately does not strip the trailing `/` here
    // — `resolveBaseUrl` does that at gateway-call time.
    this.update({
      baseUrl,
      validation: { kind: "idle" },
      save: { kind: "idle" },
    });
  }

  public setModelId(modelId: string): void {
    if (this.state.modelId === modelId) {
      return;
    }
    // Editing the model id does NOT invalidate validation: validation
    // is about the `(provider, key)` pair, and the model id is
    // metadata persisted alongside the key. Save status is still
    // reset because re-entering the model id should require a fresh
    // confirmation.
    this.update({
      modelId,
      save: this.state.save.kind === "awaitingConfirmation"
        ? { kind: "idle" }
        : this.state.save,
    });
  }

  public setApiKey(apiKey: string): void {
    if (this.state.apiKey === apiKey) {
      return;
    }
    // Same reasoning as `setProvider`: editing the key invalidates
    // prior validation. Any in-flight probe is also superseded by
    // bumping `validateSeq`.
    this.validateSeq += 1;
    this.update({
      apiKey,
      validation: { kind: "idle" },
      save: { kind: "idle" },
    });
  }

  // -------------------------------------------------------------------------
  // Validate
  // -------------------------------------------------------------------------

  /**
   * Issues a Provider validation probe. Resolves to the new
   * `validation` slice so callers (e.g. tests) can `await` it without
   * reading the controller's state again.
   *
   * Concurrency:
   *   • Multiple in-flight `validate()` calls are tolerated: only the
   *     most recent one is applied. This matches typical UI behaviour
   *     where a user presses "Validate" twice quickly.
   *   • The state immediately transitions to `"validating"` regardless
   *     of how many concurrent calls are in flight, so the UI shows
   *     a spinner without flicker.
   */
  public async validate(): Promise<LoginValidationStatus> {
    if (this.state.entryMode !== "apiKey") {
      // Hard guard: validate is only meaningful in API-key mode.
      // Returning idle (rather than throwing) keeps the controller
      // tolerant of host wiring bugs.
      return this.state.validation;
    }
    const apiKey = this.state.apiKey;
    if (apiKey.trim().length === 0) {
      // Mirror the backend's empty-key short-circuit so the UI shows
      // an immediate, structured error without a network round-trip.
      const next: LoginValidationStatus = {
        kind: "error",
        providerCode: "invalid_api_key",
        providerMessage: "API key is empty",
      };
      this.update({ validation: next, save: { kind: "idle" } });
      return next;
    }

    // Pre-flight checks for provider-preset requirements. Catching
    // these here prevents an avoidable network round-trip and gives
    // the user a precise diagnostic.
    const preset = findProviderPreset(this.state.provider);
    const resolvedBaseUrl = resolveBaseUrl(
      this.state.provider,
      this.state.baseUrl,
    );
    if (preset?.requiresUserBaseUrl === true && resolvedBaseUrl === null) {
      const next: LoginValidationStatus = {
        kind: "error",
        providerCode: "missing_base_url",
        providerMessage:
          "This provider requires a base URL — paste your gateway endpoint and try again.",
      };
      this.update({ validation: next, save: { kind: "idle" } });
      return next;
    }
    if (
      preset?.requiresUserModelId === true &&
      this.state.modelId.trim().length === 0
    ) {
      const next: LoginValidationStatus = {
        kind: "error",
        providerCode: "missing_model_id",
        providerMessage:
          "This provider requires a model id — paste it into the form and try again.",
      };
      this.update({ validation: next, save: { kind: "idle" } });
      return next;
    }

    const seq = ++this.validateSeq;
    this.update({
      validation: { kind: "validating" },
      // Any prior save-confirmation is invalidated by a new validation
      // attempt — we'll reopen the modal once validation succeeds.
      save: { kind: "idle" },
    });

    let result: ValidationResult;
    try {
      result = await this.gateway.validateApiKey({
        provider: this.state.provider,
        apiKey,
        ...(resolvedBaseUrl !== null ? { baseUrl: resolvedBaseUrl } : {}),
        ...(this.state.modelId.length > 0
          ? { modelId: this.state.modelId }
          : {}),
      });
    } catch (err: unknown) {
      // Defence-in-depth: the gateway is documented not to throw, but
      // if it does we still surface a structured error so the UI
      // doesn't render an indefinite "validating" spinner.
      result = {
        kind: "error",
        providerCode: "unexpected_error",
        providerMessage: describeError(err),
      };
    }

    if (seq !== this.validateSeq) {
      // A newer validate call superseded this one. Drop the result.
      return this.state.validation;
    }

    const next: LoginValidationStatus =
      result.kind === "ok"
        ? result.modelsCount === undefined
          ? { kind: "ok" }
          : { kind: "ok", modelsCount: result.modelsCount }
        : {
            kind: "error",
            providerCode: result.providerCode,
            providerMessage: result.providerMessage,
          };
    this.update({ validation: next });
    return next;
  }

  // -------------------------------------------------------------------------
  // Save (confirmation modal)
  // -------------------------------------------------------------------------

  /**
   * User pressed the "Save" button. Per Requirement 2.4 we MUST NOT
   * persist the secret without explicit user confirmation, so this
   * method only opens the confirmation modal — `confirmAndSave()` is
   * the one that actually invokes the gateway.
   */
  public requestSave(): void {
    if (!this.canRequestSave()) {
      // Defence-in-depth: the render layer disables the Save button,
      // but a host that forgets to honour `canRequestSave()` should
      // still get a no-op rather than an unguarded backend call.
      return;
    }
    if (this.state.save.kind === "saving") {
      return;
    }
    this.update({ save: { kind: "awaitingConfirmation" } });
  }

  /**
   * User pressed "Cancel" in the confirmation modal. Returns the form
   * to a non-pending state without touching validation.
   */
  public cancelSave(): void {
    if (this.state.save.kind === "awaitingConfirmation") {
      this.update({ save: { kind: "idle" } });
    }
  }

  /**
   * User pressed "Confirm" in the modal. Invokes the gateway with
   * `confirmedByUser: true` (the backend rejects anything else).
   *
   * Returns the new save status so callers can `await` the outcome.
   */
  public async confirmAndSave(): Promise<LoginState["save"]> {
    if (this.state.save.kind !== "awaitingConfirmation") {
      // Confirm without a prior `requestSave` is a host bug — bail
      // out cleanly rather than minting a save call out of nowhere.
      return this.state.save;
    }
    if (this.state.validation.kind !== "ok") {
      // Validation may have been invalidated between `requestSave` and
      // `confirmAndSave` (e.g. the user edited the key after opening
      // the modal). Refuse to proceed.
      this.update({ save: { kind: "idle" } });
      return this.state.save;
    }

    const seq = ++this.saveSeq;
    this.update({ save: { kind: "saving" } });

    let session: Session;
    try {
      const resolvedBaseUrl = resolveBaseUrl(
        this.state.provider,
        this.state.baseUrl,
      );
      session = await this.gateway.createLocalSession({
        provider: this.state.provider,
        apiKey: this.state.apiKey,
        ...(resolvedBaseUrl !== null ? { baseUrl: resolvedBaseUrl } : {}),
        ...(this.state.modelId.length > 0
          ? { modelId: this.state.modelId }
          : {}),
        confirmedByUser: true,
      });
    } catch (err: unknown) {
      const message = describeError(err);
      const code = readErrorCode(err);
      if (seq !== this.saveSeq) {
        return this.state.save;
      }
      const errSlice =
        code === undefined
          ? { kind: "error" as const, message }
          : { kind: "error" as const, code, message };
      this.update({ save: errSlice });
      return errSlice;
    }

    if (seq !== this.saveSeq) {
      return this.state.save;
    }
    const saved = { kind: "saved" as const, session };
    this.update({ save: saved });
    this.emit({ type: "saved", session });
    return saved;
  }

  // -------------------------------------------------------------------------
  // Google OAuth stub
  // -------------------------------------------------------------------------

  /**
   * User pressed "Sign in with Gmail". The actual OAuth flow lands in
   * task 17.4 — for now the controller emits a `requestGoogleOAuth`
   * event so the host shell can route the action however it wants
   * (open a browser, show a "coming soon" notice, etc.).
   */
  public requestGoogleOAuth(): void {
    // Switching to the google entry mode keeps the UI consistent with
    // the user's intent even when the host has not wired the OAuth
    // flow yet.
    this.setEntryMode("google");
    this.emit({ type: "requestGoogleOAuth" });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private update(patch: Partial<LoginState>): void {
    const next: LoginState = { ...this.state, ...patch };
    if (statesEqual(this.state, next)) {
      return;
    }
    this.state = next;
    for (const listener of this.stateListeners) {
      listener(next);
    }
  }

  private emit(event: LoginEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

/**
 * Shallow equality on the slices that matter for re-render avoidance.
 * Validation/save are nested objects, so a referential check is enough
 * here — the controller always allocates a new object for transitions.
 */
function statesEqual(a: LoginState, b: LoginState): boolean {
  return (
    a.entryMode === b.entryMode &&
    a.provider === b.provider &&
    a.apiKey === b.apiKey &&
    a.baseUrl === b.baseUrl &&
    a.modelId === b.modelId &&
    a.validation === b.validation &&
    a.save === b.save
  );
}

/** Renders an unknown error value as a short, key-free string. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message =
      err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return message.length > 0 ? message : err.name;
  }
  if (typeof err === "string") {
    return err;
  }
  return "unknown error";
}

/**
 * Pulls a stable error code off an error-like value when present. This
 * matches the `LocalSessionError` shape from the backend so the UI can
 * render a precise message ("missing_confirmation" vs. "storage_failed")
 * without parsing strings.
 */
function readErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return undefined;
}
