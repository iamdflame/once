// The wrong-driver capture, over real sockets: driver A charges on CP07, the link is cut,
// A unplugs offline, driver B pays on CP07, the link comes back. Under v1 A's queued
// StopTransaction is billed to B's hold and A's hold is stranded; under an episode ledger
// both drivers are billed for their own energy. Also: the agent-run record and the probe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorld } from '../src/live.js';
import { LIVE_TIMING } from '../src/firmware.js';

const ref = fs.readFileSync(new URL('../settlers/reference-episode-ledger.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'once-state-'));

let world;
let base;

const call = async (method, p, body, headers = {}) => {
  const isText = typeof body === 'string';
  const r = await fetch(base + p, {
    method,
    headers: body === undefined ? headers : { 'content-type': isText ? 'text/javascript' : 'application/json', ...headers },
    body: body === undefined ? undefined : isText ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* raw */ }
  return { status: r.status, json, text };
};

async function until(fn, ms = 10000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(step);
  }
}

const cmd = (op, charger = 'CP07') => call('POST', '/cmd', { op, charger });
const state = async () => (await call('GET', '/state?events=0')).json;
const intentsFor = async (pi) => (await state()).intents.filter((i) => i.payment_intent === pi);
const holdOf = async (pi) => (await state()).holds.find((h) => h.payment_intent === pi);

// A plugs and charges, the link is cut, A unplugs offline, B pays, the link is restored.
async function wrongDriverSequence(piA, piB) {
  assert.equal((await call('POST', '/hold', { charger: 'CP07', payment_intent: piA, amount_cents: 5000 })).status, 201);
  await cmd('plug');
  await until(async () => (await state()).chargers.find((c) => c.id === 'CP07').transaction?.transaction_id);
  await sleep(1200);
  await cmd('cut');
  await until(async () => !(await state()).chargers.find((c) => c.id === 'CP07').online);
  await cmd('unplug');
  const b = await call('POST', '/hold', { charger: 'CP07', payment_intent: piB, amount_cents: 5000, driver: 'B' });
  assert.equal(b.status, 201);
  assert.equal(b.json.hold.driver, 'B');
  assert.equal(b.json.hold.seq, 2);
  await cmd('restore');
}

before(async () => {
  world = await startWorld({ port: 0, host: '127.0.0.1', stateDir, timing: { ...LIVE_TIMING, sampleEvery: 400, reconnectEvery: 200, rebootDowntime: 400, retryEvery: 300 } });
  base = `http://127.0.0.1:${world.port}`;
  await until(async () => (await call('GET', '/health')).json.online === 12);
});

after(async () => {
  await world.close();
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (e) { /* fine */ }
});

test('v1: A\'s queued Stop is billed to B\'s hold; A\'s hold is stranded; the world says so', async () => {
  await wrongDriverSequence('pi_A_v1', 'pi_B_v1');
  const [it] = await until(async () => { const l = await intentsFor('pi_B_v1'); return l.length ? l : null; });
  assert.equal(it.driver, 'B', 'the hold charged is B\'s');
  assert.equal(it.energy_driver, 'A', 'the energy is A\'s');
  assert.equal(it.energy_episode_id, 'CP07-E1');
  assert.equal(it.wrong_driver, true);
  assert.match(it.attribution, /^StopTransaction transactionId \d+$/);
  assert.ok(it.amount_cents > 0 && it.amount_cents === it.energy_expected_cents, 'B is charged exactly A\'s cost');
  assert.equal((await intentsFor('pi_A_v1')).length, 0, 'nothing is ever captured on A\'s hold');

  // The host executes it; Stripe says succeeded.
  const claimed = (await call('POST', '/intents/claim', {})).json.intents.find((i) => i.id === it.id);
  assert.ok(claimed);
  const r = await call('POST', `/intents/${it.id}/result`, { ok: true, status: 'succeeded', error: null, stripe_object: { id: 'pi_B_v1', amount_received: it.amount_cents } });
  assert.equal(r.status, 200);
  const hb = await holdOf('pi_B_v1');
  assert.equal(hb.status, 'succeeded');
  assert.deepEqual(hb.captured_for, { episode_id: 'CP07-E1', driver: 'A', wrong_driver: true });
  assert.equal(hb.results[0].driver, 'B');
  assert.equal(hb.results[0].energy_driver, 'A');
  const ha = await holdOf('pi_A_v1');
  assert.equal(ha.driver, 'A');
  assert.equal(ha.status, 'requires_capture');
  assert.equal(ha.episode_ended, true);
  assert.equal(ha.stranded, true);
  const ev = (await call('GET', '/events?since=0&limit=2000')).json.events.find((e) => e.type === 'intent_result' && e.world_intent_id === it.id);
  assert.equal(ev.energy_driver, 'A');
});

test('episode ledger: A is billed to A\'s hold, B to B\'s', async () => {
  assert.equal((await call('PUT', '/settle', ref, { 'x-settle-name': 'reference.js' })).status, 200);
  assert.equal((await call('POST', '/reset', {})).status, 200); // keeps the reference program
  await until(async () => (await call('GET', '/health')).json.online === 12);
  await wrongDriverSequence('pi_A_ref', 'pi_B_ref');
  const [a] = await until(async () => { const l = await intentsFor('pi_A_ref'); return l.length ? l : null; });
  assert.equal(a.driver, 'A');
  assert.equal(a.energy_driver, 'A');
  assert.equal(a.wrong_driver, false);
  assert.ok(a.amount_cents > 0 && a.amount_cents === a.energy_expected_cents);
  await sleep(1500);
  assert.equal((await intentsFor('pi_B_ref')).length, 0, 'B\'s hold waits for B\'s own plug-in');
  // B plugs, charges and leaves.
  await cmd('plug');
  await until(async () => (await state()).episodes.find((e) => e.id === 'CP07-E2')?.energy_wh > 0);
  await sleep(800);
  await cmd('unplug');
  const [b] = await until(async () => { const l = await intentsFor('pi_B_ref'); return l.length ? l : null; });
  assert.equal(b.driver, 'B');
  assert.equal(b.energy_driver, 'B');
  assert.equal(b.energy_episode_id, 'CP07-E2');
  assert.equal(b.wrong_driver, false);
  await call('POST', '/reset', { settle: 'v1' });
});

test('the last agent run is kept by the world (and on disk with STATE_DIR)', async () => {
  assert.deepEqual((await call('GET', '/agent/last')).json, { ok: true, run: null });
  const run = { ok: true, model: 'test/model', attempts: [{ n: 1, summary: '30/30 ok' }], deployed_version: 7 };
  assert.equal((await call('POST', '/agent/last', run)).status, 200);
  const got = (await call('GET', '/agent/last')).json.run;
  assert.equal(got.model, 'test/model');
  assert.equal(got.attempts[0].summary, '30/30 ok');
  assert.ok(got.received_at > 0);
  await call('POST', '/reset', {});
  assert.equal((await call('GET', '/agent/last')).json.run.model, 'test/model', 'survives /reset');
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'agent-last.json'), 'utf8')).model, 'test/model');
});

test('the probe: every vm escape is blocked and the infinite loop is stopped at 1 s', async () => {
  const p = (await call('POST', '/probe', {})).json;
  const a = p.checks.filter((c) => c.group === 'a');
  assert.ok(a.length >= 5);
  for (const c of a) assert.equal(c.pass, true, `${c.id}: ${c.detail}`);
  const loop = p.checks.find((c) => c.id === 'infinite-loop');
  assert.equal(loop.pass, true, loop.detail);
  assert.ok(loop.ms >= 900 && loop.ms < 3000);
  assert.ok(p.checks.find((c) => c.id === 'tcp-stripe'));
  assert.ok(p.checks.find((c) => c.id === 'dns-example'));
  const env = p.checks.find((c) => c.id === 'env-keys');
  assert.ok(Array.isArray(p.env.names) && p.env.names.length > 0);
  assert.ok(!JSON.stringify(p).includes(process.env.PATH ?? '\u0000'), 'values are never reported');
  assert.equal(typeof env.pass, 'boolean');
});
