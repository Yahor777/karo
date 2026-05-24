#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KaroAutomationContext } from "./tools/app.js";
import {
  karoClick,
  karoFill,
  karoGetAppDiagnostics,
  karoGetBoundingBox,
  karoGetHtml,
  karoGetText,
  karoGetVisibleState,
  karoHover,
  karoPress,
  karoSelect,
} from "./tools/browser.js";
import { karoScreenshot, karoScreenshotElement } from "./tools/screenshots.js";
import {
  assertComposerUsable,
  assertContextPopoverNotInComposer,
  assertElementInsideViewport,
  assertNoDuplicateUserMessages,
  assertNoHorizontalOverflow,
  assertNotVisible,
  assertResponsiveLayoutQuality,
  assertTextContains,
  assertVisible,
} from "./tools/assertions.js";
import {
  runAllGuiScenarios,
  runScenarioBoot,
  runScenarioCasualChat,
  runScenarioClarification,
  runScenarioComposer,
  runScenarioContextPopover,
  runScenarioDangerousCommand,
  runScenarioModelSwitching,
  runScenarioPlanMode,
  runScenarioProjectExplain,
  runScenarioResponsiveLayout,
  runScenarioRightPanelTabs,
  runScenarioSecurityReview,
  runScenarioSidebarConversations,
  runScenarioWorkspacePages,
} from "./tools/scenarios.js";

const ctx = new KaroAutomationContext({
  headed: process.argv.includes("--headed"),
});

const server = new McpServer({
  name: "karo-ui-automation",
  version: "0.1.0",
});

const selectorShape = {
  selector: z.string().optional(),
  testId: z.string().optional(),
};

function asText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

server.registerTool(
  "karo_start_dev_server",
  {
    title: "Start Karo dev renderer",
    description: "Starts the Karo Vite renderer dev server and waits until it is reachable.",
    inputSchema: { timeoutMs: z.number().int().positive().optional() },
  },
  async ({ timeoutMs }) => asText(await ctx.startDevServer(timeoutMs)),
);

server.registerTool(
  "karo_stop_dev_server",
  {
    title: "Stop Karo dev renderer",
    description: "Stops the dev server and browser instances started by this MCP server.",
    inputSchema: {},
  },
  async () => asText(await ctx.stopDevServer()),
);

server.registerTool(
  "karo_open_app",
  {
    title: "Open Karo app",
    description: "Opens Karo in a Playwright browser context and returns basic state.",
    inputSchema: { path: z.string().optional() },
  },
  async ({ path }) => asText(await ctx.openApp(path ?? "/")),
);

server.registerTool(
  "karo_reload_app",
  {
    title: "Reload Karo app",
    description: "Reloads the current Karo page.",
    inputSchema: {},
  },
  async () => asText(await ctx.reloadApp()),
);

server.registerTool(
  "karo_click",
  { title: "Click UI", description: "Clicks an element by selector or data-testid.", inputSchema: selectorShape },
  async (input) => asText(await karoClick(ctx, input)),
);

server.registerTool(
  "karo_fill",
  {
    title: "Fill UI",
    description: "Fills an input or textarea by selector or data-testid.",
    inputSchema: { ...selectorShape, text: z.string() },
  },
  async (input) => asText(await karoFill(ctx, input)),
);

server.registerTool(
  "karo_press",
  { title: "Press key", description: "Presses a keyboard key.", inputSchema: { key: z.string() } },
  async (input) => asText(await karoPress(ctx, input)),
);

server.registerTool(
  "karo_select",
  {
    title: "Select option",
    description: "Selects an option inside a labelled composer select wrapper.",
    inputSchema: { ...selectorShape, value: z.string() },
  },
  async (input) => asText(await karoSelect(ctx, input)),
);

server.registerTool(
  "karo_hover",
  { title: "Hover UI", description: "Hovers an element by selector or data-testid.", inputSchema: selectorShape },
  async (input) => asText(await karoHover(ctx, input)),
);

server.registerTool(
  "karo_screenshot",
  {
    title: "Screenshot",
    description: "Captures a full-page screenshot into e2e-artifacts/screenshots.",
    inputSchema: { name: z.string().optional(), fullPage: z.boolean().optional() },
  },
  async (input) => asText(await karoScreenshot(ctx, input)),
);

server.registerTool(
  "karo_screenshot_element",
  {
    title: "Element screenshot",
    description: "Captures a screenshot of one element.",
    inputSchema: { ...selectorShape, name: z.string().optional() },
  },
  async (input) => asText(await karoScreenshotElement(ctx, input)),
);

server.registerTool("karo_get_text", {
  title: "Get text",
  description: "Reads textContent from an element.",
  inputSchema: { ...selectorShape, all: z.boolean().optional() },
}, async (input) => asText(await karoGetText(ctx, input)));

