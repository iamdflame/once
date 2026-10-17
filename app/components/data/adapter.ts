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
  proof(): Promise<Proof>;
  /** Reset the demo: clean board and the naive v1 settle.js. */
  reset?(): void | Promise<void>;
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
