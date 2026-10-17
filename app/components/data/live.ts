// The live adapter: the host API routes (app/app/api/**) in front of the
// CreateOS sandbox and Stripe. Shapes follow world/README.md (GET /state,
// /intents, /suite, /events) and app/lib (proof, agent events). Field access
// stays tolerant so a renamed field degrades to a blank, not a crash.

import type { AgentRun, DriverCharge, DriverHold, DriverLedger, NextHold, ProbeReport, ProofWithDrivers, WorldAdapter } from "./adapter";
import { chargeStory, holdStory, totals } from "./adapter";
import type {
  AgentEvent,
  Charger,
  CheckoutStart,
  Command,
  Hold,
  Intent,
  Quirk,
  ReceiptLine,
  Scenario,
  Settle,
  Snapshot,
  StripeHold,
  SuiteReport,
  WorldEvent,
} from "./types";
import { QUIRKS, euro, ledFor, stripeUrl } from "./types";

type J = Record<string, unknown>;
const obj = (x: unknown): J => (x && typeof x === "object" && !Array.isArray(x) ? (x as J) : {});
const str = (x: unknown, d = ""): string => (x == null ? d : String(x));
const num = (x: unknown, d = 0): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const when = (x: unknown): number => {
  if (typeof x === "number") return x > 1e12 ? x : x * 1000;
  const t = Date.parse(str(x));
  return Number.isFinite(t) ? t : 0;
};
const vtag = (v: unknown, d = "v1"): string => {
  const s = str(v);
  if (!s) return d;
  return /^\d+$/.test(s) ? `v${s}` : s;
};

/** Drop the test-sandbox preamble Stripe prepends to errors; the rest is Stripe's words, untouched. */
function stripeMsg(m: string): string {
  return m.replace(/^This is an unclaimed Stripe sandbox.[^.]*.s*/, "");
}

async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init?.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) }, body, cache: "no-store" });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* text */
  }
  if (!res.ok) {
    const o = obj(data);
    throw new Error(str(o.error ?? o.message ?? text ?? `HTTP ${res.status}`));
  }
  return data as T;
}

// ------------------------------------------------------------ normalisers

function normQuirks(raw: unknown): Record<Quirk, boolean> {
  const o = obj(raw);
  const out = {} as Record<Quirk, boolean>;
  for (const q of QUIRKS) out[q.id] = Boolean(o[q.id]);
  return out;
}

/** A world hold (GET /state .holds[]) → the UI's Hold. */
function normHold(raw: unknown): Hold | null {
  const h = obj(raw);
  const pi = str(h.payment_intent);
  if (!pi) return null;
  const s = str(h.status).toLowerCase();
  const results = arr(h.results).map(obj);
  const captured = results.find((r) => r.ok && str(r.kind, "capture") === "capture");
  const refused = results.find((r) => !r.ok);
  let status: Hold["status"] = "uncaptured";
  if (s === "succeeded" || captured) status = "captured";
  else if (s === "canceled") status = "released";
  else if (refused) status = "refused";
  return {
    payment_intent: pi,
    amount_cents: num(h.amount_cents, 5000),
    captured_cents: num(h.amount_captured, captured ? num(captured.amount_cents) : 0) || undefined,
    status,
    episode_id: str(h.episode_id) || undefined,
  };
}

function normCharger(raw: unknown, holds: J[], tariff: number): Charger {
  const c = obj(raw);
  const id = str(c.id);
  const status = str(c.status);
  const link: Charger["link"] = str(c.link) === "cut" ? "cut" : c.power === false || status === "Unavailable" ? "rebooting" : "up";
  const ep = obj(c.episode);
  const tx = obj(c.transaction);
  const mine = holds.filter((h) => str(h.charger) === id);
  // The hold of the current episode, else the one waiting for the next plug-in, else the last settled one.
  const holdRaw =
    (ep.id ? mine.find((h) => str(h.episode_id) === str(ep.id)) : undefined) ??
    (c.next_hold ? obj(c.next_hold) : undefined) ??
    mine.find((h) => str(h.status) === "requires_capture") ??
    mine[mine.length - 1];
  const hold = normHold(holdRaw);
  const wh = num(ep.energy_wh, num(tx.energy_wh, 0));
  const kwh = wh / 1000;
  const cents = ep.cost_cents != null ? num(ep.cost_cents) : Math.round(kwh * tariff);
  const base = {
    id,
    kw: num(obj(c.car).power_kw, 11),
    link,
    plugged: Boolean(c.plugged),
    kwh,
    cents: hold ? Math.min(cents, hold.amount_cents) : cents,
    transaction_id: tx.transaction_id != null ? num(tx.transaction_id) : null,
    hold,
    quirks: normQuirks(c.quirks),
    queued: num(c.queue_len, arr(c.queue).length),
  };
  return { ...base, status: ledFor(base) };
}

