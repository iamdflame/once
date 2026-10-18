// The proof: what Stripe actually did, next to what the world decided.
import "server-only";
import { recentCaptures, type CaptureRecord } from "./settle";
import { stripe, dashboardUrl } from "./stripe";
import { world, type SuiteReport, type WorldHold } from "./world";
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

const eur = (c: unknown) => `€${(Number(c ?? 0) / 100).toFixed(2)}`;
const who = (d: unknown) => (d ? `Driver ${String(d)}` : "an unpaid session");

/** One plain sentence per capture attempt: who was charged, for whose energy, and what Stripe said. */
/** Stripe's message without the unclaimed-test-sandbox preamble (the rest is Stripe's words, untouched). */
const stripeWords = (m: unknown) => String(m ?? "").replace(/^This is an unclaimed Stripe sandbox\.[^.]*\.\s*/, "");

export function captureStory(a: Record<string, unknown>): string {
  const payer = who(a.driver);
  const energy = a.energy_driver ? `${who(a.energy_driver)}'s energy` : a.energy_episode_id ? `the energy of ${String(a.energy_episode_id)}` : "energy the world could not attribute";
  const action = String(a.action ?? "capture");
  if (action === "rejected") return `${payer}'s hold: the host refused the intent (${String(a.error ?? "invalid")})`;
  if (action === "release") return a.ok ? `${payer}'s hold was released in full (no energy); Stripe: canceled` : `${payer}'s hold: release refused by Stripe: ${String(a.error ?? a.status)}`;
  if (a.ok) return `${payer} was charged ${eur(a.amount_cents)} for ${energy}; Stripe: ${String(a.status ?? "succeeded")}`;
  if (a.error) return `${payer}'s hold: a capture of ${eur(a.amount_cents)} for ${energy} was refused by Stripe: ${stripeWords(a.error)}`;
  return `${payer}'s hold: a capture of ${eur(a.amount_cents)} for ${energy} is ${String(a.status ?? "pending")}`;
}

