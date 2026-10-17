// Shared shapes for the Once UI. The mock adapter and the live adapter both
// produce these; the components never see raw world or Stripe JSON.

export type Quirk =
  | "queue_offline"
  | "dup_stop"
  | "reboot_restart"
  | "stop_without_start"
  | "meter_reset_on_reboot";

export const QUIRKS: { id: Quirk; label: string; note: string }[] = [
  { id: "queue_offline", label: "Queue while offline", note: "Transaction messages queue when the link is down and resend on reconnect." },
  { id: "dup_stop", label: "Duplicate Stop", note: "A queued StopTransaction is delivered twice on reconnect, 1.2 s apart." },
  { id: "reboot_restart", label: "Reboot restarts the transaction", note: "A reboot mid-session ends the transaction and starts a new one for the same plug-in." },
  { id: "stop_without_start", label: "Stop without Start", note: "A StopTransaction arrives for a transaction the CSMS never saw start." },
  { id: "meter_reset_on_reboot", label: "Meter resets on reboot", note: "The energy register restarts from zero after a reboot." },
];

export type LedStatus = "idle" | "charging" | "offline" | "holding" | "faulted";

export type HoldStatus = "uncaptured" | "captured" | "released" | "refused";

export interface Hold {
  payment_intent: string;
  checkout_session?: string;
  amount_cents: number;
  captured_cents?: number;
  status: HoldStatus;
  episode_id?: string;
}

export interface Charger {
  id: string; // CP01..CP12
  kw: number;
  link: "up" | "cut" | "rebooting";
  plugged: boolean;
  /** Energy of the current or last episode, kWh. */
  kwh: number;
  /** Price of the current or last episode at the tariff, cents. */
  cents: number;
  transaction_id: number | null;
  hold: Hold | null;
  quirks: Record<Quirk, boolean>;
  status: LedStatus;
  queued: number;
}

export type EventKind = "ocpp" | "link" | "cmd" | "settle" | "stripe" | "world";

export interface WorldEvent {
  id: string;
  t: number; // epoch ms
  charger: string | null;
  kind: EventKind;
  dir?: "in" | "out" | "queued" | "dup";
  text: string;
}

/** "wrong": a capture that took one driver's money for another driver's energy (v1). "stranded": a hold left blocked. */
export type ReceiptKind = "hold" | "capture" | "wrong" | "stranded" | "released" | "refused" | "note";

export interface ReceiptLine {
  id: string;
  t: number;
  kind: ReceiptKind;
  charger?: string;
  amount_cents?: number;
  payment_intent?: string;
  stripe_url?: string;
  text: string;
  /** Whose hold this line is about. */
  driver?: string | null;
  /** Whose energy a capture billed (differs from `driver` on a wrong-driver capture). */
  energy_driver?: string | null;
  wrong_driver?: boolean | null;
}

export interface Intent {
  /** The world's own id (in_00001) when there is one. */
  id?: string;
  intent_id: string;
  episode_id: string;
  charger: string;
  payment_intent: string;
  amount_cents: number;
  kind?: "capture" | "release";
  created_at?: number;
  result?: { ok: boolean; status: string; error?: string; stripe_object?: string };
}

export interface Scenario {
  seed: number;
  name?: string;
  faults: string[];
  chargers?: string[];
  double: number;
  stranded: number;
  unbilled: number;
  overbilled: number;
  underbilled?: number;
  ok: boolean;
  /** The world's plain-English account of what went wrong. */
  notes?: string[];
}

export interface SuiteReport {
  version: string;
  ran_at: number;
  summary?: string;
  scenarios: Scenario[];
  totals: { stranded: number; double: number; unbilled: number; overbilled: number; ok: number; count: number };
}

export interface Settle {
  /** The world's deploy counter, as "v7". It keeps counting across resets. */
  version: string;
  source: string;
  author: "shipped" | "agent";
  loaded_at: number;
  /** The program's file name as the world reports it (v1-naive.js, agent-v8.js, …). */
  name?: string;
}

/** "deploy #7" from "v7" (the world's counter), or the tag as is. */
export function deployTag(version: string | number | undefined | null): string {
  const n = Number(String(version ?? "").replace(/\D/g, ""));
  return Number.isFinite(n) && n > 0 ? `deploy #${n}` : String(version ?? "—");
}

/** What the program is, then which deploy: "v1 (naive) · deploy #7", "agent-written · deploy #8". */
export function settleLabel(s: Pick<Settle, "version" | "author">): string {
  return `${s.author === "agent" ? "agent-written" : "v1 (naive)"} · ${deployTag(s.version)}`;
}

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "attempt"; n: number; of: number }
  | { type: "model"; name: string; provider: string }
  | { type: "thinking"; text: string }
  /** A chunk of the model's streamed output. */
  | { type: "delta"; text: string }
  | { type: "diff"; old: string; new: string; version: string }
  | { type: "uploaded"; version: string }
  | { type: "scenario"; scenario: Scenario; index: number; count: number }
  | { type: "suite"; report: SuiteReport; phase?: "baseline" | "attempt" | "deployed" }
  | { type: "done"; ok: boolean; version: string; attempts: number; reason?: string }
  | { type: "error"; text: string };

export interface Capture {
  payment_intent: string;
  charger: string;
  episode_id: string;
  amount_cents: number;
  authorized_cents: number;
  status: "succeeded" | "requires_capture" | "canceled" | "refused";
  idempotency_key: string;
  t: number;
  error?: string;
  url: string;
}

export interface SandboxInfo {
  provider: "CreateOS" | "mock" | "local";
  name: string;
  rootfs: string;
  egress: string[];
  keys_inside: string[];
  state: "running" | "paused" | "absent";
  preview?: string;
  creates_used?: string;
}

export interface Proof {
  captures: Capture[];
  suite: SuiteReport | null;
  sandbox: SandboxInfo;
  settle: Settle | null;
  /** Each hold as Stripe itself reports it (live mode). */
  holds?: StripeHold[];
}

export interface StripeHold {
  payment_intent: string;
  status: string;
  amount_authorized: number;
  amount_received: number;
  amount_capturable: number;
  charger?: string;
  dashboard_url: string;
  capture_attempts: number;
  captures_succeeded: number;
  refusals: string[];
  error?: string;
}

export interface Snapshot {
  chargers: Charger[];
  events: WorldEvent[];
  receipt: ReceiptLine[];
  intents: Intent[];
  settle: Settle;
  suite: SuiteReport | null;
  sandbox: SandboxInfo;
  tariff_cents_per_kwh: number;
  connected: boolean;
  error?: string;
}

export type Command =
  | { op: "plug" | "unplug" | "cut" | "restore" | "reboot"; charger: string }
  | { op: "quirk"; charger: string; quirk: Quirk; on: boolean };

export interface CheckoutStart {
  mode: "redirect" | "mock";
  url?: string;
  session_id?: string;
}

export type Mode = "mock" | "live";

export const STRIPE_DASHBOARD = "https://dashboard.stripe.com/test/payments/";

export function stripeUrl(pi: string): string {
  return STRIPE_DASHBOARD + pi;
}

export function euro(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const v = Math.abs(cents);
  return `${sign}€${(v / 100).toFixed(2)}`;
}

export function ledFor(c: Pick<Charger, "link" | "plugged" | "hold">): LedStatus {
  if (c.link !== "up") return "offline";
  if (c.plugged) return "charging";
  if (c.hold && c.hold.status === "uncaptured") return "holding";
  return "idle";
}
