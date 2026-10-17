// The live world: one Node process with
//   - the CSMS on ws://<host>:<port>/ocpp/<chargerId> (OCPP 1.6J via ocpp-rpc, strict mode),
//   - 12 simulated chargers, each connected through its own cuttable TCP link proxy,
//   - the settlement program in its sandbox, fed every CSMS-side event,
//   - the HTTP API the host drives (CORS open), on the same port.
// It never opens a connection to anything but 127.0.0.1.

import http from 'node:http';
import ocpp from 'ocpp-rpc';
import { LiveClock } from './clock.js';
import { WorldCore, httpError } from './core.js';
import { LIVE_TIMING, QUIRK_NAMES } from './firmware.js';
import { LinkProxy, LiveTransport } from './transport-live.js';
import { validateSettleSource } from './sandbox.js';
import { runSuite, runScenario, DEFAULT_SUITE_COUNT, DEFAULT_SUITE_SEED } from './runner.js';
import { V1_NAIVE_SOURCE, V1_NAIVE_NAME } from './builtin-settlers.js';

const { RPCServer, createRPCError } = ocpp;

export const WORLD_VERSION = '0.1.0';

export function chargerIds(n = 12) {
  return Array.from({ length: n }, (_, i) => `CP${String(i + 1).padStart(2, '0')}`);
}

