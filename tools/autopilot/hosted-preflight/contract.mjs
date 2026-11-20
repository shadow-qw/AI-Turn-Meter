// Trusted synthetic preflight only. Not a candidate executor or acceptance attestation.
export const IMAGE='docker.io/library/node@sha256:0e2646ab57e77b7a384a0cb59b6815b182c77e1f9c3ba36bd8435bd9c4e6680e';
const modes=new Set(['baseline','memory','pids','cpu','timeout']);
export function argsFor(input){
 if(Object.keys(input).some(k=>!['root','mode'].includes(k))) throw Error('unknown keys');
 const {root,mode}=input;
 if(!/^\/tmp\/atm-hosted-canary-[A-Za-z0-9]+$/.test(root)||!modes.has(mode)) throw Error('invalid fixed fixture');
 return ['--cgroup-manager=systemd','run','--name',`atm-canary-${mode}`,
 '--pull=never','--network=none','--read-only','--cap-drop=ALL',
 '--security-opt=no-new-privileges','--user=65534:65534','--pid=private','--ipc=private','--cgroupns=private',
 '--pids-limit=32','--memory=128m','--memory-swap=128m','--cpus=0.25',
 '--unsetenv-all','--env=HOME=/tmp/home','--env=PATH=/usr/local/bin:/usr/bin:/bin',
 '--env=NODE_OPTIONS=','--http-proxy=false','--no-hosts','--dns=none',
 '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777',
 '--tmpfs=/run:rw,nosuid,nodev,noexec,size=4m,mode=755',
 '--mount',`type=bind,src=${root}/src,dst=/src,ro=true`,
 '--mount',`type=bind,src=${root}/out,dst=/out,rw=true`,
 '--workdir=/tmp','--entrypoint=/usr/local/bin/node',IMAGE,'/src/harness.mjs',`/src/${mode}.mjs`,mode,`${root}/host-only/fake-secret`];
}
export function assertHost(h){
 if(!Number.isInteger(h.uid)||h.uid===0||h.pid1!=='systemd'||h.cgroup2!==true||h.userBus!==true||h.rootless!==true||h.cgroupVersion!=='v2'||h.cgroupManager!=='systemd'||!['cpu','memory','pids'].every(c=>h.controllers?.includes(c))) throw Error('SANDBOX_UNAVAILABLE: rootless/systemd/cgroup delegation not established');
}

export function assertInspect(i,root){
 const h=i.HostConfig;
 const reject=()=>{throw Error('SANDBOX_UNAVAILABLE: inspect contract mismatch');};
 if(!h)reject();
 // Podman/Docker inspect uses missing/0 for an unused family, never a
 // negative, string, null, fractional or overflowed value. Do not let a
 // valid family hide an explicitly unlimited/malformed other family.
 for(const key of ['NanoCpus','CpuQuota','CpuPeriod']){
  if(Object.hasOwn(h,key)&&(!Number.isSafeInteger(h[key])||h[key]<0))reject();
 }
 const nano=h.NanoCpus??0,quota=h.CpuQuota??0,period=h.CpuPeriod??0;
 const nanoSet=nano!==0,quotaSet=quota!==0||period!==0;
 if(nanoSet&&nano!==250000000)reject();
 if(quotaSet&&(quota===0||period<1000||period>1000000||quota!==period/4))reject();
 if(!nanoSet&&!quotaSet)reject();
 if(i.ImageName!==IMAGE||!Array.isArray(i.EffectiveCaps)||i.EffectiveCaps.length||!Array.isArray(i.BoundingCaps)||i.BoundingCaps.length)reject();
 if(h.PidMode!=='private'||h.IpcMode!=='private'||h.CgroupMode!=='private'||h.CapAdd?.length||h.Devices?.length)reject();
 const env=i.Config?.Env;
 if(!Array.isArray(env)||!['HOME=/tmp/home','PATH=/usr/local/bin:/usr/bin:/bin','NODE_OPTIONS='].every(e=>env.includes(e))||env.some(e=>!['HOME=/tmp/home','PATH=/usr/local/bin:/usr/bin:/bin','NODE_OPTIONS=','container=podman'].includes(e)&&!/^HOSTNAME=[a-z0-9-]+$/.test(e)))reject();
 if(!h||i.Config?.User!=='65534:65534'||h.Privileged!==false||h.ReadonlyRootfs!==true||h.NetworkMode!=='none'||!h.CapDrop?.some(x=>x.toUpperCase()==='ALL')||!h.SecurityOpt?.includes('no-new-privileges')||h.SecurityOpt?.some(x=>x.includes('unconfined'))||h.Memory!==134217728||h.MemorySwap!==134217728||h.PidsLimit!==32)throw Error('SANDBOX_UNAVAILABLE: inspect contract mismatch');
 const mounts=i.Mounts;
 if(!Array.isArray(mounts)||mounts.length!==2||!mounts.some(m=>m.Source===`${root}/src`&&m.Destination==='/src'&&m.RW===false)||!mounts.some(m=>m.Source===`${root}/out`&&m.Destination==='/out'&&m.RW===true))throw Error('SANDBOX_UNAVAILABLE: mount mismatch');
}

// Internal adapter seam: inspect is verified before the start side effect.
export function verifyThenStart(inspect,start,root){
 const info=inspect();
 assertInspect(info,root);
 start();
 return info;
}
