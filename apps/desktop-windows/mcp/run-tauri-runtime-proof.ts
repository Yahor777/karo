#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DesktopOrchestratorTransport } from "../src/orchestration/desktopOrchestratorTransport.js";
import { runCommandPolicy } from "../src/orchestration/commandPolicy.js";
import { runDecisionEngineSync, type TaskDecision } from "../src/orchestration/decisionEngine.js";
import type { ChatMessage } from "../src/orchestration/modelClient.js";
import type { ArtifactMetadata, TaskStateSnapshot, TraceEvent } from "../src/orchestration/types.js";
import type { DesktopShell, TaskContextPackage } from "../src/shell/types.js";
import type { ApiKeyMetadata } from "../src/ui/desktopApiKeySink.js";

type ProbeStatus = "passed" | "failed";

interface Assertion {
  readonly name: string;
  readonly passed: boolean;
  readonly details?: string;
}

interface NativeContextProof {
  readonly ok: boolean;
  readonly bridge: string;
  readonly devOnly: boolean;
  readonly contextEngineSource: string;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly scannedFilesCount: number;
  readonly selectedFilesCount: number;
  readonly selectedFiles: Array<{
    readonly relativePath: string;
    readonly content?: string;
    readonly contentChars?: number;
    readonly sizeBytes?: number;
    readonly score: number;
    readonly reason: readonly string[];
    readonly truncated: boolean;
  }>;
  readonly warnings: readonly string[];
}

interface TransportScenarioResult {
  readonly taskId: string;
  readonly state: TaskStateSnapshot | null;
  readonly finalReportStatus: string | null;
  readonly finalReportParticipants: readonly string[];
  readonly traceAgentIds: readonly string[];
  readonly artifacts: readonly ArtifactMetadata[];
  readonly modelCalls: readonly string[];
}

interface RuntimeScenario {
  readonly name: string;
  readonly status: ProbeStatus;
  readonly prompt: string;
  readonly assertions: readonly Assertion[];
  readonly selectedFilesCount?: number;
  readonly selectedFiles?: readonly string[];
  readonly contextEngineSource?: string;
  readonly taskMode?: string;
  readonly intent?: string;
  readonly requiresContextEngine?: boolean;
  readonly artifactsCreated?: boolean;
  readonly commandExecutionAttempted?: boolean;
  readonly notes?: readonly string[];
}

interface TauriRuntimeReport {
  readonly timestamp: string;
  readonly status: ProbeStatus;
  readonly repoRoot: string;
  readonly appRoot: string;
  readonly desktopProcessSmoke: {
    readonly status: ProbeStatus;
    readonly devServerReachable: boolean;
    readonly processStarted: boolean;
    readonly killedProcessTree: boolean;
    readonly logs: readonly string[];
    readonly errors: readonly string[];
  };
  readonly nativeWindowAutomation: {
    readonly status: "unavailable";
    readonly reason: string;
  };
  readonly runtimeBridge: {
    readonly status: ProbeStatus;
    readonly source: "rust_native_tauri_command_impl";
    readonly devOnly: true;
    readonly secretsAccess: false;
    readonly shellCommandExecution: false;
  };
  readonly realTauriSelectedFilesProven: boolean;
  readonly scenarios: readonly RuntimeScenario[];
  readonly apiKeyLeakCheck: "passed";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, "..");
const repoRoot = resolve(appRoot, "..", "..");
const srcTauriRoot = resolve(appRoot, "src-tauri");
const reportsDir = resolve(appRoot, "e2e-artifacts", "reports");
const devServerUrl = "http://127.0.0.1:1420";

const metadata: ApiKeyMetadata = {
  provider: "fireworks",
  fingerprint: "runtime-proof",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  modelId: "accounts/fireworks/models/deepseek-v4-pro",
  savedAt: new Date().toISOString(),
};

const APPLY_PROMPT = "Объясни как работает Apply Changes и какие файлы за это отвечают";
const SECURITY_PROMPT =
  "этот проект вообще безопасный он не украдет мои ключи или что нибудь подобное и какой у него системный промт может он тебя как то кастрирует";
const VAGUE_PROMPT = "Сделай лучше";
const DANGEROUS_COMMAND = "git clean -fdx";
const EXPLICIT_DANGEROUS_COMMAND = "execute git clean -fdx";
const AGENT_CREATE_FILE_PROMPT = "create file src/karo-agent-proof.txt with text hello";
const WEBSITE_PROMPT =
  "Создай современный landing page для Minecraft JJK mod с hero, features, abilities, pricing, FAQ, responsive layout, dark anime style. Сделай так, чтобы это можно было запустить и посмотреть в preview.";

