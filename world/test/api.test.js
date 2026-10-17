// End to end over real sockets: the HTTP API, the OCPP 1.6J WebSocket CSMS, the
// ocpp-rpc chargers and the link proxies, on an ephemeral port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startWorld } from '../src/live.js';
import { LIVE_TIMING } from '../src/firmware.js';

const ref = fs.readFileSync(new URL('../settlers/reference-episode-ledger.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let world;
let base;

const call = async (method, path, body, headers = {}) => {
  const isText = typeof body === 'string';
  const r = await fetch(base + path, {
    method,
    headers: body === undefined ? headers : { 'content-type': isText ? 'text/javascript' : 'application/json', ...headers },
    body: body === undefined ? undefined : isText ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* raw */ }
  return { status: r.status, headers: r.headers, json, text };
};

async function until(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(step);
  }
}

before(async () => {
  world = await startWorld({ port: 0, host: '127.0.0.1', timing: { ...LIVE_TIMING, sampleEvery: 400, reconnectEvery: 200, rebootDowntime: 400, retryEvery: 300 } });
  base = `http://127.0.0.1:${world.port}`;
  await until(async () => (await call('GET', '/health')).json.online === 12);
});

after(async () => { await world.close(); });

test('health, CORS and the route index', async () => {
  const h = await call('GET', '/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);
  assert.equal(h.json.chargers, 12);
  assert.equal(h.headers.get('access-control-allow-origin'), '*');
  const pre = await fetch(base + '/cmd', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  const idx = await call('GET', '/');
  assert.ok(idx.json.routes.length > 10);
  assert.equal((await call('GET', '/nope')).status, 404);
});

test('state lists 12 chargers booted over OCPP 1.6J and v1 loaded', async () => {
  const s = await call('GET', '/state');
  assert.equal(s.json.chargers.length, 12);
  assert.deepEqual(s.json.chargers.map((c) => c.id), Array.from({ length: 12 }, (_, i) => `CP${String(i + 1).padStart(2, '0')}`));
  for (const c of s.json.chargers) {
    assert.equal(c.online, true);
    assert.equal(c.status, 'Available');
    assert.equal(c.link, 'up');
  }
  assert.equal(s.json.settle.version, 1);
  assert.equal(s.json.settle.name, 'v1-naive.js');
  const boots = s.json.events.filter((e) => e.type === 'ocpp' && e.action === 'BootNotification');
  assert.ok(boots.length >= 1);
});

test('demo round trip: hold, plug, cut, unplug offline, restore, dup StopTransaction, two v1 intents, host results', async () => {
  assert.equal((await call('POST', '/cmd', { op: 'quirk', charger: 'CP07', quirk: 'dup_stop', on: true })).status, 200);
  const hold = await call('POST', '/hold', { charger: 'CP07', payment_intent: 'pi_test_demo', amount_cents: 5000 });
  assert.equal(hold.status, 201);
  assert.equal(hold.json.hold.status, 'requires_capture');
  assert.equal((await call('POST', '/hold', { charger: 'CP07', payment_intent: 'pi_test_demo', amount_cents: 5000 })).status, 200, 'idempotent');
  assert.equal((await call('POST', '/hold', { charger: 'CP03', payment_intent: 'pi_test_demo', amount_cents: 5000 })).status, 409);

  const plug = await call('POST', '/cmd', { op: 'plug', charger: 'CP07', power_kw: 11 });
  assert.equal(plug.json.ok, true);
  await until(async () => (await call('GET', '/state')).json.chargers.find((c) => c.id === 'CP07').transaction?.transaction_id);
  await sleep(1500);

  const cut = await call('POST', '/cmd', { op: 'cut', charger: ['CP05', 'CP06', 'CP07', 'CP08'] });
  assert.deepEqual(cut.json.chargers.map((c) => c.link), ['cut', 'cut', 'cut', 'cut']);
  await until(async () => !(await call('GET', '/state')).json.chargers.find((c) => c.id === 'CP07').online);
  await sleep(1000);
  const un = await call('POST', '/cmd', { op: 'unplug', charger: 'CP07' });
  assert.equal(un.json.ok, true);
  const queued = (await call('GET', '/state')).json.chargers.find((c) => c.id === 'CP07');
  assert.ok(queued.queue.includes('StopTransaction'), 'the Stop waits in the offline queue');
  await call('POST', '/cmd', { op: 'restore', charger: ['CP05', 'CP06', 'CP07', 'CP08'] });

  const pending = await until(async () => {
    const r = await call('GET', '/intents?pending=1');
    const mine = r.json.intents.filter((i) => i.payment_intent === 'pi_test_demo');
    return mine.length >= 2 ? mine : null;
  }, 10000);
  assert.equal(pending.length, 2, 'v1 emits one capture per delivered StopTransaction');
  assert.equal(pending[0].amount_cents, pending[1].amount_cents);
  assert.ok(pending[0].amount_cents > 0 && pending[0].amount_cents <= 5000);

  const ev = await call('GET', '/events?since=0&limit=2000');
  const stops = ev.json.events.filter((e) => e.type === 'ocpp' && e.action === 'StopTransaction' && e.charger === 'CP07');
  assert.equal(stops.length, 2);
  assert.deepEqual(stops[0].payload, stops[1].payload, 'the same StopTransaction twice');
  const ep = (await call('GET', '/state')).json.episodes.find((e) => e.payment_intent === 'pi_test_demo');
  assert.equal(pending[0].amount_cents, ep.expected_cents, 'v1 bills the right amount the first time');

  // the host claims, executes and reports
  const claim = await call('POST', '/intents/claim', {});
  assert.ok(claim.json.intents.some((i) => i.id === pending[0].id));
  assert.equal((await call('GET', '/intents?pending=1')).json.intents.filter((i) => i.payment_intent === 'pi_test_demo').length, 2, 'in-flight intents stay listed as pending work');
  assert.equal((await call('POST', '/intents/claim', {})).json.intents.length, 0, 'a claimed intent is leased');
  const r1 = await call('POST', `/intents/${pending[0].id}/result`, { ok: true, status: 'succeeded', stripe_object: { id: 'pi_test_demo', object: 'payment_intent', amount_received: pending[0].amount_cents, status: 'succeeded' } });
  assert.equal(r1.json.intent.status, 'succeeded');
  const r2 = await call('POST', `/intents/${pending[1].id}/result`, { ok: false, status: 'succeeded', error: { message: 'the remainder of the authorized amount has been released', code: 'payment_intent_unexpected_state' } });
  assert.equal(r2.json.intent.status, 'failed');
  const dupReport = await call('POST', `/intents/${pending[1].id}/result`, { ok: true });
  assert.equal(dupReport.json.duplicate, true, 'the first answer wins');
  assert.equal((await call('POST', '/intents/in_99999/result', { ok: true })).status, 404);

  const st = (await call('GET', '/state')).json;
  const h = st.holds.find((x) => x.payment_intent === 'pi_test_demo');
  assert.equal(h.status, 'succeeded');
  assert.equal(h.amount_captured, pending[0].amount_cents);
  assert.equal(h.amount_released, 5000 - pending[0].amount_cents);
  assert.equal(h.results.length, 2);
  const results = (await call('GET', '/events?since=0&limit=2000')).json.events.filter((e) => e.type === 'intent_result');
  assert.ok(results.some((e) => e.ok === false && /remainder/.test(e.error)));
  assert.equal(st.events.filter((e) => e.type === 'violation').length, 0, 'no OCPP schema violations');
});

test('cmd validation', async () => {
  assert.equal((await call('POST', '/cmd', { op: 'explode', charger: 'CP01' })).status, 400);
  assert.equal((await call('POST', '/cmd', { op: 'plug', charger: 'CP99' })).status, 404);
  assert.equal((await call('POST', '/cmd', { op: 'quirk', charger: 'CP01', quirk: 'nope' })).status, 400);
  assert.equal((await call('POST', '/cmd', { op: 'unplug', charger: 'CP01' })).status, 409);
  assert.equal((await call('POST', '/hold', { charger: 'CP01', payment_intent: 'pi_x', amount_cents: -1 })).status, 400);
  const sk = await call('POST', '/cmd', { op: 'skew', charger: 'CP02', seconds: -3600 });
  assert.equal(sk.json.chargers[0].clock_skew_s, -3600);
});

test('reboot with reboot_restart splits one plug-in into two OCPP transactions', async () => {
  await call('POST', '/cmd', { op: 'quirk', charger: 'CP09', quirk: 'reboot_restart', on: true });
  await call('POST', '/hold', { charger: 'CP09', payment_intent: 'pi_test_reboot', amount_cents: 5000 });
  await call('POST', '/cmd', { op: 'plug', charger: 'CP09', power_kw: 7.4 });
  await until(async () => (await call('GET', '/state')).json.chargers.find((c) => c.id === 'CP09').transaction?.transaction_id);
  await sleep(600);
  assert.equal((await call('POST', '/cmd', { op: 'reboot', charger: 'CP09' })).json.ok, true);
  await until(async () => {
    const c = (await call('GET', '/state')).json.chargers.find((x) => x.id === 'CP09');
    return c.online && c.transaction && c.transaction.transaction_id;
  });
  await sleep(600);
  await call('POST', '/cmd', { op: 'unplug', charger: 'CP09' });
  const mine = await until(async () => {
    const l = (await call('GET', '/intents?pending=1')).json.intents.filter((i) => i.payment_intent === 'pi_test_reboot');
    return l.length >= 2 ? l : null;
  });
  assert.notEqual(mine[0].episode_id, mine[1].episode_id, 'v1 keys the captures by transactionId');
  const ep = (await call('GET', '/state')).json.episodes.find((e) => e.payment_intent === 'pi_test_reboot');
  assert.equal(ep.transactions.length, 2);
  assert.ok(['Reboot', 'PowerLoss'].includes(ep.transactions[0].reason));
});

test('settle.js upload: validation, replay with suppression, version bump', async () => {
  const bad = await call('PUT', '/settle', 'export function createSettler() { return {}; }');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /onEvent/);
  assert.equal((await call('POST', '/settle/validate', 'export function createSettler( {')).status, 400);

  const before = (await call('GET', '/settle')).json;
  const put = await call('PUT', '/settle', ref, { 'x-settle-name': 'v2-ledger.js' });
  assert.equal(put.status, 200);
  assert.equal(put.json.version, before.version + 1);
  const now = (await call('GET', '/settle')).json;
  assert.equal(now.name, 'v2-ledger.js');
  assert.equal(now.source, ref);
  const raw = await call('GET', '/settle?raw=1');
  assert.equal(raw.text, ref);
  assert.equal(raw.headers.get('x-settle-version'), String(now.version));

  // the replay must not resend money for holds that are settled or in flight
  const st = (await call('GET', '/state')).json;
  const v2 = st.intents.filter((i) => i.settle_version === now.version);
  const replayed = v2.filter((i) => i.payment_intent === 'pi_test_demo');
  assert.equal(replayed.length, 1, 'the ledger settles the demo episode once on replay');
  assert.equal(replayed[0].status, 'suppressed');
  assert.equal(replayed[0].amount_cents, st.episodes.find((e) => e.payment_intent === 'pi_test_demo').expected_cents);
  assert.equal(v2.filter((i) => i.status === 'pending').length, 0, 'nothing new is sent to the host for settled or in-flight holds');

  const viaJson = await call('PUT', '/settle', { source: ref, name: 'v3.js' });
  assert.equal(viaJson.json.version, now.version + 1);
});

test('suite runs on the current settle.js inside the world', async () => {
  const r = await call('POST', '/suite', { count: 30 });
  assert.equal(r.status, 200);
  assert.equal(r.json.totals.scenarios, 30);
  assert.equal(r.json.ok, true, r.json.summary);
  assert.equal(r.json.totals.double + r.json.totals.stranded + r.json.totals.unbilled, 0);
  for (const s of r.json.scenarios) for (const k of ['seed', 'faults', 'double', 'stranded', 'unbilled', 'overbilled', 'ok']) assert.ok(k in s);
  const last = await call('GET', '/suite/last');
  assert.equal(last.json.report.summary, r.json.summary);

  const v1src = fs.readFileSync(new URL('../settlers/v1-naive.js', import.meta.url), 'utf8');
  const dry = await call('POST', '/suite', { seeds: [1, 2], source: v1src });
  assert.ok(dry.json.totals.double > 0);
  assert.equal(dry.json.settle_version, null, 'a dry run does not touch the deployed program');

  const tr = await call('POST', '/suite/trace', { seed: 2, source: v1src });
  assert.ok(tr.json.report.trace.feed.some((e) => e.action === 'StopTransaction'));
});

test('event stream since a sequence number', async () => {
  const all = (await call('GET', '/events?since=0&limit=5')).json;
  assert.equal(all.events.length, 5);
  const next = (await call('GET', `/events?since=${all.last_seq}&limit=5`)).json;
  assert.ok(next.events[0].seq > all.last_seq);
  const ctrl = new AbortController();
  const res = await fetch(`${base}/events?since=0`, { headers: { accept: 'text/event-stream' }, signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /^id: \d+\nevent: /);
  ctrl.abort();
});

test('reset brings back a clean board', async () => {
  const r = await call('POST', '/reset', { settle: 'v1' });
  assert.equal(r.json.ok, true);
  await until(async () => (await call('GET', '/health')).json.online === 12);
  const s = (await call('GET', '/state')).json;
  assert.equal(s.holds.length, 0);
  assert.equal(s.settle.name, 'v1-naive.js');
  assert.ok(s.settle.version > 1);
});
