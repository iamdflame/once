"use client";

import { useState } from "react";
import type { ProbeCheck, ProbeReport } from "@/components/data/adapter";
import { useWorld } from "@/components/data/provider";
import s from "./proof.module.css";

const GROUPS: { id: ProbeCheck["group"]; title: string; sub: string }[] = [
  { id: "a", title: "settle.js tries to escape the vm", sub: "fetch, require, process.env, import(), eval, the Function-constructor escape: each must be blocked inside the vm or refused by the loader" },
  { id: "b", title: "settle.js runs forever", sub: "an infinite loop in onEvent must be stopped at the 1 s budget" },
  { id: "c", title: "the world process reaches out", sub: "HTTP and HTTPS requests with a body to Stripe, example.com and a raw IP must get no response; two facts are disclosed, not judged" },
  { id: "d", title: "keys and the sandbox settings", sub: "no credential-like name or value in the world's environment (names only); CreateOS's own report of the egress allowlist" },
];

const WORD: Record<ProbeCheck["verdict"], string> = { pass: "blocked", fail: "FAILED", disclosed: "disclosed", "local: not applicable": "local, n/a" };

/** "Probe the boundary": the world attacks its own boxes and reports each attempt. */
export function Probe() {
  const { world, mode } = useWorld();
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setReport(await world.probe());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const judged = report ? report.checks.filter((c) => c.verdict === "pass" || c.verdict === "fail") : [];
  const failed = judged.filter((c) => c.verdict === "fail").length;
  const disclosed = report ? report.checks.filter((c) => c.verdict === "disclosed").length : 0;

  return (
    <div className={`${s.card} ${s.probe}`} data-state={report ? (failed ? "fail" : "ok") : undefined}>
      <div className={s.probeHead}>
        <div>
          <h2 className={s.cardTitle}>The boundary, probed live</h2>
          <p className={s.probeLede}>
            The world runs attacks on its own boxes, inside the sandbox, and reports each one: a settle.js that reaches for <code>fetch</code> or <code>process.env</code>, one that never returns, the world process itself trying to send a body to Stripe, and its
            environment. Three readings: <b className={s.vPass}>blocked</b>, <b className={s.vFail}>failed</b>, <b className={s.vDisc}>disclosed</b> (a fact reported without a verdict).
          </p>
        </div>
        <button type="button" className="btn btn-steel" onClick={() => void run()} disabled={busy}>
          {busy ? <span className={s.spin} aria-hidden="true" /> : <ShieldIcon />}
          {busy ? "Probing…" : report ? "Probe again" : "Probe the boundary"}
        </button>
      </div>

      {err ? <p className={s.err}>The probe did not run: {err}</p> : null}

      {report ? (
        <>
          <p className={s.probeSummary} data-state={failed ? "fail" : "ok"}>
            <span className={s.probeLed} data-state={failed ? "fail" : "ok"} aria-hidden="true" />
            {failed ? `${failed} of ${judged.length} judged checks FAILED` : `${judged.length} of ${judged.length} judged checks blocked`}
            {disclosed ? ` · ${disclosed} disclosed` : ""} · {report.mode === "createos" ? "inside the CreateOS sandbox" : report.mode === "local" ? "a local world (network checks not applicable)" : "mock: the shape of a run, nothing probed"} · {(report.ms / 1000).toFixed(1)} s ·{" "}
            {new Date(report.at).toLocaleTimeString()}
          </p>
          {report.note && mode !== "live" ? <p className={s.probeNote}>{report.note}</p> : null}

          {GROUPS.map((g) => {
            const rows = report.checks.filter((c) => c.group === g.id);
            if (!rows.length) return null;
            return (
              <section key={g.id} className={s.probeGroup} aria-labelledby={`probe-${g.id}`}>
                <h3 id={`probe-${g.id}`} className={s.probeGroupTitle}>
                  <span className={s.probeGroupLetter}>{g.id}</span>
                  {g.title}
                  <small>{g.sub}</small>
                </h3>
                <ul className={s.probeList}>
                  {rows.map((c) => (
                    <li key={c.id} className={s.probeRow} data-verdict={c.verdict}>
                      <span className={s.probeRowLed} data-verdict={c.verdict} aria-hidden="true" />
                      <span className={s.probeRowBody}>
                        <span className={s.probeLabel}>{c.label}</span>
                        <span className={s.probeDetail}>
                          <span className={s.probeVerdict} data-verdict={c.verdict}>
                            {WORD[c.verdict] ?? c.verdict}
                          </span>
                          {c.detail}
                          {c.layer ? <small> · {c.layer}</small> : null}
                          {c.ms != null ? <small> · {c.ms >= 1000 ? `${(c.ms / 1000).toFixed(1)} s` : `${Math.round(c.ms)} ms`}</small> : null}
                        </span>
                        {c.verdict === "fail" && c.expected ? <span className={s.probeExpected}>expected: {c.expected}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          <dl className={s.probeEnv}>
            <dt>World process environment (names only)</dt>
            <dd className={s.mono}>{report.env.world_process.length ? report.env.world_process.join(" ") : "—"}</dd>
            <dt>Flagged as credential-like</dt>
            <dd className={s.mono} data-flagged={report.env.flagged.length > 0}>
              {report.env.flagged.length ? report.env.flagged.join(" ") : "none"}
            </dd>
            <dt>Declared on the sandbox</dt>
            <dd className={s.mono}>{report.env.sandbox_declared.length ? report.env.sandbox_declared.join(" ") : "—"}</dd>
          </dl>
        </>
      ) : (
        <p className={s.empty}>Not probed yet in this session. The probe takes a few seconds: the infinite-loop check deliberately blocks the world for one of them.</p>
      )}
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
