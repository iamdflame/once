// WorldCore: the CSMS, the charger fleet, the episode/hold ledger, the settlement
// program and the intent book, wired to one clock and one transport. The live world
// (HTTP API, WebSockets, real timers) and the scenario runner (virtual network,
// discrete-event clock) both build on it, so the suite tests the very code that runs
// live.

import { Csms } from './csms.js';
import { Firmware } from './firmware.js';
import { SettlerHost } from './sandbox.js';

// Event types the settlement program receives (everything the CSMS side can know).
export const FEED_TYPES = new Set(['ocpp', 'link', 'hold', 'intent_result']);

export class WorldCore {
  constructor({
    clock,
    transport,
    links,
    chargerIds,
    timing,
    tariffCentsPerKwh = 60,
    chargerOptions = () => ({}),
    authority = null, // PaymentAuthority: execute intents locally (scenario runner)
    hostDelayMs = 1500,
    tickEvery = null,
    maxEvents = 20000,
    maxFeed = 200000,
    seed = 1,
    heartbeatIntervalS = 300,
  }) {
    this.clock = clock;
    this.links = links;
    this.tariffCentsPerKwh = tariffCentsPerKwh;
    this.authority = authority;
    this.hostDelayMs = hostDelayMs;
    this.maxEvents = maxEvents;
    this.maxFeed = maxFeed;
    this.seed = seed;

    this.seq = 0;
    this.events = [];
    this.feed = [];
    this.listeners = new Set();

    this.holds = new Map(); // payment_intent -> hold
    this.pendingHolds = new Map(); // charger -> [hold] (FIFO, bound at the next plug-in)
    this.episodes = [];
    this.episodeCount = new Map();
    this.holdCount = new Map(); // charger -> holds placed (a hold's seq; driver A, B, ... by default)
    this.trigger = null; // the feed event settle.js is reacting to (for driver attribution)
    this.intents = new Map(); // world intent id -> intent
    this.intentN = 0;
    this.settle = null;
    this.settler = null;
    this.settleVersion = 0;
    this.settlerErrors = 0;

    this.csms = new Csms({ clock, emit: (e) => this.emit(e), heartbeatIntervalS });
    this.chargers = new Map();
    chargerIds.forEach((id, index) => {
      const fw = new Firmware({
        id,
        index,
        clock,
        transport,
        timing,
        onLog: (kind, detail) => this.emit({ type: 'charger', charger: id, kind, ...detail }),
        ...chargerOptions(id, index),
      });
      this.chargers.set(id, fw);
      this.pendingHolds.set(id, []);
      this.episodeCount.set(id, 0);
      this.holdCount.set(id, 0);
    });

    if (tickEvery) this.tickTimer = clock.every(tickEvery, () => this.tick());
  }

  setTransport(transport) {
    for (const fw of this.chargers.values()) fw.transport = transport;
  }

  start() { for (const fw of this.chargers.values()) fw.start(); }

  shutdown() {
    this.clock.cancel(this.tickTimer);
    for (const fw of this.chargers.values()) fw.shutdown();
  }

  fw(id) {
    const fw = this.chargers.get(id);
    if (!fw) throw httpError(404, `unknown charger "${id}" (known: ${[...this.chargers.keys()].join(', ')})`);
    return fw;
  }

  // ---------- events ----------

  emit(e) {
    const evt = { seq: ++this.seq, at: this.clock.now(), ...e };
    this.events.push(evt);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    for (const l of this.listeners) { try { l(evt); } catch (err) { /* listener errors never break the world */ } }
    if (FEED_TYPES.has(evt.type)) this.deliver(toFeed(evt));
    return evt;
  }

  deliver(f) {
    this.feed.push(f);
    if (this.feed.length > this.maxFeed) this.feed.splice(0, this.feed.length - this.maxFeed);
    if (!this.settler) return;
    this.react(f, () => this.absorb(this.settler.onEvent(f, f.at), {}));
  }

  tick() {
    if (!this.settler) return;
    const now = this.clock.now();
    const f = { seq: this.seq, at: now, type: 'tick' };
    this.react(f, () => this.absorb(this.settler.onEvent(f, now), {}));
  }

  // Run fn with `f` as the event settle.js is reacting to, so every intent it emits can be
  // attributed to the plug-in episode whose energy it bills (see attribute()).
  react(f, fn) {
    const prev = this.trigger;
    this.trigger = f;
    try { fn(); } finally { this.trigger = prev; }
  }

