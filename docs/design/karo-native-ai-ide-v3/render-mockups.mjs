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
  ["mockup-cockpit.png", '[data-shot="cockpit"]'],
  ["mockup-agent-run.png", '[data-shot="agent-run"]'],
  ["mockup-recovery-terminal.png", '[data-shot="recovery-terminal"]'],
  ["mockup-compact.png", '[data-shot="compact"]'],
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1520, height: 1040 },
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