function normIntent(raw: unknown): Intent {
  const i = obj(raw);
  const r = i.result != null ? obj(i.result) : null;
  const err = r?.error;
  return {
    id: str(i.id) || undefined,
    intent_id: str(i.intent_id ?? i.id),
    episode_id: str(i.episode_id),
    charger: str(i.charger),
    payment_intent: str(i.payment_intent),
    amount_cents: num(i.amount_cents),
    kind: str(i.kind) === "release" ? "release" : "capture",
    created_at: when(i.created_at),
    result: r
      ? {
          ok: Boolean(r.ok),
          status: str(r.status, "error"),
          error: err == null ? undefined : typeof err === "string" ? err : str(obj(err).message ?? JSON.stringify(err)),
          stripe_object: typeof r.stripe_object === "string" ? r.stripe_object : str(obj(r.stripe_object).id) || undefined,
        }
      : undefined,
  };
}

const compact = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  return JSON.stringify(v).replace(/"([A-Za-z_]+)":/g, "$1:").slice(0, 160);
};

function energyOf(payload: J): string {
  const mv = arr(payload.meterValue)[0];
  const sv = arr(obj(mv).sampledValue).map(obj).find((s) => !s.measurand || s.measurand === "Energy.Active.Import.Register");
  return sv ? `${str(sv.value)} Wh` : "";
}

