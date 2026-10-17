import type { Metadata } from "next";
import Link from "next/link";
import { SETTLE_INTERFACE_MD } from "@/lib/settle-interface";
import { Md } from "@/components/docs/Md";
import s from "@/components/shell/prose.module.css";

export const metadata: Metadata = {
  title: "Docs — Once",
  description: "Quick start from an empty directory, the settle.js interface, the API routes, the settlement tick, the agent loop and the threat model.",
};

const INDEX = [
  ["overview", "What it does"],
  ["quick-start", "Quick start"],
  ["running", "Running it"],
  ["the-settle-js-interface", "The settle.js interface"],
  ["routes", "API routes"],
  ["tick", "The settlement tick"],
  ["agent", "The agent loop"],
  ["threat-model", "Threat model"],
  ["verify", "Verify it yourself"],
  ["layout", "Repository layout"],
] as const;

export default function DocsPage() {
  return (
    <>
      <section className={`wrap ${s.head}`}>
        <h1 className={s.h1}>Docs</h1>
        <p className={s.lede}>
          Built from the repository&apos;s README, ARCHITECTURE and THREAT_MODEL. The settle.js interface below is rendered from the same text the agent is given, so the two cannot drift.
        </p>
      </section>

      <section className={`wrap ${s.docGrid}`}>
        <nav className={s.index} aria-label="On this page">
          <p className={s.indexTitle}>On this page</p>
          <ol>
            {INDEX.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ol>
        </nav>

        <article className={`${s.sheet} ${s.prose}`}>
          <h2 id="overview">What it does, in plain words</h2>
          <p>
            A charge-point operator that takes card payments at an unattended charger has to hold money when the driver plugs in, meter the energy, and capture the right amount when the session ends. The hard part is that a charger is a device on a flaky link: OCPP 1.6 chargers queue their
            transaction messages while offline and resend them on reconnect, some firmware restarts an open transaction after a reboot, and a Stop can arrive twice. Stripe allows exactly one capture per authorization, so payment code that captures on &ldquo;first Stop it sees&rdquo; either
            double-bills, strands the hold, or errors.
          </p>
          <ol>
            <li>
              The <b>agent</b> (a language model) writes the settlement program, <code>settle.js</code>: it reads the OCPP event stream and emits capture intents <code>{"{episode_id, payment_intent, amount_cents}"}</code>.
            </li>
            <li>
              The program runs inside a <b>CreateOS sandbox</b> (the &ldquo;world&rdquo;) whose egress allowlist contains a single sinkhole, so it has no internet, and it holds no keys. Inside the same sandbox: a CSMS, 12 simulated chargers with documented firmware quirks, and a per-charger
              link proxy so any charger can be cut, restored or rebooted.
            </li>
            <li>
              A <b>scenario suite</b> (30 seeded fault scenarios) runs in the sandbox and reports <code>stranded</code>, <code>double</code> and <code>unbilled</code> per scenario. If a scenario is red the agent rewrites <code>settle.js</code> and the suite runs again, up to 3 attempts.
            </li>
            <li>
              Only <b>intents</b> leave the sandbox. The <b>host</b> executes each capture on Stripe with an idempotency key derived from the world&apos;s intent id (with the hold and the episode) and reports Stripe&apos;s answer back. Stripe witnesses &ldquo;once&rdquo;.
            </li>
          </ol>
          <p className={s.note}>Everything money-related runs in Stripe test mode. The product code started from an empty directory at the hackathon kickoff; the research and planning happened before.</p>

          <h2 id="quick-start">Quick start from an empty directory</h2>
          <p>The whole stack was created with the Stripe Projects CLI (<code>stripe projects</code>, v0.50.0 at build time). Nothing else was provisioned by hand.</p>
          <pre>
            <code>{`mkdir once && cd once
stripe projects init once
stripe projects add createos/free
stripe projects add createos/project
stripe projects add openrouter/free
stripe projects add openrouter/api
stripe projects add vercel/hobby
stripe projects add vercel/project
stripe projects env --pull          # writes the provider credentials into .env`}</code>
          </pre>
          <p>
            The resulting resource list is committed in <code>.projects/state.json</code>; <code>.env</code> and <code>.projects/vault</code> are git-ignored. CreateOS provides the sandbox key (<code>CREATEOS_PROJECT_API_KEY</code>, aliased to <code>CREATEOS_SANDBOX_API_KEY</code> in
            code), OpenRouter the model, Vercel the host deployment. Add a Stripe <b>test</b> secret key (<code>STRIPE_SECRET_KEY=sk_test_…</code>, restricted to Checkout Sessions and PaymentIntents); the host refuses live keys.
          </p>
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Variable</th>
                  <th scope="col">Use</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>STRIPE_SECRET_KEY</code>, <code>STRIPE_PUBLISHABLE_KEY</code>
                  </td>
                  <td>Stripe test sandbox. Live keys are refused.</td>
                </tr>
                <tr>
                  <td>
                    <code>CREATEOS_PROJECT_API_KEY</code>
                  </td>
                  <td>CreateOS sandbox key from Stripe Projects, passed to the SDK explicitly.</td>
                </tr>
                <tr>
                  <td>
                    <code>CREATEOS_PROJECT_API_URL</code>
                  </td>
                  <td>
                    Written by Stripe Projects; it is the CreateOS platform API, so the host does not use it as the Sandbox API base. <code>CREATEOS_SANDBOX_BASE_URL</code> overrides the SDK default.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>OPENROUTER_API_API_KEY</code>
                  </td>
                  <td>
                    OpenRouter key from Stripe Projects. <code>OPENROUTER_MODELS</code> overrides the free-model chain. <code>ANTHROPIC_API_KEY</code>, when set, makes the agent use Claude instead.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>WORLD_URL</code>
                  </td>
                  <td>
                    Optional: talk to a local world (<code>http://127.0.0.1:8080</code>) and skip CreateOS entirely.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>AGENT_BUDGET_S</code>, <code>AGENT_ATTEMPTS</code>
                  </td>
                  <td>Optional: agent run budget (default 285 s, under Vercel&apos;s 300 s) and attempts (default 3).</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2 id="running">Running it</h2>
          <pre>
            <code>{`git clone https://github.com/iamdflame/once && cd once

# the world: CSMS + 12 chargers + settle.js loader + scenario runner, one file
cd world && npm install && npm test                           # 25 tests
node scripts/suite.mjs settlers/v1-naive.js --notes            # 30 seeded storms, naive code
node scripts/suite.mjs settlers/reference-episode-ledger.js    # the same 30 with an episode ledger
PORT=8080 node dist/world.cjs                                 # HTTP API on :8080, no network needed

# the host, against the local world
cd ../app && npm install
WORLD_URL=http://127.0.0.1:8080 npm run dev

# without WORLD_URL the host creates or reuses the CreateOS sandbox "once-world",
# locks its egress to the sinkhole, uploads world/dist/world.cjs and starts it.`}</code>
          </pre>
          <p>
            The demo: select CP07, <b>Plug in and pay</b> with the test card <code>4242 4242 4242 4242</code>, <b>Cut cable</b>, <b>Unplug</b>, <b>Restore</b>. The wire log shows the StopTransaction arrive twice 1.2 s apart; the receipt shows one capture and the released remainder.
            Turn <em>Reboot restarts the transaction</em> on, reboot mid-session under the naive v1 and Stripe refuses the second capture in its own words; <b>Fix it</b> on the bench writes v2 and runs the thirty storms.
          </p>

          <Md text={SETTLE_INTERFACE_MD} />

          <h2 id="routes">API routes</h2>
          <p>
            All routes are Node runtime and dynamic, JSON in and out unless noted. Errors are <code>{"{error, detail?}"}</code> with the HTTP status; world errors keep the world&apos;s status and message.
          </p>
          <h3>World</h3>
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Route</th>
                  <th scope="col">Does</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>POST /api/world/ensure</code>
                  </td>
                  <td>
                    Create or reuse the sandbox, resume it, start the world. Returns <code>{"{mode, url, healthy, sandbox: {id, name, status, egress, created_at, auto_pause_after_seconds}, actions, creates_used_24h, creates_limit_24h, bundle_sha, ms}"}</code>.{" "}
                    <code>{"{redeploy: true}"}</code> replaces the world when the bundle&apos;s sha differs.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>POST /api/world/pause</code>
                  </td>
                  <td>Pause the sandbox now.</td>
                </tr>
                <tr>
                  <td>
                    <code>GET /api/world/state</code>
                  </td>
                  <td>Proxy of the world&apos;s state: chargers, episodes, holds with Stripe results, intents, events.</td>
                </tr>
                <tr>
                  <td>
                    <code>POST /api/world/cmd</code>
                  </td>
                  <td>
                    <code>{"{op, charger, quirk?, on?}"}</code>; <code>op</code> is one of plug, unplug, cut, restore, reboot, quirk.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>GET /api/world/events?since=</code>
                  </td>
                  <td>The event log since a sequence number.</td>
                </tr>
                <tr>
                  <td>
                    <code>POST /api/world/suite</code>
                  </td>
                  <td>
                    Runs the 30-seed suite on the deployed settle.js inside the world. With <code>?stream=1</code> it streams NDJSON events (status, scenario × 30, suite).
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>GET /api/world/settle</code>
                  </td>
                  <td>The deployed source, version, name and sha256. Uploads only go through the agent.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <h3>Stripe, proof and status</h3>
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Route</th>
                  <th scope="col">Does</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>POST /api/checkout</code>
                  </td>
                  <td>
                    <code>{"{charger}"}</code>. A Checkout Session: EUR, one line item &ldquo;Charging hold&rdquo; €50.00, <code>capture_method = manual</code>. Returns <code>{"{id, url, charger, amount, currency}"}</code>; redirect to <code>url</code>.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>GET /api/checkout/confirm?session_id=</code>
                  </td>
                  <td>
                    Retrieves the session and its PaymentIntent; when it is <code>requires_capture</code>, binds it to the charger&apos;s next episode with the world&apos;s <code>POST /hold</code>.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>POST /api/settle/tick</code>
                  </td>
                  <td>One settlement tick (below).</td>
                </tr>
                <tr>
                  <td>
                    <code>POST /api/agent/fix</code>
                  </td>
                  <td>The agent loop as an NDJSON stream. One run at a time.</td>
                </tr>
                <tr>
                  <td>
                    <code>GET /api/proof</code>
                  </td>
                  <td>Every capture attempt, each hold as Stripe reports it now, the suite history, the sandbox.</td>
                </tr>
                <tr>
                  <td>
                    <code>GET /api/receipt</code>
                  </td>
                  <td>The run receipt: sha256 of the deployed settle.js, the latest suite summary, every capture with its PaymentIntent id, idempotency key and status. Also a button on the proof page.</td>
                </tr>
                <tr>
                  <td>
                    <code>GET /api/status</code>
                  </td>
                  <td>
                    Asserted outcomes, what the <Link href="/status">status page</Link> shows.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2 id="tick">The settlement tick</h2>
          <p>The board calls <code>POST /api/settle/tick</code> every second while open.</p>
          <ol>
            <li>
              <code>POST /intents/claim</code> on the world leases pending intents atomically, so overlapping ticks from this or any other host instance never get the same intent.
            </li>
            <li>
              Each intent runs on Stripe: <code>capture</code> → <code>paymentIntents.capture(pi, {"{amount_to_capture}"})</code>; <code>release</code> or a zero amount → <code>paymentIntents.cancel(pi)</code>. Intents on the same PaymentIntent run in the order the world emitted them.
            </li>
            <li>
              <b>Idempotency key:</b> <code>once-cap-&lt;episode_id&gt;-&lt;sha256(payment_intent, world intent id)&gt;</code>. A retry of the same decision replays Stripe&apos;s stored answer; a second decision for the same hold is a different request, so Stripe itself judges it and refuses it.
              Keying on the episode alone would hide that refusal: the naive v1 reuses its episode id for both copies of a duplicated Stop.
            </li>
            <li>
              Stripe&apos;s answer goes back verbatim with <code>POST /intents/:id/result</code>. If Stripe is unreachable nothing is reported; the lease expires and a later tick retries with the same key.
            </li>
            <li>Concurrent calls in one host process share the running tick.</li>
          </ol>

          <h2 id="agent">The agent loop</h2>
          <ol>
            <li>Read the deployed settle.js and run the 30-seed suite on it: the baseline.</li>
            <li>Per attempt (up to 3): the model gets the spec, the settle.js interface above, the current code, the failing scenarios with the world&apos;s notes, and the full event trace of one failing seed. It answers with a short plan and the complete file.</li>
            <li>
              The host extracts the code as text and the world checks it: <code>POST /settle/validate</code> (does it load in the vm), then <code>POST /suite {"{source}"}</code>, a dry run that does not deploy it.
            </li>
            <li>
              All 30 green: <code>PUT /settle</code> deploys it, the world replays its history into the new program, and the suite runs once more on the deployed version. A red candidate is never deployed, so it can never send a wrong capture to a real hold.
            </li>
          </ol>
          <p>
            Models: Anthropic Claude when <code>ANTHROPIC_API_KEY</code> is set; otherwise OpenRouter free models in a fallback chain. The host never runs code the model wrote: candidates go to the world as text and run inside the sandbox. The model writes code and fixes; it never decides a
            capture at runtime.
          </p>

          <h2 id="threat-model">Threat model</h2>
          <p>
            <code>settle.js</code> is untrusted by construction. A model writes it from a prompt that includes scenario reports; it can be buggy, and a prompt injection or a hostile spec edit could make it adversarial. The design does not rely on the model behaving.
          </p>
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Control</th>
                  <th scope="col">What it does</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>No egress</td>
                  <td>The sandbox&apos;s allowlist is a single sinkhole entry, re-asserted on every ensure. Generated code cannot call out.</td>
                </tr>
                <tr>
                  <td>No keys in the world</td>
                  <td>Only the world bundle and the generated settle.js are uploaded. The sandbox holds nothing to leak.</td>
                </tr>
                <tr>
                  <td>vm isolation</td>
                  <td>Fresh Node vm per run; no fs, net, process, fetch, timers or require. Output is a list of intents, validated for shape.</td>
                </tr>
                <tr>
                  <td>Execution on the host</td>
                  <td>The PaymentIntent must be one the host&apos;s own Checkout created and bound; the amount at most the hold.</td>
                </tr>
                <tr>
                  <td>Idempotency keys</td>
                  <td>Retries replay; a second decision is a different request that Stripe judges.</td>
                </tr>
                <tr>
                  <td>Stripe refuses duplicates</td>
                  <td>One capture per PaymentIntent. Even a compromised settle.js and a buggy host cannot capture an authorization twice.</td>
                </tr>
                <tr>
                  <td>Test mode only</td>
                  <td>A Stripe test sandbox. No real card data, no real funds.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Not claimed: that real firmware behaves like the simulated fleet; PCI scope (Checkout handles card data); that the sandbox provider is bug-free; that a wrong-but-valid capture is impossible. The <Link href="/security">security page</Link> has the threat table and what is
            not claimed; the full analysis is in{" "}
            <a href="https://github.com/iamdflame/once/blob/main/docs/THREAT_MODEL.md" target="_blank" rel="noreferrer">
              docs/THREAT_MODEL.md
            </a>
            .
          </p>

          <h2 id="verify">Verify it yourself</h2>
          <p>With only a Stripe test key, the money mechanic everything else rests on:</p>
          <pre>
            <code>{`# 1. A EUR 50 hold: manual capture, confirmed with a test card
PI=$(curl -s https://api.stripe.com/v1/payment_intents -u "$STRIPE_TEST_SECRET_KEY:" \\
  -d amount=5000 -d currency=eur -d capture_method=manual \\
  -d payment_method=pm_card_visa -d confirm=true \\
  -d "payment_method_types[]=card" | jq -r .id)

# 2. Capture EUR 11.40 once. The remaining EUR 38.60 is released.
curl -s https://api.stripe.com/v1/payment_intents/$PI/capture -u "$STRIPE_TEST_SECRET_KEY:" \\
  -d amount_to_capture=1140 | jq '{status, amount_received}'

# 3. Try to capture again. Stripe refuses.
curl -s https://api.stripe.com/v1/payment_intents/$PI/capture -u "$STRIPE_TEST_SECRET_KEY:" \\
  -d amount_to_capture=1140 | jq .error.message`}</code>
          </pre>
          <p>
            On the deployed app: run the demo, then open the Stripe Dashboard (test mode) and see exactly one captured PaymentIntent for the session; or download the run receipt from the <Link href="/proof">proof page</Link> and check each <code>payment_intent</code> with{" "}
            <code>stripe payment_intents retrieve</code>.
          </p>

          <h2 id="layout">Repository layout</h2>
          <pre>
            <code>{`README.md          the front page
docs/              ARCHITECTURE, THREAT_MODEL, BUSINESS, ROADMAP
app/               Next.js host: UI, API routes, agent loop, Stripe executor
world/             OCPP fleet, link proxy, settle.js loader, scenario runner
.projects/         Stripe Projects state (resources provisioned for this stack)`}</code>
          </pre>
          <p className={s.actions}>
            <a href="https://github.com/iamdflame/once" className="btn btn-primary" target="_blank" rel="noreferrer">
              Open the repository
            </a>
            <Link href="/" className="btn btn-ghost">
              Back to the board
            </Link>
          </p>
        </article>
      </section>
    </>
  );
}
