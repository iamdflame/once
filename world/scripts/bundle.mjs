// npm run bundle -> dist/world.cjs: one file, every dependency inlined, runnable with
// plain `node dist/world.cjs` (no npm install, no network). The settlers/v1-naive.js
// text is inlined; the reference ledger is not.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const inlineSettlers = {
  name: 'inline-settlers',
  setup(b) {
    b.onLoad({ filter: /builtin-settlers\.js$/ }, () => {
      const v1 = fs.readFileSync(path.join(root, 'settlers', 'v1-naive.js'), 'utf8');
      return {
        contents: `export const V1_NAIVE_NAME = 'v1-naive.js';\nexport const V1_NAIVE_SOURCE = ${JSON.stringify(v1)};\n`,
        loader: 'js',
      };
    });
  },
};

const out = path.join(root, 'dist', 'world.cjs');
const result = await build({
  entryPoints: [path.join(root, 'src', 'index.js')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // ws tries these optional native add-ons inside try/catch; leave them out.
  external: ['bufferutil', 'utf-8-validate'],
  plugins: [inlineSettlers],
  legalComments: 'none',
  banner: { js: '// once-world bundle: OCPP 1.6J CSMS + simulated charger fleet + settlement sandbox. Run: node world.cjs' },
  logLevel: 'warning',
  metafile: true,
});
const bytes = fs.statSync(out).size;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(`dist/world.cjs: ${(bytes / 1024).toFixed(0)} KB from ${inputs} inputs`);
