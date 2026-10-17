// Regenerates lib/settle-interface.ts from world/README.md ("The settle.js interface" section).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const md = readFileSync(path.join(APP, "..", "world", "README.md"), "utf8");
const a = md.indexOf("## The settle.js interface");
const b = md.indexOf("## Payment authority model");
if (a < 0 || b < 0) throw new Error("section markers not found in world/README.md");
const sec = md.slice(a, b).trim();
writeFileSync(
  path.join(APP, "lib", "settle-interface.ts"),
  `// Copied verbatim from world/README.md, section "The settle.js interface" (the world agent's
// contract), so the agent prompt works where the README is not on disk (e.g. Vercel).
// Refresh with: node scripts/sync-settle-interface.mjs
export const SETTLE_INTERFACE_MD = ${JSON.stringify(sec)};
`,
);
console.log(`lib/settle-interface.ts: ${sec.length} chars`);