/** One world event (GET /events) → a wire-log line. Returns null for lines not worth showing. */
function normEvent(raw: unknown): WorldEvent | null {
  const e = obj(raw);
  const type = str(e.type);
  const charger = e.charger == null ? null : str(e.charger);
  const base = { id: `s${str(e.seq)}`, t: when(e.at), charger };
  switch (type) {
    case "tick":
    case "settler_log":
      return null;
    case "ocpp": {
      const action = str(e.action);
      const p = obj(e.payload);
      const r = obj(e.response);
      if (action === "Heartbeat") return null;
      let text = `${action} ${compact(p)}`;
      if (action === "StartTransaction") text = `StartTransaction {idTag:"${str(p.idTag)}", meterStart:${str(p.meterStart)}} → {transactionId:${str(r.transactionId)}, ${str(obj(r.idTagInfo).status, "Accepted")}}`;
      if (action === "StopTransaction") text = `StopTransaction {transactionId:${str(p.transactionId)}, meterStop:${str(p.meterStop)}, reason:"${str(p.reason)}"}`;
      if (action === "MeterValues") text = `MeterValues {transactionId:${str(p.transactionId)}, Energy.Active.Import.Register:${energyOf(p)}}`;
      if (action === "StatusNotification") text = `StatusNotification {connectorId:${str(p.connectorId)}, status:"${str(p.status)}"}`;
      if (action === "BootNotification") text = `BootNotification {model:"${str(p.chargePointModel)}", firmware:"${str(p.firmwareVersion)}"} → {${str(r.status, "Accepted")}}`;
      if (action === "Authorize") text = `Authorize {idTag:"${str(p.idTag)}"} → ${str(obj(r.idTagInfo).status, "Accepted")}`;
      return { ...base, kind: "ocpp", dir: "in", text };
    }
    case "link":
      return { ...base, kind: "link", text: `socket ${str(e.state)} at the CSMS` };
    case "hold":
      return { ...base, kind: "world", dir: "in", text: `POST /hold · ${str(e.payment_intent)} · ${euro(num(e.amount_cents))} bound to the next plug-in` };
    case "intent_result": {
      const ok = Boolean(e.ok);
      const err = e.error;
      const msg = err == null ? "" : typeof err === "string" ? err : str(obj(err).message);
      return {
        ...base,
        kind: "stripe",
        dir: "in",
        text: ok
          ? `${str(e.kind, "capture")} ${str(e.payment_intent)} ${euro(num(e.amount_cents))} → ${str(e.status)}`
          : `${str(e.kind, "capture")} ${str(e.payment_intent)} ${euro(num(e.amount_cents))} → refused: ${stripeMsg(msg) || str(e.status)}`,
      };
    }
    case "cmd": {
      const op = str(e.op);
      const extra =
        op === "plug" ? ` · ${str(e.episode_id)}${e.payment_intent ? ` · ${str(e.payment_intent)}` : ""} · ${str(e.power_kw, "11")} kW` : op === "unplug" ? ` · ${num(e.energy_wh)} Wh${e.offline ? " · while offline" : ""}` : op === "quirk" ? ` ${str(e.quirk)} ${e.on === false ? "off" : "on"}` : "";
      return { ...base, kind: "cmd", text: `${op}${extra}` };
    }
    case "charger": {
      const kind = str(e.kind);
      const act = str(e.ocpp_action);
      const q = e.queue != null ? ` (${str(e.queue)} waiting)` : "";
      if (kind === "queued") return { ...base, kind: "ocpp", dir: "queued", text: `${act} queued in firmware (offline)${q}` };
      if (kind === "dropped") return { ...base, kind: "ocpp", dir: "queued", text: `${act} dropped (offline, queue_offline off)` };
      if (kind === "duplicate") return { ...base, kind: "ocpp", dir: "dup", text: `${act} delivered again, 1.2 s after the first (dup_stop)` };
      if (kind === "online" || kind === "offline") return { ...base, kind: "link", text: kind === "online" ? "reconnected to the CSMS" : "lost the CSMS" };
      if (kind === "boot") return { ...base, kind: "link", text: "firmware booted" };
      if (kind === "reboot") return { ...base, kind: "cmd", text: "rebooting (link down, no energy flows)" };
      if (kind === "meter-reset") return { ...base, kind: "ocpp", dir: "queued", text: "energy register reset to 0 Wh (meter_reset_on_reboot)" };
      if (kind === "start-lost") return { ...base, kind: "ocpp", dir: "queued", text: "StartTransaction lost in firmware (stop_without_start)" };
      if (kind === "rejected") return { ...base, kind: "ocpp", dir: "queued", text: `${act} rejected by the CSMS${e.why ? `: ${str(e.why)}` : ""}` };
      return { ...base, kind: "world", text: `${kind}${act ? ` ${act}` : ""}${e.why ? ` · ${str(e.why)}` : ""}` };
    }
    case "intent": {
      const i = obj(e.intent);
      return { ...base, charger: str(i.charger) || charger, kind: "settle", dir: "out", text: `settle.js v${str(i.settle_version)} → ${str(i.kind, "capture")} intent ${str(i.intent_id)} · ${str(i.episode_id)} · ${euro(num(i.amount_cents))}` };
    }
    case "settle":
      return { ...base, kind: "world", text: `PUT /settle · v${str(e.version)} loaded fresh (node:vm)${e.replayed ? " · replayed over the event history" : ""}` };
    case "settler_error":
      return { ...base, kind: "world", text: `settle.js v${str(e.version)} threw: ${str(e.error)}` };
    case "suite":
      return { ...base, kind: "world", text: `POST /suite · v${str(e.settle_version)} · ${str(e.summary)}` };
    case "violation":
      return { ...base, kind: "world", text: `OCPP schema violation: ${compact(e)}` };
    default:
      return { ...base, kind: "world", text: `${type} ${compact(e)}` };
  }
}

function normScenario(raw: unknown): Scenario {
  const s = obj(raw);
  const faults = arr(s.faults).map((f) => (typeof f === "string" ? f : str(obj(f).type ?? obj(f).op ?? obj(f).kind)));
  const double = num(s.double);
  const stranded = num(s.stranded);
  const unbilled = num(s.unbilled);
  const overbilled = num(s.overbilled);
  const underbilled = num(s.underbilled);
  return {
    seed: num(s.seed),
    name: str(s.name) || undefined,
    faults,
    chargers: arr(s.chargers).map(String),
    double,
    stranded,
    unbilled,
    overbilled,
    underbilled,
    ok: Boolean(s.ok ?? double + stranded + unbilled + overbilled + underbilled === 0),
    notes: arr(s.notes).map(String),
  };
}

