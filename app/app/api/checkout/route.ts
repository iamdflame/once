// POST /api/checkout {charger}: a Stripe Checkout Session for a EUR 50.00 manual-capture hold.
import { createHoldCheckout, normalizeCharger } from "@/lib/stripe";
import { readJson, route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return route(async () => {
    const body = await readJson(req);
    const charger = normalizeCharger(body.charger);
    const origin = req.headers.get("origin") ?? new URL(req.url).origin;
    const s = await createHoldCheckout(charger, origin);
    return { id: s.id, url: s.url, charger, amount: s.amount_total, currency: s.currency };
  });
}
