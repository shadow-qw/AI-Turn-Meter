import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const source='87d3d39d40e63f18752443a6aee10e6797e75adb';
const wf=JSON.parse(readFileSync(new URL('../.github/workflows/autopilot-synthetic.yml',import.meta.url)));
const job=wf.jobs['synthetic-only'];
const scratch=t=>{const p=mkdtempSync(join(tmpdir(),'atm-bootstrap-boundary-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;};
const run=(script,cwd,env={})=>spawnSync('/bin/bash',['-e','-c',script],{cwd,env:{PATH:process.env.PATH,HOME:cwd,...env},encoding:'utf8',timeout:10000});
test('additive adversarial PR tests cannot run as bootstrap host package scripts',t=>{
 const cwd=scratch(t);mkdirSync(join(cwd,'tests'));writeFileSync(join(cwd,'package.json'),JSON.stringify({scripts:{test:'node --test tests/*.test.mjs'}}));
 writeFileSync(join(cwd,'tests/autopilot-evil.test.mjs'),"import{writeFileSync}from'node:fs';writeFileSync('PR_TEST_HOST_MARKER','inert adversarial fixture');");
 const old=job.steps.find(s=>s.name==='Offline component tests');if(old)run(old.run,cwd);
 assert.equal(existsSync(join(cwd,'PR_TEST_HOST_MARKER')),false);
 assert.ok(!job.steps.some(s=>/\bnpm\s+(test|run|install)\b/.test(s.run??'')));
});
test('modified PR driver is not the workflow checkout or executable source',t=>{
 const cwd=scratch(t);mkdirSync(join(cwd,'tools/autopilot/hosted-preflight'),{recursive:true});
 writeFileSync(join(cwd,'tools/autopilot/hosted-preflight/run-synthetic.mjs'),"import{writeFileSync}from'node:fs';writeFileSync('PR_DRIVER_HOST_MARKER','inert adversarial fixture');");
 const checkout=job.steps.find(s=>s.uses?.startsWith('actions/checkout@'));
 if(checkout.with.ref!==source)run(job.steps.at(-1).run,cwd);
 assert.equal(existsSync(join(cwd,'PR_DRIVER_HOST_MARKER')),false);
 assert.equal(checkout.with.ref,source);assert.equal(checkout.with.repository,'shadow-qw/AI-Turn-Meter');assert.equal(checkout.with.path,'trusted-bootstrap');
 assert.deepEqual(Object.keys(wf.on),['push']);assert.equal(job.steps.at(-1)['working-directory'],'trusted-bootstrap');
});
test('actual inline approval gate rejects wrong source, event, head, workflow or baseline',t=>{
 const cwd=scratch(t),step=job.steps.find(s=>s.name==='Gate one-shot approval');assert.ok(step);
 const sha='a'.repeat(40),before='c6c5d4fd0a6ba167f3a2cbcf1fa123ee712656f8';
 const event={ref:'refs/heads/docs/issue-autopilot-design-20261119',before,after:sha,forced:false,deleted:false,repository:{id:1461122513,full_name:'shadow-qw/AI-Turn-Meter'}};
 const path=join(cwd,'event.json');writeFileSync(path,JSON.stringify(event));
 const env={GITHUB_EVENT_NAME:'push',GITHUB_REPOSITORY:'shadow-qw/AI-Turn-Meter',GITHUB_REPOSITORY_ID:'1461122513',GITHUB_ACTOR:'shadow-qw',GITHUB_REF:event.ref,GITHUB_SHA:sha,GITHUB_WORKFLOW_SHA:sha,GITHUB_EVENT_PATH:path,APPROVED_WORKFLOW_SHA:sha,APPROVED_SOURCE_SHA:source};
 assert.equal(run(step.run,cwd,env).status,0);
 for(const patch of [{APPROVED_WORKFLOW_SHA:''},{APPROVED_SOURCE_SHA:'b'.repeat(40)},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_SHA:'b'.repeat(40)},{GITHUB_WORKFLOW_SHA:'b'.repeat(40)},{GITHUB_REF:'refs/heads/main'},{GITHUB_ACTOR:'untrusted'}])assert.notEqual(run(step.run,cwd,{...env,...patch}).status,0,JSON.stringify(patch));
 for(const patch of [{forced:true},{deleted:true},{before:'c'.repeat(40)},{after:'c'.repeat(40)}]){writeFileSync(path,JSON.stringify({...event,...patch}));assert.notEqual(run(step.run,cwd,env).status,0);}
});
test('actual byte-verifier checks pinned fixture bytes and rejects altered driver before execution',t=>{
 const cwd=scratch(t),dir=join(cwd,'trusted-bootstrap');mkdirSync(dir);
 const step=job.steps.find(s=>s.name==='Verify approved bootstrap bytes');assert.ok(step);
 const checkout=job.steps.find(s=>s.uses?.startsWith('actions/checkout@'));
 const repo=new URL('../',import.meta.url).pathname;
 // Do not require ancestor Git objects in shallow macOS CI. The actual
 // workflow validates its immutable checkout OID separately; here the
 // pinned byte map independently authenticates copied fixture bytes.
 const names=['contract.mjs','host-probe.mjs','run-synthetic.mjs','harness.mjs',...['baseline','cpu','pids','memory','timeout'].map(x=>`fixtures/${x}.mjs`)];
 for(const name of names){const relative='tools/autopilot/hosted-preflight/'+name;mkdirSync(join(dir,relative,'..'),{recursive:true});copyFileSync(join(repo,relative),join(dir,relative));}

 assert.equal(run(step.run,cwd).status,0);
 const target=join(dir,'tools/autopilot/hosted-preflight/run-synthetic.mjs');
 writeFileSync(target,"import{writeFileSync}from'node:fs';writeFileSync('PR_DRIVER_HOST_MARKER','tampered');");
 assert.notEqual(run(step.run,cwd).status,0);assert.equal(existsSync(join(cwd,'PR_DRIVER_HOST_MARKER')),false);
});
test('documented preflight requires complete strict PR identity before any external write',t=>{
 const file=new URL('../docs/superpowers/runbooks/synthetic-preflight.md',import.meta.url);
 assert.ok(existsSync(file),'reviewed preflight runbook must exist');
 const text=readFileSync(file,'utf8'),match=text.match(/```python\n([\s\S]*?)\n```/);assert.ok(match);
 const cwd=scratch(t),path=join(cwd,'pr.json');
 const valid={number:2,state:'open',merged:false,head:{sha:'c6c5d4fd0a6ba167f3a2cbcf1fa123ee712656f8',ref:'docs/issue-autopilot-design-20261119',repo:{id:1461122513,full_name:'shadow-qw/AI-Turn-Meter'}},base:{sha:'759f3ea525b64281060b14ed43c6f35ae15705c8',ref:'main',repo:{id:1461122513,full_name:'shadow-qw/AI-Turn-Meter'}}};
 const check=raw=>{writeFileSync(path,raw);return spawnSync('python3',['-B','-c',match[1],path],{env:{PATH:process.env.PATH,HOME:cwd},encoding:'utf8',timeout:1500});};
 const ok=check(JSON.stringify(valid));assert.equal(ok.status,0,ok.stderr);assert.equal(ok.stdout,'PREFLIGHT_PR_IDENTITY_OK\n');
 const variants=['not-json','<wrapper>'+JSON.stringify(valid),JSON.stringify(valid).slice(0,-10),JSON.stringify({...valid,state:'closed'}),JSON.stringify({...valid,merged:0}),JSON.stringify({...valid,number:3}),JSON.stringify({...valid,head:{...valid.head,sha:'a'.repeat(40)}}),JSON.stringify({...valid,head:{...valid.head,ref:'main'}}),JSON.stringify({...valid,base:{...valid.base,sha:'a'.repeat(40)}}),JSON.stringify({...valid,head:{...valid.head,repo:{id:1,full_name:'untrusted/repo'}}})];
 for(const raw of variants){const r=check(raw);assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'PREFLIGHT_PR_REJECTED\n');}
});
