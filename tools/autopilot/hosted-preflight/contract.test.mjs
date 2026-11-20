import test from 'node:test';
import assert from 'node:assert/strict';
import {argsFor,assertHost,assertInspect,IMAGE,verifyThenStart} from './contract.mjs';
import * as contract from './contract.mjs';
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

const strict=()=>({ImageName:IMAGE,EffectiveCaps:[],BoundingCaps:[],Config:{User:'65534:65534',Env:['HOME=/tmp/home','PATH=/usr/local/bin:/usr/bin:/bin','NODE_OPTIONS=']},HostConfig:{PidMode:'private',IpcMode:'private',CgroupMode:'private',CapAdd:[],Devices:[],Privileged:false,ReadonlyRootfs:true,NetworkMode:'none',CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Memory:134217728,MemorySwap:134217728,PidsLimit:32,NanoCpus:250000000},Mounts:[{Type:'bind',Destination:'/src',Source:root+'/src',RW:false},{Type:'bind',Destination:'/out',Source:root+'/out',RW:true},{Type:'bind',Destination:'/etc/resolv.conf',Source:root+'/resolv.conf',RW:false}]});
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

test('pre-start inspect rejects contradictory, unlimited, malformed and incomplete CPU families',()=>{
 const bad=[{NanoCpus:250000000,CpuQuota:-1,CpuPeriod:100000},{NanoCpus:250000000,CpuQuota:'unlimited',CpuPeriod:100000},{NanoCpus:-1,CpuQuota:25000,CpuPeriod:100000},{NanoCpus:500000000.5,CpuQuota:25000,CpuPeriod:100000},{NanoCpus:0,CpuQuota:0,CpuPeriod:0},{NanoCpus:250000000,CpuQuota:0,CpuPeriod:100000},{NanoCpus:250000000,CpuQuota:25000,CpuPeriod:0}];
 for(const field of ['NanoCpus','CpuQuota','CpuPeriod'])for(const value of [-1,.5,'0',null,true,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,undefined])bad.push({...{NanoCpus:250000000,CpuQuota:25000,CpuPeriod:100000},[field]:value});
 for(const cpu of bad){const i=strict();Object.assign(i.HostConfig,cpu);assert.throws(()=>assertInspect(i,root),JSON.stringify(cpu));}
});
test('official inspect zero defaults, nano-only, quota-only and consistent dual limits remain supported',()=>{
 for(const cpu of [{NanoCpus:250000000},{NanoCpus:250000000,CpuQuota:0,CpuPeriod:0},{NanoCpus:0,CpuQuota:25000,CpuPeriod:100000},{NanoCpus:250000000,CpuQuota:25000,CpuPeriod:100000}]){const i=strict();Object.assign(i.HostConfig,cpu);assert.doesNotThrow(()=>assertInspect(i,root));}
 const missing=strict();delete missing.HostConfig.NanoCpus;assert.throws(()=>assertInspect(missing,root));
});

test('actual adapter pre-start helper refuses invalid inspect before invoking start',()=>{
 let starts=0;const bad=strict();Object.assign(bad.HostConfig,{CpuQuota:-1,CpuPeriod:100000});
 assert.throws(()=>verifyThenStart(()=>bad,()=>starts++,root),/SANDBOX_UNAVAILABLE/);assert.equal(starts,0);
 const calls=[];const good=strict();assert.equal(verifyThenStart(()=>{calls.push('inspect');return good;},()=>calls.push('start'),root),good);assert.deepEqual(calls,['inspect','start']);
});

test('Podman49 offline argv binds only a controlled read-only empty resolver instead of conflicting DNS options',()=>{
 const a=argsFor({root,mode:'baseline'});
 assert.ok(a.includes('--network=none'));
 assert.ok(!a.some(x=>/^--dns(?:=|-|$)/.test(x)),'Podman4.9 forbids DNS flags with network none');
 assert.ok(a.includes(`type=bind,src=${root}/resolv.conf,dst=/etc/resolv.conf,ro=true`));
 assert.ok(a.includes('--read-only-tmpfs=false'),'no implicit unbounded /var/tmp tmpfs');
});
test('resolver mount is mandatory and may not be replaced, duplicated, writable or inherited',()=>{
 const dns={Type:'bind',Source:root+'/resolv.conf',Destination:'/etc/resolv.conf',RW:false};
 const i=strict();assert.doesNotThrow(()=>assertInspect(i,root));
 for(const mounts of [i.Mounts.slice(0,2),[...i.Mounts.slice(0,2),{...dns,RW:true}],[...i.Mounts.slice(0,2),{...dns,Source:'/etc/resolv.conf'}],[...i.Mounts.slice(0,2),{...dns,Destination:'/etc/hosts'}],[...i.Mounts.slice(0,2),{...dns,Type:'unknown'}],[...i.Mounts,dns]])assert.throws(()=>assertInspect({...i,Mounts:mounts},root));
});
test('offline network snapshot refuses DNS content, extra interfaces and external routes',()=>{
 assert.equal(typeof contract.assertOfflineNetwork,'function');
 const good={devices:'Inter-| Receive | Transmit\n face |bytes packets\n lo: '+Array(16).fill('0').join(' ')+'\n',resolvConf:'',interfaces:{lo:[{internal:true,address:'127.0.0.1',family:'IPv4'}]},ipv4Routes:'Iface\tDestination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n',ipv6Routes:''};
 assert.doesNotThrow(()=>contract.assertOfflineNetwork(good));
 for(const patch of [{devices:'Inter-| Receive | Transmit\n face |bytes packets\n eth0: '+Array(16).fill('0').join(' ')+'\n'},{devices:undefined},{resolvConf:'nameserver 127.0.0.53\n'},{resolvConf:'# inherited host config\n'},{interfaces:{eth0:[]}},{interfaces:{lo:[{internal:false,address:'1.1.1.1',family:'IPv4'}]}},{ipv4Routes:good.ipv4Routes+'eth0 00000000 01010101 0003 0 0 0 00000000 0 0 0\n'},{ipv6Routes:'0 '.repeat(9)+'eth0\n'},{ipv4Routes:''},{interfaces:null}])assert.throws(()=>contract.assertOfflineNetwork({...good,...patch}));
});