server.registerTool("karo_get_html", {
  title: "Get HTML",
  description: "Reads outerHTML and optionally writes it to a report file.",
  inputSchema: { ...selectorShape, fileName: z.string().optional() },
}, async (input) => asText(await karoGetHtml(ctx, input)));

server.registerTool("karo_get_bounding_box", {
  title: "Get bounding box",
  description: "Returns element coordinates.",
  inputSchema: selectorShape,
}, async (input) => asText(await karoGetBoundingBox(ctx, input)));

server.registerTool("karo_get_visible_state", {
  title: "Get visible state",
  description: "Checks element visibility and count.",
  inputSchema: selectorShape,
}, async (input) => asText(await karoGetVisibleState(ctx, input)));

server.registerTool("karo_get_app_diagnostics", {
  title: "Get app diagnostics",
  description: "Reads available Karo debug/local state without secrets.",
  inputSchema: {},
}, async () => asText(await karoGetAppDiagnostics(ctx)));

server.registerTool("karo_assert_visible", {
  title: "Assert visible",
  description: "Asserts an element is visible.",
  inputSchema: selectorShape,
}, async (input) => asText(await assertVisible(ctx, input)));

server.registerTool("karo_assert_not_visible", {
  title: "Assert not visible",
  description: "Asserts an element is not visible.",
  inputSchema: selectorShape,
}, async (input) => asText(await assertNotVisible(ctx, input)));

server.registerTool("karo_assert_text_contains", {
  title: "Assert text contains",
  description: "Asserts an element contains text.",
  inputSchema: { ...selectorShape, text: z.string() },
}, async (input) => asText(await assertTextContains(ctx, input)));

server.registerTool("karo_assert_no_horizontal_overflow", {
  title: "Assert no horizontal overflow",
  description: "Checks document/body horizontal overflow.",
  inputSchema: {},
}, async () => asText(await assertNoHorizontalOverflow(ctx)));

server.registerTool("karo_assert_element_inside_viewport", {
  title: "Assert element inside viewport",
  description: "Checks element bounds are inside viewport.",
  inputSchema: selectorShape,
}, async (input) => asText(await assertElementInsideViewport(ctx, input)));

server.registerTool("karo_assert_composer_usable", {
  title: "Assert composer usable",
  description: "Checks textarea and send button are visible and sized.",
  inputSchema: {},
}, async () => asText(await assertComposerUsable(ctx)));

server.registerTool("karo_assert_context_popover_not_in_composer", {
  title: "Assert context popover portal",
  description: "Checks Context Usage popover is not nested inside composer or chat timeline.",
  inputSchema: {},
}, async () => asText(await assertContextPopoverNotInComposer(ctx)));

server.registerTool("karo_assert_no_duplicate_user_messages", {
  title: "Assert no duplicate user messages",
  description: "Checks visible user messages for duplicate text.",
  inputSchema: {},
}, async () => asText(await assertNoDuplicateUserMessages(ctx)));

server.registerTool("karo_assert_responsive_layout_quality", {
  title: "Assert responsive layout quality",
  description: "Checks composer size, chat width, compact sidebar/right-panel behavior, send reachability, and overflow.",
  inputSchema: {},
}, async () => asText(await assertResponsiveLayoutQuality(ctx)));

const scenarioTools = {
  karo_run_scenario_boot: runScenarioBoot,
  karo_run_scenario_sidebar_conversations: runScenarioSidebarConversations,
  karo_run_scenario_context_popover: runScenarioContextPopover,
  karo_run_scenario_casual_chat: runScenarioCasualChat,
  karo_run_scenario_clarification: runScenarioClarification,
  karo_run_scenario_plan_mode: runScenarioPlanMode,
  karo_run_scenario_project_explain: runScenarioProjectExplain,
  karo_run_scenario_security_review: runScenarioSecurityReview,
  karo_run_scenario_dangerous_command: runScenarioDangerousCommand,
  karo_run_scenario_model_switching: runScenarioModelSwitching,
  karo_run_scenario_workspace_pages: runScenarioWorkspacePages,
  karo_run_scenario_responsive_layout: runScenarioResponsiveLayout,
};

for (const [name, run] of Object.entries(scenarioTools)) {
  server.registerTool(name, {
    title: name,
    description: `Runs GUI scenario ${name.replace("karo_run_scenario_", "")}.`,
    inputSchema: {},
  }, async () => asText(await run(ctx)));
}

server.registerTool("karo_run_scenario_right_panel_tabs", {
  title: "Run right panel tabs scenario",
  description: "Clicks Preview/Changes/Diff/Files/Logs/Usage/Terminal.",
  inputSchema: {},
}, async () => asText(await runScenarioRightPanelTabs(ctx)));

server.registerTool("karo_run_all_gui_scenarios", {
  title: "Run all GUI scenarios",
  description: "Runs the full MCP GUI automation scenario suite and writes latest.json/latest.md.",
  inputSchema: {},
}, async () => asText(await runAllGuiScenarios(ctx)));

const transport = new StdioServerTransport();
await server.connect(transport);