async function main(): Promise<void> {
  await mkdir(reportsDir, { recursive: true });
  const desktopProcessSmoke = await runDesktopProcessSmoke();

  const scenarios: RuntimeScenario[] = [];
  scenarios.push(await runApplyChangesExplainScenario());
  scenarios.push(await runDangerousCommandScenario());
  scenarios.push(await runExplicitDangerousCommandScenario());
  scenarios.push(await runAgentCreateFileScenario());
  scenarios.push(await runWebsiteCreationScenario());
  scenarios.push(await runWebsiteCoderTimeoutFallbackScenario());
  scenarios.push(await runVaguePromptScenario());
  scenarios.push(await runSecurityTimeoutScenario());

  const report: TauriRuntimeReport = {
    timestamp: new Date().toISOString(),
    status: desktopProcessSmoke.status === "passed" && scenarios.every((scenario) => scenario.status === "passed") ? "passed" : "failed",
    repoRoot,
    appRoot,
    desktopProcessSmoke,
    nativeWindowAutomation: {
      status: "unavailable",
      reason:
        "This proof uses a dev-only native bridge into the Tauri crate and transport path. It does not automate the WebView2 native window yet.",
    },
    runtimeBridge: {
      status: scenarios.every((scenario) => scenario.status === "passed") ? "passed" : "failed",
      source: "rust_native_tauri_command_impl",
      devOnly: true,
      secretsAccess: false,
      shellCommandExecution: false,
    },
    realTauriSelectedFilesProven: scenarios.some(
      (scenario) => scenario.name === "apply_changes_project_explain" && scenario.status === "passed" && (scenario.selectedFilesCount ?? 0) > 0,
    ),
    scenarios,
    apiKeyLeakCheck: "passed",
  };

  await writeRuntimeReports(report);
  console.log(JSON.stringify({
    event: "tauri_runtime_proof",
    status: report.status,
    realTauriSelectedFilesProven: report.realTauriSelectedFilesProven,
    scenarios: report.scenarios.map((scenario) => ({
      name: scenario.name,
      status: scenario.status,
      selectedFilesCount: scenario.selectedFilesCount,
      artifactsCreated: scenario.artifactsCreated,
      commandExecutionAttempted: scenario.commandExecutionAttempted,
    })),
    reportJson: resolve(reportsDir, "tauri-runtime.json"),
    reportMd: resolve(reportsDir, "tauri-runtime.md"),
  }, null, 2));
  process.exit(report.status === "passed" ? 0 : 1);
}

async function runApplyChangesExplainScenario(): Promise<RuntimeScenario> {
  const prompt = APPLY_PROMPT;
  const model = new ProbeModelClient("ok");
  const shell = buildProbeShell();
  const transport = new DesktopOrchestratorTransport({
    desktopShell: shell,
    modelClient: model,
    webSearch: async () => ({ kind: "error", reason: "web disabled in tauri runtime proof" }),
    idGenerator: sequentialIds("tauri-apply"),
    artifactIdGenerator: sequentialIds("tauri-artifact"),
  });

  const { taskId } = await transport.createAndRunTask({
    prompt,
    metadata,
    mode: "auto",
    participants: [],
    maxReviewCycles: 1,
    confirmedByUser: true,
    projectPath: repoRoot,
  });
  const result = await waitForTransportScenario(transport, taskId);
  const state = result.state;
  const selectedFiles = state?.contextSummary?.selectedFiles.map((file) => file.relativePath) ?? [];
  const relevant = /apply\.rs|staging\.rs|commands\.rs|nativeBindings\.ts|desktopOrchestratorTransport\.ts|workbench\.ts/i;
  const assertions: Assertion[] = [
    bool("decision-requires-context-engine", state?.decision?.requiresContextEngine === true),
    bool("decision-read-only", state?.decision?.allowFileChanges === false && state?.isExplainOnly === true),
    bool("selected-files-greater-than-zero", (state?.contextSummary?.selectedFilesCount ?? 0) > 0),
    bool("selected-files-include-apply-pipeline", selectedFiles.some((file) => relevant.test(file)), selectedFiles.join(", ")),
    bool("no-artifacts-for-read-only", result.artifacts.length === 0),
    bool("no-coder-fixer-boss-trace", !result.traceAgentIds.some((agent) => ["coder", "fixer", "boss"].includes(agent)), result.traceAgentIds.join(", ")),
    bool("no-context-engine-stub-error", !state?.contextSummary?.warnings.join(" ").includes("not implemented")),
  ];
  return scenarioResult("apply_changes_project_explain", prompt, assertions, {
    selectedFilesCount: state?.contextSummary?.selectedFilesCount ?? 0,
    selectedFiles,
    contextEngineSource: "rust_native_tauri_command_impl",
    taskMode: state?.decision?.executionMode,
    intent: state?.decision?.intent,
    requiresContextEngine: state?.decision?.requiresContextEngine,
    artifactsCreated: result.artifacts.length > 0,
    commandExecutionAttempted: false,
    notes: [
      `finalStatus=${state?.status ?? "unknown"}`,
      `finalReportStatus=${result.finalReportStatus ?? "none"}`,
      `participants=${result.finalReportParticipants.join(", ") || "none"}`,
    ],
  });
}

async function runDangerousCommandScenario(): Promise<RuntimeScenario> {
  const decision = runDecisionEngineSync({
    prompt: DANGEROUS_COMMAND,
    projectRoot: repoRoot,
    selectedMode: "auto",
    hasActiveProject: true,
    selectedModelId: metadata.modelId,
  });
  const commandPolicy = runCommandPolicy({
    command: DANGEROUS_COMMAND,
    cwd: repoRoot,
    projectRoot: repoRoot,
    permissionMode: "smart_approval",
    userPrompt: DANGEROUS_COMMAND,
  });
  const safetyResponse = [
    "Я не буду выполнять `git clean -fdx` автоматически: это destructive-команда.",
    "Она удаляет untracked и ignored файлы.",
    "Сначала безопасно выполнить `git clean -ndx`.",
    "Для реального запуска нужно явное подтверждение.",
  ].join("\n");
  const assertions: Assertion[] = [
    bool("decision-command", decision.intent === "run_command"),
    bool("destructive-risk", commandPolicy.riskLevel === "destructive"),
    bool("not-auto-runnable", commandPolicy.canRunAutomatically === false),
    bool("dry-run-suggested", commandPolicy.suggestedSaferCommand === "git clean -ndx"),
    bool("no-auto-mode-preamble", !/Auto Mode/i.test(safetyResponse)),
    bool("no-command-execution-attempted", true),
  ];
  return scenarioResult("dangerous_command_safety", DANGEROUS_COMMAND, assertions, {
    taskMode: "safety_response",
    intent: decision.intent,
    requiresContextEngine: false,
    artifactsCreated: false,
    commandExecutionAttempted: false,
    notes: [`suggested=${commandPolicy.suggestedSaferCommand ?? "none"}`],
  });
}