export async function buildProof(opts: { verify?: boolean } = {}) {
  const host = recentCaptures(200);

  // The world remembers every intent and the result we reported, across host restarts.
  let worldIntents: Record<string, unknown>[] = [];
  let worldError: string | undefined;
  let settle: Record<string, unknown> | null = null;
  let worldHolds: WorldHold[] = [];
  try {
    const [intents, st] = await Promise.all([world.allIntents(), world.state(0) as Promise<{ holds?: WorldHold[] }>]);
    worldIntents = intents as Record<string, unknown>[];
    worldHolds = st?.holds ?? [];
  } catch (e) {
    worldError = describe(e);
  }
  const holdByPi = new Map(worldHolds.map((h) => [h.payment_intent, h]));
  try {
    const s = await world.getSettle();
    settle = { ...s };
  } catch {}

  // Keyed by (PaymentIntent, world intent id): the world's ids restart at in_00001 after a
  // /reset, while this host's ledger remembers the attempts from before it.
  const key = (pi: unknown, id: unknown) => `${String(pi ?? "")}|${String(id ?? "")}`;
  const byId = new Map<string, CaptureRecord | Record<string, unknown>>();
  for (const i of worldIntents) {
    // Only intents that reached the host (or should have): not rejected/suppressed ones.
    if (i.status === "rejected" || i.status === "suppressed") continue;
    const res = (i.result ?? null) as { ok?: boolean; status?: string; error?: unknown; stripe_object?: unknown } | null;
    const err = res?.error;
    byId.set(key(i.payment_intent, i.id), {
      ...i,
      world_status: i.status,
      at: typeof i.created_at === "number" ? new Date(i.created_at).toISOString() : i.created_at,
      action: i.kind === "release" ? "release" : "capture",
      ok: res?.ok ?? false,
      status: res?.status ?? i.status,
      error: err == null ? null : typeof err === "string" ? err : ((err as { message?: string }).message ?? JSON.stringify(err)),
      stripe_object: res?.stripe_object,
      reported: !!res,
    });
  }
  for (const r of host) byId.set(key(r.payment_intent, r.id), { ...(byId.get(key(r.payment_intent, r.id)) ?? {}), ...r });
  const attempts = [...byId.values()] as Record<string, unknown>[];

  // Ask Stripe for the truth about each hold: every hold the world bound (a stranded one has
  // no attempts at all), newest first, then any PaymentIntent the attempts mention.
  const pis = [
    ...new Set([...worldHolds.map((h) => h.payment_intent).reverse(), ...attempts.map((a) => String(a.payment_intent ?? ""))].filter((p) => p.startsWith("pi_"))),
  ].slice(0, 25);
  const holds: Record<string, unknown>[] = [];
  if (opts.verify !== false && pis.length) {
    await Promise.all(
      pis.map(async (id) => {
        try {
          const pi = await stripe().paymentIntents.retrieve(id);
          const mine = attempts.filter((a) => a.payment_intent === id);
          const wh = holdByPi.get(id);
          holds.push({
            payment_intent: id,
            driver: wh?.driver ?? pi.metadata?.driver ?? null,
            seq: wh?.seq ?? null,
            episode_id: wh?.episode_id ?? null,
            stranded: !!wh?.stranded && pi.status === "requires_capture",
            captured_for: wh?.captured_for ?? null,
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
    .filter((a) => a.action !== "rejected" && a.reported)
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
      driver: (a.driver as string | null) ?? holdByPi.get(String(a.payment_intent))?.driver ?? null,
      energy_driver: (a.energy_driver as string | null) ?? null,
      energy_episode_id: (a.energy_episode_id as string | null) ?? null,
      wrong_driver: (a.wrong_driver as boolean | null) ?? null,
      story: captureStory({ ...a, driver: a.driver ?? holdByPi.get(String(a.payment_intent))?.driver }),
    }));

  // Per driver: each hold the world bound, what was captured on it and for whose energy.
  const stripeByPi = new Map(holds.map((h) => [String(h.payment_intent), h]));
  const drivers = worldHolds.map((h) => {
    const s = stripeByPi.get(h.payment_intent);
    const status = String(s?.status ?? h.status);
    const received = Number(s?.amount_received ?? h.amount_captured ?? 0);
    const cf = h.captured_for ?? null;
    const stranded = !!h.stranded && status === "requires_capture";
    const story = stranded
      ? `${who(h.driver)}'s ${eur(h.amount_cents)} hold is stranded: the session ended and nothing was captured on it (Stripe: requires_capture)`
      : status === "succeeded"
        ? `${who(h.driver)} paid ${eur(received)}${cf ? ` for ${cf.driver ? who(cf.driver) + "'s" : String(cf.episode_id) + "'s"} energy` : ""}${cf?.wrong_driver ? " (not their own session)" : ""}; Stripe: succeeded`
        : status === "canceled"
          ? `${who(h.driver)}'s hold was released in full; Stripe: canceled`
          : `${who(h.driver)}'s ${eur(h.amount_cents)} hold is authorised and waiting${h.episode_id ? ` (${h.episode_id} in progress)` : " for the next plug-in"}`;
    return {
      driver: h.driver ?? null,
      seq: h.seq ?? null,
      charger: h.charger,
      payment_intent: h.payment_intent,
      episode_id: h.episode_id ?? null,
      amount_authorized: h.amount_cents,
      amount_received: received,
      status,
      stranded,
      charged_for_driver: cf?.driver ?? null,
      charged_for_episode: cf?.episode_id ?? null,
      wrong_driver: cf?.wrong_driver ?? null,
      verified_by_stripe: !!s && !s.error,
      dashboard_url: dashboardUrl(h.payment_intent),
      story,
    };
  });
  const w = cachedWorldInfo();
  const local = !!env.worldUrl();
  const sandbox = {
    provider: local ? "local" : "CreateOS",
    name: local ? "local world (WORLD_URL)" : WORLD_SANDBOX.name,
    rootfs: local ? "host node" : WORLD_SANDBOX.rootfs,
    egress: local ? [] : (w?.sandbox?.egress ?? [...WORLD_SANDBOX.egress]),
    keys_inside: [] as string[],
    state: local ? "running" : (w?.sandbox?.status ?? "absent"),
    creates_used: w?.creates_used_24h !== undefined ? `${w.creates_used_24h}/${w.creates_limit_24h} in 24 h` : undefined,
  };

  return {
    at: new Date().toISOString(),
    captures,
    sandbox,
    // The preview URL stays private: the world API has no host key yet (see /security).
    world: w ? { ...w, url: undefined } : null,
    world_error: worldError,
    settle,
    attempts: attempts.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? ""))),
    holds,
    drivers,
    suite: g.__onceSuites?.at(-1) ?? null,
    suites: [...(g.__onceSuites ?? [])].reverse(),
  };
}
