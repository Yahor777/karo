/**
 * File_Artifact viewer controller (task 10.3).
 *
 * Sources:
 *   • design.md → "Artifact Store" → "Interface" (`getArtifact`,
 *     `listArtifacts`, `getDiff`) and "Rules" ("diff generation happens
 *     only on explicit request").
 *   • design.md → "Trace Event Bus" → "Rules" ("diff must not open
 *     automatically. Diff opens only after explicit user selection of
 *     File_Artifact").
 *   • requirements.md → 11.4, 11.5, 11.7.
 *   • tasks.md → task 10.3 ("Show content on artifact selection; show
 *     diff only on explicit version comparison action. Never auto-open
 *     diff in response to other UI events").
 *
 * Validates: Requirements 11.4, 11.5, 11.7.
 *
 * Design notes
 * ------------
 *
 *   1. The controller is framework-free. It exposes a tiny
 *      subscribe/getState API so the DOM mount in
 *      `mountArtifactViewer.ts` can re-render imperatively. A future
 *      React/Vue host could use the same controller through a thin
 *      adapter — same pattern as the Model Selection screen.
 *
 *   2. The controller is the single integration point for
 *      `ArtifactGateway`. It owns four entry points (`refresh`,
 *      `selectArtifact`, `selectVersion`, `requestDiff`) and these are
 *      the ONLY places where gateway methods are called. In particular:
 *
 *        • `refresh()`        → `gateway.listArtifacts(...)` only
 *        • `selectArtifact()` → `gateway.getArtifact(...)` only
 *        • `selectVersion()`  → `gateway.getArtifact(...)` only
 *        • `requestDiff()`    → `gateway.getDiff(...)` only
 *
 *      `gateway.getDiff` is reachable from `requestDiff` and from
 *      nowhere else. This is the controller-level enforcement of
 *      Requirement 11.5 / Property 11 ("diff is never displayed
 *      automatically"). The unit test in
 *      `artifactViewerController.test.ts` exercises every other entry
 *      point against a counting spy and asserts `getDiff` stays at
 *      zero invocations.
 *
 *   3. `requestDiff(fromVersion, toVersion)` is intentionally a
 *      separate, explicit API. Selection / refresh / version
 *      navigation NEVER trigger it as a side effect. The mount helper
 *      wires this entry point to a "Compare versions" button that
 *      requires the user to pick two distinct versions and click the
 *      button. There is no path that reaches `requestDiff` from a
 *      selection change, a refresh tick, or any other UI event.
 *
 *   4. State transitions are immutable: `getState()` returns the same
 *      object reference until something actually changes. Listeners
 *      are notified synchronously after each transition. The mount
 *      helper uses reference equality to skip redundant renders.
 *
 *   5. Concurrent in-flight calls are disambiguated with monotonic
 *      tokens. If the user clicks several artifacts in quick
 *      succession, only the most recent `getArtifact` is allowed to
 *      apply its result; older ones become no-ops on completion so
 *      the UI cannot flash stale content. Same pattern as the Model
 *      Selection controller.
 *
 *   6. Errors are surfaced into discriminated state slots
 *      (`ContentStatus`, `DiffStatus`, `ListStatus`) rather than
 *      thrown. The mount helper renders them as inline error banners.
 */

import type {
  ArtifactGateway,
  DiffPatch,
  FileArtifactContent,
  FileArtifactMetadata,
  TaskId,
} from "../../ports/artifacts.js";

// ---------------------------------------------------------------------------
// Public state shape
// ---------------------------------------------------------------------------

/**
 * Status of the most recent `listArtifacts` call.
 *
 *   • `idle`    — `refresh()` has not run yet.
 *   • `loading` — a refresh is in flight; previous `artifacts` are kept
 *                 visible so the UI does not blank on transient blips.
 *   • `loaded`  — the most recent refresh succeeded.
 *   • `error`   — the gateway rejected; UI shows the reason inline.
 */
