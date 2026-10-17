// The central system (CSMS): the OCPP 1.6J server side. It answers the seven
// charge-point-initiated messages a public AC charger sends during a session and
// reports every accepted call to the world as an `ocpp` event (which is what the
// settlement program sees). It is transport-agnostic: the live world calls it from
// ocpp-rpc handlers, the scenario runner from the virtual network.

export const HANDLED_ACTIONS = [
  'BootNotification',
  'Heartbeat',
  'StatusNotification',
  'Authorize',
  'StartTransaction',
  'MeterValues',
  'StopTransaction',
];

export class CsmsError extends Error {
  constructor(rpcErrorCode, message) {
    super(message);
    this.rpcErrorCode = rpcErrorCode;
  }
}

const iso = (ms) => new Date(ms).toISOString();

export class Csms {
  constructor({ clock, emit, heartbeatIntervalS = 300, firstTransactionId = 1001 }) {
    this.clock = clock;
    this.emit = emit;
    this.heartbeatIntervalS = heartbeatIntervalS;
    this.nextTransactionId = firstTransactionId;
    // A charger that resends a StartTransaction whose answer it never got must get the
    // same transactionId back; real CSMSs dedupe Starts on their content.
    this.startKeys = new Map();
    this.sessions = new Map(); // charger -> { connected, since, boots }
  }

  connected(charger) {
    const s = this._session(charger);
    s.connected = true;
    s.since = this.clock.now();
    this.emit({ type: 'link', charger, state: 'connected' });
  }

  disconnected(charger) {
    const s = this._session(charger);
    if (!s.connected) return;
    s.connected = false;
    s.since = this.clock.now();
    this.emit({ type: 'link', charger, state: 'disconnected' });
  }

  handle(charger, action, payload) {
    const now = iso(this.clock.now());
    let response;
    switch (action) {
      case 'BootNotification':
        this._session(charger).boots++;
        response = { status: 'Accepted', currentTime: now, interval: this.heartbeatIntervalS };
        break;
      case 'Heartbeat':
        response = { currentTime: now };
        break;
      case 'StatusNotification':
        response = {};
        break;
      case 'Authorize':
        response = { idTagInfo: { status: 'Accepted' } };
        break;
      case 'StartTransaction': {
        const key = [charger, payload.connectorId, payload.idTag, payload.meterStart, payload.timestamp].join('|');
        let id = this.startKeys.get(key);
        if (id == null) {
          id = this.nextTransactionId++;
          this.startKeys.set(key, id);
        }
        response = { transactionId: id, idTagInfo: { status: 'Accepted' } };
        break;
      }
      case 'MeterValues':
        response = {};
        break;
      case 'StopTransaction':
        response = { idTagInfo: { status: 'Accepted' } };
        break;
      default:
        throw new CsmsError('NotImplemented', `${action} is not handled by this CSMS`);
    }
    this.emit({ type: 'ocpp', charger, action, payload, response });
    return response;
  }

  _session(charger) {
    let s = this.sessions.get(charger);
    if (!s) {
      s = { connected: false, since: null, boots: 0 };
      this.sessions.set(charger, s);
    }
    return s;
  }
}
