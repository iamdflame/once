// Loads a settlement program (settle.js) from text into a fresh node:vm context with
// no require, no import, no fs, no net, no process, no timers and no eval, and talks
// to it only through JSON strings, so no object from the host realm ever reaches it.
// Date.now() and Math.random() inside are deterministic (world time, seeded), which
// keeps scenario runs reproducible. Every call runs under a timeout.
//
// node:vm is not a security boundary on its own; in production the whole world runs
// inside a CreateOS microVM with no internet and no keys. This layer makes the
// settlement program's capabilities explicit: events in, capture intents out.

import vm from 'node:vm';
import crypto from 'node:crypto';

export class SettleLoadError extends Error {}

export const CALL_TIMEOUT_MS = 1000;

const PRELUDE = `
(function () {
  "use strict";
  const logs = [];
  const fmt = (a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); } };
  const mk = (level) => (...args) => { if (logs.length < 200) logs.push((level === 'log' ? '' : level + ': ') + args.map(fmt).join(' ').slice(0, 400)); };
  globalThis.console = { log: mk('log'), info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') };
  globalThis.__takeLogs = () => logs.splice(0, logs.length);
  let now = 0;
  globalThis.__setNow = (t) => { now = t; };
  let a = __SEED__ >>> 0;
  Math.random = function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const RealDate = Date;
  class WorldDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(now); else super(...args); }
    static now() { return now; }
  }
  globalThis.Date = WorldDate;
  delete globalThis.Atomics;
  delete globalThis.SharedArrayBuffer;
  delete globalThis.WebAssembly;
})();
`;

const CALL = new vm.Script(`(function () {
  __setNow(__now);
  let err = null;
  if (__in !== null) {
    try { __s.onEvent(JSON.parse(__in)); }
    catch (e) { err = String((e && e.stack) || e).split('\\n').slice(0, 4).join('\\n'); }
  }
  let out = '[]';
  try {
    const list = __s.intents();
    out = JSON.stringify(Array.isArray(list) ? list : []);
  } catch (e) {
    err = err || ('intents() threw: ' + String((e && e.message) || e));
  }
  return JSON.stringify({ out: out, err: err, logs: __takeLogs() });
})()`, { filename: 'once:call' });

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Turn an ES module (or CommonJS) source into a script that yields createSettler.
export function transformSource(src) {
  if (typeof src !== 'string' || !src.trim()) throw new SettleLoadError('settle.js is empty');
  if (src.length > 200000) throw new SettleLoadError('settle.js is larger than 200 KB');
  if (/^\s*import\s+[\w{*'"]/m.test(src) || /\bimport\s*\(/.test(src) || /\brequire\s*\(/.test(src)) {
    throw new SettleLoadError('settle.js cannot import or require anything: it runs with no modules, no fs, no net and no process. Inline what you need.');
  }
  let s = src;
  s = s.replace(/(^|[;}\s])export\s*\{([^}]*)\}\s*;?/g, (_, ind, names) => ind + names.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [local, as] = p.split(/\s+as\s+/).map((x) => x.trim());
    return `__exports[${JSON.stringify(as || local)}] = ${local};`;
  }).join(' '));
  s = s.replace(/(^|[;}\s])export\s+default\s+/g, '$1__exports.default = ');
  s = s.replace(/(^|[;}\s])export\s+(?=(async\s+)?function\b|const\b|let\b|var\b|class\b)/g, '$1');
  return `(function () {
"use strict";
const __exports = {};
const module = { exports: {} };
const exports = module.exports;
${s}
;
return {
  createSettler: (typeof createSettler === 'function') ? createSettler : undefined,
  named: __exports.createSettler,
  def: __exports.default,
  cjs: module.exports,
};
})()`;
}

