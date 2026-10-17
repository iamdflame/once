// The mock world: twelve simulated chargers, a link proxy, a settlement
// program and a stand-in for Stripe, all in the browser. It replays the
// demo in BUILD-ONCE.md faithfully enough to build and test the UI against.
// Nothing here touches the network.

import type { WorldAdapter } from "./adapter";
import { emptyReport, totals } from "./adapter";
import { SETTLE_V1, SETTLE_V2 } from "./settle-sources";
import type {
  AgentEvent,
  Capture,
  Charger,
  CheckoutStart,
  Command,
  Intent,
  Proof,
  Quirk,
  ReceiptLine,
  Scenario,
  Settle,
  Snapshot,
  SuiteReport,
  WorldEvent,
} from "./types";
import { ledFor, stripeUrl } from "./types";

const TARIFF = 60; // cents per kWh (the world's default)
const HOLD = 5000; // €50.00
const COMPRESSION = 300; // simulated seconds per real second (the world's LiveClock default)
const TICK_MS = 250;
const METER_EVERY = 8; // ticks between MeterValues

type OcppAction = "BootNotification" | "StatusNotification" | "StartTransaction" | "MeterValues" | "StopTransaction";

interface OcppMsg {
  action: OcppAction;
  payload: Record<string, unknown>;
}

interface SettleEvent {
  type: "hold" | "ocpp";
  charger: string;
  action?: OcppAction;
  payload?: Record<string, unknown>;
  payment_intent?: string;
  amount_cents?: number;
  episode_id?: string;
}

interface Settler {
  onEvent(e: SettleEvent): void;
  intents(): Omit<Intent, "result">[];
}

interface MockCharger {
  id: string;
  kw: number;
  link: "up" | "cut" | "rebooting";
  plugged: boolean;
  meterWh: number;
  tx: { id: number; meterStart: number } | null;
  queue: OcppMsg[];
  hold: Charger["hold"];
  quirks: Record<Quirk, boolean>;
  episode: { id: string; wh: number } | null;
  ticks: number;
  idTag: string | null;
}

interface MockPI {
  id: string;
  amount: number;
  captured: number | null;
  status: "requires_capture" | "succeeded" | "canceled";
  charger: string;
  session: string;
  created: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rid(prefix: string, n = 14) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return prefix + s;
}

const defaultQuirks = (): Record<Quirk, boolean> => ({
  queue_offline: true,
  dup_stop: true,
  reboot_restart: false,
  stop_without_start: false,
  meter_reset_on_reboot: false,
});

const ARCHETYPES: { name: string; faults: string[] }[] = [
  { name: "cut-unplug-restore", faults: ["cut", "unplug_offline", "restore"] },
  { name: "dup-stop", faults: ["cut", "unplug_offline", "restore", "dup_stop"] },
  { name: "reboot-restart", faults: ["reboot_restart"] },
  { name: "reboot-meter-reset", faults: ["reboot_restart", "meter_reset_on_reboot", "cut", "dup_stop"] },
  { name: "stop-without-start", faults: ["stop_without_start", "cut"] },
  { name: "start-lost-offline", faults: ["stop_without_start", "dup_stop", "unplug_offline"] },
  { name: "clock-skew", faults: ["skew", "unplug_offline"] },
  { name: "reboot-while-offline", faults: ["cut", "reboot_restart", "unplug_offline", "restore", "dup_stop"] },
  { name: "back-to-back-offline", faults: ["cut", "unplug_offline", "hold_while_queued", "restore"] },
  { name: "storm", faults: ["cut", "reboot_restart", "dup_stop", "lose_ack", "over_hold"] },
];

/**
 * Deterministic scenario outcomes for a given settle version, shaped like the
 * world's runner: seed % 10 picks the archetype; v1-naive ends 4/30 ok with
 * double 43, the episode ledger 30/30.
 */
