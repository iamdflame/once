// GET /api/world/events?since=: the world's event stream since a cursor.
import { world } from "@/lib/world";
import { route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return route(() => world.events(new URL(req.url).searchParams.get("since") ?? undefined));
}
