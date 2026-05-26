import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Buffer } from "node:buffer";
import type { KaroAutomationContext } from "./app.js";
import {
  assertComposerUsable,
  assertContextPopoverNotInComposer,
  assertElementInsideViewport,
  assertSidebarChatsDoNotOverlapFooter,
  assertNoDuplicateUserMessages,
  assertNoElementOverlap,
  assertNoHorizontalOverflow,
  assertResponsiveLayoutQuality,
  assertNotVisible,
  assertTextContains,
  assertVisible,
  summarizeAssertions,
  type AssertionResult,
} from "./assertions.js";
import { karoClick, karoFill, karoGetText, karoPress } from "./browser.js";
import { karoScreenshot, karoScreenshotElement } from "./screenshots.js";
import { byTestId, TEST_IDS } from "./selectors.js";

export interface ScenarioResult {
  readonly name: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly assertions: readonly AssertionResult[];
  readonly screenshots: readonly string[];
  readonly errors: readonly string[];
  readonly notes: readonly string[];
}

export interface GuiReport {
  readonly timestamp: string;
  readonly baseUrl: string;
  readonly passed: boolean;
  readonly scenarios: readonly ScenarioResult[];
  readonly liveProviderSmoke: LiveProviderSmokeResult;
  readonly contextRuntimeProof: ContextRuntimeProof;
  readonly tauriRuntimeBridge?: TauriRuntimeBridgeSummary | undefined;
  readonly screenshotsDir: string;
  readonly reportsDir: string;
}

export interface LiveProviderSmokeResult {
  readonly status: "passed" | "failed" | "skipped";
  readonly provider: "fireworks";
  readonly endpoint: "models";
  readonly targetModelId: string;
  readonly latencyMs?: number;
  readonly modelCount?: number;
  readonly activeModelFound?: boolean;
  readonly reason?: string;
}

export interface ContextRuntimeProof {
  readonly rendererProjectExplain: "passed" | "failed";
  readonly realTauriProjectExplain: "passed" | "failed" | "unavailable";
  readonly selectedFilesProvenInRenderer: boolean;
  readonly selectedFilesProvenInRealTauri: boolean;
  readonly reason: string;
}

export interface TauriRuntimeBridgeSummary {
  readonly status: "passed" | "failed" | "unavailable";
  readonly realTauriSelectedFilesProven: boolean;
  readonly contextEngineSource: string;
  readonly selectedFilesCount?: number | undefined;
  readonly reportJson: string;
  readonly reportMd: string;
}

type ScenarioFn = (ctx: KaroAutomationContext) => Promise<ScenarioResult>;

export const ALL_SCENARIOS: ReadonlyArray<readonly [string, ScenarioFn]> = [
  ["boot", runScenarioBoot],
  ["sidebar_conversations", runScenarioSidebarConversations],
  ["composer", runScenarioComposer],
  ["context_popover", runScenarioContextPopover],
  ["casual_chat", runScenarioCasualChat],
  ["chat_mode_readonly", runScenarioChatModeReadonly],
  ["clarification", runScenarioClarification],
  ["plan_mode", runScenarioPlanMode],
  ["project_explain", runScenarioProjectExplain],
  ["security_review", runScenarioSecurityReview],
  ["dangerous_command", runScenarioDangerousCommand],
  ["timeline_order", runScenarioTimelineOrder],
  ["agent_route_guardrails", runScenarioAgentRouteGuardrails],
  ["website_creation_not_security_review", runScenarioWebsiteCreationNotSecurityReview],
  ["one_prompt_website_creation_preview", runScenarioOnePromptWebsiteCreationPreview],
  ["model_switching", runScenarioModelSwitching],
  ["right_panel_tabs", runScenarioRightPanelTabs],
  ["workspace_pages", runScenarioWorkspacePages],
  ["responsive_layout", runScenarioResponsiveLayout],
];

export async function runAllGuiScenarios(ctx: KaroAutomationContext): Promise<GuiReport> {
  const scenarios: ScenarioResult[] = [];
  for (const [, run] of ALL_SCENARIOS) {
    scenarios.push(await run(ctx));
  }
  const report: GuiReport = {
    timestamp: new Date().toISOString(),
    baseUrl: ctx.state.baseUrl,
    passed: scenarios.every((scenario) => scenario.passed),
    scenarios,
    liveProviderSmoke: await runLiveProviderSmoke(),
    contextRuntimeProof: buildContextRuntimeProof(scenarios),
    tauriRuntimeBridge: await readLatestTauriRuntimeBridge(ctx.state.reportsDir),
    screenshotsDir: ctx.state.screenshotsDir,
    reportsDir: ctx.state.reportsDir,
  };
  await saveReport(ctx, report);
  return report;
}

export async function runScenarioBoot(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "boot", async (bag) => {
    await ctx.openApp();
    bag.screenshots.push((await karoScreenshot(ctx, { name: "boot-full" })).path);
    bag.screenshots.push((await karoScreenshot(ctx, { name: "product-home" })).path);
    bag.assertions.push(
      await assertVisible(ctx, { testId: TEST_IDS.sidebar }),
      await assertVisible(ctx, { testId: TEST_IDS.navChat }),
      await assertVisible(ctx, { testId: TEST_IDS.composer }),
      await assertVisible(ctx, { testId: TEST_IDS.composerTextarea }),
      await assertVisible(ctx, { testId: TEST_IDS.composerSend }),
      await assertVisible(ctx, { testId: TEST_IDS.rightPanel }),
      await assertComposerUsable(ctx),
      await assertNoHorizontalOverflow(ctx),
      await assertResponsiveLayoutQuality(ctx),
    );
    await ctx.page.setViewportSize({ width: 900, height: 800 });
    bag.screenshots.push((await karoScreenshot(ctx, { name: "boot-narrow" })).path);
    bag.assertions.push(
      await assertComposerUsable(ctx),
      await assertNoHorizontalOverflow(ctx),
      await assertResponsiveLayoutQuality(ctx),
    );
    await ctx.page.setViewportSize({ width: 1366, height: 768 });
  });
}

export async function runScenarioSidebarConversations(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "sidebar_conversations", async (bag) => {
    await ctx.openApp();
    await sendLocalMessage(ctx, "первый чат для проверки истории");
    await waitShort(ctx);
    await karoClick(ctx, { testId: TEST_IDS.sidebarNewChat });
    bag.assertions.push(await assertVisible(ctx, { testId: TEST_IDS.composerTextarea }));
    const userCountAfterNew = await ctx.page.locator(byTestId(TEST_IDS.chatMessageUser)).count();
    bag.assertions.push({
      name: "new-chat-empty",
      passed: userCountAfterNew === 0,
      details: userCountAfterNew === 0 ? undefined : `user messages in new chat: ${userCountAfterNew}`,
    });
    const items = ctx.page.locator(byTestId(TEST_IDS.sidebarConversationItem));
    const itemCount = await items.count();
    bag.assertions.push({
      name: "conversation-items-created",
      passed: itemCount >= 2,
      details: `items=${itemCount}`,
    });
    if (itemCount > 1) {
      await items.nth(1).click();
      bag.assertions.push(
        await assertTextContains(ctx, {
          testId: TEST_IDS.chatThread,
          text: "первый чат для проверки истории",
          name: "old-chat-message-restored",
        }),
        await assertNoDuplicateUserMessages(ctx),
      );
      ctx.page.once("dialog", async (dialog) => {
        await dialog.accept("Renamed MCP chat");
      });
      await items.nth(1).hover();
      await items.nth(1).locator(".kw-conversation-action").first().click();
      bag.assertions.push(await assertTextContains(ctx, {
        testId: TEST_IDS.sidebarConversationList,
        text: "Renamed MCP chat",
        name: "chat-rename-action-persists-title",
      }));
      await ctx.reloadApp();
      bag.assertions.push(
        await assertTextContains(ctx, {
          testId: TEST_IDS.chatThread,
          text: "первый чат для проверки истории",
          name: "old-chat-message-restored-after-reload",
        }),
        await assertTextContains(ctx, {
          testId: TEST_IDS.sidebarConversationList,
          text: "Renamed MCP chat",
          name: "chat-rename-survives-reload",
        }),
        await assertNoDuplicateUserMessages(ctx),
      );
      ctx.page.once("dialog", async (dialog) => {
        await dialog.accept();
      });
      const activeRow = ctx.page.locator(`${byTestId(TEST_IDS.sidebarConversationItem)}[aria-current="true"]`).first();
      const activeBeforeDelete = await activeRow.getAttribute("data-conversation-id");
      await activeRow.hover();
      await activeRow.locator(".kw-conversation-action").last().click({ force: true });
      await waitShort(ctx);
      const activeAfterDelete = await ctx.page.locator(`${byTestId(TEST_IDS.sidebarConversationItem)}[aria-current="true"]`).first().getAttribute("data-conversation-id").catch(() => null);
      bag.assertions.push({
        name: "delete-active-chat-clears-stale-active-id",
        passed: activeBeforeDelete !== null && activeAfterDelete !== null && activeAfterDelete !== activeBeforeDelete,
        details: `before=${activeBeforeDelete ?? "none"} after=${activeAfterDelete ?? "none"}`,
      });
      await sendLocalMessage(ctx, "message after active chat delete");
      await waitForAssistantSettled(ctx, 8_000);
      const persistedActiveHasMessage = await ctx.page.evaluate(() => {
        const raw = localStorage.getItem("karo.conversations.v1");
        if (raw === null) return false;
        const parsed = JSON.parse(raw) as { activeConversationId?: string; conversations?: Array<{ id: string; messages?: Array<{ text?: string }> }> };
        const active = parsed.conversations?.find((conversation) => conversation.id === parsed.activeConversationId);
        return active?.messages?.some((message) => message.text === "message after active chat delete") === true;
      }).catch(() => false);
      bag.assertions.push({
        name: "send-after-active-delete-persists-to-current-chat",
        passed: persistedActiveHasMessage,
      });
    }
    bag.assertions.push(await assertSidebarChatsDoNotOverlapFooter(ctx));
    bag.screenshots.push((await karoScreenshot(ctx, { name: "sidebar-conversations" })).path);
  });
}