export function normSuite(raw: unknown, fallbackVersion = ""): SuiteReport | null {
  if (!raw) return null;
  const r = obj(raw);
  const scenarios = arr(r.scenarios).map(normScenario);
  if (scenarios.length === 0) return null;
  return {
    version: vtag(r.version ?? r.settle_version, fallbackVersion || "v1"),
    ran_at: when(r.ran_at ?? r.at) || Date.now(),
    summary: str(r.summary) || undefined,
    scenarios,
    totals: totals(scenarios),
  };
}

function normSettle(raw: unknown, prev?: Settle): Settle | null {
  const s = obj(raw);
  const version = s.version != null ? vtag(s.version) : "";
  if (!version) return null;
  const source = str(s.source) || (prev && prev.version === version ? prev.source : "");
  const name = str(s.name);
  // The world's version counter keeps counting across resets, so the name decides.
  const shipped = /naive/i.test(name) || (!name && num(s.version, 1) <= 1);
  return {
    version,
    source,
    author: shipped ? "shipped" : "agent",
    loaded_at: when(s.loaded_at),
    name: name || undefined,
  };
}

/** The receipt derives from the world's holds and their results, in time order. */
function buildReceipt(holds: J[], intents: Intent[]): ReceiptLine[] {
  const lines: ReceiptLine[] = [];
  const byWorldId = new Map(intents.map((i) => [i.id ?? i.intent_id, i]));
  for (const h of holds) {
    const pi = str(h.payment_intent);
    if (!pi) continue;
    const charger = str(h.charger);
    const auth = num(h.amount_cents, 5000);
    const placed = when(h.placed_at);
    lines.push({ id: `hold-${pi}`, t: placed, kind: "hold", charger, amount_cents: auth, payment_intent: pi, stripe_url: stripeUrl(pi), text: `HOLD ${euro(auth)} on ${charger}` });
    arr(h.results)
      .map(obj)
      .forEach((r, k) => {
        const i = byWorldId.get(str(r.intent));
        const t = (i?.created_at || placed) + k * 2 + 1;
        const amt = num(r.amount_cents);
        const kind = str(r.kind, "capture");
        if (r.ok && kind === "capture") {
          lines.push({ id: `cap-${pi}-${k}`, t, kind: "capture", charger, amount_cents: amt, payment_intent: pi, stripe_url: stripeUrl(pi), text: `CAPTURE ${euro(amt)}` });
          const rel = num(h.amount_released, auth - amt);
          if (rel > 0) lines.push({ id: `rel-${pi}-${k}`, t: t + 1, kind: "released", charger, amount_cents: rel, payment_intent: pi, stripe_url: stripeUrl(pi), text: `RELEASED ${euro(rel)}` });
        } else if (r.ok && kind === "release") {
          lines.push({ id: `rel-${pi}-${k}`, t, kind: "released", charger, amount_cents: auth, payment_intent: pi, stripe_url: stripeUrl(pi), text: `RELEASED ${euro(auth)} (no energy)` });
        } else {
          const err = r.error;
          const msg = err == null ? str(r.status, "refused") : typeof err === "string" ? err : str(obj(err).message ?? JSON.stringify(err));
          lines.push({ id: `ref-${pi}-${k}`, t, kind: "refused", charger, amount_cents: amt, payment_intent: pi, stripe_url: stripeUrl(pi), text: `REFUSED: ${stripeMsg(msg)}` });
        }
      });
  }
  return lines.sort((a, b) => a.t - b.t);
}

