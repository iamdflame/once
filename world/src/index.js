// Entry point: `node world/src/index.js` (or the bundle, `node world/dist/world.cjs`).
// Environment: PORT (8080), HOST (0.0.0.0), SIM_SPEED (300), TARIFF_CENTS_PER_KWH (60),
// STATE_DIR (unset: keep the last agent run in memory only).
import { startWorld } from './live.js';

const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

startWorld({
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  speed: num(process.env.SIM_SPEED, 300),
  tariffCentsPerKwh: num(process.env.TARIFF_CENTS_PER_KWH, 60),
  stateDir: process.env.STATE_DIR || null,
  log: (line) => console.log(line),
}).then((world) => {
  let closing = false;
  const stop = async (sig) => {
    if (closing) return;
    closing = true;
    console.log(`once-world: ${sig}, shutting down`);
    await world.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}, (err) => {
  console.error(`once-world failed to start: ${err && err.message}`);
  process.exit(1);
});