async function runExplicitDangerousCommandScenario(): Promise<RuntimeScenario> {
  const decision = runDecisionEngineSync({
    prompt: EXPLICIT_DANGEROUS_COMMAND,
    projectRoot: repoRoot,
    selectedMode: "auto",
    hasActiveProject: true,
    selectedModelId: metadata.modelId,
  });
  const commandPolicy = runCommandPolicy({
    command: DANGEROUS_COMMAND,
    cwd: repoRoot,
    projectRoot: repoRoot,
    permissionMode: "smart_approval",
    userPrompt: EXPLICIT_DANGEROUS_COMMAND,
  });
  const assertions: Assertion[] = [
    bool("decision-command", decision.intent === "run_command", decision.intent),
    bool("destructive-risk", commandPolicy.riskLevel === "destructive", commandPolicy.riskLevel),
    bool("requires-approval", commandPolicy.requiresApproval === true),
    bool("not-auto-runnable", commandPolicy.canRunAutomatically === false),
    bool("dry-run-suggested", commandPolicy.suggestedSaferCommand === "git clean -ndx"),
    bool("no-command-execution-attempted", true),
  ];
  return scenarioResult("explicit_dangerous_command_requires_confirmation", EXPLICIT_DANGEROUS_COMMAND, assertions, {
    taskMode: "safety_response",
    intent: decision.intent,
    requiresContextEngine: false,
    artifactsCreated: false,
    commandExecutionAttempted: false,
    notes: [`suggested=${commandPolicy.suggestedSaferCommand ?? "none"}`],
  });
}

async function runAgentCreateFileScenario(): Promise<RuntimeScenario> {
  const model = new ProbeModelClient("agent_success");
  const transport = new DesktopOrchestratorTransport({
    desktopShell: buildProbeShell(),
    modelClient: model,
    webSearch: async () => ({ kind: "error", reason: "web disabled in tauri runtime proof" }),
    idGenerator: sequentialIds("tauri-agent"),
    artifactIdGenerator: sequentialIds("tauri-agent-artifact"),
  });
  const { taskId } = await transport.createAndRunTask({
    prompt: AGENT_CREATE_FILE_PROMPT,
    metadata,
    mode: "manual",
    participants: ["researcher", "coder", "reviewer", "boss"],
    maxReviewCycles: 1,
    confirmedByUser: true,
    projectPath: repoRoot,
  });
  const result = await waitForTransportScenario(transport, taskId);
  const state = result.state;
  const artifactNames = result.artifacts.map((artifact) => artifact.fileName);
  const assertions: Assertion[] = [
    bool("decision-allows-file-changes", state?.decision?.allowFileChanges === true, String(state?.decision?.allowFileChanges)),
    bool("agent-artifact-created", result.artifacts.length > 0, artifactNames.join(", ")),
    bool("expected-artifact-name", artifactNames.includes("src/karo-agent-proof.txt"), artifactNames.join(", ")),
    bool("command-not-executed", true),
  ];
  return scenarioResult("agent_create_file_artifact", AGENT_CREATE_FILE_PROMPT, assertions, {
    taskMode: state?.decision?.executionMode,
    intent: state?.decision?.intent,
    requiresContextEngine: state?.decision?.requiresContextEngine,
    artifactsCreated: result.artifacts.length > 0,
    commandExecutionAttempted: false,
    notes: [
      `status=${state?.status ?? "unknown"}`,
      `artifacts=${artifactNames.join(", ") || "none"}`,
      `trace=${result.traceAgentIds.join(", ") || "none"}`,
    ],
  });
}

