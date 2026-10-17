// The two settlement programs the bench shows as a diff. v1 ships with the
// world; v2 is what the agent writes at demo time. In mock mode these are the
// texts; in live mode the real sources come from the world (`GET /settle`).

export const SETTLE_V1 = `// settle.js — v1 (naive)
// Captures on every StopTransaction, keyed by the OCPP transactionId.
export function createSettler({ tariffCentsPerKwh }) {
  const holds = new Map();      // charger -> { payment_intent, amount_cents }
  const starts = new Map();     // transactionId -> { charger, meterStart }
  const seen = new Set();       // transactionId already captured
  const out = [];

  return {
    onEvent(evt) {
      if (evt.type === "hold") {
        holds.set(evt.charger, evt);
        return;
      }
      if (evt.type !== "ocpp") return;
      const p = evt.payload;
      if (evt.action === "StartTransaction") {
        starts.set(p.transactionId, { charger: evt.charger, meterStart: p.meterStart });
      }
      if (evt.action === "StopTransaction") {
        if (seen.has(p.transactionId)) return;
        seen.add(p.transactionId);
        const start = starts.get(p.transactionId);
        const hold = holds.get(evt.charger);
        if (!start || !hold) return;
        const wh = Math.max(0, p.meterStop - start.meterStart);
        const amount = Math.round((wh / 1000) * tariffCentsPerKwh);
        out.push({
          intent_id: "stop-" + p.transactionId,
          episode_id: "tx-" + p.transactionId,
          charger: evt.charger,
          payment_intent: hold.payment_intent,
          amount_cents: Math.min(amount, hold.amount_cents),
        });
      }
    },
    intents() {
      return out.splice(0);
    },
  };
}
`;

export const SETTLE_V2 = `// settle.js — v2 (episode ledger)
// One capture per plug-in episode, never per OCPP transactionId.
// A reboot that splits the session into two transactions, a Stop that
// arrives twice, or a Stop for a Start we never saw all land in the
// same episode; the episode closes once, when the car is unplugged.
export function createSettler({ tariffCentsPerKwh }) {
  const episodes = new Map();   // charger -> episode
  const seenStops = new Set();  // hash(charger, transactionId, meterStop)
  const out = [];

  function open(charger, hold) {
    episodes.set(charger, {
      id: hold.episode_id,
      payment_intent: hold.payment_intent,
      hold_cents: hold.amount_cents,
      wh: 0,                  // settled energy from closed transactions
      live: null,             // { transactionId, meterStart, lastMeter }
      closed: false,
    });
  }

  function energy(ep) {
    const live = ep.live ? Math.max(0, ep.live.lastMeter - ep.live.meterStart) : 0;
    return ep.wh + live;
  }

  function close(ep, charger) {
    if (ep.closed) return;
    ep.closed = true;
    const amount = Math.round((energy(ep) / 1000) * tariffCentsPerKwh);
    out.push({
      intent_id: "episode-" + ep.id,      // one decision per episode
      episode_id: ep.id,
      charger,
      payment_intent: ep.payment_intent,
      amount_cents: Math.min(amount, ep.hold_cents),
    });
  }

  return {
    onEvent(evt) {
      if (evt.type === "hold") return open(evt.charger, evt);
      if (evt.type !== "ocpp") return;
      const ep = episodes.get(evt.charger);
      if (!ep || ep.closed) return;
      const p = evt.payload;

      if (evt.action === "StartTransaction") {
        // A second Start inside one episode is a reboot split: keep counting.
        if (ep.live) ep.wh += Math.max(0, ep.live.lastMeter - ep.live.meterStart);
        ep.live = { transactionId: p.transactionId, meterStart: p.meterStart, lastMeter: p.meterStart };
      }

      if (evt.action === "MeterValues" && ep.live) {
        const wh = sampleWh(p);
        if (wh != null && wh >= ep.live.lastMeter) ep.live.lastMeter = wh;  // monotone
      }

      if (evt.action === "StopTransaction") {
        const key = evt.charger + ":" + p.transactionId + ":" + p.meterStop;
        if (seenStops.has(key)) return;                      // the duplicate
        seenStops.add(key);
        if (ep.live && ep.live.transactionId === p.transactionId) {
          if (p.meterStop >= ep.live.meterStart) ep.live.lastMeter = p.meterStop;
          ep.wh += Math.max(0, ep.live.lastMeter - ep.live.meterStart);
          ep.live = null;
        }
        // Stop for a Start we never saw: trust MeterValues, not the Stop.
        if (p.reason !== "PowerLoss" && p.reason !== "Reboot") close(ep, evt.charger);
      }

      if (evt.action === "StatusNotification" && p.status === "Available" && !ep.live) {
        close(ep, evt.charger);   // the car is gone: settle whatever we have
      }
    },
    intents() {
      return out.splice(0);
    },
  };
}

function sampleWh(p) {
  const mv = p.meterValue && p.meterValue[0];
  const s = mv && mv.sampledValue && mv.sampledValue.find((v) => !v.measurand || v.measurand === "Energy.Active.Import.Register");
  return s ? Number(s.value) : null;
}
`;
