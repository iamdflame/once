import type { Metadata } from "next";
import Link from "next/link";
import p from "@/components/shell/prose.module.css";
import r from "@/components/ledger/receipt.module.css";
import s from "./pricing.module.css";

export const metadata: Metadata = {
  title: "Pricing — Once",
  description: "An estimate, in the product's own voice: two to five euros per public charger per month for the payment module, the fault suite and the agent's fixes proven before deploy.",
};

const INCLUDED: { item: string; what: string; qty: string }[] = [
  { item: "PAYMENT MODULE", what: "settle.js for your CSMS: hold on plug-in, meter, one capture per plug-in episode, the rest released", qty: "1" },
  { item: "FAULT SUITE", what: "30 seeded storms: cut, unplug offline, restore, duplicate Stop, reboot-restart, Stop without Start, meter reset", qty: "30" },
  { item: "AGENT FIXES", what: "every red seed goes back to the agent; a candidate is dry-run in the sandbox and deploys only when all 30 are green", qty: "∞" },
  { item: "STRIPE EXECUTOR", what: "captures run on the host with an idempotency key per decision; Stripe's answer comes back verbatim", qty: "1" },
  { item: "PROOF", what: "every capture with its PaymentIntent id and a run receipt a third party can check against Stripe", qty: "1" },
];

export default function PricingPage() {
  return (
    <>
      <section className={`wrap ${p.head}`}>
        <h1 className={p.h1}>Two to five euros per public charger per month.</h1>
        <p className={p.lede}>
          The number is an estimate from{" "}
          <a href="https://github.com/iamdflame/once/blob/main/docs/BUSINESS.md" target="_blank" rel="noreferrer">
            docs/BUSINESS.md
          </a>
          , not a price list. There are no customers yet; the first job of a pilot is to find out whether it is wrong.
        </p>
        <p className={p.stamp}>estimate · no customers · Stripe test mode</p>
      </section>

      <section className={`wrap ${s.grid}`}>
        {/* The tariff plate: what a charger would show for this product. */}
        <div className={s.plateCol}>
          <div className={s.plate} aria-label="Tariff plate: 2 to 5 euro per charger per month, estimate">
            <div className={s.plateTop}>
              <span className={s.stencil}>TARIFF</span>
              <span className={s.led} aria-hidden="true" />
            </div>
            <div className={s.lcd}>
              <div className={s.lcdRow}>
                <span className={s.segments} aria-hidden="true">
                  <span className={s.ghost}>8.8-8.8</span>
                  <span className={s.lit}>2.0-5.0</span>
                </span>
                <span className={s.unit} aria-hidden="true">
                  EUR
                </span>
              </div>
              <div className={s.lcdRow}>
                <span className={s.segments} aria-hidden="true">
                  <span className={s.ghost}>8</span>
                  <span className={s.lit}>1</span>
                </span>
                <span className={s.unit} aria-hidden="true">
                  CHARGER / MONTH
                </span>
              </div>
              <span className={s.lcdLine}>ESTIMATE · NOT A QUOTE</span>
            </div>
            <p className={s.plateNote}>
              For charge-point operators. The module runs on your Stripe account; Once is test and correctness tooling plus the generated code, not a payment institution.
            </p>
          </div>

          <div className={s.rung}>
            <h2 className={s.rungTitle}>The next rung</h2>
            <p className={s.rungPrice}>
              <b>€0.5–1k</b> per CSMS vendor per month <span className={s.est}>estimate</span>
            </p>
            <p>
              A conformance runner for charger makers and CSMS vendors: the same fault suite, versioned like a test standard (&ldquo;pays exactly once while offline, suite v1, 30/30&rdquo;), run against their stack, with a published result they can link from their AFIR documentation.
            </p>
            <p className={p.quiet}>
              The OCA&apos;s OCTT certifies protocol conformance, Eichrecht covers the meter and EMV/PCI the card. The offline behaviour of the payment code sits between those, and that is what this would test. No certification by the OCA, Stripe or a regulator is claimed.
            </p>
          </div>
        </div>

        {/* What is included, printed as the receipt would print it. */}
        <div className={`${r.printer} ${r.tall} ${s.receipt}`} aria-labelledby="included-h">
          <div className={r.head}>
            <span className={r.headLabel}>INCLUDED</span>
            <span className={r.headSlot} aria-hidden="true" />
          </div>
          <div className={r.paper}>
            <div className={r.strip}>
              <header className={r.title}>
                <h2 id="included-h">ONCE · PER CHARGER</h2>
                <p>
                  proven settlement, every change re-run
                  <br />
                  prices are estimates
                </p>
                <span className={r.rule} aria-hidden="true" />
              </header>
              <ol className={r.lines}>
                {INCLUDED.map((l) => (
                  <li key={l.item} className={r.line} data-kind="capture">
                    <span className={r.lineMain}>
                      <span className={r.lineText}>{l.item}</span>
                      <span className={`${r.lineAmt} num`}>×{l.qty}</span>
                    </span>
                    <span className={r.lineMeta}>
                      <span>{l.what}</span>
                    </span>
                  </li>
                ))}
                <li className={r.line} data-kind="hold">
                  <span className={r.lineMain}>
                    <span className={r.lineText}>PER CHARGER / MONTH</span>
                    <span className={`${r.lineAmt} num`}>2.00–5.00</span>
                  </span>
                  <span className={r.lineMeta}>
                    <span>EUR, estimate; 300,000 points on small operators at €36 a year is about €11M a year: illustrative arithmetic, not a forecast</span>
                  </span>
                </li>
                <li className={r.line} data-kind="released">
                  <span className={r.lineMain}>
                    <span className={r.lineText}>STRIPE FEES</span>
                    <span className={`${r.lineAmt} num`}>yours</span>
                  </span>
                  <span className={r.lineMeta}>
                    <span>processing fees on captures are the operator&apos;s, on the operator&apos;s own Stripe account</span>
                  </span>
                </li>
              </ol>
              <footer className={r.foot} aria-hidden="true">
                <span className={r.rule} />
                <span>test mode · no real money moves on this site</span>
              </footer>
            </div>
            <div className={r.tear} aria-hidden="true" />
          </div>
        </div>
      </section>

      <section className="wrap">
        <div className={`${p.sheet} ${p.prose} ${s.notes}`}>
          <h2 id="honest">What the number rests on</h2>
          <ul>
            <li>
              <b>Who pays.</b> Small and mid-size charge-point operators and CSMS vendors who must offer ad-hoc payment at public points (AFIR, Regulation (EU) 2023/1804 Art. 5: a card or contactless reader at 50 kW and above, an internet-based option such as a QR code below), and who
              today learn their offline behaviour from a driver billed twice.
            </li>
            <li>
              <b>Why now.</b> 1.1 million public charge points in the EU by the end of 2025, five times 2020 (Transport &amp; Environment, July 2026). Open-source CSMSs ship Stripe payment modules without a fault suite.
            </li>
            <li>
              <b>Unit costs to watch.</b> Our own cost of running suites in sandboxes. Not yet measured.
            </li>
            <li>
              <b>Test mode.</b> Everything on this site runs in Stripe test mode: the hold, the capture, the refused duplicate. Nothing here charges a real card. See the <Link href="/terms">terms</Link>.
            </li>
          </ul>
          <p className={p.actions}>
            <Link href="/" className="btn btn-primary">
              Try the demo
            </Link>
            <Link href="/docs" className="btn btn-ghost">
              Read the docs
            </Link>
          </p>
        </div>
      </section>
    </>
  );
}
