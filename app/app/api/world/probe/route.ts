// POST /api/world/probe: the boundary, shown live. The world runs its probe inside the
// sandbox (world/src/probe.js: vm escapes, the 1 s budget, TCP to api.stripe.com and DNS
// from the world process, its environment by name) and the host adds the sandbox's
// settings as CreateOS reports them. Every check has pass/fail and timing; checks that
// cannot mean anything on a laptop world (no egress block there) are "local: not applicable".
import { world, type ProbeCheck } from "@/lib/world";
import { sandboxReport } from "@/lib/createos";
import { env } from "@/lib/env";
import { describe, route } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Check = ProbeCheck & { applicable: boolean; verdict: "pass" | "fail" | "local: not applicable"; expected: string };

const EXPECTED: Record<string, string> = {
  a: "blocked inside the vm (or refused by the loader)",
  b: "stopped at the 1 s budget",
  c: "fails: the CreateOS egress allowlist is a single sinkhole",
  d: "no Stripe, model or CreateOS key; sandbox egress locked",
};

const KEYISH = /STRIPE|SECRET|API_?KEY|TOKEN|PASSWORD|PRIVATE|OPENROUTER|ANTHROPIC|CREATEOS|VERCEL|CREDENTIAL/i;

function isLocalUrl(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname;
    return h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h) || h === "0.0.0.0";
  } catch {
    return false;
  }
}

export async function POST() {
  return route(async () => {
    const t0 = Date.now();
    const local = isLocalUrl(env.worldUrl());
    const [probe, sb] = await Promise.all([
      world.probe(),
      sandboxReport().catch((e) => ({ mode: "error" as const, error: describe(e) })),
    ]);

    const checks: Check[] = probe.checks.map((c) => {
      const applicable = !(local && c.group === "c");
      return { ...c, applicable, verdict: !applicable ? "local: not applicable" : c.pass ? "pass" : "fail", expected: EXPECTED[c.group] ?? "" };
    });

    // (d) the sandbox itself, as CreateOS reports it.
    if (sb.mode === "createos" && sb.found) {
      const keyish = sb.env_names.filter((n) => KEYISH.test(n));
      checks.push({
        group: "d", id: "sandbox-egress", label: "CreateOS reports the world sandbox's egress allowlist", layer: "createos",
        pass: sb.egress_is_sinkhole_only, applicable: true, verdict: sb.egress_is_sinkhole_only ? "pass" : "fail",
        detail: `egress ${JSON.stringify(sb.egress)} on ${sb.id} (${sb.status})${sb.egress.length === 0 ? ": an empty list means allow all" : ""}`,
        expected: 'exactly ["sinkhole.invalid"]', ms: 0,
      });
      checks.push({
        group: "d", id: "sandbox-env", label: "env variables CreateOS stores on the sandbox (names only)", layer: "createos",
        pass: keyish.length === 0, applicable: true, verdict: keyish.length === 0 ? "pass" : "fail",
        detail: keyish.length ? `credential-like names: ${keyish.join(", ")}` : `${sb.env_names.length} declared (${sb.env_names.join(", ") || "none"}), none named like a key`,
        expected: EXPECTED.d, ms: 0,
      });
    } else {
      checks.push({
        group: "d", id: "sandbox-egress", label: "CreateOS reports the world sandbox's egress allowlist", layer: "createos",
        pass: false, applicable: false, verdict: "local: not applicable",
        detail: sb.mode === "local" ? `local world at ${sb.url}: there is no sandbox` : sb.mode === "error" ? `CreateOS could not be asked: ${sb.error}` : "no sandbox found",
        expected: 'exactly ["sinkhole.invalid"]', ms: 0,
      });
      if (sb.mode === "error" || (sb.mode === "createos" && !sb.found)) checks[checks.length - 1].applicable = true;
      if (checks[checks.length - 1].applicable) checks[checks.length - 1].verdict = "fail";
    }

    const applicable = checks.filter((c) => c.applicable);
    return {
      ok: applicable.length > 0 && applicable.every((c) => c.pass),
      mode: local ? "local" : "createos",
      note: local
        ? "local world: the vm checks (a, b) and the environment check are real; the egress checks (c) succeed on a laptop and are not applicable, and there is no sandbox to ask CreateOS about"
        : "run inside the CreateOS sandbox: the world process tried the network itself",
      at: new Date().toISOString(),
      passed: applicable.filter((c) => c.pass).length,
      applicable: applicable.length,
      checks,
      sandbox: sb,
      world: { node: probe.node, platform: probe.platform, uptime_s: probe.world_uptime_s, probe_ms: probe.ms },
      env: { world_process: probe.env.names, flagged: probe.env.flagged, sandbox_declared: sb.mode === "createos" && sb.found ? sb.env_names : [] },
      ms: Date.now() - t0,
    };
  });
}
