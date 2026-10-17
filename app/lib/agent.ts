// The agent loop: the model writes settle.js, the world runs it.
//
// Given the failing scenario report, the current settle.js, the settle.js interface (from
// world/README.md) and a short spec, the model writes a new settle.js. The host never
// executes that code. It sends the text to the world, which loads it in an isolated vm
// context inside the sandbox:
//   1. POST /settle/validate   does it load, export createSettler, survive a probe tick?
//   2. POST /suite {source}    the 30 seeded fault scenarios, as a dry run (not deployed)
//   3. PUT /settle             only when all 30 pass: deployed, replayed over live history
// Up to three attempts, each fed the previous attempt's failing scenarios (the world's
// notes) and one full event trace. A red candidate never touches the live board, so it
// can never send a bad capture to a real Stripe hold.
import "server-only";
import { complete, modelPlan, type ChatMessage } from "./llm";
import { diffStats, unifiedDiff } from "./diff";
import { world, type ScenarioResult, type SuiteReport } from "./world";
import { describe } from "./errors";
import { recordSuite } from "./proof";
import { SETTLE_INTERFACE_MD } from "./settle-interface";

export const MAX_ATTEMPTS = Math.max(1, Math.min(10, Number(process.env.AGENT_ATTEMPTS) || 3));
/** Whole-run budget. Vercel stops the function at 300 s; AGENT_BUDGET_S raises it locally. */
const BUDGET_MS = (Number(process.env.AGENT_BUDGET_S) || 285) * 1000;

export const SETTLE_SPEC = `Exactly-once settlement for public EV chargers.

- A plug-in EPISODE lasts from plug to unplug on one charger. It may span several OCPP
  transactions (a reboot ends one transaction and starts another for the same car; the
  energy register may restart at 0). The episode ends when the car leaves.
- Each episode is paid by one hold: a Stripe PaymentIntent (manual capture), announced by
  a "hold" event; holds pay for the NEXT plug-in on that charger, FIFO per charger.
- Emit exactly ONE intent per hold, after the episode has ended. Stripe allows one
  capture per PaymentIntent; after a partial capture the rest is released and every
  further capture is refused.
- amount_cents = min(hold.amount_cents, round(energyWh * tariffCentsPerKwh / 1000)), where
  energyWh is ALL energy of the episode, summed across its transactions (meter resets
  and interruptions accounted for). Never more than the hold.
- Never capture on a transactionId alone: StopTransactions arrive twice, transactionIds
  can be ones the CSMS never issued (lost StartTransaction), and one plug-in can be split
  into several transactions. Deduplicate; repeats are no-ops.
- No stranded holds (every hold ends with one intent), no unbilled energy, no over- or
  under-billing, even when the link was cut and messages arrive late, out of order, twice,
  or after the next driver's hold. Use MeterValues and transactionData readings when a
  Start was lost. Trust "at" (CSMS arrival time), not payload timestamps.
- episode_id must be stable for the episode; intent_id unique per decision.`;

type Version = string | number | undefined;

/**
 * NDJSON events streamed by POST /api/agent/fix (one JSON object per line, plus `at`).
 * The names match the UI's AgentEvent; `reasoning`, `delta` and `fallback` are extras.
 */
export type AgentEvent =
  | { type: "status"; text: string; phase?: string; provider?: string; models?: string[] }
  | { type: "attempt"; n: number; of: number }
  /** Emitted only once a model has actually answered; name is the provider-reported id. */
  | { type: "model"; name: string; provider: string; requested: string }
  | { type: "trying"; name: string; provider: string }
  | { type: "fallback"; model: string; error: string }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string; model: string; ms: number }
  | { type: "diff"; old: string; new: string; version: string; unified: string; added: number; removed: number; attempt: number }
  | { type: "uploaded"; version: string }
  | { type: "scenario"; scenario: ScenarioResult; index: number; count: number }
  | { type: "suite"; report: SuiteReport; phase: "baseline" | "attempt" | "deployed"; attempt?: number }
  | { type: "done"; ok: boolean; version: string; attempts: number; reason: string; model?: string }
  | { type: "error"; text: string };