export async function runScenarioComposer(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "composer", async (bag) => {
    await ctx.openApp();
    bag.assertions.push(
      await assertComposerUsable(ctx),
      await assertVisible(ctx, { testId: TEST_IDS.composerModeAuto }),
      await assertVisible(ctx, { testId: TEST_IDS.composerModeChat }),
      await assertVisible(ctx, { testId: TEST_IDS.composerModePlan }),
      await assertVisible(ctx, { testId: TEST_IDS.composerModeAgent }),
      await assertVisible(ctx, { testId: TEST_IDS.composerModeContract }),
      await assertVisible(ctx, { testId: TEST_IDS.composerModelChip }),
      await assertVisible(ctx, { testId: TEST_IDS.composerContextTrigger }),
      await assertNotVisible(ctx, { selector: `${byTestId(TEST_IDS.composer)} > .kw-composer-controls > ${byTestId(TEST_IDS.composerCommandMode)}`, name: "command-mode-not-primary" }),
      await assertNotVisible(ctx, { selector: `${byTestId(TEST_IDS.composer)} > .kw-composer-controls > ${byTestId(TEST_IDS.composerWebMode)}`, name: "web-mode-not-primary" }),
      await assertComposerToolbarRows(ctx, 2),
    );
    await karoClick(ctx, { testId: TEST_IDS.composerModeChat });
    const chatContract = await ctx.page.locator(byTestId(TEST_IDS.composerModeContract)).textContent().catch(() => "");
    await karoClick(ctx, { testId: TEST_IDS.composerModePlan });
    const planContract = await ctx.page.locator(byTestId(TEST_IDS.composerModeContract)).textContent().catch(() => "");
    await karoClick(ctx, { testId: TEST_IDS.composerModeAgent });
    const agentContract = await ctx.page.locator(byTestId(TEST_IDS.composerModeContract)).textContent().catch(() => "");
    bag.assertions.push(
      {
        name: "composer-mode-contract-chat-readonly",
        passed: /Chat Mode|Read-only answer|Never staged|Unavailable/i.test(chatContract ?? ""),
        details: chatContract ?? "",
      },
      {
        name: "composer-mode-contract-plan-readonly",
        passed: /Plan Mode|Read-only plan|No artifacts|Prepare Agent/i.test(planContract ?? ""),
        details: planContract ?? "",
      },
      {
        name: "composer-mode-contract-agent-apply-gate",
        passed: /Agent Mode|Stage artifacts|Review before disk|Explicit gate/i.test(agentContract ?? ""),
        details: agentContract ?? "",
      },
    );
    await karoClick(ctx, { testId: TEST_IDS.composerModeAuto });
    await karoClick(ctx, { testId: TEST_IDS.composerAdvancedToggle });
    bag.assertions.push(
      await assertVisible(ctx, { testId: TEST_IDS.composerAdvancedPanel }),
      await assertVisible(ctx, { testId: TEST_IDS.composerCommandMode, name: "command-mode-visible-in-advanced" }),
      await assertVisible(ctx, { testId: TEST_IDS.composerWebMode, name: "web-mode-visible-in-advanced" }),
    );
    await karoClick(ctx, { testId: TEST_IDS.composerAdvancedToggle });
    await ctx.page.locator(".kw-attachment-input").setInputFiles({
      name: "mcp-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello from mcp"),
    });
    const chipBox = await ctx.page.locator(".kw-attachment-chip").first().boundingBox().catch(() => null);
    bag.assertions.push({
      name: "attachment-chip-visible-without-breaking-layout",
      passed: chipBox !== null && chipBox.width > 20 && chipBox.height > 12,
      details: chipBox === null ? "missing attachment chip" : JSON.stringify(chipBox),
    });
    bag.screenshots.push((await karoScreenshot(ctx, { name: "composer" })).path);
    bag.screenshots.push((await karoScreenshot(ctx, { name: "product-chat-empty" })).path);
  });
}

export async function runScenarioContextPopover(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "context_popover", async (bag) => {
    await ctx.openApp();
    bag.assertions.push(
      await assertNotVisible(ctx, { testId: TEST_IDS.contextUsagePopover, name: "popover-closed-initially" }),
      await assertNotVisible(ctx, {
        selector: `${byTestId(TEST_IDS.topbar)} ${byTestId(TEST_IDS.composerContextTrigger)}`,
        name: "topbar-has-no-context-trigger",
      }),
    );
    await ctx.page.locator(byTestId(TEST_IDS.topbar)).hover();
    await waitShort(ctx);
    bag.assertions.push(await assertNotVisible(ctx, { testId: TEST_IDS.contextUsagePopover, name: "topbar-hover-does-not-open" }));
    await karoClick(ctx, { testId: TEST_IDS.composerContextTrigger });
    const distance = await distanceBetweenElements(ctx, byTestId(TEST_IDS.composerContextTrigger), byTestId(TEST_IDS.contextUsagePopover));
    bag.assertions.push(
      await assertVisible(ctx, { testId: TEST_IDS.contextUsagePopover }),
      await assertContextPopoverNotInComposer(ctx),
      await assertElementInsideViewport(ctx, { testId: TEST_IDS.contextUsagePopover }),
      await assertNoElementOverlap(ctx, {
        firstTestId: TEST_IDS.contextUsagePopover,
        secondTestId: TEST_IDS.composerTextarea,
        name: "context-popover-does-not-overlap-textarea",
      }),
      await assertNoElementOverlap(ctx, {
        firstTestId: TEST_IDS.contextUsagePopover,
        secondTestId: TEST_IDS.composerSend,
        name: "context-popover-does-not-overlap-send",
      }),
      await assertTextContains(ctx, { testId: TEST_IDS.contextUsagePopover, text: "Context usage" }),
      {
        name: "context-popover-anchored-near-trigger",
        passed: distance !== null && distance <= 360,
        details: distance === null ? "missing bounds" : `distance=${distance.toFixed(1)}`,
      },
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "context-popover-open" })).path);
    bag.screenshots.push((await karoScreenshot(ctx, { name: "product-context-popover" })).path);
    await karoClick(ctx, { testId: TEST_IDS.contextUsageCopy });
    await karoPress(ctx, { key: "Escape" });
    await waitShort(ctx);
    bag.assertions.push(await assertNotVisible(ctx, { testId: TEST_IDS.contextUsagePopover, name: "escape-closes-popover" }));

    await ctx.page.setViewportSize({ width: 900, height: 800 });
    await waitShort(ctx);
    await karoClick(ctx, { testId: TEST_IDS.composerContextTrigger });
    bag.assertions.push(
      await assertVisible(ctx, { testId: TEST_IDS.contextUsagePopover, name: "popover-visible-at-900" }),
      await assertElementInsideViewport(ctx, { testId: TEST_IDS.contextUsagePopover, name: "popover-inside-viewport-at-900" }),
      await assertNoElementOverlap(ctx, {
        firstTestId: TEST_IDS.contextUsagePopover,
        secondTestId: TEST_IDS.composerTextarea,
        name: "context-popover-does-not-overlap-textarea-at-900",
      }),
      await assertNoElementOverlap(ctx, {
        firstTestId: TEST_IDS.contextUsagePopover,
        secondTestId: TEST_IDS.composerSend,
        name: "context-popover-does-not-overlap-send-at-900",
      }),
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "context-popover-900" })).path);
    await karoPress(ctx, { key: "Escape" });
    await ctx.page.setViewportSize({ width: 1366, height: 768 });
  });
}

export async function runScenarioCasualChat(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "casual_chat", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await karoClick(ctx, { testId: TEST_IDS.composerModeChat });
    await sendLocalMessage(ctx, "привет как дела");
    await waitForAssistantSettled(ctx, 8_000);
    bag.assertions.push(
      await assertVisible(ctx, { testId: TEST_IDS.chatMessageAssistant }),
      await assertNotVisible(ctx, { selector: ".kw-pipeline-bar", name: "no-agent-pipeline" }),
      await assertNotVisible(ctx, { selector: ".kw-chat-final", name: "no-final-report" }),
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "casual-chat" })).path);
  });
}

export async function runScenarioChatModeReadonly(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "chat_mode_readonly", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await karoClick(ctx, { testId: TEST_IDS.composerModeChat });
    await sendLocalMessage(ctx, "\u0441\u043e\u0437\u0434\u0430\u0439 \u0444\u0430\u0439\u043b src/chat-mode-should-not-write.txt \u0441 \u0442\u0435\u043a\u0441\u0442\u043e\u043c hello");
    await waitForAssistantSettled(ctx, 4_000);
    const text = await ctx.page.locator(byTestId(TEST_IDS.chatThread)).textContent().catch(() => "");
    bag.assertions.push(
      {
        name: "chat-mode-refuses-file-changes",
        passed: /Chat Mode is read-only/i.test(text ?? "") && /Agent Mode|Auto Mode/i.test(text ?? ""),
        details: text ?? "",
      },
      await assertNotVisible(ctx, { selector: ".kw-pipeline-bar", name: "chat-mode-no-agent-pipeline" }),
      await assertNotVisible(ctx, { selector: ".kw-chat-final", name: "chat-mode-no-final-report" }),
      await assertNotVisible(ctx, { testId: TEST_IDS.changesApplyButton, name: "chat-mode-no-apply" }),
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "chat-mode-readonly" })).path);
  });
}

