"use client";

import Link from "next/link";
import type { Charger } from "@/components/data/types";
import { euro } from "@/components/data/types";
import s from "./board.module.css";

export type GuideStep = 0 | 1 | 2 | 3 | 4;

const STEPS: { title: string; hint: string }[] = [
  { title: "Plug in and pay", hint: "test card 4242 4242 4242 4242" },
  { title: "Cut the cable", hint: "the charger keeps metering offline" },
  { title: "Unplug", hint: "the Stop is queued in firmware" },
  { title: "Restore", hint: "the Stop arrives twice; watch the receipt" },
];

/**
 * The try-it strip: four numbered steps that light as the person completes them, and
 * the current step's action right here, above the fold. `reached` is the last step
 * the Board saw completed; `captured` is the capture that landed after the restore.
 */
export function Guide({
  charger,
  reached,
  captured,
  busy,
  onPay,
  onCmd,
}: {
  charger: Charger | null;
  reached: GuideStep;
  captured: { amount_cents: number } | null;
  busy: string | null;
  onPay(id: string): void;
  onCmd(op: "cut" | "unplug" | "restore", id: string): void;
}) {
  const id = charger?.id ?? "";
  // Step 1 counts as done once a hold or a car is on the plate, however it got there.
  const done = Math.max(reached, charger && (charger.hold || charger.plugged) ? 1 : 0) as GuideStep;
  const finished = done >= 4 && captured !== null;
  const active = finished ? 5 : done + 1; // 1..4, 5 = all lit

  const action = (() => {
    if (!charger) return { label: "Pick a charger on the wall", disabled: true, run: () => {} };
    if (finished) return null;
    switch (active) {
      case 1:
        return { label: `Plug in and pay €50 hold on ${id}`, disabled: busy !== null || charger.plugged || charger.link !== "up", run: () => onPay(id) };
      case 2:
        return { label: `Cut the cable on ${id}`, disabled: busy !== null || charger.link !== "up", run: () => onCmd("cut", id) };
      case 3:
        return { label: `Unplug ${id}`, disabled: busy !== null || !charger.plugged, run: () => onCmd("unplug", id) };
      case 4:
        return { label: `Restore the link on ${id}`, disabled: busy !== null || charger.link === "up", run: () => onCmd("restore", id) };
      default:
        return null;
    }
  })();

  const scrollToControls = () => document.getElementById("controls")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <section className={s.guide} aria-label="Try it in four steps">
      <ol className={s.guideSteps}>
        {STEPS.map((st, i) => {
          const n = i + 1;
          const state = n < active ? "done" : n === active ? "active" : "pending";
          const waiting = n === 4 && done >= 4 && !finished;
          return (
            <li key={n} className={s.guideStep} data-state={state} aria-current={state === "active" ? "step" : undefined}>
              <span className={s.guideN} aria-hidden="true">
                {n}
              </span>
              <span className={s.guideText}>
                <b>{st.title}</b>
                <small>
                  {finished && n === 4 ? `captured once, ${euro(captured!.amount_cents)}` : waiting ? "waiting for the capture…" : state === "done" ? "done" : st.hint}
                </small>
              </span>
            </li>
          );
        })}
      </ol>
      <div className={s.guideActions}>
        {finished ? (
          <Link href="/proof" className="btn btn-primary">
            See the proof
          </Link>
        ) : action ? (
          <button type="button" className={`btn ${active === 2 ? "btn-hazard" : "btn-primary"}`} disabled={action.disabled} onClick={action.run}>
            {busy === "pay" ? "Opening Checkout…" : action.label}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={scrollToControls}>
          <ChevronDown />
          Controls
        </button>
      </div>
    </section>
  );
}

function ChevronDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