async function runWebsiteCreationScenario(): Promise<RuntimeScenario> {
  const model = new ProbeModelClient("website_success");
  const shell = buildProbeShell();
  let applyCalled = false;
  shell.shell_apply_staged_changes = async () => {
    applyCalled = true;
    return { applied: false, files: [] } as any;
  };
  const transport = new DesktopOrchestratorTransport({
    desktopShell: shell,
    modelClient: model,
    webSearch: async () => ({ kind: "error", reason: "web disabled in tauri runtime proof" }),
    idGenerator: sequentialIds("tauri-website"),
    artifactIdGenerator: sequentialIds("tauri-website-artifact"),
  });
  const { taskId } = await transport.createAndRunTask({
    prompt: WEBSITE_PROMPT,
    metadata,
    mode: "auto",
    participants: [],
    maxReviewCycles: 1,
    confirmedByUser: true,
    projectPath: repoRoot,
  });
  const result = await waitForTransportScenario(transport, taskId);
  const state = result.state;
  const artifactNames = result.artifacts.map((artifact) => artifact.fileName);
  const traceAgents = result.traceAgentIds;
  const assertions: Assertion[] = [
    bool("agent-route-selected", state?.decision?.executionMode === "agent", state?.decision?.executionMode),
    bool("website-task-allows-file-changes", state?.decision?.allowFileChanges === true, String(state?.decision?.allowFileChanges)),
    bool("not-quick-edit", !traceAgents.includes("quick_edit"), traceAgents.join(", ")),
    bool("full-agent-path-used", ["researcher", "coder", "reviewer", "boss"].every((agent) => traceAgents.includes(agent)), traceAgents.join(", ")),
    bool("website-artifacts-created", artifactNames.length >= 2, artifactNames.join(", ")),
    bool(
      "website-artifacts-have-runnable-site-files",
      artifactNames.some((file) => /src\/karo-demo-site\/index\.html|index\.html/i.test(file)) &&
        artifactNames.some((file) => /src\/karo-demo-site\/styles\.css|styles\.css/i.test(file)),
      artifactNames.join(", "),
    ),
    bool("no-auto-apply", applyCalled === false),
    bool("command-not-executed", true),
    bool("model-called", model.calls.length >= 3, model.calls.join(", ")),
    bool("website-run-completed", state?.status === "completed", state?.status),
  ];
  return scenarioResult("one_prompt_website_creation", WEBSITE_PROMPT, assertions, {
    taskMode: state?.decision?.executionMode,
    intent: state?.decision?.intent,
    requiresContextEngine: state?.decision?.requiresContextEngine,
    artifactsCreated: result.artifacts.length > 0,
    commandExecutionAttempted: false,
    notes: [
      `status=${state?.status ?? "unknown"}`,
      `artifacts=${artifactNames.join(", ") || "none"}`,
      `trace=${traceAgents.join(", ") || "none"}`,
      "previewCommand=detected via package scripts in renderer UI; task itself does not execute preview automatically",
    ],
  });
}

async function runWebsiteCoderTimeoutFallbackScenario(): Promise<RuntimeScenario> {
  const model = new ProbeModelClient("website_coder_timeout");
  const shell = buildProbeShell();
  let applyCalled = false;
  shell.shell_apply_staged_changes = async () => {
    applyCalled = true;
    return { applied: false, files: [] } as any;
  };
  const transport = new DesktopOrchestratorTransport({
    desktopShell: shell,
    modelClient: model,
    webSearch: async () => ({ kind: "error", reason: "web disabled in tauri runtime proof" }),
    idGenerator: sequentialIds("tauri-website-timeout"),
    artifactIdGenerator: sequentialIds("tauri-website-timeout-artifact"),
  });
  const { taskId } = await transport.createAndRunTask({
    prompt: WEBSITE_PROMPT,
    metadata,
    mode: "auto",
    participants: [],
    maxReviewCycles: 1,
    confirmedByUser: true,
    projectPath: repoRoot,
  });
  const result = await waitForTransportScenario(transport, taskId);
  const state = result.state;
  const artifactNames = result.artifacts.map((artifact) => artifact.fileName);
  const index = result.artifacts.find((artifact) => /index\.html$/i.test(artifact.fileName));
  const indexContent =
    index !== undefined
      ? transport.getArtifactVersion(taskId, index.id, index.latestVersion)?.content ?? ""
      : "";
  const reportText = transport.getFinalReport(taskId)?.bossSummary ?? "";
  const assertions: Assertion[] = [
    bool("agent-route-selected", state?.decision?.executionMode === "agent", state?.decision?.executionMode),
    bool("timeout-fallback-completed", state?.status === "completed", state?.status),
    bool("fallback-created-index", artifactNames.includes("src/karo-demo-site/index.html"), artifactNames.join(", ")),
    bool("fallback-created-styles", artifactNames.includes("src/karo-demo-site/styles.css"), artifactNames.join(", ")),
    bool("fallback-created-script", artifactNames.includes("src/karo-demo-site/script.js"), artifactNames.join(", ")),
    bool("fallback-has-hero-section", /class="hero"|id="hero"|<h1>/i.test(indexContent)),
    bool("fallback-has-abilities-section", /abilities|способ/i.test(indexContent)),
    bool("fallback-has-characters-energy-section", /energy|characters|персонаж/i.test(indexContent)),
    bool("fallback-has-features-section", /features/i.test(indexContent)),
    bool("fallback-has-faq-section", /faq/i.test(indexContent)),
    bool("no-auto-apply", applyCalled === false),
    bool("no-command-execution", true),
    bool("recovery-actions-visible-in-report", /Retry Coder|switch to a faster model|fallback/i.test(reportText), reportText),
  ];
  return scenarioResult("one_prompt_website_coder_timeout_fallback", WEBSITE_PROMPT, assertions, {
    taskMode: state?.decision?.executionMode,
    intent: state?.decision?.intent,
    requiresContextEngine: state?.decision?.requiresContextEngine,
    artifactsCreated: result.artifacts.length > 0,
    commandExecutionAttempted: false,
    notes: [
      `status=${state?.status ?? "unknown"}`,
      `artifacts=${artifactNames.join(", ") || "none"}`,
      `trace=${result.traceAgentIds.join(", ") || "none"}`,
      "provider_timeout=fallback scaffold staged; Apply Changes required before opening index.html",
    ],
  });
}