export type ListStatus =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "loaded" }
  | { readonly status: "error"; readonly message: string };

/**
 * Status of the currently-displayed artifact content. The selected
 * artifact and selected version are tracked separately on the top
 * level state so the renderer can highlight the row even while content
 * is still loading.
 */
export type ContentStatus =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly content: FileArtifactContent }
  | { readonly status: "error"; readonly message: string };

/**
 * Status of the most recent `requestDiff` call.
 *
 *   • `idle`     — no diff has been requested in this session yet, or
 *                  the active selection changed and the diff cleared.
 *   • `loading`  — a `getDiff` call is in flight.
 *   • `ready`    — the diff has been computed and is on display.
 *   • `error`    — the gateway rejected, or the requested versions did
 *                  not exist for the artifact.
 *
 * The `comparing` flag on the top-level state captures the
 * "user is explicitly comparing versions" UI mode. It flips to true
 * only on `requestDiff(...)` and is reset whenever the active artifact
 * changes — including via `selectArtifact()` or a `refresh()` that
 * removes the current artifact from the listing.
 */
export type DiffStatus =
  | { readonly status: "idle" }
  | {
      readonly status: "loading";
      readonly fromVersion: number;
      readonly toVersion: number;
    }
  | { readonly status: "ready"; readonly diff: DiffPatch }
  | { readonly status: "error"; readonly message: string };

export interface ArtifactViewerState {
  readonly taskId: TaskId;
  /** Metadata listing returned by the gateway, in gateway order. */
  readonly artifacts: readonly FileArtifactMetadata[];
  readonly listStatus: ListStatus;
  /** ID of the artifact currently selected in the left pane. */
  readonly selectedArtifactId: string | null;
  /**
   * Version of the selected artifact currently being displayed in the
   * right pane. `null` when nothing is selected; defaults to
   * `latestVersion` on initial selection.
   */
  readonly selectedVersion: number | null;
  /** Content for the `(selectedArtifactId, selectedVersion)` pair. */
  readonly content: ContentStatus;
  /** Last-requested diff (only populated after `requestDiff(...)`). */
  readonly diff: DiffStatus;
  /**
   * `true` iff the user is currently in "compare versions" mode (i.e.
   * an explicit `requestDiff(...)` is in flight or has produced a
   * result). Selection-change events always reset this to `false`.
   */
  readonly comparing: boolean;
}

export type ArtifactViewerListener = (state: ArtifactViewerState) => void;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface ArtifactViewerControllerOptions {
  readonly gateway: ArtifactGateway;
  readonly taskId: TaskId;
  /**
   * Pre-populate the listing — handy for SSR or screenshot tests. The
   * controller does not call `refresh()` automatically; the embedder
   * is expected to call it once the screen mounts.
   */
  readonly initialArtifacts?: readonly FileArtifactMetadata[];
}

/**
 * Public surface of the artifact viewer controller.
 *
 * The four entry points (`refresh`, `selectArtifact`, `selectVersion`,
 * `requestDiff`) constitute the entire user-driven action surface.
 * `requestDiff` is the ONLY path that reaches `gateway.getDiff`.
 */
export interface ArtifactViewerController {
  /** Returns the current snapshot. Stable reference until next change. */
  getState(): ArtifactViewerState;
  /** Subscribe to state transitions. Returns an unsubscribe function. */
  subscribe(listener: ArtifactViewerListener): () => void;
  /** Re-fetches the artifact listing for the controller's task. */
  refresh(): Promise<void>;
  /**
   * Selects an artifact and loads its latest version's content. Clears
   * any prior diff state and exits "compare versions" mode — selection
   * NEVER auto-opens a diff (Requirement 11.5).
   */
  selectArtifact(artifactId: string): Promise<void>;
  /**
   * Loads a specific version of the currently-selected artifact.
   * Clears any prior diff state and exits "compare versions" mode for
   * the same reason as `selectArtifact`.
   */
  selectVersion(version: number): Promise<void>;
  /**
   * Explicit user gesture to compare two versions of the
   * currently-selected artifact. This is the ONLY entry point that
   * calls `gateway.getDiff`. Throws synchronously if no artifact is
   * selected or if `fromVersion === toVersion`.
   */
  requestDiff(fromVersion: number, toVersion: number): Promise<void>;
}

