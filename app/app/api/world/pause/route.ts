// POST /api/world/pause: pause the world sandbox now (it also auto-pauses after 10 idle minutes).
import { pauseWorld } from "@/lib/createos";
import { route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return route(() => pauseWorld());
}
