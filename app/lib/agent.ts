// The agent loop: the model writes settle.js, the world runs it.
//
// Given the failing scenario report, the current settle.js, the settle.js interface and a
// short spec, the model writes a new settle.js. The host never executes that code: it
// extracts the text, uploads it to the world (PUT /settle, which loads it in an isolated
// context inside the sandbox), and runs the 30-scenario suite there (POST /suite). Up to
// three attempts, each fed the previous attempt's failures. A version that does not pass
// every scenario is not left deployed: the previous settle.js is restored.
import "server-only";
import { complete, modelPlan, type ChatMessage } from "./llm";
import { diffStats, unifiedDiff } from "./diff";
import { world, type ScenarioResult, type SuiteReport } from "./world";
import { describe } from "./errors";
import { recordSuite } from "./proof";

export const MAX_ATTEMPTS = 3;

export const SETTLE_SPEC = `Exactly-once settlement for public EV chargers.

- A plug-in EPISODE lasts from plug to unplug on one charger. It may span several OCPP
  transactions (a reboot mid-session ends the transaction and starts a new one for the
  same plug-in; the meter may reset to 0 on reboot).
- Each episode is bound to one Stripe PaymentIntent hold (a EUR 50.00 manual-capture
  authorisation). Stripe allows exactly ONE capture per PaymentIntent; after a partial
  capture the remainder is released and any further capture fails.
- Emit exactly ONE capture intent per plug-in episode, once the episode has ended
  (the car is unplugged / the connector is available again), never one per transaction.
- amount_cents = round(total energy delivered in the episode in kWh x tariffCentsPerKwh),
  summed across every transaction of the episode (account for meter resets), and capped
  at the hold amount. Never more than the hold.
- Never capture on a transactionId alone: chargers resend queued StopTransactions twice
  after reconnecting, send a StopTransaction for a Start that was never seen, and split
  one plug-in into several transactions. Deduplicate; treat repeats as no-ops.
- Every episode with a hold must end with exactly one intent (no stranded holds), and
  energy delivered must be billed (no unbilled episodes), including when the link was
  cut and messages arrive late, out of order or twice. Use MeterValues as a lower bound
  when a Stop never arrives or carries a reset meter.
- intents() must be idempotent: calling it again returns the same intents with the same
  intent_id values, never new ones for the same episode.
- Pure JavaScript only: no imports, no require, no timers, no I/O. The module is loaded
  from text in an isolated context with no fs, net or process.`;

/** Mirrors world/README.md "settle.js interface". Kept here so the prompt works when the README is not on disk. */
export const SETTLE_INTERFACE = `// settle.js is an ES module loaded from text, fresh for every run.
export function createSettler({ tariffCentsPerKwh }) {
  return {
    // Called once per world event, in arrival order (OCPP messages as the CSMS received
    // them, plus hold bindings and plug/unplug). See the event samples for the shapes.
    onEvent(evt) {},
    // Returns every capture intent decided so far (the world calls it repeatedly).
    intents() {
      return [{ intent_id, episode_id, charger, payment_intent, amount_cents }];
    },
  };
}`;

type Version = string | number | undefined;

/**
 * NDJSON events streamed by POST /api/agent/fix (one JSON object per line, plus `at`).
 * The names match the UI's AgentEvent; `reasoning`, `delta` and `fallback` are extras.
 */
export type AgentEvent =
  | { type: "status"; text: string; phase?: string; provider?: string; models?: string[] }
  | { type: "attempt"; n: number; of: number }
  | { type: "model"; name: string; provider: string }
  | { type: "fallback"; model: string; error: string }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string; model: string; ms: number }
  | { type: "diff"; old: string; new: string; version: string; unified: string; added: number; removed: number; attempt: number }
  | { type: "uploaded"; version: string }
  | { type: "scenario"; scenario: ScenarioResult; index: number; count: number }
  | { type: "suite"; report: SuiteReport; phase: "baseline" | "attempt"; attempt?: number }
  | { type: "done"; ok: boolean; version: string; attempts: number; reason: string; reverted?: boolean }
  | { type: "error"; text: string };

const v = (x: Version) => (x === undefined ? "" : String(x));
const slim = (r: SuiteReport): SuiteReport => ({ version: r.version, ran_at: r.ran_at, scenarios: r.scenarios, totals: r.totals });