  absorb(res, { replay = false }) {
    if (!res) return;
    if (res.error) {
      this.settlerErrors++;
      this.emit({ type: 'settler_error', version: this.settleVersion, error: res.error });
    }
    if (res.logs && res.logs.length) this.emit({ type: 'settler_log', version: this.settleVersion, lines: res.logs });
    for (const raw of res.intents) this.registerIntent(raw, { replay });
  }

  // ---------- settlement program ----------

  loadSettler(source, { name = 'settle.js', replay = false } = {}) {
    const host = new SettlerHost(source, { tariffCentsPerKwh: this.tariffCentsPerKwh, seed: this.seed, now: this.clock.now() });
    this.settleVersion++;
    this.settler = host;
    this.settle = { version: this.settleVersion, name, sha256: host.sha, loaded_at: this.clock.now(), source };
    this.emit({ type: 'settle', version: this.settleVersion, name, sha256: host.sha, replayed: replay ? this.feed.length : 0 });
    if (replay) {
      for (const f of this.feed) this.react(f, () => this.absorb(host.onEvent(f, f.at), { replay: true }));
    }
    return this.settle;
  }

  registerIntent(raw, { replay = false } = {}) {
    const id = `in_${String(++this.intentN).padStart(5, '0')}`;
    const pi = raw.payment_intent != null ? String(raw.payment_intent) : null;
    const hold = pi ? this.holds.get(pi) : null;
    const amount = raw.amount_cents;
    let problem = raw.__invalid || null;
    const who = this.attribute(hold, this.trigger);
    if (!problem && !hold) problem = pi ? `unknown payment_intent "${pi}" (no hold was placed with it)` : 'intent has no payment_intent';
    if (!problem && !(Number.isInteger(amount) && amount >= 0)) problem = 'amount_cents must be a non-negative integer number of cents';
    const intent = {
      id,
      intent_id: raw.intent_id,
      episode_id: raw.episode_id != null ? String(raw.episode_id) : null,
      charger: raw.charger != null ? String(raw.charger) : hold ? hold.charger : null,
      payment_intent: pi,
      amount_cents: Number.isInteger(amount) ? amount : null,
      kind: amount === 0 ? 'release' : 'capture',
      // Who pays and whose energy it is: the hold's driver, and the plug-in episode the
      // decision was made for (by the OCPP message settle.js was reacting to).
      driver: hold ? hold.driver : null,
      hold_seq: hold ? hold.seq : null,
      energy_episode_id: who.episode ? who.episode.id : null,
      energy_driver: who.episode ? who.episode.driver : null,
      energy_wh: who.episode ? who.episode.energy_wh : null,
      energy_expected_cents: who.episode ? this.expectedCents(who.episode) : null,
      attribution: who.basis,
      wrong_driver: hold && who.episode ? hold.episode_id !== who.episode.id : null,
      status: problem ? 'rejected' : 'pending',
      error: problem,
      settle_version: this.settleVersion,
      created_at: this.clock.now(),
      created_seq: this.seq,
      result: null,
      extra_results: [],
    };
    if (!problem && replay && hold) {
      const busy = hold.status !== 'requires_capture' || [...this.intents.values()].some((x) => x.payment_intent === pi && (x.status === 'pending' || x.status === 'in_flight'));
      if (busy) { intent.status = 'suppressed'; intent.error = 'replay: this hold was already settled or has an intent in flight'; }
    }
    this.intents.set(id, intent);
    this.emit({ type: 'intent', intent: publicIntent(intent) });
    if (intent.status === 'pending' && this.authority) {
      this.clock.after(this.hostDelayMs, () => this.recordResult(id, this.authority.execute(intent)));
    }
    return intent;
  }

  claimIntents({ limit = 50, leaseMs = 15000 } = {}) {
    const nowReal = Date.now();
    const out = [];
    for (const it of this.intents.values()) {
      if (out.length >= limit) break;
      const free = it.status === 'pending' || (it.status === 'in_flight' && it.lease_until < nowReal);
      if (!free) continue;
      it.status = 'in_flight';
      it.lease_until = nowReal + leaseMs;
      out.push(publicIntent(it));
    }
    return out;
  }

  pendingIntents() {
    return [...this.intents.values()].filter((it) => it.status === 'pending' || it.status === 'in_flight').map(publicIntent);
  }

