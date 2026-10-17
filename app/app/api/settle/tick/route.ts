// POST /api/settle/tick: execute the world's pending capture intents on Stripe, report Stripe's answers back.
import { settleTick } from "@/lib/settle";
import { route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return route(() => settleTick());
}
