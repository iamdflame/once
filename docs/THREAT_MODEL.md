# Threat model

Scope: Once's runtime, where a language model writes code that decides when payments are captured. Facts marked **planned** describe controls specified in the build and not yet verified in this repository.

## 1. What we protect

1. Money: no capture beyond the hold, no second capture for one episode, no capture for an episode that was never paid for.
2. Secrets: the Stripe secret key, the model key, the CreateOS key.
3. The host: the process that holds those secrets.
4. Honest evidence: the results the UI reports must be what the sandbox actually produced.

## 2. The central assumption

`settle.js` is **untrusted by construction**. A model writes it, from a prompt that includes scenario reports derived from simulated device traffic. We assume it can be buggy, and we assume that a prompt-injection or a hostile spec edit could make it adversarial. The design does not rely on the model behaving.

## 3. Trust boundaries and controls

```
 untrusted                         host (trusted)                 witness
 settle.js  --intents only-->  validate + execute  --idempotency key-->  Stripe
 (vm, no fs/net/process)       (keys live here)                           (refuses duplicates)
 inside a no-keys sandbox: HTTP/HTTPS off the allowlist refused
```

| Control | What it does | State |
|---|---|---|
| **Egress allowlist** | The world sandbox's egress allowlist is a single sinkhole entry, and it filters by SNI/Host: HTTP and HTTPS to any host off the allowlist are refused; DNS resolves; nothing secret is inside. Measured from inside the sandbox by the live probe (`POST /api/world/probe`, 2026-10-17): an HTTPS POST to `api.stripe.com/v1/charges`, an HTTP POST to `example.com` and HTTP to `1.1.1.1` all got no response; a raw TCP connect is accepted and DNS resolves (both disclosed by the probe, not hidden). Generated code has no network API at all (`vm`). | live; enforced by CreateOS, checked by the probe |
| **No keys in the world** | The Stripe key and the model key are never uploaded to the sandbox. The world process has nothing to leak. Only `world/` source and the generated `settle.js` are uploaded. | planned (by construction of the upload step) |
| **`vm` isolation for `settle.js`** | The program is loaded fresh per run in a Node `vm` context with no `fs`, `net`, `process` or `require`; its globals are the event stream and an emit function. Output is a list of intents, validated for shape. | planned |
| **Execution happens on the host** | The world only proposes `{episode_id, payment_intent, amount_cents}`. The host decides whether to execute: the PaymentIntent must belong to a known episode (created by the host's own Checkout), the amount must be at most the hold, and the episode must not already have a result. | planned |
| **Idempotency keys** | Each capture uses an idempotency key derived from the world's intent id (with the hold and episode), so a retried intent produces the same Stripe request, and the world leases each intent to one tick. | live |
| **Stripe refuses duplicates** | A PaymentIntent has one capture; Stripe rejects another and releases the uncaptured remainder after a partial capture. This is the last line: even a fully compromised `settle.js` and a buggy host cannot capture an episode twice. | verified in the pre-build spike and in production on 2026-10-17 (EUR 50 hold, one capture of EUR 4.37, second refused by Stripe) |
| **Test mode only** | Payments use a Stripe test sandbox. No real card data, no real funds. | by configuration |

## 4. Threats and responses

| # | Threat | Response | Residual risk |
|---|---|---|---|
| T1 | Generated code attempts network exfiltration or a call to Stripe | No keys, `vm` with no net; HTTP and HTTPS to any host off the allowlist are refused; any attempt fails or has nothing to send | Sandbox escape from a `vm` is possible in principle; then the attacker is in a keyless microVM where HTTP and HTTPS off the allowlist are refused, a raw TCP connect is accepted and DNS resolves: DNS is a known low-bandwidth side channel, and the world holds no keys or customer data to leak through it |
| T2 | Generated code reads the filesystem or environment | No `fs`/`process` in the `vm`; the sandbox holds no secrets | same as T1 |
| T3 | Generated code emits an intent for more than the hold | Host checks amount against the episode's hold; Stripe rejects `amount_to_capture` above the authorized amount | none beyond Stripe's own rules |
| T4 | Generated code emits many intents or duplicate intents (bug or attack) | Idempotency key per intent and leased intents; host executes each intent at most once; Stripe refuses a second capture | a wrong-but-single capture (see T6) |
| T5 | Generated code forges an intent for an episode that was never paid | Host only executes intents whose PaymentIntent it created and which is in `requires_capture` | none for money; the world could mislead the UI (T8) |
| T6 | Generated code captures the wrong amount (once) | The scenario oracle compares captured amounts to metered energy; the suite must be green before v2 is deployed; partial amounts cannot exceed the hold | This is a correctness risk, not a security one. The suite covers 30 scenarios; real firmware deviates more |
| T7 | Prompt injection through simulated device data into the agent loop | The agent sees scenario reports generated by our own code from seeded scenarios, not free text from outside; its output is only a `settle.js` file | A malicious scenario contributor could write hostile text; scenarios are code-reviewed |
| T8 | The world lies about results to the UI | The UI shows Stripe's own objects and links for every capture; dashboard is the witness for money. Suite results are labelled as sandbox-reported | A compromised world could report a green suite falsely; mitigated by re-running locally (`node world/index.js`) and by Stripe being the money source of truth |
| T9 | Host abuse: anonymous users burn the sandbox quota or the model | Free plan limits (1 concurrent sandbox, 10 creates per rolling 24 h); the world is reused; agent attempts capped at 3 per run | A demo-grade rate limit only; planned: per-visitor limits |
| T10 | Secret leakage from the repo | `.env` and `.projects/vault` are git-ignored; keys are provisioned by Stripe Projects and live only on the host | Keys pasted into logs by mistake; planned check before release |
| T11 | Replay of the Stripe webhooks / forged callbacks | The first build does not depend on webhooks for money; the host polls the world and calls Stripe directly. Any Stripe webhook added later must verify signatures | none in the first build |

## 5. What this model does not claim

- It does not claim real charger firmware behaves like the simulated fleet. The fleet reproduces documented deviations (reboot-restart, queued and duplicated Stops, Stop without Start, meter reset); it is not every firmware.
- It does not claim PCI scope: Checkout handles card data, the project never sees PANs.
- It does not claim the sandbox provider is bug-free: CreateOS Sandbox is an alpha ("APIs may change", no SLA, per the event materials). The controls are layered so that no single layer is the only protection.
- It does not make a wrong-but-valid capture impossible; it makes the money bounded (the hold), single (idempotency plus Stripe), and checked (suite plus oracle).

## 6. Summary in one sentence

The agent's code can only say "capture this much for this episode"; it has no network API, holds no key and cannot call Stripe (and the sandbox around it refuses HTTP and HTTPS to any host off the allowlist; DNS resolves; nothing secret is inside), and even if the host and the code both misbehave, Stripe will not capture one authorization twice.
