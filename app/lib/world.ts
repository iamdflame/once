// Typed client for the world's HTTP API (world/README.md). The host never runs
// settlement code itself; it only talks to the world over HTTP.
import "server-only";
import { ensureWorld, invalidateWorldCache, worldBaseUrl } from "./createos";
import { env, HttpError } from "./env";

/** A world intent (world/README.md "Intents"). `id` is the world's; `intent_id` is settle.js's own. */
export type CaptureIntent = {
  id: string;
  intent_id: string;
  episode_id: string;
  charger: string;
  payment_intent: string;
  amount_cents: number;
  kind?: "capture" | "release";
  status?: string;
  settle_version?: number;
  [k: string]: unknown;
};

export type IntentResult = {
  ok: boolean;
  status: string; // the PaymentIntent's status after the call, or "error"
  error?: { message: string; code?: string | null; type?: string } | string | null; // Stripe's error, verbatim
  stripe_object?: unknown;
};

export type ScenarioResult = {
  seed: number;
  faults?: unknown;
  double: number;
  stranded: number;
  unbilled: number;
  overbilled?: number;
  underbilled?: number;
  invalid?: number;
  ok: boolean;
  notes?: string[];
  [k: string]: unknown;
};

export type SuiteTotals = {
  double: number;
  stranded: number;
  unbilled: number;
  overbilled: number;
  underbilled: number;
  invalid: number;
  ok: number; // scenarios passed
  failed: number;
  count: number;
};

/** The suite report as the host returns it (matches the UI's SuiteReport; `raw` is the world's own JSON). */
export type SuiteReport = {
  version?: number | string;
  ran_at: number;
  scenarios: ScenarioResult[];
  totals: SuiteTotals;
  summary?: string;
  raw?: unknown;
};

type Init = { method?: string; body?: unknown; text?: string; timeoutMs?: number };

async function call(base: string, p: string, init: Init) {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.text !== undefined) {
    headers["content-type"] = "text/javascript; charset=utf-8";
    body = init.text;
  } else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  return fetch(base + p, {
    method: init.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
  });
}

/** Call the world; on a network failure in CreateOS mode, re-ensure (resume a paused box) and retry once. */
export async function worldFetch<T = unknown>(p: string, init: Init = {}): Promise<T> {
  let base = await worldBaseUrl();
  let res: Response;
  try {
    res = await call(base, p, init);
  } catch (e) {
    if (env.worldUrl()) throw new HttpError(503, `world unreachable at ${base}: ${(e as Error).message}`);
    invalidateWorldCache();
    const info = await ensureWorld();
    if (!info.healthy) throw new HttpError(503, "world unreachable after ensure", info);
    base = info.url;
    res = await call(base, p, init);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && ("error" in data ? (data as { error: unknown }).error : (data as { message?: unknown }).message)) ||
      text ||
      `HTTP ${res.status}`;
    throw new HttpError(res.status, `world ${init.method ?? "GET"} ${p}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, data);
  }
  return data as T;
}

function arr<T>(x: unknown, ...keys: string[]): T[] {
  if (Array.isArray(x)) return x as T[];
  if (x && typeof x === "object") {
    for (const k of keys) {
      const v = (x as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

export const world = {
  health: () => worldFetch("/health", { timeoutMs: 5000 }),
  state: () => worldFetch("/state"),
  events: (since?: string | number) => worldFetch(`/events${since !== undefined && since !== "" ? `?since=${encodeURIComponent(String(since))}` : ""}`),
  cmd: (body: Record<string, unknown>) => worldFetch("/cmd", { body }),
  hold: (body: { charger: string; payment_intent: string; amount_cents: number }) => worldFetch("/hold", { body }),

  /** Pending or in-flight intents (read-only view). */
  async pendingIntents(): Promise<CaptureIntent[]> {
    return arr<CaptureIntent>(await worldFetch("/intents?pending=1"), "intents");
  },
  /** Atomically lease pending intents so overlapping ticks never execute one twice. */
  async claimIntents(limit = 50, leaseMs = 20_000): Promise<CaptureIntent[]> {
    return arr<CaptureIntent>(await worldFetch("/intents/claim", { body: { limit, lease_ms: leaseMs } }), "intents");
  },
  /** The last 200 intents of any status, with the host's reported results. */
  async allIntents(): Promise<CaptureIntent[]> {
    return arr<CaptureIntent>(await worldFetch("/intents"), "intents");
  },
  /** `worldId` is the world's intent id (`in_00001`), not settle.js's intent_id. */
  reportResult: (worldId: string, result: IntentResult) =>
    worldFetch(`/intents/${encodeURIComponent(worldId)}/result`, { body: result }),

  getSettle: () => worldFetch<{ source: string; version?: number; name?: string; sha256?: string; [k: string]: unknown }>("/settle"),
  putSettle: (source: string, name?: string) =>
    worldFetch<{ ok?: boolean; version?: number; name?: string; sha256?: string; error?: string }>("/settle", {
      method: "PUT",
      body: { source, ...(name ? { name } : {}) },
    }),
  validateSettle: (source: string) => worldFetch<{ ok: boolean; error?: string | null; sha256?: string }>("/settle/validate", { body: { source } }),

  /** Run the seeded suite on the deployed settle.js, or dry-run `source` without deploying it. */
  async suite(body: { count?: number; seed?: number; seeds?: number[]; source?: string } = {}): Promise<SuiteReport> {
    const raw = await worldFetch<unknown>("/suite", { body: { count: 30, ...body }, timeoutMs: 180_000 });
    return normalizeSuite(raw);
  },
  /** One seed with the full event feed settle.js saw (the debugging view). */
  trace: (seed: number, source?: string) => worldFetch<{ ok: boolean; report: Record<string, unknown> }>("/suite/trace", { body: { seed, ...(source ? { source } : {}) }, timeoutMs: 60_000 }),
  lastSuite: () => worldFetch<{ ok: boolean; report: unknown }>("/suite/last"),
  reset: (body: { settle?: "v1" } = {}) => worldFetch("/reset", { body }),
};

export function normalizeSuite(raw: unknown): SuiteReport {
  const scenarios = arr<ScenarioResult>(raw, "scenarios").map((s) => ({
    ...s,
    double: Number(s.double ?? 0),
    stranded: Number(s.stranded ?? 0),
    unbilled: Number(s.unbilled ?? 0),
    overbilled: Number(s.overbilled ?? 0),
    underbilled: Number(s.underbilled ?? 0),
    invalid: Number(s.invalid ?? 0),
    ok: s.ok ?? (!s.double && !s.stranded && !s.unbilled && !s.overbilled && !s.underbilled && !s.invalid),
  }));
  const sum = (k: "double" | "stranded" | "unbilled" | "overbilled" | "underbilled" | "invalid") =>
    scenarios.reduce((a, s) => a + Number(s[k] ?? 0), 0);
  const passed = scenarios.filter((s) => s.ok).length;
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    version: (r.settle_version ?? r.version) as number | string | undefined,
    ran_at: Date.now(),
    summary: typeof r.summary === "string" ? r.summary : undefined,
    scenarios,
    totals: {
      double: sum("double"),
      stranded: sum("stranded"),
      unbilled: sum("unbilled"),
      overbilled: sum("overbilled"),
      underbilled: sum("underbilled"),
      invalid: sum("invalid"),
      ok: passed,
      failed: scenarios.length - passed,
      count: scenarios.length,
    },
    raw,
  };
}
