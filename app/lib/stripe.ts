// Stripe: the €50 manual-capture hold (Checkout) and the one capture per intent.
// Stripe keys never enter the sandbox; only the host talks to Stripe.
import "server-only";
import { createHash } from "node:crypto";
import Stripe from "stripe";
import { env, HttpError } from "./env";

export const HOLD = { amount: 5000, currency: "eur", label: "Charging hold" } as const;

let _stripe: Stripe | undefined;
export function stripe(): Stripe {
  if (_stripe) return _stripe;
  const key = env.stripeSecret();
  if (!key) throw new HttpError(500, "missing STRIPE_SECRET_KEY");
  if (/^(sk|rk)_live_/.test(key)) throw new HttpError(500, "refusing a live Stripe key: Once runs in test mode only");
  _stripe = new Stripe(key, { maxNetworkRetries: 2, appInfo: { name: "Once", url: "https://github.com/" } });
  return _stripe;
}

export function dashboardUrl(objectId: string): string {
  const kind = objectId.startsWith("pi_") ? "payments" : objectId.startsWith("cs_") ? "checkout/sessions" : "search?query=";
  return `https://dashboard.stripe.com/test/${kind}${kind.endsWith("=") ? "" : "/"}${objectId}`;
}

export function normalizeCharger(raw: unknown): string {
  const s = String(raw ?? "").trim().toUpperCase();
  const m = s.match(/^(?:CP)?0*(\d{1,2})$/);
  if (!m) throw new HttpError(400, `charger must look like CP07 or 7, got ${JSON.stringify(raw)}`);
  const n = Number(m[1]);
  if (n < 1 || n > 12) throw new HttpError(400, `charger out of range 1..12: ${n}`);
  return `CP${String(n).padStart(2, "0")}`;
}

/** Checkout Session for "plug in charger N": €50.00 hold, manual capture, dynamic payment methods. */
export async function createHoldCheckout(charger: string, origin: string) {
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: HOLD.currency,
          unit_amount: HOLD.amount,
          product_data: { name: HOLD.label, description: `Charger ${charger}: authorised now, captured once for the energy used, the rest released` },
        },
      },
    ],
    payment_intent_data: {
      capture_method: "manual",
      description: `Once charging hold ${charger}`,
      metadata: { app: "once", charger },
    },
    metadata: { app: "once", charger },
    success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}&charger=${charger}`,
    cancel_url: `${origin}/?canceled=1&charger=${charger}`,
  });
  return session;
}

/**
 * A €50 manual-capture hold created and confirmed server-side with Stripe's test card
 * (pm_card_visa): the next driver's test hold for the wrong-driver demo. Test mode only
 * (stripe() refuses live keys); no browser and no Checkout involved.
 */
export async function createTestHold(charger: string, driver: string) {
  return stripe().paymentIntents.create({
    amount: HOLD.amount,
    currency: HOLD.currency,
    capture_method: "manual",
    payment_method: "pm_card_visa",
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    confirm: true,
    description: `Once test hold, driver ${driver}, charger ${charger} (Stripe test mode, pm_card_visa)`,
    metadata: { app: "once", charger, driver },
  });
}

/**
 * The idempotency key for one capture intent: the world's intent id (unique per
 * decision), labelled with the episode. The host's own retries (overlapping ticks, a
 * lease that ran out, a crash between capturing and reporting) replay the same Stripe
 * request and get Stripe's stored answer. A second, distinct decision for the same
 * episode (what naive settlement code emits; v1 even reuses its episode_id under
 * dup_stop) is a new request, so Stripe itself judges it, and refuses it. Keying on
 * episode_id alone would make Stripe replay the first capture and hide that refusal.
 */
export function captureIdempotencyKey(episodeId: string, paymentIntent: string, worldIntentId: string): string {
  const h = createHash("sha256").update(`${paymentIntent}\u0000${worldIntentId}`).digest("hex").slice(0, 32);
  return `once-cap-${String(episodeId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}-${h}`;
}

export type CaptureOutcome = {
  ok: boolean;
  status: string; // PaymentIntent status after the call, or "error"
  error: string | null; // Stripe's message, verbatim
  code?: string | null;
  replayed: boolean; // Stripe answered from its idempotency store
  request_id?: string | null;
  idempotency_key: string;
  stripe_object: {
    id: string;
    object: "payment_intent";
    status?: string;
    amount?: number;
    amount_received?: number;
    amount_capturable?: number;
    currency?: string;
    latest_charge?: string | null;
    dashboard_url: string;
  };
};

export async function capture(paymentIntent: string, amountCents: number, idempotencyKey: string): Promise<CaptureOutcome> {
  const base = { id: paymentIntent, object: "payment_intent" as const, dashboard_url: dashboardUrl(paymentIntent) };
  try {
    const pi = await stripe().paymentIntents.capture(
      paymentIntent,
      { amount_to_capture: Math.round(amountCents) },
      { idempotencyKey },
    );
    const headers = (pi.lastResponse?.headers ?? {}) as Record<string, string>;
    return {
      ok: pi.status === "succeeded",
      status: pi.status,
      error: null,
      replayed: headers["idempotent-replayed"] === "true",
      request_id: pi.lastResponse?.requestId ?? null,
      idempotency_key: idempotencyKey,
      stripe_object: {
        ...base,
        status: pi.status,
        amount: pi.amount,
        amount_received: pi.amount_received,
        amount_capturable: pi.amount_capturable,
        currency: pi.currency,
        latest_charge: typeof pi.latest_charge === "string" ? pi.latest_charge : (pi.latest_charge?.id ?? null),
      },
    };
  } catch (e) {
    const err = e as Stripe.errors.StripeError & { raw?: { payment_intent?: Stripe.PaymentIntent }; headers?: Record<string, string> };
    if (!(e instanceof Stripe.errors.StripeError)) throw e;
    const pi = err.payment_intent ?? err.raw?.payment_intent;
    return {
      ok: false,
      status: pi?.status ?? "error",
      error: err.message, // verbatim, e.g. "...the remainder of the authorized amount has been released."
      code: err.code ?? null,
      replayed: err.headers?.["idempotent-replayed"] === "true",
      request_id: err.requestId ?? null,
      idempotency_key: idempotencyKey,
      stripe_object: {
        ...base,
        status: pi?.status,
        amount: pi?.amount,
        amount_received: pi?.amount_received,
        amount_capturable: pi?.amount_capturable,
        currency: pi?.currency,
      },
    };
  }
}