export async function startWorld({
  port = 8080,
  host = '0.0.0.0',
  speed = 300,
  chargers = 12,
  tariffCentsPerKwh = 60,
  settleSource = V1_NAIVE_SOURCE,
  settleName = V1_NAIVE_NAME,
  timing = LIVE_TIMING,
  log = () => {},
} = {}) {
  const ids = chargerIds(chargers);
  const proxies = new Map();
  const startedAt = Date.now();
  const ctx = { core: null, clock: null, lastSuite: null, suiteChain: Promise.resolve() };

  const links = {
    cut: (id) => proxies.get(id).setCut(true),
    restore: (id) => proxies.get(id).setCut(false),
    isCut: (id) => proxies.get(id).cut,
  };

  function buildCore({ source, name, versionBase = 0 }) {
    const clock = new LiveClock({ speed });
    const transport = new LiveTransport({ proxies, onViolation: (v) => ctx.core && ctx.core.emit({ type: 'violation', ...v }) });
    const core = new WorldCore({
      clock,
      transport,
      links,
      chargerIds: ids,
      timing,
      tariffCentsPerKwh,
      chargerOptions: (id, i) => ({ meterWh: 1200000 + i * 487331 }),
      tickEvery: 2000,
      seed: 1,
      heartbeatIntervalS: Math.round(timing.heartbeatEvery / 1000),
    });
    core.settleVersion = versionBase;
    core.loadSettler(source, { name });
    ctx.clock = clock;
    return core;
  }

  ctx.core = buildCore({ source: settleSource, name: settleName });

  // ---------- CSMS (OCPP 1.6J over WebSocket) ----------
  const rpc = new RPCServer({ protocols: ['ocpp1.6'], strictMode: true, callTimeoutMs: 8000, pingIntervalMs: 10000 });
  rpc.auth((accept, reject, handshake) => {
    if (!ids.includes(handshake.identity)) { reject(404, `unknown charge point ${handshake.identity}`); return; }
    accept({ core: ctx.core });
  });
  rpc.on('client', (client) => {
    const id = client.identity;
    const core = client.session.core;
    if (core !== ctx.core) { client.close({ force: true }).catch(() => {}); return; }
    const connCount = core.liveConns || (core.liveConns = new Map());
    const n = (connCount.get(id) || 0) + 1;
    connCount.set(id, n);
    if (n === 1) core.csms.connected(id);
    client.on('strictValidationFailure', (f) => core.emit({ type: 'violation', charger: id, kind: f.outbound ? 'outbound' : 'inbound', action: f.method, error: f.error ? f.error.message : 'invalid' }));
    client.handle(({ method, params }) => {
      try {
        return core.csms.handle(id, method, params);
      } catch (e) {
        if (e.rpcErrorCode) throw createRPCError(e.rpcErrorCode, e.message);
        throw e;
      }
    });
    client.once('close', () => {
      const m = (connCount.get(id) || 1) - 1;
      connCount.set(id, m);
      if (m === 0) core.csms.disconnected(id);
    });
  });
  rpc.on('error', () => {});

  // ---------- HTTP ----------
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => send(res, e.status || 500, { ok: false, error: e.message }));
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/ocpp/')) rpc.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  async function handle(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://world.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const core = ctx.core;
    const m = req.method;

    if (m === 'GET' && path === '/') return send(res, 200, index());
    if (m === 'GET' && path === '/health') {
      return send(res, 200, {
        ok: true,
        name: 'once-world',
        version: WORLD_VERSION,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        now: core.clock.now(),
        sim_speed: speed,
        chargers: ids.length,
        online: [...core.chargers.values()].filter((f) => f.online).length,
        settle_version: core.settle ? core.settle.version : null,
        egress: 'none: the world connects only to 127.0.0.1',
      });
    }
    if (m === 'GET' && path === '/state') {
      const n = Math.max(0, Math.min(1000, Number(url.searchParams.get('events') ?? 100) || 0));
      return send(res, 200, { ok: true, sim_speed: speed, ...core.state({ events: n }) });
    }
    if (m === 'GET' && path === '/events') {
      const since = Number(url.searchParams.get('since') || 0) || 0;
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') || 500) || 500));
      if (url.searchParams.get('stream') === '1' || /text\/event-stream/.test(req.headers.accept || '')) return stream(req, res, since);
      return send(res, 200, { ok: true, ...core.eventsSince(since, limit) });
    }
    if (m === 'POST' && path === '/cmd') return send(res, 200, command(await readJson(req)));
    if (m === 'POST' && path === '/hold') {
      const b = await readJson(req);
      const r = core.placeHold({ charger: b.charger, payment_intent: b.payment_intent, amount_cents: b.amount_cents, currency: b.currency || 'eur' });
      return send(res, r.existing ? 200 : 201, { ok: true, ...r });
    }
    if (m === 'GET' && path === '/intents') {
      const pending = url.searchParams.get('pending');
      const list = pending === '1' || pending === 'true' ? core.pendingIntents() : core.state({ events: 0 }).intents;
      return send(res, 200, { ok: true, intents: list });
    }
    if (m === 'POST' && path === '/intents/claim') {
      const b = await readJson(req, true);
      return send(res, 200, { ok: true, intents: core.claimIntents({ limit: b.limit || 50, leaseMs: b.lease_ms || 15000 }) });
    }
    const mr = path.match(/^\/intents\/([^/]+)\/result$/);
    if (m === 'POST' && mr) {
      const b = await readJson(req);
      const r = core.recordResult(decodeURIComponent(mr[1]), b);
      return send(res, 200, { ok: true, ...r });
    }
    if (m === 'GET' && path === '/settle') {
      const s = core.settle;
      if (url.searchParams.get('raw') === '1') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'x-settle-version': String(s.version) });
        res.end(s.source);
        return;
      }
      return send(res, 200, { ok: true, version: s.version, name: s.name, sha256: s.sha256, loaded_at: s.loaded_at, source: s.source, errors: core.settlerErrors, dead: core.settler.dead });
    }
    if ((m === 'PUT' || m === 'POST') && path === '/settle') {
      const { source, name } = await readSource(req);
      const v = validateSettleSource(source, { tariffCentsPerKwh, now: core.clock.now() });
      if (!v.ok) return send(res, 400, { ok: false, error: v.error, sha256: v.sha });
      const s = core.loadSettler(source, { name: name || `settle-v${core.settleVersion + 1}.js`, replay: true });
      return send(res, 200, { ok: true, version: s.version, name: s.name, sha256: s.sha256 });
    }
    if (m === 'POST' && path === '/settle/validate') {
      const { source } = await readSource(req);
      const v = validateSettleSource(source, { tariffCentsPerKwh, now: core.clock.now() });
      return send(res, v.ok ? 200 : 400, { ok: v.ok, error: v.error, sha256: v.sha });
    }
    if (m === 'POST' && path === '/suite') {
      const b = await readJson(req, true);
      const source = typeof b.source === 'string' ? b.source : core.settle.source;
      const version = typeof b.source === 'string' ? null : core.settle.version;
      const report = await serial(() => runSuite({ source, count: b.count ?? DEFAULT_SUITE_COUNT, seed: b.seed ?? DEFAULT_SUITE_SEED, seeds: b.seeds, tariffCentsPerKwh }));
      const out = { settle_version: version, ...report };
      if (version != null) ctx.lastSuite = out;
      core.emit({ type: 'suite', settle_version: version, summary: report.summary, ok: report.ok, totals: report.totals });
      return send(res, 200, out);
    }
    if (m === 'GET' && path === '/suite/last') return send(res, 200, ctx.lastSuite ? { ok: true, report: ctx.lastSuite } : { ok: true, report: null });
    if (m === 'POST' && path === '/suite/trace') {
      const b = await readJson(req);
      if (!Number.isFinite(b.seed)) throw httpError(400, 'seed (number) is required');
      const source = typeof b.source === 'string' ? b.source : core.settle.source;
      const rep = await serial(() => runScenario(b.seed >>> 0, source, { tariffCentsPerKwh, trace: true }));
      return send(res, 200, { ok: true, report: rep });
    }
    if (m === 'POST' && path === '/reset') {
      const b = await readJson(req, true);
      const keep = b.settle !== 'v1';
      const old = ctx.core;
      const source = keep ? old.settle.source : V1_NAIVE_SOURCE;
      const name = keep ? old.settle.name : V1_NAIVE_NAME;
      old.shutdown();
      for (const p of proxies.values()) p.setCut(false);
      ctx.core = buildCore({ source, name, versionBase: old.settleVersion });
      ctx.core.start();
      return send(res, 200, { ok: true, settle_version: ctx.core.settle.version });
    }
    throw httpError(404, `no route ${m} ${path}`);
  }

  function serial(fn) {
    const p = ctx.suiteChain.then(fn, fn);
    ctx.suiteChain = p.catch(() => {});
    return p;
  }

  function command(b) {
    const core = ctx.core;
    const op = b.op;
    const ops = ['plug', 'unplug', 'cut', 'restore', 'reboot', 'quirk', 'skew'];
    if (!ops.includes(op)) throw httpError(400, `op must be one of ${ops.join(', ')}`);
    const targets = b.charger === 'all' ? ids : Array.isArray(b.charger) ? b.charger : [b.charger];
    if (!targets.length || targets.some((t) => typeof t !== 'string')) throw httpError(400, 'charger must be an id like "CP07", an array of ids, or "all"');
    const results = [];
    for (const id of targets) {
      try {
        switch (op) {
          case 'plug': core.plug(id, { powerKw: b.power_kw, idTag: b.id_tag }); break;
          case 'unplug': core.unplug(id); break;
          case 'cut': core.cut(id); break;
          case 'restore': core.restore(id); break;
          case 'reboot': core.reboot(id); break;
          case 'quirk':
            if (!QUIRK_NAMES.includes(b.quirk)) throw httpError(400, `quirk must be one of ${QUIRK_NAMES.join(', ')}`);
            core.setQuirk(id, b.quirk, b.on !== false);
            break;
          case 'skew': core.setSkew(id, Number(b.seconds)); break;
          default:
        }
        results.push({ charger: id, ok: true });
      } catch (e) {
        if (targets.length === 1) throw e;
        results.push({ charger: id, ok: false, error: e.message });
      }
    }
    const snap = core.state({ events: 0 }).chargers.filter((c) => targets.includes(c.id));
    return { ok: results.every((r) => r.ok), op, results, chargers: snap };
  }

  function stream(req, res, since) {
    const core = ctx.core;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    const write = (e) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of core.eventsSince(since, 2000).events) write(e);
    core.listeners.add(write);
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); core.listeners.delete(write); });
  }

  function index() {
    return {
      ok: true,
      name: 'once-world',
      version: WORLD_VERSION,
      ocpp: '/ocpp/{CP01..CP12} (OCPP 1.6J WebSocket, subprotocol ocpp1.6)',
      routes: [
        'GET /health', 'GET /state?events=100', 'GET /events?since=0&limit=500 (or Accept: text/event-stream)',
        'POST /cmd {op: plug|unplug|cut|restore|reboot|quirk|skew, charger, quirk?, on?, power_kw?, seconds?}',
        'POST /hold {charger, payment_intent, amount_cents}', 'GET /intents?pending=1', 'POST /intents/claim {limit?, lease_ms?}',
        'POST /intents/:id/result {ok, status, error, stripe_object}', 'GET /settle (?raw=1)', 'PUT /settle (body: settle.js source)',
        'POST /settle/validate', 'POST /suite {count?, seed?, seeds?, source?}', 'GET /suite/last', 'POST /suite/trace {seed, source?}', 'POST /reset {settle?: "v1"}',
      ],
    };
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  for (const id of ids) {
    const p = new LinkProxy({ id, upstreamPort: actualPort });
    await p.listen();
    proxies.set(id, p);
  }
  ctx.core.start();
  log(`once-world ${WORLD_VERSION} on http://${host}:${actualPort} · CSMS ws://127.0.0.1:${actualPort}/ocpp/<id> · ${ids.length} chargers · ${speed}x world time · settle ${ctx.core.settle.name} v${ctx.core.settle.version}`);

  return {
    port: actualPort,
    get core() { return ctx.core; },
    async close() {
      ctx.core.shutdown();
      await Promise.all([...proxies.values()].map((p) => p.close()));
      await rpc.close({ force: true }).catch(() => {});
      await new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    },
  };
}

function setCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, accept');
}

function send(res, status, body) {
  if (res.headersSent) { res.end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, optional = false) {
  const text = await readBody(req);
  if (!text.trim()) {
    if (optional) return {};
    throw httpError(400, 'expected a JSON body');
  }
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object') throw new Error('not an object');
    return v;
  } catch (e) {
    throw httpError(400, `invalid JSON body: ${e.message}`);
  }
}

// PUT /settle accepts the raw source (any content type) or JSON {source, name}.
async function readSource(req) {
  const text = await readBody(req);
  const ct = String(req.headers['content-type'] || '');
  if (/application\/json/.test(ct)) {
    try {
      const v = JSON.parse(text);
      if (v && typeof v.source === 'string') return { source: v.source, name: typeof v.name === 'string' ? v.name : null };
    } catch (e) {
      throw httpError(400, `invalid JSON body: ${e.message}`);
    }
    throw httpError(400, 'JSON body must be {"source": "<settle.js text>", "name"?: "..."}');
  }
  return { source: text, name: req.headers['x-settle-name'] ? String(req.headers['x-settle-name']) : null };
}
