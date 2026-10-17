"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import s from "./status.module.css";

type CheckState = "ok" | "warn" | "fail";
type Check = { id: string; label: string; state: CheckState; value: string; detail?: string; at?: string | null; age_s?: number | null; url?: string };
type Status = { at: string; overall: CheckState; checks: Check[]; ms: number };

const WORD: Record<CheckState, string> = { ok: "ALL CLEAR", warn: "ATTENTION", fail: "FAULT" };

const ORDER = ["world", "sandbox", "egress", "creates", "capture", "suite", "stripe"];

export function StatusView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const data = (await res.json()) as Status | { error: string };
      if (!res.ok || !("checks" in data)) throw new Error(("error" in data && data.error) || `the host answered ${res.status}`);
      setStatus(data);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  // Ages count up between loads.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const overall: CheckState = err ? "fail" : (status?.overall ?? "warn");
  const since = status ? Math.round((Date.now() - Date.parse(status.at)) / 1000) : 0;
  const checks = status ? [...status.checks].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)) : [];
  void tick;

  return (
    <>
      <section className={`wrap ${s.head}`}>
        <h1 className={s.h1}>Status</h1>
        <p className={s.lede}>
          Outcomes, not HTTP 200. Each row is asserted against the sandbox, the world and Stripe when this page asks, and the panel goes red when the world cannot be reached or no suite has run. Reloads every 30 s.
        </p>
      </section>

      <section className="wrap">
        <div className={s.panel} data-state={overall}>
          <header className={s.panelHead}>
            <span className={s.bigLed} data-state={overall} aria-hidden="true" />
            <div className={s.panelTitle}>
              <h2 className={s.word} data-state={overall}>
                {err ? "FAULT" : status ? WORD[overall] : loading ? "CHECKING" : WORD[overall]}
              </h2>
              <p className={s.panelSub}>
                {err
                  ? `The host could not report: ${err}`
                  : status
                    ? `checked ${new Date(status.at).toLocaleTimeString()} in ${(status.ms / 1000).toFixed(1)} s · ${since < 2 ? "just now" : `${since} s ago`}`
                    : "asking the host, the sandbox and Stripe…"}
              </p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
              {loading ? "Checking…" : "Check again"}
            </button>
          </header>

          <ol className={s.rows} aria-live="polite">
            {err && !status ? (
              <li className={s.row} data-state="fail">
                <span className={s.led} data-state="fail" aria-hidden="true" />
                <span className={s.rowLabel}>Host</span>
                <span className={s.rowBody}>
                  <span className={s.rowValue}>/api/status did not answer</span>
                  <span className={s.rowDetail}>The API routes run on the host (Vercel). The in-browser mock has no status to report; this page is about the deployment.</span>
                </span>
                <Lcd value={null} />
              </li>
            ) : null}
            {!status && !err
              ? ORDER.map((id) => (
                  <li key={id} className={s.row} data-state="pending">
                    <span className={s.led} data-state="pending" aria-hidden="true" />
                    <span className={s.rowLabel}>{labelOf(id)}</span>
                    <span className={s.rowBody}>
                      <span className={s.rowValue}>…</span>
                    </span>
                    <Lcd value={null} />
                  </li>
                ))
              : null}
            {checks.map((c) => (
              <li key={c.id} className={s.row} data-state={c.state}>
                <span className={s.led} data-state={c.state} aria-hidden="true" />
                <span className={s.rowLabel}>
                  {c.label}
                  <span className="sr-only">: {c.state === "ok" ? "ok" : c.state === "warn" ? "attention" : "fault"}</span>
                </span>
                <span className={s.rowBody}>
                  <span className={s.rowValue}>
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer">
                        {c.value}
                      </a>
                    ) : (
                      c.value
                    )}
                  </span>
                  {c.detail ? <span className={s.rowDetail}>{c.detail}</span> : null}
                </span>
                <Lcd value={ageNow(c, status?.at)} label={c.id === "sandbox" ? "age" : "ago"} />
              </li>
            ))}
          </ol>

          <footer className={s.panelFoot}>
            <span>
              Read the same JSON at <code>/api/status</code>.
            </span>
            <span>
              Every capture with its Stripe id is on the <Link href="/proof">proof page</Link>; the run receipt there is what a third party checks against Stripe.
            </span>
          </footer>
        </div>
      </section>
    </>
  );
}

function labelOf(id: string): string {
  return { world: "World", sandbox: "Sandbox", egress: "Egress", creates: "Sandbox creates", capture: "Last capture", suite: "Last suite", stripe: "Stripe" }[id] ?? id;
}

/** Seconds since `c.at`, counted up from the moment the host reported. */
function ageNow(c: Check, reportedAt?: string): number | null {
  if (c.age_s == null) return null;
  const drift = reportedAt ? Math.max(0, Math.round((Date.now() - Date.parse(reportedAt)) / 1000)) : 0;
  return c.age_s + drift;
}

/** A small segment display for an age: hh:mm:ss, ghost segments behind it. */
function Lcd({ value, label = "ago" }: { value: number | null; label?: string }) {
  const text = value == null ? "" : fmt(value);
  return (
    <span className={s.lcd} data-empty={value == null} role="img" aria-label={value == null ? "no time" : `${text} ${label}`}>
      <span className={s.segments} aria-hidden="true">
        <span className={s.ghost}>88:88:88</span>
        <span className={s.lit}>{text}</span>
      </span>
      <span className={s.lcdUnit} aria-hidden="true">
        {value == null ? "" : label}
      </span>
    </span>
  );
}

function fmt(secs: number): string {
  const h = Math.min(99, Math.floor(secs / 3600));
  const m = Math.floor((secs % 3600) / 60);
  const sec = secs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
