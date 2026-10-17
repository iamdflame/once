// The settlement tick: the world decides (its settle.js emits capture intents),
// the host executes each intent on Stripe exactly once, and reports Stripe's answer
// back to the world verbatim. Stripe is the witness.
//
// Safety under concurrent ticks:
//  1. single-flight in this process: concurrent callers share the running tick;
//  2. an intent stays "pending" in the world until its result is reported, so an
//     intent is retried only if the report did not land;
//  3. every Stripe call carries an idempotency key derived from (episode, intent), so a
//     retry from this or any other host instance replays Stripe's stored answer instead
//     of capturing again.
import "server-only";
import { capture, captureIdempotencyKey, stripe, dashboardUrl, type CaptureOutcome } from "./stripe";
import { world, type CaptureIntent } from "./world";
import { describe } from "./errors";

export type CaptureRecord = {
  at: string;
  intent_id: string;
  episode_id: string;
  charger: string;
  payment_intent: string;
  amount_cents: number;
  action: "capture" | "release" | "rejected";
  ok: boolean;
  status: string;
  error: string | null;
  code?: string | null;
  replayed: boolean;
  idempotency_key?: string;
  request_id?: string | null;
  stripe_object?: CaptureOutcome["stripe_object"];
  reported: boolean;
  report_error?: string;
};

export type TickResult = {
  at: string;
  pending: number;
  processed: CaptureRecord[];
  coalesced?: boolean;
  error?: string;
  ms: number;
};

const g = globalThis as unknown as {
  __onceTick?: Promise<TickResult>;
  __onceLedger?: CaptureRecord[];
};
const ledger = () => (g.__onceLedger ??= []);

export function recentCaptures(limit = 100): CaptureRecord[] {
  return ledger().slice(-limit).reverse();
}

function validate(i: CaptureIntent): string | null {
  if (!i || typeof i !== "object") return "intent is not an object";
  if (!i.intent_id) return "intent has no intent_id";
  if (!i.episode_id) return "intent has no episode_id";
  if (typeof i.payment_intent !== "string" || !i.payment_intent.startsWith("pi_")) return `payment_intent is not a Stripe PaymentIntent id: ${JSON.stringify(i.payment_intent)}`;
  if (!Number.isInteger(i.amount_cents) || i.amount_cents < 0) return `amount_cents must be a non-negative integer, got ${JSON.stringify(i.amount_cents)}`;
  return null;
}

/** Zero energy: nothing to capture, so release the whole hold (cancel the PaymentIntent). */
async function release(paymentIntent: string, idempotencyKey: string): Promise<CaptureOutcome> {
  const base = { id: paymentIntent, object: "payment_intent" as const, dashboard_url: dashboardUrl(paymentIntent) };
  try {
    const pi = await stripe().paymentIntents.cancel(paymentIntent, { cancellation_reason: "abandoned" }, { idempotencyKey });
    const headers = (pi.lastResponse?.headers ?? {}) as Record<string, string>;
    return {
      ok: pi.status === "canceled",
      status: pi.status,
      error: null,
      replayed: headers["idempotent-replayed"] === "true",
      request_id: pi.lastResponse?.requestId ?? null,
      idempotency_key: idempotencyKey,
      stripe_object: { ...base, status: pi.status, amount: pi.amount, amount_received: pi.amount_received, amount_capturable: pi.amount_capturable, currency: pi.currency },
    };
  } catch (e) {
    const err = e as { message?: string; code?: string; requestId?: string; payment_intent?: { status?: string } };
    if (!err?.message) throw e;
    return {
      ok: false,
      status: err.payment_intent?.status ?? "error",
      error: err.message,
      code: err.code ?? null,
      replayed: false,
      request_id: err.requestId ?? null,
      idempotency_key: idempotencyKey,
      stripe_object: { ...base, status: err.payment_intent?.status },
    };
  }
}

async function executeOne(i: CaptureIntent): Promise<CaptureRecord> {
  const rec: CaptureRecord = {
    at: new Date().toISOString(),
    intent_id: String(i?.intent_id ?? ""),
    episode_id: String(i?.episode_id ?? ""),
    charger: String(i?.charger ?? ""),
    payment_intent: String(i?.payment_intent ?? ""),
    amount_cents: Number(i?.amount_cents),
    action: "capture",
    ok: false,
    status: "error",
    error: null,
    replayed: false,
    reported: false,
  };
  const invalid = validate(i);
  let outcome: CaptureOutcome | null = null;
  if (invalid) {
    rec.action = "rejected";
    rec.status = "rejected_by_host";
    rec.error = invalid;
  } else {
    const key = captureIdempotencyKey(rec.episode_id, rec.intent_id);
    try {
      outcome = rec.amount_cents === 0 ? await release(rec.payment_intent, key) : await capture(rec.payment_intent, rec.amount_cents, key);
      if (rec.amount_cents === 0) rec.action = "release";
      Object.assign(rec, {
        ok: outcome.ok,
        status: outcome.status,
        error: outcome.error,
        code: outcome.code,
        replayed: outcome.replayed,
        idempotency_key: outcome.idempotency_key,
        request_id: outcome.request_id,
        stripe_object: outcome.stripe_object,
      });
    } catch (e) {
      // Network failure talking to Stripe: do not report, so the intent stays pending and
      // the next tick retries with the same idempotency key.
      rec.error = `host could not reach Stripe: ${describe(e)}`;
      ledger().push(rec);
      return rec;
    }
  }
  try {
    await world.reportResult(rec.intent_id, {
      ok: rec.ok,
      status: rec.status,
      error: rec.error,
      stripe_object: rec.stripe_object ?? null,
    });
    rec.reported = true;
  } catch (e) {
    rec.report_error = describe(e);
  }
  ledger().push(rec);
  if (ledger().length > 500) ledger().splice(0, ledger().length - 500);
  return rec;
}

async function runTick(): Promise<TickResult> {
  const t0 = Date.now();
  const at = new Date().toISOString();
  let pending: CaptureIntent[];
  try {
    pending = await world.pendingIntents();
  } catch (e) {
    return { at, pending: 0, processed: [], error: describe(e), ms: Date.now() - t0 };
  }
  // Intents on the same PaymentIntent run in the order the world emitted them, so the
  // first capture wins and Stripe judges every later one; different holds run in parallel.
  const byPi = new Map<string, CaptureIntent[]>();
  for (const i of pending) {
    const k = String(i?.payment_intent ?? "");
    byPi.set(k, [...(byPi.get(k) ?? []), i]);
  }
  const groups = await Promise.all(
    [...byPi.values()].map(async (list) => {
      const out: CaptureRecord[] = [];
      for (const i of list) out.push(await executeOne(i));
      return out;
    }),
  );
  return { at, pending: pending.length, processed: groups.flat(), ms: Date.now() - t0 };
}

/** One settlement tick. Concurrent calls in this process share the running tick. */
export async function settleTick(): Promise<TickResult> {
  if (g.__onceTick) {
    const r = await g.__onceTick;
    return { ...r, coalesced: true };
  }
  g.__onceTick = runTick().finally(() => {
    g.__onceTick = undefined;
  });
  return g.__onceTick;
}
