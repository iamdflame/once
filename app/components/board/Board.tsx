"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWorld } from "@/components/data/provider";
import type { Command } from "@/components/data/types";
import { Wall } from "./Wall";
import { Controls } from "./Controls";
import { CheckoutSheet } from "./CheckoutSheet";
import { WireLog } from "./WireLog";
import { Receipt } from "@/components/ledger/Receipt";
import s from "./board.module.css";

type Notice = { tone: "ok" | "warn" | "err"; text: string } | null;

export function Board() {
  const { world, snap, mode, setMode } = useWorld();
  const [selected, setSelected] = useState<string | null>("CP07");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const confirmed = useRef(false);

  const charger = snap.chargers.find((c) => c.id === selected) ?? null;

  // The settlement tick: once a second while the board is open.
  useEffect(() => {
    const t = setInterval(() => void world.tick(), 1000);
    return () => clearInterval(t);
  }, [world]);

  // Back from Stripe Checkout: bind the hold, then plug the car in.
  useEffect(() => {
    if (confirmed.current) return;
    const q = new URLSearchParams(window.location.search);
    const sid = q.get("session_id");
    const ch = q.get("charger");
    if (q.get("canceled")) {
      setNotice({ tone: "warn", text: `Checkout cancelled${ch ? ` for ${ch}` : ""}. Nothing was authorised.` });
      if (ch) setSelected(ch);
      history.replaceState(null, "", "/");
      confirmed.current = true;
      return;
    }
    if (!sid) return;
    // A session id only ever comes back from a real Stripe redirect: wait for (or switch to) the live world.
    if (mode !== "live") {
      setMode("live");
      return;
    }
    confirmed.current = true;
    if (ch) setSelected(ch);
    setBusy("confirm");
    setNotice({ tone: "ok", text: "Confirming the hold with Stripe…" });
    world
      .confirmCheckout(sid)
      .then(async (r) => {
        const id = r.charger ?? ch;
        if (r.ok && id) {
          setSelected(id);
          setNotice({ tone: "ok", text: `€50.00 held on ${id} (${r.payment_intent ?? "PaymentIntent"}, uncaptured). Plugging the car in.` });
          await world.cmd({ op: "plug", charger: id });
        } else {
          setNotice({ tone: "err", text: `Could not bind the hold: ${r.error ?? "unknown error"}` });
        }
      })
      .finally(() => {
        setBusy(null);
        history.replaceState(null, "", "/");
      });
  }, [world, mode, setMode]);

  const onCmd = useCallback(
    async (c: Command) => {
      setBusy(c.op);
      try {
        await world.cmd(c);
        setNotice(null);
      } catch (e) {
        setNotice({ tone: "err", text: (e as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [world],
  );

  const onPay = useCallback(
    async (id: string) => {
      setBusy("pay");
      try {
        const start = await world.checkout(id);
        if (start.mode === "redirect" && start.url) {
          window.location.assign(start.url);
          return;
        }
        setSheet(id);
      } catch (e) {
        setNotice({ tone: "err", text: `Checkout could not start: ${(e as Error).message}` });
      } finally {
        setBusy(null);
      }
    },
    [world],
  );

  return (
    <>
      <section className={`wrap ${s.hero}`}>
        <h1 className={s.h1}>
          Cut the cable, pull the plug, <span className={s.nowrap}>bring it back.</span>
        </h1>
        <p className={s.lede}>
          The charger reports the stop twice. Stripe captures once. Twelve simulated OCPP 1.6J chargers run inside a CreateOS sandbox with no internet; the agent&apos;s settlement code runs
          there too, and only capture intents leave.
        </p>
      </section>

      <section className={s.wallBand} aria-label="The wall">
        <div className="wrap">
          <Wall chargers={snap.chargers} selected={selected} onSelect={setSelected} />
        </div>
      </section>

      <section className={`wrap ${s.bench}`}>
        <Controls charger={charger} busy={busy} notice={notice} onCmd={onCmd} onPay={onPay} />
        <Receipt lines={snap.receipt} mode={mode} />
        <WireLog events={snap.events} filter={selected} worldTime={mode === "live"} />
      </section>

      {sheet ? (
        <CheckoutSheet
          charger={sheet}
          onClose={() => setSheet(null)}
          onPay={async () => {
            try {
              const r = await world.mockPay!(sheet);
              setNotice({ tone: "ok", text: `€50.00 held on ${sheet} (${r.payment_intent.slice(0, 12)}…, uncaptured). The car is plugged in.` });
            } catch (e) {
              setNotice({ tone: "err", text: (e as Error).message });
            } finally {
              setSheet(null);
            }
          }}
        />
      ) : null}
    </>
  );
}