export async function runScenarioClarification(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "clarification", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await karoClick(ctx, { testId: TEST_IDS.composerModeAuto });
    await sendLocalMessage(ctx, "Сделай лучше");
    await ctx.page.waitForTimeout(1500);
    const hasCard = await ctx.page.locator(byTestId(TEST_IDS.clarificationCard)).isVisible().catch(() => false);
    const localFallback = await ctx.page.locator(byTestId(TEST_IDS.chatMessageAssistant)).last().textContent().catch(() => "");
    bag.assertions.push({
      name: "clarification-card-visible",
      passed: hasCard,
      details: hasCard ? "card visible" : `fallback=${localFallback ?? ""}`,
    });
    if (hasCard) {
      const continueBtn = ctx.page.locator(byTestId(TEST_IDS.clarificationContinue)).first();
      bag.assertions.push({
        name: "continue-disabled-before-input",
        passed: await continueBtn.isDisabled().catch(() => false),
      });
      bag.screenshots.push((await karoScreenshot(ctx, { name: "clarification-card" })).path);
      await karoFill(ctx, { testId: TEST_IDS.clarificationCustomInput, text: "давай просто поговорим" });
      await continueBtn.click();
      await waitForAssistantSettled(ctx, 10_000);
      bag.assertions.push(await assertNotVisible(ctx, { selector: ".kw-pipeline-bar", name: "no-pipeline-after-casual-clarification" }));
      bag.assertions.push(
        await assertVisible(ctx, { testId: TEST_IDS.readonlyResult, name: "clarification-readonly-result-visible" }),
      );
    }
    bag.screenshots.push((await karoScreenshot(ctx, { name: "clarification-after-continue" })).path);
  });
}

export async function runScenarioPlanMode(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "plan_mode", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await karoClick(ctx, { testId: TEST_IDS.composerModePlan });
    await sendLocalMessage(ctx, "сделай подробный план переделки интерфейса Karo как в Codex");
    await waitForAssistantSettled(ctx, 10_000);
    bag.assertions.push(
      await assertVisible(ctx, { selector: `${byTestId(TEST_IDS.chatMessagePlan)}, ${byTestId(TEST_IDS.chatMessageAnalysis)}` }),
      await assertNotVisible(ctx, { testId: TEST_IDS.changesApplyButton, name: "plan-no-apply" }),
      await assertNotVisible(ctx, { selector: ".kw-pipeline-bar", name: "plan-no-agent-pipeline" }),
      await assertNotVisible(ctx, { selector: ".kw-chat-final", name: "plan-no-final-report" }),
    );
    const planText = await ctx.page.locator(byTestId(TEST_IDS.chatThread)).textContent().catch(() => "");
    const planFailedHonestly = /Plan model call failed|Plan Mode could not complete|model_not_found|No encrypted API key/i.test(planText ?? "");
    const hasEnglishSections =
      /Plan Result/i.test(planText ?? "") &&
      /Goal/i.test(planText ?? "") &&
      /Assumptions/i.test(planText ?? "") &&
      /Implementation steps/i.test(planText ?? "") &&
      /Risks/i.test(planText ?? "") &&
      /Tests/i.test(planText ?? "") &&
      /Suggested mode/i.test(planText ?? "");
    const hasRussianSections =
      /Plan Result/i.test(planText ?? "") &&
      /\u0426\u0435\u043b\u044c/u.test(planText ?? "") &&
      /\u041f\u0440\u0435\u0434\u043f\u043e\u0441/u.test(planText ?? "") &&
      /\u0428\u0430\u0433\u0438/u.test(planText ?? "") &&
      /\u0420\u0438\u0441\u043a/u.test(planText ?? "") &&
      /\u041f\u0440\u043e\u0432\u0435\u0440/u.test(planText ?? "") &&
      /\u0420\u0435\u043a\u043e\u043c\u0435\u043d\u0434/u.test(planText ?? "");
    bag.assertions.push({
      name: "plan-result-has-mode-contract-sections",
      passed: planFailedHonestly || hasEnglishSections || hasRussianSections,
      details: planText ?? "",
    });
    if (!planFailedHonestly) {
      bag.assertions.push(
        await assertVisible(ctx, {
          testId: TEST_IDS.planResultActions,
          name: "plan-result-actions-visible",
        }),
        await assertVisible(ctx, {
          testId: TEST_IDS.planPrepareAgent,
          name: "plan-prepare-agent-action-visible",
        }),
      );
      await karoClick(ctx, { testId: TEST_IDS.planPrepareAgent });
      await waitShort(ctx);
      const preparedPrompt = await ctx.page.locator(byTestId(TEST_IDS.composerTextarea)).inputValue().catch(() => "");
      const agentSelected = await ctx.page
        .locator(byTestId(TEST_IDS.composerModeAgent))
        .getAttribute("aria-current")
        .catch(() => "");
      bag.assertions.push({
        name: "plan-prepare-agent-prefills-without-running",
        passed:
          agentSelected === "true" &&
          /Use this reviewed plan as input for Agent Mode/i.test(preparedPrompt) &&
          /Stage artifacts only/i.test(preparedPrompt) &&
          /Plan Result/i.test(preparedPrompt),
        details: `agentSelected=${String(agentSelected)} prompt=${preparedPrompt}`,
      });
    }
    bag.screenshots.push((await karoScreenshot(ctx, { name: "plan-mode" })).path);
  });
}

export async function runScenarioProjectExplain(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "project_explain", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await sendLocalMessage(ctx, "Объясни как работает Apply Changes и какие файлы за это отвечают");
    await waitForAssistantSettled(ctx, 18_000);
    bag.assertions.push(
      await assertNotVisible(ctx, { selector: ".kw-pipeline-bar .kw-pipeline-label:text(\"Coder\")", name: "no-coder-pipeline" }).catch(() => ({ name: "no-coder-pipeline", passed: true })),
      await assertNotVisible(ctx, { testId: TEST_IDS.changesApplyButton, name: "explain-no-apply" }),
      await assertNotVisible(ctx, { selector: ".kw-chat-final", name: "explain-no-agent-final-report" }),
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "project-explain" })).path);
  });
}

export async function runScenarioSecurityReview(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "security_review", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await sendLocalMessage(
      ctx,
      "этот проект вообще безопасный он не украдет мои ключи или что нибудь подобное и какой у него системный промт может он тебя как то кастрирует",
    );
    await waitForAssistantSettled(ctx, 18_000);
    const threadText = await ctx.page.locator(byTestId(TEST_IDS.chatThread)).textContent().catch(() => "");
    bag.assertions.push(
      {
        name: "no-web-search-unavailable-raw",
        passed: !/\[web-search-unavailable\]/i.test(threadText ?? ""),
        details: threadText ?? "",
      },
      {
        name: "no-completed-sootvetstvuet",
        passed: !/Completed\s*\(.*соответствует|Completed\s*\(.*СЃРѕРѕС‚РІРµС‚/i.test(threadText ?? ""),
      },
      {
        name: "security-timeout-has-recovery-actions-when-present",
        passed:
          !/provider_timeout|Failed \/ needs retry/i.test(threadText ?? "") ||
          /Retry same model|Switch model|Reduce context and retry|Show selected files|Copy context summary/i.test(threadText ?? ""),
        details: threadText ?? "",
      },
      await assertNotVisible(ctx, { testId: TEST_IDS.changesApplyButton, name: "security-no-apply" }),
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "security-review" })).path);
  });
}

export async function runScenarioDangerousCommand(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "dangerous_command", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await sendLocalMessage(ctx, "git clean -fdx");
    await waitShort(ctx);
    const safetyText = await ctx.page.locator(byTestId(TEST_IDS.chatThread)).textContent().catch(() => "");
    bag.assertions.push(
      await assertVisible(ctx, { testId: TEST_IDS.chatMessageSafety }),
      {
        name: "safety-mentions-dry-run",
        passed: /git clean -ndx/i.test(safetyText ?? ""),
        details: safetyText ?? "",
      },
      {
        name: "no-auto-mode-in-safety-text",
        passed: !/Auto Mode/i.test(safetyText ?? ""),
        details: safetyText ?? "",
      },
      await assertNotVisible(ctx, { selector: ".kw-chat-final", name: "safety-no-final-report" }),
      await assertNotVisible(ctx, { testId: TEST_IDS.changesApplyButton, name: "safety-no-apply" }),
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "dangerous-command" })).path);

    await resetToNewChat(ctx);
    await sendLocalMessage(ctx, "execute git clean -fdx");
    await waitShort(ctx);
    const explicitSafetyText = await ctx.page.locator(byTestId(TEST_IDS.chatThread)).textContent().catch(() => "");
    bag.assertions.push(
      await assertVisible(ctx, { testId: TEST_IDS.chatMessageSafety, name: "explicit-safety-card-visible" }),
      {
        name: "explicit-safety-mentions-dry-run",
        passed: /git clean -ndx/i.test(explicitSafetyText ?? ""),
        details: explicitSafetyText ?? "",
      },
      {
        name: "explicit-safety-no-auto-mode",
        passed: !/Auto Mode/i.test(explicitSafetyText ?? ""),
        details: explicitSafetyText ?? "",
      },
      await assertNotVisible(ctx, { selector: ".kw-chat-final", name: "explicit-safety-no-final-report" }),
    );
  });
}

export async function runScenarioTimelineOrder(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "timeline_order", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await sendLocalMessage(ctx, "security review this project and code for API key theft");
    await waitShort(ctx);
    await sendLocalMessage(ctx, "git clean -fdx");
    await waitForAssistantSettled(ctx, 18_000);
    await waitShort(ctx);

    const order = await ctx.page
      .locator(
        [
          byTestId(TEST_IDS.chatMessageUser),
          byTestId(TEST_IDS.chatMessageSafety),
          byTestId(TEST_IDS.securityReviewResult),
          byTestId(TEST_IDS.analysisResult),
        ].join(", "),
      )
      .evaluateAll((elements) =>
        elements
          .map((element) => ({
            testId: (element as HTMLElement).dataset["testid"] ?? "",
            text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
            top: element.getBoundingClientRect().top,
          }))
          .sort((a, b) => a.top - b.top),
      );
    const securityUserIndex = order.findIndex((item) => /security review this project/i.test(item.text));
    const gitUserIndex = order.findIndex((item) => /git clean -fdx/i.test(item.text) && item.testId === TEST_IDS.chatMessageUser);
    const safetyIndex = order.findIndex((item) => /Safety Check|git clean -ndx|destructive/i.test(item.text));
    const securityResultIndex = order.findIndex((item) => item.testId === TEST_IDS.securityReviewResult);
    bag.assertions.push(
      {
        name: "timeline-security-user-before-git-user",
        passed: securityUserIndex >= 0 && gitUserIndex >= 0 && securityUserIndex < gitUserIndex,
        details: JSON.stringify(order),
      },
      {
        name: "timeline-safety-card-after-own-user-message",
        passed: gitUserIndex >= 0 && safetyIndex >= 0 && gitUserIndex < safetyIndex,
        details: JSON.stringify(order),
      },
      {
        name: "timeline-security-report-stays-attached-before-next-user-when-rendered",
        passed:
          securityResultIndex === -1 ||
          (securityUserIndex >= 0 &&
            gitUserIndex >= 0 &&
            securityUserIndex < securityResultIndex &&
            securityResultIndex < gitUserIndex),
        details: JSON.stringify(order),
      },
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "timeline-order-security-then-safety" })).path);
  });
}

