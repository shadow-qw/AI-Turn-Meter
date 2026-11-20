import { policy } from './policy.mjs';
import { exactObject, requireValue as check } from './contracts.mjs';
const prepare=`import {cpSync,mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
mkdirSync('/tmp/home',{recursive:true});cpSync('/src','/tmp/work',{recursive:true,dereference:false});process.chdir('/tmp/work');`;
const commands=Object.freeze({
 unit:prepare+`const files=readdirSync('tests').filter(x=>x.endsWith('.test.mjs')).sort().map(x=>'tests/'+x);if(!files.length)process.exit(1);const result=spawnSync('/usr/local/bin/node',['--test',...files],{stdio:'inherit',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp/home',TMPDIR:'/tmp',XDG_CONFIG_HOME:'/tmp/config',XDG_DATA_HOME:'/tmp/data',CODEX_HOME:'/tmp/codex',AI_TURN_METER_DB:'/tmp/db'},timeout:1800000});process.exit(result.status??1);`,
 'package-check':prepare+`const root=JSON.parse(readFileSync('package.json'));const extension=JSON.parse(readFileSync('packages/vscode-extension/package.json'));if(typeof root.version!=='string'||root.version!==extension.version)process.exit(1);`
});
/** Planning only. These flags do NOT prove enforcement, a safe snapshot or an accepted image. */
export function sandboxArgs(spec) {
 exactObject(spec,['imageDigest','sourceDir','outDir','commandId']);
 check(spec.imageDigest===policy.sandbox.image&&Object.hasOwn(commands,spec.commandId),'INVALID_SANDBOX_SPEC');
 check(typeof spec.sourceDir==='string'&&/^\/tmp\/atm-candidate-[A-Za-z0-9]+\/source$/.test(spec.sourceDir),'INVALID_STAGING_PATH');
 check(spec.outDir===spec.sourceDir.replace(/\/source$/,'/out'),'INVALID_STAGING_PATH');
 return ['--cgroup-manager=systemd','run','--rm','--pull=never','--network=none','--cap-drop=ALL','--read-only','--security-opt=no-new-privileges',
  '--pids-limit=128','--memory=2g','--memory-swap=2g','--cpus=2','--user=65534:65534','--pid=private','--ipc=private','--cgroupns=private',
  '--unsetenv-all','--env=HOME=/tmp/home','--env=PATH=/usr/local/bin:/usr/bin:/bin','--http-proxy=false','--no-hosts','--dns=none',
  '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777','--tmpfs=/run:rw,nosuid,nodev,noexec,size=4m,mode=755',
  '--mount',`type=bind,src=${spec.sourceDir},dst=/src,ro=true`,'--mount',`type=bind,src=${spec.outDir},dst=/out,rw=true`,
  '--workdir=/tmp','--entrypoint=/usr/local/bin/node',spec.imageDigest,'--input-type=module','--eval',commands[spec.commandId]];
}
/** No runtime adapter or authentic canary evidence exists yet. Never accept JSON as an attestation. */
export function inspectSandbox() { throw new Error('SANDBOX_UNAVAILABLE: trusted runtime inspect/canary adapter not accepted'); }
/** Deliberate hard stop; cannot be unlocked by a flag, env, Issue or injected spawn. */
export async function runSandbox() { inspectSandbox(); }
