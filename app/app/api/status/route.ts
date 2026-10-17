// GET /api/status: asserted outcomes (world, sandbox, egress, creates, last capture, last suite, Stripe mode).
import { buildStatus } from "@/lib/status";
import { route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  return route(() => buildStatus());
}
