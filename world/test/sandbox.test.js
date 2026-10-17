import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettlerHost, validateSettleSource } from '../src/sandbox.js';
import { PaymentAuthority, MESSAGES } from '../src/authority.js';

const probe = (expr) => {
  const src = `let r; export function createSettler() { try { r = String(${expr}); } catch (e) { r = 'blocked: ' + e.message; } return { onEvent() {}, intents() { return [{ intent_id: 'p', probe: r }]; } }; }`;
  return new SettlerHost(src).poll(0).intents[0].probe;
};

test('settle.js has no process, require, fetch, timers or eval', () => {
  assert.equal(probe('typeof process'), 'undefined');
  assert.equal(probe('typeof require'), 'undefined');
  assert.equal(probe('typeof fetch'), 'undefined');
  assert.equal(probe('typeof setTimeout'), 'undefined');
  assert.match(probe("eval('1+1')"), /blocked/);
  assert.match(probe("({}).constructor.constructor('return process')()"), /blocked/);
  assert.match(probe("globalThis.constructor.constructor('return process')()"), /blocked/);
  assert.match(probe("(function(){}).constructor('return 1')()"), /blocked/);
});

test('settle.js sees world time and seeded randomness', () => {
  const src = 'export function createSettler(){ const o=[]; return { onEvent(e){ o.push({intent_id: String(o.length), t: Date.now(), d: new Date().getTime(), r: Math.random()}); }, intents(){ return o; } }; }';
  const a = new SettlerHost(src, { seed: 7 }).onEvent({ type: 'tick' }, 1234).intents[0];
  assert.equal(a.t, 1234);
  assert.equal(a.d, 1234);
  const b = new SettlerHost(src, { seed: 7 }).onEvent({ type: 'tick' }, 99).intents[0];
  assert.equal(b.r, a.r);
});

test('loader errors are explicit', () => {
  assert.match(validateSettleSource('import fs from "node:fs"; export function createSettler(){}').error, /cannot import/);
  assert.match(validateSettleSource('export function nope() {}').error, /createSettler/);
  assert.match(validateSettleSource('export function createSettler( {').error, /does not parse/);
  assert.match(validateSettleSource('export function createSettler(){ return {}; }').error, /onEvent/);
  assert.match(validateSettleSource('export function createSettler(){ for(;;){} }').error, /timed out/);
  assert.equal(validateSettleSource('module.exports.createSettler = () => ({ onEvent() {}, intents() { return []; } });').ok, true);
  assert.equal(validateSettleSource('export default function createSettler(){ return { onEvent() {}, intents() { return []; } }; }').ok, true);
  assert.equal(validateSettleSource('const createSettler = () => ({ onEvent() {}, intents() { return []; } });\nexport { createSettler };').ok, true);
});

test('a settle.js that hangs on an event is stopped, not the world', () => {
  const h = new SettlerHost('export function createSettler(){ return { onEvent(){ for(;;){} }, intents(){ return []; } }; }', { timeoutMs: 100 });
  const r = h.onEvent({ type: 'tick' }, 0);
  assert.match(r.error, /longer than 100 ms/);
  assert.ok(h.dead);
});

test('intents are diffed by intent_id and immutable once emitted', () => {
  const h = new SettlerHost('export function createSettler(){ const o=[]; return { onEvent(e){ if (e.n === 1) o.push({intent_id:"a", amount_cents: 1}); if (e.n === 2) { o[0].amount_cents = 999; o.push({intent_id:"b", amount_cents: 2}); } }, intents(){ return o; } }; }');
  assert.deepEqual(h.onEvent({ n: 1 }, 0).intents.map((i) => i.intent_id), ['a']);
  assert.deepEqual(h.onEvent({ n: 2 }, 0).intents.map((i) => i.intent_id), ['b']);
});

test('payment authority: one capture per PaymentIntent, remainder released after a partial capture', () => {
  const a = new PaymentAuthority();
  a.authorize('pi_1', 5000);
  const first = a.capture('pi_1', 1140);
  assert.equal(first.ok, true);
  assert.equal(first.stripe_object.amount_received, 1140);
  assert.equal(first.stripe_object.amount_released, 3860);
  const second = a.capture('pi_1', 1140);
  assert.equal(second.ok, false);
  assert.equal(second.error.message, MESSAGES.remainderReleased);
  assert.match(second.error.message, /the remainder of the authorized amount has been released/);
  a.authorize('pi_2', 5000);
  assert.equal(a.capture('pi_2', 5001).ok, false);
  assert.equal(a.capture('pi_2', 5000).ok, true);
  assert.equal(a.capture('pi_2', 1).ok, false);
  a.authorize('pi_3', 5000);
  assert.equal(a.cancel('pi_3').status, 'canceled');
  assert.equal(a.capture('pi_3', 100).ok, false);
  assert.equal(a.capture('pi_missing', 100).error.code, 'resource_missing');
});