const v = (x: Version) => (x === undefined ? "" : String(x));
const slim = (r: SuiteReport): SuiteReport => ({ version: r.version, ran_at: r.ran_at, summary: r.summary, scenarios: r.scenarios, totals: r.totals });

function failingReport(report: SuiteReport, maxChars = 12_000): string {
  const failing = report.scenarios.filter((s) => !s.ok);
  let out = `${report.summary ?? JSON.stringify(report.totals)}\nfailing scenarios: ${failing.length}/${report.scenarios.length}\n`;
  for (const s of failing) {
    const counts = (["double", "stranded", "unbilled", "overbilled", "underbilled", "invalid"] as const)
      .filter((k) => Number(s[k] ?? 0) > 0)
      .map((k) => `${k} ${s[k]}`)
      .join(", ");
    const extra = [s.error ? `error: ${s.error}` : "", Number(s.settler_errors ?? 0) ? `settler_errors: ${s.settler_errors}` : ""].filter(Boolean).join("; ");
    const line = `- seed ${s.seed} ${s.name ?? ""} [${(Array.isArray(s.faults) ? s.faults : []).join(", ")}]: ${counts}${extra ? "; " + extra : ""}\n${(s.notes ?? []).map((n) => `    ${n}`).join("\n")}\n`;
    if (out.length + line.length > maxChars) {
      out += `... more failing scenarios omitted\n`;
      break;
    }
    out += line;
  }
  return out;
}

/** One failing seed's full event feed, compacted: what settle.js actually saw. */
async function traceFor(report: SuiteReport, source: string, pick: number, maxChars = 7000): Promise<string> {
  const failing = report.scenarios.filter((s) => !s.ok);
  if (!failing.length) return "";
  const s = failing[pick % failing.length];
  try {
    const t = await world.trace(Number(s.seed), source);
    const trace = (t.report?.trace ?? {}) as { feed?: Record<string, unknown>[]; intents?: unknown[]; episodes?: unknown[] };
    const feed = (trace.feed ?? [])
      .filter((e) => !(e.type === "ocpp" && ["BootNotification", "Heartbeat", "Authorize"].includes(String(e.action))) && e.type !== "tick")
      .map((e) => {
        const c: Record<string, unknown> = { seq: e.seq, at: e.at, type: e.type, charger: e.charger };
        if (e.type === "ocpp") {
          c.action = e.action;
          c.payload = e.payload;
          if (e.response && Object.keys(e.response as object).length) c.response = e.response;
        } else {
          for (const [k, val] of Object.entries(e)) if (!(k in c)) c[k] = val;
        }
        return JSON.stringify(c);
      });
    let body = "";
    for (const line of feed) {
      if (body.length + line.length > maxChars) {
        body += "... (feed truncated)\n";
        break;
      }
      body += line + "\n";
    }
    const truth = JSON.stringify({ episodes: trace.episodes, intents: trace.intents }).slice(0, 2500);
    return `seed ${s.seed} (${s.name ?? ""}): events settle.js received, in order (BootNotification/Heartbeat/Authorize/tick omitted):\n${body}\nthe world's truth and the intents your code emitted:\n${truth}`;
  } catch {
    return "";
  }
}

