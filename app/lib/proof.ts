// The proof: what Stripe actually did, next to what the world decided.
import "server-only";
import { recentCaptures, type CaptureRecord } from "./settle";
import { stripe, dashboardUrl } from "./stripe";
import { world, type SuiteReport } from "./world";
import { cachedWorldInfo, WORLD_SANDBOX } from "./createos";
import { env } from "./env";
import { describe } from "./errors";

type SuiteRecord = { at: string; source: "agent" | "suite"; label?: string; version?: string | number; totals: SuiteReport["totals"]; scenarios: SuiteReport["scenarios"] };

const g = globalThis as unknown as { __onceSuites?: SuiteRecord[] };

export function recordSuite(r: SuiteReport, source: SuiteRecord["source"], label?: string) {
  const list = (g.__onceSuites ??= []);
  list.push({ at: new Date().toISOString(), source, label, version: r.version, totals: r.totals, scenarios: r.scenarios });
  if (list.length > 20) list.splice(0, list.length - 20);
}

export async function buildProof(opts: { verify?: boolean } = {}) {
  const host = recentCaptures(200);

  // The world remembers every intent and the result we reported, across host restarts.
  let worldIntents: Record<string, unknown>[] = [];
  let worldError: string | undefined;
  let settle: Record<string, unknown> | null = null;
  try {
    worldIntents = (await world.allIntents()) as Record<string, unknown>[];
  } catch (e) {
    worldError = describe(e);
  }
  try {
    const s = await world.getSettle();
    settle = { ...s };
  } catch {}

  const byId = new Map<string, CaptureRecord | Record<string, unknown>>();
  for (const i of worldIntents) byId.set(String(i.intent_id), { ...i });
  for (const r of host) byId.set(r.intent_id, { ...(byId.get(r.intent_id) ?? {}), ...r });
  const attempts = [...byId.values()] as Record<string, unknown>[];

  // Ask Stripe for the truth about each hold.
  const pis = [...new Set(attempts.map((a) => String(a.payment_intent ?? "")).filter((p) => p.startsWith("pi_")))].slice(0, 25);
  const holds: Record<string, unknown>[] = [];
  if (opts.verify !== false && pis.length) {
    await Promise.all(
      pis.map(async (id) => {
        try {
          const pi = await stripe().paymentIntents.retrieve(id);
          const mine = attempts.filter((a) => a.payment_intent === id);
          holds.push({
            payment_intent: id,
            status: pi.status,
            amount_authorized: pi.amount,
            amount_received: pi.amount_received,
            amount_capturable: pi.amount_capturable,
            currency: pi.currency,
            charger: pi.metadata?.charger ?? mine[0]?.charger,
            latest_charge: typeof pi.latest_charge === "string" ? pi.latest_charge : (pi.latest_charge?.id ?? null),
            dashboard_url: dashboardUrl(id),
            capture_attempts: mine.length,
            captures_succeeded: mine.filter((a) => a.ok && a.action !== "release").length,
            refusals: mine.filter((a) => !a.ok && a.error).map((a) => a.error),
          });
        } catch (e) {
          holds.push({ payment_intent: id, error: describe(e) });
        }
      }),
    );
  }

  // UI-shaped views (components/data/types.ts: Capture, SandboxInfo).
  const authorized = new Map(holds.map((h) => [String(h.payment_intent), Number(h.amount_authorized ?? 0)]));
  const captures = attempts
    .filter((a) => a.action !== "rejected" && (a.status || a.error))
    .map((a) => ({
      payment_intent: String(a.payment_intent ?? ""),
      charger: String(a.charger ?? ""),
      episode_id: String(a.episode_id ?? ""),
      amount_cents: Number(a.amount_cents ?? 0),
      authorized_cents: authorized.get(String(a.payment_intent)) ?? 5000,
      status: a.ok ? (a.action === "release" ? "canceled" : "succeeded") : a.error ? "refused" : String(a.status ?? "requires_capture"),
      idempotency_key: String(a.idempotency_key ?? ""),
      t: Date.parse(String(a.at ?? "")) || 0,
      error: (a.error as string | null) ?? undefined,
      url: dashboardUrl(String(a.payment_intent ?? "")),
    }));
  const w = cachedWorldInfo();
  const local = !!env.worldUrl();
  const sandbox = {
    provider: local ? "local" : "CreateOS",
    name: local ? "local world (WORLD_URL)" : WORLD_SANDBOX.name,
    rootfs: local ? "host node" : WORLD_SANDBOX.rootfs,
    egress: local ? [] : (w?.sandbox?.egress ?? [...WORLD_SANDBOX.egress]),
    keys_inside: [] as string[],
    state: local ? "running" : (w?.sandbox?.status ?? "absent"),
    preview: w?.url,
    creates_used: w?.creates_used_24h !== undefined ? `${w.creates_used_24h}/${w.creates_limit_24h} in 24 h` : undefined,
  };

  return {
    at: new Date().toISOString(),
    captures,
    sandbox,
    world: cachedWorldInfo() ?? null,
    world_error: worldError,
    settle,
    attempts: attempts.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? ""))),
    holds,
    suite: g.__onceSuites?.at(-1) ?? null,
    suites: [...(g.__onceSuites ?? [])].reverse(),
  };
}