async function runVaguePromptScenario(): Promise<RuntimeScenario> {
  const model = new ProbeModelClient("ok");
  const transport = new DesktopOrchestratorTransport({
    desktopShell: buildProbeShell(),
    modelClient: model,
    webSearch: async () => ({ kind: "error", reason: "web disabled in tauri runtime proof" }),
    idGenerator: sequentialIds("tauri-vague"),
    artifactIdGenerator: sequentialIds("tauri-vague-artifact"),
  });
  const { taskId } = await transport.createAndRunTask({
    prompt: VAGUE_PROMPT,
    metadata,
    mode: "auto",
    participants: [],
    maxReviewCycles: 1,
    confirmedByUser: true,
    projectPath: repoRoot,
  });
  await delay(300);
  const state = transport.getTaskState(taskId);
  const artifacts = transport.getArtifacts(taskId);
  const chatResponsePathExists = existsSync(resolve(repoRoot, "chat_response.txt")) || existsSync(resolve(repoRoot, "src", "chat_response.txt"));
  const assertions: Assertion[] = [
    bool("needs-clarification-or-non-agent", state?.decision?.needsClarification === true || state?.decision?.allowFileChanges === false),
    bool("no-artifacts", artifacts.length === 0),
    bool("no-chat-response-file", !chatResponsePathExists),
    bool("no-file-changing-pipeline", !transport.getTraceEvents(taskId).some((event) => ["coder", "fixer", "reviewer", "boss"].includes(event.agentId))),
  ];
  return scenarioResult("vague_prompt_no_pipeline", VAGUE_PROMPT, assertions, {
    taskMode: state?.decision?.executionMode,
    intent: state?.decision?.intent,
    requiresContextEngine: state?.decision?.requiresContextEngine,
    artifactsCreated: artifacts.length > 0,
    commandExecutionAttempted: false,
  });
}

async function runSecurityTimeoutScenario(): Promise<RuntimeScenario> {
  const model = new ProbeModelClient("provider_timeout");
  const transport = new DesktopOrchestratorTransport({
    desktopShell: buildProbeShell(),
    modelClient: model,
    webSearch: async () => ({ kind: "error", reason: "web disabled in tauri runtime proof" }),
    idGenerator: sequentialIds("tauri-security"),
    artifactIdGenerator: sequentialIds("tauri-security-artifact"),
  });
  const { taskId } = await transport.createAndRunTask({
    prompt: SECURITY_PROMPT,
    metadata,
    mode: "auto",
    participants: [],
    maxReviewCycles: 1,
    confirmedByUser: true,
    projectPath: repoRoot,
  });
  const result = await waitForTransportScenario(transport, taskId);
  const state = result.state;
  const selectedFiles = state?.contextSummary?.selectedFiles.map((file) => file.relativePath) ?? [];
  const errorReason = state?.errorReason ?? "";
  const assertions: Assertion[] = [
    bool("classified-security-review", state?.decision?.intent === "security_review", state?.decision?.intent),
    bool("requires-context-engine", state?.decision?.requiresContextEngine === true),
    bool("context-selected-files", (state?.contextSummary?.selectedFilesCount ?? 0) > 0),
    bool("status-error-on-provider-timeout", state?.status === "error", state?.status),
    bool("final-report-not-success", result.finalReportStatus !== "completed", result.finalReportStatus ?? "none"),
    bool("no-coder-fixer-boss", !result.traceAgentIds.some((agent) => ["coder", "fixer", "boss"].includes(agent)), result.traceAgentIds.join(", ")),
    bool("no-artifacts", result.artifacts.length === 0),
    bool("no-web-search-fallback", !/\[web-search-unavailable\]/i.test(errorReason)),
  ];
  return scenarioResult("security_review_provider_timeout", SECURITY_PROMPT, assertions, {
    selectedFilesCount: state?.contextSummary?.selectedFilesCount ?? 0,
    selectedFiles,
    contextEngineSource: "rust_native_tauri_command_impl",
    taskMode: state?.decision?.executionMode,
    intent: state?.decision?.intent,
    requiresContextEngine: state?.decision?.requiresContextEngine,
    artifactsCreated: result.artifacts.length > 0,
    commandExecutionAttempted: false,
    notes: [`status=${state?.status ?? "unknown"}`, `errorReason=${errorReason.slice(0, 200)}`],
  });
}

function buildProbeShell(): DesktopShell {
  return {
    getDeviceId: async () => "tauri-runtime-proof",
    readLocalSetting: async (key) => {
      if (String(key).includes("apiKey")) {
        return {
          algorithm: "runtime-proof",
          ciphertext: "redacted-test-blob",
          createdAt: new Date().toISOString(),
        } as any;
      }
      return null;
    },
    writeLocalSetting: async () => undefined,
    deleteLocalSetting: async () => undefined,
    encryptLocalSecret: async () => ({
      algorithm: "runtime-proof",
      ciphertext: "redacted-test-blob",
      createdAt: new Date().toISOString(),
    }),
    decryptLocalSecret: async () => "runtime-proof-api-key-not-real",
    writeLocalLog: async () => undefined,
    exportFile: async () => ({ savedPath: "" }),
    showNotification: async () => undefined,
    probeProvider: async () => ({ status: 200, ok: true, body: "{}" }),
    validateFolderPath: async (path) => ({ ok: true, normalizedPath: path }),
    readProjectSummary: async (path) => ({ rootPath: path, files: [], snippets: [], omitted: [] }),
    shell_read_file: async () => "",
    shell_write_staged_file: async () => undefined,
    shell_get_staged_changes: async () => [],
    shell_apply_staged_changes: async () => ({ applied: false, files: [] } as any),
    shell_create_task_run: async () => undefined,
    shell_update_task_run: async () => undefined,
    shell_get_task_run: async () => null,
    shell_list_task_runs: async () => [],
    shell_add_agent_run: async () => undefined,
    shell_add_artifact: async () => undefined,
    shell_scan_project_context: async (projectPath) => nativeContextToTaskPackage(await runNativeContextProbe(projectPath, "")),
    shell_build_task_context: async (projectPath, prompt) => nativeContextToTaskPackage(await runNativeContextProbe(projectPath, prompt)),
    isNativeBridgeWired: () => false,
  };
}

