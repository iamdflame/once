# Roadmap

Ordered by dependency, not by date: no dates are promised. "Built" means in this repository and checked; "in progress" and "next" are intentions.

## Now: the event build (Phase 0)

| Item | State |
|---|---|
| Stripe Projects stack from an empty directory (CreateOS, OpenRouter, Vercel) | built (`.projects/state.json`) |
| Docs: README, architecture, threat model, business, roadmap | built |
| `world/`: CSMS, 12 chargers with quirks, link proxy, v1 naive `settle.js`, 30-scenario runner, HTTP API | in progress |
| `app/`: charger grid, event stream, receipt strip, agent panel; Stripe hold and idempotent capture; CreateOS orchestration; agent loop | in progress |
| Deployed demo on Vercel; golden path run end to end from a clean browser | next |
| Results table in the README filled from the real suite | done (measured 2026-10-17) |

## Phase 1: make the proof credible

- Third-party chargers in the loop: run an open simulator (for example Solidstudio Virtual Charge Point or Monta's emulator) as one charger, to answer "those are your own scripts".
- A published, sourced **firmware-quirk catalogue** (each scenario cites the vendor KB or OCA list message it is derived from).
- Real firmware in the loop: MicroOcpp or EVerest inside the sandbox for a subset of chargers.
- Multi-sandbox fleet on CreateOS overlay networks with `detachNetwork`/`attachNetwork`, so partitions are real infrastructure actions and storms parallelise across sandboxes (needs a plan with more than 1 concurrent sandbox; the dossier assumed 5).
- A signed control-plane event for each cut shown in the timeline.

## Phase 2: cover the money

- Incremental authorization for sessions that exceed the hold (`increment_authorization`), and extended authorization for long holds (7-day card hold, extendable to 30). These are IC+ features on Stripe; document the access path.
- Hold-expiry and clock-skew scenarios.
- Partial capture and refund-based late corrections.
- OCPP 2.0.1: `TransactionEvent` with `seqNo` and the `offline` flag as additional dedup signals.
- Static-QR-per-charger and per-session QR flows, both under AFIR.

## Phase 3: product for operators

- Point the suite at a customer's own CSMS (CitrineOS and SteVe first) and generate the payment module for it, with the diff and the green suite as the deliverable.
- Per-customer run history and a ledger store (Postgres via Stripe Projects, for example Neon) for evidence that outlives a sandbox.
- Pricing pilots against the estimates in BUSINESS.md (EUR 2-5 per charger per month; EUR 0.5-1k per month per CSMS vendor); the first goal is to learn whether those numbers are wrong.
- Per-visitor rate limits, and a key-leak check before any public release.

## Phase 4: the conformance venue

- A shared fault suite versioned like a test standard ("pays exactly once while offline, suite v1, 30/30").
- Charger makers and CSMS vendors submit and certify; a registry vendors can link from AFIR documentation.
- Scenario contributions from customers feed the library; review process for hostile scenarios.

## Phase 5: beyond chargers

- The exactly-once kernel for other offline money devices: PAYGo solar tokens, vending, transit validators. One-click vending-machine scenario as the first demonstration of device-agnosticism.
- Stripe Terminal card-present for sites of 50 kW and above; Connect payouts to site hosts.

## Not on the roadmap

- Operating chargers or processing payments as a payment institution; Once is test and correctness tooling plus generated code that runs on the customer's Stripe account.
- Any claim of certification by the OCA, Stripe or a regulator.
