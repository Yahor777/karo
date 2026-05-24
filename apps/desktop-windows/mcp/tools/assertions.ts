import type { KaroAutomationContext } from "./app.js";
import { byTestId, resolveSelector, TEST_IDS } from "./selectors.js";

export interface AssertionResult {
  readonly name: string;
  readonly passed: boolean;
  readonly details?: string;
}

export async function assertVisible(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string; name?: string },
): Promise<AssertionResult> {
  const selector = resolveSelector(input);
  const visible = await ctx.page.locator(selector).first().isVisible().catch(() => false);
  return {
    name: input.name ?? `visible:${selector}`,
    passed: visible,
    details: visible ? undefined : `${selector} is not visible`,
  };
}

export async function assertNotVisible(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string; name?: string },
): Promise<AssertionResult> {
  const selector = resolveSelector(input);
  const visible = await ctx.page.locator(selector).first().isVisible().catch(() => false);
  return {
    name: input.name ?? `not-visible:${selector}`,
    passed: !visible,
    details: visible ? `${selector} is visible` : undefined,
  };
}

export async function assertTextContains(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string; text: string; name?: string },
): Promise<AssertionResult> {
  const selector = resolveSelector(input);
  const value = await ctx.page.locator(selector).first().textContent().catch(() => null);
  const passed = (value ?? "").includes(input.text);
  return {
    name: input.name ?? `text:${selector}`,
    passed,
    details: passed ? undefined : `Expected "${input.text}" in "${value ?? ""}"`,
  };
}

export async function assertNoHorizontalOverflow(ctx: KaroAutomationContext): Promise<AssertionResult> {
  const result = await ctx.page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return {
      docOverflow: root.scrollWidth - root.clientWidth,
      bodyOverflow: body.scrollWidth - body.clientWidth,
      rootScrollWidth: root.scrollWidth,
      rootClientWidth: root.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      bodyClientWidth: body.clientWidth,
    };
  });
  const overflow = Math.max(result.docOverflow, result.bodyOverflow);
  return {
    name: "no-horizontal-overflow",
    passed: overflow <= 2,
    details: overflow <= 2 ? undefined : JSON.stringify(result),
  };
}

export async function assertElementInsideViewport(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string; name?: string },
): Promise<AssertionResult> {
  const selector = resolveSelector(input);
  const result = await ctx.page.locator(selector).first().evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }).catch((error) => ({ error: String(error) }));
  if ("error" in result) {
    return { name: input.name ?? `inside-viewport:${selector}`, passed: false, details: result.error };
  }
  const passed = result.left >= 0 && result.top >= 0 && result.right <= result.width && result.bottom <= result.height;
  return {
    name: input.name ?? `inside-viewport:${selector}`,
    passed,
    details: passed ? undefined : JSON.stringify(result),
  };
}

export async function assertComposerUsable(ctx: KaroAutomationContext): Promise<AssertionResult> {
  const visible = await ctx.page.locator(byTestId(TEST_IDS.composerTextarea)).isVisible().catch(() => false);
  const sendVisible = await ctx.page.locator(byTestId(TEST_IDS.composerSend)).isVisible().catch(() => false);
  const box = await ctx.page.locator(byTestId(TEST_IDS.composer)).boundingBox().catch(() => null);
  const textareaBox = await ctx.page.locator(byTestId(TEST_IDS.composerTextarea)).boundingBox().catch(() => null);
  const sendBox = await ctx.page.locator(byTestId(TEST_IDS.composerSend)).boundingBox().catch(() => null);
  const passed =
    visible &&
    sendVisible &&
    box !== null &&
    textareaBox !== null &&
    sendBox !== null &&
    box.width >= 360 &&
    box.height >= 120 &&
    textareaBox.height >= 60 &&
    sendBox.width >= 30 &&
    sendBox.height >= 30;
  return {
    name: "composer-usable",
    passed,
    details: passed
      ? undefined
      : `visible=${visible}; sendVisible=${sendVisible}; box=${JSON.stringify(box)}; textarea=${JSON.stringify(textareaBox)}; send=${JSON.stringify(sendBox)}`,
  };
}

