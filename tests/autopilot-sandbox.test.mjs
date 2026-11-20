import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxArgs, inspectSandbox, runSandbox } from '../tools/autopilot/sandbox.mjs';
import { policy } from '../tools/autopilot/policy.mjs';
const spec={imageDigest:policy.sandbox.image,sourceDir:'/tmp/atm-candidate-Fixture1/source',outDir:'/tmp/atm-candidate-Fixture1/out',commandId:'unit'};
test('planned sandbox argv is fixed, rootless-oriented, credential-free and offline',()=>{
 const a=sandboxArgs(spec);
 for(const required of ['--network=none','--cap-drop=ALL','--read-only','--security-opt=no-new-privileges','--pids-limit=128','--memory=2g','--memory-swap=2g','--cpus=2','--user=65534:65534','--unsetenv-all','--pull=never','--pid=private','--ipc=private','--cgroupns=private'])assert.ok(a.includes(required),required);
 assert.ok(!a.some(v=>/docker.sock|\/home\/box|host:|unconfined|privileged/.test(v)));
 assert.ok(a.includes('type=bind,src=/tmp/atm-candidate-Fixture1/source,dst=/src,ro=true'));
 assert.ok(sandboxArgs({...spec,commandId:'package-check'}).includes('--network=none'));
});
test('issue command/env/image/mounts and path escapes cannot enter argv',()=>{
 for(const extra of [{commandId:'curl evil'},{env:{GH_TOKEN:'fake'}},{imageDigest:'sha256:'+'a'.repeat(64)},{sourceDir:'/home/box'},{outDir:'/tmp/other/out'},{sourceDir:'/tmp/atm-candidate-x/source/../../secret'},{mounts:['/var/run/docker.sock']}])assert.throws(()=>sandboxArgs({...spec,...extra}));
});
test('synthetic inspect-shaped assertions never stand in for real runtime acceptance',()=>{
 for(const evidence of [undefined,{}, {rootless:true,network:'none',canariesPassed:true}, {approved:true,policyRevision:'a'.repeat(64)}])assert.throws(()=>inspectSandbox(evidence),/SANDBOX_UNAVAILABLE/);
});
test('production runner rejects before spawn, even with fake canary success and spawn injection',async()=>{
 let spawned=false;
 await assert.rejects(runSandbox(spec,{spawn:()=>{spawned=true;},clock:()=>0,accepted:true}),/SANDBOX_UNAVAILABLE/);
 assert.equal(spawned,false);
});
