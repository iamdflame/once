// Seeded fault scenarios. A scenario is a pure function of its seed: which chargers
// take part, their firmware quirks, clock skew, and a timeline of holds, plug-ins,
// unplugs, cuts, restores, reboots and lost acknowledgements. The archetype is
// seed % 10, so any 10 consecutive seeds cover every archetype; the seed's PRNG then
// varies the charger, the timings, the power, the quirk mix and the extra faults.

import { Rng } from './rng.js';

const M = 60000;

export const ARCHETYPES = [
  'cut-unplug-restore',
  'dup-stop',
  'reboot-restart',
  'reboot-meter-reset',
  'stop-without-start',
  'start-lost-offline',
  'clock-skew',
  'reboot-while-offline',
  'back-to-back-offline',
  'storm',
];

const IDS = Array.from({ length: 12 }, (_, i) => `CP${String(i + 1).padStart(2, '0')}`);

class Builder {
  constructor(seed) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.chargers = new Map();
    this.actions = [];
    this.faults = new Set();
    this.holdN = 0;
    this.free = this.rng.shuffle(IDS);
  }

  charger(quirks = {}, skewS = 0) {
    const id = this.free.shift();
    const c = {
      id,
      quirks: { queue_offline: true, dup_stop: false, reboot_restart: false, stop_without_start: false, meter_reset_on_reboot: false, ...quirks },
      skew_s: skewS,
      meter_wh: this.rng.int(100000, 5000000),
      reboot_reason: this.rng.pick(['Reboot', 'PowerLoss']),
    };
    this.chargers.set(id, c);
    for (const [q, on] of Object.entries(quirks)) {
      if (q === 'queue_offline') { if (!on) this.faults.add('queue_offline_off'); } else if (on) this.faults.add(q === 'meter_reset_on_reboot' ? 'meter_reset' : q);
    }
    if (skewS) this.faults.add('clock_skew');
    return id;
  }

  at(t, op, charger, extra = {}) { this.actions.push({ at: Math.round(t), op, charger, ...extra }); }

  fault(f) { this.faults.add(f); }

  hold(t, charger, amount = 5000) {
    const pi = `pi_sim_${this.seed}_${++this.holdN}`;
    this.at(t, 'hold', charger, { payment_intent: pi, amount_cents: amount });
    return pi;
  }

  plug(t, charger, kw) {
    this.at(t, 'plug', charger, { power_kw: kw ?? Math.round(this.rng.float(7, 22) * 10) / 10, id_tag: this.rng.hex(8) });
  }

  min(a, b) { return this.rng.int(a, b) * M + this.rng.int(0, 59) * 1000; }

  build(name) {
    this.actions.sort((a, b) => a.at - b.at);
    const last = this.actions.length ? this.actions[this.actions.length - 1].at : 0;
    return {
      seed: this.seed,
      name,
      faults: [...this.faults],
      chargers: [...this.chargers.values()],
      actions: this.actions,
      duration: last + 40 * M,
    };
  }
}

// A session with an optional offline ending: hold, plug, (cut, unplug offline, restore) or unplug.
function session(b, id, t0, { offline = false, minMin = 20, maxMin = 150, kw, amount } = {}) {
  b.hold(t0, id, amount);
  const plugAt = t0 + b.min(1, 3);
  b.plug(plugAt, id, kw);
  if (!offline) {
    const unplugAt = plugAt + b.min(minMin, maxMin);
    b.at(unplugAt, 'unplug', id);
    return unplugAt;
  }
  const cutAt = plugAt + b.min(Math.max(5, minMin - 15), Math.max(10, maxMin - 40));
  const unplugAt = cutAt + b.min(5, 40);
  const restoreAt = unplugAt + b.min(1, 20);
  b.at(cutAt, 'cut', id);
  b.at(unplugAt, 'unplug', id);
  b.at(restoreAt, 'restore', id);
  b.fault('cut');
  b.fault('unplug_offline');
  b.fault('restore');
  return restoreAt;
}

