# Once · the interface

The product visual is the charger itself. The board is a wall of twelve enamel faceplates on concrete, each with a segment LCD (DSEG7) for kWh and €, a status LED and a cable down to the CSMS rail; a cut link shows a yellow-and-black hazard break in the cable. The ledger is a thermal receipt that prints line by line and links every line to its Stripe object. The agent bench is a worktop with the `settle.js` diff, the model status line and thirty storm tiles that flip green or red.

Pages: `/` the board · `/agent` the bench · `/proof` every capture, the latest storm report, the sandbox settings, how to verify · `/about` the company in five lines and the stack.

## Layout

```
app/app/            pages (page.tsx, agent/, proof/, about/, not-found.tsx), layout.tsx (fonts, providers), globals.css (tokens, base, buttons)
components/data/    types.ts · adapter.ts (the WorldAdapter interface) · mock.ts (in-browser world) · live.ts (host API) · provider.tsx (mode, context)
components/board/   Board (the page) · Wall · Faceplate · Lcd · Controls · CheckoutSheet (mock Checkout) · WireLog
components/ledger/  Receipt (the thermal strip)
components/bench/   Bench · Diff (LCS line diff) · Tiles (30 storms)
components/proof/   ProofView
components/shell/   Nav · Footer
public/fonts/       DSEG7 Classic (SIL OFL, self-hosted); Barlow Semi Condensed and JetBrains Mono come through next/font
public/shots/       screenshots of every screen at 1440×900 and 390×844 (`node scripts/shots.mjs`)
```

## Tokens

OKLCH on `:root` in `globals.css`: `--concrete`, `--enamel`, `--lcd`, `--segment-amber`, `--hold-amber`, `--captured-green`, `--refused-carmine`, `--hazard-yellow`, plus ink, line and paper neutrals tinted warm. Type: `--font-ui` (Barlow Semi Condensed), `--font-code` (JetBrains Mono), `--font-seg` (DSEG7). Radii: plate 18, LCD 8, controls 10. Shadows are layered and tinted with the concrete hue. Light by day only.

Motion: the receipt prints (clip + rise, 420 ms), LEDs breathe or blink by state, the hazard chip snaps in, the tiles flip on the X axis, the mock Checkout sheet rises. Everything collapses to its end state under `prefers-reduced-motion`.

## The world adapters

Components never see raw world or Stripe JSON. They read a `Snapshot` (`components/data/types.ts`) through `useWorld()` and call the `WorldAdapter` methods (`cmd`, `checkout`, `confirmCheckout`, `tick`, `runSuite`, `fix`, `proof`).

- **`MockWorld`** (`mock.ts`): twelve chargers with time-compressed metering (300×, like the world's LiveClock), the five firmware quirks, a link proxy, a `settle.js` v1 (naive, keyed by transactionId) and v2 (episode ledger) run as real settlers, a stand-in for Stripe that captures once and refuses the second attempt with Stripe's phrase ("the remainder of the authorized amount has been released"), thirty seeded storms shaped like the world's archetypes (v1 ends 4/30 green, v2 30/30), and a replayed agent loop. A mock Checkout sheet stands in for Stripe Checkout. Nothing touches the network.
- **`LiveWorld`** (`live.ts`): the host routes in `app/app/api/**` (`/api/world/ensure`, `/state`, `/cmd`, `/settle`, `/suite?stream=1`, `/api/checkout`, `/api/checkout/confirm`, `/api/settle/tick`, `/api/agent/fix`, `/api/proof`). Shapes follow `world/README.md` and `app/lib`; the normalisers in `live.ts` are tolerant, so a renamed field degrades to a blank. The receipt derives from the world's holds and their results; the wire log from `/state`'s events. The board polls `/state` once a second and ticks settlement while intents are pending; the suite and the agent loop are consumed as NDJSON streams.

### Picking the mode

`provider.tsx` decides once per page load: `?mode=mock|live` in the URL (remembered in `localStorage`), else the stored choice, else `NEXT_PUBLIC_ONCE_MODE`, else a probe of `GET /api/world/state` (live when it answers). The badge in the nav shows the mode and toggles it. The server renders an empty wall; the client fills it after hydration (`useSyncExternalStore`), so there is no hydration mismatch and the mock stays deterministic per session.

## Running

```
npm run dev                                      # mock by default; the live routes are probed
WORLD_URL=http://127.0.0.1:8080 npm run dev      # live against a local world (node world/dist/world.cjs)
PLAYWRIGHT_DIR=<dir with playwright> node scripts/shots.mjs http://localhost:3000 public/shots mock
```

The demo (BUILD-ONCE.md): select CP07 → **Plug in and pay** (test card 4242) → **Cut cable** → **Unplug** → **Restore**. The wire log shows the StopTransaction arrive twice 1.2 s apart; the receipt shows one capture and the released remainder. Turn **Reboot restarts the transaction** on, reboot mid-session under v1 and Stripe refuses the second capture in its own words; **Fix it** on the bench writes v2 and runs the thirty storms.