/** World holds and intents (GET /state) -> holds per driver and attributed charges. */
function driverLedger(holds: J[], intents: J[]): DriverLedger {
  const holdByPi = new Map(holds.map((h) => [str(h.payment_intent), h]));
  const charges: DriverCharge[] = intents
    .filter((i) => !["rejected", "suppressed"].includes(str(i.status)))
    .map((i) => {
      const r = i.result != null ? obj(i.result) : null;
      const kind = str(i.kind, "capture");
      const e = r?.error;
      const error = e == null ? undefined : stripeMsg(typeof e === "string" ? e : str(obj(e).message ?? JSON.stringify(e)));
      const status: DriverCharge["status"] = !r ? "pending" : r.ok ? (kind === "release" ? "released" : "succeeded") : "refused";
      const pi = str(i.payment_intent);
      const c = {
        id: str(i.id),
        charger: str(i.charger),
        payment_intent: pi,
        driver: str(i.driver) || str(holdByPi.get(pi)?.driver) || null,
        energy_driver: str(i.energy_driver) || null,
        energy_episode_id: str(i.energy_episode_id) || null,
        amount_cents: num(i.amount_cents),
        status,
        wrong_driver: typeof i.wrong_driver === "boolean" ? i.wrong_driver : null,
        error,
        url: stripeUrl(pi),
        t: when(i.created_at),
      };
      return { ...c, story: chargeStory(c) };
    });
  return { holds: holds.map(normDriverHold), charges };
}

function normDriverHold(raw: unknown): DriverHold {
  const h = obj(raw);
  const s = str(h.status).toLowerCase();
  const cf = h.captured_for ? obj(h.captured_for) : null;
  const pi = str(h.payment_intent);
  const base = {
    driver: str(h.driver) || null,
    seq: h.seq != null ? num(h.seq) : null,
    charger: str(h.charger),
    payment_intent: pi,
    episode_id: str(h.episode_id) || null,
    amount_cents: num(h.amount_cents ?? h.amount_authorized, 5000),
    captured_cents: num(h.amount_captured ?? h.amount_received),
    status: (s === "succeeded" ? "captured" : s === "canceled" ? "released" : "uncaptured") as DriverHold["status"],
    stranded: Boolean(h.stranded),
    charged_for_driver: str(cf?.driver ?? h.charged_for_driver) || null,
    wrong_driver: typeof (cf?.wrong_driver ?? h.wrong_driver) === "boolean" ? Boolean(cf?.wrong_driver ?? h.wrong_driver) : null,
    url: str(h.dashboard_url) || stripeUrl(pi),
  };
  return { ...base, story: holdStory(base) };
}

// ------------------------------------------------------------ the adapter

export class LiveWorld implements WorldAdapter {
  readonly mode = "live" as const;
  private snap: Snapshot;
  private listeners = new Set<(s: Snapshot) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  private ticking = false;
  private settle: Settle = { version: "v1", source: "", author: "shipped", loaded_at: 0 };
  private suite: SuiteReport | null = null;
  private tariff = 60;
  private failures = 0;
  private lastSuiteCheck = 0;

  constructor() {
    this.snap = {
      chargers: [],
      events: [],
      receipt: [],
      intents: [],
      settle: this.settle,
      suite: null,
      sandbox: { provider: "CreateOS", name: "once-world", rootfs: "devbox:1", egress: ["sinkhole.invalid"], keys_inside: [], state: "absent" },
      tariff_cents_per_kwh: this.tariff,
      connected: false,
    };
  }

  snapshot() {
    return this.snap;
  }

  subscribe(fn: (s: Snapshot) => void) {
    this.listeners.add(fn);
    fn(this.snap);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }

  start() {
    if (this.timer) return;
    void this.ensure();
    this.timer = setInterval(() => void this.poll(), 1000);
    void this.poll();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async ensure() {
    try {
      const r = obj(await api("/api/world/ensure", { method: "POST", json: {} }));
      const sb = obj(r.sandbox);
      const local = str(r.mode) === "local";
      this.emit({
        sandbox: {
          provider: local ? "local" : "CreateOS",
          name: local ? "local world (WORLD_URL)" : str(sb.name, "once-world"),
          rootfs: local ? "host node" : "devbox:1",
          egress: local ? [] : arr(sb.egress).map(String).length ? arr(sb.egress).map(String) : ["sinkhole.invalid"],
          keys_inside: [],
          state: local ? "running" : ((str(sb.status, "running") as "running" | "paused" | "absent") || "running"),
          preview: str(r.url) || undefined,
          creates_used: r.creates_used_24h !== undefined ? `${str(r.creates_used_24h)}/${str(r.creates_limit_24h)} in 24 h` : undefined,
        },
      });
      await this.loadSettle();
    } catch (e) {
      this.emit({ error: (e as Error).message });
    }
  }

  private async loadSettle() {
    try {
      const s = normSettle(await api("/api/world/settle"), this.settle);
      if (s) {
        this.settle = s;
        this.emit({ settle: s });
      }
    } catch {
      /* the next poll retries */
    }
  }

  private async poll() {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const w = obj(await api("/api/world/state?events=120"));
      this.tariff = num(w.tariff_cents_per_kwh, this.tariff) || this.tariff;
      const holds = arr(w.holds).map(obj);
      const intents = arr(w.intents).map(normIntent);
      const chargers = arr(w.chargers)
        .map((c) => normCharger(c, holds, this.tariff))
        .filter((c) => c.id);
      const events = arr(w.events)
        .map(normEvent)
        .filter((e): e is WorldEvent => e !== null);
      const sv = vtag(obj(w.settle).version, this.settle.version);
      if (sv !== this.settle.version || !this.settle.source) {
        this.settle = { ...(normSettle(w.settle, this.settle) ?? this.settle), source: sv === this.settle.version ? this.settle.source : "" };
        void this.loadSettle();
      }
      this.failures = 0;
      this.emit({
        chargers,
        events,
        intents,
        receipt: buildReceipt(holds, intents),
        settle: this.settle,
        suite: this.suite,
        tariff_cents_per_kwh: this.tariff,
        connected: true,
        error: undefined,
      });
      if (!this.suite && Date.now() - this.lastSuiteCheck > 15000) {
        this.lastSuiteCheck = Date.now();
        void this.loadLastSuite();
      }
      // The settlement tick: idempotent on the host, once a second while the board is open.
      if (!this.ticking && intents.some((i) => !i.result)) void this.tick();
    } catch (e) {
      this.failures++;
      if (this.failures > 2) this.emit({ connected: false, error: (e as Error).message });
    } finally {
      this.inflight = false;
    }
  }

  private async loadLastSuite() {
    try {
      const p = obj(await api("/api/proof?verify=0"));
      const s = normSuite(p.suite, this.settle.version);
      if (s) {
        this.suite = s;
        this.emit({ suite: s });
      }
    } catch {
      /* fine */
    }
  }

  async cmd(c: Command): Promise<void> {
    await api("/api/world/cmd", { method: "POST", json: c });
    void this.poll();
  }

  async checkout(charger: string): Promise<CheckoutStart> {
    const r = obj(await api("/api/checkout", { method: "POST", json: { charger } }));
    const url = str(r.url);
    if (!url) throw new Error("Checkout did not return a URL");
    return { mode: "redirect", url, session_id: str(r.id) || undefined };
  }

  async confirmCheckout(sessionId: string) {
    try {
      const r = obj(await api(`/api/checkout/confirm?session_id=${encodeURIComponent(sessionId)}`));
      const pi = obj(r.payment_intent);
      const ok = Boolean(r.hold) && !r.hold_error;
      const status = str(pi.status);
      return {
        ok,
        charger: str(r.charger) || undefined,
        payment_intent: str(pi.id) || undefined,
        error: ok ? undefined : str(r.hold_error) || (status ? `PaymentIntent is ${status}, not requires_capture` : `session ${str(obj(r.session).status, "incomplete")}`),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await api("/api/settle/tick", { method: "POST", json: {} });
      void this.poll();
    } catch {
      /* the next poll retries */
    } finally {
      this.ticking = false;
    }
  }

  /** Read an NDJSON stream of host AgentEvents. */
  private async *ndjson(path: string, body: unknown): AsyncIterable<AgentEvent> {
    let res: Response;
    try {
      res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    } catch (e) {
      yield { type: "error", text: (e as Error).message };
      return;
    }
    if (!res.ok || !res.body) {
      let msg = `the host answered ${res.status}`;
      try {
        msg = str(obj(JSON.parse(await res.text())).error, msg);
      } catch {
        /* keep */
      }
      yield { type: "error", text: msg };
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let count = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: J;
        try {
          msg = obj(JSON.parse(line));
        } catch {
          yield { type: "status", text: line };
          continue;
        }
        const ev = this.normAgent(msg, count++);
        if (!ev) continue;
        if (ev.type === "suite" && ev.phase !== "baseline") {
          this.suite = ev.report;
          this.emit({ suite: ev.report });
        }
        if (ev.type === "diff") this.settle = { version: ev.version, source: ev.new, author: "agent", loaded_at: Date.now() };
        if (ev.type === "uploaded") this.settle = { ...this.settle, version: ev.version, author: "agent", loaded_at: Date.now() };
        if (ev.type === "done") {
          if (ev.version) this.settle = { ...this.settle, version: ev.version };
          void this.loadSettle();
        }
        yield ev;
      }
    }
    void this.poll();
  }

