"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorld } from "@/components/data/provider";
import type { Proof, ReceiptLine } from "@/components/data/types";
import { deployTag, euro, settleLabel } from "@/components/data/types";
import { Tiles } from "@/components/bench/Tiles";
import { RunReceipt } from "./RunReceipt";
import s from "./proof.module.css";

/** Every hold the world knows, with its latest outcome, from the board's receipt lines. */
function holdsFrom(lines: ReceiptLine[]) {
  const by = new Map<string, { payment_intent: string; charger: string; amount_cents: number; url?: string; state: string; captured?: number }>();
  for (const l of lines) {
    if (!l.payment_intent) continue;
    const h = by.get(l.payment_intent) ?? { payment_intent: l.payment_intent, charger: l.charger ?? "", amount_cents: 5000, url: l.stripe_url, state: "uncaptured" };
    if (l.kind === "hold") h.amount_cents = l.amount_cents ?? h.amount_cents;
    if (l.kind === "capture") {
      h.state = "captured";
      h.captured = l.amount_cents;
    }
    if (l.kind === "released" && h.state === "uncaptured") h.state = "released";
    if (l.kind === "refused" && h.state !== "captured") h.state = "refused";
    by.set(l.payment_intent, h);
  }
  return [...by.values()].reverse();
}

export function ProofView() {
  const { world, snap, mode } = useWorld();
  const [proof, setProof] = useState<Proof | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      world
        .proof()
        .then((p) => alive && (setProof(p), setErr(null)))
        .catch((e) => alive && setErr((e as Error).message));
    void load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [world, snap.receipt.length]);

  const suite = proof?.suite ?? snap.suite;
  const settle = proof?.settle ?? snap.settle;
  const sandbox = proof?.sandbox ?? snap.sandbox;
  const holds = holdsFrom(snap.receipt);

  return (
    <>
      <section className={`wrap ${s.head}`}>
        <h1 className={s.h1}>Proof</h1>
        <p className={s.lede}>
          Every capture with its Stripe object, the latest storm report, what the sandbox can and cannot reach, and how to check all of it yourself. {mode === "live" ? "Stripe test mode." : "Mock world: the Stripe ids are stand-ins and the links will not resolve."}
        </p>
      </section>

      <section className={`wrap ${s.grid}`}>
        <div className={`${s.card} ${s.holds}`}>
          <h2 className={s.cardTitle}>Holds in the world</h2>
          {holds.length === 0 ? (
            <p className={s.empty}>
              No holds yet. <Link href="/">Plug in and pay</Link> on the board; the hold appears here at once, the capture when the session ends.
            </p>
          ) : (
            <ul className={s.holdList}>
              {holds.map((h) => (
                <li key={h.payment_intent} className={s.hold} data-state={h.state}>
                  <a href={h.url} target="_blank" rel="noreferrer" className={s.mono}>
                    {h.payment_intent}
                  </a>
                  <span className={s.holdCharger}>{h.charger}</span>
                  <span className={`${s.holdAmt} num`}>{euro(h.amount_cents)} held</span>
                  <span className={s.status} data-status={h.state === "captured" ? "succeeded" : h.state === "uncaptured" ? "requires_capture" : h.state === "refused" ? "refused" : "canceled"}>
                    {h.state === "captured" ? `captured once · ${euro(h.captured ?? 0)}` : h.state}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className={s.holdNote}>Read from the world&apos;s state as the board sees it; the table below is what Stripe answered to each capture attempt.</p>
        </div>

        <div className={`${s.card} ${s.captures}`}>
          <h2 className={s.cardTitle}>Captures</h2>
          {err ? <p className={s.err}>Could not load the ledger: {err}</p> : null}
          {proof && proof.captures.length === 0 ? (
            <p className={s.empty}>
              {holds.length ? "No capture attempt has reached Stripe yet: unplug, then restore the link." : "Nothing has been captured. The first capture appears here with its Stripe id."}
            </p>
          ) : null}
          {proof && proof.captures.length > 0 ? (
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th scope="col">PaymentIntent</th>
                    <th scope="col">Charger</th>
                    <th scope="col">Episode</th>
                    <th scope="col" className={s.num}>Authorised</th>
                    <th scope="col" className={s.num}>Captured</th>
                    <th scope="col">Stripe says</th>
                  </tr>
                </thead>
                <tbody>
                  {proof.captures.map((c, i) => (
                    <tr key={`${c.payment_intent}-${c.idempotency_key}-${i}`} data-status={c.status}>
                      <td data-label="PaymentIntent">
                        <a href={c.url} target="_blank" rel="noreferrer" className={s.mono}>
                          {c.payment_intent}
                        </a>
                      </td>
                      <td data-label="Charger">{c.charger}</td>
                      <td data-label="Episode" className={s.mono}>
                        {c.episode_id || "—"}
                      </td>
                      <td data-label="Authorised" className={`${s.num} num`}>
                        {euro(c.authorized_cents)}
                      </td>
                      <td data-label="Captured" className={`${s.num} num`}>
                        {c.status === "succeeded" ? euro(c.amount_cents) : c.status === "refused" ? `(${euro(c.amount_cents)})` : "—"}
                      </td>
                      <td data-label="Stripe says">
                        <span className={s.status} data-status={c.status}>
                          {c.status === "succeeded" ? "captured once" : c.status === "requires_capture" ? "uncaptured" : c.status === "canceled" ? "released" : "refused"}
                        </span>
                        {c.error ? <span className={s.errText}>{c.error}</span> : null}
                        {c.idempotency_key ? <span className={s.key}>idempotency {c.idempotency_key}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {!proof && !err ? <p className={s.empty}>Loading the ledger…</p> : null}
          <RunReceipt mode={mode} proof={proof} settle={settle} />
        </div>

        <div className={`${s.card} ${s.suite}`}>
          <h2 className={s.cardTitle}>Latest storm report</h2>
          {suite ? (
            <>
              <p className={s.suiteMeta}>
                settle.js <b>{deployTag(suite.version)}</b> · {suite.scenarios.length} seeded scenarios · {suite.ran_at ? new Date(suite.ran_at).toLocaleString() : ""}
              </p>
              <Tiles tiles={suite.scenarios} count={suite.scenarios.length} running={false} />
            </>
          ) : (
            <p className={s.empty}>
              Not run yet. <Link href="/agent">Run the storm</Link> on the bench.
            </p>
          )}
        </div>

        <div className={`${s.card} ${s.sandbox}`}>
          <h2 className={s.cardTitle}>The world&apos;s sandbox</h2>
          <dl className={s.dl}>
            <dt>Provider</dt>
            <dd>{sandbox.provider === "mock" ? "in-browser mock (stands in for CreateOS)" : sandbox.provider === "local" ? "a local world on the host machine (WORLD_URL, development only)" : "CreateOS sandbox via Stripe Projects"}</dd>
            <dt>Name</dt>
            <dd className={s.mono}>{sandbox.name}</dd>
            <dt>Root filesystem</dt>
            <dd className={s.mono}>{sandbox.rootfs}</dd>
            <dt>Egress allowlist</dt>
            <dd>
              <span className={s.mono}>{sandbox.egress.join(", ") || (sandbox.provider === "local" ? "not sandboxed" : "(empty = open)")}</span>
              <small>
                {sandbox.provider === "local"
                  ? "In development the world runs on the host. Deployed, it runs in a CreateOS sandbox whose allowlist holds a single sinkhole entry."
                  : "A single sinkhole entry. HTTP and HTTPS to Stripe, example.com and 1.1.1.1 are refused from inside (the allowlist filters by SNI/Host); DNS still resolves, and nothing secret is inside."}
              </small>
            </dd>
            <dt>Keys inside</dt>
            <dd>
              <b>{sandbox.keys_inside.length === 0 ? "none" : sandbox.keys_inside.join(", ")}</b>
              <small>Stripe keys never enter the sandbox. The world emits capture intents; the host executes them with an idempotency key per episode.</small>
            </dd>
            <dt>State</dt>
            <dd>
              {sandbox.state}
              {sandbox.creates_used ? <small>sandbox creates used: {sandbox.creates_used}</small> : null}
            </dd>
            <dt>Settlement program</dt>
            <dd>
              settle.js <b>{settle ? settleLabel(settle) : "—"}</b>
              {settle?.name ? <> ({settle.name})</> : null} · loaded fresh in <span className={s.mono}>node:vm</span> with no fs, net or process
            </dd>
          </dl>
        </div>

        <div className={`${s.card} ${s.verify}`}>
          <h2 className={s.cardTitle}>How to verify</h2>
          <ol className={s.steps}>
            <li>
              <b>Stripe is the witness.</b> Open any PaymentIntent above in the dashboard (test mode) or run <code>stripe payment_intents retrieve pi_…</code>. One hold of €50.00, <code>amount_received</code> equal to the energy × the tariff (€0.60/kWh by default), <code>amount_capturable</code> 0: the remainder was released.
            </li>
            <li>
              <b>The duplicate.</b> On the board, with <em>Duplicate Stop</em> on: pay, cut the cable, unplug, restore. The wire log shows two StopTransaction messages 1.2 s apart; the ledger shows one capture.
            </li>
            <li>
              <b>The refusal, verbatim.</b> Turn <em>Reboot restarts the transaction</em> on and reboot mid-session under settle.js v1: two capture intents reach Stripe, and Stripe refuses the second with its own message, printed on the receipt.
            </li>
            <li>
              <b>The storms.</b> <code>POST /suite</code> inside the world runs 30 deterministic seeds; the same seed replays the same faults. The report above is the world&apos;s own JSON.
            </li>
            <li>
              <b>The sandbox.</b> From inside the world, <code>curl https://api.stripe.com</code> fails: the egress allowlist contains only a sinkhole. The settlement code could not reach Stripe if it tried.
            </li>
          </ol>
        </div>
      </section>
    </>
  );
}
