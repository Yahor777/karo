// @vitest-environment jsdom
/**
 * Tests for the chat-centric KARO workbench (`workbench.ts`).
 *
 * Validates: Requirements 1.4, 1.6, 6.1, 6.5, 6.7, 7.1, 11.1, 11.2,
 * 11.7, 14.2, 14.4.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountWorkspaceShell } from "./workbench.js";
import type { ApiKeyMetadata } from "./desktopApiKeySink.js";
import type {
  DesktopShell,
  ProjectSummaryResult,
  ValidateFolderPathResult,
  ApplyResult,
} from "../shell/types.js";
import type {
  ArtifactListener,
  ArtifactMetadata,
  ArtifactVersion,
  ChatMessage,
  ChatResponse,
  FinalReportListener,
  FinalReportSummary,
  OrchestratorTransport,
  StartTaskInput,
  StartTaskResult,
  TaskStateListener,
  TaskStateSnapshot,
  TraceEvent,
  TraceListener,
  ConsentDecision,
} from "../orchestration/index.js";

const SAMPLE_METADATA: ApiKeyMetadata = {
  provider: "fireworks",
  fingerprint: "ab12cd34",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  modelId: "accounts/fireworks/models/llama-v3p1-8b-instruct",
  savedAt: "2026-05-17T12:00:00.000Z",
};

const SAMPLE_SESSION = {
  id: "sess-1",
  kind: "local" as const,
  deviceId: "dev-1",
  createdAt: "2026-05-17T12:00:00.000Z",
};

function buildShell(): {
  shell: DesktopShell;
  reads: Map<string, unknown>;
  writes: Array<{ key: string; value: unknown }>;
  deletes: string[];
  probeBody: string;
  setProbeBody: (body: string, ok?: boolean) => void;
} {
  const reads = new Map<string, unknown>();
  const writes: Array<{ key: string; value: unknown }> = [];
  const deletes: string[] = [];
  let probeBody = "";
  let probeOk = true;

  const shell: DesktopShell = {
    getDeviceId: vi.fn(async () => "device-test"),
    readLocalSetting: <T = unknown>(key: string): Promise<T | null> => {
      return Promise.resolve((reads.get(key) as T | undefined) ?? null);
    },
    writeLocalSetting: vi.fn(async (key: string, value: unknown) => {
      writes.push({ key, value });
      reads.set(key, value);
      return undefined;
    }),
    deleteLocalSetting: vi.fn(async (key: string) => {
      deletes.push(key);
      reads.delete(key);
      return undefined;
    }),
    encryptLocalSecret: vi.fn(async () => ({
      algorithm: "aes-256-gcm",
      ciphertext: "AA==",
      createdAt: "2026-05-17T12:00:00.000Z",
    })),
    decryptLocalSecret: vi.fn(async () => "fw-test-key"),
    writeLocalLog: vi.fn(async () => undefined),
    exportFile: vi.fn(async () => ({ savedPath: "" })),
    showNotification: vi.fn(async () => undefined),
    probeProvider: vi.fn(async () => ({
      status: probeOk ? 200 : 500,
      ok: probeOk,
      body: probeBody,
    })),
    validateFolderPath: vi.fn(
      async (path: string): Promise<ValidateFolderPathResult> => ({
        ok: true,
        normalizedPath: path.trim(),
      }),
    ),
    readProjectSummary: vi.fn(
      async (path: string): Promise<ProjectSummaryResult> => ({
        rootPath: path,
        files: [
          { path: "package.json", kind: "file" as const },
          { path: "src", kind: "directory" as const },
        ],
        snippets: [
          { path: "package.json", content: '{"scripts":{"build":"tsc -b"}}', truncated: false },
        ],
        omitted: [],
      }),
    ),
  };
  reads.set("secret:apiKey:fireworks", {
    algorithm: "aes-256-gcm",
    ciphertext: "AA==",
    createdAt: "2026-05-17T12:00:00.000Z",
  });
  return {
    shell,
    reads,
    writes,
    deletes,
    get probeBody() {
      return probeBody;
    },
    setProbeBody(body: string, ok = true): void {
      probeBody = body;
      probeOk = ok;
    },
  };
}

class FakeTransport implements OrchestratorTransport {
  public createCalls: StartTaskInput[] = [];
  public resumeCalls: Array<{ taskId: string; decision: ConsentDecision }> = [];
  public createImpl: (input: StartTaskInput) => Promise<StartTaskResult> = async () => ({
    taskId: "task-1",
  });

  private taskState: TaskStateSnapshot | null = null;
  private trace: TraceEvent[] = [];
  private artifacts: Map<string, ArtifactMetadata> = new Map();
  private artifactVersions: Map<string, ArtifactVersion[]> = new Map();
  private finalReport: FinalReportSummary | null = null;

  private taskStateListeners = new Set<TaskStateListener>();
  private traceListeners = new Set<TraceListener>();
  private artifactListeners = new Set<ArtifactListener>();
  private finalReportListeners = new Set<FinalReportListener>();

  public async createAndRunTask(input: StartTaskInput): Promise<StartTaskResult> {
    this.createCalls.push(input);
    return this.createImpl(input);
  }
  public getTaskState(): TaskStateSnapshot | null {
    return this.taskState;
  }
  public getTraceEvents(): readonly TraceEvent[] {
    return [...this.trace];
  }
  public getArtifacts(): readonly ArtifactMetadata[] {
    return Array.from(this.artifacts.values());
  }
  public getArtifactVersion(
    _taskId: string,
    artifactId: string,
    version: number,
  ): ArtifactVersion | null {
    const versions = this.artifactVersions.get(artifactId) ?? [];
    return versions.find((v) => v.version === version) ?? null;
  }
  public getFinalReport(): FinalReportSummary | null {
    return this.finalReport;
  }
  public listTasks(): readonly TaskStateSnapshot[] {
    return this.taskState !== null ? [this.taskState] : [];
  }
  public subscribeTaskState(listener: TaskStateListener): () => void {
    this.taskStateListeners.add(listener);
    return () => this.taskStateListeners.delete(listener);
  }
  public subscribeTrace(listener: TraceListener): () => void {
    this.traceListeners.add(listener);
    return () => this.traceListeners.delete(listener);
  }
  public subscribeArtifacts(listener: ArtifactListener): () => void {
    this.artifactListeners.add(listener);
    return () => this.artifactListeners.delete(listener);
  }
  public subscribeFinalReport(listener: FinalReportListener): () => void {
    this.finalReportListeners.add(listener);
    return () => this.finalReportListeners.delete(listener);
  }
  public async resumeTask(taskId: string, decision: ConsentDecision): Promise<void> {
    this.resumeCalls.push({ taskId, decision });
  }
  public async applyStagedChanges(_taskId: string, _approval: boolean): Promise<ApplyResult> {
    return {
      success: true,
      changedFiles: [],
      createdFiles: [],
      overwrittenFiles: [],
      skippedFiles: [],
      errors: [],
    };
  }

  // Test helpers
  public emitTaskState(state: TaskStateSnapshot): void {
    this.taskState = state;
    for (const l of this.taskStateListeners) l(state.id, state);
  }
  public emitTraceEvent(ev: TraceEvent): void {
    this.trace.push(ev);
    for (const l of this.traceListeners) l(ev.taskId, ev);
  }
  public emitArtifact(meta: ArtifactMetadata, content: string): void {
    this.artifacts.set(meta.id, meta);
    const versions = this.artifactVersions.get(meta.id) ?? [];
    versions.push({
      artifactId: meta.id,
      version: meta.latestVersion,
      fileName: meta.fileName,
      contentHash: meta.latestContentHash,
      content,
      authoredByAgentId: meta.authoredByAgentId,
      createdAt: meta.updatedAt,
    });
    this.artifactVersions.set(meta.id, versions);
    for (const l of this.artifactListeners) l(meta.taskId, meta);
  }
  public emitFinalReport(report: FinalReportSummary): void {
    this.finalReport = report;
    for (const l of this.finalReportListeners) l(report.taskId, report);
  }
}

class FakeChatModelClient {
  public calls: Array<{
    modelId: string;
    apiKey: string;
    messages: readonly ChatMessage[];
    maxTokens?: number;
  }> = [];
  public nextResponse: ChatResponse = {
    kind: "ok",
    text: "LLM answer from selected model.",
  };

  public async chat(req: {
    readonly modelId: string;
    readonly apiKey: string;
    readonly messages: readonly ChatMessage[];
    readonly maxTokens?: number;
  }): Promise<ChatResponse> {
    this.calls.push({
      modelId: req.modelId,
      apiKey: req.apiKey,
      messages: req.messages,
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    });
    return this.nextResponse;
  }
}

let root: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 16; i += 1) {
    await Promise.resolve();
  }
}

function buildOptions(
  overrides: Partial<Parameters<typeof mountWorkspaceShell>[1]> = {},
): Parameters<typeof mountWorkspaceShell>[1] & {
  shell: DesktopShell;
  transport: FakeTransport;
  chatModelClient: FakeChatModelClient;
} {
  const built = buildShell();
  const defaultTransport = new FakeTransport();
  const defaultChat = new FakeChatModelClient();
  const merged: Parameters<typeof mountWorkspaceShell>[1] = {
    session: SAMPLE_SESSION,
    metadata: SAMPLE_METADATA,
    desktopShell: built.shell,
    transport: defaultTransport,
    chatModelClient: defaultChat,
    onSignOut: vi.fn(),
    ...overrides,
  };
  return {
    ...merged,
    shell: built.shell,
    transport: (merged.transport as FakeTransport | undefined) ?? defaultTransport,
    chatModelClient: (merged.chatModelClient as FakeChatModelClient | undefined) ?? defaultChat,
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

describe("workbench ??? layout", () => {
  it("renders topbar with KARO brand, project, provider info and Sign out", () => {
    mountWorkspaceShell(root, buildOptions());
    expect(root.querySelector<HTMLImageElement>(".kw-brand-logo")?.alt).toBe("KARO");
    expect(root.querySelector(".kw-brand-name")?.textContent).toBe("KARO");
    expect(root.querySelector(".kw-brand-tagline")?.textContent).toContain("AI Agent Orchestrator");
    expect(root.querySelector(".kw-project-field")?.textContent).toBe("No project selected");
    expect(root.querySelector(".kw-provider-line")?.textContent).toContain("Fireworks AI");
    const modelLine = root.querySelector<HTMLElement>(".kw-model-line");
    expect(modelLine?.textContent).toContain("Llama V3.1 8B Instruct");
    expect(modelLine?.title).toBe("accounts/fireworks/models/llama-v3p1-8b-instruct");
    expect(root.querySelector(".kw-topbar-signout")).toBeNull();
    expect(root.querySelector(".kw-sidebar-signout")?.textContent).toBe("Sign out");
    expect(root.querySelector(".kw-header-perm-badge")).toBeNull();
    expect(root.querySelector(".kw-header-web-badge")).toBeNull();
  });

  it("renders the seven sidebar items as text labels (no emoji)", () => {
    mountWorkspaceShell(root, buildOptions());
    const buttons = root.querySelectorAll<HTMLButtonElement>(".kw-sidebar-button");
    const labels = Array.from(buttons).map(
      (b) => b.querySelector<HTMLElement>(".kw-sidebar-label")?.textContent,
    );
    expect(labels).toEqual(["Chat", "Project", "Changes", "Runs", "Models", "Agents", "Settings"]);
    // Forbid stray emoji code points in the entire sidebar.
    const sidebarText = root.querySelector(".kw-sidebar")?.textContent ?? "";
    expect(/[\p{Extended_Pictographic}]/u.test(sidebarText)).toBe(false);
  });

  it("collapses the sidebar and hides labels", () => {
    mountWorkspaceShell(root, buildOptions());
    const sidebar = root.querySelector<HTMLElement>(".kw-sidebar")!;
    expect(sidebar.dataset["collapsed"]).toBe("false");
    const collapseBtn = root.querySelector<HTMLButtonElement>(".kw-sidebar-collapse")!;
    expect(collapseBtn.textContent).toBe("Collapse");
    collapseBtn.click();
    expect(sidebar.dataset["collapsed"]).toBe("true");
    expect(collapseBtn.textContent).toBe("Expand");
    // Initials remain in the DOM but labels are hidden via CSS
    // (data-collapsed is what tests check; styling is asserted in CSS).
    const labels = root.querySelectorAll(".kw-sidebar-label");
    expect(labels.length).toBeGreaterThan(0);
  });

  it("renders right panel tabs and switches active tab", () => {
    mountWorkspaceShell(root, buildOptions());
    const tabs = root.querySelectorAll<HTMLButtonElement>(".kw-right-tab");
    const ids = Array.from(tabs).map((t) => t.dataset["tabId"]);
    expect(ids).toEqual(["preview", "changes", "logs", "usage"]);
    expect(ids).not.toContain("terminal");

    const preview = root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="preview"]')!;
    preview.click();
    expect(root.querySelector<HTMLElement>(".kw-right-content")?.dataset["tab"]).toBe("preview");
    expect(root.querySelector(".kw-right-content")?.textContent).toContain("Suggested command");
  });

  it("Usage empty state explains run evidence and only prepares explicit next actions", () => {
    mountWorkspaceShell(root, buildOptions());
    root.querySelector<HTMLButtonElement>('[data-testid="right-tab-usage"]')!.click();

    const readiness = root.querySelector<HTMLElement>('[data-testid="usage-readiness"]');
    expect(readiness).not.toBeNull();
    expect(readiness?.textContent).toContain("No usage recorded yet");
    expect(readiness?.textContent).toContain("Model calls");
    expect(readiness?.textContent).toContain("0");
    expect(readiness?.textContent).toContain("Apply");
    expect(readiness?.textContent).toContain("Unavailable");
    expect(readiness?.textContent).not.toContain("Open Composer");

    root.querySelector<HTMLButtonElement>('[data-testid="usage-plan-next"]')!.click();
    expect(root.querySelector<HTMLButtonElement>('[data-testid="composer-mode-plan"]')?.getAttribute("aria-current")).toBe(
      "true",
    );
    expect(root.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]')?.value).toContain(
      "Plan the next focused Karo AI IDE improvement",
    );
    expect(root.querySelector("[data-testid='changes-apply-button']")).toBeNull();

    root.querySelector<HTMLButtonElement>('[data-testid="usage-choose-project"]')!.click();
    expect(root.querySelector<HTMLElement>(".kw-center")?.dataset["routeId"]).toBe("project");
  });

  it("renders post-run usage as an evidence summary before raw metrics", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);

    opts.transport.emitTaskState({
      id: "usage-evidence",
      status: "completed",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 0,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:18.000Z",
      originalPrompt: "Create a polished local website",
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["planner", "coder"],
      isExplainOnly: false,
      currentContextUsage: {
        modelId: SAMPLE_METADATA.modelId!,
        contextWindowTokens: 128_000,
        usedTokens: 24_000,
        usageRatio: 24_000 / 128_000,
        systemPromptTokens: 1_200,
        userPromptTokens: 560,
        conversationTokens: 1_400,
        projectContextTokens: 2_200,
        selectedFilesTokens: 3_300,
        toolResultTokens: 0,
        outputTokens: 1_200,
        reservedOutputTokens: 4_000,
        estimatedCostUsd: 0.01234,
        isEstimated: true,
        updatedAt: "2026-05-17T12:00:18.000Z",
      },
      contextSummary: {
        scannedFilesCount: 42,
        selectedFilesCount: 1,
        selectedFiles: [
          { relativePath: "src/karo-demo-site/index.html", score: 1, reason: ["website"], truncated: false },
        ],
        warnings: [],
      },
      agentCoreEstimate: {
        mode: "agent",
        routeReason: "website generation",
        routeReasonUser: "This needs staged artifacts and validation.",
        routeReasonInternal: "test",
        expectedModelCalls: 2,
        maxExpectedModelCalls: 4,
        baselineSingleModelCalls: 4,
        avoidedFullPipelineModelCalls: 2,
        expectedContextTokens: 5_500,
        contextTokensEstimate: 5_500,
        selectedFilesEstimate: 1,
        contextProfile: "website_creation",
        requiresProjectContext: true,
        allowsCommands: false,
        riskLevel: "medium",
        allowsArtifacts: true,
        timeoutRisk: "medium",
        timeoutPolicy: "Bounded model calls.",
        recoveryPolicy: "Preserve staged artifacts and retry failed stage.",
        fallbackCountsAsSuccess: false,
        stages: [],
        warnings: [],
      },
      providerDiagnostics: [
        {
          id: "diag-usage-1",
          agentId: "coder",
          stageName: "Coder",
          provider: SAMPLE_METADATA.provider,
          modelId: SAMPLE_METADATA.modelId!,
          inputTokenEstimate: 5_500,
          selectedFilesCount: 1,
          contextTokens: 5_500,
          timeoutMs: 120_000,
          elapsedMs: 18_500,
          partialOutputReceived: false,
          artifactsCreated: true,
          createdAt: "2026-05-17T12:00:16.000Z",
        },
      ],
    });
    opts.transport.emitArtifact(
      {
        id: "art-usage-index",
        taskId: "usage-evidence",
        fileName: "src/karo-demo-site/index.html",
        latestVersion: 1,
        latestContentHash: "hash",
        authoredByAgentId: "coder",
        updatedAt: "2026-05-17T12:00:18.000Z",
      },
      "<main><section class=\"hero\">Karo</section></main>",
    );
    const stateObj = (root as any)._karoState || (window as any)._karoState;
    if (stateObj) {
      stateObj.activeTaskId = "usage-evidence";
    }

    root.querySelector<HTMLButtonElement>('[data-testid="right-tab-usage"]')!.click();
    await flush();

    const summary = root.querySelector<HTMLElement>('[data-testid="usage-evidence-summary"]');
    expect(summary).not.toBeNull();
    const summaryText = summary?.textContent ?? "";
    expect(summaryText).toContain("Llama V3.1 8B Instruct");
    expect(summaryText).toContain("Model calls");
    expect(summaryText).toContain("18.5s model time");
    expect(summaryText).toContain("Context");
    expect(summaryText).toContain("Artifacts");
    expect(summaryText).toContain("1 staged");
    expect(root.querySelector('[data-testid="usage-readiness"]')).toBeNull();
    expect(root.querySelector<HTMLElement>(".kw-right-content")?.textContent).toContain("Token Breakdown");
  });

  it("refreshes right inspector tabs after persisted project hydration", async () => {
    const built = buildShell();
    built.reads.set("recentProject", {
      path: "D:\\проекты\\karo-exstention",
      savedAt: "2026-05-17T12:00:00.000Z",
    });
    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport: new FakeTransport(),
      chatModelClient: new FakeChatModelClient(),
      onSignOut: vi.fn(),
    });
    await flush();

    const filesTab = root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="files"]');
    expect(filesTab).not.toBeNull();
    expect(root.querySelector(".kw-right-tabs")?.textContent).toContain("Files");
    filesTab!.click();
    await flush();

    const rightContent = root.querySelector<HTMLElement>(".kw-right-content")!;
    expect(rightContent.dataset["tab"]).toBe("files");
    expect(rightContent.textContent).toContain("package.json");
    expect(root.querySelector(".kw-files-list")).not.toBeNull();
  });

  it("shows Logs tab immediately after a run starts without requiring tab rehydration", async () => {
    const opts = buildOptions();
    opts.transport.createImpl = async () => ({ taskId: "task-logs" });
    mountWorkspaceShell(root, opts);

    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "Build hello world";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
    await flush();
    await flush();

    const logsTab = root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="logs"]');
    expect(logsTab).not.toBeNull();
    expect(root.querySelector(".kw-right-tabs")?.textContent).toContain("Logs");
    logsTab!.click();
    expect(root.querySelector(".kw-right-content")?.textContent).toContain("Task task-log started");
    expect(root.querySelector(".kw-right-content")?.textContent).toContain("Run events");
    expect(root.querySelector(".kw-right-content")?.textContent).not.toContain("System Logs");
  });

  it("Logs empty state is an honest event ledger, not a fake refresh/debug panel", () => {
    mountWorkspaceShell(root, buildOptions());
    root.querySelector<HTMLButtonElement>('[data-testid="right-tab-logs"]')!.click();

    const ledger = root.querySelector<HTMLElement>('[data-testid="logs-ledger-empty"]');
    expect(ledger).not.toBeNull();
    expect(ledger?.textContent).toContain("No run events yet");
    expect(ledger?.textContent).toContain("Provider calls");
    expect(ledger?.textContent).toContain("Commands");
    expect(ledger?.textContent).toContain("Artifacts");
    expect(ledger?.textContent).toContain("Recovery");
    expect(ledger?.textContent).not.toContain("Refresh Logs Status");
    expect(ledger?.textContent).not.toContain("developer traces");
    expect(/[\p{Extended_Pictographic}]/u.test(ledger?.textContent ?? "")).toBe(false);

    root.querySelector<HTMLButtonElement>('[data-testid="logs-open-usage"]')!.click();
    expect(root.querySelector<HTMLElement>(".kw-right-content")?.dataset["tab"]).toBe("usage");
    root.querySelector<HTMLButtonElement>('[data-testid="right-tab-logs"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-testid="logs-open-changes"]')!.click();
    expect(root.querySelector<HTMLElement>(".kw-right-content")?.dataset["tab"]).toBe("changes");
  });

  it("limits context popover trigger to the usage ring button", () => {
    mountWorkspaceShell(root, buildOptions());
    const ring = root.querySelector<HTMLElement>(".kw-composer .kw-context-ring-container");
    const trigger = root.querySelector<HTMLButtonElement>(".kw-composer .kw-context-ring-trigger");

    expect(ring).not.toBeNull();
    expect(trigger).not.toBeNull();
    expect(trigger?.parentElement).toBe(ring);
    expect(root.querySelector(".kw-provider-info .kw-context-tooltip")).toBeNull();
    expect(root.querySelector(".kw-topbar .kw-context-ring-trigger")).toBeNull();
    expect(root.querySelector(".kw-composer .kw-context-ring-trigger")).not.toBeNull();
    expect(root.querySelector(".kw-chat-thread .kw-context-usage-portal")).toBeNull();
    expect(root.querySelector(".kw-composer .kw-context-usage-portal")).toBeNull();
    expect(document.body.querySelector(".kw-context-usage-portal")).toBeNull();
    root.querySelector<HTMLElement>(".kw-provider-info")?.dispatchEvent(new Event("mouseenter"));
    expect(document.body.querySelector(".kw-context-usage-portal")).toBeNull();
    trigger?.dispatchEvent(new Event("mouseenter"));
    expect(ring?.dataset["open"]).toBe("true");
    const portal = document.body.querySelector<HTMLElement>(".kw-context-usage-portal");
    expect(portal).not.toBeNull();
    expect(root.querySelector(".kw-chat-thread .kw-context-usage-portal")).toBeNull();
    expect(root.querySelector(".kw-composer .kw-context-usage-portal")).toBeNull();
    expect(portal?.classList.contains("kw-context-usage-portal")).toBe(true);
    expect(portal?.querySelector(".kw-context-usage-id")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Chat workbench
// ---------------------------------------------------------------------------

describe("workbench ??? chat workbench", () => {
  it("renders welcome card and composer when no task is active", () => {
    mountWorkspaceShell(root, buildOptions());
    expect(root.querySelector(".kw-chat-welcome")).not.toBeNull();
    expect(root.querySelector(".kw-chat-welcome")?.textContent).toContain("Apply gate");
    expect(root.querySelector(".kw-chat-welcome")?.textContent).toContain("Disk writes require the Apply gate.");
    expect(root.querySelector(".kw-chat-welcome")?.textContent).toContain("Choose project");
    expect(root.querySelector(".kw-composer-input")).not.toBeNull();
    const send = root.querySelector<HTMLButtonElement>(".kw-composer-start")!;
    expect(send.textContent).toBe("\u2191");
    expect(send.title).toBe("Send");
    expect(send.disabled).toBe(true);
  });

  it("welcome suggestions preselect the safest matching composer mode", () => {
    mountWorkspaceShell(root, buildOptions());
    const input = root.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]')!;

    root.querySelector<HTMLButtonElement>('[data-testid="welcome-suggestion-plan-make-a-plan"]')!.click();
    expect(root.querySelector<HTMLButtonElement>('[data-testid="composer-mode-plan"]')?.getAttribute("aria-current")).toBe("true");
    expect(input.value).toContain("read-only plan");
    expect(root.querySelector<HTMLButtonElement>(".kw-composer-start")?.disabled).toBe(false);

    root.querySelector<HTMLButtonElement>('[data-testid="welcome-suggestion-agent-create-a-file"]')!.click();
    expect(root.querySelector<HTMLButtonElement>('[data-testid="composer-mode-agent"]')?.getAttribute("aria-current")).toBe("true");
    expect(input.value).toBe("Create file src/karo-test.txt with text hello");

    root.querySelector<HTMLButtonElement>('[data-testid="welcome-suggestion-chat-security-review"]')!.click();
    expect(root.querySelector<HTMLButtonElement>('[data-testid="composer-mode-chat"]')?.getAttribute("aria-current")).toBe("true");
    expect(input.value).toContain("Do not change files");
  });

  it("Send with empty prompt is disabled and does not start a run", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    expect(opts.transport.createCalls).toHaveLength(0);
    const status = root.querySelector<HTMLElement>(".kw-composer-status");
    expect(root.querySelector<HTMLButtonElement>(".kw-composer-start")?.disabled).toBe(true);
    expect(status?.textContent ?? "").not.toContain("Prompt cannot be empty");
  });

  it("composer controls update per-task UI preferences", () => {
    mountWorkspaceShell(root, buildOptions());
    const selects = Array.from(root.querySelectorAll<HTMLLabelElement>(".kw-composer-select"));
    expect(selects.map((s) => s.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Command"),
        expect.stringContaining("Web"),
        expect.stringContaining("Preset"),
        expect.stringContaining("Context"),
        expect.stringContaining("Effort"),
      ]),
    );

    const command = selects
      .find((s) => s.textContent?.includes("Command"))
      ?.querySelector<HTMLSelectElement>("select")!;
    command.value = "safe_commands";
    command.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("karo.permissionMode")).toBe("safe_commands");

    const context = selects
      .find((s) => s.textContent?.includes("Context"))
      ?.querySelector<HTMLSelectElement>("select")!;
    context.value = "128k";
    context.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("karo.effectiveContextWindow")).toBe("128k");
  });

  it("context window options are capped by model context capability", () => {
    mountWorkspaceShell(root, buildOptions({
      metadata: {
        ...SAMPLE_METADATA,
        modelId: "accounts/fireworks/models/deepseek-v4-pro",
      },
    }));
    const contextSelect = Array.from(root.querySelectorAll<HTMLLabelElement>(".kw-composer-select"))
      .find((s) => s.textContent?.includes("Context"))
      ?.querySelector<HTMLSelectElement>("select")!;
    const options = Array.from(contextSelect.options).map((o) => o.value);
    expect(options).toContain("1m");
    expect(options).not.toContain("2m");

    root.innerHTML = "";
    mountWorkspaceShell(root, buildOptions({
      metadata: {
        ...SAMPLE_METADATA,
        modelId: "accounts/fireworks/models/unknown-custom-model",
      },
    }));
    const unknownContext = Array.from(root.querySelectorAll<HTMLLabelElement>(".kw-composer-select"))
      .find((s) => s.textContent?.includes("Context"))
      ?.querySelector<HTMLSelectElement>("select")!;
    const unknownOptions = Array.from(unknownContext.options).map((o) => o.value);
    expect(unknownOptions).toEqual(["auto", "128k", "custom"]);
  });

  it("selected composer mode persists after sending", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = { kind: "ok", text: "Read-only answer." };
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-pill[data-value="plan"]')!.click();
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "объясни что такое проект";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();
    expect(localStorage.getItem("karo.composerMode")).toBe("plan");
    expect(root.querySelector<HTMLButtonElement>('.kw-pill[data-value="plan"]')?.getAttribute("aria-current")).toBe("true");
  });

  it("Plan Mode answers with a Plan Result and does not start the agent pipeline", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = {
      kind: "ok",
      text: JSON.stringify({
        goal: "Улучшить UX Karo без изменения файлов в Plan Mode.",
        assumptions: ["Нужен review текущего UI."],
        relevantFileAreas: ["workbench.ts", "main.css"],
        implementationSteps: ["Проверить composer", "Проверить right inspector", "Составить Agent task после ревью"],
        risks: ["Scope может расползтись."],
        tests: ["gui:check", "tsc"],
        estimatedComplexity: "medium",
        expectedModelCallsContextBudget: "One planning call.",
        suggestedExecutionMode: "Agent",
        acceptanceCriteria: ["План понятен пользователю."],
        whatNotToDoYet: ["Не создавать artifacts в Plan Mode."],
      }),
    };
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-pill[data-value="plan"]')!.click();
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "сделай план переделки UI как в Codex";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    const answer = Array.from(root.querySelectorAll<HTMLElement>(".kw-chat-assistant"))
      .map((el) => el.textContent ?? "")
      .join("\n");
    expect(answer).toContain("Plan Result");
    expect(answer).toContain("Цель");
    expect(answer).toContain("Предпосылки");
    expect(answer).toContain("Зоны файлов");
    expect(answer).toContain("Шаги реализации");
    expect(answer).toContain("Риски");
    expect(answer).toContain("Проверки");
    expect(answer).toContain("Оценка сложности");
    expect(answer).toContain("Рекомендуемый режим");
    expect(opts.transport.createCalls).toHaveLength(0);
    expect(opts.shell.readProjectSummary).not.toHaveBeenCalled();
    expect(root.querySelector(".kw-chat-final")).toBeNull();
    expect(root.querySelector("[data-testid='changes-apply-button']")).toBeNull();
  });

  it("generic Plan Mode does not read project context", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = {
      kind: "ok",
      text: JSON.stringify({
        goal: "Build a one-week Python learning plan.",
        assumptions: ["The learner can study daily."],
        relevantFileAreas: [],
        implementationSteps: ["Day 1: syntax", "Day 2: functions", "Day 3: small script"],
        risks: ["Too much theory."],
        tests: ["Write one runnable script."],
        estimatedComplexity: "low",
        expectedModelCallsContextBudget: "One planning call, no project context.",
        suggestedExecutionMode: "Plan",
        acceptanceCriteria: ["The learner has a daily checklist."],
        whatNotToDoYet: ["Do not scan the local project."],
      }),
    };
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-pill[data-value="plan"]')!.click();
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "составь план изучения Python на неделю";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.chatModelClient.calls).toHaveLength(1);
    expect(opts.shell.readProjectSummary).not.toHaveBeenCalled();
    const userPayload = opts.chatModelClient.calls[0]!.messages.at(-1)!.content;
    expect(userPayload).toContain("Plan context profile: none");
    expect(root.querySelector("[data-testid='chat-readonly-context']")).toBeNull();
    expect(opts.transport.createCalls).toHaveLength(0);
  });

  it("project-specific Plan Mode uses minimal read-only Context Engine", async () => {
    const built = buildShell();
    built.reads.set("recentProject", {
      path: "D:\\projects\\karo",
      savedAt: "2026-05-17T12:00:00.000Z",
    });
    built.shell.shell_build_task_context = vi.fn(async () => ({
      projectRoot: "D:\\projects\\karo",
      prompt: "спланируй как переделать Agent Activity UI в Karo",
      fileTreeSummary: [],
      selectedFiles: [
        {
          relativePath: "apps/desktop-windows/src/ui/workbench.ts",
          content: "function buildChatMessage() {}",
          sizeBytes: 64,
          score: 40,
          reason: ["ui work"],
          truncated: false,
        },
        {
          relativePath: "apps/desktop-windows/src/ui/main.css",
          content: ".kw-agent-card {}",
          sizeBytes: 32,
          score: 36,
          reason: ["visual work"],
          truncated: false,
        },
      ],
      ignoredSummary: {
        ignoredDirs: 0,
        ignoredFiles: 0,
        ignoredLargeFiles: 0,
        ignoredBinaryFiles: 0,
        ignoredSecretFiles: 0,
      },
      tokenBudgetHint: 48000,
      createdAt: "2026-05-17T12:00:00.000Z",
      warnings: [],
      scannedFilesCount: 20,
      selectedFilesCount: 2,
    }));
    const chat = new FakeChatModelClient();
    chat.nextResponse = {
      kind: "ok",
      text: JSON.stringify({
        goal: "Спланировать Agent Activity UI.",
        assumptions: ["Контекст выбран read-only."],
        relevantFileAreas: ["workbench.ts", "main.css"],
        implementationSteps: ["Описать карточки", "Проверить scroll", "Добавить GUI assertions"],
        risks: ["Не показывать hidden chain-of-thought."],
        tests: ["workbench.test.ts", "gui:check"],
        estimatedComplexity: "medium",
        expectedModelCallsContextBudget: "One planning call plus selected UI context.",
        suggestedExecutionMode: "Agent",
        acceptanceCriteria: ["План не создает artifacts."],
        whatNotToDoYet: ["Не делать redesign."],
      }),
    };
    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport: new FakeTransport(),
      chatModelClient: chat,
      onSignOut: vi.fn(),
    });
    await flush();
    (root as any)._karoState.project = {
      path: "D:\\projects\\karo",
      savedAt: "2026-05-17T12:00:00.000Z",
    };
    root.querySelector<HTMLButtonElement>('.kw-pill[data-value="plan"]')!.click();
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "спланируй как переделать Agent Activity UI в Karo";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(built.shell.shell_build_task_context).toHaveBeenCalledWith(
      "D:\\projects\\karo",
      "спланируй как переделать Agent Activity UI в Karo",
      expect.objectContaining({ maxFiles: 8, includeContent: true }),
    );
    const payload = chat.calls[0]!.messages.at(-1)!.content;
    expect(payload).toContain("Plan context profile: ui_work");
    expect(payload).toContain("workbench.ts");
    expect(root.querySelector("[data-testid='chat-readonly-context']")?.textContent).toContain("2 files");
    const planActions = root.querySelector<HTMLElement>('[data-testid="plan-result-actions"]');
    expect(planActions).not.toBeNull();
    expect(planActions?.textContent).toContain("Plan Mode did not stage files");
    expect(planActions?.textContent).toContain("Prepare Agent run");
    expect(planActions?.textContent).toContain("Copy plan");
    expect(planActions?.textContent).toContain("Run Evidence");
    root.querySelector<HTMLButtonElement>('[data-testid="plan-prepare-agent"]')!.click();
    const agentPrompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.value ?? "";
    expect(root.querySelector<HTMLElement>('.kw-pill[data-value="agent"]')?.getAttribute("aria-current")).toBe("true");
    expect(agentPrompt).toContain("Use this reviewed plan as input for Agent Mode");
    expect(agentPrompt).toContain("Stage artifacts only");
    expect(agentPrompt).toContain("Plan Result");
    expect(root.querySelector("[data-testid='changes-apply-button']")).toBeNull();
  });

  it("Plan Mode provider timeout is an honest recovery state, not fake success", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = {
      kind: "error",
      providerCode: "provider_timeout",
      providerMessage: "model timed out",
    };
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-pill[data-value="plan"]')!.click();
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    const promptText = "make a plan to improve Karo UI";
    prompt.value = promptText;
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    const text = root.textContent ?? "";
    expect(text).toContain("Plan Mode could not complete");
    expect(text).toContain("Retry Plan");
    expect(text).toContain("provider_timeout");
    expect(text).toContain("No files were changed");
    expect(text).not.toContain("Artifacts staged");
    const failureFocus = root.querySelector<HTMLElement>('[data-testid="failure-focus"]');
    expect(failureFocus).not.toBeNull();
    expect(failureFocus?.textContent).toContain("Safe stop: no writes");
    expect(failureFocus?.textContent).toContain("No files changed");
    expect(failureFocus?.textContent).toContain("none staged");
    expect(failureFocus?.textContent).toContain("Use recovery actions");
    const recovery = root.querySelector<HTMLElement>('[data-testid="plan-failure-recovery"]');
    expect(recovery).not.toBeNull();
    expect(recovery?.textContent).toContain("read-only failure");
    expect(recovery?.textContent).toContain("Make smaller plan");
    expect(opts.transport.createCalls).toHaveLength(0);
    expect(root.querySelector("[data-testid='changes-apply-button']")).toBeNull();

    const retryPlan = Array.from(recovery?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent === "Retry Plan");
    retryPlan?.click();
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.value).toBe(promptText);
    expect(root.querySelector<HTMLElement>('.kw-pill[data-value="plan"]')?.getAttribute("aria-current")).toBe("true");
  });

  it("Plan Mode missing API key is honest failure, not fake success", async () => {
    const built = buildShell();
    built.reads.delete("secret:apiKey:fireworks");
    const opts = buildOptions({ desktopShell: built.shell });
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-pill[data-value="plan"]')!.click();
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "сделай план улучшения UI Karo";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    const text = root.textContent ?? "";
    expect(text).toContain("Plan Mode could not complete");
    expect(text).toContain("API key");
    expect(root.querySelector('[data-testid="plan-failure-recovery"]')?.textContent).toContain("Open Models");
    expect(root.querySelector('[data-testid="plan-failure-recovery"]')?.textContent).toContain("No project context collected");
    expect(opts.chatModelClient.calls).toHaveLength(0);
    expect(opts.transport.createCalls).toHaveLength(0);
    expect(root.querySelector("[data-testid='changes-apply-button']")).toBeNull();
  });

  it("Plan Mode invalid JSON does not become a fake plan", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = { kind: "ok", text: "{not valid json" };
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-pill[data-value="plan"]')!.click();
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "сделай план рефакторинга";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    const text = root.textContent ?? "";
    expect(text).toContain("Plan Mode could not complete");
    expect(text).toContain("plan_parse_failed");
    expect(root.querySelector('[data-testid="plan-failure-recovery"]')).not.toBeNull();
    expect(text).not.toContain("Implementation steps");
    expect(opts.transport.createCalls).toHaveLength(0);
  });

  it("Auto routes planning prompts to Plan Mode without artifacts", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = {
      kind: "ok",
      text: JSON.stringify({
        goal: "Plan recovery work.",
        assumptions: ["No file changes yet."],
        relevantFileAreas: [],
        implementationSteps: ["Define states", "Add tests"],
        risks: ["Timeouts need honest recovery."],
        tests: ["unit tests"],
        estimatedComplexity: "medium",
        expectedModelCallsContextBudget: "One planning call.",
        suggestedExecutionMode: "Agent",
        acceptanceCriteria: ["Plan is reviewable."],
        whatNotToDoYet: ["Do not stage files."],
      }),
    };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "спланируй как лучше реализовать recovery";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.chatModelClient.calls).toHaveLength(1);
    expect(opts.transport.createCalls).toHaveLength(0);
    expect(root.querySelector('[data-testid="chat-message-plan"]')?.textContent).toContain("Plan Result");
    expect(root.querySelector("[data-testid='changes-apply-button']")).toBeNull();
  });

  it("New chat creates a new persisted conversation without deleting the previous messages", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = { kind: "ok", text: "hello back" };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "привет";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();
    expect(root.querySelector(".kw-chat-thread")?.textContent).toContain("привет");

    root.querySelector<HTMLButtonElement>(".kw-sidebar-new-chat")!.click();
    expect(root.querySelector(".kw-chat-thread")?.textContent).not.toContain("привет");
    const conversations = root.querySelectorAll(".kw-conversation-item");
    expect(conversations.length).toBeGreaterThanOrEqual(2);
  });

  it("switching conversations persists the selected chat across remount", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = { kind: "ok", text: "hello back" };
    const handle = mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "первый чат для persistence";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    root.querySelector<HTMLButtonElement>(".kw-sidebar-new-chat")!.click();
    const conversations = root.querySelectorAll<HTMLButtonElement>(".kw-conversation-item");
    expect(conversations.length).toBeGreaterThanOrEqual(2);
    conversations[1]!.click();
    expect(root.querySelector(".kw-chat-thread")?.textContent).toContain("первый чат для persistence");

    handle.unmount();
    mountWorkspaceShell(root, buildOptions());
    expect(root.querySelector(".kw-chat-thread")?.textContent).toContain("первый чат для persistence");
  });

  it("conversation items can be renamed and deleted without mixing chat history", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = { kind: "ok", text: "first response" };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "first chat prompt";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    root.querySelector<HTMLButtonElement>(".kw-sidebar-new-chat")!.click();
    const conversationItems = root.querySelectorAll<HTMLElement>(".kw-conversation-item");
    expect(conversationItems.length).toBeGreaterThanOrEqual(2);

    vi.spyOn(window, "prompt").mockReturnValue("Renamed chat");
    conversationItems[1]!.querySelector<HTMLButtonElement>(".kw-conversation-action")!.click();
    expect(root.querySelector(".kw-conversation-list")?.textContent).toContain("Renamed chat");

    vi.spyOn(window, "confirm").mockReturnValue(true);
    root.querySelectorAll<HTMLElement>(".kw-conversation-item")[1]!
      .querySelectorAll<HTMLButtonElement>(".kw-conversation-action")[1]!
      .click();
    expect(root.querySelector(".kw-conversation-list")?.textContent).not.toContain("Renamed chat");
    expect(root.querySelector(".kw-chat-thread")?.textContent).not.toContain("first chat prompt");
  });

  it("deleting the active chat switches to a valid conversation before the next send", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = { kind: "ok", text: "first response" };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "first active chat";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    root.querySelector<HTMLButtonElement>(".kw-sidebar-new-chat")!.click();
    const activeBeforeDelete = root.querySelector<HTMLElement>('.kw-conversation-item[aria-current="true"]');
    const deletedId = activeBeforeDelete?.dataset["conversationId"];
    expect(deletedId).toBeTruthy();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    activeBeforeDelete!
      .querySelectorAll<HTMLButtonElement>(".kw-conversation-action")[1]!
      .click();

    const activeAfterDelete = root.querySelector<HTMLElement>('.kw-conversation-item[aria-current="true"]');
    expect(activeAfterDelete?.dataset["conversationId"]).not.toBe(deletedId);

    opts.chatModelClient.nextResponse = { kind: "ok", text: "new response" };
    const nextPrompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    nextPrompt.value = "message after active delete";
    nextPrompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    const persisted = JSON.parse(localStorage.getItem("karo.conversations.v1") ?? "{}") as {
      activeConversationId?: string;
      conversations?: Array<{ id: string; messages?: Array<{ text?: string }> }>;
    };
    expect(persisted.activeConversationId).not.toBe(deletedId);
    expect(persisted.conversations?.some((conversation) => conversation.id === deletedId)).toBe(false);
    const active = persisted.conversations?.find((conversation) => conversation.id === persisted.activeConversationId);
    expect(active?.messages?.some((message) => message.text === "message after active delete")).toBe(true);
  });

  it("attachment queue shows chips and allows removal", () => {
    mountWorkspaceShell(root, buildOptions());
    const input = root.querySelector<HTMLInputElement>(".kw-attachment-input")!;
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    expect(root.querySelector(".kw-attachment-chip")?.textContent).toContain("note.txt");
    root.querySelector<HTMLButtonElement>(".kw-attachment-chip button")!.click();
    expect(root.querySelector(".kw-attachment-chip")).toBeNull();
  });

  it("long incomplete assistant message shows truncation continue affordance", () => {
    mountWorkspaceShell(root, buildOptions());
    (root as any)._karoState.chatMessages.push({
      id: "msg-long",
      role: "assistant",
      text: `${"Длинный ответ ".repeat(30)}**Иде`,
      kind: "chat",
      mode: "chat",
    });
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="chat"]')!.click();
    expect(root.querySelector(".kw-truncation-notice")?.textContent).toContain("Response may be truncated");
    root.querySelector<HTMLButtonElement>(".kw-continue-response")!.click();
    expect(root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.value).toContain("Продолжи");
  });

  it("Start task opens an API-usage confirmation modal before invoking the transport", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "Build hello world";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();

    const modal = root.querySelector(".kw-modal");
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain("Confirm task run");
    expect(modal?.textContent).toContain("Fireworks AI");
    expect(modal?.textContent).toContain("Cancel");
    // Transport not yet called ??? confirmation pending.
    expect(opts.transport.createCalls).toHaveLength(0);
  });

  it("Confirming the modal calls the transport and shows the running task in chat", async () => {
    const opts = buildOptions();
    opts.transport.createImpl = async (input) => {
      // Emit running state synchronously so the chat re-renders.
      opts.transport.emitTaskState({
        id: "task-x",
        status: "researching",
        currentAgentId: "researcher",
        reviewCycles: 0,
        maxReviewCycles: input.maxReviewCycles,
        createdAt: "2026-05-17T12:00:00.000Z",
        updatedAt: "2026-05-17T12:00:00.000Z",
        originalPrompt: input.prompt,
        modelId: input.metadata.modelId ?? "",
        provider: input.metadata.provider,
        participants: ["researcher", "coder", "reviewer", "fixer", "boss"],
      });
      return { taskId: "task-x" };
    };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "Build hello world";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
    await flush();
    await flush();

    expect(opts.transport.createCalls).toHaveLength(1);
    expect(opts.transport.createCalls[0]?.confirmedByUser).toBe(true);
    expect(opts.transport.createCalls[0]?.prompt).toBe("Build hello world");
    expect(opts.transport.createCalls[0]?.bossEnabled).toBe(true);

    // After start the chat shows the user prompt and a KARO message.
    expect(root.querySelector(".kw-chat-user")?.textContent).toContain("Build hello world");
    expect(root.querySelector(".kw-chat-assistant")).not.toBeNull();
    expect(root.querySelector(".kw-chat-status-pill")?.textContent).toBe("Selecting context");
  });

  it("Cancel on the confirmation modal does not call the transport", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "Build hello";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".kw-modal-cancel")!.click();
    await flush();
    expect(opts.transport.createCalls).toHaveLength(0);
    expect(root.querySelector(".kw-modal")).toBeNull();
  });

  it("casual Auto message answers in Chat Mode without starting pipeline", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = {
      kind: "ok",
      text: "Привет. Я реальный ответ LLM в Chat Mode.",
    };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "\u043f\u0440\u0438\u0432\u0435\u0442";
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.transport.createCalls).toHaveLength(0);
    expect(opts.chatModelClient.calls).toHaveLength(1);
    expect(opts.chatModelClient.calls[0]?.modelId).toBe(SAMPLE_METADATA.modelId);
    expect(root.querySelector('.kw-chat-local[data-mode="chat"]')?.textContent).toContain(
      "реальный ответ LLM",
    );
    expect(root.textContent).not.toContain("Отвечаю в Chat Mode");
    expect(root.querySelector(".kw-modal")).toBeNull();
  });

  it("question Auto message stays in Chat Mode without starting pipeline", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = {
      kind: "ok",
      text: "Могу отвечать на вопросы и объяснять режимы без запуска pipeline.",
    };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "\u0447\u0442\u043e \u0442\u044b \u0443\u043c\u0435\u0435\u0448\u044c?";
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.transport.createCalls).toHaveLength(0);
    expect(opts.chatModelClient.calls).toHaveLength(1);
    expect(root.querySelector('.kw-chat-local[data-mode="chat"]')?.textContent).toContain(
      "\u041c\u043e\u0433\u0443 \u043e\u0442\u0432\u0435\u0447\u0430\u0442\u044c",
    );
  });

  it("second chat message sends prior conversation history to the model", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = { kind: "ok", text: "first answer" };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "first question";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    opts.chatModelClient.nextResponse = { kind: "ok", text: "second answer" };
    const secondPrompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    secondPrompt.value = "second question";
    secondPrompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.chatModelClient.calls).toHaveLength(2);
    const secondCall = opts.chatModelClient.calls[1]!;
    const serialized = secondCall.messages.map((message) => `${message.role}:${message.content}`).join("\n");
    expect(serialized).toContain("first question");
    expect(serialized).toContain("first answer");
    expect(serialized).toContain("second question");
  });

  it("new chat does not leak previous conversation history into Chat Mode payload", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = { kind: "ok", text: "noted" };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "remember the word watermelon";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    root.querySelector<HTMLButtonElement>(".kw-sidebar-new-chat")!.click();
    await flush();
    opts.chatModelClient.nextResponse = { kind: "ok", text: "I only see this chat." };
    const secondPrompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    secondPrompt.value = "what was the previous message in this chat?";
    secondPrompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.chatModelClient.calls).toHaveLength(2);
    const serialized = opts.chatModelClient.calls[1]!.messages
      .map((message) => `${message.role}:${message.content}`)
      .join("\n");
    expect(serialized).toContain("what was the previous message");
    expect(serialized).not.toContain("watermelon");
  });

  it("Chat Mode file-change request is blocked without model call or artifacts", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('[data-testid="composer-mode-chat"]')!.click();
    await flush();
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "\u0441\u043e\u0437\u0434\u0430\u0439 \u0444\u0430\u0439\u043b src/chat-mode-should-not-write.txt \u0441 \u0442\u0435\u043a\u0441\u0442\u043e\u043c hello";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.transport.createCalls).toHaveLength(0);
    expect(opts.chatModelClient.calls).toHaveLength(0);
    const text = root.textContent ?? "";
    expect(text).toContain("Chat Mode is read-only");
    expect(text).toContain("Agent Mode");
    expect(root.querySelector(".kw-chat-final")).toBeNull();
    expect(root.querySelector("[data-testid='changes-apply-button']")).toBeNull();
  });

  it("collapses long exact user file requests in the chat transcript", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('[data-testid="composer-mode-chat"]')!.click();
    await flush();
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value =
      'create file src/karo-demo-site/index.html with text <!doctype html><html><body><main><section class="hero">Minecraft JJK Mod</section><section class="abilities">Abilities with cursed energy cards and Gojo infinity polish</section><section class="characters">Characters and energy</section><section class="features">Feature grid</section><section class="faq">FAQ</section></main></body></html>';
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    const compact = root.querySelector<HTMLElement>('[data-testid="compact-user-request"]');
    const summary = compact?.querySelector(".kw-user-request-summary")?.textContent ?? "";
    const fullRequest = compact?.querySelector<HTMLDetailsElement>('[data-testid="compact-user-full-request"]');

    expect(compact).not.toBeNull();
    expect(summary).toContain("Exact file request for src/karo-demo-site/index.html");
    expect(summary).not.toContain("<!doctype html>");
    expect(fullRequest?.hasAttribute("open")).toBe(false);
    expect(fullRequest?.textContent).toContain("<!doctype html>");
    expect(root.querySelector(".kw-chat-final")).toBeNull();
    expect(opts.transport.createCalls).toHaveLength(0);
    expect(opts.chatModelClient.calls).toHaveLength(0);
  });

  it("Chat Mode project question uses read-only Context Engine payload", async () => {
    const built = buildShell();
    built.reads.set("recentProject", {
      path: "D:\\projects\\karo",
      savedAt: "2026-05-17T12:00:00.000Z",
    });
    built.shell.shell_build_task_context = vi.fn(async () => ({
      projectRoot: "D:\\projects\\karo",
      prompt: "what handles Apply Changes?",
      fileTreeSummary: [],
      selectedFiles: [
        {
          relativePath: "apps/desktop-windows/src/shell/nativeBindings.ts",
          content: "export const shellApplyChanges = 'apply changes native binding';",
          sizeBytes: 64,
          score: 42,
          reason: ["apply changes target"],
          truncated: false,
        },
        {
          relativePath: "apps/desktop-windows/src/orchestration/desktopOrchestratorTransport.ts",
          content: "export class DesktopOrchestratorTransport {}",
          sizeBytes: 64,
          score: 40,
          reason: ["transport"],
          truncated: false,
        },
      ],
      ignoredSummary: {
        ignoredDirs: 0,
        ignoredFiles: 0,
        ignoredLargeFiles: 0,
        ignoredBinaryFiles: 0,
        ignoredSecretFiles: 0,
      },
      tokenBudgetHint: 50000,
      createdAt: "2026-05-17T12:00:00.000Z",
      warnings: [],
      scannedFilesCount: 12,
      selectedFilesCount: 2,
    }));
    const chat = new FakeChatModelClient();
    chat.nextResponse = { kind: "ok", text: "Apply Changes is handled by native bindings and transport." };
    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport: new FakeTransport(),
      chatModelClient: chat,
      onSignOut: vi.fn(),
    });
    await flush();
    (root as any)._karoState.project = {
      path: "D:\\projects\\karo",
      savedAt: "2026-05-17T12:00:00.000Z",
    };
    root.querySelector<HTMLButtonElement>('[data-testid="composer-mode-chat"]')!.click();
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "what handles Apply Changes?";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(built.shell.shell_build_task_context).toHaveBeenCalledWith(
      "D:\\projects\\karo",
      "what handles Apply Changes?",
      expect.objectContaining({ maxFiles: 8, includeContent: true }),
    );
    const serialized = chat.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(serialized).toContain("nativeBindings.ts");
    expect(serialized).toContain("desktopOrchestratorTransport.ts");
    expect(root.querySelector("[data-testid='chat-readonly-context']")?.textContent).toContain("2 files");
    expect(root.querySelector(".kw-chat-final")).toBeNull();
    expect(root.querySelector("[data-testid='changes-apply-button']")).toBeNull();
  });

  it("agent tasks include a short conversation summary without mixing chats", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = { kind: "ok", text: "first answer" };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "привет кто ты";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    const agentPrompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    agentPrompt.value = "создай файл src/test.txt с текстом hello";
    agentPrompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
    await flush();

    expect(opts.transport.createCalls).toHaveLength(1);
    expect(opts.transport.createCalls[0]?.conversationContext).toContain("Conversation context summary");
    expect(opts.transport.createCalls[0]?.conversationContext).toContain("привет кто ты");
    expect(opts.transport.createCalls[0]?.conversationContext).toContain("first answer");
  });

  it("custom system prompt is included in the next chat prompt payload", async () => {
    localStorage.setItem("karo.systemPrompt", "CUSTOM_PRODUCT_STYLE");
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = { kind: "ok", text: "ok" };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "hello";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.chatModelClient.calls[0]?.messages[0]?.content).toContain("CUSTOM_PRODUCT_STYLE");
  });

  it("ordinary chat answer strips unsolicited mode preamble", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = {
      kind: "ok",
      text: "Я в Auto Mode. Привет, можем спокойно поговорить.",
    };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "привет";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    const answer = root.querySelector('.kw-chat-local[data-mode="chat"]')?.textContent ?? "";
    expect(answer).toContain("Привет");
    expect(answer.trim()).not.toMatch(/^Я в Auto Mode/i);
  });

  it("Auto mode meta question routes to chat response and does not run pipeline", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = {
      kind: "ok",
      text: "Я Karo. Сейчас активен режим Auto Mode.",
    };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "какой сейчас режим и что ты можешь делать?";
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.transport.createCalls).toHaveLength(0);
    expect(opts.chatModelClient.calls).toHaveLength(1);
    expect(root.querySelector('.kw-chat-local[data-mode="chat"]')?.textContent).toContain(
      "Auto Mode",
    );
  });

  it("Agent mode meta question routes to chat response and does not run pipeline", async () => {
    const opts = buildOptions();
    opts.chatModelClient.nextResponse = {
      kind: "ok",
      text: "Я Karo. Сейчас активен режим Agent Mode.",
    };
    mountWorkspaceShell(root, opts);
    const modeSwitch = root.querySelector<HTMLButtonElement>('.kw-composer-mode-btn[data-mode="agent"]');
    if (modeSwitch) {
      modeSwitch.click();
      await flush();
    }
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "какой сейчас режим и что ты можешь делать?";
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.transport.createCalls).toHaveLength(0);
    expect(opts.chatModelClient.calls).toHaveLength(1);
    expect(root.querySelector('.kw-chat-local[data-mode="chat"]')?.textContent).toContain(
      "Agent Mode",
    );
  });

  it("Auto mode explicit coding task runs agent pipeline", async () => {
    const opts = buildOptions();
    opts.transport.createImpl = async (_input) => {
      return { taskId: "task-capabilities" };
    };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "создай файл capabilities.md с описанием возможностей";
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
    await flush();
    await flush();

    expect(opts.transport.createCalls).toHaveLength(1);
    expect(opts.transport.createCalls[0]?.prompt).toContain("capabilities.md");
  });

  it("URL page question in Auto stays in Chat Mode and includes fetched page context", async () => {
    const opts = buildOptions();
    (opts.shell.probeProvider as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: `<html><head><title>Kour.io - CrazyGames</title><meta property="og:description" content="A browser arena shooter game"></head><body><h1>Kour.io</h1><iframe src="https://games.crazygames.com/kour-io/index.html"></iframe></body></html>`,
    });
    opts.chatModelClient.nextResponse = {
      kind: "ok",
      text: "На странице Kour.io на CrazyGames.",
    };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value =
      "https://www.crazygames.com/game/kour-io?room=yizig1 что находится на этой странице";
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.transport.createCalls).toHaveLength(0);
    expect(opts.chatModelClient.calls).toHaveLength(1);
    expect(root.querySelector(".kw-modal")).toBeNull();
    const userMessage = opts.chatModelClient.calls[0]?.messages.at(-1)?.content ?? "";
    expect(userMessage).toContain(
      "Fetched URL: https://www.crazygames.com/game/kour-io?room=yizig1",
    );
    expect(userMessage).toContain("Title: Kour.io - CrazyGames");
    expect(userMessage).toContain(
      "Iframe sources: https://games.crazygames.com/kour-io/index.html",
    );
  });

  it("read-only project request uses fetched URL context without file changes", async () => {
    const opts = buildOptions();
    (opts.shell.probeProvider as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: `<html><head><title>Example Domain</title><meta name="description" content="Example page"></head><body><main>Example Domain content</main></body></html>`,
    });
    opts.chatModelClient.nextResponse = {
      kind: "ok",
      text: "example.com is the Example Domain page.",
    };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value =
      "\u043d\u0430\u0439\u0434\u0438 \u0438\u043d\u0444\u043e\u0440\u043c\u0430\u0446\u0438\u044e \u043d\u0430 \u0441\u0430\u0439\u0442\u0435 example.com";
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    expect(opts.transport.createCalls).toHaveLength(0);
    expect(opts.chatModelClient.calls).toHaveLength(1);
    const userMessage = opts.chatModelClient.calls[0]?.messages.at(-1)?.content ?? "";
    expect(userMessage).toContain("Fetched URL: https://example.com/");
    expect(userMessage).toContain("Title: Example Domain");
    const assist = root.querySelector('.kw-chat-local[data-mode="assist"]')?.textContent ?? "";
    expect(assist).toContain("Example Domain");
  });

  it("unclear Auto message asks for clarification", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "\u0441\u0434\u0435\u043b\u0430\u0439";
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();

    expect(opts.transport.createCalls).toHaveLength(1);
    expect(opts.transport.createCalls[0]?.prompt).toBe("\u0441\u0434\u0435\u043b\u0430\u0439");
    expect(opts.transport.createCalls[0]?.mode).toBe("auto");
  });

  it("Clarification Card custom Continue calls resumeTask and disables empty continue", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    (root as any)._karoState.activeTaskId = "clarify-task";
    opts.transport.emitTaskState({
      id: "clarify-task",
      status: "waiting_consent",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 3,
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
      originalPrompt: "Сделай лучше",
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["researcher", "coder", "reviewer", "boss"],
      clarificationState: {
        question: "Что именно улучшить?",
        options: [
          { id: "modify", label: "Внести изменения", value: "Помоги внести изменения в код" },
          { id: "cancel", label: "Отмена", value: "Отменить запрос" },
        ],
        customAnswer: "",
        resolved: false,
      },
    });

    const continueBtn = root.querySelector<HTMLButtonElement>(".kw-btn-continue")!;
    expect(continueBtn.disabled).toBe(true);
    expect(root.querySelector(".kw-clarify-option-btn")?.textContent).not.toContain("Отмена");
    expect(root.querySelector(".kw-pipeline-bar")).toBeNull();
    expect(root.textContent).not.toContain("Waiting for the first agent");
    const startBtn = root.querySelector<HTMLButtonElement>(".kw-composer-start")!;
    expect(startBtn.disabled).toBe(true);
    expect(root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.disabled).toBe(true);

    const textarea = root.querySelector<HTMLTextAreaElement>(".kw-clarify-textarea")!;
    textarea.value = "Сделай Usage tab понятнее";
    textarea.dispatchEvent(new Event("input"));
    expect(continueBtn.disabled).toBe(false);
    continueBtn.click();
    await flush();

    expect(opts.transport.resumeCalls).toHaveLength(1);
    expect(opts.transport.resumeCalls[0]).toEqual({
      taskId: "clarify-task",
      decision: {
        kind: "clarify",
        selectedOptionId: undefined,
        customAnswer: "Сделай Usage tab понятнее",
      },
    });
  });

  it("resolved read-only clarification renders a result card instead of an empty thread", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    (root as any)._karoState.activeTaskId = "clarify-readonly";
    opts.transport.emitTaskState({
      id: "clarify-readonly",
      status: "completed",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 3,
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:01.000Z",
      originalPrompt: "Improve it\nUser clarification: let's just discuss",
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["orchestrator"],
      isExplainOnly: true,
      decision: {
        intent: "casual_chat",
        executionMode: "chat",
        confidence: 0.86,
        needsClarification: false,
        clarificationOptions: [],
        allowWebSearch: false,
        allowFileChanges: false,
        allowCommands: false,
        requiresContextEngine: false,
        expectedOutput: "chat",
        riskLevel: "low",
        reasoningSummary: "Clarification resolved as casual chat.",
      },
      clarificationState: {
        question: "What should Karo improve?",
        options: [],
        customAnswer: "let's just discuss",
        resolved: true,
      },
    });
    opts.transport.emitFinalReport({
      taskId: "clarify-readonly",
      status: "completed",
      originalPrompt: "Improve it\nUser clarification: let's just discuss",
      bossSummary: "Ready to keep this as a read-only chat.",
      participants: ["orchestrator"],
      reviewCyclesPerformed: 0,
      finalArtifacts: [],
      createdAt: "2026-05-22T00:00:01.000Z",
    });

    const readonlyResult = root.querySelector<HTMLElement>('[data-testid="readonly-result"]');
    expect(readonlyResult).not.toBeNull();
    expect(readonlyResult?.textContent).toContain("Clarification resolved");
    expect(readonlyResult?.textContent).toContain("No coding pipeline ran");
    expect(readonlyResult?.textContent).toContain("none staged");
    expect(readonlyResult?.textContent).toContain("Ready to keep this as a read-only chat.");
    expect(root.querySelector(".kw-pipeline-bar")).toBeNull();
    expect(root.querySelector("[data-testid='changes-apply-button']")).toBeNull();
  });

  it("failed read-only clarification surfaces a safe-stop focus instead of an empty thread", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    (root as any)._karoState.activeTaskId = "clarify-failed";
    opts.transport.emitTaskState({
      id: "clarify-failed",
      status: "error",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 3,
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:01.000Z",
      originalPrompt: "Improve it\nUser clarification: let's just discuss",
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["orchestrator"],
      isExplainOnly: true,
      errorReason: "No encrypted API key was found for the active provider.",
      decision: {
        intent: "casual_chat",
        executionMode: "chat",
        confidence: 0.86,
        needsClarification: false,
        clarificationOptions: [],
        allowWebSearch: false,
        allowFileChanges: false,
        allowCommands: false,
        requiresContextEngine: false,
        expectedOutput: "chat",
        riskLevel: "low",
        reasoningSummary: "Clarification resolved as casual chat.",
      },
      clarificationState: {
        question: "What should Karo improve?",
        options: [],
        customAnswer: "let's just discuss",
        resolved: true,
      },
    });
    opts.transport.emitFinalReport({
      taskId: "clarify-failed",
      status: "error",
      originalPrompt: "Improve it\nUser clarification: let's just discuss",
      participants: ["orchestrator"],
      reviewCyclesPerformed: 0,
      finalArtifacts: [],
      outstandingIssues: ["No encrypted API key was found for the active provider."],
      createdAt: "2026-05-22T00:00:01.000Z",
    });

    const readonlyResult = root.querySelector<HTMLElement>('[data-testid="readonly-result"]');
    expect(readonlyResult).not.toBeNull();
    expect(readonlyResult?.textContent).toContain("Clarification failed");
    const focus = root.querySelector<HTMLElement>('[data-testid="failure-focus"]');
    expect(focus).not.toBeNull();
    expect(focus?.textContent).toContain("Read-only stop: no writes");
    expect(focus?.textContent).toContain("none staged");
    expect(focus?.textContent).toContain("Apply");
    expect(focus?.textContent).toContain("disabled");
    expect(root.querySelector(".kw-pipeline-bar")).toBeNull();
    expect(root.querySelector("[data-testid='changes-apply-button']")).toBeNull();
  });

  it("Command Safety shows destructive notification and dry-run suggestion", async () => {
    const opts = buildOptions();
    localStorage.setItem("karo.permissionMode", "smart_approval");
    mountWorkspaceShell(root, opts);
    (root as any)._karoState.activeTaskId = "command-task";
    opts.transport.emitTaskState({
      id: "command-task",
      status: "waiting_consent",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 3,
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
      originalPrompt: "git clean -fdx",
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["researcher", "coder", "reviewer", "boss"],
      consentRequest: {
        command: "git",
        args: ["clean", "-fdx"],
        cwd: "D:\\проекты\\karo-exstention",
        reason: "<img src=x onerror=alert(1)>",
      },
    });

    const cardText = root.querySelector(".kw-command-approval-card")?.textContent ?? "";
    expect(cardText).toContain("Command approval required");
    expect(cardText).toContain("DESTRUCTIVE");
    expect(cardText).toContain("Safety system: command not executed automatically.");
    expect(cardText).toContain("git clean -ndx");
    expect(cardText).toContain("<img src=x onerror=alert(1)>");
    expect(cardText).not.toContain("Always allow similar");
    expect(root.querySelector(".kw-command-meta img")).toBeNull();
  });

  it("bare git clean prompt is answered by safety policy without Auto Mode preamble", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "git clean -fdx";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    const assistantText = Array.from(root.querySelectorAll<HTMLElement>(".kw-chat-assistant"))
      .map((el) => el.textContent ?? "")
      .find((text) => text.includes("destructive")) ?? "";
    const safetyCard = Array.from(root.querySelectorAll<HTMLElement>(".kw-chat-assistant"))
      .find((el) => (el.textContent ?? "").includes("destructive"));
    expect(assistantText).toContain("destructive");
    expect(assistantText).toContain("git clean -ndx");
    expect(assistantText).not.toContain("Auto Mode");
    expect(safetyCard?.querySelector(".kw-chat-status-pill")?.textContent).toBe("Safety Check");
    expect(opts.transport.createCalls).toHaveLength(0);
  });

  it("explicit git clean execution request is still blocked by safety policy", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "execute git clean -fdx";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    await flush();

    const safetyCard = Array.from(root.querySelectorAll<HTMLElement>(".kw-chat-assistant"))
      .find((el) => (el.textContent ?? "").includes("destructive"));
    expect(safetyCard?.textContent).toContain("git clean -ndx");
    expect(safetyCard?.textContent).not.toContain("Auto Mode");
    expect(safetyCard?.querySelector(".kw-chat-status-pill")?.textContent).toBe("Safety Check");
    expect(opts.transport.createCalls).toHaveLength(0);
  });

  it("Save draft persists the current composer state", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    const save = root.querySelector<HTMLButtonElement>(".kw-composer-save")!;
    expect(save.textContent).toBe("Save task draft");
    expect(save.title).toContain("It will not run the task");
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "Save me";
    prompt.dispatchEvent(new Event("input"));
    save.click();
    await flush();
    await flush();
    const status = root.querySelector<HTMLElement>(".kw-composer-status");
    expect(status?.textContent?.toLowerCase()).toContain("draft saved");
  });

  it("renders a compact agent timeline grouped by agent", () => {
    const opts = buildOptions();
    opts.transport.emitTaskState({
      id: "task-2",
      status: "reviewing",
      currentAgentId: "reviewer",
      reviewCycles: 0,
      maxReviewCycles: 2,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:00.000Z",
      originalPrompt: "Do something",
      modelId: "x",
      provider: "fireworks",
      participants: ["researcher", "coder", "reviewer", "fixer", "boss"],
    });
    opts.transport.emitTraceEvent({
      taskId: "task-2",
      agentId: "researcher",
      sequence: 1,
      at: "2026-05-17T12:00:00.000Z",
      record: { kind: "status", status: "started" },
    });
    opts.transport.emitTraceEvent({
      taskId: "task-2",
      agentId: "researcher",
      sequence: 2,
      at: "2026-05-17T12:00:00.000Z",
      record: { kind: "thought", text: "Enriched prompt." },
    });
    opts.transport.emitTraceEvent({
      taskId: "task-2",
      agentId: "researcher",
      sequence: 3,
      at: "2026-05-17T12:00:00.000Z",
      record: { kind: "status", status: "finished" },
    });
    opts.transport.emitTraceEvent({
      taskId: "task-2",
      agentId: "coder",
      sequence: 4,
      at: "2026-05-17T12:00:00.000Z",
      record: { kind: "artifact_change", artifactId: "a", version: 1 },
    });
    opts.transport.emitArtifact(
      {
        id: "a",
        taskId: "task-2",
        fileName: "src/example.ts",
        latestVersion: 1,
        latestContentHash: "hash-a",
        authoredByAgentId: "coder",
        updatedAt: "2026-05-17T12:00:01.000Z",
      },
      "export const value = 1;",
    );

    // Mount AFTER seeding, then simulate the activeTaskId by clicking
    // Start; simpler: directly seed by calling Start through composer.
    const handle = mountWorkspaceShell(root, opts);
    void handle;
    // Activate the task by emitting a state listener trigger. The
    // workbench re-renders only when activeTaskId is set; since
    // there is no public setter, drive Start to register the id.
    opts.transport.createImpl = async () => ({ taskId: "task-2" });
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "build timeline";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    return flush()
      .then(() => {
        root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
        return flush();
      })
      .then(() => {
        const runSummary = root.querySelector<HTMLElement>('[data-testid="agent-run-summary"]');
        expect(runSummary).not.toBeNull();
        expect(runSummary?.textContent).toContain("Checking result");
        expect(runSummary?.textContent).toContain("Artifacts");
        expect(runSummary?.textContent).toContain("1 staged");
        expect(runSummary?.textContent).toContain("Next");
        const summaryActions = root.querySelector<HTMLElement>('[data-testid="agent-run-summary-actions"]');
        expect(summaryActions).not.toBeNull();
        expect(summaryActions?.textContent).toContain("Review Changes");
        expect(summaryActions?.textContent).toContain("Preview");
        const steps = root.querySelectorAll<HTMLElement>(".kw-agent-step");
        const ids = Array.from(steps).map((s) => s.dataset["agentId"]);
        expect(ids).toContain("researcher");
        expect(ids).toContain("coder");
        // researcher group surfaces the latest thought as summary
        const researcherStep = root.querySelector<HTMLElement>(
          '.kw-agent-step[data-agent-id="researcher"]',
        )!;
        expect(researcherStep.textContent).toContain("Enriched prompt.");
        expect(researcherStep.querySelector(".kw-agent-avatar")?.textContent).toBe("R");
        expect(researcherStep.textContent).toContain("Selecting the minimum project context needed.");
        expect(researcherStep.textContent).toContain("Finds minimal relevant project context");
        expect(researcherStep.textContent).toContain("Show activity details");
        expect(researcherStep.textContent).not.toContain("thought");
        expect(researcherStep.querySelector(".kw-agent-step-details")?.hasAttribute("open")).toBe(false);
        expect(researcherStep.dataset["status"]).toBe("finished");
        const coderStep = root.querySelector<HTMLElement>('.kw-agent-step[data-agent-id="coder"]')!;
        expect(coderStep.querySelector(".kw-agent-file-chip")?.textContent).toBe("src/example.ts");
        root.querySelector<HTMLButtonElement>('[data-testid="agent-summary-open-preview"]')!.click();
        expect(root.querySelector<HTMLElement>('[data-testid="right-tab-preview"]')?.getAttribute("aria-current")).toBe(
          "page",
        );
      });
  });

  it("shows skipped reviewer and file chips when deterministic validation passes", async () => {
    const opts = buildOptions();
    opts.transport.emitTaskState({
      id: "website-activity",
      status: "completed",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 2,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:05.000Z",
      originalPrompt: "создай landing page",
      modelId: "x",
      provider: "fireworks",
      participants: ["planner", "coder", "validator", "finalizer"],
      deterministicValidation: {
        status: "passed",
        skipModelReview: true,
        issues: [],
        checkedSignals: [
          "hero section",
          "FAQ section",
          "substantive section copy",
          "first-viewport hero visual",
          "responsive layout",
          "stable spacing system",
          "offline-safe local assets",
          "premium visual depth",
          "interactive polish",
          "balanced accent palette",
        ],
        reason: "Website acceptance signals passed.",
      },
    });
    for (const [sequence, agentId, status] of [
      [1, "planner", "finished"],
      [2, "coder", "finished"],
      [4, "validator", "finished"],
      [5, "finalizer", "finished"],
    ] as const) {
      opts.transport.emitTraceEvent({
        taskId: "website-activity",
        agentId,
        sequence,
        at: `2026-05-17T12:00:0${String(sequence)}.000Z`,
        record: { kind: "status", status },
      });
    }
    opts.transport.emitTraceEvent({
      taskId: "website-activity",
      agentId: "coder",
      sequence: 3,
      at: "2026-05-17T12:00:03.000Z",
      record: { kind: "artifact_change", artifactId: "site-css", version: 1 },
    });
    opts.transport.emitArtifact(
      {
        id: "site-css",
        taskId: "website-activity",
        fileName: "src/karo-demo-site/styles.css",
        latestVersion: 1,
        latestContentHash: "hash-css",
        authoredByAgentId: "coder",
        updatedAt: "2026-05-17T12:00:03.000Z",
      },
      ".hero { display: grid; }",
    );

    mountWorkspaceShell(root, opts);
    opts.transport.createImpl = async () => ({ taskId: "website-activity" });
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "создай landing page";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
    await flush();

    const ids = Array.from(root.querySelectorAll<HTMLElement>(".kw-agent-step"))
      .map((step) => step.dataset["agentId"]);
    expect(ids).toEqual(expect.arrayContaining(["planner", "coder", "validator", "reviewer", "finalizer"]));
    const runSummary = root.querySelector<HTMLElement>('[data-testid="agent-run-summary"]');
    expect(runSummary).not.toBeNull();
    expect(runSummary?.textContent).toContain("Ready for review");
    expect(runSummary?.textContent).toContain("Apply Changes");
    expect(runSummary?.textContent).toContain("passed / reviewer skipped");
    expect(runSummary?.textContent).toContain("5/5 steps");
    const reviewer = root.querySelector<HTMLElement>('.kw-agent-step[data-agent-id="reviewer"]')!;
    expect(reviewer.dataset["status"]).toBe("skipped");
    expect(reviewer.textContent).toContain("Пропущен");
    expect(reviewer.textContent).toContain("deterministic validation");
    const coder = root.querySelector<HTMLElement>('.kw-agent-step[data-agent-id="coder"]')!;
    expect(coder.querySelector(".kw-agent-file-chip")?.textContent).toBe("src/karo-demo-site/styles.css");
    const contract = root.querySelector<HTMLElement>(".kw-run-contract")?.textContent ?? "";
    expect(contract).toContain("Apply Changes required before disk write");
    expect(contract).toContain("passed / reviewer skipped");
    expect(contract).toContain("Validation evidence");
    expect(contract).toContain("Website acceptance signals passed.");
    expect(contract).toContain("Content");
    expect(contract).toContain("Sections + body copy");
    expect(contract).toContain("Hero visual");
    expect(contract).toContain("First viewport scene");
    expect(contract).toContain("Responsive");
    expect(contract).toContain("Mobile layout + spacing");
    expect(contract).toContain("Safety");
    expect(contract).toContain("Local assets only");
    expect(contract).toContain("Polish");
    expect(contract).toContain("Depth + hover/focus");
    expect(contract).toContain("Palette");
    expect(contract).toContain("Balanced accents");
    expect(root.querySelectorAll(".kw-agent-step-details[open]")).toHaveLength(0);
    expect(root.querySelector('[data-testid="chat-thread"]')?.textContent).not.toMatch(/\bthought\b/i);
  });

  it("shows recovery summary without marking a failed run completed", async () => {
    const opts = buildOptions();
    opts.transport.emitTaskState({
      id: "recovery-activity",
      status: "error",
      currentAgentId: "coder",
      reviewCycles: 0,
      maxReviewCycles: 2,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:01:00.000Z",
      originalPrompt: "создай сайт",
      modelId: "x",
      provider: "fireworks",
      participants: ["coder"],
      errorReason: "Coder timed out",
      recoveryState: {
        failedStage: "chunked_coder",
        failedAgent: "coder",
        failedFile: "src/karo-demo-site/script.js",
        provider: "fireworks",
        model: "x",
        elapsedMs: 60_000,
        timeoutMs: 60_000,
        selectedFiles: [],
        contextTokens: 800,
        partialArtifacts: [
          { artifactId: "site-html", version: 1, fileName: "src/karo-demo-site/index.html" },
          { artifactId: "site-css", version: 1, fileName: "src/karo-demo-site/styles.css" },
        ],
        retryCount: 0,
        lastSuccessfulStage: "chunked_coder",
        lastSuccessfulArtifact: { artifactId: "site-css", version: 1, fileName: "src/karo-demo-site/styles.css" },
        recommendedAction: "retry_failed_stage",
        fallbackUsed: false,
        canRetryFailedStage: true,
        canRetryReducedContext: true,
        canContinueFromPartial: true,
        canSwitchModel: false,
        recoveryReasonUser: "Coder timed out while generating script.js.",
        recoveryReasonInternal: "provider_timeout",
      },
    });

    mountWorkspaceShell(root, opts);
    opts.transport.createImpl = async () => ({ taskId: "recovery-activity" });
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "создай сайт";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
    await flush();

    const runSummary = root.querySelector<HTMLElement>('[data-testid="agent-run-summary"]');
    expect(runSummary).not.toBeNull();
    expect(runSummary?.textContent).toContain("Run stopped before success");
    expect(runSummary?.textContent).toContain("Partial staged artifacts stay reviewable");
    expect(runSummary?.textContent).toContain("Use recovery actions");
    const recovery = root.querySelector<HTMLElement>('[data-testid="agent-recovery-summary"]')!;
    expect(recovery.textContent).toContain("src/karo-demo-site/script.js");
    expect(recovery.textContent).toContain("src/karo-demo-site/index.html");
    expect(recovery.textContent).toContain("fallback");
    expect(recovery.textContent).toContain("Run state");
    expect(recovery.textContent).toContain("not completed");
    expect(recovery.textContent).toContain("Fallback");
    expect(recovery.textContent).toContain("not success");
    expect(recovery.textContent).toContain("Preserved");
    expect(recovery.textContent).not.toContain("Completed");
  });

  it("renders a Final Report card with Copy report and Open artifacts buttons", async () => {
    const opts = buildOptions();
    opts.transport.createImpl = async (input) => {
      opts.transport.emitTaskState({
        id: "t",
        status: "completed",
        currentAgentId: null,
        reviewCycles: 1,
        maxReviewCycles: 2,
        createdAt: "2026-05-17T12:00:00.000Z",
        updatedAt: "2026-05-17T12:00:00.000Z",
        originalPrompt: input.prompt,
        modelId: input.metadata.modelId ?? "",
        provider: input.metadata.provider,
        participants: ["researcher", "coder", "reviewer", "boss"],
      });
      opts.transport.emitFinalReport({
        taskId: "t",
        status: "completed",
        originalPrompt: input.prompt,
        bossSummary: "??????????????????????????",
        participants: ["researcher", "coder", "reviewer", "boss"],
        reviewCyclesPerformed: 1,
        finalArtifacts: [{ artifactId: "a1", version: 1, fileName: "hello.ts" }],
        createdAt: "2026-05-17T12:00:00.000Z",
      });
      return { taskId: "t" };
    };
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "Build hello world";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
    await flush();
    await flush();
    const finalCard = root.querySelector(".kw-chat-final");
    expect(finalCard).not.toBeNull();
    expect(finalCard?.textContent).toContain("Completed");
    expect(finalCard?.textContent).toContain("hello.ts");
    expect(root.querySelector(".kw-final-copy")).not.toBeNull();
    expect(
      Array.from(root.querySelectorAll<HTMLButtonElement>(".kw-button")).some(
        (b) => b.textContent === "Open artifacts",
      ),
    ).toBe(true);
  });

  it("renders Quick Edit result without dumping raw HTML in the main report", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    const taskId = "quick-edit-site";
    const prompt =
      'create file src/karo-demo-site/index.html with text <!doctype html><html><body><main><section class="hero">Minecraft JJK Mod</section><section class="abilities">Abilities</section><section class="characters">Characters and energy</section><section class="features">Features</section><section class="faq">FAQ</section></main></body></html>';
    const stateObj = (root as any)._karoState || (window as any)._karoState;
    stateObj.activeTaskId = taskId;
    opts.transport.emitTaskState({
      id: taskId,
      status: "completed",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 0,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:01.000Z",
      originalPrompt: prompt,
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["quick_edit"],
      decision: {
        intent: "modify_file",
        executionMode: "quick_edit",
        confidence: 0.99,
        needsClarification: false,
        clarificationOptions: [],
        allowWebSearch: false,
        allowFileChanges: true,
        allowCommands: false,
        requiresContextEngine: false,
        expectedOutput: "artifacts",
        riskLevel: "low",
        reasoningSummary: "Exact file edit.",
      } as any,
    });
    opts.transport.emitArtifact(
      {
        id: "site-index",
        taskId,
        fileName: "src/karo-demo-site/index.html",
        latestVersion: 1,
        latestContentHash: "hash",
        authoredByAgentId: "quick_edit",
        updatedAt: "2026-05-17T12:00:01.000Z",
      },
      "<main>FAQ</main>",
    );
    opts.transport.emitFinalReport({
      taskId,
      status: "completed",
      originalPrompt: prompt,
      bossSummary: "Quick edit prepared 1 file: src/karo-demo-site/index.html. Review it in Changes before applying.",
      participants: ["quick_edit"],
      reviewCyclesPerformed: 0,
      finalArtifacts: [{ artifactId: "site-index", version: 1, fileName: "src/karo-demo-site/index.html" }],
      createdAt: "2026-05-17T12:00:01.000Z",
    });
    await flush();

    const quickEdit = root.querySelector<HTMLElement>('[data-testid="quick-edit-result"]');
    expect(quickEdit).not.toBeNull();
    const listText = quickEdit?.querySelector(".kw-final-list")?.textContent ?? "";
    expect(listText).toContain("Request");
    expect(listText).toContain("Exact edit captured into 1 staged file");
    expect(listText).toContain("src/karo-demo-site/index.html");
    expect(listText).not.toContain("Original prompt");
    expect(listText).not.toContain("<!doctype html>");
    const rawRequest = quickEdit?.querySelector<HTMLDetailsElement>('[data-testid="quick-edit-original-request"]');
    expect(rawRequest).not.toBeNull();
    expect(rawRequest?.hasAttribute("open")).toBe(false);
    expect(rawRequest?.textContent).toContain("<!doctype html>");
  });

  it("renders security read-only result without boss verdict wording or duplicated open report", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    opts.transport.emitTaskState({
      id: "security-1",
      status: "completed",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 0,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:00.000Z",
      originalPrompt: "этот проект безопасный?",
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["researcher"],
      isExplainOnly: true,
      decision: {
        intent: "security_review",
        confidence: 0.9,
        requiresContextEngine: true,
        allowWebSearch: false,
        allowFileChanges: false,
        allowCommands: false,
        reason: "local security question",
      } as any,
      recoveryState: {
        failedStage: "Security review",
        failedAgent: "researcher",
        provider: SAMPLE_METADATA.provider,
        model: SAMPLE_METADATA.modelId!,
        elapsedMs: 60000,
        timeoutMs: 60000,
        selectedFiles: ["src/security.ts", "src/settings.ts"],
        contextTokens: 1200,
        partialArtifacts: [],
        retryCount: 0,
        recommendedAction: "retry_failed_stage",
        fallbackUsed: false,
        canRetryFailedStage: true,
        canRetryReducedContext: true,
        canContinueFromPartial: false,
        canSwitchModel: false,
        recoveryReasonUser: "Security review timed out. No artifacts were created.",
        recoveryReasonInternal: "provider_timeout",
      },
    });
    const stateObj = (root as any)._karoState || (window as any)._karoState;
    if (stateObj) {
      stateObj.activeTaskId = "security-1";
      stateObj.routeId = "chat";
    }
    opts.transport.emitFinalReport({
      taskId: "security-1",
      status: "completed",
      originalPrompt: "этот проект безопасный?",
      bossSummary: "Что проверено\n- provider config\n\nИтог: не гарантия.",
      participants: ["researcher"],
      reviewCyclesPerformed: 0,
      finalArtifacts: [],
      createdAt: "2026-05-17T12:00:00.000Z",
    });
    await flush();

    const finalCard = root.querySelector<HTMLElement>(".kw-chat-final");
    expect(finalCard).not.toBeNull();
    expect(finalCard?.textContent).toContain("Security Review Result");
    expect(finalCard?.textContent).toContain("Review completed");
    expect(finalCard?.textContent).not.toContain("соответствует");
    expect(finalCard?.textContent).not.toContain("Coder");
    expect(finalCard?.textContent).not.toContain("Fixer");
    expect(finalCard?.textContent).not.toContain("Boss");
    expect(finalCard?.querySelector("details.kw-final-details")?.hasAttribute("open")).toBe(false);
    expect(finalCard?.textContent).toContain("Show full security report");
  });

  it("renders security timeout as failed with recovery actions", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    opts.transport.emitTaskState({
      id: "security-timeout",
      status: "error",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 0,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:00.000Z",
      originalPrompt: "проверь безопасность проекта",
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["researcher"],
      isExplainOnly: true,
      contextSummary: {
        scannedFilesCount: 305,
        selectedFilesCount: 2,
        selectedFiles: [
          { relativePath: "src/security.ts", score: 1, reason: ["security"], truncated: false },
          { relativePath: "src/settings.ts", score: 1, reason: ["settings"], truncated: false },
        ],
        warnings: [],
      },
      decision: {
        intent: "security_review",
        confidence: 0.9,
        requiresContextEngine: true,
        allowWebSearch: false,
        allowFileChanges: false,
        allowCommands: false,
        reason: "local security question",
      } as any,
    });
    const stateObj = (root as any)._karoState || (window as any)._karoState;
    if (stateObj) {
      stateObj.activeTaskId = "security-timeout";
      stateObj.routeId = "chat";
    }
    opts.transport.emitFinalReport({
      taskId: "security-timeout",
      status: "error",
      originalPrompt: "проверь безопасность проекта",
      bossSummary: "Модель не успела ответить / provider_timeout. Контекст проекта был собран, но анализ не завершён.",
      participants: ["researcher"],
      reviewCyclesPerformed: 0,
      finalArtifacts: [],
      createdAt: "2026-05-17T12:00:00.000Z",
    });
    await flush();

    const finalCard = root.querySelector<HTMLElement>(".kw-chat-final");
    expect(finalCard).not.toBeNull();
    expect(finalCard?.textContent).toContain("Failed / needs retry");
    expect(finalCard?.textContent).not.toContain("Review completed");
    expect(finalCard?.textContent).not.toContain("Completed (");
    expect(finalCard?.textContent).not.toContain("Coder");
    expect(finalCard?.textContent).not.toContain("Fixer");
    expect(finalCard?.textContent).not.toContain("Boss");
    expect(root.querySelector('[data-testid="model-timeout-recovery"]')).not.toBeNull();
    expect(finalCard?.textContent).toContain("Retry same model");
    expect(finalCard?.textContent).toContain("Switch model");
    expect(finalCard?.textContent).toContain("Reduce context and retry");
    expect(finalCard?.textContent).toContain("Show selected files");
    expect(finalCard?.textContent).toContain("Copy context summary");
    expect(finalCard?.textContent).toContain("Read-only failure");
    expect(finalCard?.textContent).toContain("Write state");
    expect(finalCard?.textContent).toContain("no artifacts");
    expect(finalCard?.textContent).toContain("not completed");

    const buttons = Array.from(finalCard?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    expect(buttons.find((button) => button.textContent?.includes("Retry same model") === true)).not.toBeUndefined();
    expect(buttons.find((button) => button.textContent?.includes("Reduce context and retry") === true)).not.toBeUndefined();
  });

  it("wires Coder recovery actions to retry/continue decisions and disables fake model switch", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    opts.transport.emitTaskState({
      id: "website-recovery",
      status: "error",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 1,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:01:00.000Z",
      originalPrompt: "Create a landing page website",
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["researcher", "planner", "coder"],
      isExplainOnly: false,
      providerDiagnostics: [
        {
          id: "diag-1",
          agentId: "coder",
          stageName: "Coder",
          provider: SAMPLE_METADATA.provider,
          modelId: SAMPLE_METADATA.modelId!,
          inputTokenEstimate: 3200,
          selectedFilesCount: 0,
          contextTokens: 0,
          timeoutMs: 120000,
          elapsedMs: 120200,
          errorType: "provider_timeout",
          partialOutputReceived: false,
          artifactsCreated: true,
          createdAt: "2026-05-17T12:01:00.000Z",
        },
      ],
      recoveryState: {
        failedStage: "chunked_coder",
        failedAgent: "coder",
        failedFile: "src/karo-demo-site/script.js",
        provider: SAMPLE_METADATA.provider,
        model: SAMPLE_METADATA.modelId!,
        elapsedMs: 120200,
        timeoutMs: 120000,
        selectedFiles: [],
        contextTokens: 0,
        partialArtifacts: [
          { artifactId: "art-index", version: 1, fileName: "src/karo-demo-site/index.html" },
        ],
        retryCount: 0,
        lastSuccessfulStage: "chunked_coder",
        lastSuccessfulArtifact: { artifactId: "art-index", version: 1, fileName: "src/karo-demo-site/index.html" },
        recommendedAction: "continue_partial",
        fallbackUsed: false,
        canRetryFailedStage: true,
        canRetryReducedContext: true,
        canContinueFromPartial: true,
        canSwitchModel: false,
        recoveryReasonUser: "Coder timed out while generating script.js. One staged artifact was preserved.",
        recoveryReasonInternal: "provider_timeout",
      },
    });
    opts.transport.emitArtifact(
      {
        id: "art-index",
        taskId: "website-recovery",
        fileName: "src/karo-demo-site/index.html",
        latestVersion: 1,
        latestContentHash: "hash",
        authoredByAgentId: "coder",
        updatedAt: "2026-05-17T12:00:30.000Z",
      },
      "<main><section class=\"hero\">Hero</section></main>",
    );
    const stateObj = (root as any)._karoState || (window as any)._karoState;
    if (stateObj) {
      stateObj.activeTaskId = "website-recovery";
      stateObj.routeId = "chat";
    }
    opts.transport.emitFinalReport({
      taskId: "website-recovery",
      status: "error",
      originalPrompt: "Create a landing page website",
      participants: ["researcher", "planner", "coder"],
      reviewCyclesPerformed: 0,
      finalArtifacts: [
        {
          artifactId: "art-index",
          version: 1,
          fileName: "src/karo-demo-site/index.html",
        },
      ],
      outstandingIssues: [
        "Coder timed out while generating src/karo-demo-site/script.js. Retry Coder or continue from partial artifacts.",
      ],
      createdAt: "2026-05-17T12:01:00.000Z",
    });
    await flush();

    const recovery = root.querySelector<HTMLElement>('[data-testid="coder-timeout-recovery"]');
    expect(recovery).not.toBeNull();
    expect(recovery?.textContent).toContain("Coder recovery: src/karo-demo-site/script.js");
    expect(recovery?.textContent).toContain("Provider timeout");
    expect(recovery?.textContent).toContain("Preserved staged files");
    expect(recovery?.textContent).toContain("explicit only");
    expect(recovery?.textContent).toContain("continue partial");
    expect(recovery?.textContent).toContain("not completed");
    const buttons = Array.from(recovery?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    expect(buttons.find((button) => button.textContent === "Switch model")?.disabled).toBe(true);

    buttons.find((button) => button.textContent === "Retry failed stage")?.click();
    buttons.find((button) => button.textContent === "Retry with reduced context")?.click();
    buttons.find((button) => button.textContent === "Continue from partial artifacts")?.click();
    await flush();
    expect(opts.transport.resumeCalls).toEqual([
      { taskId: "website-recovery", decision: { kind: "retryFailedStage" } },
      { taskId: "website-recovery", decision: { kind: "retryReducedContext" } },
      { taskId: "website-recovery", decision: { kind: "continuePartial" } },
    ]);
  });

  it("keeps delayed security report attached before a later safety command", async () => {
    const opts = buildOptions();
    opts.transport.createImpl = async () => ({ taskId: "security-delayed" });
    mountWorkspaceShell(root, opts);

    const securityPrompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    securityPrompt.value = "проверь безопасность проекта и код";
    securityPrompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
    await flush();

    const safetyPrompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    safetyPrompt.value = "git clean -fdx";
    safetyPrompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();

    opts.transport.emitTaskState({
      id: "security-delayed",
      status: "error",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 0,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:05.000Z",
      originalPrompt: "проверь безопасность проекта и код",
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["researcher"],
      isExplainOnly: true,
      contextSummary: {
        scannedFilesCount: 10,
        selectedFilesCount: 1,
        selectedFiles: [{ relativePath: "src/security.ts", score: 1, reason: ["security"], truncated: false }],
        warnings: [],
      },
      decision: {
        intent: "security_review",
        confidence: 0.9,
        requiresContextEngine: true,
        allowWebSearch: false,
        allowFileChanges: false,
        allowCommands: false,
        reason: "security",
      } as any,
    });
    opts.transport.emitFinalReport({
      taskId: "security-delayed",
      status: "error",
      originalPrompt: "проверь безопасность проекта и код",
      bossSummary: "provider_timeout",
      participants: ["researcher"],
      reviewCyclesPerformed: 0,
      finalArtifacts: [],
      createdAt: "2026-05-17T12:00:05.000Z",
    });
    await flush();

    const messages = Array.from(root.querySelectorAll<HTMLElement>(".kw-chat-thread > .kw-chat-message"));
    const labels = messages.map((node) => node.textContent ?? "");
    const securityUserIndex = labels.findIndex((text) => text.includes("проверь безопасность проекта"));
    const securityReportIndex = labels.findIndex((text) => text.includes("Security Review Result"));
    const gitUserIndex = labels.findIndex((text) => text.includes("git clean -fdx") && text.includes("You"));
    const safetyIndex = labels.findIndex((text) => text.includes("Safety Check"));

    expect(securityUserIndex).toBeGreaterThanOrEqual(0);
    expect(securityReportIndex).toBeGreaterThan(securityUserIndex);
    expect(gitUserIndex).toBeGreaterThan(securityReportIndex);
    expect(safetyIndex).toBeGreaterThan(gitUserIndex);
  });
});

// ---------------------------------------------------------------------------
// Right panel
// ---------------------------------------------------------------------------

describe("workbench ??? right panel", () => {
  it("Changes empty state does not show misleading composer actions without an active run", () => {
    mountWorkspaceShell(root, buildOptions());
    root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="changes"]')!.click();
    const text = root.querySelector(".kw-right-content")?.textContent ?? "";
    expect(text).toContain("No changes yet");
    expect(text).toContain("Ask Agent to modify files");
    expect(text).not.toContain("Open Composer");
    expect(root.querySelector(".kw-empty-action")).toBeNull();
  });

  it("Changes tab shows artifacts after the transport emits one", async () => {
    const opts = buildOptions();
    opts.transport.createImpl = async () => ({ taskId: "t1" });
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "build artifact";
    prompt.dispatchEvent(new Event("input"));
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
    await flush();
    opts.transport.emitArtifact(
      {
        id: "art-1",
        taskId: "t1",
        fileName: "hello.ts",
        latestVersion: 1,
        latestContentHash: "abc",
        authoredByAgentId: "coder",
        updatedAt: "2026-05-17T12:00:00.000Z",
      },
      "console.log('hi');",
    );
    await flush();
    const right = root.querySelector(".kw-right-content")!;
    expect(right.textContent).toContain("hello.ts");
    expect(right.querySelector(".kw-changes-item")).not.toBeNull();
  });

  it("Changes tab marks completed artifacts ready and opens diff artifacts", async () => {
    const built = buildShell();
    Object.assign(built.shell, { isNativeBridgeWired: () => true });
    const opts = buildOptions({ desktopShell: built.shell });
    opts.transport.createImpl = async () => ({ taskId: "tdiff" });
    mountWorkspaceShell(root, opts);
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "покажи изменения перед применением";
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
    await flush();
    opts.transport.emitTaskState({
      id: "tdiff",
      status: "completed",
      currentAgentId: null,
      reviewCycles: 1,
      maxReviewCycles: 2,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:00.000Z",
      originalPrompt: "show changes",
      modelId: "x",
      provider: "fireworks",
      participants: ["researcher", "coder", "reviewer", "boss"],
    });
    opts.transport.emitFinalReport({
      taskId: "tdiff",
      status: "completed",
      originalPrompt: "show changes",
      participants: ["researcher", "coder", "reviewer", "boss"],
      reviewCyclesPerformed: 1,
      finalArtifacts: [{ artifactId: "diff-1", version: 1, fileName: "changes.diff" }],
      createdAt: "2026-05-17T12:00:00.000Z",
    });
    opts.transport.emitArtifact(
      {
        id: "diff-1",
        taskId: "tdiff",
        fileName: "changes.diff",
        latestVersion: 1,
        latestContentHash: "hash",
        authoredByAgentId: "coder",
        updatedAt: "2026-05-17T12:00:00.000Z",
      },
      "--- a/file\n+++ b/file\n+hello",
    );
    await flush();
    expect(root.querySelector(".kw-changes-status")?.textContent).toBe("ready");
    const applyGate = root.querySelector<HTMLElement>('[data-testid="changes-apply-gate"]')!;
    const applyButton = root.querySelector<HTMLButtonElement>('[data-testid="changes-apply-button"]')!;
    expect(applyGate.dataset["state"]).toBe("project-required");
    expect(applyGate.textContent).toContain("Review before disk write");
    expect(applyGate.textContent).toContain("Project required");
    expect(applyGate.textContent).toContain("Apply is blocked until a project is selected.");
    expect(applyButton.disabled).toBe(true);
    const diffBtn = root.querySelector<HTMLButtonElement>(".kw-changes-diff")!;
    expect(diffBtn.disabled).toBe(false);
    diffBtn.click();
    expect(root.querySelector(".kw-right-content")?.textContent).toContain("+hello");
  });

  it("Preview tab shows an honest empty state", () => {
    mountWorkspaceShell(root, buildOptions());
    root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="preview"]')!.click();
    const text = root.querySelector(".kw-right-content")?.textContent ?? "";
    expect(text).toContain("Preview");
    expect(text).toContain("Suggested command");
    expect(text).toContain("Preview status");
    expect(text).toContain("Run preview");
    expect(text).toContain("Copy command");
    expect(text).toContain("Terminal status");
    expect(text).toContain("No fake iframe preview");
    expect(text).toContain("Embedded preview is unavailable");
    expect(text).toContain("Preview preflight");
    expect(text).toContain("No index.html staged");
    expect(text).toContain("No preview target yet");
    expect(root.querySelector<HTMLButtonElement>(".kw-preview-panel .kw-button-primary")?.disabled).toBe(true);
  });

  it("Preview explains the project-root gate when terminal backend is connected", async () => {
    const built = buildShell();
    Object.assign(built.shell, {
      shell_start_command: vi.fn(),
      shell_stop_command: vi.fn(),
      shell_get_command_output: vi.fn(),
      shell_clear_command_output: vi.fn(),
    });
    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport: new FakeTransport(),
      chatModelClient: new FakeChatModelClient(),
      onSignOut: vi.fn(),
    });
    await flush();

    root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="preview"]')!.click();
    const text = root.querySelector(".kw-right-content")?.textContent ?? "";
    expect(text).toContain("Preview status: dev-command-gated");
    expect(text).toContain("Project root required");
    expect(text).not.toContain("Outside safe command allowlist");
    expect(root.querySelector<HTMLButtonElement>('[data-testid="preview-run-button"]')?.disabled).toBe(true);
  });

  it("Preview detects dev scripts from package.json without running them", async () => {
    const built = buildShell();
    built.reads.set("recentProject", {
      path: "D:\\РїСЂРѕРµРєС‚С‹\\vite-site",
      savedAt: "2026-05-17T12:00:00.000Z",
    });
    built.shell.readProjectSummary = vi.fn(async (path: string) => ({
      rootPath: path,
      files: [{ path: "package.json", kind: "file" as const }],
      snippets: [{ path: "package.json", content: '{"scripts":{"dev":"vite","preview":"vite preview"}}', truncated: false }],
      omitted: [],
    }));
    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport: new FakeTransport(),
      chatModelClient: new FakeChatModelClient(),
      onSignOut: vi.fn(),
    });
    await flush();
    root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="preview"]')!.click();
    expect(root.querySelector<HTMLInputElement>(".kw-preview-command input")?.value).toBe("pnpm dev");
    expect(root.querySelector(".kw-preview-meta")?.textContent).toContain("package.json");
  });

  it("Preview tab explains the open-file flow for staged static website artifacts", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    (root as any)._karoState.activeTaskId = "site-task";
    opts.transport.emitTaskState({
      id: "site-task",
      status: "completed",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 2,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:01.000Z",
      originalPrompt: "Создай landing page",
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["researcher", "coder"],
      decision: {
        intent: "modify_file",
        executionMode: "agent",
        confidence: 0.9,
        needsClarification: false,
        clarificationOptions: [],
        allowWebSearch: false,
        allowFileChanges: true,
        allowCommands: false,
        requiresContextEngine: true,
        expectedOutput: "artifacts",
        riskLevel: "medium",
        reasoningSummary: "Website artifacts staged.",
      },
    });
    opts.transport.emitArtifact(
      {
        id: "site-index",
        taskId: "site-task",
        fileName: "src/karo-demo-site/index.html",
        latestVersion: 1,
        latestContentHash: "hash",
        authoredByAgentId: "coder",
        updatedAt: "2026-05-17T12:00:01.000Z",
      },
      "<main class=\"hero\">FAQ</main>",
    );
    await flush();
    root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="preview"]')!.click();
    const text = root.querySelector(".kw-right-content")?.textContent ?? "";
    expect(text).toContain("Static preview");
    expect(text).toContain("Preview status: staged-only/apply-required");
    expect(text).toContain("Preview gate evidence");
    expect(text).toContain("Preview preflight");
    expect(text).toContain("no deterministic website quality validation was recorded");
    expect(text).toContain("No website quality record");
    expect(text).toContain("Upgrade with Agent");
    expect(text).toContain("Nothing runs automatically");
    expect(text).toContain("Apply Changes required first");
    expect(text).toContain("Apply changes before preview");
    expect(text).toContain("src/karo-demo-site/index.html");
    expect(text).toContain("Review staged changes");
    expect(text).toContain("Choose project");
    expect(root.querySelector<HTMLButtonElement>('[data-testid="preview-copy-static-path"]')?.disabled).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('[data-testid="preview-open-static"]')?.disabled).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-testid="validation-upgrade-agent"]')!.click();
    const agentPrompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.value ?? "";
    expect(root.querySelector<HTMLElement>('.kw-pill[data-value="agent"]')?.getAttribute("aria-current")).toBe("true");
    expect(agentPrompt).toContain("Rebuild the staged static site as a validated Agent Mode website");
    expect(agentPrompt).toContain("Stage artifacts only");
    expect(agentPrompt).toContain("deterministic website quality evidence");
    expect(root.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')?.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-testid="preview-review-staged-changes"]')!.click();
    expect(root.querySelector<HTMLElement>('[data-testid="right-tab-changes"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
    expect(root.querySelector(".kw-right-content")?.textContent).toContain("Review before disk write");
  });

  it("Preview opens an applied static index.html through the desktop shell", async () => {
    const built = buildShell();
    Object.assign(built.shell, { isNativeBridgeWired: () => true });
    built.reads.set("recentProject", {
      path: "D:\\РїСЂРѕРµРєС‚С‹\\karo-site",
      savedAt: "2026-05-17T12:00:00.000Z",
    });
    const openPreview = vi.fn(async () => ({
      path: "D:\\РїСЂРѕРµРєС‚С‹\\karo-site\\src\\karo-demo-site\\index.html",
      opened: true,
    }));
    Object.assign(built.shell, {
      shell_open_preview_file: openPreview,
    });
    const transport = new FakeTransport();
    transport.applyStagedChanges = vi.fn(async () => ({
      success: true,
      changedFiles: [],
      createdFiles: ["src/karo-demo-site/index.html"],
      overwrittenFiles: [],
      skippedFiles: [],
      errors: [],
    }));
    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport,
      chatModelClient: new FakeChatModelClient(),
      onSignOut: vi.fn(),
    });
    await flush();
    (root as any)._karoState.activeTaskId = "site-task";
    transport.emitTaskState({
      id: "site-task",
      status: "completed",
      currentAgentId: null,
      reviewCycles: 0,
      maxReviewCycles: 2,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:01.000Z",
      originalPrompt: "Создай landing page",
      modelId: SAMPLE_METADATA.modelId!,
      provider: SAMPLE_METADATA.provider,
      participants: ["researcher", "coder"],
      deterministicValidation: {
        status: "passed",
        skipModelReview: true,
        issues: [],
        checkedSignals: [
          "document metadata",
          "stylesheet/script wiring",
          "visible CTA",
          "hero section",
          "FAQ section",
          "substantive section copy",
          "first-viewport hero visual",
          "responsive layout",
          "stable spacing system",
          "offline-safe local assets",
          "premium visual depth",
          "interactive polish",
          "balanced accent palette",
        ],
        reason: "Website acceptance signals passed.",
      },
      decision: {
        intent: "modify_file",
        executionMode: "agent",
        confidence: 0.9,
        needsClarification: false,
        clarificationOptions: [],
        allowWebSearch: false,
        allowFileChanges: true,
        allowCommands: false,
        requiresContextEngine: true,
        expectedOutput: "artifacts",
        riskLevel: "medium",
        reasoningSummary: "Website artifacts staged.",
      },
    });
    transport.emitArtifact(
      {
        id: "site-index",
        taskId: "site-task",
        fileName: "src/karo-demo-site/index.html",
        latestVersion: 1,
        latestContentHash: "hash",
        authoredByAgentId: "coder",
        updatedAt: "2026-05-17T12:00:01.000Z",
      },
      "<main class=\"hero\">FAQ</main>",
    );
    await flush();

    root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="changes"]')!.click();
    const applyGate = root.querySelector<HTMLElement>('[data-testid="changes-apply-gate"]')!;
    const applyButton = root.querySelector<HTMLButtonElement>('[data-testid="changes-apply-button"]')!;
    expect(applyGate.dataset["state"]).toBe("ready");
    expect(applyGate.textContent).toContain("Review before disk write");
    expect(applyGate.textContent).toContain("selected project");
    expect(applyButton.disabled).toBe(false);
    applyButton.click();
    await flush();
    expect(applyGate.dataset["state"]).toBe("success");
    expect(applyGate.textContent).toContain("Changes Applied Successfully");
    expect(applyGate.textContent).toContain("Created");
    expect(applyGate.textContent).toContain("src/karo-demo-site/index.html");
    root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="preview"]')!.click();

    const open = root.querySelector<HTMLButtonElement>('[data-testid="preview-open-static"]')!;
    expect(open.disabled).toBe(false);
    const previewText = root.querySelector(".kw-right-content")?.textContent ?? "";
    expect(previewText).toContain("Preview status: static-file-ready");
    expect(previewText).toContain("Preview gate evidence");
    expect(previewText).toContain("Preview preflight");
    expect(previewText).toContain("Website acceptance signals passed.");
    expect(previewText).toContain("Website quality checks passed");
    expect(previewText).toContain("Apply completed for this file");
    expect(previewText).toContain("document metadata");
    expect(previewText).toContain("Sections + body copy");
    expect(previewText).toContain("First viewport scene");
    expect(previewText).toContain("Local assets only");
    expect(previewText).toContain("Depth + hover/focus");
    expect(previewText).toContain("Balanced accents");
    open.click();
    await flush();

    expect(openPreview).toHaveBeenCalledWith("D:\\РїСЂРѕРµРєС‚С‹\\karo-site", "src/karo-demo-site/index.html");
    expect(root.querySelector(".kw-right-content")?.textContent).toContain("Opened in browser/default app");
  });

  it("Terminal lives in the bottom tools panel until backend command execution is wired", () => {
    mountWorkspaceShell(root, buildOptions());
    expect(root.querySelector('.kw-right-tab[data-tab-id="terminal"]')).toBeNull();
    const bottomTools = root.querySelector<HTMLElement>(".kw-bottom-tools")!;
    expect(bottomTools).not.toBeNull();
    expect(bottomTools.dataset["open"]).toBe("false");
    root.querySelector<HTMLButtonElement>(".kw-bottom-tools-toggle")!.click();
    const text = bottomTools.textContent ?? "";
    expect(text).toContain("Terminal");
    expect(text).toMatch(/command execution is disabled/i);
    expect(text).toContain("No command execution");
    expect(text).toContain("No project selected");
    expect(text).toContain("Project required");
    expect(text).not.toContain("Run command");
  });

  it("Preview runs through the connected terminal backend and streams terminal output", async () => {
    const built = buildShell();
    built.reads.set("recentProject", {
      path: "D:\\проекты\\karo-exstention",
      savedAt: "2026-05-17T12:00:00.000Z",
    });
    const terminalLines = [
      { stream: "stdout" as const, text: "Local: http://127.0.0.1:5173/", at: "2026-05-17T12:00:01.000Z" },
      { stream: "stdout" as const, text: "preview ready", at: "2026-05-17T12:00:02.000Z" },
    ];
    const start = vi.fn(async () => ({ sessionId: "term-1", status: "running" as const, allowed: true, profileId: "powershell" }));
    const stop = vi.fn(async () => ({
      sessionId: "term-1",
      status: "exited" as const,
      exitCode: 0,
      lines: terminalLines,
    }));
    Object.assign(built.shell, {
      shell_start_command: start,
      shell_stop_command: stop,
      shell_get_command_output: vi.fn(async () => ({
        sessionId: "term-1",
        status: "running" as const,
        exitCode: null,
        lines: terminalLines,
      })),
      shell_clear_command_output: vi.fn(async () => undefined),
      shell_get_terminal_profiles: vi.fn(async () => [
        { id: "powershell", label: "PowerShell", shell: "powershell.exe", available: true },
        { id: "cmd", label: "CMD", shell: "cmd.exe", available: true },
        { id: "git_bash", label: "Git Bash", shell: "C:\\Program Files\\Git\\bin\\bash.exe", available: false },
      ]),
    });

    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport: new FakeTransport(),
      chatModelClient: new FakeChatModelClient(),
      onSignOut: vi.fn(),
    });
    await flush();

    root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="preview"]')!.click();
    const run = root.querySelector<HTMLButtonElement>('[data-testid="preview-run-button"]')!;
    expect(run.disabled).toBe(false);
    run.click();
    await flush();

    expect(start).toHaveBeenCalledWith("D:\\проекты\\karo-exstention", "pnpm desktop:dev:renderer", "preview", "powershell");
    expect(root.querySelector<HTMLElement>(".kw-bottom-tools")?.dataset["open"]).toBe("true");
    expect(root.querySelector(".kw-bottom-tools")?.textContent).toContain("running");
    expect(root.querySelector(".kw-bottom-tools")?.textContent).toContain("Safe command runner");
    expect(root.querySelector(".kw-bottom-tools")?.textContent).toContain("Smart Approval");
    expect(root.querySelector('[data-testid="terminal-profile"]')?.textContent).toContain("PowerShell");
    const gitBashOption = root.querySelector<HTMLOptionElement>('[data-testid="terminal-profile"] option[value="git_bash"]');
    expect(gitBashOption?.disabled).toBe(true);
    expect(gitBashOption?.textContent).toContain("unavailable");
    expect(root.querySelector(".kw-preview-url")?.textContent).toContain("http://127.0.0.1:5173/");

    const stopPreview = Array.from(root.querySelectorAll<HTMLButtonElement>(".kw-preview-actions button")).find(
      (button) => button.textContent === "Stop preview",
    )!;
    expect(stopPreview.disabled).toBe(false);
    stopPreview.click();
    await flush();

    expect(stop).toHaveBeenCalledWith("term-1");
    expect(root.querySelector('[data-testid="terminal-output"]')?.textContent).toContain("preview ready");
    expect(root.querySelector('[data-testid="terminal-output"]')?.textContent).toContain("Exit code: 0");
    expect(root.querySelector(".kw-bottom-tools-status")?.textContent).toContain("success");
  });

  it("Preview disables custom dev commands outside the safe command allowlist", async () => {
    const built = buildShell();
    built.reads.set("recentProject", {
      path: "D:\\проекты\\karo-exstention",
      savedAt: "2026-05-17T12:00:00.000Z",
    });
    const start = vi.fn(async () => ({ sessionId: "term-1", status: "running" as const, allowed: true, profileId: "powershell" }));
    Object.assign(built.shell, {
      shell_start_command: start,
      shell_stop_command: vi.fn(),
      shell_get_command_output: vi.fn(),
      shell_clear_command_output: vi.fn(),
      shell_get_terminal_profiles: vi.fn(async () => [
        { id: "powershell", label: "PowerShell", shell: "powershell.exe", available: true },
      ]),
    });
    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport: new FakeTransport(),
      chatModelClient: new FakeChatModelClient(),
      onSignOut: vi.fn(),
    });
    await flush();

    root.querySelector<HTMLButtonElement>('.kw-right-tab[data-tab-id="preview"]')!.click();
    const input = root.querySelector<HTMLInputElement>(".kw-preview-command input")!;
    input.value = "pnpm build";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(root.querySelector('[data-testid="preview-status"]')?.textContent).toContain("Preview status: dev-command-gated");
    expect(root.querySelector('[data-testid="preview-preflight"]')?.textContent).toContain("Outside safe command allowlist");
    const run = root.querySelector<HTMLButtonElement>('[data-testid="preview-run-button"]')!;
    expect(run.disabled).toBe(true);
    run.click();
    await flush();

    expect(start).not.toHaveBeenCalled();
  });

  it("Terminal blocks destructive commands before they reach the backend", async () => {
    const built = buildShell();
    built.reads.set("recentProject", {
      path: "D:\\проекты\\karo-exstention",
      savedAt: "2026-05-17T12:00:00.000Z",
    });
    const start = vi.fn(async () => ({ sessionId: "term-1", status: "running" as const, allowed: true, profileId: "powershell" }));
    Object.assign(built.shell, {
      shell_start_command: start,
      shell_stop_command: vi.fn(),
      shell_get_command_output: vi.fn(),
      shell_clear_command_output: vi.fn(),
      shell_get_terminal_profiles: vi.fn(async () => [
        { id: "powershell", label: "PowerShell", shell: "powershell.exe", available: true },
      ]),
    });
    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport: new FakeTransport(),
      chatModelClient: new FakeChatModelClient(),
      onSignOut: vi.fn(),
    });
    await flush();

    root.querySelector<HTMLButtonElement>(".kw-bottom-tools-head")!.click();
    const command = root.querySelector<HTMLInputElement>(".kw-terminal-command")!;
    command.value = "git clean -fdx";
    command.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector(".kw-terminal-safety-cockpit")?.textContent).toContain("destructive");
    expect(root.querySelector(".kw-terminal-safety-cockpit")?.textContent).toContain("Blocked before backend");
    expect(root.querySelector(".kw-terminal-safety-cockpit")?.textContent).toContain("Hard blocked");
    const run = root.querySelector<HTMLButtonElement>(".kw-terminal-actions .kw-button-primary")!;
    expect(run.disabled).toBe(true);
    run.click();
    await flush();

    expect(start).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="terminal-output"]')?.textContent).toContain("No terminal output yet");
  });

  it("Terminal disables commands outside the safe command allowlist before backend execution", async () => {
    const built = buildShell();
    built.reads.set("recentProject", {
      path: "D:\\проекты\\karo-exstention",
      savedAt: "2026-05-17T12:00:00.000Z",
    });
    const start = vi.fn(async () => ({ sessionId: "term-1", status: "running" as const, allowed: true, profileId: "powershell" }));
    Object.assign(built.shell, {
      shell_start_command: start,
      shell_stop_command: vi.fn(),
      shell_get_command_output: vi.fn(),
      shell_clear_command_output: vi.fn(),
      shell_get_terminal_profiles: vi.fn(async () => [
        { id: "powershell", label: "PowerShell", shell: "powershell.exe", available: true },
      ]),
    });
    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport: new FakeTransport(),
      chatModelClient: new FakeChatModelClient(),
      onSignOut: vi.fn(),
    });
    await flush();

    root.querySelector<HTMLButtonElement>(".kw-bottom-tools-head")!.click();
    const command = root.querySelector<HTMLInputElement>(".kw-terminal-command")!;
    command.value = "pnpm build";
    command.dispatchEvent(new Event("input", { bubbles: true }));

    const cockpitText = root.querySelector(".kw-terminal-safety-cockpit")?.textContent ?? "";
    expect(cockpitText).toContain("Allowlist");
    expect(cockpitText).toContain("Not allowed");
    expect(cockpitText).toContain("Use Preview/test/status commands");
    const run = root.querySelector<HTMLButtonElement>(".kw-terminal-actions .kw-button-primary")!;
    expect(run.disabled).toBe(true);
    run.click();
    await flush();

    expect(start).not.toHaveBeenCalled();
  });

  it("Diff tab is hidden until an artifact or selected diff exists", () => {
    mountWorkspaceShell(root, buildOptions());
    expect(root.querySelector('.kw-right-tab[data-tab-id="diff"]')).toBeNull();
  });

  it("Files tab is hidden until a project is selected", () => {
    mountWorkspaceShell(root, buildOptions());
    expect(root.querySelector('.kw-right-tab[data-tab-id="files"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Models pane
// ---------------------------------------------------------------------------

describe("workbench ??? Models", () => {
  it("Refresh fetches models, lists them, and saves selection to metadata", async () => {
    const built = buildShell();
    built.setProbeBody(
      JSON.stringify({
        data: [
          { id: "accounts/fireworks/models/qwen3-coder" },
          { id: "accounts/fireworks/models/deepseek-v4-pro", display_name: "DeepSeek V4 Pro" },
        ],
      }),
    );
    built.reads.set("secret:apiKey:fireworks", {
      algorithm: "aes-256-gcm",
      ciphertext: "AA==",
      createdAt: "2026-05-17T12:00:00.000Z",
    });
    const transport = new FakeTransport();
    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport,
      onSignOut: vi.fn(),
    });
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="models"]')!.click();
    expect(root.querySelector(".kw-models-list")).not.toBeNull();
    root.querySelector<HTMLButtonElement>(".kw-models-refresh")!.click();
    // Real setTimeout is needed for the async crypto/text decoding path.
    await new Promise((r) => setTimeout(r, 30));

    const items = root.querySelectorAll<HTMLElement>(".kw-models-item");
    const ids = Array.from(items).map((li) => li.dataset["modelId"]);
    expect(ids).toEqual(expect.arrayContaining([
      "accounts/fireworks/models/deepseek-v4-pro",
      "accounts/fireworks/models/qwen3-coder",
    ]));
    expect(ids).toContain("accounts/fireworks/models/flux-kontext-pro");

    const targetButton = root.querySelector<HTMLButtonElement>(
      '.kw-models-item[data-model-id="accounts/fireworks/models/qwen3-coder"] .kw-models-button',
    )!;
    targetButton.click();
    await new Promise((r) => setTimeout(r, 10));

    const writtenMeta = built.writes.find((w) => w.key === "apiKeyMeta:fireworks");
    expect(writtenMeta).toBeDefined();
    expect((writtenMeta!.value as { modelId: string }).modelId).toBe("accounts/fireworks/models/qwen3-coder");
  });

  it("Manual fallback saves an arbitrary model id", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="models"]')!.click();
    const manual = root.querySelector<HTMLInputElement>(".kw-models-manual-input")!;
    manual.value = "my/custom/model";
    root.querySelector<HTMLButtonElement>(".kw-models-manual-save")!.click();
    await flush();
    await flush();
    const writes = (
      opts.shell.writeLocalSetting as unknown as {
        mock: { calls: Array<[string, unknown]> };
      }
    ).mock.calls;
    const last = writes[writes.length - 1];
    expect(last?.[0]).toBe("apiKeyMeta:fireworks");
    expect((last?.[1] as { modelId: string }).modelId).toBe("my/custom/model");
  });

  it("does not render plaintext API key anywhere on the Models pane", () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="models"]')!.click();
    const text = root.textContent ?? "";
    expect(text).not.toContain("fw-test-key");
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  });

  it("shows active model badge and details", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="models"]')!.click();
    await flush();

    const modelBadge = root.querySelector(".kw-model-badge");
    expect(modelBadge).not.toBeNull();
    expect(modelBadge!.textContent).toBe("Llama V3.1 8B Instruct");
    expect((modelBadge as HTMLElement).title).toBe(SAMPLE_METADATA.modelId);
  });

  it("composer model chip opens a selector popover instead of switching tabs", () => {
    mountWorkspaceShell(root, buildOptions());
    expect(root.querySelector<HTMLElement>(".kw-center")?.dataset["routeId"]).toBe("chat");
    root.querySelector<HTMLButtonElement>(".kw-model-chip")!.click();
    expect(root.querySelector(".kw-model-popover")).not.toBeNull();
    expect(root.querySelector<HTMLElement>(".kw-center")?.dataset["routeId"]).toBe("chat");
    root.querySelector<HTMLButtonElement>(".kw-model-popover-manage")!.click();
    expect(root.querySelector<HTMLElement>(".kw-center")?.dataset["routeId"]).toBe("models");
  });

  it("Fireworks model list shows estimated capabilities instead of unknown-only badges", () => {
    mountWorkspaceShell(root, buildOptions());
    (root as any)._karoState.cachedModels = [
      { modelId: "accounts/fireworks/models/deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
      { modelId: "accounts/fireworks/models/flux-kontext-pro", displayName: "Flux Kontext Pro" },
    ];
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="models"]')!.click();
    const text = root.querySelector(".kw-models-list")?.textContent ?? "";
    expect(text).toContain("Text");
    expect(text).toContain("Code");
    expect(text).toContain("Image generation");
    expect(text).toContain("Known Fireworks");
    const flux = root.querySelector<HTMLButtonElement>(
      '.kw-models-item[data-model-id="accounts/fireworks/models/flux-kontext-pro"] .kw-models-button',
    );
    expect(flux?.disabled).toBe(true);
    expect(flux?.textContent).toContain("Image model");
  });

  it("missing API key displays a missing status", async () => {
    const built = buildShell();
    built.shell.decryptLocalSecret = vi.fn().mockRejectedValue(new Error("No key found"));
    const opts = buildOptions({ desktopShell: built.shell });
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="models"]')!.click();
    await flush();
    await new Promise((r) => setTimeout(r, 20));

    const status = root.querySelector(".kw-key-status")!;
    expect(status.textContent).toBe("Missing / Unconfigured");
  });

  it("handles test connection success and failure correctly", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="models"]')!.click();
    await flush();
    await new Promise((r) => setTimeout(r, 20));

    const testBtn = root.querySelector<HTMLButtonElement>(".kw-test-connection-btn")!;
    expect(testBtn).not.toBeNull();

    // Success test
    opts.chatModelClient.nextResponse = {
      kind: "ok",
      text: "pong",
    };

    testBtn.click();
    await flush();
    await new Promise((r) => setTimeout(r, 20));

    const resultEl = root.querySelector(".kw-test-result")!;
    expect(resultEl.textContent).toContain("Connection successful");
    expect(resultEl.textContent).toContain('Response: "pong"');

    // Failure test
    opts.chatModelClient.chat = vi.fn().mockRejectedValue(new Error("Model connection timeout"));
    testBtn.click();
    await flush();
    await new Promise((r) => setTimeout(r, 20));

    expect(resultEl.textContent).toContain("Connection error: Model connection timeout");
  });
});

// ---------------------------------------------------------------------------
// Agents pane
// ---------------------------------------------------------------------------

describe("workbench ??? Agents", () => {
  it("renders all five builtin agents with enabled checkbox and model input", () => {
    mountWorkspaceShell(root, buildOptions());
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="agents"]')!.click();
    const items = root.querySelectorAll<HTMLElement>(".kw-agents-item");
    const ids = Array.from(items).map((it) => it.dataset["agentId"]);
    expect(ids).toEqual(["researcher", "coder", "reviewer", "fixer", "boss"]);
    const enabledChecks = root.querySelectorAll<HTMLInputElement>('input[data-field="enabled"]');
    expect(enabledChecks.length).toBe(5);
    const modelInputs = root.querySelectorAll<HTMLInputElement>('input[data-field="modelId"]');
    expect(modelInputs.length).toBe(5);
  });

  it("Save persists per-agent settings without exposing the API key", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="agents"]')!.click();
    const reviewerEnabled = root.querySelector<HTMLInputElement>(
      'input[data-field="enabled"][data-agent-id="reviewer"]',
    )!;
    reviewerEnabled.checked = false;
    reviewerEnabled.dispatchEvent(new Event("change"));
    const reviewerModel = root.querySelector<HTMLInputElement>(
      'input[data-field="modelId"][data-agent-id="reviewer"]',
    )!;
    reviewerModel.value = "lightweight-reviewer";
    reviewerModel.dispatchEvent(new Event("change"));
    const saveBtn = root.querySelector<HTMLButtonElement>(
      '.kw-agents-save[data-agent-id="reviewer"]',
    )!;
    saveBtn.click();
    await flush();
    await flush();

    const writes = (
      opts.shell.writeLocalSetting as unknown as {
        mock: { calls: Array<[string, unknown]> };
      }
    ).mock.calls;
    const saved = writes.find((c) => c[0] === "agentSettings:fireworks");
    expect(saved).toBeDefined();
    const value = saved![1] as Record<string, unknown>;
    const reviewer = value.reviewer as { enabled: boolean; modelId?: string };
    expect(reviewer.enabled).toBe(false);
    expect(reviewer.modelId).toBe("lightweight-reviewer");
    // Plaintext key never reaches storage layer outputs we can inspect.
    expect(JSON.stringify(value)).not.toContain("fw-test-key");
  });

  it("Agent Mode passes per-agent model overrides and Boss setting to transport", async () => {
    const built = buildShell();
    built.reads.set("agentSettings:fireworks", {
      coder: { enabled: true, modelId: "coder-override" },
      reviewer: { enabled: true, modelId: "reviewer-override" },
      boss: { enabled: false },
    });
    const transport = new FakeTransport();
    mountWorkspaceShell(root, {
      session: SAMPLE_SESSION,
      metadata: SAMPLE_METADATA,
      desktopShell: built.shell,
      transport,
      onSignOut: vi.fn(),
    });
    await flush();
    const prompt = root.querySelector<HTMLTextAreaElement>(".kw-composer-input")!;
    prompt.value = "\u0441\u043e\u0437\u0434\u0430\u0439 \u0441\u0430\u0439\u0442";
    root.querySelector<HTMLTextAreaElement>(".kw-composer-input")?.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".kw-composer-start")!.click();
    await flush();
    root.querySelector<HTMLInputElement>(".kw-boss-enabled")!.checked = false;
    root.querySelector<HTMLButtonElement>(".kw-modal-confirm")!.click();
    await flush();

    expect(transport.createCalls).toHaveLength(1);
    expect(transport.createCalls[0]?.agentModelOverrides).toMatchObject({
      coder: "coder-override",
      reviewer: "reviewer-override",
    });
    expect(transport.createCalls[0]?.bossEnabled).toBe(false);
    expect(transport.createCalls[0]?.participants).not.toContain("boss");
  });
});

// ---------------------------------------------------------------------------
// Settings pane
// ---------------------------------------------------------------------------

describe("workbench ??? Settings", () => {
  it("does not render plaintext API key", () => {
    mountWorkspaceShell(root, buildOptions());
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="settings"]')!.click();
    const text = root.textContent ?? "";
    expect(text).toContain("ab12cd34");
    expect(text).not.toContain("fw-test-key");
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  });

  it("Sign out and Change API key invoke their callbacks", () => {
    const onSignOut = vi.fn();
    const onChangeKey = vi.fn();
    mountWorkspaceShell(root, buildOptions({ onSignOut, onChangeKey }));
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="settings"]')!.click();
    root.querySelector<HTMLButtonElement>(".kw-settings-change")!.click();
    expect(onChangeKey).toHaveBeenCalledTimes(1);
    expect(onSignOut).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>(".kw-settings-signout")!.click();
    root.querySelector<HTMLButtonElement>(".kw-signout-confirm")!.click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("diagnostics are JSON-stringified and contain no plaintext", () => {
    mountWorkspaceShell(root, buildOptions());
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="settings"]')!.click();
    const pre = root.querySelector<HTMLPreElement>(".kw-diagnostics")!;
    const parsed = JSON.parse(pre.textContent ?? "{}");
    expect(parsed).toMatchObject({
      desktopShellStatus: "active",
      storageStatus: "local-encrypted-active",
    });
    expect(JSON.stringify(parsed)).not.toContain("fw-test-key");
  });

  it("does not fake model capability probes from Settings", () => {
    mountWorkspaceShell(root, buildOptions());
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="settings"]')!.click();

    const text = root.textContent ?? "";
    expect(text).toContain("Open model catalog");
    expect(text).toContain("Karo does not fabricate compatibility scores.");
    expect(text).not.toContain("Test Model Capability");
    expect(text).not.toContain("Compatibility score: 98%");

    const modelCatalogBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Open model catalog",
    )!;
    modelCatalogBtn.click();
    expect(root.querySelector<HTMLElement>(".kw-center")?.dataset["routeId"]).toBe("models");
  });

  it("shows real last command diagnostics when the terminal stores them", () => {
    localStorage.setItem("karo.lastCommand", "npm run build");
    localStorage.setItem("karo.lastCommandRiskLevel", "safe");
    localStorage.setItem("karo.lastCommandDecision", "Auto");
    localStorage.setItem("karo.lastCommandRequiredApproval", "false");
    localStorage.setItem("karo.lastCommandRollbackAvailable", "false");
    localStorage.setItem("karo.lastCommandReason", "Allowed inside workspace");

    mountWorkspaceShell(root, buildOptions());
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="settings"]')!.click();

    const commandDiag = Array.from(root.querySelectorAll<HTMLPreElement>(".kw-diagnostics")).find((pre) =>
      pre.textContent?.includes("npm run build"),
    )!;
    const parsed = JSON.parse(commandDiag.textContent ?? "{}");
    expect(parsed).toMatchObject({
      lastCommand: "npm run build",
      lastCommandRiskLevel: "safe",
      lastCommandDecision: "Auto",
      lastCommandRequiredApproval: "false",
      lastCommandRollbackAvailable: "false",
      lastCommandReason: "Allowed inside workspace",
    });
  });
});

// ---------------------------------------------------------------------------
// Project pane
// ---------------------------------------------------------------------------

describe("workbench ??? Project", () => {
  it("renders a workspace command center and pre-fills safe mode prompts", () => {
    mountWorkspaceShell(root, buildOptions());
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="project"]')!.click();

    const commandCenter = root.querySelector<HTMLElement>(".kw-project-command-center")!;
    expect(commandCenter.textContent).toContain("Workspace command center");
    expect(commandCenter.textContent).toContain("Apply Changes remains the write gate");
    expect(commandCenter.textContent).toContain("Project root");
    expect(commandCenter.textContent).toContain("Not selected");

    const planButton = Array.from(commandCenter.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Plan next slice",
    )!;
    planButton.click();

    expect(localStorage.getItem("karo.composerMode")).toBe("plan");
    expect(root.querySelector('.kw-sidebar-button[data-route-id="chat"]')?.getAttribute("aria-current")).toBe("page");
    expect(root.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]')?.value).toContain(
      "next highest-impact Karo AI IDE improvement",
    );
    expect(root.querySelector<HTMLButtonElement>('[data-testid="composer-mode-plan"]')?.getAttribute("aria-current")).toBe("true");
  });

  it("Saves a project path and reflects it in the topbar", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="project"]')!.click();
    const input = root.querySelector<HTMLInputElement>(".kw-project-input")!;
    input.value = "C:\\demo";
    root.querySelector<HTMLButtonElement>(".kw-project-save")!.click();
    await flush();
    await flush();
    expect(root.querySelector(".kw-project-field")?.textContent).toBe("C:\\demo");
  });

  it("Rejects a non-existent project path without persisting it", async () => {
    const opts = buildOptions();
    (opts.shell.validateFolderPath as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "not_found",
      message: "not found",
    });
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="project"]')!.click();
    const input = root.querySelector<HTMLInputElement>(".kw-project-input")!;
    input.value = "D:\\такой-папки-нет";
    root.querySelector<HTMLButtonElement>(".kw-project-save")!.click();
    await flush();
    await flush();

    expect(root.querySelector(".kw-form-status")?.textContent).toContain("Folder does not exist");
    expect(root.querySelector(".kw-project-field")?.textContent).toBe("No project selected");
    const writes = (
      opts.shell.writeLocalSetting as unknown as {
        mock: { calls: Array<[string, unknown]> };
      }
    ).mock.calls;
    expect(writes.some((c) => c[0] === "recentProject")).toBe(false);
  });

  it("Rejects a relative project path without validating or saving", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="project"]')!.click();
    root.querySelector<HTMLInputElement>(".kw-project-input")!.value = "relative\\path";
    root.querySelector<HTMLButtonElement>(".kw-project-save")!.click();
    await flush();
    expect(root.querySelector(".kw-form-status")?.textContent).toContain("absolute folder path");
    expect(opts.shell.validateFolderPath).not.toHaveBeenCalledWith("relative\\path");
  });

  it("Rejects empty project path without persisting it", async () => {
    const opts = buildOptions();
    mountWorkspaceShell(root, opts);
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="project"]')!.click();
    const input = root.querySelector<HTMLInputElement>(".kw-project-input")!;
    input.value = "   ";
    root.querySelector<HTMLButtonElement>(".kw-project-save")!.click();
    await flush();
    await flush();

    expect(root.querySelector(".kw-project-field")?.textContent).toBe("No project selected");
    expect(root.querySelector(".kw-form-status")?.textContent).toContain(
      "Project path cannot be empty",
    );
    const writes = (
      opts.shell.writeLocalSetting as unknown as {
        mock: { calls: Array<[string, unknown]> };
      }
    ).mock.calls;
    expect(writes.some((c) => c[0] === "recentProject")).toBe(false);
  });

  it("explain-only task does not show 'Preparing changes' in Changes panel", async () => {
    const opts = buildOptions();
    opts.transport.getTaskState = () => ({
      id: "task-explain",
      status: "completed",
      currentAgentId: "boss",
      reviewCycles: 0,
      maxReviewCycles: 3,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:00.000Z",
      originalPrompt: "Объясни как работает Apply Changes",
      modelId: "test-model",
      provider: "fireworks",
      participants: ["researcher"],
      isExplainOnly: true,
    });
    opts.transport.getArtifacts = () => [];

    mountWorkspaceShell(root, opts);
    // Switch to active task state (so right panel has activeTaskId)
    (opts.transport as any).emitTaskState({
      id: "task-explain",
      status: "completed",
      isExplainOnly: true,
    });
    // Set activeTaskId on the workbench state manually or by mimicking navigate
    const stateObj = (root as any)._karoState || (window as any)._karoState;
    if (stateObj) {
      stateObj.activeTaskId = "task-explain";
      stateObj.routeId = "changes";
    }
    await flush();

    // Trigger changes route render
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="changes"]')!.click();
    await flush();

    const changesPanel = root.querySelector(".kw-changes");
    expect(changesPanel).not.toBeNull();
    expect(changesPanel?.textContent).not.toContain("Preparing changes");
    expect(changesPanel?.textContent).toContain("Read-only analysis");
    expect(changesPanel?.textContent).toContain("No file changes were produced");
  });

  it("Context used block is rendered when contextSummary exists", async () => {
    const opts = buildOptions();
    opts.transport.getTaskState = () => ({
      id: "task-ctx",
      status: "completed",
      currentAgentId: "boss",
      reviewCycles: 0,
      maxReviewCycles: 3,
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:00.000Z",
      originalPrompt: "Объясни как работает Apply Changes",
      modelId: "test-model",
      provider: "fireworks",
      participants: ["researcher"],
      isExplainOnly: true,
      contextSummary: {
        projectRoot: "D:/проекты/karo-exstention",
        scannedFilesCount: 15,
        selectedFilesCount: 2,
        selectedFiles: [
          { relativePath: "src/apply.rs", score: 25, reason: ["keyword"], truncated: false },
          { relativePath: "src/staging.rs", score: 22, reason: ["keyword"], truncated: false }
        ],
        warnings: []
      }
    });

    mountWorkspaceShell(root, opts);
    const stateObj = (root as any)._karoState || (window as any)._karoState;
    if (stateObj) {
      stateObj.activeTaskId = "task-ctx";
      stateObj.routeId = "chat";
    }
    await flush();

    // Switch to chat route
    root.querySelector<HTMLButtonElement>('.kw-sidebar-button[data-route-id="chat"]')!.click();
    await flush();

    const contextBlock = root.querySelector(".kw-context-used");
    expect(contextBlock).not.toBeNull();
    expect(contextBlock?.textContent).toContain("Context");
    expect(contextBlock?.textContent).toContain("2 files selected");
    expect(contextBlock?.textContent).toContain("15 scanned");
    expect(contextBlock?.textContent).toContain("src/apply.rs");
    expect(contextBlock?.textContent).toContain("src/staging.rs");
  });
});
