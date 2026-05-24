/**
 * Framework-free DOM mount for the File_Artifact viewer (task 10.3).
 *
 * Sources:
 *   • design.md → "Artifact Store" → "Rules" ("Diff generation happens
 *     only on explicit request").
 *   • design.md → "Trace Event Bus" → "Rules" ("Diff must not open
 *     automatically. Diff opens only after explicit user selection of
 *     File_Artifact").
 *   • requirements.md → 11.4, 11.5, 11.7.
 *
 * Validates: Requirements 11.4, 11.5, 11.7.
 *
 * Layout
 * ------
 *
 *   ┌─────────────────────┬───────────────────────────────────────┐
 *   │  Artifact list      │  Right pane                           │
 *   │  (left)             │                                        │
 *   │                     │   • Header with file name + version    │
 *   │  • file-a.txt v3    │   • Version picker + "Compare versions"│
 *   │  • file-b.bin v1    │     button (explicit gesture only)     │
 *   │  • file-c.json v2   │   • Content pane OR diff pane          │
 *   │                     │     (mutually exclusive)               │
 *   └─────────────────────┴───────────────────────────────────────┘
 *
 * Behavioural invariants
 * ----------------------
 *
 *   1. Clicking an artifact in the left pane calls
 *      `controller.selectArtifact(id)`. This NEVER triggers a diff —
 *      the controller resets the diff slot to `idle` on every selection
 *      change, and the renderer reflects that by hiding the diff pane.
 *
 *   2. The "Compare versions" button is the ONLY UI affordance that
 *      calls `controller.requestDiff(...)`. The button stays disabled
 *      until the user has explicitly picked two distinct, valid
 *      versions in the From / To selects. There is no keyboard
 *      shortcut, no double-click, no selection-change handler that
 *      opens a diff. Requirement 11.5 / Property 11 are enforced both
 *      at the controller boundary (single call site for `getDiff`) and
 *      at the DOM boundary (single click handler for `requestDiff`).
 *
 *   3. Binary content is rendered as a short hex summary plus a
 *      "binary" placeholder. UTF-8-decodable content (`text/*`,
 *      `application/json`, no mime hint, etc.) is rendered as text.
 *      The decision is heuristic — the source of truth for binary
 *      classification on a real run is the producer's `mimeType`,
 *      which is not surfaced through `FileArtifactMetadata` /
 *      `FileArtifactContent`. We therefore look at the file extension
 *      and at the bytes themselves.
 *
 *   4. The mount helper is framework-free vanilla DOM, matching the
 *      style of `mountModelSelection.ts` and `mountProviderKeysScreen`.
 */

import type {
  ArtifactViewerController,
  ArtifactViewerState,
  ContentStatus,
  DiffStatus,
  ListStatus,
} from "./artifactViewerController.js";
import type {
  FileArtifactContent,
  FileArtifactMetadata,
} from "../../ports/artifacts.js";

export interface MountArtifactViewerOptions {
  readonly root: HTMLElement;
  readonly controller: ArtifactViewerController;
  /** Optional document override, primarily for jsdom tests. */
  readonly document?: Document;
}

/**
 * Mounts the artifact viewer into `root`.
 *
 *   • Replaces any existing children of `root`.
 *   • Subscribes to the controller for live updates.
 *   • Returns a teardown function that detaches the listener and
 *     empties `root`.
 */
