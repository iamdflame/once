// Live transport: each charger is an ocpp-rpc client (OCPP 1.6J over WebSocket, strict
// schema validation) that reaches the CSMS only through its own TCP link proxy.
// Cutting the proxy destroys the charger's sockets and refuses new ones until restored,
// which is what a pulled cable or a dead modem looks like to both ends.

import net from 'node:net';
import ocpp from 'ocpp-rpc';

const { RPCClient } = ocpp;

export class LinkProxy {
  constructor({ id, upstreamHost = '127.0.0.1', upstreamPort, onChange = () => {} }) {
    this.id = id;
    this.upstreamHost = upstreamHost;
    this.upstreamPort = upstreamPort;
    this.cut = false;
    this.pairs = new Set();
    this.onChange = onChange;
    this.refused = 0;
    this.server = net.createServer((client) => this._accept(client));
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  _accept(client) {
    if (this.cut) {
      this.refused++;
      client.destroy();
      return;
    }
    const upstream = net.connect(this.upstreamPort, this.upstreamHost);
    const pair = { client, upstream };
    this.pairs.add(pair);
    const end = () => {
      if (!this.pairs.has(pair)) return;
      this.pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
    client.pipe(upstream);
    upstream.pipe(client);
  }

  setCut(on) {
    this.cut = !!on;
    if (this.cut) {
      for (const { client, upstream } of [...this.pairs]) {
        client.destroy();
        upstream.destroy();
      }
      this.pairs.clear();
    }
    this.onChange(this.cut);
  }

  close() {
    this.setCut(true);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// Transport for the firmware: open() makes a fresh ocpp-rpc client through the proxy.
// Reconnection is the firmware's job (reconnect: false here), so a reboot or a cut
// behaves exactly like the firmware decides.
export class LiveTransport {
  constructor({ proxies, path = '/ocpp', onViolation = () => {} }) {
    this.proxies = proxies; // Map id -> LinkProxy
    this.path = path;
    this.onViolation = onViolation;
  }

  async open(id) {
    const proxy = this.proxies.get(id);
    const cli = new RPCClient({
      endpoint: `ws://127.0.0.1:${proxy.port}${this.path}`,
      identity: id,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
      callTimeoutMs: 8000,
      pingIntervalMs: 5000,
    });
    cli.on('strictValidationFailure', (f) => this.onViolation({ charger: id, ...summarize(f) }));
    cli.on('error', () => {});
    cli.on('socketError', () => {});
    await cli.connect();
    return new LiveConn(cli);
  }
}

function summarize(f) {
  return { kind: f.outbound ? 'outbound' : 'inbound', action: f.method, error: f.error ? f.error.message : String(f) };
}

class LiveConn {
  constructor(cli) {
    this.cli = cli;
    this.closed = false;
    this.cbs = [];
    const fire = () => {
      if (this.closed) return;
      this.closed = true;
      for (const cb of this.cbs) cb();
    };
    cli.on('disconnect', fire);
    cli.on('close', fire);
  }

  onClose(cb) { this.cbs.push(cb); }

  call(action, payload) { return this.cli.call(action, payload); }

  close() { this.cli.close({ force: true, awaitPending: false }).catch(() => {}); }
}
