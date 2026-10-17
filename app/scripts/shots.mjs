// Screenshots of every screen at desktop and phone width, plus a console
// error check. Uses the Playwright install at a path given by PLAYWRIGHT_DIR
// (or the app's own node_modules when present).
//
//   node scripts/shots.mjs http://localhost:3100 [outDir] [mock|live]

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const base = process.argv[2] ?? "http://localhost:3100";
const out = process.argv[3] ?? path.resolve("public/shots");
const mode = process.argv[4] ?? "mock";
const pwDir = process.env.PLAYWRIGHT_DIR ?? process.cwd();
const require = createRequire(path.join(pwDir, "package.json"));
const { chromium } = require("playwright");

fs.mkdirSync(out, { recursive: true });

// After the board, every screen is reached by a client-side link so the mock
// world (in memory) carries the demo state along, as it does for a person.
const screens = [
  { name: "board", path: "/", prep: "demo" },
  { name: "bench", link: /^Fix it$/, wait: 17000 },
  { name: "proof", link: /^Proof$/, wait: 1200 },
  { name: "about", link: /^About$/, wait: 600 },
];

const sizes = [
  { tag: "desktop", width: 1440, height: 900, scale: 1 },
  { tag: "phone", width: 390, height: 844, scale: 2, mobile: true },
];

const errors = [];
const browser = await chromium.launch();
try {
  for (const size of sizes) {
    const ctx = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.scale,
      isMobile: size.mobile ?? false,
      hasTouch: size.mobile ?? false,
      reducedMotion: "no-preference",
    });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`[${size.tag}] console.error: ${m.text()}`);
    });
    page.on("pageerror", (e) => errors.push(`[${size.tag}] pageerror: ${e.message}`));

    // One session so the mock world carries the demo state from the board to the bench.
    for (const sc of screens) {
      if (sc.path) {
        const sep = sc.path.includes("?") ? "&" : "?";
        await page.goto(`${base}${sc.path}${sep}mode=${mode}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(600);
      } else {
        await page.getByRole("link", { name: sc.link }).first().click();
        await page.waitForLoadState("networkidle");
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      if (sc.prep === "demo" && mode === "mock") await playDemo(page);
      if (sc.wait) await page.waitForTimeout(sc.wait);
      await page.screenshot({ path: path.join(out, `${sc.name}-${size.tag}.png`), fullPage: false });
      await page.screenshot({ path: path.join(out, `${sc.name}-${size.tag}-full.png`), fullPage: true });
      console.log(`shot ${sc.name} ${size.tag}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (errors.length) {
  console.log("\nConsole errors:");
  for (const e of errors) console.log("  " + e);
  process.exitCode = 1;
} else {
  console.log("\nNo console errors.");
}

/** The demo: select CP07, pay, cut, unplug, restore; wait for the capture. */
async function playDemo(page) {
  const plate = page.getByRole("button", { name: /Charger CP07/ }).first();
  await plate.click();
  await page.getByRole("button", { name: /Plug in and pay/ }).click();
  await page.getByRole("button", { name: /^Pay €50\.00$/ }).click();
  await page.waitForTimeout(13000); // 22 kW at 300x: about 30 kWh by the unplug
  await page.getByRole("button", { name: /Cut cable/ }).click();
  await page.waitForTimeout(3400);
  await page.getByRole("button", { name: /^Unplug$/ }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /^Restore$/ }).click();
  await page.waitForTimeout(5000);
  await page.evaluate(() => window.scrollTo(0, 0));
}
