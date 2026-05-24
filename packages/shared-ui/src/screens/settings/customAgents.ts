/**
 * Custom Agents editor — controller and DOM mount helper (task 6.4).
 *
 * Sources:
 *   • design.md → "Settings Store" → `upsertCustomAgent`,
 *     `removeCustomAgent`, `listAgents`.
 *   • design.md → "Data Models" → "Agent" (Custom_Agent / Custom_AgentInput).
 *   • requirements.md → 12.1, 12.2, 12.3, 12.4.
 *   • tasks.md task 6.4 sub-bullets:
 *     "Custom agents editor with name conflict feedback."
 *
 * Design notes
 * ------------
 *   1. Backend access via narrow {@link CustomAgentsGateway} port. Tests
 *      pass plain object stubs. The renderer wires a concrete adapter that
 *      forwards to `CustomAgentService` (`apps/backend/src/settings/
 *      customAgents.ts`).
 *   2. Conflict-feedback discrimination per Requirement 12.3:
 *        • `conflictWith === "builtin"` — the proposed name collides with
 *          one of the five Builtin_Agent names (researcher, coder, reviewer,
 *          fixer, boss). The UI surfaces a "reserved name" message.
 *        • `conflictWith === "custom"`  — the name collides with another
 *          Custom_Agent in the same scope. The UI surfaces a "name already
 *          in use" message and prompts the user to pick a different name.
 *      Detection uses a structural type guard
 *      ({@link isCustomAgentNameConflict}) so the controller works whether
 *      the backend throws the original class instance or an over-the-wire
 *      reconstruction.
 *   3. Client-side `systemPrompt` non-emptiness (Requirement 12.2): the
 *      controller short-circuits a submit with an empty / whitespace-only
 *      prompt before issuing the network call, surfacing
 *      `{ status: "validation_failed", reason: "empty_system_prompt" }`.
 *      Server-side validation still runs as defence-in-depth.
 *   4. Mount helper renders a vanilla DOM editor: a list of existing
 *      custom agents and a single create/update form. Matches the
 *      framework-free style established in
 *      `apps/desktop-windows/src/ui/bootstrap.ts`.
 */

import type {
  CustomAgentInputShape,
  CustomAgentShape,
  Scope,
  ToolId,
} from "../../ports/settings.js";
import { isCustomAgentNameConflict } from "../../ports/settings.js";

// ---------------------------------------------------------------------------
// Ports (gateway)
// ---------------------------------------------------------------------------

/**
 * Narrow gateway port covering the Custom_Agent CRUD methods of the
 * backend `SettingsStore`.
 *
 * `upsertCustomAgent` MUST throw an object satisfying
 * {@link import("../../ports/settings.js").CustomAgentNameConflict} on a
 * name collision. The controller uses the structural guard to render
 * specific feedback for builtin- vs. custom-name conflicts.
 */
export interface CustomAgentsGateway {
  listCustomAgents(scope: Scope): Promise<readonly CustomAgentShape[]>;
  upsertCustomAgent(
    scope: Scope,
    input: CustomAgentInputShape,
  ): Promise<CustomAgentShape>;
  removeCustomAgent(scope: Scope, agentId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// State and actions
// ---------------------------------------------------------------------------

export type ListStatus =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly entries: readonly CustomAgentShape[] }
  | { readonly status: "error"; readonly message: string };

/**
 * Reasons a save can fail before/after the network call.
 *
 *   • `empty_system_prompt`  — client-side guard (Requirement 12.2).
 *   • `empty_name`           — client-side guard (Requirement 12.1).
 *   • `name_conflict_builtin`— server-side (Requirement 12.3, builtin).
 *   • `name_conflict_custom` — server-side (Requirement 12.3, custom).
 *   • `transport`            — network/RPC failure.
 */
export type SaveFailureReason =
  | "empty_system_prompt"
  | "empty_name"
  | "name_conflict_builtin"
  | "name_conflict_custom"
  | "transport";

export type SaveStatus =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "success"; readonly agent: CustomAgentShape }
  | {
      readonly status: "failed";
      readonly reason: SaveFailureReason;
      readonly message: string;
    };

export type DeleteStatus =
  | { readonly status: "idle" }
  | { readonly status: "deleting"; readonly agentId: string }
  | { readonly status: "success"; readonly agentId: string }
  | { readonly status: "error"; readonly message: string };

export interface CustomAgentsState {
  readonly scope: Scope;
  readonly list: ListStatus;
  readonly save: SaveStatus;
  readonly delete: DeleteStatus;
}

export type CustomAgentsListener = (state: CustomAgentsState) => void;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface CustomAgentsControllerOptions {
  readonly scope: Scope;
  readonly gateway: CustomAgentsGateway;
}

