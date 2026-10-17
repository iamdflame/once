"use client";

import { useEffect, useRef } from "react";
import type { WorldEvent } from "@/components/data/types";
import s from "./board.module.css";

function hhmmss(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0").slice(0, 1)}`;
}

export function WireLog({ events, filter }: { events: WorldEvent[]; filter: string | null }) {
  const ref = useRef<HTMLOListElement>(null);
  const shown = (filter ? events.filter((e) => e.charger === filter || e.charger === null) : events).slice(-60);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <section className={s.wire} aria-labelledby="wire-h">
      <header className={s.wireHead}>
        <h2 id="wire-h" className={s.panelTitle}>
          On the wire
        </h2>
        <span className={s.wireSub}>{filter ? `${filter} and the world` : "all chargers"}</span>
      </header>
      <ol ref={ref} className={s.wireList} aria-live="off">
        {shown.length === 0 ? <li className={s.wireEmpty}>Nothing yet. Plug a car in.</li> : null}
        {shown.map((e) => (
          <li key={e.id} className={s.wireLine} data-kind={e.kind} data-dir={e.dir ?? "in"}>
            <time className={s.wireTime} dateTime={new Date(e.t).toISOString()}>
              {hhmmss(e.t)}
            </time>
            <span className={s.wireWho}>{e.charger ?? "world"}</span>
            <span className={s.wireText}>{e.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
