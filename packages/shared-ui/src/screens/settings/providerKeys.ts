/**
 * Provider / API-key management screen — controller and DOM mount helper
 * (task 6.4).
 *
 * Sources:
 *   • design.md → "Settings Store" → `SettingsStore.upsertApiKey`,
 *     `removeApiKey`, `listApiKeyMetadata`; `ApiKeyMetadata` shape.
 *   • design.md → "Auth Service" → `validateApiKey`, `ValidationResult`.
 *   • requirements.md → 4.1, 4.2, 4.3, 4.4, 12.1.
 *   • tasks.md task 6.4 sub-bullets:
 *     "List metadata only (no full keys), add/update/delete flows,
 *     fingerprint display."
 *
 * Design notes
 * ------------
 *   1. The controller is pure framework-free TypeScript so it can be reused
 *      by both the desktop renderer (jsdom-friendly) and the future Web App.
 *      It owns the screen state machine, dispatches actions, and notifies
 *      registered listeners on every state transition.
 *   2. Backend access happens exclusively through narrow ports so unit tests
 *      can stub them without importing the backend modules:
 *        • {@link ProviderKeysApiKeyGateway}   — `listApiKeyMetadata` /
 *          `upsertApiKey` / `removeApiKey`. Mirrors a subset of
 *          `apps/backend/src/settings/apiKeys.ts → ApiKeyService` (already
 *          a class; we depend on the structural shape, not on the class).
 *        • {@link ProviderKeysAuthGateway}     — `validateApiKey`. Mirrors a
 *          subset of `apps/backend/src/auth/authService.ts → AuthService`
 *          and the `ValidationResult` discriminated union.
 *      The renderer composes these ports over the Client SDK / IPC bridge;
 *      tests pass plain object stubs.
 *   3. Add flow gates persistence behind a successful `validateApiKey` so
 *      the rejection path of Requirement 4.3 ("отклонить сохранение и
 *      отобразить причину ошибки") is enforced in the UI layer itself, not
 *      only at the backend boundary. The provider's `providerCode` /
 *      `providerMessage` are surfaced verbatim per Requirement 2.3 / 4.3.
 *   4. Delete flow surfaces success silently — Property 15 (Requirement 4.4)
 *      forbids producing error UI on a successful deletion. The controller
 *      models this as `{ status: "success" }` with no error string and the
 *      mount helper renders a brief toast / status line that disappears
 *      after a refresh. A delete that throws (transport failure) maps to
 *      `{ status: "error", message }`; the requirement is specifically
 *      about *successful* deletes producing no error UI.
 *   5. Listing displays only `provider`, `fingerprint`, `createdAt`,
 *      `lastValidatedAt` (Property 9 / Requirement 3.7). The UI never
 *      requests the full key after entry; the input form clears the field
 *      after dispatch. Browsers offering "save password" prompts on the
 *      input are unavoidable in vanilla DOM, but the controller never
 *      retains the plaintext past the dispatch call.
 */

import type {
  ApiKeyMetadata,
  ProviderId,
  Scope,
  ValidationResult,
} from "../../ports/settings.js";

// ---------------------------------------------------------------------------
// Ports (gateways)
// ---------------------------------------------------------------------------

/**
 * Narrow gateway port covering the API-key methods of the backend
 * `SettingsStore`. The controller depends on this structural shape only —
 * never on `apps/backend` code directly — so it can be stubbed in tests
 * without pulling in backend modules.
 */
export interface ProviderKeysApiKeyGateway {
  listApiKeyMetadata(scope: Scope): Promise<readonly ApiKeyMetadata[]>;
  upsertApiKey(
    scope: Scope,
    input: { readonly provider: ProviderId; readonly apiKey: string },
  ): Promise<void>;
  removeApiKey(scope: Scope, provider: ProviderId): Promise<void>;
}

/**
 * Narrow gateway port covering the `validateApiKey` portion of the backend
 * `AuthService`. Reused with the same `ValidationResult` shape so the
 * controller can switch on `kind` directly.
 */
export interface ProviderKeysAuthGateway {
  validateApiKey(input: {
    readonly provider: ProviderId;
    readonly apiKey: string;
  }): Promise<ValidationResult>;
}

// ---------------------------------------------------------------------------
// State and actions
// ---------------------------------------------------------------------------

/** Status of the last list refresh. */
export type ListStatus =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly entries: readonly ApiKeyMetadata[] }
  | { readonly status: "error"; readonly message: string };

