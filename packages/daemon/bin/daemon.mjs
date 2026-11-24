#!/usr/bin/env node
import { createMeterServer } from '../src/server.mjs';

const args = new Set(process.argv.slice(2));
const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.AI_TURN_METER_PORT || 47831);

const ts = () => new Date().toISOString();

const meter = createMeterServer({ port });

let fatalHandled = false;
function handleServerError(err) {
  if (fatalHandled) return;
  fatalHandled = true;
  if (err?.code === 'EADDRINUSE') {
    console.error(
      `[${ts()}] [ai-turn-meter] port 127.0.0.1:${port} is already in use (EADDRINUSE); another daemon instance may already be running. Exiting.`
    );
  } else {
    console.error(`[${ts()}] [ai-turn-meter] daemon server error: ${err?.message || err}`);
  }
  try {
    meter.store?.close?.();
  } catch {}
  process.exit(1);
}

meter.server.on('error', handleServerError);

try {
  await meter.start();
} catch (err) {
  handleServerError(err);
}

console.log(`[${ts()}] [ai-turn-meter] daemon listening on http://127.0.0.1:${port} (pid ${process.pid})`);

if (args.has('--once')) {
  const state = meter.store.getState(5);
  console.log(JSON.stringify(state, null, 2));
  await meter.stop();
  console.log(`[${ts()}] [ai-turn-meter] daemon --once complete, stopped cleanly.`);
  process.exit(0);
}

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${ts()}] [ai-turn-meter] received ${sig}, shutting down daemon (pid ${process.pid})...`);
  try {
    await meter.stop();
    console.log(`[${ts()}] [ai-turn-meter] daemon stopped cleanly.`);
    process.exit(0);
  } catch (err) {
    console.error(`[${ts()}] [ai-turn-meter] error during shutdown: ${err?.message || err}`);
    process.exit(1);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    shutdown(sig);
  });
}