  private normAgent(m: J, i: number): AgentEvent | null {
    const type = str(m.type).toLowerCase();
    const text = str(m.text ?? m.message);
    switch (type) {
      case "attempt":
        return { type: "attempt", n: num(m.n, 1), of: num(m.of, 3) };
      case "model":
        return { type: "model", name: str(m.name ?? m.model), provider: str(m.provider, "OpenRouter") };
      case "fallback":
        return { type: "status", text: `model ${str(m.model)} failed (${str(m.error)}); trying the next one` };
      case "reasoning":
      case "thinking":
        return text ? { type: "thinking", text } : null;
      case "delta":
        return text ? { type: "delta", text } : null;
      case "diff":
        return { type: "diff", old: str(m.old), new: str(m.new), version: vtag(m.version, this.settle.version) };
      case "uploaded":
        return { type: "uploaded", version: vtag(m.version, this.settle.version) };
      case "scenario":
        return { type: "scenario", scenario: normScenario(m.scenario ?? m), index: num(m.index, i), count: num(m.count, 30) };
      case "suite": {
        const report = normSuite(m.report ?? m, this.settle.version);
        const phase = str(m.phase) as "baseline" | "attempt" | "deployed" | "";
        return report ? { type: "suite", report, phase: phase || undefined } : { type: "status", text: text || "suite finished" };
      }
      case "done":
        return { type: "done", ok: Boolean(m.ok), version: vtag(m.version, this.settle.version), attempts: num(m.attempts, 0), reason: str(m.reason) || undefined };
      case "error":
        return { type: "error", text: text || "the agent loop failed" };
      case "status":
      default:
        return text ? { type: "status", text } : null;
    }
  }

  async *runSuite(): AsyncIterable<AgentEvent> {
    for await (const e of this.ndjson("/api/world/suite?stream=1", { count: 30 })) yield e;
  }

  /** Rearm the demo: clean board, naive v1 settle.js live again. */
  async reset(): Promise<void> {
    await api("/api/world/reset", { method: "POST", json: {} });
  }

  async *fix(): AsyncIterable<AgentEvent> {
    for await (const e of this.ndjson("/api/agent/fix", {})) yield e;
  }

  async nextHold(charger: string): Promise<NextHold> {
    const r = obj(await api("/api/hold/next", { method: "POST", json: { charger } }));
    const pi = str(r.payment_intent);
    void this.poll();
    return { payment_intent: pi, driver: str(r.driver, "B"), charger: str(r.charger, charger), label: str(r.label), dashboard_url: str(obj(r.stripe).dashboard_url) || stripeUrl(pi) };
  }

  async drivers(): Promise<DriverLedger> {
    const w = obj(await api("/api/world/state"));
    return driverLedger(arr(w.holds).map(obj), arr(w.intents).map(obj));
  }

  async lastAgentRun(): Promise<AgentRun | null> {
    const r = obj(await api("/api/agent/last"));
    if (!r.run) return null;
    const run = obj(r.run);
    return { ...(run as unknown as AgentRun), attempts: arr(run.attempts) as AgentRun["attempts"], errors: arr(run.errors).map(String), deployed: (run.deployed ?? null) as AgentRun["deployed"], final_diff: (run.final_diff ?? null) as AgentRun["final_diff"] };
  }