export async function assertContextPopoverNotInComposer(ctx: KaroAutomationContext): Promise<AssertionResult> {
  const nestedCount = await ctx.page.locator(
    `${byTestId(TEST_IDS.composer)} ${byTestId(TEST_IDS.contextUsagePopover)}, ${byTestId(TEST_IDS.chatThread)} ${byTestId(TEST_IDS.contextUsagePopover)}`,
  ).count();
  return {
    name: "context-popover-not-in-composer-or-thread",
    passed: nestedCount === 0,
    details: nestedCount === 0 ? undefined : `Nested popover count: ${nestedCount}`,
  };
}

export async function assertNoDuplicateUserMessages(ctx: KaroAutomationContext): Promise<AssertionResult> {
  const texts = await ctx.page.locator(byTestId(TEST_IDS.chatMessageUser)).allTextContents();
  const normalized = texts.map((text) => text.trim()).filter(Boolean);
  const duplicates = normalized.filter((text, index) => normalized.indexOf(text) !== index);
  return {
    name: "no-duplicate-user-messages",
    passed: duplicates.length === 0,
    details: duplicates.length === 0 ? undefined : `Duplicates: ${duplicates.join(" | ")}`,
  };
}

export async function assertSidebarChatsDoNotOverlapFooter(ctx: KaroAutomationContext): Promise<AssertionResult> {
  const result = await ctx.page.evaluate(() => {
    const sidebar = document.querySelector('[data-testid="sidebar"]') as HTMLElement | null;
    const conversations = document.querySelector(".kw-sidebar-conversations") as HTMLElement | null;
    const list = document.querySelector(".kw-conversation-list") as HTMLElement | null;
    const footer = document.querySelector(".kw-sidebar-footer") as HTMLElement | null;
    if (sidebar === null || conversations === null || list === null || footer === null) {
      return { missing: true };
    }
    if (sidebar.dataset["collapsed"] === "true" || getComputedStyle(conversations).display === "none") {
      return { collapsed: true };
    }
    const conversationRect = conversations.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const listStyle = getComputedStyle(list);
    return {
      missing: false,
      collapsed: false,
      conversationBottom: conversationRect.bottom,
      listBottom: listRect.bottom,
      footerTop: footerRect.top,
      footerBottom: footerRect.bottom,
      listOverflowY: listStyle.overflowY,
      listScrollHeight: list.scrollHeight,
      listClientHeight: list.clientHeight,
    };
  });
  if ("missing" in result && result.missing) {
    return { name: "sidebar-chats-do-not-overlap-footer", passed: false, details: "Missing sidebar conversation/footer elements" };
  }
  if ("collapsed" in result && result.collapsed) {
    return { name: "sidebar-chats-do-not-overlap-footer", passed: true };
  }
  const footerGap = result.footerTop - Math.max(result.conversationBottom, result.listBottom);
  const passed = footerGap >= -1 && result.listOverflowY !== "visible";
  return {
    name: "sidebar-chats-do-not-overlap-footer",
    passed,
    details: passed ? undefined : `metrics=${JSON.stringify({ ...result, footerGap })}`,
  };
}