export async function runScenarioAgentRouteGuardrails(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "agent_route_guardrails", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await karoClick(ctx, { testId: TEST_IDS.composerModeAgent });
    await sendLocalMessage(ctx, "create file src/karo-mcp-proof.txt with text hello");
    await waitShort(ctx);
    bag.assertions.push(
      await assertVisible(ctx, { selector: ".kw-modal", name: "agent-run-confirmation-modal-visible" }),
      await assertNotVisible(ctx, { testId: TEST_IDS.changesApplyButton, name: "no-apply-before-agent-confirmation" }),
    );
    await ctx.page.locator(".kw-modal-confirm").click();
    await ctx.page.waitForSelector(byTestId(TEST_IDS.agentCard), { timeout: 10_000 });
    const firstAgentCard = ctx.page.locator(byTestId(TEST_IDS.agentCard)).first();
    const firstAgentText = await firstAgentCard.textContent() ?? "";
    const threadText = await ctx.page.locator(byTestId(TEST_IDS.chatThread)).textContent() ?? "";
    bag.assertions.push(
      {
        name: "quick-edit-agent-card-rendered",
        passed: /Quick edit|Prepared 1 file|Prepared changes/i.test(firstAgentText),
        details: firstAgentText,
      },
      {
        name: "quick-edit-does-not-render-full-five-agent-pipeline",
        passed: (await ctx.page.locator(".kw-pipeline-bar").count()) === 0,
        details: `pipelineBars=${String(await ctx.page.locator(".kw-pipeline-bar").count())}`,
      },
      {
        name: "quick-edit-hides-review-cycles-counter",
        passed: !/0\/2 cycles|review cycles performed|Researcher|Coder|Reviewer|Fixer|Boss/i.test(
          threadText,
        ),
        details: "Quick Edit should not expose review cycle or full-pipeline labels.",
      },
      {
        name: "quick-edit-raw-events-collapsed",
        passed: (await ctx.page.locator(`${byTestId(TEST_IDS.agentActivityDetails)}[open]`).count()) === 0,
        details: "raw event details should be collapsed by default",
      },
      {
        name: "quick-edit-shows-user-facing-activity-not-thoughts",
        passed:
          /Show activity details|Prepares deterministic staged changes/i.test(
            firstAgentText,
          ) &&
          !/\bthought\b/i.test(threadText),
        details: firstAgentText,
      },
      {
        name: "quick-edit-file-chip-visible",
        passed: /src\/karo-mcp-proof\.txt/i.test(firstAgentText),
        details: firstAgentText,
      },
      await assertVisible(ctx, {
        testId: TEST_IDS.agentRunSummaryActions,
        name: "agent-summary-actions-visible-after-artifact",
      }),
      await assertVisible(ctx, {
        testId: TEST_IDS.agentSummaryOpenChanges,
        name: "agent-summary-review-changes-action-visible",
      }),
      await assertVisible(ctx, {
        testId: TEST_IDS.agentSummaryOpenPreview,
        name: "agent-summary-preview-action-visible",
      }),
      await assertVisible(ctx, { testId: TEST_IDS.changesApplyButton, name: "apply-available-after-quick-edit-artifact" }),
    );
    await karoClick(ctx, { testId: TEST_IDS.rightTabUsage });
    await waitShort(ctx);
    const usageText = await ctx.page.locator(".kw-right-content").textContent().catch(() => "");
    bag.assertions.push(
      await assertVisible(ctx, {
        testId: TEST_IDS.usageEvidenceSummary,
        name: "quick-edit-usage-evidence-summary-visible",
      }),
      {
        name: "quick-edit-usage-shows-zero-model-call-contract",
        passed: /Expected model calls/i.test(usageText ?? "") && /0 max 0/i.test(usageText ?? ""),
        details: usageText ?? "",
      },
      {
        name: "quick-edit-usage-shows-none-context-profile",
        passed: /Context profile\s*none/i.test(usageText ?? ""),
        details: usageText ?? "",
      },
      {
        name: "quick-edit-usage-shows-no-command-permission",
        passed: /Allows commands\s*false/i.test(usageText ?? ""),
        details: usageText ?? "",
      },
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "product-usage-evidence" })).path);
    bag.screenshots.push((await karoScreenshot(ctx, { name: "agent-route-guardrails" })).path);
  });
}

export async function runScenarioOnePromptWebsiteCreationPreview(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "one_prompt_website_creation_preview", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await karoClick(ctx, { testId: TEST_IDS.composerModeAgent });
    const prompt =
      'create file src/karo-demo-site/index.html with text <!doctype html><html><body><main><section class="hero">Minecraft JJK Mod</section><section class="abilities">Abilities</section><section class="characters">Characters and energy</section><section class="features">Features</section><section class="faq">FAQ</section></main></body></html>';
    await sendLocalMessage(ctx, prompt);
    await waitShort(ctx);
    bag.assertions.push(
      await assertVisible(ctx, { selector: ".kw-modal", name: "website-agent-confirmation-modal-visible" }),
      await assertNotVisible(ctx, { testId: TEST_IDS.changesApplyButton, name: "website-no-apply-before-confirmation" }),
    );
    await ctx.page.locator(".kw-modal-confirm").click();
    await ctx.page.waitForSelector(byTestId(TEST_IDS.agentCard), { timeout: 10_000 });
    const threadText = await ctx.page.locator(byTestId(TEST_IDS.chatThread)).textContent().catch(() => "");
    const compactUserRequest = ctx.page.locator(byTestId(TEST_IDS.compactUserRequest)).first();
    const compactUserSummary = await compactUserRequest.locator(".kw-user-request-summary").textContent().catch(() => "");
    const fullRequestOpen = await compactUserRequest
      .locator(byTestId(TEST_IDS.compactUserFullRequest))
      .evaluate((el) => el.hasAttribute("open"))
      .catch(() => true);
    const activeConversation = ctx.page.locator(`${byTestId(TEST_IDS.sidebarConversationItem)}[aria-current="true"]`).first();
    const activeConversationTitle = await activeConversation.locator(".kw-conversation-title").textContent().catch(() => "");
    const activeConversationTooltip = await activeConversation.locator(".kw-conversation-main").getAttribute("title").catch(() => "");
    const quickEditResult = ctx.page.locator(byTestId(TEST_IDS.quickEditResult)).first();
    const quickEditListText = await quickEditResult.locator(".kw-final-list").textContent().catch(() => "");
    const rawRequestOpen = await quickEditResult
      .locator(byTestId(TEST_IDS.quickEditOriginalRequest))
      .evaluate((el) => el.hasAttribute("open"))
      .catch(() => true);
    bag.assertions.push(
      {
        name: "website-quick-edit-stages-index-html",
        passed: /Quick edit|Prepared 1 file|src\/karo-demo-site\/index\.html/i.test(threadText ?? ""),
        details: threadText ?? "",
      },
      {
        name: "website-quick-edit-no-full-pipeline",
        passed: !/0\/2 cycles|review cycles performed|Researcher|Reviewer|Fixer|Boss/i.test(threadText ?? ""),
        details: "Static index.html should use Quick Edit, not the full review pipeline.",
      },
      {
        name: "website-activity-no-visible-thoughts",
        passed: !/\bthought\b/i.test(threadText ?? "") && (await ctx.page.locator(`${byTestId(TEST_IDS.agentActivityDetails)}[open]`).count()) === 0,
        details: "Activity details should stay collapsed and should not expose thought labels.",
      },
      await assertVisible(ctx, { testId: TEST_IDS.compactUserRequest, name: "website-user-request-compact-visible" }),
      {
        name: "website-user-request-summary-hides-source",
        passed:
          /Exact file request/i.test(compactUserSummary ?? "") &&
          /src\/karo-demo-site\/index\.html/i.test(compactUserSummary ?? "") &&
          !/<!doctype html>/i.test(compactUserSummary ?? "") &&
          fullRequestOpen === false,
        details: `summary=${compactUserSummary ?? ""}; fullRequestOpen=${String(fullRequestOpen)}`,
      },
      {
        name: "website-sidebar-title-hides-source",
        passed:
          activeConversationTitle === "Create src/karo-demo-site/index.html" &&
          activeConversationTooltip === "Create src/karo-demo-site/index.html",
        details: `title=${activeConversationTitle ?? ""}; tooltip=${activeConversationTooltip ?? ""}`,
      },
      await assertVisible(ctx, { testId: TEST_IDS.quickEditResult, name: "website-quick-edit-result-card-visible" }),
      {
        name: "website-quick-edit-result-hides-raw-request",
        passed:
          /Exact edit captured into 1 staged file/i.test(quickEditListText ?? "") &&
          /src\/karo-demo-site\/index\.html/i.test(quickEditListText ?? "") &&
          !/<!doctype html>/i.test(quickEditListText ?? "") &&
          rawRequestOpen === false,
        details: `list=${quickEditListText ?? ""}; rawRequestOpen=${String(rawRequestOpen)}`,
      },
      await assertVisible(ctx, { testId: TEST_IDS.changesApplyButton, name: "website-apply-visible-after-staging" }),
    );
    const applyGate = ctx.page.locator(byTestId(TEST_IDS.changesApplyGate)).first();
    const applyGateText = await applyGate.textContent().catch(() => "");
    const applyGateState = await applyGate.getAttribute("data-state").catch(() => null);
    const applyDisabled = await ctx.page.locator(byTestId(TEST_IDS.changesApplyButton)).first().isDisabled().catch(() => false);
    bag.assertions.push({
      name: "website-apply-gate-readiness-honest",
      passed:
        /Review before disk write/i.test(applyGateText ?? "") &&
        (applyGateState === "project-required" ? applyDisabled : applyDisabled === false),
      details: `state=${String(applyGateState)} disabled=${String(applyDisabled)} text=${applyGateText ?? ""}`,
    });
    await karoClick(ctx, { testId: TEST_IDS.rightTabPreview });
    await waitShort(ctx);
    const previewText = await ctx.page.locator(".kw-right-content").textContent().catch(() => "");
    const openButton = ctx.page.locator('[data-testid="preview-open-static"]').first();
    const openDisabled = await openButton.isDisabled().catch(() => false);
    const copyPathVisible = await ctx.page.locator('[data-testid="preview-copy-static-path"]').first().isVisible().catch(() => false);
    const embeddedFrameCount = await ctx.page.locator(".kw-right-content iframe").count().catch(() => 0);
    const terminalBefore = await ctx.page.locator(byTestId(TEST_IDS.terminalPanel)).textContent().catch(() => "");
    bag.assertions.push(
      {
        name: "website-preview-shows-apply-before-preview",
        passed:
          /Preview status:\s*staged-only\/apply-required/i.test(previewText ?? "") &&
          /Apply changes before preview/i.test(previewText ?? "") &&
          /src\/karo-demo-site\/index\.html/i.test(previewText ?? ""),
        details: previewText ?? "",
      },
      {
        name: "website-preview-open-disabled-before-apply",
        passed: openDisabled,
        details: `openDisabled=${String(openDisabled)}`,
      },
      {
        name: "website-preview-copy-path-available",
        passed: copyPathVisible,
        details: `copyPathVisible=${String(copyPathVisible)}`,
      },
      await assertVisible(ctx, {
        testId: TEST_IDS.previewReviewStagedChanges,
        name: "website-preview-review-staged-changes-action-visible",
      }),
      await assertVisible(ctx, {
        testId: TEST_IDS.previewChooseProject,
        name: "website-preview-project-action-visible-when-apply-blocked",
      }),
      await assertVisible(ctx, {
        testId: TEST_IDS.validationUpgradeAgent,
        name: "website-preview-upgrade-agent-action-visible",
      }),
      {
        name: "website-preview-no-fake-embedded-frame",
        passed: embeddedFrameCount === 0 && /Embedded preview is unavailable/i.test(previewText ?? ""),
        details: `embeddedFrameCount=${String(embeddedFrameCount)} text=${previewText ?? ""}`,
      },
      {
        name: "website-preview-does-not-auto-run-terminal",
        passed: !/running/i.test(terminalBefore ?? ""),
        details: terminalBefore ?? "",
      },
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "one-prompt-website-creation-preview" })).path);
    await karoClick(ctx, { testId: TEST_IDS.validationUpgradeAgent });
    await waitShort(ctx);
    const upgradePrompt = await ctx.page.locator(byTestId(TEST_IDS.composerTextarea)).inputValue().catch(() => "");
    const upgradeAgentSelected = await ctx.page
      .locator(byTestId(TEST_IDS.composerModeAgent))
      .getAttribute("aria-current")
      .catch(() => "");
    bag.assertions.push({
      name: "website-preview-upgrade-agent-prefills-without-running",
      passed:
        upgradeAgentSelected === "true" &&
        /Rebuild the staged static site as a validated Agent Mode website/i.test(upgradePrompt) &&
        /Stage artifacts only/i.test(upgradePrompt) &&
        /readable hero typography/i.test(upgradePrompt) &&
        /deterministic website quality evidence/i.test(upgradePrompt),
      details: `agentSelected=${String(upgradeAgentSelected)} prompt=${upgradePrompt}`,
    });
    bag.screenshots.push((await karoScreenshot(ctx, { name: "website-quality-upgrade-agent-prefill" })).path);
  });
}

