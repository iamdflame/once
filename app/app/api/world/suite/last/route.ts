// GET /api/world/suite/last: the last suite the world ran on its deployed settle.js (world GET /suite/last),
// normalised like POST /api/world/suite. {report: null} when none has run since the world started.
import { normalizeSuite, world } from "@/lib/world";
import { route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return route(async () => {
    const r = await world.lastSuite();
    if (!r?.report) return { report: null };
    const n = normalizeSuite(r.report);
    return { report: { version: n.version, ran_at: n.ran_at, summary: n.summary, totals: n.totals, scenarios: n.scenarios } };
  });
}
