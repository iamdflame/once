// POST /api/world/suite {count?, seed?}: run the seeded scenario suite on the deployed settle.js (inside the world).
// JSON by default; with ?stream=1 it streams NDJSON AgentEvents (status, scenario x N, suite) like /api/agent/fix.
import { world } from "@/lib/world";
import { describe, readJson, route } from "@/lib/errors";
import { recordSuite } from "@/lib/proof";
import type { AgentEvent } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const stream = new URL(req.url).searchParams.get("stream") === "1";
  if (!stream) {
    return route(async () => {
      const body = await readJson<{ count?: number; seed?: number }>(req);
      const report = await world.suite({ count: body.count ?? 30, ...(body.seed !== undefined ? { seed: body.seed } : {}) });
      recordSuite(report, "suite");
      return { version: report.version, ran_at: report.ran_at, totals: report.totals, scenarios: report.scenarios };
    });
  }
  const body = await readJson<{ count?: number; seed?: number }>(req).catch(() => ({}) as { count?: number; seed?: number });
  const enc = new TextEncoder();
  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(enc.encode(JSON.stringify({ ...e, at: Date.now() }) + "\n"));
      try {
        emit({ type: "status", phase: "suite", text: `running ${body.count ?? 30} seeded fault scenarios inside the sandbox` });
        const r = await world.suite({ count: body.count ?? 30, ...(body.seed !== undefined ? { seed: body.seed } : {}) });
        recordSuite(r, "suite");
        r.scenarios.forEach((scenario, index) => emit({ type: "scenario", scenario, index, count: r.scenarios.length }));
        emit({ type: "suite", phase: "attempt", report: { version: r.version, ran_at: r.ran_at, totals: r.totals, scenarios: r.scenarios } });
      } catch (e) {
        emit({ type: "error", text: describe(e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(out, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform" } });
}
