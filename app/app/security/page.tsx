import type { Metadata } from "next";
import Link from "next/link";
import s from "@/components/shell/prose.module.css";

export const metadata: Metadata = {
  title: "Security — Once",
  description: "The threat model in one page: web egress locked to a sinkhole, no keys in the sandbox, settle.js in a vm, captures executed by the host with idempotency keys, Stripe refuses duplicates. And what is not claimed.",
};

export default function SecurityPage() {
  return (
    <>
      <section className={`wrap ${s.head}`}>
        <h1 className={s.h1}>The code that decides when money moves never touches money.</h1>
        <p className={s.lede}>
          A model writes <code>settle.js</code>. It is untrusted by construction, so the design does not rely on it behaving. Full analysis in{" "}
          <a href="https://github.com/iamdflame/once/blob/main/docs/THREAT_MODEL.md" target="_blank" rel="noreferrer">
            docs/THREAT_MODEL.md
          </a>
          .
        </p>
      </section>

      <section className="wrap">
        <div className={`${s.sheet} ${s.prose}`}>
          <h2 id="boundaries">Trust boundaries</h2>
          <pre>
            <code>{` untrusted                         host (trusted)                 witness
 settle.js  --intents only-->  validate + execute  --idempotency key-->  Stripe
 (vm, no fs/net/process)       (keys live here)                           (refuses duplicates)
 inside a no-egress, no-keys sandbox`}</code>
          </pre>

          <h2 id="controls">Controls, layered</h2>
          <dl className={s.rows}>
            <div>
              <dt>Egress locked</dt>
              <dd>
                The world sandbox&apos;s egress allowlist is a single sinkhole entry (<code>sinkhole.invalid</code>), set at create time and re-asserted on every ensure. An empty list would mean open. From inside, <code>curl https://api.stripe.com</code> and <code>http://1.1.1.1</code> both
                fail. The <Link href="/status">status page</Link> reads the allowlist back from CreateOS.
              </dd>
            </div>
            <div>
              <dt>No keys in the sandbox</dt>
              <dd>The Stripe key, the model key and the CreateOS key live on the host only. The upload step sends the world bundle and the generated settle.js, nothing else. The world process has nothing to leak.</dd>
            </div>
            <div>
              <dt>settle.js in a vm</dt>
              <dd>
                Loaded fresh per run in a Node <code>vm</code> context with no <code>fs</code>, <code>net</code>, <code>process</code>, <code>fetch</code>, timers or <code>require</code>. Its globals are the event stream and an emit function. Its only output is a list of intents{" "}
                <code>{"{episode_id, payment_intent, amount_cents}"}</code>, validated for shape. A call has a 1 s budget.
              </dd>
            </div>
            <div>
              <dt>Captures run on the host</dt>
              <dd>
                The world proposes; the host executes. An intent must name a <code>pi_</code> the host&apos;s own Checkout created and bound with <code>/hold</code>, with an integer amount of at most the hold. Intents are leased atomically (<code>POST /intents/claim</code>) so overlapping ticks
                never execute the same one twice.
              </dd>
            </div>
            <div>
              <dt>Idempotency keys</dt>
              <dd>
                Every Stripe call carries <code>once-cap-&lt;episode&gt;-&lt;sha256(payment_intent, intent id)&gt;</code>. A retry of the same decision replays Stripe&apos;s stored answer; a second decision for the same hold is a different request, so Stripe itself judges it.
              </dd>
            </div>
            <div>
              <dt>Stripe refuses duplicates</dt>
              <dd>
                A PaymentIntent has one capture. After a partial capture Stripe releases the remainder and refuses any further capture in its own words. This is the last line: even a fully compromised settle.js and a buggy host cannot capture one authorization twice. Verified on 2026-10-17 in test
                mode; the refusal is printed verbatim on the <Link href="/proof">proof page</Link>.
              </dd>
            </div>
            <div>
              <dt>Test mode only</dt>
              <dd>Payments use a Stripe test sandbox. The host refuses a live key. No real card data, no real funds.</dd>
            </div>
          </dl>

          <h2 id="threats">Threats and responses</h2>
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Threat</th>
                  <th scope="col">Response</th>
                  <th scope="col">Residual</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Generated code calls out or calls Stripe</td>
                  <td>Web egress refused, no keys, vm with no net</td>
                  <td>A vm escape lands in a keyless, egress-less microVM</td>
                </tr>
                <tr>
                  <td>Generated code reads files or env</td>
                  <td>No fs or process in the vm; the sandbox holds no secrets</td>
                  <td>same</td>
                </tr>
                <tr>
                  <td>Intent for more than the hold</td>
                  <td>Host bounds the amount; Stripe rejects above the authorised amount</td>
                  <td>none beyond Stripe&apos;s own rules</td>
                </tr>
                <tr>
                  <td>Many or duplicate intents</td>
                  <td>Idempotency key per decision; Stripe refuses a second capture</td>
                  <td>a wrong-but-single capture (a correctness risk the suite covers)</td>
                </tr>
                <tr>
                  <td>Forged intent for an unpaid episode</td>
                  <td>Only PaymentIntents the host created and bound are executable</td>
                  <td>none for money</td>
                </tr>
                <tr>
                  <td>Prompt injection via device data</td>
                  <td>The agent sees reports our own code generates from seeded scenarios; its output is one file</td>
                  <td>scenario contributions need review</td>
                </tr>
                <tr>
                  <td>The world lies about results</td>
                  <td>Every capture links its Stripe object; suite results are labelled as sandbox-reported</td>
                  <td>re-run locally; Stripe is the source of truth for money</td>
                </tr>
                <tr>
                  <td>Quota or model abuse by visitors</td>
                  <td>One sandbox reused; ten creates per 24 h refused locally; three agent attempts per run</td>
                  <td>demo-grade; per-visitor limits are planned</td>
                </tr>
                <tr>
                  <td>Someone calls the world&apos;s HTTP API directly</td>
                  <td>The host never publishes the sandbox preview URL; everything is test mode and every capture is capped by its €50 hold</td>
                  <td>demo-grade: the world API has no host key yet; a shared host-world key is planned</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2 id="not-claimed">What is not claimed</h2>
          <ul>
            <li>That real charger firmware behaves like the simulated fleet. The fleet reproduces documented deviations (reboot-restart, queued and duplicated Stops, Stop without Start, meter reset); it is not every firmware.</li>
            <li>PCI scope: Stripe Checkout handles card data; this project never sees a PAN.</li>
            <li>That the sandbox provider is bug-free. CreateOS Sandbox is an alpha with no SLA; the controls are layered so that no single layer is the only protection.</li>
            <li>That a wrong-but-valid capture is impossible. The money is bounded (the hold), single (idempotency plus Stripe) and checked (the suite plus the oracle), not infallible.</li>
            <li>Any certification by the OCA, Stripe or a regulator.</li>
          </ul>

          <h2 id="contact">Reporting a problem</h2>
          <p>
            <b>security@once.example</b> <span className={s.quiet}>(placeholder: the project has no security inbox yet)</span>. Until there is one, open an issue at{" "}
            <a href="https://github.com/iamdflame/once/issues" target="_blank" rel="noreferrer">
              github.com/iamdflame/once/issues
            </a>
            . Keys are provisioned by Stripe Projects and live only on the host; <code>.env</code> and <code>.projects/vault</code> are git-ignored.
          </p>
        </div>
      </section>
    </>
  );
}
