// Give host inspector time to record container PID/cgroup; no work before this delay.
await new Promise(r=>setTimeout(r,500));
// At most 12 children x 8 Node threads, 5s lifetime. No fork recursion.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const before=readFileSync('/sys/fs/cgroup/pids.events','utf8'); const children=[];
try {
 for(let i=0;i<12;i++){ const c=spawn('/usr/local/bin/node',['-e','setTimeout(()=>{},5000)'],{stdio:'ignore'}); c.on('error',()=>{}); children.push(c); await new Promise(r=>setTimeout(r,50)); }
 const after=readFileSync('/sys/fs/cgroup/pids.events','utf8');
 const count=s=>Number(s.match(/^max (\d+)$/m)?.[1]);assert.ok(count(after)>count(before));
 writeFileSync('/out/pids.json',JSON.stringify({before,after}));
} finally {for(const c of children) c.kill('SIGKILL');}
