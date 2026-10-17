// CreateOS orchestration for the world sandbox.
//
// One long-lived sandbox named "once-world" holds the whole world (CSMS, fleet, link
// proxies, scenario runner). It has no internet: its egress allowlist is a single
// sinkhole entry (an empty list would mean "open"). The host reaches it only through
// the sandbox's ingress preview URL on port 8080.
//
// Quota (free plan): 1 concurrent sandbox, 10 creates per rolling 24 h. So we reuse the
// box by name, resume it when paused, let it auto-pause when idle, and never create in
// a loop: creates are counted from the API's own sandbox list (created_at in the last
// 24 h, destroyed boxes included) and refused locally before the server would.
import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CreateosSandboxClient,
  CreateosSandboxApiError,
  CreateosSandboxError,
  type Sandbox,
} from "@nodeops-createos/sandbox";
import { env, HttpError } from "./env";

export const WORLD_SANDBOX = {
  name: "once-world", // max 22 characters
  shape: "s-1vcpu-1gb",
  rootfs: "devbox:1",
  egress: ["sinkhole.invalid"], // one sinkhole entry = no internet; [] would mean open
  port: 8080,
  dir: "/tmp/once",
  autoPauseSeconds: 600, // pause after 10 min idle (60-86400 allowed)
  createsPer24h: 10,
} as const;

const DEAD = new Set(["destroyed", "destroying", "failed", "error"]);

export type WorldInfo = {
  mode: "local" | "createos";
  url: string;
  healthy: boolean;
  sandbox?: {
    id: string;
    name?: string;
    status: string;
    egress?: string[];
    created_at?: string;
    auto_pause_after_seconds?: number;
  };
  actions: string[]; // what this ensure did: found, created, resumed, uploaded, started...
  creates_used_24h?: number;
  creates_limit_24h?: number;
  bundle_sha?: string;
  ms: number;
};

type Cache = { info: WorldInfo; at: number };
const g = globalThis as unknown as {
  __onceWorldCache?: Cache;
  __onceWorldEnsure?: Promise<WorldInfo>;
  __onceLastCreateAt?: number;
};

function log(msg: string, extra?: unknown) {
  console.log(`[once/createos] ${msg}${extra === undefined ? "" : " " + JSON.stringify(extra)}`);
}

function client(): CreateosSandboxClient {
  const apiKey = env.createosKey();
  if (!apiKey) throw new HttpError(500, "missing CREATEOS_PROJECT_API_KEY (or CREATEOS_SANDBOX_API_KEY)");
  const baseUrl = env.createosBaseUrl();
  return new CreateosSandboxClient(baseUrl ? { apiKey, baseUrl } : { apiKey });
}

export function describeCreateosError(e: unknown): string {
  if (e instanceof CreateosSandboxApiError) {
    return `${e.name} ${e.statusCode}${e.code ? " " + e.code : ""}: ${e.message}${e.requestId ? ` (request ${e.requestId})` : ""}`;
  }
  if (e instanceof CreateosSandboxError || e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

// ---------- world bundle ----------

async function loadBundle(): Promise<{ bytes: Buffer; sha: string; file: string } | null> {
  const candidates = [
    env.worldBundle(),
    path.resolve(process.cwd(), "..", "world", "dist", "world.cjs"),
    path.resolve(process.cwd(), "world", "dist", "world.cjs"),
  ].filter(Boolean) as string[];
  for (const file of candidates) {
    try {
      const bytes = await readFile(file);
      return { bytes, sha: createHash("sha256").update(bytes).digest("hex"), file };
    } catch {
      /* try next */
    }
  }
  return null;
}

// ---------- health ----------

async function probe(url: string, timeoutMs = 4000): Promise<{ ok: boolean; tls?: boolean; error?: string }> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    return { ok: r.ok, error: r.ok ? undefined : `HTTP ${r.status}` };
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    const msg = `${cause?.code ?? ""} ${cause?.message ?? (e as Error)?.message ?? e}`;
    const tls = /CERT|SSL|TLS|self[- ]signed|verify/i.test(msg);
    return { ok: false, tls, error: msg.trim() };
  }
}

/** Prefer https; fall back to plain http when the ingress certificate is self-signed or not provisioned yet. */
async function resolveUrl(sb: Sandbox): Promise<{ url: string; healthy: boolean; error?: string }> {
  const https = sb.previewUrl(WORLD_SANDBOX.port, { scheme: "https" });
  const r1 = await probe(https);
  if (r1.ok) return { url: https, healthy: true };
  const http = sb.previewUrl(WORLD_SANDBOX.port, { scheme: "http" });
  const r2 = await probe(http);
  if (r2.ok) return { url: http, healthy: true };
  return { url: r1.tls ? http : https, healthy: false, error: `${r1.error} | ${r2.error}` };
}

