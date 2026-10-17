// The live adapter: the host API routes (app/app/api/**) in front of the
// CreateOS sandbox and Stripe. The world's JSON is normalised here into the
// shapes in types.ts, tolerantly, so a renamed field degrades to a blank
// instead of a crash.

import type { WorldAdapter } from "./adapter";
import { totals } from "./adapter";
import type {
  AgentEvent,
  Charger,
  CheckoutStart,
  Command,
  Hold,
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
import { QUIRKS, euro, ledFor, stripeUrl } from "./types";

type J = Record<string, unknown>;
const obj = (x: unknown): J => (x && typeof x === "object" ? (x as J) : {});
const str = (x: unknown, d = ""): string => (x == null ? d : String(x));
const num = (x: unknown, d = 0): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const arr = (x: unknown, ...keys: string[]): unknown[] => {
  if (Array.isArray(x)) return x;
  const o = obj(x);
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  if (keys.length === 0 && x && typeof x === "object") return Object.values(o);
  return [];
};
const when = (x: unknown): number => {
  if (typeof x === "number") return x > 1e12 ? x : x * 1000;
  const t = Date.parse(str(x));
  return Number.isFinite(t) ? t : Date.now();
};

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

function normHold(raw: unknown, intents: Intent[]): Hold | null {
  const h = obj(raw);
  const pi = str(h.payment_intent ?? h.paymentIntent ?? h.pi);
  if (!pi) return null;
  const mine = intents.filter((i) => i.payment_intent === pi && i.result);
  const captured = mine.find((i) => i.result?.ok);
  const refused = mine.find((i) => i.result && !i.result.ok);
  let status: Hold["status"] = "uncaptured";
  const s = str(h.status).toLowerCase();
  if (captured || s === "captured" || s === "succeeded") status = "captured";
  else if (s === "released" || s === "canceled") status = "released";
  else if (refused && !captured) status = "refused";
  return {
    payment_intent: pi,
    checkout_session: str(h.checkout_session ?? h.session) || undefined,
    amount_cents: num(h.amount_cents ?? h.amount, 5000),
    captured_cents: captured?.amount_cents ?? (h.captured_cents != null ? num(h.captured_cents) : undefined),
    status,
    episode_id: str(h.episode_id ?? h.episode) || undefined,
  };
}

function normCharger(raw: unknown, holds: unknown[], episodes: unknown[], intents: Intent[], tariff: number): Charger {
  const c = obj(raw);
  const id = str(c.id ?? c.charger ?? c.name);
  const linkRaw = str(c.link ?? obj(c.proxy).state ?? (c.connected === false ? "cut" : c.online === false ? "cut" : "up")).toLowerCase();
  const link: Charger["link"] = /cut|down|off|closed|false/.test(linkRaw) ? "cut" : /reboot|boot/.test(linkRaw) ? "rebooting" : "up";
  const holdRaw = c.hold ?? holds.find((h) => str(obj(h).charger) === id);
  const episode = obj(c.episode ?? episodes.find((e) => str(obj(e).charger) === id && !obj(e).ended_at && !obj(e).closed));
  const hold = normHold(holdRaw ?? episode.hold, intents);
  const wh = num(c.episode_wh ?? episode.wh ?? episode.energy_wh ?? c.session_wh ?? c.wh ?? (c.kwh != null ? num(c.kwh) * 1000 : undefined), 0);
  const kwh = wh / 1000;
  const cents = Math.round(kwh * tariff);
  const plugged = Boolean(c.plugged ?? c.ev_connected ?? episode.id ?? (str(c.connector_status ?? c.status).toLowerCase() === "charging"));
  const base = {
    id,
    kw: num(c.kw ?? c.power_kw ?? c.max_kw, 11),
    link,
    plugged,
    kwh,
    cents: hold ? Math.min(cents, hold.amount_cents) : cents,
    transaction_id: c.transaction_id != null ? num(c.transaction_id) : c.transactionId != null ? num(c.transactionId) : null,
    hold,
    quirks: normQuirks(c.quirks),
    queued: num(c.queued ?? c.queue_length ?? arr(c.queue).length, 0),
  };
  return { ...base, status: ledFor(base) };
}

function normIntent(raw: unknown): Intent {
  const i = obj(raw);
  const r = i.result != null ? obj(i.result) : i.status != null && i.status !== "pending" ? i : null;
  return {
    intent_id: str(i.intent_id ?? i.id),
    episode_id: str(i.episode_id),
    charger: str(i.charger),
    payment_intent: str(i.payment_intent),
    amount_cents: num(i.amount_cents),
    result: r
      ? {
          ok: Boolean(r.ok ?? str(r.status) === "succeeded"),
          status: str(r.status, "error"),
          error: r.error == null ? undefined : str(r.error),
          stripe_object: typeof r.stripe_object === "string" ? r.stripe_object : str(obj(r.stripe_object).id) || undefined,
        }
      : undefined,
  };
}

function normEvent(raw: unknown, i: number): WorldEvent {
  const e = obj(raw);
  const kindRaw = str(e.kind ?? e.type ?? "world").toLowerCase();
  const kind: WorldEvent["kind"] = /ocpp|msg|message/.test(kindRaw)
    ? "ocpp"
    : /link|proxy|net/.test(kindRaw)
      ? "link"
      : /cmd|command/.test(kindRaw)
        ? "cmd"
        : /settle|intent/.test(kindRaw)
          ? "settle"
          : /stripe|capture|hold/.test(kindRaw)
            ? "stripe"
            : "world";
  let text = str(e.text ?? e.message ?? e.summary);
  if (!text) {
    const action = str(e.action);
    const payload = e.payload ?? e.body;
    text = action ? `${action} ${payload !== undefined ? JSON.stringify(payload) : ""}`.trim() : JSON.stringify(e).slice(0, 200);
  }
  const dirRaw = str(e.dir ?? e.direction).toLowerCase();
  return {
    id: str(e.id ?? e.seq ?? `${when(e.t ?? e.ts ?? e.at)}-${i}`),
    t: when(e.t ?? e.ts ?? e.at ?? e.time),
    charger: e.charger == null ? null : str(e.charger),
    kind,
    dir: /dup/.test(dirRaw) || e.duplicate ? "dup" : /queue/.test(dirRaw) || e.queued ? "queued" : /out|tx/.test(dirRaw) ? "out" : "in",
    text,
  };
}

function normScenario(raw: unknown): Scenario {
  const s = obj(raw);
  const faultsRaw = s.faults;
  const faults = Array.isArray(faultsRaw) ? faultsRaw.map((f) => (typeof f === "string" ? f : str(obj(f).type ?? obj(f).op ?? obj(f).kind))) : faultsRaw && typeof faultsRaw === "object" ? Object.keys(faultsRaw).filter((k) => obj(faultsRaw)[k]) : [];
  const double = num(s.double);
  const stranded = num(s.stranded);
  const unbilled = num(s.unbilled);
  const overbilled = num(s.overbilled);
  return { seed: num(s.seed), faults, double, stranded, unbilled, overbilled, ok: Boolean(s.ok ?? double + stranded + unbilled + overbilled === 0) };
}

export function normSuite(raw: unknown, fallbackVersion = ""): SuiteReport | null {
  if (!raw) return null;
  const r = obj(raw);
  const scenarios = arr(r.scenarios ?? r.results ?? r.runs ?? raw).map(normScenario);
  if (scenarios.length === 0) return null;
  return {
    version: str(r.version ?? r.settle_version ?? obj(r.settle).version, fallbackVersion),
    ran_at: when(r.ran_at ?? r.at ?? r.t ?? Date.now()),
    scenarios,
    totals: totals(scenarios),
  };
}

function normSettle(raw: unknown): Settle | null {
  const s = obj(raw);
  const source = str(s.source ?? s.code);
  if (!source) return null;
  const version = str(s.version ?? s.v, "v1");
  return {
    version: /^\d+$/.test(version) ? `v${version}` : version,
    source,
    author: str(s.author) === "agent" || num(s.version) > 1 ? "agent" : "shipped",
    loaded_at: when(s.loaded_at ?? s.at ?? Date.now()),
  };
}

/** Receipt lines derive from holds and intent results, in time order. */
function buildReceipt(chargers: Charger[], intents: Intent[], events: WorldEvent[]): ReceiptLine[] {
  const lines: ReceiptLine[] = [];
  for (const c of chargers) {
    if (!c.hold) continue;
    const holdEvt = events.find((e) => e.charger === c.id && /hold/i.test(e.text) && e.text.includes(c.hold!.payment_intent));
    lines.push({
      id: `hold-${c.hold.payment_intent}`,
      t: holdEvt?.t ?? 0,
      kind: "hold",
      charger: c.id,
      amount_cents: c.hold.amount_cents,
      payment_intent: c.hold.payment_intent,
      stripe_url: stripeUrl(c.hold.payment_intent),
      text: `HOLD ${euro(c.hold.amount_cents)} on ${c.id}`,
    });
  }
  let n = 0;
  for (const i of intents) {
    if (!i.result) continue;
    n++;
    const t = n; // ordering within the intent list is the world's order
    if (i.result.ok) {
      lines.push({ id: `cap-${i.intent_id}`, t, kind: "capture", charger: i.charger, amount_cents: i.amount_cents, payment_intent: i.payment_intent, stripe_url: stripeUrl(i.payment_intent), text: `CAPTURE ${euro(i.amount_cents)}` });
      const hold = chargers.find((c) => c.hold?.payment_intent === i.payment_intent)?.hold;
      const auth = hold?.amount_cents ?? 5000;
      if (auth - i.amount_cents > 0) lines.push({ id: `rel-${i.intent_id}`, t: t + 0.5, kind: "released", charger: i.charger, amount_cents: auth - i.amount_cents, payment_intent: i.payment_intent, stripe_url: stripeUrl(i.payment_intent), text: `RELEASED ${euro(auth - i.amount_cents)}` });
    } else {
      lines.push({ id: `ref-${i.intent_id}`, t, kind: "refused", charger: i.charger, amount_cents: i.amount_cents, payment_intent: i.payment_intent, stripe_url: stripeUrl(i.payment_intent), text: `REFUSED: ${i.result.error ?? i.result.status}` });
    }
  }
  // Holds first (they have real timestamps or 0), then intents in world order.
  return lines.sort((a, b) => (a.kind === "hold" && b.kind !== "hold" ? -1 : b.kind === "hold" && a.kind !== "hold" ? 1 : a.t - b.t));
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
  private tariff = 38;
  private failures = 0;

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
      const info = obj(r.sandbox ?? r);
      this.emit({
        sandbox: {
          ...this.snap.sandbox,
          name: str(info.name, this.snap.sandbox.name),
          rootfs: str(info.rootfs ?? info.image, "devbox:1"),
          egress: arr(info.egress ?? info.allowlist).map(String).length ? arr(info.egress ?? info.allowlist).map(String) : ["sinkhole.invalid"],
          state: (str(info.state ?? info.status, "running") as "running" | "paused" | "absent") || "running",
          preview: str(info.url ?? info.preview ?? info.previewUrl) || undefined,
          creates_used: info.creates_used != null ? str(info.creates_used) : undefined,
        },
      });
      const s = await api("/api/world/settle").catch(() => null);
      const settle = normSettle(s);
      if (settle) this.settle = settle;
    } catch (e) {
      this.emit({ error: (e as Error).message });
    }
  }

  private async poll() {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const raw = obj(await api("/api/world/state"));
      const world = obj(raw.state ?? raw.world ?? raw);
      this.tariff = num(world.tariff_cents_per_kwh ?? obj(world.tariff).cents_per_kwh ?? world.tariff, this.tariff) || this.tariff;
      const intents = arr(world.intents ?? raw.intents, "items").map(normIntent);
      const holds = arr(world.holds);
      const episodes = arr(world.episodes);
      const chargers = arr(world.chargers, "items").map((c) => normCharger(c, holds, episodes, intents, this.tariff)).filter((c) => c.id);
      const events = arr(world.events ?? world.recent_events ?? raw.events).map(normEvent);
      const settleRaw = world.settle ?? raw.settle;
      const settle = normSettle(settleRaw) ?? this.settle;
      if (settle.source && (settle.version !== this.settle.version || !this.settle.source)) this.settle = settle;
      else if (settleRaw && str(obj(settleRaw).version) && !obj(settleRaw).source) this.settle = { ...this.settle, version: normSettle({ ...obj(settleRaw), source: "x" })!.version };
      const suite = normSuite(world.suite ?? world.last_suite ?? raw.suite, this.settle.version) ?? this.suite;
      this.suite = suite;
      this.failures = 0;
      this.emit({
        chargers,
        events,
        intents,
        receipt: buildReceipt(chargers, intents, events),
        settle: this.settle,
        suite,
        tariff_cents_per_kwh: this.tariff,
        connected: true,
        error: undefined,
      });
      // Tick while there is anything pending (and once a second anyway: cheap, idempotent).
      if (!this.ticking) void this.tick();
    } catch (e) {
      this.failures++;
      if (this.failures > 2) this.emit({ connected: false, error: (e as Error).message });
    } finally {
      this.inflight = false;
    }
  }

  async cmd(c: Command): Promise<void> {
    await api("/api/world/cmd", { method: "POST", json: c });
    void this.poll();
  }

  async checkout(charger: string): Promise<CheckoutStart> {
    const r = obj(await api("/api/checkout", { method: "POST", json: { charger } }));
    const url = str(r.url ?? obj(r.session).url);
    if (!url) throw new Error("Checkout did not return a URL");
    return { mode: "redirect", url, session_id: str(r.id ?? r.session_id) || undefined };
  }

  async confirmCheckout(sessionId: string) {
    try {
      const r = obj(await api(`/api/checkout/confirm?session_id=${encodeURIComponent(sessionId)}`));
      const ok = Boolean(r.ok ?? r.bound ?? /requires_capture|succeeded/.test(str(r.status ?? obj(r.payment_intent).status)));
      return { ok, charger: str(r.charger) || undefined, payment_intent: str(typeof r.payment_intent === "string" ? r.payment_intent : obj(r.payment_intent).id) || undefined, error: ok ? undefined : str(r.error ?? r.status, "not bound") };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await api("/api/settle/tick", { method: "POST", json: {} });
    } catch {
      /* the next poll retries */
    } finally {
      this.ticking = false;
    }
  }

  async *runSuite(): AsyncIterable<AgentEvent> {
    yield { type: "status", text: `Running 30 seeded storms against settle.js ${this.settle.version} inside the sandbox` };
    try {
      const raw = await api("/api/world/suite", { method: "POST", json: { count: 30 } });
      const report = normSuite(raw, this.settle.version);
      if (!report) throw new Error("the suite returned no scenarios");
      for (let i = 0; i < report.scenarios.length; i++) {
        yield { type: "scenario", scenario: report.scenarios[i], index: i, count: report.scenarios.length };
        await new Promise((r) => setTimeout(r, 60));
      }
      this.suite = report;
      this.emit({ suite: report });
      yield { type: "suite", report };
    } catch (e) {
      yield { type: "error", text: (e as Error).message };
    }
  }

  async *fix(): AsyncIterable<AgentEvent> {
    let res: Response;
    try {
      res = await fetch("/api/agent/fix", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    } catch (e) {
      yield { type: "error", text: (e as Error).message };
      return;
    }
    if (!res.ok || !res.body) {
      yield { type: "error", text: `agent route answered ${res.status}` };
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
        let line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (line.startsWith("data:")) line = line.slice(5).trim();
        if (line.startsWith("event:") || line.startsWith(":")) continue;
        let msg: J;
        try {
          msg = obj(JSON.parse(line));
        } catch {
          yield { type: "status", text: line };
          continue;
        }
        const ev = this.normAgent(msg, count++);
        if (ev) {
          if (ev.type === "suite") {
            this.suite = ev.report;
            this.emit({ suite: ev.report });
          }
          if (ev.type === "diff") this.settle = { version: ev.version, source: ev.new, author: "agent", loaded_at: Date.now() };
          if (ev.type === "uploaded") this.settle = { ...this.settle, version: ev.version, author: "agent", loaded_at: Date.now() };
          yield ev;
        }
      }
    }
    void this.poll();
  }

  private normAgent(m: J, i: number): AgentEvent | null {
    const type = str(m.type ?? m.event ?? m.kind).toLowerCase();
    const text = str(m.text ?? m.message ?? m.summary ?? m.status);
    if (/^attempt/.test(type)) return { type: "attempt", n: num(m.n ?? m.attempt, 1), of: num(m.of ?? m.max, 3) };
    if (/model/.test(type)) return { type: "model", name: str(m.name ?? m.model), provider: str(m.provider, "OpenRouter") };
    if (/think|reason/.test(type)) return { type: "thinking", text };
    if (/diff|code|settle/.test(type) && (m.new != null || m.source != null || m.after != null)) {
      const version = str(m.version ?? m.v, `v${num(this.settle.version.replace(/\D/g, ""), 1) + 1}`);
      return { type: "diff", old: str(m.old ?? m.before ?? m.previous ?? this.settle.source), new: str(m.new ?? m.after ?? m.source), version: /^\d+$/.test(version) ? `v${version}` : version };
    }
    if (/upload|loaded|put/.test(type)) {
      const version = str(m.version, this.settle.version);
      return { type: "uploaded", version: /^\d+$/.test(version) ? `v${version}` : version };
    }
    if (/^scenario|^tile|^result$/.test(type)) return { type: "scenario", scenario: normScenario(m.scenario ?? m), index: num(m.index ?? m.i, i), count: num(m.count ?? m.of, 30) };
    if (/suite|report/.test(type)) {
      const report = normSuite(m.report ?? m.suite ?? m, this.settle.version);
      return report ? { type: "suite", report } : { type: "status", text: text || "suite finished" };
    }
    if (/done|finish|complete|success/.test(type)) {
      const version = str(m.version, this.settle.version);
      return { type: "done", ok: Boolean(m.ok ?? m.passed ?? m.success ?? true), version: /^\d+$/.test(version) ? `v${version}` : version, attempts: num(m.attempts ?? m.attempt, 1) };
    }
    if (/error|fail/.test(type)) return { type: "error", text: text || "the agent loop failed" };
    return text ? { type: "status", text } : null;
  }

  async proof(): Promise<Proof> {
    const r = obj(await api("/api/proof"));
    const captures = arr(r.captures ?? r.recent ?? r.ledger, "items").map((raw) => {
      const c = obj(raw);
      const so = obj(c.stripe_object);
      const status = str(c.status).toLowerCase();
      return {
        payment_intent: str(c.payment_intent ?? so.id),
        charger: str(c.charger),
        episode_id: str(c.episode_id),
        amount_cents: num(c.amount_cents ?? so.amount_received),
        authorized_cents: num(so.amount ?? c.authorized_cents, 5000),
        status: (c.ok === true || status === "succeeded" ? "succeeded" : status === "requires_capture" ? "requires_capture" : status === "canceled" ? "canceled" : "refused") as "succeeded" | "requires_capture" | "canceled" | "refused",
        idempotency_key: str(c.idempotency_key),
        t: when(c.at ?? c.t),
        error: c.error == null ? undefined : str(c.error),
        url: str(so.dashboard_url) || stripeUrl(str(c.payment_intent ?? so.id)),
      };
    });
    const sandboxRaw = obj(r.sandbox ?? r.world);
    return {
      captures,
      suite: normSuite(r.suite ?? r.last_suite, this.settle.version) ?? this.suite,
      settle: normSettle(r.settle) ?? this.settle,
      sandbox: {
        provider: "CreateOS",
        name: str(sandboxRaw.name, this.snap.sandbox.name),
        rootfs: str(sandboxRaw.rootfs ?? sandboxRaw.image, "devbox:1"),
        egress: arr(sandboxRaw.egress ?? sandboxRaw.allowlist).map(String).length ? arr(sandboxRaw.egress ?? sandboxRaw.allowlist).map(String) : ["sinkhole.invalid"],
        keys_inside: arr(sandboxRaw.keys_inside).map(String),
        state: (str(sandboxRaw.state ?? sandboxRaw.status, this.snap.sandbox.state) as "running" | "paused" | "absent") || "running",
        preview: str(sandboxRaw.url ?? sandboxRaw.preview) || this.snap.sandbox.preview,
        creates_used: sandboxRaw.creates_used != null ? str(sandboxRaw.creates_used) : this.snap.sandbox.creates_used,
      },
    };
  }
}
