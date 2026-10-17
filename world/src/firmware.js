// A simulated public AC charger (one connector) speaking OCPP 1.6J as a client,
// with switchable firmware quirks taken from vendor documentation and field reports:
//
//   queue_offline          transaction messages (Start, MeterValues, Stop) are kept in a
//                          persistent queue while the link is down and resent in order
//                          on reconnect. Off: they are dropped while offline.
//   dup_stop               a StopTransaction that was queued while offline is delivered
//                          twice on reconnect, about 1.2 s apart.
//   reboot_restart         a reboot during a session ends the transaction (reason Reboot
//                          or PowerLoss) and starts a new one for the same plug-in.
//   stop_without_start     the firmware loses the StartTransaction; MeterValues and the
//                          StopTransaction carry a locally generated transactionId the
//                          CSMS never issued.
//   meter_reset_on_reboot  the energy register restarts at 0 after a reboot. A resumed
//                          transaction then reports Interruption.Begin / Interruption.End
//                          readings so the energy is still recoverable.
//
// The firmware is clock- and transport-agnostic, so the same code runs live (ocpp-rpc
// over WebSocket through a cuttable TCP proxy, real timers) and in the scenario runner
// (virtual network, discrete-event clock).

export const QUIRK_NAMES = ['queue_offline', 'dup_stop', 'reboot_restart', 'stop_without_start', 'meter_reset_on_reboot'];

export const DEFAULT_QUIRKS = Object.freeze({
  queue_offline: true,
  dup_stop: false,
  reboot_restart: false,
  stop_without_start: false,
  meter_reset_on_reboot: false,
});

// Timer units are the clock's: real ms live, virtual ms in the runner.
export const LIVE_TIMING = Object.freeze({
  sampleEvery: 2000, // MeterValues every 2 s real (10 world minutes at 300x)
  heartbeatEvery: 30000,
  reconnectEvery: 1000,
  rebootDowntime: 3000,
  dupDelay: 1200,
  retryEvery: 2000,
});

export const SIM_TIMING = Object.freeze({
  sampleEvery: 300000, // MeterValueSampleInterval = 300 s
  heartbeatEvery: 900000,
  reconnectEvery: 5000,
  rebootDowntime: 45000,
  dupDelay: 1200,
  retryEvery: 5000,
});

const REG = 'Energy.Active.Import.Register';
const iso = (ms) => new Date(ms).toISOString();

export class Firmware {
  constructor({ id, index = 0, clock, transport, timing = LIVE_TIMING, quirks = {}, meterWh = 0, skewMs = 0, rebootReason = 'Reboot', onLog = () => {} }) {
    this.id = id;
    this.clock = clock;
    this.transport = transport;
    this.timing = timing;
    this.quirks = { ...DEFAULT_QUIRKS, ...quirks };
    this.skewMs = skewMs;
    this.rebootReason = rebootReason;
    this.onLog = onLog;

    this.power = true;
    this.conn = null;
    this.connecting = false;
    this.booted = false;
    this.online = false;

    this.status = 'Available';
    this.plugged = false;
    this.car = null; // { idTag, powerKw }
    this.tx = null;
    this.pendingRestart = false;
    this.episode = null; // opaque truth record owned by the world: { energy_wh, transactions: [] }

    this.regWh = Math.floor(meterWh);
    this.fracWh = 0;
    this.lastAccrue = clock.now();

    this.queue = [];
    this.pumping = false;
    this.lock = Promise.resolve();
    this.msgN = 0;
    this.localTxBase = 7000000 + index * 10000;
    this.nextLocalTx = 1;

    this.timers = { sample: null, heartbeat: null, reconnect: null, boot: null, retry: null };
    this.stats = { calls: 0, queued: 0, dropped: 0, duplicates: 0, reboots: 0, transactions: 0 };
    this.stopped = false;
  }

  // ---------- lifecycle ----------

  start() { this.connect(); }

  shutdown() {
    this.stopped = true;
    for (const k of Object.keys(this.timers)) { this.clock.cancel(this.timers[k]); this.timers[k] = null; }
    const c = this.conn;
    this.conn = null;
    this.online = false;
    if (c) c.close();
  }

  log(kind, detail = {}) { this.onLog(kind, detail); }

  ts(ms = this.clock.now()) { return iso(ms + this.skewMs); }

  setQuirk(name, on) {
    if (!QUIRK_NAMES.includes(name)) throw new Error(`unknown quirk "${name}" (known: ${QUIRK_NAMES.join(', ')})`);
    this.quirks[name] = !!on;
    this.log('quirk', { quirk: name, on: !!on });
  }

