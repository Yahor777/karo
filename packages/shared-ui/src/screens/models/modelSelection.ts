/**
 * Model Selection screen controller.
 *
 * Source:
 *   • design.md → "Model Catalog" → "Rules" (per-provider isolation,
 *     explicit fallback labelling, no silent fallback substitution).
 *   • requirements.md → 5.2, 5.3, 5.5.
 *   • tasks.md → task 7.2 ("Build Model selection UI with fallback
 *     labeling").
 *
 * Validates: Requirements 5.2, 5.3, 5.5.
 *
 * Design notes:
 *
 *   • The controller is framework-free. It exposes a tiny
 *     subscribe/getState API so the DOM mount in `mountModelSelection`
 *     can re-render imperatively, but a future React/Vue host could use
 *     the same controller with a thin adapter.
 *   • Snapshots are immutable. `getState()` returns the same object
 *     reference until something actually changes; the DOM mount uses
 *     reference equality to short-circuit redundant renders.
 *   • Fallback selection is gated behind a `pendingFallback` step. The
 *     caller MUST invoke `confirmFallback()` before the platform
 *     fallback model becomes the active selection. This implements
 *     Requirement 5.5's "fallback must not silently replace user's
 *     chosen model" rule at the UI level.
 *   • Provider isolation (Requirement 5.3 / Property 7) is preserved by
 *     storing the gateway's full `ProviderModelsResult[]` snapshot
 *     verbatim. Errors are rendered inline alongside healthy
 *     providers — the controller never drops or merges them.
 */

import type {
  ModelCatalogGateway,
  ModelInfo,
  ModelRef,
  ProviderModelsResult,
  Scope,
} from "./types.js";

/**
 * What a `confirmFallback()` call applies. Stored separately from the
 * active selection so the UI can render "Pending: <name>" without
 * mutating the user's previous choice until they actually confirm.
 */
export interface PendingFallback {
  readonly modelRef: ModelRef;
  /**
   * Human-readable text that describes what the user is opting into.
   * The renderer may show this verbatim in a confirmation banner.
   */
  readonly notice: string;
}

/**
 * Top-level loading state for the screen.
 *
 *   • `idle`     — no `refresh()` has been kicked off yet.
 *   • `loading`  — a refresh is in flight; previous `providers` are kept
 *     visible to avoid blanking the UI on transient network blips.
 *   • `ready`    — the most recent `refresh()` completed successfully.
 *   • `error`    — the gateway rejected outright (network down, etc.).
 *     This is distinct from individual provider errors, which are
 *     surfaced per-provider via `status: "error"` entries.
 */
export type ModelSelectionLoadStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "error"; readonly reason: string };

/**
 * Public controller snapshot. The DOM mount renders directly from this
 * shape; tests assert against it.
 */
export interface ModelSelectionState {
  readonly scope: Scope;
  readonly status: ModelSelectionLoadStatus;
  /**
   * Per-provider listing exactly as the gateway returned it, including
   * `status: "error"` entries. Order is preserved so the UI can render
   * a stable list across refreshes.
   */
  readonly providers: readonly ProviderModelsResult[];
  /**
   * The model currently applied to downstream task creation. `null`
   * means the user has not made a choice yet.
   */
  readonly selectedModelRef: ModelRef | null;
  /**
   * A fallback model the user has highlighted but not yet confirmed.
   * `null` when no fallback is pending. The renderer disables the
   * primary "Use this model" button on platform-fallback options until
   * `confirmFallback()` runs.
   */
  readonly pendingFallback: PendingFallback | null;
}

/**
 * Optional initial state for tests/composition.
 */
export interface ModelSelectionControllerOptions {
  readonly gateway: ModelCatalogGateway;
  readonly scope: Scope;
  /** Pre-populate the providers list — handy for SSR or screenshot tests. */
  readonly initialProviders?: readonly ProviderModelsResult[];
  /** Pre-populate the active selection. */
  readonly initialSelectedModel?: ModelRef;
}

type Listener = (state: ModelSelectionState) => void;

/**
 * Builds the human-readable notice rendered next to a pending fallback
 * model. We include the modelId so users can tell two fallbacks apart
 * if the platform exposes more than one tier.
 */
function buildFallbackNotice(model: ModelInfo): string {
  const tier = model.qualityTier ? ` (${model.qualityTier})` : "";
  return `Platform fallback model "${model.displayName}"${tier}. Quality may be reduced; usage is rate-limited.`;
}

/**
 * Controller for the Model Selection screen.
 *
 * The class is intentionally small: it owns the snapshot, the action
 * handlers, and a subscribe/notify loop. It does not know anything
 * about the DOM.
 */
export class ModelSelectionController {
  private readonly gateway: ModelCatalogGateway;
  private readonly listeners = new Set<Listener>();
  private state: ModelSelectionState;
  /**
   * Monotonically increasing token to disambiguate concurrent
   * `refresh()` calls. Only the latest one is allowed to mutate
   * `providers`; older in-flight requests become no-ops on completion
   * so the UI can never flash stale data.
   */
  private refreshCounter = 0;

  public constructor(options: ModelSelectionControllerOptions) {
    this.gateway = options.gateway;
    this.state = {
      scope: options.scope,
      status: { kind: "idle" },
      providers: options.initialProviders ?? [],
      selectedModelRef: options.initialSelectedModel ?? null,
      pendingFallback: null,
    };
  }

