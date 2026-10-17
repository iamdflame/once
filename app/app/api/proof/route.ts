// GET /api/proof[?verify=0]: capture attempts with Stripe ids and statuses, each hold as Stripe sees it, suite results.
import { buildProof } from "@/lib/proof";
import { route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return route(() => buildProof({ verify: new URL(req.url).searchParams.get("verify") !== "0" }));
}