  recordResult(id, { ok, status, error, stripe_object } = {}) {
    const it = this.intents.get(id);
    if (!it) throw httpError(404, `unknown intent "${id}"`);
    if (it.status === 'rejected' || it.status === 'suppressed') throw httpError(409, `intent ${id} was ${it.status} by the world and must not be executed`);
    const result = { ok: !!ok, status: status ?? null, error: normError(error), stripe_object: stripe_object ?? null, at: this.clock.now() };
    if (it.result) {
      it.extra_results.push(result);
      return { intent: publicIntent(it), duplicate: true };
    }
    it.result = result;
    it.status = result.ok ? 'succeeded' : 'failed';
    const hold = this.holds.get(it.payment_intent);
    if (hold) {
      hold.results.push({
        intent: id, kind: it.kind, amount_cents: it.amount_cents, ok: result.ok, status: result.status, error: result.error,
        driver: it.driver, energy_episode_id: it.energy_episode_id, energy_driver: it.energy_driver, wrong_driver: it.wrong_driver,
      });
      const so = stripe_object || {};
      if (result.ok) {
        if (it.kind === 'release') {
          hold.status = 'canceled';
          hold.amount_released = hold.amount_cents;
        } else {
          hold.status = 'succeeded';
          hold.amount_captured = Number.isInteger(so.amount_received) ? so.amount_received : it.amount_cents;
          hold.amount_released = hold.amount_cents - hold.amount_captured;
          hold.captured_for = { episode_id: it.energy_episode_id, driver: it.energy_driver, wrong_driver: it.wrong_driver };
        }
      } else if (so.status) {
        hold.status = so.status;
      }
    }
    this.emit({
      type: 'intent_result',
      intent_id: it.intent_id,
      world_intent_id: id,
      episode_id: it.episode_id,
      charger: it.charger,
      payment_intent: it.payment_intent,
      kind: it.kind,
      amount_cents: it.amount_cents,
      ok: result.ok,
      status: result.status,
      error: result.error ? result.error.message : null,
      driver: it.driver,
      energy_episode_id: it.energy_episode_id,
      energy_driver: it.energy_driver,
      wrong_driver: it.wrong_driver,
    });
    return { intent: publicIntent(it), duplicate: false };
  }

  // ---------- holds and episodes ----------

  placeHold({ charger, payment_intent, amount_cents, currency = 'eur', driver = null }) {
    this.fw(charger);
    if (typeof payment_intent !== 'string' || !payment_intent) throw httpError(400, 'payment_intent must be a non-empty string');
    if (!Number.isInteger(amount_cents) || amount_cents <= 0) throw httpError(400, 'amount_cents must be a positive integer');
    if (driver != null && !(typeof driver === 'string' && /^[A-Za-z0-9 _.-]{1,24}$/.test(driver))) throw httpError(400, 'driver must be a short label like "A" or "B"');
    const existing = this.holds.get(payment_intent);
    if (existing) {
      if (existing.charger !== charger) throw httpError(409, `payment_intent ${payment_intent} is already bound to ${existing.charger}`);
      return { hold: this.holdView(existing), existing: true };
    }
    const seq = this.holdCount.get(charger) + 1;
    this.holdCount.set(charger, seq);
    const hold = {
      payment_intent,
      charger,
      seq, // 1 for the first hold on this charger since the last reset
      driver: driver || driverLetter(seq), // "A", "B", ... unless the host names the driver
      amount_cents,
      currency: String(currency).toLowerCase(),
      placed_at: this.clock.now(),
      episode_id: null,
      status: 'requires_capture',
      amount_captured: 0,
      amount_released: 0,
      results: [],
      captured_for: null,
    };
    this.holds.set(payment_intent, hold);
    this.pendingHolds.get(charger).push(hold);
    if (this.authority) this.authority.authorize(payment_intent, amount_cents, hold.currency);
    this.emit({ type: 'hold', charger, connectorId: 1, payment_intent, amount_cents, currency: hold.currency, driver: hold.driver, hold_seq: seq });
    return { hold: this.holdView(hold), existing: false };
  }

