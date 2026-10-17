// POST /api/hold/next {charger, driver?}: the NEXT driver's test hold on this charger, for the
// wrong-driver demo. Creates and confirms a €50 manual-capture PaymentIntent server-side in
// Stripe test mode (pm_card_visa), then binds it to the charger's next plug-in with the
// world's /hold. Driver A pays through Checkout; this is driver B (or C, ... by the
// charger's hold count; `driver` overrides).
import { createTestHold, dashboardUrl, normalizeCharger, stripe } from "@/lib/stripe";
import { world, type WorldHold } from "@/lib/world";
import { describe, readJson, route } from "@/lib/errors";
import { HttpError } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const letter = (n: number) => String.fromCharCode(64 + Math.min(26, Math.max(1, n)));

export async function POST(req: Request) {
  return route(async () => {
    const body = await readJson<{ charger?: unknown; driver?: unknown }>(req);
    const charger = normalizeCharger(body.charger);
    let driver: string;
    if (body.driver !== undefined) {
      driver = String(body.driver).trim();
      if (!/^[A-Za-z0-9 _.-]{1,24}$/.test(driver)) throw new HttpError(400, 'driver must be a short label like "B"');
    } else {
      // The next driver after the holds already on this charger: B after A's Checkout hold.
      const st = (await world.state(0)) as { holds?: WorldHold[] };
      const placed = (st.holds ?? []).filter((h) => h.charger === charger).length;
      driver = letter(Math.max(2, placed + 1));
    }
    const pi = await createTestHold(charger, driver);
    if (pi.status !== "requires_capture") {
      throw new HttpError(502, `Stripe returned the test hold as ${pi.status}, not requires_capture`, { payment_intent: pi.id });
    }
    let hold: WorldHold;
    try {
      hold = (await world.hold({ charger, payment_intent: pi.id, amount_cents: pi.amount_capturable, driver })).hold;
    } catch (e) {
      // Unbound, nothing would ever settle it: release it at once rather than leave it authorised.
      const released = await stripe()
        .paymentIntents.cancel(pi.id)
        .then((x) => x.status)
        .catch((err) => `cancel failed: ${describe(err)}`);
      throw new HttpError(502, `the world did not bind the test hold: ${describe(e)} (PaymentIntent ${pi.id}: ${released})`);
    }
    return {
      payment_intent: pi.id,
      driver,
      charger,
      label: `Driver ${driver}'s test hold: €${(pi.amount / 100).toFixed(2)} authorised in Stripe test mode with the test card pm_card_visa, created server-side`,
      test_mode: true,
      stripe: { id: pi.id, status: pi.status, amount: pi.amount, amount_capturable: pi.amount_capturable, currency: pi.currency, capture_method: pi.capture_method, dashboard_url: dashboardUrl(pi.id) },
      hold,
    };
  });
}