// ---------- the sandbox ----------

async function findBox(c: CreateosSandboxClient): Promise<{ box: Sandbox | null; createsUsed: number; others: Sandbox[] }> {
  const all = await c.listSandboxes({ limit: 100 });
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const createsUsed = all.filter((s) => Date.parse(s.data.created_at) > dayAgo).length;
  const live = all.filter((s) => !DEAD.has(s.status));
  const mine = live
    .filter((s) => s.name === WORLD_SANDBOX.name)
    .sort((a, b) => Date.parse(b.data.created_at) - Date.parse(a.data.created_at));
  return { box: mine[0] ?? null, createsUsed, others: live.filter((s) => s.name !== WORLD_SANDBOX.name) };
}

async function startWorld(sb: Sandbox, bundle: { bytes: Buffer; sha: string }, actions: string[]) {
  const d = WORLD_SANDBOX.dir;
  const remote = await sb.sh(`cat ${d}/world.sha 2>/dev/null; command -v node >/dev/null || echo NO_NODE`, { timeoutMs: 20_000 });
  if (remote.result.stdout.includes("NO_NODE")) {
    throw new HttpError(500, `rootfs ${WORLD_SANDBOX.rootfs} has no node binary`);
  }
  if (!remote.result.stdout.includes(bundle.sha)) {
    await sb.sh(`mkdir -p ${d}`, { timeoutMs: 20_000 });
    await sb.files.upload(`${d}/world.cjs`, new Uint8Array(bundle.bytes), { timeoutMs: 120_000 });
    await sb.files.upload(`${d}/world.sha`, bundle.sha);
    actions.push(`uploaded world.cjs (${bundle.bytes.length} bytes, sha ${bundle.sha.slice(0, 12)})`);
  }
  // Stop any previous world, then start it in the background as a managed process
  // (managed processes survive pause/resume).
  await sb.sh(`pkill -f "${d}/world.cjs" || true`, { timeoutMs: 20_000 });
  try {
    await sb.processes.create({
      cmd: "node",
      args: [`${d}/world.cjs`],
      cwd: d,
      env: { PORT: String(WORLD_SANDBOX.port), HOST: "0.0.0.0", NODE_ENV: "production" },
    });
  } catch (e) {
    log("processes.create failed, falling back to nohup", describeCreateosError(e));
    await sb.sh(
      `cd ${d} && PORT=${WORLD_SANDBOX.port} HOST=0.0.0.0 nohup node ${d}/world.cjs > ${d}/world.log 2>&1 &`,
      { timeoutMs: 20_000 },
    );
  }
  await sb.waitForPortReady(WORLD_SANDBOX.port, { timeoutMs: 30_000 });
  actions.push("started world on :8080");
}

