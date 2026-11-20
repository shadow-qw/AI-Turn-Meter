import { parentPort, workerData } from 'node:worker_threads';
import { openState } from '../../../tools/autopilot/state.mjs';
const state=openState(workerData.path);
parentPort.postMessage('ready');
Atomics.wait(new Int32Array(workerData.barrier),0,0);
try { parentPort.postMessage(workerData.operation==='enqueue' ? {enqueued:state.enqueue(workerData.snapshot,2000)} : {lease:state.claim(workerData.owner,2000)}); }
catch(error) { parentPort.postMessage({error:error.message}); }
finally { state.close(); }
