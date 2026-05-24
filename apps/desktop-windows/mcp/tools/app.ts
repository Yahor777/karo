import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface KaroAutomationOptions {
  readonly headed?: boolean;
  readonly baseUrl?: string;
  readonly repoRoot?: string;
  readonly appRoot?: string;
}

export interface DevServerResult {
  readonly started: boolean;
  readonly reusedExisting: boolean;
  readonly url: string;
  readonly pid?: number;
  readonly logs: readonly string[];
}

export interface KaroAutomationState {
  readonly baseUrl: string;
  readonly repoRoot: string;
  readonly appRoot: string;
  readonly screenshotsDir: string;
  readonly reportsDir: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class KaroAutomationContext {
  readonly state: KaroAutomationState;
  private readonly headed: boolean;
  private devProcess: ChildProcess | null = null;
  private browser: Browser | null = null;
  private browserContext: BrowserContext | null = null;
  private pageRef: Page | null = null;
  private logs: string[] = [];

  constructor(options: KaroAutomationOptions = {}) {
    const appRoot = options.appRoot ?? resolve(__dirname, "..", "..");
    const repoRoot = options.repoRoot ?? resolve(appRoot, "..", "..");
    this.headed = options.headed ?? false;
    this.state = {
      baseUrl: options.baseUrl ?? "http://127.0.0.1:1420",
      repoRoot,
      appRoot,
      screenshotsDir: resolve(appRoot, "e2e-artifacts", "screenshots"),
      reportsDir: resolve(appRoot, "e2e-artifacts", "reports"),
    };
  }

  get page(): Page {
    if (this.pageRef === null) throw new Error("Karo app is not open. Call karo_open_app first.");
    return this.pageRef;
  }

  async ensureArtifactDirs(): Promise<void> {
    await mkdir(this.state.screenshotsDir, { recursive: true });
    await mkdir(this.state.reportsDir, { recursive: true });
  }

  async startDevServer(timeoutMs = 90_000): Promise<DevServerResult> {
    await this.ensureArtifactDirs();
    if (await isUrlAvailable(this.state.baseUrl)) {
      return {
        started: true,
        reusedExisting: true,
        url: this.state.baseUrl,
        logs: this.logs.slice(-80),
      };
    }
    if (this.devProcess !== null) {
      await waitForUrl(this.state.baseUrl, timeoutMs);
      return {
        started: true,
        reusedExisting: false,
        url: this.state.baseUrl,
        pid: this.devProcess.pid,
        logs: this.logs.slice(-80),
      };
    }

    this.devProcess = spawn("pnpm --filter @ai-agent-orchestrator/desktop-windows dev:renderer", {
      cwd: this.state.repoRoot,
      env: { ...process.env, BROWSER: "none" },
      shell: true,
      windowsHide: true,
    });
    this.devProcess.stdout?.on("data", (chunk) => this.captureLog(String(chunk)));
    this.devProcess.stderr?.on("data", (chunk) => this.captureLog(String(chunk)));
    this.devProcess.on("exit", (code, signal) => {
      this.captureLog(`dev server exited code=${String(code)} signal=${String(signal)}`);
      this.devProcess = null;
    });

    await waitForUrl(this.state.baseUrl, timeoutMs);
    return {
      started: true,
      reusedExisting: false,
      url: this.state.baseUrl,
      pid: this.devProcess?.pid,
      logs: this.logs.slice(-80),
    };
  }

  async stopDevServer(): Promise<{ stopped: boolean; logs: readonly string[] }> {
    await this.closeBrowser();
    if (this.devProcess === null) return { stopped: false, logs: this.logs.slice(-80) };
    const proc = this.devProcess;
    this.devProcess = null;
    if (process.platform === "win32" && proc.pid !== undefined) {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    } else {
      proc.kill("SIGTERM");
    }
    return { stopped: true, logs: this.logs.slice(-80) };
  }

  async openApp(pathname = "/"): Promise<{ url: string; title: string }> {
    await this.ensureArtifactDirs();
    if (this.browser === null) {
      this.browser = await chromium.launch({ headless: !this.headed });
      this.browserContext = await this.browser.newContext({
        viewport: { width: 1366, height: 768 },
        deviceScaleFactor: 1,
      });
      await this.browserContext.addInitScript(() => {
        const key = "aiao::apiKeyMeta:fireworks";
        if (window.localStorage.getItem(key) === null) {
          window.localStorage.setItem(
            key,
            JSON.stringify({
              provider: "fireworks",
              fingerprint: "mcp-gui",
              modelId: "accounts/fireworks/models/deepseek-v4-pro",
              savedAt: new Date().toISOString(),
            }),
          );
        }
      });
    }
    if (this.pageRef === null) {
      this.pageRef = await this.browserContext!.newPage();
    }
    const url = new URL(pathname, this.state.baseUrl).toString();
    await this.pageRef.goto(url, { waitUntil: "domcontentloaded" });
    await this.ensureWorkspaceScreen();
    return { url: this.pageRef.url(), title: await this.pageRef.title() };
  }

  async reloadApp(): Promise<{ url: string }> {
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await this.ensureWorkspaceScreen();
    return { url: this.page.url() };
  }

  async closeBrowser(): Promise<void> {
    await this.browserContext?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.browserContext = null;
    this.browser = null;
    this.pageRef = null;
  }

  async dispose(): Promise<void> {
    await this.stopDevServer();
  }

  getRecentLogs(): readonly string[] {
    return this.logs.slice(-100);
  }

  private captureLog(line: string): void {
    for (const part of line.split(/\r?\n/)) {
      if (part.trim().length > 0) this.logs.push(part);
    }
    if (this.logs.length > 500) this.logs = this.logs.slice(-500);
  }

  private async ensureWorkspaceScreen(): Promise<void> {
    const appRoot = this.page.locator('[data-testid="app-root"]');
    if (await appRoot.isVisible({ timeout: 5_000 }).catch(() => false)) return;

    const continueButton = this.page.locator(".welcome-continue").first();
    if (await continueButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await continueButton.click();
      await appRoot.waitFor({ timeout: 30_000 });
      return;
    }

    await this.page.evaluate(() => {
      window.localStorage.setItem(
        "aiao::apiKeyMeta:fireworks",
        JSON.stringify({
          provider: "fireworks",
          fingerprint: "mcp-gui",
          modelId: "accounts/fireworks/models/deepseek-v4-pro",
          savedAt: new Date().toISOString(),
        }),
      );
    });
    await this.page.reload({ waitUntil: "domcontentloaded" });
    if (await continueButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await continueButton.click();
    }
    await appRoot.waitFor({ timeout: 30_000 });
  }
}

export async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await isUrlAvailable(url)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}. Last error: ${String(lastError ?? "unavailable")}`);
}

async function isUrlAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}