/** Pull the settle.js module out of the model's answer: the last fenced block that defines createSettler. */
export function extractCode(text: string): string | null {
  const blocks = [...text.matchAll(/```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => m[2]);
  const good = blocks.filter((b) => /createSettler/.test(b));
  let code = good.at(-1) ?? null;
  if (!code) {
    // Unterminated fence (the model ran out of tokens or forgot to close it).
    const open = text.lastIndexOf("```");
    if (open >= 0) {
      const rest = text.slice(open).replace(/^```[^\n]*\n/, "");
      if (/createSettler/.test(rest)) code = rest;
    }
  }
  if (!code) return null;
  code = code.trim() + "\n";
  if (!/createSettler/.test(code) || !/export|module\.exports/.test(code)) return null;
  return code;
}

function extractPlan(text: string): string {
  const fence = text.indexOf("```");
  const before = (fence >= 0 ? text.slice(0, fence) : text).trim();
  return before.replace(/^#+\s*plan:?\s*/i, "").replace(/^plan:\s*/i, "").trim().slice(0, 1200);
}

function systemPrompt(): string {
  return [
    "You write settlement code for public EV chargers. Your module decides how much to capture on each card hold; every driver must be charged exactly once, for exactly the energy they took.",
    "Reply in exactly this format and nothing else:",
    "PLAN: two to four plain sentences saying what is wrong with the current code and what your version does differently.",
    "Then ONE fenced ```js block containing the complete settle.js file (not a diff, not a fragment).",
  ].join("\n");
}

function userPrompt(input: { current: string; report: string; trace: string; feedback?: string }): string {
  return [
    "## Spec",
    SETTLE_SPEC,
    SETTLE_INTERFACE_MD,
    "## Current settle.js",
    "```js\n" + input.current + "\n```",
    "## Failing scenarios from the 30-seed suite (run inside the sandbox)",
    "```\n" + input.report + "\n```",
    input.trace ? "## Full trace of one failing seed\n```\n" + input.trace + "\n```" : "",
    input.feedback ? "## Your previous attempt\n" + input.feedback : "",
    "Write the complete new settle.js now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

type SuiteSummary = { version?: string | number; summary?: string; totals: SuiteReport["totals"]; ms?: number };
type AttemptRecord = {
  n: number;
  started_at: number;
  model?: string;
  provider?: string;
  model_ms?: number;
  plan?: string;
  diff?: { added: number; removed: number };
  load_error?: string;
  suite?: SuiteSummary;
  suite_ms?: number;
  deployed?: boolean;
};

/** The record of one agent run that the world keeps (POST /agent/last): what the Bench shows on load. */
export type AgentRunRecord = {
  kind: "agent_run";
  ok: boolean;
  reason: string;
  provider?: string;
  models?: string[];
  model?: string;
  started_at: number;
  finished_at: number;
  ms: number;
  baseline?: SuiteSummary;
  attempts: AttemptRecord[];
  deployed?: { version: string; suite?: SuiteSummary } | null;
  version: string;
  final_diff?: { attempt: number; added: number; removed: number; unified: string; source: string } | null;
  errors: string[];
  timings: { baseline_ms?: number; model_ms: number; suite_ms: number; total_ms: number };
};

const cap = (t: string, n = 60_000) => (t.length > n ? t.slice(0, n) + "\n... (truncated)" : t);
const sum = (r: SuiteReport, ms?: number): SuiteSummary => ({ version: r.version, summary: r.summary, totals: r.totals, ...(ms !== undefined ? { ms } : {}) });

/** Builds the run record from the event stream, so the loop itself stays as it is. */
function recorder() {
  const t0 = Date.now();
  const rec: AgentRunRecord = { kind: "agent_run", ok: false, reason: "", started_at: t0, finished_at: t0, ms: 0, attempts: [], version: "", errors: [], timings: { model_ms: 0, suite_ms: 0, total_ms: 0 } };
  let suiteFrom = t0;
  const diffs = new Map<number, AgentRunRecord["final_diff"]>();
  const cur = () => rec.attempts.at(-1);
  return {
    rec,
    see(e: AgentEvent) {
      const now = Date.now();
      switch (e.type) {
        case "status":
          if (e.phase === "start") {
            rec.provider = e.provider;
            rec.models = e.models;
          }
          if (e.phase === "baseline" || e.phase === "suite") suiteFrom = now;
          break;
        case "attempt":
          rec.attempts.push({ n: e.n, started_at: now });
          break;
        case "model": {
          const a = cur();
          rec.model = e.name;
          if (a) Object.assign(a, { model: e.name, provider: e.provider });
          break;
        }
        case "thinking": {
          const a = cur();
          if (a) Object.assign(a, { plan: e.text, model_ms: e.ms });
          rec.timings.model_ms += e.ms;
          break;
        }
        case "diff": {
          const a = cur();
          if (a) a.diff = { added: e.added, removed: e.removed };
          diffs.set(e.attempt, { attempt: e.attempt, added: e.added, removed: e.removed, unified: cap(e.unified), source: cap(e.new) });
          break;
        }
        case "suite": {
          const ms = now - suiteFrom;
          rec.timings.suite_ms += ms;
          if (e.phase === "baseline") {
            rec.baseline = sum(e.report, ms);
            rec.timings.baseline_ms = ms;
          } else if (e.phase === "attempt") {
            const a = cur();
            if (a) Object.assign(a, { suite: sum(e.report), suite_ms: ms });
          } else if (rec.deployed) rec.deployed.suite = sum(e.report, ms);
          break;
        }
        case "uploaded": {
          const a = cur();
          if (a) a.deployed = true;
          rec.deployed = { version: e.version };
          suiteFrom = now;
          break;
        }
        case "error": {
          rec.errors.push(e.text);
          const a = cur();
          if (a && /did not load/.test(e.text)) a.load_error = e.text;
          break;
        }
        case "done":
          rec.ok = e.ok;
          rec.reason = e.reason;
          rec.version = e.version;
          if (e.model) rec.model = e.model;
          break;
        default:
      }
      if (e.type === "done" || e.type === "uploaded") {
        const deployedAttempt = rec.attempts.find((a) => a.deployed)?.n;
        rec.final_diff = (deployedAttempt ? diffs.get(deployedAttempt) : diffs.get(Math.max(0, ...diffs.keys()))) ?? null;
      }
    },
    finish() {
      rec.finished_at = Date.now();
      rec.ms = rec.finished_at - t0;
      rec.timings.total_ms = rec.ms;
      if (!rec.deployed) rec.deployed = null;
      return rec;
    },
  };
}

/**
 * Run the loop, emitting progress events. Never throws; failures arrive as events.
 * When it ends, the run's record goes to the world (POST /agent/last), which keeps it in
 * the sandbox so the Bench can show the last real run after a host cold start.
 */
export async function runAgentFix(emit: (e: AgentEvent) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const r = recorder();
  try {
    await runLoop((e) => {
      r.see(e);
      emit(e);
    }, opts);
  } finally {
    const rec = r.finish();
    if (rec.reason || rec.attempts.length || rec.baseline) {
      await world.postAgentLast(rec as unknown as Record<string, unknown>).catch((e) => console.error("[once/agent] could not keep the run record in the world:", describe(e)));
    }
  }
}

async function runLoop(emit: (e: AgentEvent) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const deadline = Date.now() + BUDGET_MS;
  const plan = modelPlan();
  emit({ type: "status", phase: "start", text: `agent: ${plan.provider} (${plan.models.join(", ")}), up to ${MAX_ATTEMPTS} attempts`, provider: plan.provider, models: plan.models });
  if (plan.provider === "none") {
    emit({ type: "error", text: "no model key: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY" });
    emit({ type: "done", ok: false, version: "", attempts: 0, reason: "no model key configured" });
    return;
  }

  let original: { source: string; version?: number };
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

  let current = original.source;
  let report = failingReport(baseline);
  let trace = await traceFor(baseline, current, 0);
  let feedback: string | undefined;
  let modelStart = 0;
  let best: { failed: number; n: number; code: string; report: string; trace: string } | null = null;

  let attempts = 0;
  let lastModel: string | undefined;
  let outOfTime = false;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    if (opts.signal?.aborted) break;
    if (deadline - Date.now() < 60_000) {
      outOfTime = true;
      emit({ type: "status", phase: "budget", text: `stopping before attempt ${n}: less than 60 s left of the ${BUDGET_MS / 1000} s budget` });
      break;
    }
    attempts = n;
    emit({ type: "attempt", n, of: MAX_ATTEMPTS });
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userPrompt({ current, report, trace, feedback }) },
    ];

    let completion;
    try {
      completion = await complete(
        messages,
        {
          onTrying: (m) => emit({ type: "trying", name: m.model, provider: m.provider }),
          onFallback: (f) => emit({ type: "fallback", ...f }),
          onReasoning: (text) => emit({ type: "reasoning", text }),
          onText: (text) => emit({ type: "delta", text }),
        },
        {
          signal: opts.signal,
          startAt: modelStart,
          deadline,
          accept: (c) => (extractCode(c.text) ? null : "answer had no settle.js code block defining createSettler"),
        },
      );
      modelStart = completion.modelIndex; // stay on the model that answered
    } catch (e) {
      emit({ type: "error", text: describe(e) });
      modelStart = 0;
      continue;
    }
    const code = extractCode(completion.text)!;
    lastModel = completion.model;
    emit({ type: "model", name: completion.model, provider: completion.provider, requested: completion.requested });
    emit({ type: "thinking", text: extractPlan(completion.text), model: completion.model, ms: completion.ms });
    emit({
      type: "diff",
      attempt: n,
      old: current,
      new: code,
      version: `candidate ${n}`,
      unified: unifiedDiff(current, code, { a: "settle.js (before)", b: `settle.js (attempt ${n})` }),
      ...diffStats(current, code),
    });

    // 1. Does it load inside the sandbox?
    let loadError: string | null = null;
    try {
      const val = await world.validateSettle(code);
      if (!val.ok) loadError = val.error ?? "the world refused the module";
    } catch (e) {
      loadError = describe(e);
    }
    if (loadError) {
      emit({ type: "error", text: `attempt ${n} did not load in the sandbox: ${loadError}` });
      feedback = `Your module did not load in the world's sandbox:\n${loadError}\nFix it. Plain JavaScript only, export function createSettler, no imports.`;
      current = code;
      continue;
    }

    // 2. Dry-run the 30 scenarios on the candidate (not deployed).
    emit({ type: "status", phase: "suite", text: `attempt ${n} loads; running 30 seeded fault scenarios on it inside the sandbox` });
    let result: SuiteReport;
    try {
      result = await world.suite({ count: 30, source: code });
      recordSuite(result, "agent", `attempt ${n} (dry run)`);
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
      // 3. Deploy it: the world loads it fresh and replays the live history into it.
      try {
        const up = await world.putSettle(code, `agent-attempt-${n}.js`);
        emit({ type: "uploaded", version: v(up?.version) });
        const confirm = await world.suite({ count: 30 });
        recordSuite(confirm, "agent", `deployed v${v(up?.version)}`);
        emit({ type: "suite", phase: "deployed", report: slim(confirm) });
        emit({ type: "done", ok: true, version: v(up?.version), attempts: n, model: lastModel, reason: `attempt ${n} passes all ${result.totals.count} scenarios; deployed as v${v(up?.version)} (${confirm.summary ?? ""})` });
      } catch (e) {
        emit({ type: "error", text: `attempt ${n} passed but deploying it failed: ${describe(e)}` });
        emit({ type: "done", ok: false, version: v(original.version), attempts: n, reason: "deploy failed" });
      }
      return;
    }
    if (!best || result.totals.failed < best.failed) {
      best = { failed: result.totals.failed, n, code, report: failingReport(result), trace: await traceFor(result, code, n) };
      current = best.code;
      report = best.report;
      trace = best.trace;
      feedback = `It loaded, but ${result.totals.failed} of ${result.totals.count} scenarios still fail (the report and trace above are for YOUR version). Fix the remaining failures without breaking the passing ones.`;
    } else {
      // A regression: build on the best version so far, and say what the last one broke.
      current = best.code;
      report = best.report;
      trace = best.trace;
      feedback = `Your attempt ${n} was worse (${result.totals.failed} failing: ${result.summary ?? ""}) than attempt ${best.n} (${best.failed} failing), so the code above is attempt ${best.n} again. Its failures are listed above. Change less and fix those.`;
    }
  }

  emit({
    type: "done",
    ok: false,
    version: v(original.version),
    attempts,
    model: lastModel,
    reason: `no attempt passed all 30 scenarios in ${attempts} attempt(s)${outOfTime ? " (time budget spent; free models were slow or rate-limited)" : ""}${best ? ` (best: attempt ${best.n}, ${best.failed} failing)` : ""}; nothing was deployed, v${v(original.version)} stays live`,
  });
}