export function mockScenarios(version: "v1" | "v2", count = 30, seedBase = 1): Scenario[] {
  const out: Scenario[] = [];
  for (let i = 0; i < count; i++) {
    const seed = seedBase + i;
    const a = ARCHETYPES[seed % 10];
    const rnd = mulberry32(seed * 7919);
    const charger = `CP${String(1 + Math.floor(rnd() * 12)).padStart(2, "0")}`;
    const wh = 4000 + Math.floor(rnd() * 26000);
    const expected = Math.min(5000, Math.round((wh * TARIFF) / 1000));
    let double = 0;
    let stranded = 0;
    let unbilled = 0;
    let overbilled = 0;
    let underbilled = 0;
    const notes: string[] = [];
    if (version === "v1") {
      const arche = seed % 10;
      const split = a.faults.includes("reboot_restart");
      const lostStart = a.faults.includes("stop_without_start");
      if (split) {
        const n = arche === 9 ? 3 + Math.floor(rnd() * 3) : arche === 7 ? 2 : 1 + Math.floor(rnd() * 2);
        double += n;
        underbilled += 1;
        const first = Math.round(expected * (0.25 + rnd() * 0.4));
        notes.push(
          `${charger}-E1 pi_sim_${seed}_1 expected €${(expected / 100).toFixed(2)} for ${wh} Wh over ${n + 1} OCPP transaction(s): ${n + 1} settlement intents for one hold; underbilled: captured €${(first / 100).toFixed(2)}. Intents: capture €${(first / 100).toFixed(2)} [tx-1001] ok; capture €${((expected - first) / 100).toFixed(2)} [tx-1002] refused: This PaymentIntent could not be captured: the remainder of the authorized amount has been released.`,
        );
      }
      if (lostStart) {
        if (arche === 5 || rnd() < 0.5) {
          stranded += 1;
          unbilled += 1;
          notes.push(`${charger}-E1 pi_sim_${seed}_1 expected €${(expected / 100).toFixed(2)} for ${wh} Wh: no settlement intent (StopTransaction for transactionId 7000001 the CSMS never issued); the hold is still requires_capture.`);
        } else {
          overbilled += 1;
          notes.push(`${charger}-E1 pi_sim_${seed}_1 expected €${(expected / 100).toFixed(2)}: captured €50.00 (meterStart unknown, billed from 0).`);
        }
      }
      if (arche === 3) {
        overbilled += 1;
        notes.push(`${charger}-E1 meter reset to 0 after the reboot: the second transaction's meterStop was billed as if the register had never reset.`);
      }
      if (arche === 8) {
        double += 1;
        notes.push(`${charger}-E2 pi_sim_${seed}_2 (driver B) was charged for driver A's queued StopTransaction, then again for its own.`);
      }
      if (arche === 1 && seed > 10) {
        double += 1;
        notes.push(`${charger}: a second session on the same charger reused the hold; two intents for one PaymentIntent.`);
      }
      if (arche === 6 && seed > 6) {
        underbilled += 1;
        notes.push(`${charger}-E1 timestamps 26 h behind: the energy window was cut at the skewed Stop timestamp.`);
      }
    }
    const ok = double + stranded + unbilled + overbilled + underbilled === 0;
    out.push({ seed, name: a.name, faults: a.faults, chargers: [charger], double, stranded, unbilled, overbilled, underbilled, ok, notes });
  }
  return out;
}

// ---------------------------------------------------------------- settlers

function settlerV1(tariff: number): Settler {
  const holds = new Map<string, SettleEvent>();
  const starts = new Map<number, { charger: string; meterStart: number }>();
  const seen = new Set<number>();
  const out: Omit<Intent, "result">[] = [];
  return {
    onEvent(evt) {
      if (evt.type === "hold") {
        holds.set(evt.charger, evt);
        return;
      }
      const p = evt.payload as { transactionId: number; meterStart?: number; meterStop?: number };
      if (evt.action === "StartTransaction") starts.set(p.transactionId, { charger: evt.charger, meterStart: p.meterStart ?? 0 });
      if (evt.action === "StopTransaction") {
        if (seen.has(p.transactionId)) return;
        seen.add(p.transactionId);
        const start = starts.get(p.transactionId);
        const hold = holds.get(evt.charger);
        if (!start || !hold) return;
        const wh = Math.max(0, (p.meterStop ?? 0) - start.meterStart);
        const amount = Math.round((wh / 1000) * tariff);
        out.push({
          intent_id: "stop-" + p.transactionId,
          episode_id: "tx-" + p.transactionId,
          charger: evt.charger,
          payment_intent: hold.payment_intent!,
          amount_cents: Math.min(amount, hold.amount_cents!),
        });
      }
    },
    intents: () => out.splice(0),
  };
}

