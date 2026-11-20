import test from 'node:test';
import assert from 'node:assert/strict';
import {argsFor,assertHost,assertInspect,IMAGE} from './contract.mjs';
const root='/tmp/atm-hosted-canary-Ab12cd';
test('fixed image and offline unprivileged contract',()=>{
 const a=argsFor({root,mode:'baseline'});
 for(const s of ['--network=none','--cap-drop=ALL','--read-only','--security-opt=no-new-privileges','--user=65534:65534','--pids-limit=32','--memory=128m','--memory-swap=128m','--cpus=0.25','--cgroupns=private','--pid=private','--pull=never','--unsetenv-all']) assert.ok(a.includes(s),s);
 assert.ok(a.includes(IMAGE)); assert.match(IMAGE,/^docker.io\/library\/node@sha256:[a-f0-9]{64}$/);
 assert.ok(a.includes(`type=bind,src=${root}/src,dst=/src,ro=true`));
 assert.ok(!a.some(x=>/docker.sock|\/home\/box|\/cursor\/stores|privileged|seccomp=unconfined/.test(x)));
});
test('reject arbitrary mode, paths, image override and unknown keys',()=>{
 for(const input of [{root,mode:'curl evil'},{root:'/home/box',mode:'baseline'},{root:root+',dst=/host',mode:'baseline'},{root,mode:'baseline',image:'evil'}]) assert.throws(()=>argsFor(input));
});
const good={uid:1001,pid1:'systemd',cgroup2:true,userBus:true,controllers:['cpu','memory','pids'],rootless:true,cgroupVersion:'v2',cgroupManager:'systemd'};
test('host requires real rootless systemd and all controllers',()=>{
 assert.doesNotThrow(()=>assertHost(good));
 for(const patch of [{uid:0},{pid1:'tini'},{userBus:false},{controllers:['memory','pids']},{rootless:false},{cgroupVersion:'v1'},{cgroupManager:'cgroupfs'}]) assert.throws(()=>assertHost({...good,...patch}),/SANDBOX_UNAVAILABLE/);
});
test('canary resource modes remain bounded',()=>{
 for(const mode of ['memory','pids','cpu','timeout']) assert.ok(argsFor({root,mode}).includes(`/src/${mode}.mjs`));
});

test('inspect rejects silent relaxation and extra host mounts',()=>{
 const good=strict();
 assert.doesNotThrow(()=>assertInspect(good,root));
 for(const h of [{Privileged:true},{ReadonlyRootfs:false},{NetworkMode:'host'},{Memory:0},{PidsLimit:0},{NanoCpus:0},{SecurityOpt:['seccomp=unconfined']}]) assert.throws(()=>assertInspect({...good,HostConfig:{...good.HostConfig,...h}},root));
 assert.throws(()=>assertInspect({...good,Mounts:[...good.Mounts,{Destination:'/host',Source:'/home/runner',RW:true}]},root));
});

const strict=()=>({ImageName:IMAGE,EffectiveCaps:[],BoundingCaps:[],Config:{User:'65534:65534',Env:['HOME=/tmp/home','PATH=/usr/local/bin:/usr/bin:/bin','NODE_OPTIONS=']},HostConfig:{PidMode:'private',IpcMode:'private',CgroupMode:'private',CapAdd:[],Devices:[],Privileged:false,ReadonlyRootfs:true,NetworkMode:'none',CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Memory:134217728,MemorySwap:134217728,PidsLimit:32,NanoCpus:250000000},Mounts:[{Destination:'/src',Source:root+'/src',RW:false},{Destination:'/out',Source:root+'/out',RW:true}]});
test('official Podman quota/period representation is equivalent, conflicts reject',()=>{
 const i=strict();Object.assign(i.HostConfig,{NanoCpus:0,CpuQuota:25000,CpuPeriod:100000});assert.doesNotThrow(()=>assertInspect(i,root));
 for(const patch of [{CpuQuota:100000},{CpuPeriod:0},{NanoCpus:500000000}])assert.throws(()=>assertInspect({...i,HostConfig:{...i.HostConfig,...patch}},root));
});
test('inspect must reject shared namespaces, devices, capability or environment injection',()=>{
 for(const patch of [{PidMode:'host'},{IpcMode:'host'},{CgroupMode:'host'},{Devices:[{PathOnHost:'/dev/sda'}]},{CapAdd:['SYS_ADMIN']}]){const i=strict();Object.assign(i.HostConfig,patch);assert.throws(()=>assertInspect(i,root));}
 for(const patch of [{EffectiveCaps:['CAP_SYS_ADMIN']},{BoundingCaps:['CAP_CHOWN']},{ImageName:'evil'},{Config:{User:'65534:65534',Env:['GITHUB_TOKEN=not-real']}}])assert.throws(()=>assertInspect({...strict(),...patch},root));
});
test('all trusted synthetic entrypoints use a start barrier before bounded fixtures',()=>{
 for(const mode of ['baseline','cpu','memory','pids','timeout']){const a=argsFor({root,mode});assert.ok(a.includes('/src/harness.mjs'));assert.equal(a.at(-2),mode);}
});
