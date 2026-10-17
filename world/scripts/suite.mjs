// Run the seeded fault suite against a settle.js file, offline, with no world server.
//   node scripts/suite.mjs [settlers/v1-naive.js] [--count 30] [--seed 1] [--seeds 3,7] [--json] [--trace SEED]
import fs from 'node:fs';
import path from 'node:path';
import { runSuite, runScenario } from '../src/runner.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--json'].includes(args[i - 1]))) || 'settlers/v1-naive.js';
const source = fs.readFileSync(path.resolve(file), 'utf8');

if (opt('trace')) {
  const rep = await runScenario(Number(opt('trace')), source, { trace: true });
  console.log(JSON.stringify(rep, null, 2));
  process.exit(0);
}

const seeds = opt('seeds') ? opt('seeds').split(',').map(Number) : null;
const report = await runSuite({ source, count: Number(opt('count', 30)), seed: Number(opt('seed', 1)), seeds });
if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const s of report.scenarios) {
    console.log(`${s.ok ? 'ok  ' : 'FAIL'} seed ${String(s.seed).padStart(3)} ${s.name.padEnd(22)} double ${s.double} stranded ${s.stranded} unbilled ${s.unbilled} overbilled ${s.overbilled} underbilled ${s.underbilled} invalid ${s.invalid}  [${s.faults.join(', ')}]${s.error ? `  ERROR ${s.error}` : ''}`);
    if (!s.ok && args.includes('--notes')) for (const n of s.notes) console.log(`       ${n}`);
  }
  console.log(`\n${path.basename(file)}: ${report.summary} (${report.ms} ms)`);
}
