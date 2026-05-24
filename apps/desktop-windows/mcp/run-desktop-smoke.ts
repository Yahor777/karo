#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface DesktopSmokeReport {
  readonly timestamp: string;
  readonly status: "passed" | "failed";
  readonly repoRoot: string;
  readonly appRoot: string;
  readonly command: string;
  readonly processStarted: boolean;
  readonly processPid?: number;
  readonly devServerUrl: string;
  readonly devServerReachable: boolean;
  readonly desktopWindowAutomation: {
    readonly status: "unavailable";
    readonly reason: string;
  };
  readonly tauriRuntimeContextProof: {
    readonly selectedFilesGreaterThanZero: "not_proven";
    readonly reason: string;
  };
  readonly cleanup: {
    readonly attempted: boolean;
    readonly killedProcessTree: boolean;
  };
  readonly durationMs: number;
  readonly logs: readonly string[];
  readonly errors: readonly string[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, "..");
const repoRoot = resolve(appRoot, "..", "..");
const reportsDir = resolve(appRoot, "e2e-artifacts", "reports");
const devServerUrl = "http://127.0.0.1:1420";

async function main(): Promise<void> {
  const startedAt = Date.now();
  await mkdir(reportsDir, { recursive: true });
  const logs: string[] = [];
  const errors: string[] = [];
  let proc: ChildProcessWithoutNullStreams | null = null;
  let killedProcessTree = false;
  let devServerReachable = false;

  try {
    proc = spawn("pnpm --filter @ai-agent-orchestrator/desktop-windows dev", {
      cwd: repoRoot,
      env: { ...process.env, BROWSER: "none" },
      shell: true,
      windowsHide: true,
    });
    proc.stdout.on("data", (chunk) => captureLines(logs, String(chunk)));
    proc.stderr.on("data", (chunk) => captureLines(logs, String(chunk)));
    proc.on("error", (error) => {
      errors.push(`${error.name}: ${error.message}`);
      captureLines(logs, `tauri dev spawn error: ${error.message}`);
    });
    proc.on("exit", (code, signal) => {
      captureLines(logs, `tauri dev exited code=${String(code)} signal=${String(signal)}`);
    });

    devServerReachable = await waitForUrlOrProcess(devServerUrl, proc, logs, 75_000);
  } catch (error) {
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    if (proc?.pid !== undefined) {
      killedProcessTree = killProcessTree(proc.pid);
    }
  }

  const report: DesktopSmokeReport = {
    timestamp: new Date().toISOString(),
    status: proc !== null && devServerReachable ? "passed" : "failed",
    repoRoot,
    appRoot,
    command: "pnpm --filter @ai-agent-orchestrator/desktop-windows dev",
    processStarted: proc !== null,
    ...(proc?.pid !== undefined ? { processPid: proc.pid } : {}),
    devServerUrl,
    devServerReachable,
    desktopWindowAutomation: {
      status: "unavailable",
      reason:
        "This smoke starts the real Tauri dev flow and verifies the renderer dev server, but Playwright cannot control the native Tauri window in this harness yet.",
    },
    tauriRuntimeContextProof: {
      selectedFilesGreaterThanZero: "not_proven",
      reason:
        "The desktop smoke does not drive the native window far enough to submit the Apply Changes explain prompt. Real Tauri selectedFiles > 0 remains unproven by automation.",
    },
    cleanup: {
      attempted: proc !== null,
      killedProcessTree,
    },
    durationMs: Date.now() - startedAt,
    logs: logs.slice(-120),
    errors,
  };

  await writeDesktopReports(report);
  console.log(JSON.stringify({
    event: "desktop_smoke",
    status: report.status,
    devServerReachable: report.devServerReachable,
    desktopWindowAutomation: report.desktopWindowAutomation.status,
    desktopReportJson: resolve(reportsDir, "desktop-smoke.json"),
    desktopReportMd: resolve(reportsDir, "desktop-smoke.md"),
  }, null, 2));
  process.exit(report.status === "passed" ? 0 : 1);
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

async function writeDesktopReports(report: DesktopSmokeReport): Promise<void> {
  const json = JSON.stringify(report, null, 2);
  const markdown = renderMarkdown(report);
  assertNoFireworksKeyLeak(json, markdown);
  await writeFile(resolve(reportsDir, "desktop-smoke.json"), json, "utf8");
  await writeFile(resolve(reportsDir, "desktop-smoke.md"), markdown, "utf8");
}

function renderMarkdown(report: DesktopSmokeReport): string {
  return [
    "# Karo Desktop Smoke Report",
    "",
    `Timestamp: ${report.timestamp}`,
    `Status: ${report.status}`,
    `Command: ${report.command}`,
    `Dev server: ${report.devServerReachable ? "reachable" : "not reachable"} (${report.devServerUrl})`,
    `Desktop window automation: ${report.desktopWindowAutomation.status}`,
    `Desktop reason: ${report.desktopWindowAutomation.reason}`,
    `Real Tauri selectedFiles > 0: ${report.tauriRuntimeContextProof.selectedFilesGreaterThanZero}`,
    `Context proof reason: ${report.tauriRuntimeContextProof.reason}`,
    `Cleanup attempted: ${String(report.cleanup.attempted)}`,
    `Killed process tree: ${String(report.cleanup.killedProcessTree)}`,
    `Duration: ${report.durationMs}ms`,
    "",
    "## Errors",
    report.errors.length > 0 ? report.errors.map((error) => `- ${error}`).join("\n") : "- none",
    "",
    "## Recent logs",
    ...report.logs.slice(-40).map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function assertNoFireworksKeyLeak(...contents: string[]): void {
  const apiKey = process.env["FIREWORKS_API_KEY"];
  if (apiKey === undefined || apiKey.length < 8) return;
  if (contents.some((content) => content.includes(apiKey))) {
    throw new Error("Desktop smoke secret leak guard blocked writing FIREWORKS_API_KEY.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
