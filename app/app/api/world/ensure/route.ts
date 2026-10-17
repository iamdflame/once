// POST /api/world/ensure {redeploy?: boolean}: create or reuse the world sandbox, resume it, start the world.
import { ensureWorld } from "@/lib/createos";
import { readJson, route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  return route(async () => {
    const body = await readJson<{ redeploy?: boolean }>(req);
    return ensureWorld({ redeploy: !!body.redeploy });
  });
}
