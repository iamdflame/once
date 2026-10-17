"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorld } from "@/components/data/provider";
import type { Proof } from "@/components/data/types";
import { euro } from "@/components/data/types";
import { Tiles } from "@/components/bench/Tiles";
import s from "./proof.module.css";

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

  return (
    <>
      <section className={`wrap ${s.head}`}>
        <h1 className={s.h1}>Proof</h1>
        <p className={s.lede}>
          Every capture with its Stripe object, the latest storm report, what the sandbox can and cannot reach, and how to check all of it yourself. {mode === "live" ? "Stripe test mode." : "Mock world: the Stripe ids are stand-ins and the links will not resolve."}
        </p>
      </section>

      <section className={`wrap ${s.grid}`}>
        <div className={`${s.card} ${s.captures}`}>
          <h2 className={s.cardTitle}>Captures</h2>
          {err ? <p className={s.err}>Could not load the ledger: {err}</p> : null}
          {proof && proof.captures.length === 0 ? (
            <p className={s.empty}>
              No holds yet. <Link href="/">Plug in and pay</Link> on the board; the capture appears here with its Stripe id.
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
                      <td>
                        <a href={c.url} target="_blank" rel="noreferrer" className={s.mono}>
                          {c.payment_intent}
                        </a>
                      </td>
                      <td>{c.charger}</td>
                      <td className={s.mono}>{c.episode_id || "—"}</td>
                      <td className={`${s.num} num`}>{euro(c.authorized_cents)}</td>
                      <td className={`${s.num} num`}>{c.status === "succeeded" ? euro(c.amount_cents) : c.status === "refused" ? `(${euro(c.amount_cents)})` : "—"}</td>
                      <td>
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
        </div>

        <div className={`${s.card} ${s.suite}`}>
          <h2 className={s.cardTitle}>Latest storm report</h2>
          {suite ? (
            <>
              <p className={s.suiteMeta}>
                settle.js <b>{suite.version}</b> · {suite.scenarios.length} seeded scenarios · {suite.ran_at ? new Date(suite.ran_at).toLocaleString() : ""}
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
            <dd>{sandbox.provider === "mock" ? "in-browser mock (stands in for CreateOS)" : "CreateOS sandbox via Stripe Projects"}</dd>
            <dt>Name</dt>
            <dd className={s.mono}>{sandbox.name}</dd>
            <dt>Root filesystem</dt>
            <dd className={s.mono}>{sandbox.rootfs}</dd>
            <dt>Egress allowlist</dt>
            <dd>
              <span className={s.mono}>{sandbox.egress.join(", ") || "(empty = open)"}</span>
              <small>A single sinkhole entry. Stripe, example.com and 1.1.1.1 are unreachable from inside: the world has no internet at all.</small>
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
              settle.js <b>{settle?.version ?? "—"}</b> · {settle?.author === "agent" ? "written by the agent" : "shipped with the world"} · loaded fresh in <span className={s.mono}>node:vm</span> with no fs, net or process
            </dd>
          </dl>
        </div>

        <div className={`${s.card} ${s.verify}`}>
          <h2 className={s.cardTitle}>How to verify</h2>
          <ol className={s.steps}>
            <li>
              <b>Stripe is the witness.</b> Open any PaymentIntent above in the dashboard (test mode) or run <code>stripe payment_intents retrieve pi_…</code>. One hold of €50.00, <code>amount_received</code> equal to the energy × €0.38/kWh, <code>amount_capturable</code> 0: the remainder was released.
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