/**
 * Builds an `ArtifactViewerController` over the supplied gateway.
 *
 * The controller is implemented as a closure rather than a class so the
 * private state cannot be reached through `this`-binding gymnastics
 * from the renderer. Same convention as
 * `createProviderKeysController` in `screens/settings/providerKeys.ts`.
 */
export function createArtifactViewerController(
  options: ArtifactViewerControllerOptions,
): ArtifactViewerController {
  const { gateway, taskId } = options;

  let state: ArtifactViewerState = {
    taskId,
    artifacts: options.initialArtifacts ?? [],
    listStatus: { status: "idle" },
    selectedArtifactId: null,
    selectedVersion: null,
    content: { status: "idle" },
    diff: { status: "idle" },
    comparing: false,
  };
  const listeners = new Set<ArtifactViewerListener>();

  /**
   * Monotonic tokens. We track one per async path so a slow `getArtifact`
   * never overwrites a fresher selection's content, and a slow
   * `getDiff` never overwrites a fresher diff request.
   */
  let listToken = 0;
  let contentToken = 0;
  let diffToken = 0;

  function emit(next: ArtifactViewerState): void {
    if (next === state) return;
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  }

  function update(
    updater: (s: ArtifactViewerState) => ArtifactViewerState,
  ): void {
    emit(updater(state));
  }

  // -----------------------------------------------------------------------
  // refresh()
  // -----------------------------------------------------------------------

  async function refresh(): Promise<void> {
    const token = ++listToken;
    update((s) => ({ ...s, listStatus: { status: "loading" } }));

    let entries: readonly FileArtifactMetadata[];
    try {
      entries = await gateway.listArtifacts(taskId);
    } catch (err) {
      if (token !== listToken) return; // a newer refresh already won
      update((s) => ({
        ...s,
        listStatus: { status: "error", message: describeError(err) },
      }));
      return;
    }

    if (token !== listToken) return;

    update((s) => {
      // If the selected artifact disappeared from the listing (e.g.
      // listing changed scope, server purged it) clear selection +
      // content + diff so the right pane does not keep stale data.
      const stillPresent =
        s.selectedArtifactId !== null &&
        entries.some((e) => e.id === s.selectedArtifactId);

      if (!stillPresent && s.selectedArtifactId !== null) {
        return {
          ...s,
          artifacts: entries,
          listStatus: { status: "loaded" },
          selectedArtifactId: null,
          selectedVersion: null,
          content: { status: "idle" },
          diff: { status: "idle" },
          comparing: false,
        };
      }

      return {
        ...s,
        artifacts: entries,
        listStatus: { status: "loaded" },
      };
    });
  }

  // -----------------------------------------------------------------------
  // selectArtifact()
  // -----------------------------------------------------------------------

  async function selectArtifact(artifactId: string): Promise<void> {
    const meta = state.artifacts.find((a) => a.id === artifactId);
    if (meta === undefined) {
      // Selection of an artifact not in the snapshot is a programmer
      // error. We surface it via the content slot rather than throwing
      // so the renderer (which may not handle a thrown promise) shows
      // the cause. Selection identity still flips so highlight follows
      // the click.
      update((s) => ({
        ...s,
        selectedArtifactId: artifactId,
        selectedVersion: null,
        content: {
          status: "error",
          message: `Artifact "${artifactId}" not in current listing`,
        },
        diff: { status: "idle" },
        comparing: false,
      }));
      return;
    }

    // Default to the latest version. selectVersion() can refine this
    // later. Note: this triggers gateway.getArtifact, NOT
    // gateway.getDiff — selection never auto-opens a diff.
    await loadVersion(artifactId, meta.latestVersion, /*resetDiff=*/ true);
  }

  // -----------------------------------------------------------------------
  // selectVersion()
  // -----------------------------------------------------------------------

  async function selectVersion(version: number): Promise<void> {
    if (state.selectedArtifactId === null) {
      throw new Error(
        "ArtifactViewerController.selectVersion: no artifact selected",
      );
    }
    assertPositiveInteger(version, "version");
    await loadVersion(state.selectedArtifactId, version, /*resetDiff=*/ true);
  }

  /**
   * Shared helper for `selectArtifact` / `selectVersion` — loads a
   * specific `(artifactId, version)` content blob. `resetDiff = true`
   * clears any prior diff state so navigation never leaves a stale
   * diff visible. The mount helper relies on this to decide whether
   * to render the diff pane or the content pane.
   *
   * MUST NEVER call `gateway.getDiff`.
   */
  async function loadVersion(
    artifactId: string,
    version: number,
    resetDiff: boolean,
  ): Promise<void> {
    const token = ++contentToken;
    update((s) => ({
      ...s,
      selectedArtifactId: artifactId,
      selectedVersion: version,
      content: { status: "loading" },
      diff: resetDiff ? { status: "idle" } : s.diff,
      comparing: resetDiff ? false : s.comparing,
    }));

    let content: FileArtifactContent | null;
    try {
      content = await gateway.getArtifact({
        taskId,
        artifactId,
        version,
      });
    } catch (err) {
      if (token !== contentToken) return;
      update((s) => ({
        ...s,
        content: { status: "error", message: describeError(err) },
      }));
      return;
    }

    if (token !== contentToken) return;

    if (content === null) {
      update((s) => ({
        ...s,
        content: {
          status: "error",
          message: `Version ${version} of "${artifactId}" not found`,
        },
      }));
      return;
    }

    update((s) => ({
      ...s,
      content: { status: "loaded", content },
    }));
  }

  // -----------------------------------------------------------------------
  // requestDiff()
  // -----------------------------------------------------------------------
  //
  // THIS IS THE ONLY ENTRY POINT THAT CALLS `gateway.getDiff`.
  // -----------------------------------------------------------------------

  async function requestDiff(
    fromVersion: number,
    toVersion: number,
  ): Promise<void> {
    const artifactId = state.selectedArtifactId;
    if (artifactId === null) {
      throw new Error(
        "ArtifactViewerController.requestDiff: no artifact selected",
      );
    }
    assertPositiveInteger(fromVersion, "fromVersion");
    assertPositiveInteger(toVersion, "toVersion");
    if (fromVersion === toVersion) {
      throw new Error(
        "ArtifactViewerController.requestDiff: fromVersion and toVersion must differ",
      );
    }

    const token = ++diffToken;
    update((s) => ({
      ...s,
      diff: { status: "loading", fromVersion, toVersion },
      comparing: true,
    }));

    let diff: DiffPatch | null;
    try {
      // The single, deliberate, explicit-gesture-only call to
      // `gateway.getDiff`. No other code path in this file reaches it.
      diff = await gateway.getDiff({
        taskId,
        artifactId,
        fromVersion,
        toVersion,
      });
    } catch (err) {
      if (token !== diffToken) return;
      update((s) => ({
        ...s,
        diff: { status: "error", message: describeError(err) },
      }));
      return;
    }

    if (token !== diffToken) return;

    if (diff === null) {
      update((s) => ({
        ...s,
        diff: {
          status: "error",
          message: `Diff between v${fromVersion} and v${toVersion} not available`,
        },
      }));
      return;
    }

    update((s) => ({
      ...s,
      diff: { status: "ready", diff },
    }));
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    selectArtifact,
    selectVersion,
    requestDiff,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertPositiveInteger(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(
      `ArtifactViewerController: ${field} must be a positive integer (>= 1)`,
    );
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  if (typeof err === "string") return err;
  return "unknown error";
}