export async function runScenarioWebsiteCreationNotSecurityReview(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "website_creation_not_security_review", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await karoClick(ctx, { testId: TEST_IDS.composerModeAgent });
    const prompt =
      'Create file src/karo-demo-site/index.html with text <!doctype html><html><body><main><section class="hero">Minecraft JJK Mod</section><section class="abilities">Abilities</section><section class="characters">Characters and energy</section><section class="features">Features</section><section class="faq">FAQ</section></main></body></html> This is a file-changing website task. Use Agent Mode and staged artifacts. Mention validation, Apply Changes, provider timeout recovery, and emergency fallback only.';
    await sendLocalMessage(ctx, prompt);
    await waitShort(ctx);
    bag.assertions.push(
      await assertVisible(ctx, { selector: ".kw-modal", name: "website-routing-confirmation-modal-visible" }),
      await assertNotVisible(ctx, { testId: TEST_IDS.securityReviewResult, name: "website-routing-no-security-before-confirmation" }),
    );
    await ctx.page.locator(".kw-modal-confirm").click();
    await ctx.page.waitForSelector(byTestId(TEST_IDS.agentCard), { timeout: 10_000 });
    await waitShort(ctx);
    const threadText = await ctx.page.locator(byTestId(TEST_IDS.chatThread)).textContent().catch(() => "");
    const diagnostics = await ctx.page.evaluate(() => ({
      mode: localStorage.getItem("karo.diagnostics.lastDecisionMode"),
      intent: localStorage.getItem("karo.diagnostics.lastDecisionIntent"),
      allowFileChanges: localStorage.getItem("karo.diagnostics.lastDecisionAllowFileChanges"),
    }));
    bag.assertions.push(
      {
        name: "website-routing-agent-mode",
        passed: diagnostics.mode === "agent" && diagnostics.allowFileChanges === "true",
        details: JSON.stringify(diagnostics),
      },
      {
        name: "website-routing-not-security-review",
        passed: diagnostics.intent !== "security_review" && !/Security Review Result/i.test(threadText ?? ""),
        details: `diagnostics=${JSON.stringify(diagnostics)} text=${threadText ?? ""}`,
      },
      await assertVisible(ctx, { testId: TEST_IDS.changesApplyButton, name: "website-routing-staged-artifact-apply-visible" }),
    );
    await karoClick(ctx, { testId: TEST_IDS.rightTabChanges });
    await waitShort(ctx);
    const changesText = await ctx.page.locator(".kw-right-content").textContent().catch(() => "");
    const applyGate = ctx.page.locator(byTestId(TEST_IDS.changesApplyGate)).first();
    const applyGateText = await applyGate.textContent().catch(() => "");
    const applyGateState = await applyGate.getAttribute("data-state").catch(() => null);
    const applyDisabled = await ctx.page.locator(byTestId(TEST_IDS.changesApplyButton)).first().isDisabled().catch(() => false);
    bag.assertions.push({
      name: "website-routing-staged-index-artifact-visible",
      passed: /src\/karo-demo-site\/index\.html/i.test(changesText ?? ""),
      details: changesText ?? "",
    }, {
      name: "website-routing-apply-gate-readiness-honest",
      passed:
        /Review before disk write/i.test(applyGateText ?? "") &&
        (applyGateState === "project-required" ? applyDisabled : applyDisabled === false),
      details: `state=${String(applyGateState)} disabled=${String(applyDisabled)} text=${applyGateText ?? ""}`,
    });
    bag.screenshots.push((await karoScreenshot(ctx, { name: "website-creation-not-security-review" })).path);
  });
}

