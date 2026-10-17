import s from "./board.module.css";

/**
 * One row of a segment display. `ghost` is the all-segments-on pattern that
 * sits behind the lit digits the way unlit segments do on a real LCD.
 */
export function LcdRow({ value, ghost, unit, label }: { value: string; ghost: string; unit: string; label: string }) {
  return (
    <div className={s.lcdRow} role="img" aria-label={`${label} ${value.trim()} ${unit}`}>
      <span className={s.segments} aria-hidden="true">
        <span className={s.ghost}>{ghost}</span>
        <span className={s.lit}>{value}</span>
      </span>
      <span className={s.unit} aria-hidden="true">
        {unit}
      </span>
    </div>
  );
}

export function fmtKwh(kwh: number): string {
  const v = Math.min(kwh, 999.9);
  return v.toFixed(1).padStart(5, " ");
}

export function fmtEur(cents: number): string {
  const v = Math.min(cents / 100, 99.99);
  return v.toFixed(2).padStart(5, " ");
}
