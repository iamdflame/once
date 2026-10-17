// settle.js v1 (naive): capture on every StopTransaction.
//
// This is the code most CSMS payment modules start with: when a StopTransaction
// arrives, bill meterStop - meterStart for that transactionId against the charger's
// latest hold. It is wrong in exactly the ways real chargers expose:
//   - a StopTransaction delivered twice (dup_stop, lost acknowledgements) captures twice;
//   - a reboot that splits one plug-in into two transactions captures twice;
//   - a Stop for a never-seen Start bills from meter 0 (the lifetime register);
//   - a Stop that arrives after the next driver paid lands on the wrong hold.

export function createSettler({ tariffCentsPerKwh }) {
  const holdByCharger = new Map(); // charger -> latest hold event
  const meterStart = new Map(); // transactionId -> meterStart
  const out = [];

  return {
    onEvent(evt) {
      if (evt.type === 'hold') {
        holdByCharger.set(evt.charger, evt);
        return;
      }
      if (evt.type !== 'ocpp') return;

      if (evt.action === 'StartTransaction') {
        meterStart.set(evt.response.transactionId, evt.payload.meterStart);
        return;
      }

      if (evt.action === 'StopTransaction') {
        const hold = holdByCharger.get(evt.charger);
        if (!hold) return;
        const txId = evt.payload.transactionId;
        const wh = evt.payload.meterStop - (meterStart.get(txId) ?? 0);
        const cents = Math.max(0, Math.min(hold.amount_cents, Math.round((wh * tariffCentsPerKwh) / 1000)));
        out.push({
          intent_id: `stop-${evt.seq}`,
          episode_id: `tx-${txId}`,
          charger: evt.charger,
          payment_intent: hold.payment_intent,
          amount_cents: cents,
        });
      }
    },

    intents() {
      return out;
    },
  };
}
