/**
 * Framework-free DOM render for the Agent_Trace panel (task 11.3).
 *
 * Mirrors the imperative style established by
 * `screens/models/mountModelSelection.ts`:
 *   • build elements with `document.createElement`,
 *   • attach listeners,
 *   • re-render on every `controller.subscribe(...)` notification.
 *
 * Layout
 * ------
 *
 *   ┌───────────────── Agent_Trace panel ─────────────────┐
 *   │  [Updating...] [Gap notice] [Connection status]     │
 *   ├──────────────┬──────────────────────────────────────┤
 *   │  Sidebar     │  Main pane                           │
 *   │  ┌────────┐  │  ┌────────────────────────────────┐  │
 *   │  │ Agents │  │  │ thought / tool_call /          │  │
 *   │  │  list  │  │  │ artifact_change / status rows  │  │
 *   │  └────────┘  │  └────────────────────────────────┘  │
 *   └──────────────┴──────────────────────────────────────┘
 *
 *   • Sidebar lists participating agents with status badges. Clicking
 *     an agent filters the main pane (Requirement 11.2). Clicking the
 *     "All agents" row clears the filter.
 *   • Main pane renders records in their `state.visibleRecords` order
 *     (ascending sequence).
 *   • A top banner surfaces "Updating..." when `state.delayed` is
 *     `true` (Requirement 11.6) and a separate banner surfaces server-
 *     reported gaps (`delayed` SSE events). Neither banner blocks any
 *     other UI (Requirement 11.6).
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.6, 11.8.
 */

import type { TraceEvent } from "@ai-agent-orchestrator/validation";

import type { AgentTraceController } from "./agentTraceController.js";
import type {
  AgentTraceState,
  TraceAgentSummary,
  TraceGapNotice,
} from "./types.js";

export interface MountAgentTracePanelOptions {
  readonly root: HTMLElement;
  readonly controller: AgentTraceController;
  /** Optional document override, primarily for jsdom tests. */
  readonly document?: Document;
  /**
   * Renderer for `artifact_change` records. The default emits a plain
   * `[artifactId@version]` label; the desktop / web shells inject
   * their own renderer to wire the artifact viewer (task 10.3).
   */
  readonly renderArtifactLink?: (input: {
    readonly artifactId: string;
    readonly version: number;
  }) => HTMLElement | string;
}

/**
 * Mounts the Agent_Trace panel into `root`. Replaces any existing
 * children and returns a teardown function that detaches the listener
 * and empties `root`.
 *
 * The teardown does NOT call `controller.dispose()` — owners often
 * want to reuse the controller (e.g. switching tabs but keeping the
 * subscription warm). Call `controller.dispose()` explicitly when the
 * subscription should be torn down.
 */
