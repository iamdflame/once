"use client";

import Link from "next/link";
import type { Charger } from "@/components/data/types";
import { euro } from "@/components/data/types";
import s from "./board.module.css";

export type GuideStep = 0 | 1 | 2 | 3 | 4 | 5;

export interface GuideCapture {
  amount_cents: number;
  wrong_driver: boolean;
  driver?: string | null;
  energy_driver?: string | null;
}

const STEPS: { title: string; short: string; hint: string }[] = [
  { title: "Plug in and pay", short: "Pay", hint: "driver A · test card 4242 4242 4242 4242" },
  { title: "Cut the cable", short: "Cut", hint: "the charger keeps metering offline" },
  { title: "Unplug", short: "Unplug", hint: "A leaves; the Stop is queued in firmware" },
  { title: "Next driver pays", short: "Driver B", hint: "driver B's €50 test hold on the same charger" },
  { title: "Restore", short: "Restore", hint: "A's Stop arrives; whose hold gets charged?" },
];

/**
 * The try-it strip: the wrong-driver story in five numbered steps that light as the
 * person completes them, with the current step's action right here, above the fold.
 * `reached` is the last step the Board saw completed; `captured` is the capture that
 * landed after the restore.
 */
export function Guide({
  charger,
  reached,
  captured,
  busy,
  agentWritten,
  onPay,
  onCmd,
  onNextHold,
}: {
  charger: Charger | null;
  reached: GuideStep;
  captured: GuideCapture | null;
  busy: string | null;
  agentWritten: boolean;
  onPay(id: string): void;
  onCmd(op: "cut" | "unplug" | "restore", id: string): void;
  onNextHold(id: string): void;
}) {
  const id = charger?.id ?? "";
  // Step 1 counts as done once a hold or a car is on the plate, however it got there.
  const done = Math.max(reached, charger && (charger.hold || charger.plugged) ? 1 : 0) as GuideStep;
  const finished = done >= 5 && captured !== null;
  const active = finished ? 6 : done + 1; // 1..5, 6 = all lit

  const action = (() => {
    if (!charger) return { label: "Pick a charger on the wall", disabled: true, tone: "btn-primary", run: () => {} };
    if (finished) return null;
    switch (active) {
      case 1:
        return { label: `Plug in and pay €50 hold on ${id}`, disabled: busy !== null || charger.plugged || charger.link !== "up", tone: "btn-primary", run: () => onPay(id) };
      case 2:
        return { label: `Cut the cable on ${id}`, disabled: busy !== null || charger.link !== "up", tone: "btn-hazard", run: () => onCmd("cut", id) };
      case 3:
        return { label: `Unplug ${id}`, disabled: busy !== null || !charger.plugged, tone: "btn-primary", run: () => onCmd("unplug", id) };
      case 4:
        return { label: `Next driver pays €50 test hold on ${id}`, disabled: busy !== null, tone: "btn-primary", run: () => onNextHold(id) };
      case 5:
        return { label: `Restore the link on ${id}`, disabled: busy !== null || charger.link === "up", tone: "btn-primary", run: () => onCmd("restore", id) };
      default:
        return null;
    }
  })();

  const scrollToControls = () => document.getElementById("controls")?.scrollIntoView({ behavior: "smooth", block: "start" });

  const outcome = finished
    ? captured!.wrong_driver
      ? `driver ${captured!.driver ?? "B"} charged ${euro(captured!.amount_cents)} for driver ${captured!.energy_driver ?? "A"}'s energy`
      : `captured once, ${euro(captured!.amount_cents)}, on driver ${captured!.driver ?? "A"}'s own hold`
    : null;

  return (
    <section className={s.guide} aria-label="Try it in five steps" data-outcome={finished ? (captured!.wrong_driver ? "wrong" : "right") : undefined}>
      <ol className={s.guideSteps}>
        {STEPS.map((st, i) => {
          const n = i + 1;
          const state = n < active ? "done" : n === active ? "active" : "pending";
          const waiting = n === 5 && done >= 5 && !finished;
          const last = n === 5 && finished;
          return (
            <li key={n} className={s.guideStep} data-state={state} data-wrong={last && captured!.wrong_driver ? "true" : undefined} aria-current={state === "active" ? "step" : undefined}>
              <span className={s.guideN} aria-hidden="true">
                {n}
              </span>
              <span className={s.guideText}>
                <b>
                  <span className={s.guideLong}>{st.title}</span>
                  <span className={s.guideShort}>{st.short}</span>
                </b>
                <small>{last ? outcome : waiting ? "waiting for the capture…" : state === "done" ? "done" : st.hint}</small>
              </span>
            </li>
          );
        })}
      </ol>
      <div className={s.guideActions}>
        {finished ? (
          captured!.wrong_driver ? (
            <Link href="/agent?run=fix" className="btn btn-primary">
              Fix it on the bench
            </Link>
          ) : (
            <Link href="/proof" className="btn btn-primary">
              See the proof
            </Link>
          )
        ) : action ? (
          <button type="button" className={`btn ${action.tone}`} disabled={action.disabled} onClick={action.run}>
            {busy === "pay" ? "Opening Checkout…" : busy === "next-hold" ? "Authorising the test hold…" : action.label}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={scrollToControls}>
          <ChevronDown />
          Controls
        </button>
      </div>
      {finished ? (
        <p className={s.guideVerdict} data-wrong={captured!.wrong_driver}>
          {captured!.wrong_driver
            ? `Under the naive settle.js the Stop that arrived after driver B paid was billed to B's hold, and Stripe said succeeded: Stripe only refuses a second capture, not a wrong one. A's €50 hold is stranded. The agent's fix keys the ledger by plug-in episode.`
            : agentWritten
              ? `Under the agent-written settle.js each driver is billed on their own hold: A's energy on A's hold, B's hold waits for B's plug-in. Stripe witnessed one capture per hold.`
              : `Each driver was billed on their own hold. Stripe witnessed one capture per hold.`}
        </p>
      ) : null}
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
