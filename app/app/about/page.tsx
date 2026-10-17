import type { Metadata } from "next";
import Link from "next/link";
import s from "./about.module.css";

export const metadata: Metadata = {
  title: "About — Once",
  description: "The company in five lines, and the stack.",
};

export default function AboutPage() {
  return (
    <>
      <section className={`wrap ${s.head}`}>
        <h1 className={s.h1}>
          Exactly-once payments <span className={s.nowrap}>for EV chargers.</span>
        </h1>
        <p className={s.lede}>
          Once is an agent that writes the hold-meter-capture code for public chargers and proves it exactly-once against a fleet of simulated chargers it can cut, reboot and reconnect at will.
        </p>
      </section>

      <section className={`wrap ${s.sheet}`} aria-labelledby="company-h">
        <h2 id="company-h" className={s.sheetTitle}>The company in five lines</h2>
        <dl className={s.lines}>
          <div className={s.line}>
            <dt>Who pays</dt>
            <dd>Charge-point operators and CSMS vendors who must take ad-hoc card payment at public points, and who today find out their offline behaviour from a driver billed twice.</dd>
          </div>
          <div className={s.line}>
            <dt>The law</dt>
            <dd>AFIR (Regulation (EU) 2023/1804, Art. 5) requires ad-hoc payment with a widely used instrument at new public points since 13 April 2024; ≥50 kW points on the TEN-T network comply from 1 January 2027.</dd>
          </div>
          <div className={s.line}>
            <dt>The market</dt>
            <dd>About 1.1 million public charge points in the EU by end 2025, five times 2020 (T&amp;E, 2026). Most operators run well under 500 points on an open-source or white-label CSMS with a payment module and no fault suite.</dd>
          </div>
          <div className={s.line}>
            <dt>The price</dt>
            <dd>€2–5 per public charger per month for the proven settlement module and the storm suite; a conformance runner for CSMS vendors on top. 300k points on small operators is about €11M a year.</dd>
          </div>
          <div className={s.line}>
            <dt>The next step</dt>
            <dd>A &ldquo;pays exactly once offline&rdquo; certificate: charger makers and CSMS vendors run the shared fault suite and publish the result. The OCA certifies protocol conformance; nobody certifies the money.</dd>
          </div>
        </dl>
      </section>

      <section className={`wrap ${s.stack}`} aria-labelledby="stack-h">
        <h2 id="stack-h" className={s.sheetTitle}>The stack</h2>
        <p className={s.stackLine}>
          <b>Stripe Projects</b> provisions the stack and the identity: the CreateOS key, an LLM provider, the deployment. <b>CreateOS</b> runs the world in one sandbox with no egress and no keys: the CSMS, twelve OCPP 1.6J chargers with firmware quirks, the link proxies and the agent&apos;s
          settlement program. <b>Stripe</b> holds €50 with manual capture through Checkout, captures once per plug-in episode with an idempotency key the host derives from the episode, and refuses anything more. The host is a Next.js app; the model writes code, never decisions.
        </p>
        <ul className={s.facts}>
          <li>
            <b>The world decides.</b> settle.js runs inside the sandbox and emits capture intents.
          </li>
          <li>
            <b>The host executes.</b> One Stripe capture per intent, idempotency key per episode.
          </li>
          <li>
            <b>Stripe is the witness.</b> A second capture is refused in Stripe&apos;s own words.
          </li>
        </ul>
        <p className={s.links}>
          <Link href="/" className="btn btn-primary">
            Open the board
          </Link>
          <Link href="/proof" className="btn btn-ghost">
            Read the proof
          </Link>
        </p>
      </section>
    </>
  );
}