  setSkew(ms) {
    this.skewMs = Math.round(ms);
    this.log('skew', { skew_s: Math.round(ms / 1000) });
  }

  // ---------- physics ----------

  accrue() {
    const now = this.clock.now();
    if (this.power && this.tx && !this.tx.suspended && this.plugged && this.car) {
      const dt = Math.max(0, now - this.lastAccrue);
      this.fracWh += (this.car.powerKw * dt) / 3600; // kW * ms / 3600 = Wh
      const whole = Math.floor(this.fracWh);
      if (whole > 0) {
        this.fracWh -= whole;
        this.regWh += whole;
        this.tx.energyWh += whole;
        if (this.episode) this.episode.energy_wh += whole;
      }
    }
    this.lastAccrue = now;
  }

  reading() { this.accrue(); return this.regWh; }

  // ---------- link ----------

  async connect() {
    if (this.stopped || !this.power || this.conn || this.connecting) return;
    this.connecting = true;
    let conn;
    try {
      conn = await this.transport.open(this.id);
    } catch (e) {
      this.connecting = false;
      this._scheduleReconnect();
      return;
    }
    this.connecting = false;
    if (this.stopped || !this.power) { conn.close(); return; }
    this.conn = conn;
    conn.onClose(() => this._onClose(conn));
    try {
      if (!this.booted) {
        const r = await this.call('BootNotification', {
          chargePointVendor: 'Once Lab',
          chargePointModel: 'AC22-Q',
          chargePointSerialNumber: `SN-${this.id}`,
          firmwareVersion: '4.2.1-quirks',
        }, { handshake: true });
        if (r.status !== 'Accepted') { conn.close(); return; }
        this.booted = true;
      }
      if (this.conn !== conn) return;
      this.online = true;
      this.log('online');
      this._startHeartbeat();
      // OCPP 1.6: after (re)connecting, report the connector's *current* status, then
      // drain the transaction queue. So an Available sent now can precede the queued
      // StopTransaction of a session that ended while offline.
      await this.sendStatus();
      this.pump();
    } catch (e) {
      // the link dropped during the handshake; _onClose schedules the reconnect
    }
  }