function settlerV2(tariff: number): Settler {
  interface Ep {
    id: string;
    payment_intent: string;
    hold_cents: number;
    wh: number;
    live: { transactionId: number; meterStart: number; lastMeter: number } | null;
    closed: boolean;
  }
  const episodes = new Map<string, Ep>();
  const seenStops = new Set<string>();
  const out: Omit<Intent, "result">[] = [];
  const energy = (ep: Ep) => ep.wh + (ep.live ? Math.max(0, ep.live.lastMeter - ep.live.meterStart) : 0);
  const close = (ep: Ep, charger: string) => {
    if (ep.closed) return;
    ep.closed = true;
    const amount = Math.round((energy(ep) / 1000) * tariff);
    out.push({
      intent_id: "episode-" + ep.id,
      episode_id: ep.id,
      charger,
      payment_intent: ep.payment_intent,
      amount_cents: Math.min(amount, ep.hold_cents),
    });
  };
  return {
    onEvent(evt) {
      if (evt.type === "hold") {
        episodes.set(evt.charger, {
          id: evt.episode_id!,
          payment_intent: evt.payment_intent!,
          hold_cents: evt.amount_cents!,
          wh: 0,
          live: null,
          closed: false,
        });
        return;
      }
      const ep = episodes.get(evt.charger);
      if (!ep || ep.closed) return;
      const p = evt.payload as {
        transactionId?: number;
        meterStart?: number;
        meterStop?: number;
        reason?: string;
        status?: string;
        wh?: number;
      };
      if (evt.action === "StartTransaction") {
        if (ep.live) ep.wh += Math.max(0, ep.live.lastMeter - ep.live.meterStart);
        ep.live = { transactionId: p.transactionId!, meterStart: p.meterStart ?? 0, lastMeter: p.meterStart ?? 0 };
      }
      if (evt.action === "MeterValues" && ep.live && p.wh != null && p.wh >= ep.live.lastMeter) ep.live.lastMeter = p.wh;
      if (evt.action === "StopTransaction") {
        const key = `${evt.charger}:${p.transactionId}:${p.meterStop}`;
        if (seenStops.has(key)) return;
        seenStops.add(key);
        if (ep.live && ep.live.transactionId === p.transactionId) {
          if ((p.meterStop ?? 0) >= ep.live.meterStart) ep.live.lastMeter = p.meterStop ?? ep.live.lastMeter;
          ep.wh += Math.max(0, ep.live.lastMeter - ep.live.meterStart);
          ep.live = null;
        }
        if (p.reason !== "PowerLoss" && p.reason !== "Reboot") close(ep, evt.charger);
      }
      if (evt.action === "StatusNotification" && p.status === "Available" && !ep.live) close(ep, evt.charger);
    },
    intents: () => out.splice(0),
  };
}

// ---------------------------------------------------------------- the world

export class MockWorld implements WorldAdapter {
  readonly mode = "mock" as const;
  private chargers = new Map<string, MockCharger>();
  private events: WorldEvent[] = [];
  private receipt: ReceiptLine[] = [];
  private intents: Intent[] = [];
  private stripe = new Map<string, MockPI>();
  private settle: Settle = { version: "v1", source: SETTLE_V1, author: "shipped", loaded_at: Date.now() };
  private settler: Settler = settlerV1(TARIFF);
  private suite: SuiteReport | null = null;
  private listeners = new Set<(s: Snapshot) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout>[] = [];
  private nextTx = 1001;
  private episodeN: Record<string, number> = {};
  private intentN = 0;
  private seq = 0;
  private suiteRuns = 0;
  private snap: Snapshot | null = null;

  constructor() {
    this.seed();
  }

  // ---- lifecycle

