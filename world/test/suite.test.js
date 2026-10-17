import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSuite, runScenario } from '../src/runner.js';
import { generateScenario, ARCHETYPES } from '../src/scenarios.js';

const v1 = fs.readFileSync(new URL('../settlers/v1-naive.js', import.meta.url), 'utf8');
const ref = fs.readFileSync(new URL('../settlers/reference-episode-ledger.js', import.meta.url), 'utf8');

const seedsOf = (name) => Array.from({ length: 30 }, (_, i) => i + 1).filter((s) => generateScenario(s).name === name);

test('the default 30 seeds cover every archetype and every fault family', () => {
  const scs = Array.from({ length: 30 }, (_, i) => generateScenario(i + 1));
  assert.deepEqual(new Set(scs.map((s) => s.name)), new Set(ARCHETYPES));
  const faults = new Set(scs.flatMap((s) => s.faults));
  for (const f of ['cut', 'unplug_offline', 'restore', 'dup_stop', 'reboot_restart', 'stop_without_start', 'meter_reset', 'clock_skew', 'ack_lost']) {
    assert.ok(faults.has(f), `fault ${f} appears in the suite`);
  }
});

test('v1-naive double-captures under dup_stop', async () => {
  const seeds = seedsOf('dup-stop');
  assert.ok(seeds.length >= 3);
  const rep = await runSuite({ source: v1, seeds });
  for (const s of rep.scenarios) {
    assert.equal(s.ok, false, `seed ${s.seed} should fail under v1`);
    assert.ok(s.double >= 1, `seed ${s.seed} shows a double capture`);
    assert.ok(s.notes.some((n) => /remainder of the authorized amount has been released|status of succeeded/.test(n)), 'the authority refused the second capture');
  }
});

test('v1-naive double-captures under reboot_restart (one plug-in, two transactions)', async () => {
  const rep = await runSuite({ source: v1, seeds: seedsOf('reboot-restart') });
  assert.ok(rep.scenarios.length >= 3);
  for (const s of rep.scenarios) {
    assert.ok(s.double >= 1, `seed ${s.seed} shows a double capture`);
    assert.ok(s.underbilled >= 1, `seed ${s.seed}: the first partial capture released the rest`);
  }
});

test('v1-naive fails the default suite with doubles', async () => {
  const rep = await runSuite({ source: v1 });
  assert.equal(rep.totals.scenarios, 30);
  assert.ok(rep.totals.double > 0);
  assert.ok(rep.totals.failed > 20);
});

test('the reference episode ledger passes all 30 default seeds with 0 double, 0 stranded, 0 unbilled', async () => {
  const rep = await runSuite({ source: ref, count: 30, seed: 1 });
  assert.equal(rep.totals.scenarios, 30);
  for (const s of rep.scenarios) {
    assert.equal(s.ok, true, `seed ${s.seed} (${s.name}): ${s.notes.join(' | ')} ${s.error || ''}`);
    assert.equal(s.double, 0);
    assert.equal(s.stranded, 0);
    assert.equal(s.unbilled, 0);
    assert.equal(s.overbilled, 0);
  }
  assert.equal(rep.ok, true);
  assert.equal(rep.totals.captured_cents, rep.totals.expected_cents);
});

test('scenarios are fully deterministic from their seed', async () => {
  const strip = (r) => JSON.stringify({ ...r, ms: 0 });
  const a = await runSuite({ source: v1, seeds: [3, 9, 19] });
  const b = await runSuite({ source: v1, seeds: [3, 9, 19] });
  assert.equal(strip(a), strip(b));
  assert.deepEqual(generateScenario(17), generateScenario(17));
  const t1 = await runScenario(9, ref, { trace: true });
  const t2 = await runScenario(9, ref, { trace: true });
  assert.equal(JSON.stringify(t1.trace.feed), JSON.stringify(t2.trace.feed));
});

test('a settle.js that never captures strands every hold', async () => {
  const idle = 'export function createSettler() { return { onEvent() {}, intents() { return []; } }; }';
  const rep = await runSuite({ source: idle, seeds: [1, 2] });
  for (const s of rep.scenarios) {
    assert.equal(s.stranded, s.episodes);
    assert.equal(s.unbilled, s.episodes);
  }
});

test('a settle.js that does not load fails every scenario with the load error', async () => {
  const rep = await runSuite({ source: 'export const x = 1;', seeds: [1] });
  assert.equal(rep.ok, false);
  assert.match(rep.scenarios[0].error, /createSettler/);
});

test('intents for unknown payment intents are rejected and counted invalid', async () => {
  const rogue = `export function createSettler() { const out = []; return { onEvent(e) { if (e.type === 'hold' && !out.length) out.push({ intent_id: 'x', episode_id: 'x', charger: e.charger, payment_intent: 'pi_somebody_else', amount_cents: 100 }); }, intents() { return out; } }; }`;
  const rep = await runSuite({ source: rogue, seeds: [1] });
  assert.equal(rep.scenarios[0].invalid, 1);
  assert.equal(rep.scenarios[0].ok, false);
});