/**
 * Status of the in-progress add flow. The flow goes:
 *
 *   idle → validating → (validation_failed | saving) → (save_failed | success)
 *
 * `validation_failed` carries the provider's verbatim code/message so the
 * UI can render the cause from the Provider (Requirement 4.3).
 */
export type AddStatus =
  | { readonly status: "idle" }
  | { readonly status: "validating" }
  | {
      readonly status: "validation_failed";
      readonly providerCode: string;
      readonly providerMessage: string;
    }
  | { readonly status: "saving" }
  | { readonly status: "save_failed"; readonly message: string }
  | { readonly status: "success"; readonly provider: ProviderId };

/**
 * Status of the in-progress delete flow.
 *
 * Property 15 (Requirement 4.4): a successful delete must not produce an
 * error UI. Hence the `success` branch carries no error string. A transport
 * failure that *prevents* the delete from succeeding produces `error`.
 */
export type DeleteStatus =
  | { readonly status: "idle" }
  | { readonly status: "deleting"; readonly provider: ProviderId }
  | { readonly status: "success"; readonly provider: ProviderId }
  | { readonly status: "error"; readonly message: string };

export interface ProviderKeysState {
  readonly scope: Scope;
  readonly list: ListStatus;
  readonly add: AddStatus;
  readonly delete: DeleteStatus;
}

/**
 * Listener invoked on every state transition. Listeners receive the next
 * state by value so they cannot accidentally retain a reference to a
 * stale snapshot.
 */
export type ProviderKeysListener = (state: ProviderKeysState) => void;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface ProviderKeysControllerOptions {
  readonly scope: Scope;
  readonly apiKeys: ProviderKeysApiKeyGateway;
  readonly auth: ProviderKeysAuthGateway;
}

export interface ProviderKeysController {
  /** Snapshot of the current state. Returned by value. */
  getState(): ProviderKeysState;
  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: ProviderKeysListener): () => void;
  /** Loads the metadata listing and updates {@link ProviderKeysState.list}. */
  refresh(): Promise<void>;
  /**
   * Validates `input.apiKey` for `input.provider`, then on success persists
   * via `upsertApiKey` and refreshes the listing. Returns the resulting
   * {@link AddStatus} so callers can react inline (the listener also fires).
   */
  addOrUpdateApiKey(input: {
    readonly provider: ProviderId;
    readonly apiKey: string;
  }): Promise<AddStatus>;
  /**
   * Removes the API key for `provider`, then refreshes the listing.
   * Successful delete never produces an error UI (Requirement 4.4).
   */
  removeApiKey(provider: ProviderId): Promise<DeleteStatus>;
}

/**
 * Build a {@link ProviderKeysController} over the supplied gateways.
 *
 * The controller is intentionally a closure rather than a class so the
 * private state (`state`, `listeners`) cannot be reached through any
 * `this`-binding gymnastics from the renderer.
 */