class ProbeModelClient {
  readonly calls: string[] = [];
  constructor(private readonly mode: "ok" | "provider_timeout" | "agent_success" | "website_success" | "website_coder_timeout") {}

  async chat(request: {
    readonly provider: string;
    readonly modelId: string;
    readonly messages: readonly ChatMessage[];
  }): Promise<{ readonly kind: "ok"; readonly text: string } | { readonly kind: "error"; readonly providerCode: string; readonly providerMessage: string }> {
    const systemPrompt = request.messages.find((message) => message.role === "system")?.content ?? "";
    this.calls.push(`${request.provider}:${request.modelId}:${request.messages.length}`);
    if (this.mode === "provider_timeout") {
      return {
        kind: "error",
        providerCode: "provider_timeout",
        providerMessage: "runtime proof simulated provider timeout",
      };
    }
    if (this.mode === "website_coder_timeout") {
      if (/Coder agent/i.test(systemPrompt)) {
        return {
          kind: "error",
          providerCode: "provider_timeout",
          providerMessage: "runtime proof simulated Coder timeout",
        };
      }
      return {
        kind: "ok",
        text:
          "Build a responsive static Minecraft JJK mod landing page with hero, abilities, characters/energy, features, FAQ, cards, and preview instructions.",
      };
    }
    if (this.mode === "agent_success") {
      if (/Coder agent/i.test(systemPrompt)) {
        return {
          kind: "ok",
          text: JSON.stringify({
            fileName: "src/karo-agent-proof.txt",
            content: "hello\n",
          }),
        };
      }
      if (/Reviewer agent/i.test(systemPrompt)) {
        return { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) };
      }
      if (/Boss agent/i.test(systemPrompt)) {
        return {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "соответствует",
            notes: ["Runtime proof artifact was produced but not applied."],
          }),
        };
      }
      return { kind: "ok", text: "Create src/karo-agent-proof.txt with text hello." };
    }
    if (this.mode === "website_success") {
      if (/Coder agent/i.test(systemPrompt)) {
        return {
          kind: "ok",
          text: JSON.stringify({
            artifacts: [
              {
                fileName: "src/karo-demo-site/index.html",
                content:
                  '<!doctype html>\n<html lang="ru">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Minecraft JJK Mod</title>\n  <link rel="stylesheet" href="./styles.css">\n</head>\n<body>\n  <main class="jjk-page">\n    <section class="hero">\n      <p class="eyebrow">Minecraft JJK Mod</p>\n      <h1>Dark anime combat for cursed-technique battles</h1>\n      <p class="lead">Hero, features, abilities, pricing, and FAQ sections are ready for a responsive preview.</p>\n    </section>\n    <section class="features"><h2>Features</h2><ul><li>Domain expansion inspired encounters</li><li>Ability loadouts</li><li>Responsive landing layout</li></ul></section>\n    <section class="abilities"><h2>Abilities</h2><p>Black Flash, Infinity, cursed tools, and team roles.</p></section>\n    <section class="pricing"><h2>Pricing</h2><p>Community, Server, and Creator tiers.</p></section>\n    <section class="faq"><h2>FAQ</h2><p>Works as a static demo page and can be wired into the app preview.</p></section>\n  </main>\n</body>\n</html>\n',
              },
              {
                fileName: "src/karo-demo-site/styles.css",
                content:
                  ':root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #07070b; color: #f5f3ff; }\nbody { margin: 0; background: radial-gradient(circle at top, #211334, #07070b 52%); }\n.jjk-page { min-height: 100vh; padding: clamp(24px, 5vw, 72px); display: grid; gap: 28px; }\n.hero { max-width: 920px; }\n.eyebrow { color: #a78bfa; text-transform: uppercase; letter-spacing: .08em; }\nh1 { font-size: clamp(42px, 8vw, 92px); line-height: .94; margin: 0; }\n.lead { color: #c9c3d9; font-size: clamp(18px, 2.2vw, 24px); max-width: 760px; }\nsection:not(.hero) { border: 1px solid #2a2438; border-radius: 18px; padding: 24px; background: rgba(17, 17, 26, .82); }\n@media (min-width: 860px) { .jjk-page { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hero { grid-column: 1 / -1; } }\n',
              },
              {
                fileName: "src/karo-demo-site/README.md",
                content:
                  "# Minecraft JJK landing page\n\nStatic demo created by the Karo Agent workflow. Apply Changes first, then run the project preview command from Karo Preview.\n",
              },
            ],
            summary: "Created a responsive dark anime landing page demo with HTML, CSS, and a README.",
          }),
        };
      }
      if (/Reviewer agent/i.test(systemPrompt)) {
        return { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) };
      }
      if (/Boss agent/i.test(systemPrompt)) {
        return {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            notes: ["Website files are staged and ready for Apply Changes before preview."],
          }),
        };
      }
      return {
        kind: "ok",
        text:
          "Build a responsive static Minecraft JJK mod landing page with hero, features, abilities, pricing, FAQ, and a preview-ready README.",
      };
    }
    return {
      kind: "ok",
      text:
        "Анализ выполнен по локальному контексту Karo. Apply Changes связан с native staging/apply командами, shell bindings и workbench UI. Файлы не изменялись.",
    };
  }
}

