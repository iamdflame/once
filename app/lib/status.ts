// /status: outcomes, not HTTP 200. Each check is asserted against the world, the
// sandbox and Stripe when the page asks; red when the world cannot be reached or
// no suite has run.
import "server-only";
import { world } from "./world";
import { cachedWorldInfo, WORLD_SANDBOX } from "./createos";
import { buildProof } from "./proof";
import { env } from "./env";
import { describe } from "./errors";

export type CheckState = "ok" | "warn" | "fail";

export type Check = {
  id: string;
  label: string;
  state: CheckState;
  /** One line, the outcome. */
  value: string;
  /** What the check means or how to read it. */
  detail?: string;
  /** When the thing being reported happened (ISO), if it has a time. */
  at?: string | null;
  age_s?: number | null;
  url?: string;
};

export type Status = {
  at: string;
  overall: CheckState;
  checks: Check[];
  ms: number;
};

type J = Record<string, unknown>;
const obj = (x: unknown): J => (x && typeof x === "object" && !Array.isArray(x) ? (x as J) : {});
const num = (x: unknown, d = 0): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const ageOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
};

export async function buildStatus(): Promise<Status> {
  const t0 = Date.now();
  const checks: Check[] = [];
  const local = !!env.worldUrl();

  // The world: does it answer, and with what.
  let health: J | null = null;
  let healthErr: string | undefined;
  try {
    health = obj(await world.health());
  } catch (e) {
    healthErr = describe(e);
  }
  const reachable = !!health && health.ok !== false;
  const info = cachedWorldInfo();
  checks.push({
    id: "world",
    label: "World",
    state: reachable ? "ok" : "fail",
    value: reachable
      ? `answering · ${num(health?.online)}/${num(health?.chargers, 12)} chargers online · settle.js deploy #${num(health?.settle_version, 1)}`
      : `unreachable${healthErr ? `: ${healthErr}` : ""}`,
    detail: local ? "a local world on the host machine (WORLD_URL)" : info?.url ? `GET /health at ${info.url}` : "the CSMS, twelve chargers, the link proxies and settle.js, one process in the sandbox",
  });

  // The sandbox: running or paused, no internet, creates against the plan.
  const sb = info?.sandbox;
  checks.push({
    id: "sandbox",
    label: "Sandbox",
    state: local ? "warn" : sb?.status === "running" ? "ok" : sb?.status === "paused" ? "warn" : "fail",
    value: local ? "not sandboxed: local world (development only)" : sb ? `${sb.name ?? WORLD_SANDBOX.name} · ${sb.status} · ${WORLD_SANDBOX.rootfs} · ${WORLD_SANDBOX.shape}` : "no sandbox known to this host",
    detail: sb ? `CreateOS via Stripe Projects. Auto-pauses after ${sb.auto_pause_after_seconds ?? WORLD_SANDBOX.autoPauseSeconds} s idle; a paused box resumes on the next call with its state intact.` : reachable ? undefined : "the host could not ensure a sandbox; see the World row",
    at: sb?.created_at ?? null,
    age_s: ageOf(sb?.created_at),
  });

  const egress = local ? null : (sb?.egress ?? null);
  const sinkholed = Array.isArray(egress) && egress.length === 1 && egress[0] === WORLD_SANDBOX.egress[0];
  checks.push({
    id: "egress",
    label: "Egress",
    state: local ? "warn" : egress === null ? "warn" : sinkholed ? "ok" : "fail",
    value: local ? "open (local world on the host)" : egress === null ? "not read yet" : egress.length === 0 ? "EMPTY ALLOWLIST: open to the internet" : `allowlist [${egress.join(", ")}]${sinkholed ? " · no internet" : " · more than the sinkhole"}`,
    detail: "The list must contain exactly one sinkhole entry. An empty list would mean open. The host re-asserts it on every ensure.",
  });

  const used = info?.creates_used_24h;
  const limit = info?.creates_limit_24h ?? WORLD_SANDBOX.createsPer24h;
  checks.push({
    id: "creates",
    label: "Sandbox creates",
    state: local ? "warn" : used === undefined ? "warn" : used >= limit ? "fail" : used >= limit - 2 ? "warn" : "ok",
    value: local ? "none (local world)" : used === undefined ? "not counted yet by this host" : `${used} of ${limit} in the last 24 h`,
    detail: "Free plan: one concurrent sandbox, ten creates per rolling 24 h. The box is reused by name and never destroyed by the host.",
  });

  // What Stripe did last, and when.
  let proof: Awaited<ReturnType<typeof buildProof>> | null = null;
  let proofErr: string | undefined;
  try {
    proof = await buildProof({ verify: false });
  } catch (e) {
    proofErr = describe(e);
  }
  const caps = [...(proof?.captures ?? [])].sort((a, b) => b.t - a.t);
  const last = caps[0];
  const lastAt = last?.t ? new Date(last.t).toISOString() : null;
  checks.push({
    id: "capture",
    label: "Last capture",
    state: last ? "ok" : "warn",
    value: last
      ? `${last.status === "succeeded" ? "captured once" : last.status === "refused" ? "refused by Stripe" : last.status === "canceled" ? "released" : last.status} · €${(last.amount_cents / 100).toFixed(2)} on ${last.charger || "?"} · ${last.payment_intent}`
      : proofErr
        ? `unknown: ${proofErr}`
        : "none yet in this world",
    detail: last ? `idempotency key ${last.idempotency_key || "—"}${last.error ? ` · ${last.error}` : ""}` : "Pay a €50 hold on the board, cut the cable, unplug, restore.",
    at: lastAt,
    age_s: ageOf(lastAt),
    url: last?.url,
  });

  // The last suite: from this host's memory, else from the world itself.
  let suiteAt: string | null = proof?.suite?.at ?? null;
  let passed: number | null = null;
  let count: number | null = null;
  let version: string | number | undefined = proof?.suite?.version;
  if (proof?.suite) {
    passed = num(proof.suite.totals?.ok);
    count = num(proof.suite.totals?.count);
  } else if (reachable) {
    try {
      const r = obj(await world.lastSuite());
      const rep = obj(r.report);
      if (Array.isArray(rep.scenarios) && rep.scenarios.length) {
        const tot = obj(rep.totals);
        passed = num(tot.passed, rep.scenarios.filter((s) => obj(s).ok).length);
        count = num(tot.scenarios, rep.scenarios.length);
        version = (rep.settle_version ?? rep.version) as string | number | undefined;
        const at = rep.ran_at ?? rep.at ?? rep.finished_at;
        suiteAt = typeof at === "number" ? new Date(at).toISOString() : typeof at === "string" ? at : null;
      }
    } catch {
      /* no last suite in the world */
    }
  }
  const ran = passed !== null && count !== null;
  checks.push({
    id: "suite",
    label: "Last suite",
    state: !ran ? "fail" : passed === count ? "ok" : "warn",
    value: !ran ? "no suite has run" : `${passed}/${count} green · settle.js deploy #${version ?? "?"}`,
    detail: !ran ? "Run the storm on the bench: 30 seeded fault scenarios against the deployed settle.js, inside the sandbox." : passed === count ? "stranded 0 · double 0 · unbilled 0 on every seed" : "Red seeds: the deployed program still double-captures or strands a hold. Fix it on the bench.",
    at: suiteAt,
    age_s: ageOf(suiteAt),
  });

  // Stripe: test keys only.
  const key = env.stripeSecret();
  const mode = !key ? "missing" : /^[a-z]+_test_/.test(key) ? "test" : /^[a-z]+_live_/.test(key) ? "live" : "unknown";
  checks.push({
    id: "stripe",
    label: "Stripe",
    state: mode === "test" ? "ok" : "fail",
    value: mode === "test" ? "test mode" : mode === "missing" ? "no secret key on the host" : mode === "live" ? "a live key is set: the host refuses it" : "unrecognised key",
    detail: "Every hold, capture and refusal is a test object. The host refuses live keys by construction.",
  });

  const overall: CheckState = checks.some((c) => c.state === "fail") ? "fail" : checks.some((c) => c.state === "warn") ? "warn" : "ok";
  return { at: new Date().toISOString(), overall, checks, ms: Date.now() - t0 };
}
