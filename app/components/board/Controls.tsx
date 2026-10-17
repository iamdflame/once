"use client";

import Link from "next/link";
import { useState } from "react";
import type { Charger, Command, Quirk } from "@/components/data/types";
import { QUIRKS } from "@/components/data/types";
import s from "./board.module.css";

export function Controls({
  charger,
  busy,
  notice,
  onCmd,
  onPay,
  onNextHold,
}: {
  charger: Charger | null;
  busy: string | null;
  notice: { tone: "ok" | "warn" | "err"; text: string } | null;
  onCmd(c: Command): void;
  onPay(id: string): void;
  /** Driver B's €50 test hold on this charger, created server-side in Stripe test mode. */
  onNextHold(id: string): void;
}) {
  const [showQuirks, setShowQuirks] = useState(true);
  const c = charger;
  const id = c?.id ?? "";
  const dis = (cond: boolean) => !c || busy !== null || cond;

  return (
    <section id="controls" className={s.panel} aria-labelledby="controls-h">
      <header className={s.panelHead}>
        <h2 id="controls-h" className={s.panelTitle}>
          Controls
        </h2>
        {c ? (
          <p className={s.panelSub}>
            <strong>{c.id}</strong> · {c.kw} kW · link {c.link} · {c.plugged ? "car connected" : "no car"}
            {c.hold ? (
              <>
                {" "}
                · hold{" "}
                <a className={s.piLink} href={`https://dashboard.stripe.com/test/payments/${c.hold.payment_intent}`} target="_blank" rel="noreferrer">
                  {c.hold.payment_intent.slice(0, 11)}…
                </a>{" "}
                {c.hold.status}
              </>
            ) : null}
          </p>
        ) : (
          <p className={s.panelSub}>Select a charger on the wall.</p>
        )}
      </header>

      <div className={s.actions}>
        <button type="button" className="btn btn-primary" disabled={dis(!!c?.plugged || c?.link !== "up")} onClick={() => c && onPay(c.id)}>
          <CardIcon />
          {busy === "pay" ? "Opening Checkout…" : "Plug in and pay €50 hold"}
        </button>
        <button type="button" className="btn btn-hazard" disabled={dis(c?.link !== "up")} onClick={() => onCmd({ op: "cut", charger: id })}>
          <ScissorsIcon />
          Cut cable
        </button>
        <button type="button" className="btn btn-steel" disabled={dis(!c?.plugged)} onClick={() => onCmd({ op: "unplug", charger: id })}>
          Unplug
        </button>
        <button type="button" className="btn btn-steel" disabled={dis(c?.link === "up")} onClick={() => onCmd({ op: "restore", charger: id })}>
          Restore
        </button>
        <button type="button" className="btn btn-steel" disabled={dis(c?.link !== "up")} onClick={() => onCmd({ op: "reboot", charger: id })}>
          Reboot
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={dis(!!c?.plugged || c?.link !== "up")} onClick={() => onCmd({ op: "plug", charger: id })} title="Start a session authorised by RFID, with no Stripe hold">
          Plug in with RFID
        </button>
        <button
          type="button"
          className={`btn btn-steel btn-sm ${s.nextHold}`}
          disabled={dis(false)}
          onClick={() => c && onNextHold(c.id)}
          title="The wrong-driver demo: the next driver's €50 hold on this charger, a Stripe test-mode PaymentIntent created server-side with the test card (pm_card_visa), bound to the next plug-in"
        >
          <DriverIcon />
          {busy === "next-hold" ? "Authorising…" : "Next driver pays €50 test hold"}
        </button>
      </div>

      <p className={`${s.notice} ${notice ? s[`notice_${notice.tone}`] : ""}`} role="status" aria-live="polite">
        {notice?.text ?? (c ? "Test mode: Checkout takes 4242 4242 4242 4242, any future date, any CVC." : "")}
      </p>

      <div className={s.quirks}>
        <button type="button" className={s.quirksToggle} aria-expanded={showQuirks} onClick={() => setShowQuirks((v) => !v)}>
          Firmware quirks {c ? `on ${c.id}` : ""}
          <span className={s.chev} data-open={showQuirks} aria-hidden="true" />
        </button>
        {showQuirks ? (
          <ul className={s.quirkList}>
            {QUIRKS.map((q) => {
              const on = c?.quirks[q.id] ?? false;
              return (
                <li key={q.id} className={s.quirk}>
                  <label className={s.switchLabel}>
                    <input
                      type="checkbox"
                      role="switch"
                      className={s.switchInput}
                      checked={on}
                      disabled={!c || busy !== null}
                      aria-describedby={`q-${q.id}`}
                      onChange={(e) => onCmd({ op: "quirk", charger: id, quirk: q.id as Quirk, on: e.target.checked })}
                    />
                    <span className={s.switch} aria-hidden="true">
                      <span className={s.switchKnob} />
                    </span>
                    <span className={s.switchText}>
                      {q.label}
                      <small id={`q-${q.id}`}>{q.note}</small>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <div className={s.benchLinks}>
        <Link href="/agent?run=storm" className="btn btn-ghost btn-sm">
          Run the storm
        </Link>
        <Link href="/agent?run=fix" className="btn btn-ghost btn-sm">
          Fix it
        </Link>
      </div>
    </section>
  );
}

function DriverIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}

function CardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <path d="M2 10h20" />
      <path d="M6 15h4" />
    </svg>
  );
}

function ScissorsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.1 15.9" />
      <path d="M14.5 14.5 20 20" />
      <path d="M8.1 8.1 12 12" />
    </svg>
  );
}
