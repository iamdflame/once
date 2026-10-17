// Typed client for the world's HTTP API (world/README.md). The host never runs
// settlement code itself; it only talks to the world over HTTP.
import "server-only";
import { ensureWorld, invalidateWorldCache, worldBaseUrl } from "./createos";
import { env, HttpError } from "./env";

export type CaptureIntent = {
  intent_id: string;
  episode_id: string;
  charger: string;
  payment_intent: string;
  amount_cents: number;
  [k: string]: unknown;
};

export type IntentResult = {
  ok: boolean;
  status: string; // Stripe's PaymentIntent status, or "error"
  error?: string | null; // Stripe's message, verbatim
  stripe_object?: unknown;
};

export type ScenarioResult = {
  seed: number;
  faults?: unknown;
  double: number;
  stranded: number;
  unbilled: number;
  overbilled?: number;
  ok: boolean;
  [k: string]: unknown;
};

export type SuiteTotals = { double: number; stranded: number; unbilled: number; overbilled: number; ok: number; failed: number; count: number };

/** The suite report as the host returns it (matches the UI's SuiteReport; `raw` is the world's own JSON). */
export type SuiteReport = {
  version?: number | string;
  ran_at: number;
  scenarios: ScenarioResult[];
  totals: SuiteTotals;
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

  async pendingIntents(): Promise<CaptureIntent[]> {
    return arr<CaptureIntent>(await worldFetch("/intents?pending=1"), "intents", "pending", "items");
  },
  async allIntents(): Promise<unknown[]> {
    return arr(await worldFetch("/intents"), "intents", "items");
  },
  reportResult: (intentId: string, result: IntentResult) =>
    worldFetch(`/intents/${encodeURIComponent(intentId)}/result`, { body: result }),

  getSettle: () => worldFetch<{ source: string; version?: number | string; [k: string]: unknown }>("/settle"),
  putSettle: (source: string) => worldFetch<{ ok?: boolean; version?: number | string; error?: string; [k: string]: unknown }>("/settle", { method: "PUT", text: source }),

  async suite(body: { count?: number; seed?: number } = {}): Promise<SuiteReport> {
    const raw = await worldFetch<unknown>("/suite", { body: { count: 30, ...body }, timeoutMs: 180_000 });
    return normalizeSuite(raw);
  },
};

export function normalizeSuite(raw: unknown): SuiteReport {
  const scenarios = arr<ScenarioResult>(raw, "scenarios", "results", "runs").map((s) => ({
    ...s,
    double: Number(s.double ?? 0),
    stranded: Number(s.stranded ?? 0),
    unbilled: Number(s.unbilled ?? 0),
    overbilled: Number(s.overbilled ?? 0),
    ok: s.ok ?? (!s.double && !s.stranded && !s.unbilled && !s.overbilled),
  }));
  const sum = (k: "double" | "stranded" | "unbilled" | "overbilled") => scenarios.reduce((a, s) => a + Number(s[k] ?? 0), 0);
  const passed = scenarios.filter((s) => s.ok).length;
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    version: (r.version ?? r.settle_version) as number | string | undefined,
    ran_at: Date.now(),
    scenarios,
    totals: {
      double: sum("double"),
      stranded: sum("stranded"),
      unbilled: sum("unbilled"),
      overbilled: sum("overbilled"),
      ok: passed,
      failed: scenarios.length - passed,
      count: scenarios.length,
    },
    raw,
  };
}
