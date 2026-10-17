// Render /og (a 1200×630 composition) to public/og.png.
//   PLAYWRIGHT_DIR=<dir with playwright> node scripts/og.mjs http://localhost:3000
import { createRequire } from "node:module";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:3000";
const pwDir = process.env.PLAYWRIGHT_DIR ?? process.cwd();
const { chromium } = createRequire(path.join(pwDir, "package.json"))("playwright");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`${base}/og`, { waitUntil: "load" });
await page.addStyleTag({ content: "header, footer, .skip { display: none !important } main { min-height: 0 }" });
await page.waitForTimeout(500);
const el = page.locator("main > div").first();
await el.screenshot({ path: path.resolve("public/og.png") });
console.log("wrote public/og.png");
await browser.close();
