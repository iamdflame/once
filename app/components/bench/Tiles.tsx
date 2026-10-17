import type { Scenario } from "@/components/data/types";
import s from "./bench.module.css";

export function Tiles({ tiles, count = 30, running }: { tiles: (Scenario | null)[]; count?: number; running: boolean }) {
  const filled = tiles.filter(Boolean) as Scenario[];
  const t = filled.reduce(
    (acc, sc) => ({ stranded: acc.stranded + sc.stranded, double: acc.double + sc.double, unbilled: acc.unbilled + sc.unbilled, ok: acc.ok + (sc.ok ? 1 : 0) }),
    { stranded: 0, double: 0, unbilled: 0, ok: 0 },
  );
  const allIn = filled.length === count;
  const green = allIn && t.ok === count;
  return (
    <div className={s.tilesWrap}>
      <ol className={s.tiles} aria-label="Thirty storm scenarios">
        {Array.from({ length: count }, (_, i) => {
          const sc = tiles[i] ?? null;
          const state = sc ? (sc.ok ? "ok" : "red") : running && i === filled.length ? "running" : "pending";
          return (
            <li
              key={i}
              className={s.tile}
              data-state={state}
              title={sc ? `seed ${sc.seed} · ${sc.faults.join(", ")} · double ${sc.double} · stranded ${sc.stranded} · unbilled ${sc.unbilled}` : `scenario ${i + 1}`}
              aria-label={sc ? `Scenario ${i + 1}, seed ${sc.seed}, ${sc.ok ? "passed" : `failed: double ${sc.double}, stranded ${sc.stranded}, unbilled ${sc.unbilled}`}` : `Scenario ${i + 1}, not run`}
            >
              <span className={s.tileFace} aria-hidden="true">
                <span className={s.tileN}>{i + 1}</span>
                {sc ? <span className={s.tileFaults}>{sc.faults.map(short).join(" ")}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <p className={`${s.totals} num`} data-green={green} aria-live="polite">
        <span>
          stranded <b>{t.stranded}</b>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          double <b>{t.double}</b>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          unbilled <b>{t.unbilled}</b>
        </span>
        <span className={s.totalsOk}>
          {filled.length ? `${t.ok}/${filled.length} green` : "not run"}
        </span>
      </p>
    </div>
  );
}

function short(f: string): string {
  const map: Record<string, string> = {
    cut: "cut",
    unplug_offline: "unplug",
    restore: "rest",
    dup_stop: "dup",
    reboot_restart: "rbt",
    stop_without_start: "s/s",
    meter_reset: "mtr",
    meter_reset_on_reboot: "mtr",
    clock_skew: "clk",
    reorder: "ord",
    queue_offline: "q",
  };
  return map[f] ?? f.slice(0, 4);
}
