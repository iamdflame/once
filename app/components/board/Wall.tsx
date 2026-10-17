"use client";

import type { Charger } from "@/components/data/types";
import { Faceplate } from "./Faceplate";
import s from "./board.module.css";

export function Wall({ chargers, selected, onSelect }: { chargers: Charger[]; selected: string | null; onSelect(id: string): void }) {
  const rows = [chargers.slice(0, 6), chargers.slice(6, 12)];
  const skeleton = chargers.length === 0;
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
          <div className={s.scrollRow}>
            {chargers.map((c) => (
              <Faceplate key={c.id} c={c} selected={selected === c.id} onSelect={onSelect} compact />
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
