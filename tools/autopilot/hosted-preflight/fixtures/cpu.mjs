// Give host inspector time to record container PID/cgroup; no work before this delay.
await new Promise(r=>setTimeout(r,500));
// Bounded 1s wall-time loop, .25 CPU cgroup; inspect actual throttling counter.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const read=()=>Number(readFileSync('/sys/fs/cgroup/cpu.stat','utf8').match(/^nr_throttled (\d+)$/m)?.[1]);
const before=read();const stop=performance.now()+1000;let n=0;while(performance.now()<stop)n++;
const after=read();assert.ok(after>before);writeFileSync('/out/cpu.json',JSON.stringify({before,after,n}));
