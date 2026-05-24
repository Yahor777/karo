import { resolve } from "node:path";
import type { KaroAutomationContext } from "./app.js";
import { resolveSelector } from "./selectors.js";

export async function karoScreenshot(
  ctx: KaroAutomationContext,
  input: { name?: string; fullPage?: boolean } = {},
): Promise<{ path: string }> {
  await ctx.ensureArtifactDirs();
  const path = await captureWithFallback(
    resolve(ctx.state.screenshotsDir, sanitizeName(input.name ?? "screenshot") + ".png"),
    (target) => ctx.page.screenshot({ path: target, fullPage: input.fullPage ?? true }),
  );
  return { path };
}

export async function karoScreenshotElement(
  ctx: KaroAutomationContext,
  input: { selector?: string; testId?: string; name?: string },
): Promise<{ path: string; selector: string }> {
  await ctx.ensureArtifactDirs();
  const selector = resolveSelector(input);
  const path = await captureWithFallback(
    resolve(ctx.state.screenshotsDir, sanitizeName(input.name ?? "element") + ".png"),
    (target) => ctx.page.locator(selector).first().screenshot({ path: target }),
  );
  return { path, selector };
}

async function captureWithFallback(
  stablePath: string,
  capture: (target: string) => Promise<unknown>,
): Promise<string> {
  try {
    await capture(stablePath);
    return stablePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/EPERM|EBUSY|EACCES/i.test(message)) throw error;
    const fallbackPath = stablePath.replace(/\.png$/i, `-${Date.now().toString(36)}.png`);
    await capture(fallbackPath);
    return fallbackPath;
  }
}

function sanitizeName(name: string): string {
  return name
    .replace(/[^a-z0-9а-яё._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}
