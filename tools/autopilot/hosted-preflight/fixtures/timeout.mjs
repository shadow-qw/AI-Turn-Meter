// Give host inspector time to record container PID/cgroup; no work before this delay.
await new Promise(r=>setTimeout(r,500));
// One child only, own 8s hard lifetime; runtime must kill before it writes.
import {spawn} from 'node:child_process';
spawn('/usr/local/bin/node',['-e',`setTimeout(()=>{require('node:fs').writeFileSync('/out/late-write','FAIL')},6500);setTimeout(()=>process.exit(),8000)`],{stdio:'ignore'});
setTimeout(()=>{},8000);
