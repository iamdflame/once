# Host server (`app/lib`, `app/app/api`)

The host runs the Stripe side and the agent; the world (`world/`) runs inside one CreateOS sandbox with no internet and no keys. The world decides, the host executes each decision on Stripe exactly once, and Stripe is the witness. The host never runs code the model wrote: candidates go to the world as text and run inside the sandbox.

```
browser ──> /api/* (Next.js, Node runtime) ──https──> CreateOS ingress :8080 ──> world (CSMS, fleet, settle.js, suite)
                 │
                 └──> Stripe (test mode): Checkout hold, capture with idempotency key, cancel
```

## Files

| File | What it does |
|---|---|
| `env.ts` | Every environment variable, with the names Stripe Projects writes, plus `HttpError` |
| `createos.ts` | The world sandbox: find by name, resume, create (quota-guarded), lock egress, upload `world.cjs`, start it, ingress URL; single-flight `ensureWorld`, `pauseWorld` |
| `world.ts` | Typed client for the world's HTTP API; on a network failure in CreateOS mode it re-ensures (resumes a paused box) and retries once |
| `stripe.ts` | Stripe client (test keys only), the €50 manual-capture Checkout Session, `capture()` with the idempotency key, verbatim errors |
| `checkout.ts` | Checkout confirmation: binds an authorised PaymentIntent to the charger's next episode (`POST /hold`) |
| `settle.ts` | The settlement tick and the in-memory capture ledger |
| `agent.ts` | The agent loop (prompt, code extraction, validate, dry-run suite, deploy) and its NDJSON event types |
| `llm.ts` | Streaming model calls: Anthropic if `ANTHROPIC_API_KEY`, else OpenRouter free models with fallback and backoff |
| `settle-interface.ts` | The settle.js contract, copied from `world/README.md` (`node scripts/sync-settle-interface.mjs` refreshes it) |
| `diff.ts` | Line diff (LCS) for the settle.js diff the bench shows |
| `proof.ts` | `/api/proof`: every capture attempt, each hold as Stripe reports it now, holds per driver and every capture attributed to the driver whose energy it billed, suite history |
| `errors.ts` | `route()` wrapper (errors become `{error, detail?}` with the right status), `describe()` |

## Environment

`app/.env.local` (never committed; names in `app/.env.example`):

