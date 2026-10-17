// Screenshots of every screen at desktop and phone width, plus a console error
// check and a horizontal-overflow check at phone width. Uses the Playwright
// install at a path given by PLAYWRIGHT_DIR (or the app's own node_modules).
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

// After the board, the bench and the proof are reached by client-side links so the
// mock world (in memory) carries the demo state along, as it does for a person.
// The company pages are plain navigations.
const screens = [
  { name: "board", path: "/", prep: "demo" },
  { name: "bench", link: /^Fix it on the bench$/, wait: 17000 },
  { name: "proof", link: /^Proof$/, wait: 1200, prep: "probe" },
  { name: "bench-last", link: /^Bench$/, wait: 1500 },
  { name: "status", path: "/status", wait: 16000 },
  { name: "pricing", path: "/pricing", wait: 600 },
  { name: "docs", path: "/docs", wait: 600 },
  { name: "security", path: "/security", wait: 600 },
  { name: "terms", path: "/terms", wait: 400 },
  { name: "privacy", path: "/privacy", wait: 400 },
  { name: "about", path: "/about", wait: 600 },
];

const sizes = [
  { tag: "desktop", width: 1440, height: 900, scale: 1 },
  { tag: "phone", width: 390, height: 844, scale: 2, mobile: true },
];

const errors = [];
const overflow = [];
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

    for (const sc of screens) {
      if (sc.path) {
        const sep = sc.path.includes("?") ? "&" : "?";
        await page.goto(`${base}${sc.path}${sep}mode=${mode}`, { waitUntil: "load" });
        await page.waitForTimeout(600);
      } else {
        await page.getByRole("link", { name: sc.link }).first().click();
        await page.waitForTimeout(1500);
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      if (sc.prep === "demo" && mode === "mock") await playDemo(page);
      if (sc.prep === "probe") {
        await page.getByRole("button", { name: /^Probe the boundary$/ }).click();
        await page.waitForTimeout(mode === "mock" ? 2500 : 20000);
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      if (sc.wait) await page.waitForTimeout(sc.wait);
      const wide = await page.evaluate(() => {
        const w = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        const culprits = [];
        if (w > 0) {
          for (const el of document.querySelectorAll("body *")) {
            const r = el.getBoundingClientRect();
            if (r.right > document.documentElement.clientWidth + 1 && r.width > 0) culprits.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} right=${Math.round(r.right)}`);
            if (culprits.length >= 5) break;
          }
        }
        return { w, culprits };
      });
      if (wide.w > 0) overflow.push(`[${size.tag}] ${sc.name}: page is ${wide.w}px wider than the viewport (${wide.culprits.join("; ")})`);
      await page.screenshot({ path: path.join(out, `${sc.name}-${size.tag}.png`), fullPage: false });
      await page.screenshot({ path: path.join(out, `${sc.name}-${size.tag}-full.png`), fullPage: true });
      console.log(`shot ${sc.name} ${size.tag}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (overflow.length) {
  console.log("\nHorizontal overflow:");
  for (const o of overflow) console.log("  " + o);
  process.exitCode = 1;
} else {
  console.log("\nNo horizontal overflow.");
}
if (errors.length) {
  console.log("\nConsole errors:");
  for (const e of errors) console.log("  " + e);
  process.exitCode = 1;
} else {
  console.log("No console errors.");
}

/** The wrong-driver story, driven from the try-it strip: A pays, cut, A unplugs, B pays, restore; wait for the capture. */
async function playDemo(page) {
  const guide = page.getByLabel("Try it in five steps");
  await guide.getByRole("button", { name: /Plug in and pay/ }).click();
  await page.getByRole("button", { name: /^Pay €50\.00$/ }).click();
  await page.waitForTimeout(7800); // 22 kW at 300x and €0.60/kWh: about €11.40 by the unplug
  await guide.getByRole("button", { name: /Cut the cable/ }).click();
  await page.waitForTimeout(3400);
  await guide.getByRole("button", { name: /^Unplug/ }).click();
  await page.waitForTimeout(1500);
  await guide.getByRole("button", { name: /Next driver pays/ }).click();
  await page.waitForTimeout(1500);
  await guide.getByRole("button", { name: /Restore/ }).click();
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.scrollTo(0, 0));
}