export function mountAgentTracePanel(
  options: MountAgentTracePanelOptions,
): () => void {
  const doc =
    options.document ?? options.root.ownerDocument ?? globalThis.document;
  if (!doc) {
    throw new Error("mountAgentTracePanel: no Document available");
  }

  const root = options.root;
  const controller = options.controller;
  const renderArtifactLink =
    options.renderArtifactLink ??
    ((input) => `[${input.artifactId}@v${String(input.version)}]`);

  root.innerHTML = "";
  root.classList.add("agent-trace");

  // ---------------- top banners ----------------
  const banner = doc.createElement("div");
  banner.className = "agent-trace__banner";

  const delayedIndicator = doc.createElement("p");
  delayedIndicator.className = "agent-trace__delayed";
  delayedIndicator.setAttribute("role", "status");
  delayedIndicator.setAttribute("aria-live", "polite");
  delayedIndicator.hidden = true;
  delayedIndicator.textContent = "Updating…";

  const connectionStatus = doc.createElement("p");
  connectionStatus.className = "agent-trace__connection";
  connectionStatus.setAttribute("aria-live", "polite");

  const gapBanner = doc.createElement("div");
  gapBanner.className = "agent-trace__gap-banner";
  gapBanner.setAttribute("role", "alert");
  gapBanner.hidden = true;

  const gapText = doc.createElement("span");
  gapText.className = "agent-trace__gap-text";
  const gapDismiss = doc.createElement("button");
  gapDismiss.type = "button";
  gapDismiss.className = "agent-trace__gap-dismiss";
  gapDismiss.textContent = "Dismiss";
  gapDismiss.addEventListener("click", () => {
    controller.dismissGapNotices();
  });
  gapBanner.append(gapText, gapDismiss);

  banner.append(delayedIndicator, connectionStatus, gapBanner);

  // ---------------- two-pane layout ----------------
  const panes = doc.createElement("div");
  panes.className = "agent-trace__panes";

  const sidebar = doc.createElement("aside");
  sidebar.className = "agent-trace__sidebar";
  sidebar.setAttribute("aria-label", "Participating agents");

  const sidebarHeading = doc.createElement("h3");
  sidebarHeading.className = "agent-trace__sidebar-heading";
  sidebarHeading.textContent = "Agents";
  sidebar.append(sidebarHeading);

  const sidebarList = doc.createElement("ul");
  sidebarList.className = "agent-trace__agent-list";
  sidebar.append(sidebarList);

  const mainPane = doc.createElement("section");
  mainPane.className = "agent-trace__records";
  mainPane.setAttribute("aria-label", "Trace records");
  mainPane.setAttribute("aria-live", "polite");

  panes.append(sidebar, mainPane);
  root.append(banner, panes);

  // ---------------- render ----------------

  function renderBanner(state: AgentTraceState): void {
    delayedIndicator.hidden = !state.delayed;
    delayedIndicator.textContent = state.delayed ? "Updating…" : "";

    connectionStatus.textContent = describeConnection(state);
    connectionStatus.dataset["status"] = state.connection.kind;

    if (state.gapNotices.length === 0) {
      gapBanner.hidden = true;
      gapText.textContent = "";
    } else {
      gapBanner.hidden = false;
      gapText.textContent = formatGapNotices(state.gapNotices);
    }
  }

  function renderSidebar(state: AgentTraceState): void {
    sidebarList.innerHTML = "";

    // "All agents" row (clears the filter).
    const allRow = doc.createElement("li");
    allRow.className = "agent-trace__agent";
    if (state.selectedAgentId === null) {
      allRow.dataset["selected"] = "true";
    }
    const allButton = doc.createElement("button");
    allButton.type = "button";
    allButton.className = "agent-trace__agent-button";
    allButton.textContent = `All agents (${String(state.records.length)})`;
    allButton.addEventListener("click", () => {
      controller.selectAgent(null);
    });
    allRow.append(allButton);
    sidebarList.append(allRow);

    if (state.agents.length === 0) {
      const empty = doc.createElement("li");
      empty.className = "agent-trace__agent-empty";
      empty.textContent = "No agents yet.";
      sidebarList.append(empty);
      return;
    }

    for (const summary of state.agents) {
      sidebarList.append(renderAgentRow(doc, summary, state, controller));
    }
  }

  function renderRecords(state: AgentTraceState): void {
    mainPane.innerHTML = "";
    if (state.visibleRecords.length === 0) {
      const empty = doc.createElement("p");
      empty.className = "agent-trace__records-empty";
      empty.textContent =
        state.selectedAgentId === null
          ? "No trace records yet."
          : `No records for agent "${state.selectedAgentId}".`;
      mainPane.append(empty);
      return;
    }

    const list = doc.createElement("ol");
    list.className = "agent-trace__record-list";
    for (const ev of state.visibleRecords) {
      list.append(renderRecordRow(doc, ev, renderArtifactLink));
    }
    mainPane.append(list);
  }

  function render(state: AgentTraceState): void {
    renderBanner(state);
    renderSidebar(state);
    renderRecords(state);
  }

  render(controller.getState());
  const unsubscribe = controller.subscribe(render);

  return () => {
    unsubscribe();
    gapDismiss.replaceWith(gapDismiss.cloneNode(true));
    root.innerHTML = "";
    root.classList.remove("agent-trace");
  };
}

// ----------------------------------------------------------------
// Row renderers
// ----------------------------------------------------------------

function renderAgentRow(
  doc: Document,
  summary: TraceAgentSummary,
  state: AgentTraceState,
  controller: AgentTraceController,
): HTMLElement {
  const row = doc.createElement("li");
  row.className = "agent-trace__agent";
  row.dataset["agentId"] = summary.agentId;
  row.dataset["status"] = summary.status;
  if (state.selectedAgentId === summary.agentId) {
    row.dataset["selected"] = "true";
  }

  const button = doc.createElement("button");
  button.type = "button";
  button.className = "agent-trace__agent-button";

  const name = doc.createElement("span");
  name.className = "agent-trace__agent-name";
  name.textContent = summary.agentId;

  const badge = doc.createElement("span");
  badge.className = "agent-trace__agent-badge";
  badge.dataset["status"] = summary.status;
  badge.textContent = badgeLabel(summary.status);

  button.append(name, badge);
  button.addEventListener("click", () => {
    controller.selectAgent(summary.agentId);
  });
  row.append(button);
  return row;
}

