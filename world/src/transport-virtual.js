// The scenario runner's network: one virtual link per charger with seeded latency,
// cut / restore, and an "ack lost" fault (the CSMS processed a call but the link
// dropped before its answer arrived, so the charger resends it on reconnect).
// Every call and every answer is validated against the OCPP 1.6J JSON schemas that
// ship with ocpp-rpc, the same schemas the live world enforces in strict mode.

import standardValidators from 'ocpp-rpc/lib/standard-validators.js';

const validator16 = standardValidators.find((v) => v.subprotocol === 'ocpp1.6');

export function validate16(kind, action, params) {
  validator16.validate(`urn:${action}.${kind}`, params);
}

const clone = (x) => JSON.parse(JSON.stringify(x));

export class VirtualNet {
  constructor({ clock, rng, csms, latencyMs = [8, 60], onViolation = () => {} }) {
    this.clock = clock;
    this.rng = rng;
    this.csms = csms;
    this.latencyMs = latencyMs;
    this.onViolation = onViolation;
    this.links = new Map();
  }

  link(id) {
    let l = this.links.get(id);
    if (!l) {
      l = { cut: false, conns: new Set(), dropAck: new Map() };
      this.links.set(id, l);
    }
    return l;
  }

  lat() { return this.rng.int(this.latencyMs[0], this.latencyMs[1]); }

  isCut(id) { return this.link(id).cut; }

  cut(id) {
    const l = this.link(id);
    l.cut = true;
    for (const c of [...l.conns]) c._drop('link cut');
  }

  restore(id) { this.link(id).cut = false; }

  // The next `count` answers to `action` on this link are lost together with the link.
  loseAck(id, action, count = 1) { this.link(id).dropAck.set(action, count); }

  open(id) {
    return new Promise((resolve, reject) => {
      this.clock.after(this.lat(), () => {
        const l = this.link(id);
        if (l.cut) { reject(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })); return; }
        const conn = new VirtualConn(this, id, l);
        l.conns.add(conn);
        this.csms.connected(id);
        resolve(conn);
      });
    });
  }
}

class VirtualConn {
  constructor(net, id, link) {
    this.net = net;
    this.id = id;
    this.link = link;
    this.alive = true;
    this.pending = new Set();
    this.closeCbs = [];
  }

  onClose(cb) { this.closeCbs.push(cb); }

  close() { this._drop('closed by charger'); }

  call(action, payload) {
    return new Promise((resolve, reject) => {
      if (!this.alive) { reject(new Error('socket closed')); return; }
      try {
        validate16('req', action, payload);
      } catch (e) {
        this.net.onViolation({ charger: this.id, action, kind: 'req', error: e.message });
        reject(e);
        return;
      }
      const msg = clone(payload);
      this.pending.add(reject);
      const net = this.net;
      net.clock.after(net.lat(), () => {
        if (!this.alive) return;
        let resp;
        try {
          resp = net.csms.handle(this.id, action, msg);
          validate16('conf', action, resp);
        } catch (e) {
          if (!e.rpcErrorCode) net.onViolation({ charger: this.id, action, kind: 'conf', error: e.message });
          net.clock.after(net.lat(), () => {
            if (!this.alive) return;
            this.pending.delete(reject);
            reject(e.rpcErrorCode ? e : Object.assign(new Error(e.message), { rpcErrorCode: 'InternalError' }));
          });
          return;
        }
        const n = this.link.dropAck.get(action) || 0;
        if (n > 0) {
          this.link.dropAck.set(action, n - 1);
          this._drop('ack lost');
          return;
        }
        const answer = clone(resp);
        net.clock.after(net.lat(), () => {
          if (!this.alive) return;
          this.pending.delete(reject);
          resolve(answer);
        });
      });
    });
  }

  _drop(reason) {
    if (!this.alive) return;
    this.alive = false;
    this.link.conns.delete(this);
    const err = new Error(`socket closed: ${reason}`);
    for (const rej of this.pending) rej(err);
    this.pending.clear();
    this.net.csms.disconnected(this.id);
    for (const cb of this.closeCbs) cb(reason);
  }
}
