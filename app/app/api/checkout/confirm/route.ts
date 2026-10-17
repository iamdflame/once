// GET /api/checkout/confirm?session_id=: read the session and its PaymentIntent; bind the hold in the world once it is authorised.
import { confirmCheckout } from "@/lib/checkout";
import { route } from "@/lib/errors";
import { HttpError } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return route(async () => {
    const id = new URL(req.url).searchParams.get("session_id");
    if (!id || !id.startsWith("cs_")) throw new HttpError(400, "session_id (cs_...) is required");
    return confirmCheckout(id);
  });
}
