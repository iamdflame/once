#!/usr/bin/env node
// The wrong-driver capture, end to end against a LOCAL world with real Stripe test mode.
//
//   Driver A pays a EUR 50 hold on CP07 and charges. The cable is cut; A unplugs while the
//   charger is offline (its StopTransaction is queued). Driver B pays a EUR 50 hold on CP07
//   (POST /api/hold/next). The link is restored, A's queued Stop arrives, then B charges and
//   leaves. The host ticks /api/settle/tick and Stripe answers.
//
//   Phase 1, settle.js v1 (naive): A's energy is captured from B's PaymentIntent and Stripe
//   says "succeeded"; B's own capture is refused (B's hold is already captured); A's hold
//   is stranded (still requires_capture). The world attributes it: driver B, energy A.
//   Phase 2, the reference episode ledger (tests only, PUT /settle): A is captured on A's
//   hold for A's energy, B on B's hold for B's energy.
//
// Prereqs: a local world and the host pointed at it:
//   PORT=8080 node world/dist/world.cjs
//   WORLD_URL=http://127.0.0.1:8080 npm run dev                    (in app/)
//   node scripts/wrong-driver.mjs [--host http://localhost:3000] [--world http://127.0.0.1:8080] [--charger CP07]
// It resets the world it points at and refuses a non-local world. Test keys only.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const REF = path.resolve(APP, "..", "world", "settlers", "reference-episode-ledger.js");

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
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const HOST = opt("--host", process.env.HOST_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const WORLD = opt("--world", process.env.WORLD_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const CHARGER = opt("--charger", "CP07");
const SK = process.env.STRIPE_SECRET_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eur = (c) => `EUR ${(Number(c ?? 0) / 100).toFixed(2)}`;
function die(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
if (!SK) die("STRIPE_SECRET_KEY is not set (app/.env.local)");
if (/^(sk|rk)_live_/.test(SK)) die("refusing a live Stripe key");
if (!/^https?:\/\/(127\.|localhost|\[::1\])/.test(WORLD)) die(`refusing to reset a non-local world (${WORLD}); this script is for a local world`);
if (!existsSync(REF)) die(`reference ledger not found at ${REF}`);

async function http(method, url, body, { text = false } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = text ? "text/javascript" : "application/json";
    init.body = text ? body : JSON.stringify(body);
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

const cmd = (op) => http("POST", `${HOST}/api/world/cmd`, { op, charger: CHARGER });
const worldState = () => http("GET", `${WORLD}/state?events=0`);
let failures = 0;
const check = (cond, msg) => {
  console.log(`    ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

async function untilOnline() {
  for (let i = 0; i < 40; i++) {
    const h = await http("GET", `${WORLD}/health`);
    if (h.online === 12) return;
    await sleep(250);
  }
  die("the world's chargers did not come back online");
}

/** Plays the sequence once and returns what Stripe and the world say. */
async function play(label) {
  console.log(`\n=== ${label} ===`);
  const settle = await http("GET", `${WORLD}/settle`);
  console.log(`  settle.js v${settle.version} (${settle.name})`);

  // Driver A: the hold the board gets from Checkout; here a confirmed test PaymentIntent bound with /hold
  // (no driver label passed: the world names the first hold on the charger "A").
  const a = await stripeApi("POST", "/payment_intents", {
    amount: "5000",
    currency: "eur",
    capture_method: "manual",
    payment_method: "pm_card_visa",
    "automatic_payment_methods[enabled]": "true",
    "automatic_payment_methods[allow_redirects]": "never",
    confirm: "true",
    description: `Once wrong-driver test, driver A, ${CHARGER}`,
    "metadata[app]": "once",
    "metadata[charger]": CHARGER,
    "metadata[driver]": "A",
  });
  const boundA = await http("POST", `${WORLD}/hold`, { charger: CHARGER, payment_intent: a.id, amount_cents: a.amount_capturable });
  console.log(`  [1] driver A: ${a.id} ${a.status}, bound as driver ${boundA.hold.driver} (seq ${boundA.hold.seq})`);

  await cmd("plug");
  console.log("  [2] A plugs in and charges for 6 s (30 world minutes at 300x)");
  await sleep(6000);
  await cmd("cut");
  console.log("  [3] cable cut: CP07 is offline, still metering");
  await sleep(1500);
  await cmd("unplug");
  console.log("  [4] A unplugs while offline: StopTransaction queued in the charger");
  await sleep(1000);

  const b = await http("POST", `${HOST}/api/hold/next`, { charger: CHARGER });
  console.log(`  [5] POST /api/hold/next -> ${b.payment_intent} driver ${b.driver}: ${b.label}`);
  check(b.driver === "B", `the next hold is labelled driver B (got ${b.driver})`);
  check(b.stripe?.status === "requires_capture", `Stripe: ${b.payment_intent} is requires_capture`);

  await cmd("restore");
  console.log("  [6] link restored: A's queued StopTransaction arrives after B's hold");
  await sleep(3000);
  await cmd("plug");
  console.log("  [7] B plugs in and charges for 4 s, then leaves (online)");
  await sleep(4000);
  await cmd("unplug");

  // The settlement tick, as the board runs it (two concurrent calls per tick).
  const seen = new Map();
  let lastNew = Date.now();
  for (let t = 0; t < 60; t++) {
    const rs = await Promise.all([http("POST", `${HOST}/api/settle/tick`), http("POST", `${HOST}/api/settle/tick`)]);
    for (const r of rs) {
      for (const p of r.processed ?? []) {
        if (![a.id, b.payment_intent].includes(p.payment_intent) || seen.has(p.id)) continue;
        seen.set(p.id, p);
        lastNew = Date.now();
        console.log(
          `      tick: ${p.id} capture ${eur(p.amount_cents)} on driver ${p.driver}'s hold for driver ${p.energy_driver}'s energy (${p.energy_episode_id})${p.wrong_driver ? " WRONG DRIVER" : ""} -> ${p.ok ? "Stripe: succeeded" : `Stripe refused: "${p.error}"`}`,
        );
      }
    }
    if (seen.size > 0 && Date.now() - lastNew > 6000) break;
    await sleep(1000);
  }

  const st = await worldState();
  const eps = st.episodes.filter((e) => e.payment_intent === a.id || e.payment_intent === b.payment_intent);
  const epA = eps.find((e) => e.payment_intent === a.id);
  const epB = eps.find((e) => e.payment_intent === b.payment_intent);
  const holdA = st.holds.find((h) => h.payment_intent === a.id);
  const holdB = st.holds.find((h) => h.payment_intent === b.payment_intent);
  const sa = await stripeApi("GET", `/payment_intents/${a.id}`);
  const sb = await stripeApi("GET", `/payment_intents/${b.payment_intent}`);
  const proof = await http("GET", `${HOST}/api/proof`);
  console.log(`  truth: ${epA?.id} (driver A) ${epA?.energy_wh} Wh -> ${eur(epA?.expected_cents)}; ${epB?.id} (driver B) ${epB?.energy_wh} Wh -> ${eur(epB?.expected_cents)}`);
  console.log(`  Stripe: A ${a.id} ${sa.status} received ${eur(sa.amount_received)}; B ${b.payment_intent} ${sb.status} received ${eur(sb.amount_received)}`);
  console.log(`  world: A stranded=${holdA?.stranded} captured_for=${JSON.stringify(holdA?.captured_for)}; B captured_for=${JSON.stringify(holdB?.captured_for)}`);
  for (const c of proof.captures.filter((c) => [a.id, b.payment_intent].includes(c.payment_intent))) console.log(`  /api/proof capture: ${c.story}`);
  for (const d of proof.drivers.filter((d) => [a.id, b.payment_intent].includes(d.payment_intent))) console.log(`  /api/proof driver ${d.driver}: ${d.story}`);
  return { a, b, sa, sb, epA, epB, holdA, holdB, attempts: [...seen.values()], proof };
}

// ---------- run ----------
console.log(`Once wrong-driver test: host ${HOST}, world ${WORLD}, charger ${CHARGER} (Stripe test mode)`);
const ensure = await http("POST", `${HOST}/api/world/ensure`, {});
if (!ensure.healthy || ensure.mode !== "local") die(`the host must run against this local world (WORLD_URL); ensure said mode=${ensure.mode} healthy=${ensure.healthy}`);

await http("POST", `${WORLD}/reset`, { settle: "v1" });
await untilOnline();
const v1 = await play("Phase 1: settle.js v1 (naive)");
{
  const wrong = v1.attempts.find((p) => p.payment_intent === v1.b.payment_intent && p.ok);
  check(!!wrong, "a capture landed on B's PaymentIntent and Stripe said succeeded");
  check(wrong?.driver === "B" && wrong?.energy_driver === "A" && wrong?.wrong_driver === true, "the host's record attributes it: driver B charged for driver A's energy");
  check(v1.sb.status === "succeeded" && v1.sb.amount_received === v1.epA?.expected_cents, `B's PaymentIntent holds A's amount (${eur(v1.sb.amount_received)} = A's ${eur(v1.epA?.expected_cents)})`);
  check(v1.sa.status === "requires_capture" && v1.holdA?.stranded === true, "A's hold is stranded (Stripe: requires_capture; world: stranded)");
  check(v1.attempts.some((p) => p.payment_intent === v1.b.payment_intent && !p.ok && p.energy_driver === "B"), "B's own capture was refused by Stripe (B's hold was already captured)");
  const story = v1.proof.captures.find((c) => c.payment_intent === v1.b.payment_intent && c.status === "succeeded")?.story ?? "";
  check(/^Driver B was charged .* for Driver A's energy; Stripe: succeeded$/.test(story), `/api/proof says: "${story}"`);
  // Tidy: release A's stranded test hold so it does not sit authorised in the test account.
  const rel = await stripeApi("POST", `/payment_intents/${v1.a.id}/cancel`, {});
  console.log(`  cleanup: released driver A's stranded test hold ${v1.a.id} (${rel.status})`);
}

const put = await http("PUT", `${WORLD}/settle`, readFileSync(REF, "utf8"), { text: true });
await http("POST", `${WORLD}/reset`, {}); // keeps the reference program
await untilOnline();
console.log(`\nPUT /settle reference-episode-ledger.js (tests only) -> v${put.version}; board reset`);
const ref = await play("Phase 2: the episode ledger");
{
  const capA = ref.attempts.find((p) => p.payment_intent === ref.a.id && p.ok);
  const capB = ref.attempts.find((p) => p.payment_intent === ref.b.payment_intent && p.ok);
  check(capA?.driver === "A" && capA?.energy_driver === "A" && capA?.wrong_driver === false, "A was charged on A's hold for A's energy");
  check(capB?.driver === "B" && capB?.energy_driver === "B" && capB?.wrong_driver === false, "B was charged on B's hold for B's energy");
  check(ref.sa.status === "succeeded" && ref.sa.amount_received === ref.epA?.expected_cents, `Stripe: A received ${eur(ref.sa.amount_received)} = A's ${eur(ref.epA?.expected_cents)}`);
  check(ref.sb.status === "succeeded" && ref.sb.amount_received === ref.epB?.expected_cents, `Stripe: B received ${eur(ref.sb.amount_received)} = B's ${eur(ref.epB?.expected_cents)}`);
  check(ref.attempts.every((p) => p.ok), "no capture was refused");
  check(!ref.holdA?.stranded && !ref.holdB?.stranded, "no hold is stranded");
}

await http("POST", `${WORLD}/reset`, { settle: "v1" });
console.log(`\nworld reset to v1. ${failures === 0 ? "OK: the wrong-driver capture reproduces under v1 and is gone under the episode ledger" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