  private seed() {
    const kws = [11, 22, 7.4, 11, 22, 11, 22, 7.4, 11, 22, 11, 7.4];
    for (let i = 1; i <= 12; i++) {
      const id = `CP${String(i).padStart(2, "0")}`;
      this.chargers.set(id, {
        id,
        kw: kws[i - 1],
        link: "up",
        plugged: false,
        meterWh: Math.round(1_000_000 + Math.random() * 9_000_000),
        tx: null,
        queue: [],
        hold: null,
        quirks: defaultQuirks(),
        episode: null,
        ticks: 0,
        idTag: null,
      });
    }
    // Three RFID sessions already running, one charger whose link is down.
    for (const id of ["CP02", "CP05", "CP11"]) {
      const c = this.chargers.get(id)!;
      c.plugged = true;
      c.idTag = "RFID-" + rid("", 6).toUpperCase();
      c.tx = { id: this.nextTx++, meterStart: c.meterWh };
      c.meterWh += Math.round(2000 + Math.random() * 9000);
    }
    const down = this.chargers.get("CP09")!;
    down.link = "cut";
    this.log(null, "world", "World booted · 12 chargers · CSMS ws://csms:9000 · tariff €0.60/kWh", undefined, true);
    this.log("CP09", "link", "link down since boot (proxy refusing sockets)", undefined, true);
    for (const id of ["CP02", "CP05", "CP11"]) {
      const c = this.chargers.get(id)!;
      this.log(id, "ocpp", `StartTransaction {idTag:"${c.idTag}", meterStart:${c.tx!.meterStart}} → {transactionId:${c.tx!.id}}`, "in", true);
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tickWorld(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reset() {
    this.stop();
    for (const t of this.pending) clearTimeout(t);
    this.pending = [];
    this.chargers.clear();
    this.events = [];
    this.receipt = [];
    this.intents = [];
    this.stripe.clear();
    this.settle = { version: "v1", source: SETTLE_V1, author: "shipped", loaded_at: Date.now() };
    this.settler = settlerV1(TARIFF);
    this.suite = null;
    this.nextTx = 1001;
    this.episodeN = {};
    this.intentN = 0;
    this.seed();
    this.start();
    this.emit();
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.pending = this.pending.filter((x) => x !== t);
      fn();
    }, ms);
    this.pending.push(t);
  }

  // ---- snapshot

  snapshot(): Snapshot {
    if (this.snap) return this.snap;
    const chargers: Charger[] = [...this.chargers.values()].map((c) => {
      const wh = c.episode ? c.episode.wh + (c.tx ? c.meterWh - c.tx.meterStart : 0) : c.tx ? c.meterWh - c.tx.meterStart : 0;
      const kwh = Math.max(0, wh) / 1000;
      const cents = Math.round(kwh * TARIFF);
      const base = {
        id: c.id,
        kw: c.kw,
        link: c.link,
        plugged: c.plugged,
        kwh,
        cents: c.hold ? Math.min(cents, c.hold.amount_cents) : cents,
        transaction_id: c.tx?.id ?? null,
        hold: c.hold,
        quirks: { ...c.quirks },
        queued: c.queue.length,
      };
      return { ...base, status: ledFor(base) };
    });
    this.snap = {
      chargers,
      events: this.events.slice(-120),
      receipt: this.receipt,
      intents: this.intents,
      settle: this.settle,
      suite: this.suite,
      sandbox: {
        provider: "mock",
        name: "once-world (in-browser mock)",
        rootfs: "devbox:1",
        egress: ["sinkhole.invalid"],
        keys_inside: [],
        state: "running",
        creates_used: "0 of 10 (mock)",
      },
      tariff_cents_per_kwh: TARIFF,
      connected: true,
    };
    return this.snap;
  }

  subscribe(fn: (s: Snapshot) => void) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    this.snap = null;
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }

  private log(charger: string | null, kind: WorldEvent["kind"], text: string, dir?: WorldEvent["dir"], quiet = false) {
    this.events.push({ id: `e${++this.seq}`, t: Date.now(), charger, kind, text, dir });
    if (this.events.length > 400) this.events = this.events.slice(-300);
    if (!quiet) this.emit();
  }

  private print(line: Omit<ReceiptLine, "id" | "t">) {
    this.receipt.push({ id: `r${++this.seq}`, t: Date.now(), ...line });
    this.emit();
  }

  // ---- OCPP plumbing

  private deliver(c: MockCharger, msg: OcppMsg, dir: WorldEvent["dir"] = "in") {
    const p = msg.payload;
    let text = "";
    switch (msg.action) {
      case "StartTransaction":
        text = `StartTransaction {idTag:"${p.idTag}", meterStart:${p.meterStart}} → {transactionId:${p.transactionId}, idTagInfo:Accepted}`;
        break;
      case "StopTransaction":
        text = `StopTransaction {transactionId:${p.transactionId}, meterStop:${p.meterStop}, reason:"${p.reason}"}`;
        break;
      case "MeterValues":
        text = `MeterValues {transactionId:${p.transactionId}, Energy.Active.Import.Register:${p.wh} Wh}`;
        break;
      case "StatusNotification":
        text = `StatusNotification {connectorId:1, status:"${p.status}"}`;
        break;
      case "BootNotification":
        text = `BootNotification {chargePointModel:"${p.model}", firmwareVersion:"${p.fw}"} → {status:Accepted, interval:30}`;
        break;
    }
    this.log(c.id, "ocpp", dir === "dup" ? `${text}   ← duplicate, 1.2 s after the first` : text, dir, true);
    this.settler.onEvent({ type: "ocpp", charger: c.id, action: msg.action, payload: p });
    this.collectIntents();
    this.emit();
  }

