// GET /api/agent/last: the last real agent run, as the world keeps it inside the sandbox
// (posted by /api/agent/fix when a run ends; survives host cold starts). {run: null} before the first run.
import { world } from "@/lib/world";
import { route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return route(async () => {
    const r = await world.agentLast();
    return { run: r?.run ?? null };
  });
}
