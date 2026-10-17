# once-world

The world that Once's agent writes payment code against: one Node process with an **OCPP 1.6J central system (CSMS)**, **12 simulated public AC chargers** with real firmware quirks, a **cuttable link proxy per charger**, a **sandboxed settlement program** (`settle.js`) that turns the charger traffic into capture intents, a **payment authority model** with Stripe's manual-capture semantics, and a **seeded fault-scenario runner** that proves a `settle.js` exactly-once (or shows where it double-captures, strands a hold or bills the wrong amount).

It runs locally and, bundled into a single file, inside a CreateOS sandbox with no internet: it opens connections only to `127.0.0.1`, holds no keys and never calls Stripe. It decides; the host executes the intents on Stripe with idempotency and reports Stripe's answers back.

```
node world/src/index.js          # dev, needs world/node_modules (npm install in world/)
npm --prefix world run bundle    # -> world/dist/world.cjs (single file, all deps inlined, ~2 MB)
node world/dist/world.cjs        # anywhere with Node 18+, no npm install, no network
npm --prefix world test          # node --test: 29 tests
node world/scripts/suite.mjs world/settlers/v1-naive.js --notes   # the 30-seed suite offline
```

Environment: `PORT` (8080), `HOST` (0.0.0.0), `SIM_SPEED` (300: world time runs 300x faster than the wall clock, so an hour of charging plays in 12 s), `TARIFF_CENTS_PER_KWH` (60), `STATE_DIR` (unset; when set, the last agent run is also written to `<STATE_DIR>/agent-last.json` and read back at start).

