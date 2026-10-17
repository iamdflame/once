import type { Metadata } from "next";
import s from "./og.module.css";

export const metadata: Metadata = {
  title: "Once — OG image",
  robots: { index: false },
};

// A 1200×630 composition rendered to public/og.png by scripts/og.mjs.
export default function OgPage() {
  const plates = [
    { id: "CP06", kwh: " 18.2", eur: "10.92", line: "HOLD €50.00", led: "holding" },
    { id: "CP07", kwh: " 19.0", eur: "11.40", line: "CAPTURED €11.40", led: "idle", cut: true },
    { id: "CP08", kwh: "  0.0", eur: " 0.00", line: "TAP OR SCAN TO PAY", led: "idle" },
  ];
  return (
    <div className={s.canvas}>
      <div className={s.left}>
        <p className={s.brand}>ONCE</p>
        <h1 className={s.h1}>
          Cut the cable, pull the plug, bring it back.
        </h1>
        <p className={s.sub}>The charger reported the stop twice. Stripe captured once: €11.40.</p>
        <p className={s.stack}>Stripe Projects · CreateOS · exactly-once payments for EV chargers</p>
      </div>
      <div className={s.right}>
        {plates.map((p) => (
          <div key={p.id} className={s.bay}>
            <div className={s.plate}>
              <div className={s.top}>
                <span className={s.stencil}>{p.id}</span>
                <span className={s.led} data-led={p.led} />
              </div>
              <div className={s.lcd}>
                <div className={s.row}>
                  <span className={s.seg}>
                    <span className={s.ghost}>888.8</span>
                    <span className={s.lit}>{p.kwh}</span>
                  </span>
                  <span className={s.unit}>kWh</span>
                </div>
                <div className={s.row}>
                  <span className={s.seg}>
                    <span className={s.ghost}>88.88</span>
                    <span className={s.lit}>{p.eur}</span>
                  </span>
                  <span className={s.unit}>EUR</span>
                </div>
                <div className={s.line} data-kind={p.line.startsWith("CAPTURED") ? "captured" : p.line.startsWith("HOLD") ? "hold" : "none"}>
                  {p.line}
                </div>
              </div>
            </div>
            <div className={s.cable} data-cut={p.cut ? "true" : "false"}>
              <span />
              {p.cut ? <i /> : null}
              <span />
            </div>
          </div>
        ))}
        <div className={s.rail}>
          CSMS <em>OCPP 1.6J</em>
        </div>
      </div>
    </div>
  );
}
