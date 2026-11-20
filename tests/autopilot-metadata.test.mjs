import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const wf=JSON.parse(readFileSync(new URL('../.github/workflows/autopilot-synthetic.yml',import.meta.url)));
const job=wf.jobs['synthetic-only'],step=job.steps.find(x=>x.name?.startsWith('Record exact PR metadata'));
const code=step.run.split("<<'NODE'\n")[1].split('\nNODE')[0];
const token='INERT_METADATA_CANARY_DO_NOT_LOG',head='a'.repeat(40),base='759f3ea525b64281060b14ed43c6f35ae15705c8';
function probe(scenario,patch={}) {
 const prelude=`
 const scenario=${JSON.stringify(scenario)},patch=${JSON.stringify(patch)};
 const nativeTimer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>nativeTimer(fn,Math.min(ms,50),...args);
 let calls=0;
 globalThis.fetch=async(url,options)=>{
  calls++;
  if(url!=='https://api.github.com/repos/shadow-qw/AI-Turn-Meter/pulls/2'&&!/^https:\\/\\/api.github.com\\/repos\\/shadow-qw\\/AI-Turn-Meter\\/git\\/commits\\/[a-f0-9]{40}$/.test(url))throw Error('unknown host/route');
  if(options.redirect!=='error')throw Error('unsafe redirects');
  if(scenario==='success'&&options.headers.Authorization!=='Bearer '+process.env.ATM_METADATA_TOKEN)throw Error('missing scoped authentication');
  if(scenario==='transport')throw Error('Authorization Bearer '+process.env.ATM_METADATA_TOKEN);
  if(scenario==='timeout')return new Promise(()=>{});
  if(scenario==='body-timeout')return new Response(new ReadableStream({start(){}}));
  if(scenario==='oversize')return new Response('x'.repeat(262145));
  if(scenario==='redirect')return new Response('',{status:302,headers:{location:'https://untrusted.invalid/'+process.env.ATM_METADATA_TOKEN}});
  if(scenario==='bad-json')return new Response('not json '+process.env.ATM_METADATA_TOKEN);
  if(typeof scenario==='number')return new Response(JSON.stringify({message:patch.large?'x'.repeat(300000):patch.message??'unrecognized '+process.env.ATM_METADATA_TOKEN}),{status:scenario,headers:{'x-github-request-id':'ABC:123','x-ratelimit-limit':'60','x-ratelimit-remaining':'0','x-ratelimit-reset':'123456','x-ratelimit-resource':'core','x-ratelimit-used':'60','authorization':process.env.ATM_METADATA_TOKEN,'x-ratelimit-evil':process.env.ATM_METADATA_TOKEN,...patch.headers}});
  let value;
  if(calls===1)value={state:'open',head:{sha:'${head}',repo:{id:1461122513}},base:{sha:'${base}',repo:{id:1461122513}},merge_commit_sha:'b'.repeat(40),...patch};
  else value={sha:url.split('/').at(-1),tree:{sha:'c'.repeat(40)},parents:patch.badParents?[{sha:'d'.repeat(40)},{sha:'${head}'}]:[{sha:'${base}'},{sha:'${head}'}]};
  return new Response(JSON.stringify(value));
 };
 `;
 return spawnSync(process.execPath,['--input-type=module','--eval',prelude+'\n'+code],{env:{PATH:process.env.PATH,HOME:'/nonexistent',GITHUB_SHA:head,ATM_METADATA_TOKEN:token},encoding:'utf8',timeout:1500});
}
test('actual builtin metadata uses step-only readonly token and preserves normal exact metadata',()=>{
 assert.deepEqual(step.env,{ATM_METADATA_TOKEN:'${{ github.token }}'});
 assert.equal(job.env,undefined);assert.equal(wf.env,undefined);assert.deepEqual(wf.permissions,{contents:'read'});
 for(const x of job.steps.filter(x=>x!==step))assert.doesNotMatch(JSON.stringify(x),/ATM_METADATA_TOKEN|github.token/);
 assert.equal(job.steps.find(x=>x.uses?.startsWith('actions/checkout@')).with['persist-credentials'],false);
 assert.match(job.steps.at(-1).run,/env -i/);
 const r=probe('success');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/'?"head":"a{40}"/);assert.doesNotMatch(r.stdout+r.stderr,new RegExp(token));
});
for(const status of [403,429,500,503])test(`HTTP${status}: bounded allowlisted diagnostics, no pass/no secret`,()=>{
 const r=probe(status);assert.notEqual(r.status,0);assert.equal(r.signal,null);
 assert.match(r.stderr,new RegExp(`"status":${status}`));assert.match(r.stderr,/"x-github-request-id":"ABC:123"/);assert.match(r.stderr,/"x-ratelimit-remaining":"0"/);
 assert.doesNotMatch(r.stderr+r.stdout,new RegExp(token+'|x-ratelimit-evil|Bearer|publicMetadataOnly'));
});
test('known rate-limit message is normalized, unknown text never echoed',()=>{
 const r=probe(403,{message:'API rate limit exceeded for 10.0.0.1 '+token});assert.match(r.stderr,/API rate limit exceeded/);assert.doesNotMatch(r.stderr,/10\.0\.0\.1|INERT_METADATA/);
});
for(const scenario of ['redirect','transport','timeout','body-timeout','oversize','bad-json'])test(`${scenario} fails closed without printing raw error/body/token`,()=>{
 const r=probe(scenario);assert.notEqual(r.status,0);assert.equal(r.signal,null,'bounded completion');assert.match(r.stderr,/METADATA_REJECTED/);assert.doesNotMatch(r.stderr+r.stdout,new RegExp(token+'|publicMetadataOnly|untrusted.invalid'));
});
for(const patch of [{state:'closed'},{head:{sha:'d'.repeat(40),repo:{id:1461122513}}},{base:{sha:'d'.repeat(40),repo:{id:1461122513}}},{merge_commit_sha:null},{head:{sha:head,repo:{id:1}}}])test('exact metadata offsets rejected '+JSON.stringify(patch),()=>{
 const r=probe('success',patch);assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout,/publicMetadataOnly/);
});

test('error header/message injection is omitted and oversized error body stays bounded',()=>{
 for(const patch of [{headers:{'x-github-request-id':token,'x-ratelimit-remaining':token,'x-ratelimit-resource':token},message:'::error::'+token},{large:true}]){
  const r=probe(403,patch);assert.notEqual(r.status,0);assert.equal(r.signal,null);assert.match(r.stderr,/"status":403/);assert.doesNotMatch(r.stdout+r.stderr,new RegExp(token+'|::error::'));assert.ok(r.stderr.length<1500);
 }
});
test('wrong merge parents rejected despite syntactically valid merge SHA',()=>{const r=probe('success',{badParents:true});assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout,/publicMetadataOnly/);});

test('actual driver shell env-i boundary strips metadata token before inert child execution',()=>{
 const shell=job.steps.at(-1).run.replace('node tools/autopilot/hosted-preflight/run-synthetic.mjs',`node -e 'if(process.env.ATM_METADATA_TOKEN||process.env.GITHUB_TOKEN)process.exit(3);console.log("INERT_ENV_EMPTY")'`)+ '\nrmdir "$scratch"\n';
 const r=spawnSync('/bin/bash',['-e','-c',shell],{env:{PATH:process.env.PATH,ATM_METADATA_TOKEN:token,GITHUB_TOKEN:token},encoding:'utf8',timeout:1500});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/INERT_ENV_EMPTY/);assert.doesNotMatch(r.stdout+r.stderr,new RegExp(token));
});
