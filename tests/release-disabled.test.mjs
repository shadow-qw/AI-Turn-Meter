import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const workflow=()=>readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
test('local Release definition has no write capability or reachable publisher (staged E boundary)',()=>{
 const s=workflow();
 assert.doesNotMatch(s,/: write|uses:|secrets\.|github\.token|GITHUB_TOKEN|gh release|publish:|vars\./);
 assert.match(s,/contents: read/);
 assert.equal((s.match(/^  [a-z][a-z-]*:\n    runs-on:/gm)||[]).length,1);
 assert.match(s,/run: exit 1/);
 assert.doesNotMatch(s,/\bif:|needs:|workflow_call:/);
});
test('exact disabled-job command fails for tag, dispatch and proof variables; no input can unlock it',()=>{
 const s=workflow(); const commands=[...s.matchAll(/^\s+run: (.+)$/gm)].map(m=>m[1]);
 assert.deepEqual(commands,['exit 1']);
 const home=mkdtempSync(join(tmpdir(),'atm-release-disabled-'));
 try {
  for(const event of ['push','workflow_dispatch']) for(const proof of ['', 'a'.repeat(40)]) {
   const result=spawnSync('sh',['-c',commands[0]],{env:{PATH:process.env.PATH,HOME:home,GITHUB_EVENT_NAME:event,GITHUB_REF:'refs/heads/main',CONFIRM_STABLE_TAG:'v0.3.0',RC_CHANNEL_PROOF_SHA:proof},encoding:'utf8'});
   assert.equal(result.status,1); assert.equal(result.signal,null);
  }
 }finally{rmSync(home,{recursive:true,force:true});}
});
