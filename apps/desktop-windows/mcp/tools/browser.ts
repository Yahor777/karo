import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ElementHandle } from "playwright";
import type { KaroAutomationContext } from "./app.js";
import { resolveSelector } from "./selectors.js";

export async function karoClick(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string; timeoutMs?: number },
): Promise<{ success: true; selector: string }> {
  const selector = resolveSelector(input);
  await ctx.page.locator(selector).first().click({ timeout: input.timeoutMs ?? 10_000 });
  return { success: true, selector };
}

export async function karoFill(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string; text: string; timeoutMs?: number },
): Promise<{ success: true; selector: string; length: number }> {
  const selector = resolveSelector(input);
  await ctx.page.locator(selector).first().fill(input.text, { timeout: input.timeoutMs ?? 10_000 });
  return { success: true, selector, length: input.text.length };
}

export async function karoPress(
  ctx: KaroAutomationContext,
  input: { key: string },
): Promise<{ success: true; key: string }> {
  await ctx.page.keyboard.press(input.key);
  return { success: true, key: input.key };
}

export async function karoSelect(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string; value: string; timeoutMs?: number },
): Promise<{ success: true; selector: string; value: string }> {
  const selector = resolveSelector(input);
  await ctx.page.locator(selector).first().locator("select").selectOption(input.value, {
    timeout: input.timeoutMs ?? 10_000,
  });
  return { success: true, selector, value: input.value };
}

export async function karoHover(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string; timeoutMs?: number },
): Promise<{ success: true; selector: string }> {
  const selector = resolveSelector(input);
  await ctx.page.locator(selector).first().hover({ timeout: input.timeoutMs ?? 10_000 });
  return { success: true, selector };
}

export async function karoGetText(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string; all?: boolean; timeoutMs?: number },
): Promise<{ selector: string; text: string; count: number }> {
  const selector = resolveSelector(input);
  const locator = ctx.page.locator(selector);
  await locator.first().waitFor({ timeout: input.timeoutMs ?? 10_000 });
  const texts = input.all === true ? await locator.allTextContents() : [await locator.first().textContent()];
  return { selector, text: texts.map((text) => text ?? "").join("\n"), count: await locator.count() };
}

export async function karoGetHtml(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string; fileName?: string },
): Promise<{ selector: string; html: string; path?: string }> {
  const selector = resolveSelector(input);
  const html = await ctx.page.locator(selector).first().evaluate((el) => (el as HTMLElement).outerHTML);
  if (input.fileName === undefined) return { selector, html };
  const path = resolve(ctx.state.reportsDir, input.fileName);
  await writeFile(path, html, "utf8");
  return { selector, html, path };
}

export async function karoGetBoundingBox(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string },
): Promise<{ selector: string; box: Awaited<ReturnType<ElementHandle<HTMLElement>["boundingBox"]>> }> {
  const selector = resolveSelector(input);
  const handle = await ctx.page.locator(selector).first().elementHandle();
  if (handle === null) throw new Error(`Element not found: ${selector}`);
  return { selector, box: await handle.boundingBox() };
}

export async function karoGetVisibleState(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string },
): Promise<{ selector: string; visible: boolean; count: number }> {
  const selector = resolveSelector(input);
  const locator = ctx.page.locator(selector);
  return { selector, visible: await locator.first().isVisible().catch(() => false), count: await locator.count() };
}

export async function karoGetAppDiagnostics(ctx: KaroAutomationContext): Promise<unknown> {
  return ctx.page.evaluate(() => {
    const anyWindow = window as unknown as {
      _karoState?: unknown;
      __KARO_STATE__?: unknown;
      localStorage?: Storage;
    };
    const localStorageSnapshot: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key !== null && key.startsWith("karo.")) {
        const value = window.localStorage.getItem(key);
        if (value !== null && !/key|secret|token/i.test(key)) localStorageSnapshot[key] = value;
      }
    }
    return {
      karoState: anyWindow._karoState ?? anyWindow.__KARO_STATE__ ?? null,
      localStorage: localStorageSnapshot,
      url: window.location.href,
      title: document.title,
    };
  });
}
