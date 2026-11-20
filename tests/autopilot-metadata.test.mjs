// Frozen offline regression fixture ONLY; active publication workflow cannot run it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const wf=JSON.parse(readFileSync(new URL('./fixtures/autopilot/diagnostic-workflow.inert.json',import.meta.url)));
const job=wf.jobs['synthetic-only'],step=job.steps.find(x=>x.name?.startsWith('Record exact PR metadata'));
const code=step.run.split("<<'NODE'\n")[1].split('\nNODE')[0];
const token='ghs_'+'ABCD1234'.repeat(4)+'ABCD',head='a'.repeat(40),base='601e7775e5f9b5748f4426cfd0f741e337c2eeca';
function probe(scenario,patch={},credential=token) {
 const prelude=`
 const scenario=${JSON.stringify(scenario)},patch=${JSON.stringify(patch)};
 // Plain synthetic env permits NUL/control fixtures that OS execve cannot carry.
 process.env={...process.env};const input=${JSON.stringify(credential)};
 if(input===null)delete process.env.ATM_METADATA_TOKEN;else process.env.ATM_METADATA_TOKEN=input;
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
  else value={sha:url.split('/').at(-1),tree:{sha:patch.treeParts?patch.treeParts[calls-2]:'c'.repeat(40)},parents:patch.badParents?[{sha:'d'.repeat(40)},{sha:'${head}'}]:[{sha:patch.base?.sha??'${base}'},{sha:'${head}'}]};
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
 assert.match(r.stderr,new RegExp(`"status":${status}`));assert.match(r.stderr,/"classification":"[a-z-]+"/);assert.doesNotMatch(r.stderr,/x-github-|x-ratelimit-|ABC:123/);
 assert.doesNotMatch(r.stderr+r.stdout,new RegExp(token+'|x-ratelimit-evil|Bearer|publicMetadataOnly'));
});
test('untrusted error text cannot classify 403 as rate limit or be echoed',()=>{
 const r=probe(403,{message:'API rate limit exceeded for 10.0.0.1 '+token});assert.match(r.stderr,/forbidden-status/);assert.doesNotMatch(r.stderr,/API rate limit exceeded/);assert.doesNotMatch(r.stderr,new RegExp('10\\.0\\.0\\.1|'+token));
});
for(const scenario of ['redirect','transport','timeout','body-timeout','oversize','bad-json'])test(`${scenario} fails closed without printing raw error/body/token`,()=>{
 const r=probe(scenario);assert.notEqual(r.status,0);assert.equal(r.signal,null,'bounded completion');assert.match(r.stderr,/METADATA_REJECTED/);assert.doesNotMatch(r.stderr+r.stdout,new RegExp(token+'|publicMetadataOnly|untrusted.invalid'));
});
for(const patch of [{base:{sha:'759f3ea525b64281060b14ed43c6f35ae15705c8',repo:{id:1461122513}}},{state:'closed'},{head:{sha:'d'.repeat(40),repo:{id:1461122513}}},{base:{sha:'d'.repeat(40),repo:{id:1461122513}}},{merge_commit_sha:null},{head:{sha:head,repo:{id:1}}}])test('exact metadata offsets rejected '+JSON.stringify(patch),()=>{
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

// Response diagnostics must have a finite output alphabet independent of arbitrary
// response text. Do not grow an encoding blacklist: compare entire error outputs.
test('MI1: all response string encodings/fragments leave identical status-only diagnostics',()=>{
 const hex=Buffer.from(token).toString('hex');
 const variants=[token,token.toLowerCase(),token.toUpperCase(),hex,hex.toUpperCase(),hex.match(/.{1,8}/g).join(':'),Buffer.from(token).toString('base64'),[...token].map(x=>'%'+x.charCodeAt(0).toString(16)).join(''),...hex.match(/.{1,20}/g),...token.match(/.{1,10}/g),'12345678901234567890','core','ABC:123'];
 let baseline;
 for(const text of variants){
  const r=probe(403,{headers:{'x-github-request-id':text,'x-ratelimit-limit':text,'x-ratelimit-remaining':text,'x-ratelimit-reset':text,'x-ratelimit-used':text,'x-ratelimit-resource':text,'location':text},message:text});
  assert.equal(r.status,1);assert.equal(r.signal,null);assert.equal(r.stdout,'');
  const lines=r.stderr.trim().split('\n');
  assert.equal(lines.length,2);assert.deepEqual(JSON.parse(lines[0].replace(/^METADATA_HTTP /,'')),{status:403,classification:'forbidden-status'});
  assert.equal(lines[1],'METADATA_REJECTED http-status');
  baseline??=r.stderr;assert.equal(r.stderr,baseline,'response-controlled text must not alter output');
 }
});
test('adjacent success path validates tree hashes without echoing arbitrary hex response strings',()=>{
 const hex=Buffer.from(token).toString('hex'),r=probe('success',{treeParts:[hex.slice(0,40),hex.slice(40)]});
 assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stdout+r.stderr,new RegExp(hex.slice(0,40)+'|'+hex.slice(40),'i'));
 assert.doesNotMatch(r.stdout,/"(?:merge|headTree|mergeTree)":/);
 assert.match(r.stdout,/"mergeValidated":true/);
});

test('opaque HTTP-safe synthetic credentials do not assume GitHub prefix, size or alphabet',()=>{
 for(const value of ['opaque.v1/part+other=','opaque~:_!@#$%^&*()-[]{}','Q'.repeat(4096)]){
  const r=probe('success',{},value);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/"mergeValidated":true/);assert.doesNotMatch(r.stdout+r.stderr,new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 }
});
test('missing and invalid-header are fixed distinct errors before any fetch, no derived credential diagnostics',()=>{
 for(const [value,expected] of [[null,'missing-token'],['','missing-token'],[' ','invalid-header'],['abc def','invalid-header'],['abc\rdef','invalid-header'],['abc\ndef','invalid-header'],['abc\u0000def','invalid-header'],['abc\u0001def','invalid-header'],['abc\tdef','invalid-header'],['abc\u007fdef','invalid-header'],['abcédef','invalid-header'],['abc中def','invalid-header'],['X'.repeat(4097),'invalid-header']]){
  const r=probe('success',{},value);assert.equal(r.status,1);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'METADATA_REJECTED '+expected+'\n');
 }
});
test('newly admitted opaque synthetic values remain non-reflectable on HTTP errors',()=>{
 const value='synthetic.opaque/part+other=',hex=Buffer.from(value).toString('hex');
 for(const text of [value,hex,hex.toUpperCase(),hex.slice(0,24),Buffer.from(value).toString('base64')]){
  const r=probe(403,{headers:{'x-github-request-id':text,'x-ratelimit-remaining':text},message:text},value);
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'METADATA_HTTP {"status":403,"classification":"forbidden-status"}\nMETADATA_REJECTED http-status\n');
 }
});
