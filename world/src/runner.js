// The scenario runner: plays a seeded fault scenario in discrete-event time against a
// settle.js loaded fresh into its own sandbox, executes its intents on the payment
// authority model, then judges the money per hold against the metered truth:
//
//   double       settlement intents beyond the first for the same hold (a second
//                capture or release of money that was already settled)
//   stranded     holds still uncaptured and unreleased when the scenario ends
//   unbilled     episodes that delivered energy but captured nothing
//   overbilled   episodes captured for more than energy x tariff (capped at the hold)
//   underbilled  episodes captured for less than that
//   invalid      intents the world rejected (unknown payment_intent, bad amount)
//
// A scenario is ok when all six are zero and the program never crashed.

import { VirtualClock } from './clock.js';
import { Rng } from './rng.js';
import { WorldCore } from './core.js';
import { SIM_TIMING } from './firmware.js';
import { VirtualNet } from './transport-virtual.js';
import { PaymentAuthority } from './authority.js';
import { generateScenario } from './scenarios.js';
import { sha256 } from './sandbox.js';

export const DEFAULT_SUITE_SEED = 1;
export const DEFAULT_SUITE_COUNT = 30;
export const TOLERANCE_CENTS = 2;
const T0 = Date.UTC(2026, 9, 17, 6, 0, 0);

const eur = (c) => (c == null ? '-' : `€${(c / 100).toFixed(2)}`);