  plug(id, { idTag, powerKw } = {}) {
    const fw = this.fw(id);
    if (fw.plugged) throw httpError(409, `${id} is already plugged in`);
    const n = this.episodeCount.get(id) + 1;
    this.episodeCount.set(id, n);
    const hold = this.pendingHolds.get(id).shift() || null;
    const kw = Number.isFinite(powerKw) ? Math.min(22, Math.max(1, powerKw)) : 11;
    const tag = idTag || `QR${id.slice(-2)}${String(n).padStart(3, '0')}`;
    const ep = {
      id: `${id}-E${n}`,
      charger: id,
      payment_intent: hold ? hold.payment_intent : null,
      amount_cents: hold ? hold.amount_cents : null,
      driver: hold ? hold.driver : null,
      plugged_at: this.clock.now(),
      unplugged_at: null,
      power_kw: kw,
      energy_wh: 0,
      transactions: [],
    };
    if (hold) hold.episode_id = ep.id;
    this.episodes.push(ep);
    this.emit({ type: 'cmd', op: 'plug', charger: id, episode_id: ep.id, payment_intent: ep.payment_intent, driver: ep.driver, power_kw: kw, id_tag: tag });
    fw.plug({ idTag: tag, powerKw: kw }, ep);
    return ep;
  }

  unplug(id) {
    const fw = this.fw(id);
    if (!fw.plugged) throw httpError(409, `${id} is not plugged in`);
    const ep = fw.unplug();
    if (ep) ep.unplugged_at = this.clock.now();
    this.emit({ type: 'cmd', op: 'unplug', charger: id, episode_id: ep ? ep.id : null, energy_wh: ep ? ep.energy_wh : null, offline: !fw.online });
    return ep;
  }

  cut(id) { this.fw(id); this.links.cut(id); this.emit({ type: 'cmd', op: 'cut', charger: id }); }

  restore(id) { this.fw(id); this.links.restore(id); this.emit({ type: 'cmd', op: 'restore', charger: id }); }

  reboot(id) {
    const fw = this.fw(id);
    const ok = fw.reboot();
    this.emit({ type: 'cmd', op: 'reboot', charger: id, accepted: ok });
    return ok;
  }

  setQuirk(id, quirk, on) {
    const fw = this.fw(id);
    try { fw.setQuirk(quirk, on); } catch (e) { throw httpError(400, e.message); }
  }

  setSkew(id, seconds) {
    const fw = this.fw(id);
    if (!Number.isFinite(seconds)) throw httpError(400, 'seconds must be a number');
    fw.setSkew(seconds * 1000);
  }

  episodeById(id) {
    if (!id) return null;
    for (let i = this.episodes.length - 1; i >= 0; i--) if (this.episodes[i].id === id) return this.episodes[i];
    return null;
  }

  // The plug-in episode whose energy a settlement decision bills. The world knows which
  // OCPP transaction belongs to which episode (it is the metered truth), so an intent
  // emitted while settle.js handled a StopTransaction / MeterValues / StartTransaction is
  // for that transaction's episode. Otherwise (a tick, a status message) it is taken to be
  // for the episode its hold paid for.
  attribute(hold, trig) {
    let txId = null;
    if (trig && trig.type === 'ocpp') {
      txId = trig.action === 'StartTransaction' ? trig.response && trig.response.transactionId : trig.payload && trig.payload.transactionId;
    }
    if (txId != null && (!hold || hold.charger === trig.charger)) {
      for (let i = this.episodes.length - 1; i >= 0; i--) {
        const ep = this.episodes[i];
        if (ep.charger !== trig.charger) continue;
        if (ep.transactions.some((t) => t.transactionId === txId || t.localId === txId)) {
          return { episode: ep, basis: `${trig.action} transactionId ${txId}` };
        }
      }
    }
    const own = hold ? this.episodeById(hold.episode_id) : null;
    return own ? { episode: own, basis: 'hold episode' } : { episode: null, basis: null };
  }

  // A hold as the API shows it, plus whether its episode is over and the hold is stranded
  // (episode ended, still requires_capture, no intent pending or in flight for it).
  holdView(h) {
    const ep = this.episodeById(h.episode_id);
    const ended = !!(ep && ep.unplugged_at != null);
    const busy = ended && [...this.intents.values()].some((x) => x.payment_intent === h.payment_intent && (x.status === 'pending' || x.status === 'in_flight'));
    return { ...publicHold(h), episode_ended: ended, stranded: ended && h.status === 'requires_capture' && !busy };
  }

  expectedCents(ep) {
    if (ep.amount_cents == null) return null;
    return Math.min(ep.amount_cents, Math.round((ep.energy_wh * this.tariffCentsPerKwh) / 1000));
  }

  // ---------- views ----------