  _onClose(conn) {
    if (this.conn !== conn) return;
    this.conn = null;
    const was = this.online;
    this.online = false;
    this.clock.cancel(this.timers.heartbeat);
    this.timers.heartbeat = null;
    if (was) this.log('offline');
    if (this.power) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped || this.timers.reconnect) return;
    this.timers.reconnect = this.clock.after(this.timing.reconnectEvery, () => {
      this.timers.reconnect = null;
      this.connect();
    });
  }

  _startHeartbeat() {
    this.clock.cancel(this.timers.heartbeat);
    this.timers.heartbeat = this.clock.every(this.timing.heartbeatEvery, () => {
      if (this.online) this.call('Heartbeat', {}).catch(() => {});
    });
  }

  // One outstanding CALL at a time, as OCPP-J requires.
  call(action, payload, { handshake = false } = {}) {
    const run = async () => {
      const conn = this.conn;
      if (!conn || (!this.online && !handshake)) {
        const e = new Error('offline');
        e.offline = true;
        throw e;
      }
      this.stats.calls++;
      return conn.call(action, payload);
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => {});
    return p;
  }

  setStatus(status) {
    this.status = status;
    if (this.online) this.sendStatus().catch(() => {});
  }

  sendStatus() {
    return this.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: this.status, timestamp: this.ts() });
  }

  // ---------- transaction queue ----------

  enqueue(action, payload, { tx = null, force = false } = {}) {
    if (!this.online && !this.quirks.queue_offline && !force) {
      this.stats.dropped++;
      this.log('dropped', { ocpp_action: action, why: 'offline and queue_offline is off' });
      return;
    }
    const m = { n: ++this.msgN, action, payload, tx, force, offline: !this.online };
    this.queue.push(m);
    this.stats.queued++;
    if (m.offline) this.log('queued', { ocpp_action: action, queue: this.queue.length });
    this.pump();
  }

  materialize(m) {
    const p = { ...m.payload };
    if (m.tx && 'transactionId' in p) p.transactionId = m.tx.transactionId ?? m.tx.localId;
    return p;
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.online && this.queue.length) {
        const m = this.queue[0];
        const payload = this.materialize(m);
        let resp;
        try {
          resp = await this.call(m.action, payload);
        } catch (e) {
          if (e && e.rpcErrorCode) {
            // the CSMS answered with a CALLERROR: the message will never be accepted
            this.queue.shift();
            this.log('rejected', { ocpp_action: m.action, error: `${e.rpcErrorCode}: ${e.message}` });
            continue;
          }
          m.offline = true; // it will go out on a later connection, if it is kept
          if (!this.quirks.queue_offline && !m.force) {
            this.queue.shift();
            this.stats.dropped++;
            this.log('dropped', { ocpp_action: m.action, why: 'link lost in flight and queue_offline is off' });
          }
          if (this.online) {
            this.clock.cancel(this.timers.retry);
            this.timers.retry = this.clock.after(this.timing.retryEvery, () => { this.timers.retry = null; this.pump(); });
          }
          break;
        }
        this.queue.shift();
        if (m.action === 'StartTransaction' && m.tx) m.tx.transactionId = resp.transactionId;
        if (m.action === 'StopTransaction' && m.offline && this.quirks.dup_stop) {
          this.clock.after(this.timing.dupDelay, () => this._duplicate(m.action, payload));
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  _duplicate(action, payload) {
    if (!this.online) return;
    this.stats.duplicates++;
    this.log('duplicate', { ocpp_action: action, transactionId: payload.transactionId });
    this.call(action, payload).catch(() => {});
  }

  // ---------- the session ----------

  plug({ idTag, powerKw }, episode = null) {
    if (this.plugged) throw new Error(`${this.id} is already plugged in`);
    this.accrue();
    this.plugged = true;
    this.car = { idTag, powerKw };
    this.episode = episode;
    this.log('plug', { idTag, power_kw: powerKw });
    if (!this.power) { this.status = 'Preparing'; return; }
    this.setStatus('Preparing');
    this._authorizeAndStart();
  }

  async _authorizeAndStart() {
    const car = this.car;
    if (this.online) {
      try {
        const r = await this.call('Authorize', { idTag: car.idTag });
        if (r.idTagInfo && r.idTagInfo.status !== 'Accepted') { this.log('auth-rejected', { idTag: car.idTag }); return; }
      } catch (e) {
        // link dropped: authorize locally (AllowOfflineTxForUnknownId)
      }
    }
    if (this.car !== car || !this.plugged || !this.power || this.tx) return;
    this.startTransaction();
  }

  startTransaction() {
    this.accrue();
    const now = this.clock.now();
    const tx = {
      localId: this.localTxBase + this.nextLocalTx++,
      transactionId: null,
      idTag: this.car.idTag,
      meterStart: this.regWh,
      startedAt: now,
      energyWh: 0,
      startLost: !!this.quirks.stop_without_start,
      suspended: false,
      interruptions: [],
    };
    this.tx = tx;
    this.stats.transactions++;
    if (this.episode) this.episode.transactions.push(tx);
    if (tx.startLost) {
      this.log('start-lost', { localId: tx.localId });
    } else {
      this.enqueue('StartTransaction', { connectorId: 1, idTag: tx.idTag, meterStart: tx.meterStart, timestamp: this.ts(now) }, { tx });
    }
    this.setStatus('Charging');
    this._startSampling();
  }

  _startSampling() {
    this.clock.cancel(this.timers.sample);
    this.timers.sample = this.clock.every(this.timing.sampleEvery, () => {
      if (!this.tx || !this.power || this.tx.suspended) return;
      const r = this.reading();
      this.enqueue('MeterValues', { connectorId: 1, transactionId: null, meterValue: [this._mv(r, 'Sample.Periodic')] }, { tx: this.tx });
    });
  }

  _mv(value, context, ms = this.clock.now(), withPower = true) {
    const sampledValue = [{ value: String(value), context, format: 'Raw', measurand: REG, location: 'Outlet', unit: 'Wh' }];
    if (withPower) {
      sampledValue.push({ value: String(this.car && this.power ? Math.round(this.car.powerKw * 1000) : 0), context, format: 'Raw', measurand: 'Power.Active.Import', location: 'Outlet', unit: 'W' });
    }
    return { timestamp: this.ts(ms), sampledValue };
  }

  stopTransaction(reason, { force = false } = {}) {
    const tx = this.tx;
    if (!tx) return;
    this.accrue();
    const now = this.clock.now();
    const meterStop = this.regWh;
    const transactionData = [
      { timestamp: this.ts(tx.startedAt), sampledValue: [{ value: String(tx.meterStart), context: 'Transaction.Begin', format: 'Raw', measurand: REG, location: 'Outlet', unit: 'Wh' }] },
      ...tx.interruptions.map((i) => ({ timestamp: this.ts(i.at), sampledValue: [{ value: String(i.value), context: i.context, format: 'Raw', measurand: REG, location: 'Outlet', unit: 'Wh' }] })),
      { timestamp: this.ts(now), sampledValue: [{ value: String(meterStop), context: 'Transaction.End', format: 'Raw', measurand: REG, location: 'Outlet', unit: 'Wh' }] },
    ];
    this.enqueue('StopTransaction', { transactionId: null, idTag: tx.idTag, meterStop, timestamp: this.ts(now), reason, transactionData }, { tx, force });
    tx.stoppedAt = now;
    tx.meterStop = meterStop;
    tx.reason = reason;
    this.tx = null;
    this.clock.cancel(this.timers.sample);
    this.timers.sample = null;
  }

  unplug() {
    if (!this.plugged) throw new Error(`${this.id} is not plugged in`);
    this.accrue();
    if (this.tx && this.power) this.stopTransaction('EVDisconnected');
    this.plugged = false;
    this.car = null;
    const ep = this.episode;
    this.episode = null;
    this.log('unplug', {});
    if (this.power) {
      this.setStatus('Finishing');
      this.setStatus('Available');
    } else {
      this.status = 'Available';
    }
    return ep;
  }

  reboot() {
    if (!this.power) return false;
    this.accrue();
    this.stats.reboots++;
    const tx = this.tx;
    if (tx) {
      if (this.quirks.reboot_restart && this.plugged) {
        this.stopTransaction(this.rebootReason, { force: true });
        this.pendingRestart = true;
      } else {
        tx.suspended = true;
        this.clock.cancel(this.timers.sample);
        this.timers.sample = null;
        if (this.quirks.meter_reset_on_reboot) {
          const ib = { value: this.regWh, context: 'Interruption.Begin', at: this.clock.now() };
          tx.interruptions.push(ib);
          this.enqueue('MeterValues', { connectorId: 1, transactionId: null, meterValue: [this._mv(ib.value, ib.context, ib.at, false)] }, { tx, force: true });
        }
      }
    }
    this.power = false;
    this.online = false;
    this.booted = false;
    for (const k of ['heartbeat', 'reconnect', 'retry']) { this.clock.cancel(this.timers[k]); this.timers[k] = null; }
    const c = this.conn;
    this.conn = null;
    if (c) c.close();
    this.log('reboot', { restart: !!(tx && this.pendingRestart) });
    this.timers.boot = this.clock.after(this.timing.rebootDowntime, () => { this.timers.boot = null; this.powerOn(); });
    return true;
  }

  powerOn() {
    if (this.stopped) return;
    this.power = true;
    this.lastAccrue = this.clock.now();
    if (this.quirks.meter_reset_on_reboot) {
      this.regWh = 0;
      this.fracWh = 0;
      this.log('meter-reset');
    }
    const tx = this.tx;
    if (tx) {
      // a transaction that survives the reboot
      tx.suspended = false;
      if (this.quirks.meter_reset_on_reboot) {
        const ie = { value: this.regWh, context: 'Interruption.End', at: this.clock.now() };
        tx.interruptions.push(ie);
        this.enqueue('MeterValues', { connectorId: 1, transactionId: null, meterValue: [this._mv(ie.value, ie.context, ie.at, false)] }, { tx, force: true });
      }
      if (!this.plugged) {
        this.stopTransaction('EVDisconnected', { force: true });
      } else {
        this._startSampling();
      }
    } else if (this.pendingRestart) {
      this.pendingRestart = false;
      if (this.plugged) this.startTransaction(); // same plug-in, new OCPP transaction
    } else if (this.plugged) {
      this._authorizeAndStart();
    }
    this.status = this.plugged ? (this.tx ? 'Charging' : 'Preparing') : 'Available';
    this.log('boot');
    this.connect();
  }

  snapshot() {
    this.accrue();
    return {
      id: this.id,
      power: this.power,
      online: this.online,
      status: this.power ? this.status : 'Unavailable',
      plugged: this.plugged,
      car: this.car ? { id_tag: this.car.idTag, power_kw: this.car.powerKw } : null,
      transaction: this.tx ? {
        transaction_id: this.tx.transactionId,
        local_id: this.tx.localId,
        start_lost: this.tx.startLost,
        meter_start: this.tx.meterStart,
        started_at: this.tx.startedAt,
        energy_wh: this.tx.energyWh,
      } : null,
      meter_wh: this.regWh,
      queue_len: this.queue.length,
      queue: this.queue.slice(0, 20).map((m) => m.action),
      quirks: { ...this.quirks },
      clock_skew_s: Math.round(this.skewMs / 1000),
      stats: { ...this.stats },
    };
  }
}
