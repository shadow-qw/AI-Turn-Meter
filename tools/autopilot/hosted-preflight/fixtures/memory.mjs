// Give host inspector time to record container PID/cgroup; no work before this delay.
await new Promise(r=>setTimeout(r,500));
// Hard allocation ceiling 192MiB; only run after 128MiB cgroup baseline verified.
import {writeFileSync} from 'node:fs';
const retained=[];
for(let i=0;i<48;i++){retained.push(Buffer.alloc(4*1024*1024,0x5a));await new Promise(r=>setTimeout(r,5));}
writeFileSync('/out/memory-unexpected-survival','FAIL'); process.exitCode=1;
