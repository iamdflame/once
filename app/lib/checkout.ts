// Checkout confirmation: once Stripe says the hold is authorised (requires_capture),
// bind it to the next plug-in episode on that charger in the world.
import "server-only";
import { stripe, dashboardUrl } from "./stripe";
import { world } from "./world";
import { describe } from "./errors";

const g = globalThis as unknown as { __onceBound?: Map<string, unknown> };
const bound = () => (g.__onceBound ??= new Map());

export async function confirmCheckout(sessionId: string) {
  const session = await stripe().checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
  const pi = session.payment_intent && typeof session.payment_intent === "object" ? session.payment_intent : null;
  const charger = session.metadata?.charger ?? pi?.metadata?.charger ?? null;
  const out = {
    session: { id: session.id, status: session.status, payment_status: session.payment_status, amount_total: session.amount_total, currency: session.currency },
    charger,
    payment_intent: pi
      ? { id: pi.id, status: pi.status, amount: pi.amount, amount_capturable: pi.amount_capturable, capture_method: pi.capture_method, dashboard_url: dashboardUrl(pi.id) }
      : null,
    hold: null as unknown,
    hold_error: undefined as string | undefined,
  };
  if (!pi || pi.status !== "requires_capture" || !charger) return out;

  // Bind once per PaymentIntent (the success page may be reloaded).
  if (bound().has(pi.id)) {
    out.hold = bound().get(pi.id);
    return out;
  }
  try {
    out.hold = await world.hold({ charger, payment_intent: pi.id, amount_cents: pi.amount_capturable });
    bound().set(pi.id, out.hold);
  } catch (e) {
    out.hold_error = describe(e);
  }
  return out;
}
