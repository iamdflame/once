// The single-file bundle starts from an empty directory with plain node (no
// node_modules next to it), serves the API and runs the suite. Skipped until
// `npm run bundle` has produced dist/world.cjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bundle = fileURLToPath(new URL('../dist/world.cjs', import.meta.url));

test('dist/world.cjs runs alone with plain node', { skip: !fs.existsSync(bundle) && 'run npm run bundle first', timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'once-world-'));
  const copy = path.join(dir, 'world.cjs');
  fs.copyFileSync(bundle, copy);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [copy], { cwd: dir, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const base = `http://127.0.0.1:${port}`;
    let health = null;
    for (let i = 0; i < 100 && !(health && health.online === 12); i++) {
      await new Promise((r) => setTimeout(r, 100));
      health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
    }
    assert.ok(health, `bundle did not start: ${out}`);
    assert.equal(health.online, 12);
    const settle = await fetch(`${base}/settle`).then((r) => r.json());
    assert.equal(settle.name, 'v1-naive.js');
    const suite = await fetch(`${base}/suite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 30 }) }).then((r) => r.json());
    assert.equal(suite.totals.scenarios, 30);
    assert.ok(suite.totals.double > 0, 'v1 shows doubles in the bundle too');
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows may hold the dir briefly */ }
  }
});