  /** Returns the current snapshot. Stable reference until next change. */
  public getState(): ModelSelectionState {
    return this.state;
  }

  /**
   * Registers a listener. The returned function unsubscribes. Listeners
   * are invoked synchronously after each state change so the DOM mount
   * can stay consistent with imperative input handlers.
   */
  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Re-fetches the catalog. Concurrent calls are safe: only the most
   * recent one is allowed to apply its result.
   */
  public async refresh(): Promise<void> {
    const token = ++this.refreshCounter;
    this.update((s) => ({ ...s, status: { kind: "loading" } }));

    let result: readonly ProviderModelsResult[];
    try {
      result = await this.gateway.listModelsForUser(this.state.scope);
    } catch (err) {
      // Stale completion: a newer refresh already won, so do nothing.
      if (token !== this.refreshCounter) {
        return;
      }
      this.update((s) => ({
        ...s,
        status: { kind: "error", reason: describeError(err) },
      }));
      return;
    }

    if (token !== this.refreshCounter) {
      return;
    }

    this.update((s) => {
      // If the previously selected model disappeared from the catalog
      // (e.g. user removed the API key), clear the selection so the UI
      // does not silently keep an unusable model.
      const next = pruneSelection(s.selectedModelRef, result);
      const pending = pruneSelection(
        s.pendingFallback ? s.pendingFallback.modelRef : null,
        result,
      );
      return {
        ...s,
        status: { kind: "ready" },
        providers: result,
        selectedModelRef: next,
        pendingFallback:
          pending && s.pendingFallback
            ? { modelRef: pending, notice: s.pendingFallback.notice }
            : null,
      };
    });
  }

  /**
   * Selects a model.
   *
   *   • If `modelRef.source === "user-api-key"`, the selection is
   *     applied immediately and any pending fallback is cleared.
   *   • If `modelRef.source === "platform-fallback"`, the selection is
   *     held in `pendingFallback` and the active `selectedModelRef`
   *     does NOT change until `confirmFallback()` runs. This is the
   *     concrete enforcement of Requirement 5.5 at the controller
   *     level.
   *
   * Throws if the model is not present in the current catalog snapshot.
   * The renderer should never construct a `ModelRef` from outside the
   * snapshot, but the guard keeps test failures readable when it does.
   */
  public setSelectedModel(modelRef: ModelRef): void {
    const found = findModel(this.state.providers, modelRef);
    if (found === null) {
      throw new Error(
        `Model "${modelRef.provider}/${modelRef.modelId}" (source=${modelRef.source}) not found in catalog snapshot`,
      );
    }

    if (found.source === "platform-fallback") {
      const notice = buildFallbackNotice(found);
      this.update((s) => ({
        ...s,
        pendingFallback: { modelRef, notice },
      }));
      return;
    }

    this.update((s) => ({
      ...s,
      selectedModelRef: modelRef,
      pendingFallback: null,
    }));
  }

  /**
   * Applies the currently pending fallback selection. No-op if there
   * is nothing pending. After confirmation `pendingFallback` is
   * cleared and `selectedModelRef` reflects the fallback model.
   */
  public confirmFallback(): void {
    const pending = this.state.pendingFallback;
    if (pending === null) {
      return;
    }
    this.update((s) => ({
      ...s,
      selectedModelRef: pending.modelRef,
      pendingFallback: null,
    }));
  }

  /**
   * Discards a pending fallback selection without applying it. Useful
   * when the user clicks "Cancel" on the confirmation banner.
   */
  public cancelPendingFallback(): void {
    if (this.state.pendingFallback === null) {
      return;
    }
    this.update((s) => ({ ...s, pendingFallback: null }));
  }

  /**
   * Drops the active selection. Mostly used by tests and by composition
   * code when the underlying scope changes.
   */
  public clearSelection(): void {
    this.update((s) => ({
      ...s,
      selectedModelRef: null,
      pendingFallback: null,
    }));
  }

  private update(
    updater: (s: ModelSelectionState) => ModelSelectionState,
  ): void {
    const next = updater(this.state);
    if (next === this.state) {
      return;
    }
    this.state = next;
    for (const l of this.listeners) {
      l(this.state);
    }
  }
}

/**
 * Looks up a model by `(provider, modelId, source)` triple. Source is
 * part of the key because the catalog can list the same modelId both
 * via the user's key and via the platform fallback adapter; those are
 * distinct selectable rows in the UI.
 */
function findModel(
  providers: readonly ProviderModelsResult[],
  ref: ModelRef,
): ModelInfo | null {
  for (const p of providers) {
    if (p.status !== "ok") continue;
    if (p.provider !== ref.provider) continue;
    for (const m of p.models) {
      if (
        m.modelId === ref.modelId &&
        m.source === ref.source &&
        m.provider === ref.provider
      ) {
        return m;
      }
    }
  }
  return null;
}

/**
 * Returns `ref` unchanged if it still exists in the snapshot; otherwise
 * `null`. Used after `refresh()` to drop selections that were tied to
 * an API key the user has since removed.
 */
function pruneSelection(
  ref: ModelRef | null,
  providers: readonly ProviderModelsResult[],
): ModelRef | null {
  if (ref === null) return null;
  return findModel(providers, ref) === null ? null : ref;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || "Unknown error";
  }
  if (typeof err === "string") {
    return err;
  }
  return "Unknown error";
}