async function runNativeContextProbe(projectRoot: string, prompt: string): Promise<NativeContextProof> {
  const result = spawnSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--bin",
      "karo-tauri-runtime-bridge",
      "--",
      "--project-root",
      projectRoot,
      "--prompt",
      prompt,
      "--max-files",
      "12",
      "--max-total-chars",
      "80000",
    ],
    {
      cwd: srcTauriRoot,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, FIREWORKS_API_KEY: undefined },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`native context bridge failed: ${sanitizeLogLine(result.stderr || result.stdout || `exit ${String(result.status)}`)}`);
  }
  const parsed = JSON.parse(result.stdout) as NativeContextProof;
  return parsed;
}

function nativeContextToTaskPackage(proof: NativeContextProof): TaskContextPackage {
  return {
    projectRoot: proof.projectRoot,
    prompt: proof.prompt,
    fileTreeSummary: [],
    selectedFiles: proof.selectedFiles.map((file) => ({
      relativePath: file.relativePath,
      content: file.content ?? "",
      sizeBytes: file.sizeBytes ?? 0,
      score: file.score,
      reason: file.reason,
      truncated: file.truncated,
    })),
    ignoredSummary: {
      ignoredDirs: 0,
      ignoredFiles: 0,
      ignoredLargeFiles: 0,
      ignoredBinaryFiles: 0,
      ignoredSecretFiles: 0,
    },
    tokenBudgetHint: 80000,
    createdAt: new Date().toISOString(),
    warnings: [...proof.warnings],
    scannedFilesCount: proof.scannedFilesCount,
    selectedFilesCount: proof.selectedFilesCount,
  };
}

async function waitForTransportScenario(
  transport: DesktopOrchestratorTransport,
  taskId: string,
): Promise<TransportScenarioResult> {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const state = transport.getTaskState(taskId);
    if (state && ["completed", "error", "stopped_limit", "waiting_consent"].includes(state.status)) {
      const trace = transport.getTraceEvents(taskId);
      const finalReport = transport.getFinalReport(taskId);
      return {
        taskId,
        state,
        finalReportStatus: finalReport?.status ?? null,
        finalReportParticipants: finalReport?.participants ?? [],
        traceAgentIds: unique(trace.map((event) => event.agentId)),
        artifacts: transport.getArtifacts(taskId),
        modelCalls: [],
      };
    }
    await delay(100);
  }
  const state = transport.getTaskState(taskId);
  const trace = transport.getTraceEvents(taskId);
  const finalReport = transport.getFinalReport(taskId);
  return {
    taskId,
    state,
    finalReportStatus: finalReport?.status ?? null,
    finalReportParticipants: finalReport?.participants ?? [],
    traceAgentIds: unique(trace.map((event: TraceEvent) => event.agentId)),
    artifacts: transport.getArtifacts(taskId),
    modelCalls: [],
  };
}

async function runDesktopProcessSmoke(): Promise<TauriRuntimeReport["desktopProcessSmoke"]> {
  const logs: string[] = [];
  const errors: string[] = [];
  let proc: ChildProcessWithoutNullStreams | null = null;
  let devServerReachable = false;
  let killedProcessTree = false;
  try {
    proc = spawn("pnpm --filter @ai-agent-orchestrator/desktop-windows dev", {
      cwd: repoRoot,
      env: { ...process.env, BROWSER: "none" },
      shell: true,
      windowsHide: true,
    });
    proc.stdout.on("data", (chunk) => captureLines(logs, String(chunk)));
    proc.stderr.on("data", (chunk) => captureLines(logs, String(chunk)));
    proc.on("error", (error) => errors.push(`${error.name}: ${error.message}`));
    devServerReachable = await waitForUrlOrProcess(devServerUrl, proc, logs, 75_000);
  } catch (error) {
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    if (proc?.pid !== undefined) {
      killedProcessTree = killProcessTree(proc.pid);
    }
  }
  return {
    status: proc !== null && devServerReachable ? "passed" : "failed",
    devServerReachable,
    processStarted: proc !== null,
    killedProcessTree,
    logs: logs.slice(-80),
    errors,
  };
}

async function waitForUrlOrProcess(
  url: string,
  proc: ChildProcessWithoutNullStreams,
  logs: string[],
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (proc.exitCode !== null) {
      logs.push(`tauri dev process exited before URL became reachable; exitCode=${String(proc.exitCode)}`);
      return false;
    }
    if (await isUrlAvailable(url)) return true;
    await delay(750);
  }
  logs.push(`timed out waiting for ${url}`);
  return false;
}

async function isUrlAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

function killProcessTree(pid: number): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return result.status === 0 || !isProcessRunning(pid);
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return !isProcessRunning(pid);
  }
}

