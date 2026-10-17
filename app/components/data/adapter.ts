import type { AgentEvent, CheckoutStart, Command, Mode, Proof, Snapshot, SuiteReport } from "./types";

/**
 * What the UI needs from a world. `MockWorld` replays a realistic sequence in
 * the browser; `LiveWorld` talks to the host API routes which talk to the
 * CreateOS sandbox and Stripe.
 */
export interface WorldAdapter {
  readonly mode: Mode;
  /** Current snapshot; cheap, synchronous. */
  snapshot(): Snapshot;
  /** Called on every change. Returns an unsubscribe. */
  subscribe(fn: (s: Snapshot) => void): () => void;
  /** Start polling / timers. Idempotent. */
  start(): void;
  stop(): void;

  cmd(c: Command): Promise<void>;
  /** Begin a Stripe Checkout for a €50 hold on this charger. */
  checkout(charger: string): Promise<CheckoutStart>;
  /** After Checkout returns: bind the PaymentIntent to the charger's next episode. */
  confirmCheckout(sessionId: string): Promise<{ ok: boolean; charger?: string; payment_intent?: string; error?: string }>;
  /** Mock only: complete the fake Checkout sheet. */
  mockPay?(charger: string): Promise<{ payment_intent: string }>;
  /** Pull pending capture intents and execute them on Stripe. */
  tick(): Promise<void>;
  /** Run the 30-storm suite on the current settle.js. */
  runSuite(): AsyncIterable<AgentEvent>;
  /** The agent loop: read the report, write settle.js, upload, run, repeat. */
  fix(): AsyncIterable<AgentEvent>;
  /** The proof, plus every hold per driver and every capture attributed to the driver whose energy it billed. */
  proof(): Promise<ProofWithDrivers>;
  /** Reset the demo: clean board and the naive v1 settle.js. */
  reset?(): void | Promise<void>;

  /** The wrong-driver demo: place the NEXT driver's €50 test hold on this charger (driver B after A's Checkout). */
  nextHold(charger: string): Promise<NextHold>;
  /** Holds per driver and attributed captures, from the world (cheap; no Stripe lookups). */
  drivers(): Promise<DriverLedger>;
  /** The last real agent run, kept in the sandbox; null before the first run. */
  lastAgentRun(): Promise<AgentRun | null>;
  /** The last suite the world ran on its deployed settle.js; null when none has run. */
  lastSuite(): Promise<SuiteReport | null>;
  /** Run the boundary probe inside the sandbox. */
  probe(): Promise<ProbeReport>;
}

export function emptyReport(version: string): SuiteReport {
  return {
    version,
    ran_at: 0,
    scenarios: [],
    totals: { stranded: 0, double: 0, unbilled: 0, overbilled: 0, ok: 0, count: 0 },
  };
}

export function totals(scenarios: SuiteReport["scenarios"]): SuiteReport["totals"] {
  return scenarios.reduce(
    (t, s) => ({
      stranded: t.stranded + s.stranded,
      double: t.double + s.double,
      unbilled: t.unbilled + s.unbilled,
      overbilled: t.overbilled + s.overbilled,
      ok: t.ok + (s.ok ? 1 : 0),
      count: t.count + 1,
    }),
    { stranded: 0, double: 0, unbilled: 0, overbilled: 0, ok: 0, count: 0 },
  );
}

// ------------------------------------------------------------ drivers, the agent's last run, the probe

/** POST /api/hold/next: the next driver's €50 test hold on a charger (Stripe test mode, pm_card_visa, server-side). */
export interface NextHold {
  payment_intent: string;
  driver: string;
  charger: string;
  /** "Driver B's test hold: €50.00 authorised in Stripe test mode with the test card pm_card_visa, created server-side" */
  label: string;
  dashboard_url: string;
}

/** One capture attempt, attributed: whose hold paid (driver) and whose energy it was for (energy_driver). */
export interface DriverCharge {
  id: string;
  charger: string;
  payment_intent: string;
  /** The driver whose hold this charges ("A", "B", ...). */
  driver: string | null;
  /** The driver whose plug-in episode delivered the energy being billed. */
  energy_driver: string | null;
  energy_episode_id: string | null;
  amount_cents: number;
  status: "pending" | "succeeded" | "refused" | "released";
  /** true: the money came off someone else's hold (v1's wrong-driver capture). */
  wrong_driver: boolean | null;
  /** Stripe's own words when it refused. */
  error?: string;
  /** "Driver B was charged €4.37 for Driver A's energy; Stripe: succeeded" */
  story: string;
  url: string;
  t: number;
}

/** One hold, per driver: what was captured on it and for whose energy, or that it is stranded. */
export interface DriverHold {
  driver: string | null;
  seq: number | null;
  charger: string;
  payment_intent: string;
  episode_id: string | null;
  amount_cents: number;
  captured_cents: number;
  status: "uncaptured" | "captured" | "released";
  /** The session ended, nothing was captured, and nothing is pending: the driver's €50 stays blocked. */
  stranded: boolean;
  charged_for_driver: string | null;
  wrong_driver: boolean | null;
  story: string;
  url: string;
}