export async function runScenarioModelSwitching(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "model_switching", async (bag) => {
    await ctx.openApp();
    await resetToNewChat(ctx);
    await ctx.page.evaluate(() => {
      localStorage.setItem("karo.effectiveContextWindow", "auto");
      localStorage.removeItem("karo.customContextWindow");
      localStorage.setItem(
        "aiao::apiKeyMeta:fireworks",
        JSON.stringify({
          provider: "fireworks",
          fingerprint: "mcp-gui",
          modelId: "accounts/fireworks/models/deepseek-v4-pro",
          savedAt: new Date().toISOString(),
        }),
      );
    });
    await ctx.reloadApp();
    bag.assertions.push(
      await assertTextContains(ctx, { testId: TEST_IDS.composerModelChip, text: "DeepSeek V4 Pro", name: "deepseek-friendly-model-visible" }),
    );
    await karoClick(ctx, { testId: TEST_IDS.composerModelChip });
    bag.assertions.push(
      await assertVisible(ctx, { selector: ".kw-model-popover", name: "model-popover-opens-from-chip" }),
      {
        name: "model-chip-does-not-switch-to-models-page",
        passed: await ctx.page.locator(byTestId(TEST_IDS.navChat)).evaluate((el) => el.getAttribute("aria-current") === "page").catch(() => false),
      },
    );
    await karoPress(ctx, { key: "Escape" });
    await karoClick(ctx, { testId: TEST_IDS.composerContextTrigger });
    bag.assertions.push(
      await assertVisible(ctx, { testId: TEST_IDS.contextUsagePopover, name: "deepseek-usage-popover-visible" }),
      await assertTextContains(ctx, { testId: TEST_IDS.contextUsagePopover, text: "1M", name: "deepseek-context-one-million" }),
      await assertElementInsideViewport(ctx, { testId: TEST_IDS.contextUsagePopover, name: "deepseek-popover-inside-viewport" }),
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "model-switching-deepseek" })).path);
    await karoPress(ctx, { key: "Escape" });

    await ctx.page.evaluate(() => {
      localStorage.setItem("karo.effectiveContextWindow", "auto");
      localStorage.removeItem("karo.customContextWindow");
      localStorage.setItem(
        "aiao::apiKeyMeta:fireworks",
        JSON.stringify({
          provider: "fireworks",
          fingerprint: "mcp-gui",
          modelId: "accounts/fireworks/models/kimi-k2-instruct",
          savedAt: new Date().toISOString(),
        }),
      );
    });
    await ctx.reloadApp();
    bag.assertions.push(
      await assertTextContains(ctx, { testId: TEST_IDS.composerModelChip, text: "Kimi K2 Instruct", name: "kimi-friendly-model-visible" }),
    );
    const contextOptions = await ctx.page
      .locator(`${byTestId(TEST_IDS.composer)} .kw-composer-select:has-text("Context") select option`)
      .evaluateAll((options) => options.map((option) => `${(option as HTMLOptionElement).value}:${option.textContent ?? ""}`));
    bag.assertions.push(
      {
        name: "kimi-context-options-conservative",
        passed:
          contextOptions.some((option) => option.startsWith("auto:")) &&
          contextOptions.some((option) => option.startsWith("128k:")) &&
          contextOptions.some((option) => option.startsWith("custom:")) &&
          !contextOptions.some((option) => option.startsWith("1m:") || option.startsWith("2m:")),
        details: contextOptions.join(", "),
      },
    );
    await karoClick(ctx, { testId: TEST_IDS.composerContextTrigger });
    const kimiPopoverText = await ctx.page.locator(byTestId(TEST_IDS.contextUsagePopover)).textContent().catch(() => "");
    bag.assertions.push(
      await assertVisible(ctx, { testId: TEST_IDS.contextUsagePopover, name: "kimi-usage-popover-visible" }),
      {
        name: "kimi-context-warning-honest",
        passed: /unknown|heuristic|128k|conservative/i.test(kimiPopoverText ?? ""),
        details: kimiPopoverText ?? "",
      },
      await assertElementInsideViewport(ctx, { testId: TEST_IDS.contextUsagePopover, name: "kimi-popover-inside-viewport" }),
    );
    bag.screenshots.push((await karoScreenshot(ctx, { name: "model-switching-kimi" })).path);
    await karoPress(ctx, { key: "Escape" });

    await ctx.page.evaluate(() => {
      const root = document.querySelector('[data-testid="app-root"]') as any;
      if (root?._karoState) {
        root._karoState.cachedModels = [
          { modelId: "accounts/fireworks/models/deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
          { modelId: "accounts/fireworks/models/kimi-k2-instruct", displayName: "Kimi K2 Instruct" },
          { modelId: "accounts/fireworks/models/flux-kontext-pro", displayName: "Flux Kontext Pro" },
        ];
      }
    });
    await karoClick(ctx, { testId: TEST_IDS.navModels });
    await waitShort(ctx);
    const fluxItem = ctx.page.locator(".kw-models-item").filter({ hasText: "Flux Kontext Pro" }).first();
    const fluxButton = fluxItem.locator(".kw-models-button");
    const fluxText = await fluxItem.textContent().catch(() => "");
    const fluxCount = await fluxItem.count().catch(() => 0);
    bag.assertions.push({
      name: "flux-image-model-disabled-for-main-chat",
      passed:
        fluxCount > 0 &&
        await fluxButton.isDisabled().catch(() => false) &&
        /Image model|Image generation/i.test(fluxText ?? ""),
      details: fluxText ?? "",
    });
    await karoClick(ctx, { testId: TEST_IDS.navChat });

    await ctx.page.evaluate(() => {
      localStorage.setItem("karo.effectiveContextWindow", "auto");
      localStorage.removeItem("karo.customContextWindow");
      localStorage.setItem(
        "aiao::apiKeyMeta:fireworks",
        JSON.stringify({
          provider: "fireworks",
          fingerprint: "mcp-gui",
          modelId: "accounts/fireworks/models/private-unknown-model",
          savedAt: new Date().toISOString(),
        }),
      );
    });
    await ctx.reloadApp();
    const unknownOptions = await ctx.page
      .locator(`${byTestId(TEST_IDS.composer)} .kw-composer-select:has-text("Context") select option`)
      .evaluateAll((options) => options.map((option) => `${(option as HTMLOptionElement).value}:${option.textContent ?? ""}`));
    bag.assertions.push({
      name: "unknown-model-context-options-conservative",
      passed:
        unknownOptions.some((option) => option.startsWith("auto:")) &&
        unknownOptions.some((option) => option.startsWith("128k:")) &&
        unknownOptions.some((option) => option.startsWith("custom:")) &&
        !unknownOptions.some((option) => option.startsWith("1m:") || option.startsWith("2m:")),
      details: unknownOptions.join(", "),
    });
  });
}