export async function assertNoElementOverlap(
  ctx: KaroAutomationContext,
  input: { firstTestId: string; secondTestId: string; name?: string },
): Promise<AssertionResult> {
  const result = await ctx.page.evaluate(([firstSelector, secondSelector]) => {
    const first = document.querySelector(firstSelector);
    const second = document.querySelector(secondSelector);
    if (first === null || second === null) {
      return { missing: true, firstFound: first !== null, secondFound: second !== null };
    }
    const a = first.getBoundingClientRect();
    const b = second.getBoundingClientRect();
    const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const yOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return {
      missing: false,
      overlapArea: xOverlap * yOverlap,
      first: { left: a.left, top: a.top, right: a.right, bottom: a.bottom },
      second: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
    };
  }, [byTestId(input.firstTestId), byTestId(input.secondTestId)] as const);
  const passed = !result.missing && result.overlapArea === 0;
  return {
    name: input.name ?? `no-overlap:${input.firstTestId}:${input.secondTestId}`,
    passed,
    details: passed ? undefined : JSON.stringify(result),
  };
}

export async function assertResponsiveLayoutQuality(ctx: KaroAutomationContext): Promise<AssertionResult> {
  const result = await ctx.page.evaluate(`(() => {
    const ids = ${JSON.stringify(TEST_IDS)};
    const rectFor = (testId) => {
      const el = document.querySelector('[data-testid="' + testId + '"]');
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const viewportWidth = window.innerWidth;
    const body = document.body;
    const root = document.documentElement;
    const right = rectFor(ids.rightPanel);
    const sidebar = rectFor(ids.sidebar);
    const thread = rectFor(ids.chatThread);
    const composer = rectFor(ids.composer);
    const textarea = rectFor(ids.composerTextarea);
    const send = rectFor(ids.composerSend);
    const rightEl = document.querySelector('[data-testid="' + ids.rightPanel + '"]');
    const rightDisplay = rightEl === null ? "missing" : getComputedStyle(rightEl).display;
    return {
      viewportWidth,
      overflow: Math.max(root.scrollWidth - root.clientWidth, body.scrollWidth - body.clientWidth),
      rightDisplay,
      right,
      sidebar,
      thread,
      composer,
      textarea,
      send,
    };
  })()`) as {
    viewportWidth: number;
    overflow: number;
    rightDisplay: string;
    right: null | { width: number; height: number; left: number; right: number; top: number; bottom: number };
    sidebar: null | { width: number; height: number; left: number; right: number; top: number; bottom: number };
    thread: null | { width: number; height: number; left: number; right: number; top: number; bottom: number };
    composer: null | { width: number; height: number; left: number; right: number; top: number; bottom: number };
    textarea: null | { width: number; height: number; left: number; right: number; top: number; bottom: number };
    send: null | { width: number; height: number; left: number; right: number; top: number; bottom: number };
  };
  const failures: string[] = [];
  if (result.overflow > 2) failures.push(`horizontal overflow ${result.overflow}`);
  if (result.composer === null || result.composer.width < 360) failures.push(`composer too narrow ${JSON.stringify(result.composer)}`);
  if (result.textarea === null || result.textarea.height < 60) failures.push(`textarea too small ${JSON.stringify(result.textarea)}`);
  if (result.send === null || result.send.right > result.viewportWidth || result.send.width < 30) failures.push(`send not reachable ${JSON.stringify(result.send)}`);
  if (result.thread === null || result.thread.width < Math.min(560, result.viewportWidth - 120)) failures.push(`chat thread too narrow ${JSON.stringify(result.thread)}`);
  if (result.viewportWidth <= 1280 && result.rightDisplay !== "none") failures.push(`right panel visible at compact width (${result.viewportWidth})`);
  if (result.viewportWidth <= 1280 && result.sidebar !== null && result.sidebar.width > 88) failures.push(`sidebar too wide at compact width ${result.sidebar.width}`);
  return {
    name: `responsive-layout-quality-${result.viewportWidth}`,
    passed: failures.length === 0,
    details: failures.length === 0 ? undefined : `${failures.join("; ")}; metrics=${JSON.stringify(result)}`,
  };
}

export function summarizeAssertions(assertions: readonly AssertionResult[]): {
  readonly passed: boolean;
  readonly failed: readonly AssertionResult[];
} {
  const failed = assertions.filter((item) => !item.passed);
  return { passed: failed.length === 0, failed };
}