  private send(c: MockCharger, msg: OcppMsg) {
    if (c.link === "up") {
      this.deliver(c, msg);
      return;
    }
    if (c.quirks.queue_offline) {
      c.queue.push(msg);
      const p = msg.payload;
      this.log(c.id, "ocpp", `${msg.action}${p.transactionId ? ` tx ${p.transactionId}` : ""} queued in firmware (offline, ${c.queue.length} waiting)`, "queued");
    } else {
      this.log(c.id, "ocpp", `${msg.action} dropped (offline, queue_offline off)`, "queued");
    }
  }

  private drain(c: MockCharger) {
    const q = c.queue.splice(0);
    if (q.length === 0) return;
    this.log(c.id, "link", `reconnected · resending ${q.length} queued message${q.length === 1 ? "" : "s"}`);
    q.forEach((msg, i) => {
      this.later(220 + i * 180, () => {
        if (c.link !== "up") {
          c.queue.unshift(msg);
          return;
        }
        this.deliver(c, msg);
        if (msg.action === "StopTransaction" && c.quirks.dup_stop) {
          this.later(1200, () => {
            if (c.link === "up") this.deliver(c, msg, "dup");
          });
        }
      });
    });
  }

  private collectIntents() {
    for (const i of this.settler.intents()) {
      if (this.intents.some((x) => x.intent_id === i.intent_id)) continue;
      this.intents.push({ ...i, id: `in_${String(++this.intentN).padStart(5, "0")}`, kind: "capture", created_at: Date.now() });
      this.log(i.charger, "settle", `settle.js ${this.settle.version} → capture intent ${i.intent_id} · ${i.episode_id} · €${(i.amount_cents / 100).toFixed(2)}`, "out", true);
    }
  }

  private tickWorld() {
    let changed = false;
    for (const c of this.chargers.values()) {
      if (!c.plugged || !c.tx || c.link === "rebooting") continue;
      const whPerTick = (c.kw * 1000 * (TICK_MS / 1000) * COMPRESSION) / 3600;
      c.meterWh += Math.round(whPerTick);
      c.ticks++;
      changed = true;
      if (c.ticks % METER_EVERY === 0) {
        this.send(c, { action: "MeterValues", payload: { transactionId: c.tx.id, wh: c.meterWh } });
      }
    }
    if (changed) this.emit();
  }

  // ---- commands

  async cmd(cmd: Command): Promise<void> {
    const c = this.chargers.get(cmd.charger);
    if (!c) throw new Error(`unknown charger ${cmd.charger}`);
    switch (cmd.op) {
      case "plug":
        this.plug(c);
        break;
      case "unplug":
        this.unplug(c);
        break;
      case "cut":
        if (c.link === "cut") return;
        c.link = "cut";
        this.log(c.id, "cmd", "cut · link proxy dropped the socket and refuses new ones");
        break;
      case "restore":
        if (c.link === "up") return;
        c.link = "up";
        this.log(c.id, "cmd", "restore · link proxy accepting sockets");
        this.send(c, { action: "BootNotification", payload: { model: "ONCE-SIM-1", fw: "1.6j-sim.3" } });
        this.drain(c);
        break;
      case "reboot":
        this.reboot(c);
        break;
      case "quirk":
        c.quirks[cmd.quirk] = cmd.on;
        this.log(c.id, "cmd", `quirk ${cmd.quirk} ${cmd.on ? "on" : "off"}`);
        break;
    }
    this.emit();
  }