export function generateScenario(seed) {
  seed = seed >>> 0;
  const archetype = seed % ARCHETYPES.length;
  const b = new Builder(seed);
  const r = b.rng;
  const T = 2 * M;
  switch (ARCHETYPES[archetype]) {
    case 'cut-unplug-restore': {
      const id = b.charger();
      session(b, id, T, { offline: true });
      if (r.chance(0.5)) session(b, b.charger(), T + b.min(0, 20), { offline: r.chance(0.5) });
      break;
    }
    case 'dup-stop': {
      const id = b.charger({ dup_stop: true });
      const end = session(b, id, T, { offline: true });
      if (r.chance(0.5)) session(b, id, end + b.min(2, 10), { offline: r.chance(0.5) });
      break;
    }
    case 'reboot-restart': {
      const id = b.charger({ reboot_restart: true });
      b.hold(T, id);
      const plugAt = T + b.min(1, 3);
      b.plug(plugAt, id);
      let t = plugAt + b.min(15, 60);
      b.at(t, 'reboot', id);
      if (r.chance(0.4)) { t += b.min(5, 30); b.at(t, 'reboot', id); b.fault('reboot_twice'); }
      b.at(t + b.min(10, 70), 'unplug', id);
      break;
    }
    case 'reboot-meter-reset': {
      const dup = r.chance(0.5);
      const id = b.charger({ reboot_restart: true, meter_reset_on_reboot: true, dup_stop: dup });
      b.hold(T, id);
      const plugAt = T + b.min(1, 3);
      b.plug(plugAt, id);
      const rebootAt = plugAt + b.min(15, 60);
      b.at(rebootAt, 'reboot', id);
      if (dup || r.chance(0.5)) {
        const cutAt = rebootAt + b.min(5, 30);
        const unplugAt = cutAt + b.min(5, 30);
        b.at(cutAt, 'cut', id);
        b.at(unplugAt, 'unplug', id);
        b.at(unplugAt + b.min(1, 15), 'restore', id);
        b.fault('cut'); b.fault('unplug_offline'); b.fault('restore');
      } else {
        b.at(rebootAt + b.min(10, 60), 'unplug', id);
      }
      break;
    }
    case 'stop-without-start': {
      const noQueue = r.chance(0.5);
      const id = b.charger({ stop_without_start: true, queue_offline: !noQueue });
      b.hold(T, id);
      const plugAt = T + b.min(1, 3);
      b.plug(plugAt, id);
      let unplugAt = plugAt + b.min(30, 150);
      if (r.chance(0.6)) {
        // a cut in the middle of the session, restored before the driver leaves
        const cutAt = plugAt + b.min(5, 20);
        const restoreAt = cutAt + b.min(5, 25);
        b.at(cutAt, 'cut', id);
        b.at(restoreAt, 'restore', id);
        unplugAt = Math.max(unplugAt, restoreAt + b.min(5, 30));
        b.fault('cut'); b.fault('restore');
      }
      b.at(unplugAt, 'unplug', id);
      break;
    }
    case 'start-lost-offline': {
      const id = b.charger({ stop_without_start: true, dup_stop: true });
      session(b, id, T, { offline: true });
      break;
    }
    case 'clock-skew': {
      const skew = r.pick([-26 * 3600, -3 * 3600, -17 * 60, 9 * 60, 2 * 3600, 31 * 3600]) + r.int(-300, 300);
      const id = b.charger({ dup_stop: r.chance(0.5) }, skew);
      session(b, id, T, { offline: true });
      const other = b.charger({}, -Math.round(skew / 2));
      session(b, other, T + b.min(0, 15), { offline: r.chance(0.5) });
      break;
    }
    case 'reboot-while-offline': {
      const reset = r.chance(0.5);
      const id = b.charger({ reboot_restart: true, dup_stop: true, meter_reset_on_reboot: reset });
      b.hold(T, id);
      const plugAt = T + b.min(1, 3);
      b.plug(plugAt, id);
      const cutAt = plugAt + b.min(10, 40);
      const rebootAt = cutAt + b.min(2, 10);
      const unplugAt = rebootAt + b.min(5, 30);
      b.at(cutAt, 'cut', id);
      b.at(rebootAt, 'reboot', id);
      b.at(unplugAt, 'unplug', id);
      b.at(unplugAt + b.min(1, 15), 'restore', id);
      b.fault('cut'); b.fault('reboot_offline'); b.fault('unplug_offline'); b.fault('restore');
      break;
    }
    case 'back-to-back-offline': {
      const id = b.charger({ dup_stop: r.chance(0.6), stop_without_start: r.chance(0.3) });
      b.hold(T, id);
      const plugA = T + b.min(1, 3);
      b.plug(plugA, id);
      const cutAt = plugA + b.min(10, 50);
      const unplugA = cutAt + b.min(5, 30);
      const holdB = unplugA + b.min(1, 5);
      const plugB = holdB + b.min(1, 3);
      b.at(cutAt, 'cut', id);
      b.at(unplugA, 'unplug', id);
      b.hold(holdB, id);
      b.plug(plugB, id);
      if (r.chance(0.5)) {
        const unplugB = plugB + b.min(20, 60);
        b.at(unplugB, 'unplug', id);
        b.at(unplugB + b.min(1, 10), 'restore', id);
      } else {
        const restoreAt = plugB + b.min(5, 30);
        b.at(restoreAt, 'restore', id);
        b.at(restoreAt + b.min(10, 60), 'unplug', id);
      }
      b.fault('back_to_back'); b.fault('cut'); b.fault('unplug_offline'); b.fault('restore');
      break;
    }
    case 'storm': {
      const n = r.int(3, 5);
      for (let i = 0; i < n; i++) {
        const quirks = {
          dup_stop: r.chance(0.5),
          reboot_restart: r.chance(0.4),
          stop_without_start: r.chance(0.25),
          meter_reset_on_reboot: false,
        };
        quirks.meter_reset_on_reboot = quirks.reboot_restart && r.chance(0.5);
        const skew = r.chance(0.25) ? r.int(-30, 30) * 600 : 0;
        const id = b.charger(quirks, skew);
        let t = T + b.min(0, 30);
        const sessions = r.int(1, 2);
        for (let s = 0; s < sessions; s++) {
          const long = r.chance(0.15);
          const amount = r.chance(0.2) ? 2500 : 5000;
          if (long) b.fault('exceeds_hold');
          if (r.chance(0.3)) { b.at(t, 'lose_ack', id, { action: r.chance(0.8) ? 'StopTransaction' : 'StartTransaction' }); b.fault('ack_lost'); }
          const plan = r.pick(['offline', 'reboot', 'midcut', 'plain']);
          if (plan === 'offline') {
            t = session(b, id, t, { offline: true, kw: long ? 22 : undefined, minMin: long ? 200 : 20, maxMin: long ? 300 : 150, amount });
          } else {
            b.hold(t, id, amount);
            const plugAt = t + b.min(1, 3);
            b.plug(plugAt, id, long ? 22 : undefined);
            let unplugAt = plugAt + b.min(long ? 200 : 25, long ? 300 : 150);
            if (plan === 'reboot') {
              b.at(plugAt + b.min(10, 20), 'reboot', id);
              b.fault(quirks.reboot_restart ? 'reboot_restart' : 'reboot');
            } else if (plan === 'midcut') {
              const cutAt = plugAt + b.min(5, 15);
              b.at(cutAt, 'cut', id);
              b.at(cutAt + b.min(3, 8), 'restore', id);
              b.fault('cut'); b.fault('restore');
            }
            b.at(unplugAt, 'unplug', id);
            t = unplugAt;
          }
          t += b.min(2, 15);
        }
      }
      break;
    }
    default:
      throw new Error('unreachable');
  }
  return b.build(ARCHETYPES[archetype]);
}