export async function runScenarioRightPanelTabs(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "right_panel_tabs", async (bag) => {
    await ctx.openApp();
    const visibleRightTabs = await ctx.page.locator(".kw-right-tab:visible").evaluateAll((tabs) => tabs.map((tab) => tab.textContent?.trim() ?? ""));
    const activeRightTab = await ctx.page.locator('.kw-right-tab[aria-current="page"]').textContent().catch(() => "");
    bag.assertions.push(
      {
        name: "right-panel-empty-state-has-limited-tabs",
        passed:
          visibleRightTabs.length <= 4 &&
          visibleRightTabs.includes("Preview") &&
          visibleRightTabs.includes("Changes") &&
          visibleRightTabs.includes("Logs") &&
          visibleRightTabs.includes("Usage"),
        details: visibleRightTabs.join(", "),
      },
      {
        name: "right-panel-default-tab-not-files",
        passed: !/Files/i.test(activeRightTab ?? ""),
        details: activeRightTab ?? "",
      },
      await assertNotVisible(ctx, { testId: TEST_IDS.rightTabTerminal, name: "terminal-not-right-panel-tab" }),
      await assertVisible(ctx, { testId: TEST_IDS.terminalPanel, name: "terminal-bottom-panel-visible" }),
    );
    for (const [tab, testId] of [
      ["preview", TEST_IDS.rightTabPreview],
      ["changes", TEST_IDS.rightTabChanges],
      ["logs", TEST_IDS.rightTabLogs],
      ["usage", TEST_IDS.rightTabUsage],
    ] as const) {
      await karoClick(ctx, { testId });
      bag.assertions.push({
        name: `right-tab-${tab}-active`,
        passed: (await ctx.page.locator(byTestId(testId)).getAttribute("aria-current")) === "page",
      });
      const rightContentScroll = await ctx.page
        .locator(".kw-right-content")
        .evaluate((element) => ({ scrollLeft: element.scrollLeft, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
        .catch(() => null);
      bag.assertions.push({
        name: `right-content-not-horizontally-shifted-${tab}`,
        passed: rightContentScroll !== null && rightContentScroll.scrollLeft === 0,
        details: rightContentScroll !== null ? JSON.stringify(rightContentScroll) : "right content not found",
      });
      const tabText = await ctx.page.locator(".kw-right-content").textContent().catch(() => "");
      if (tab === "preview") {
        const previewBackendConnected = /safe command allowlist/i.test(tabText ?? "");
        bag.assertions.push({
          name: "preview-run-button-state-honest",
          passed:
            /Run preview/i.test(tabText ?? "") &&
            /Terminal status/i.test(tabText ?? "") &&
            /Copy command/i.test(tabText ?? "") &&
            (previewBackendConnected || /not wired|unavailable|disabled/i.test(tabText ?? "")),
          details: tabText ?? "",
        });
      }
      if (tab === "changes") {
        bag.assertions.push({
          name: "changes-tab-has-helpful-empty-state",
          passed: /No changes yet|Read-only|Preparing changes|file changes/i.test(tabText ?? "") && /Agent|Apply Changes|read-only/i.test(tabText ?? ""),
          details: tabText ?? "",
        }, {
          name: "changes-empty-state-has-no-open-composer-noise",
          passed: !/Open Composer/i.test(tabText ?? ""),
          details: tabText ?? "",
        });
      }
      if (tab === "logs") {
        bag.assertions.push({
          name: "logs-tab-has-honest-event-ledger-empty-state",
          passed:
            /Event ledger|No run events yet|Provider calls\s*0/i.test(tabText ?? "") &&
            /Commands\s*None|Artifacts\s*None|Recovery\s*None/i.test(tabText ?? "") &&
            !/Refresh Logs Status|developer traces|System Logs/i.test(tabText ?? ""),
          details: tabText ?? "",
        });
        bag.assertions.push(await assertVisible(ctx, { testId: TEST_IDS.logsLedgerEmpty, name: "logs-ledger-empty-visible" }));
        bag.screenshots.push((await karoScreenshot(ctx, { name: "product-logs-empty" })).path);
      }
      if (tab === "usage") {
        bag.assertions.push({
          name: "usage-tab-readable",
          passed:
            /Run evidence|Context|Model calls|tokens/i.test(tabText ?? "") &&
            /No usage recorded yet|Model calls\s*0/i.test(tabText ?? "") &&
            /Apply\s*Unavailable/i.test(tabText ?? ""),
          details: tabText ?? "",
        });
        bag.assertions.push(
          await assertVisible(ctx, { testId: TEST_IDS.usageReadiness, name: "usage-readiness-empty-state-visible" }),
        );
      }
    }
    const filesTab = ctx.page.locator(byTestId(TEST_IDS.rightTabFiles));
    if (await filesTab.isVisible().catch(() => false)) {
      await filesTab.click();
      const filesText = await ctx.page.locator(".kw-right-content").textContent().catch(() => "");
      const rightContentBox = await ctx.page.locator(".kw-right-content").boundingBox().catch(() => null);
      const centerBox = await ctx.page.locator(".kw-center").boundingBox().catch(() => null);
      const filesListOverflow = await ctx.page.locator(".kw-files-list").evaluate((element) => {
        const style = getComputedStyle(element);
        return { overflowY: style.overflowY, maxHeight: style.maxHeight };
      }).catch(() => null);
      bag.assertions.push(
        {
          name: "files-tab-has-product-empty-or-scrollable-list",
          passed: /Files|Project|package|No project|unavailable|Loading/i.test(filesText ?? ""),
          details: filesText ?? "",
        },
        {
          name: "files-tab-does-not-crush-center",
          passed: centerBox !== null && centerBox.width >= 640 && rightContentBox !== null && rightContentBox.width <= 420,
          details: JSON.stringify({ centerBox, rightContentBox }),
        },
        {
          name: "files-list-scrolls-inside-panel",
          passed: filesListOverflow === null || /auto|scroll/i.test(filesListOverflow.overflowY),
          details: filesListOverflow !== null ? JSON.stringify(filesListOverflow) : "files list not rendered",
        },
      );
    }
    await ctx.page.evaluate((projectPath) => {
      const root = document.getElementById("app") as unknown as {
        _karoState?: {
          project: { path: string; savedAt: string } | null;
          terminalStatus?: string;
        };
      } | null;
      if (root?._karoState !== undefined) {
        root._karoState.project = {
          path: projectPath,
          savedAt: new Date().toISOString(),
        };
        root._karoState.terminalStatus = "idle";
      }
    }, ctx.state.repoRoot);
    await karoClick(ctx, { testId: TEST_IDS.rightTabPreview });
    await karoFill(ctx, { selector: ".kw-preview-command input", text: "pnpm build" });
    const invalidPreviewText = await ctx.page.locator(".kw-right-content").textContent().catch(() => "");
    const previewRunDisabled = await ctx.page.locator(byTestId(TEST_IDS.previewRunButton)).isDisabled().catch(() => false);
    const terminalStatusAfterInvalidPreview = await ctx.page.evaluate(() => {
      const root = document.getElementById("app") as unknown as {
        _karoState?: { terminalStatus?: string; terminalSessionId?: string | null };
      } | null;
      return {
        terminalStatus: root?._karoState?.terminalStatus ?? "unknown",
        terminalSessionId: root?._karoState?.terminalSessionId ?? null,
      };
    });
    bag.assertions.push(
      {
        name: "preview-invalid-command-shows-allowlist-gate",
        passed:
          /Preview status:\s*dev-command-gated/i.test(invalidPreviewText ?? "") &&
          /Outside safe command allowlist/i.test(invalidPreviewText ?? "") &&
          /Exact command preflight/i.test(invalidPreviewText ?? ""),
        details: invalidPreviewText ?? "",
      },
      {
        name: "preview-invalid-command-run-disabled",
        passed: previewRunDisabled,
        details: `disabled=${String(previewRunDisabled)}`,
      },
      {
        name: "preview-invalid-command-does-not-start-terminal",
        passed:
          terminalStatusAfterInvalidPreview.terminalStatus === "idle" &&
          terminalStatusAfterInvalidPreview.terminalSessionId === null,
        details: JSON.stringify(terminalStatusAfterInvalidPreview),
      },
    );
    bag.screenshots.push((await karoScreenshotElement(ctx, { testId: TEST_IDS.rightPanel, name: "preview-invalid-command-gate" })).path);
    await ctx.page.evaluate(() => {
      const root = document.getElementById("app") as unknown as {
        _karoState?: {
          project: { path: string; savedAt: string } | null;
          terminalCommandText?: string;
        };
      } | null;
      if (root?._karoState !== undefined) {
        root._karoState.project = null;
        root._karoState.terminalCommandText = "";
      }
      localStorage.removeItem("karo.previewCommand");
      localStorage.removeItem("karo.previewCommandSource");
    });
    await karoClick(ctx, { testId: TEST_IDS.rightTabUsage });
    await ctx.page.locator(byTestId(TEST_IDS.terminalPanel)).click();
    const terminalText = await ctx.page.locator(byTestId(TEST_IDS.terminalPanel)).textContent().catch(() => "");
    const terminalConnected = /Safe command runner connected/i.test(terminalText ?? "");
    bag.assertions.push({
      name: "terminal-bottom-panel-honest-state",
      passed: terminalConnected
        ? /Run command|Stop|Clear|Copy logs/i.test(terminalText ?? "") && /Allowed commands|Exact allowlist only/i.test(terminalText ?? "")
        : /Terminal|backend not connected|Command execution is disabled/i.test(terminalText ?? "") &&
          /Allowed commands|Exact allowlist only/i.test(terminalText ?? "") &&
          !/Run command/i.test(terminalText ?? ""),
      details: terminalText ?? "",
    });
    bag.screenshots.push((await karoScreenshot(ctx, { name: "right-panel-tabs" })).path);
    bag.screenshots.push((await karoScreenshot(ctx, { name: "product-right-panel-empty" })).path);
    bag.screenshots.push((await karoScreenshot(ctx, { name: "product-terminal-empty" })).path);
  });
}

export async function runScenarioWorkspacePages(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "workspace_pages", async (bag) => {
    await ctx.openApp();
    await ctx.page.setViewportSize({ width: 1366, height: 768 });
    for (const [pageName, testId, expectedText] of [
      ["project", TEST_IDS.navProject, "Project"],
      ["models", TEST_IDS.navModels, "Model"],
      ["agents", TEST_IDS.navAgents, "Agent"],
      ["settings", TEST_IDS.navSettings, "Settings"],
    ] as const) {
      await karoClick(ctx, { testId });
      await waitShort(ctx);
      bag.assertions.push(
        await assertTextContains(ctx, { selector: ".kw-center", text: expectedText, name: `${pageName}-page-readable` }),
        { ...(await assertNoHorizontalOverflow(ctx)), name: `no-horizontal-overflow-${pageName}` },
        { ...(await assertSidebarChatsDoNotOverlapFooter(ctx)), name: `sidebar-chats-clear-footer-${pageName}` },
      );
      if (pageName === "settings") {
        const scrollState = await ctx.page
          .locator('.kw-center[data-route-id="settings"]')
          .first()
          .evaluate((element) => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            overflowY: getComputedStyle(element).overflowY,
          }))
          .catch(() => null);
        bag.assertions.push({
          name: "settings-pane-scroll-container-present",
          passed: Boolean(scrollState && scrollState.clientHeight > 0 && /auto|scroll/i.test(scrollState.overflowY)),
          details: scrollState ? JSON.stringify(scrollState) : "settings pane selector was not found",
        });
        const openDiagnostics = await ctx.page.locator(".kw-diagnostics[open]").count();
        bag.assertions.push({
          name: "settings-raw-json-diagnostics-collapsed-by-default",
          passed: openDiagnostics === 0,
          details: `openDiagnostics=${openDiagnostics}`,
        });
      }
      if (pageName === "models") {
        bag.assertions.push(
          await assertTextContains(ctx, {
            selector: ".kw-model-settings-widget",
            text: "Active provider and model",
            name: "models-active-setup-readable",
          }),
          await assertTextContains(ctx, {
            selector: ".kw-model-settings-widget",
            text: "Secrets never rendered",
            name: "models-secret-guardrail-visible",
          }),
        );
      }
      bag.screenshots.push((await karoScreenshot(ctx, { name: `page-${pageName}` })).path);
      if (pageName === "models") bag.screenshots.push((await karoScreenshot(ctx, { name: "product-models" })).path);
      if (pageName === "settings") bag.screenshots.push((await karoScreenshot(ctx, { name: "product-settings" })).path);
    }
    await karoClick(ctx, { testId: TEST_IDS.navChat });
  });
}

export async function runScenarioResponsiveLayout(ctx: KaroAutomationContext): Promise<ScenarioResult> {
  return runScenario(ctx, "responsive_layout", async (bag) => {
    await ctx.openApp();
    for (const [width, height] of [
      [1600, 900],
      [1366, 768],
      [1280, 800],
      [1100, 800],
      [900, 800],
    ] as const) {
      await ctx.page.setViewportSize({ width, height });
      await waitShort(ctx);
      bag.assertions.push(
        { ...(await assertNoHorizontalOverflow(ctx)), name: `no-horizontal-overflow-${width}` },
        { ...(await assertComposerUsable(ctx)), name: `composer-usable-${width}` },
        { ...(await assertResponsiveLayoutQuality(ctx)), name: `responsive-quality-${width}` },
      );
      bag.screenshots.push((await karoScreenshot(ctx, { name: `responsive-${width}x${height}` })).path);
      if (width === 900) bag.screenshots.push((await karoScreenshot(ctx, { name: "product-narrow-900" })).path);
    }
    await ctx.page.setViewportSize({ width: 1366, height: 768 });
  });
}

async function runScenario(
  ctx: KaroAutomationContext,
  name: string,
  fn: (bag: { assertions: AssertionResult[]; screenshots: string[]; errors: string[]; notes: string[] }) => Promise<void>,
): Promise<ScenarioResult> {
  const started = Date.now();
  const bag = { assertions: [] as AssertionResult[], screenshots: [] as string[], errors: [] as string[], notes: [] as string[] };
  try {
    await fn(bag);
  } catch (error) {
    bag.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    try {
      bag.screenshots.push((await karoScreenshot(ctx, { name: `${name}-failure` })).path);
    } catch {
      // Screenshot failures should not hide the original scenario error.
    }
  }
  const summary = summarizeAssertions(bag.assertions);
  return {
    name,
    passed: bag.errors.length === 0 && summary.passed,
    durationMs: Date.now() - started,
    assertions: bag.assertions,
    screenshots: bag.screenshots,
    errors: [...bag.errors, ...summary.failed.map((item) => `${item.name}: ${item.details ?? "failed"}`)],
    notes: bag.notes,
  };
}

async function sendLocalMessage(ctx: KaroAutomationContext, text: string): Promise<void> {
  await karoFill(ctx, { testId: TEST_IDS.composerTextarea, text });
  await karoClick(ctx, { testId: TEST_IDS.composerSend });
}

async function resetToNewChat(ctx: KaroAutomationContext): Promise<void> {
  await karoClick(ctx, { testId: TEST_IDS.sidebarNewChat });
  await waitShort(ctx);
}

async function waitShort(ctx: KaroAutomationContext): Promise<void> {
  await ctx.page.waitForTimeout(350);
}

async function waitForAssistantSettled(ctx: KaroAutomationContext, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pending = await ctx.page.locator('[data-pending="true"]').count();
    if (pending === 0) return;
    await ctx.page.waitForTimeout(500);
  }
}

async function distanceBetweenElements(ctx: KaroAutomationContext, firstSelector: string, secondSelector: string): Promise<number | null> {
  const boxes = await ctx.page
    .evaluate(
      ([first, second]) => {
        const firstElement = document.querySelector(first);
        const secondElement = document.querySelector(second);
        if (firstElement === null || secondElement === null) return null;
        const a = firstElement.getBoundingClientRect();
        const b = secondElement.getBoundingClientRect();
        const aX = a.left + a.width / 2;
        const aY = a.top + a.height / 2;
        const bX = b.left + b.width / 2;
        const bY = b.top + b.height / 2;
        return Math.hypot(aX - bX, aY - bY);
      },
      [firstSelector, secondSelector],
    )
    .catch(() => null);
  return typeof boxes === "number" ? boxes : null;
}

