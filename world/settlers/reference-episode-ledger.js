// settle.js reference: the episode ledger. FOR TESTS ONLY. It is not bundled into the
// world and is never offered to the agent; the agent writes its own fix at demo time.
//
// The rule: money binds to the plug-in episode, never to an OCPP transactionId.
//   - A hold binds to the next episode on its charger (FIFO), opened by the first
//     transaction activity (Start, MeterValues or Stop) that belongs to no known
//     transaction, whatever transactionId it carries (even one the CSMS never issued).
//   - A StopTransaction whose reason is Reboot / PowerLoss / HardReset / SoftReset does
//     not end the episode: the next transaction on that connector continues it.
//   - Any other StopTransaction ends the episode; so does a connector that is Available
//     with every known transaction stopped and no news for 10 minutes while connected.
//   - Energy per transaction is the sum of its monotone meter segments (a register that
//     restarts at 0 after a reboot starts a new segment), from meterStart or the
//     Transaction.Begin reading, through MeterValues, to meterStop.
//   - Each episode settles exactly once: capture energy x tariff capped at the hold, or
//     release the hold when nothing was delivered. Messages for transactions already
//     stopped are duplicates and are ignored. Charger timestamps are never trusted.

export function createSettler({ tariffCentsPerKwh }) {
  const REBOOT_REASONS = new Set(['Reboot', 'PowerLoss', 'HardReset', 'SoftReset']);
  const GRACE_MS = 10 * 60 * 1000;
  const chargers = new Map(); // id -> { holds: [], ep, connected }
  const txIndex = new Map(); // "charger#transactionId" -> { ep, tx }
  const settled = new Set(); // payment_intent
  const out = [];
  let orphan = 0;

  function charger(id) {
    let c = chargers.get(id);
    if (!c) {
      c = { holds: [], ep: null, connected: true };
      chargers.set(id, c);
    }
    return c;
  }

  function openEpisode(c, id) {
    const hold = c.holds.shift() || null;
    const ep = {
      id: hold ? `ep_${hold.payment_intent}` : `${id}-unpaid-${++orphan}`,
      charger: id,
      hold,
      txs: [],
      closed: false,
      sawAvailable: false,
      graceFrom: null,
    };
    c.ep = ep;
    return ep;
  }

  // The live transaction record for (charger, transactionId), or null for a duplicate.
  function txFor(id, txId) {
    const key = `${id}#${txId}`;
    const known = txIndex.get(key);
    if (known) return known.tx.stopped ? null : known;
    const c = charger(id);
    const ep = c.ep && !c.ep.closed ? c.ep : openEpisode(c, id);
    const tx = { id: txId, begin: null, readings: [], end: null, stopped: false };
    ep.txs.push(tx);
    const rec = { ep, tx };
    txIndex.set(key, rec);
    return rec;
  }

  function wh(sv) {
    const v = Number(sv.value);
    if (!Number.isFinite(v)) return null;
    return sv.unit === 'kWh' ? v * 1000 : v;
  }

  function isEnergy(sv) {
    return !sv.measurand || sv.measurand === 'Energy.Active.Import.Register';
  }

  function txEnergy(tx) {
    const seq = [];
    if (tx.begin != null) seq.push(tx.begin);
    seq.push(...tx.readings);
    if (tx.end != null) seq.push(tx.end);
    let e = 0;
    for (let i = 1; i < seq.length; i++) e += seq[i] >= seq[i - 1] ? seq[i] - seq[i - 1] : seq[i];
    return e;
  }

  function close(ep) {
    if (ep.closed) return;
    ep.closed = true;
    if (!ep.hold || settled.has(ep.hold.payment_intent)) return;
    settled.add(ep.hold.payment_intent);
    const energyWh = ep.txs.reduce((s, tx) => s + txEnergy(tx), 0);
    const cents = Math.max(0, Math.min(ep.hold.amount_cents, Math.round((energyWh * tariffCentsPerKwh) / 1000)));
    out.push({
      intent_id: `settle-${ep.id}`,
      episode_id: ep.id,
      charger: ep.charger,
      payment_intent: ep.hold.payment_intent,
      amount_cents: cents,
    });
  }

  function touch(ep) { ep.graceFrom = null; }

  function checkGrace(at) {
    for (const c of chargers.values()) {
      const ep = c.ep;
      if (!ep || ep.closed) continue;
      const idle = ep.sawAvailable && c.connected && ep.txs.length > 0 && ep.txs.every((t) => t.stopped);
      if (!idle) { ep.graceFrom = null; continue; }
      if (ep.graceFrom == null) ep.graceFrom = at;
      else if (at - ep.graceFrom >= GRACE_MS) close(ep);
    }
  }

  function onOcpp(evt) {
    const p = evt.payload || {};
    switch (evt.action) {
      case 'StartTransaction': {
        const rec = txFor(evt.charger, evt.response && evt.response.transactionId);
        if (!rec) return;
        if (rec.tx.begin == null) rec.tx.begin = p.meterStart;
        touch(rec.ep);
        return;
      }
      case 'MeterValues': {
        if (p.transactionId == null) return;
        const rec = txFor(evt.charger, p.transactionId);
        if (!rec) return;
        for (const mv of p.meterValue || []) {
          for (const sv of mv.sampledValue || []) {
            if (!isEnergy(sv)) continue;
            const v = wh(sv);
            if (v == null) continue;
            if (sv.context === 'Transaction.Begin') { if (rec.tx.begin == null) rec.tx.begin = v; }
            else if (sv.context !== 'Transaction.End') rec.tx.readings.push(v);
          }
        }
        touch(rec.ep);
        return;
      }
      case 'StopTransaction': {
        const rec = txFor(evt.charger, p.transactionId);
        if (!rec) return; // duplicate of a Stop we already processed
        const { ep, tx } = rec;
        const extra = [];
        for (const mv of p.transactionData || []) {
          for (const sv of mv.sampledValue || []) {
            if (!isEnergy(sv)) continue;
            const v = wh(sv);
            if (v == null) continue;
            if (sv.context === 'Transaction.Begin') { if (tx.begin == null) tx.begin = v; }
            else if (sv.context !== 'Transaction.End') extra.push(v);
          }
        }
        if (tx.readings.length === 0) tx.readings.push(...extra);
        tx.end = p.meterStop;
        tx.stopped = true;
        touch(ep);
        if (!REBOOT_REASONS.has(p.reason)) close(ep);
        return;
      }
      case 'StatusNotification': {
        if (!(p.connectorId >= 1)) return;
        const c = charger(evt.charger);
        if (!c.ep || c.ep.closed) return;
        if (p.status === 'Available') c.ep.sawAvailable = true;
        else if (['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE'].includes(p.status)) c.ep.sawAvailable = false;
        return;
      }
      default:
    }
  }

  return {
    onEvent(evt) {
      if (evt.type === 'hold') charger(evt.charger).holds.push(evt);
      else if (evt.type === 'link') {
        const c = charger(evt.charger);
        c.connected = evt.state === 'connected';
      } else if (evt.type === 'ocpp') onOcpp(evt);
      checkGrace(evt.at);
    },
    intents() {
      return out;
    },
  };
}