export function mountArtifactViewer(
  options: MountArtifactViewerOptions,
): () => void {
  const doc =
    options.document ?? options.root.ownerDocument ?? globalThis.document;
  if (!doc) {
    throw new Error("mountArtifactViewer: no Document available");
  }

  const root = options.root;
  const controller = options.controller;

  root.innerHTML = "";
  root.classList.add("artifact-viewer");

  // ----------------------------------------------------------------- left
  const leftPane = doc.createElement("section");
  leftPane.className = "artifact-viewer__list";
  leftPane.setAttribute("aria-label", "Artifacts");

  const leftHeader = doc.createElement("div");
  leftHeader.className = "artifact-viewer__list-header";

  const heading = doc.createElement("h2");
  heading.className = "artifact-viewer__title";
  heading.textContent = "Artifacts";

  const refreshButton = doc.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "artifact-viewer__refresh";
  refreshButton.textContent = "Refresh";
  refreshButton.addEventListener("click", () => {
    void controller.refresh();
  });

  leftHeader.append(heading, refreshButton);

  const listStatusEl = doc.createElement("p");
  listStatusEl.className = "artifact-viewer__list-status";
  listStatusEl.setAttribute("aria-live", "polite");

  const listEl = doc.createElement("ul");
  listEl.className = "artifact-viewer__list-items";

  leftPane.append(leftHeader, listStatusEl, listEl);

  // ---------------------------------------------------------------- right
  const rightPane = doc.createElement("section");
  rightPane.className = "artifact-viewer__detail";
  rightPane.setAttribute("aria-label", "Selected artifact");

  const detailHeader = doc.createElement("div");
  detailHeader.className = "artifact-viewer__detail-header";

  const fileNameEl = doc.createElement("h3");
  fileNameEl.className = "artifact-viewer__file-name";

  const versionLabel = doc.createElement("span");
  versionLabel.className = "artifact-viewer__version-label";

  detailHeader.append(fileNameEl, versionLabel);

  // Compare-versions controls. The "Compare versions" button is the
  // ONE entry point that triggers requestDiff(...). No other DOM
  // listener calls requestDiff.
  const compareForm = doc.createElement("form");
  compareForm.className = "artifact-viewer__compare";
  // Block native form submission — we drive the call through the
  // button click handler explicitly.
  compareForm.addEventListener("submit", (event) => event.preventDefault());

  const compareLabel = doc.createElement("span");
  compareLabel.className = "artifact-viewer__compare-label";
  compareLabel.textContent = "Compare versions:";

  const fromSelect = doc.createElement("select");
  fromSelect.className = "artifact-viewer__compare-from";
  fromSelect.setAttribute("aria-label", "From version");

  const toSelect = doc.createElement("select");
  toSelect.className = "artifact-viewer__compare-to";
  toSelect.setAttribute("aria-label", "To version");

  const compareButton = doc.createElement("button");
  compareButton.type = "button";
  compareButton.className = "artifact-viewer__compare-button";
  compareButton.textContent = "Compare versions";
  compareButton.disabled = true;
  // CRITICAL: this is the only DOM affordance that triggers a diff.
  // No selection-change handler, no double-click, no keyboard shortcut
  // calls requestDiff. Requirement 11.5 / Property 11.
  compareButton.addEventListener("click", () => {
    const from = parseSelectedVersion(fromSelect);
    const to = parseSelectedVersion(toSelect);
    if (from === null || to === null || from === to) {
      // Defensive: enableCompareButton() should have prevented this,
      // but the click handler is the last line of defence. Doing
      // nothing here is safe.
      return;
    }
    void controller.requestDiff(from, to);
  });

  const cancelDiffButton = doc.createElement("button");
  cancelDiffButton.type = "button";
  cancelDiffButton.className = "artifact-viewer__compare-cancel";
  cancelDiffButton.textContent = "Close diff";
  cancelDiffButton.hidden = true;
  cancelDiffButton.addEventListener("click", () => {
    // Re-selecting the active version exits compare mode without
    // opening a different artifact. The controller resets the diff
    // slot on selectVersion, which is what we want here.
    const s = controller.getState();
    if (s.selectedVersion !== null) {
      void controller.selectVersion(s.selectedVersion);
    }
  });

  compareForm.append(
    compareLabel,
    fromSelect,
    toSelect,
    compareButton,
    cancelDiffButton,
  );

  const contentPane = doc.createElement("div");
  contentPane.className = "artifact-viewer__content";
  contentPane.setAttribute("aria-live", "polite");

  const diffPane = doc.createElement("pre");
  diffPane.className = "artifact-viewer__diff";
  diffPane.setAttribute("aria-live", "polite");
  diffPane.hidden = true;

  rightPane.append(detailHeader, compareForm, contentPane, diffPane);

  root.append(leftPane, rightPane);

  // ------------------------------------------------------------- render

  function render(state: ArtifactViewerState): void {
    renderList(state);
    renderHeader(state);
    renderCompareControls(state);
    renderRightPane(state);
  }

  function renderList(state: ArtifactViewerState): void {
    renderListStatus(state.listStatus);
    listEl.innerHTML = "";

    if (state.artifacts.length === 0) {
      const empty = doc.createElement("li");
      empty.className = "artifact-viewer__list-empty";
      empty.textContent =
        state.listStatus.status === "loading"
          ? "Loading artifacts…"
          : "No artifacts for this task.";
      listEl.append(empty);
      return;
    }

    for (const meta of state.artifacts) {
      listEl.append(renderListItem(meta, state));
    }
  }

  function renderListStatus(status: ListStatus): void {
    switch (status.status) {
      case "idle":
        listStatusEl.textContent = "";
        delete listStatusEl.dataset["state"];
        refreshButton.disabled = false;
        break;
      case "loading":
        listStatusEl.textContent = "Loading artifacts…";
        delete listStatusEl.dataset["state"];
        refreshButton.disabled = true;
        break;
      case "loaded":
        listStatusEl.textContent = "";
        delete listStatusEl.dataset["state"];
        refreshButton.disabled = false;
        break;
      case "error":
        listStatusEl.textContent = `Failed to load artifacts: ${status.message}`;
        listStatusEl.dataset["state"] = "error";
        refreshButton.disabled = false;
        break;
    }
  }

  function renderListItem(
    meta: FileArtifactMetadata,
    state: ArtifactViewerState,
  ): HTMLElement {
    const item = doc.createElement("li");
    item.className = "artifact-viewer__list-item";
    item.dataset["artifactId"] = meta.id;

    if (meta.id === state.selectedArtifactId) {
      item.dataset["selected"] = "true";
    }

    const button = doc.createElement("button");
    button.type = "button";
    button.className = "artifact-viewer__list-item-button";
    // Selection click handler. NEVER calls requestDiff — selection
    // does not auto-open a diff (Requirement 11.5).
    button.addEventListener("click", () => {
      void controller.selectArtifact(meta.id);
    });

    const fileName = doc.createElement("span");
    fileName.className = "artifact-viewer__list-item-name";
    fileName.textContent = meta.fileName;

    const version = doc.createElement("span");
    version.className = "artifact-viewer__list-item-version";
    version.textContent = `v${meta.latestVersion}`;

    const updatedAt = doc.createElement("time");
    updatedAt.className = "artifact-viewer__list-item-updated";
    updatedAt.dateTime = meta.updatedAt;
    updatedAt.textContent = meta.updatedAt;

    button.append(fileName, version, updatedAt);
    item.append(button);
    return item;
  }

  function renderHeader(state: ArtifactViewerState): void {
    if (state.selectedArtifactId === null) {
      fileNameEl.textContent = "Select an artifact";
      versionLabel.textContent = "";
      return;
    }
    const meta = state.artifacts.find(
      (a) => a.id === state.selectedArtifactId,
    );
    fileNameEl.textContent = meta?.fileName ?? state.selectedArtifactId;
    versionLabel.textContent =
      state.selectedVersion !== null ? `v${state.selectedVersion}` : "";
  }

  function renderCompareControls(state: ArtifactViewerState): void {
    const meta =
      state.selectedArtifactId !== null
        ? state.artifacts.find((a) => a.id === state.selectedArtifactId)
        : undefined;

    // Hide compare controls when nothing is selected — there is
    // nothing to compare.
    compareForm.hidden = meta === undefined;
    if (meta === undefined) {
      compareButton.disabled = true;
      cancelDiffButton.hidden = true;
      fromSelect.innerHTML = "";
      toSelect.innerHTML = "";
      return;
    }

    rebuildVersionSelect(fromSelect, meta, /*defaultVersion=*/ 1);
    rebuildVersionSelect(
      toSelect,
      meta,
      /*defaultVersion=*/ meta.latestVersion,
    );
    enableCompareButton();

    cancelDiffButton.hidden = !state.comparing;
  }

  function enableCompareButton(): void {
    const from = parseSelectedVersion(fromSelect);
    const to = parseSelectedVersion(toSelect);
    compareButton.disabled = from === null || to === null || from === to;
  }

  function rebuildVersionSelect(
    select: HTMLSelectElement,
    meta: FileArtifactMetadata,
    defaultVersion: number,
  ): void {
    // Preserve the user's prior choice across re-renders if the
    // version still exists; otherwise fall back to `defaultVersion`.
    const previous = parseSelectedVersion(select);
    select.innerHTML = "";
    for (let v = 1; v <= meta.latestVersion; v += 1) {
      const opt = doc.createElement("option");
      opt.value = String(v);
      opt.textContent = `v${v}`;
      select.append(opt);
    }
    const desired =
      previous !== null && previous >= 1 && previous <= meta.latestVersion
        ? previous
        : Math.min(Math.max(defaultVersion, 1), meta.latestVersion);
    select.value = String(desired);

    // Refresh the compare button enabled-state on selection change.
    // This handler does NOT call requestDiff — it only re-evaluates
    // whether the explicit "Compare versions" button should be live.
    select.addEventListener("change", enableCompareButton);
  }

  function renderRightPane(state: ArtifactViewerState): void {
    if (state.comparing) {
      contentPane.hidden = true;
      diffPane.hidden = false;
      renderDiff(state.diff);
      return;
    }
    contentPane.hidden = false;
    diffPane.hidden = true;
    renderContent(state.content);
  }

  function renderContent(status: ContentStatus): void {
    contentPane.innerHTML = "";

    switch (status.status) {
      case "idle": {
        const placeholder = doc.createElement("p");
        placeholder.className = "artifact-viewer__content-placeholder";
        placeholder.textContent =
          "Select an artifact from the list to see its contents.";
        contentPane.append(placeholder);
        return;
      }
      case "loading": {
        const loading = doc.createElement("p");
        loading.className = "artifact-viewer__content-loading";
        loading.textContent = "Loading content…";
        contentPane.append(loading);
        return;
      }
      case "error": {
        const error = doc.createElement("p");
        error.className = "artifact-viewer__content-error";
        error.setAttribute("role", "alert");
        error.textContent = `Failed to load content: ${status.message}`;
        contentPane.append(error);
        return;
      }
      case "loaded":
        renderLoadedContent(status.content);
        return;
    }
  }

  function renderLoadedContent(content: FileArtifactContent): void {
    if (looksLikeText(content)) {
      const pre = doc.createElement("pre");
      pre.className = "artifact-viewer__content-text";
      pre.textContent = decodeUtf8(content.bytes);
      contentPane.append(pre);
      return;
    }

    // Binary path: short metadata line + hex-ish summary.
    const summary = doc.createElement("p");
    summary.className = "artifact-viewer__content-binary-summary";
    summary.textContent = `Binary content (${content.bytes.byteLength} bytes)`;

    const hex = doc.createElement("pre");
    hex.className = "artifact-viewer__content-binary-hex";
    hex.textContent = formatHexSummary(content.bytes);

    const placeholder = doc.createElement("p");
    placeholder.className = "artifact-viewer__content-binary-placeholder";
    placeholder.textContent = "binary";

    contentPane.append(summary, hex, placeholder);
  }

  function renderDiff(status: DiffStatus): void {
    diffPane.textContent = "";
    diffPane.removeAttribute("data-state");
    switch (status.status) {
      case "idle":
        // Compare mode is on but no result yet — show a small hint.
        diffPane.textContent = "Pick two versions and press Compare versions.";
        return;
      case "loading":
        diffPane.textContent = `Computing diff between v${status.fromVersion} and v${status.toVersion}…`;
        return;
      case "ready":
        diffPane.textContent = status.diff.patchText;
        return;
      case "error":
        diffPane.dataset["state"] = "error";
        diffPane.textContent = `Failed to compute diff: ${status.message}`;
        return;
    }
  }

  // Initial render and listener wiring.
  render(controller.getState());
  const unsubscribe = controller.subscribe(render);

  return () => {
    unsubscribe();
    root.innerHTML = "";
    root.classList.remove("artifact-viewer");
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEXT_LIKE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "rb",
  "php",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "ini",
  "toml",
  "csv",
  "tsv",
  "log",
]);

function fileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  if (idx < 0 || idx === fileName.length - 1) return "";
  return fileName.slice(idx + 1).toLowerCase();
}

/**
 * Heuristic: treat the bytes as text when either the filename has a
 * known text extension OR the bytes contain no NUL byte and decode
 * cleanly as UTF-8. The Artifact Store does not currently surface
 * `mimeType` on `FileArtifactContent` so we fall back to bytes
 * inspection. This is intentionally conservative: ambiguous binary
 * content shows as "binary" rather than rendering scrambled text.
 */
function looksLikeText(content: FileArtifactContent): boolean {
  const ext = fileExtension(content.fileName);
  if (ext.length > 0 && TEXT_LIKE_EXTENSIONS.has(ext)) return true;

  // No extension hint: scan the buffer. NUL byte → binary.
  // Long buffers cap at 4 KiB to keep the check fast for large files.
  const cap = Math.min(content.bytes.byteLength, 4096);
  for (let i = 0; i < cap; i += 1) {
    if (content.bytes[i] === 0) return false;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      content.bytes.subarray(0, cap),
    );
    return true;
  } catch {
    return false;
  }
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function decodeUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/**
 * Renders the first 64 bytes of a binary blob as `XX XX XX XX` hex
 * groups, eight per line. Truncated previews include a trailing
 * ellipsis so users can tell summary from full content.
 */
function formatHexSummary(bytes: Uint8Array): string {
  const limit = Math.min(bytes.byteLength, 64);
  const groups: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const byte = bytes[i] ?? 0;
    groups.push(byte.toString(16).padStart(2, "0"));
  }
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 8) {
    lines.push(groups.slice(i, i + 8).join(" "));
  }
  if (bytes.byteLength > limit) {
    lines.push("…");
  }
  return lines.join("\n");
}

function parseSelectedVersion(select: HTMLSelectElement): number | null {
  if (select.value.length === 0) return null;
  const parsed = Number.parseInt(select.value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return parsed;
}
