// Two clocks with one interface:
//   now()          world time in ms (what OCPP timestamps and the meter physics use)
//   after(ms, fn)  one-shot timer, in the clock's timer units
//   every(ms, fn)  repeating timer
//   cancel(handle)
//
// LiveClock: timers are real milliseconds, but world time runs `speed` times faster
// than the wall clock, so a two-hour charging session plays out in about 24 s at 300x.
// VirtualClock: discrete-event time for the scenario runner. Nothing waits; the
// runner pops the next timer, advances time to it and drains the microtask queue.

export class LiveClock {
  constructor({ speed = 300, epochMs = Date.now() } = {}) {
    this.live = true;
    this.speed = speed;
    this.realStart = Date.now();
    this.epoch = epochMs;
  }
  now() { return Math.round(this.epoch + (Date.now() - this.realStart) * this.speed); }
  after(ms, fn) { const t = setTimeout(fn, Math.max(0, ms)); t.unref?.(); return { t, kind: 'timeout' }; }
  every(ms, fn) { const t = setInterval(fn, ms); t.unref?.(); return { t, kind: 'interval' }; }
  cancel(h) {
    if (!h) return;
    if (h.kind === 'interval') clearInterval(h.t); else clearTimeout(h.t);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

export class VirtualClock {
  constructor(startMs = Date.UTC(2026, 9, 17, 8, 0, 0)) {
    this.live = false;
    this.t = startMs;
    this.heap = [];
    this.n = 0;
  }
  now() { return this.t; }
  after(ms, fn) {
    const ev = { at: this.t + Math.max(0, Math.round(ms)), n: this.n++, fn, dead: false };
    this._push(ev);
    return ev;
  }
  every(ms, fn) {
    const h = { dead: false, ev: null };
    const loop = () => {
      if (h.dead) return;
      fn();
      if (!h.dead) h.ev = this.after(ms, loop);
    };
    h.ev = this.after(ms, loop);
    return h;
  }
  cancel(h) {
    if (!h) return;
    h.dead = true;
    if (h.ev) h.ev.dead = true;
  }
  async runUntil(tEnd) {
    await flush();
    while (this.heap.length && this.heap[0].at <= tEnd) {
      const ev = this._pop();
      if (ev.dead) continue;
      this.t = ev.at;
      ev.fn();
      await flush();
    }
    if (tEnd > this.t) this.t = tEnd;
  }
  _less(a, b) { return a.at < b.at || (a.at === b.at && a.n < b.n); }
  _push(ev) {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this._less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }
  _pop() {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && this._less(h[l], h[m])) m = l;
        if (r < h.length && this._less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}
