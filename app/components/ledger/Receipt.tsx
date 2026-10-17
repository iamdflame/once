"use client";

import { useEffect, useRef } from "react";
import type { ReceiptLine } from "@/components/data/types";
import s from "./receipt.module.css";

function stamp(t: number) {
  if (!t || t < 1e12) return "";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function Receipt({ lines, mode, tall = false }: { lines: ReceiptLine[]; mode: "mock" | "live"; tall?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lines.length]);

  return (
    <section className={`${s.printer} ${tall ? s.tall : ""}`} aria-labelledby="receipt-h">
      <div className={s.head}>
        <span className={s.headLabel}>LEDGER</span>
        <span className={s.headSlot} aria-hidden="true" />
      </div>
      <div ref={ref} className={s.paper}>
        <div className={s.strip}>
          <header className={s.title}>
            <h2 id="receipt-h">ONCE · SETTLEMENT</h2>
            <p>
              {mode === "live" ? "Stripe · test mode" : "Stripe stand-in · mock"}
              <br />
              one capture per plug-in episode
            </p>
            <span className={s.rule} aria-hidden="true" />
          </header>
          <ol className={s.lines}>
            {lines.length === 0 ? (
              <li className={s.empty}>
                No holds yet.
                <br />
                Plug in and pay on a charger.
              </li>
            ) : null}
            {lines.map((l) => (
              <li key={l.id} className={s.line} data-kind={l.kind}>
                <span className={s.lineMain}>
                  <span className={s.lineText}>{l.text}</span>
                  {l.kind !== "refused" && l.kind !== "note" && l.amount_cents != null ? (
                    <span className={`${s.lineAmt} num`}>{(l.amount_cents / 100).toFixed(2)}</span>
                  ) : null}
                </span>
                <span className={s.lineMeta}>
                  {l.charger ? <span>{l.charger}</span> : null}
                  {l.payment_intent ? (
                    <a href={l.stripe_url} target="_blank" rel="noreferrer" title="Open the PaymentIntent in the Stripe dashboard (test mode)">
                      {l.payment_intent.length > 18 ? `${l.payment_intent.slice(0, 10)}…${l.payment_intent.slice(-4)}` : l.payment_intent}
                    </a>
                  ) : null}
                  {stamp(l.t) ? <time>{stamp(l.t)}</time> : null}
                </span>
              </li>
            ))}
          </ol>
          <footer className={s.foot} aria-hidden="true">
            <span className={s.rule} />
            <span>stranded holds are counted · duplicates are Stripe&apos;s to refuse</span>
          </footer>
        </div>
        <div className={s.tear} aria-hidden="true" />
      </div>
    </section>
  );
}