  private plug(c: MockCharger) {
    if (c.plugged) return;
    c.plugged = true;
    c.ticks = 0;
    c.tx = { id: this.nextTx++, meterStart: c.meterWh };
    if (c.hold && c.hold.status === "uncaptured" && !c.episode) {
      c.episode = { id: c.hold.episode_id!, wh: 0 };
    }
    const idTag = c.hold ? "CARD-" + c.hold.payment_intent.slice(-6) : (c.idTag = "RFID-" + rid("", 6).toUpperCase());
    this.log(c.id, "cmd", "plug · connector 1 Preparing → Charging");
    this.send(c, { action: "StatusNotification", payload: { status: "Charging" } });
    if (c.quirks.stop_without_start) {
      this.log(c.id, "ocpp", `StartTransaction tx ${c.tx.id} lost in firmware (stop_without_start quirk)`, "queued");
    } else {
      this.send(c, { action: "StartTransaction", payload: { idTag, meterStart: c.tx.meterStart, transactionId: c.tx.id } });
    }
  }

  private unplug(c: MockCharger) {
    if (!c.plugged) return;
    c.plugged = false;
    const tx = c.tx;
    c.tx = null;
    this.log(c.id, "cmd", c.link === "up" ? "unplug · cable removed" : "unplug · cable removed while offline");
    if (tx) {
      if (c.episode) c.episode.wh += c.meterWh - tx.meterStart;
      this.send(c, { action: "StopTransaction", payload: { transactionId: tx.id, meterStop: c.meterWh, reason: "EVDisconnected" } });
    }
    this.send(c, { action: "StatusNotification", payload: { status: "Available" } });
  }

  private reboot(c: MockCharger) {
    if (c.link !== "up") return;
    const hadTx = c.tx;
    c.link = "rebooting";
    this.log(c.id, "cmd", "reboot · firmware restarting (2.5 s)");
    this.emit();
    this.later(2500, () => {
      c.link = "up";
      if (c.quirks.meter_reset_on_reboot) {
        this.log(c.id, "ocpp", `energy register reset ${c.meterWh} → 0 Wh (meter_reset_on_reboot)`, "queued");
        if (c.episode && hadTx) c.episode.wh += c.meterWh - hadTx.meterStart;
        c.meterWh = 0;
        if (c.tx) c.tx = { ...c.tx, meterStart: 0 };
      }
      this.send(c, { action: "BootNotification", payload: { model: "ONCE-SIM-1", fw: "1.6j-sim.3" } });
      if (c.plugged && hadTx && c.quirks.reboot_restart) {
        // The firmware ends the old transaction and starts a new one for the same plug-in.
        if (c.episode && !c.quirks.meter_reset_on_reboot) c.episode.wh += c.meterWh - hadTx.meterStart;
        this.send(c, {
          action: "StopTransaction",
          payload: { transactionId: hadTx.id, meterStop: c.quirks.meter_reset_on_reboot ? hadTx.meterStart : c.meterWh, reason: "PowerLoss" },
        });
        c.tx = { id: this.nextTx++, meterStart: c.meterWh };
        const idTag = c.hold ? "CARD-" + c.hold.payment_intent.slice(-6) : c.idTag ?? "RFID-LOCAL";
        this.later(400, () => {
          if (c.tx) this.send(c, { action: "StartTransaction", payload: { idTag, meterStart: c.tx.meterStart, transactionId: c.tx.id } });
          this.emit();
        });
      }
      this.emit();
    });
  }

  // ---- Stripe stand-in

  async checkout(charger: string): Promise<CheckoutStart> {
    const c = this.chargers.get(charger);
    if (!c) throw new Error("unknown charger");
    await sleep(350);
    return { mode: "mock", session_id: rid("cs_test_", 24) };
  }

  async mockPay(charger: string): Promise<{ payment_intent: string }> {
    const c = this.chargers.get(charger)!;
    await sleep(900);
    const pi = rid("pi_3", 24);
    const session = rid("cs_test_", 24);
    this.stripe.set(pi, { id: pi, amount: HOLD, captured: null, status: "requires_capture", charger, session, created: Date.now() });
    this.log(charger, "stripe", `Checkout Session paid · PaymentIntent ${pi} · €50.00 · capture_method manual · status requires_capture`, "in", true);
    return this.bindHold(c, pi, session);
  }

  private bindHold(c: MockCharger, pi: string, session: string) {
    const episode_id = `${c.id}-E${(this.episodeN[c.id] = (this.episodeN[c.id] ?? 0) + 1)}`;
    c.hold = { payment_intent: pi, checkout_session: session, amount_cents: HOLD, status: "uncaptured", episode_id };
    c.episode = null;
    this.log(c.id, "world", `POST /hold · ${pi} bound to the next episode on ${c.id} (${episode_id})`, "in", true);
    this.settler.onEvent({ type: "hold", charger: c.id, payment_intent: pi, amount_cents: HOLD, episode_id });
    this.print({ kind: "hold", charger: c.id, amount_cents: HOLD, payment_intent: pi, stripe_url: stripeUrl(pi), text: `HOLD €50.00 on ${c.id}` });
    this.plug(c);
    return { payment_intent: pi };
  }

