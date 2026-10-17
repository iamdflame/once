"use client";

import type { AgentRun, AgentRunSuite } from "@/components/data/adapter";
import { deployTag } from "@/components/data/types";
import s from "./bench.module.css";

const secs = (ms?: number) => (ms == null ? "—" : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
const ago = (t: number) => {
  const d = Math.max(0, Date.now() - t);
  if (d < 90_000) return `${Math.round(d / 1000)} s ago`;
  if (d < 90 * 60_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 36 * 3_600_000) return `${Math.round(d / 3_600_000)} h ago`;
  return new Date(t).toLocaleString();
};
const suiteLine = (r?: AgentRunSuite) => (r ? (r.summary ?? `${r.totals.ok}/${r.totals.count} ok · double ${r.totals.double} · stranded ${r.totals.stranded} · unbilled ${r.totals.unbilled}`) : "not run");
const green = (r?: AgentRunSuite) => !!r && r.totals.ok === r.totals.count && r.totals.count > 0;

/** The agent's last real run, as the world kept it: what a cold visitor sees instead of an empty transcript. */
export function LastRun({ run, mode }: { run: AgentRun; mode: "mock" | "live" }) {
  return (
    <div className={s.lastRun} data-ok={run.ok}>
      <header className={s.lastRunHead}>
        <span className={s.lastRunTag}>{mode === "live" ? "LAST RUN · kept in the sandbox" : "LAST RUN · mock replay"}</span>
        <time dateTime={new Date(run.finished_at).toISOString()}>{ago(run.finished_at)}</time>
      </header>
      <p className={s.lastRunVerdict}>
        <span className={s.lastRunLed} data-ok={run.ok} aria-hidden="true" />
        {run.ok ? `Deployed ${deployTag(run.deployed?.version ?? run.version)} after ${run.attempts.length} attempt${run.attempts.length === 1 ? "" : "s"}: every storm green.` : run.reason || "The agent did not make every storm green."}
      </p>
      <dl className={s.lastRunFacts}>
        <div>
          <dt>Model</dt>
          <dd>
            {run.model ?? run.attempts.find((a) => a.model)?.model ?? "—"}
            {run.provider ? <small> · {run.provider}</small> : null}
          </dd>
        </div>
        <div>
          <dt>Baseline</dt>
          <dd data-green={green(run.baseline)}>{suiteLine(run.baseline)}</dd>
        </div>
        <div>
          <dt>Timings</dt>
          <dd>
            model {secs(run.timings.model_ms)} · suite {secs(run.timings.suite_ms)} · total {secs(run.timings.total_ms)}
          </dd>
        </div>
      </dl>
      <ol className={s.attempts}>
        {run.attempts.map((a) => (
          <li key={a.n} className={s.attempt} data-green={green(a.suite)} data-deployed={a.deployed === true}>
            <span className={s.attemptN}>{a.n}</span>
            <span className={s.attemptBody}>
              <span className={s.attemptHead}>
                <b>{a.model ?? "model"}</b>
                {a.model_ms != null ? <span>{secs(a.model_ms)} to answer</span> : null}
                {a.diff ? (
                  <span>
                    <span className={s.cntDel}>−{a.diff.removed}</span> <span className={s.cntAdd}>+{a.diff.added}</span>
                  </span>
                ) : null}
                {a.deployed ? <span className={s.deployed}>deployed</span> : null}
              </span>
              {a.plan ? <em>{a.plan}</em> : null}
              {a.load_error ? <span className={s.attemptErr}>did not load: {a.load_error}</span> : null}
              <span className={s.attemptSuite}>{a.suite ? `dry run · ${suiteLine(a.suite)}${a.suite_ms != null ? ` · ${secs(a.suite_ms)}` : ""}` : "no suite ran"}</span>
            </span>
          </li>
        ))}
      </ol>
      {run.errors.length ? (
        <ul className={s.lastRunErrors}>
          {run.errors.slice(0, 4).map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
