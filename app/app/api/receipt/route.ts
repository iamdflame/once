// GET /api/receipt: the run receipt, a JSON a third party can check against Stripe.
// The sha256 of the deployed settle.js (the world's and one the host computes itself),
// the latest suite summary, and every capture with its PaymentIntent id, idempotency
// key and status.
import { createHash } from "node:crypto";
import { buildProof } from "@/lib/proof";
import { route } from "@/lib/errors";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  return route(async () => {
    const p = await buildProof({ verify: true });
    const settle = p.settle ?? {};
    const source = typeof settle.source === "string" ? settle.source : "";
    const key = env.stripeSecret();
    const origin = new URL(req.url).origin;
    const body = {
      receipt: "once-run-receipt",
      schema: 1,
      generated_at: p.at,
      app: origin,
      stripe_mode: !key ? "missing" : /^[a-z]+_test_/.test(key) ? "test" : "other",
      settle: {
        deploy: settle.version ?? null,
        name: settle.name ?? null,
        bytes: source.length,
        sha256_reported_by_world: settle.sha256 ?? null,
        sha256_computed_by_host: source ? createHash("sha256").update(source, "utf8").digest("hex") : null,
      },
      suite: p.suite
        ? {
            ran_at: p.suite.at,
            source: p.suite.source,
            label: p.suite.label ?? null,
            deploy: p.suite.version ?? null,
            totals: p.suite.totals,
            scenarios: p.suite.scenarios.map((s) => ({
              seed: s.seed,
              name: s.name ?? null,
              faults: s.faults ?? null,
              ok: s.ok,
              double: s.double,
              stranded: s.stranded,
              unbilled: s.unbilled,
              overbilled: s.overbilled ?? 0,
              underbilled: s.underbilled ?? 0,
            })),
          }
        : null,
      captures: p.attempts.map((a) => ({
        at: a.at ?? null,
        world_intent: a.id ?? null,
        episode_id: a.episode_id ?? null,
        charger: a.charger ?? null,
        payment_intent: a.payment_intent ?? null,
        amount_cents: a.amount_cents ?? null,
        action: a.action ?? null,
        ok: a.ok ?? null,
        status: a.status ?? null,
        idempotency_key: a.idempotency_key ?? null,
        stripe_request_id: a.request_id ?? null,
        stripe_error: a.error ?? null,
        replayed: a.replayed ?? null,
        dashboard_url: typeof a.payment_intent === "string" ? `https://dashboard.stripe.com/test/payments/${a.payment_intent}` : null,
      })),
      holds_as_stripe_reports_them: p.holds,
      sandbox: p.sandbox,
      world_error: p.world_error ?? null,
      how_to_check: [
        "Every payment_intent above is a Stripe test-mode object: `stripe payment_intents retrieve <pi> --api-key sk_test_...` (the sandbox's key) shows amount, amount_received and amount_capturable.",
        "Exactly-once: for each payment_intent, at most one entry has action capture and ok true; any further capture entry carries Stripe's own refusal in stripe_error.",
        "Idempotency: a repeated entry with the same idempotency_key and replayed true is a replay of Stripe's stored answer, not a second capture.",
        "The program: GET /api/world/settle returns the deployed settle.js; sha256 it and compare with sha256_computed_by_host.",
      ],
    };
    const name = `once-run-receipt-${p.at.replace(/[:.]/g, "-")}.json`;
    return new Response(JSON.stringify(body, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
      },
    });
  });
}