Contents: [Architecture](#architecture) · [Chargers and quirks](#chargers-and-firmware-quirks) · [Episodes and holds](#episodes-and-holds) · [HTTP API](#http-api) · [**settle.js interface**](#the-settlejs-interface) · [Payment authority model](#payment-authority-model) · [Scenario runner](#scenario-runner) · [For the host](#notes-for-the-host) · [Limits](#limits)

## Architecture

```
                         one Node process (the CreateOS sandbox, egress = sinkhole)
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ CP01..CP12 firmware ──ws──> link proxy CPxx (cut/restore) ──tcp──┐               │
 │  (ocpp-rpc clients,          127.0.0.1:<ephemeral>               │               │
 │   strict 1.6J schemas)                                           v               │
 │                                       :8080  /ocpp/CPxx  CSMS (ocpp-rpc server)  │
 │                                              │ every accepted call = an event    │
 │                                              v                                   │
 │                     settle.js in a node:vm sandbox ── capture intents ──┐        │
 │                     (events in, intents out; nothing else)              v        │
 │                                       :8080  HTTP API  <── host claims, executes │
 │  scenario runner: same CSMS + firmware + settle.js on a virtual network,         │
 │  discrete-event clock, payment authority model, 30 seeded fault scenarios        │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

| File | What it is |
|---|---|
| `src/csms.js` | The CSMS: answers BootNotification, Heartbeat, StatusNotification, Authorize, StartTransaction, MeterValues, StopTransaction (real 1.6J shapes), assigns transactionIds from 1001, dedupes resent Starts by content |
| `src/firmware.js` | One charger (one connector): status machine, metering physics, the persistent transaction queue, reconnect, reboot, the five quirks |
| `src/transport-live.js` | ocpp-rpc client per connection (`strictMode`, `reconnect: false`; the firmware owns reconnection) and the TCP link proxy |
| `src/transport-virtual.js` | The runner's network: seeded latency, cut/restore, lost acks; validates every call and answer against ocpp-rpc's OCPP 1.6J JSON schemas |
| `src/core.js` | WorldCore: event bus, settlement feed, holds, episodes (the metered truth), intent book. Shared by live and runner |
| `src/sandbox.js` | Loads `settle.js` from text into a fresh vm context |
| `src/authority.js` | Payment authority model (Stripe manual-capture semantics) |
| `src/scenarios.js`, `src/runner.js` | Seeded scenarios and the judge |
| `src/live.js`, `src/index.js` | HTTP API, CSMS endpoint, proxies, startup |
| `src/probe.js` | The boundary probe (`POST /probe`): vm escapes, the 1 s budget, egress and the environment |
| `settlers/v1-naive.js` | The program the world starts with: captures on every StopTransaction (wrong on purpose) |
| `settlers/reference-episode-ledger.js` | Tests only. Not bundled, not served, never shown to the agent |

The live world and the runner share the CSMS, the firmware, the ledger and the sandbox code; only the clock (real timers vs discrete events) and the transport (WebSocket through proxies vs virtual links) differ. So the suite tests the code that runs live.

## Chargers and firmware quirks

12 chargers, `CP01`..`CP12`, one connector each (`connectorId: 1`), 7-22 kW (default 11 kW per plug-in, set with `power_kw`). Every charger boots with BootNotification, reports StatusNotification, sends Heartbeat, and during a session: StatusNotification Preparing, Authorize, StartTransaction, Charging, MeterValues every sample interval (`Energy.Active.Import.Register` in Wh plus `Power.Active.Import` in W), StopTransaction with `transactionData` (Transaction.Begin and Transaction.End readings, plus any Interruption readings), Finishing, Available.

Ordering rule (as real chargers do it): after a (re)connection the charger first sends its *current* status, then drains its queue. So after an offline unplug the CSMS sees `Available` **before** the queued StopTransaction.

| Quirk | Default | Behaviour |
|---|---|---|
| `queue_offline` | on | StartTransaction, MeterValues and StopTransaction are kept in a persistent FIFO queue while the link is down (or when a send fails in flight) and resent in order on reconnect. Off: they are dropped while offline. |
| `dup_stop` | off | A StopTransaction that went through the offline queue is delivered twice on reconnect, 1.2 s apart (same payload, new OCPP message id). |
| `reboot_restart` | off | A reboot during a session ends the transaction (StopTransaction reason `Reboot` or `PowerLoss`, persisted even with `queue_offline` off) and starts a new transaction for the same plug-in after boot. Off: the transaction survives the reboot. |
| `stop_without_start` | off | The firmware loses the StartTransaction. MeterValues and StopTransaction carry a locally generated transactionId (7000001 and up) the CSMS never issued. |
| `meter_reset_on_reboot` | off | The energy register restarts at 0 after a reboot. With `reboot_restart` the new transaction starts at `meterStart: 0`; on a surviving transaction the firmware sends `Interruption.Begin` (reading before) and `Interruption.End` (reading after) MeterValues and repeats them in `transactionData`. |

Also: `skew` (charger clock offset in seconds; all charger timestamps shift, CSMS time does not), `reboot` (link drops, the charger is off for the reboot downtime, no energy flows, then BootNotification), `cut`/`restore` (the proxy destroys the charger's sockets and refuses new ones; the charger retries every reconnect interval).

The runner adds one network fault: `lose_ack` (the CSMS processed a call but the link drops before the answer arrives; the charger resends it after reconnecting, so a StopTransaction can arrive twice even without `dup_stop`).

Timing, live (real ms): MeterValues every 2 s (10 world minutes at 300x), heartbeat 30 s, reconnect every 1 s, reboot downtime 3 s, dup 1.2 s. Runner (world ms): MeterValues every 300 s, heartbeat 900 s, reconnect every 5 s, reboot downtime 45 s, dup 1.2 s, latency 8-60 ms per hop.

## Episodes and holds

A **plug-in episode** lasts from plug to unplug on one charger and may span several OCPP transactions (reboot restarts). The world tracks the truth itself: episode id `CP07-E3`, the transactions it contained, and the **metered energy** (`energy_wh`, the sum of the register increments while charging). The amount that should be captured is

```
expected_cents = min(hold.amount_cents, round(energy_wh * tariffCentsPerKwh / 1000))
```

`POST /hold {charger, payment_intent, amount_cents, driver?}` binds the **next** plug-in on that charger to a PaymentIntent the host created (a €50 manual-capture hold in the demo). Holds queue FIFO per charger: the first plug-in after a hold takes the oldest unbound hold. The settlement program is told about the hold (a `hold` event) but not about episodes: it has to infer them from OCPP, like a real CSMS.

**Drivers.** Each hold has a `seq` (1, 2, ... per charger since the last reset) and a `driver` label: the one the host passes, else `A`, `B`, ... by `seq`. An episode's `driver` is its hold's. The settlement program never sees the label (the `hold` feed event is unchanged).

**Attribution: whose energy a capture is for.** The world knows which OCPP transaction belongs to which plug-in episode (it meters the truth), and it knows which event settle.js was handling when it emitted an intent. So every intent carries `energy_episode_id` / `energy_driver`: the episode of the transaction in the StopTransaction, MeterValues or StartTransaction that triggered it (same charger only), or, for an intent emitted on a tick or a status message, the hold's own episode (`attribution` says which). `wrong_driver` is true when that episode is not the one the charged hold paid for. This is how the demo shows the wrong-driver capture: under v1 a StopTransaction that arrives after the next driver paid is billed to the next driver's hold (`driver: "B", energy_driver: "A", wrong_driver: true`), Stripe says `succeeded`, and A's hold is left `stranded`.

## HTTP API

Base `http://<host>:8080`, JSON in and out, CORS open (`*`), errors are `{ok: false, error: "<message>"}` with a 4xx/5xx status. Times (`at`, `now`, `*_at`) are world time in epoch ms (compressed live).

### `GET /health`
`{ok, name: "once-world", version, uptime_s, now, sim_speed, chargers: 12, online: <n>, settle_version, egress}`

### `GET /state?events=100`
The board in one call.
```jsonc
{
  "ok": true, "now": 1792267010417, "now_iso": "...", "sim_speed": 300, "tariff_cents_per_kwh": 60,
  "settle": { "version": 1, "name": "v1-naive.js", "sha256": "...", "loaded_at": 0, "errors": 0, "dead": null },
  "chargers": [{
    "id": "CP07", "power": true, "online": true, "link": "up" /* or "cut" */,
    "status": "Charging" /* Available|Preparing|Charging|Finishing|Unavailable (rebooting) */,
    "plugged": true, "car": { "id_tag": "QR07001", "power_kw": 11 },
    "transaction": { "transaction_id": 1001, "local_id": 7060001, "start_lost": false, "meter_start": 4123987, "started_at": 0, "energy_wh": 5321 },
    "meter_wh": 4129308, "queue_len": 0, "queue": [], "quirks": { "queue_offline": true, "dup_stop": true, "...": false },
    "clock_skew_s": 0, "stats": { "calls": 40, "queued": 9, "dropped": 0, "duplicates": 1, "reboots": 0, "transactions": 1 },
    "episode": { "id": "CP07-E1", "payment_intent": "pi_...", "energy_wh": 5321, "cost_cents": 319, "plugged_at": 0 },
    "next_hold": null /* or {payment_intent, amount_cents, driver} */
  }],
  "episodes": [{ "id": "CP07-E1", "charger": "CP07", "payment_intent": "pi_...", "amount_cents": 5000, "driver": "A", "plugged_at": 0, "unplugged_at": null,
                 "power_kw": 11, "energy_wh": 5321, "expected_cents": 319,
                 "transactions": [{ "transaction_id": 1001, "local_id": 7060001, "start_lost": false, "meter_start": 4123987, "meter_stop": null, "energy_wh": 5321, "reason": null }] }],
  "holds": [{ "payment_intent": "pi_...", "charger": "CP07", "seq": 1, "driver": "A", "amount_cents": 5000, "currency": "eur", "placed_at": 0, "episode_id": "CP07-E1",
              "status": "requires_capture" /* | succeeded | canceled */, "amount_captured": 0, "amount_released": 0,
              "episode_ended": false, "stranded": false,   // stranded: its episode is over, still requires_capture, nothing pending for it
              "captured_for": null,                        // after a capture: {episode_id, driver, wrong_driver}, whose energy it paid for
              "results": [{ "intent": "in_00001", "kind": "capture", "amount_cents": 1140, "ok": true, "status": "succeeded", "error": null,
                            "driver": "A", "energy_episode_id": "CP07-E1", "energy_driver": "A", "wrong_driver": false }] }],
  "intents": [ /* see GET /intents */ ],
  "last_seq": 412,
  "events": [ /* the last N events, see GET /events */ ]
}
```

### `POST /cmd`
`{op, charger, ...}`. `charger` is an id (`"CP07"`), an array of ids, or `"all"`.

| op | extra fields | effect |
|---|---|---|
| `plug` | `power_kw?` (1-22, default 11), `id_tag?` | starts a plug-in episode (binds the oldest pending hold) |
| `unplug` | | ends it; StopTransaction (queued if offline) |
| `cut` | | link proxy drops the charger's sockets and refuses new ones |
| `restore` | | link proxy accepts again; the charger reconnects within ~1 s |
| `reboot` | | charger goes dark for the reboot downtime |
| `quirk` | `quirk` (one of the five), `on` (default true) | flips a firmware quirk |
| `skew` | `seconds` | sets the charger clock offset |

Response: `{ok, op, results: [{charger, ok, error?}], chargers: [<snapshots of the targeted chargers>]}`. With a single charger a failure is an HTTP error (404 unknown charger, 409 already plugged / not plugged, 400 bad op or quirk).

### `POST /hold`
`{charger, payment_intent, amount_cents, currency?: "eur", driver?: "B"}` → `201 {ok, hold, existing: false}` (`hold.seq`, `hold.driver`; `driver` defaults to A, B, ... by seq). Idempotent: the same `payment_intent` for the same charger returns `200 {..., existing: true}`; for another charger `409`.

### Intents
An intent is a settlement decision the program made. World intent ids are URL-safe (`in_00001`).
```jsonc
{
  "id": "in_00001",               // use this in /intents/:id/result
  "intent_id": "stop-98",         // the settle.js's own id
  "episode_id": "tx-1001",        // the settle.js's episode key (idempotency anchor)
  "charger": "CP07", "payment_intent": "pi_...", "amount_cents": 1140,
  "kind": "capture",              // "release" when amount_cents is 0: cancel the PaymentIntent
  "driver": "B", "hold_seq": 2,   // whose hold is charged
  "energy_episode_id": "CP07-E1", "energy_driver": "A", "energy_wh": 7280, "energy_expected_cents": 437,  // whose energy it bills
  "attribution": "StopTransaction transactionId 1001",  // or "hold episode" (tick / status trigger)
  "wrong_driver": true,           // the energy is not from the episode this hold paid for
  "status": "pending",            // pending | in_flight (claimed) | succeeded | failed | rejected (world refused it) | suppressed (replay)
  "error": null, "settle_version": 1, "created_at": 0, "created_seq": 98,
  "result": null,                 // the host's report, once posted
  "extra_results": []
}
```
- `GET /intents?pending=1` → `{ok, intents}` with status `pending` or `in_flight`. Without `pending=1`: the last 200 intents of any status.
- `POST /intents/claim {limit?: 50, lease_ms?: 15000}` → `{ok, intents}`: atomically marks pending intents `in_flight` with a lease, so concurrent ticks never execute one twice. An unanswered claim becomes claimable again after the lease.
- `POST /intents/:id/result {ok, status, error, stripe_object}` → `{ok, intent, duplicate}`. `ok`: did Stripe accept the call; `status`: the PaymentIntent's status after the call; `error`: Stripe's error (object with `message`/`code`, or a string), verbatim; `stripe_object`: the PaymentIntent (its `amount_received` becomes the hold's captured amount). The first report wins; later ones are kept in `extra_results` (`duplicate: true`). 404 unknown id, 409 for rejected/suppressed intents. The result is fed to settle.js as an `intent_result` event.

The world rejects (never offers to the host) intents whose `payment_intent` was not bound with `/hold` or whose `amount_cents` is not a non-negative integer: a settlement program cannot make the host touch arbitrary PaymentIntents.

### Settlement program
- `GET /settle` → `{ok, version, name, sha256, loaded_at, source, errors, dead}`; `GET /settle?raw=1` → the source as `text/javascript` (header `x-settle-version`).
- `PUT /settle` (or `POST`), body = the settle.js source as text (any content type; optional `x-settle-name` header), or JSON `{source, name?}`. The world validates that it loads, calls `createSettler`, survives a probe tick: `400 {ok: false, error}` with an actionable message otherwise. On success: `{ok, version, name, sha256}`. The new program is loaded fresh and **replayed over the whole event history** so it knows ongoing sessions; intents it produces during replay for holds that are already settled or have an intent in flight are recorded as `suppressed` and not sent to the host; for holds still open they are new pending intents.
- `POST /settle/validate` (same body) → `{ok, error, sha256}` without deploying.

### Scenario suite
- `POST /suite {count?: 30, seed?: 1, seeds?: [..], source?}` → runs the scenario runner on the current settle.js (or on `source`, a dry run that does not touch the deployed program). Seeds are `seed .. seed+count-1` unless `seeds` is given. Takes ~2 s for 30. Response:
```jsonc
{
  "ok": false, "settle_version": 1, "seeds": [1, 2, "..."], "settle_sha256": "...", "tariff_cents_per_kwh": 60,
  "summary": "4/30 ok · double 43 · stranded 3 · unbilled 3 · overbilled 8 · underbilled 10",
  "totals": { "scenarios": 30, "passed": 4, "failed": 26, "episodes": 41, "double": 43, "stranded": 3, "unbilled": 3, "overbilled": 8, "underbilled": 10, "invalid": 0, "errors": 0, "expected_cents": 0, "captured_cents": 0 },
  "scenarios": [{
    "seed": 2, "name": "reboot-restart", "faults": ["reboot_restart"], "chargers": ["CP09"], "episodes": 1,
    "double": 1, "stranded": 0, "unbilled": 0, "overbilled": 0, "underbilled": 1, "invalid": 0, "ok": false,
    "expected_cents": 802, "captured_cents": 230, "error": null, "settler_errors": 0,
    "notes": ["CP09-E1 pi_sim_2_1 expected €8.02 for 13374 Wh over 2 OCPP transaction(s) [tx 1001 3832 Wh Reboot, tx 1002 9542 Wh EVDisconnected]: 2 settlement intents for one hold; underbilled: captured €2.30. Intents: capture €2.30 [tx-1001] ok; capture €5.73 [tx-1002] refused: This PaymentIntent could not be captured: the remainder of the authorized amount has been released."]
  }],
  "ms": 1900
}
```
- `GET /suite/last` → `{ok, report}` (the last run on the deployed program).
- `POST /suite/trace {seed, source?}` → `{ok, report}` with `report.trace = {scenario, feed (every event settle.js saw), intents, episodes, charger_log}` for one seed: the debugging view.

### Events
- `GET /events?since=<seq>&limit=500` → `{ok, events, last_seq, head_seq, truncated}`; poll with `since=last_seq`. The world keeps the last 20,000 events.
- Same URL with `Accept: text/event-stream` (or `?stream=1`): Server-Sent Events, `id: <seq>`, `event: <type>`, `data: <json>`, backlog first, keepalive every 15 s.

Every event has `{seq, at, type, ...}`:

| type | fields | settle.js sees it |
|---|---|---|
| `ocpp` | `charger, action, payload, response` (a call the CSMS accepted) | yes |
| `link` | `charger, state: "connected"\|"disconnected"` (as the CSMS sees the socket) | yes |
| `hold` | `charger, connectorId, payment_intent, amount_cents, currency` | yes |
| `intent_result` | `intent_id` (settle.js's), `world_intent_id, episode_id, charger, payment_intent, kind, amount_cents, ok, status, error` (the log also carries `driver, energy_episode_id, energy_driver, wrong_driver`; settle.js does not see those) | yes |
| `cmd` | `op, charger, ...` (plug carries `episode_id, payment_intent, power_kw, id_tag`; unplug `energy_wh, offline`) | no |
| `charger` | `charger, kind` (`online, offline, queued, dropped, duplicate, rejected, plug, unplug, reboot, boot, meter-reset, start-lost, quirk, skew`), `ocpp_action?, queue?, why?` (firmware-side view) | no |
| `intent` | `intent` (as in /intents) | no |
| `settle` | `version, name, sha256, replayed` | no |
| `settler_error`, `settler_log` | `version, error` / `lines` (console output of settle.js) | no |
| `suite` | `settle_version, summary, ok, totals` | no |
| `violation` | an OCPP schema violation (should never happen) | no |

### The last agent run
- `POST /agent/last {...}`: the host posts the record of a finished `/api/agent/fix` run (model, attempts with suite summaries, final diff, deployed version, timings, ok). The world adds `received_at` and keeps it in memory (survives `/reset` and host cold starts; with `STATE_DIR` also a world restart).
- `GET /agent/last` → `{ok, run}` (`run: null` until the first run).

### The boundary probe
`POST /probe` → `{ok, ran_at, node, platform, pid, checks: [{group, id, label, pass, layer, detail, ms}], env: {names, flagged}, ms, world_uptime_s}`. One run at a time; about 1-4 s. It never touches the deployed program or the board.

| group | check | pass when |
|---|---|---|
| a | settle.js calls `fetch`, `require('fs')` (literal: refused by the loader; hidden as `globalThis['req'+'uire']`: undefined in the vm), `process.env`, `import/**/('node:fs')` (hidden from the loader pattern), `eval`, and the escape `({}).constructor.constructor('return process')()` | each throws inside the vm (or the loader refuses the file) |
| b | settle.js runs `for (;;) {}` in `onEvent` | the call is stopped at the 1 s budget (0.9-3 s measured) |
| c | the world process (outside the vm) opens TCP to `api.stripe.com:443` and resolves `example.com` (3 s timeout each) | both fail. They succeed on a laptop; the host marks them "local: not applicable" |
| d | the world's environment: variable names only, never values | no name and no value looks like a Stripe, model or CreateOS credential |

The infinite-loop check blocks the world's event loop for about a second (chargers keep their queues; the CSMS answers late once).

### Other
- `POST /reset {settle?: "v1"}` → a clean board (new fleet, no holds, no history); keeps the current settle.js unless `settle: "v1"`. Version numbers keep increasing.
- `GET /` → route index. WebSocket `ws://<host>:8080/ocpp/CP01`..`CP12`, subprotocol `ocpp1.6`: the CSMS endpoint (the world's own chargers use it through their proxies).

## The settle.js interface

`settle.js` is the payment program the agent writes. It reads the CSMS-side event stream and decides when to capture how much from which hold. It never calls Stripe.

```js
export function createSettler({ tariffCentsPerKwh }) {   // tariffCentsPerKwh: 60 = €0.60/kWh
  const out = [];
  return {
    onEvent(evt) {
      // called once per event, in arrival order; push decisions into `out`
    },
    intents() {
      return out;   // every intent decided so far (cumulative); the world picks up new ones
    },
  };
}
```

**Rules**
1. Export `createSettler` (`export function`, `export const`, `export { createSettler }`, `export default`, or `module.exports.createSettler` all work). It is called once per run with `{tariffCentsPerKwh}` and must return `{onEvent, intents}`.
2. `onEvent(evt)` receives events in the order the CSMS saw them. Return values are ignored. Exceptions are caught and counted (`settler_errors`); the run continues.
3. `intents()` returns an array of **all** intents decided so far. After every event the world reads it and takes the entries whose `intent_id` it has not seen. An intent is final once emitted: changing or removing it later has no effect.
4. An intent: `{intent_id, episode_id, charger, payment_intent, amount_cents}`.
   - `intent_id`: unique string per decision (if missing, the array index is used).
   - `episode_id`: your key for the plug-in episode; the host derives Stripe's idempotency key from it, so the same episode must always get the same `episode_id`.
   - `payment_intent`: from a `hold` event. Unknown ids are rejected.
   - `amount_cents`: integer ≥ 0. `> 0` captures that amount (must be ≤ the hold); `0` releases the hold (cancels the PaymentIntent).
   - The correct amount for an episode is `min(hold.amount_cents, round(energyWh * tariffCentsPerKwh / 1000))`.
5. Exactly one intent per hold. Stripe allows one capture per PaymentIntent; after a partial capture the rest of the hold is released and any further capture is refused.
6. The sandbox: plain JavaScript only. No `import`/`require`, no `fs`, `net`, `process`, `fetch`, timers, `eval` or `new Function`. `console.log` is captured (`settler_log` events). `Date.now()` / `new Date()` return world time and `Math.random()` is seeded, so runs are reproducible. Each call has a 1 s budget; a program that exceeds it is stopped and the scenario fails. Keep state in closures.

**Events settle.js receives** (exact shapes):

```jsonc
// a hold was placed: it pays for the NEXT plug-in on that charger (holds queue FIFO per charger)
{ "seq": 6, "at": 1792216920000, "type": "hold", "charger": "CP08", "connectorId": 1, "payment_intent": "pi_sim_7_1", "amount_cents": 5000, "currency": "eur" }

// the CSMS socket for a charger went up or down
{ "seq": 2, "at": 1792216800048, "type": "link", "charger": "CP08", "state": "connected" }

// an OCPP 1.6J call the CSMS accepted, with the CSMS's answer
{ "seq": 11, "at": 1792217002186, "type": "ocpp", "charger": "CP08", "action": "StartTransaction",
  "payload": { "connectorId": 1, "idTag": "84F3E322", "meterStart": 3844041, "timestamp": "2026-10-17T06:03:22.141Z" },
  "response": { "transactionId": 1001, "idTagInfo": { "status": "Accepted" } } }

{ "seq": 13, "at": 1792217302149, "type": "ocpp", "charger": "CP08", "action": "MeterValues",
  "payload": { "connectorId": 1, "transactionId": 1001, "meterValue": [{ "timestamp": "2026-10-17T06:08:22.141Z", "sampledValue": [
      { "value": "3844991", "context": "Sample.Periodic", "format": "Raw", "measurand": "Energy.Active.Import.Register", "location": "Outlet", "unit": "Wh" },
      { "value": "11400", "context": "Sample.Periodic", "format": "Raw", "measurand": "Power.Active.Import", "location": "Outlet", "unit": "W" } ] }] },
  "response": {} }

{ "seq": 43, "at": 1792221013700, "type": "ocpp", "charger": "CP08", "action": "StopTransaction",
  "payload": { "transactionId": 1001, "idTag": "84F3E322", "meterStop": 3849284, "timestamp": "2026-10-17T06:30:58.000Z", "reason": "PowerLoss",
    "transactionData": [
      { "timestamp": "2026-10-17T06:03:22.141Z", "sampledValue": [{ "value": "3844041", "context": "Transaction.Begin", "format": "Raw", "measurand": "Energy.Active.Import.Register", "location": "Outlet", "unit": "Wh" }] },
      { "timestamp": "2026-10-17T06:30:58.000Z", "sampledValue": [{ "value": "3849284", "context": "Transaction.End", "format": "Raw", "measurand": "Energy.Active.Import.Register", "location": "Outlet", "unit": "Wh" }] } ] },
  "response": { "idTagInfo": { "status": "Accepted" } } }

{ "seq": 5, "at": 1792216800128, "type": "ocpp", "charger": "CP08", "action": "StatusNotification",
  "payload": { "connectorId": 1, "errorCode": "NoError", "status": "Available", "timestamp": "2026-10-17T06:00:00.117Z" }, "response": {} }
// also BootNotification, Heartbeat and Authorize

// the host's answer to one of your intents (Stripe's verdict)
{ "seq": 56, "at": 1792221015200, "type": "intent_result", "intent_id": "stop-43", "episode_id": "tx-1001", "charger": "CP08",
  "payment_intent": "pi_sim_7_1", "kind": "capture", "amount_cents": 315, "ok": false, "status": "succeeded",
  "error": "This PaymentIntent could not be captured: the remainder of the authorized amount has been released." }

// a clock tick (every 30 s of world time in the runner, every 2 s real live); no seq of its own
{ "seq": 412, "at": 1792221030000, "type": "tick" }
```

**What the world will do to your program** (all of it is real charger behaviour):
- A StopTransaction can arrive twice: `dup_stop` (1.2 s apart) and lost acknowledgements (resent after reconnect). Resent StartTransactions get the same transactionId back.
- One plug-in can produce several transactions: a reboot ends one with reason `Reboot` or `PowerLoss` and starts the next for the same car. The episode ends when the car leaves (a StopTransaction with another reason, normally `EVDisconnected`).
- A transactionId can be one the CSMS never issued (lost StartTransaction): MeterValues and StopTransaction arrive for an unknown id; `transactionData` still has the Transaction.Begin reading.
- The energy register can restart at 0 after a reboot (a restarted transaction starts at `meterStart: 0`; a surviving one reports `Interruption.Begin`/`Interruption.End` readings).
- After an offline period the charger reports its current status first, then drains its queue: `Available` can arrive before the StopTransaction of the session that ended offline.
- The next driver's hold can arrive while the previous session's messages are still queued in the charger.
- Charger clocks can be off by minutes to days; `at` (CSMS arrival time) is trustworthy, `payload.timestamp` is not.

## Payment authority model

The runner executes intents on `src/authority.js`, which reproduces Stripe's manual-capture semantics as verified on a Stripe test sandbox on 2026-10-17 (€50 manual-capture hold, one capture of €11.40, the second capture refused):

| Call | Outcome |
|---|---|
| capture `0 < amount ≤ authorized` on `requires_capture` | `succeeded`, `amount_received = amount`, the remainder is released at once |
| capture `amount > authorized` | refused, `amount_too_large` |
| any capture after a partial capture | refused: "This PaymentIntent could not be captured: the remainder of the authorized amount has been released." |
| any capture after a full capture | refused: "...because it has a status of succeeded..." |
| release (`amount_cents: 0`) on `requires_capture` | `canceled`, the whole hold is released |
| capture after release | refused, status `canceled` |
| unknown PaymentIntent | refused, `resource_missing` |

Only the phrase "the remainder of the authorized amount has been released" is quoted from the verified run; the rest of each message follows Stripe's wording pattern. Live, the host runs the real calls and Stripe's own words come back through `/intents/:id/result`. The host's answer reaches settle.js 1.5 s (world time) after the intent in the runner.

## Scenario runner

`POST /suite` (or `node scripts/suite.mjs <settle.js>`) plays seeded fault scenarios in discrete-event time (no waiting: 30 scenarios take ~2 s) against a fresh copy of the program per scenario, then judges the money **per hold** against the metered truth:

| Metric | Counted when |
|---|---|
| `double` | settlement intents beyond the first for the same hold (each one is a second attempt to move money that was already settled) |
| `stranded` | a hold is still `requires_capture` at the end (the driver's €50 stays blocked until the authorization expires) |
| `unbilled` | the episode delivered energy and nothing was captured |
| `overbilled` | captured more than `expected_cents` + 2 cents |
| `underbilled` | captured something, but less than `expected_cents` − 2 cents |
| `invalid` | intents the world rejected (unknown `payment_intent`, bad amount) |

`ok` = all six are 0, the program loaded and never timed out, and no OCPP schema violation occurred. Each scenario ends with every link restored and 40 world minutes of drain time.

A scenario is a pure function of its seed (`src/scenarios.js`): the archetype is `seed % 10`, the seed's PRNG picks chargers, timings (minutes to hours), power (7-22 kW), meter registers, quirk mixes and extra faults. The default suite is seeds 1-30: every archetype three times.

| seed % 10 | Archetype | Faults |
|---|---|---|
| 0 | `cut-unplug-restore` | cut mid-session, unplug while offline, restore; sometimes a second charger |
| 1 | `dup-stop` | the same with `dup_stop`; sometimes a second session on the same charger |
| 2 | `reboot-restart` | `reboot_restart`, one or two reboots mid-session |
| 3 | `reboot-meter-reset` | `reboot_restart` + `meter_reset_on_reboot`, often followed by cut / offline unplug / restore with `dup_stop` |
| 4 | `stop-without-start` | lost StartTransaction; often a mid-session cut, sometimes with `queue_offline` off (MeterValues lost) |
| 5 | `start-lost-offline` | lost StartTransaction + `dup_stop` + offline unplug |
| 6 | `clock-skew` | charger clocks off by −26 h … +31 h, offline unplug, a second charger skewed the other way |
| 7 | `reboot-while-offline` | cut, reboot during the cut (transaction restarted offline), unplug offline, restore, `dup_stop`, sometimes meter reset |
| 8 | `back-to-back-offline` | driver A leaves while offline, driver B pays and plugs in before the link returns; A's Stop arrives after B's hold |
| 9 | `storm` | 3-5 chargers, 1-2 sessions each, random quirk mixes, lost acknowledgements, mid-session cuts, reboots, sessions that exceed the hold, €25 holds |

Results with the bundled programs (default 30 seeds):
- `settlers/v1-naive.js`: `4/30 ok · double 43 · stranded 3 · unbilled 3 · overbilled 8 · underbilled 10`
- `settlers/reference-episode-ledger.js`: `30/30 ok · double 0 · stranded 0 · unbilled 0 · overbilled 0 · underbilled 0` (also 500/500 on seeds 1000-1499)

## Notes for the host

- **Run it in the sandbox:** upload `world/dist/world.cjs` (committed, ~2 MB; rebuild with `npm --prefix world run bundle`) and start `PORT=8080 node world.cjs` in the background. It prints one line when ready; poll `GET /health` until `online` is 12.
- **Settlement tick:** `POST /intents/claim` → execute each intent on Stripe (`kind: "capture"` → capture with `amount_to_capture = amount_cents`; `kind: "release"` → cancel) → `POST /intents/:id/result` with Stripe's answer verbatim. Claims are leased, so overlapping ticks never double-execute an intent.
- **Idempotency key:** derive it from `payment_intent` + `episode_id` to let Stripe dedupe retries of the same decision. Note what that means for the demo: v1-naive keys episodes by transactionId, so under `dup_stop` its two intents share an `episode_id` and an idempotent replay would answer the second one with the first capture (no refusal, but still one capture); under `reboot_restart` the two intents have different `episode_id`s and Stripe refuses the second. Keying on the world intent `id` instead makes every duplicate decision visible as a Stripe refusal.
- **Agent loop:** `PUT /settle` with the model's code (400 carries the loader error to feed back), then `POST /suite`, feed the failing scenarios' `notes` back to the model. `POST /suite {source}` dry-runs a candidate without deploying it; `POST /suite/trace {seed, source}` gives the full event feed for one seed.
- **No egress:** the world binds `HOST:PORT` and the 12 proxies on `127.0.0.1:<ephemeral>`, and connects only to `127.0.0.1`. It has no keys and makes no outbound calls.

## Limits

- `node:vm` is not a security boundary by itself. The sandbox removes every capability (no modules, no host objects cross the boundary, JSON-only I/O, no code generation, per-call timeouts) and the CreateOS microVM with no internet and no keys is the real boundary.
- The chargers are simulations built on real OCPP 1.6J message schemas and documented firmware behaviour, not vendor firmware. One connector per charger. Status messages generated while offline are not queued (the current status is sent on reconnect).
- The runner checks the money outcome per hold; it does not check capture timing beyond the episode boundaries (an early capture shows up as underbilled).
- Authorization expiry (7 days), incremental authorization and overcapture are not modeled.