async function doEnsure(opts: { redeploy?: boolean }): Promise<WorldInfo> {
  const t0 = Date.now();
  const local = env.worldUrl();
  if (local) {
    const p = await probe(local);
    return { mode: "local", url: local, healthy: p.ok, actions: ["local mode (WORLD_URL)"], ms: Date.now() - t0 };
  }

  const c = client();
  const actions: string[] = [];
  let { box, createsUsed, others } = await findBox(c);

  if (!box) {
    if (others.length > 0) {
      log("another sandbox is live; the free plan allows one at a time", others.map((s) => [s.id, s.name, s.status]));
    }
    if (createsUsed >= WORLD_SANDBOX.createsPer24h) {
      throw new HttpError(429, `CreateOS create quota spent: ${createsUsed}/${WORLD_SANDBOX.createsPer24h} in the last 24 h`);
    }
    // Never create in a loop: at most one create per host process per 10 minutes.
    if (g.__onceLastCreateAt && Date.now() - g.__onceLastCreateAt < 10 * 60_000) {
      throw new HttpError(429, "a sandbox was created by this host less than 10 minutes ago; refusing to create another");
    }
    g.__onceLastCreateAt = Date.now();
    log(`creating sandbox ${WORLD_SANDBOX.name} (creates used in 24 h before this: ${createsUsed}/${WORLD_SANDBOX.createsPer24h})`);
    try {
      box = await c.createSandbox({
        shape: WORLD_SANDBOX.shape,
        rootfs: WORLD_SANDBOX.rootfs,
        name: WORLD_SANDBOX.name,
        egress: [...WORLD_SANDBOX.egress], // in force before the first command
        ingress_enabled: true,
        auto_pause_after_seconds: WORLD_SANDBOX.autoPauseSeconds,
      });
    } catch (e) {
      throw new HttpError(502, `CreateOS create failed: ${describeCreateosError(e)}`);
    }
    createsUsed += 1;
    actions.push(`created ${box.id}`);
    log(`created ${box.id}; creates used in 24 h: ${createsUsed}/${WORLD_SANDBOX.createsPer24h}`);
  } else {
    actions.push(`found ${box.id} (${box.status})`);
  }

  // Bring it to running.
  if (box.status === "pausing") await box.waitUntilPaused({ timeoutMs: 120_000 });
  if (box.status === "paused") {
    await box.resume();
    actions.push("resumed");
  }
  if (box.status !== "running") await box.waitUntilRunning({ timeoutMs: 120_000 });

  // Invariants: ingress on, egress locked to the sinkhole, auto-pause set.
  if (!box.data.ingress_enabled) {
    await box.setIngress(true);
    actions.push("ingress enabled");
  }
  const eg = await box.getEgress();
  const want = [...WORLD_SANDBOX.egress];
  if (!eg.egress || eg.egress.length !== want.length || eg.egress.some((x, i) => x !== want[i])) {
    await box.setEgress(want);
    actions.push(`egress locked to ${JSON.stringify(want)}`);
  }
  if (box.data.auto_pause_after_seconds !== WORLD_SANDBOX.autoPauseSeconds) {
    await box.setAutoPause(WORLD_SANDBOX.autoPauseSeconds).catch((e) => log("setAutoPause failed", describeCreateosError(e)));
  }

  let res = await resolveUrl(box);
  const bundle = await loadBundle();
  const remoteSha = bundle
    ? (await box.sh(`cat ${WORLD_SANDBOX.dir}/world.sha 2>/dev/null || true`, { timeoutMs: 20_000 })).result.stdout.trim()
    : "";
  const stale = !!bundle && remoteSha !== bundle.sha;
  if (!res.healthy || (opts.redeploy && stale)) {
    if (!bundle) {
      throw new HttpError(500, "world is not running in the sandbox and world/dist/world.cjs was not found on the host (run `npm run bundle` in world/)");
    }
    await startWorld(box, bundle, actions);
    // Ingress can lag the port by a few seconds.
    for (let i = 0; i < 10; i++) {
      res = await resolveUrl(box);
      if (res.healthy) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } else if (stale) {
    actions.push("world bundle on host differs from the sandbox; pass {redeploy:true} to replace it");
  }

  await box.refresh().catch(() => {});
  const info: WorldInfo = {
    mode: "createos",
    url: res.url,
    healthy: res.healthy,
    sandbox: {
      id: box.id,
      name: box.name,
      status: box.status,
      egress: (await box.getEgress().catch(() => ({ egress: undefined }))).egress ?? undefined,
      created_at: box.data.created_at,
      auto_pause_after_seconds: box.data.auto_pause_after_seconds,
    },
    actions,
    creates_used_24h: createsUsed,
    creates_limit_24h: WORLD_SANDBOX.createsPer24h,
    bundle_sha: bundle?.sha,
    ms: Date.now() - t0,
  };
  if (!res.healthy) actions.push(`world not reachable at ${res.url}: ${res.error}`);
  log("ensure", { actions, url: info.url, healthy: info.healthy, ms: info.ms });
  return info;
}

/** Ensure the world is up and return where it is. Single-flight: concurrent callers share one ensure. */
export async function ensureWorld(opts: { redeploy?: boolean } = {}): Promise<WorldInfo> {
  if (!g.__onceWorldEnsure) {
    g.__onceWorldEnsure = doEnsure(opts)
      .then((info) => {
        if (info.healthy) g.__onceWorldCache = { info, at: Date.now() };
        return info;
      })
      .finally(() => {
        g.__onceWorldEnsure = undefined;
      });
  }
  return g.__onceWorldEnsure;
}

/** The world's base URL, from cache when fresh; ensures (and resumes) otherwise. */
export async function worldBaseUrl(): Promise<string> {
  const local = env.worldUrl();
  if (local) return local;
  const c = g.__onceWorldCache;
  if (c && Date.now() - c.at < 5 * 60_000) return c.info.url;
  const info = await ensureWorld();
  if (!info.healthy) throw new HttpError(503, `world not reachable: ${info.actions.at(-1)}`, info);
  return info.url;
}

export function invalidateWorldCache() {
  g.__onceWorldCache = undefined;
}

export function cachedWorldInfo(): WorldInfo | undefined {
  return g.__onceWorldCache?.info;
}

/** Pause the world sandbox now (it also auto-pauses after 10 idle minutes). */
export async function pauseWorld(): Promise<{ id?: string; status: string }> {
  if (env.worldUrl()) return { status: "local mode: nothing to pause" };
  const c = client();
  const { box } = await findBox(c);
  if (!box) return { status: "no sandbox" };
  if (box.status === "running") {
    await box.pause();
    await box.waitUntilPaused({ timeoutMs: 120_000 }).catch(() => {});
  }
  invalidateWorldCache();
  return { id: box.id, status: box.status };
}