export interface CustomAgentsController {
  getState(): CustomAgentsState;
  subscribe(listener: CustomAgentsListener): () => void;
  refresh(): Promise<void>;
  saveCustomAgent(input: CustomAgentInputShape): Promise<SaveStatus>;
  deleteCustomAgent(agentId: string): Promise<DeleteStatus>;
}

export function createCustomAgentsController(
  options: CustomAgentsControllerOptions,
): CustomAgentsController {
  const { scope, gateway } = options;

  let state: CustomAgentsState = {
    scope,
    list: { status: "idle" },
    save: { status: "idle" },
    delete: { status: "idle" },
  };
  const listeners = new Set<CustomAgentsListener>();

  function setState(patch: Partial<CustomAgentsState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
  }

  async function refresh(): Promise<void> {
    setState({ list: { status: "loading" } });
    try {
      const entries = await gateway.listCustomAgents(scope);
      setState({ list: { status: "loaded", entries } });
    } catch (err) {
      setState({
        list: { status: "error", message: describeError(err) },
      });
    }
  }

  async function saveCustomAgent(
    input: CustomAgentInputShape,
  ): Promise<SaveStatus> {
    // (Requirement 12.1) Client-side guard for empty name.
    if (input.name.trim().length === 0) {
      const status: SaveStatus = {
        status: "failed",
        reason: "empty_name",
        message: "Agent name must not be empty.",
      };
      setState({ save: status });
      return status;
    }
    // (Requirement 12.2) Client-side guard for empty system prompt.
    if (input.systemPrompt.trim().length === 0) {
      const status: SaveStatus = {
        status: "failed",
        reason: "empty_system_prompt",
        message: "System prompt must not be empty.",
      };
      setState({ save: status });
      return status;
    }

    setState({ save: { status: "saving" } });

    let agent: CustomAgentShape;
    try {
      agent = await gateway.upsertCustomAgent(scope, input);
    } catch (err) {
      // (Requirement 12.3) Distinguish builtin- vs. custom-name conflicts
      // so the UI can render a more specific message.
      if (isCustomAgentNameConflict(err)) {
        const reason: SaveFailureReason =
          err.conflictWith === "builtin"
            ? "name_conflict_builtin"
            : "name_conflict_custom";
        const message =
          err.conflictWith === "builtin"
            ? `"${input.name}" is reserved by a built-in agent. Choose a different name.`
            : `"${input.name}" is already used by another custom agent in this scope.`;
        const status: SaveStatus = { status: "failed", reason, message };
        setState({ save: status });
        return status;
      }
      const status: SaveStatus = {
        status: "failed",
        reason: "transport",
        message: describeError(err),
      };
      setState({ save: status });
      return status;
    }

    const status: SaveStatus = { status: "success", agent };
    setState({ save: status });
    await refresh();
    return status;
  }

  async function deleteCustomAgent(agentId: string): Promise<DeleteStatus> {
    setState({ delete: { status: "deleting", agentId } });
    try {
      await gateway.removeCustomAgent(scope, agentId);
    } catch (err) {
      const status: DeleteStatus = {
        status: "error",
        message: describeError(err),
      };
      setState({ delete: status });
      return status;
    }
    const status: DeleteStatus = { status: "success", agentId };
    setState({ delete: status });
    await refresh();
    return status;
  }

  return {
    getState: () => state,
    subscribe(listener: CustomAgentsListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    saveCustomAgent,
    deleteCustomAgent,
  };
}

// ---------------------------------------------------------------------------
// DOM mount helper
// ---------------------------------------------------------------------------

const ALL_TOOLS: readonly ToolId[] = [
  "web_search",
  "file_read",
  "file_write",
  "artifact_diff",
];

export interface MountCustomAgentsScreenOptions {
  readonly root: HTMLElement;
  readonly controller: CustomAgentsController;
  /** Optional document override, primarily for jsdom tests. */
  readonly document?: Document;
}

export function mountCustomAgentsScreen(
  options: MountCustomAgentsScreenOptions,
): () => void {
  const doc =
    options.document ?? options.root.ownerDocument ?? globalThis.document;
  if (!doc) {
    throw new Error("mountCustomAgentsScreen: no Document available");
  }

  const root = options.root;
  root.innerHTML = "";

  const heading = doc.createElement("h2");
  heading.textContent = "Custom agents";
  heading.className = "custom-agents-heading";

  const listRegion = doc.createElement("section");
  listRegion.className = "custom-agents-list";
  listRegion.setAttribute("aria-live", "polite");

  const deleteStatus = doc.createElement("p");
  deleteStatus.className = "custom-agents-delete-status";
  deleteStatus.setAttribute("aria-live", "polite");

  const form = doc.createElement("form");
  form.className = "custom-agents-form";
  form.setAttribute("novalidate", "novalidate");

  const nameLabel = doc.createElement("label");
  nameLabel.textContent = "Name";
  const nameInput = doc.createElement("input");
  nameInput.type = "text";
  nameInput.name = "name";
  nameInput.required = true;
  nameLabel.append(nameInput);

  const promptLabel = doc.createElement("label");
  promptLabel.textContent = "System prompt";
  const promptInput = doc.createElement("textarea");
  promptInput.name = "systemPrompt";
  promptInput.required = true;
  promptInput.rows = 5;
  promptLabel.append(promptInput);

  const toolsFieldset = doc.createElement("fieldset");
  toolsFieldset.className = "custom-agents-form-tools";
  const toolsLegend = doc.createElement("legend");
  toolsLegend.textContent = "Allowed tools";
  toolsFieldset.append(toolsLegend);
  const toolCheckboxes = new Map<ToolId, HTMLInputElement>();
  for (const tool of ALL_TOOLS) {
    const toolLabel = doc.createElement("label");
    const checkbox = doc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "allowedTools";
    checkbox.value = tool;
    toolLabel.append(checkbox, doc.createTextNode(` ${tool}`));
    toolsFieldset.append(toolLabel);
    toolCheckboxes.set(tool, checkbox);
  }

  const submitButton = doc.createElement("button");
  submitButton.type = "submit";
  submitButton.textContent = "Save agent";

  const formStatus = doc.createElement("p");
  formStatus.className = "custom-agents-form-status";
  formStatus.setAttribute("aria-live", "polite");

  form.append(nameLabel, promptLabel, toolsFieldset, submitButton, formStatus);

  root.append(heading, listRegion, deleteStatus, form);

  function renderList(state: CustomAgentsState): void {
    listRegion.innerHTML = "";
    const list = state.list;
    if (list.status === "idle") {
      listRegion.textContent = "No agents loaded yet.";
      return;
    }
    if (list.status === "loading") {
      listRegion.textContent = "Loading custom agents…";
      return;
    }
    if (list.status === "error") {
      listRegion.textContent = `Failed to load custom agents: ${list.message}`;
      return;
    }
    if (list.entries.length === 0) {
      listRegion.textContent = "No custom agents yet.";
      return;
    }
    const ul = doc.createElement("ul");
    ul.className = "custom-agents-entries";
    for (const entry of list.entries) {
      const li = doc.createElement("li");
      li.className = "custom-agents-entry";
      li.setAttribute("data-agent-id", entry.id);

      const name = doc.createElement("span");
      name.className = "custom-agents-entry-name";
      name.textContent = entry.name;

      const tools = doc.createElement("span");
      tools.className = "custom-agents-entry-tools";
      tools.textContent =
        entry.allowedTools.length === 0
          ? "(no tools)"
          : entry.allowedTools.join(", ");

      const deleteButton = doc.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "custom-agents-entry-delete";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", () => {
        void options.controller.deleteCustomAgent(entry.id);
      });

      li.append(name, tools, deleteButton);
      ul.append(li);
    }
    listRegion.append(ul);
  }

  function renderForm(state: CustomAgentsState): void {
    const save = state.save;
    switch (save.status) {
      case "idle":
        formStatus.textContent = "";
        submitButton.disabled = false;
        break;
      case "saving":
        formStatus.textContent = "Saving agent…";
        submitButton.disabled = true;
        break;
      case "success":
        formStatus.textContent = `Saved agent "${save.agent.name}".`;
        submitButton.disabled = false;
        nameInput.value = "";
        promptInput.value = "";
        for (const checkbox of toolCheckboxes.values()) {
          checkbox.checked = false;
        }
        break;
      case "failed":
        formStatus.textContent = save.message;
        submitButton.disabled = false;
        break;
    }
  }

  function renderDelete(state: CustomAgentsState): void {
    const del = state.delete;
    switch (del.status) {
      case "idle":
        deleteStatus.textContent = "";
        break;
      case "deleting":
        deleteStatus.textContent = `Deleting ${del.agentId}…`;
        break;
      case "success":
        deleteStatus.textContent = `Removed ${del.agentId}.`;
        break;
      case "error":
        deleteStatus.textContent = `Delete failed: ${del.message}`;
        break;
    }
  }

  function render(state: CustomAgentsState): void {
    renderList(state);
    renderForm(state);
    renderDelete(state);
  }

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    const allowedTools: ToolId[] = [];
    for (const [tool, checkbox] of toolCheckboxes) {
      if (checkbox.checked) allowedTools.push(tool);
    }
    void options.controller.saveCustomAgent({
      name: nameInput.value,
      systemPrompt: promptInput.value,
      allowedTools,
    });
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
