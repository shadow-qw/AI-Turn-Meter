// Read-only probe. Invoke on the intended disposable hosted VM, never escalate privileges.
import {readFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {assertHost} from './contract.mjs';
export function probe({env,globalArgs}={}){
 const uid=process.getuid();
 if(!env||!Array.isArray(globalArgs)||readFileSync('/proc/1/comm','utf8').trim()!=='systemd'||uid===0)throw Error('SANDBOX_UNAVAILABLE: private runtime and systemd required');
 const call=(cmd,args)=>execFileSync(cmd,args,{env,encoding:'utf8',timeout:10000,maxBuffer:1024*1024}).trim();
 const cg=call('/usr/bin/systemctl',['show',`user@${uid}.service`,'--property=ControlGroup','--value']);
 if(!/^\/user.slice\/[A-Za-z0-9@._\/-]+$/.test(cg)||cg.includes('..')) throw Error('SANDBOX_UNAVAILABLE: user manager cgroup');
 const info=JSON.parse(call('/usr/bin/podman',[...globalArgs,'info','--format=json']));
 const result={uid,pid1:readFileSync('/proc/1/comm','utf8').trim(),cgroup2:existsSync('/sys/fs/cgroup/cgroup.controllers'),userBus:existsSync(`/run/user/${uid}/bus`),controllers:readFileSync(`/sys/fs/cgroup${cg}/cgroup.controllers`,'utf8').trim().split(/\s+/),rootless:info.host?.security?.rootless,cgroupVersion:info.host?.cgroupVersion,cgroupManager:info.host?.cgroupManager};
 assertHost(result); return result;
}
if(process.argv[1]?.endsWith('/host-probe.mjs')) {
 try{console.log(JSON.stringify(probe(),null,2));}catch(e){console.error(`SANDBOX_UNAVAILABLE: ${e.message}`);process.exitCode=1;}
}