export class SettlerHost {
  // Throws SettleLoadError with a message a model can act on.
  constructor(source, { tariffCentsPerKwh = 60, seed = 1, now = 0, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    this.source = source;
    this.sha = sha256(source);
    this.timeoutMs = timeoutMs;
    this.seen = new Set();
    this.dead = null;
    this.errors = 0;
    this.lastError = null;

    const sandbox = Object.create(null);
    this.ctx = vm.createContext(sandbox, {
      name: 'settle.js',
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    });
    new vm.Script(PRELUDE.replace('__SEED__', String(seed >>> 0)), { filename: 'once:prelude' }).runInContext(this.ctx);

    let code;
    try {
      code = new vm.Script(transformSource(source), { filename: 'settle.js' });
    } catch (e) {
      if (e instanceof SettleLoadError) throw e;
      throw new SettleLoadError(`settle.js does not parse: ${e.message}`);
    }
    this.ctx.__now = now;
    try {
      const holder = code.runInContext(this.ctx, { timeout: timeoutMs });
      // holder is an object from the sandbox realm; keep it inside by storing it there.
      this.ctx.__holder = holder;
    } catch (e) {
      throw new SettleLoadError(`settle.js threw while loading: ${firstLine(e)}`);
    }
    const setup = new vm.Script(`(function () {
      const h = __holder;
      const f = h.createSettler || h.named || (typeof h.def === 'function' ? h.def : (h.def && h.def.createSettler)) || (h.cjs && h.cjs.createSettler) || (typeof h.cjs === 'function' ? h.cjs : undefined);
      if (typeof f !== 'function') return 'settle.js must export function createSettler({ tariffCentsPerKwh })';
      __setNow(__now);
      let s;
      try { s = f(JSON.parse(__cfg)); } catch (e) { return 'createSettler() threw: ' + String((e && e.message) || e); }
      if (!s || typeof s.onEvent !== 'function' || typeof s.intents !== 'function') return 'createSettler() must return an object with onEvent(evt) and intents() methods';
      globalThis.__s = s;
      try { const l = s.intents(); if (!Array.isArray(l)) return 'intents() must return an array'; JSON.stringify(l); } catch (e) { return 'intents() threw: ' + String((e && e.message) || e); }
      return null;
    })()`, { filename: 'once:setup' });
    this.ctx.__cfg = JSON.stringify({ tariffCentsPerKwh });
    let problem;
    try {
      problem = setup.runInContext(this.ctx, { timeout: timeoutMs });
    } catch (e) {
      throw new SettleLoadError(`settle.js setup failed: ${firstLine(e)}`);
    }
    if (problem) throw new SettleLoadError(String(problem));
  }

  // Deliver one event; returns { intents: [new raw intents], logs, error }.
  onEvent(evt, now) { return this._call(JSON.stringify(evt), now); }

  // Read intents() without delivering an event.
  poll(now) { return this._call(null, now); }

  _call(json, now) {
    if (this.dead) return { intents: [], logs: [], error: this.dead };
    this.ctx.__in = json;
    this.ctx.__now = Number.isFinite(now) ? now : 0;
    let res;
    try {
      res = JSON.parse(CALL.runInContext(this.ctx, { timeout: this.timeoutMs }));
    } catch (e) {
      this.dead = /timed out/i.test(String(e && e.message))
        ? `settle.js took longer than ${this.timeoutMs} ms on one event and was stopped`
        : `settle.js crashed: ${firstLine(e)}`;
      return { intents: [], logs: [], error: this.dead };
    }
    if (res.err) { this.errors++; this.lastError = res.err; }
    let list = [];
    try { list = JSON.parse(res.out); } catch (e) { list = []; }
    const fresh = [];
    list.forEach((it, i) => {
      const key = it && typeof it === 'object' && it.intent_id != null ? `id:${it.intent_id}` : `#${i}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (!it || typeof it !== 'object') { fresh.push({ __invalid: 'intent is not an object', raw: it, intent_id: `#${i}` }); return; }
      fresh.push({ ...it, intent_id: it.intent_id != null ? String(it.intent_id) : `#${i}` });
    });
    return { intents: fresh, logs: res.logs || [], error: res.err };
  }
}

function firstLine(e) {
  return String((e && e.message) || e).split('\n')[0];
}

// Validate that a source loads and survives a probe event. Returns { ok, error, sha }.
export function validateSettleSource(source, opts = {}) {
  try {
    const h = new SettlerHost(source, opts);
    const r = h.onEvent({ seq: 0, at: opts.now || 0, type: 'tick' }, opts.now || 0);
    if (h.dead) return { ok: false, error: h.dead, sha: h.sha };
    if (r.error) return { ok: false, error: `onEvent threw on a tick event: ${r.error}`, sha: h.sha };
    return { ok: true, error: null, sha: h.sha };
  } catch (e) {
    return { ok: false, error: e instanceof SettleLoadError ? e.message : `settle.js failed to load: ${firstLine(e)}`, sha: sha256(String(source || '')) };
  }
}
