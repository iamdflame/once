// Copy the world bundle into the app so it ships with the server functions (Vercel builds from app/).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
const src = new URL("../../world/dist/world.cjs", import.meta.url);
const dst = new URL("../world/dist/world.cjs", import.meta.url);
if (existsSync(src)) {
  mkdirSync(new URL("../world/dist/", import.meta.url), { recursive: true });
  copyFileSync(src, dst);
  console.log("synced world bundle into app/world/dist/world.cjs");
} else {
  console.log("world/ not present (deploying from app/ only); using the committed app/world/dist/world.cjs");
}
