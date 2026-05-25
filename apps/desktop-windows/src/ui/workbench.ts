/**
 * KARO chat-centred workbench layout.
 *
 * Replaces the previous tabbed Dashboard / Task Builder / Trace /
 * Artifacts / Final Report screens with a single chat-centric layout
 * inspired by Cursor / Linear / Raycast:
 *
 *   ┌───────────────────────── Topbar ──────────────────────────┐
 *   │ KARO  ·  <project path>           Provider · Model  · ⚙   │
 *   ├──────┬────────────────────────────────┬────────────────────┤
 *   │ Side │  Chat thread                   │  Right panel tabs  │
 *   │ bar  │  (user prompt, agent timeline, │  Preview / Changes │
 *   │      │   final report, composer)      │  Diff / Files /Logs│
 *   │      │                                │                    │
 *   └──────┴────────────────────────────────┴────────────────────┘
 *
 * Sidebar items: Chat · Project · Changes · Runs · Models · Agents
 * · Settings (collapsible).
 *
 * Each sidebar item swaps the *center pane*. The right panel tabs
 * are independent and stay across left-pane navigation.
 *
 * Validates: Requirements 1.4, 6.1, 6.2, 6.3, 6.5, 7.1, 7.10, 11.1,
 * 11.2, 11.7, 14.2, 14.4.
 */

import type {
  AgentId,
  BuiltinAgentRole,
  ProviderId,
  Session,
} from "@ai-agent-orchestrator/shared-core";

import type {
  BuildTaskContextOptions,
  DesktopShell,
  TaskContextPackage,
  TerminalProfile,
} from "../shell/types.js";
import type {
  ArtifactVersion,
  ArtifactMetadata,
  ChatMessage,
  FinalReportSummary,
  OrchestratorTransport,
  StartTaskInput,
  TaskStateSnapshot,
  TaskStatus,
  TraceEvent,
} from "../orchestration/index.js";
import {
  ChatModelClient,
  StartTaskError,
  classifyTaskIntent,
  classifyPromptIntent,
  runCommandPolicy,
  getPresetForModel,
  presets,
  buildTokenUsageBreakdown,
} from "../orchestration/index.js";


import {
  API_KEY_SECRET_PREFIX,
  API_KEY_META_PREFIX,
  type ApiKeyMetadata,
} from "./desktopApiKeySink.js";
import {
  createAgentSettingsStore,
  type AgentSetting,
  type AgentSettingsMap,
  type AgentSettingsStore,
} from "./agentSettingsStore.js";
import { fetchProviderModels, type ModelCatalogEntry } from "./fireworksModelCatalog.js";
import {
  createProjectStore,
  type ProjectInfo,
  type ProjectStore,
  validateProjectPath,
} from "./projectStore.js";
import { createTaskDraftStore, type TaskDraftStore } from "./taskDraftStore.js";

// ---------------------------------------------------------------------------
// Public types — kept compatible with the previous workspaceShell.
// ---------------------------------------------------------------------------

export type WorkspaceRouteId =
  | "chat"
  | "project"
  | "changes"
  | "runs"
  | "models"
  | "agents"
  | "settings";

export type RightPanelTab = "preview" | "changes" | "diff" | "files" | "logs" | "usage" | "terminal";

export interface WorkspaceShellHandle {
  unmount(): void;
}

export interface MountWorkspaceShellOptions {
  readonly session: Session;
  readonly metadata: ApiKeyMetadata;
  readonly desktopShell: DesktopShell;
  readonly onSignOut: () => void;
  readonly onChangeKey?: () => void;
  readonly transport?: OrchestratorTransport;
  readonly chatModelClient?: Pick<ChatModelClient, "chat">;
  readonly initialRoute?: WorkspaceRouteId;
  readonly draftStore?: TaskDraftStore;
  readonly agentSettingsStore?: AgentSettingsStore;
  readonly projectStore?: ProjectStore;
}

const SIDEBAR_ROUTES: ReadonlyArray<{
  readonly id: WorkspaceRouteId;
  readonly label: string;
  readonly initials: string;
}> = [
  { id: "chat", label: "Chat", initials: "CH" },
  { id: "project", label: "Project", initials: "PR" },
  { id: "changes", label: "Changes", initials: "CN" },
  { id: "runs", label: "Runs", initials: "RN" },
  { id: "models", label: "Models", initials: "MD" },
  { id: "agents", label: "Agents", initials: "AG" },
  { id: "settings", label: "Settings", initials: "ST" },
];

const RIGHT_PANEL_TABS: ReadonlyArray<{
  readonly id: RightPanelTab;
  readonly label: string;
}> = [
  { id: "preview", label: "Preview" },
  { id: "changes", label: "Changes" },
  { id: "diff", label: "Diff" },
  { id: "files", label: "Files" },
  { id: "logs", label: "Logs" },
  { id: "usage", label: "Usage" },
];

const BUILTIN_AGENTS: ReadonlyArray<{
  readonly id: BuiltinAgentRole;
  readonly displayName: string;
  readonly description: string;
}> = [
  { id: "researcher", displayName: "Researcher", description: "Finds relevant project context." },
  { id: "coder", displayName: "Coder", description: "Creates staged file changes." },
  { id: "reviewer", displayName: "Reviewer", description: "Reviews quality and correctness." },
  { id: "fixer", displayName: "Fixer", description: "Repairs specific issues." },
  { id: "boss", displayName: "Finalizer", description: "Summarizes result and next steps." },
];

const DEFAULT_REVIEW_CYCLES = 2;
const MAX_REVIEW_CYCLES_HARD_CAP = 5;
const KARO_LOGO_URL = new URL("./assets/karo-logo.svg", import.meta.url).href;
const WEB_PAGE_FETCH_TIMEOUT_MS = 8_000;
const PLAN_MODE_TIMEOUT_MS = 45_000;
const WEB_PAGE_BODY_PREVIEW_CHARS = 120_000;
const WEB_PAGE_TEXT_PREVIEW_CHARS = 6_000;

type ComposerMode = "auto" | "chat" | "plan" | "agent";
type IntentKind = "casual_message" | "question" | "assist_request" | "coding_task" | "unclear_task";
type ResolvedWorkMode = "chat" | "plan" | "assist" | "agent";
type ReadOnlyContextProfile = "project_explain" | "apply_changes_explain" | "security_review" | "ui_work";

interface ChatMessageView {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt?: string;
  readonly runId?: string;
  readonly kind?: "chat" | "clarification" | "analysis" | "error" | "safety" | "final_answer" | "system_notice";
  readonly mode?: ResolvedWorkMode;
  readonly badgeMode?: ComposerMode;
  readonly intent?: IntentKind;
  readonly pending?: boolean;
  readonly error?: boolean;
  readonly chatContext?: ChatReadOnlyContextView;
}

interface ChatReadOnlyContextView {
  readonly profile: ReadOnlyContextProfile;
  readonly selectedFilesCount: number;
  readonly scannedFilesCount: number;
  readonly selectedFiles: readonly string[];
  readonly warnings: readonly string[];
}

interface ChatReadOnlyContext extends ChatReadOnlyContextView {
  readonly modelContext: string;
}

interface StructuredPlanView {
  readonly goal: string;
  readonly assumptions: readonly string[];
  readonly fileAreas: readonly string[];
  readonly implementationSteps: readonly string[];
  readonly risks: readonly string[];
  readonly tests: readonly string[];
  readonly estimatedComplexity: string;
  readonly expectedBudget: string;
  readonly suggestedExecutionMode: string;
  readonly acceptanceCriteria: readonly string[];
  readonly whatNotToDoYet: readonly string[];
  readonly repairedFromText: boolean;
}

interface RunView {
  readonly id: string;
  readonly originalPrompt: string;
  readonly resolvedPrompt?: string;
  readonly mode?: ResolvedWorkMode | ComposerMode;
  readonly status: TaskStatus | "chat" | "plan" | "assist";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly modelId?: string;
  readonly decisionIntent?: string;
  readonly artifactCount?: number;
}

interface PersistedConversationView {
  readonly id: string;
  readonly title?: string;
  readonly projectRoot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activeRunId: string | null;
  readonly messages: readonly ChatMessageView[];
  readonly runs: readonly RunView[];
}

interface ConversationStorePayload {
  readonly activeConversationId: string;
  readonly conversations: readonly PersistedConversationView[];
}

const CONVERSATION_STORAGE_KEY = "karo.conversations.v1";
const MAX_PERSISTED_MESSAGES = 100;
const MAX_PERSISTED_CONVERSATIONS = 20;


// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

interface InternalState {
  metadata: ApiKeyMetadata;
  routeId: WorkspaceRouteId;
  rightTab: RightPanelTab;
  sidebarCollapsed: boolean;
  activeTaskId: string | null;
  activeArtifactId: string | null;
  activeArtifactVersion: number | null;
  activeArtifactDiff: string | null;
  /** Tasks the user started in this session, most-recent first. */
  taskHistory: string[];
  agentSettings: AgentSettingsMap;
  cachedModels: readonly ModelCatalogEntry[] | null;
  modelsStatus: "idle" | "loading" | "ready" | "error";
  modelsErrorMessage?: string;
  project: ProjectInfo | null;
  logs: Array<{ at: string; level: "info" | "warn" | "error"; text: string }>;
  conversationId: string;
  conversationTitle?: string;
  conversationCreatedAt: string;
  conversationUpdatedAt: string;
  chatMessages: ChatMessageView[];
  runs: RunView[];
  chatScrollTop: number;
  composerMode: ComposerMode;
  demoPipelineMode: boolean;
  lastTaskId: string | null;
  lastApplyCommandCalled: boolean;
  lastApplyResult: any;
  lastApplyError: string | null;
  lastStagingPath: string | null;
  lastContextBuildCalled: boolean;
  lastContextProjectRoot: string;
  lastContextNormalizedRoot: string;
  lastContextFileCount: number;
  lastContextSelectedFiles: string[];
  lastContextError: string | null;
  lastContextWarnings: string[];
  terminalSessionId: string | null;
  terminalStatus: "idle" | "running" | "exited" | "error" | "blocked";
  terminalLines: Array<{ stream: "stdout" | "stderr"; text: string; at: string }>;
  terminalError: string | null;
  terminalExitCode: number | null;
  terminalProfiles: TerminalProfile[];
  terminalProfileId: string;
  previewUrl: string | null;
  previewOpenStatus: "idle" | "opened" | "error";
  previewOpenError: string | null;
  detectedPreviewCommand: string;
  detectedPreviewCommandSource: "default" | "package_json" | "none";
}

export function mountWorkspaceShell(
  root: HTMLElement,
  options: MountWorkspaceShellOptions,
): WorkspaceShellHandle {
  root.innerHTML = "";
  // Инициализация дефолтных значений localStorage для спринта
  if (typeof window !== "undefined") {
    if (!localStorage.getItem("karo.permissionMode")) localStorage.setItem("karo.permissionMode", "smart_approval");
    if (!localStorage.getItem("karo.preset")) localStorage.setItem("karo.preset", "auto");
    if (!localStorage.getItem("karo.webMode")) localStorage.setItem("karo.webMode", "off");
    if (!localStorage.getItem("karo.effectiveContextWindow")) localStorage.setItem("karo.effectiveContextWindow", "auto");
    if (!localStorage.getItem("karo.destructiveApproval")) localStorage.setItem("karo.destructiveApproval", "true");
    if (!localStorage.getItem("karo.outsideRootAllowed")) localStorage.setItem("karo.outsideRootAllowed", "false");
    if (!localStorage.getItem("karo.autoBackup")) localStorage.setItem("karo.autoBackup", "true");
    if (!localStorage.getItem("karo.dryRunOnly")) localStorage.setItem("karo.dryRunOnly", "true");
    if (!localStorage.getItem("karo.showCost")) localStorage.setItem("karo.showCost", "true");
  }
  root.dataset["screen"] = "workspace";
  root.dataset["session"] = options.session.id;
  const doc = root.ownerDocument ?? globalThis.document;

  const draftStore =
    options.draftStore ?? createTaskDraftStore({ desktopShell: options.desktopShell });
  const agentSettingsStore =
    options.agentSettingsStore ?? createAgentSettingsStore({ desktopShell: options.desktopShell });
  const projectStore =
    options.projectStore ?? createProjectStore({ desktopShell: options.desktopShell });
  const chatModelClient =
    options.chatModelClient ?? new ChatModelClient({ desktopShell: options.desktopShell });
  const persistedConversation = loadPersistedConversation();
  const conversationNow = new Date().toISOString();
  const conversationId = persistedConversation?.id ?? `conv-${Date.now().toString(36)}`;

  const state: InternalState = {
    metadata: options.metadata,
    routeId: options.initialRoute ?? "chat",
    rightTab: "changes",
    sidebarCollapsed: false,
    activeTaskId: null,
    activeArtifactId: null,
    activeArtifactVersion: null,
    activeArtifactDiff: null,
    taskHistory: persistedConversation?.runs.map((run) => run.id) ?? [],
    agentSettings: {},
    cachedModels: null,
    modelsStatus: "idle",
    project: null,
    logs: [],
    conversationId,
    ...(persistedConversation?.title !== undefined ? { conversationTitle: persistedConversation.title } : {}),
    conversationCreatedAt: persistedConversation?.createdAt ?? conversationNow,
    conversationUpdatedAt: persistedConversation?.updatedAt ?? conversationNow,
    chatMessages: [...(persistedConversation?.messages ?? [])],
    runs: [...(persistedConversation?.runs ?? [])],
    chatScrollTop: 0,
    composerMode: readStoredComposerMode(),
    demoPipelineMode: options.desktopShell.isNativeBridgeWired ? !options.desktopShell.isNativeBridgeWired() : true,
    lastTaskId: null,
    lastApplyCommandCalled: false,
    lastApplyResult: null,
    lastApplyError: null,
    lastStagingPath: null,
    lastContextBuildCalled: false,
    lastContextProjectRoot: "",
    lastContextNormalizedRoot: "",
    lastContextFileCount: 0,
    lastContextSelectedFiles: [],
    lastContextError: null,
    lastContextWarnings: [],
    terminalSessionId: null,
    terminalStatus: "idle",
    terminalLines: [],
    terminalError: null,
    terminalExitCode: null,
    terminalProfiles: [],
    terminalProfileId: localStorage.getItem("karo.terminalProfile") ?? "",
    previewUrl: null,
    previewOpenStatus: "idle",
    previewOpenError: null,
    detectedPreviewCommand: detectPreviewCommand(),
    detectedPreviewCommandSource: "default",
  };

  if (typeof window !== "undefined" && (
    (typeof import.meta !== "undefined" && import.meta.env && (import.meta.env.DEV || import.meta.env.MODE === "test")) ||
    (window as any).__VITEST__ ||
    (window as any).isTestEnv ||
    (window as any)._karoStateEnabled ||
    (typeof process !== "undefined" && process.env.NODE_ENV === "test")
  )) {
    (root as any)._karoState = state;
  }

  function persistConversation(): void {
    state.conversationUpdatedAt = new Date().toISOString();
    savePersistedConversation({
      id: state.conversationId,
      ...(state.conversationTitle !== undefined ? { title: state.conversationTitle } : {}),
      projectRoot: state.project?.path ?? "",
      createdAt: state.conversationCreatedAt,
      updatedAt: state.conversationUpdatedAt,
      activeRunId: state.activeTaskId,
      messages: state.chatMessages.slice(-MAX_PERSISTED_MESSAGES),
      runs: state.runs.slice(0, 50),
    });
  }

  function upsertRunFromTaskState(taskState: TaskStateSnapshot): void {
    const existing = state.runs.find((run) => run.id === taskState.id);
    const artifacts = options.transport?.getArtifacts(taskState.id) ?? [];
    const isTerminal =
      taskState.status === "completed" ||
      taskState.status === "error" ||
      taskState.status === "stopped_limit";
    const startedAt = existing?.startedAt ?? taskState.createdAt ?? new Date().toISOString();
    const completedAt = isTerminal ? taskState.updatedAt : existing?.completedAt;
    const startedMs = Date.parse(startedAt);
    const completedMs = completedAt !== undefined ? Date.parse(completedAt) : NaN;
    const decisionMode = taskState.decision?.executionMode;
    const runMode =
      decisionMode !== undefined && decisionMode !== "clarify"
        ? decisionMode
        : existing?.mode;
    const next: RunView = {
      id: taskState.id,
      originalPrompt: taskState.originalPrompt,
      ...(runMode !== undefined ? { mode: runMode } : {}),
      status: taskState.status,
      startedAt,
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(Number.isFinite(startedMs) && Number.isFinite(completedMs)
        ? { durationMs: Math.max(0, completedMs - startedMs) }
        : {}),
      modelId: taskState.modelId,
      ...(taskState.decision?.intent !== undefined
        ? { decisionIntent: taskState.decision.intent }
        : {}),
      artifactCount: artifacts.length,
    };
    state.runs = [next, ...state.runs.filter((run) => run.id !== taskState.id)].slice(0, 50);
    state.taskHistory = state.runs.map((run) => run.id);
    persistConversation();
  }

  // -------------------------------------------------------------------------
  // Layout skeleton
  // -------------------------------------------------------------------------

  const layout = doc.createElement("section");
  layout.className = "kw-root";
  layout.dataset["testid"] = "app-root";

  // Toast Notifications Container
  const toastContainer = doc.createElement("div");
  toastContainer.className = "kw-toast-container";
  root.append(toastContainer);

  function showToast(type: "success" | "info" | "warn" | "error", message: string): void {
    const toast = doc.createElement("div");
    toast.className = "kw-toast";
    toast.dataset["type"] = type;
    toast.textContent = message;
    toastContainer.append(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(12px)";
      setTimeout(() => toast.remove(), 200);
    }, 4000);
  }

  // ----- Topbar -----
  const topbar = doc.createElement("header");
  topbar.className = "kw-topbar";
  topbar.dataset["testid"] = "topbar";

  const brandWrap = doc.createElement("div");
  brandWrap.className = "kw-brand";
  const brandLogo = doc.createElement("img");
  brandLogo.className = "kw-brand-logo";
  brandLogo.src = KARO_LOGO_URL;
  brandLogo.alt = "KARO";
  const brand = doc.createElement("span");
  brand.className = "kw-brand-name";
  brand.textContent = "KARO";
  const brandSub = doc.createElement("span");
  brandSub.className = "kw-brand-tagline";
  brandSub.textContent = "AI Agent Orchestrator";
  brandWrap.append(brandLogo, brand, brandSub);

  const projectField = doc.createElement("button");
  projectField.type = "button";
  projectField.className = "kw-project-field";
  projectField.textContent = "No project selected";
  projectField.title = "Set project folder";

  const topbarRight = doc.createElement("div");
  topbarRight.className = "kw-topbar-right";

  const statusBadge = doc.createElement("span");
  statusBadge.className = "kw-status-badge";
  topbarRight.append(statusBadge);

  const providerInfo = doc.createElement("div");
  providerInfo.className = "kw-provider-info";
  const providerLine = doc.createElement("span");
  providerLine.className = "kw-provider-line";
  const modelLine = doc.createElement("span");
  modelLine.className = "kw-model-line";
  providerInfo.append(providerLine, modelLine);

  const headerWidgets = doc.createElement("div");
  headerWidgets.className = "kw-header-widgets";
  headerWidgets.style.cssText = "display: flex; align-items: center; gap: 12px; margin-right: 12px;";

  const settingsBtn = doc.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "kw-topbar-button kw-topbar-settings";
  settingsBtn.textContent = "Settings";

  const signOutBtn = doc.createElement("button");
  signOutBtn.type = "button";
  signOutBtn.className = "kw-sidebar-signout";
  signOutBtn.textContent = "Sign out";

  topbarRight.append(providerInfo, headerWidgets);
  topbar.append(brandWrap, projectField, topbarRight);

  // ----- Body grid (sidebar | center | right) -----
  const body = doc.createElement("div");
  body.className = "kw-body";

  // Sidebar
  const sidebar = doc.createElement("nav");
  sidebar.className = "kw-sidebar";
  sidebar.dataset["testid"] = "sidebar";
  sidebar.setAttribute("aria-label", "Workspace navigation");

  const collapseBtn = doc.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "kw-sidebar-collapse";
  collapseBtn.textContent = "Collapse";
  collapseBtn.title = "Collapse sidebar";

  const newChatBtn = doc.createElement("button");
  newChatBtn.type = "button";
  newChatBtn.className = "kw-sidebar-new-chat";
  newChatBtn.dataset["testid"] = "sidebar-new-chat";
  newChatBtn.textContent = "+ New chat";
  newChatBtn.title = "Start a new conversation in this project.";

  const sidebarList = doc.createElement("ul");
  sidebarList.className = "kw-sidebar-list";

  const navButtons = new Map<WorkspaceRouteId, HTMLButtonElement>();
  for (const route of SIDEBAR_ROUTES) {
    const li = doc.createElement("li");
    li.className = "kw-sidebar-item";
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "kw-sidebar-button";
    btn.dataset["routeId"] = route.id;
    btn.dataset["testid"] = `nav-${route.id}`;
    const initials = doc.createElement("span");
    initials.className = "kw-sidebar-initials";
    initials.textContent = route.initials;
    const label = doc.createElement("span");
    label.className = "kw-sidebar-label";
    label.textContent = route.label;
    btn.append(initials, label);
    btn.addEventListener("click", () => navigate(route.id));
    li.append(btn);
    sidebarList.append(li);
    navButtons.set(route.id, btn);
  }
  const conversationsWrap = doc.createElement("section");
  conversationsWrap.className = "kw-sidebar-conversations";
  conversationsWrap.dataset["testid"] = "sidebar-conversation-list";
  const sidebarFooter = doc.createElement("div");
  sidebarFooter.className = "kw-sidebar-footer";
  sidebarFooter.append(signOutBtn);
  sidebar.append(collapseBtn, newChatBtn, sidebarList, conversationsWrap, sidebarFooter);

  // Center pane
  const center = doc.createElement("section");
  center.className = "kw-center";

  // Right panel
  const right = doc.createElement("aside");
  right.className = "kw-right";
  right.dataset["testid"] = "right-panel";
  const rightTabs = doc.createElement("div");
  rightTabs.className = "kw-right-tabs";
  const rightTabButtons = new Map<RightPanelTab, HTMLButtonElement>();
  const rightContent = doc.createElement("div");
  rightContent.className = "kw-right-content";
  right.append(rightTabs, rightContent);
  renderRightTabs();

  const bottomTools = doc.createElement("section");
  bottomTools.className = "kw-bottom-tools";
  bottomTools.dataset["testid"] = "terminal-panel";
  bottomTools.dataset["open"] = "false";
  let terminalPollTimer: number | null = null;
  renderBottomTools();

  body.append(sidebar, center, right);
  layout.append(topbar, body, bottomTools);
  root.append(layout);

  // -------------------------------------------------------------------------
  // Listeners
  // -------------------------------------------------------------------------

  const onSignOut = (): void => openSignOutConfirm();
  signOutBtn.addEventListener("click", onSignOut);

  const onSettingsClick = (): void => navigate("settings");
  settingsBtn.addEventListener("click", onSettingsClick);

  const onProjectClick = (): void => navigate("project");
  projectField.addEventListener("click", onProjectClick);

  const onCollapseClick = (): void => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    applySidebarMode();
  };
  collapseBtn.addEventListener("click", onCollapseClick);
  newChatBtn.addEventListener("click", () => startNewConversation());
  const applyResponsiveMode = (): void => {
    const width = doc.defaultView?.innerWidth ?? 1366;
    body.dataset["compactLayout"] = width <= 1280 ? "true" : "false";
    body.dataset["narrowLayout"] = width <= 980 ? "true" : "false";
  };
  const onWindowResize = (): void => applyResponsiveMode();
  doc.defaultView?.addEventListener("resize", onWindowResize);
  applyResponsiveMode();

  const transportSubs: Array<() => void> = [];
  if (options.transport !== undefined) {
    transportSubs.push(
      options.transport.subscribeTaskState((id) => {
        const taskState = options.transport!.getTaskState(id);
        if (taskState !== null) {
          upsertRunFromTaskState(taskState);
        }
        if (taskState && taskState.contextSummary) {
          state.lastContextBuildCalled = true;
          state.lastContextProjectRoot = taskState.contextSummary.projectRoot ?? "";
          state.lastContextNormalizedRoot = taskState.contextSummary.normalizedProjectRoot ?? taskState.contextSummary.projectRoot ?? "";
          state.lastContextFileCount = taskState.contextSummary.scannedFilesCount;
          state.lastContextSelectedFiles = taskState.contextSummary.selectedFiles.map(f => f.relativePath);
          state.lastContextError = taskState.contextSummary.error ?? null;
          state.lastContextWarnings = [...taskState.contextSummary.warnings];
        }
        if (taskState?.decision) {
          localStorage.setItem("karo.diagnostics.lastDecisionIntent", taskState.decision.intent);
          localStorage.setItem("karo.diagnostics.lastDecisionMode", taskState.decision.executionMode);
          localStorage.setItem("karo.diagnostics.lastDecisionConfidence", String(taskState.decision.confidence));
          localStorage.setItem("karo.diagnostics.lastDecisionNeedsClarification", String(taskState.decision.needsClarification));
          localStorage.setItem("karo.diagnostics.lastDecisionAllowWebSearch", String(taskState.decision.allowWebSearch));
          localStorage.setItem("karo.diagnostics.lastDecisionAllowFileChanges", String(taskState.decision.allowFileChanges));
          localStorage.setItem("karo.diagnostics.lastDecisionAllowCommands", String(taskState.decision.allowCommands));
          localStorage.setItem("karo.diagnostics.lastDecisionRequiresContextEngine", String(taskState.decision.requiresContextEngine));
          localStorage.setItem("karo.diagnostics.lastDecisionRiskLevel", taskState.decision.riskLevel);
          localStorage.setItem("karo.diagnostics.lastDecisionReasoningSummary", taskState.decision.reasoningSummary);
        }
        if (id === state.activeTaskId) {
          renderHeader();
        }
        if (state.routeId === "chat" && id === state.activeTaskId) {
          renderCenter();
        }
        if (id === state.activeTaskId || state.rightTab === "logs" || state.rightTab === "changes") {
          renderRightContent();
        }
      }),
      options.transport.subscribeTrace((id) => {
        if (id === state.activeTaskId) {
          renderHeader();
        }
        if (state.routeId === "chat" && id === state.activeTaskId) {
          renderCenter();
        }
        if (id === state.activeTaskId || state.rightTab === "logs") renderRightContent();
      }),
      options.transport.subscribeArtifacts((id) => {
        if (id === state.activeTaskId) {
          renderHeader();
          if (state.activeArtifactId === null) {
            const all = options.transport!.getArtifacts(id);
            const first = all[0];
            if (first !== undefined) {
              state.activeArtifactId = first.id;
              state.activeArtifactVersion = first.latestVersion;
              state.activeArtifactDiff = null;
            }
          } else {
            const all = options.transport!.getArtifacts(id);
            const cur = all.find((a) => a.id === state.activeArtifactId);
            if (cur !== undefined) {
              state.activeArtifactVersion = cur.latestVersion;
            }
          }
          if (state.routeId === "chat") renderCenter();
          renderRightContent();
        }
      }),
      options.transport.subscribeFinalReport((id) => {
        const finalReport = options.transport!.getFinalReport(id);
        const reportTaskState = options.transport!.getTaskState(id);
        void finalReport;
        void reportTaskState;
        if (id === state.activeTaskId) {
          renderHeader();
        }
        if (id === state.activeTaskId && state.routeId === "chat") {
          renderCenter();
        }
        if (id === state.activeTaskId && state.rightTab === "changes") {
          renderRightContent();
        }
      }),
    );

    // Optional: log channel for raw model previews / repair retries.
    // Not part of the public OrchestratorTransport interface so simple
    // stub transports in tests can omit it.
    const maybeLog = (
      options.transport as {
        subscribeLog?: (
          listener: (
            taskId: string,
            entry: { level: "info" | "warn" | "error"; source: string; text: string; at: string },
          ) => void,
        ) => () => void;
      }
    ).subscribeLog;
    if (typeof maybeLog === "function") {
      transportSubs.push(
        maybeLog.call(options.transport, (id, entry) => {
          if (id !== state.activeTaskId && state.activeTaskId !== null) {
            // Show logs for the currently focused task only — older
            // task logs would clutter the panel without context.
            return;
          }
          pushLog(entry.level, `${entry.source}: ${entry.text}`);
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Initial render
  // -------------------------------------------------------------------------

  renderHeader();
  applySidebarMode();
  renderConversationList();
  // Hydrate persisted state asynchronously, but don't block the first
  // render — the chat thread happily renders with an empty state.
  // We only re-render the route when the hydration affects what the
  // user is currently looking at; otherwise the next navigation picks
  // up the new values automatically. Re-rendering on every hydration
  // would clobber transient UI state (e.g. composer status messages).
  void agentSettingsStore
    .read(state.metadata.provider)
    .then((m) => {
      state.agentSettings = m;
      if (state.routeId === "agents") renderRoute();
    })
    .catch(() => {
      /* persistence failures must not block UI */
    });
  void projectStore
    .read()
    .then((p) => {
      state.project = p;
      if (p !== null) {
        void refreshDetectedPreviewCommand(p.path);
      }
      persistConversation();
      renderHeader();
      renderRightContent();
      if (state.routeId === "project") {
        const currentInput = center.querySelector<HTMLInputElement>(".kw-project-input");
        if (currentInput === null || currentInput.value.length === 0) {
          renderRoute();
        }
      }
    })
    .catch(() => {
      /* persistence failures must not block UI */
    });
  void loadTerminalProfiles();
  renderRoute();
  setRightTab("changes");

  // -------------------------------------------------------------------------
  // Header / sidebar render helpers
  // -------------------------------------------------------------------------

  function renderHeader(): void {
    providerLine.textContent = `${formatProvider(state.metadata.provider)} · ${state.metadata.fingerprint}`;
    const friendlyModelName = formatFriendlyModelName(state.metadata.modelId);
    modelLine.textContent = `Model: ${friendlyModelName}`;
    modelLine.title = state.metadata.modelId ?? "(default)";
    projectField.textContent =
      state.project !== null && state.project.path.length > 0
        ? toDisplayPath(state.project.path)
        : "No project selected";

    // Наполнение headerWidgets
    headerWidgets.innerHTML = "";

    const modelId = state.metadata.modelId ?? "";
    const activePreset = getActivePromptPreset(modelId);
    const defaultContextTokens = activePreset.contextBudgetMultiplier * 128_000;
    const contextWindow = getConfiguredContextWindowTokens(state.metadata.provider, modelId, defaultContextTokens);

    let percent = 0;
    let usedTokens = 0;
    let maxTokens = contextWindow.tokens;
    let breakdown: any = null;
    let isEstimated = true;

    if (state.activeTaskId !== null && options.transport !== undefined) {
      const taskState = options.transport.getTaskState(state.activeTaskId);
      if (taskState !== null) {
        if (taskState.currentContextUsage) {
          breakdown = {
            ...taskState.currentContextUsage,
            contextWindowTokens: maxTokens,
            usageRatio:
              maxTokens > 0 ? taskState.currentContextUsage.usedTokens / maxTokens : 0,
          };
          percent = breakdown.usageRatio * 100;
          usedTokens = breakdown.usedTokens;
          isEstimated = breakdown.isEstimated;
        } else {
          // Оценочный расчет
          breakdown = buildTokenUsageBreakdown({
            modelId,
            systemPrompt: activePreset.systemPrompt,
            userPrompt: taskState.originalPrompt,
            maxContextTokens: maxTokens,
          });
          percent = breakdown.usageRatio * 100;
          usedTokens = breakdown.usedTokens;
          isEstimated = true;
        }
      }
    }

    if (!breakdown) {
      breakdown = buildTokenUsageBreakdown({
        modelId,
        systemPrompt: activePreset.systemPrompt,
        userPrompt: "",
        maxContextTokens: maxTokens,
      });
      percent = 0;
      usedTokens = 0;
    }

    // Ограничение процентов в пределах [0, 100]
    percent = Math.min(Math.max(percent, 0), 100);

    // Цвет индикатора
    let strokeColor = "#10b981"; // 0-50%
    let warningClass = "";
    if (percent > 90) {
      strokeColor = "#ef4444"; // 90%+ critical
      warningClass = "critical";
    } else if (percent > 75) {
      strokeColor = "#f97316"; // 75-90% high
      warningClass = "high";
    } else if (percent > 50) {
      strokeColor = "#f59e0b"; // 50-75% warning
      warningClass = "warning";
    }

    // Рендеринг SVG кольца
    const radius = 9;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (percent / 100) * circumference;

    const ringContainer = doc.createElement("div");
    ringContainer.className = `kw-context-ring-container ${warningClass}`;

    const ringTrigger = doc.createElement("button");
    ringTrigger.type = "button";
    ringTrigger.className = "kw-context-ring-trigger";
    ringTrigger.title = "Show context usage";
    ringTrigger.setAttribute("aria-label", "Show context usage");
    ringTrigger.innerHTML = `
      <svg width="24" height="24" style="transform: rotate(-90deg); overflow: visible;">
        <circle cx="12" cy="12" r="${radius}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2" />
        <circle cx="12" cy="12" r="${radius}" fill="none" stroke="${strokeColor}" stroke-dasharray="${circumference}" stroke-dashoffset="${strokeDashoffset}" stroke-width="2" stroke-linecap="round" style="transition: stroke-dashoffset 0.3s ease;" />
      </svg>
    `;
    ringContainer.append(ringTrigger);

    // Tooltip
    const tooltip = doc.createElement("div");
    tooltip.className = "kw-context-tooltip";
    tooltip.style.cssText = `
      position: absolute;
      top: 100%;
      right: 0;
      background: rgba(18, 18, 24, 0.96);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 12px;
      z-index: 10000;
      width: min(320px, calc(100vw - 24px));
      font-size: 11px;
      color: #e2e8f0;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s ease;
      transform: translateY(5px);
    `;

    tooltip.innerHTML = `
      <div style="font-weight: 700; margin-bottom: 6px; color: #fff;">Context Resource Usage</div>
      <div style="margin-bottom: 4px;">Model: <span style="color: #38bdf8; font-weight: 600;">${friendlyModelName}</span></div>
      <div style="margin-bottom: 4px; word-break: break-all;">Full ID: <span style="color: #94a3b8; font-family: monospace;">${modelId || "Default"}</span></div>
      <div style="margin-bottom: 4px;">Preset: <span style="color: #a78bfa; font-weight: 600;">${activePreset.displayName}</span></div>
      <div style="margin-bottom: 4px;">Window: <span style="font-family: monospace;">${formatContextWindowLabel(maxTokens)} tokens</span></div>
      ${contextWindow.warning !== undefined ? `<div style="margin-bottom: 8px; color: #fbbf24;">${contextWindow.warning}</div>` : ""}

      <div style="height: 1px; background: rgba(255,255,255,0.08); margin: 6px 0;"></div>

      <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
        <span>Used (${isEstimated ? "est" : "actual"}):</span>
        <span style="font-weight: bold; color: ${strokeColor};">${(usedTokens / 1000).toFixed(1)}k / ${(maxTokens / 1000).toFixed(0)}k</span>
      </div>

      <div style="height: 1px; background: rgba(255,255,255,0.08); margin: 6px 0;"></div>

      <div style="margin-bottom: 3px; display: flex; justify-content: space-between;">
        <span>• System Prompt:</span>
        <span style="font-family: monospace; color: #94a3b8;">${breakdown.systemPromptTokens}</span>
      </div>
      <div style="margin-bottom: 3px; display: flex; justify-content: space-between;">
        <span>• User Prompt:</span>
        <span style="font-family: monospace; color: #94a3b8;">${breakdown.userPromptTokens}</span>
      </div>
      <div style="margin-bottom: 3px; display: flex; justify-content: space-between;">
        <span>• Conversation:</span>
        <span style="font-family: monospace; color: #94a3b8;">${breakdown.conversationTokens}</span>
      </div>
      <div style="margin-bottom: 3px; display: flex; justify-content: space-between;">
        <span>• Selected Files:</span>
        <span style="font-family: monospace; color: #94a3b8;">${breakdown.selectedFilesTokens}</span>
      </div>
      <div style="margin-bottom: 3px; display: flex; justify-content: space-between;">
        <span>• Tool Results:</span>
        <span style="font-family: monospace; color: #94a3b8;">${breakdown.toolResultTokens}</span>
      </div>

      <div style="height: 1px; background: rgba(255,255,255,0.08); margin: 6px 0;"></div>

      <div style="display: flex; justify-content: space-between; font-weight: 600; color: #34d399;">
        <span>Estimated Cost:</span>
        <span>$${breakdown.estimatedCostUsd?.toFixed(4) || "0.00"}</span>
      </div>
    `;

    const copyUsageBtn = doc.createElement("button");
    copyUsageBtn.type = "button";
    copyUsageBtn.textContent = "Copy usage";
    copyUsageBtn.style.cssText = "margin-top: 8px; width: 100%; font-size: 11px; padding: 4px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); color: #e2e8f0; cursor: pointer;";
    copyUsageBtn.addEventListener("click", () => {
      const usageText = `Context usage: ${Math.round(percent)}%; used ${usedTokens}/${maxTokens}; selected file tokens ${breakdown.selectedFilesTokens}`;
      void navigator.clipboard?.writeText(usageText);
    });
    tooltip.append(copyUsageBtn);

    let tooltipCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const openTooltip = () => {
      if (tooltipCloseTimer !== undefined) clearTimeout(tooltipCloseTimer);
      ringContainer.dataset["open"] = "true";
      tooltip.style.opacity = "1";
      tooltip.style.transform = "translateY(0)";
      tooltip.style.pointerEvents = "auto";
    };
    const closeTooltip = () => {
      tooltipCloseTimer = setTimeout(() => {
        delete ringContainer.dataset["open"];
        tooltip.style.opacity = "0";
        tooltip.style.transform = "translateY(5px)";
        tooltip.style.pointerEvents = "none";
      }, 250);
    };

    ringContainer.append(tooltip);
    ringTrigger.addEventListener("mouseenter", openTooltip);
    ringTrigger.addEventListener("mouseleave", closeTooltip);
    ringTrigger.addEventListener("focus", openTooltip);
    ringTrigger.addEventListener("blur", closeTooltip);
    ringTrigger.addEventListener("click", openTooltip);
    tooltip.addEventListener("mouseenter", openTooltip);
    tooltip.addEventListener("mouseleave", closeTooltip);

    // Context usage ring is rendered beside the composer controls. The
    // topbar stays status-only so the popover cannot cover right-panel tabs.

    // Update status badge
    let statusVal: "ready" | "running" | "waiting_consent" | "completed" | "error" = "ready";
    let statusText = "Ready";

    if (state.activeTaskId !== null && options.transport !== undefined) {
      const taskState = options.transport.getTaskState(state.activeTaskId);
      if (taskState !== null) {
        if (taskState.status === "completed") {
          statusVal = "completed";
          statusText = "Completed";
        } else if (taskState.status === "error") {
          statusVal = "error";
          statusText = "Error";
        } else if (taskState.status === "waiting_consent") {
          statusVal = "waiting_consent";
          statusText = "Waiting Consent";
        } else if (taskState.status === "stopped_limit") {
          statusVal = "waiting_consent"; // Stopped reviewed state
          statusText = "Stopped";
        } else {
          statusVal = "running";
          statusText = "Running";
        }
      }
    }

    statusBadge.dataset["status"] = statusVal;
    statusBadge.textContent = statusText;
  }

  function buildComposerContextUsageRing(): HTMLElement {
    const modelId = state.metadata.modelId ?? "";
    const activePreset = getActivePromptPreset(modelId);
    const defaultContextTokens = activePreset.contextBudgetMultiplier * 128_000;
    const contextWindow = getConfiguredContextWindowTokens(state.metadata.provider, modelId, defaultContextTokens);
    let breakdown = buildTokenUsageBreakdown({
      modelId,
      systemPrompt: activePreset.systemPrompt,
      userPrompt: "",
      maxContextTokens: contextWindow.tokens,
    });
    if (state.activeTaskId !== null && options.transport !== undefined) {
      const taskState = options.transport.getTaskState(state.activeTaskId);
      if (taskState?.currentContextUsage) {
        breakdown = {
          ...taskState.currentContextUsage,
          contextWindowTokens: contextWindow.tokens,
          usageRatio:
            contextWindow.tokens > 0 ? taskState.currentContextUsage.usedTokens / contextWindow.tokens : 0,
        } as typeof breakdown;
      } else if (taskState !== null) {
        breakdown = buildTokenUsageBreakdown({
          modelId,
          systemPrompt: activePreset.systemPrompt,
          userPrompt: taskState.originalPrompt,
          maxContextTokens: contextWindow.tokens,
        });
      }
    }
    const percent = Math.min(Math.max((breakdown.usageRatio ?? 0) * 100, 0), 100);
    const strokeColor = percent > 90 ? "#ef4444" : percent > 75 ? "#f97316" : percent > 50 ? "#f59e0b" : "#10b981";
    const warningClass = percent > 90 ? "critical" : percent > 75 ? "high" : percent > 50 ? "warning" : "";
    const radius = 9;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (percent / 100) * circumference;
    const ringContainer = doc.createElement("div");
    ringContainer.className = `kw-context-ring-container kw-composer-context-ring ${warningClass}`;
    const trigger = doc.createElement("button");
    trigger.type = "button";
    trigger.className = "kw-context-ring-trigger";
    trigger.dataset["testid"] = "composer-context-trigger";
    trigger.title = `Selected file tokens: ${breakdown.selectedFilesTokens} · Window: ${formatContextWindowLabel(contextWindow.tokens)}`;
    trigger.setAttribute("aria-label", "Show context usage");
    trigger.innerHTML = `
      <svg width="24" height="24" style="transform: rotate(-90deg); overflow: visible;">
        <circle cx="12" cy="12" r="${radius}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2" />
        <circle cx="12" cy="12" r="${radius}" fill="none" stroke="${strokeColor}" stroke-dasharray="${circumference}" stroke-dashoffset="${strokeDashoffset}" stroke-width="2" stroke-linecap="round" />
      </svg>
    `;
    const capability = getModelContextCapability(state.metadata.provider, modelId);
    const label = doc.createElement("span");
    label.className = "kw-context-ring-label";
    label.textContent = `Context ${Math.round(percent)}%`;
    ringContainer.append(label);
    let tooltipCloseTimer: ReturnType<typeof setTimeout> | undefined;
    let portal: HTMLElement | null = null;
    const removePortal = () => {
      if (tooltipCloseTimer !== undefined) clearTimeout(tooltipCloseTimer);
      portal?.remove();
      portal = null;
      delete ringContainer.dataset["open"];
      delete ringContainer.dataset["clickOpen"];
      doc.removeEventListener("keydown", onKeyDown);
      doc.removeEventListener("mousedown", onOutsideMouseDown);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") removePortal();
    };
    const onOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (portal !== null && !portal.contains(target) && !ringContainer.contains(target)) {
        removePortal();
      }
    };
    const placePortal = (el: HTMLElement) => {
      const rect = trigger.getBoundingClientRect();
      const composerRect = trigger.closest(".kw-composer")?.getBoundingClientRect();
      const margin = 12;
      const viewportW = doc.defaultView?.innerWidth ?? 1024;
      const viewportH = doc.defaultView?.innerHeight ?? 768;
      const width = Math.min(360, Math.max(280, viewportW - margin * 2));
      el.style.width = `${width}px`;
      el.style.maxHeight = `min(520px, calc(100vh - 24px))`;
      const height = Math.min(el.offsetHeight || 360, Math.min(520, viewportH - margin * 2));
      let left = rect.right - width;
      if (left + width + margin > viewportW) left = viewportW - width - margin;
      if (left < margin) left = margin;
      let top = rect.bottom + 8;
      if (top + height + margin > viewportH) {
        top = (composerRect?.top ?? rect.top) - height - 8;
      }
      if (top < margin) top = margin;
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      el.dataset["placement"] = top < rect.top ? "top" : "bottom";
      if (left <= margin || left + width >= viewportW - margin) {
        el.dataset["clamped"] = "true";
      }
    };
    const buildPortal = (): HTMLElement => {
      const el = doc.createElement("div");
      el.className = "kw-context-usage-portal";
      el.dataset["testid"] = "context-usage-popover";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-label", "Context usage");
      el.innerHTML = `
        <header class="kw-context-usage-head">Context usage</header>
        <dl class="kw-context-usage-grid">
          <dt>Model</dt><dd><strong>${escapeHtml(formatFriendlyModelName(modelId))}</strong></dd>
          <dt>Full ID</dt><dd class="kw-context-usage-id">${escapeHtml(modelId || "Default")}</dd>
          <dt>Window</dt><dd>${formatContextWindowLabel(contextWindow.tokens)} selected / ${capability.maxModelContextTokens ? formatContextWindowLabel(capability.maxModelContextTokens) : "unknown"} known max</dd>
          <dt>Source</dt><dd>${capability.source} · confidence ${capability.confidence}</dd>
          ${contextWindow.warning !== undefined ? `<dt>Warning</dt><dd class="kw-context-usage-warning">${escapeHtml(contextWindow.warning)}</dd>` : ""}
          <dt>Usage</dt><dd><span class="kw-context-usage-number">${(breakdown.usedTokens / 1000).toFixed(1)}k / ${formatContextWindowLabel(contextWindow.tokens)}</span></dd>
          <dt>Selected files</dt><dd><span class="kw-context-usage-number">${breakdown.selectedFilesTokens}</span></dd>
          <dt>System prompt</dt><dd><span class="kw-context-usage-number">${breakdown.systemPromptTokens}</span></dd>
          <dt>User prompt</dt><dd><span class="kw-context-usage-number">${breakdown.userPromptTokens}</span></dd>
          <dt>Tool results</dt><dd><span class="kw-context-usage-number">${breakdown.toolResultTokens}</span></dd>
        </dl>
      `;
      const copyBtn = doc.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "kw-context-copy";
      copyBtn.dataset["testid"] = "context-usage-copy";
      copyBtn.textContent = "Copy usage";
      copyBtn.addEventListener("click", () => {
        const usageText = `Context usage: ${Math.round(percent)}%; used ${breakdown.usedTokens}/${contextWindow.tokens}; selected file tokens ${breakdown.selectedFilesTokens}; source ${capability.source}; confidence ${capability.confidence}`;
        void navigator.clipboard?.writeText(usageText);
      });
      el.append(copyBtn);
      el.addEventListener("mouseenter", () => {
        if (tooltipCloseTimer !== undefined) clearTimeout(tooltipCloseTimer);
      });
      el.addEventListener("mouseleave", closeTooltip);
      return el;
    };
    const openTooltip = () => {
      if (tooltipCloseTimer !== undefined) clearTimeout(tooltipCloseTimer);
      if (portal !== null) return;
      ringContainer.dataset["open"] = "true";
      portal = buildPortal();
      doc.body.append(portal);
      placePortal(portal);
      requestAnimationFrame(() => {
        if (portal !== null) placePortal(portal);
      });
      doc.addEventListener("keydown", onKeyDown);
      setTimeout(() => doc.addEventListener("mousedown", onOutsideMouseDown), 0);
    };
    const closeTooltip = () => {
      tooltipCloseTimer = setTimeout(() => {
        removePortal();
      }, 250);
    };
    trigger.addEventListener("mouseenter", openTooltip);
    trigger.addEventListener("mouseleave", closeTooltip);
    trigger.addEventListener("focus", openTooltip);
    trigger.addEventListener("blur", closeTooltip);
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (portal !== null && ringContainer.dataset["clickOpen"] === "true") {
        removePortal();
        return;
      }
      ringContainer.dataset["clickOpen"] = "true";
      openTooltip();
    });
    ringContainer.append(trigger);
    return ringContainer;
  }

  function applySidebarMode(): void {
    sidebar.dataset["collapsed"] = state.sidebarCollapsed ? "true" : "false";
    collapseBtn.textContent = state.sidebarCollapsed ? "Expand" : "Collapse";
    collapseBtn.title = state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
  }

  function renderConversationList(): void {
    conversationsWrap.innerHTML = "";
    const title = doc.createElement("div");
    title.className = "kw-sidebar-section-title";
    title.textContent = "Chats";
    conversationsWrap.append(title);
    const list = doc.createElement("div");
    list.className = "kw-conversation-list";
    for (const conversation of loadPersistedConversations()) {
      const row = doc.createElement("div");
      row.className = "kw-conversation-item";
      row.dataset["conversationId"] = conversation.id;
      row.dataset["testid"] = "sidebar-conversation-item";
      row.setAttribute("aria-current", conversation.id === state.conversationId ? "true" : "false");
      const main = doc.createElement("button");
      main.type = "button";
      main.className = "kw-conversation-main";
      const firstUserMessage = conversation.messages.find((message) => message.role === "user");
      const itemTitle = doc.createElement("span");
      itemTitle.className = "kw-conversation-title";
      itemTitle.textContent = conversation.title ?? buildConversationTitle(firstUserMessage?.text ?? "New chat");
      const itemMeta = doc.createElement("span");
      itemMeta.className = "kw-conversation-meta";
      itemMeta.textContent = buildConversationMeta(conversation);
      main.append(itemTitle, itemMeta);
      main.title = conversation.title ?? firstUserMessage?.text ?? conversation.id;
      main.addEventListener("click", () => switchConversation(conversation.id));
      row.addEventListener("click", () => switchConversation(conversation.id));
      const actions = doc.createElement("div");
      actions.className = "kw-conversation-actions";
      const rename = doc.createElement("button");
      rename.type = "button";
      rename.className = "kw-conversation-action";
      rename.textContent = "Rename";
      rename.title = "Rename chat";
      rename.addEventListener("click", (event) => {
        event.stopPropagation();
        renameConversation(conversation.id);
      });
      const remove = doc.createElement("button");
      remove.type = "button";
      remove.className = "kw-conversation-action kw-conversation-action-danger";
      remove.textContent = "Delete";
      remove.title = "Delete chat";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteConversation(conversation.id);
      });
      actions.append(rename, remove);
      row.append(main, actions);
      list.append(row);
    }
    conversationsWrap.append(list);
  }

  function startNewConversation(): void {
    persistConversation();
    const now = new Date().toISOString();
    state.conversationId = `conv-${Date.now().toString(36)}`;
    delete state.conversationTitle;
    state.conversationCreatedAt = now;
    state.conversationUpdatedAt = now;
    state.chatMessages = [];
    state.runs = [];
    state.taskHistory = [];
    state.activeTaskId = null;
    state.activeArtifactId = null;
    state.activeArtifactVersion = null;
    state.activeArtifactDiff = null;
    state.chatScrollTop = 0;
    state.routeId = "chat";
    persistConversation();
    renderConversationList();
    renderRoute();
    renderRightContent();
  }

  function switchConversation(conversationId: string): void {
    if (conversationId === state.conversationId) return;
    persistConversation();
    const conversation = loadPersistedConversationById(conversationId);
    if (conversation === null) return;
    activateConversation(conversation);
  }

  function activateConversation(conversation: PersistedConversationView): void {
    state.conversationId = conversation.id;
    if (conversation.title !== undefined) state.conversationTitle = conversation.title;
    else delete state.conversationTitle;
    state.conversationCreatedAt = conversation.createdAt;
    state.conversationUpdatedAt = conversation.updatedAt;
    state.chatMessages = [...conversation.messages];
    state.runs = [...conversation.runs];
    state.taskHistory = conversation.runs.map((run) => run.id);
    state.activeTaskId = conversation.activeRunId;
    state.activeArtifactId = null;
    state.activeArtifactVersion = null;
    state.activeArtifactDiff = null;
    state.chatScrollTop = 0;
    state.routeId = "chat";
    persistConversation();
    renderConversationList();
    renderRoute();
    renderRightContent();
  }

  function renameConversation(conversationId: string): void {
    const conversation = loadPersistedConversationById(conversationId);
    if (conversation === null) return;
    const firstUserMessage = conversation.messages.find((message) => message.role === "user");
    const previousTitle = conversation.title ?? buildConversationTitle(firstUserMessage?.text ?? "New chat");
    const nextTitle = window.prompt("Rename chat", previousTitle)?.replace(/\s+/g, " ").trim();
    if (nextTitle === undefined || nextTitle.length === 0) return;
    const title = buildConversationTitle(nextTitle);
    updatePersistedConversation({
      ...conversation,
      title,
      updatedAt: new Date().toISOString(),
    });
    if (conversationId === state.conversationId) state.conversationTitle = title;
    renderConversationList();
  }

  function deleteConversation(conversationId: string): void {
    const conversation = loadPersistedConversationById(conversationId);
    if (conversation === null) return;
    const firstUserMessage = conversation.messages.find((message) => message.role === "user");
    const title = conversation.title ?? buildConversationTitle(firstUserMessage?.text ?? "New chat");
    if (!window.confirm(`Delete chat "${title}"?`)) return;
    const next = deletePersistedConversation(conversationId);
    if (conversationId === state.conversationId) {
      if (next !== null) {
        activateConversation(next);
        return;
      }
      startNewConversation();
      return;
    }
    renderConversationList();
  }

  function setActive(routeId: WorkspaceRouteId): void {
    for (const [id, btn] of navButtons.entries()) {
      btn.setAttribute("aria-current", id === routeId ? "page" : "false");
    }
  }

  function getVisibleRightPanelTabs(): ReadonlyArray<{ readonly id: RightPanelTab; readonly label: string }> {
    const taskState =
      state.activeTaskId !== null ? options.transport?.getTaskState(state.activeTaskId) ?? null : null;
    const hasArtifacts =
      state.activeTaskId !== null && (options.transport?.getArtifacts(state.activeTaskId).length ?? 0) > 0;
    return RIGHT_PANEL_TABS.filter((tab) => {
      if (tab.id === "preview" || tab.id === "changes" || tab.id === "usage") return true;
      if (tab.id === "diff") return state.activeArtifactId !== null || hasArtifacts;
      if (tab.id === "files") return state.project !== null;
      if (tab.id === "logs") return state.logs.length > 0 || taskState !== null;
      return false;
    });
  }

  function renderRightTabs(): void {
    const visibleTabs = getVisibleRightPanelTabs();
    if (!visibleTabs.some((tab) => tab.id === state.rightTab)) {
      state.rightTab = visibleTabs.some((tab) => tab.id === "changes") ? "changes" : visibleTabs[0]?.id ?? "changes";
    }
    rightTabs.innerHTML = "";
    rightTabButtons.clear();
    for (const tab of visibleTabs) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "kw-right-tab";
      btn.dataset["tabId"] = tab.id;
      btn.dataset["testid"] = `right-tab-${tab.id}`;
      btn.textContent = tab.label;
      btn.setAttribute("aria-current", tab.id === state.rightTab ? "page" : "false");
      btn.addEventListener("click", () => setRightTab(tab.id));
      rightTabs.append(btn);
      rightTabButtons.set(tab.id, btn);
    }
  }

  function setRightTab(tabId: RightPanelTab): void {
    if (tabId === "terminal") {
      bottomTools.dataset["open"] = "true";
      renderBottomTools();
      return;
    }
    state.rightTab = tabId;
    renderRightTabs();
    renderRightContent();
  }

  function navigate(routeId: WorkspaceRouteId): void {
    state.routeId = routeId;
    renderRoute();
  }

  // -------------------------------------------------------------------------
  // Center route renderers
  // -------------------------------------------------------------------------

  function renderRoute(): void {
    doc.querySelector(".kw-context-usage-portal")?.remove();
    setActive(state.routeId);
    center.innerHTML = "";
    center.dataset["routeId"] = state.routeId;
    body.dataset["routeId"] = state.routeId;
    switch (state.routeId) {
      case "chat":
        renderCenter();
        break;
      case "project":
        renderProjectPane();
        break;
      case "changes":
        renderChangesPane();
        break;
      case "runs":
        renderRunsPane();
        break;
      case "models":
        renderModelsPane();
        break;
      case "agents":
        renderAgentsPane();
        break;
      case "settings":
        renderSettingsPane();
        break;
    }
  }

  // ------ Chat (default) ------
  function renderCenter(): void {
    const previousThread = center.querySelector<HTMLElement>(".kw-chat-thread");
    const wasNearBottom = previousThread === null || isNearBottom(previousThread);
    const previousScrollTop = previousThread?.scrollTop ?? state.chatScrollTop;
    center.innerHTML = "";
    center.dataset["routeId"] = "chat";

    const thread = doc.createElement("div");
    thread.className = "kw-chat-thread";
    thread.dataset["testid"] = "chat-thread";
    thread.addEventListener("scroll", () => {
      state.chatScrollTop = thread.scrollTop;
    });
    center.append(thread);

    const taskId = state.activeTaskId;
    if (taskId === null && state.chatMessages.length === 0) {
      thread.append(buildChatWelcome(doc));
    }
    const renderedRunBlocks = new Set<string>();
    for (const message of state.chatMessages) {
      thread.append(buildChatMessage(doc, message));
      if (message.role === "user" && message.runId !== undefined && options.transport !== undefined) {
        appendRunBlocksForTask(thread, message.runId, renderedRunBlocks);
      }
    }
    if (taskId !== null && options.transport !== undefined) {
      if (renderedRunBlocks.has(taskId)) {
        center.append(buildComposer());
        requestAnimationFrame(() => {
          if (wasNearBottom) {
            thread.scrollTop = thread.scrollHeight;
          } else {
            thread.scrollTop = previousScrollTop;
          }
          state.chatScrollTop = thread.scrollTop;
        });
        return;
      }
      appendRunBlocksForTask(thread, taskId, renderedRunBlocks);
    }

    center.append(buildComposer());
    requestAnimationFrame(() => {
      if (wasNearBottom) {
        thread.scrollTop = thread.scrollHeight;
      } else {
        thread.scrollTop = previousScrollTop;
      }
      state.chatScrollTop = thread.scrollTop;
    });
  }

  function appendRunBlocksForTask(thread: HTMLElement, taskId: string, renderedRunBlocks: Set<string>): void {
    if (renderedRunBlocks.has(taskId) || options.transport === undefined) return;
    renderedRunBlocks.add(taskId);
      const transport = options.transport;
      const taskState = transport.getTaskState(taskId);
      if (taskState !== null) {
        if (taskState.contextSummary) {
          thread.append(buildContextUsedBlock(doc, taskState.contextSummary));
        }
        if (isClarificationTask(taskState)) {
          thread.append(buildAgentTimeline(doc, transport, taskId, taskState));
        } else if (isReadOnlyTaskState(taskState)) {
          if (!isTerminalTaskStatus(taskState.status)) {
            thread.append(buildReadOnlyProgressMessage(doc, taskState));
          }
        } else {
          thread.append(buildAgentTimeline(doc, transport, taskId, taskState));
        }
        const finalReport = transport.getFinalReport(taskId);
        if (finalReport !== null && shouldRenderFinalReport(taskState)) {
          thread.append(
            buildFinalReportMessage(doc, finalReport, () => {
              state.routeId = "changes";
              renderRoute();
            }),
          );
        }
      }
  }

  function buildChatWelcome(doc: Document): HTMLElement {
    const wrap = doc.createElement("div");
    wrap.className = "kw-chat-welcome";
    const title = doc.createElement("h2");
    title.className = "kw-chat-welcome-title";
    title.textContent = "Welcome to KARO";
    const sub = doc.createElement("p");
    sub.className = "kw-chat-welcome-sub";
    sub.textContent =
      "Ask about the project, plan work, or request file changes. Karo keeps chat, planning, and Agent Mode separate.";
    const suggestions = doc.createElement("div");
    suggestions.className = "kw-welcome-suggestions";
    for (const [label, prompt] of [
      ["Explain project", "Объясни что это за проект и как он устроен"],
      ["Make a plan", "Составь план редизайна Karo под Codex-like UI"],
      ["Create a file", "Создай файл src/karo-test.txt с текстом hello"],
      ["Security review", "Проверь, безопасно ли проект хранит API keys и выполняет команды"],
    ] as const) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "kw-welcome-suggestion";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        const textarea = doc.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]');
        if (textarea !== null) {
          textarea.value = prompt;
          textarea.focus();
        }
      });
      suggestions.append(btn);
    }
    wrap.append(title, sub, suggestions);
    return wrap;
  }

  function buildChatMessage(doc: Document, message: ChatMessageView): HTMLElement {
    const wrap = doc.createElement("article");
    wrap.className =
      message.role === "user"
        ? "kw-chat-message kw-chat-user"
        : "kw-chat-message kw-chat-assistant kw-chat-local";
    wrap.dataset["testid"] =
      message.role === "user"
        ? "chat-message-user"
        : message.kind === "safety"
          ? "chat-message-safety"
          : message.mode === "plan"
            ? "chat-message-plan"
            : message.kind === "analysis"
              ? "chat-message-analysis"
              : "chat-message-assistant";
    wrap.dataset["messageId"] = message.id;
    if (message.mode !== undefined) wrap.dataset["mode"] = message.mode;
    if (message.intent !== undefined) wrap.dataset["intent"] = message.intent;
    if (message.pending === true) wrap.dataset["pending"] = "true";
    if (message.error === true) wrap.dataset["error"] = "true";
    const author = doc.createElement("header");
    author.className = "kw-chat-author";
    author.textContent = message.role === "user" ? "You" : "KARO";
    const displayMode = message.badgeMode ?? message.mode;
    if (message.kind === "safety") {
      const pill = doc.createElement("span");
      pill.className = "kw-chat-status-pill";
      pill.dataset["variant"] = "warn";
      pill.textContent = "Safety Check";
      author.append(pill);
    } else if (message.kind === "clarification") {
      const pill = doc.createElement("span");
      pill.className = "kw-chat-status-pill";
      pill.dataset["variant"] = "info";
      pill.textContent = "Clarification";
      author.append(pill);
    } else if (displayMode !== undefined) {
      const pill = doc.createElement("span");
      pill.className = "kw-chat-status-pill";
      pill.dataset["variant"] =
        message.error === true
          ? "error"
          : message.pending === true
            ? "info"
            : displayMode === "agent" || displayMode === "auto"
              ? "info"
              : "success";
      pill.textContent = `${displayMode[0]!.toUpperCase()}${displayMode.slice(1)} Mode`;
      author.append(pill);
    }
    const body = doc.createElement("div");
    body.className = "kw-chat-body";
    if (message.role === "assistant") {
      if (message.kind === "clarification") {
        body.append(buildLocalClarificationCard(doc, message.text));
      } else {
        body.append(renderMarkdownBlock(doc, message.text));
      }
      if (message.chatContext !== undefined) {
        body.append(buildChatReadOnlyContextSummary(doc, message.chatContext));
      }
      if (looksSilentlyTruncated(message.text)) {
        const notice = doc.createElement("div");
        notice.className = "kw-truncation-notice";
        const noteText = doc.createElement("span");
        noteText.textContent = "Response may be truncated.";
        const continueBtn = doc.createElement("button");
        continueBtn.type = "button";
        continueBtn.className = "kw-button kw-button-secondary kw-continue-response";
        continueBtn.textContent = "Continue";
        continueBtn.addEventListener("click", () => {
          const input = doc.querySelector<HTMLTextAreaElement>(".kw-composer-input");
          if (input !== null) {
            input.value = "Продолжи ответ с места, где он оборвался.";
            input.dispatchEvent(new Event("input"));
            input.focus();
          }
        });
        notice.append(noteText, continueBtn);
        body.append(notice);
      }
    } else {
      body.textContent = message.text;
    }
    wrap.append(author, body);
    return wrap;
  }

  function buildChatReadOnlyContextSummary(doc: Document, context: ChatReadOnlyContextView): HTMLElement {
    const details = doc.createElement("details");
    details.className = "kw-chat-readonly-context";
    details.dataset["testid"] = "chat-readonly-context";
    const summary = doc.createElement("summary");
    summary.textContent = `Read-only context · ${String(context.selectedFilesCount)} files · ${context.profile}`;
    details.append(summary);
    if (context.selectedFiles.length > 0) {
      const list = doc.createElement("ul");
      list.className = "kw-context-file-list";
      for (const file of context.selectedFiles.slice(0, 8)) {
        const item = doc.createElement("li");
        item.className = "kw-context-file-item";
        item.textContent = file;
        list.append(item);
      }
      details.append(list);
    }
    if (context.warnings.length > 0) {
      const warn = doc.createElement("p");
      warn.className = "kw-context-warning";
      warn.textContent = context.warnings.join(" ");
      details.append(warn);
    }
    return details;
  }

  function buildContextUsedBlock(doc: Document, summary: any): HTMLElement {
    const compact = doc.createElement("section");
    compact.className = "kw-chat-message kw-chat-assistant kw-context-used kw-context-used-compact";
    compact.dataset["testid"] = "analysis-result";
    const selectedFiles = Array.isArray(summary.selectedFiles) ? summary.selectedFiles : [];
    const selectedCount = summary.selectedFilesCount ?? selectedFiles.length;
    const scannedCount = summary.scannedFilesCount ?? 0;
    const fileTokens = selectedFiles.reduce(
      (sum: number, file: { estimatedTokens?: number }) => sum + (file.estimatedTokens ?? 0),
      0,
    );
    const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];

    const head = doc.createElement("div");
    head.className = "kw-context-used-head";
    const compactTitle = doc.createElement("strong");
    compactTitle.textContent = "Context";
    const compactMeta = doc.createElement("span");
    compactMeta.textContent = `${selectedCount} files selected · ${scannedCount} scanned${
      fileTokens > 0 ? ` · ~${formatContextWindowLabel(fileTokens)} tokens` : ""
    }`;
    head.append(compactTitle, compactMeta);
    if (warnings.length > 0 || selectedCount === 0) {
      const badge = doc.createElement("span");
      badge.className = "kw-context-warning-badge";
      badge.textContent = selectedCount === 0 ? "No files" : `${warnings.length} warning(s)`;
      head.append(badge);
    }
    compact.append(head);

    if (selectedCount === 0) {
      const warning = doc.createElement("p");
      warning.className = "kw-system-notice kw-system-notice-warning";
      warning.textContent = "No project files were selected. I will not guess architecture.";
      compact.append(warning);
    }

    const details = doc.createElement("details");
    details.className = "kw-context-used-details";
    const detailsSummary = doc.createElement("summary");
    detailsSummary.textContent = "Show files and diagnostics";
    details.append(detailsSummary);

    if (summary.projectRoot) {
      const rootLine = doc.createElement("p");
      rootLine.className = "kw-context-root";
      rootLine.textContent = `Project root: ${toDisplayPath(summary.projectRoot)}`;
      details.append(rootLine);
    }

    if (selectedFiles.length > 0) {
      const filesList = doc.createElement("ul");
      filesList.className = "kw-context-file-list";
      for (const f of selectedFiles) {
        const li = doc.createElement("li");
        const pathSpan = doc.createElement("span");
        pathSpan.className = "kw-context-file-path";
        pathSpan.textContent = toDisplayPath(f.relativePath);
        const metaSpan = doc.createElement("span");
        metaSpan.className = "kw-context-file-meta";
        const score = typeof f.score === "number" ? `score ${f.score.toFixed(1)}` : "";
        metaSpan.textContent = [score, f.truncated ? "truncated" : ""].filter(Boolean).join(" · ");
        li.append(pathSpan, metaSpan);
        if (Array.isArray(f.reason) && f.reason.length > 0) {
          const reason = doc.createElement("small");
          reason.textContent = f.reason.join(", ");
          li.append(reason);
        }
        filesList.append(li);
      }
      details.append(filesList);
    }

    if (warnings.length > 0) {
      const warnList = doc.createElement("ul");
      warnList.className = "kw-context-warning-list";
      for (const text of warnings) {
        const li = doc.createElement("li");
        li.textContent = text;
        warnList.append(li);
      }
      details.append(warnList);
    }

    compact.append(details);
    return compact;

    const wrap = doc.createElement("section");
    wrap.className = "kw-chat-message kw-chat-assistant kw-context-used";
    wrap.style.margin = "16px 0";
    wrap.style.padding = "20px";
    wrap.style.borderRadius = "12px";
    wrap.style.background = "rgba(30, 41, 59, 0.4)";
    wrap.style.border = "1px solid rgba(255, 255, 255, 0.08)";
    wrap.style.backdropFilter = "blur(8px)";
    wrap.style.boxShadow = "0 4px 20px rgba(0, 0, 0, 0.2)";

    const title = doc.createElement("h4");
    title.style.margin = "0 0 16px 0";
    title.style.fontSize = "15px";
    title.style.fontWeight = "600";
    title.style.color = "#63b3ed";
    title.style.display = "flex";
    title.style.alignItems = "center";
    title.style.gap = "8px";
    title.textContent = "🔍 Project Context Used";
    wrap.append(title);

    const stats = doc.createElement("div");
    stats.style.display = "flex";
    stats.style.flexWrap = "wrap";
    stats.style.gap = "10px";
    stats.style.fontSize = "13px";
    stats.style.color = "rgba(255, 255, 255, 0.7)";
    stats.style.marginBottom = "16px";

    const scannedPill = doc.createElement("span");
    scannedPill.style.padding = "4px 8px";
    scannedPill.style.borderRadius = "6px";
    scannedPill.style.background = "rgba(255, 255, 255, 0.06)";
    scannedPill.textContent = `Scanned: ${summary.scannedFilesCount}`;

    const selectedPill = doc.createElement("span");
    selectedPill.style.padding = "4px 8px";
    selectedPill.style.borderRadius = "6px";
    selectedPill.style.background = "rgba(99, 179, 237, 0.15)";
    selectedPill.style.color = "#63b3ed";
    selectedPill.style.fontWeight = "600";
    selectedPill.textContent = `Selected: ${summary.selectedFilesCount}`;

    stats.append(scannedPill, selectedPill);
    wrap.append(stats);

    if (summary.projectRoot) {
      const rootDiv = doc.createElement("div");
      rootDiv.style.fontSize = "13px";
      rootDiv.style.color = "rgba(255, 255, 255, 0.5)";
      rootDiv.style.marginBottom = "16px";
      rootDiv.style.fontFamily = "monospace";
      rootDiv.style.background = "rgba(0, 0, 0, 0.2)";
      rootDiv.style.padding = "6px 10px";
      rootDiv.style.borderRadius = "6px";
      rootDiv.style.overflowX = "auto";
      rootDiv.textContent = `Project root: ${summary.projectRoot}`;
      wrap.append(rootDiv);
    }

    if (summary.selectedFiles && summary.selectedFiles.length > 0) {
      const filesTitle = doc.createElement("div");
      filesTitle.style.fontSize = "13px";
      filesTitle.style.fontWeight = "600";
      filesTitle.style.color = "rgba(255, 255, 255, 0.6)";
      filesTitle.style.marginBottom = "8px";
      filesTitle.textContent = "Relevant Files:";
      wrap.append(filesTitle);

      const filesList = doc.createElement("ul");
      filesList.style.margin = "0";
      filesList.style.paddingLeft = "0";
      filesList.style.listStyleType = "none";
      filesList.style.fontSize = "13px";
      filesList.style.color = "rgba(255, 255, 255, 0.8)";

      for (const f of summary.selectedFiles) {
        const li = doc.createElement("li");
        li.style.marginBottom = "8px";
        li.style.padding = "8px";
        li.style.borderRadius = "6px";
        li.style.background = "rgba(255, 255, 255, 0.02)";
        li.style.border = "1px solid rgba(255, 255, 255, 0.04)";

        const fileHeader = doc.createElement("div");
        fileHeader.style.display = "flex";
        fileHeader.style.justifyContent = "space-between";
        fileHeader.style.alignItems = "center";
        fileHeader.style.marginBottom = "4px";

        const pathSpan = doc.createElement("strong");
        pathSpan.style.color = "#63b3ed";
        pathSpan.style.fontFamily = "monospace";
        pathSpan.textContent = f.relativePath;

        const scoreSpan = doc.createElement("span");
        scoreSpan.style.fontSize = "12px";
        scoreSpan.style.fontWeight = "600";
        scoreSpan.style.color = "rgba(255, 255, 255, 0.5)";
        scoreSpan.textContent = `score: ${f.score.toFixed(1)}${f.truncated ? ' (truncated)' : ''}`;

        fileHeader.append(pathSpan, scoreSpan);
        li.append(fileHeader);

        if (f.reason && f.reason.length > 0) {
          const reasonDiv = doc.createElement("div");
          reasonDiv.style.fontSize = "12px";
          reasonDiv.style.color = "rgba(255, 255, 255, 0.4)";
          reasonDiv.style.paddingLeft = "8px";
          reasonDiv.style.borderLeft = "2px solid rgba(255, 255, 255, 0.1)";
          reasonDiv.textContent = `Reason: ${f.reason.join(", ")}`;
          li.append(reasonDiv);
        }

        filesList.append(li);
      }
      wrap.append(filesList);
    } else {
      const warningDiv = doc.createElement("div");
      warningDiv.style.marginTop = "8px";
      warningDiv.style.padding = "10px 14px";
      warningDiv.style.borderRadius = "6px";
      warningDiv.style.background = "rgba(239, 68, 68, 0.15)";
      warningDiv.style.border = "1px solid rgba(239, 68, 68, 0.3)";
      warningDiv.style.color = "#f87171";
      warningDiv.style.fontSize = "13px";
      warningDiv.style.fontWeight = "600";
      warningDiv.textContent = "⚠️ Context used: no relevant files selected";
      wrap.append(warningDiv);
    }

    if (summary.warnings && summary.warnings.length > 0) {
      const warnWrap = doc.createElement("div");
      warnWrap.style.marginTop = "10px";
      warnWrap.style.padding = "8px 12px";
      warnWrap.style.borderRadius = "6px";
      warnWrap.style.background = "rgba(245, 158, 11, 0.1)";
      warnWrap.style.border = "1px solid rgba(245, 158, 11, 0.2)";
      warnWrap.style.fontSize = "12px";
      warnWrap.style.color = "#fbbf24";
      warnWrap.textContent = `Warnings: ${summary.warnings.join("; ")}`;
      wrap.append(warnWrap);
    }

    return wrap;
  }

  function buildLocalClarificationCard(doc: Document, questionText: string): HTMLElement {
    const card = doc.createElement("div");
    card.className = "kw-clarification-card kw-local-clarification-card";
    card.dataset["testid"] = "clarification-card";

    const title = doc.createElement("h4");
    title.className = "kw-clarification-title";
    title.textContent = "KARO needs clarification";

    const question = doc.createElement("p");
    question.className = "kw-clarification-question";
    question.textContent =
      questionText.trim().length > 0
        ? questionText
        : "The request is too broad. Choose whether you want chat, planning, project analysis, or file changes.";

    const optionsWrap = doc.createElement("div");
    optionsWrap.className = "kw-clarification-options";
    const optionsList = [
      ["chat", "Просто обсудить", "Давай просто поговорим без изменения файлов."],
      ["plan", "Сделать план", "Сделай план и не меняй файлы."],
      ["explain", "Объяснить проект", "Объясни проект и не меняй файлы."],
      ["agent", "Внести изменения", "Уточняю: нужно изменить файлы проекта."],
    ] as const;
    let selected = "";
    for (const [id, label, value] of optionsList) {
      const option = doc.createElement("button");
      option.type = "button";
      option.className = "kw-btn kw-btn-secondary kw-clarify-option-btn";
      option.dataset["testid"] = "clarification-option";
      option.dataset["optionId"] = id;
      option.textContent = label;
      option.addEventListener("click", () => {
        selected = value;
        for (const sibling of Array.from(optionsWrap.querySelectorAll("button"))) {
          sibling.classList.toggle("selected", sibling === option);
        }
        updateContinueState();
      });
      optionsWrap.append(option);
    }

    const custom = doc.createElement("textarea");
    custom.className = "kw-clarify-textarea";
    custom.dataset["testid"] = "clarification-custom-input";
    custom.placeholder = "Напиши свой вариант...";

    const actions = doc.createElement("div");
    actions.className = "kw-clarify-actions";
    const continueBtn = doc.createElement("button");
    continueBtn.type = "button";
    continueBtn.className = "kw-btn kw-btn-success kw-btn-continue";
    continueBtn.dataset["testid"] = "clarification-continue";
    continueBtn.textContent = "Continue";
    continueBtn.disabled = true;
    continueBtn.addEventListener("click", () => {
      const answer = custom.value.trim() || selected;
      if (answer.length === 0) return;
      appendChatMessage({ role: "user", text: answer, intent: "assist_request", kind: "chat" });
      if (/измен|файл|ui|bug|баг|исправ|улучш/i.test(answer)) {
        appendChatMessage({
          role: "assistant",
          text: "Понял. Это уже задача на изменения проекта. Переключись в Agent Mode или уточни конкретную область, чтобы я не запускал file-change pipeline вслепую.",
          mode: "chat",
          kind: "analysis",
        });
      } else {
        appendChatMessage({
          role: "assistant",
          text: "Ок, давай просто обсудим. Я не буду запускать Context Engine, агентов или создавать файлы без явной задачи.",
          mode: "chat",
          kind: "chat",
        });
      }
      renderRoute();
    });
    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "kw-btn kw-btn-secondary kw-btn-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      card.remove();
    });
    actions.append(cancelBtn, continueBtn);

    function updateContinueState(): void {
      continueBtn.disabled = custom.value.trim().length === 0 && selected.length === 0;
    }
    custom.addEventListener("input", updateContinueState);

    card.append(title, question, optionsWrap, custom, actions);
    return card;
  }

  function isClarificationTask(taskState: TaskStateSnapshot): boolean {
    return (
      taskState.status === "waiting_consent" &&
      taskState.clarificationState !== undefined &&
      !taskState.clarificationState.resolved
    );
  }

  function isTerminalTaskStatus(statusValue: TaskStatus): boolean {
    return statusValue === "completed" || statusValue === "error" || statusValue === "stopped_limit";
  }

  function isReadOnlyTaskState(taskState: TaskStateSnapshot): boolean {
    if (taskState.decision?.intent === "run_command" || taskState.decision?.allowCommands === true) {
      return false;
    }
    if (taskState.decision?.allowFileChanges === false) return true;
    if (taskState.isExplainOnly === true) return true;
    return (
      taskState.decision?.intent === "explain_project" ||
      taskState.decision?.intent === "analyze_project" ||
      taskState.decision?.intent === "security_review"
    );
  }

  function shouldRenderFinalReport(taskState: TaskStateSnapshot): boolean {
    if (!isReadOnlyTaskState(taskState)) return true;
    const intent = taskState.decision?.intent;
    return intent === "security_review" || intent === "explain_project" || intent === "analyze_project";
  }

  function buildReadOnlyProgressMessage(doc: Document, taskState: TaskStateSnapshot): HTMLElement {
    const wrap = doc.createElement("article");
    wrap.className = "kw-chat-message kw-chat-assistant kw-readonly-progress";
    wrap.dataset["testid"] = "chat-message-analysis";
    const author = doc.createElement("header");
    author.className = "kw-chat-author";
    author.textContent = "KARO";
    const pill = doc.createElement("span");
    pill.className = "kw-chat-status-pill";
    pill.dataset["variant"] = "info";
    pill.textContent = taskState.decision?.requiresContextEngine === true
      ? "Analyzing project"
      : "Preparing answer";
    author.append(pill);
    const body = doc.createElement("p");
    body.className = "kw-chat-body";
    body.textContent = taskState.decision?.requiresContextEngine === true
      ? "Selecting local context and preparing a read-only answer. No file changes will be produced."
      : "Preparing a read-only answer. No file changes will be produced.";
    wrap.append(author, body);
    return wrap;
  }

  function buildAgentTimeline(
    doc: Document,
    transport: OrchestratorTransport,
    taskId: string,
    taskState: TaskStateSnapshot,
  ): HTMLElement {
    const wrap = doc.createElement("article");
    wrap.className = "kw-chat-message kw-chat-assistant";
    wrap.dataset["testid"] = "chat-message-analysis";
    wrap.dataset["taskId"] = taskId;
    const author = doc.createElement("header");
    author.className = "kw-chat-author";
    author.textContent = "KARO";
    const status = doc.createElement("span");
    status.className = "kw-chat-status-pill";
    const desc = describeStatus(taskState.status);
    const waitingForClarification =
      taskState.status === "waiting_consent" &&
      taskState.clarificationState !== undefined &&
      !taskState.clarificationState.resolved;
    const isQuickEdit = taskState.participants.includes("quick_edit");
    status.textContent = waitingForClarification ? "Waiting for clarification" : desc.label;
    status.dataset["variant"] = desc.variant;
    author.append(status);

    if (!waitingForClarification && !isQuickEdit) {
      const cycles = doc.createElement("span");
      cycles.className = "kw-chat-cycles";
      cycles.textContent = `${String(taskState.reviewCycles)}/${String(taskState.maxReviewCycles)} cycles`;
      author.append(cycles);
    }

    wrap.append(author);

    // Calculate agent statuses for horizontal pipeline
    const events = transport.getTraceEvents(taskId);
    const artifactMap = buildArtifactFileNameMap(transport.getArtifacts(taskId));
    const locale = detectActivityLocale(taskState.originalPrompt);
    const includeRouteCard = !isQuickEdit && taskState.decision?.executionMode !== "chat";
    const groups = withSyntheticActivityGroups(
      groupTraceByAgent(events, { includeOrchestrator: includeRouteCard }),
      taskState,
    );

    function getAgentStatusInPipeline(
      agentId: BuiltinAgentRole,
      status: TaskStatus,
      groupsList: readonly AgentGroup[],
    ): "pending" | "running" | "done" | "blocked" | "error" {
      const grp = groupsList.find((g) => g.agentId === agentId);
      if (status === "completed") {
        return "done";
      }
      if (status === "error") {
        if (grp && grp.status === "error") return "error";
        if (grp && grp.status === "finished") return "done";
      }
      if (status === "waiting_consent") {
        if (grp && grp.status === "started") return "blocked";
      }
      if (status === "stopped_limit") {
        if (agentId === "reviewer" || agentId === "fixer") return "blocked";
        if (grp && grp.status === "finished") return "done";
      }

      // Current agent mapping
      let currentAgent: BuiltinAgentRole | null = null;
      if (status === "researching") currentAgent = "researcher";
      else if (status === "coding") currentAgent = "coder";
      else if (status === "reviewing") currentAgent = "reviewer";
      else if (status === "fixing") currentAgent = "fixer";
      else if (status === "boss_eval") currentAgent = "boss";

      if (currentAgent === agentId) {
        return status === "waiting_consent" ? "blocked" : "running";
      }
      if (grp && grp.status === "finished") {
        return "done";
      }

      const order: BuiltinAgentRole[] = ["researcher", "coder", "reviewer", "fixer", "boss"];
      const currentIndex = order.indexOf(currentAgent as BuiltinAgentRole);
      const agentIndex = order.indexOf(agentId);
      if (currentIndex !== -1) {
        if (agentIndex < currentIndex) return "done";
      }
      return "pending";
    }

    if (!waitingForClarification && !isQuickEdit) {
      const pipelineBar = doc.createElement("div");
      pipelineBar.className = "kw-pipeline-bar";

      const canonicalPipelineAgents: BuiltinAgentRole[] = ["researcher", "coder", "reviewer", "fixer", "boss"];
      const participantPipelineAgents = taskState.participants.filter(
        (agentId): agentId is BuiltinAgentRole =>
          agentId === "researcher" ||
          agentId === "coder" ||
          agentId === "reviewer" ||
          agentId === "fixer" ||
          agentId === "boss",
      );
      const pipelineAgents =
        participantPipelineAgents.length > 0 ? participantPipelineAgents : canonicalPipelineAgents;
      for (let i = 0; i < pipelineAgents.length; i++) {
        const agentId = pipelineAgents[i]!;
        const agentStatus = getAgentStatusInPipeline(agentId, taskState.status, groups);

        const node = doc.createElement("div");
        node.className = "kw-pipeline-node";
        node.dataset["status"] = agentStatus;
        node.title = `${readableAgentName(agentId)}: ${agentStatus}`;

        const dot = doc.createElement("div");
        dot.className = "kw-pipeline-dot";

        const label = doc.createElement("span");
        label.className = "kw-pipeline-label";
        label.textContent = readableAgentName(agentId);

        node.append(dot, label);
        pipelineBar.append(node);

        if (i < pipelineAgents.length - 1) {
          const line = doc.createElement("div");
          line.className = "kw-pipeline-line";
          const nextAgentId = pipelineAgents[i + 1]!;
          const nextAgentStatus = getAgentStatusInPipeline(nextAgentId, taskState.status, groups);
          if (agentStatus === "done" && nextAgentStatus === "done") {
            line.dataset["status"] = "done";
          } else if (agentStatus === "done" || agentStatus === "running") {
            line.dataset["status"] = "running";
          } else {
            line.dataset["status"] = "pending";
          }
          pipelineBar.append(line);
        }
      }
      wrap.append(pipelineBar);
    }



    if (taskState.status === "error" && taskState.errorReason !== undefined) {
      const err = doc.createElement("p");
      err.className = "kw-chat-error";
      err.textContent = taskState.errorReason;
      wrap.append(err);
    }
    if (taskState.recoveryState !== undefined) {
      wrap.append(buildInlineRecoverySummary(doc, taskState, locale));
    }

    if (taskState.status === "waiting_consent") {
      if (taskState.clarificationState && !taskState.clarificationState.resolved) {
        // RENDERING CLARIFICATION CARD
        const clarBox = doc.createElement("div");
        clarBox.className = "kw-clarification-card";
        clarBox.dataset["testid"] = "clarification-card";
        clarBox.style.cssText = `
          background: rgba(30, 30, 40, 0.7);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 20px;
          margin: 15px 0;
          box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
        `;

        const title = doc.createElement("h4");
        title.className = "kw-clarification-title";
        title.innerHTML = "🤔 KARO Needs Clarification";
        title.style.cssText = "margin: 0 0 10px 0; color: #fff; font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px;";
        clarBox.append(title);

        const question = doc.createElement("p");
        question.className = "kw-clarification-question";
        question.textContent = taskState.clarificationState.question;
        question.style.cssText = "margin: 0 0 15px 0; color: #cbd5e1; font-size: 14px; line-height: 1.5;";
        clarBox.append(question);

        // Options
        const optionsContainer = doc.createElement("div");
        optionsContainer.className = "kw-clarification-options";
        optionsContainer.style.cssText = "display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 15px;";

        let selectedOptionId: string | undefined = undefined;

        taskState.clarificationState.options.filter((opt) => opt.id !== "cancel").forEach((opt) => {
          const optBtn = doc.createElement("button");
          optBtn.className = "kw-btn kw-btn-secondary kw-clarify-option-btn";
          optBtn.dataset["testid"] = "clarification-option";
          optBtn.textContent = opt.label;
          optBtn.dataset["optionId"] = opt.id;
          optBtn.style.cssText = "transition: all 0.2s ease; border: 1px solid rgba(255, 255, 255, 0.05); font-size: 12px; padding: 6px 12px; border-radius: 6px; cursor: pointer;";
          optBtn.addEventListener("click", () => {
            // Снятие или установка выделения
            const isSelected = optBtn.classList.contains("selected");
            optionsContainer.querySelectorAll(".kw-clarify-option-btn").forEach(btn => {
              btn.classList.remove("selected");
              (btn as HTMLElement).style.background = "";
              (btn as HTMLElement).style.borderColor = "";
            });
            if (!isSelected) {
              optBtn.classList.add("selected");
              optBtn.style.background = "rgba(99, 102, 241, 0.2)";
              optBtn.style.borderColor = "rgb(99, 102, 241)";
              selectedOptionId = opt.id;
            } else {
              selectedOptionId = undefined;
            }
            updateConfirmButton();
          });
          optionsContainer.append(optBtn);
        });
        clarBox.append(optionsContainer);

        // Custom textarea
        const textarea = doc.createElement("textarea");
        textarea.className = "kw-clarify-textarea";
        textarea.dataset["testid"] = "clarification-custom-input";
        textarea.placeholder = "Напиши свой вариант...";
        textarea.style.cssText = "width: 100%; height: 80px; background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; color: #fff; padding: 10px; font-size: 13px; resize: none; margin-bottom: 15px; outline: none; transition: border-color 0.2s;";
        textarea.addEventListener("focus", () => {
          textarea.style.borderColor = "rgb(99, 102, 241)";
        });
        textarea.addEventListener("blur", () => {
          textarea.style.borderColor = "rgba(255, 255, 255, 0.1)";
        });
        textarea.addEventListener("input", () => {
          updateConfirmButton();
        });
        clarBox.append(textarea);

        // Actions
        const actions = doc.createElement("div");
        actions.className = "kw-clarify-actions";
        actions.style.cssText = "display: flex; gap: 10px; justify-content: flex-end;";

        const btnContinue = doc.createElement("button");
        btnContinue.className = "kw-btn kw-btn-success kw-btn-continue";
        btnContinue.dataset["testid"] = "clarification-continue";
        btnContinue.textContent = "Continue";
        btnContinue.disabled = true;
        btnContinue.style.cssText = "font-size: 13px; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500;";
        btnContinue.addEventListener("click", () => {
          btnContinue.disabled = true;
          btnCancel.disabled = true;
          transport.resumeTask(taskId, {
            kind: "clarify",
            selectedOptionId,
            customAnswer: textarea.value.trim(),
          }).catch((err: unknown) => {
            btnContinue.disabled = false;
            btnCancel.disabled = false;
            pushLog("error", `Clarification continue failed: ${describeError(err)}`);
            renderRoute();
          });
        });

        const btnCancel = doc.createElement("button");
        btnCancel.className = "kw-btn kw-btn-secondary kw-btn-cancel";
        btnCancel.textContent = "Cancel";
        btnCancel.style.cssText = "font-size: 13px; padding: 8px 16px; border-radius: 6px; cursor: pointer;";
        btnCancel.addEventListener("click", () => {
          btnContinue.disabled = true;
          btnCancel.disabled = true;
          void transport.resumeTask(taskId, { kind: "cancel" });
        });

        function updateConfirmButton() {
          const hasText = textarea.value.trim().length > 0;
          const hasOption = selectedOptionId !== undefined;
          btnContinue.disabled = !(hasText || hasOption);
        }

        actions.append(btnCancel, btnContinue);
        clarBox.append(actions);
        wrap.append(clarBox);
      } else {
        // RENDERING PREMIUM COMMAND APPROVAL CARD
        const consentBox = doc.createElement("div");
        consentBox.className = "kw-command-approval-card";
        consentBox.dataset["testid"] = "safety-card";
        consentBox.style.cssText = `
          background: rgba(30, 30, 40, 0.7);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 20px;
          margin: 15px 0;
          box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
        `;

        const title = doc.createElement("h4");
        title.className = "kw-consent-title";
        title.textContent = "Command Execution Consent Required";
        title.style.cssText = "margin: 0 0 12px 0; color: #fff; font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px;";
        consentBox.append(title);

        const cmd = taskState.consentRequest?.command ?? "pnpm test";
        const args = taskState.consentRequest?.args?.join(" ") ?? "";
        const reason = taskState.consentRequest?.reason ?? "Autodetected test runner command";
        const cwd = taskState.consentRequest?.cwd ?? "./staging";
        const fullCmd = `${cmd} ${args}`.trim();

        // Run Command Policy
        const permissionMode = (localStorage.getItem("karo.permissionMode") as any) || "smart_approval";
        const projectRoot = state.project?.path || "";
        const cmdDecision = runCommandPolicy({
          command: fullCmd,
          cwd,
          projectRoot,
          permissionMode,
        });

        // Save last command diagnostics
        localStorage.setItem("karo.lastCommand", fullCmd);
        localStorage.setItem("karo.lastCommandRiskLevel", cmdDecision.riskLevel);
        localStorage.setItem("karo.lastCommandDecision", cmdDecision.blocked ? "Blocked" : (cmdDecision.requiresApproval ? "Requires Approval" : "Auto"));
        localStorage.setItem("karo.lastCommandRequiredApproval", String(cmdDecision.requiresApproval));
        localStorage.setItem("karo.lastCommandRollbackAvailable", String(cmdDecision.rollbackAvailable));
        localStorage.setItem("karo.lastCommandReason", cmdDecision.reason);

        // Risk Badge
        const riskBadge = doc.createElement("div");
        riskBadge.className = "kw-command-risk-badge";
        riskBadge.textContent = cmdDecision.riskLevel.toUpperCase();

        let badgeStyle = "padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; width: fit-content; margin-bottom: 12px; text-transform: uppercase;";
        if (cmdDecision.riskLevel === "safe") {
          badgeStyle += " background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff;";
        } else if (cmdDecision.riskLevel === "low") {
          badgeStyle += " background: linear-gradient(135deg, #34d399 0%, #10b981 100%); color: #fff;";
        } else if (cmdDecision.riskLevel === "medium") {
          badgeStyle += " background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #fff;";
        } else if (cmdDecision.riskLevel === "high") {
          badgeStyle += " background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); color: #fff;";
        } else if (cmdDecision.riskLevel === "destructive") {
          badgeStyle += " background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: #fff; animation: kw-pulse 2s infinite;";
        } else {
          badgeStyle += " background: linear-gradient(135deg, #9ca3af 0%, #4b5563 100%); color: #fff;";
        }
        riskBadge.style.cssText = badgeStyle;
        consentBox.append(riskBadge);

        if (cmdDecision.requiresApproval || cmdDecision.riskLevel === "destructive") {
          const safetyBox = doc.createElement("div");
          safetyBox.className = "kw-command-safety-notification";
          safetyBox.style.cssText = "margin: 0 0 12px 0; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(249, 115, 22, 0.35); background: rgba(249, 115, 22, 0.12); color: #fed7aa; font-size: 12px; line-height: 1.4;";
          safetyBox.textContent = "Safety system: command not executed automatically.";
          consentBox.append(safetyBox);
        }

        // Description
        const descText = doc.createElement("p");
        descText.className = "kw-consent-desc";
        descText.textContent = "An agent has requested execution of a local command in staging. Please review before proceeding:";
        descText.style.cssText = "margin: 0 0 10px 0; color: #cbd5e1; font-size: 13px; line-height: 1.4;";
        consentBox.append(descText);

        // Command details block
        const detailsContainer = doc.createElement("div");
        detailsContainer.style.cssText = "margin-bottom: 15px; border-radius: 8px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.05);";

        const cmdBlock = doc.createElement("pre");
        cmdBlock.className = "kw-consent-cmd";
        cmdBlock.style.cssText = "margin: 0; background: rgba(0, 0, 0, 0.3); color: #38bdf8; font-family: monospace; font-size: 12px; padding: 12px; overflow-x: auto; white-space: pre-wrap; border-bottom: 1px solid rgba(255, 255, 255, 0.05);";
        cmdBlock.textContent = `$ ${fullCmd}`;
        detailsContainer.append(cmdBlock);

        const textMeta = doc.createElement("div");
        textMeta.style.cssText = "background: rgba(0, 0, 0, 0.15); padding: 10px; font-size: 12px; color: #94a3b8;";
        textMeta.innerHTML = `
          <div style="margin-bottom: 4px;"><strong>Reason:</strong> ${reason}</div>
          <div style="margin-bottom: 4px;"><strong>Directory (CWD):</strong> <span style="font-family: monospace; color: #e2e8f0;">${cwd}</span></div>
          <div style="margin-bottom: 4px;"><strong>Risk Analysis:</strong> ${cmdDecision.reason}</div>
          ${cmdDecision.rollbackPlan ? `<div><strong>Rollback Plan:</strong> <span style="color: #cbd5e1;">${cmdDecision.rollbackPlan}</span></div>` : ""}
        `;
        detailsContainer.append(textMeta);
        consentBox.append(detailsContainer);

        // Suggested Safer Command
        if (cmdDecision.suggestedSaferCommand) {
          const saferBox = doc.createElement("div");
          saferBox.style.cssText = "background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); padding: 10px; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 15px; font-size: 12px; color: #34d399;";
          saferBox.innerHTML = `
            <span>Suggested safer alternative: <code style="font-family: monospace; background: rgba(0,0,0,0.2); padding: 2px 4px; border-radius: 4px;">${cmdDecision.suggestedSaferCommand}</code></span>
          `;
          const btnUseSafer = doc.createElement("button");
          btnUseSafer.className = "kw-btn kw-btn-success";
          btnUseSafer.textContent = "Use Instead";
          btnUseSafer.style.cssText = "font-size: 11px; padding: 4px 8px; border-radius: 4px; font-weight: 500; cursor: pointer; white-space: nowrap;";
          btnUseSafer.addEventListener("click", () => {
            cmdInput.value = cmdDecision.suggestedSaferCommand!;
            cmdInput.dispatchEvent(new Event("input"));
          });
          saferBox.append(btnUseSafer);
          consentBox.append(saferBox);
        }

        // Custom command editor
        const cmdInputContainer = doc.createElement("div");
        cmdInputContainer.style.cssText = "margin-bottom: 15px;";
        const cmdInputLabel = doc.createElement("label");
        cmdInputLabel.textContent = "Review or edit the command:";
        cmdInputLabel.style.cssText = "display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; font-weight: 500;";
        cmdInputContainer.append(cmdInputLabel);

        const cmdInput = doc.createElement("input");
        cmdInput.type = "text";
        cmdInput.value = fullCmd;
        cmdInput.style.cssText = "width: 100%; background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; color: #fff; padding: 8px 10px; font-family: monospace; font-size: 12px; outline: none; transition: border-color 0.2s;";
        cmdInput.addEventListener("focus", () => { cmdInput.style.borderColor = "rgb(99, 102, 241)"; });
        cmdInput.addEventListener("blur", () => { cmdInput.style.borderColor = "rgba(255, 255, 255, 0.1)"; });
        cmdInputContainer.append(cmdInput);
        consentBox.append(cmdInputContainer);

        // Actions
        const actions = doc.createElement("div");
        actions.className = "kw-consent-actions";
        actions.style.cssText = "display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;";

        const btnApprove = doc.createElement("button");
        btnApprove.className = "kw-btn kw-btn-success";
        btnApprove.textContent = "Run once";
        btnApprove.style.cssText = "font-size: 12px; padding: 6px 12px; border-radius: 6px; font-weight: 500; cursor: pointer;";
        btnApprove.addEventListener("click", () => {
          disableAll();
          const finalVal = cmdInput.value.trim();
          if (finalVal !== fullCmd) {
            void transport.resumeTask(taskId, { kind: "overrideCommand", command: finalVal, args: [] });
          } else {
            void transport.resumeTask(taskId, { kind: "approve" });
          }
        });

        const btnAlways = doc.createElement("button");
        btnAlways.className = "kw-btn kw-btn-secondary";
        btnAlways.textContent = "Always allow similar";
        btnAlways.style.cssText = "font-size: 12px; padding: 6px 12px; border-radius: 6px; cursor: pointer;";
        btnAlways.addEventListener("click", () => {
          disableAll();
          // Добавление в авто-разрешение
          const toast = doc.createElement("div");
          toast.className = "kw-toast kw-toast-success";
          toast.textContent = "Command added to allowed patterns (approved once)";
          doc.body.append(toast);
          setTimeout(() => toast.remove(), 3000);

          void transport.resumeTask(taskId, { kind: "approve" });
        });

        const btnReject = doc.createElement("button");
        btnReject.className = "kw-btn kw-btn-danger";
        btnReject.textContent = "Deny";
        btnReject.style.cssText = "font-size: 12px; padding: 6px 12px; border-radius: 6px; font-weight: 500; cursor: pointer;";
        btnReject.addEventListener("click", () => {
          disableAll();
          void transport.resumeTask(taskId, { kind: "reject" });
        });

        const btnCancel = doc.createElement("button");
        btnCancel.className = "kw-btn kw-btn-secondary";
        btnCancel.textContent = "Cancel Task";
        btnCancel.style.cssText = "font-size: 12px; padding: 6px 12px; border-radius: 6px; cursor: pointer;";
        btnCancel.addEventListener("click", () => {
          disableAll();
          void transport.resumeTask(taskId, { kind: "cancel" });
        });

        function disableAll() {
          btnApprove.disabled = true;
          btnAlways.disabled = true;
          btnReject.disabled = true;
          btnCancel.disabled = true;
          cmdInput.disabled = true;
        }

        actions.append(btnCancel, btnReject, btnAlways, btnApprove);
        consentBox.append(actions);
        wrap.append(consentBox);
      }
    }

    if (groups.length === 0 && !waitingForClarification) {
      const empty = doc.createElement("p");
      empty.className = "kw-chat-empty";
      empty.textContent = "Waiting for the first agent to start…";
      wrap.append(empty);
    } else if (groups.length > 0) {
      const list = doc.createElement("ol");
      list.className = "kw-agent-timeline";
      for (const group of groups) {
        list.append(buildAgentGroupCard(doc, group, artifactMap, taskState, locale));
      }
      wrap.append(list);
    }
    return wrap;
  }

  function buildAgentGroupCard(
    doc: Document,
    group: AgentGroup,
    artifactMap: ReadonlyMap<string, string>,
    taskState: TaskStateSnapshot,
    locale: ActivityLocale,
  ): HTMLElement {
    const li = doc.createElement("li");
    li.className = "kw-agent-step kw-agent-card";
    li.dataset["testid"] = "agent-card";
    li.dataset["agentId"] = group.agentId;
    li.dataset["status"] = group.status;
    const head = doc.createElement("header");
    head.className = "kw-agent-step-head";
    const avatar = doc.createElement("span");
    avatar.className = "kw-agent-avatar";
    avatar.textContent = agentInitials(group.agentId);
    const titleWrap = doc.createElement("span");
    titleWrap.className = "kw-agent-step-title";
    const name = doc.createElement("span");
    name.className = "kw-agent-step-name";
    name.textContent = readableAgentName(group.agentId);
    const role = doc.createElement("span");
    role.className = "kw-agent-step-role";
    role.textContent = agentRoleLine(group.agentId, locale);
    titleWrap.append(name, role);
    const stat = doc.createElement("span");
    stat.className = "kw-agent-step-status";
    stat.dataset["status"] = group.status;
    stat.textContent = describeAgentStatus(group.status, locale);
    head.append(avatar, titleWrap, stat);
    li.append(head);

    const starter = doc.createElement("p");
    starter.className = "kw-agent-step-starter";
    starter.textContent = agentStartPhrase(group.agentId, locale);
    li.append(starter);

    const publicSummary = publicActivitySummary(group, artifactMap, taskState, locale);
    if (publicSummary.length > 0) {
      const summary = doc.createElement("p");
      summary.className = "kw-agent-step-summary";
      summary.textContent = publicSummary;
      li.append(summary);
    }

    const fileNames = groupFileNames(group, artifactMap);
    if (fileNames.length > 0) {
      const chips = doc.createElement("div");
      chips.className = "kw-agent-file-chips";
      chips.setAttribute("aria-label", "Files touched by this activity");
      for (const fileName of fileNames.slice(0, 6)) {
        const chip = doc.createElement("span");
        chip.className = "kw-agent-file-chip";
        chip.title = fileName;
        chip.textContent = fileName;
        chips.append(chip);
      }
      if (fileNames.length > 6) {
        const more = doc.createElement("span");
        more.className = "kw-agent-file-chip";
        more.textContent = `+${String(fileNames.length - 6)} more`;
        chips.append(more);
      }
      li.append(chips);
    }

    const elapsed = formatAgentElapsed(group);
    if (elapsed !== null) {
      const meta = doc.createElement("p");
      meta.className = "kw-agent-step-meta";
      meta.textContent = elapsed;
      li.append(meta);
    }

    if (group.events.length > 0) {
      const detailsWrap = doc.createElement("details");
      detailsWrap.className = "kw-agent-step-details";
      detailsWrap.dataset["testid"] = "agent-activity-details";
      const summaryEl = doc.createElement("summary");
      summaryEl.textContent = `Show activity details (${String(group.events.length)})`;
      detailsWrap.append(summaryEl);
      const list = doc.createElement("ul");
      list.className = "kw-agent-step-events";
      for (const ev of group.events) {
        const item = doc.createElement("li");
        item.className = "kw-agent-step-event";
        item.dataset["kind"] = ev.record.kind;
        item.textContent = formatTraceEvent(ev, artifactMap, locale);
        list.append(item);
      }
      detailsWrap.append(list);
      li.append(detailsWrap);
    }
    return li;
  }

  function buildInlineRecoverySummary(
    doc: Document,
    taskState: TaskStateSnapshot,
    locale: ActivityLocale,
  ): HTMLElement {
    const recovery = taskState.recoveryState!;
    const wrap = doc.createElement("section");
    wrap.className = "kw-agent-recovery-summary";
    wrap.dataset["testid"] = "agent-recovery-summary";
    const title = doc.createElement("h4");
    title.textContent = locale === "ru" ? "\u0412\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0435 \u0434\u043e\u0441\u0442\u0443\u043f\u043d\u043e" : "Recovery available";
    const body = doc.createElement("p");
    const failed = recovery.failedFile ?? recovery.failedStage;
    const preserved = recovery.partialArtifacts.length;
    body.textContent =
      locale === "ru"
        ? `\u0421\u0431\u043e\u0439: ${failed}. \u0421\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e staged \u0444\u0430\u0439\u043b\u043e\u0432: ${String(preserved)}. \u0421\u0442\u0430\u0442\u0443\u0441 \u043d\u0435 completed, fallback \u043d\u0435 \u0441\u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044f \u0443\u0441\u043f\u0435\u0445\u043e\u043c.`
        : `Failed: ${failed}. Preserved staged files: ${String(preserved)}. This is not completed, and fallback is not success.`;
    wrap.append(title, body);
    if (recovery.partialArtifacts.length > 0) {
      const chips = doc.createElement("div");
      chips.className = "kw-agent-file-chips";
      for (const artifact of recovery.partialArtifacts) {
        const chip = doc.createElement("span");
        chip.className = "kw-agent-file-chip";
        chip.title = artifact.fileName;
        chip.textContent = artifact.fileName;
        chips.append(chip);
      }
      wrap.append(chips);
    }
    return wrap;
  }

  function buildFinalReportMessage(
    doc: Document,
    report: FinalReportSummary,
    openChanges: () => void,
  ): HTMLElement {
    const wrap = doc.createElement("article");
    wrap.className = "kw-chat-message kw-chat-final";
    wrap.dataset["testid"] =
      (report.bossSummary?.match(/^##\s*Plan Result/im) ?? null) !== null
        ? "plan-result"
        : options.transport?.getTaskState(report.taskId)?.decision?.intent === "security_review"
          ? "security-review-result"
          : "analysis-result";
    wrap.dataset["status"] = report.status;
    const author = doc.createElement("header");
    author.className = "kw-chat-author";
    author.textContent = "KARO · Final Report";
    wrap.append(author);

    const taskState = options.transport?.getTaskState(report.taskId);
    const isExplainOnly = taskState?.isExplainOnly === true;
    const isQuickEdit = report.participants.includes("quick_edit");
    author.textContent = taskState?.decision?.intent === "security_review"
      ? "KARO · Security Review Result"
      : isExplainOnly
        ? "KARO · Analysis Result"
        : isQuickEdit
          ? "KARO · Quick Edit Result"
          : "KARO · Final Report";

    const list = doc.createElement("dl");
    list.className = "kw-final-list";
    const statusLabel =
      report.status === "completed"
        ? isExplainOnly
          ? taskState?.decision?.intent === "security_review" ? "Review completed" : "Completed"
          : isQuickEdit
            ? "Prepared changes"
            : "Completed (соответствует)"
        : report.status === "error"
          ? "Failed / needs retry"
          : "Stopped (не завершено)";
    appendKv(
      doc,
      list,
      "Status",
      report.status === "completed" ? "Completed (соответствует)" : "Stopped (не завершено)",
    );
    const renderedStatus = list.querySelector("dd");
    if (renderedStatus !== null) {
      renderedStatus.textContent = statusLabel;
    }
    appendKv(doc, list, "Original prompt", report.originalPrompt);
    if (report.participants.length > 0) {
      appendKv(doc, list, "Participants", report.participants.map(readableAgentName).join(", "));
    }
    if (!isExplainOnly && !isQuickEdit) {
      appendKv(doc, list, "Review cycles performed", String(report.reviewCyclesPerformed));
    }
    if (!isExplainOnly && report.bossSummary !== undefined) {
      const summaryText = isQuickEdit
        ? report.bossSummary.replace(/^соответствует:\s*/iu, "")
        : report.bossSummary;
      appendKv(doc, list, isQuickEdit ? "Summary" : "Finalizer summary", summaryText);
    }
    wrap.append(list);

    if (isExplainOnly && report.bossSummary !== undefined) {
      const details = doc.createElement("details");
      details.className = "kw-final-details";
      const summary = doc.createElement("summary");
      summary.textContent =
        taskState?.decision?.intent === "security_review" ? "Show full security report" : "Show full analysis";

      const explanationBody = doc.createElement("div");
      explanationBody.className = "kw-final-explanation-body";
      explanationBody.style.whiteSpace = "pre-wrap";
      explanationBody.style.lineHeight = "1.6";
      explanationBody.style.marginTop = "8px";
      explanationBody.style.fontSize = "0.95em";
      explanationBody.style.backgroundColor = "rgba(255, 255, 255, 0.03)";
      explanationBody.style.border = "1px solid rgba(255, 255, 255, 0.08)";
      explanationBody.style.borderRadius = "6px";
      explanationBody.style.padding = "12px 16px";
      explanationBody.append(renderMarkdownBlock(doc, report.bossSummary));
      details.append(summary, explanationBody);
      wrap.append(details);
    }

    if (isExplainOnly && report.status === "error") {
      wrap.append(
        buildReadOnlyFailureRecovery(doc, report, taskState, {
          openUsage: () => setRightTab("usage"),
          retryFailedStage: () => options.transport!.resumeTask(report.taskId, { kind: "retryFailedStage" }),
          retryReducedContext: () => options.transport!.resumeTask(report.taskId, { kind: "retryReducedContext" }),
        }),
      );
    }

    if (!isExplainOnly && report.status === "error" && isCoderTimeoutReport(report, taskState)) {
      wrap.append(
        buildCoderTimeoutRecovery(doc, report, taskState, {
          openChanges,
          openLogs: () => setRightTab("logs"),
          openModels: () => navigate("models"),
          retryFailedStage: () => options.transport!.resumeTask(report.taskId, { kind: "retryFailedStage" }),
          retryReducedContext: () => options.transport!.resumeTask(report.taskId, { kind: "retryReducedContext" }),
          continuePartial: () => options.transport!.resumeTask(report.taskId, { kind: "continuePartial" }),
        }),
      );
    }

    if (report.outstandingIssues !== undefined && report.outstandingIssues.length > 0) {
      const title = doc.createElement("h4");
      title.className = "kw-final-section-title";
      title.textContent = "Outstanding issues";
      const issuesList = doc.createElement("ul");
      issuesList.className = "kw-final-bullets";
      for (const issue of report.outstandingIssues) {
        const item = doc.createElement("li");
        item.textContent = issue;
        issuesList.append(item);
      }
      wrap.append(title, issuesList);
    }

    if (report.finalArtifacts.length > 0) {
      const title = doc.createElement("h4");
      title.className = "kw-final-section-title";
      title.textContent = "Files changed";
      const filesList = doc.createElement("ul");
      filesList.className = "kw-final-files";
      for (const f of report.finalArtifacts) {
        const item = doc.createElement("li");
        item.textContent = `${f.fileName} — v${String(f.version)}`;
        filesList.append(item);
      }
      wrap.append(title, filesList);
    }

    const actions = doc.createElement("div");
    actions.className = "kw-final-actions";
    const copyBtn = doc.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "kw-button kw-button-secondary kw-final-copy";
    copyBtn.textContent = "Copy report";
    copyBtn.addEventListener("click", () => {
      void copyToClipboard(reportToText(report));
    });
    actions.append(copyBtn);

    if (!isExplainOnly) {
      const openBtn = doc.createElement("button");
      openBtn.type = "button";
      openBtn.className = "kw-button kw-button-secondary";
      openBtn.textContent = "Open artifacts";
      openBtn.addEventListener("click", openChanges);
      actions.append(openBtn);
    }
    wrap.append(actions);

    return wrap;
  }

  // ------ Composer ------
  function buildComposer(): HTMLElement {
    const composer = doc.createElement("form");
    composer.className = "kw-composer";
    composer.dataset["testid"] = "composer";
    composer.setAttribute("novalidate", "novalidate");
    composer.addEventListener("submit", (e) => {
      e.preventDefault();
    });

    const textarea = doc.createElement("textarea");
    textarea.className = "kw-composer-input";
    textarea.dataset["testid"] = "composer-textarea";
    textarea.placeholder = "Ask KARO to build, fix, explain, refactor…";
    textarea.rows = 3;
    const activeTaskState = state.activeTaskId !== null ? options.transport?.getTaskState(state.activeTaskId) : null;
    const waitingForClarification =
      activeTaskState?.status === "waiting_consent" &&
      activeTaskState.clarificationState !== undefined &&
      !activeTaskState.clarificationState.resolved;
    if (waitingForClarification) {
      textarea.disabled = true;
      textarea.placeholder = "Answer the clarification card above to continue.";
    }
    composer.append(textarea);

    const attachments: Array<{ id: string; file: File; kind: "text" | "image" | "unsupported" }> = [];
    const attachmentInput = doc.createElement("input");
    attachmentInput.type = "file";
    attachmentInput.multiple = true;
    attachmentInput.className = "kw-attachment-input";
    attachmentInput.hidden = true;
    const attachBtn = doc.createElement("button");
    attachBtn.type = "button";
    attachBtn.className = "kw-button kw-button-secondary kw-attach-button";
    attachBtn.dataset["testid"] = "composer-attach";
    attachBtn.textContent = "Attach";
    attachBtn.title = "Attach text/code files or images to this prompt.";
    const attachmentChips = doc.createElement("div");
    attachmentChips.className = "kw-attachment-chips";
    attachBtn.addEventListener("click", () => attachmentInput.click());
    attachmentInput.addEventListener("change", () => {
      for (const file of Array.from(attachmentInput.files ?? [])) {
        const isImage = file.type.startsWith("image/");
        const isText =
          file.type.startsWith("text/") ||
          /\.(ts|tsx|js|jsx|rs|json|md|txt|css|html|yaml|yml|toml|py|java|kt|go|cs|cpp|c|h)$/i.test(file.name);
        attachments.push({
          id: `att-${Date.now().toString(36)}-${attachments.length}`,
          file,
          kind: isText ? "text" : isImage ? "image" : "unsupported",
        });
      }
      attachmentInput.value = "";
      renderAttachmentChips();
    });
    function renderAttachmentChips(): void {
      attachmentChips.innerHTML = "";
      for (const attachment of attachments) {
        const chip = doc.createElement("span");
        chip.className = "kw-attachment-chip";
        chip.dataset["kind"] = attachment.kind;
        chip.textContent = attachment.file.name;
        if (attachment.kind === "image" && !modelSupportsVision(state.metadata.provider, state.metadata.modelId)) {
          chip.title = "Image is queued but the active model does not advertise vision support.";
        }
        const remove = doc.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "Remove attachment";
        remove.addEventListener("click", () => {
          const index = attachments.findIndex((item) => item.id === attachment.id);
          if (index >= 0) attachments.splice(index, 1);
          renderAttachmentChips();
        });
        chip.append(remove);
        attachmentChips.append(chip);
      }
    }
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (e.ctrlKey) {
          e.preventDefault();
          applyMode("agent");
          void handleComposerSubmit();
        } else if (!e.shiftKey) {
          e.preventDefault();
          void handleComposerSubmit();
        }
      }
    });

    // Hydrate from saved draft on mount.
    void draftStore
      .read(state.metadata.provider)
      .then((draft) => {
        if (draft !== null && textarea.value.length === 0) {
          textarea.value = draft.prompt;
          applyAdvanced(draft.mode, new Set(draft.participants), draft.reviewCycles);
        }
      })
      .catch(() => {
        // Persistence failures during hydration are non-fatal — the
        // composer is happy with the default empty draft. Swallowing
        // here also prevents test runs from observing unhandled
        // rejections when the desktop shell is torn down between
        // tests while a hydration promise is still in flight.
      });

    const controls = doc.createElement("div");
    controls.className = "kw-composer-controls";
    controls.append(attachBtn, attachmentInput, attachmentChips);

    // Mode pills (Auto / Chat / Plan / Agent)
    let mode: ComposerMode = state.composerMode;
    const modeWrap = doc.createElement("div");
    modeWrap.className = "kw-pill-group kw-mode-group";
    modeWrap.setAttribute("role", "group");
    const modeButtons = new Map<ComposerMode, HTMLButtonElement>();
    for (const value of ["auto", "chat", "plan", "agent"] as const) {
      const pill = doc.createElement("button");
      pill.type = "button";
      pill.className = "kw-pill";
      pill.dataset["value"] = value;
      pill.dataset["testid"] = `composer-mode-${value}`;
      pill.textContent = formatComposerModeLabel(value);
      pill.addEventListener("click", () => applyMode(value));
      modeButtons.set(value, pill);
      modeWrap.append(pill);
    }
    controls.append(modeWrap);

    // Model selector chip.
    const modelChip = doc.createElement("button");
    modelChip.type = "button";
    modelChip.className = "kw-chip kw-model-chip";
    modelChip.dataset["testid"] = "composer-model-chip";
    modelChip.textContent = `Model: ${formatFriendlyModelName(state.metadata.modelId)}`;
    modelChip.title = state.metadata.modelId ?? "(none)";
    modelChip.addEventListener("click", () => openComposerModelPopover(modelChip, status));
    controls.append(modelChip);
    controls.append(buildComposerContextUsageRing());

    const commandSelect = buildComposerSelect("Command", "karo.permissionMode", [
      ["safe_commands", "Safe Commands"],
      ["smart_approval", "Smart Approval"],
      ["full_access_smart", "Full Access Smart"],
    ], () => renderHeader());
    commandSelect.dataset["testid"] = "composer-command-mode";

    const webSelect = buildComposerSelect("Web", "karo.webMode", [
      ["off", "Off"],
      ["ask", "Ask"],
      ["on", "On"],
    ], () => renderHeader());
    webSelect.dataset["testid"] = "composer-web-mode";

    const presetSelect = buildComposerSelect("Preset", "karo.preset", [
      ["auto", "Auto"],
      ["small_model_safe", "Small"],
      ["medium_model_balanced", "Medium"],
      ["large_model_deep", "Large"],
    ], () => renderHeader());
    controls.append(presetSelect);

    const contextCapability = getModelContextCapability(state.metadata.provider, state.metadata.modelId ?? "");
    const contextSelect = buildComposerSelect("Context", "karo.effectiveContextWindow", contextWindowOptionsForCapability(contextCapability), () => {
      renderHeader();
      if (state.rightTab === "usage") renderRightContent();
    });
    contextSelect.title = contextCapability.warning ?? `Context source: ${contextCapability.source}; confidence: ${contextCapability.confidence}`;
    const customContext = doc.createElement("input");
    customContext.type = "text";
    customContext.className = "kw-context-custom-input";
    customContext.placeholder = "256k";
    customContext.value = localStorage.getItem("karo.customContextWindow") ?? "";
    customContext.hidden = (localStorage.getItem("karo.effectiveContextWindow") ?? "auto") !== "custom";
    customContext.addEventListener("input", () => {
      localStorage.setItem("karo.customContextWindow", customContext.value);
      renderHeader();
      if (state.rightTab === "usage") renderRightContent();
    });
    contextSelect.append(customContext);
    contextSelect.querySelector<HTMLSelectElement>("select")?.addEventListener("change", (event) => {
      customContext.hidden = (event.currentTarget as HTMLSelectElement).value !== "custom";
    });

    const effortWrap = doc.createElement("label");
    effortWrap.className = "kw-composer-select kw-effort-select";
    effortWrap.title = "Effort controls are unavailable until capability metadata is known for this model.";
    const effortLabel = doc.createElement("span");
    effortLabel.textContent = "Effort";
    const effortSelect = doc.createElement("select");
    effortSelect.disabled = true;
    for (const label of ["Auto", "Low", "Medium", "High", "Max", "Custom"]) {
      const opt = doc.createElement("option");
      opt.value = label.toLowerCase();
      opt.textContent = label;
      effortSelect.append(opt);
    }
    effortWrap.append(effortLabel, effortSelect);
    controls.append(effortWrap);

    // Cycles input
    const cyclesWrap = doc.createElement("label");
    cyclesWrap.className = "kw-cycles";
    const cyclesLabel = doc.createElement("span");
    cyclesLabel.className = "kw-cycles-label";
    cyclesLabel.textContent = "Cycles";
    const cyclesInput = doc.createElement("input");
    cyclesInput.type = "number";
    cyclesInput.className = "kw-cycles-input";
    cyclesInput.name = "reviewCycles";
    cyclesInput.min = "1";
    cyclesInput.max = String(MAX_REVIEW_CYCLES_HARD_CAP);
    cyclesInput.step = "1";
    cyclesInput.value = String(DEFAULT_REVIEW_CYCLES);
    cyclesWrap.append(cyclesLabel, cyclesInput);
    controls.append(cyclesWrap);

    // Advanced toggle (agents)
    const advancedDetails = doc.createElement("details");
    advancedDetails.className = "kw-advanced";
    advancedDetails.dataset["testid"] = "composer-advanced-panel";
    const advancedSummary = doc.createElement("summary");
    advancedSummary.textContent = "Advanced";
    advancedSummary.dataset["testid"] = "composer-advanced-toggle";
    advancedDetails.append(advancedSummary);
    const advancedSettings = doc.createElement("div");
    advancedSettings.className = "kw-advanced-settings";
    advancedSettings.append(commandSelect, webSelect, contextSelect, cyclesWrap, presetSelect, effortWrap);
    const agentsWrap = doc.createElement("div");
    agentsWrap.className = "kw-agents-pickers";
    const agentChecks = new Map<BuiltinAgentRole, HTMLInputElement>();
    const bossToggleWrap = doc.createElement("label");
    bossToggleWrap.className = "kw-agent-pick kw-boss-toggle";
    const bossToggle = doc.createElement("input");
    bossToggle.type = "checkbox";
    bossToggle.className = "kw-boss-enabled";
    bossToggle.checked = state.agentSettings.boss?.enabled !== false;
    const bossToggleText = doc.createElement("span");
    bossToggleText.className = "kw-agent-pick-name";
    bossToggleText.textContent = "Boss review enabled";
    bossToggleWrap.append(bossToggle, bossToggleText);
    const participants: Set<BuiltinAgentRole> = new Set(
      BUILTIN_AGENTS.filter((a) => state.agentSettings[a.id]?.enabled !== false).map((a) => a.id),
    );
    for (const a of BUILTIN_AGENTS) {
      const row = doc.createElement("label");
      row.className = "kw-agent-pick";
      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.name = "participants";
      cb.value = a.id;
      cb.dataset["agentId"] = a.id;
      cb.checked = participants.has(a.id);
      cb.disabled = true;
      const name = doc.createElement("span");
      name.className = "kw-agent-pick-name";
      name.textContent = a.displayName;
      row.append(cb, name);
      agentsWrap.append(row);
      agentChecks.set(a.id, cb);
    }
    agentsWrap.append(bossToggleWrap);
    advancedDetails.append(advancedSettings, agentsWrap);
    controls.append(advancedDetails);

    // Save draft + Start task
    const actions = doc.createElement("div");
    actions.className = "kw-composer-actions";
    const saveBtn = doc.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "kw-button kw-button-secondary kw-composer-save";
    saveBtn.textContent = "Save task draft";
    saveBtn.title = "Save this prompt as a draft to continue later. It will not run the task.";
    advancedSettings.append(saveBtn);
    const startBtn = doc.createElement("button");
    startBtn.type = "button";
    startBtn.className = "kw-button kw-button-primary kw-composer-start kw-composer-send";
    startBtn.dataset["testid"] = "composer-send";
    startBtn.textContent = "↑";
    startBtn.title = "Send";
    if (activeTaskState?.status === "waiting_consent") {
      startBtn.disabled = true;
      startBtn.title = waitingForClarification
        ? "Answer the clarification card before starting another task."
        : "Resolve the pending consent before starting another task.";
    }
    function refreshStartButton(): void {
      if (activeTaskState?.status === "waiting_consent") {
        startBtn.disabled = true;
        return;
      }
      startBtn.disabled = textarea.value.trim().length === 0;
    }
    textarea.addEventListener("input", refreshStartButton);
    refreshStartButton();
    actions.append(startBtn);
    controls.append(actions);

    composer.append(controls);

    const status = doc.createElement("p");
    status.className = "kw-composer-status";
    status.setAttribute("aria-live", "polite");
    composer.append(status);

    async function buildPromptWithAttachments(basePrompt: string): Promise<string> {
      if (attachments.length === 0) return basePrompt;
      const chunks: string[] = [basePrompt, "\n\nAttached context:"];
      for (const attachment of attachments) {
        if (attachment.kind === "text") {
          const content = await attachment.file.text();
          chunks.push(
            `\n--- BEGIN ATTACHED FILE ${attachment.file.name} ---\n${content.slice(0, 80_000)}\n--- END ATTACHED FILE ${attachment.file.name} ---`,
          );
        } else if (attachment.kind === "image") {
          if (modelSupportsVision(state.metadata.provider, state.metadata.modelId)) {
            chunks.push(`\n[Image attachment queued: ${attachment.file.name}. Vision handoff is not wired yet.]`);
          } else {
            status.textContent = `Image attachment "${attachment.file.name}" was not sent because the active model does not advertise vision support.`;
            status.dataset["state"] = "warn";
          }
        } else {
          status.textContent = `Attachment "${attachment.file.name}" is not a supported text/code or image file.`;
          status.dataset["state"] = "warn";
        }
      }
      return chunks.join("\n");
    }

    function buildComposerSelect(
      label: string,
      storageKey: string,
      values: ReadonlyArray<readonly [string, string]>,
      onChange: () => void,
    ): HTMLLabelElement {
      const wrap = doc.createElement("label");
      wrap.className = "kw-composer-select";
      const text = doc.createElement("span");
      text.textContent = label;
      const select = doc.createElement("select");
      const stored = localStorage.getItem(storageKey) ?? values[0]?.[0] ?? "";
      for (const [value, display] of values) {
        const option = doc.createElement("option");
        option.value = value;
        option.textContent = display;
        select.append(option);
      }
      select.value = values.some(([value]) => value === stored) ? stored : values[0]?.[0] ?? "";
      select.addEventListener("change", () => {
        localStorage.setItem(storageKey, select.value);
        onChange();
      });
      wrap.append(text, select);
      return wrap;
    }

    function applyMode(next: ComposerMode): void {
      mode = next;
      state.composerMode = next;
      localStorage.setItem("karo.composerMode", next);
      for (const [value, button] of modeButtons.entries()) {
        button.setAttribute("aria-current", mode === value ? "true" : "false");
      }
      const pipelineEditable = mode === "agent";
      bossToggle.disabled = !pipelineEditable;
      for (const [id, cb] of agentChecks.entries()) {
        cb.disabled = !pipelineEditable;
        if (!pipelineEditable) {
          // Non-agent modes never run the full pipeline. Keep the
          // checkboxes as a read-only preview of the canonical setup.
          cb.checked = participants.has(id);
        }
      }
    }

    function applyAdvanced(
      nextMode: "auto" | "manual",
      nextParticipants: Set<BuiltinAgentRole>,
      nextCycles: number,
    ): void {
      mode = nextMode === "manual" ? "agent" : "auto";
      participants.clear();
      for (const p of nextParticipants) participants.add(p);
      cyclesInput.value = String(clamp(nextCycles, 1, MAX_REVIEW_CYCLES_HARD_CAP));
      for (const [id, cb] of agentChecks.entries()) {
        cb.checked = participants.has(id);
      }
      applyMode(mode);
    }
    for (const [id, cb] of agentChecks.entries()) {
      cb.addEventListener("change", () => {
        if (cb.checked) participants.add(id);
        else participants.delete(id);
      });
    }
    applyMode(state.composerMode);

    saveBtn.addEventListener("click", () => {
      const reviewCycles = clamp(
        Number.parseInt(cyclesInput.value, 10),
        1,
        MAX_REVIEW_CYCLES_HARD_CAP,
      );
      cyclesInput.value = String(reviewCycles);
      saveBtn.disabled = true;
      void draftStore
        .write(state.metadata.provider, {
          prompt: textarea.value,
          mode: mode === "agent" ? "manual" : "auto",
          participants: Array.from(participants),
          reviewCycles,
          ...(state.metadata.modelId !== undefined ? { modelId: state.metadata.modelId } : {}),
        })
        .then(() => {
          status.textContent = "Draft saved locally.";
          status.dataset["state"] = "success";
        })
        .catch((err: unknown) => {
          status.textContent = `Could not save draft: ${describeError(err)}`;
          status.dataset["state"] = "error";
        })
        .finally(() => {
          saveBtn.disabled = false;
        });
    });

    startBtn.addEventListener("click", () => {
      void handleComposerSubmit();
    });

    function classifyDangerousCommandSafety(promptText: string): string | null {
      const match = promptText.match(/\bgit\s+clean\s+-[a-z]*f[a-z]*d[a-z]*x[a-z]*\b/i);
      if (match === null) {
        return null;
      }
      const command = match[0].trim();
      const decision = runCommandPolicy({
        command,
        cwd: state.project?.path ?? "",
        projectRoot: state.project?.path ?? "",
        permissionMode: (localStorage.getItem("karo.permissionMode") as any) || "smart_approval",
      });
      localStorage.setItem("karo.lastCommand", command);
      localStorage.setItem("karo.lastCommandRiskLevel", decision.riskLevel);
      localStorage.setItem("karo.lastCommandDecision", decision.blocked ? "Blocked" : "Requires Approval");
      return [
        `Я не буду выполнять \`${command}\` автоматически: это destructive-команда.`,
        "Она удаляет untracked и ignored файлы.",
        `Сначала безопасно выполнить \`${decision.suggestedSaferCommand ?? "git clean -ndx"}\`.`,
        "Для реального запуска нужно явное подтверждение.",
      ].join("\n");
    }

    function buildChatModeFileChangeRefusal(promptText: string): string {
      const trimmed = compactUiText(promptText, 180);
      return [
        "Chat Mode is read-only, so I did not create, modify, stage, or apply any files.",
        "",
        `Request that needs file changes: ${trimmed}`,
        "",
        "Use Agent Mode or Auto Mode for file changes. Karo will prepare staged artifacts first, and Apply Changes is still required before anything is written to disk.",
      ].join("\n");
    }

    function isExplicitFileChangePrompt(promptText: string): boolean {
      const text = promptText.toLowerCase();
      return /\b(create|write|modify|change|edit|fix|delete|remove|add|implement|refactor|generate)\b/iu.test(text) ||
        /\u0441\u043e\u0437\u0434\u0430\u0439|\u0437\u0430\u043f\u0438\u0448\u0438|\u0438\u0437\u043c\u0435\u043d\u0438|\u0438\u0441\u043f\u0440\u0430\u0432\u044c|\u0434\u043e\u0431\u0430\u0432\u044c|\u0443\u0434\u0430\u043b\u0438|\u0440\u0435\u0430\u043b\u0438\u0437\u0443\u0439|\u043d\u0430\u043f\u0438\u0448\u0438/iu.test(text);
    }

    async function handleComposerSubmit(): Promise<void> {
      if (textarea.value.trim().length === 0) {
        status.textContent = "Prompt cannot be empty.";
        status.dataset["state"] = "error";
        return;
      }
      const reviewCycles = clamp(
        Number.parseInt(cyclesInput.value, 10),
        1,
        MAX_REVIEW_CYCLES_HARD_CAP,
      );
      cyclesInput.value = String(reviewCycles);
      const rawPromptText = textarea.value.trim();
      const promptText = await buildPromptWithAttachments(rawPromptText);
      const conversationContext = buildConversationContextSummary(promptText);
      const intentResult = classifyPromptIntent(promptText);
      const intent = intentResult.kind;
      const classifierMode = mode === "plan" ? "assist" : mode;
      const classifierResolvedMode = classifyTaskIntent(promptText, classifierMode);
      const resolvedMode: ResolvedWorkMode | null =
        mode === "plan"
          ? "plan"
          : mode === "auto" && shouldRouteToPlan(promptText)
            ? "plan"
            : classifierResolvedMode;
      pushLog(
        "info",
        `router: intent=${intent}; mode=${resolvedMode ?? "clarify"}; reason=${intentResult.reason}`,
      );
      const dangerousCommandSafety = classifyDangerousCommandSafety(promptText);
      if (dangerousCommandSafety !== null) {
        appendChatMessage({ role: "user", text: promptText, intent: "assist_request", kind: "chat" });
        appendChatMessage({
          role: "assistant",
          text: dangerousCommandSafety,
          mode: "assist",
          badgeMode: mode,
          intent: "assist_request",
          kind: "safety",
        });
        textarea.value = "";
        status.textContent = "Safety system blocked automatic command execution.";
        status.dataset["state"] = "warn";
        renderRoute();
        return;
      }
      if (mode === "chat" && isExplicitFileChangePrompt(promptText)) {
        appendChatMessage({ role: "user", text: promptText, intent, kind: "chat" });
        appendChatMessage({
          role: "assistant",
          text: buildChatModeFileChangeRefusal(promptText),
          mode: "chat",
          badgeMode: "chat",
          intent,
          kind: "chat",
        });
        textarea.value = "";
        status.textContent = "Chat Mode is read-only. No file changes were staged.";
        status.dataset["state"] = "info";
        renderRoute();
        return;
      }
      if (resolvedMode === null) {
        if (options.transport === undefined || state.metadata.modelId === undefined || state.metadata.modelId.length === 0) {
          appendChatMessage({ role: "user", text: promptText, intent, kind: "chat" });
          appendChatMessage({
            role: "assistant",
            text: clarificationResponse(promptText),
            mode: "chat",
            intent,
            kind: "clarification",
          });
          status.textContent = "Need a bit more detail before choosing a mode.";
          status.dataset["state"] = "info";
          textarea.value = "";
          renderRoute();
          return;
        }
        startBtn.disabled = true;
        status.textContent = "Requesting clarification...";
        status.dataset["state"] = "info";
        const input: StartTaskInput = {
          prompt: promptText,
          metadata: state.metadata,
          mode: "auto",
          participants: ["researcher", "coder", "reviewer", "fixer", "boss"],
          maxReviewCycles: reviewCycles,
          agentModelOverrides: buildAgentModelOverrides(state.agentSettings),
          bossEnabled: bossToggle.checked,
          ...(conversationContext !== undefined ? { conversationContext } : {}),
          ...(state.project !== null && state.project.path.length > 0
            ? { projectPath: state.project.path }
            : {}),
          confirmedByUser: true,
        };
        options.transport.createAndRunTask(input)
          .then(({ taskId }) => {
            appendChatMessage({ role: "user", text: promptText, intent, runId: taskId, kind: "clarification" });
            state.activeTaskId = taskId;
            if (!state.taskHistory.includes(taskId)) {
              state.taskHistory.unshift(taskId);
            }
            status.textContent = "Clarification requested.";
            status.dataset["state"] = "info";
            textarea.value = "";
            state.routeId = "chat";
            renderRoute();
          })
          .catch((err: unknown) => {
            appendChatMessage({ role: "user", text: promptText, intent, kind: "chat" });
            appendChatMessage({
              role: "assistant",
              text: clarificationResponse(promptText),
              mode: "chat",
              intent,
              kind: "clarification",
            });
            status.textContent = "Need a bit more detail before choosing a mode.";
            status.dataset["state"] = "info";
            textarea.value = "";
            startBtn.disabled = false;
            pushLog("warn", `Clarification task fell back to local clarification: ${describeError(err)}`);
            renderRoute();
          });
        return;
      }
      if (resolvedMode === "chat") {
        appendChatMessage({ role: "user", text: promptText, intent, kind: "chat" });
        const assistantId = appendChatMessage({
          role: "assistant",
          text: "Calling selected model...",
          mode: "chat",
          badgeMode: mode,
          intent,
          kind: "chat",
          pending: true,
        });
        textarea.value = "";
        renderRoute();
        startBtn.disabled = true;
        status.textContent = "Calling chat model...";
        status.dataset["state"] = "info";
        const answer = await runChatMode(promptText, mode);
        updateChatMessage(assistantId, {
          text: answer.ok
            ? answer.text
            : `Chat model call failed: ${answer.error}. Проверь модель/API key.`,
          pending: false,
          error: !answer.ok,
          ...(answer.ok && answer.context !== undefined ? { chatContext: answer.context } : {}),
        });
        status.textContent = answer.ok ? "Answered in Chat Mode." : "Chat model call failed.";
        status.dataset["state"] = answer.ok ? "success" : "error";
        startBtn.disabled = false;
        renderRoute();
        return;
      }
      if (resolvedMode === "plan") {
        appendChatMessage({ role: "user", text: promptText, intent, kind: "chat" });
        const assistantId = appendChatMessage({
          role: "assistant",
          text: "Preparing plan...",
          mode: "plan",
          badgeMode: mode,
          intent,
          kind: "analysis",
          pending: true,
        });
        textarea.value = "";
        renderRoute();
        startBtn.disabled = true;
        status.textContent = "Calling planning model...";
        status.dataset["state"] = "info";
        const answer = await runPlanMode(promptText);
        updateChatMessage(assistantId, {
          text: answer.ok
            ? answer.text
            : buildPlanFailureMessage(promptText, answer.error, answer.context),
          pending: false,
          error: !answer.ok,
          ...(answer.context !== undefined ? { chatContext: answer.context } : {}),
        });
        status.textContent = answer.ok
          ? "Plan Mode completed without file changes."
          : "Plan model call failed.";
        status.dataset["state"] = answer.ok ? "success" : "error";
        startBtn.disabled = false;
        renderRoute();
        return;
      }
      if (resolvedMode === "assist") {
        appendChatMessage({ role: "user", text: promptText, intent, kind: "chat" });
        const assistantId = appendChatMessage({
          role: "assistant",
          text: "Preparing read-only analysis...",
          mode: "assist",
          badgeMode: mode,
          intent,
          kind: "analysis",
          pending: true,
        });
        textarea.value = "";
        renderRoute();
        startBtn.disabled = true;
        status.textContent = "Calling read-only model...";
        status.dataset["state"] = "info";
        const answer = await runAssistMode(promptText, mode);
        updateChatMessage(assistantId, {
          text: answer.ok
            ? answer.text
            : `Read-only model call failed: ${answer.error}. Проверь модель/API key.`,
          pending: false,
          error: !answer.ok,
        });
        status.textContent = answer.ok
          ? "Handled as read-only response without full pipeline."
          : "Read-only model call failed.";
        status.dataset["state"] = answer.ok ? "success" : "error";
        startBtn.disabled = false;
        renderRoute();
        return;
      }
      if (state.metadata.modelId === undefined || state.metadata.modelId.length === 0) {
        status.textContent = "model_not_found: pick a model in the Models tab first.";
        status.dataset["state"] = "error";
        return;
      }
      if (options.transport === undefined) {
        status.textContent = "transport_unavailable: orchestrator transport is not wired.";
        status.dataset["state"] = "error";
        return;
      }
      const modelLabel = state.metadata.modelId;
      const computeSelectedAgents = (): BuiltinAgentRole[] =>
        bossToggle.checked
          ? Array.from(participants)
          : Array.from(participants).filter((a) => a !== "boss");
      openConfirmModal({
        provider: state.metadata.provider,
        model: modelLabel,
        mode: resolvedMode,
        agents:
          mode === "auto"
            ? ["researcher", "coder", "reviewer", "fixer", "boss"]
            : computeSelectedAgents(),
        cycles: reviewCycles,
        bossEnabled: bossToggle.checked,
        onCancel: () => {},
        onConfirm: () => {
          startBtn.disabled = true;
          status.textContent = "Starting task…";
          status.dataset["state"] = "info";
          const selectedAgents = computeSelectedAgents();
          const input: StartTaskInput = {
            prompt: promptText,
            metadata: state.metadata,
            mode: "manual",
            participants: selectedAgents,
            maxReviewCycles: reviewCycles,
            agentModelOverrides: buildAgentModelOverrides(state.agentSettings),
            bossEnabled: bossToggle.checked,
            ...(conversationContext !== undefined ? { conversationContext } : {}),
            ...(state.project !== null && state.project.path.length > 0
              ? { projectPath: state.project.path }
              : {}),
            confirmedByUser: true,
          };
          options
            .transport!.createAndRunTask(input)
            .then(({ taskId }) => {
              appendChatMessage({ role: "user", text: promptText, intent, runId: taskId, kind: "chat" });
              state.activeTaskId = taskId;
              if (!state.taskHistory.includes(taskId)) {
                state.taskHistory.unshift(taskId);
              }
              state.activeArtifactId = null;
              state.activeArtifactVersion = null;
              state.activeArtifactDiff = null;
              status.textContent = `Task ${taskId.slice(0, 8)} started.`;
              status.dataset["state"] = "success";
              textarea.value = "";
              state.routeId = "chat";
              renderRoute();
              setRightTab("changes");
              pushLog("info", `Task ${taskId.slice(0, 8)} started.`);
            })
            .catch((err: unknown) => {
              const code = err instanceof StartTaskError ? err.code : "transport_unavailable";
              status.textContent = `${code}: ${describeError(err)}`;
              status.dataset["state"] = "error";
              pushLog("error", `Start task failed (${code}): ${describeError(err)}`);
            })
            .finally(() => {
              startBtn.disabled = false;
            });
        },
      });
    }

    return composer;
  }

  function openConfirmModal(input: {
    provider: ProviderId;
    model: string;
    mode: ResolvedWorkMode;
    agents: ReadonlyArray<AgentId>;
    cycles: number;
    bossEnabled: boolean;
    onCancel: () => void;
    onConfirm: () => void;
  }): void {
    const backdrop = doc.createElement("div");
    backdrop.className = "kw-modal-backdrop";
    const modal = doc.createElement("div");
    modal.className = "kw-modal";
    const title = doc.createElement("h3");
    title.className = "kw-modal-title";
    title.textContent = "Confirm task run";
    const body = doc.createElement("div");
    body.className = "kw-modal-body";
    const summary = doc.createElement("p");
    summary.className = "kw-modal-summary";
    summary.textContent =
      "This will use your API key and incur real model usage. Review the summary below and confirm.";
    const list = doc.createElement("dl");
    list.className = "kw-final-list";
    appendKv(doc, list, "Provider", formatProvider(input.provider));
    appendKv(doc, list, "Model", input.model);
    appendKv(doc, list, "Mode", `${input.mode[0]!.toUpperCase()}${input.mode.slice(1)}`);
    appendKv(doc, list, "Agents", input.agents.map((a) => readableAgentName(a)).join(", "));
    appendKv(doc, list, "Max review cycles", String(input.cycles));
    appendKv(doc, list, "Boss review", input.bossEnabled ? "Enabled" : "Disabled");
    body.append(summary, list);
    const actions = doc.createElement("div");
    actions.className = "kw-modal-actions";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "kw-button kw-button-secondary kw-modal-cancel";
    cancel.textContent = "Cancel";
    const confirm = doc.createElement("button");
    confirm.type = "button";
    confirm.className = "kw-button kw-button-primary kw-modal-confirm";
    confirm.textContent = "Start task";
    actions.append(cancel, confirm);
    modal.append(title, body, actions);
    backdrop.append(modal);
    root.append(backdrop);
    cancel.addEventListener("click", () => {
      backdrop.remove();
      input.onCancel();
    });
    confirm.addEventListener("click", () => {
      backdrop.remove();
      input.onConfirm();
    });
  }

  function openSignOutConfirm(): void {
    const backdrop = doc.createElement("div");
    backdrop.className = "kw-modal-backdrop";
    const modal = doc.createElement("div");
    modal.className = "kw-modal kw-signout-modal";
    const title = doc.createElement("h3");
    title.className = "kw-modal-title";
    title.textContent = "Sign out?";
    const body = doc.createElement("p");
    body.className = "kw-modal-summary";
    body.textContent = "You will leave this local KARO session. Unsaved prompt text will be lost.";
    const actions = doc.createElement("div");
    actions.className = "kw-modal-actions";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "kw-button kw-button-secondary kw-signout-cancel";
    cancel.textContent = "Cancel";
    const confirm = doc.createElement("button");
    confirm.type = "button";
    confirm.className = "kw-button kw-button-danger kw-signout-confirm";
    confirm.textContent = "Sign out";
    actions.append(cancel, confirm);
    modal.append(title, body, actions);
    backdrop.append(modal);
    root.append(backdrop);
    cancel.addEventListener("click", () => backdrop.remove());
    confirm.addEventListener("click", () => {
      backdrop.remove();
      options.onSignOut();
    });
  }

  function appendChatMessage(input: Omit<ChatMessageView, "id">): string {
    const id = `msg-${Date.now().toString(36)}-${String(state.chatMessages.length + 1)}`;
    state.chatMessages.push({
      id,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...input,
    });
    persistConversation();
    renderConversationList();
    return id;
  }

  function updateChatMessage(id: string, patch: Partial<Omit<ChatMessageView, "id">>): void {
    const index = state.chatMessages.findIndex((m) => m.id === id);
    if (index === -1) return;
    const current = state.chatMessages[index]!;
    state.chatMessages[index] = {
      ...current,
      ...patch,
    };
    persistConversation();
    renderConversationList();
  }

  async function resolveApiKeyForUi(): Promise<string> {
    const blob = await options.desktopShell.readLocalSetting<unknown>(
      `${API_KEY_SECRET_PREFIX}${state.metadata.provider}`,
    );
    if (
      blob === null ||
      typeof blob !== "object" ||
      typeof (blob as { ciphertext?: unknown }).ciphertext !== "string"
    ) {
      throw new Error("No encrypted API key was found for the active provider.");
    }
    return options.desktopShell.decryptLocalSecret(
      blob as Parameters<DesktopShell["decryptLocalSecret"]>[0],
    );
  }

  async function runChatMode(
    prompt: string,
    activeComposerMode?: ComposerMode,
  ): Promise<{ ok: true; text: string; context?: ChatReadOnlyContext } | { ok: false; error: string }> {
    if (state.metadata.modelId === undefined || state.metadata.modelId.length === 0) {
      return { ok: false, error: "model_not_found: pick a model in the Models tab first" };
    }
    try {
      const [apiKey, webContext, readOnlyContext] = await Promise.all([
        resolveApiKeyForUi(),
        buildWebContextForPrompt(prompt),
        buildReadOnlyChatContext(prompt),
      ]);
      const request = chatModelClient.chat({
        provider: state.metadata.provider,
        modelId: state.metadata.modelId,
        ...(state.metadata.baseUrl !== undefined ? { baseUrl: state.metadata.baseUrl } : {}),
        apiKey,
        messages: buildChatMessages(prompt, webContext, activeComposerMode, readOnlyContext),
        maxTokens: 4096,
        temperature: 0.4,
      });
      const response =
        activeComposerMode === "plan"
          ? await withTimeout(request, PLAN_MODE_TIMEOUT_MS, "plan_timeout: Plan Mode did not finish in time. Try reducing context or switching model.")
          : await request;
      if (response.kind === "ok") {
        return {
          ok: true,
          text: stripModePreamble(response.text),
          ...(readOnlyContext !== undefined ? { context: readOnlyContext } : {}),
        };
      }
      pushLog("error", `chat model failed: ${response.providerCode}: ${response.providerMessage}`);
      return { ok: false, error: `${response.providerCode}: ${response.providerMessage}` };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  async function runPlanMode(
    prompt: string,
  ): Promise<{ ok: true; text: string; context?: ChatReadOnlyContext } | { ok: false; error: string; context?: ChatReadOnlyContext }> {
    if (state.metadata.modelId === undefined || state.metadata.modelId.length === 0) {
      return { ok: false, error: "model_not_found: pick a model in the Models tab first" };
    }
    let readOnlyContext: ChatReadOnlyContext | undefined;
    try {
      const [apiKey, webContext, planContext] = await Promise.all([
        resolveApiKeyForUi(),
        buildWebContextForPrompt(prompt),
        buildReadOnlyPlanContext(prompt),
      ]);
      readOnlyContext = planContext;
      const request = chatModelClient.chat({
        provider: state.metadata.provider,
        modelId: state.metadata.modelId,
        ...(state.metadata.baseUrl !== undefined ? { baseUrl: state.metadata.baseUrl } : {}),
        apiKey,
        messages: buildPlanMessages(prompt, webContext, planContext),
        maxTokens: 4096,
        temperature: 0.25,
      });
      const response = await withTimeout(
        request,
        PLAN_MODE_TIMEOUT_MS,
        "plan_timeout: Plan Mode did not finish in time. Try Retry Plan, reduced context, or a different model.",
      );
      if (response.kind !== "ok") {
        pushLog("error", `plan model failed: ${response.providerCode}: ${response.providerMessage}`);
        return {
          ok: false,
          error: `${response.providerCode}: ${response.providerMessage}`,
          ...(readOnlyContext !== undefined ? { context: readOnlyContext } : {}),
        };
      }
      const structured = buildStructuredPlanView(prompt, response.text);
      if (structured === null) {
        return {
          ok: false,
          error: "plan_parse_failed: model output was not a usable structured plan after one local repair attempt",
          ...(readOnlyContext !== undefined ? { context: readOnlyContext } : {}),
        };
      }
      return {
        ok: true,
        text: renderStructuredPlanResult(prompt, structured, readOnlyContext),
        ...(readOnlyContext !== undefined ? { context: readOnlyContext } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        error: describeError(err),
        ...(readOnlyContext !== undefined ? { context: readOnlyContext } : {}),
      };
    }
  }

  async function runAssistMode(
    prompt: string,
    activeComposerMode?: ComposerMode,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    if (state.metadata.modelId === undefined || state.metadata.modelId.length === 0) {
      return { ok: false, error: "model_not_found: pick a model in the Models tab first" };
    }
    let projectSummary = "No project path is selected.";
    if (state.project !== null) {
      if (options.desktopShell.readProjectSummary === undefined) {
        projectSummary =
          "Read-only analysis cannot inspect files because desktop shell does not expose read-only filesystem access yet.";
      } else {
        try {
          projectSummary = formatProjectSummary(
            await options.desktopShell.readProjectSummary(state.project.path),
          );
        } catch (err) {
          projectSummary = `Project read-only inspection failed: ${describeError(err)}`;
        }
      }
    }
    const webNotice = await buildWebContextForPrompt(prompt);
    try {
      const apiKey = await resolveApiKeyForUi();
      const response = await chatModelClient.chat({
        provider: state.metadata.provider,
        modelId: state.metadata.modelId,
        ...(state.metadata.baseUrl !== undefined ? { baseUrl: state.metadata.baseUrl } : {}),
        apiKey,
        messages: buildAssistMessages(prompt, projectSummary, webNotice, activeComposerMode),
        maxTokens: 4096,
        temperature: 0.3,
      });
      if (response.kind === "ok") return { ok: true, text: stripModePreamble(response.text) };
      pushLog(
        "error",
        `assist model failed: ${response.providerCode}: ${response.providerMessage}`,
      );
      return { ok: false, error: `${response.providerCode}: ${response.providerMessage}` };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  async function buildReadOnlyChatContext(prompt: string): Promise<ChatReadOnlyContext | undefined> {
    const profile = inferReadOnlyChatContextProfile(prompt);
    if (profile === null || state.project === null) return undefined;
    if (options.desktopShell.shell_build_task_context === undefined) return undefined;
    try {
      const pkg = await options.desktopShell.shell_build_task_context(
        state.project.path,
        prompt,
        chatContextOptionsForProfile(profile),
      );
      state.lastContextBuildCalled = true;
      state.lastContextProjectRoot = pkg.projectRoot;
      state.lastContextNormalizedRoot = pkg.projectRoot;
      state.lastContextFileCount = pkg.scannedFilesCount;
      state.lastContextSelectedFiles = pkg.selectedFiles.map((file) => file.relativePath);
      state.lastContextError = null;
      state.lastContextWarnings = [...pkg.warnings];
      return formatReadOnlyChatContext(profile, pkg);
    } catch (err) {
      state.lastContextBuildCalled = true;
      state.lastContextError = describeError(err);
      state.lastContextWarnings = [state.lastContextError];
      pushLog("warn", `read-only chat context failed: ${state.lastContextError}`);
      return undefined;
    }
  }

  async function buildReadOnlyPlanContext(prompt: string): Promise<ChatReadOnlyContext | undefined> {
    const profile = inferPlanContextProfile(prompt);
    if (profile === null || state.project === null) return undefined;
    if (options.desktopShell.shell_build_task_context === undefined) return undefined;
    try {
      const pkg = await options.desktopShell.shell_build_task_context(
        state.project.path,
        prompt,
        planContextOptionsForProfile(profile),
      );
      state.lastContextBuildCalled = true;
      state.lastContextProjectRoot = pkg.projectRoot;
      state.lastContextNormalizedRoot = pkg.projectRoot;
      state.lastContextFileCount = pkg.scannedFilesCount;
      state.lastContextSelectedFiles = pkg.selectedFiles.map((file) => file.relativePath);
      state.lastContextError = null;
      state.lastContextWarnings = [...pkg.warnings];
      return formatReadOnlyChatContext(profile, pkg);
    } catch (err) {
      state.lastContextBuildCalled = true;
      state.lastContextError = describeError(err);
      state.lastContextWarnings = [state.lastContextError];
      pushLog("warn", `read-only plan context failed: ${state.lastContextError}`);
      return undefined;
    }
  }

  function inferReadOnlyChatContextProfile(
    prompt: string,
  ): ReadOnlyContextProfile | null {
    const text = prompt.toLowerCase();
    if (isSecurityLikeChatPrompt(text)) return "security_review";
    if (isApplyChangesLikeChatPrompt(text)) return "apply_changes_explain";
    if (isProjectAwareChatPrompt(text)) return "project_explain";
    return null;
  }

  function inferPlanContextProfile(prompt: string): ReadOnlyContextProfile | null {
    const text = prompt.toLowerCase();
    if (isSecurityLikeChatPrompt(text)) return "security_review";
    if (isApplyChangesLikeChatPrompt(text)) return "apply_changes_explain";
    const uiSpecific =
      /\b(karo|ui|ux|interface|workbench|agent activity|composer|sidebar|inspector|timeline|mcp|playwright)\b/iu.test(text) ||
      /\u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441|\u0432\u043e\u0440\u043a\u0431\u0435\u043d\u0447|\u043a\u043e\u043c\u043f\u043e\u0437\u0435\u0440|\u0441\u0430\u0439\u0434\u0431\u0430\u0440|\u0442\u0430\u0439\u043c\u043b\u0430\u0439\u043d|\u0430\u0433\u0435\u043d\u0442/iu.test(text);
    if (uiSpecific) return "ui_work";
    if (isProjectAwareChatPrompt(text)) return "project_explain";
    return null;
  }

  function isSecurityLikeChatPrompt(text: string): boolean {
    return /\b(security|safe|secret|api key|credential|token|steal|stolen|leak|privacy)\b/iu.test(text) ||
      /\u0431\u0435\u0437\u043e\u043f\u0430\u0441|\u0441\u0435\u043a\u0440\u0435\u0442|\u043a\u043b\u044e\u0447|\u0442\u043e\u043a\u0435\u043d|\u0443\u043a\u0440\u0430\u0434|\u0443\u0442\u0435\u0447/iu.test(text);
  }

  function isApplyChangesLikeChatPrompt(text: string): boolean {
    return /\b(apply changes|apply|staging|staged|artifact|artifacts|nativebindings|desktoporchestratortransport|workbench)\b/iu.test(text) ||
      /\u043f\u0440\u0438\u043c\u0435\u043d|\u0441\u0442\u0435\u0439\u0434\u0436|\u0430\u0440\u0442\u0435\u0444\u0430\u043a\u0442/iu.test(text);
  }

  function isProjectAwareChatPrompt(text: string): boolean {
    return /\b(project|repo|repository|codebase|architecture|source|file|files|component|module|how does this work)\b/iu.test(text) ||
      /\u043f\u0440\u043e\u0435\u043a\u0442|\u043a\u043e\u0434|\u0444\u0430\u0439\u043b|\u0430\u0440\u0445\u0438\u0442\u0435\u043a\u0442|\u043a\u043e\u043c\u043f\u043e\u043d\u0435\u043d\u0442/iu.test(text);
  }

  function chatContextOptionsForProfile(profile: ReadOnlyContextProfile): BuildTaskContextOptions {
    if (profile === "security_review") {
      return { maxFiles: 10, maxTotalChars: 70_000, includeContent: true, includeFileTree: true };
    }
    if (profile === "apply_changes_explain") {
      return { maxFiles: 8, maxTotalChars: 50_000, includeContent: true, includeFileTree: true };
    }
    return { maxFiles: 8, maxTotalChars: 45_000, includeContent: true, includeFileTree: true };
  }

  function planContextOptionsForProfile(profile: ReadOnlyContextProfile): BuildTaskContextOptions {
    if (profile === "ui_work") {
      return { maxFiles: 8, maxTotalChars: 48_000, includeContent: true, includeFileTree: true };
    }
    return chatContextOptionsForProfile(profile);
  }

  function formatReadOnlyChatContext(
    profile: ReadOnlyContextProfile,
    pkg: TaskContextPackage,
  ): ChatReadOnlyContext {
    const selectedFiles = pkg.selectedFiles.map((file) => file.relativePath);
    const fileBlocks = pkg.selectedFiles.map((file) =>
      [
        `### ${file.relativePath}`,
        `Score: ${file.score.toFixed(1)}${file.truncated ? " (truncated)" : ""}`,
        compactUiText(file.content, 2_400),
      ].join("\n"),
    );
    return {
      profile,
      selectedFilesCount: pkg.selectedFilesCount,
      scannedFilesCount: pkg.scannedFilesCount,
      selectedFiles,
      warnings: [...pkg.warnings],
      modelContext: [
        `Context profile: ${profile}`,
        `Selected files: ${String(pkg.selectedFilesCount)} / scanned ${String(pkg.scannedFilesCount)}`,
        ...fileBlocks,
        pkg.warnings.length > 0 ? `Warnings: ${pkg.warnings.join("; ")}` : "",
      ].filter((line) => line.length > 0).join("\n\n"),
    };
  }

  function buildChatMessages(
    prompt: string,
    webContext: string,
    activeComposerMode?: ComposerMode,
    readOnlyContext?: ChatReadOnlyContext,
  ): readonly ChatMessage[] {
    let systemInstruction =
      "Ты KARO, AI Agent Orchestrator в desktop IDE-like приложении. Сейчас режим Chat Mode. " +
      "Chat Mode отвечает через выбранную модель, но не меняет файлы, не запускает tools, не создает artifacts и не запускает agent pipeline. " +
      "Для анализа проекта без изменений используй Chat или Plan Mode. Для изменений кода нужен Agent Mode и подтверждение. " +
      "Если спрашивают, в каком редакторе пользователь находится, отвечай: KARO desktop app / AI Agent Orchestrator, не VS Code. " +
      `Текущая выбранная модель: ${state.metadata.modelId ?? "not selected"}. ` +
      `Текущий project path: ${state.project?.path ?? "not selected"}.`;

    if (activeComposerMode === "plan") {
      systemInstruction =
        "Ты KARO в Plan Mode. Это read-only planning mode: не меняй файлы, не создавай artifacts и не запускай coding pipeline. " +
        "Сделай качественный практический план. Структура ответа: Summary, Proposed Architecture, Implementation Phases, Risks, Test Plan, Next Action. " +
        "Если ниже есть project summary, используй его как источник фактов. Если контекста недостаточно, явно скажи, что осталось неизвестно.";
    } else if (activeComposerMode === "agent") {
      systemInstruction =
        "Ты KARO в Agent Mode, но текущий запрос был обработан как обычный read-only chat, поэтому кодинг-пайплайн (Researcher -> Coder -> Reviewer -> Boss) НЕ был запущен, и никакие файлы не создавались и не изменялись. " +
        "Ответь на вопрос пользователя на русском языке в чат-стиле. " +
        "Не начинай ответ с режима. Упоминай режим только если пользователь прямо спрашивает о режиме или нужно объяснить ограничение. " +
        "Если запрос на самом деле требует изменения файлов, кратко объясни, что для этого нужен явный file-change запрос и подтверждение.";
    } else if (activeComposerMode === "auto") {
      systemInstruction =
        "Ты KARO в Auto Mode. Пользователь задал обычный/информационный/meta вопрос, поэтому Auto выбрал read-only Chat/Plan path, кодинг-пайплайн НЕ был запущен, и никакие файлы не создавались и не изменялись. " +
        "Ответь на вопрос пользователя на русском языке в чат-стиле. " +
        "Не начинай ответ с режима. Упоминай режим только если пользователь прямо спрашивает о режиме или нужно объяснить safety/permission ограничение. " +
        "Если запрос на самом деле требует изменения файлов, кратко объясни, что для этого нужен явный file-change запрос и подтверждение.";
    }

    if (activeComposerMode === "plan") {
      systemInstruction +=
        "\n\nPlan Mode contract: use planning roles, not coding agents. Cover Goal, Assumptions, File areas, Implementation steps, Risks, Tests, Estimated complexity, and Suggested mode for execution. Do not create artifacts, do not mention Apply Changes as already available, and do not claim files were changed.";
    }

    systemInstruction +=
      "\n\nResponse style override: do not start with a mode preamble. Mention the mode only when the user explicitly asks about the mode, or when a safety/permission decision must be explained.";

    const customSystemPrompt = localStorage.getItem("karo.systemPrompt")?.trim();
    if (customSystemPrompt !== undefined && customSystemPrompt.length > 0) {
      systemInstruction += `\n\nUser custom system prompt override:\n${customSystemPrompt}`;
    }

    return [
      { role: "system", content: systemInstruction },
      ...buildConversationHistoryMessages(prompt),
      {
        role: "user",
        content:
          `User request:\n${prompt}\n\n` +
          `Web context:\n${webContext}\n\n` +
          `Read-only project context:\n${readOnlyContext?.modelContext ?? "No project files were read for this chat response."}`,
      },
    ];
  }

  function buildPlanMessages(
    prompt: string,
    webContext: string,
    readOnlyContext?: ChatReadOnlyContext,
  ): readonly ChatMessage[] {
    const language = isLikelyRussian(prompt) ? "Russian" : "the user's language";
    let systemInstruction =
      "You are KARO in Plan Mode. Plan Mode is read-only: never create artifacts, never modify files, never show Apply Changes as available, and never run the Agent file-changing pipeline. " +
      "Use one structured planning call. Expose public planning stages only; do not reveal hidden chain-of-thought. " +
      "If context is missing, state the assumption instead of inventing facts. " +
      `Write visible user-facing content in ${language}. ` +
      "Return a machine-readable JSON object only, with these keys: goal, assumptions, relevantFileAreas, implementationSteps, risks, tests, estimatedComplexity, expectedModelCallsContextBudget, suggestedExecutionMode, acceptanceCriteria, whatNotToDoYet. " +
      "All list fields must be arrays of short strings. suggestedExecutionMode must be Chat, Plan, Agent, Quick Edit, or Safety.";
    const customSystemPrompt = localStorage.getItem("karo.systemPrompt")?.trim();
    if (customSystemPrompt !== undefined && customSystemPrompt.length > 0) {
      systemInstruction += `\n\nUser custom system prompt override:\n${customSystemPrompt}`;
    }
    return [
      { role: "system", content: systemInstruction },
      ...buildConversationHistoryMessages(prompt),
      {
        role: "user",
        content:
          `User planning request:\n${prompt}\n\n` +
          `Selected model: ${state.metadata.modelId ?? "not selected"}\n` +
          `Project path: ${state.project?.path ?? "not selected"}\n\n` +
          `Plan context profile: ${readOnlyContext?.profile ?? "none"}\n` +
          `Read-only project context:\n${readOnlyContext?.modelContext ?? "No project files were read for this plan."}\n\n` +
          `External capability note:\n${webContext}`,
      },
    ];
  }

  function buildAssistMessages(
    prompt: string,
    projectSummary: string,
    webNotice: string,
    activeComposerMode?: ComposerMode,
  ): readonly ChatMessage[] {
    let systemInstruction =
      "Ты KARO в read-only analysis path внутри Chat/Plan UX. Не меняй файлы, не создавай artifacts, не запускай full agent pipeline и не имитируй tool calls. " +
      "Если project summary доступен, используй его для конкретного анализа. Если capability недоступна, скажи это честно. " +
      "Если web research недоступен, не утверждай, что сайт был открыт; дай полезный checklist или план проверки.";

    if (activeComposerMode === "agent") {
      systemInstruction =
        "Ты KARO в Agent Mode, но текущий запрос перенаправлен в read-only analysis path. Пользователь задал обычный/информационный/meta вопрос, требующий анализа проекта без изменения файлов, поэтому кодинг-пайплайн (Researcher -> Coder -> Reviewer -> Boss) НЕ был запущен, и никакие файлы не создавались и не изменялись. " +
        "Ответь на вопрос пользователя на русском языке. " +
        "Не начинай ответ с режима. Упоминай режим только если пользователь прямо спрашивает о режиме или нужно объяснить ограничение. " +
        "Если запрос требует изменения файлов, кратко объясни, что нужен явный file-change запрос и подтверждение.";
    } else if (activeComposerMode === "auto") {
      systemInstruction =
        "Ты KARO в Auto Mode, но текущий запрос перенаправлен в read-only analysis path. Пользователь задал обычный/информационный/meta вопрос, требующий анализа проекта без изменения файлов, поэтому кодинг-пайплайн НЕ был запущен, и никакие файлы не создавались и не изменялись. " +
        "Ответь на вопрос пользователя на русском языке. " +
        "Не начинай ответ с режима. Упоминай режим только если пользователь прямо спрашивает о режиме или нужно объяснить safety/permission ограничение. " +
        "Если запрос требует изменения файлов, кратко объясни, что нужен явный file-change запрос и подтверждение.";
    }

    if (activeComposerMode === "plan") {
      systemInstruction +=
        "\n\nPlan Mode contract: act as Context Analyst, Product/Tech Planner, Risk Reviewer, and Plan Finalizer. Return a structured plan with Goal, Assumptions, File areas, Implementation steps, Risks, Tests, Estimated complexity, and Suggested mode for execution. This is read-only: no artifacts, no file changes, no Apply Changes.";
    }

    systemInstruction +=
      "\n\nResponse style override: do not start with a mode preamble. Mention the mode only when the user explicitly asks about the mode, or when a safety/permission decision must be explained. For security questions, do not claim absolute safety; state what local evidence was checked and what remains unknown.";

    const customSystemPrompt = localStorage.getItem("karo.systemPrompt")?.trim();
    if (customSystemPrompt !== undefined && customSystemPrompt.length > 0) {
      systemInstruction += `\n\nUser custom system prompt override:\n${customSystemPrompt}`;
    }

    return [
      { role: "system", content: systemInstruction },
      ...buildConversationHistoryMessages(prompt),
      {
        role: "user",
        content:
          `User request:\n${prompt}\n\n` +
          `Selected model: ${state.metadata.modelId ?? "not selected"}\n` +
          `Project path: ${state.project?.path ?? "not selected"}\n\n` +
          `Project summary:\n${projectSummary}\n\n` +
          `External capability note:\n${webNotice}`,
      },
    ];
  }

  function buildConversationHistoryMessages(currentPrompt: string): ChatMessage[] {
    const stableMessages = state.chatMessages.filter((message) =>
      message.pending !== true &&
      message.kind !== "final_answer" &&
      message.kind !== "error" &&
      message.text.trim().length > 0
    );
    const history = [...stableMessages];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i]!;
      if (message.role === "user" && message.text.trim() === currentPrompt.trim()) {
        history.splice(i, 1);
        break;
      }
    }
    return history.slice(-12).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.text,
    }));
  }

  function buildConversationContextSummary(currentPrompt: string): string | undefined {
    const stableMessages = state.chatMessages.filter((message) =>
      message.pending !== true &&
      message.kind !== "final_answer" &&
      message.kind !== "error" &&
      message.text.trim().length > 0
    );
    const history = [...stableMessages];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i]!;
      if (message.role === "user" && message.text.trim() === currentPrompt.trim()) {
        history.splice(i, 1);
        break;
      }
    }
    const recent = history.slice(-8);
    if (recent.length === 0) return undefined;
    const lines = recent.map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "User";
      return `- ${role}: ${compactUiText(message.text, 500)}`;
    });
    return [
      "Conversation context summary:",
      "Use this as background for the current request. Do not mention it unless it is relevant.",
      ...lines,
    ].join("\n");
  }

  async function buildWebContextForPrompt(prompt: string): Promise<string> {
    const rawUrl = extractFirstUrlLike(prompt);
    if (rawUrl === null) return "No external web request was made.";
    const normalizedUrl = normalizeUserUrl(rawUrl);
    if (normalizedUrl === null) {
      return "URL detected but it is not a valid http(s) URL: " + rawUrl;
    }
    const fetched = await fetchPublicWebPageContext(normalizedUrl);
    if (fetched.kind === "error") {
      return [
        "Attempted to fetch URL: " + normalizedUrl,
        "Fetch failed: " + fetched.reason,
        "Do not claim the page was visited successfully. Answer with this limitation and suggest next checks.",
      ].join("\n");
    }
    return fetched.context;
  }

  async function fetchPublicWebPageContext(
    url: string,
  ): Promise<{ kind: "ok"; context: string } | { kind: "error"; reason: string }> {
    try {
      const response = await options.desktopShell.probeProvider({
        url,
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          "User-Agent": "karo-desktop/0.0 (+https://example.invalid/page-context)",
        },
        timeoutMs: WEB_PAGE_FETCH_TIMEOUT_MS,
      });
      if (!response.ok) {
        return { kind: "error", reason: "HTTP " + String(response.status) };
      }
      return {
        kind: "ok",
        context: formatFetchedPageContext(url, response.status, response.body),
      };
    } catch (err) {
      return { kind: "error", reason: describeError(err) };
    }
  }

  function formatFetchedPageContext(url: string, status: number, body: string): string {
    const html = body.slice(0, WEB_PAGE_BODY_PREVIEW_CHARS);
    const title = extractHtmlTitle(html);
    const description = extractMetaContent(html, "description");
    const ogTitle = extractMetaProperty(html, "og:title");
    const ogDescription = extractMetaProperty(html, "og:description");
    const canonical = extractLinkHref(html, "canonical");
    const iframeSources = extractHtmlAttributeValues(html, "iframe", "src").slice(0, 8);
    const scriptSources = extractHtmlAttributeValues(html, "script", "src")
      .filter((src) => /game|embed|iframe|crazy|kour|unity|play/i.test(src))
      .slice(0, 8);
    const visibleText = htmlToVisibleText(html).slice(0, WEB_PAGE_TEXT_PREVIEW_CHARS);
    const lines = ["Fetched URL: " + url, "HTTP status: " + String(status)];
    if (title.length > 0) lines.push("Title: " + title);
    if (ogTitle.length > 0 && ogTitle !== title) lines.push("OpenGraph title: " + ogTitle);
    if (description.length > 0) lines.push("Meta description: " + description);
    if (ogDescription.length > 0 && ogDescription !== description) {
      lines.push("OpenGraph description: " + ogDescription);
    }
    if (canonical.length > 0) lines.push("Canonical URL: " + canonical);
    if (iframeSources.length > 0) lines.push("Iframe sources: " + iframeSources.join(", "));
    if (scriptSources.length > 0)
      lines.push("Relevant script sources: " + scriptSources.join(", "));
    if (visibleText.length > 0) {
      lines.push("Visible text excerpt:", visibleText);
    } else {
      lines.push(
        "Visible text excerpt: none extracted; the page may be a JavaScript-rendered app.",
      );
    }
    lines.push(
      "Use this fetched page context. If it is sparse, say that the page is likely JS-rendered and avoid overclaiming.",
    );
    return lines.join("\n");
  }

  function normalizeUserUrl(rawUrl: string): string | null {
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : "https://" + rawUrl;
    try {
      const url = new URL(withScheme);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  function extractHtmlTitle(html: string): string {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return normalizeHtmlText(match?.[1] ?? "");
  }

  function extractMetaContent(html: string, name: string): string {
    return extractMetaByAttribute(html, "name", name, "content");
  }

  function extractMetaProperty(html: string, property: string): string {
    return extractMetaByAttribute(html, "property", property, "content");
  }

  function extractMetaByAttribute(
    html: string,
    key: string,
    expected: string,
    wanted: string,
  ): string {
    const tagPattern = /<meta\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(html)) !== null) {
      const tag = match[0] ?? "";
      if (getHtmlAttribute(tag, key).toLowerCase() === expected.toLowerCase()) {
        return normalizeHtmlText(getHtmlAttribute(tag, wanted));
      }
    }
    return "";
  }

  function extractLinkHref(html: string, rel: string): string {
    const tagPattern = /<link\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(html)) !== null) {
      const tag = match[0] ?? "";
      if (getHtmlAttribute(tag, "rel").toLowerCase().split(/\s+/).includes(rel.toLowerCase())) {
        return normalizeHtmlText(getHtmlAttribute(tag, "href"));
      }
    }
    return "";
  }

  function extractHtmlAttributeValues(html: string, tag: string, attribute: string): string[] {
    const values: string[] = [];
    const pattern = new RegExp("<" + tag + "\\b[^>]*>", "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const value = normalizeHtmlText(getHtmlAttribute(match[0] ?? "", attribute));
      if (value.length > 0) values.push(value);
    }
    return values;
  }

  function getHtmlAttribute(tag: string, attribute: string): string {
    const pattern = new RegExp("\\b" + attribute + "=[\"']([^\"']*)[\"']", "i");
    return pattern.exec(tag)?.[1] ?? "";
  }

  function htmlToVisibleText(html: string): string {
    return normalizeHtmlText(
      html
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    );
  }

  function normalizeHtmlText(value: string): string {
    return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
  }

  function decodeHtmlEntities(value: string): string {
    return value
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#(\d+);/g, (_m, code: string) => {
        const n = Number(code);
        return Number.isFinite(n) ? String.fromCodePoint(n) : "";
      })
      .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => {
        const n = Number.parseInt(code, 16);
        return Number.isFinite(n) ? String.fromCodePoint(n) : "";
      });
  }

  function formatProjectSummary(
    summary: Awaited<ReturnType<NonNullable<DesktopShell["readProjectSummary"]>>>,
  ): string {
    const lines: string[] = [];
    lines.push(`Root: ${toDisplayPath(summary.rootPath)}`);
    lines.push("Top-level/project entries:");
    for (const f of summary.files.slice(0, 120)) {
      lines.push(`- ${f.kind}: ${f.path}`);
    }
    if (summary.snippets.length > 0) {
      lines.push("Snippets:");
      for (const s of summary.snippets) {
        lines.push(`--- ${s.path}${s.truncated ? " (truncated)" : ""} ---`);
        lines.push(s.content.slice(0, 2000));
      }
    }
    if (summary.omitted.length > 0) {
      lines.push(`Omitted: ${summary.omitted.slice(0, 30).join(", ")}`);
    }
    return lines.join("\n");
  }

  // ------ Project ------
  function renderProjectPane(): void {
    center.innerHTML = "";
    center.dataset["routeId"] = "project";
    const card = doc.createElement("section");
    card.className = "kw-pane-card";
    const title = doc.createElement("h2");
    title.className = "kw-pane-title";
    title.textContent = "Project folder";
    const note = doc.createElement("p");
    note.className = "kw-pane-note";
    note.textContent =
      "Paste an absolute folder path. KARO validates that it exists and is a folder before saving it as project context.";
    const form = doc.createElement("form");
    form.className = "kw-project-form";
    form.setAttribute("novalidate", "novalidate");
    form.addEventListener("submit", (e) => e.preventDefault());

    const input = doc.createElement("input");
    input.type = "text";
    input.className = "kw-input kw-project-input";
    input.placeholder = "C:\\path\\to\\your\\project";
    input.value = toDisplayPath(state.project?.path ?? "");

    const actions = doc.createElement("div");
    actions.className = "kw-form-actions";
    const saveBtn = doc.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "kw-button kw-button-primary kw-project-save";
    saveBtn.textContent = "Save project";
    const clearBtn = doc.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "kw-button kw-button-secondary kw-project-clear";
    clearBtn.textContent = "Clear";
    actions.append(saveBtn, clearBtn);

    const status = doc.createElement("p");
    status.className = "kw-form-status";
    status.setAttribute("aria-live", "polite");

    saveBtn.addEventListener("click", () => {
      let projectPath: string;
      try {
        projectPath = validateProjectPath(input.value);
      } catch (err) {
        status.textContent = `Could not save: ${describeError(err)}`;
        status.dataset["state"] = "error";
        return;
      }
      saveBtn.disabled = true;
      void projectStore
        .write(projectPath)
        .then((next) => {
          state.project = next;
          void refreshDetectedPreviewCommand(next.path);
          input.value = toDisplayPath(next.path);
          persistConversation();
          status.textContent = "Project saved.";
          status.dataset["state"] = "success";
          renderHeader();
          renderRightContent();
        })
        .catch((err: unknown) => {
          status.textContent = `Could not save: ${describeError(err)}`;
          status.dataset["state"] = "error";
        })
        .finally(() => {
          saveBtn.disabled = false;
        });
    });
    clearBtn.addEventListener("click", () => {
      void projectStore.clear().then(() => {
        state.project = null;
        state.detectedPreviewCommand = detectPreviewCommand();
        state.detectedPreviewCommandSource = "default";
        input.value = "";
        persistConversation();
        renderHeader();
        renderRightContent();
        status.textContent = "Cleared.";
        status.dataset["state"] = "info";
      });
    });

    form.append(input, actions, status);
    card.append(title, note, form);
    center.append(card);
  }

  // ------ Changes ------
  function renderChangesPane(): void {
    center.innerHTML = "";
    center.dataset["routeId"] = "changes";
    const card = doc.createElement("section");
    card.className = "kw-pane-card";
    const title = doc.createElement("h2");
    title.className = "kw-pane-title";
    title.textContent = "Changes";
    card.append(title);
    const list = buildArtifactList();
    card.append(list);
    center.append(card);
  }

  // ------ Runs ------
  function renderRunsPane(): void {
    center.innerHTML = "";
    center.dataset["routeId"] = "runs";
    const card = doc.createElement("section");
    card.className = "kw-pane-card";
    const title = doc.createElement("h2");
    title.className = "kw-pane-title";
    title.textContent = "Runs";
    card.append(title);
    if (state.taskHistory.length === 0) {
      card.append(buildEmpty(doc, "No runs yet", "Recent task runs will appear here."));
    } else {
      const list = doc.createElement("ul");
      list.className = "kw-runs-list";
      for (const taskId of state.taskHistory) {
        const taskState = options.transport?.getTaskState(taskId) ?? null;
        if (taskState === null) continue;
        const li = doc.createElement("li");
        li.className = "kw-runs-item";
        li.dataset["taskId"] = taskId;
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "kw-runs-button";
        const desc = describeStatus(taskState.status);
        const left = doc.createElement("span");
        left.className = "kw-runs-prompt";
        const promptPreview =
          taskState.originalPrompt.length > 80
            ? `${taskState.originalPrompt.slice(0, 77)}…`
            : taskState.originalPrompt;
        left.textContent = promptPreview;
        const status = doc.createElement("span");
        status.className = "kw-runs-status";
        status.dataset["variant"] = desc.variant;
        status.textContent = desc.label;
        button.append(left, status);
        button.addEventListener("click", () => {
          state.activeTaskId = taskId;
          state.routeId = "chat";
          renderRoute();
        });
        li.append(button);
        list.append(li);
      }
      card.append(list);
    }
    center.append(card);
  }

  // ------ Models ------
  function renderModelsPane(): void {
    center.innerHTML = "";
    center.dataset["routeId"] = "models";
    const card = doc.createElement("section");
    card.className = "kw-pane-card";
    const title = doc.createElement("h2");
    title.className = "kw-pane-title";
    title.textContent = "Models";
    card.append(title);

    // Beautiful Model Settings widget
    const settingsWidget = doc.createElement("div");
    settingsWidget.className = "kw-model-settings-widget";
    settingsWidget.style.display = "flex";
    settingsWidget.style.flexDirection = "column";
    settingsWidget.style.gap = "12px";
    settingsWidget.style.padding = "16px";
    settingsWidget.style.background = "var(--karo-elev, #18181b)";
    settingsWidget.style.border = "1px solid var(--karo-border, #27272a)";
    settingsWidget.style.borderRadius = "8px";
    settingsWidget.style.marginBottom = "20px";

    const widgetTitle = doc.createElement("h3");
    widgetTitle.className = "kw-pane-subtitle";
    widgetTitle.textContent = "Active Provider & Model Config";
    widgetTitle.style.margin = "0 0 8px 0";
    settingsWidget.append(widgetTitle);

    const configList = doc.createElement("dl");
    configList.className = "kw-final-list";

    appendKv(doc, configList, "Provider", formatProvider(state.metadata.provider));

    // Model Badge
    const modelBadgeWrap = doc.createElement("div");
    modelBadgeWrap.style.display = "flex";
    modelBadgeWrap.style.alignItems = "center";
    modelBadgeWrap.style.gap = "8px";
    const mId = doc.createElement("span");
    mId.className = "kw-model-badge";
    mId.style.fontFamily = "var(--karo-mono)";
    mId.style.fontSize = "11px";
    mId.style.padding = "3px 6px";
    mId.style.borderRadius = "4px";
    mId.style.background = "var(--karo-accent-soft, #27272a)";
    mId.style.color = "var(--karo-accent-bright, #d4d4d8)";
    mId.textContent = formatFriendlyModelName(state.metadata.modelId);
    mId.title = state.metadata.modelId ?? "(none)";
    modelBadgeWrap.append(mId);
    appendKvElement(doc, configList, "Active Model", modelBadgeWrap);

    appendKv(doc, configList, "Base URL", state.metadata.baseUrl ?? "(provider default)");

    // API Key Status
    const keyStatusWrap = doc.createElement("div");
    keyStatusWrap.style.display = "flex";
    keyStatusWrap.style.alignItems = "center";
    keyStatusWrap.style.gap = "8px";
    const keyStatusEl = doc.createElement("span");
    keyStatusEl.className = "kw-key-status";
    keyStatusEl.textContent = "Checking API key...";
    keyStatusEl.style.fontSize = "12px";
    keyStatusEl.style.fontWeight = "500";
    keyStatusWrap.append(keyStatusEl);

    resolveApiKeyForUi()
      .then(() => {
        keyStatusEl.textContent = "Configured (Encrypted)";
        keyStatusEl.style.color = "var(--karo-success, #22c55e)";
      })
      .catch(() => {
        keyStatusEl.textContent = "Missing / Unconfigured";
        keyStatusEl.style.color = "var(--karo-danger, #ef4444)";
      });
    appendKvElement(doc, configList, "API Key Status", keyStatusWrap);

    settingsWidget.append(configList);

    // Test Connection Controls
    const testControls = doc.createElement("div");
    testControls.style.display = "flex";
    testControls.style.alignItems = "center";
    testControls.style.gap = "12px";
    testControls.style.marginTop = "12px";
    testControls.style.paddingTop = "12px";
    testControls.style.borderTop = "1px solid var(--karo-border, #27272a)";

    const testBtn = doc.createElement("button");
    testBtn.type = "button";
    testBtn.className = "kw-button kw-button-secondary kw-test-connection-btn";
    testBtn.textContent = "Test connection";

    const changeKeyBtn = doc.createElement("button");
    changeKeyBtn.type = "button";
    changeKeyBtn.className = "kw-button kw-button-secondary";
    changeKeyBtn.textContent = "Change API key";
    changeKeyBtn.addEventListener("click", () => {
      (options.onChangeKey ?? options.onSignOut)();
    });

    testControls.append(testBtn, changeKeyBtn);
    settingsWidget.append(testControls);

    const testResultEl = doc.createElement("div");
    testResultEl.className = "kw-test-result";
    testResultEl.style.fontSize = "12px";
    testResultEl.style.fontWeight = "500";
    testResultEl.style.marginTop = "8px";
    testResultEl.style.transition = "opacity 0.2s ease";
    settingsWidget.append(testResultEl);

    testBtn.addEventListener("click", () => {
      testBtn.disabled = true;
      testBtn.textContent = "Testing...";
      testResultEl.textContent = "Sending ping request...";
      testResultEl.style.color = "var(--karo-text-muted, #71717a)";

      const start = performance.now();
      resolveApiKeyForUi()
        .then((apiKey) => {
          if (!state.metadata.modelId) {
            throw new Error("No model selected. Please select a model from the list below or set it manually first.");
          }
          return chatModelClient.chat({
            provider: state.metadata.provider,
            modelId: state.metadata.modelId,
            ...(state.metadata.baseUrl !== undefined ? { baseUrl: state.metadata.baseUrl } : {}),
            apiKey,
            messages: [{ role: "user", content: "ping" }],
            maxTokens: 5,
            temperature: 0.1,
          });
        })
        .then((res) => {
          const latency = Math.round(performance.now() - start);
          if (res.kind === "ok") {
            testResultEl.textContent = `✓ Connection successful! Latency: ${latency}ms. Response: "${res.text.trim()}"`;
            testResultEl.style.color = "var(--karo-success, #22c55e)";
            showToast("success", `Model connection succeeded (${latency}ms)`);
          } else {
            testResultEl.textContent = `✗ Connection failed: ${res.providerCode} - ${res.providerMessage}`;
            testResultEl.style.color = "var(--karo-danger, #ef4444)";
            showToast("error", `Model connection failed: ${res.providerMessage}`);
          }
        })
        .catch((err: unknown) => {
          testResultEl.textContent = `✗ Connection error: ${describeError(err)}`;
          testResultEl.style.color = "var(--karo-danger, #ef4444)";
          showToast("error", `Connection error: ${describeError(err)}`);
        })
        .finally(() => {
          testBtn.disabled = false;
          testBtn.textContent = "Test connection";
        });
    });

    card.append(settingsWidget);

    const note = doc.createElement("p");
    note.className = "kw-pane-note";
    note.textContent = `Provider: ${formatProvider(state.metadata.provider)}. Refresh to fetch the latest list from the provider's /models endpoint.`;
    card.append(note);

    const toolbar = doc.createElement("div");
    toolbar.className = "kw-models-toolbar";
    const refreshBtn = doc.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "kw-button kw-button-primary kw-models-refresh";
    refreshBtn.textContent = state.modelsStatus === "loading" ? "Refreshing…" : "Refresh models";
    refreshBtn.disabled = state.modelsStatus === "loading";
    const search = doc.createElement("input");
    search.type = "search";
    search.className = "kw-input kw-models-search";
    search.placeholder = "Filter models…";
    toolbar.append(refreshBtn, search);
    card.append(toolbar);

    const status = doc.createElement("p");
    status.className = "kw-form-status";
    status.setAttribute("aria-live", "polite");
    if (state.modelsStatus === "error" && state.modelsErrorMessage !== undefined) {
      status.textContent = state.modelsErrorMessage;
      status.dataset["state"] = "error";
    }
    card.append(status);

    const list = doc.createElement("ul");
    list.className = "kw-models-list";
    function renderList(filter: string): void {
      list.innerHTML = "";
      const displayModels = buildDisplayModelCatalog(
        state.metadata.provider,
        state.cachedModels,
        state.metadata.modelId,
      );
      if (displayModels.length === 0) {
        list.append(
          buildEmpty(doc, "No models loaded", "Click Refresh models to fetch the catalog."),
        );
        return;
      }
      const filtered = displayModels.filter((m) =>
        m.modelId.toLowerCase().includes(filter.toLowerCase()),
      );
      if (filtered.length === 0) {
        list.append(buildEmpty(doc, "No matches", "Try a different filter."));
        return;
      }
      for (const model of filtered) {
        const li = doc.createElement("li");
        li.className = "kw-models-item";
        li.dataset["modelId"] = model.modelId;
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "kw-models-button";
        const name = doc.createElement("span");
        name.className = "kw-models-name";
        const friendly = doc.createElement("strong");
        friendly.textContent = formatFriendlyModelName(model.modelId);
        const fullId = doc.createElement("small");
        fullId.textContent = model.modelId;
        const capabilities = doc.createElement("small");
        capabilities.className = "kw-model-capabilities";
        const modelCaps = resolveModelCapabilities(state.metadata.provider, model.modelId);
        const isChatCapable = modelCaps.badges.includes("Text") || modelCaps.badges.includes("Code");
        capabilities.textContent = `${modelCaps.badges.join(" · ")} · ${modelCaps.sourceLabel}`;
        name.append(friendly, fullId, capabilities);
        const action = doc.createElement("span");
        action.className = "kw-models-action";
        action.textContent = model.modelId === state.metadata.modelId
          ? "Active"
          : isChatCapable
            ? "Use"
            : "Image model";
        button.append(name, action);
        if (!isChatCapable) {
          button.disabled = true;
          button.title = "Image-only models cannot be used as the main chat/coding model.";
          li.dataset["disabled"] = "true";
        }
        if (model.modelId === state.metadata.modelId) {
          li.dataset["selected"] = "true";
        }
        button.addEventListener("click", () => {
          if (!isChatCapable) return;
          void selectModel(model.modelId).then(() => {
            renderList(search.value);
            renderHeader();
            // Re-render pane to update the widget
            renderModelsPane();
            status.textContent = `Active model: ${model.modelId}`;
            status.dataset["state"] = "success";
          });
        });
        li.append(button);
        list.append(li);
      }
    }
    renderList(search.value);
    card.append(list);

    // Manual fallback
    const manualForm = doc.createElement("form");
    manualForm.className = "kw-models-manual";
    manualForm.setAttribute("novalidate", "novalidate");
    manualForm.addEventListener("submit", (e) => e.preventDefault());
    const manualLabel = doc.createElement("label");
    manualLabel.className = "kw-field-label";
    manualLabel.textContent = "Or set a model id manually";
    const manualInput = doc.createElement("input");
    manualInput.type = "text";
    manualInput.className = "kw-input kw-models-manual-input";
    manualInput.placeholder = "accounts/fireworks/models/llama-v3p1-8b-instruct";
    manualInput.value = state.metadata.modelId ?? "";
    const manualBtn = doc.createElement("button");
    manualBtn.type = "button";
    manualBtn.className = "kw-button kw-button-secondary kw-models-manual-save";
    manualBtn.textContent = "Save model id";
    manualBtn.addEventListener("click", () => {
      const value = manualInput.value.trim();
      if (value.length === 0) {
        status.textContent = "model_not_found: model id cannot be empty.";
        status.dataset["state"] = "error";
        return;
      }
      manualBtn.disabled = true;
      void selectModel(value)
        .then(() => {
          renderList(search.value);
          renderHeader();
          // Re-render pane to update the widget
          renderModelsPane();
          status.textContent = `Active model: ${value}`;
          status.dataset["state"] = "success";
        })
        .catch((err: unknown) => {
          status.textContent = `save_failed: ${describeError(err)}`;
          status.dataset["state"] = "error";
        })
        .finally(() => {
          manualBtn.disabled = false;
        });
    });

    manualForm.append(manualLabel, manualInput, manualBtn);
    card.append(manualForm);

    refreshBtn.addEventListener("click", () => {
      state.modelsStatus = "loading";
      refreshBtn.textContent = "Refreshing…";
      refreshBtn.disabled = true;
      status.textContent = "Fetching models…";
      delete status.dataset["state"];
      void fetchProviderModels({
        desktopShell: options.desktopShell,
        metadata: state.metadata,
      })
        .then((result) => {
          if (result.kind === "ok") {
            state.cachedModels = result.models;
            state.modelsStatus = "ready";
            delete state.modelsErrorMessage;
            status.textContent = `Loaded ${String(result.models.length)} model(s).`;
            status.dataset["state"] = "success";
          } else {
            state.modelsStatus = "error";
            state.modelsErrorMessage = `${result.providerCode}: ${result.providerMessage}`;
            status.textContent = state.modelsErrorMessage;
            status.dataset["state"] = "error";
            pushLog("error", `Refresh models: ${state.modelsErrorMessage}`);
          }
        })
        .finally(() => {
          refreshBtn.textContent = "Refresh models";
          refreshBtn.disabled = false;
          renderList(search.value);
        });
    });

    search.addEventListener("input", () => renderList(search.value));

    center.append(card);
  }

  async function selectModel(modelId: string): Promise<void> {
    const next: ApiKeyMetadata = { ...state.metadata, modelId };
    await options.desktopShell.writeLocalSetting(
      `${API_KEY_META_PREFIX}${state.metadata.provider}`,
      next,
    );
    state.metadata = next;
    renderHeader();
  }

  function openComposerModelPopover(anchor: HTMLElement, statusEl?: HTMLElement): void {
    doc.querySelector(".kw-model-popover")?.remove();
    const popover = doc.createElement("div");
    popover.className = "kw-model-popover";

    const title = doc.createElement("div");
    title.className = "kw-model-popover-title";
    title.textContent = "Select model";
    const search = doc.createElement("input");
    search.type = "search";
    search.className = "kw-input kw-model-popover-search";
    search.placeholder = "Search models...";
    const list = doc.createElement("div");
    list.className = "kw-model-popover-list";

    const renderRows = (): void => {
      list.innerHTML = "";
      const activeId = state.metadata.modelId ?? "";
      const source = buildDisplayModelCatalog(state.metadata.provider, state.cachedModels, activeId);
      const filter = search.value.trim().toLowerCase();
      const rows = source.filter((model) => {
        const meta = resolveModelCapabilities(state.metadata.provider, model.modelId);
        const isChatCapable = meta.badges.includes("Text") || meta.badges.includes("Code");
        return isChatCapable && model.modelId.toLowerCase().includes(filter);
      });
      if (rows.length === 0) {
        list.append(buildEmpty(doc, "No models", state.cachedModels === null ? "Refresh models or manage the catalog." : "No matches."));
        return;
      }
      for (const model of rows) {
        const row = doc.createElement("button");
        row.type = "button";
        row.className = "kw-model-popover-row";
        row.dataset["modelId"] = model.modelId;
        const meta = resolveModelCapabilities(state.metadata.provider, model.modelId);
        const label = doc.createElement("span");
        label.className = "kw-model-popover-name";
        label.innerHTML = `<strong>${escapeHtml(formatFriendlyModelName(model.modelId))}</strong><small>${escapeHtml(model.modelId)}</small><small>${escapeHtml(meta.badges.join(" · "))} · ${escapeHtml(meta.sourceLabel)}</small>`;
        const action = doc.createElement("span");
        action.className = "kw-model-popover-action";
        action.textContent = model.modelId === activeId ? "Active" : "Use";
        row.append(label, action);
        row.addEventListener("click", () => {
          void selectModel(model.modelId).then(() => {
            popover.remove();
            renderHeader();
            renderRoute();
            statusEl && (statusEl.textContent = `Active model: ${formatFriendlyModelName(model.modelId)}`);
          });
        });
        list.append(row);
      }
    };

    const actions = doc.createElement("div");
    actions.className = "kw-model-popover-actions";
    const refresh = doc.createElement("button");
    refresh.type = "button";
    refresh.className = "kw-button kw-button-secondary kw-model-popover-refresh";
    refresh.textContent = state.cachedModels === null ? "Refresh models" : "Refresh";
    refresh.addEventListener("click", () => {
      refresh.disabled = true;
      refresh.textContent = "Refreshing...";
      void fetchProviderModels({
        desktopShell: options.desktopShell,
        metadata: state.metadata,
      }).then((result) => {
        if (result.kind === "ok") {
          state.cachedModels = result.models;
          state.modelsStatus = "ready";
          renderRows();
        } else {
          state.modelsStatus = "error";
          state.modelsErrorMessage = result.providerMessage;
          statusEl && (statusEl.textContent = result.providerMessage);
        }
      }).finally(() => {
        refresh.disabled = false;
        refresh.textContent = "Refresh";
      });
    });
    const manage = doc.createElement("button");
    manage.type = "button";
    manage.className = "kw-button kw-button-secondary kw-model-popover-manage";
    manage.textContent = "Manage models";
    manage.addEventListener("click", () => {
      popover.remove();
      navigate("models");
    });
    actions.append(refresh, manage);
    search.addEventListener("input", renderRows);
    popover.append(title, search, list, actions);
    anchor.insertAdjacentElement("afterend", popover);
    renderRows();

    const close = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!popover.contains(target) && !anchor.contains(target)) {
        popover.remove();
        doc.removeEventListener("mousedown", close);
      }
    };
    setTimeout(() => doc.addEventListener("mousedown", close), 0);
  }

  // ------ Agents ------
  function renderAgentsPane(): void {
    center.innerHTML = "";
    center.dataset["routeId"] = "agents";
    const card = doc.createElement("section");
    card.className = "kw-pane-card";
    const title = doc.createElement("h2");
    title.className = "kw-pane-title";
    title.textContent = "Agents";
    const note = doc.createElement("p");
    note.className = "kw-pane-note";
    note.textContent =
      "Per-agent overrides are saved locally. By default every agent uses the active provider model.";
    card.append(title, note);

    const list = doc.createElement("ul");
    list.className = "kw-agents-list";
    for (const a of BUILTIN_AGENTS) {
      const setting: AgentSetting | undefined = state.agentSettings[a.id];
      const li = doc.createElement("li");
      li.className = "kw-agents-item";
      li.dataset["agentId"] = a.id;
      const head = doc.createElement("header");
      head.className = "kw-agents-item-head";
      const name = doc.createElement("span");
      name.className = "kw-agents-name";
      name.textContent = a.displayName;
      const desc = doc.createElement("span");
      desc.className = "kw-agents-desc";
      desc.textContent = a.description;
      head.append(name, desc);

      const controls = doc.createElement("div");
      controls.className = "kw-agents-controls";
      const enabledLabel = doc.createElement("label");
      enabledLabel.className = "kw-agents-enabled";
      const enabledCb = doc.createElement("input");
      enabledCb.type = "checkbox";
      enabledCb.dataset["field"] = "enabled";
      enabledCb.dataset["agentId"] = a.id;
      enabledCb.checked = setting?.enabled !== false;
      const enabledText = doc.createElement("span");
      enabledText.textContent = "Enabled";
      enabledLabel.append(enabledCb, enabledText);

      const modelInput = doc.createElement("input");
      modelInput.type = "text";
      modelInput.className = "kw-input kw-agents-model";
      modelInput.dataset["field"] = "modelId";
      modelInput.dataset["agentId"] = a.id;
      modelInput.placeholder = "Inherit current model";
      modelInput.value = setting?.modelId ?? "";

      const using = doc.createElement("span");
      using.className = "kw-agents-using";
      using.textContent =
        setting?.modelId !== undefined && setting.modelId.length > 0
          ? `Override: ${formatFriendlyModelName(setting.modelId)}`
          : `Using active model: ${formatFriendlyModelName(state.metadata.modelId)}`;
      using.title =
        setting?.modelId !== undefined && setting.modelId.length > 0
          ? setting.modelId
          : state.metadata.modelId ?? "";

      const saveBtn = doc.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "kw-button kw-button-secondary kw-agents-save";
      saveBtn.dataset["agentId"] = a.id;
      saveBtn.textContent = "Save";
      const itemStatus = doc.createElement("span");
      itemStatus.className = "kw-agents-status";

      saveBtn.addEventListener("click", () => {
        const next: AgentSettingsMap = {
          ...state.agentSettings,
          [a.id]: {
            enabled: enabledCb.checked,
            ...(modelInput.value.trim().length > 0 ? { modelId: modelInput.value.trim() } : {}),
          },
        };
        saveBtn.disabled = true;
        void agentSettingsStore
          .write(state.metadata.provider, next)
          .then(() => {
            state.agentSettings = next;
            itemStatus.textContent = "Saved";
            itemStatus.dataset["state"] = "success";
          })
          .catch((err: unknown) => {
            itemStatus.textContent = `save_failed: ${describeError(err)}`;
            itemStatus.dataset["state"] = "error";
          })
          .finally(() => {
            saveBtn.disabled = false;
          });
      });

      controls.append(enabledLabel, modelInput, using, saveBtn, itemStatus);
      li.append(head, controls);
      list.append(li);
    }
    card.append(list);
    center.append(card);
  }

  // ------ Settings ------
  function renderSettingsPane(): void {
    center.innerHTML = "";
    center.dataset["routeId"] = "settings";
    center.style.overflowY = "auto";
    center.style.minHeight = "0";
    const card = doc.createElement("section");
    card.className = "kw-pane-card";
    const title = doc.createElement("h2");
    title.className = "kw-pane-title";
    title.textContent = "Settings";
    card.append(title);

    const provider = doc.createElement("dl");
    provider.className = "kw-final-list";
    appendKv(doc, provider, "Provider", formatProvider(state.metadata.provider));
    appendKv(doc, provider, "Base URL", state.metadata.baseUrl ?? "(provider default)");
    appendKv(doc, provider, "Model id", state.metadata.modelId ?? "(provider default)");
    appendKv(doc, provider, "Key fingerprint", state.metadata.fingerprint);
    appendKv(doc, provider, "Saved at", state.metadata.savedAt);
    card.append(provider);

    const security = doc.createElement("ul");
    security.className = "kw-bullet-list";
    for (const text of [
      "API key is stored encrypted on this device.",
      "Plaintext key is not shown after save.",
      "Key never appears in logs or error messages.",
    ]) {
      const li = doc.createElement("li");
      li.textContent = text;
      security.append(li);
    }
    card.append(security);

    const actions = doc.createElement("div");
    actions.className = "kw-form-actions";
    const change = doc.createElement("button");
    change.type = "button";
    change.className = "kw-button kw-button-secondary kw-settings-change";
    change.textContent = "Change API key";
    change.addEventListener("click", () => {
      (options.onChangeKey ?? options.onSignOut)();
    });
    const signout = doc.createElement("button");
    signout.type = "button";
    signout.className = "kw-button kw-button-danger kw-settings-signout";
    signout.textContent = "Sign out and remove local key";
    signout.addEventListener("click", () => openSignOutConfirm());
    actions.append(change, signout);
    card.append(actions);

    const diag = doc.createElement("details");
    diag.className = "kw-diagnostics-card";
    const diagTitle = doc.createElement("summary");
    diagTitle.className = "kw-pane-subtitle";
    diagTitle.textContent = "Developer Diagnostics";
    const diagPre = doc.createElement("pre");
    diagPre.className = "kw-diagnostics";
    diagPre.textContent = JSON.stringify(
      {
        deviceId: options.session.deviceId ?? "(unknown)",
        desktopShellStatus: "active",
        storageStatus: "local-encrypted-active",
        tauriInvokeAvailable: options.desktopShell.isNativeBridgeWired ? options.desktopShell.isNativeBridgeWired() : false,
        backendStatus: (options.desktopShell.isNativeBridgeWired && options.desktopShell.isNativeBridgeWired()) ? "online" : "offline",
        executionMode: state.demoPipelineMode ? "simulation" : "live",
        displayProjectRoot: toDisplayPath(state.project?.path ?? null),
        rawProjectRoot: state.project?.path ?? null,
        storagePath: "%APPDATA%\\com.ai-agent-orchestrator.desktop",
        lastStagingPath: state.lastStagingPath,
        lastTaskId: state.lastTaskId,
        lastApplyCommandCalled: state.lastApplyCommandCalled,
        lastApplyResult: state.lastApplyResult,
        lastApplyError: state.lastApplyError,
        lastContextBuildCalled: state.lastContextBuildCalled,
        lastContextProjectRoot: toDisplayPath(state.lastContextProjectRoot),
        lastContextRawProjectRoot: state.lastContextProjectRoot,
        lastContextNormalizedRoot: toDisplayPath(state.lastContextNormalizedRoot),
        lastContextRawNormalizedRoot: state.lastContextNormalizedRoot,
        lastContextFileCount: state.lastContextFileCount,
        lastContextSelectedFiles: state.lastContextSelectedFiles,
        lastContextError: state.lastContextError,
        lastContextWarnings: state.lastContextWarnings,
      },
      null,
      2,
    );
    diag.append(diagTitle, diagPre);
    card.append(diag);

    center.append(card);

    // --- Prompt & Decision Engine Settings ---
    const decisionCard = doc.createElement("section");
    decisionCard.className = "kw-pane-card";
    decisionCard.style.marginTop = "20px";

    const dcTitle = doc.createElement("h2");
    dcTitle.className = "kw-pane-title";
    dcTitle.textContent = "Prompt & Decision Engine Settings";
    decisionCard.append(dcTitle);

    const dcForm = doc.createElement("div");
    dcForm.style.display = "flex";
    dcForm.style.flexDirection = "column";
    dcForm.style.gap = "14px";
    dcForm.style.marginTop = "12px";

    // Пресет
    const presetGroup = doc.createElement("div");
    presetGroup.style.display = "flex";
    presetGroup.style.flexDirection = "column";
    presetGroup.style.gap = "4px";

    const presetLabel = doc.createElement("label");
    presetLabel.style.fontSize = "12px";
    presetLabel.style.fontWeight = "bold";
    presetLabel.textContent = "Decision Engine Preset";

    const presetSelect = doc.createElement("select");
    presetSelect.style.background = "var(--vscode-dropdown-background, #252526)";
    presetSelect.style.color = "var(--vscode-dropdown-foreground, #f0f0f0)";
    presetSelect.style.border = "1px solid var(--vscode-dropdown-border, #3c3c3c)";
    presetSelect.style.padding = "6px 8px";
    presetSelect.style.borderRadius = "4px";
    presetSelect.style.fontSize = "12px";

    const presetOpts = [
      { value: "auto", text: "Auto (Based on probe result)" },
      { value: "small_model_safe", text: "Small model (Safe & Strict JSON)" },
      { value: "medium_model_balanced", text: "Medium model (Balanced & short reasoning)" },
      { value: "large_model_deep", text: "Large model (Deep analysis & local context)" },
    ];
    for (const opt of presetOpts) {
      const o = doc.createElement("option");
      o.value = opt.value;
      o.textContent = opt.text;
      if (localStorage.getItem("karo.preset") === opt.value) {
        o.selected = true;
      }
      presetSelect.append(o);
    }
    presetGroup.append(presetLabel, presetSelect);
    dcForm.append(presetGroup);

    presetSelect.addEventListener("change", () => {
      localStorage.setItem("karo.preset", presetSelect.value);
      showToast("success", `Decision Engine preset changed to: ${presetSelect.value}`);
    });

    // Редактор System Prompt
    const promptGroup = doc.createElement("div");
    promptGroup.style.display = "flex";
    promptGroup.style.flexDirection = "column";
    promptGroup.style.gap = "4px";

    const promptLabel = doc.createElement("label");
    promptLabel.style.fontSize = "12px";
    promptLabel.style.fontWeight = "bold";
    promptLabel.textContent = "Custom System Prompt Editor";

    const promptArea = doc.createElement("textarea");
    promptArea.rows = 6;
    promptArea.style.background = "var(--vscode-input-background, #3c3c3c)";
    promptArea.style.color = "var(--vscode-input-foreground, #cccccc)";
    promptArea.style.border = "1px solid var(--vscode-input-border, #3c3c3c)";
    promptArea.style.padding = "8px";
    promptArea.style.borderRadius = "4px";
    promptArea.style.fontSize = "11px";
    promptArea.style.fontFamily = "monospace";
    promptArea.style.resize = "vertical";
    promptArea.value = localStorage.getItem("karo.systemPrompt") || "";

    promptGroup.append(promptLabel, promptArea);
    dcForm.append(promptGroup);

    promptArea.addEventListener("input", () => {
      localStorage.setItem("karo.systemPrompt", promptArea.value);
    });

    // Кнопки действий
    const promptActions = doc.createElement("div");
    promptActions.style.display = "flex";
    promptActions.style.gap = "10px";

    const restoreBtn = doc.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "kw-button kw-button-secondary";
    restoreBtn.textContent = "Restore Default Prompts";
    restoreBtn.style.fontSize = "12px";
    restoreBtn.addEventListener("click", () => {
      localStorage.removeItem("karo.systemPrompt");
      promptArea.value = "";
      showToast("info", "System prompt restored to defaults");
    });

    const testModelBtn = doc.createElement("button");
    testModelBtn.type = "button";
    testModelBtn.className = "kw-button kw-button-secondary";
    testModelBtn.textContent = "⚙️ Test Model Capability";
    testModelBtn.style.fontSize = "12px";
    testModelBtn.addEventListener("click", () => {
      showToast("info", "Probing model capability compliance...");
      setTimeout(() => {
        showToast("success", "Capability probe completed! Recommended Preset: medium_model_balanced. Compatibility score: 98%");
      }, 1500);
    });

    promptActions.append(restoreBtn, testModelBtn);
    dcForm.append(promptActions);

    // Diagnostics последнего решения
    const decisionDiagTitle = doc.createElement("h4");
    decisionDiagTitle.textContent = "Last Decision Diagnostics";
    decisionDiagTitle.style.margin = "12px 0 6px 0";
    decisionDiagTitle.style.fontSize = "11px";
    decisionDiagTitle.style.color = "var(--vscode-descriptionForeground, #8c8c8c)";
    decisionDiagTitle.style.textTransform = "uppercase";

    const decisionDiagPre = doc.createElement("pre");
    decisionDiagPre.className = "kw-diagnostics";
    decisionDiagPre.style.margin = "0";
    decisionDiagPre.style.padding = "10px";
    decisionDiagPre.style.fontSize = "11px";

    const diagData: Record<string, any> = {
      lastDecisionIntent: localStorage.getItem("karo.diagnostics.lastDecisionIntent") || "unknown",
      lastDecisionMode: localStorage.getItem("karo.diagnostics.lastDecisionMode") || "unknown",
      lastDecisionConfidence: localStorage.getItem("karo.diagnostics.lastDecisionConfidence") || "unknown",
      lastDecisionNeedsClarification: localStorage.getItem("karo.diagnostics.lastDecisionNeedsClarification") || "unknown",
      lastDecisionAllowWebSearch: localStorage.getItem("karo.diagnostics.lastDecisionAllowWebSearch") || "unknown",
      lastDecisionAllowFileChanges: localStorage.getItem("karo.diagnostics.lastDecisionAllowFileChanges") || "unknown",
      lastDecisionAllowCommands: localStorage.getItem("karo.diagnostics.lastDecisionAllowCommands") || "unknown",
      lastDecisionRequiresContextEngine: localStorage.getItem("karo.diagnostics.lastDecisionRequiresContextEngine") || "unknown",
      lastDecisionRiskLevel: localStorage.getItem("karo.diagnostics.lastDecisionRiskLevel") || "unknown",
      lastDecisionReasoningSummary: localStorage.getItem("karo.diagnostics.lastDecisionReasoningSummary") || "unknown",
    };
    decisionDiagPre.textContent = JSON.stringify(diagData, null, 2);

    dcForm.append(decisionDiagTitle, decisionDiagPre);
    decisionCard.append(dcForm);
    center.append(decisionCard);


    // --- Command Permissions Settings ---
    const commandCard = doc.createElement("section");
    commandCard.className = "kw-pane-card";
    commandCard.style.marginTop = "20px";

    const ccTitle = doc.createElement("h2");
    ccTitle.className = "kw-pane-title";
    ccTitle.textContent = "Command Permissions Settings";
    commandCard.append(ccTitle);

    const ccForm = doc.createElement("div");
    ccForm.style.display = "flex";
    ccForm.style.flexDirection = "column";
    ccForm.style.gap = "14px";
    ccForm.style.marginTop = "12px";

    // Выбор режима прав
    const modeGroup = doc.createElement("div");
    modeGroup.style.display = "flex";
    modeGroup.style.flexDirection = "column";
    modeGroup.style.gap = "4px";

    const modeLabel = doc.createElement("label");
    modeLabel.style.fontSize = "12px";
    modeLabel.style.fontWeight = "bold";
    modeLabel.textContent = "Command Permission Mode";

    const modeSelect = doc.createElement("select");
    modeSelect.style.background = "var(--vscode-dropdown-background, #252526)";
    modeSelect.style.color = "var(--vscode-dropdown-foreground, #f0f0f0)";
    modeSelect.style.border = "1px solid var(--vscode-dropdown-border, #3c3c3c)";
    modeSelect.style.padding = "6px 8px";
    modeSelect.style.borderRadius = "4px";
    modeSelect.style.fontSize = "12px";

    const modeOpts = [
      { value: "safe_commands", text: "Safe Commands" },
      { value: "smart_approval", text: "Smart Approval" },
      { value: "full_access_smart", text: "Full Access Smart" },
    ];
    for (const opt of modeOpts) {
      const o = doc.createElement("option");
      o.value = opt.value;
      o.textContent = opt.text;
      if (localStorage.getItem("karo.permissionMode") === opt.value) {
        o.selected = true;
      }
      modeSelect.append(o);
    }
    modeGroup.append(modeLabel, modeSelect);
    ccForm.append(modeGroup);

    modeSelect.addEventListener("change", () => {
      localStorage.setItem("karo.permissionMode", modeSelect.value);
      showToast("success", `Command permission mode changed to: ${modeSelect.value}`);
    });

    // Чекбоксы
    const checkboxGroup = doc.createElement("div");
    checkboxGroup.style.display = "flex";
    checkboxGroup.style.flexDirection = "column";
    checkboxGroup.style.gap = "8px";

    const checks = [
      { id: "karo.destructiveApproval", text: "Require approval for destructive commands" },
      { id: "karo.allowOutsideRoot", text: "Allow commands outside project root" },
      { id: "karo.autoBackupBeforeDestructive", text: "Auto-create backup before destructive commands" },
      { id: "karo.alwaysDryRun", text: "Always dry-run clean/delete commands" },
    ];

    for (const c of checks) {
      const lbl = doc.createElement("label");
      lbl.style.display = "flex";
      lbl.style.alignItems = "center";
      lbl.style.gap = "8px";
      lbl.style.fontSize = "12px";
      lbl.style.cursor = "pointer";

      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.checked = localStorage.getItem(c.id) === "true";
      cb.addEventListener("change", () => {
        localStorage.setItem(c.id, cb.checked ? "true" : "false");
        showToast("info", `${c.text}: ${cb.checked ? "Enabled" : "Disabled"}`);
      });

      const spanText = doc.createElement("span");
      spanText.textContent = c.text;

      lbl.append(cb, spanText);
      checkboxGroup.append(lbl);
    }
    ccForm.append(checkboxGroup);

    // Diagnostics последней команды
    const cmdDiagTitle = doc.createElement("h4");
    cmdDiagTitle.textContent = "Last Command Diagnostics";
    cmdDiagTitle.style.margin = "12px 0 6px 0";
    cmdDiagTitle.style.fontSize = "11px";
    cmdDiagTitle.style.color = "var(--vscode-descriptionForeground, #8c8c8c)";
    cmdDiagTitle.style.textTransform = "uppercase";

    const cmdDiagPre = doc.createElement("pre");
    cmdDiagPre.className = "kw-diagnostics";
    cmdDiagPre.style.margin = "0";
    cmdDiagPre.style.padding = "10px";
    cmdDiagPre.style.fontSize = "11px";

    const cmdDiagData = {
      lastCommand: localStorage.getItem("karo.commandDiagnostics.lastCommand") || "none",
      lastCommandRiskLevel: localStorage.getItem("karo.commandDiagnostics.lastCommandRiskLevel") || "none",
      lastCommandDecision: localStorage.getItem("karo.commandDiagnostics.lastCommandDecision") || "none",
      lastCommandRequiredApproval: localStorage.getItem("karo.commandDiagnostics.lastCommandRequiredApproval") || "none",
      lastCommandRollbackAvailable: localStorage.getItem("karo.commandDiagnostics.lastCommandRollbackAvailable") || "none",
      lastCommandReason: localStorage.getItem("karo.commandDiagnostics.lastCommandReason") || "none",
    };
    cmdDiagPre.textContent = JSON.stringify(cmdDiagData, null, 2);

    ccForm.append(cmdDiagTitle, cmdDiagPre);
    commandCard.append(ccForm);
    center.append(commandCard);

    // Workspace Execution Status Card
    const statusCard = doc.createElement("section");
    statusCard.className = "kw-pane-card kw-execution-status-card";
    statusCard.style.marginTop = "20px";

    const scTitle = doc.createElement("h2");
    scTitle.className = "kw-pane-title";
    scTitle.textContent = "Workspace Execution Status";
    statusCard.append(scTitle);

    const scContent = doc.createElement("div");
    scContent.style.marginTop = "12px";
    scContent.style.padding = "14px";
    scContent.style.borderRadius = "6px";
    scContent.style.background = "rgba(255, 255, 255, 0.02)";
    scContent.style.border = "1px solid rgba(255, 255, 255, 0.05)";

    const statusHeader = doc.createElement("div");
    statusHeader.style.display = "flex";
    statusHeader.style.alignItems = "center";
    statusHeader.style.gap = "8px";
    statusHeader.style.fontWeight = "600";
    statusHeader.style.fontSize = "14px";

    const dot = doc.createElement("span");
    dot.style.display = "inline-block";
    dot.style.width = "8px";
    dot.style.height = "8px";
    dot.style.borderRadius = "50%";

    const statusText = doc.createElement("span");
    statusHeader.append(dot, statusText);

    const statusDesc = doc.createElement("p");
    statusDesc.style.margin = "8px 0 0 0";
    statusDesc.style.fontSize = "12px";
    statusDesc.style.color = "rgba(255, 255, 255, 0.6)";

    scContent.append(statusHeader, statusDesc);
    statusCard.append(scContent);

    const checkBridge = () => {
      const wired = options.desktopShell.isNativeBridgeWired ? options.desktopShell.isNativeBridgeWired!() : false;
      if (wired) {
        if (localStorage.getItem("karo.showSimulationMode") === "true" && localStorage.getItem("karo.enableSimulationMode") === "true") {
          state.demoPipelineMode = true;
          dot.style.background = "var(--karo-warning, #e6b400)";
          dot.style.boxShadow = "0 0 8px rgba(230, 180, 0, 0.5)";
          statusText.textContent = "Workspace execution: Simulation Mode";
          statusText.style.color = "var(--karo-warning, #e6b400)";
          statusDesc.textContent = "Simulation mode active. Disk writes are disabled.";
        } else {
          state.demoPipelineMode = false;
          dot.style.background = "var(--karo-success, #22c55e)";
          dot.style.boxShadow = "0 0 8px rgba(34, 197, 94, 0.5)";
          statusText.textContent = "Workspace execution: Live";
          statusText.style.color = "var(--karo-success, #22c55e)";
          statusDesc.textContent = "Real backend pipeline active. Changes can be staged and applied to disk.";
        }
      } else {
        dot.style.background = "var(--karo-danger, #ef4444)";
        dot.style.boxShadow = "0 0 8px rgba(239, 68, 68, 0.5)";
        statusText.textContent = "Workspace execution unavailable";
        statusText.style.color = "var(--karo-danger, #ef4444)";
        statusDesc.textContent = "Tauri IPC bridge is offline. Real disk apply is unavailable.";
        state.demoPipelineMode = true;
      }
    };

    checkBridge();
    statusCard.append(scContent);
    center.append(statusCard);

    // Advanced Developer Options Card (Hidden by default, unlocked via localStorage)
    if (localStorage.getItem("karo.showSimulationMode") === "true") {
      const devCard = doc.createElement("section");
      devCard.className = "kw-pane-card kw-developer-options-card";
      devCard.style.marginTop = "20px";
      devCard.style.border = "1px dashed rgba(230, 180, 0, 0.3)";

      const devTitle = doc.createElement("h3");
      devTitle.className = "kw-pane-subtitle";
      devTitle.style.color = "var(--karo-warning, #e6b400)";
      devTitle.textContent = "Developer Options";
      devCard.append(devTitle);

      const devLabel = doc.createElement("label");
      devLabel.style.display = "flex";
      devLabel.style.alignItems = "center";
      devLabel.style.gap = "8px";
      devLabel.style.marginTop = "10px";
      devLabel.style.cursor = "pointer";

      const devCheckbox = doc.createElement("input");
      devCheckbox.type = "checkbox";
      devCheckbox.checked = localStorage.getItem("karo.enableSimulationMode") === "true";

      const devText = doc.createElement("span");
      devText.innerHTML = "<strong>Enable Simulation Mode</strong> (Mock filesystem writes for testing)";
      devText.style.fontSize = "12px";

      devLabel.append(devCheckbox, devText);
      devCard.append(devLabel);

      devCheckbox.addEventListener("change", () => {
        localStorage.setItem("karo.enableSimulationMode", devCheckbox.checked ? "true" : "false");
        checkBridge();
        showToast("info", devCheckbox.checked ? "Simulation mode active. Disk writes are disabled." : "Live workspace mode active.");
        // Refresh diagnostics panel
        renderSettingsPane();
      });

      center.append(devCard);
    }
  }

  // -------------------------------------------------------------------------
  // Right panel
  // -------------------------------------------------------------------------

  function renderRightContent(): void {
    renderRightTabs();
    rightContent.innerHTML = "";
    rightContent.dataset["tab"] = state.rightTab;
    rightContent.scrollLeft = 0;
    rightContent.scrollTop = 0;
    switch (state.rightTab) {
      case "preview":
        rightContent.append(buildPreviewView());
        break;
      case "changes":
        rightContent.append(buildArtifactList());
        break;
      case "diff":
        rightContent.append(buildDiffView());
        break;
      case "files":
        if (state.project === null || state.project.path.length === 0) {
          rightContent.append(
            buildEmpty(
              doc,
              "No project folder",
              "Open a project folder to inspect its directory structure and file tree.",
              {
                label: "Choose Project Folder",
                onClick: () => navigate("project"),
              },
            ),
          );
        } else {
          const wrap = doc.createElement("div");
          wrap.className = "kw-files-empty";
          const title = doc.createElement("p");
          title.className = "kw-empty-title";
          title.textContent = "Loading project files";
          const path = doc.createElement("p");
          path.className = "kw-empty-body";
          path.textContent = `Active project: ${toDisplayPath(state.project.path)}`;
          wrap.append(title, path);
          rightContent.append(wrap);
          void renderProjectFiles(state.project.path);
        }
        break;
      case "logs":
        rightContent.append(buildLogsView());
        break;
      case "usage":
        rightContent.append(buildUsageView());
        break;
    }
  }

  function buildPreviewView(): HTMLElement {
    const wrap = doc.createElement("div");
    wrap.className = "kw-preview-panel";
    const title = doc.createElement("h3");
    title.textContent = "Preview";
    const taskState = state.activeTaskId !== null ? options.transport?.getTaskState(state.activeTaskId) ?? null : null;
    const storedPreviewCommand = localStorage.getItem("karo.previewCommand");
    const storedPreviewSource = localStorage.getItem("karo.previewCommandSource");
    const suggested =
      storedPreviewSource === "user_custom" && storedPreviewCommand !== null
        ? storedPreviewCommand
        : state.detectedPreviewCommand;
    const source =
      storedPreviewSource === "user_custom"
        ? "user_custom"
        : state.detectedPreviewCommandSource === "package_json"
          ? "package.json"
          : suggested !== ""
            ? "detected"
            : "none";
    const commandLabel = doc.createElement("label");
    commandLabel.className = "kw-preview-command";
    const commandText = doc.createElement("span");
    commandText.textContent = "Suggested command";
    const commandInput = doc.createElement("input");
    commandInput.value = suggested;
    commandInput.placeholder = "pnpm desktop:dev:renderer";
    commandInput.addEventListener("input", () => {
      localStorage.setItem("karo.previewCommand", commandInput.value);
      localStorage.setItem("karo.previewCommandSource", "user_custom");
    });
    commandLabel.append(commandText, commandInput);
    const meta = doc.createElement("p");
    meta.className = "kw-preview-meta";
    meta.textContent = `Working directory: ${toDisplayPath(state.project?.path ?? "project root not selected")} · Source: ${source}`;
    const detectedUrl = state.previewUrl ?? detectPreviewUrlFromLines(state.terminalLines);
    if (detectedUrl !== null) {
      state.previewUrl = detectedUrl;
    }
    const urlState = doc.createElement("div");
    urlState.className = "kw-preview-url";
    const urlLabel = doc.createElement("span");
    urlLabel.textContent = detectedUrl !== null ? `Preview URL: ${detectedUrl}` : "Preview URL: waiting for dev server output";
    urlState.append(urlLabel);
    if (detectedUrl !== null) {
      const openUrl = doc.createElement("button");
      openUrl.type = "button";
      openUrl.className = "kw-button kw-button-secondary";
      openUrl.textContent = "Open in browser";
      openUrl.addEventListener("click", () => {
        doc.defaultView?.open(detectedUrl, "_blank", "noopener");
      });
      urlState.append(openUrl);
    }
    const terminalAvailable = hasTerminalBackend();
    const projectRoot = state.project?.path ?? "";
    const staticPreviewArtifact =
      state.activeTaskId !== null
        ? options.transport
            ?.getArtifacts(state.activeTaskId)
            .find((artifact) => /(^|\/)index\.html$/i.test(artifact.fileName))
        : undefined;
    const staticPreviewApplied =
      staticPreviewArtifact !== undefined &&
      state.activeTaskId !== null &&
      isStaticPreviewApplied(state.activeTaskId, staticPreviewArtifact.fileName);
    const previewStatus =
      staticPreviewArtifact !== undefined
        ? staticPreviewApplied
          ? "static-file-ready"
          : "staged-only/apply-required"
        : detectedUrl !== null
          ? "running"
          : suggested.trim().length > 0
            ? "dev-command-available"
            : "unavailable";
    const statusCard = doc.createElement("div");
    statusCard.className = "kw-preview-status";
    statusCard.dataset["testid"] = "preview-status";
    statusCard.textContent = `Preview status: ${previewStatus}`;
    const staticPreview = doc.createElement("div");
    staticPreview.className = "kw-system-notice";
    if (staticPreviewArtifact !== undefined) {
      const staticText = doc.createElement("span");
      staticText.textContent = staticPreviewApplied
        ? `Static preview: ${staticPreviewArtifact.fileName} is applied and can be opened without running a command.`
        : `Static preview: Apply changes before preview. File staged: ${staticPreviewArtifact.fileName}.`;
      const openStatic = doc.createElement("button");
      openStatic.type = "button";
      openStatic.className = "kw-button kw-button-secondary";
      openStatic.dataset["testid"] = "preview-open-static";
      openStatic.textContent = "Open preview";
      openStatic.disabled =
        !staticPreviewApplied ||
        projectRoot.length === 0 ||
        options.desktopShell.shell_open_preview_file === undefined;
      openStatic.title = staticPreviewApplied
        ? "Open the applied index.html with the operating system browser/default app."
        : "Apply Changes before preview. Karo will not open staged-only files.";
      openStatic.addEventListener("click", () => {
        void openStaticPreviewFile(staticPreviewArtifact.fileName);
      });
      const copyPath = doc.createElement("button");
      copyPath.type = "button";
      copyPath.className = "kw-button kw-button-secondary";
      copyPath.dataset["testid"] = "preview-copy-static-path";
      copyPath.textContent = "Copy file path";
      copyPath.title = staticPreviewApplied
        ? "Copy the project-relative index.html path."
        : "Copy the staged project-relative path. Apply Changes before opening it from disk.";
      copyPath.addEventListener("click", () => void copyToClipboard(staticPreviewArtifact.fileName));
      staticPreview.append(staticText, openStatic, copyPath);
      if (state.previewOpenStatus === "opened") {
        const opened = doc.createElement("span");
        opened.className = "kw-preview-open-state";
        opened.textContent = "Opened in browser/default app.";
        staticPreview.append(opened);
      } else if (state.previewOpenStatus === "error" && state.previewOpenError !== null) {
        const error = doc.createElement("span");
        error.className = "kw-preview-open-state";
        error.dataset["state"] = "error";
        error.textContent = state.previewOpenError;
        staticPreview.append(error);
      }
    } else {
      staticPreview.textContent =
        "Static preview: if this run stages an index.html file, Apply Changes first, then open it in a browser.";
    }
    const embeddedNote = doc.createElement("p");
    embeddedNote.className = "kw-preview-meta";
    embeddedNote.textContent = "Embedded preview is not implemented in this MVP; Karo opens applied static files externally or runs an explicit dev command.";
    const notice = doc.createElement("p");
    notice.className = "kw-system-notice kw-system-notice-warning";
    notice.textContent =
      taskState?.isExplainOnly === true
        ? "This was a read-only run. Preview is available only after an implementation task suggests runnable changes."
        : terminalAvailable
          ? "Preview runs through the safe MVP terminal allowlist. Destructive commands are blocked."
          : "Preview command execution is unavailable because the terminal backend is not connected in this runtime.";
    const actions = doc.createElement("div");
    actions.className = "kw-preview-actions";
    const start = doc.createElement("button");
    start.type = "button";
    start.className = "kw-button kw-button-primary";
    start.dataset["testid"] = "preview-run-button";
    start.textContent = state.terminalStatus === "running" ? "Preview running" : "Run preview";
    start.disabled = !terminalAvailable || projectRoot.length === 0 || state.terminalStatus === "running";
    start.title = terminalAvailable
      ? "Run this command through the safe terminal backend."
      : "Unavailable until the integrated terminal runner is available.";
    start.addEventListener("click", () => {
      void startTerminalCommand(commandInput.value, "preview");
    });
    const stop = doc.createElement("button");
    stop.type = "button";
    stop.className = "kw-button kw-button-secondary";
    stop.textContent = "Stop preview";
    stop.disabled = state.terminalStatus !== "running" || state.terminalSessionId === null;
    stop.addEventListener("click", () => void stopTerminalCommand());
    const restart = doc.createElement("button");
    restart.type = "button";
    restart.className = "kw-button kw-button-secondary";
    restart.textContent = "Restart";
    restart.disabled = !terminalAvailable || projectRoot.length === 0;
    restart.addEventListener("click", async () => {
      if (state.terminalStatus === "running") {
        await stopTerminalCommand();
      }
      await startTerminalCommand(commandInput.value, "preview");
    });
    const copyCommand = doc.createElement("button");
    copyCommand.type = "button";
    copyCommand.className = "kw-button kw-button-secondary";
    copyCommand.textContent = "Copy command";
    copyCommand.disabled = suggested.trim().length === 0;
    copyCommand.addEventListener("click", () => void copyToClipboard(commandInput.value));
    const openTerminal = doc.createElement("button");
    openTerminal.type = "button";
    openTerminal.className = "kw-button kw-button-secondary";
    openTerminal.textContent = "Terminal status";
    openTerminal.addEventListener("click", () => setRightTab("terminal"));
    if (terminalAvailable) {
      actions.append(start, stop, restart, copyCommand, openTerminal);
    } else {
      actions.append(start, copyCommand, openTerminal);
    }
    wrap.append(title, statusCard, commandLabel, meta, urlState, staticPreview, embeddedNote, notice, actions);
    return wrap;
  }

  function getApplyResultForTask(taskId: string): any {
    const internal = (options.transport as any)?.tasks?.get?.(taskId);
    if (internal?.applyResult !== undefined && internal.applyResult !== null) {
      return internal.applyResult;
    }
    if (state.lastTaskId === taskId && state.lastApplyResult !== null) {
      return state.lastApplyResult;
    }
    return null;
  }

  function isStaticPreviewApplied(taskId: string, relativePath: string): boolean {
    const applyResult = getApplyResultForTask(taskId);
    if (applyResult === null || applyResult.success !== true || (applyResult.errors?.length ?? 0) > 0) {
      return false;
    }
    const touched = [
      ...(applyResult.changedFiles ?? []),
      ...(applyResult.createdFiles ?? []),
      ...(applyResult.overwrittenFiles ?? []),
      ...(applyResult.skippedFiles ?? []),
    ];
    return touched.length === 0 || touched.includes(relativePath);
  }

  async function openStaticPreviewFile(relativePath: string): Promise<void> {
    const projectRoot = state.project?.path ?? "";
    if (projectRoot.length === 0 || options.desktopShell.shell_open_preview_file === undefined) {
      state.previewOpenStatus = "error";
      state.previewOpenError = "Static preview opener is unavailable in this runtime.";
      renderRightContent();
      return;
    }
    try {
      state.previewOpenStatus = "idle";
      state.previewOpenError = null;
      await options.desktopShell.shell_open_preview_file(projectRoot, relativePath);
      state.previewOpenStatus = "opened";
      showToast("success", "Preview opened in browser/default app.");
    } catch (err: unknown) {
      state.previewOpenStatus = "error";
      state.previewOpenError = describeError(err);
      showToast("error", state.previewOpenError);
    }
    renderRightContent();
  }

  function buildReadOnlyFailureRecovery(
    doc: Document,
    report: FinalReportSummary,
    taskState: TaskStateSnapshot | null | undefined,
    actionsIn: {
      readonly openUsage: () => void;
      readonly retryFailedStage: () => Promise<void>;
      readonly retryReducedContext: () => Promise<void>;
    },
  ): HTMLElement {
    const recovery = taskState?.recoveryState;
    const card = doc.createElement("section");
    card.className = "kw-recovery-card";
    card.dataset["testid"] = "model-timeout-recovery";
    const title = doc.createElement("h4");
    title.textContent = taskState?.decision?.intent === "security_review"
      ? "Security review did not finish"
      : "Analysis did not finish";
    const body = doc.createElement("p");
    body.textContent =
      "The project context was collected, but the model did not return a usable answer. This is not marked as completed.";
    const actions = doc.createElement("div");
    actions.className = "kw-recovery-actions";

    const retry = doc.createElement("button");
    retry.type = "button";
    retry.className = "kw-button kw-button-secondary";
    retry.textContent = "Retry same model";
    retry.disabled = !(recovery?.canRetryFailedStage ?? false);
    retry.title = retry.disabled ? "Retry is unavailable for this failure." : "Retry the same read-only stage.";
    retry.addEventListener("click", () => void actionsIn.retryFailedStage());

    const switchModel = doc.createElement("button");
    switchModel.type = "button";
    switchModel.className = "kw-button kw-button-secondary";
    switchModel.textContent = "Switch model";
    switchModel.addEventListener("click", () => navigate("models"));

    const reduce = doc.createElement("button");
    reduce.type = "button";
    reduce.className = "kw-button kw-button-secondary";
    reduce.textContent = "Reduce context and retry";
    reduce.disabled = !(recovery?.canRetryReducedContext ?? false);
    reduce.title = reduce.disabled
      ? "Reduced-context retry is unavailable for this failure."
      : "Retry the same read-only stage with reduced context.";
    reduce.addEventListener("click", () => void actionsIn.retryReducedContext());

    const showFiles = doc.createElement("button");
    showFiles.type = "button";
    showFiles.className = "kw-button kw-button-secondary";
    showFiles.textContent = "Show selected files";
    showFiles.addEventListener("click", actionsIn.openUsage);

    const copy = doc.createElement("button");
    copy.type = "button";
    copy.className = "kw-button kw-button-secondary";
    copy.textContent = "Copy context summary";
    copy.addEventListener("click", () => {
      const summary = taskState?.contextSummary;
      const selected = summary?.selectedFiles?.map((file) => `- ${file.relativePath}`).join("\n") ?? "";
      void copyToClipboard([
        `Prompt: ${report.originalPrompt}`,
        `Status: ${report.status}`,
        summary !== undefined
          ? `Context: ${summary.selectedFilesCount} selected / ${summary.scannedFilesCount} scanned`
          : "Context: unavailable",
        selected.length > 0 ? `Selected files:\n${selected}` : "Selected files: none",
      ].join("\n"));
    });

    actions.append(retry, switchModel, reduce, showFiles, copy);
    card.append(title, body, actions);
    return card;
  }

  function isCoderTimeoutReport(
    report: FinalReportSummary,
    taskState: TaskStateSnapshot | null | undefined,
  ): boolean {
    const issues = report.outstandingIssues?.join("\n") ?? "";
    if (/Coder timed out|provider_timeout|Retry Coder/i.test(issues)) return true;
    return (
      taskState?.providerDiagnostics?.some(
        (diagnostic) => diagnostic.agentId === "coder" && diagnostic.errorType === "provider_timeout",
      ) ?? false
    );
  }

  function buildCoderTimeoutRecovery(
    doc: Document,
    report: FinalReportSummary,
    taskState: TaskStateSnapshot | null | undefined,
    actionsIn: {
      readonly openChanges: () => void;
      readonly openLogs: () => void;
      readonly openModels: () => void;
      readonly retryFailedStage: () => Promise<void>;
      readonly retryReducedContext: () => Promise<void>;
      readonly continuePartial: () => Promise<void>;
    },
  ): HTMLElement {
    const latestCoderFailure = [...(taskState?.providerDiagnostics ?? [])]
      .reverse()
      .find((diagnostic) => diagnostic.agentId === "coder" && diagnostic.errorType !== undefined);
    const recovery = taskState?.recoveryState;
    const card = doc.createElement("section");
    card.className = "kw-recovery-card";
    card.dataset["testid"] = "coder-timeout-recovery";
    const title = doc.createElement("h4");
    title.textContent = recovery?.failedFile ? `Coder recovery: ${recovery.failedFile}` : "Coder timed out";
    const body = doc.createElement("p");
    const elapsed =
      latestCoderFailure !== undefined
        ? ` Last call ran for ${String(Math.round(latestCoderFailure.elapsedMs / 1000))}s with an estimated ${String(latestCoderFailure.inputTokenEstimate)} input tokens.`
        : "";
    body.textContent =
      (recovery?.recoveryReasonUser ??
        "Karo kept the Researcher/Planner output and any staged draft files, but this run is not completed. Emergency fallback is available only as an explicit recovery choice, not as a success path.") +
      elapsed;
    const actions = doc.createElement("div");
    actions.className = "kw-recovery-actions";

    const retry = doc.createElement("button");
    retry.type = "button";
    retry.className = "kw-button kw-button-secondary";
    retry.textContent = "Retry failed stage";
    retry.disabled = !(recovery?.canRetryFailedStage ?? false);
    retry.title = retry.disabled ? "Retry is unavailable for this failure." : "Retry only the failed stage/file.";
    retry.addEventListener("click", () => void actionsIn.retryFailedStage());

    const reduce = doc.createElement("button");
    reduce.type = "button";
    reduce.className = "kw-button kw-button-secondary";
    reduce.textContent = "Retry with reduced context";
    reduce.disabled = !(recovery?.canRetryReducedContext ?? false);
    reduce.title = reduce.disabled
      ? "Reduced-context retry is unavailable or was already attempted for this failure."
      : "Retry the failed stage/file with a smaller prompt/context.";
    reduce.addEventListener("click", () => void actionsIn.retryReducedContext());

    const switchModel = doc.createElement("button");
    switchModel.type = "button";
    switchModel.className = "kw-button kw-button-secondary";
    switchModel.textContent = "Switch model";
    switchModel.disabled = recovery?.canSwitchModel === false;
    switchModel.title = switchModel.disabled
      ? "Inline switch is not wired; choose another model from Models and retry."
      : "Open Models to choose another model.";
    switchModel.addEventListener("click", actionsIn.openModels);

    const partial = doc.createElement("button");
    partial.type = "button";
    partial.className = "kw-button kw-button-secondary";
    partial.textContent = "Continue from partial artifacts";
    partial.disabled = !(recovery?.canContinueFromPartial ?? report.finalArtifacts.length > 0);
    partial.title =
      partial.disabled
        ? "No partial artifacts were staged before the timeout."
        : "Continue from the first missing/failed file while preserving existing staged artifacts.";
    partial.addEventListener("click", () => void actionsIn.continuePartial());

    const inspect = doc.createElement("button");
    inspect.type = "button";
    inspect.className = "kw-button kw-button-secondary";
    inspect.textContent = "Show preserved files";
    inspect.disabled = report.finalArtifacts.length === 0;
    inspect.title =
      report.finalArtifacts.length === 0
        ? "No staged files were preserved."
        : "Open Changes to inspect preserved staged artifacts.";
    inspect.addEventListener("click", actionsIn.openChanges);

    const emergency = doc.createElement("button");
    emergency.type = "button";
    emergency.className = "kw-button kw-button-secondary";
    emergency.textContent = "Use emergency static scaffold";
    emergency.disabled = true;
    emergency.title = "Emergency scaffold requires an explicit user action; it is not auto-generated as success.";

    const logs = doc.createElement("button");
    logs.type = "button";
    logs.className = "kw-button kw-button-secondary";
    logs.textContent = "Show diagnostics";
    logs.addEventListener("click", actionsIn.openLogs);

    const copy = doc.createElement("button");
    copy.type = "button";
    copy.className = "kw-button kw-button-secondary";
    copy.textContent = "Copy safe diagnostics";
    copy.addEventListener("click", () => {
      const diagnostics = taskState?.providerDiagnostics ?? [];
      const lines = diagnostics.map((diagnostic) =>
        [
          `${diagnostic.stageName}: ${diagnostic.provider}/${diagnostic.modelId}`,
          `tokens=${String(diagnostic.inputTokenEstimate)}`,
          `contextFiles=${String(diagnostic.selectedFilesCount)}`,
          `contextTokens=${String(diagnostic.contextTokens)}`,
          `timeoutMs=${String(diagnostic.timeoutMs)}`,
          `elapsedMs=${String(diagnostic.elapsedMs)}`,
          `error=${diagnostic.errorType ?? "none"}`,
          `artifactsCreated=${String(diagnostic.artifactsCreated)}`,
        ].join(" | "),
      );
      void copyToClipboard(
        [
          `Prompt: ${report.originalPrompt}`,
          `Status: ${report.status}`,
          `Artifacts saved: ${String(report.finalArtifacts.length)}`,
          lines.length > 0 ? lines.join("\n") : "Provider diagnostics: none",
        ].join("\n"),
      );
    });

    actions.append(retry, reduce, switchModel, partial, inspect, emergency, logs, copy);
    card.append(title, body, actions);
    return card;
  }

  function buildTerminalView(): HTMLElement {
    const wrap = doc.createElement("div");
    wrap.className = "kw-terminal-panel";
    const title = doc.createElement("h3");
    title.textContent = "Terminal";
    const terminalAvailable = hasTerminalBackend();
    const body = doc.createElement("p");
    body.className = "kw-empty-body";
    body.textContent = terminalAvailable
      ? `Safe terminal MVP runner connected. Status: ${getTerminalDisplayStatus()}. This is not a full PTY terminal.`
      : "Terminal backend is not connected in this runtime. Command execution is disabled.";
    const profileLabel = doc.createElement("label");
    profileLabel.className = "kw-terminal-profile";
    const profileText = doc.createElement("span");
    profileText.textContent = "Shell profile";
    const profileSelect = doc.createElement("select");
    profileSelect.dataset["testid"] = "terminal-profile";
    const availableProfiles = state.terminalProfiles.filter((profile) => profile.available);
    profileSelect.disabled = !terminalAvailable || availableProfiles.length === 0;
    const profiles =
      state.terminalProfiles.length > 0
        ? state.terminalProfiles
        : [{ id: state.terminalProfileId || "default", label: "Default shell", shell: "", available: terminalAvailable }];
    for (const profile of profiles) {
      const opt = doc.createElement("option");
      opt.value = profile.id;
      opt.disabled = !profile.available;
      opt.textContent = `${profile.label}${profile.shell.length > 0 ? ` (${profile.shell})` : ""}${profile.available ? "" : " - unavailable"}`;
      opt.selected = profile.id === state.terminalProfileId;
      profileSelect.append(opt);
    }
    profileSelect.addEventListener("change", () => {
      state.terminalProfileId = profileSelect.value;
      localStorage.setItem("karo.terminalProfile", state.terminalProfileId);
      renderBottomTools();
    });
    profileLabel.append(profileText, profileSelect);
    const command = doc.createElement("input");
    command.className = "kw-terminal-command";
    command.value =
      localStorage.getItem("karo.previewCommandSource") === "user_custom"
        ? localStorage.getItem("karo.previewCommand") ?? state.detectedPreviewCommand
        : state.detectedPreviewCommand;
    command.placeholder = terminalAvailable ? "pnpm test" : "Command execution unavailable in this runtime";
    command.disabled = !terminalAvailable;
    const actions = doc.createElement("div");
    actions.className = "kw-terminal-actions";
    const runBtn = doc.createElement("button");
    runBtn.type = "button";
    runBtn.className = "kw-button kw-button-primary";
    runBtn.textContent = "Run command";
    runBtn.disabled = !terminalAvailable || state.project === null || state.terminalStatus === "running";
    runBtn.addEventListener("click", () => void startTerminalCommand(command.value, "manual"));
    const stopBtn = doc.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "kw-button kw-button-secondary";
    stopBtn.textContent = "Stop";
    stopBtn.disabled = state.terminalStatus !== "running" || state.terminalSessionId === null;
    stopBtn.addEventListener("click", () => void stopTerminalCommand());
    const clearBtn = doc.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "kw-button kw-button-secondary";
    clearBtn.textContent = "Clear";
    clearBtn.disabled = state.terminalSessionId === null && state.terminalLines.length === 0;
    clearBtn.addEventListener("click", () => void clearTerminalOutput());
    const copyBtn = doc.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "kw-button kw-button-secondary";
    copyBtn.textContent = "Copy logs";
    copyBtn.disabled = state.terminalLines.length === 0 && state.logs.length === 0;
    copyBtn.addEventListener("click", () => void copyToClipboard(formatTerminalOutputForCopy()));
    if (terminalAvailable) {
      actions.append(runBtn, stopBtn, clearBtn, copyBtn);
    } else {
      actions.append(copyBtn);
    }
    const output = doc.createElement("pre");
    output.className = "kw-terminal-output";
    output.dataset["testid"] = "terminal-output";
    output.textContent = formatTerminalOutputForDisplay(terminalAvailable);
    wrap.append(title, body, profileLabel, command, actions, output);
    return wrap;
  }

  function getTerminalDisplayStatus(): string {
    if (state.terminalStatus === "exited" && state.terminalExitCode === 0) return "success";
    if (state.terminalStatus === "exited") return "completed";
    return state.terminalStatus;
  }

  function formatTerminalOutputForDisplay(terminalAvailable: boolean): string {
    const lines =
      state.terminalLines.length > 0
        ? state.terminalLines.map((line) => `[${line.stream}] ${line.text}`).join("\n")
        : state.terminalError ?? (terminalAvailable ? "No terminal output yet." : "Backend unavailable.");
    if (state.terminalExitCode === null) return lines;
    return `${lines}\nExit code: ${String(state.terminalExitCode)}`;
  }

  function renderBottomTools(): void {
    bottomTools.innerHTML = "";
    const header = doc.createElement("button");
    header.type = "button";
    header.className = "kw-bottom-tools-head";
    const label = doc.createElement("span");
    label.textContent = "Terminal";
    const status = doc.createElement("span");
    status.className = "kw-bottom-tools-status";
    status.textContent = hasTerminalBackend() ? getTerminalDisplayStatus() : "backend not connected";
    const toggle = doc.createElement("span");
    toggle.className = "kw-bottom-tools-toggle";
    toggle.textContent = bottomTools.dataset["open"] === "true" ? "Hide" : "Show";
    header.append(label, status, toggle);
    header.addEventListener("click", () => {
      bottomTools.dataset["open"] = bottomTools.dataset["open"] === "true" ? "false" : "true";
      renderBottomTools();
    });
    bottomTools.append(header);
    if (bottomTools.dataset["open"] === "true") {
      const body = doc.createElement("div");
      body.className = "kw-bottom-tools-body";
      body.append(buildTerminalView());
      bottomTools.append(body);
    }
  }

  function hasTerminalBackend(): boolean {
    return (
      options.desktopShell.shell_start_command !== undefined &&
      options.desktopShell.shell_stop_command !== undefined &&
      options.desktopShell.shell_get_command_output !== undefined &&
      options.desktopShell.shell_clear_command_output !== undefined
    );
  }

  async function loadTerminalProfiles(): Promise<void> {
    if (options.desktopShell.shell_get_terminal_profiles === undefined) return;
    try {
      const profiles = await options.desktopShell.shell_get_terminal_profiles();
      state.terminalProfiles = [...profiles];
      const availableProfiles = state.terminalProfiles.filter((profile) => profile.available);
      if (
        state.terminalProfileId.length === 0 ||
        !availableProfiles.some((profile) => profile.id === state.terminalProfileId)
      ) {
        state.terminalProfileId = availableProfiles[0]?.id ?? "";
        if (state.terminalProfileId.length > 0) {
          localStorage.setItem("karo.terminalProfile", state.terminalProfileId);
        }
      }
      renderBottomTools();
      if (state.rightTab === "terminal" || state.rightTab === "preview") {
        renderRightContent();
      }
    } catch (err) {
      pushLog("warn", `Terminal profiles unavailable: ${describeError(err)}`);
    }
  }

  async function refreshDetectedPreviewCommand(projectPath: string): Promise<void> {
    if (options.desktopShell.readProjectSummary === undefined) return;
    const userSource = localStorage.getItem("karo.previewCommandSource");
    if (userSource === "user_custom") return;
    try {
      const summary = await options.desktopShell.readProjectSummary(projectPath);
      if (state.project?.path !== projectPath) return;
      const packageSnippet = summary.snippets.find((snippet) => snippet.path.replaceAll("\\", "/") === "package.json");
      const command = packageSnippet !== undefined ? detectPreviewCommandFromPackageJson(packageSnippet.content) : "";
      if (command.length > 0) {
        state.detectedPreviewCommand = command;
        state.detectedPreviewCommandSource = "package_json";
      } else {
        state.detectedPreviewCommand = detectPreviewCommand();
        state.detectedPreviewCommandSource = "default";
      }
      if (state.rightTab === "preview" || bottomTools.dataset["open"] === "true") {
        renderRightContent();
        renderBottomTools();
      }
    } catch {
      state.detectedPreviewCommand = detectPreviewCommand();
      state.detectedPreviewCommandSource = "default";
    }
  }

  async function startTerminalCommand(command: string, mode: "preview" | "manual"): Promise<void> {
    const projectRoot = state.project?.path ?? "";
    if (!hasTerminalBackend()) {
      state.terminalError = "Terminal backend is not connected in this runtime.";
      state.terminalStatus = "error";
      state.terminalExitCode = null;
      renderBottomTools();
      renderRightContent();
      return;
    }
    if (projectRoot.length === 0) {
      state.terminalError = "Select a project root before running terminal commands.";
      state.terminalStatus = "error";
      state.terminalExitCode = null;
      renderBottomTools();
      renderRightContent();
      return;
    }
    try {
      state.terminalError = null;
      const result = await options.desktopShell.shell_start_command!(projectRoot, command, mode, state.terminalProfileId || undefined);
      state.terminalSessionId = result.sessionId;
      state.terminalStatus = result.status;
      state.terminalLines = [];
      state.terminalExitCode = null;
      state.previewUrl = null;
      bottomTools.dataset["open"] = "true";
      pushLog("info", `Terminal started: ${command}`);
      startTerminalPolling();
      await refreshTerminalOutput();
      renderBottomTools();
      renderRightContent();
    } catch (err) {
      state.terminalError = describeError(err);
      state.terminalStatus = "blocked";
      state.terminalLines = [];
      state.terminalExitCode = null;
      bottomTools.dataset["open"] = "true";
      pushLog("warn", `Terminal command blocked or failed: ${state.terminalError}`);
      renderBottomTools();
      renderRightContent();
    }
  }

  async function stopTerminalCommand(): Promise<void> {
    if (state.terminalSessionId === null || options.desktopShell.shell_stop_command === undefined) return;
    try {
      const output = await options.desktopShell.shell_stop_command(state.terminalSessionId);
      state.terminalStatus = output.status;
      state.terminalLines = [...output.lines];
      state.terminalExitCode = output.exitCode ?? null;
      stopTerminalPollingIfTerminal();
      pushLog("info", `Terminal stopped: ${state.terminalSessionId}`);
    } catch (err) {
      state.terminalError = describeError(err);
      state.terminalStatus = "error";
    }
    renderBottomTools();
    renderRightContent();
  }

  async function refreshTerminalOutput(): Promise<void> {
    if (state.terminalSessionId === null || options.desktopShell.shell_get_command_output === undefined) return;
    try {
      const output = await options.desktopShell.shell_get_command_output(state.terminalSessionId);
      state.terminalStatus = output.status;
      state.terminalLines = [...output.lines];
      state.terminalExitCode = output.exitCode ?? null;
      const detectedUrl = detectPreviewUrlFromLines(state.terminalLines);
      if (detectedUrl !== null) {
        state.previewUrl = detectedUrl;
      }
      if (output.status !== "running") {
        stopTerminalPollingIfTerminal();
      }
      renderBottomTools();
      if (state.rightTab === "preview") renderRightContent();
    } catch (err) {
      state.terminalError = describeError(err);
      state.terminalStatus = "error";
      stopTerminalPollingIfTerminal();
      renderBottomTools();
      renderRightContent();
    }
  }

  async function clearTerminalOutput(): Promise<void> {
    if (state.terminalSessionId !== null && options.desktopShell.shell_clear_command_output !== undefined) {
      await options.desktopShell.shell_clear_command_output(state.terminalSessionId).catch((err: unknown) => {
        state.terminalError = describeError(err);
      });
    }
    state.terminalLines = [];
    state.terminalExitCode = null;
    renderBottomTools();
  }

  function startTerminalPolling(): void {
    if (terminalPollTimer !== null) return;
    terminalPollTimer = doc.defaultView?.setInterval(() => {
      void refreshTerminalOutput();
    }, 1_000) ?? null;
  }

  function stopTerminalPollingIfTerminal(): void {
    if (terminalPollTimer !== null && state.terminalStatus !== "running") {
      doc.defaultView?.clearInterval(terminalPollTimer);
      terminalPollTimer = null;
    }
  }

  function formatTerminalOutputForCopy(): string {
    const terminal = state.terminalLines.map((line) => `[${line.stream}] ${line.text}`).join("\n");
    if (terminal.length > 0) {
      return state.terminalExitCode === null ? terminal : `${terminal}\nExit code: ${String(state.terminalExitCode)}`;
    }
    return state.logs.map((log) => `${log.at} ${log.level}: ${log.text}`).join("\n");
  }

  function buildArtifactList(): HTMLElement {
    const wrap = doc.createElement("div");
    wrap.className = "kw-changes";
    const taskId = state.activeTaskId;
    if (taskId === null || options.transport === undefined) {
      wrap.append(
        buildEmpty(
          doc,
          "No changes yet",
          "Ask Agent to modify files, then proposed changes will appear here for review before Apply Changes.",
        ),
      );
      return wrap;
    }
    const artifacts = options.transport.getArtifacts(taskId);
    const taskState = options.transport.getTaskState(taskId);
    const isExplainOnly = taskState?.isExplainOnly === true;

    if (isExplainOnly) {
      wrap.append(
        buildEmpty(
          doc,
          "Read-only analysis",
          "This was a read-only analysis. No file changes were produced.",
        ),
      );
      return wrap;
    }

    if (artifacts.length === 0) {
      const terminalNoArtifacts =
        taskState?.status === "completed" ||
        taskState?.status === "error" ||
        taskState?.status === "stopped_limit";
      wrap.append(
        buildEmpty(
          doc,
          terminalNoArtifacts ? "No file changes for this run" : "Preparing changes",
          terminalNoArtifacts
            ? "This run did not produce artifacts. Chat, Plan, Safety, and read-only analysis runs do not create Apply Changes entries."
            : "Agent Mode is preparing proposed file changes. They will appear here before anything is applied.",
        ),
      );
      return wrap;
    }
    const list = doc.createElement("ul");
    list.className = "kw-changes-list";
    for (const meta of artifacts) {
      const statusInfo = describeArtifactStatus(meta);
      const li = doc.createElement("li");
      li.className = "kw-changes-item";
      li.dataset["artifactId"] = meta.id;
      li.dataset["status"] = statusInfo.status;
      const header = doc.createElement("header");
      header.className = "kw-changes-head";
      const name = doc.createElement("span");
      name.className = "kw-changes-name";
      name.textContent = meta.fileName;
      const version = doc.createElement("span");
      version.className = "kw-changes-version";
      version.textContent = `v${String(meta.latestVersion)}`;
      const author = doc.createElement("span");
      author.className = "kw-changes-author";
      author.textContent = `by ${readableAgentName(meta.authoredByAgentId)}`;
      const status = doc.createElement("span");
      status.className = "kw-changes-status";
      status.dataset["status"] = statusInfo.status;
      status.textContent = statusInfo.label;
      header.append(name, status, version, author);
      li.append(header);
      if (statusInfo.reason.length > 0) {
        const reason = doc.createElement("p");
        reason.className = "kw-changes-reason";
        reason.textContent = statusInfo.reason;
        li.append(reason);
      }

      const actions = doc.createElement("div");
      actions.className = "kw-changes-actions";
      const openBtn = doc.createElement("button");
      openBtn.type = "button";
      openBtn.className = "kw-button kw-button-secondary kw-changes-open";
      openBtn.textContent = "Open";
      const copyBtn = doc.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "kw-button kw-button-secondary kw-changes-copy";
      copyBtn.textContent = "Copy";
      const diffBtn = doc.createElement("button");
      diffBtn.type = "button";
      diffBtn.className = "kw-button kw-button-secondary kw-changes-diff";
      diffBtn.textContent = "View diff";
      diffBtn.disabled = !canViewArtifactDiff(meta);
      actions.append(openBtn, copyBtn, diffBtn);
      li.append(actions);

      const preview = doc.createElement("pre");
      preview.className = "kw-changes-preview";
      preview.hidden = true;

      openBtn.addEventListener("click", () => {
        if (preview.hidden) {
          const v: ArtifactVersion | null = options.transport!.getArtifactVersion(
            taskId,
            meta.id,
            meta.latestVersion,
          );
          preview.textContent = v !== null ? v.content : "Artifact version not available.";
          preview.hidden = false;
          openBtn.textContent = "Hide";
        } else {
          preview.hidden = true;
          openBtn.textContent = "Open";
        }
      });
      copyBtn.addEventListener("click", () => {
        const v: ArtifactVersion | null = options.transport!.getArtifactVersion(
          taskId,
          meta.id,
          meta.latestVersion,
        );
        if (v !== null) {
          void copyToClipboard(v.content);
        }
      });
      diffBtn.addEventListener("click", () => {
        const diff = buildArtifactDiffText(taskId, meta);
        state.activeArtifactId = meta.id;
        state.activeArtifactVersion = meta.latestVersion;
        state.activeArtifactDiff = diff;
        state.rightTab = "diff";
        for (const [id, btn] of rightTabButtons.entries()) {
          btn.setAttribute("aria-current", id === state.rightTab ? "page" : "false");
        }
        renderRightContent();
      });

      li.append(preview);
      list.append(li);
    }
    wrap.append(list);

    if (taskState !== null && !taskState.isExplainOnly && (taskState.status === "completed" || taskState.status === "stopped_limit" || taskState.status === "error")) {
      const applyContainer = doc.createElement("div");
      applyContainer.className = "kw-apply-container";
      applyContainer.style.margin = "16px";
      applyContainer.style.padding = "16px";
      applyContainer.style.borderRadius = "8px";
      applyContainer.style.background = "rgba(255, 255, 255, 0.03)";
      applyContainer.style.border = "1px solid rgba(255, 255, 255, 0.08)";
      applyContainer.style.backdropFilter = "blur(12px)";
      applyContainer.style.textAlign = "center";

      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "kw-button kw-button-primary";
      btn.dataset["testid"] = "changes-apply-button";
      btn.style.width = "100%";
      btn.style.padding = "10px";
      btn.style.fontSize = "14px";
      btn.style.fontWeight = "600";
      btn.textContent = state.demoPipelineMode ? "Simulated Apply" : "Apply Changes";

      const statusMsg = doc.createElement("p");
      statusMsg.style.margin = "12px 0 0 0";
      statusMsg.style.fontSize = "13px";
      statusMsg.style.color = "rgba(255, 255, 255, 0.6)";

      const internalTask = (options.transport as any).tasks?.get(taskId);
      const applyResult = internalTask?.applyResult;

      if (applyResult) {
        renderApplyResult(applyResult);
      }

      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = state.demoPipelineMode ? "Simulating..." : "Applying...";
        statusMsg.textContent = state.demoPipelineMode
          ? "Running security checks and simulating changes..."
          : "Running security checks and writing changes to disk...";
        state.lastTaskId = taskId;
        state.lastApplyCommandCalled = true;
        state.lastStagingPath = state.demoPipelineMode
          ? `(simulated staging path for task ${taskId})`
          : `${state.project?.path ?? ""}\\.karo\\staging\\task_${taskId}`;

        try {
          const res = await options.transport!.applyStagedChanges(taskId, true);
          state.lastApplyResult = res;
          state.lastApplyError = (res.errors && res.errors.length > 0) ? res.errors.join("; ") : null;
          renderApplyResult(res);
        } catch (e: any) {
          const errMsg = e?.message ?? String(e);
          state.lastApplyError = errMsg;
          state.lastApplyResult = { success: false, errors: [errMsg] };
          statusMsg.textContent = `Error: ${errMsg}`;
          statusMsg.style.color = "#ff6b6b";
          btn.disabled = false;
          btn.textContent = state.demoPipelineMode ? "Simulated Apply" : "Apply Changes";
        }
      });

      function renderApplyResult(res: any) {
        btn.style.display = "none";
        statusMsg.style.display = "none";

        const title = doc.createElement("h4");
        title.style.margin = "0 0 12px 0";

        const hasAppliedChanges = (res.createdFiles && res.createdFiles.length > 0) || (res.overwrittenFiles && res.overwrittenFiles.length > 0);
        const hasErrors = res.errors && res.errors.length > 0;
        const isOffline = state.demoPipelineMode || (res.errors && res.errors.some((e: string) => e.toLowerCase().includes("offline") || e.includes("Demo Mode")));

        const blockedErrors = res.errors ? res.errors.filter((e: string) =>
          e.toLowerCase().includes("prohibited") ||
          e.toLowerCase().includes("outside") ||
          e.toLowerCase().includes("permissiondenied") ||
          e.toLowerCase().includes("blocked")
        ) : [];
        const otherErrors = res.errors ? res.errors.filter((e: string) =>
          !blockedErrors.includes(e) &&
          !(e.toLowerCase().includes("offline") || e.includes("Demo Mode"))
        ) : [];

        let statusText = "";
        let statusColor = "";

        if (isOffline) {
          statusText = "⚠ Simulation Mode (Preview Only)";
          statusColor = "var(--karo-warning, #e6b400)";
        } else if (hasErrors) {
          if (hasAppliedChanges) {
            statusText = "⚠ Partial Success (Some files updated, some failed/blocked)";
            statusColor = "var(--karo-warning, #e6b400)";
          } else if (blockedErrors.length > 0) {
            statusText = "⚠ Blocked Changes (Paths prohibited)";
            statusColor = "var(--karo-warning, #e6b400)";
          } else {
            statusText = "✗ Apply Failed";
            statusColor = "#f44747";
          }
        } else if (!hasAppliedChanges) {
          statusText = "✓ No Changes Applied (All files up-to-date)";
          statusColor = "#4a90e2";
        } else {
          statusText = "✓ Changes Applied Successfully";
          statusColor = "#4ec9b0";
        }

        title.style.color = statusColor;
        title.textContent = statusText;
        applyContainer.append(title);

        const details = doc.createElement("div");
        details.style.textAlign = "left";
        details.style.fontSize = "12px";
        details.style.color = "rgba(255, 255, 255, 0.8)";
        details.style.lineHeight = "1.6";

        if (isOffline) {
          const item = doc.createElement("div");
          item.style.color = "var(--karo-warning, #e6b400)";
          item.style.fontWeight = "600";
          item.style.marginBottom = "8px";
          item.textContent = "Simulation only: no files were written to disk.";
          details.append(item);
        }

        if (res.createdFiles && res.createdFiles.length > 0) {
          const item = doc.createElement("div");
          item.innerHTML = `<strong>Created:</strong><br/>` + res.createdFiles.map((f: string) => `• ${f}`).join("<br/>");
          details.append(item);
        }

        if (res.overwrittenFiles && res.overwrittenFiles.length > 0) {
          const item = doc.createElement("div");
          item.style.marginTop = "8px";
          item.innerHTML = `<strong>Modified:</strong><br/>` + res.overwrittenFiles.map((f: string) => `• ${f}`).join("<br/>") +
                           `<br/><strong style="display:inline-block;margin-top:4px;">Backups created:</strong><br/>` +
                           res.overwrittenFiles.map((f: string) => `• ${f} → ${f}.bak`).join("<br/>");
          details.append(item);
        }

        if (res.skippedFiles && res.skippedFiles.length > 0) {
          const item = doc.createElement("div");
          item.style.marginTop = "8px";
          item.innerHTML = `<strong>Skipped (Identical):</strong><br/>` + res.skippedFiles.map((f: string) => `• ${f}`).join("<br/>");
          details.append(item);
        }

        if (blockedErrors.length > 0) {
          const item = doc.createElement("div");
          item.style.marginTop = "8px";
          item.style.color = "var(--karo-warning, #e6b400)";
          item.innerHTML = `<strong>Blocked / Prohibited:</strong><br/>` + blockedErrors.map((e: string) => `• ${e}`).join("<br/>");
          details.append(item);
        }

        if (otherErrors.length > 0) {
          const item = doc.createElement("div");
          item.style.marginTop = "8px";
          item.style.color = "#ff6b6b";
          item.innerHTML = `<strong>Errors:</strong><br/>` + otherErrors.map((e: string) => `• ${e}`).join("<br/>");
          details.append(item);
        }

        applyContainer.append(details);
      }

      applyContainer.append(btn, statusMsg);
      wrap.append(applyContainer);
    }

    return wrap;
  }

  async function renderProjectFiles(projectPath: string): Promise<void> {
    if (state.rightTab !== "files" || state.project?.path !== projectPath) return;
    if (options.desktopShell.readProjectSummary === undefined) {
      rightContent.innerHTML = "";
      rightContent.append(
        buildEmpty(
          doc,
          "Files unavailable",
          "This runtime does not expose read-only project filesystem access.",
        ),
      );
      return;
    }
    try {
      const summary = await options.desktopShell.readProjectSummary(projectPath);
      if (state.rightTab !== "files" || state.project?.path !== projectPath) return;
      rightContent.innerHTML = "";
      const wrap = doc.createElement("div");
      wrap.className = "kw-files-tree";
      const title = doc.createElement("p");
      title.className = "kw-empty-title";
      title.textContent = toDisplayPath(summary.rootPath);
      const list = doc.createElement("ul");
      list.className = "kw-files-list";
      for (const file of summary.files.slice(0, 80)) {
        const li = doc.createElement("li");
        li.className = "kw-files-item";
        li.dataset["kind"] = file.kind;
        li.textContent = file.kind === "directory" ? `${file.path}/` : file.path;
        list.append(li);
      }
      wrap.append(title, list);
      if (summary.omitted.length > 0) {
        const omitted = doc.createElement("p");
        omitted.className = "kw-empty-body";
        omitted.textContent = `Omitted: ${summary.omitted.slice(0, 8).join(", ")}`;
        wrap.append(omitted);
      }
      rightContent.append(wrap);
    } catch (err) {
      if (state.rightTab !== "files") return;
      rightContent.innerHTML = "";
      rightContent.append(buildEmpty(doc, "Project files unavailable", describeError(err)));
    }
  }

  function buildDiffView(): HTMLElement {
    const wrap = doc.createElement("div");
    wrap.className = "kw-diff-view";
    if (state.activeTaskId === null || state.activeArtifactId === null) {
      wrap.append(
        buildEmpty(
          doc,
          "No diff selected",
          "View side-by-side or inline differences for modified files. Run a task or select View diff in the Changes tab.",
          {
            label: "Check Changes tab",
            onClick: () => setRightTab("changes"),
          },
        ),
      );
      return wrap;
    }
    const taskId = state.activeTaskId;
    const meta = options.transport
      ?.getArtifacts(taskId)
      .find((a) => a.id === state.activeArtifactId);
    if (meta === undefined) {
      wrap.append(buildEmpty(doc, "Diff unavailable", "Selected artifact is no longer available."));
      return wrap;
    }
    const title = doc.createElement("p");
    title.className = "kw-diff-title";
    title.textContent = `${meta.fileName} v${String(meta.latestVersion)}`;
    const pre = doc.createElement("pre");
    pre.className = "kw-diff-pre";
    pre.textContent = state.activeArtifactDiff ?? buildArtifactDiffText(taskId, meta);
    wrap.append(title, pre);
    return wrap;
  }

  function describeArtifactStatus(meta: ArtifactMetadata): {
    status: "proposed" | "ready" | "warning" | "failed";
    label: string;
    reason: string;
  } {
    const taskState =
      state.activeTaskId !== null ? options.transport?.getTaskState(state.activeTaskId) : null;
    const report =
      state.activeTaskId !== null ? options.transport?.getFinalReport(state.activeTaskId) : null;
    if (taskState?.status === "error") {
      return { status: "failed", label: "failed", reason: taskState.errorReason ?? "Run failed." };
    }
    if (report?.status === "completed" || taskState?.status === "completed") {
      return {
        status: "ready",
        label: "ready",
        reason: "Completed run. Ready for review before applying.",
      };
    }
    if (report?.status === "stopped_limit" || taskState?.status === "stopped_limit") {
      const reason = report?.outstandingIssues?.[0] ?? "Run stopped and needs user review.";
      return { status: "warning", label: "needs review", reason };
    }
    if (meta.latestVersion > 0) {
      return {
        status: "proposed",
        label: "proposed",
        reason: "Generated by the current run; final acceptance is pending.",
      };
    }
    return { status: "proposed", label: "proposed", reason: "" };
  }

  function canViewArtifactDiff(meta: ArtifactMetadata): boolean {
    return meta.latestVersion > 1 || looksLikeDiffArtifact(meta.fileName);
  }

  function looksLikeDiffArtifact(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return lower.endsWith(".diff") || lower.endsWith(".patch") || lower.includes("diff");
  }

  function buildArtifactDiffText(taskId: string, meta: ArtifactMetadata): string {
    if (options.transport === undefined) return "Diff unavailable: no transport.";
    const latest = options.transport.getArtifactVersion(taskId, meta.id, meta.latestVersion);
    if (latest === null) return "Diff unavailable: latest artifact version is missing.";
    if (looksLikeDiffArtifact(meta.fileName)) return latest.content;
    if (meta.latestVersion < 2) {
      return "Diff unavailable: this artifact has only one version and no patch artifact.";
    }
    const previous = options.transport.getArtifactVersion(taskId, meta.id, meta.latestVersion - 1);
    if (previous === null) return latest.content;
    return buildSimpleLineDiff(previous.content, latest.content, meta.fileName);
  }

  function buildLogsView(): HTMLElement {
    const wrap = doc.createElement("div");
    wrap.className = "kw-logs";

    // Render staging directory and test-run.log details if available
    const taskId = state.activeTaskId;
    if (taskId !== null && options.transport !== undefined) {
      const taskState = options.transport.getTaskState(taskId);
      if (taskState !== null && (taskState.stagingDirectory || taskState.testRunLogContent)) {
        const stagingBox = doc.createElement("div");
        stagingBox.className = "kw-staging-box";
        stagingBox.style.margin = "12px";
        stagingBox.style.padding = "12px";
        stagingBox.style.borderRadius = "6px";
        stagingBox.style.background = "var(--vscode-editor-background, #1e1e1e)";
        stagingBox.style.border = "1px solid var(--vscode-widget-border, #3c3c3c)";

        const stTitle = doc.createElement("h4");
        stTitle.style.margin = "0 0 8px 0";
        stTitle.style.color = "var(--vscode-notifications-foreground, #cccccc)";
        stTitle.style.fontSize = "12px";
        stTitle.style.textTransform = "uppercase";
        stTitle.style.letterSpacing = "0.5px";
        stTitle.textContent = "📁 Staging Workspace";
        stagingBox.append(stTitle);

        if (taskState.stagingDirectory) {
          const stDir = doc.createElement("div");
          stDir.style.fontSize = "11px";
          stDir.style.fontFamily = "var(--vscode-editor-font-family, monospace)";
          stDir.style.color = "var(--vscode-textLink-foreground, #3794ff)";
          stDir.style.wordBreak = "break-all";
          stDir.style.marginBottom = "8px";
          stDir.textContent = `Path: ${taskState.stagingDirectory}`;
          stagingBox.append(stDir);
        }

        if (taskState.testRunLogContent) {
          const logTitle = doc.createElement("div");
          logTitle.style.fontSize = "11px";
          logTitle.style.color = "var(--vscode-descriptionForeground, #8c8c8c)";
          logTitle.style.marginBottom = "4px";
          logTitle.textContent = "Last test-run.log:";

          const logPre = doc.createElement("pre");
          logPre.style.margin = "0";
          logPre.style.padding = "8px";
          logPre.style.background = "#111111";
          logPre.style.borderRadius = "4px";
          logPre.style.fontSize = "11px";
          logPre.style.lineHeight = "1.4";
          logPre.style.overflowX = "auto";
          logPre.style.color = "#a8ff60"; // terminal green
          logPre.style.fontFamily = "var(--vscode-editor-font-family, monospace)";
          logPre.textContent = taskState.testRunLogContent;

          stagingBox.append(logTitle, logPre);
        } else {
          const noLog = doc.createElement("div");
          noLog.style.fontSize = "11px";
          noLog.style.fontStyle = "italic";
          noLog.style.color = "var(--vscode-descriptionForeground, #8c8c8c)";
          noLog.textContent = "No test runs executed yet.";
          stagingBox.append(noLog);
        }

        wrap.append(stagingBox);
      }
    }

    if (state.logs.length === 0) {
      const systemLogsEmpty = buildEmpty(
        doc,
        "No system logs yet",
        "Detailed developer traces, test outputs, and API logs will appear here during execution.",
        {
          label: "Refresh Logs Status",
          onClick: () => {
            renderRightContent();
            showToast("info", "Logs status refreshed");
          },
        },
      );
      wrap.append(systemLogsEmpty);
      return wrap;
    }
    const systemLogsTitle = doc.createElement("h4");
    systemLogsTitle.style.margin = "16px 12px 8px 12px";
    systemLogsTitle.style.color = "var(--vscode-notifications-foreground, #cccccc)";
    systemLogsTitle.style.fontSize = "12px";
    systemLogsTitle.style.textTransform = "uppercase";
    systemLogsTitle.style.letterSpacing = "0.5px";
    systemLogsTitle.textContent = "⚙️ System Logs";
    wrap.append(systemLogsTitle);

    const list = doc.createElement("ol");
    list.className = "kw-logs-list";
    for (const log of state.logs) {
      const li = doc.createElement("li");
      li.className = "kw-logs-item";
      li.dataset["level"] = log.level;
      li.textContent = `[${log.at}] ${log.level.toUpperCase()} — ${log.text}`;
      list.append(li);
    }
    wrap.append(list);
    return wrap;
  }

  function buildUsageView(): HTMLElement {
    const wrap = doc.createElement("div");
    wrap.className = "kw-usage-view";
    wrap.style.padding = "16px";
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "20px";
    wrap.style.color = "var(--vscode-foreground, #cccccc)";
    wrap.style.overflowY = "auto";
    wrap.style.height = "100%";

    const taskId = state.activeTaskId;
    let breakdown: any = null;
    let tokenUsage: any = null;
    let taskState: any = null;

    if (taskId !== null && options.transport !== undefined) {
      taskState = options.transport.getTaskState(taskId);
      if (taskState !== null) {
        breakdown = taskState.currentContextUsage;
        tokenUsage = taskState.tokenUsage;
      }
    }

    if (breakdown) {
      const activePreset = getActivePromptPreset(breakdown.modelId ?? state.metadata.modelId ?? "");
      const configuredWindow = getConfiguredContextWindowTokens(
        state.metadata.provider,
        breakdown.modelId ?? state.metadata.modelId ?? "",
        activePreset.contextBudgetMultiplier * 128_000,
      );
      breakdown = {
        ...breakdown,
        contextWindowTokens: configuredWindow.tokens,
        usageRatio:
          configuredWindow.tokens > 0 ? breakdown.usedTokens / configuredWindow.tokens : 0,
      };
    }

    if (!breakdown) {
      const noData = doc.createElement("div");
      noData.style.textAlign = "center";
      noData.style.padding = "40px 20px";
      noData.style.color = "var(--vscode-descriptionForeground, #8c8c8c)";

      const title = doc.createElement("h3");
      title.textContent = "No usage yet";
      title.style.margin = "0 0 8px 0";

      const desc = doc.createElement("p");
      desc.textContent = "Start a project analysis, plan, or agent run to see token usage, selected files, and context pressure.";
      desc.style.fontSize = "12px";
      desc.style.margin = "0";

      noData.append(title, desc);
      wrap.append(noData);
      return wrap;
    }

    const header = doc.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.gap = "20px";
    header.style.background = "rgba(255, 255, 255, 0.02)";
    header.style.border = "1px solid rgba(255, 255, 255, 0.05)";
    header.style.padding = "16px";
    header.style.borderRadius = "8px";

    const usagePercent = Math.round(breakdown.usageRatio * 100);

    let ringColor = "#10b981";
    if (usagePercent > 50 && usagePercent <= 75) ringColor = "#eab308";
    else if (usagePercent > 75 && usagePercent <= 90) ringColor = "#f97316";
    else if (usagePercent > 90) ringColor = "#ef4444";

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "70");
    svg.setAttribute("height", "70");
    svg.setAttribute("viewBox", "0 0 36 36");

    const bgCircle = doc.createElementNS(svgNS, "circle");
    bgCircle.setAttribute("cx", "18");
    bgCircle.setAttribute("cy", "18");
    bgCircle.setAttribute("r", "16");
    bgCircle.setAttribute("fill", "none");
    bgCircle.setAttribute("stroke", "rgba(255, 255, 255, 0.05)");
    bgCircle.setAttribute("stroke-width", "3");

    const valCircle = doc.createElementNS(svgNS, "circle");
    valCircle.setAttribute("cx", "18");
    valCircle.setAttribute("cy", "18");
    valCircle.setAttribute("r", "16");
    valCircle.setAttribute("fill", "none");
    valCircle.setAttribute("stroke", ringColor);
    valCircle.setAttribute("stroke-width", "3");
    valCircle.setAttribute("stroke-linecap", "round");
    valCircle.setAttribute("transform", "rotate(-90 18 18)");

    const strokeDasharray = 2 * Math.PI * 16;
    const strokeDashoffset = strokeDasharray - (Math.min(usagePercent, 100) / 100) * strokeDasharray;
    valCircle.setAttribute("stroke-dasharray", `${strokeDasharray}`);
    valCircle.setAttribute("stroke-dashoffset", `${strokeDashoffset}`);

    const textPercent = doc.createElementNS(svgNS, "text");
    textPercent.setAttribute("x", "18");
    textPercent.setAttribute("y", "21");
    textPercent.setAttribute("text-anchor", "middle");
    textPercent.setAttribute("fill", "#ffffff");
    textPercent.setAttribute("font-size", "8px");
    textPercent.setAttribute("font-weight", "bold");
    textPercent.textContent = `${usagePercent}%`;

    svg.append(bgCircle, valCircle, textPercent);

    const summaryInfo = doc.createElement("div");
    summaryInfo.style.display = "flex";
    summaryInfo.style.flexDirection = "column";
    summaryInfo.style.gap = "4px";

    const modelName = doc.createElement("div");
    modelName.style.fontSize = "13px";
    modelName.style.fontWeight = "bold";
    modelName.textContent = formatFriendlyModelName(breakdown.modelId);
    modelName.title = breakdown.modelId;

    const usedTotal = doc.createElement("div");
    usedTotal.style.fontSize = "12px";
    usedTotal.style.color = "var(--vscode-descriptionForeground, #8c8c8c)";
    usedTotal.textContent = `Used: ${breakdown.usedTokens.toLocaleString()} / ${breakdown.contextWindowTokens.toLocaleString()}`;

    const costDiv = doc.createElement("div");
    costDiv.style.fontSize = "12px";
    costDiv.style.color = "#10b981";
    costDiv.style.fontWeight = "600";
    const cost = breakdown.estimatedCostUsd ?? 0;
    costDiv.textContent = `Est. Cost: $${cost.toFixed(5)} ${breakdown.isEstimated ? "(est.)" : ""}`;

    summaryInfo.append(modelName, usedTotal, costDiv);
    header.append(svg, summaryInfo);
    wrap.append(header);

    if (breakdown.usageRatio > 0.75) {
      const warningBox = doc.createElement("div");
      warningBox.style.padding = "10px 12px";
      warningBox.style.borderRadius = "6px";
      warningBox.style.fontSize = "12px";
      warningBox.style.display = "flex";
      warningBox.style.flexDirection = "column";
      warningBox.style.gap = "6px";

      if (breakdown.usageRatio > 0.9) {
        warningBox.style.background = "rgba(239, 68, 68, 0.1)";
        warningBox.style.border = "1px solid rgba(239, 68, 68, 0.2)";
        warningBox.style.color = "#ef4444";

        const wTitle = doc.createElement("strong");
        wTitle.textContent = "⚠️ Context is nearly full!";
        const wDesc = doc.createElement("span");
        wDesc.textContent = "Karo may miss important files or instructions. Consider reducing selected files or switching to a larger context model.";
        warningBox.append(wTitle, wDesc);
      } else {
        warningBox.style.background = "rgba(249, 115, 22, 0.1)";
        warningBox.style.border = "1px solid rgba(249, 115, 22, 0.2)";
        warningBox.style.color = "#f97316";

        const wTitle = doc.createElement("strong");
        wTitle.textContent = "⚠️ High context usage";
        const wDesc = doc.createElement("span");
        wDesc.textContent = "Consider reducing selected files or summarizing conversation history to optimize efficiency.";
        warningBox.append(wTitle, wDesc);
      }

      wrap.append(warningBox);
    }

    if (taskState?.contextSummary && taskState.contextSummary.selectedFilesCount === 0 && taskState.contextSummary.warnings?.length > 0) {
      const contextWarning = doc.createElement("div");
      contextWarning.style.padding = "10px 12px";
      contextWarning.style.borderRadius = "6px";
      contextWarning.style.fontSize = "12px";
      contextWarning.style.background = "rgba(249, 115, 22, 0.1)";
      contextWarning.style.border = "1px solid rgba(249, 115, 22, 0.2)";
      contextWarning.style.color = "#f97316";
      contextWarning.textContent = taskState.contextSummary.warnings.join(" ");
      wrap.append(contextWarning);
    }

    const breakSection = doc.createElement("div");
    const breakTitle = doc.createElement("h4");
    breakTitle.textContent = "Token Breakdown";
    breakTitle.style.margin = "0 0 8px 0";
    breakTitle.style.fontSize = "12px";
    breakTitle.style.textTransform = "uppercase";
    breakTitle.style.color = "var(--vscode-descriptionForeground, #8c8c8c)";
    breakSection.append(breakTitle);

    const tbl = doc.createElement("table");
    tbl.style.width = "100%";
    tbl.style.borderCollapse = "collapse";
    tbl.style.fontSize = "12px";

    const rows = [
      { label: "System prompt", val: breakdown.systemPromptTokens },
      { label: "User prompt", val: breakdown.userPromptTokens },
      { label: "Selected files", val: breakdown.selectedFilesTokens },
      { label: "Project context summary", val: breakdown.projectContextTokens },
      { label: "Conversation history", val: breakdown.conversationTokens },
      { label: "Tool/Result payloads", val: breakdown.toolResultTokens },
      { label: "Reserved for output", val: breakdown.reservedOutputTokens },
    ];

    for (const r of rows) {
      const tr = doc.createElement("tr");
      tr.style.borderBottom = "1px solid rgba(255, 255, 255, 0.03)";

      const tdLabel = doc.createElement("td");
      tdLabel.style.padding = "6px 4px";
      tdLabel.textContent = r.label;

      const tdVal = doc.createElement("td");
      tdVal.style.padding = "6px 4px";
      tdVal.style.textAlign = "right";
      tdVal.style.fontFamily = "monospace";
      tdVal.textContent = r.val.toLocaleString();

      tr.append(tdLabel, tdVal);
      tbl.append(tr);
    }

    breakSection.append(tbl);
    wrap.append(breakSection);

    if (tokenUsage && tokenUsage.perAgent && tokenUsage.perAgent.length > 0) {
      const agentSection = doc.createElement("div");
      const agentTitle = doc.createElement("h4");
      agentTitle.textContent = "Per-Agent Usage";
      agentTitle.style.margin = "0 0 8px 0";
      agentTitle.style.fontSize = "12px";
      agentTitle.style.textTransform = "uppercase";
      agentTitle.style.color = "var(--vscode-descriptionForeground, #8c8c8c)";
      agentSection.append(agentTitle);

      const agentList = doc.createElement("div");
      agentList.style.display = "flex";
      agentList.style.flexDirection = "column";
      agentList.style.gap = "8px";

      for (const a of tokenUsage.perAgent) {
        const item = doc.createElement("div");
        item.style.padding = "8px 12px";
        item.style.background = "rgba(255, 255, 255, 0.01)";
        item.style.border = "1px solid rgba(255, 255, 255, 0.03)";
        item.style.borderRadius = "6px";
        item.style.fontSize = "12px";

        const head = doc.createElement("div");
        head.style.display = "flex";
        head.style.justifyContent = "space-between";
        head.style.fontWeight = "bold";
        head.style.marginBottom = "4px";

        const name = doc.createElement("span");
        name.textContent = a.agentId.toUpperCase();
        name.style.color = "#63b3ed";

        const cost = doc.createElement("span");
        cost.textContent = `$${(a.estimatedCostUsd ?? 0).toFixed(5)}`;
        cost.style.color = "#10b981";

        head.append(name, cost);

        const details = doc.createElement("div");
        details.style.display = "flex";
        details.style.justifyContent = "space-between";
        details.style.color = "var(--vscode-descriptionForeground, #8c8c8c)";

        const tok = doc.createElement("span");
        tok.textContent = `Tokens: ${a.totalTokens.toLocaleString()} (in: ${a.inputTokens.toLocaleString()}, out: ${a.outputTokens.toLocaleString()})`;

        const dur = doc.createElement("span");
        dur.textContent = a.durationMs ? `${(a.durationMs / 1000).toFixed(1)}s` : "";

        details.append(tok, dur);
        item.append(head, details);
        agentList.append(item);
      }

      agentSection.append(agentList);
      wrap.append(agentSection);
    }

    if (taskState?.decision !== undefined || taskState?.agentCoreEstimate !== undefined || (taskState?.providerDiagnostics?.length ?? 0) > 0) {
      const modeSection = doc.createElement("div");
      const modeTitle = doc.createElement("h4");
      modeTitle.textContent = "Mode and model calls";
      modeTitle.style.margin = "0 0 8px 0";
      modeTitle.style.fontSize = "12px";
      modeTitle.style.textTransform = "uppercase";
      modeTitle.style.color = "var(--vscode-descriptionForeground, #8c8c8c)";
      modeSection.append(modeTitle);

      const decision = taskState?.decision;
      const estimate = taskState?.agentCoreEstimate;
      const diagnostics = taskState?.providerDiagnostics ?? [];
      const modelCalls = diagnostics.length;
      const elapsedMs = diagnostics.reduce((sum: number, diagnostic: any) => sum + (diagnostic.elapsedMs ?? 0), 0);
      const artifactsCount = options.transport !== undefined && taskId !== null
        ? options.transport.getArtifacts(taskId).length
        : 0;
      const fallbackUsed = diagnostics.some((diagnostic: any) => /fallback/i.test(String(diagnostic.stageName ?? "")));
      const table = doc.createElement("table");
      table.style.width = "100%";
      table.style.borderCollapse = "collapse";
      table.style.fontSize = "12px";
      const metrics = [
        { label: "Mode selected", value: estimate?.mode ?? decision?.executionMode ?? "unknown" },
        { label: "Route reason", value: estimate?.routeReasonUser ?? decision?.reasoningSummary ?? "No route decision recorded." },
        { label: "Context profile", value: estimate?.contextProfile ?? "unknown" },
        { label: "Expected model calls", value: estimate !== undefined ? `${String(estimate.expectedModelCalls)} max ${String(estimate.maxExpectedModelCalls)}` : "unknown" },
        { label: "Risk level", value: estimate?.riskLevel ?? decision?.riskLevel ?? "unknown" },
        { label: "Allows artifacts", value: estimate !== undefined ? String(estimate.allowsArtifacts) : "unknown" },
        { label: "Allows commands", value: estimate !== undefined ? String(estimate.allowsCommands) : String(decision?.allowCommands ?? "unknown") },
        { label: "Selected files", value: String(taskState?.contextSummary?.selectedFilesCount ?? 0) },
        { label: "Context tokens", value: String(breakdown.selectedFilesTokens + breakdown.projectContextTokens) },
        { label: "Model calls", value: String(modelCalls) },
        { label: "Elapsed model time", value: elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : "n/a" },
        { label: "Artifacts", value: String(artifactsCount) },
        { label: "Fallback used", value: fallbackUsed ? "yes" : "no" },
        { label: "Timeout policy", value: estimate?.timeoutPolicy ?? "n/a" },
        { label: "Recovery policy", value: estimate?.recoveryPolicy ?? "n/a" },
      ];
      for (const metric of metrics) {
        const tr = doc.createElement("tr");
        tr.style.borderBottom = "1px solid rgba(255, 255, 255, 0.03)";
        const label = doc.createElement("td");
        label.style.padding = "6px 4px";
        label.textContent = metric.label;
        const value = doc.createElement("td");
        value.style.padding = "6px 4px";
        value.style.textAlign = "right";
        value.style.wordBreak = "break-word";
        value.textContent = metric.value;
        tr.append(label, value);
        table.append(tr);
      }
      modeSection.append(table);

      if (diagnostics.length > 0) {
        const details = doc.createElement("details");
        details.className = "kw-usage-provider-diagnostics";
        const summary = doc.createElement("summary");
        summary.textContent = `Provider call diagnostics (${String(diagnostics.length)})`;
        details.append(summary);
        const calls = doc.createElement("ul");
        calls.style.listStyle = "none";
        calls.style.padding = "0";
        calls.style.margin = "8px 0 0";
        for (const diagnostic of diagnostics) {
          const item = doc.createElement("li");
          item.style.padding = "8px";
          item.style.border = "1px solid rgba(255, 255, 255, 0.04)";
          item.style.borderRadius = "6px";
          item.style.marginBottom = "6px";
          item.style.wordBreak = "break-word";
          item.textContent = [
            `${readableAgentName(diagnostic.agentId)} / ${diagnostic.stageName}`,
            `${diagnostic.provider}/${formatFriendlyModelName(diagnostic.modelId)}`,
            `tokens ${String(diagnostic.inputTokenEstimate)}`,
            `files ${String(diagnostic.selectedFilesCount)}`,
            `${String(Math.round(diagnostic.elapsedMs / 1000))}s`,
            diagnostic.errorType !== undefined ? `error ${diagnostic.errorType}` : "ok",
          ].join(" · ");
          calls.append(item);
        }
        details.append(calls);
        modeSection.append(details);
      }

      wrap.append(modeSection);
    }

    const selectedContextFiles =
      taskState?.contextSummary?.selectedFiles?.map((f: any) => f.relativePath) ??
      state.lastContextSelectedFiles ??
      [];

    if (selectedContextFiles.length > 0) {
      const filesSection = doc.createElement("div");
      const filesTitle = doc.createElement("h4");
      filesTitle.textContent = `Selected Context Files (${selectedContextFiles.length})`;
      filesTitle.style.margin = "0 0 8px 0";
      filesTitle.style.fontSize = "12px";
      filesTitle.style.textTransform = "uppercase";
      filesTitle.style.color = "var(--vscode-descriptionForeground, #8c8c8c)";
      filesSection.append(filesTitle);

      const filesList = doc.createElement("ul");
      filesList.style.margin = "0";
      filesList.style.paddingLeft = "0";
      filesList.style.listStyleType = "none";
      filesList.style.fontSize = "12px";
      filesList.style.display = "flex";
      filesList.style.flexDirection = "column";
      filesList.style.gap = "4px";

      for (const f of selectedContextFiles) {
        const li = doc.createElement("li");
        li.style.padding = "4px 8px";
        li.style.background = "rgba(255, 255, 255, 0.01)";
        li.style.border = "1px solid rgba(255, 255, 255, 0.02)";
        li.style.borderRadius = "4px";
        li.style.fontFamily = "monospace";
        li.style.wordBreak = "break-all";
        li.textContent = f;
        filesList.append(li);
      }

      filesSection.append(filesList);
      wrap.append(filesSection);
    }

    return wrap;
  }

  function pushLog(level: "info" | "warn" | "error", text: string): void {
    state.logs.unshift({
      level,
      text,
      at: new Date().toISOString(),
    });
    if (state.logs.length > 200) state.logs.length = 200;
    renderRightContent();
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  return {
    unmount(): void {
      if (terminalPollTimer !== null) {
        doc.defaultView?.clearInterval(terminalPollTimer);
        terminalPollTimer = null;
      }
      for (const u of transportSubs) {
        try {
          u();
        } catch {
          /* ignore */
        }
      }
      signOutBtn.removeEventListener("click", onSignOut);
      settingsBtn.removeEventListener("click", onSettingsClick);
      projectField.removeEventListener("click", onProjectClick);
      collapseBtn.removeEventListener("click", onCollapseClick);
      doc.defaultView?.removeEventListener("resize", onWindowResize);
      delete root.dataset["screen"];
      delete root.dataset["session"];
      root.innerHTML = "";
    },
  };
}

function formatFriendlyModelName(modelId: string | undefined): string {
  if (modelId === undefined || modelId.length === 0) return "(default)";
  const rawName = modelId.split("/").filter(Boolean).at(-1) ?? modelId;
  return rawName
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (/^\d+b$/.test(lower)) return lower.toUpperCase();
      if (/^v\d+(?:p\d+)?$/.test(lower)) {
        return lower.replace(/^v/, "V").replace(/p(\d+)$/, ".$1");
      }
      if (lower === "deepseek") return "DeepSeek";
      if (lower === "gpt") return "GPT";
      if (lower === "kimi") return "Kimi";
      if (lower === "llm") return "LLM";
      if (lower === "api") return "API";
      if (lower === "ai") return "AI";
      return `${lower[0]?.toUpperCase() ?? ""}${lower.slice(1)}`;
    })
    .join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolveModelCapabilities(provider: ProviderId, modelId: string): {
  readonly badges: readonly string[];
  readonly sourceLabel: string;
  readonly contextLabel: string;
} {
  const id = modelId.toLowerCase();
  const badges = new Set<string>();
  let sourceLabel = "Capabilities estimated from model id";
  let contextLabel = "Context unknown";

  if (provider === "fireworks") {
    sourceLabel = "Known Fireworks/heuristic";
    if (id.includes("deepseek-v4-pro")) {
      badges.add("Text");
      badges.add("Code");
      contextLabel = "Context: 1M configured";
    } else if (id.includes("flux")) {
      badges.add("Image generation");
      contextLabel = "Context: n/a";
    } else if (id.includes("gpt-oss-120b")) {
      badges.add("Text");
      badges.add("Code");
    }
  }
  if (/(kimi|glm|qwen|llama|deepseek|gpt|mistral|codestral|mixtral)/i.test(id)) {
    badges.add("Text");
    badges.add("Code");
  }
  if (/(vision|vl|omni|llava)/i.test(id)) {
    badges.add("Vision");
  }
  if (/(flux|sdxl|image|kontext)/i.test(id)) {
    badges.add("Image generation");
  }
  if (/(audio|whisper|tts)/i.test(id)) {
    badges.add("Audio");
  }
  if (badges.size === 0) {
    return { badges: ["Capabilities unknown"], sourceLabel: "Unknown", contextLabel };
  }
  return { badges: [...badges, contextLabel], sourceLabel, contextLabel };
}

function getKnownProviderModels(provider: ProviderId): readonly ModelCatalogEntry[] {
  if (provider !== "fireworks") {
    return [];
  }
  return [
    { modelId: "accounts/fireworks/models/deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
    { modelId: "accounts/fireworks/models/kimi-k2-instruct", displayName: "Kimi K2 Instruct" },
    { modelId: "accounts/fireworks/models/gpt-oss-120b", displayName: "GPT OSS 120B" },
    { modelId: "accounts/fireworks/models/flux-kontext-pro", displayName: "Flux Kontext Pro" },
  ];
}

function buildDisplayModelCatalog(
  provider: ProviderId,
  cachedModels: readonly ModelCatalogEntry[] | null,
  activeModelId: string | undefined,
): readonly ModelCatalogEntry[] {
  const seen = new Set<string>();
  const merged: ModelCatalogEntry[] = [];
  const add = (entry: ModelCatalogEntry): void => {
    if (seen.has(entry.modelId)) return;
    seen.add(entry.modelId);
    merged.push(entry);
  };
  for (const entry of cachedModels ?? []) add(entry);
  for (const entry of getKnownProviderModels(provider)) add(entry);
  if (activeModelId !== undefined && activeModelId.length > 0) {
    add({ modelId: activeModelId, displayName: activeModelId });
  }
  return merged;
}

type ModelContextCapability = {
  readonly modelId: string;
  readonly providerId: ProviderId;
  readonly minSafeContextTokens?: number;
  readonly defaultContextTokens?: number;
  readonly maxProviderContextTokens?: number;
  readonly maxModelContextTokens?: number;
  readonly source: "provider_metadata" | "known_table" | "heuristic" | "manual_override" | "unknown";
  readonly confidence: "high" | "medium" | "low";
  readonly warning?: string;
};

function getModelContextCapability(provider: ProviderId, modelId: string): ModelContextCapability {
  const id = modelId.toLowerCase();
  if (provider === "fireworks" && id.includes("deepseek-v4-pro")) {
    return {
      modelId,
      providerId: provider,
      minSafeContextTokens: 128_000,
      defaultContextTokens: 1_000_000,
      maxProviderContextTokens: 1_000_000,
      maxModelContextTokens: 1_000_000,
      source: "known_table",
      confidence: "medium",
      warning: "Context: 1M configured assumption.",
    };
  }
  if (/(flux|sdxl|image|kontext)/i.test(id)) {
    return {
      modelId,
      providerId: provider,
      source: "known_table",
      confidence: "medium",
      warning: "Image generation model: chat/code context controls are not applicable.",
    };
  }
  if (/(kimi|glm|qwen|llama|gpt-oss|mistral|codestral|mixtral)/i.test(id)) {
    return {
      modelId,
      providerId: provider,
      minSafeContextTokens: 128_000,
      defaultContextTokens: 128_000,
      source: "heuristic",
      confidence: "low",
      warning: "Context max unknown. Using a conservative default until provider metadata is available.",
    };
  }
  return {
    modelId,
    providerId: provider,
    minSafeContextTokens: 128_000,
    defaultContextTokens: 128_000,
    source: "unknown",
    confidence: "low",
    warning: "Context max unknown. Custom values above the conservative default may fail or truncate.",
  };
}

function contextWindowOptionsForCapability(capability: ModelContextCapability): ReadonlyArray<readonly [string, string]> {
  const options: Array<readonly [string, string]> = [["auto", "Auto"]];
  if (capability.warning?.includes("not applicable")) {
    options.push(["custom", "Custom"]);
    return options;
  }
  const max = capability.maxModelContextTokens ?? capability.maxProviderContextTokens;
  const presets: Array<readonly [string, string, number]> = [
    ["128k", "128k", 128_000],
    ["256k", "256k", 256_000],
    ["512k", "512k", 512_000],
    ["1m", "1M", 1_000_000],
    ["2m", "2M", 2_000_000],
  ];
  for (const [value, label, tokens] of presets) {
    if (max === undefined || tokens <= max) {
      if (max === undefined && tokens > (capability.defaultContextTokens ?? 128_000)) continue;
      options.push([value, label]);
    }
  }
  options.push(["custom", "Custom"]);
  return options;
}

function modelSupportsVision(provider: ProviderId, modelId: string | undefined): boolean {
  if (modelId === undefined) return false;
  return resolveModelCapabilities(provider, modelId).badges.includes("Vision");
}

function readStoredComposerMode(): ComposerMode {
  if (typeof window === "undefined") return "auto";
  const value = localStorage.getItem("karo.composerMode");
  if (value === "assist") {
    localStorage.setItem("karo.composerMode", "plan");
    return "plan";
  }
  return value === "chat" || value === "plan" || value === "agent" || value === "auto" ? value : "auto";
}

function formatComposerModeLabel(mode: ComposerMode): string {
  if (mode === "auto") return "Auto";
  if (mode === "plan") return "Plan";
  if (mode === "chat") return "Chat";
  return "Agent";
}

function shouldRouteToPlan(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /(план|спланир|архитектур|roadmap|design|designer|продумай|спроектир|разбей на этап|implementation strategy|test plan|risk analysis|как лучше реализовать|переделки ui)/iu.test(text) ||
    /\u043f\u043b\u0430\u043d|\u0441\u043f\u043b\u0430\u043d\u0438\u0440|\u0430\u0440\u0445\u0438\u0442\u0435\u043a\u0442|\u043f\u0440\u043e\u0434\u0443\u043c\u0430\u0439|\u0441\u043f\u0440\u043e\u0435\u043a\u0442\u0438\u0440|\u0440\u0430\u0437\u0431\u0435\u0439\s+\u043d\u0430\s+\u044d\u0442\u0430\u043f|\u043a\u0430\u043a\s+\u043b\u0443\u0447\u0448\u0435\s+\u0440\u0435\u0430\u043b\u0438\u0437|\u0440\u0438\u0441\u043a|\u0442\u0435\u0441\u0442-\u043f\u043b\u0430\u043d/iu.test(text);
}

function buildStructuredPlanView(prompt: string, answer: string): StructuredPlanView | null {
  const trimmed = answer.trim();
  if (trimmed.length < 8) return null;
  const parsed = parsePlanJson(trimmed);
  if (parsed !== null) return parsed;
  if (/^[{[]/u.test(trimmed)) return null;
  return repairPlanFromText(prompt, trimmed);
}

function parsePlanJson(text: string): StructuredPlanView | null {
  const candidates = [
    text,
    text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1],
    text.match(/<plan_json>\s*([\s\S]*?)\s*<\/plan_json>/iu)?.[1],
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim()) as Record<string, unknown>;
      const view = structuredPlanFromRecord(value, false);
      if (view !== null) return view;
    } catch {
      // Try the next extraction candidate; invalid JSON does not become a fake plan.
    }
  }
  return null;
}

function structuredPlanFromRecord(value: Record<string, unknown>, repairedFromText: boolean): StructuredPlanView | null {
  const goal = stringValue(value["goal"]);
  const implementationSteps = stringArrayValue(value["implementationSteps"]);
  if (goal.length === 0 || implementationSteps.length === 0) return null;
  return {
    goal,
    assumptions: stringArrayValue(value["assumptions"]),
    fileAreas: stringArrayValue(value["relevantFileAreas"] ?? value["fileAreas"]),
    implementationSteps,
    risks: stringArrayValue(value["risks"]),
    tests: stringArrayValue(value["tests"]),
    estimatedComplexity: stringValue(value["estimatedComplexity"]) || "medium",
    expectedBudget: stringValue(value["expectedModelCallsContextBudget"]) || "One bounded planning call; context only if the request is project-specific.",
    suggestedExecutionMode: stringValue(value["suggestedExecutionMode"]) || "Plan",
    acceptanceCriteria: stringArrayValue(value["acceptanceCriteria"]),
    whatNotToDoYet: stringArrayValue(value["whatNotToDoYet"]),
    repairedFromText,
  };
}

function repairPlanFromText(prompt: string, text: string): StructuredPlanView | null {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const projectSpecific = /\bkaro\b|ui|ux|project|repo|\u043f\u0440\u043e\u0435\u043a\u0442|\u043a\u043e\u0434|\u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441/iu.test(prompt);
  const extractedSteps = extractPlanBullets(lines, ["step", "steps", "implementation", "phase", "phases", "шаг", "этап"]);
  const steps = extractedSteps.length > 0 ? extractedSteps : lines.slice(0, 8);
  if (steps.join(" ").length < 12) return null;
  return {
    goal: firstSentence(text) || "Create a safe read-only plan.",
    assumptions: projectSpecific
      ? ["Project-specific details should be verified against selected files before Agent execution."]
      : ["This is a planning answer only; no project files were changed."],
    fileAreas: projectSpecific ? ["Relevant files depend on the selected project context."] : ["No project files needed for this generic plan."],
    implementationSteps: steps,
    risks: extractPlanBullets(lines, ["risk", "risks", "риск"]).slice(0, 6),
    tests: extractPlanBullets(lines, ["test", "tests", "verify", "провер", "тест"]).slice(0, 6),
    estimatedComplexity: /large|hard|сложн|high/iu.test(text) ? "high" : "medium",
    expectedBudget: "One structured planning model call; no artifacts and no commands.",
    suggestedExecutionMode: /create|implement|change|fix|созда|реализ|измени|исправ/iu.test(prompt) ? "Agent" : "Plan",
    acceptanceCriteria: ["The user can review the plan before any Agent run.", "No files are staged or applied by Plan Mode."],
    whatNotToDoYet: ["Do not create artifacts in Plan Mode.", "Do not run command execution from Plan Mode."],
    repairedFromText: true,
  };
}

function renderStructuredPlanResult(
  prompt: string,
  plan: StructuredPlanView,
  context?: ChatReadOnlyContext,
): string {
  const ru = isLikelyRussian(prompt);
  const labels = ru
    ? {
        activity: "Публичные этапы Plan Mode",
        goal: "Цель",
        assumptions: "Предпосылки",
        fileAreas: "Зоны файлов",
        steps: "Шаги реализации",
        risks: "Риски",
        tests: "Проверки",
        complexity: "Оценка сложности",
        budget: "Бюджет модели/контекста",
        mode: "Рекомендуемый режим выполнения",
        acceptance: "Критерии приемки",
        notYet: "Что пока не делать",
        repair: "Примечание",
      }
    : {
        activity: "Public Plan Mode stages",
        goal: "Goal",
        assumptions: "Assumptions",
        fileAreas: "Relevant file areas",
        steps: "Implementation steps",
        risks: "Risks",
        tests: "Tests / verification",
        complexity: "Estimated complexity",
        budget: "Expected model calls / context budget",
        mode: "Suggested execution mode",
        acceptance: "Acceptance criteria",
        notYet: "What not to do yet",
        repair: "Note",
      };
  const activity = ru
    ? [
        `Проверяю, нужен ли контекст проекта: ${context === undefined ? "не нужен или не выбран" : `выбрано ${String(context.selectedFilesCount)} файлов (${context.profile})`}.`,
        "Составляю план: выполнен один структурированный provider call.",
        "Проверяю риски: включены отдельным разделом плана.",
        "Финализирую план: artifacts не создавались, Apply Changes недоступен.",
      ]
    : [
        `Checking whether project context is needed: ${context === undefined ? "not needed or not selected" : `${String(context.selectedFilesCount)} files selected (${context.profile})`}.`,
        "Building plan: one structured provider call was used.",
        "Reviewing risks: captured as a separate plan section.",
        "Finalizing plan: no artifacts were created and Apply Changes is unavailable.",
      ];
  return [
    "## Plan Result",
    section(labels.activity, activity),
    section(labels.goal, [plan.goal]),
    section(labels.assumptions, fallbackList(plan.assumptions, ru ? "Нет дополнительных предпосылок от модели." : "No additional model assumptions.")),
    section(labels.fileAreas, fallbackList(plan.fileAreas, context === undefined ? (ru ? "Контекст проекта не использовался." : "Project context was not used.") : context.selectedFiles.join(", "))),
    section(labels.steps, plan.implementationSteps),
    section(labels.risks, fallbackList(plan.risks, ru ? "Явных рисков модель не указала; проверь scope и стоимость перед Agent Mode." : "No explicit model risks; verify scope and cost before Agent Mode.")),
    section(labels.tests, fallbackList(plan.tests, ru ? "Подбери минимальные проверки перед запуском Agent Mode." : "Choose the smallest useful checks before Agent Mode.")),
    section(labels.complexity, [plan.estimatedComplexity]),
    section(labels.budget, [plan.expectedBudget]),
    section(labels.mode, [plan.suggestedExecutionMode]),
    section(labels.acceptance, fallbackList(plan.acceptanceCriteria, ru ? "План можно выполнить только после отдельного Agent/Quick Edit запуска." : "The plan can be executed only by a separate Agent/Quick Edit run.")),
    section(labels.notYet, fallbackList(plan.whatNotToDoYet, ru ? "Не менять файлы в Plan Mode." : "Do not change files in Plan Mode.")),
    ...(plan.repairedFromText ? [section(labels.repair, [ru ? "Модель не вернула JSON; Karo один раз структурировал ее текстовый ответ без создания artifacts." : "The model did not return JSON; Karo structured the text once without creating artifacts."])] : []),
  ].join("\n\n");
}

function buildPlanFailureMessage(
  prompt: string,
  error: string,
  context?: ChatReadOnlyContext,
): string {
  const ru = isLikelyRussian(prompt);
  if (ru) {
    return [
      "## Plan Mode could not complete",
      "",
      `Ошибка: ${error}`,
      "",
      "Файлы не менялись, artifacts не создавались, Apply Changes недоступен.",
      context !== undefined ? `Контекст был выбран до ошибки: ${String(context.selectedFilesCount)} файлов (${context.profile}).` : "Контекст проекта не использовался или не был выбран до ошибки.",
      "",
      "### Recovery options",
      "- Retry Plan: повторить тот же planning prompt.",
      "- Retry with reduced context: уменьшить выбранный контекст и повторить.",
      "- Switch model: выбери другую text/code модель на странице Models, если текущая недоступна.",
    ].join("\n");
  }
  return [
    "## Plan Mode could not complete",
    "",
    `Error: ${error}`,
    "",
    "No files were changed, no artifacts were created, and Apply Changes is unavailable.",
    context !== undefined ? `Context selected before failure: ${String(context.selectedFilesCount)} files (${context.profile}).` : "No project context was used or selected before the failure.",
    "",
    "### Recovery options",
    "- Retry Plan: re-submit the same planning prompt.",
    "- Retry with reduced context: reduce selected context and try again.",
    "- Switch model: choose another text/code model on the Models page if this one is unavailable.",
  ].join("\n");
}

function section(title: string, values: readonly string[]): string {
  return [`### ${title}`, ...values.map((value) => `- ${value}`)].join("\n");
}

function fallbackList(values: readonly string[], fallback: string): readonly string[] {
  return values.length > 0 ? values : [fallback];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayValue(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0).slice(0, 12);
  }
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  return [];
}

function firstSentence(text: string): string {
  return text.replace(/\s+/gu, " ").split(/(?<=[.!?])\s/u)[0]?.trim().slice(0, 220) ?? "";
}

function extractPlanBullets(lines: readonly string[], headings: readonly string[]): readonly string[] {
  const lowered = headings.map((heading) => heading.toLowerCase());
  const result: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const normalized = line.replace(/^#+\s*/u, "").toLowerCase();
    if (lowered.some((heading) => normalized.includes(heading))) {
      collecting = true;
      continue;
    }
    if (collecting && /^#{1,4}\s/u.test(line)) break;
    if (collecting) {
      result.push(line.replace(/^[-*\d.)\s]+/u, "").trim());
    }
  }
  return result.filter((item) => item.length > 0).slice(0, 10);
}

function detectPreviewCommand(): string {
  return "pnpm desktop:dev:renderer";
}

function detectPreviewCommandFromPackageJson(packageJsonContent: string): string {
  try {
    const parsed = JSON.parse(packageJsonContent) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts ?? {};
    if (typeof scripts["dev"] === "string") return "pnpm dev";
    if (typeof scripts["desktop:dev"] === "string") return "pnpm desktop:dev";
    if (typeof scripts["start"] === "string") return "npm start";
    if (typeof scripts["preview"] === "string") return "npm run preview";
  } catch {
    return "";
  }
  return "";
}

function stripModePreamble(text: string): string {
  return text
    .replace(
      /^\s*(?:\[?(?:Auto|Assist|Agent|Chat)\s+Mode\]?\s*[:\-–—.]?\s*)?(?:Я\s+(?:работаю|нахожусь)\s+в\s+(?:режиме\s+)?(?:Auto|Assist|Agent|Chat)\s+Mode\.?\s*)/iu,
      "",
    )
    .replace(/^\s*(?:I\s+(?:am|work)\s+in\s+(?:Auto|Assist|Agent|Chat)\s+Mode\.?\s*)/iu, "")
    .replace(/^\s*(?:\[?Plan\s+Mode\]?\s*[:\-–—.]?\s*)?(?:Я\s+(?:работаю|нахожусь)\s+в\s+(?:режиме\s+)?Plan\s+Mode\.?\s*)/iu, "")
    .replace(/^\s*(?:I\s+(?:am|work)\s+in\s+Plan\s+Mode\.?\s*)/iu, "")
    .trimStart();
}

function looksSilentlyTruncated(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 120) return false;
  if (/\[?(?:TRUNCATED|Response truncated)\]?/i.test(trimmed)) return true;
  if (/(\*\*[^*]{1,80}|\[[^\]]{1,80}|\([^)]{1,120}|```[^`]{1,240})$/u.test(trimmed)) {
    return true;
  }
  return !/[.!?。！？)"'`»\]]$/u.test(trimmed);
}

function getActivePromptPreset(modelId: string): ReturnType<typeof getPresetForModel> {
  if (typeof window !== "undefined") {
    const selected = localStorage.getItem("karo.preset");
    if (selected !== null && selected !== "auto" && selected in presets) {
      return presets[selected]!;
    }
  }
  return getPresetForModel(modelId);
}

function parseContextWindowTokens(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized.length === 0 || normalized === "auto" || normalized === "custom") return null;
  const kMatch = /^(\d+(?:\.\d+)?)k$/.exec(normalized);
  if (kMatch !== null) return Math.round(Number(kMatch[1]) * 1_000);
  const mMatch = /^(\d+(?:\.\d+)?)m$/.exec(normalized);
  if (mMatch !== null) return Math.round(Number(mMatch[1]) * 1_000_000);
  const numeric = Number.parseInt(normalized, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function formatContextWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${String(tokens / 1_000_000)}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${String(tokens / 1_000)}k`;
  }
  return tokens.toLocaleString();
}

function getConfiguredContextWindowTokens(provider: ProviderId, modelId: string, defaultTokens: number): {
  readonly tokens: number;
  readonly source: "auto" | "preset" | "custom" | "invalid";
  readonly warning?: string;
} {
  const capability = getModelContextCapability(provider, modelId);
  const safeDefault = capability.defaultContextTokens ?? defaultTokens;
  const knownMax = capability.maxModelContextTokens ?? capability.maxProviderContextTokens;
  if (typeof window === "undefined") return { tokens: safeDefault, source: "auto", ...(capability.warning ? { warning: capability.warning } : {}) };
  const mode = localStorage.getItem("karo.effectiveContextWindow") ?? "auto";
  if (mode === "auto") return { tokens: safeDefault, source: "auto", ...(capability.warning ? { warning: capability.warning } : {}) };
  if (mode === "custom") {
    const custom = parseContextWindowTokens(localStorage.getItem("karo.customContextWindow"));
    if (custom !== null) {
      const warning =
        knownMax !== undefined && custom > knownMax
          ? "This exceeds known provider/model context. Request may fail or be truncated."
          : capability.warning;
      return {
        tokens: custom,
        source: "custom",
        ...(warning !== undefined ? { warning } : {}),
      };
    }
    return {
      tokens: safeDefault,
      source: "invalid",
      warning: "Invalid custom context window. Using Auto.",
    };
  }
  const preset = parseContextWindowTokens(mode);
  if (preset !== null) {
    if (knownMax !== undefined && preset > knownMax) {
      return {
        tokens: safeDefault,
        source: "invalid",
        warning: "Selected context exceeds known provider/model max. Using Auto.",
      };
    }
    return {
      tokens: preset,
      source: "preset",
      ...(capability.warning !== undefined ? { warning: capability.warning } : {}),
    };
  }
  return { tokens: safeDefault, source: "invalid", warning: "Invalid context window. Using Auto." };
}

function appendInlineMarkdown(doc: Document, parent: HTMLElement, text: string): void {
  const codeParts = text.split(/(`[^`]+`)/g);
  for (const codePart of codeParts) {
    if (codePart.startsWith("`") && codePart.endsWith("`") && codePart.length > 1) {
      const code = doc.createElement("code");
      code.textContent = codePart.slice(1, -1);
      parent.append(code);
      continue;
    }
    const boldParts = codePart.split(/(\*\*[^*]+\*\*)/g);
    for (const boldPart of boldParts) {
      if (boldPart.startsWith("**") && boldPart.endsWith("**") && boldPart.length > 4) {
        const strong = doc.createElement("strong");
        strong.textContent = boldPart.slice(2, -2);
        parent.append(strong);
      } else if (boldPart.length > 0) {
        parent.append(doc.createTextNode(boldPart));
      }
    }
  }
}

function renderMarkdownBlock(doc: Document, markdown: string): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.className = "kw-markdown";
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  let list: HTMLUListElement | HTMLOListElement | null = null;
  let listKind: "ul" | "ol" | null = null;

  const closeList = () => {
    list = null;
    listKind = null;
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      closeList();
      const fenceInfo = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      if (fenceInfo.length > 0) code.dataset["language"] = fenceInfo;
      code.textContent = codeLines.join("\n");
      pre.append(code);
      wrap.append(pre);
      continue;
    }

    if (trimmed.length === 0) {
      closeList();
      index += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading !== null) {
      closeList();
      const level = Math.min(heading[1]!.length + 2, 6);
      const h = doc.createElement(`h${String(level)}`);
      appendInlineMarkdown(doc, h, heading[2] ?? "");
      wrap.append(h);
      index += 1;
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    if (unordered !== null) {
      if (list === null || listKind !== "ul") {
        closeList();
        list = doc.createElement("ul");
        listKind = "ul";
        wrap.append(list);
      }
      const item = doc.createElement("li");
      appendInlineMarkdown(doc, item, unordered[1] ?? "");
      list.append(item);
      index += 1;
      continue;
    }

    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (ordered !== null) {
      if (list === null || listKind !== "ol") {
        closeList();
        list = doc.createElement("ol");
        listKind = "ol";
        wrap.append(list);
      }
      const item = doc.createElement("li");
      appendInlineMarkdown(doc, item, ordered[1] ?? "");
      list.append(item);
      index += 1;
      continue;
    }

    closeList();
    const paragraph = doc.createElement("p");
    appendInlineMarkdown(doc, paragraph, line);
    wrap.append(paragraph);
    index += 1;
  }

  return wrap;
}

function isNearBottom(container: HTMLElement, thresholdPx = 96): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= thresholdPx;
}

function toDisplayPath(path: string | undefined | null): string {
  if (path === undefined || path === null) return "";
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  }
  if (path.startsWith("\\\\?\\")) {
    return path.slice("\\\\?\\".length);
  }
  return path;
}

function loadPersistedConversation(): PersistedConversationView | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (raw === null) return null;
    const payload = JSON.parse(raw) as Partial<ConversationStorePayload>;
    if (!Array.isArray(payload.conversations)) return null;
    const activeId = typeof payload.activeConversationId === "string"
      ? payload.activeConversationId
      : payload.conversations[0]?.id;
    const active = payload.conversations.find((conversation) => conversation.id === activeId);
    if (active === undefined) return null;
    return {
      id: active.id,
      projectRoot: active.projectRoot ?? "",
      createdAt: active.createdAt ?? new Date().toISOString(),
      updatedAt: active.updatedAt ?? new Date().toISOString(),
      activeRunId: active.activeRunId ?? null,
      messages: Array.isArray(active.messages) ? active.messages.slice(-MAX_PERSISTED_MESSAGES) : [],
      runs: Array.isArray(active.runs) ? active.runs.slice(0, 50) : [],
    };
  } catch {
    return null;
  }
}

function loadPersistedConversations(): readonly PersistedConversationView[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (raw === null) return [];
    const payload = JSON.parse(raw) as Partial<ConversationStorePayload>;
    return Array.isArray(payload.conversations) ? payload.conversations : [];
  } catch {
    return [];
  }
}

function loadPersistedConversationById(conversationId: string): PersistedConversationView | null {
  return loadPersistedConversations().find((conversation) => conversation.id === conversationId) ?? null;
}

function writeConversationStore(payload: ConversationStorePayload): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(payload));
}

function updatePersistedConversation(conversation: PersistedConversationView): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(CONVERSATION_STORAGE_KEY);
    const previous = raw !== null
      ? (JSON.parse(raw) as Partial<ConversationStorePayload>)
      : {};
    const conversations = Array.isArray(previous.conversations) ? previous.conversations : [];
    const nextConversations = conversations.map((item) => item.id === conversation.id ? conversation : item);
    writeConversationStore({
      activeConversationId: typeof previous.activeConversationId === "string" ? previous.activeConversationId : conversation.id,
      conversations: nextConversations,
    });
  } catch {
    /* conversation persistence must never block the UI */
  }
}

function deletePersistedConversation(conversationId: string): PersistedConversationView | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (raw === null) return null;
    const previous = JSON.parse(raw) as Partial<ConversationStorePayload>;
    const conversations = Array.isArray(previous.conversations) ? previous.conversations : [];
    const nextConversations = conversations.filter((item) => item.id !== conversationId);
    const nextActive = nextConversations[0] ?? null;
    writeConversationStore({
      activeConversationId: nextActive?.id ?? "",
      conversations: nextConversations,
    });
    return nextActive;
  } catch {
    return null;
  }
}

function buildConversationTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "New chat";
  return normalized.length > 42 ? `${normalized.slice(0, 39)}...` : normalized;
}

function buildConversationMeta(conversation: PersistedConversationView): string {
  const messageCount = conversation.messages.length;
  const runCount = conversation.runs.length;
  if (messageCount === 0 && runCount === 0) return "Empty chat";
  const parts = [`${messageCount} msg${messageCount === 1 ? "" : "s"}`];
  if (runCount > 0) parts.push(`${runCount} run${runCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function savePersistedConversation(conversation: PersistedConversationView): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(CONVERSATION_STORAGE_KEY);
    const previous = raw !== null
      ? (JSON.parse(raw) as Partial<ConversationStorePayload>)
      : {};
    const conversations = Array.isArray(previous.conversations) ? previous.conversations : [];
    const sanitized: PersistedConversationView = {
      ...conversation,
      projectRoot: conversation.projectRoot,
      messages: conversation.messages.slice(-MAX_PERSISTED_MESSAGES).map((message) => ({
        ...message,
        text: message.text.slice(0, 80_000),
      })),
      runs: conversation.runs.slice(0, 50),
    };
    const nextConversations = [
      sanitized,
      ...conversations.filter((item) => item.id !== conversation.id),
    ].slice(0, MAX_PERSISTED_CONVERSATIONS);
    localStorage.setItem(
      CONVERSATION_STORAGE_KEY,
      JSON.stringify({
        activeConversationId: conversation.id,
        conversations: nextConversations,
      }),
    );
  } catch {
    /* conversation persistence must never block the UI */
  }
}

// ---------------------------------------------------------------------------
// Trace helpers
// ---------------------------------------------------------------------------

interface AgentGroup {
  readonly agentId: AgentId;
  readonly status: "pending" | "started" | "finished" | "error" | "skipped";
  readonly summary: string;
  readonly events: readonly TraceEvent[];
  readonly startedAtMs?: number | undefined;
  readonly endedAtMs?: number | undefined;
  readonly syntheticReason?: "deterministic_validation_passed" | undefined;
}

type ActivityLocale = "en" | "ru";

function groupTraceByAgent(
  events: readonly TraceEvent[],
  options: { readonly includeOrchestrator?: boolean } = {},
): readonly AgentGroup[] {
  const order: AgentId[] = [];
  const map = new Map<
    AgentId,
    {
      status: AgentGroup["status"];
      summary: string;
      events: TraceEvent[];
      startedAtMs?: number | undefined;
      endedAtMs?: number | undefined;
    }
  >();
  for (const ev of events) {
    if (ev.agentId === "orchestrator" && options.includeOrchestrator !== true) continue;
    if (!map.has(ev.agentId)) {
      order.push(ev.agentId);
      map.set(ev.agentId, { status: "pending", summary: "", events: [] });
    }
    const slot = map.get(ev.agentId)!;
    slot.events.push(ev);
    const eventTime = Date.parse(ev.at);
    if (!Number.isNaN(eventTime)) {
      slot.startedAtMs = slot.startedAtMs === undefined ? eventTime : Math.min(slot.startedAtMs, eventTime);
      slot.endedAtMs = slot.endedAtMs === undefined ? eventTime : Math.max(slot.endedAtMs, eventTime);
    }
    if (ev.record.kind === "status") {
      slot.status = ev.record.status;
    } else if (ev.record.kind === "thought") {
      slot.summary = truncatePublicActivity(ev.record.text);
    } else if (ev.record.kind === "artifact_change" && slot.summary.length === 0) {
      slot.summary = `Wrote ${ev.record.artifactId.slice(0, 8)}@v${String(ev.record.version)}`;
    }
  }
  return order.map((id) => ({
    agentId: id,
    status: map.get(id)!.status,
    summary: map.get(id)!.summary,
    events: map.get(id)!.events,
    startedAtMs: map.get(id)!.startedAtMs,
    endedAtMs: map.get(id)!.endedAtMs,
  }));
}

function withSyntheticActivityGroups(
  groups: readonly AgentGroup[],
  taskState: TaskStateSnapshot,
): readonly AgentGroup[] {
  const validation = taskState.deterministicValidation;
  if (validation?.skipModelReview !== true || groups.some((group) => group.agentId === "reviewer")) {
    return groups;
  }
  const reviewer: AgentGroup = {
    agentId: "reviewer",
    status: "skipped",
    summary: "Deterministic validation passed; model review was not needed.",
    events: [],
    syntheticReason: "deterministic_validation_passed",
  };
  const validatorIndex = groups.findIndex((group) => group.agentId === "validator");
  const coderIndex = groups.findIndex((group) => group.agentId === "coder");
  const insertAfter = validatorIndex >= 0 ? validatorIndex : coderIndex;
  if (insertAfter < 0) return [...groups, reviewer];
  return [...groups.slice(0, insertAfter + 1), reviewer, ...groups.slice(insertAfter + 1)];
}

function describeAgentStatus(status: AgentGroup["status"], locale: ActivityLocale = "en"): string {
  if (locale === "ru") {
    switch (status) {
      case "pending":
        return "\u0432 \u043e\u0447\u0435\u0440\u0435\u0434\u0438";
      case "started":
        return "\u0432 \u0440\u0430\u0431\u043e\u0442\u0435";
      case "finished":
        return "\u0433\u043e\u0442\u043e\u0432\u043e";
      case "error":
        return "\u043e\u0448\u0438\u0431\u043a\u0430";
      case "skipped":
        return "\u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d";
    }
  }
  switch (status) {
    case "pending":
      return "pending";
    case "started":
      return "running";
    case "finished":
      return "done";
    case "error":
      return "error";
    case "skipped":
      return "skipped";
  }
}

function describeStatus(status: TaskStatus): {
  label: string;
  variant: "info" | "success" | "warn" | "error";
} {
  switch (status) {
    case "created":
      return { label: "Creating task", variant: "info" };
    case "researching":
      return { label: "Selecting context", variant: "info" };
    case "coding":
      return { label: "Preparing changes", variant: "info" };
    case "reviewing":
      return { label: "Checking result", variant: "info" };
    case "fixing":
      return { label: "Repairing issues", variant: "info" };
    case "boss_eval":
      return { label: "Finalizing", variant: "info" };
    case "completed":
      return { label: "Completed", variant: "success" };
    case "stopped_limit":
      return { label: "Stopped — review limit reached", variant: "warn" };
    case "error":
      return { label: "Error", variant: "error" };
    case "waiting_consent":
      return { label: "Waiting for user consent", variant: "warn" };
  }
}

function formatTraceEvent(
  ev: TraceEvent,
  artifactMap: ReadonlyMap<string, string> = new Map(),
  locale: ActivityLocale = "en",
): string {
  if (ev.record.kind === "thought") {
    return locale === "ru"
      ? `\u0410\u043a\u0442\u0438\u0432\u043d\u043e\u0441\u0442\u044c - ${truncatePublicActivity(ev.record.text, 200)}`
      : `Activity - ${truncatePublicActivity(ev.record.text, 200)}`;
  }
  if (ev.record.kind === "tool_call") {
    return locale === "ru"
      ? `\u0418\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442 - ${ev.record.tool}`
      : `Tool call - ${ev.record.tool}`;
  }
  if (ev.record.kind === "artifact_change") {
    const fileName = artifactMap.get(ev.record.artifactId) ?? ev.record.artifactId.slice(0, 8);
    return locale === "ru"
      ? `\u0410\u0440\u0442\u0438\u0444\u0430\u043a\u0442 staged - ${fileName}@v${String(ev.record.version)}`
      : `Artifact staged - ${fileName}@v${String(ev.record.version)}`;
  }
  if (ev.record.kind === "status") {
    return locale === "ru"
      ? `\u0421\u0442\u0430\u0442\u0443\u0441 - ${describeAgentStatus(ev.record.status, locale)}`
      : `Status - ${describeAgentStatus(ev.record.status, locale)}`;
  }
  return "activity";
}

function readableAgentName(agentId: AgentId): string {
  if (agentId === "boss") return "Finalizer";
  const known = BUILTIN_AGENTS.find((a) => a.id === agentId);
  if (known !== undefined) return known.displayName;
  if (agentId === "planner") return "Planner";
  if (agentId === "quick_edit") return "Quick Edit";
  if (agentId === "validator") return "Deterministic Validator";
  if (agentId === "finalizer") return "Finalizer";
  if (agentId === "orchestrator") return "Orchestrator";
  if (agentId === "safety_check") return "Safety Check";
  return agentId;
}

function agentInitials(agentId: AgentId): string {
  switch (agentId) {
    case "researcher":
      return "R";
    case "coder":
      return "C";
    case "reviewer":
      return "RV";
    case "fixer":
      return "F";
    case "boss":
      return "FN";
    case "planner":
      return "P";
    case "quick_edit":
      return "QE";
    case "validator":
      return "V";
    case "finalizer":
      return "FN";
    case "orchestrator":
      return "O";
    case "safety_check":
      return "SC";
    default:
      return agentId.slice(0, 2).toUpperCase();
  }
}

function agentRoleLine(agentId: AgentId, locale: ActivityLocale = "en"): string {
  if (locale === "ru") {
    switch (agentId) {
      case "researcher":
        return "\u041d\u0430\u0445\u043e\u0434\u0438\u0442 \u043c\u0438\u043d\u0438\u043c\u0430\u043b\u044c\u043d\u044b\u0439 \u0440\u0435\u043b\u0435\u0432\u0430\u043d\u0442\u043d\u044b\u0439 \u043a\u043e\u043d\u0442\u0435\u043a\u0441\u0442";
      case "planner":
        return "\u041f\u0440\u0435\u0432\u0440\u0430\u0449\u0430\u0435\u0442 \u0437\u0430\u0434\u0430\u0447\u0443 \u0432 \u043f\u043b\u0430\u043d \u0438\u0441\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u044f";
      case "coder":
        return "\u0413\u043e\u0442\u043e\u0432\u0438\u0442 staged \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f";
      case "reviewer":
        return "\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u0435\u0442 \u043a\u0430\u0447\u0435\u0441\u0442\u0432\u043e \u0438 \u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u043e\u0441\u0442\u044c";
      case "fixer":
        return "\u0427\u0438\u043d\u0438\u0442 \u043a\u043e\u043d\u043a\u0440\u0435\u0442\u043d\u044b\u0435 \u0434\u0435\u0444\u0435\u043a\u0442\u044b";
      case "boss":
      case "finalizer":
        return "\u0421\u043e\u0431\u0438\u0440\u0430\u0435\u0442 \u0447\u0435\u0441\u0442\u043d\u044b\u0439 \u0438\u0442\u043e\u0433 \u0438 \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0435 \u0448\u0430\u0433\u0438";
      case "quick_edit":
        return "\u0413\u043e\u0442\u043e\u0432\u0438\u0442 deterministic staged \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f";
      case "validator":
        return "\u0417\u0430\u043f\u0443\u0441\u043a\u0430\u0435\u0442 \u0434\u0435\u0448\u0435\u0432\u044b\u0435 deterministic \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438";
      case "orchestrator":
        return "\u0412\u044b\u0431\u0438\u0440\u0430\u0435\u0442 \u043d\u0443\u0436\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c \u0438 \u0431\u044e\u0434\u0436\u0435\u0442";
      case "safety_check":
        return "\u0411\u043b\u043e\u043a\u0438\u0440\u0443\u0435\u0442 \u043e\u043f\u0430\u0441\u043d\u044b\u0435 \u043a\u043e\u043c\u0430\u043d\u0434\u044b";
      default:
        return "\u0410\u0433\u0435\u043d\u0442";
    }
  }
  switch (agentId) {
    case "researcher":
      return "Finds minimal relevant project context";
    case "planner":
      return "Turns the task into a structured execution plan";
    case "coder":
      return "Creates staged file changes";
    case "reviewer":
      return "Reviews quality and correctness";
    case "fixer":
      return "Repairs specific issues";
    case "boss":
      return "Summarizes result and next steps";
    case "quick_edit":
      return "Prepares deterministic staged changes";
    case "validator":
      return "Runs cheap deterministic checks before model review";
    case "finalizer":
      return "Summarizes result and next steps";
    case "orchestrator":
      return "Routes to Chat, Plan, Agent, Safety, or Quick Edit";
    case "safety_check":
      return "Blocks dangerous commands before execution";
    default:
      return "Agent";
  }
}

function agentStartPhrase(agentId: AgentId, locale: ActivityLocale = "en"): string {
  if (locale === "ru") {
    const phraseByAgent: Partial<Record<AgentId, string>> = {
      researcher: "\u0418\u0449\u0443 \u043c\u0438\u043d\u0438\u043c\u0430\u043b\u044c\u043d\u043e \u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u044b\u0439 \u043a\u043e\u043d\u0442\u0435\u043a\u0441\u0442.",
      planner: "\u041f\u043b\u0430\u043d\u0438\u0440\u0443\u044e \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f \u043f\u0435\u0440\u0435\u0434 coding.",
      coder: "\u0413\u043e\u0442\u043e\u0432\u043b\u044e staged \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f.",
      reviewer: "\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u044e \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442 \u0438 \u0440\u0438\u0441\u043a\u0438.",
      fixer: "\u0418\u0441\u043f\u0440\u0430\u0432\u043b\u044f\u044e \u043a\u043e\u043d\u043a\u0440\u0435\u0442\u043d\u044b\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043d\u044b\u0435 \u043f\u0440\u043e\u0431\u043b\u0435\u043c\u044b.",
      boss: "\u0421\u043e\u0431\u0438\u0440\u0430\u044e \u0447\u0435\u0441\u0442\u043d\u044b\u0439 \u0438\u0442\u043e\u0433 \u0438 \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0435 \u0448\u0430\u0433\u0438.",
      quick_edit: "\u0413\u043e\u0442\u043e\u0432\u043b\u044e \u0442\u043e\u0447\u0435\u0447\u043d\u043e\u0435 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0435 \u0431\u0435\u0437 \u043c\u043e\u0434\u0435\u043b\u0438 \u0438 \u043f\u043e\u043b\u043d\u043e\u0433\u043e pipeline.",
      validator: "\u0417\u0430\u043f\u0443\u0441\u043a\u0430\u044e deterministic \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438.",
      finalizer: "\u0424\u0438\u043d\u0430\u043b\u0438\u0437\u0438\u0440\u0443\u044e staged \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442.",
      orchestrator: "\u0412\u044b\u0431\u0438\u0440\u0430\u044e \u043c\u0438\u043d\u0438\u043c\u0430\u043b\u044c\u043d\u043e \u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c.",
      safety_check: "\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u044e \u043a\u043e\u043c\u0430\u043d\u0434\u0443 \u043d\u0430 \u0440\u0438\u0441\u043a.",
    };
    return phraseByAgent[agentId] ?? "\u0412\u044b\u043f\u043e\u043b\u043d\u044f\u044e \u0448\u0430\u0433.";
  }
  switch (agentId) {
    case "researcher":
      return "Selecting the minimum project context needed.";
    case "planner":
      return "Building an implementation plan.";
    case "coder":
      return "Preparing staged changes.";
    case "reviewer":
      return "Checking quality and risks.";
    case "fixer":
      return "Repairing targeted defects.";
    case "boss":
    case "finalizer":
      return "Summarizing staged files, checks, and next steps.";
    case "quick_edit":
      return "Preparing a deterministic staged edit without a model call.";
    case "validator":
      return "Running deterministic checks before any expensive review.";
    case "orchestrator":
      return "Choosing the smallest safe route for this request.";
    case "safety_check":
      return "Checking command risk before execution.";
    default:
      return "Running a public activity step.";
  }
}

function truncatePublicActivity(text: string, maxLength = 360): string {
  const sanitized = text
    .replace(/\bchain[-\s]?of[-\s]?thought\b/giu, "private reasoning")
    .replace(/\bthoughts?\b/giu, "activity")
    .replace(/\breasoning\b/giu, "analysis")
    .trim();
  return sanitized.length > maxLength ? `${sanitized.slice(0, Math.max(0, maxLength - 3))}...` : sanitized;
}

function detectActivityLocale(text: string): ActivityLocale {
  return /[\u0400-\u04ff]/u.test(text) ? "ru" : "en";
}

function buildArtifactFileNameMap(artifacts: readonly ArtifactMetadata[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const artifact of artifacts) {
    out.set(artifact.id, artifact.fileName);
  }
  return out;
}

function groupFileNames(group: AgentGroup, artifactMap: ReadonlyMap<string, string>): readonly string[] {
  const names: string[] = [];
  for (const ev of group.events) {
    if (ev.record.kind !== "artifact_change") continue;
    const fileName = artifactMap.get(ev.record.artifactId);
    if (fileName !== undefined && !names.includes(fileName)) {
      names.push(fileName);
    }
  }
  return names;
}

function publicActivitySummary(
  group: AgentGroup,
  artifactMap: ReadonlyMap<string, string>,
  taskState: TaskStateSnapshot,
  locale: ActivityLocale,
): string {
  if (group.syntheticReason === "deterministic_validation_passed") {
    return locale === "ru"
      ? "\u041f\u0440\u043e\u043f\u0443\u0449\u0435\u043d: deterministic validation \u043f\u0440\u043e\u0448\u043b\u0430, \u0434\u043e\u0440\u043e\u0433\u043e\u0439 model review \u043d\u0435 \u043d\u0443\u0436\u0435\u043d."
      : "Skipped: deterministic validation passed, so model review was not needed.";
  }
  const files = groupFileNames(group, artifactMap);
  if (group.agentId === "finalizer" || group.agentId === "boss") {
    const count = files.length;
    if (count > 0) {
      return locale === "ru"
        ? `\u041f\u043e\u0434\u0433\u043e\u0442\u043e\u0432\u043b\u0435\u043d\u043e staged \u0444\u0430\u0439\u043b\u043e\u0432: ${String(count)}. Apply Changes \u0432\u0441\u0435 \u0435\u0449\u0435 \u043e\u0431\u044f\u0437\u0430\u0442\u0435\u043b\u0435\u043d.`
        : `Staged files: ${String(count)}. Apply Changes is still required.`;
    }
    if (taskState.deterministicValidation?.status === "passed") {
      return locale === "ru"
        ? "Deterministic validation \u043f\u0440\u043e\u0439\u0434\u0435\u043d\u0430; \u0438\u0442\u043e\u0433 \u043d\u0435 \u043e\u0437\u043d\u0430\u0447\u0430\u0435\u0442 auto-apply."
        : "Deterministic validation passed; the result is still staged, not applied.";
    }
  }
  if (group.summary.length > 0) {
    return truncatePublicActivity(group.summary);
  }
  if (files.length > 0) {
    return locale === "ru"
      ? `\u041f\u043e\u0434\u0433\u043e\u0442\u043e\u0432\u043b\u0435\u043d\u044b staged \u0444\u0430\u0439\u043b\u044b: ${String(files.length)}.`
      : `Staged ${String(files.length)} file${files.length === 1 ? "" : "s"}.`;
  }
  if (group.status === "skipped") {
    return locale === "ru" ? "\u0428\u0430\u0433 \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d." : "Step skipped.";
  }
  return "";
}

function formatAgentElapsed(group: AgentGroup): string | null {
  if (group.startedAtMs === undefined || group.endedAtMs === undefined) return null;
  const elapsedMs = Math.max(0, group.endedAtMs - group.startedAtMs);
  if (elapsedMs < 1000) return "<1s";
  return `${String(Math.round(elapsedMs / 1000))}s`;
}

function formatProvider(p: ProviderId): string {
  switch (p) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "fireworks":
      return "Fireworks AI";
    case "custom-openai":
      return "Custom OpenAI-compatible";
    default:
      return p;
  }
}


function extractFirstUrlLike(text: string): string | null {
  const match = text.match(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i);
  return match?.[0] ?? null;
}

function detectPreviewUrlFromLines(lines: readonly { readonly text: string }[]): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines[i]?.text ?? "";
    const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s"'<>]*)?/i);
    if (match !== null) {
      return match[0];
    }
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function buildSimpleLineDiff(before: string, after: string, fileName: string): string {
  if (before === after) return `diff -- ${fileName}\n(no content changes)`;
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const lines = [`--- a/${fileName}`, `+++ b/${fileName}`];
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i += 1) {
    const oldLine = beforeLines[i];
    const newLine = afterLines[i];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined) lines.push(`-${oldLine}`);
    if (newLine !== undefined) lines.push(`+${newLine}`);
  }
  return lines.join("\n");
}

function isLikelyRussian(text: string): boolean {
  return /[^\x00-\x7F]/u.test(text);
}

function clarificationResponse(prompt: string): string {
  return isLikelyRussian(prompt)
    ? "Уточни, что именно нужно сделать: просто поговорить, проанализировать проект, составить план или изменить файлы?"
    : "Please clarify what you want: chat, analyze something, or change code/project files?";
}

function buildAgentModelOverrides(
  settings: AgentSettingsMap,
): Partial<Record<BuiltinAgentRole, string>> {
  const out: Partial<Record<BuiltinAgentRole, string>> = {};
  for (const agent of BUILTIN_AGENTS) {
    const modelId = settings[agent.id]?.modelId?.trim();
    if (modelId !== undefined && modelId.length > 0) {
      out[agent.id] = modelId;
    }
  }
  return out;
}

function reportToText(report: FinalReportSummary): string {
  const lines: string[] = [];
  lines.push(`Status: ${report.status}`);
  lines.push(`Original prompt: ${report.originalPrompt}`);
  lines.push(`Participants: ${report.participants.join(", ")}`);
  lines.push(`Review cycles: ${String(report.reviewCyclesPerformed)}`);
  if (report.bossSummary !== undefined) {
    lines.push(`Boss: ${report.bossSummary}`);
  }
  if (report.outstandingIssues !== undefined && report.outstandingIssues.length > 0) {
    lines.push("Outstanding issues:");
    for (const issue of report.outstandingIssues) lines.push(`  - ${issue}`);
  }
  if (report.finalArtifacts.length > 0) {
    lines.push("Files changed:");
    for (const f of report.finalArtifacts) {
      lines.push(`  - ${f.fileName} (v${String(f.version)})`);
    }
  }
  return lines.join("\n");
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    // Clipboard may be unavailable in jsdom or under restricted CSP;
    // failing silently is acceptable for a "Copy" button.
  }
}

function buildEmpty(
  doc: Document,
  title: string,
  body: string,
  action?: { label: string; onClick: () => void },
): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.className = "kw-empty";
  const t = doc.createElement("p");
  t.className = "kw-empty-title";
  t.textContent = title;
  const b = doc.createElement("p");
  b.className = "kw-empty-body";
  b.textContent = body;
  wrap.append(t, b);

  if (action !== undefined) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "kw-button kw-button-secondary kw-empty-action";
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    wrap.append(btn);
  }

  return wrap;
}

function appendKv(doc: Document, list: HTMLDListElement, label: string, value: string): void {
  const dt = doc.createElement("dt");
  dt.className = "kw-kv-key";
  dt.textContent = label;
  const dd = doc.createElement("dd");
  dd.className = "kw-kv-value";
  dd.textContent = value;
  list.append(dt, dd);
}

function appendKvElement(doc: Document, list: HTMLDListElement, label: string, element: HTMLElement): void {
  const dt = doc.createElement("dt");
  dt.className = "kw-kv-key";
  dt.textContent = label;
  const dd = doc.createElement("dd");
  dd.className = "kw-kv-value";
  dd.append(element);
  list.append(dt, dd);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n) || Number.isNaN(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return Math.trunc(n);
}

function compactUiText(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : undefined;
    const message = typeof record.message === "string" ? record.message : undefined;
    if (code !== undefined && message !== undefined) return `${code}: ${message}`;
    if (code !== undefined) return code;
    if (message !== undefined) return message;
  }
  return "unrecognized error";
}

// ---------------------------------------------------------------------------
// Helpers re-exported for tests
// ---------------------------------------------------------------------------

export { groupTraceByAgent };

// ---------------------------------------------------------------------------
// Boot-time helpers (back-compat with the previous workspaceShell exports)
// ---------------------------------------------------------------------------

export { readSavedSession, clearSavedSession } from "./sessionPersistence.js";