function renderRecordRow(
  doc: Document,
  event: TraceEvent,
  renderArtifactLink: NonNullable<
    MountAgentTracePanelOptions["renderArtifactLink"]
  >,
): HTMLElement {
  const item = doc.createElement("li");
  item.className = "agent-trace__record";
  item.dataset["sequence"] = String(event.sequence);
  item.dataset["agentId"] = event.agentId;
  item.dataset["kind"] = event.record.kind;

  const head = doc.createElement("header");
  head.className = "agent-trace__record-head";

  const seq = doc.createElement("span");
  seq.className = "agent-trace__record-seq";
  seq.textContent = `#${String(event.sequence)}`;

  const agent = doc.createElement("span");
  agent.className = "agent-trace__record-agent";
  agent.textContent = event.agentId;

  const kind = doc.createElement("span");
  kind.className = "agent-trace__record-kind";
  kind.textContent = event.record.kind;

  head.append(seq, agent, kind);
  item.append(head);

  const body = doc.createElement("div");
  body.className = "agent-trace__record-body";

  switch (event.record.kind) {
    case "thought": {
      const text = doc.createElement("p");
      text.className = "agent-trace__thought";
      text.textContent = event.record.text;
      body.append(text);
      break;
    }
    case "tool_call": {
      const tool = doc.createElement("p");
      tool.className = "agent-trace__tool-call";
      const inputSummary = summarizeUnknown(event.record.input);
      const outputSummary = summarizeUnknown(event.record.output);
      tool.textContent =
        `tool=${event.record.tool}; input=${inputSummary}; ` +
        `output=${outputSummary}`;
      body.append(tool);
      break;
    }
    case "artifact_change": {
      const wrap = doc.createElement("p");
      wrap.className = "agent-trace__artifact-change";
      const link = renderArtifactLink({
        artifactId: event.record.artifactId,
        version: event.record.version,
      });
      if (typeof link === "string") {
        wrap.textContent = link;
      } else {
        wrap.append(link);
      }
      body.append(wrap);
      break;
    }
    case "status": {
      const lifecycle = doc.createElement("p");
      lifecycle.className = "agent-trace__lifecycle";
      lifecycle.dataset["status"] = event.record.status;
      lifecycle.textContent = `agent ${event.record.status}`;
      body.append(lifecycle);
      break;
    }
  }

  item.append(body);
  return item;
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function badgeLabel(status: TraceAgentSummary["status"]): string {
  switch (status) {
    case "pending":
      return "pending";
    case "started":
      return "running";
    case "finished":
      return "done";
    case "error":
      return "error";
  }
}

function describeConnection(state: AgentTraceState): string {
  switch (state.connection.kind) {
    case "idle":
      return "Not connected.";
    case "loading-history":
      return "Loading history…";
    case "live":
      return state.historyEnded ? "Live." : "Streaming.";
    case "closed":
      return "Stream closed.";
    case "error":
      return `Stream error: ${state.connection.reason}`;
  }
}

function formatGapNotices(notices: readonly TraceGapNotice[]): string {
  const total = notices.reduce((acc, n) => acc + n.droppedCount, 0);
  return notices.length === 1
    ? `Server reported a gap: ${String(total)} event(s) dropped.`
    : `Server reported ${String(notices.length)} gaps: ` +
      `${String(total)} event(s) dropped in total.`;
}

/**
 * One-line summary of a structured tool input/output payload.
 * `JSON.stringify` is used with a length cap so a noisy tool can't
 * blow up the DOM; the desktop / web shell can swap in a richer view
 * later by intercepting at the renderer level.
 */
function summarizeUnknown(value: unknown): string {
  if (value === undefined) return "(none)";
  if (value === null) return "null";
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return "(unserializable)";
  }
  if (json === undefined) return "(none)";
  const max = 120;
  return json.length > max ? `${json.slice(0, max - 1)}…` : json;
}