  episodeView(ep) {
    return {
      id: ep.id,
      charger: ep.charger,
      payment_intent: ep.payment_intent,
      amount_cents: ep.amount_cents,
      driver: ep.driver,
      plugged_at: ep.plugged_at,
      unplugged_at: ep.unplugged_at,
      power_kw: ep.power_kw,
      energy_wh: ep.energy_wh,
      expected_cents: this.expectedCents(ep),
      transactions: ep.transactions.map((t) => ({
        transaction_id: t.transactionId,
        local_id: t.localId,
        start_lost: t.startLost,
        meter_start: t.meterStart,
        meter_stop: t.meterStop ?? null,
        energy_wh: t.energyWh,
        reason: t.reason ?? null,
      })),
    };
  }

  state({ events = 100 } = {}) {
    const now = this.clock.now();
    const chargers = [...this.chargers.values()].map((fw) => {
      const s = fw.snapshot();
      const ep = fw.episode;
      const next = this.pendingHolds.get(fw.id)[0] || null;
      return {
        ...s,
        link: this.links.isCut(fw.id) ? 'cut' : 'up',
        episode: ep ? { id: ep.id, payment_intent: ep.payment_intent, energy_wh: ep.energy_wh, cost_cents: Math.round((ep.energy_wh * this.tariffCentsPerKwh) / 1000), plugged_at: ep.plugged_at } : null,
        next_hold: next ? { payment_intent: next.payment_intent, amount_cents: next.amount_cents, driver: next.driver } : null,
      };
    });
    return {
      now,
      now_iso: new Date(now).toISOString(),
      tariff_cents_per_kwh: this.tariffCentsPerKwh,
      settle: this.settle ? { version: this.settle.version, name: this.settle.name, sha256: this.settle.sha256, loaded_at: this.settle.loaded_at, errors: this.settlerErrors, dead: this.settler ? this.settler.dead : null } : null,
      chargers,
      episodes: this.episodes.slice(-100).map((e) => this.episodeView(e)),
      holds: [...this.holds.values()].slice(-200).map((h) => this.holdView(h)),
      intents: [...this.intents.values()].slice(-200).map(publicIntent),
      last_seq: this.seq,
      events: this.events.slice(-events),
    };
  }

  eventsSince(since = 0, limit = 500) {
    const first = this.events.length ? this.events[0].seq : this.seq + 1;
    const truncated = since + 1 < first && since > 0;
    let i = 0;
    // events are seq-ordered; binary search for the first seq > since
    let lo = 0, hi = this.events.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.events[mid].seq <= since) lo = mid + 1; else hi = mid; }
    i = lo;
    const out = this.events.slice(i, i + limit);
    return { events: out, last_seq: out.length ? out[out.length - 1].seq : Math.max(since, 0), head_seq: this.seq, truncated };
  }
}

export function toFeed(evt) {
  switch (evt.type) {
    case 'ocpp': return { seq: evt.seq, at: evt.at, type: 'ocpp', charger: evt.charger, action: evt.action, payload: evt.payload, response: evt.response };
    case 'link': return { seq: evt.seq, at: evt.at, type: 'link', charger: evt.charger, state: evt.state };
    case 'hold': return { seq: evt.seq, at: evt.at, type: 'hold', charger: evt.charger, connectorId: evt.connectorId, payment_intent: evt.payment_intent, amount_cents: evt.amount_cents, currency: evt.currency };
    case 'intent_result': return { seq: evt.seq, at: evt.at, type: 'intent_result', intent_id: evt.intent_id, episode_id: evt.episode_id, charger: evt.charger, payment_intent: evt.payment_intent, kind: evt.kind, amount_cents: evt.amount_cents, ok: evt.ok, status: evt.status, error: evt.error };
    default: return { seq: evt.seq, at: evt.at, type: evt.type };
  }
}

export function publicIntent(it) {
  const { lease_until, ...rest } = it;
  return { ...rest };
}

export function publicHold(h) {
  return { ...h, results: h.results.slice(), captured_for: h.captured_for ? { ...h.captured_for } : null };
}

// 1 -> "A", 2 -> "B", ..., 26 -> "Z", 27 -> "AA"
export function driverLetter(n) {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s || 'A';
}

function normError(error) {
  if (error == null || error === false) return null;
  if (typeof error === 'string') return { message: error };
  if (typeof error === 'object') return { message: String(error.message ?? JSON.stringify(error)), code: error.code ?? null, type: error.type ?? null };
  return { message: String(error) };
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