  async confirmCheckout(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "mock mode has no Stripe session to confirm" };
  }

  async tick(): Promise<void> {
    const pending = this.intents.filter((i) => !i.result);
    if (pending.length === 0) return;
    for (const intent of pending) {
      await sleep(400);
      const pi = this.stripe.get(intent.payment_intent);
      const c = this.chargers.get(intent.charger);
      if (!pi) {
        intent.result = { ok: false, status: "error", error: "No such payment_intent" };
        continue;
      }
      if (pi.status === "requires_capture") {
        pi.status = "succeeded";
        pi.captured = intent.amount_cents;
        intent.result = { ok: true, status: "succeeded", stripe_object: pi.id };
        if (c?.hold) {
          c.hold.status = "captured";
          c.hold.captured_cents = intent.amount_cents;
        }
        this.log(intent.charger, "stripe", `capture ${pi.id} amount_to_capture=${intent.amount_cents} idempotency_key=once-cap-${intent.episode_id}-… → succeeded`, "in", true);
        this.print({
          kind: "capture",
          charger: intent.charger,
          amount_cents: intent.amount_cents,
          payment_intent: pi.id,
          stripe_url: stripeUrl(pi.id),
          text: `CAPTURE €${(intent.amount_cents / 100).toFixed(2)}`,
        });
        await sleep(350);
        this.print({
          kind: "released",
          charger: intent.charger,
          amount_cents: pi.amount - intent.amount_cents,
          payment_intent: pi.id,
          stripe_url: stripeUrl(pi.id),
          text: `RELEASED €${((pi.amount - intent.amount_cents) / 100).toFixed(2)}`,
        });
      } else {
        const msg = "This PaymentIntent could not be captured: the remainder of the authorized amount has been released.";
        intent.result = { ok: false, status: "refused", error: msg, stripe_object: pi.id };
        this.log(intent.charger, "stripe", `capture ${pi.id} amount_to_capture=${intent.amount_cents} → 400 invalid_request_error: ${msg}`, "in", true);
        this.print({
          kind: "refused",
          charger: intent.charger,
          amount_cents: intent.amount_cents,
          payment_intent: pi.id,
          stripe_url: stripeUrl(pi.id),
          text: `REFUSED: ${msg}`,
        });
      }
    }
    this.emit();
  }

  // ---- suite and agent

  private loadSettle(version: "v1" | "v2", author: Settle["author"]) {
    this.settle = { version, source: version === "v1" ? SETTLE_V1 : SETTLE_V2, author, loaded_at: Date.now() };
    this.settler = version === "v1" ? settlerV1(TARIFF) : settlerV2(TARIFF);
    // The world replays live holds and open transactions into a fresh settler.
    for (const c of this.chargers.values()) {
      if (c.hold && c.hold.status === "uncaptured") {
        this.settler.onEvent({ type: "hold", charger: c.id, payment_intent: c.hold.payment_intent, amount_cents: c.hold.amount_cents, episode_id: c.hold.episode_id });
        if (c.tx) this.settler.onEvent({ type: "ocpp", charger: c.id, action: "StartTransaction", payload: { transactionId: c.tx.id, meterStart: c.tx.meterStart } });
      }
    }
    this.log(null, "world", `PUT /settle · ${version} loaded fresh (node:vm, no fs, no net)`);
  }

  async *runSuite(): AsyncIterable<AgentEvent> {
    const version = this.settle.version as "v1" | "v2";
    yield { type: "status", text: `Running 30 seeded storms against settle.js ${version} inside the sandbox` };
    const scenarios = mockScenarios(version, 30, 1);
    this.suiteRuns++;
    for (let i = 0; i < scenarios.length; i++) {
      await sleep(85);
      yield { type: "scenario", scenario: scenarios[i], index: i, count: scenarios.length };
    }
    const t = totals(scenarios);
    const summary = `${t.ok}/30 ok · double ${t.double} · stranded ${t.stranded} · unbilled ${t.unbilled} · overbilled ${t.overbilled}`;
    const report: SuiteReport = { version, ran_at: Date.now(), summary, scenarios, totals: t };
    this.suite = report;
    this.log(null, "world", `POST /suite · ${version} · ${summary}`);
    yield { type: "suite", report, phase: "attempt" };
  }

  async *fix(): AsyncIterable<AgentEvent> {
    const failing = this.suite && this.suite.version === this.settle.version ? this.suite : null;
    yield { type: "attempt", n: 1, of: 3 };
    yield { type: "model", name: "claude-sonnet-4-5", provider: "mock replay" };
    if (!failing) {
      yield { type: "status", text: "No storm report yet · running the suite first" };
      for await (const e of this.runSuite()) yield e;
    }
    const report = this.suite ?? emptyReport(this.settle.version);
    const red = report.scenarios.filter((s) => !s.ok).length;
    await sleep(500);
    yield { type: "status", text: `Reading the storm report · ${red} of ${report.scenarios.length} scenarios red (double ${report.totals.double}, stranded ${report.totals.stranded}, unbilled ${report.totals.unbilled})` };
    await sleep(600);
    yield { type: "status", text: `Reading settle.js ${this.settle.version} · ${this.settle.source.split("\n").length} lines · and the world's settle interface` };
    await sleep(500);
    const thoughts = [
      "26 of 30 scenarios are red and 43 of the failures are doubles. v1 keys the ledger by transactionId, so a reboot that splits one plug-in into two transactions produces two capture intents against one PaymentIntent; a lost StartTransaction leaves the hold stranded.",
      "Stripe allows one capture per authorization; the second attempt is refused and the money for the second half is lost, or the hold strands when the Start was never seen.",
      "The unit of money is the plug-in episode, not the OCPP transaction. Key the ledger by the episode bound at /hold; accumulate energy across transactions; dedupe Stops by (charger, transactionId, meterStop); keep MeterValues as a monotone lower bound so a lost Start still bills.",
      "Close the episode once: on a Stop whose reason is not PowerLoss or Reboot, or when the connector returns to Available with no live transaction. Amount = energy × tariff, capped at the hold. The intent id is the episode id, so the host's idempotency key is stable.",
    ];
    for (const t of thoughts) {
      yield { type: "thinking", text: t };
      await sleep(900);
    }
    yield { type: "status", text: "Writing settle.js v2 · episode ledger" };
    await sleep(700);
    yield { type: "diff", old: this.settle.source, new: SETTLE_V2, version: "v2" };
    await sleep(900);
    this.loadSettle("v2", "agent");
    yield { type: "uploaded", version: "v2" };
    yield { type: "status", text: "PUT /settle → v2 loaded · validated in node:vm" };
    await sleep(400);
    for await (const e of this.runSuite()) yield e;
    const ok = this.suite?.totals.ok === 30;
    yield { type: "done", ok, version: "v2", attempts: 1, reason: ok ? `attempt 1 passes all 30 scenarios; deployed as v2 (${this.suite?.summary ?? ""})` : "attempt 1 is still red" };
    this.emit();
  }

  async proof(): Promise<Proof> {
    const captures: Capture[] = [...this.stripe.values()]
      .sort((a, b) => b.created - a.created)
      .flatMap((pi): Capture[] => {
        const related = this.intents.filter((i) => i.payment_intent === pi.id);
        if (related.length === 0) {
          return [
            {
              payment_intent: pi.id,
              charger: pi.charger,
              episode_id: this.chargers.get(pi.charger)?.hold?.episode_id ?? "",
              amount_cents: 0,
              authorized_cents: pi.amount,
              status: "requires_capture" as const,
              idempotency_key: "",
              t: pi.created,
              error: undefined,
              url: stripeUrl(pi.id),
            },
          ];
        }
        return related.map((i) => ({
          payment_intent: pi.id,
          charger: i.charger,
          episode_id: i.episode_id,
          amount_cents: i.amount_cents,
          authorized_cents: pi.amount,
          status: (!i.result ? "requires_capture" : i.result.ok ? "succeeded" : "refused") as "succeeded" | "requires_capture" | "refused",
          idempotency_key: i.intent_id,
          t: pi.created,
          error: i.result?.error,
          url: stripeUrl(pi.id),
        }));
      });
    return { captures, suite: this.suite, sandbox: this.snapshot().sandbox, settle: this.settle };
  }
}
