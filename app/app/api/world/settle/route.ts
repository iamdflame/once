// GET /api/world/settle: the deployed settle.js source and version. (Uploads go through /api/agent/fix only.)
import { world } from "@/lib/world";
import { route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return route(() => world.getSettle());
}
