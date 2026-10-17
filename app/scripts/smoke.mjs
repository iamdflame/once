#!/usr/bin/env node
// End-to-end smoke test of the host API against a running world, with real Stripe test mode.
//
//   1. creates a EUR 50 manual-capture hold PaymentIntent directly (pm_card_visa, confirmed);
//   2. binds it to the charger's next episode (world POST /hold);
//   3. turns dup_stop (and queue_offline) on, plays plug -> cut -> unplug -> restore;
//   4. ticks POST /api/settle/tick (two concurrent calls per tick, to exercise the guard);
//   5. checks Stripe: exactly one successful capture, and the duplicate refused by Stripe.
//   --agent then runs POST /api/agent/fix and reports whether settle.js passes all 30 seeds.
//
// Prereqs: the world running (node world/src/index.js, or the bundle), and the host:
//   WORLD_URL=http://127.0.0.1:8080 npm run dev        (in app/)
//   node scripts/smoke.mjs [--charger CP07] [--host http://localhost:3000] [--world http://127.0.0.1:8080] [--agent] [--no-reset]
//   (it resets the world it is pointed at: use a local world, not the demo sandbox)
//
// Reads STRIPE_SECRET_KEY and WORLD_URL from the environment or app/.env.local. Test keys only.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

// ---------- config ----------
function loadDotenv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadDotenv(path.join(APP, ".env.local"));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const HOST = opt("--host", process.env.HOST_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const WORLD = (opt("--world", process.env.WORLD_URL ?? "http://127.0.0.1:8080")).replace(/\/+$/, "");
const CHARGER = opt("--charger", "CP07");
const SK = process.env.STRIPE_SECRET_KEY;
if (!SK) die("STRIPE_SECRET_KEY is not set (app/.env.local)");
if (/^(sk|rk)_live_/.test(SK)) die("refusing a live Stripe key");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
const eur = (c) => `EUR ${(c / 100).toFixed(2)}`;

async function http(method, url, body, { text = false } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    if (text) {
      init.headers["content-type"] = "text/javascript";
      init.body = body;
    } else {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  const r = await fetch(url, init);
  const t = await r.text();
  let j;
  try {
    j = t ? JSON.parse(t) : null;
  } catch {
    j = t;
  }
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status}: ${typeof j === "string" ? j : JSON.stringify(j)}`);
  return j;
}

async function stripeApi(method, p, form) {
  const r = await fetch(`https://api.stripe.com/v1${p}`, {
    method,
    headers: { Authorization: `Bearer ${SK}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${method} ${p} -> ${r.status}: ${j?.error?.message}`);
  return j;
}

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

// ---------- run ----------
console.log(`Once smoke test: host ${HOST}, world ${WORLD}, charger ${CHARGER}`);

step(1, "host and world are up");
const ensure = await http("POST", `${HOST}/api/world/ensure`, {});
console.log(`    host ensure: mode=${ensure.mode} healthy=${ensure.healthy} url=${ensure.url}`);
if (!ensure.healthy) die("world not healthy through the host");
await http("GET", `${WORLD}/health`);

if (!flag("--no-reset")) {
  // A clean board with the shipped v1-naive settle.js (POST /reset {settle: "v1"}).
  await http("POST", `${WORLD}/reset`, { settle: "v1" });
  console.log("    world reset to a clean board with v1-naive.js");
  for (let i = 0; i < 20; i++) {
    const h = await http("GET", `${WORLD}/health`);
    if (h.online === 12) break;
    await sleep(500);
  }
}
const settle = await http("GET", `${WORLD}/settle`);
console.log(`    settle.js v${settle.version}: ${String(settle.source).split("\n")[0].slice(0, 90)}`);

step(2, "quirks: dup_stop on, queue_offline on, reboot_restart off");
for (const [quirk, on] of [["dup_stop", true], ["queue_offline", true], ["reboot_restart", false]]) {
  await http("POST", `${HOST}/api/world/cmd`, { op: "quirk", charger: CHARGER, quirk, on });
}

step(3, "Stripe: create and confirm a EUR 50.00 manual-capture hold (pm_card_visa)");
const pi = await stripeApi("POST", "/payment_intents", {
  amount: "5000",
  currency: "eur",
  capture_method: "manual",
  payment_method: "pm_card_visa",
  "automatic_payment_methods[enabled]": "true",
  "automatic_payment_methods[allow_redirects]": "never",
  confirm: "true",
  description: `Once smoke test hold ${CHARGER}`,
  "metadata[app]": "once",
  "metadata[charger]": CHARGER,
  "metadata[smoke]": "1",
});
console.log(`    ${pi.id}: ${pi.status}, capturable ${eur(pi.amount_capturable)}`);
if (pi.status !== "requires_capture") die(`expected requires_capture, got ${pi.status}`);

step(4, `bind the hold to ${CHARGER}'s next episode (world POST /hold)`);
const hold = await http("POST", `${WORLD}/hold`, { charger: CHARGER, payment_intent: pi.id, amount_cents: pi.amount_capturable });
console.log(`    ${JSON.stringify(hold).slice(0, 160)}`);

step(5, "plug -> (meter) -> cut -> unplug while offline -> restore");
const cmd = (op) => http("POST", `${HOST}/api/world/cmd`, { op, charger: CHARGER });
await cmd("plug");
console.log("    plugged; metering for 5 s");
await sleep(5000);
await cmd("cut");
console.log("    link cut");
await sleep(1500);
await cmd("unplug");
console.log("    unplugged while offline (StopTransaction queued)");
await sleep(1500);
await cmd("restore");
console.log("    link restored; waiting for the queued StopTransaction (twice, ~1.2 s apart)");

step(6, "tick /api/settle/tick (2 concurrent calls per tick) until the hold is settled");
const mine = new Map();
let lastNewAt = 0;
for (let t = 0; t < 40; t++) {
  const [a, b] = await Promise.all([http("POST", `${HOST}/api/settle/tick`), http("POST", `${HOST}/api/settle/tick`)]);
  for (const r of [a, b]) {
    if (r.error) console.log(`    tick error: ${r.error}`);
    for (const p of r.processed ?? []) {
      if (p.payment_intent !== pi.id || mine.has(p.id)) continue;
      mine.set(p.id, p);
      lastNewAt = Date.now();
      console.log(
        `    intent ${p.id} [${p.intent_id}] (episode ${p.episode_id}) ${eur(p.amount_cents)} -> ${p.ok ? "CAPTURED" : "REFUSED"} status=${p.status}${p.replayed ? " (idempotent replay)" : ""}${p.error ? `\n        Stripe: "${p.error}"` : ""}`,
      );
    }
  }
  if (mine.size > 0 && Date.now() - lastNewAt > 5000) break; // settled: nothing new for 5 s
  await sleep(1000);
}

step(7, "verify on Stripe");
const after = await stripeApi("GET", `/payment_intents/${pi.id}`);
const results = [...mine.values()];
const succeeded = results.filter((r) => r.ok);
const refused = results.filter((r) => !r.ok);
console.log(`    Stripe ${pi.id}: status=${after.status} amount_received=${eur(after.amount_received)} of ${eur(after.amount)} authorised`);
console.log(`    host saw ${results.length} capture intent(s): ${succeeded.length} captured, ${refused.length} refused`);
console.log(`    dashboard: https://dashboard.stripe.com/test/payments/${pi.id}`);
const proof = await http("GET", `${HOST}/api/proof`);
const holdProof = (proof.holds ?? []).find((h) => h.payment_intent === pi.id);
if (holdProof) console.log(`    /api/proof: ${holdProof.captures_succeeded} succeeded, ${holdProof.refusals.length} refusal(s)`);

let ok = true;
const fail = (msg) => {
  ok = false;
  console.log(`    x ${msg}`);
};
if (after.status !== "succeeded") fail("PaymentIntent is not captured");
if (succeeded.length !== 1) fail(`expected exactly one successful capture, got ${succeeded.length}`);
if (succeeded[0] && after.amount_received !== succeeded[0].amount_cents) fail("captured amount differs from the intent");
const naive = /naive/i.test(String(settle.name ?? "")) || /naive/i.test(String(settle.source).slice(0, 400));
if (naive && refused.length < 1) fail("expected v1 to emit a duplicate that Stripe refuses");
if (refused.some((r) => !r.error)) fail("a refusal arrived without Stripe's message");
console.log(ok ? `    OK: Stripe captured once (${eur(after.amount_received)}); ${refused.length} duplicate attempt(s) refused by Stripe` : "    FAILED");

// ---------- agent ----------
if (flag("--agent")) {
  step(8, "agent: POST /api/agent/fix (streaming)");
  const r = await fetch(`${HOST}/api/agent/fix`, { method: "POST" });
  if (!r.ok) die(`agent/fix -> ${r.status}: ${await r.text()}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let done = null;
  let chars = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.type === "delta" || e.type === "reasoning") {
        chars += e.text.length;
        continue;
      }
      if (chars) {
        console.log(`    ... ${chars} chars streamed from the model`);
        chars = 0;
      }
      if (e.type === "scenario") continue;
      if (e.type === "suite") console.log(`    suite (${e.phase}${e.attempt ? " " + e.attempt : ""}) v${e.report.version}: ${JSON.stringify(e.report.totals)}`);
      else if (e.type === "diff") console.log(`    diff attempt ${e.attempt}: +${e.added} -${e.removed} lines -> ${e.version}`);
      else if (e.type === "thinking") console.log(`    thinking (${e.model}, ${(e.ms / 1000).toFixed(1)} s): ${e.text.replace(/\s+/g, " ").slice(0, 300)}`);
      else if (e.type === "done") {
        done = e;
        console.log(`    DONE ok=${e.ok} attempts=${e.attempts} version=${e.version} model=${e.model ?? "-"}: ${e.reason}`);
      }
      else if (e.type === "model") console.log(`    model answered: ${e.name} (${e.provider})`);
      else if (e.type !== "fallback") console.log(`    ${e.type}: ${e.text ?? e.error ?? (e.n ? `${e.n}/${e.of}` : "")}`);
    }
  }
  if (!done?.ok) ok = false;
}

process.exit(ok ? 0 : 1);
