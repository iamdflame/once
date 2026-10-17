"use client";

import type { Charger } from "@/components/data/types";
import { LcdRow, fmtEur, fmtKwh } from "./Lcd";
import s from "./board.module.css";

const STATUS_WORD: Record<Charger["status"], string> = {
  idle: "Available",
  charging: "Charging",
  offline: "Offline",
  holding: "Holding",
  faulted: "Faulted",
};

export function Faceplate({ c, selected, onSelect, compact = false }: { c: Charger; selected: boolean; onSelect(id: string): void; compact?: boolean }) {
  const hold = c.hold;
  let line = "";
  if (c.link === "rebooting") line = "REBOOTING";
  else if (c.link === "cut") line = c.queued > 0 ? `OFFLINE · ${c.queued} QUEUED` : "OFFLINE";
  else if (hold && hold.status === "uncaptured") line = c.plugged ? `HOLD €${(hold.amount_cents / 100).toFixed(2)}` : `HOLD €${(hold.amount_cents / 100).toFixed(2)} · READY`;
  else if (hold && hold.status === "captured") line = `CAPTURED €${((hold.captured_cents ?? 0) / 100).toFixed(2)}`;
  else if (hold && hold.status === "refused") line = "CAPTURE REFUSED";
  else if (c.plugged) line = c.transaction_id ? `RFID · TX ${c.transaction_id}` : "RFID";
  else line = "TAP OR SCAN TO PAY";

  return (
    <div className={`${s.bay} ${compact ? s.bayCompact : ""}`}>
      <button
        type="button"
        className={`${s.plate} ${selected ? s.plateSelected : ""}`}
        data-status={c.status}
        data-link={c.link}
        aria-pressed={selected}
        aria-label={`Charger ${c.id}, ${STATUS_WORD[c.status]}, ${c.kwh.toFixed(1)} kilowatt hours, ${(c.cents / 100).toFixed(2)} euro${hold ? `, hold ${hold.status}` : ""}`}
        onClick={() => onSelect(c.id)}
      >
        <span className={s.plateTop}>
          <span className={s.stencil}>{c.id}</span>
          <span className={s.led} data-status={c.status} aria-hidden="true" />
        </span>

        <span className={s.lcd} aria-hidden="true">
          <LcdRow value={fmtKwh(c.kwh)} ghost="888.8" unit="kWh" label="energy" />
          <LcdRow value={fmtEur(c.cents)} ghost="88.88" unit="EUR" label="price" />
          <span className={s.lcdLine} data-kind={hold?.status ?? (c.link === "up" ? "none" : "offline")}>
            {line}
          </span>
        </span>

        <span className={s.socketRow} aria-hidden="true">
          <Socket plugged={c.plugged} />
          <span className={s.kw}>
            {c.kw} kW
            {c.transaction_id ? <em> · tx {c.transaction_id}</em> : null}
          </span>
        </span>
      </button>
      <Cable link={c.link} />
    </div>
  );
}

function Socket({ plugged }: { plugged: boolean }) {
  // A Type 2 socket seen head-on; the plug appears when a car is connected.
  return (
    <svg className={s.socket} width="44" height="40" viewBox="0 0 44 40">
      <path d="M8 4h28a6 6 0 0 1 6 6v18a8 8 0 0 1-8 8H10a8 8 0 0 1-8-8V10a6 6 0 0 1 6-6z" fill="oklch(0.86 0.01 80)" stroke="oklch(0.3 0.02 60 / 0.25)" />
      <g fill={plugged ? "oklch(0.25 0.01 80)" : "oklch(0.7 0.012 80)"}>
        <circle cx="14" cy="14" r="2.6" />
        <circle cx="22" cy="12" r="2.6" />
        <circle cx="30" cy="14" r="2.6" />
        <circle cx="12" cy="24" r="2.6" />
        <circle cx="22" cy="26" r="2.6" />
        <circle cx="32" cy="24" r="2.6" />
        <circle cx="22" cy="19" r="1.6" />
      </g>
      {plugged ? (
        <g>
          <rect x="4" y="2" width="36" height="34" rx="9" fill="oklch(0.28 0.012 80)" opacity="0.92" />
          <path d="M16 36h12v4H16z" fill="oklch(0.28 0.012 80)" />
          <circle cx="22" cy="19" r="4.5" fill="oklch(0.6 0.17 145)" className={s.plugLight} />
        </g>
      ) : null}
    </svg>
  );
}

function Cable({ link }: { link: Charger["link"] }) {
  const cut = link === "cut";
  return (
    <span className={s.drop} data-link={link} aria-hidden="true">
      <span className={s.cableTop} />
      {cut ? (
        <span className={s.hazard}>
          <span className={s.hazardChip} />
        </span>
      ) : (
        <span className={s.cableMid} />
      )}
      <span className={s.cableBottom} />
    </span>
  );
}
