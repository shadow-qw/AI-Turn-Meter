// Frozen offline regression fixture ONLY; active publication workflow cannot run it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,copyFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const source='55114549a4f6841789bc3ac14218de0d2641c62b';
const wf=JSON.parse(readFileSync(new URL('./fixtures/autopilot/diagnostic-workflow.inert.json',import.meta.url)));
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
 const sha='a'.repeat(40),before='42bb66fb37373a707a8d6c2aa891906be4c4c533';
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
test('documented preflight rejects every bad identity before marker under all Python optimization modes',t=>{
 const file=new URL('../docs/superpowers/runbooks/synthetic-preflight.md',import.meta.url);
 assert.ok(existsSync(file),'reviewed preflight runbook must exist');
 const text=readFileSync(file,'utf8'),matches=[...text.matchAll(/```python\n([\s\S]*?)\n```/g)];assert.equal(matches.length,1);const match=matches[0];
 const shells=[...text.matchAll(/```bash\n([\s\S]*?)\n```/g)];assert.equal(shells.length,1);
 const digest=createHash('sha256').update(match[1]+'\n').digest('hex');assert.ok((text.includes("'"+digest+"'")||text.includes('"'+digest+'"')),'runbook must pin exact tested validator bytes');
 const cwd=scratch(t),path=join(cwd,'pr-before.json'),script=join(cwd,'validate-pr.py'),marker=join(cwd,'AFTER_GATE');writeFileSync(script,match[1]+'\n');
 const bin=join(cwd,'bin');mkdirSync(bin);writeFileSync(join(bin,'sha256sum'),'#!/bin/sh\nexit 64\n',{mode:0o755}); // No GNU CLI dependency on macOS.
 const valid={number:2,state:'open',merged:false,head:{sha:'42bb66fb37373a707a8d6c2aa891906be4c4c533',ref:'docs/issue-autopilot-design-20261119',repo:{id:1461122513,full_name:'shadow-qw/AI-Turn-Meter'}},base:{sha:'601e7775e5f9b5748f4426cfd0f741e337c2eeca',ref:'main',repo:{id:1461122513,full_name:'shadow-qw/AI-Turn-Meter'}}};
 const bad=['not-json','<wrapper>'+JSON.stringify(valid),JSON.stringify(valid).slice(0,-10),'null','[]','"unknown"',JSON.stringify(valid)+' '.repeat(1048577),Buffer.from([255])];
 bad.push(JSON.stringify({...valid,base:{...valid.base,sha:'759f3ea525b64281060b14ed43c6f35ae15705c8'}}));
 const fields={'number':999,'state':'unknown','merged':true,'head.sha':'a'.repeat(40),'head.ref':'main','head.repo.id':1,'head.repo.full_name':'evil/repo','base.sha':'a'.repeat(40),'base.ref':'other','base.repo.id':1,'base.repo.full_name':'evil/base'};
 for(const [key,value] of Object.entries(fields)){
  const parts=key.split('.'),leaf=parts.pop();
  for(const action of ['wrong','missing','type']){
   const p=structuredClone(valid);let obj=p;for(const part of parts)obj=obj[part];
   if(action==='missing')delete obj[leaf];else obj[leaf]=action==='type'?[]:value;
   bad.push(JSON.stringify(p));
  }
 }
 for(const key of ['head','base']){const p=structuredClone(valid);p[key]=null;bad.push(JSON.stringify(p));const q=structuredClone(valid);q[key].repo=[];bad.push(JSON.stringify(q));}
 const modes=[{name:'normal',flags:[],env:{}},{name:'env1',flags:[],env:{PYTHONOPTIMIZE:'1'}},{name:'env2',flags:[],env:{PYTHONOPTIMIZE:'2'}},{name:'-O',flags:['-O'],env:{}},{name:'-OO',flags:['-OO'],env:{}}];
 let negatives=0;
 for(const mode of modes){
  const check=(raw,input=path)=>{
   rmSync(marker,{force:true});rmSync(path,{recursive:true,force:true});if(input===cwd)mkdirSync(path);else if(input===path)writeFileSync(path,raw);
   const shell=shells[0][1].replaceAll('/workspace/atm-preflight',cwd).replace('python3 -B','python3 '+mode.flags.join(' ')+' -B');
   // Execute the actual pinned runbook shell, not a reconstruction; only relocate scratch paths.
   return spawnSync('/bin/bash',['-c',shell+'\nprintf local-only > "$MARKER"'],{env:{PATH:bin+':'+process.env.PATH,HOME:cwd,MARKER:marker,...mode.env},encoding:'utf8',timeout:3000});
  };
  const ok=check(JSON.stringify(valid));assert.equal(ok.status,0,mode.name+': '+ok.stderr);assert.equal(ok.stdout,'PREFLIGHT_PR_IDENTITY_OK\n');assert.equal(existsSync(marker),true);
  for(const raw of bad){const r=check(raw);assert.equal(r.status,1,mode.name);assert.equal(r.stdout,'');assert.equal(r.stderr,'PREFLIGHT_PR_REJECTED\n');assert.equal(existsSync(marker),false,mode.name+': marker must not run');negatives++;}
  for(const input of [join(cwd,'missing.json'),cwd]){const r=check('{}',input);assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'PREFLIGHT_PR_REJECTED\n');assert.equal(existsSync(marker),false);negatives++;}
  for(const altered of [match[1]+"\nprint('UNREVIEWED_COPY')\n",match[1].replaceAll("require(","require( ")+"\n",match[1].replaceAll("\n","\r\n")+"\r\n",null,"symlink"]){
   rmSync(script,{force:true});if(altered==='symlink'){const target=join(cwd,'same-reviewed-bytes.py');writeFileSync(target,match[1]+'\n');symlinkSync(target,script);}else if(altered!==null)writeFileSync(script,altered);
   const r=check(JSON.stringify(valid));assert.notEqual(r.status,0);assert.equal(r.stdout,'');assert.equal(existsSync(marker),false);negatives++;
   rmSync(script,{force:true});writeFileSync(script,match[1]+'\n');
  }
 }
 t.diagnostic('5 positive modes; '+negatives+' negative mode-cases rejected before local marker');
});
test('related Python safety paths have no removable assert and explicit guards survive optimization',t=>{
 const cwd=scratch(t),snippet=join(cwd,'validator.py');
 const doc=readFileSync(new URL('../docs/superpowers/runbooks/synthetic-preflight.md',import.meta.url),'utf8');
 writeFileSync(snippet,doc.match(/```python\n([\s\S]*?)\n```/)[1]+'\n');
 const guard=new URL('../tools/autopilot/deployment_guard.py',import.meta.url).pathname;
 const audit=`import ast, pathlib, runpy, sys
for path in sys.argv[1:]:
    if any(isinstance(n, ast.Assert) for n in ast.walk(ast.parse(pathlib.Path(path).read_text()))):
        sys.exit('REMOVABLE_SAFETY_ASSERT')
ns = runpy.run_path(sys.argv[1], run_name='synthetic_audit_only')
for call in [lambda: ns['require'](False, 'synthetic'), lambda: ns['assert_stopped']({}, {})]:
    try:
        call()
    except RuntimeError:
        continue
    sys.exit('GUARD_BYPASSED')
print('EXPLICIT_GUARDS_REJECTED')`;
 for(const mode of [{flags:[],env:{}},{flags:[],env:{PYTHONOPTIMIZE:'1'}},{flags:[],env:{PYTHONOPTIMIZE:'2'}},{flags:['-O'],env:{}},{flags:['-OO'],env:{}}]){
  const r=spawnSync('python3',['-B',...mode.flags,'-c',audit,guard,snippet],{env:{PATH:process.env.PATH,HOME:cwd,...mode.env},encoding:'utf8',timeout:3000});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'EXPLICIT_GUARDS_REJECTED\n');
 }
});

test('current integration runbook pins match the reviewed bootstrap and exact new main without stale checklist',()=>{
 const doc=readFileSync(new URL('../docs/superpowers/runbooks/synthetic-preflight.md',import.meta.url),'utf8');
 assert.ok(doc.includes(source));
 assert.ok(doc.includes('601e7775e5f9b5748f4426cfd0f741e337c2eeca'));
 assert.ok(!doc.includes('source87d/beforec6'));
 assert.ok(doc.includes('integration/issue-autopilot-main-601e777'));
 const metadata=job.steps.find(s=>s.name==='Record exact PR metadata (data only; no checkout)').run;
 assert.ok(metadata.includes("assert.equal(p.base.sha,'601e7775e5f9b5748f4426cfd0f741e337c2eeca')"));
});
