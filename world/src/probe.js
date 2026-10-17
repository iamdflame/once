// The boundary probe (POST /probe): the world tries to break out of its own boxes and
// reports each attempt, with pass/fail and timing.
//
//   (a) settle.js programs that reach for fetch, require('fs'), process.env, import() and
//       eval, plus the classic vm escape through the Function constructor: each must be
//       blocked inside the vm (or refused by the loader before it runs);
//   (b) a settle.js with an infinite loop: it must be stopped at the 1 s call budget;
//   (c) from the world process itself (no vm), the ways data could actually leave: an
//       HTTPS POST with a body to https://api.stripe.com/v1/charges, an HTTP POST with a
//       body to http://example.com/, and HTTP to a raw IP (http://1.1.1.1/). Each must get
//       no response: the CreateOS egress allowlist (a single sinkhole entry) filters by
//       SNI / Host. Two facts are reported with the verdict "disclosed" (neither pass nor
//       fail): a raw TCP connect to api.stripe.com:443 is accepted (measured 2026-10-17:
//       every connect is accepted, then reset at TLS / HTTP), and DNS resolves. On a laptop
//       all of it succeeds and the host marks it "local: not applicable";
//   (d) the world's own environment: variable NAMES only (never values), and whether any
//       name or value looks like a Stripe, model or CreateOS credential.
//
// Every probe settle.js runs in its own fresh SettlerHost; the deployed program and the
// live board are not touched. The infinite-loop check blocks the world's event loop for
// about one second (that is the point of the check).

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { SettlerHost, SettleLoadError, CALL_TIMEOUT_MS } from './sandbox.js';

// A settle.js whose onEvent tries `attempt` (a JS expression or statement block that
// returns a value) and reports what happened as an intent. Async results (import())
// land in the closure and are read on the second call.
function probeSource(attempt) {
  return `export function createSettler() {
  const out = [];
  let async = null;
  let tried = false;
  return {
    onEvent(evt) {
      if (tried) {
        if (async) out.push({ intent_id: 'async', outcome: async });
        return;
      }
      tried = true;
      try {
        const v = (function () { ${attempt} })();
        if (v && typeof v.then === 'function') {
          v.then((x) => { async = 'reached: ' + String(x).slice(0, 120); }, (e) => { async = 'blocked: ' + String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e).slice(0, 160); });
          out.push({ intent_id: 'sync', outcome: 'pending' });
        } else {
          out.push({ intent_id: 'sync', outcome: 'reached: ' + String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 120) });
        }
      } catch (e) {
        out.push({ intent_id: 'sync', outcome: 'blocked: ' + String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e).slice(0, 160) });
      }
    },
    intents() { return out; },
  };
}
`;
}

const VM_CHECKS = [
  { id: 'fetch', label: "settle.js calls fetch('https://api.stripe.com/v1/charges')", attempt: "return fetch('https://api.stripe.com/v1/charges');" },
  { id: 'require-literal', label: "settle.js contains require('fs')", attempt: "return require('fs').readFileSync('/etc/hostname', 'utf8');" },
  { id: 'require-hidden', label: "settle.js reaches for require indirectly (globalThis['req' + 'uire']('fs'))", attempt: "const r = globalThis['req' + 'uire']; return r('fs').readFileSync('/etc/hostname', 'utf8');" },
  { id: 'process-env', label: 'settle.js reads process.env', attempt: 'return Object.keys(process.env).length;' },
  { id: 'import', label: "settle.js calls import('node:fs') (hidden from the loader's pattern)", attempt: "return import/**/('node:fs');" },
  { id: 'eval', label: "settle.js calls eval('1 + 1')", attempt: "return eval('1 + 1');" },
  { id: 'function-escape', label: "settle.js tries the vm escape ({}).constructor.constructor('return process')()", attempt: "return ({}).constructor.constructor('return process')().env;" },
];

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, fractional

