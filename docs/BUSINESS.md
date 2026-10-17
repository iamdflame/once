# Business

Everything here is either sourced (link given) or explicitly labelled **estimate**. There are no customers, users or revenue yet; this is a hackathon product and none are claimed. "Femke" below is a composite persona, not a real person.

## 1. Who pays

Small and mid-size **charge-point operators (CPOs)** and **CSMS vendors** that must accept ad-hoc card payment at public charge points, and have no way to prove their payment code is correct when a charger drops offline.

Persona (composite): the only backend engineer at a 12-person CPO running about 140 public AC chargers on an open-source CSMS (SteVe or CitrineOS class). A driver posts that charger 23 "came back online and billed me twice"; another has a EUR 50 hold that never released. Her CSMS has a Stripe QR payment module but no test that says what happens when the link drops mid-session, and no fleet to try it on except the live one. Her job: ship payment code she can show the driver, the bank and her boss is correct, without touching a real charger first.

## 2. The market and why now

- **Size.** The EU had **1.1 million public charge points by the end of 2025, five times 2020** (Transport & Environment, July 2026, https://www.transportenvironment.org/topics/cars/charging). About 17% are fast chargers (T&E AFIR tracker, https://www.transportenvironment.org/articles/car-charging-afir-targets-where-do-we-stand).
- **Number of CPOs.** Not found in sources. **Estimate:** thousands of CPOs in the EU, most with fewer than 500 points.
- **The law.** AFIR (Regulation (EU) 2023/1804) Art. 5 requires ad-hoc payment "using a payment instrument widely used in the Union" at all new public points from **13 April 2024**; card readers or contactless for points of 50 kW and above; internet-based secure payment such as QR is allowed below 50 kW; 50 kW and above points along TEN-T or safe-and-secure parking must comply from **1 January 2027**; prices for 50 kW and above must be per kWh (Art. 5, https://gesetze.legal/eu/vo_eu_2023_1804/5; electrive, 2024-01-17, https://www.electrive.com/2024/01/17/european-alternate-fuels-infrastructure-regulation-to-kick-in-from-april-13). The Commission's Q&A says a static QR code can be in line with AFIR as long as it is readable and secure (electrive, 2024-04-15); a per-session dynamic QR is a national-body preference, not the law. Once works with either: a static QR per charger, with a Checkout Session created on scan.
- **The pain is current.** 36% of drivers in a Paythru survey reported multiple pre-authorisations for a single charge, with holds ranging from GBP 1 to GBP 75 (Transport + Energy, 2024-03-14, https://transportandenergy.com/2024/03/14/easing-payment-anxiety-around-ev-charging/). Meridian's Zero network dropped holds entirely over complaints (https://zero.meridianenergy.co.nz/news/meridian-says-goodbye-to-pre-authorisation-across-zero-ev-charging-network).
- **Open-source CSMSs now ship Stripe payments** (CitrineOS 1.3.0, July 2024, https://lfenergy.org/?p=9690) without a correctness suite.

## 3. Pricing (estimates)

| Product | Buyer | Price (estimate) |
|---|---|---|
| Proven payment module + fault suite, per public charger | CPOs | EUR 2-5 per charger per month |
| Conformance runner, per CSMS | CSMS vendors | EUR 0.5-1k per month |

Illustrative arithmetic, **not a forecast**: 300,000 points on SMB CPOs at EUR 36 per charger per year is about EUR 11M per year. None of the inputs is validated.

Unit costs to watch: Stripe processing fees on captures (the customer's, not ours), and our own cost of running scenario suites in sandboxes. Not yet measured.

## 4. The ladder

1. **Rung 3, the per-charger product.** The agent writes and proves the hold-meter-capture module against the operator's own CSMS, and re-runs the suite on every change.
2. **Rung 4, the conformance venue.** Charger makers and CSMS vendors certify "pays exactly once while offline" against a shared, growing fault suite. The OCA's OCTT certifies protocol conformance, not money; this is the gap. Rung 5 would need the certificate to become something banks or AFIR auditors ask for; that is not claimed.
3. **Beyond chargers.** The same exactly-once kernel for other store-and-forward devices that take money offline: PAYGo solar (OpenPAYGO Token keeps a `count` plus `used_counts` and returns `ALREADY_USED` on replay), vending, transit validators. Stripe Terminal card-present for 50 kW and above sites.

## 5. Moat

- The **library of real firmware deviations** (reboot-restart, queue order, Stop without Start, Stop in MeterValues vs separate) encoded as runnable scenarios, sourced and grown from every customer run.
- A proven exactly-once kernel reusable across devices.
- Honest limit: the kernel itself is copyable once seen. The scenario library and certification are the defensible parts, and they are unproven.

## 6. Competitors and neighbours (Scoop-Check, 2026-10-16)

Nothing found combines agent-written payment code, a simulated OCPP fleet and network partitions as the test instrument, with exactly-once money as the oracle. Nearest neighbours:

| Neighbour | What it is | Difference |
|---|---|---|
| CitrineOS Payments module (Apache-2.0) | Stripe web payments and Scan&Charge QR | The integration without the proof; it could be a target for Once's suite |
| Spirii pre-auth and capture (docs.spirii.com) | Commercial CPO platform with incremental auth, retries, reused holds | Offline and duplicate handling undocumented; no test suite anyone can run |
| Kempower ChargEye virtual chargers | Simulate charging and payment flows in CI/CD | Cloud, proprietary, no partition-based fault injection |
| Simulators: Solidstudio Virtual Charge Point, Monta emulator, docile-charge-point, MicroOcpp, Fraunhofer OCSS | Charger simulators | Chargers, no money, no partitions |
| Research: OCPPStorm, OCPPuzz, EmuOCPP, EVECTOR | Security fuzzing of CSMSs | Not payment correctness |
| Patents US10406930B2, US9436944B2 | Offline authorization codes; mobile payment with unknown final amount | Nothing on deduplicating queued transactions against a hold |
| IFSF EV payment sequence diagrams | Assume pre-auth; note it is expected in OCPP 2.1 | Specification, not tooling |
| Hackathon: "Agentic EV Charger Maintenance" (Devpost) | Maintenance agents | Not payment; 4 charger entries in a 65,214-entry field corpus, none on payments |

Verdict at the time: not scooped. The pieces exist separately; the exactly-once-under-partition proof does not. This is a search result on one date, not a guarantee.

## 7. Risks to the business (honest)

- **Niche buyer set.** The hinge question is how many CPOs pay EUR 3 per charger. Answer to be tested, not assumed.
- **Fidelity.** A charging engineer will ask for real firmware (EVerest, MicroOcpp) before being impressed. The simulator reproduces documented deviations only.
- **Stripe feature access.** Incremental and extended authorization are IC+ features on Stripe; a small CPO on blended pricing must request access. Shown in test mode only, said so openly.
- **Regulation shifts.** AFIR specifics (QR vs reader) vary by national body.