export interface DriverLedger {
  holds: DriverHold[];
  charges: DriverCharge[];
}

/** /api/proof with the per-driver view (each hold checked against Stripe in live mode). */
export type ProofWithDrivers = Proof & { drivers: DriverHold[]; charges: DriverCharge[] };

export interface AgentRunSuite {
  version?: string;
  summary?: string;
  totals: { double: number; stranded: number; unbilled: number; overbilled: number; underbilled: number; invalid: number; ok: number; failed: number; count: number };
  ms?: number;
}

export interface AgentRunAttempt {
  n: number;
  model?: string;
  provider?: string;
  model_ms?: number;
  plan?: string;
  diff?: { added: number; removed: number };
  load_error?: string;
  suite?: AgentRunSuite;
  suite_ms?: number;
  deployed?: boolean;
}

/** GET /api/agent/last: the last real agent run, kept in the world sandbox. */
export interface AgentRun {
  ok: boolean;
  reason: string;
  provider?: string;
  model?: string;
  models?: string[];
  started_at: number;
  finished_at: number;
  ms: number;
  baseline?: AgentRunSuite;
  attempts: AgentRunAttempt[];
  deployed: { version: string; suite?: AgentRunSuite } | null;
  /** The live settle.js version after the run. */
  version: string;
  final_diff: { attempt: number; added: number; removed: number; unified: string; source: string } | null;
  errors: string[];
  timings: { baseline_ms?: number; model_ms: number; suite_ms: number; total_ms: number };
  received_at?: number;
}

export interface ProbeCheck {
  /** a: settle.js vm escapes · b: the 1 s budget · c: egress from the world process · d: keys and sandbox settings */
  group: "a" | "b" | "c" | "d";
  id: string;
  label: string;
  /** null for a disclosed fact (reported, not judged). */
  pass: boolean | null;
  applicable: boolean;
  /** "disclosed": a fact reported without a verdict (TCP connect is accepted, DNS resolves). */
  verdict: "pass" | "fail" | "disclosed" | "local: not applicable";
  layer?: string;
  detail: string;
  expected: string;
  ms: number;
}

/** POST /api/world/probe: the boundary, checked live inside the sandbox. */
export interface ProbeReport {
  ok: boolean;
  mode: "local" | "createos" | "mock";
  note: string;
  at: string;
  passed: number;
  /** Judged checks that apply here ("disclosed" facts are not counted). */
  applicable: number;
  /** Facts reported without a verdict (TCP connect accepted, DNS resolves). */
  disclosed: number;
  checks: ProbeCheck[];
  sandbox: Record<string, unknown>;
  env: { world_process: string[]; flagged: string[]; sandbox_declared: string[] };
  ms: number;
}

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
const who = (d: string | null | undefined) => (d ? `Driver ${d}` : "an unpaid session");

/** The sentence for one attributed capture attempt (shared by the live and mock adapters). */
export function chargeStory(c: Pick<DriverCharge, "driver" | "energy_driver" | "energy_episode_id" | "amount_cents" | "status" | "error">): string {
  const energy = c.energy_driver ? `${who(c.energy_driver)}'s energy` : c.energy_episode_id ? `the energy of ${c.energy_episode_id}` : "unattributed energy";
  if (c.status === "succeeded") return `${who(c.driver)} was charged ${eur(c.amount_cents)} for ${energy}; Stripe: succeeded`;
  if (c.status === "released") return `${who(c.driver)}'s hold was released in full (no energy); Stripe: canceled`;
  if (c.status === "refused") return `${who(c.driver)}'s hold: a capture of ${eur(c.amount_cents)} for ${energy} was refused by Stripe${c.error ? `: ${c.error}` : ""}`;
  return `${who(c.driver)}'s hold: a capture of ${eur(c.amount_cents)} for ${energy} is waiting for the host`;
}

/** The sentence for one hold. */
export function holdStory(h: Pick<DriverHold, "driver" | "amount_cents" | "captured_cents" | "status" | "stranded" | "charged_for_driver" | "wrong_driver" | "episode_id">): string {
  if (h.stranded) return `${who(h.driver)}'s ${eur(h.amount_cents)} hold is stranded: the session ended and nothing was captured on it`;
  if (h.status === "captured")
    return `${who(h.driver)} paid ${eur(h.captured_cents)}${h.charged_for_driver ? ` for ${who(h.charged_for_driver)}'s energy` : ""}${h.wrong_driver ? " (not their own session)" : ""}; Stripe: succeeded`;
  if (h.status === "released") return `${who(h.driver)}'s hold was released in full`;
  return `${who(h.driver)}'s ${eur(h.amount_cents)} hold is authorised and waiting${h.episode_id ? ` (${h.episode_id} in progress)` : " for the next plug-in"}`;
}