export async function runScenario(seedOrScenario, source, { tariffCentsPerKwh = 60, trace = false } = {}) {
  const sc = typeof seedOrScenario === 'object' ? seedOrScenario : generateScenario(seedOrScenario);
  const clock = new VirtualClock(T0);
  const authority = new PaymentAuthority();
  const violations = [];
  let net = null;
  const links = { cut: (id) => net.cut(id), restore: (id) => net.restore(id), isCut: (id) => net.isCut(id) };
  const byId = new Map(sc.chargers.map((c) => [c.id, c]));
  const core = new WorldCore({
    clock,
    transport: null,
    links,
    chargerIds: sc.chargers.map((c) => c.id),
    timing: SIM_TIMING,
    tariffCentsPerKwh,
    chargerOptions: (id) => {
      const c = byId.get(id);
      return { quirks: c.quirks, meterWh: c.meter_wh, skewMs: c.skew_s * 1000, rebootReason: c.reboot_reason };
    },
    authority,
    hostDelayMs: 1500,
    tickEvery: 30000,
    seed: sc.seed,
    heartbeatIntervalS: 900,
    maxEvents: 1000000,
  });
  net = new VirtualNet({ clock, rng: new Rng((sc.seed * 7919 + 17) >>> 0), csms: core.csms, onViolation: (v) => violations.push(v) });
  core.setTransport(net);

  let error = null;
  try {
    core.loadSettler(source, { name: 'settle.js' });
  } catch (e) {
    error = `settle.js did not load: ${e.message}`;
  }

  const generatorErrors = [];
  if (!error) {
    core.start();
    for (const a of sc.actions) {
      clock.after(a.at, () => {
        try {
          applyAction(core, net, a);
        } catch (e) {
          generatorErrors.push(`${a.op} ${a.charger} @${Math.round(a.at / 1000)}s: ${e.message}`);
        }
      });
    }
    await clock.runUntil(T0 + sc.duration);
    core.shutdown();
    if (core.settler && core.settler.dead) error = core.settler.dead;
  }

  const report = judge(core, authority, sc, { error, tariffCentsPerKwh });
  if (violations.length) {
    report.ok = false;
    report.notes.push(`OCPP schema violations: ${violations.slice(0, 3).map((v) => `${v.charger} ${v.action}.${v.kind}: ${v.error}`).join('; ')}`);
  }
  if (generatorErrors.length) report.notes.push(`world: ${generatorErrors.slice(0, 3).join('; ')}`);
  report.settler_errors = core.settlerErrors;
  if (core.settler && core.settler.lastError) report.last_settler_error = core.settler.lastError.split('\n')[0];
  if (trace) {
    report.trace = {
      scenario: sc,
      feed: core.feed,
      intents: [...core.intents.values()],
      episodes: core.episodes.map((e) => core.episodeView(e)),
      charger_log: core.events.filter((e) => e.type === 'charger' || e.type === 'cmd').map((e) => ({ seq: e.seq, at: e.at, type: e.type, charger: e.charger, kind: e.kind || e.op, ...pick(e, ['ocpp_action', 'why', 'transactionId', 'queue', 'restart', 'episode_id', 'energy_wh', 'offline']) })),
    };
  }
  return report;
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function applyAction(core, net, a) {
  switch (a.op) {
    case 'hold': core.placeHold({ charger: a.charger, payment_intent: a.payment_intent, amount_cents: a.amount_cents }); break;
    case 'plug': core.plug(a.charger, { powerKw: a.power_kw, idTag: a.id_tag }); break;
    case 'unplug': core.unplug(a.charger); break;
    case 'cut': core.cut(a.charger); break;
    case 'restore': core.restore(a.charger); break;
    case 'reboot': core.reboot(a.charger); break;
    case 'quirk': core.setQuirk(a.charger, a.quirk, a.on); break;
    case 'skew': core.setSkew(a.charger, a.seconds); break;
    case 'lose_ack': net.loseAck(a.charger, a.action, 1); break;
    default: throw new Error(`unknown op ${a.op}`);
  }
}

function judge(core, authority, sc, { error }) {
  const r = {
    seed: sc.seed,
    name: sc.name,
    faults: sc.faults,
    chargers: sc.chargers.map((c) => c.id),
    episodes: 0,
    double: 0,
    stranded: 0,
    unbilled: 0,
    overbilled: 0,
    underbilled: 0,
    invalid: 0,
    ok: false,
    expected_cents: 0,
    captured_cents: 0,
    error,
    notes: [],
  };
  const intents = [...core.intents.values()];
  for (const it of intents) {
    if (it.status === 'rejected') {
      r.invalid++;
      r.notes.push(`invalid intent ${JSON.stringify(it.intent_id)}: ${it.error}`);
    }
  }
  for (const ep of core.episodes) {
    if (!ep.payment_intent) continue;
    r.episodes++;
    const expected = core.expectedCents(ep);
    const pi = authority.get(ep.payment_intent);
    const mine = intents.filter((it) => it.payment_intent === ep.payment_intent && it.status !== 'rejected');
    const captured = pi ? pi.amount_received : 0;
    r.expected_cents += expected;
    r.captured_cents += captured;
    const problems = [];
    if (mine.length > 1) { r.double += mine.length - 1; problems.push(`${mine.length} settlement intents for one hold`); }
    if (pi && pi.status === 'requires_capture') { r.stranded++; problems.push(mine.length ? 'hold left uncaptured' : 'no intent: hold left uncaptured (stranded)'); }
    if (expected > 0 && captured === 0) { r.unbilled++; problems.push('energy delivered but nothing captured'); }
    if (captured > expected + TOLERANCE_CENTS) { r.overbilled++; problems.push(`overbilled: captured ${eur(captured)}`); }
    if (captured > 0 && captured < expected - TOLERANCE_CENTS) { r.underbilled++; problems.push(`underbilled: captured ${eur(captured)}`); }
    if (problems.length) {
      const txs = ep.transactions.map((t) => `${t.startLost ? `local ${t.localId} (Start lost)` : `tx ${t.transactionId ?? `local ${t.localId}`}`} ${t.energyWh} Wh${t.reason ? ` ${t.reason}` : ''}`).join(', ');
      const tried = mine.map((it) => `${it.kind} ${eur(it.amount_cents)} [${it.episode_id ?? it.intent_id}] ${it.result ? (it.result.ok ? 'ok' : `refused: ${it.result.error ? it.result.error.message : it.result.status}`) : it.status}`).join('; ');
      r.notes.push(`${ep.id} ${ep.payment_intent} expected ${eur(expected)} for ${ep.energy_wh} Wh over ${ep.transactions.length} OCPP transaction(s) [${txs}]: ${problems.join('; ')}${tried ? `. Intents: ${tried}` : ''}`);
    }
  }
  r.ok = !error && r.double === 0 && r.stranded === 0 && r.unbilled === 0 && r.overbilled === 0 && r.underbilled === 0 && r.invalid === 0;
  return r;
}

export async function runSuite({ source, count = DEFAULT_SUITE_COUNT, seed = DEFAULT_SUITE_SEED, seeds = null, tariffCentsPerKwh = 60, onScenario = null } = {}) {
  const started = Date.now();
  const list = Array.isArray(seeds) && seeds.length ? seeds.map((s) => s >>> 0) : Array.from({ length: Math.max(1, Math.min(500, count | 0 || DEFAULT_SUITE_COUNT)) }, (_, i) => (seed + i) >>> 0);
  const scenarios = [];
  const totals = { scenarios: 0, passed: 0, failed: 0, episodes: 0, double: 0, stranded: 0, unbilled: 0, overbilled: 0, underbilled: 0, invalid: 0, errors: 0, expected_cents: 0, captured_cents: 0 };
  for (const s of list) {
    const rep = await runScenario(s, source, { tariffCentsPerKwh });
    scenarios.push(rep);
    totals.scenarios++;
    if (rep.ok) totals.passed++; else totals.failed++;
    for (const k of ['episodes', 'double', 'stranded', 'unbilled', 'overbilled', 'underbilled', 'invalid', 'expected_cents', 'captured_cents']) totals[k] += rep[k];
    if (rep.error) totals.errors++;
    if (onScenario) onScenario(rep);
  }
  return {
    ok: totals.failed === 0,
    seeds: list,
    settle_sha256: sha256(source || ''),
    tariff_cents_per_kwh: tariffCentsPerKwh,
    totals,
    summary: `${totals.passed}/${totals.scenarios} ok · double ${totals.double} · stranded ${totals.stranded} · unbilled ${totals.unbilled} · overbilled ${totals.overbilled} · underbilled ${totals.underbilled}`,
    scenarios,
    ms: Date.now() - started,
  };
}