  async lastSuite(): Promise<SuiteReport | null> {
    const r = obj(await api("/api/world/suite/last"));
    const s = normSuite(r.report, this.settle.version);
    if (s && !this.suite) {
      this.suite = s;
      this.emit({ suite: s });
    }
    return s;
  }

  async probe(): Promise<ProbeReport> {
    const r = obj(await api("/api/world/probe", { method: "POST", json: {} }));
    return { ...(r as unknown as ProbeReport), checks: arr(r.checks) as ProbeReport["checks"] };
  }

  async proof(): Promise<ProofWithDrivers> {
    const r = obj(await api("/api/proof"));
    const captures = arr(r.captures).map((raw) => {
      const c = obj(raw);
      const status = str(c.status).toLowerCase();
      const pi = str(c.payment_intent);
      return {
        payment_intent: pi,
        charger: str(c.charger),
        episode_id: str(c.episode_id),
        amount_cents: num(c.amount_cents),
        authorized_cents: num(c.authorized_cents, 5000),
        status: (status === "succeeded" ? "succeeded" : status === "canceled" ? "canceled" : status === "refused" ? "refused" : "requires_capture") as "succeeded" | "requires_capture" | "canceled" | "refused",
        idempotency_key: str(c.idempotency_key),
        t: when(c.t),
        error: c.error == null ? undefined : str(c.error),
        url: str(c.url) || stripeUrl(pi),
      };
    });
    const holds: StripeHold[] = arr(r.holds).map((raw) => {
      const h = obj(raw);
      return {
        payment_intent: str(h.payment_intent),
        status: str(h.status),
        amount_authorized: num(h.amount_authorized),
        amount_received: num(h.amount_received),
        amount_capturable: num(h.amount_capturable),
        charger: str(h.charger) || undefined,
        dashboard_url: str(h.dashboard_url) || stripeUrl(str(h.payment_intent)),
        capture_attempts: num(h.capture_attempts),
        captures_succeeded: num(h.captures_succeeded),
        refusals: arr(h.refusals).map(String),
        error: h.error == null ? undefined : str(h.error),
      };
    });
    const sb = obj(r.sandbox);
    const suite = normSuite(r.suite, this.settle.version) ?? this.suite;
    if (suite && suite !== this.suite) {
      this.suite = suite;
      this.emit({ suite });
    }
    const settle = normSettle(r.settle, this.settle) ?? this.settle;
    const charges: DriverCharge[] = arr(r.captures).map((raw) => {
      const c = obj(raw);
      const s = str(c.status).toLowerCase();
      const pi = str(c.payment_intent);
      const base = {
        id: str(c.idempotency_key) || pi,
        charger: str(c.charger),
        payment_intent: pi,
        driver: str(c.driver) || null,
        energy_driver: str(c.energy_driver) || null,
        energy_episode_id: str(c.energy_episode_id) || null,
        amount_cents: num(c.amount_cents),
        status: (s === "succeeded" ? "succeeded" : s === "canceled" ? "released" : s === "refused" ? "refused" : "pending") as DriverCharge["status"],
        wrong_driver: typeof c.wrong_driver === "boolean" ? c.wrong_driver : null,
        error: c.error == null ? undefined : stripeMsg(str(c.error)),
        url: str(c.url) || stripeUrl(pi),
        t: when(c.t),
      };
      return { ...base, story: chargeStory(base) };
    });
    return {
      drivers: arr(r.drivers).map(normDriverHold),
      charges,
      captures,
      holds,
      suite,
      settle,
      sandbox: {
        provider: (str(sb.provider) === "local" ? "local" : "CreateOS") as "local" | "CreateOS",
        name: str(sb.name, this.snap.sandbox.name),
        rootfs: str(sb.rootfs, "devbox:1"),
        egress: arr(sb.egress).map(String),
        keys_inside: arr(sb.keys_inside).map(String),
        state: (str(sb.state, this.snap.sandbox.state) as "running" | "paused" | "absent") || "running",
        preview: str(sb.preview) || this.snap.sandbox.preview,
        creates_used: sb.creates_used != null ? str(sb.creates_used) : this.snap.sandbox.creates_used,
      },
    };
  }
}
