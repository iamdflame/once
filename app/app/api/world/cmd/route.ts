// POST /api/world/cmd {op: plug|unplug|cut|restore|reboot|quirk, charger, quirk?, on?}: proxied to the world.
import { world } from "@/lib/world";
import { readJson, route } from "@/lib/errors";
import { HttpError } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPS = new Set(["plug", "unplug", "cut", "restore", "reboot", "quirk"]);

export async function POST(req: Request) {
  return route(async () => {
    const body = await readJson(req);
    if (!OPS.has(String(body.op))) throw new HttpError(400, `op must be one of ${[...OPS].join(", ")}`);
    return world.cmd(body);
  });
}