function failingReport(report: SuiteReport, maxChars = 7000): string {
  const failing = report.scenarios.filter((s) => !s.ok);
  const head = `totals: ${JSON.stringify(report.totals)}\nfailing scenarios: ${failing.length}/${report.scenarios.length}\n`;
  let body = "";
  for (const s of failing) {
    const line = JSON.stringify(s) + "\n";
    if (body.length + line.length > maxChars) {
      body += `... ${failing.length - body.split("\n").length + 1} more failing scenarios omitted\n`;
      break;
    }
    body += line;
  }
  return head + body;
}

/** Pull the settle.js module out of the model's answer: the last fenced block that defines createSettler. */
export function extractCode(text: string): string | null {
  const blocks = [...text.matchAll(/```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => m[2]);
  const good = blocks.filter((b) => /createSettler/.test(b));
  let code = good.at(-1) ?? null;
  if (!code) {
    // Unterminated fence (model ran out of tokens or forgot to close it).
    const open = text.lastIndexOf("```");
    if (open >= 0) {
      const rest = text.slice(open).replace(/^```[^\n]*\n/, "");
      if (/createSettler/.test(rest)) code = rest;
    }
  }
  if (!code) return null;
  code = code.trim() + "\n";
  if (!/export\s+(function|const|let|var)\s+createSettler|export\s*\{[^}]*createSettler/.test(code)) return null;
  return code;
}

function extractPlan(text: string): string {
  const fence = text.indexOf("```");
  const before = (fence >= 0 ? text.slice(0, fence) : text).trim();
  const plan = before.replace(/^#+\s*plan:?\s*/i, "").replace(/^plan:\s*/i, "").trim();
  return plan.slice(0, 1200);
}

function systemPrompt(): string {
  return [
    "You write settlement code for public EV chargers. Your module decides how much to capture on each card hold; it must charge every customer exactly once.",
    "Reply in exactly this format and nothing else:",
    "PLAN: two to four plain sentences saying what is wrong with the current code and what your version does differently.",
    "Then ONE fenced ```js block containing the complete settle.js file (not a diff, not a fragment).",
  ].join("\n");
}

function userPrompt(input: { current: string; report: string; samples: string; feedback?: string }): string {
  return [
    "## Spec",
    SETTLE_SPEC,
    "## settle.js interface",
    "```js\n" + SETTLE_INTERFACE + "\n```",
    input.samples ? "## Sample events from the live world (shapes onEvent receives may match these)\n```json\n" + input.samples + "\n```" : "",
    "## Current settle.js (deployed now)",
    "```js\n" + input.current + "\n```",
    "## Failing scenario report from the 30-seed suite (run inside the sandbox)",
    "```\n" + input.report + "\n```",
    input.feedback ? "## Your previous attempt\n" + input.feedback : "",
    "Write the complete new settle.js now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function eventSamples(): Promise<string> {
  try {
    const ev = (await world.events(0)) as unknown;
    const list = Array.isArray(ev) ? ev : ((ev as { events?: unknown[] })?.events ?? []);
    // A spread of distinct event types, newest last.
    const seen = new Map<string, unknown>();
    for (const e of list as Record<string, unknown>[]) {
      const k = String(e?.type ?? e?.action ?? e?.kind ?? e?.op ?? "event");
      if (!seen.has(k) || seen.size < 12) seen.set(k, e);
    }
    return JSON.stringify([...seen.values()].slice(-12), null, 1).slice(0, 4000);
  } catch {
    return "";
  }
}

/** Run the loop, emitting progress events. Never throws; failures arrive as events. */
export async function runAgentFix(emit: (e: AgentEvent) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const plan = modelPlan();
  emit({ type: "status", phase: "start", text: `agent: ${plan.provider} (${plan.models.join(", ")}), up to ${MAX_ATTEMPTS} attempts`, provider: plan.provider, models: plan.models });
  if (plan.provider === "none") {
    emit({ type: "error", text: "no model key: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY" });
    emit({ type: "done", ok: false, version: "", attempts: 0, reason: "no model key configured" });
    return;
  }

  let original: { source: string; version?: string | number };
  let baseline: SuiteReport;
  try {
    original = await world.getSettle();
    if (typeof original?.source !== "string") throw new Error("world GET /settle returned no source");
    emit({ type: "status", phase: "baseline", text: `running the 30-scenario suite on the deployed settle.js (v${v(original.version)})` });
    baseline = await world.suite({ count: 30 });
    recordSuite(baseline, "agent", "baseline");
  } catch (e) {
    emit({ type: "error", text: `could not read the world: ${describe(e)}` });
    emit({ type: "done", ok: false, version: "", attempts: 0, reason: "world unreachable" });
    return;
  }
  emit({ type: "suite", phase: "baseline", report: slim(baseline) });
  if (baseline.totals.count > 0 && baseline.totals.failed === 0) {
    emit({ type: "done", ok: true, version: v(original.version), attempts: 0, reason: "the deployed settle.js already passes every scenario" });
    return;
  }

  const samples = await eventSamples();
  let current = original.source;
  let report = failingReport(baseline);
  let feedback: string | undefined;
  let modelStart = 0;

  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    if (opts.signal?.aborted) break;
    emit({ type: "attempt", n, of: MAX_ATTEMPTS });
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userPrompt({ current, report, samples, feedback }) },
    ];

    let completion;
    try {
      completion = await complete(
        messages,
        {
          onModel: (m) => emit({ type: "model", name: m.model, provider: m.provider }),
          onFallback: (f) => emit({ type: "fallback", ...f }),
          onReasoning: (text) => emit({ type: "reasoning", text }),
          onText: (text) => emit({ type: "delta", text }),
        },
        {
          signal: opts.signal,
          startAt: modelStart,
          accept: (c) => (extractCode(c.text) ? null : "answer had no settle.js code block defining export function createSettler"),
        },
      );
      modelStart = completion.modelIndex; // stay on the model that answered
    } catch (e) {
      emit({ type: "error", text: describe(e) });
      modelStart = 0;
      continue;
    }
    const code = extractCode(completion.text)!;
    emit({ type: "thinking", text: extractPlan(completion.text), model: completion.model, ms: completion.ms });

    // Upload into the world: it validates that the module loads, inside the sandbox.
    let version: Version;
    let uploadError: string | undefined;
    try {
      const up = await world.putSettle(code);
      if (up && up.ok === false) throw new Error(up.error ?? "world refused the module");
      version = up?.version;
    } catch (e) {
      uploadError = describe(e);
    }
    emit({
      type: "diff",
      attempt: n,
      old: current,
      new: code,
      version: uploadError ? `attempt ${n} (rejected)` : v(version),
      unified: unifiedDiff(current, code, { a: "settle.js (before)", b: `settle.js (attempt ${n})` }),
      ...diffStats(current, code),
    });
    if (uploadError) {
      emit({ type: "error", text: `the world refused attempt ${n}: ${uploadError}` });
      feedback = `Your module did not load in the world:\n${uploadError}\nFix it. Plain JavaScript only, export function createSettler.`;
      current = code;
      continue;
    }
    emit({ type: "uploaded", version: v(version) });

    emit({ type: "status", phase: "suite", text: `running 30 seeded fault scenarios on v${v(version)} inside the sandbox` });
    let result: SuiteReport;
    try {
      result = await world.suite({ count: 30 });
      recordSuite(result, "agent", `attempt ${n}`);
    } catch (e) {
      const msg = describe(e);
      emit({ type: "error", text: `the suite failed to run: ${msg}` });
      feedback = `The suite crashed while running your module:\n${msg}`;
      current = code;
      continue;
    }
    result.scenarios.forEach((s, index) => emit({ type: "scenario", scenario: s, index, count: result.scenarios.length }));
    emit({ type: "suite", phase: "attempt", attempt: n, report: slim(result) });
    const allGreen = result.totals.count > 0 && result.totals.failed === 0;
    if (allGreen) {
      emit({ type: "done", ok: true, version: v(version), attempts: n, reason: `attempt ${n} passes all ${result.totals.count} scenarios; v${v(version)} is deployed` });
      return;
    }
    current = code;
    report = failingReport(result);
    feedback = `It loaded, but ${result.totals.failed} of ${result.totals.count} scenarios still fail (the report above is for YOUR version). Fix the remaining failures.`;
  }

  // Not green: put the previously deployed code back.
  let reason = `no attempt passed all 30 scenarios in ${MAX_ATTEMPTS} attempts`;
  let reverted = false;
  let finalVersion: Version = undefined;
  try {
    const back = await world.putSettle(original.source);
    reverted = true;
    finalVersion = back?.version ?? original.version;
    reason += `; restored the settle.js that was deployed before (now v${v(finalVersion)})`;
  } catch (e) {
    reason += `; restoring the previous settle.js failed: ${describe(e)}`;
  }
  emit({ type: "done", ok: false, version: v(finalVersion), attempts: MAX_ATTEMPTS, reason, reverted });
}
