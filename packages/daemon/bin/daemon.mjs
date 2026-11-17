#!/usr/bin/env node
import { createMeterServer } from '../src/server.mjs';

const args = new Set(process.argv.slice(2));
const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.AI_TURN_METER_PORT || 47831);

const meter = createMeterServer({ port });

await meter.start();
console.log(`[ai-turn-meter] daemon listening on http://127.0.0.1:${port}`);

if (args.has('--once')) {
  const state = meter.store.getState(5);
  console.log(JSON.stringify(state, null, 2));
  await meter.stop();
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await meter.stop();
    process.exit(0);
  });
}
