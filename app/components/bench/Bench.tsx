"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorld } from "@/components/data/provider";
import type { AgentEvent, Scenario } from "@/components/data/types";
import { Diff } from "./Diff";
import { Tiles } from "./Tiles";
import s from "./bench.module.css";

type Run = "storm" | "fix" | null;

interface Transcript {
  id: number;
  kind: "status" | "thinking" | "error" | "done";
  text: string;
}

export function Bench() {
  const { world, snap, mode } = useWorld();
  const [run, setRun] = useState<Run>(null);
  const [tiles, setTiles] = useState<(Scenario | null)[]>(() => snap.suite?.scenarios.slice(0, 30) ?? []);
  const [diff, setDiff] = useState<{ old: string; new: string; version: string } | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ n: number; of: number } | null>(null);
  const [status, setStatus] = useState<string>("Idle. The storm runs 30 seeded fault scenarios against the current settle.js inside the sandbox.");
  const [lines, setLines] = useState<Transcript[]>([]);
  const [outcome, setOutcome] = useState<"green" | "red" | null>(snap.suite ? (snap.suite.totals.ok === snap.suite.totals.count ? "green" : "red") : null);
  const seq = useRef(0);
  const auto = useRef(false);
  const logRef = useRef<HTMLOListElement>(null);

  const push = useCallback((kind: Transcript["kind"], text: string) => {
    setLines((l) => [...l.slice(-80), { id: ++seq.current, kind, text }]);
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const consume = useCallback(
    async (it: AsyncIterable<AgentEvent>) => {
      for await (const ev of it) {
        switch (ev.type) {
          case "status":
            setStatus(ev.text);
            push("status", ev.text);
            break;
          case "attempt":
            setAttempt({ n: ev.n, of: ev.of });
            break;
          case "model":
            setModel(`${ev.name} · ${ev.provider}`);
            break;
          case "thinking":
            push("thinking", ev.text);
            break;
          case "diff":
            setDiff({ old: ev.old, new: ev.new, version: ev.version });
            setStatus(`settle.js ${ev.version} written`);
            break;
          case "uploaded":
            setStatus(`settle.js ${ev.version} loaded into the world`);
            break;
          case "scenario":
            setTiles((t) => {
              const next = t.length === ev.count ? [...t] : Array.from({ length: ev.count }, (_, i) => t[i] ?? null);
              next[ev.index] = ev.scenario;
              return next;
            });
            break;
          case "suite": {
            const ok = ev.report.totals.ok === ev.report.totals.count;
            setOutcome(ok ? "green" : "red");
            const line = `settle.js ${ev.report.version} · ${ev.report.totals.ok}/${ev.report.totals.count} green · stranded ${ev.report.totals.stranded} · double ${ev.report.totals.double} · unbilled ${ev.report.totals.unbilled}`;
            setStatus(line);
            push(ok ? "done" : "status", line);
            break;
          }
          case "done":
            push("done", ev.ok ? `Deployed settle.js ${ev.version} after ${ev.attempts} attempt${ev.attempts === 1 ? "" : "s"}: every storm green.` : `Stopped after ${ev.attempts} attempts; the suite is still red.`);
            setStatus(ev.ok ? `settle.js ${ev.version} deployed · exactly once, 30 of 30` : "The agent could not make every storm green.");
            break;
          case "error":
            push("error", ev.text);
            setStatus(ev.text);
            break;
        }
      }
    },
    [push],
  );

  const start = useCallback(
    async (what: Exclude<Run, null>) => {
      if (run) return;
      setRun(what);
      setOutcome(null);
      if (what === "fix") {
        setDiff(null);
        setLines([]);
      }
      setTiles((t) => (t.length ? t.map(() => null) : t));
      try {
        await consume(what === "storm" ? world.runSuite() : world.fix());
      } finally {
        setRun(null);
      }
    },
    [consume, run, world],
  );

  useEffect(() => {
    if (auto.current) return;
    auto.current = true;
    const q = new URLSearchParams(window.location.search).get("run");
    if (q === "storm" || q === "fix") {
      history.replaceState(null, "", "/agent");
      void start(q);
    }
  }, [start]);

  const current = snap.settle;
  const oldText = diff?.old ?? current.source;
  const newText = diff?.new ?? "";

  return (
    <>
      <section className={`wrap ${s.head}`}>
        <div>
          <h1 className={s.h1}>The bench</h1>
          <p className={s.lede}>
            The agent reads the storm report and the current settlement program, writes a new <code>settle.js</code>, and the world runs 30 storms against it inside the sandbox. The
            model never touches Stripe; it writes code that emits capture intents.
          </p>
        </div>
        <div className={s.headActions}>
          <button type="button" className="btn btn-steel" disabled={run !== null} onClick={() => start("storm")}>
            {run === "storm" ? <Spinner /> : <StormIcon />}
            Run the storm
          </button>
          <button type="button" className="btn btn-primary" disabled={run !== null} onClick={() => start("fix")}>
            {run === "fix" ? <Spinner /> : <WrenchIcon />}
            Fix it
          </button>
        </div>
      </section>

      <section className={s.worktop}>
        <div className={`wrap ${s.benchGrid}`}>
          <div className={s.statusBar} role="status" aria-live="polite">
            <span className={s.statusLight} data-state={run ? "running" : outcome ?? "idle"} aria-hidden="true" />
            <span className={s.statusText}>{status}</span>
            <span className={s.statusMeta}>
              {attempt ? <span>attempt {attempt.n}/{attempt.of}</span> : null}
              <span>model {model ?? (mode === "live" ? "waiting" : "—")}</span>
              <span>
                settle.js <b>{current.version}</b> · {current.author === "agent" ? "written by the agent" : "shipped with the world"}
              </span>
            </span>
          </div>

          <div className={s.diffCol}>
            <Diff oldText={oldText} newText={newText} oldLabel={diff ? versionBefore(diff.version, current.version) : current.version} newLabel={diff?.version ?? ""} />
          </div>

          <div className={s.tilesCol}>
            <h2 className={s.colTitle}>30 storms</h2>
            <Tiles tiles={tiles} running={run !== null} />
            <RedList tiles={tiles} />
          </div>

          <div className={s.logCol}>
            <h2 className={s.colTitle}>Transcript</h2>
            <ol ref={logRef} className={s.log}>
              {lines.length === 0 ? <li className={s.logEmpty}>Press Fix it. The transcript shows what the agent read, decided and wrote.</li> : null}
              {lines.map((l) => (
                <li key={l.id} className={s.logLine} data-kind={l.kind}>
                  {l.text}
                </li>
              ))}
            </ol>
            <p className={s.logFoot}>
              Every capture lands on the <Link href="/proof">proof page</Link> with its Stripe id.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

function versionBefore(next: string, current: string): string {
  const n = Number(next.replace(/\D/g, ""));
  return Number.isFinite(n) && n > 1 ? `v${n - 1}` : current;
}

function RedList({ tiles }: { tiles: (Scenario | null)[] }) {
  const red = tiles.filter((t): t is Scenario => !!t && !t.ok);
  if (red.length === 0) return null;
  return (
    <ul className={s.redList} aria-label="Failing scenarios">
      {red.slice(0, 8).map((sc) => (
        <li key={sc.seed}>
          <b>seed {sc.seed}</b> {sc.faults.join(" → ")}
          <span>
            {sc.double ? ` double ${sc.double}` : ""}
            {sc.stranded ? ` stranded ${sc.stranded}` : ""}
            {sc.unbilled ? ` unbilled ${sc.unbilled}` : ""}
          </span>
        </li>
      ))}
      {red.length > 8 ? <li className={s.redMore}>and {red.length - 8} more</li> : null}
    </ul>
  );
}

function Spinner() {
  return <span className={s.spinner} aria-hidden="true" />;
}

function StormIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 16a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 6 16" />
      <path d="m13 13-2 4h3l-2 4" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.7 6.3a4 4 0 0 0 5 5L21 10l-4-4-2.3.3z" />
      <path d="m15 9-9.5 9.5a2 2 0 1 1-3-3L12 6" />
    </svg>
  );
}
