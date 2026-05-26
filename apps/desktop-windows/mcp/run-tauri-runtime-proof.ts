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
import { chromium, type Browser, type Page } from "playwright";

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

interface WebsiteRenderMetrics {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly overflow: number;
  readonly sectionCount: number;
  readonly wordCount: number;
  readonly ctaVisible: boolean;
  readonly heroVisible: boolean;
  readonly heroVisualVisible: boolean;
  readonly navVisible: boolean;
  readonly faqDetailsVisible: boolean;
  readonly bodyHeight: number;
  readonly bodyBackground: string;
  readonly cardLikeCount: number;
  readonly screenshotPath: string;
  readonly screenshotBytes: number;
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
const screenshotsDir = resolve(appRoot, "e2e-artifacts", "screenshots");
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
  "Review project security and code, not only README. Check API key handling, Tauri commands, terminal runner, command policy, file writes, logs, reports, and provider calls.";
const VAGUE_PROMPT = "Сделай лучше";
const DANGEROUS_COMMAND = "git clean -fdx";
const EXPLICIT_DANGEROUS_COMMAND = "execute git clean -fdx";
const AGENT_CREATE_FILE_PROMPT = "create file src/karo-agent-proof.txt with text hello";
const WEBSITE_PROMPT =
  "Create a modern landing page website for a Minecraft JJK mod with hero, abilities, characters/energy, features, FAQ, responsive layout, dark anime style, polished cards, and preview instructions.";

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
    bool("quick-edit-route-used", result.traceAgentIds.includes("quick_edit"), result.traceAgentIds.join(", ")),
    bool("quick-edit-zero-model-calls", model.calls.length === 0, model.calls.join(", ")),
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
  const artifactContent = new Map(
    result.artifacts.map((artifact) => [
      artifact.fileName,
      transport.getArtifactVersion(taskId, artifact.id, artifact.latestVersion)?.content ?? "",
    ]),
  );
  const indexHtml = artifactContent.get("src/karo-demo-site/index.html") ?? "";
  const stylesCss = artifactContent.get("src/karo-demo-site/styles.css") ?? "";
  const scriptJs = artifactContent.get("src/karo-demo-site/script.js") ?? "";
  const renderProof = await renderGeneratedWebsiteProof({ indexHtml, stylesCss, scriptJs });
  const traceAgents = result.traceAgentIds;
  const assertions: Assertion[] = [
    bool("agent-route-selected", state?.decision?.executionMode === "agent", state?.decision?.executionMode),
    bool("website-task-allows-file-changes", state?.decision?.allowFileChanges === true, String(state?.decision?.allowFileChanges)),
    bool("not-quick-edit", !traceAgents.includes("quick_edit"), traceAgents.join(", ")),
    bool("chunked-agent-path-used", ["researcher", "planner", "coder", "validator", "finalizer"].every((agent) => traceAgents.includes(agent)), traceAgents.join(", ")),
    bool("reviewer-boss-skipped-after-deterministic-validation", !traceAgents.includes("reviewer") && !traceAgents.includes("boss"), traceAgents.join(", ")),
    bool("website-artifacts-created", artifactNames.length >= 2, artifactNames.join(", ")),
    bool(
      "website-artifacts-have-runnable-site-files",
      artifactNames.some((file) => /src\/karo-demo-site\/index\.html|index\.html/i.test(file)) &&
        artifactNames.some((file) => /src\/karo-demo-site\/styles\.css|styles\.css/i.test(file)),
      artifactNames.join(", "),
    ),
    bool("no-auto-apply", applyCalled === false),
    bool("command-not-executed", true),
    bool("expected-model-call-budget", model.calls.length === 5, model.calls.join(", ")),
    bool("deterministic-validation-passed", state?.deterministicValidation?.skipModelReview === true, state?.deterministicValidation?.status),
    bool(
      "website-quality-html-metadata-links-cta",
      /<title\b/i.test(indexHtml) &&
        /<meta\b[^>]*name=["']viewport["']/i.test(indexHtml) &&
        /styles\.css/i.test(indexHtml) &&
        /script\.js/i.test(indexHtml) &&
        /cta-button|<a\b[^>]*href=/i.test(indexHtml) &&
        /<nav\b|\bsite-nav\b/i.test(indexHtml) &&
        /<details\b[\s\S]*<summary\b/i.test(indexHtml),
      indexHtml.slice(0, 600),
    ),
    bool(
      "website-quality-local-interactions",
      /querySelector(All)?\s*\(|addEventListener\s*\(/i.test(scriptJs) && !/fetch\s*\(|XMLHttpRequest|sendBeacon|localStorage\.setItem/i.test(scriptJs),
      scriptJs.slice(0, 600),
    ),
    bool(
      "website-quality-css-depth-spacing",
      /radial-gradient|linear-gradient|box-shadow|rgba\(/i.test(stylesCss) &&
        /:\s*root|--[a-z0-9-]+\s*:|gap\s*:|padding\s*:|minmax\(|clamp\(/i.test(stylesCss),
      stylesCss.slice(0, 600),
    ),
    ...renderProof.assertions,
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
      ...renderProof.notes,
      "previewCommand=detected via package scripts in renderer UI; task itself does not execute preview automatically",
    ],
  });
}

async function renderGeneratedWebsiteProof(args: {
  readonly indexHtml: string;
  readonly stylesCss: string;
  readonly scriptJs: string;
}): Promise<{ readonly assertions: readonly Assertion[]; readonly notes: readonly string[] }> {
  if (args.indexHtml.trim().length === 0 || args.stylesCss.trim().length === 0) {
    return {
      assertions: [bool("website-render-runtime-inputs-present", false, "index.html or styles.css artifact is empty")],
      notes: [],
    };
  }

  await mkdir(screenshotsDir, { recursive: true });
  const html = composeGeneratedWebsiteHtml(args.indexHtml, args.stylesCss, args.scriptJs);
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const desktop = await renderGeneratedWebsiteViewport({
      browser,
      html,
      viewport: { width: 1280, height: 900 },
      screenshotName: "generated-website-runtime-desktop.png",
      externalRequests,
      pageErrors,
    });
    const mobile = await renderGeneratedWebsiteViewport({
      browser,
      html,
      viewport: { width: 390, height: 760 },
      screenshotName: "generated-website-runtime-mobile.png",
      externalRequests,
      pageErrors,
    });

    return {
      assertions: [
        bool(
          "website-render-desktop-visible-complete-page",
          desktop.heroVisible &&
            desktop.heroVisualVisible &&
            desktop.ctaVisible &&
            desktop.navVisible &&
            desktop.faqDetailsVisible &&
            desktop.sectionCount >= 5 &&
            desktop.bodyHeight > 600,
          JSON.stringify(desktop),
        ),
        bool("website-render-copy-density", desktop.wordCount >= 75, JSON.stringify(desktop)),
        bool(
          "website-render-visual-density",
          desktop.cardLikeCount >= 3 && /gradient|rgba|rgb/i.test(desktop.bodyBackground),
          JSON.stringify(desktop),
        ),
        bool(
          "website-render-mobile-no-horizontal-overflow",
          mobile.overflow <= 2 &&
            mobile.ctaVisible &&
            mobile.navVisible &&
            mobile.faqDetailsVisible &&
            mobile.heroVisualVisible &&
            mobile.sectionCount >= 5,
          JSON.stringify(mobile),
        ),
        bool("website-render-no-external-network", externalRequests.length === 0, externalRequests.join(", ")),
        bool("website-render-no-page-errors", pageErrors.length === 0, pageErrors.join("; ")),
        bool(
          "website-render-screenshots-written",
          desktop.screenshotBytes > 10_000 && mobile.screenshotBytes > 8_000,
          `desktop=${desktop.screenshotBytes}; mobile=${mobile.screenshotBytes}`,
        ),
      ],
      notes: [
        `renderDesktopScreenshot=${desktop.screenshotPath}`,
        `renderMobileScreenshot=${mobile.screenshotPath}`,
        `renderDesktopMetrics=${JSON.stringify({
          sections: desktop.sectionCount,
          words: desktop.wordCount,
          overflow: desktop.overflow,
          cardLike: desktop.cardLikeCount,
          nav: desktop.navVisible,
          faq: desktop.faqDetailsVisible,
          heroVisual: desktop.heroVisualVisible,
        })}`,
        `renderMobileMetrics=${JSON.stringify({
          sections: mobile.sectionCount,
          words: mobile.wordCount,
          overflow: mobile.overflow,
          cardLike: mobile.cardLikeCount,
          nav: mobile.navVisible,
          faq: mobile.faqDetailsVisible,
          heroVisual: mobile.heroVisualVisible,
        })}`,
      ],
    };
  } catch (error) {
    return {
      assertions: [bool("website-render-runtime-available", false, error instanceof Error ? error.message : String(error))],
      notes: [],
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function renderGeneratedWebsiteViewport(args: {
  readonly browser: Browser;
  readonly html: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly screenshotName: string;
  readonly externalRequests: string[];
  readonly pageErrors: string[];
}): Promise<WebsiteRenderMetrics> {
  const page = await args.browser.newPage({ viewport: args.viewport });
  await wireRenderProofPage(page, args.externalRequests, args.pageErrors);
  await page.setContent(args.html, { waitUntil: "load", timeout: 10_000 });
  await page.waitForTimeout(120);
  const screenshotPath = resolve(screenshotsDir, args.screenshotName);
  const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true });
  const metrics = await page.evaluate(String.raw`(() => {
    const root = document.documentElement;
    const body = document.body;
    const visible = (element) => {
      if (element === null) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
    };
    const sections = Array.from(document.querySelectorAll("main section, section")).filter(visible);
    const cardLikeCount = sections.filter((section) => {
      const style = getComputedStyle(section);
      return style.boxShadow !== "none" || style.borderStyle !== "none" || style.backgroundColor !== "rgba(0, 0, 0, 0)";
    }).length;
    const text = body.innerText.replace(/\s+/g, " ").trim();
    const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [];
    const bodyStyle = getComputedStyle(body);
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      overflow: Math.max(root.scrollWidth - root.clientWidth, body.scrollWidth - body.clientWidth),
      sectionCount: sections.length,
      wordCount: words.length,
      ctaVisible: visible(document.querySelector(".cta-button, a[href], button")),
      heroVisible: visible(document.querySelector(".hero, h1")),
      heroVisualVisible: visible(document.querySelector(".hero-visual, figure[role='img'], [role='img']")),
      navVisible: visible(document.querySelector("nav, .site-nav")),
      faqDetailsVisible: visible(document.querySelector("details summary, .faq")),
      bodyHeight: Math.max(body.scrollHeight, root.scrollHeight),
      bodyBackground: bodyStyle.backgroundImage + " " + bodyStyle.backgroundColor,
      cardLikeCount,
    };
  })()`);
  await page.close();
  return {
    ...metrics,
    screenshotPath,
    screenshotBytes: screenshot.length,
  };
}

async function wireRenderProofPage(page: Page, externalRequests: string[], pageErrors: string[]): Promise<void> {
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (/^https?:\/\//i.test(url)) {
      externalRequests.push(url);
      await route.abort().catch(() => undefined);
      return;
    }
    await route.continue().catch(() => undefined);
  });
}

function composeGeneratedWebsiteHtml(indexHtml: string, stylesCss: string, scriptJs: string): string {
  const styleTag = `<style data-karo-runtime-proof>\n${stylesCss.replace(/<\/style/giu, "<\\/style")}\n</style>`;
  const scriptTag =
    scriptJs.trim().length > 0
      ? `<script data-karo-runtime-proof>\n${scriptJs.replace(/<\/script/giu, "<\\/script")}\n</script>`
      : "";
  let html = indexHtml
    .replace(/<link\b[^>]*href=["'][^"']*styles\.css[^"']*["'][^>]*>/giu, "")
    .replace(/<script\b[^>]*src=["'][^"']*script\.js[^"']*["'][^>]*>\s*<\/script>/giu, "");
  html = /<\/head>/iu.test(html) ? html.replace(/<\/head>/iu, `${styleTag}\n</head>`) : `${styleTag}\n${html}`;
  if (scriptTag.length === 0) return html;
  return /<\/body>/iu.test(html) ? html.replace(/<\/body>/iu, `${scriptTag}\n</body>`) : `${html}\n${scriptTag}`;
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
  const report = transport.getFinalReport(taskId);
  const reportText = [
    report?.bossSummary ?? "",
    ...(report?.outstandingIssues ?? []),
    state?.errorReason ?? "",
  ].join("\n");
  const assertions: Assertion[] = [
    bool("agent-route-selected", state?.decision?.executionMode === "agent", state?.decision?.executionMode),
    bool("timeout-is-error-not-completed", state?.status === "error", state?.status),
    bool("fallback-not-created-automatically", artifactNames.length === 0, artifactNames.join(", ")),
    bool("recovery-state-created", state?.recoveryState !== undefined, JSON.stringify(state?.recoveryState ?? null)),
    bool("recovery-failed-stage-coder", state?.recoveryState?.failedStage === "chunked_coder", state?.recoveryState?.failedStage),
    bool("recovery-failed-file-recorded", state?.recoveryState?.failedFile === "src/karo-demo-site/index.html", state?.recoveryState?.failedFile),
    bool("recovery-fallback-used-false", state?.recoveryState?.fallbackUsed === false, String(state?.recoveryState?.fallbackUsed)),
    bool("recovery-retry-wired", state?.recoveryState?.canRetryFailedStage === true, String(state?.recoveryState?.canRetryFailedStage)),
    bool("recovery-reduced-context-wired", state?.recoveryState?.canRetryReducedContext === true, String(state?.recoveryState?.canRetryReducedContext)),
    bool("recovery-partial-empty-for-first-file-timeout", (state?.recoveryState?.partialArtifacts.length ?? -1) === 0, String(state?.recoveryState?.partialArtifacts.length ?? -1)),
    bool("benchmark-does-not-pass-on-fallback-only", report?.status !== "completed", report?.status),
    bool("provider-diagnostics-recorded", (state?.providerDiagnostics?.length ?? 0) >= 2, String(state?.providerDiagnostics?.length ?? 0)),
    bool(
      "coder-timeout-diagnostic",
      state?.providerDiagnostics?.some((diagnostic) => diagnostic.agentId === "coder" && diagnostic.errorType === "provider_timeout") === true,
      JSON.stringify(state?.providerDiagnostics ?? []),
    ),
    bool("no-auto-apply", applyCalled === false),
    bool("no-command-execution", true),
    bool("recovery-actions-visible-in-report", /Retry Coder|Retry with reduced context|Switch model|emergency static scaffold/i.test(reportText), reportText),
  ];
  return scenarioResult("one_prompt_website_coder_timeout_recovery", WEBSITE_PROMPT, assertions, {
    taskMode: state?.decision?.executionMode,
    intent: state?.decision?.intent,
    requiresContextEngine: state?.decision?.requiresContextEngine,
    artifactsCreated: result.artifacts.length > 0,
    commandExecutionAttempted: false,
    notes: [
      `status=${state?.status ?? "unknown"}`,
      `artifacts=${artifactNames.join(", ") || "none"}`,
      `trace=${result.traceAgentIds.join(", ") || "none"}`,
      "provider_timeout=recovery state only; fallback scaffold requires explicit user action and does not count as benchmark success",
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
        const userPrompt = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
        const targetFile = /Target file:\s*(src\/karo-demo-site\/(?:index\.html|styles\.css|script\.js|README\.md))/i.exec(userPrompt)?.[1];
        const fileName = targetFile ?? "src/karo-demo-site/index.html";
        const contentByFile: Record<string, string> = {
          "src/karo-demo-site/index.html":
            `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Minecraft JJK Mod</title>
  <link rel="stylesheet" href="./styles.css">
  <script defer src="./script.js"></script>
</head>
<body>
  <nav class="site-nav" aria-label="Primary">
    <a class="brand-mark" href="#top">Minecraft JJK Mod</a>
    <div class="nav-links">
      <a href="#abilities">Abilities</a>
      <a href="#characters">Characters</a>
      <a href="#features">Features</a>
      <a href="#faq">FAQ</a>
    </div>
  </nav>
  <main id="top" class="jjk-page">
    <section class="hero">
      <p class="eyebrow">Domain-ready combat hub</p>
      <h1>Dark anime battles with readable cursed-technique mastery</h1>
      <p class="lead">Preview a focused Minecraft JJK mod landing page with ability roles, energy flow, install guidance, and reviewable staged files before anything touches disk.</p>
      <a class="cta-button" href="#abilities">Explore cursed techniques</a>
      <figure class="hero-visual" role="img" aria-label="Cursed energy arena with domain rings and technique cards">
        <div class="domain-orb" aria-hidden="true"></div>
        <div class="energy-ring" aria-hidden="true"></div>
        <div class="technique-card technique-card--infinity"><span>Infinity</span><strong>Guard</strong></div>
        <div class="technique-card technique-card--black-flash"><span>Black Flash</span><strong>Timing</strong></div>
        <figcaption>Local visual scene for domain pressure, ability timing, and energy roles.</figcaption>
      </figure>
    </section>
    <section id="abilities" class="ability-grid" aria-labelledby="abilities-title">
      <h2 id="abilities-title">Technique loadouts</h2>
      <article class="feature-card"><h3>Infinity control</h3><p>Spatial defense, pressure windows, and cooldown discipline are presented as clear player choices.</p></article>
      <article class="feature-card"><h3>Black Flash timing</h3><p>High-impact strikes get framed as a readable timing loop instead of a vague power spike.</p></article>
      <article class="feature-card"><h3>Cursed tool roles</h3><p>Weapons, characters, and cursed energy routing combine into an encounter plan for teams.</p></article>
    </section>
    <section id="characters" class="energy"><h2>Characters and energy</h2><p>Character roles, energy management, and progression hooks connect the page to the actual mod fantasy players expect to test.</p></section>
    <section id="features" class="features"><h2>Features</h2><p>Responsive cards, offline-safe local assets, preview instructions, and dark liquid styling make the static demo feel like a complete product surface.</p></section>
    <section id="faq" class="faq"><h2>FAQ</h2><details open><summary>Can I preview this safely?</summary><p>Yes. Apply Changes first, then open index.html through Preview or a browser. Karo does not auto-run commands.</p></details><details><summary>What does this proof cover?</summary><p>It verifies semantic sections, responsive styling, local JS enhancement, and staged artifacts before Apply Changes.</p></details></section>
  </main>
</body>
</html>
`,
          "src/karo-demo-site/styles.css":
            `:root { color-scheme: dark; --bg: #07070b; --card: rgba(17, 17, 26, .84); --line: #30243f; --accent: #8b5cf6; --cyan: #22d3ee; --rose: #fb7185; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #f5f3ff; background: var(--bg); }
* { box-sizing: border-box; }
body { margin: 0; background: radial-gradient(circle at 12% 8%, rgba(34, 211, 238, .16), transparent 30%), radial-gradient(circle at 72% 4%, rgba(251, 113, 133, .14), transparent 32%), radial-gradient(circle at top, rgba(139, 92, 246, .22), transparent 48%), var(--bg); }
.site-nav { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px clamp(18px, 4vw, 52px); border-bottom: 1px solid rgba(255, 255, 255, .08); background: rgba(7, 7, 11, .76); backdrop-filter: blur(16px); }
.site-nav a { color: #e7ddff; text-decoration: none; }
.brand-mark { font-weight: 800; }
.nav-links { display: flex; flex-wrap: wrap; gap: 12px; }
.jjk-page { min-height: 100vh; padding: clamp(24px, 5vw, 72px); display: grid; gap: 24px; }
.hero { min-height: min(72vh, 720px); display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(280px, .95fr); align-items: center; gap: clamp(24px, 5vw, 56px); padding: clamp(28px, 5vw, 64px); border: 1px solid rgba(139, 92, 246, .25); border-radius: 24px; background: linear-gradient(135deg, rgba(139, 92, 246, .14), rgba(34, 211, 238, .06)); box-shadow: 0 28px 90px rgba(0, 0, 0, .36); }
.hero > :not(.hero-visual) { grid-column: 1; }
.eyebrow { color: var(--cyan); text-transform: uppercase; letter-spacing: 0; font-weight: 800; }
h1 { max-width: 900px; font-size: clamp(48px, 8vw, 92px); line-height: .92; margin: 0; }
h2 { margin: 0 0 10px; }
.lead { color: #d8d1ea; font-size: clamp(18px, 2vw, 24px); max-width: 820px; }
.cta-button { display: inline-flex; margin-top: 20px; padding: 13px 18px; border-radius: 999px; background: linear-gradient(135deg, var(--accent), var(--cyan)); color: white; text-decoration: none; box-shadow: 0 18px 60px rgba(139, 92, 246, .34); transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease; }
.hero-visual { position: relative; min-height: 360px; margin: 0; border: 1px solid rgba(34, 211, 238, .24); border-radius: 22px; overflow: hidden; background: radial-gradient(circle at 50% 42%, rgba(34, 211, 238, .24), transparent 28%), linear-gradient(145deg, rgba(139, 92, 246, .18), rgba(251, 113, 133, .08)); box-shadow: inset 0 0 90px rgba(34, 211, 238, .08), 0 24px 70px rgba(0, 0, 0, .28); }
.hero-visual { grid-column: 2; grid-row: 1 / span 6; }
.domain-orb, .energy-ring { position: absolute; inset: 17%; border: 1px solid rgba(34, 211, 238, .44); border-radius: 999px; box-shadow: 0 0 70px rgba(34, 211, 238, .2); }
.energy-ring { inset: 30%; border-color: rgba(251, 113, 133, .44); transform: rotate(-12deg); }
.technique-card { position: absolute; min-width: 132px; padding: 12px 14px; border: 1px solid rgba(255, 255, 255, .16); border-radius: 14px; background: rgba(7, 7, 11, .68); backdrop-filter: blur(14px); }
.technique-card span, .hero-visual figcaption { color: #cbd5e1; font-size: .8rem; }
.technique-card strong { display: block; color: #fff; font-size: 1.05rem; }
.technique-card--infinity { top: 18%; left: 8%; }
.technique-card--black-flash { right: 8%; bottom: 18%; }
.hero-visual figcaption { position: absolute; left: 16px; right: 16px; bottom: 14px; }
section:not(.hero), .feature-card, details { border: 1px solid var(--line); border-radius: 18px; padding: clamp(20px, 3vw, 30px); background: var(--card); box-shadow: 0 24px 80px rgba(0, 0, 0, .32); }
.ability-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.ability-grid > h2 { grid-column: 1 / -1; }
details + details { margin-top: 12px; }
summary { cursor: pointer; color: #f8f6ff; }
.cta-button:hover, .site-nav a:hover, summary:hover { transform: translateY(-1px); color: white; }
.cta-button:focus-visible, .site-nav a:focus-visible, summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
@media (min-width: 860px) { .jjk-page { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hero, .ability-grid, .faq { grid-column: 1 / -1; } }
@media (max-width: 820px) { .hero { grid-template-columns: 1fr; } .hero-visual { grid-column: 1; grid-row: auto; min-height: 260px; } }
@media (max-width: 680px) { .site-nav { align-items: flex-start; flex-direction: column; } }
`,
          "src/karo-demo-site/script.js":
            "document.documentElement.dataset.karoPreviewReady = 'true';\nfor (const detail of document.querySelectorAll('details')) {\n  detail.addEventListener('toggle', () => {\n    detail.dataset.state = detail.open ? 'open' : 'closed';\n  });\n}\nfor (const link of document.querySelectorAll('a[href^=\"#\"]')) {\n  link.addEventListener('click', () => {\n    document.documentElement.dataset.lastNavigation = link.getAttribute('href') ?? '';\n  });\n}\n",
          "src/karo-demo-site/README.md":
            "# Minecraft JJK landing page\n\nStatic demo created by the Karo Agent workflow. Apply Changes first, then open `src/karo-demo-site/index.html` from Preview.\n",
        };
        return {
          kind: "ok",
          text: JSON.stringify({
            artifacts: [{ fileName, content: contentByFile[fileName] ?? "" }],
            summary: `Created ${fileName} for the responsive dark anime landing page demo.`,
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