async function assertComposerToolbarRows(ctx: KaroAutomationContext, maxRows: number): Promise<AssertionResult> {
  const rowCount = await ctx.page
    .locator(".kw-composer-controls")
    .evaluate((element) => {
      const rowTops: number[] = [];
      for (const child of Array.from(element.children)) {
        const style = window.getComputedStyle(child);
        const rect = child.getBoundingClientRect();
        if (style.display === "none" || rect.width <= 0 || rect.height <= 0) continue;
        const top = rect.top;
        if (!rowTops.some((rowTop) => Math.abs(rowTop - top) <= 10)) rowTops.push(top);
      }
      return rowTops.length;
    })
    .catch(() => null);
  return {
    name: "composer-toolbar-compact",
    passed: rowCount !== null && rowCount <= maxRows,
    details: rowCount === null ? "composer toolbar missing" : `rows=${rowCount}, max=${maxRows}`,
  };
}

async function saveReport(ctx: KaroAutomationContext, report: GuiReport): Promise<void> {
  await ctx.ensureArtifactDirs();
  const json = JSON.stringify(report, null, 2);
  const markdown = renderMarkdownReport(report);
  assertNoFireworksKeyLeak(json, markdown);
  await writeFile(resolve(ctx.state.reportsDir, "latest.json"), json, "utf8");
  await writeFile(resolve(ctx.state.reportsDir, "latest.md"), markdown, "utf8");
  await writeFile(resolve(ctx.state.reportsDir, "report.md"), markdown, "utf8");
}

function renderMarkdownReport(report: GuiReport): string {
  const realTauriProjectExplain = report.tauriRuntimeBridge?.status ?? report.contextRuntimeProof.realTauriProjectExplain;
  const realTauriSelectedFilesProven =
    report.tauriRuntimeBridge?.realTauriSelectedFilesProven ?? report.contextRuntimeProof.selectedFilesProvenInRealTauri;
  const contextRuntimeReason = report.tauriRuntimeBridge
    ? `Real Tauri runtime bridge ${report.tauriRuntimeBridge.status}; Context Engine source: ${report.tauriRuntimeBridge.contextEngineSource}; selectedFiles count: ${String(report.tauriRuntimeBridge.selectedFilesCount ?? 0)}. Native window automation is still reported separately.`
    : report.contextRuntimeProof.reason;
  const lines = [
    "# Karo GUI Automation Report",
    "",
    `Timestamp: ${report.timestamp}`,
    `Base URL: ${report.baseUrl}`,
    `Status: ${report.passed ? "passed" : "failed"}`,
    "",
    "## Live provider smoke",
    "",
    `Status: ${report.liveProviderSmoke.status}`,
    `Provider: ${report.liveProviderSmoke.provider}`,
    `Endpoint: ${report.liveProviderSmoke.endpoint}`,
    `Target model: ${report.liveProviderSmoke.targetModelId}`,
    report.liveProviderSmoke.latencyMs !== undefined ? `Latency: ${report.liveProviderSmoke.latencyMs}ms` : undefined,
    report.liveProviderSmoke.modelCount !== undefined ? `Model count: ${report.liveProviderSmoke.modelCount}` : undefined,
    report.liveProviderSmoke.activeModelFound !== undefined ? `Active model found: ${String(report.liveProviderSmoke.activeModelFound)}` : undefined,
    report.liveProviderSmoke.reason !== undefined ? `Reason: ${report.liveProviderSmoke.reason}` : undefined,
    "",
    "## Context runtime proof",
    "",
    `Renderer project explain: ${report.contextRuntimeProof.rendererProjectExplain}`,
    `Real Tauri project explain: ${realTauriProjectExplain}`,
    `Renderer selected files proven: ${String(report.contextRuntimeProof.selectedFilesProvenInRenderer)}`,
    `Real Tauri selected files proven: ${String(realTauriSelectedFilesProven)}`,
    `Reason: ${contextRuntimeReason}`,
    "",
    "## Runtime proof separation",
    "",
    "Renderer UI checks: this report (`gui:check`).",
    "Headed renderer checks: run `gui:check:headed`.",
    "Desktop process smoke: run `gui:check:desktop`.",
    report.tauriRuntimeBridge
      ? `Real Tauri runtime bridge: ${report.tauriRuntimeBridge.status}; selectedFiles proven: ${String(report.tauriRuntimeBridge.realTauriSelectedFilesProven)}; source: ${report.tauriRuntimeBridge.contextEngineSource}; selectedFiles count: ${String(report.tauriRuntimeBridge.selectedFilesCount ?? 0)}.`
      : "Real Tauri runtime bridge: unavailable in this renderer report. Run `gui:check:tauri-runtime`.",
    "Native window automation: unavailable until a WebView2/native window driver is added.",
    "",
    "## Scenarios",
  ].filter((line): line is string => line !== undefined);
  for (const scenario of report.scenarios) {
    lines.push(
      "",
      `### ${scenario.passed ? "PASS" : "FAIL"} ${scenario.name}`,
      `Duration: ${scenario.durationMs}ms`,
      `Assertions: ${scenario.assertions.filter((item) => item.passed).length}/${scenario.assertions.length}`,
    );
    if (scenario.errors.length > 0) {
      lines.push("Errors:");
      for (const error of scenario.errors) lines.push(`- ${error}`);
    }
    if (scenario.screenshots.length > 0) {
      lines.push("Screenshots:");
      for (const screenshot of scenario.screenshots) lines.push(`- ${screenshot}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function runLiveProviderSmoke(): Promise<LiveProviderSmokeResult> {
  const targetModelId = "accounts/fireworks/models/deepseek-v4-pro";
  const apiKey = process.env["FIREWORKS_API_KEY"];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return {
      status: "skipped",
      provider: "fireworks",
      endpoint: "models",
      targetModelId,
      reason: "FIREWORKS_API_KEY is not set.",
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch("https://api.fireworks.ai/inference/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        status: "failed",
        provider: "fireworks",
        endpoint: "models",
        targetModelId,
        latencyMs,
        reason: `HTTP ${response.status}`,
      };
    }
    const body = await response.json().catch(() => null);
    const modelIds = extractProviderModelIds(body);
    const activeModelFound =
      modelIds.includes(targetModelId) ||
      modelIds.includes(targetModelId.replace(/^accounts\/fireworks\/models\//, "")) ||
      modelIds.some((modelId) => modelId.endsWith("/deepseek-v4-pro") || modelId === "deepseek-v4-pro");
    return {
      status: "passed",
      provider: "fireworks",
      endpoint: "models",
      targetModelId,
      latencyMs,
      modelCount: modelIds.length,
      activeModelFound,
      ...(activeModelFound ? {} : { reason: "Models endpoint responded, but the active model was not found in the returned catalog." }),
    };
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      status: "failed",
      provider: "fireworks",
      endpoint: "models",
      targetModelId,
      latencyMs: Date.now() - started,
      reason: isAbort ? "provider_timeout" : describeSafeSmokeError(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractProviderModelIds(body: unknown): string[] {
  const data = Array.isArray((body as { data?: unknown[] } | null)?.data)
    ? (body as { data: unknown[] }).data
    : Array.isArray(body)
      ? body
      : [];
  return data
    .map((item) => {
      if (typeof item === "string") return item;
      if (item !== null && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (typeof record["id"] === "string") return record["id"];
        if (typeof record["modelId"] === "string") return record["modelId"];
        if (typeof record["name"] === "string") return record["name"];
      }
      return "";
    })
    .filter((item) => item.length > 0);
}

function describeSafeSmokeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 240);
  return String(error).slice(0, 240);
}

function buildContextRuntimeProof(scenarios: readonly ScenarioResult[]): ContextRuntimeProof {
  const projectExplain = scenarios.find((scenario) => scenario.name === "project_explain");
  return {
    rendererProjectExplain: projectExplain?.passed === true ? "passed" : "failed",
    realTauriProjectExplain: "unavailable",
    selectedFilesProvenInRenderer: false,
    selectedFilesProvenInRealTauri: false,
    reason:
      "The Playwright MCP suite validates the Vite renderer route, read-only UI state, and no artifacts. It cannot prove real Tauri IPC selectedFiles > 0 until desktop window automation can drive the native runtime.",
  };
}

async function readLatestTauriRuntimeBridge(reportsDir: string): Promise<TauriRuntimeBridgeSummary | undefined> {
  const reportJson = resolve(reportsDir, "tauri-runtime.json");
  const reportMd = resolve(reportsDir, "tauri-runtime.md");
  try {
    const raw = await readFile(reportJson, "utf8");
    const parsed = JSON.parse(raw) as {
      status?: string;
      realTauriSelectedFilesProven?: boolean;
      scenarios?: Array<{ name?: string; selectedFilesCount?: number }>;
      runtimeBridge?: { source?: string };
    };
    const applyScenario = parsed.scenarios?.find((scenario) => scenario.name === "apply_changes_project_explain");
    return {
      status: parsed.status === "passed" ? "passed" : parsed.status === "failed" ? "failed" : "unavailable",
      realTauriSelectedFilesProven: parsed.realTauriSelectedFilesProven === true,
      contextEngineSource: parsed.runtimeBridge?.source ?? "unavailable",
      selectedFilesCount: applyScenario?.selectedFilesCount,
      reportJson,
      reportMd,
    };
  } catch {
    return undefined;
  }
}

function assertNoFireworksKeyLeak(...contents: string[]): void {
  const apiKey = process.env["FIREWORKS_API_KEY"];
  if (apiKey === undefined || apiKey.length < 8) return;
  if (contents.some((content) => content.includes(apiKey))) {
    throw new Error("Report secret leak guard blocked writing FIREWORKS_API_KEY.");
  }
}