export function createProviderKeysController(
  options: ProviderKeysControllerOptions,
): ProviderKeysController {
  const { scope, apiKeys, auth } = options;

  let state: ProviderKeysState = {
    scope,
    list: { status: "idle" },
    add: { status: "idle" },
    delete: { status: "idle" },
  };
  const listeners = new Set<ProviderKeysListener>();

  function setState(patch: Partial<ProviderKeysState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
  }

  async function refresh(): Promise<void> {
    setState({ list: { status: "loading" } });
    try {
      const entries = await apiKeys.listApiKeyMetadata(scope);
      setState({ list: { status: "loaded", entries } });
    } catch (err) {
      setState({
        list: { status: "error", message: describeError(err) },
      });
    }
  }

  async function addOrUpdateApiKey(input: {
    readonly provider: ProviderId;
    readonly apiKey: string;
  }): Promise<AddStatus> {
    if (typeof input.apiKey !== "string" || input.apiKey.length === 0) {
      const status: AddStatus = {
        status: "validation_failed",
        providerCode: "invalid_api_key",
        providerMessage: "API key is empty",
      };
      setState({ add: status });
      return status;
    }
    if (typeof input.provider !== "string" || input.provider.length === 0) {
      const status: AddStatus = {
        status: "validation_failed",
        providerCode: "invalid_provider",
        providerMessage: "Provider is empty",
      };
      setState({ add: status });
      return status;
    }

    setState({ add: { status: "validating" } });

    let validation: ValidationResult;
    try {
      validation = await auth.validateApiKey({
        provider: input.provider,
        apiKey: input.apiKey,
      });
    } catch (err) {
      // Defensive: AuthGateway.validateApiKey is not supposed to throw,
      // but if the transport layer fails we surface a save_failed-style
      // entry rather than swallowing the issue.
      const status: AddStatus = {
        status: "save_failed",
        message: `Validation request failed: ${describeError(err)}`,
      };
      setState({ add: status });
      return status;
    }

    if (validation.kind === "error") {
      const status: AddStatus = {
        status: "validation_failed",
        providerCode: validation.providerCode,
        providerMessage: validation.providerMessage,
      };
      setState({ add: status });
      return status;
    }

    setState({ add: { status: "saving" } });

    try {
      await apiKeys.upsertApiKey(scope, {
        provider: input.provider,
        apiKey: input.apiKey,
      });
    } catch (err) {
      const status: AddStatus = {
        status: "save_failed",
        message: describeError(err),
      };
      setState({ add: status });
      return status;
    }

    const status: AddStatus = { status: "success", provider: input.provider };
    setState({ add: status });
    // Refresh the list so the new/updated entry is visible. We deliberately
    // do not block the returned status on the refresh outcome — a failed
    // refresh produces a list-level error but does not invalidate the
    // already-successful save.
    await refresh();
    return status;
  }

  async function removeApiKey(provider: ProviderId): Promise<DeleteStatus> {
    setState({ delete: { status: "deleting", provider } });
    try {
      await apiKeys.removeApiKey(scope, provider);
    } catch (err) {
      const status: DeleteStatus = {
        status: "error",
        message: describeError(err),
      };
      setState({ delete: status });
      return status;
    }
    // Property 15 / Requirement 4.4: successful deletion never produces an
    // error UI. We mark `delete` as `success` (no error string) and then
    // refresh the listing so the entry disappears.
    const status: DeleteStatus = { status: "success", provider };
    setState({ delete: status });
    await refresh();
    return status;
  }

  return {
    getState: () => state,
    subscribe(listener: ProviderKeysListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    addOrUpdateApiKey,
    removeApiKey,
  };
}

// ---------------------------------------------------------------------------
// DOM mount helper
// ---------------------------------------------------------------------------

export interface MountProviderKeysScreenOptions {
  readonly root: HTMLElement;
  readonly controller: ProviderKeysController;
  /** Optional document override, primarily for jsdom tests. */
  readonly document?: Document;
}

/**
 * Renders the provider/API-key management screen into `root` and wires
 * its DOM events to the supplied controller. Returns a `dispose()`
 * function that unsubscribes the listener and clears the root.
 *
 * The render is intentionally framework-free — the desktop UI bootstrap
 * uses a vanilla DOM style (see `apps/desktop-windows/src/ui/bootstrap.ts`)
 * and reusing it here keeps the screen consumable from both desktop and
 * web until shared-ui adopts a UI framework.
 */
export function mountProviderKeysScreen(
  options: MountProviderKeysScreenOptions,
): () => void {
  const doc = options.document ?? options.root.ownerDocument ?? globalThis.document;
  if (!doc) {
    throw new Error("mountProviderKeysScreen: no Document available");
  }

  const root = options.root;
  root.innerHTML = "";

  // Layout: a header, a "list" region, and an "add key" form.
  const heading = doc.createElement("h2");
  heading.textContent = "API keys";
  heading.className = "provider-keys-heading";

  const listRegion = doc.createElement("section");
  listRegion.className = "provider-keys-list";
  listRegion.setAttribute("aria-live", "polite");

  const form = doc.createElement("form");
  form.className = "provider-keys-form";
  form.setAttribute("novalidate", "novalidate");

  const providerLabel = doc.createElement("label");
  providerLabel.textContent = "Provider";
  const providerInput = doc.createElement("input");
  providerInput.type = "text";
  providerInput.name = "provider";
  providerInput.required = true;
  providerInput.autocomplete = "off";
  providerLabel.append(providerInput);

  const apiKeyLabel = doc.createElement("label");
  apiKeyLabel.textContent = "API key";
  const apiKeyInput = doc.createElement("input");
  apiKeyInput.type = "password";
  apiKeyInput.name = "apiKey";
  apiKeyInput.required = true;
  apiKeyInput.autocomplete = "off";
  apiKeyLabel.append(apiKeyInput);

  const submitButton = doc.createElement("button");
  submitButton.type = "submit";
  submitButton.textContent = "Save key";

  const formStatus = doc.createElement("p");
  formStatus.className = "provider-keys-form-status";
  formStatus.setAttribute("aria-live", "polite");

  form.append(providerLabel, apiKeyLabel, submitButton, formStatus);

  const deleteStatus = doc.createElement("p");
  deleteStatus.className = "provider-keys-delete-status";
  deleteStatus.setAttribute("aria-live", "polite");

  root.append(heading, listRegion, deleteStatus, form);

  function renderList(state: ProviderKeysState): void {
    listRegion.innerHTML = "";
    const list = state.list;
    if (list.status === "idle") {
      listRegion.textContent = "No keys loaded yet.";
      return;
    }
    if (list.status === "loading") {
      listRegion.textContent = "Loading API keys…";
      return;
    }
    if (list.status === "error") {
      listRegion.textContent = `Failed to load keys: ${list.message}`;
      return;
    }
    if (list.entries.length === 0) {
      listRegion.textContent = "No API keys configured.";
      return;
    }
    const ul = doc.createElement("ul");
    ul.className = "provider-keys-entries";
    for (const entry of list.entries) {
      const li = doc.createElement("li");
      li.className = "provider-keys-entry";
      li.setAttribute("data-provider", entry.provider);

      const provider = doc.createElement("span");
      provider.className = "provider-keys-entry-provider";
      provider.textContent = entry.provider;

      const fingerprint = doc.createElement("code");
      fingerprint.className = "provider-keys-entry-fingerprint";
      fingerprint.textContent = entry.fingerprint;

      const createdAt = doc.createElement("time");
      createdAt.className = "provider-keys-entry-created";
      createdAt.dateTime = entry.createdAt;
      createdAt.textContent = `added ${entry.createdAt}`;

      const validatedAt = doc.createElement("time");
      validatedAt.className = "provider-keys-entry-validated";
      validatedAt.dateTime = entry.lastValidatedAt;
      validatedAt.textContent = `validated ${entry.lastValidatedAt}`;

      const deleteButton = doc.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "provider-keys-entry-delete";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", () => {
        void options.controller.removeApiKey(entry.provider);
      });

      li.append(provider, fingerprint, createdAt, validatedAt, deleteButton);
      ul.append(li);
    }
    listRegion.append(ul);
  }

  function renderForm(state: ProviderKeysState): void {
    const add = state.add;
    switch (add.status) {
      case "idle":
        formStatus.textContent = "";
        submitButton.disabled = false;
        break;
      case "validating":
        formStatus.textContent = "Validating with provider…";
        submitButton.disabled = true;
        break;
      case "validation_failed":
        formStatus.textContent =
          `Validation failed (${add.providerCode}): ${add.providerMessage}`;
        submitButton.disabled = false;
        break;
      case "saving":
        formStatus.textContent = "Saving key…";
        submitButton.disabled = true;
        break;
      case "save_failed":
        formStatus.textContent = `Save failed: ${add.message}`;
        submitButton.disabled = false;
        break;
      case "success":
        formStatus.textContent = `Saved key for ${add.provider}.`;
        submitButton.disabled = false;
        // Wipe the input so the plaintext does not linger in the DOM.
        apiKeyInput.value = "";
        break;
    }
  }

  function renderDelete(state: ProviderKeysState): void {
    const del = state.delete;
    switch (del.status) {
      case "idle":
        deleteStatus.textContent = "";
        break;
      case "deleting":
        deleteStatus.textContent = `Deleting ${del.provider}…`;
        break;
      case "success":
        // Property 15 / Requirement 4.4: successful delete shows no error.
        // Surface a non-error confirmation instead.
        deleteStatus.textContent = `Removed ${del.provider}.`;
        break;
      case "error":
        deleteStatus.textContent = `Delete failed: ${del.message}`;
        break;
    }
  }

  function render(state: ProviderKeysState): void {
    renderList(state);
    renderForm(state);
    renderDelete(state);
  }

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    const provider = providerInput.value.trim();
    const apiKey = apiKeyInput.value;
    void options.controller.addOrUpdateApiKey({ provider, apiKey });
  };
  form.addEventListener("submit", onSubmit);

  const unsubscribe = options.controller.subscribe(render);
  render(options.controller.getState());

  return () => {
    unsubscribe();
    form.removeEventListener("submit", onSubmit);
    root.innerHTML = "";
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  if (typeof err === "string") return err;
  return "unknown error";
}
