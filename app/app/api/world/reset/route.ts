// POST /api/world/reset: put the world back on the naive v1 settle.js with a clean board (rearms the demo).
import { world } from "@/lib/world";
import { route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return route(() => world.reset({ settle: "v1" }));
}