function runVmCheck(c) {
  const t0 = now();
  let host;
  try {
    host = new SettlerHost(probeSource(c.attempt), { tariffCentsPerKwh: 60 });
  } catch (e) {
    const ms = now() - t0;
    const msg = e instanceof SettleLoadError ? e.message : String((e && e.message) || e);
    return { group: 'a', id: c.id, label: c.label, pass: true, layer: 'loader', detail: `refused before it ran: ${msg}`, ms };
  }
  const r1 = host.onEvent({ seq: 1, at: 0, type: 'tick' }, 0);
  const r2 = host.onEvent({ seq: 2, at: 0, type: 'tick' }, 0);
  const ms = now() - t0;
  const all = [...r1.intents, ...r2.intents];
  const sync = all.find((i) => i.intent_id === 'sync');
  const asyncOut = all.find((i) => i.intent_id === 'async');
  let outcome = sync ? String(sync.outcome) : host.dead || r1.error || 'no outcome';
  if (outcome === 'pending') outcome = asyncOut ? String(asyncOut.outcome) : 'blocked: the promise never settled inside the vm';
  const pass = /^blocked:/.test(outcome) || (!sync && !!host.dead);
  return { group: 'a', id: c.id, label: c.label, pass, layer: 'vm', detail: outcome, ms };
}

function runLoopCheck() {
  const src = `export function createSettler() {
  return { onEvent() { for (;;) {} }, intents() { return []; } };
}
`;
  const host = new SettlerHost(src, { tariffCentsPerKwh: 60 });
  const t0 = now();
  const r = host.onEvent({ seq: 1, at: 0, type: 'tick' }, 0);
  const ms = now() - t0;
  const stopped = !!host.dead && /longer than/.test(host.dead);
  const pass = stopped && ms >= CALL_TIMEOUT_MS * 0.9 && ms < CALL_TIMEOUT_MS * 3;
  return {
    group: 'b', id: 'infinite-loop', label: `settle.js runs for (;;) {} in onEvent (budget ${CALL_TIMEOUT_MS} ms per call)`,
    pass, layer: 'vm', detail: stopped ? `stopped after ${Math.round(ms)} ms: ${host.dead}` : `not stopped: ${r.error || 'returned'}`, ms,
  };
}

// A raw TCP connect (no bytes sent). Disclosed, not judged: the sandbox's egress proxy
// accepts every connect and filters by SNI / Host afterwards.
function tcpCheck(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = now();
    let done = false;
    const sock = net.connect({ host, port });
    const finish = (reached, detail) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ reached, detail, ms: now() - t0 });
    };
    sock.once('connect', () => finish(true, `connected to ${sock.remoteAddress}:${sock.remotePort} (then closed; nothing was sent)`));
    sock.once('error', (e) => finish(false, `${e.code || e.name}: ${e.message}`));
    sock.setTimeout(timeoutMs, () => finish(false, `no connection within ${timeoutMs} ms`));
  });
}

// A request with a real body. reached = any HTTP response came back (status line or more).
function requestCheck(url, { method = 'GET', body = null, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = now();
    let done = false;
    const finish = (reached, detail) => { if (!done) { done = true; resolve({ reached, detail, ms: now() - t0 }); } };
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'user-agent': 'once-world-probe' };
    if (body != null) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = lib.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => finish(true, `HTTP ${res.statusCode}: ${n} bytes came back`));
      res.on('error', () => finish(true, `HTTP ${res.statusCode} (body cut)`));
    });
    req.on('timeout', () => { req.destroy(); finish(false, `no response within ${timeoutMs} ms`); });
    req.on('error', (e) => finish(false, `no response: ${e.code || e.name}: ${e.message}`));
    if (body != null) req.write(body);
    req.end();
  });
}

function dnsCheck(name, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = now();
    let done = false;
    const timer = setTimeout(() => { done = true; resolve({ reached: false, detail: `no answer within ${timeoutMs} ms`, ms: now() - t0 }); }, timeoutMs);
    dns.lookup(name, { all: true }, (err, addrs) => {
      if (done) return;
      clearTimeout(timer);
      if (err) resolve({ reached: false, detail: `${err.code || err.name}: ${err.message}`, ms: now() - t0 });
      else resolve({ reached: true, detail: `resolved to ${addrs.map((a) => a.address).join(', ')}`, ms: now() - t0 });
    });
  });
}

const SECRET_NAME = /STRIPE|SECRET|API_?KEY|TOKEN|PASSWORD|PRIVATE|OPENROUTER|ANTHROPIC|CREATEOS|VERCEL|CREDENTIAL/i;
const SECRET_VALUE = /\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]{8,}|\bsk-or-[A-Za-z0-9-]{8,}|\bsk-ant-[A-Za-z0-9-]{8,}|\bwhsec_[A-Za-z0-9]{8,}/;