| Variable | Use |
|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | Stripe test sandbox (restricted: Checkout Sessions, PaymentIntents). Live keys are refused |
| `CREATEOS_PROJECT_API_KEY` | CreateOS sandbox key from Stripe Projects, passed to the SDK explicitly (the SDK alone reads only `CREATEOS_SANDBOX_API_KEY`, also accepted) |
| `CREATEOS_PROJECT_API_URL` | Written by Stripe Projects; it is the CreateOS **platform** API, so the host does not use it as the Sandbox API base. `CREATEOS_SANDBOX_BASE_URL` overrides the SDK default `https://api.sb.createos.sh` |
| `OPENROUTER_API_API_KEY` | OpenRouter key from Stripe Projects (`OPENROUTER_API_KEY` also accepted). `OPENROUTER_MODELS` overrides the free-model chain (comma-separated) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional; when set the agent uses Claude (default `claude-sonnet-4-5`) instead of OpenRouter |
| `WORLD_URL` | Optional: talk to a local world (`http://127.0.0.1:8080`) and skip CreateOS entirely |
| `WORLD_BUNDLE` | Optional: path of the bundle to upload (default `../world/dist/world.cjs`) |
| `AGENT_BUDGET_S`, `AGENT_ATTEMPTS` | Optional: agent run budget (default 285 s, under Vercel's 300 s limit) and attempts (default 3) |

## CreateOS orchestration

- One sandbox, `once-world` (`s-1vcpu-1gb`, rootfs `devbox:1`, Ubuntu 24.04 with Node 24), reused by name.
- **Egress:** allowlist `["sinkhole.invalid"]`, set at create time and re-asserted on every ensure. An empty list would mean open. Verified from inside: `curl https://api.stripe.com` and `http://1.1.1.1` both fail; no Stripe variable exists in the box.
- **Ingress:** `ingress_enabled: true`; the world is reached at `previewUrl(8080)`, `https://<id>-8080.app.sb.createos.sh` (valid TLS; the host falls back to plain http only if the certificate fails). It is reachable from outside, which is how the host talks to it.
- **Start:** uploads `world.cjs` only when its sha256 differs from `/tmp/once/world.sha`, then starts `node /tmp/once/world.cjs` as a CreateOS managed process (env inline, because `processes.create` only accepts env keys declared at creation; managed processes survive pause/resume). Redeploy of the 2 MB bundle: about 18 s from paused, 3.5 s warm.
- **Quota (free plan: 1 concurrent, 10 creates per rolling 24 h):** creates are counted from the API's own sandbox list (`created_at` in the last 24 h, destroyed boxes included) and refused locally at 10; one create per host process per 10 minutes at most; every create is logged with the running count. A box is never destroyed by the host.
- **Idle:** `auto_pause_after_seconds: 600`; `POST /api/world/pause` pauses now. Any world call to a paused box fails over to `ensureWorld`, which resumes it (about 4 s) with the world process and its state intact.
- **Single-flight:** concurrent ensures share one promise, bounded at 150 s so a stuck call cannot wedge later callers.

## Routes

All routes are Node runtime, `force-dynamic`, JSON in and out unless noted. Errors are `{error, detail?}` with the HTTP status (world errors keep the world's status and message).

### World

| Route | Does |
|---|---|
| `POST /api/world/ensure {redeploy?}` | Create or reuse the sandbox, resume it, start the world. Returns `WorldInfo`: `{mode: "local"\|"createos", url, healthy, sandbox: {id, name, status, egress, created_at, auto_pause_after_seconds}, actions: [...], creates_used_24h, creates_limit_24h, bundle_sha, ms}`. `redeploy: true` replaces the world when the local bundle's sha differs (this resets the world's state) |
| `POST /api/world/pause` | Pause the sandbox now: `{id, status}` |
| `GET /api/world/state` | Proxy of world `GET /state` (chargers, episodes, holds with Stripe results, intents, events) |
| `POST /api/world/cmd {op, charger, quirk?, on?, ...}` | Proxy of world `POST /cmd`; `op` is checked against `plug, unplug, cut, restore, reboot, quirk` |
| `GET /api/world/events?since=<seq>` | Proxy of world `GET /events` (`{events, last_seq, head_seq, truncated}`) |
| `POST /api/world/suite {count?, seed?}` | Runs the 30-seed suite on the deployed settle.js inside the world. JSON `{version, ran_at, totals, scenarios}`; with `?stream=1` it streams the same NDJSON events as the agent (`status`, `scenario` x 30, `suite`) |
| `GET /api/world/settle` | Proxy of world `GET /settle` (deployed source, version, name, sha256). Uploads only go through the agent |
| `GET /api/world/suite/last` | The last suite the world ran on its deployed settle.js (world `GET /suite/last`), normalised like `/api/world/suite`: `{report: {version, ran_at, summary, totals, scenarios} \| null}`. It lives in the world, so the Bench can show results on load after a host cold start |
| `POST /api/world/probe` | The boundary, shown live (below) |

### Stripe

| Route | Does |
|---|---|
| `POST /api/checkout {charger}` | `charger`: `"CP07"` or `7`. Creates a Checkout Session: mode `payment`, EUR, one line item "Charging hold" €50.00, `payment_intent_data.capture_method = manual`, dynamic payment methods (no `payment_method_types`), `success_url = <origin>/?session_id={CHECKOUT_SESSION_ID}&charger=CP07`, `cancel_url = <origin>/?canceled=1&charger=CP07`. Returns `{id, url, charger, amount, currency}`; redirect the browser to `url` |
| `GET /api/checkout/confirm?session_id=cs_...` | Retrieves the session and its PaymentIntent. When the PaymentIntent is `requires_capture`, binds it with world `POST /hold {charger, payment_intent, amount_cents: amount_capturable}` (once per PaymentIntent; the world is idempotent too). Returns `{session: {id, status, payment_status, amount_total, currency}, charger, payment_intent: {id, status, amount, amount_capturable, capture_method, dashboard_url}, hold, hold_error?}` |
| `POST /api/settle/tick` | One settlement tick (below). Returns `{at, pending, processed: [CaptureRecord], coalesced?, error?, ms}` |
| `POST /api/hold/next {charger, driver?}` | **The next driver's test hold** (the wrong-driver demo). Creates and confirms a €50.00 manual-capture PaymentIntent server-side in Stripe test mode (`payment_method: pm_card_visa`, `automatic_payment_methods[enabled]=true`, `allow_redirects=never`, metadata `{app: "once", charger, driver}`) and binds it with world `POST /hold {driver}`. `driver` defaults to the letter after the holds already on that charger, at least `B`. Returns `{payment_intent, driver, charger, label: "Driver B's test hold: ...", test_mode: true, stripe: {id, status, amount, amount_capturable, dashboard_url}, hold}`. If the world refuses to bind it, the PaymentIntent is cancelled at once and the route answers 502 |
| `GET /api/proof[?verify=0]` | `{captures, drivers, sandbox, settle, suite, attempts, holds, suites, world, world_error?}`. Every capture carries `driver` (whose hold), `energy_driver` / `energy_episode_id` (whose energy, from the world), `wrong_driver` and `story` ("Driver B was charged €4.17 for Driver A's energy; Stripe: succeeded"). `drivers` is one line per hold the world bound: `{driver, seq, charger, payment_intent, amount_authorized, amount_received, status (Stripe's), stranded, charged_for_driver, wrong_driver, story}`. `holds` now also covers holds with no attempt at all (a stranded one) and carries `driver`, `stranded`, `captured_for`. `holds` is each PaymentIntent as Stripe reports it now (`status, amount_authorized, amount_received, amount_capturable, latest_charge, dashboard_url, capture_attempts, captures_succeeded, refusals[]`); `captures` and `sandbox` match the UI's `Capture` and `SandboxInfo` types; `verify=0` skips the Stripe lookups |

`CaptureRecord`: `{at, id (world intent id), intent_id (settle.js's), episode_id, charger, payment_intent, amount_cents, driver, energy_driver, energy_episode_id, wrong_driver, action: capture|release|rejected, ok, status, error (Stripe's message verbatim), code, replayed, idempotency_key, request_id, stripe_object: {id, status, amount, amount_received, amount_capturable, currency, latest_charge, dashboard_url}, reported, report_error?}`.

### The settlement tick

The board calls `POST /api/settle/tick` every second while open.

1. `POST /intents/claim {limit: 50, lease_ms: 20000}` on the world: pending intents are leased atomically, so overlapping ticks (from this or any other host instance) never get the same intent.
2. Each intent runs on Stripe: `kind: "capture"` → `paymentIntents.capture(pi, {amount_to_capture: amount_cents})`; `kind: "release"` or `amount_cents: 0` → `paymentIntents.cancel(pi)`. Intents on the same PaymentIntent run in the order the world emitted them; different holds run in parallel.
3. **Idempotency key:** `once-cap-<episode_id>-<sha256(payment_intent, world intent id)>`. A retry of the same decision (a lease that ran out, a crash between capture and report) replays Stripe's stored answer; a second decision for the same hold is a different request, so Stripe itself judges it and refuses it. Keying on `episode_id` alone would hide that refusal: v1-naive reuses its `episode_id` (`tx-<id>`) for both copies of a duplicated StopTransaction, and Stripe would replay the first capture.
4. Stripe's answer goes back verbatim: `POST /intents/:id/result {ok, status, error: {message, code} | null, stripe_object}`. If Stripe is unreachable nothing is reported, the lease expires and a later tick retries with the same key.
5. In-process single-flight: concurrent calls in one host process share the running tick (`coalesced: true`).

The host validates each intent (a `pi_` id, an integer amount ≥ 0); the world already refuses to offer intents for PaymentIntents that were not bound with `/hold`.

### The agent

`POST /api/agent/fix` streams `application/x-ndjson`: one JSON object per line, each with `at` (epoch ms). Only one run at a time (409 otherwise). The run is not tied to the client connection.

1. Reads the deployed settle.js and runs the 30-seed suite on it (the baseline).
2. Per attempt (up to 3): the model gets the spec, the settle.js interface from `world/README.md`, the current code, the failing scenarios with the world's notes, and the full event trace of one failing seed (`POST /suite/trace`). It answers with a short plan and the complete file.
3. The host extracts the code (text only) and the world checks it: `POST /settle/validate` (does it load in the vm sandbox), then `POST /suite {source}`, a **dry run** that does not deploy it.
4. All 30 green: `PUT /settle` deploys it (the world replays its history into the new program), and the suite runs once more on the deployed version. Not green: the next attempt builds on the best version so far (a regression is rolled back in the prompt). A red candidate is never deployed, so it can never send a wrong capture to a real Stripe hold.

Models: Anthropic Claude when `ANTHROPIC_API_KEY` is set; otherwise OpenRouter free models in order `qwen/qwen3-coder:free` (withdrawn from the free tier on 2026-10-17, answers 404 at once), `poolside/laguna-s-2.1:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `google/gemma-4-31b-it:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `cohere/north-mini-code:free`. A model that errors falls through to the next; the model that answered last gets two backoffs when rate-limited; each call has 110 s; the whole run has `AGENT_BUDGET_S` (285 s).

Events (`AgentEvent` in `agent.ts`; names match the UI's types):

| `type` | Fields |
|---|---|
| `status` | `text, phase?` (`start` with `provider, models`; `baseline`; `suite`; `budget`) |
| `attempt` | `n, of` |
| `trying` | `name, provider`: a model is being called (it may still fail) |
| `fallback` | `model, error`: that model failed; the next one is tried |
| `reasoning`, `delta` | `text`: streamed model reasoning and answer tokens (`delta` with empty text is a keepalive) |
| `model` | `name, provider, requested`: emitted only after a model **answered**; `name` is the id the provider reports it ran |
| `thinking` | `text` (the model's plan), `model`, `ms` |
| `diff` | `attempt, old, new, version ("candidate N"), unified, added, removed` |
| `scenario` | `scenario: {seed, name, faults, double, stranded, unbilled, overbilled, underbilled, invalid, ok, notes, ...}, index, count` |
| `suite` | `phase: baseline\|attempt\|deployed, attempt?, report: {version, ran_at, summary, totals: {double, stranded, unbilled, overbilled, underbilled, invalid, ok, failed, count}, scenarios}` |
| `uploaded` | `version`: the candidate passed and is now deployed |
| `error` | `text` |
| `done` | `ok, version (live settle.js version), attempts, model?, reason` |

When a run ends (any outcome), the host posts its record to the world (`POST /agent/last`), which keeps it inside the sandbox: `{kind: "agent_run", ok, reason, provider, models, model, started_at, finished_at, ms, baseline: {version, summary, totals, ms}, attempts: [{n, model, provider, model_ms, plan, diff: {added, removed}, load_error?, suite: {summary, totals}, suite_ms, deployed?}], deployed: {version, suite} | null, version, final_diff: {attempt, added, removed, unified, source} | null, errors, timings: {baseline_ms, model_ms, suite_ms, total_ms}}`. `GET /api/agent/last` returns `{run}` (`null` before the first run). The CreateOS launch sets `STATE_DIR=/tmp/once`, so the record also survives a world restart.

### The boundary probe

`POST /api/world/probe` runs world `POST /probe` inside the sandbox and adds the sandbox's settings as CreateOS reports them. Response: `{ok, mode: local|createos, note, at, passed, applicable, checks: [{group, id, label, pass, applicable, verdict: pass|fail|"local: not applicable", layer, detail, expected, ms}], sandbox, world, env: {world_process (names), flagged, sandbox_declared (names)}, ms}`.

- (a) settle.js reaching for `fetch`, `require('fs')` (literal and hidden), `process.env`, `import()` (hidden from the loader pattern), `eval`, and the `({}).constructor.constructor('return process')()` escape: each must throw inside the vm.
- (b) `for (;;) {}` in `onEvent`: stopped at the 1 s budget.
- (c) the world process opens TCP to `api.stripe.com:443` and resolves `example.com`: both must fail in the sandbox. When `WORLD_URL` is a local address they succeed and are marked "local: not applicable".
- (d) no credential-like variable name or value in the world process (names only, never values); CreateOS's own report of the sandbox: egress exactly `["sinkhole.invalid"]`, env names stored on the box.

`ok` is true when every applicable check passes.

## The wrong-driver capture (`scripts/wrong-driver.mjs`)

Under the naive v1 settle.js, a StopTransaction that arrives after the next driver paid is billed to the charger's latest hold. The script plays it against a local world and real Stripe test mode, twice:

```bash
PORT=8080 node world/dist/world.cjs
cd app && WORLD_URL=http://127.0.0.1:8080 npm run dev
cd app && node scripts/wrong-driver.mjs --host http://localhost:3000 --world http://127.0.0.1:8080
```

A holds €50 and charges on CP07, cut, A unplugs offline, `POST /api/hold/next` (driver B), restore, B charges and leaves, tick until settled. Under v1: one capture lands on B's PaymentIntent for A's energy and Stripe says succeeded, B's own capture is refused, A's hold is stranded. After `PUT /settle` with the reference episode ledger (tests only) and a reset: A is captured on A's hold for A's energy, B on B's for B's. The script releases v1's stranded test hold and resets the world to v1 at the end.

## Smoke test

```bash
# terminal 1: the world (local)
node world/dist/world.cjs                       # or: PORT=8081 node world/dist/world.cjs
# terminal 2: the host in local mode
cd app && WORLD_URL=http://127.0.0.1:8080 npm run dev
# terminal 3
cd app && node scripts/smoke.mjs --host http://localhost:3000 --world http://127.0.0.1:8080 [--agent]
```

It resets the world it points at (`POST /reset {settle: "v1"}`), creates a €50 hold PaymentIntent directly (`pm_card_visa`, `automatic_payment_methods[enabled]=true`, `allow_redirects=never`, confirmed), binds it with `/hold`, turns `dup_stop` on, plays plug → cut → unplug → restore on CP07, ticks `/api/settle/tick` (two concurrent calls per tick), and checks on Stripe: exactly one successful capture and the duplicate refused by Stripe with its own message. `--agent` then runs `/api/agent/fix` and prints the stream. It also runs against the sandbox: start the host without `WORLD_URL` and pass `--world <previewUrl>`.
