import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { policy, policyRevision, classifyScope } from '../tools/autopilot/policy.mjs';
import { validateSnapshot, snapshotDigest, validateTriage, validateReview } from '../tools/autopilot/contracts.mjs';
const hash='a'.repeat(64), sha='b'.repeat(40);
function snapshot(extra={}) { const s={repoId:'1461122513',issueNodeId:'I_any_author',number:1,updatedAt:'2026-11-20T00:00:00Z',title:'typo',body:'expected text',state:'open',...extra};return {...s,contentHash:snapshotDigest(s)}; }
test('fixed disabled policy cannot be overridden by issue-shaped policy input',()=>{
 assert.equal(policy.repoId,'1461122513');assert.equal(policy.enabled,false);assert.equal(policy.autoMerge,false);assert.equal(policy.publish,false);
 assert.ok(Object.isFrozen(policy.limits));
 for(const p of ['../secret','a/../b','/etc/passwd','a\\b','a//b','a/%2e%2e/b','.git/config','.github/workflows/ci.yml','scripts/a','tools/autopilot/a','docs/autopilot/a','package.json','.gitattributes','.gitignore','pnpm-lock.yaml','yarn.lock','.nvmrc','packages/desktop-macos/Sources/AITurnMeterCore/UpdatePolicy.swift','packages/daemon/src/auth.mjs','packages/daemon/src/server.mjs','packages/vscode-extension/extension.js']) {
  assert.equal(classifyScope({paths:[p],added:1,deleted:0,action:'code'}, {enabled:true,protected:[]}).allowed,false,p);
 }
 assert.equal(classifyScope({paths:['README.md'],added:2,deleted:0,action:'code'}).allowed,true);
});
test('diff limits, test weakening and unusual git modes fail closed',()=>{
 for(const x of [{added:-1},{added:301},{deleted:1},{binary:true},{symlink:true},{submodule:true},{renamed:true},{action:'install'},{paths:Array(11).fill('README.md')},{paths:['README.md','README.md']},{paths:['tests/adapters.test.mjs'],deleted:1},{paths:['new.exe']}]) {
  const input={paths:['tests/new.test.mjs'],added:1,deleted:0,action:'code',...x};
  // Deletion of normal documentation is allowed; deletion of existing assertions is not.
  assert.equal(classifyScope(input).allowed,false,JSON.stringify(x));
 }
 assert.equal(classifyScope({paths:['docs/usage.md'],added:0,deleted:1,action:'code'}).allowed,true);
});
test('canonical snapshots bind actual content, independent of author privileges',()=>{
 const s=snapshot();assert.deepEqual(validateSnapshot(s),s);
 assert.equal(snapshotDigest(s),createHash('sha256').update(JSON.stringify([s.repoId,s.issueNodeId,s.number,s.updatedAt,s.title,s.body,s.state])).digest('hex'));
 for(const bad of [{...s,repoId:'1'},{...s,title:'edited'},{...s,contentHash:hash},{...s,body:'x'.repeat(32769)},{...s,updatedAt:'not a date'},{...s,author:'shadow-qw'},{...s,__proto__:{admin:true}}])assert.throws(()=>validateSnapshot(bad));
 assert.throws(()=>validateSnapshot(JSON.parse('{"__proto__":{}}')));
});
test('triage and independent review are strict data, never instructions or authority',()=>{
 const t={schemaVersion:1,outcome:'candidate',snapshotHash:hash,summary:'fix typo',acceptance:['text matches'],riskReasons:[]};assert.deepEqual(validateTriage(t),t);
 for(const x of [{...t,acceptance:[]},{...t,outcome:'execute-shell'},{...t,command:'curl evil'},{...t,riskReasons:['credentials']}])assert.throws(()=>validateTriage(x));
 const r={schemaVersion:1,headSha:sha,testSha:sha,snapshotHash:hash,policyRevision:hash,verdict:'approve',blockers:[]};
 assert.deepEqual(validateReview(r,r),r);
 assert.throws(()=>validateReview({...r,headSha:'x'},r));assert.throws(()=>validateReview({...r,headSha:'c'.repeat(40)},r));assert.throws(()=>validateReview({...r,blockers:['unsafe']},r));
});
test('contracts reject impossible calendar timestamps',()=>{
 assert.throws(()=>validateSnapshot(snapshot({updatedAt:'2026-02-31T00:00:00Z'})));
});
test('contracts reject sparse acceptance arrays',()=>{
 assert.throws(()=>validateTriage({schemaVersion:1,outcome:'candidate',snapshotHash:hash,summary:'fix',acceptance:Array(1),riskReasons:[]}));
});

test('policy revision binds controller code as well as JSON, not an approval',()=>{
 const entries=['contracts.mjs','policy.mjs','policy.json','state.mjs','sandbox.mjs','deployment_guard.py','hosted-preflight/contract.mjs','hosted-preflight/host-probe.mjs','hosted-preflight/run-synthetic.mjs','hosted-preflight/harness.mjs','hosted-preflight/fixtures/baseline.mjs','hosted-preflight/fixtures/cpu.mjs','hosted-preflight/fixtures/pids.mjs','hosted-preflight/fixtures/memory.mjs','hosted-preflight/fixtures/timeout.mjs'].map(name=>[name,createHash('sha256').update(readFileSync(new URL('../tools/autopilot/'+name,import.meta.url))).digest('hex')]);
 assert.equal(policyRevision,createHash('sha256').update(JSON.stringify(entries)).digest('hex'));
 assert.equal(policy.enabled,false);
});