function envCheck(env = process.env) {
  const names = Object.keys(env).sort();
  const byName = names.filter((n) => SECRET_NAME.test(n));
  const byValue = names.filter((n) => SECRET_VALUE.test(String(env[n] ?? '')));
  const flagged = [...new Set([...byName, ...byValue])];
  return {
    group: 'd', id: 'env-keys', label: 'no Stripe, model or CreateOS key in the world process environment (names only, never values)',
    pass: flagged.length === 0,
    detail: flagged.length ? `credential-like variables present: ${flagged.join(', ')}` : `${names.length} variables, none named or valued like a key`,
    names, flagged, ms: 0,
  };
}

export async function runProbe({ timeoutMs = 3000 } = {}) {
  const t0 = now();
  const checks = [];
  // (a) and (b) are synchronous vm work; run them before the network checks so the
  // event-loop pause of (b) does not distort the network timings.
  for (const c of VM_CHECKS) checks.push(runVmCheck(c));
  checks.push(runLoopCheck());
  // (c) from the world process itself, outside the vm. Judged: the three ways data could
  // actually leave (an HTTPS request to Stripe, an HTTP POST to a named host, HTTP to a raw
  // IP). Disclosed, not judged: a raw TCP connect and a DNS lookup, which the sandbox allows.
  const body = 'amount=100&currency=eur&source=tok_visa&description=once-world-probe';
  const [toStripe, toHost, toIp, tcp, lookup] = await Promise.all([
    requestCheck('https://api.stripe.com/v1/charges', { method: 'POST', body, timeoutMs }),
    requestCheck('http://example.com/', { method: 'POST', body, timeoutMs }),
    requestCheck('http://1.1.1.1/', { timeoutMs }),
    tcpCheck('api.stripe.com', 443, timeoutMs),
    dnsCheck('example.com', timeoutMs),
  ]);
  checks.push({ group: 'c', id: 'https-stripe', label: 'an HTTPS POST with a body to https://api.stripe.com/v1/charges gets no response (TLS/SNI refused)', pass: !toStripe.reached, verdict: toStripe.reached ? 'fail' : 'pass', layer: 'network', detail: toStripe.detail, ms: toStripe.ms });
  checks.push({ group: 'c', id: 'http-post-host', label: 'an HTTP POST with a body to http://example.com/ gets no response', pass: !toHost.reached, verdict: toHost.reached ? 'fail' : 'pass', layer: 'network', detail: toHost.detail, ms: toHost.ms });
  checks.push({ group: 'c', id: 'http-raw-ip', label: 'an HTTP request to a raw IP (http://1.1.1.1/) gets no response', pass: !toIp.reached, verdict: toIp.reached ? 'fail' : 'pass', layer: 'network', detail: toIp.detail, ms: toIp.ms });
  checks.push({ group: 'c', id: 'tcp-stripe', label: 'TCP connect is not blocked: the allowlist filters by SNI/Host', pass: null, verdict: 'disclosed', layer: 'network', detail: `TCP to api.stripe.com:443: ${tcp.detail}`, ms: tcp.ms });
  checks.push({ group: 'c', id: 'dns-example', label: 'DNS resolves: a known side channel; the world holds no keys or customer data to leak', pass: null, verdict: 'disclosed', layer: 'network', detail: `example.com: ${lookup.detail}`, ms: lookup.ms });
  // (d) the environment.
  const env = envCheck();
  checks.push({ group: 'd', id: env.id, label: env.label, pass: env.pass, layer: 'environment', detail: env.detail, ms: env.ms });
  // verdict: pass | fail for judged checks, "disclosed" for facts reported without a verdict.
  for (const c of checks) if (!c.verdict) c.verdict = c.pass ? 'pass' : 'fail';
  return {
    ok: checks.filter((c) => c.verdict !== 'disclosed').every((c) => c.pass),
    ran_at: Date.now(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    pid: process.pid,
    checks: checks.map((c) => ({ ...c, ms: Math.round(c.ms * 10) / 10 })),
    env: { names: env.names, flagged: env.flagged },
    ms: Math.round(now() - t0),
  };
}
