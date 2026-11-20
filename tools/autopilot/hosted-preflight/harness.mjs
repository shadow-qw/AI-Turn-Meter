// Trusted start barrier: inspector records the live cgroup before bounded fixtures run.
import {existsSync} from 'node:fs';
const [fixture,mode,fakeSecret]=process.argv.slice(2);
if(!['baseline','cpu','pids','memory','timeout'].includes(mode)||fixture!==`/src/${mode}.mjs`)throw Error('FIXTURE_REJECTED');
const deadline=Date.now()+10000;
while(!existsSync(`/out/go-${mode}`)){
 if(Date.now()>deadline)throw Error('START_BARRIER_TIMEOUT');
 await new Promise(r=>setTimeout(r,25));
}
process.argv=[process.argv[0],fixture,fakeSecret];
await import(fixture);
