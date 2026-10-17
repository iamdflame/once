// GET /api/world/state: the world's snapshot (chargers, episodes, holds, recent events).
import { world } from "@/lib/world";
import { route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return route(() => world.state());
}
