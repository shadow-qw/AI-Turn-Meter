// DRAFT: fixed synthetic fixtures only. Never accepts candidate paths, refs, env or commands.
// Requires explicit integration review and disposable GitHub Ubuntu VM. No privilege changes.
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {probe} from './host-probe.mjs';
import {argsFor,verifyThenStart,IMAGE} from './contract.mjs';
if(process.argv.length!==2||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('SANDBOX_UNAVAILABLE: hosted synthetic-only entrypoint');
const root=mkdtempSync('/tmp/atm-hosted-canary-');
for(const d of ['src','out','home','storage','runroot','empty-hooks','host-only'])mkdirSync(join(root,d),{mode:d==='out'?0o777:0o700});
// Set exact output directory mode despite inherited umask; this directory is ours only.
const {chmodSync}=await import('node:fs');chmodSync(join(root,'out'),0o777);
writeFileSync(join(root,'host-only/fake-secret'),'PUBLIC-SYNTHETIC-NOT-A-CREDENTIAL');
// Fresh controlled zero-byte resolver; no host DNS file is copied. Bind read-only.
writeFileSync(join(root,'resolv.conf'),'',{mode:0o444,flag:'wx'});
writeFileSync(join(root,'registry-auth.json'),'{}',{mode:0o600});
writeFileSync(join(root,'containers.conf'),'[containers]\nvolumes=[]\nenv=[]\n[engine]\ncgroup_manager="systemd"\n');
const modes=['baseline','cpu','pids','memory','timeout'];
for(const name of ['harness.mjs','contract.mjs'])copyFileSync(fileURLToPath(new URL('./'+name,import.meta.url)),join(root,'src',name));
for(const mode of modes)copyFileSync(fileURLToPath(new URL(`./fixtures/${mode}.mjs`,import.meta.url)),join(root,'src',`${mode}.mjs`));
chmodSync(join(root,'src'),0o755);
const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:join(root,'home'),XDG_RUNTIME_DIR:`/run/user/${process.getuid()}`,DBUS_SESSION_BUS_ADDRESS:`unix:path=/run/user/${process.getuid()}/bus`,REGISTRY_AUTH_FILE:join(root,'registry-auth.json'),CONTAINERS_CONF:join(root,'containers.conf')};
const global=['--root',join(root,'storage'),'--runroot',join(root,'runroot'),'--hooks-dir',join(root,'empty-hooks')];
const host=probe({env,globalArgs:global});
console.log(JSON.stringify({syntheticOnly:true,hostProbe:host}));
const pod=(args)=>execFileSync('/usr/bin/podman',[...global,...args],{env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024}).trim();
// Pull is preparation only, no candidate execution. Fully qualified immutable official digest.
execFileSync('/usr/bin/podman',[...global,'pull',IMAGE],{env,stdio:'inherit',timeout:180000});
const image=JSON.parse(pod(['image','inspect',IMAGE]))[0];
if(image.Architecture!=='amd64'||!image.RepoDigests?.includes(IMAGE))throw Error('SANDBOX_UNAVAILABLE: image digest/architecture');
console.log(JSON.stringify({syntheticOnly:true,imageDigest:IMAGE,architecture:'amd64',imageVerified:true}));
const results=[];
for(const mode of modes){
 const name=`atm-canary-${mode}`;
 const args=argsFor({root,mode}); const runAt=args.indexOf('run');
 // Create permits inspect before starting any synthetic process.
 const createArgs=[...args];createArgs[runAt]='create';
 pod(createArgs);
 try {
  const inspect=()=>JSON.parse(pod(['inspect',name]))[0];
  const preStart=inspect();
  console.log(JSON.stringify({mode,preStartCpu:{NanoCpus:preStart.HostConfig?.NanoCpus,CpuQuota:preStart.HostConfig?.CpuQuota,CpuPeriod:preStart.HostConfig?.CpuPeriod}}));
  verifyThenStart(()=>preStart,()=>pod(['start',name]),root);
  const initial=inspect();const pid=initial.State.Pid;
  // Track the unique container's cgroup; validate later that it has no residual processes.
  let cg=null;
  if(pid>0&&existsSync(`/proc/${pid}/cgroup`))cg=readFileSync(`/proc/${pid}/cgroup`,'utf8').trim().match(/^0::(\/[A-Za-z0-9_.@:/-]+)$/)?.[1];
  if(!cg)throw Error('SANDBOX_UNAVAILABLE: cannot establish container cgroup evidence');
  writeFileSync(join(root,'out',`go-${mode}`),'trusted-start');
  const deadline=Date.now()+(mode==='timeout'?1500:12000);
  while(inspect().State.Running&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  const timedOut=inspect().State.Running;
  if(timedOut)pod(['kill','--signal=KILL',name]);
  const state=inspect().State;
  if(state.Running)throw Error('SANDBOX_UNAVAILABLE: kill failed');
  if(mode==='timeout'){
   if(!timedOut)throw Error('timeout fixture exited prematurely');
   await new Promise(r=>setTimeout(r,7000));
   if(existsSync(join(root,'out/late-write')))throw Error('residual child wrote after timeout');
  } else if(mode==='memory'){
   if(timedOut||state.OOMKilled!==true||state.ExitCode===0)throw Error('bounded memory canary did not demonstrate cgroup OOM');
  }else if(timedOut||state.ExitCode!==0)throw Error(`canary failed: ${mode}`);
  const procs=`/sys/fs/cgroup${cg}/cgroup.procs`;
  if(existsSync(procs)&&readFileSync(procs,'utf8').trim())throw Error('SANDBOX_UNAVAILABLE: residual cgroup processes');
  results.push({mode,timedOut,state,baseline:mode==='baseline'?JSON.parse(readFileSync(join(root,'out/baseline.json'),'utf8')):null});
 }finally{
  // Only named containers in our private storage, never global rm/prune or shared containers.
  pod(['rm','--force',name]);
 }
}
writeFileSync(join(root,'synthetic-report.json'),JSON.stringify({syntheticOnly:true,host,imageDigest:IMAGE,results},null,2));
console.log(JSON.stringify({syntheticOnly:true,host,imageDigest:IMAGE,results},null,2));
console.log(`SYNTHETIC_PREFLIGHT_COMPLETE ${root}`);
// Does not issue a production sandbox certificate. Real candidate execution remains disabled.
