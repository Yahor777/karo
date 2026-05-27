import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const designDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(designDir, "../../..");
const requireFromDesktop = createRequire(
  path.join(repoRoot, "apps", "desktop-windows", "package.json"),
);
const { chromium } = requireFromDesktop("playwright");

const htmlPath = path.join(designDir, "mockup.html");
const pageUrl = pathToFileURL(htmlPath).href;

const shots = [
  ["windows-cockpit.png", '[data-shot="windows-cockpit"]'],
  ["windows-agent.png", '[data-shot="windows-agent"]'],
  ["windows-preview-apply.png", '[data-shot="windows-preview-apply"]'],
  ["windows-recovery.png", '[data-shot="windows-recovery"]'],
  ["web-cockpit.png", '[data-shot="web-cockpit"]'],
  ["web-compact.png", '[data-shot="web-compact"]'],
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1030 },
    deviceScaleFactor: 1,
  });
  await page.goto(pageUrl, { waitUntil: "load" });

  for (const [fileName, selector] of shots) {
    await page.locator(selector).screenshot({
      path: path.join(designDir, fileName),
      animations: "disabled",
    });
  }
} finally {
  await browser.close();
}

for (const [fileName] of shots) {
  const stat = await fs.stat(path.join(designDir, fileName));
  console.log(`${fileName} ${stat.size} bytes`);
}
