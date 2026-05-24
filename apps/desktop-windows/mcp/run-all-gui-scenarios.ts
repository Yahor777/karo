#!/usr/bin/env node
import { KaroAutomationContext } from "./tools/app.js";
import { ALL_SCENARIOS, runAllGuiScenarios } from "./tools/scenarios.js";

const args = new Set(process.argv.slice(2));
const headed = args.has("--headed");

async function main(): Promise<void> {
  const ctx = new KaroAutomationContext({ headed });
  let exitCode = 0;
  try {
    const started = await ctx.startDevServer();
    console.log(JSON.stringify({ event: "dev_server", ...started }, null, 2));
    await ctx.openApp();
    const report = await runAllGuiScenarios(ctx);
    console.log(JSON.stringify({
      event: "gui_report",
      passed: report.passed,
      scenarios: report.scenarios.map((scenario) => ({
        name: scenario.name,
        passed: scenario.passed,
        errors: scenario.errors,
      })),
      liveProviderSmoke: report.liveProviderSmoke,
      latestJson: `${report.reportsDir}\\latest.json`,
      latestMd: `${report.reportsDir}\\latest.md`,
      reportMd: `${report.reportsDir}\\report.md`,
    }, null, 2));
    if (!report.passed) exitCode = 1;
  } catch (error) {
    exitCode = 1;
    console.error(JSON.stringify({
      event: "gui_check_failed",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      availableScenarios: ALL_SCENARIOS.map(([name]) => name),
    }, null, 2));
  } finally {
    await ctx.dispose().catch(() => undefined);
  }
  process.exit(exitCode);
}

void main();
