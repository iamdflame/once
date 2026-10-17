"use client";

import { useEffect, useRef } from "react";
import type { Charger } from "@/components/data/types";
import { Faceplate } from "./Faceplate";
import s from "./board.module.css";

export function Wall({ chargers, selected, onSelect }: { chargers: Charger[]; selected: string | null; onSelect(id: string): void }) {
  const rows = [chargers.slice(0, 6), chargers.slice(6, 12)];
  const skeleton = chargers.length === 0;
  const rowRef = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);

  // On a phone the wall is one scrolling row: bring the selected plate to the front,
  // instantly on the first paint and smoothly after a tap.
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !selected || row.clientWidth === 0) return;
    const plate = row.querySelector<HTMLElement>(`[data-charger="${selected}"]`);
    if (!plate) return;
    const pad = parseFloat(getComputedStyle(row).paddingLeft) || 0;
    const left = plate.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft - pad;
    row.scrollTo({ left: Math.max(0, left), behavior: firstScroll.current ? "auto" : "smooth" });
    firstScroll.current = false;
  }, [selected, skeleton]);

  return (
    <div className={s.wall} aria-label="Charger wall" role="group">
      {skeleton ? (
        <div className={s.wallEmpty}>
          <p>Waiting for the world…</p>
          <span className={s.wallEmptyNote}>The sandbox is being created or resumed. The twelve plates appear when it answers.</span>
        </div>
      ) : (
        rows.map((row, ri) => (
          <div key={ri} className={s.rowBlock}>
            <div className={s.row}>
              {row.map((c) => (
                <Faceplate key={c.id} c={c} selected={selected === c.id} onSelect={onSelect} />
              ))}
            </div>
            <Rail row={row} index={ri} />
          </div>
        ))
      )}
      {!skeleton ? (
        <div className={s.scroller}>
          <div ref={rowRef} className={s.scrollRow}>
            {chargers.map((c) => (
              <div key={c.id} className={s.scrollBay} data-charger={c.id}>
                <Faceplate c={c} selected={selected === c.id} onSelect={onSelect} compact />
              </div>
            ))}
          </div>
          <Rail row={chargers} index={0} />
        </div>
      ) : null}
    </div>
  );
}

function Rail({ row, index }: { row: Charger[]; index: number }) {
  return (
    <div className={s.rail} aria-hidden="true">
      <span className={s.railLabel}>
        CSMS <em>OCPP 1.6J · ws://csms:9000</em>
        <b>{index === 0 ? "trunk A" : "trunk B"}</b>
      </span>
      <span className={s.ports}>
        {row.map((c) => (
          <span key={c.id} className={s.port} data-link={c.link} />
        ))}
      </span>
    </div>
  );
}
