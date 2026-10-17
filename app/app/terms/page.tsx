import type { Metadata } from "next";
import Link from "next/link";
import s from "@/components/shell/prose.module.css";

export const metadata: Metadata = {
  title: "Terms — Once",
  description: "A demo in Stripe test mode. No real money, no service commitment.",
};

export default function TermsPage() {
  return (
    <>
      <section className={`wrap ${s.head}`}>
        <h1 className={s.h1}>Terms</h1>
        <p className={s.lede}>Short, because the product is a demonstration. Last changed 2026-10-17.</p>
      </section>
      <section className="wrap">
        <div className={`${s.sheet} ${s.prose}`}>
          <h2 id="what">What this is</h2>
          <p>
            Once is a hackathon demonstration of exactly-once payment settlement for EV chargers. The chargers are simulated. Everything money-related runs in <b>Stripe test mode</b>: the Checkout page, the €50 hold, the capture and the refused duplicate are test objects paid with test cards.
            No real money moves and nothing you do here charges a real card.
          </p>
          <h2 id="use">Using it</h2>
          <ul>
            <li>You may use the board, the bench and the proof page freely. Use the test card <code>4242 4242 4242 4242</code>; do not enter a real card number.</li>
            <li>The sandbox and the model run on free plans with daily limits. When a limit is reached the live mode degrades; the in-browser mock keeps working.</li>
            <li>Do not try to break out of the sandbox, abuse the quota or attack the host. If you find a weakness, see the <Link href="/security">security page</Link>.</li>
          </ul>
          <h2 id="no-warranty">No service, no warranty</h2>
          <p>
            There is no service level, no uptime promise and no support commitment. The software is provided as is. It is not a payment service and it does not process payments on anyone&apos;s behalf; the design is that generated code would run on a customer&apos;s own Stripe
            account. Pricing on the <Link href="/pricing">pricing page</Link> is an estimate, not an offer; there are no customers and no revenue.
          </p>
          <h2 id="source">Source and licence</h2>
          <p>
            The code is at{" "}
            <a href="https://github.com/iamdflame/once" target="_blank" rel="noreferrer">
              github.com/iamdflame/once
            </a>
            . The DSEG7 font is used under the SIL Open Font License; Barlow Semi Condensed and JetBrains Mono under their own open licences.
          </p>
        </div>
      </section>
    </>
  );
}