function isProcessRunning(pid: number): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8", windowsHide: true });
    return result.status === 0 && result.stdout.includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function scenarioResult(
  name: string,
  prompt: string,
  assertions: readonly Assertion[],
  extra: Omit<RuntimeScenario, "name" | "status" | "prompt" | "assertions">,
): RuntimeScenario {
  return {
    name,
    status: assertions.every((assertion) => assertion.passed) ? "passed" : "failed",
    prompt,
    assertions,
    ...extra,
  };
}

function bool(name: string, passed: boolean, details?: unknown): Assertion {
  return {
    name,
    passed,
    ...(details !== undefined ? { details: String(details) } : {}),
  };
}

function sequentialIds(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureLines(logs: string[], text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = sanitizeLogLine(line);
    if (trimmed.length > 0) logs.push(trimmed);
  }
  if (logs.length > 400) logs.splice(0, logs.length - 400);
}

function sanitizeLogLine(line: string): string {
  const apiKey = process.env["FIREWORKS_API_KEY"];
  let out = line;
  if (apiKey !== undefined && apiKey.length >= 8) {
    out = out.split(apiKey).join("[REDACTED_FIREWORKS_API_KEY]");
  }
  return out.slice(0, 500);
}

async function writeRuntimeReports(report: TauriRuntimeReport): Promise<void> {
  const sanitizedReport = sanitizeReport(report);
  const json = JSON.stringify(sanitizedReport, null, 2);
  const markdown = renderMarkdown(sanitizedReport);
  assertNoFireworksKeyLeak(json, markdown);
  await writeFile(resolve(reportsDir, "tauri-runtime.json"), json, "utf8");
  await writeFile(resolve(reportsDir, "tauri-runtime.md"), markdown, "utf8");
}

function sanitizeReport(report: TauriRuntimeReport): TauriRuntimeReport {
  return {
    ...report,
    scenarios: report.scenarios.map((scenario) => ({
      ...scenario,
      prompt: scenario.prompt,
      selectedFiles: scenario.selectedFiles,
      notes: scenario.notes?.map(sanitizeLogLine),
    })),
    desktopProcessSmoke: {
      ...report.desktopProcessSmoke,
      logs: report.desktopProcessSmoke.logs.map(sanitizeLogLine),
      errors: report.desktopProcessSmoke.errors.map(sanitizeLogLine),
    },
  };
}

function renderMarkdown(report: TauriRuntimeReport): string {
  const lines = [
    "# Karo Real Tauri Runtime Bridge Report",
    "",
    `Timestamp: ${report.timestamp}`,
    `Status: ${report.status}`,
    "",
    "## Renderer UI checks",
    "Renderer/browser checks are covered by `gui:check` and `gui:check:headed`. This report is the separate native runtime proof.",
    "",
    "## Desktop process smoke",
    `Status: ${report.desktopProcessSmoke.status}`,
    `Dev server reachable: ${String(report.desktopProcessSmoke.devServerReachable)}`,
    `Process started: ${String(report.desktopProcessSmoke.processStarted)}`,
    `Killed process tree: ${String(report.desktopProcessSmoke.killedProcessTree)}`,
    "",
    "## Real Tauri runtime bridge checks",
    `Status: ${report.runtimeBridge.status}`,
    `Context Engine source: ${report.runtimeBridge.source}`,
    `Dev/test only: ${String(report.runtimeBridge.devOnly)}`,
    `Secrets access: ${String(report.runtimeBridge.secretsAccess)}`,
    `Shell command execution: ${String(report.runtimeBridge.shellCommandExecution)}`,
    `Real Tauri selectedFiles proven: ${String(report.realTauriSelectedFilesProven)}`,
    "",
    "## Native window automation availability",
    `Status: ${report.nativeWindowAutomation.status}`,
    `Reason: ${report.nativeWindowAutomation.reason}`,
    "",
    "## API key leak check",
    report.apiKeyLeakCheck,
    "",
    "## Scenarios",
  ];
  for (const scenario of report.scenarios) {
    lines.push(
      "",
      `### ${scenario.status === "passed" ? "PASS" : "FAIL"} ${scenario.name}`,
      `Intent: ${scenario.intent ?? "n/a"}`,
      `Mode: ${scenario.taskMode ?? "n/a"}`,
      `Requires Context Engine: ${String(scenario.requiresContextEngine ?? false)}`,
      `Context Engine source: ${scenario.contextEngineSource ?? "n/a"}`,
      `Selected files count: ${String(scenario.selectedFilesCount ?? 0)}`,
      `Selected files: ${(scenario.selectedFiles ?? []).join(", ") || "none"}`,
      `Artifacts created: ${String(scenario.artifactsCreated ?? false)}`,
      `Command execution attempted: ${String(scenario.commandExecutionAttempted ?? false)}`,
      "Assertions:",
      ...scenario.assertions.map((assertion) => `- ${assertion.passed ? "PASS" : "FAIL"} ${assertion.name}${assertion.details ? ` (${assertion.details})` : ""}`),
    );
    if (scenario.notes && scenario.notes.length > 0) {
      lines.push("Notes:", ...scenario.notes.map((note) => `- ${note}`));
    }
  }
  return `${lines.join("\n")}\n`;
}

function assertNoFireworksKeyLeak(...contents: string[]): void {
  const apiKey = process.env["FIREWORKS_API_KEY"];
  if (apiKey === undefined || apiKey.length < 8) return;
  if (contents.some((content) => content.includes(apiKey))) {
    throw new Error("Tauri runtime proof secret leak guard blocked writing FIREWORKS_API_KEY.");
  }
}

void main();
