import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {openState} from '../tools/autopilot/state.mjs';
import {snapshotDigest} from '../tools/autopilot/contracts.mjs';
function snap(n=1,body='fix',state='open') {const s={repoId:'1461122513',issueNodeId:`I_${n}`,number:n,updatedAt:'2026-11-20T00:00:00Z',title:'typo',body,state};return {...s,contentHash:snapshotDigest(s)};}
function tri(s,outcome='candidate') {return {schemaVersion:1,outcome,snapshotHash:s.contentHash,summary:'trusted triage',acceptance:outcome==='candidate'?['fixture matches']:[],riskReasons:outcome==='candidate'?[]:['manual decision']};}
function queue(db,s=snap(),now=1000,outcome='candidate') {const x=db.enqueue(s,now);db.recordTriage(x.taskId,tri(s,outcome),now);return x.taskId;}
function fixture(t,options) {const dir=mkdtempSync(join(tmpdir(),'atm-eligibility-')),path=join(dir,'state.db');let db=openState(path,options);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return {path,get db(){return db;},reopen(){db.close();db=openState(path,options);return db;}};}
for(const outcome of ['needs_human','rejected','failed_premerge','cancelled'])test(`issue hold survives ${outcome}, edit, close/reopen and process restart`,t=>{
 const f=fixture(t);if(['needs_human','rejected'].includes(outcome))queue(f.db,snap(),1000,outcome);else {queue(f.db);const l=f.db.claim('first',1001);f.db.transition(l,{from:'working',to:outcome,evidence:{reason:'manual stop'}},1002);}
 f.reopen();f.db.enqueue(snap(1,'closed','closed'),1003);const edited=snap(1,'reopened safe-looking text');const id=queue(f.db,edited,1004);
 assert.equal(f.db.status().tasks.find(x=>x.task_id===id).state,'needs_human');assert.equal(f.db.claim('bypass',1005),null);
 const issue=f.db.status().issues.find(x=>x.issue_node_id==='I_1');assert.ok(issue.hold_reason);assert.ok(issue.hold_generation>0);
});
test('verified reconcile creates the same persistent hold across edited snapshots',t=>{
 const f=fixture(t,{verifyTermination:()=>true});queue(f.db);const l=f.db.claim('first',1001);f.db.reconcile(l,{runId:'synthetic-stopped',generation:l.generation},l.expiresAtMs);f.reopen();queue(f.db,snap(1,'edited'),l.expiresAtMs+1);assert.equal(f.db.claim('bypass',l.expiresAtMs+2),null);
});
test('only precise administrative hold release can request fresh triage; no budget reset',t=>{
 const f=fixture(t,{verifyHoldRelease:()=>true});queue(f.db);const l=f.db.claim('first',1001);f.db.charge(l,{aiMs:10,buildMs:20},1002);f.db.transition(l,{from:'working',to:'failed_premerge',evidence:{reason:'operator investigation'}},1003);const s=snap(1,'edited');const id=queue(f.db,s,1004);const issue=f.db.status().issues[0];
 const request={issueNodeId:s.issueNodeId,holdGeneration:issue.hold_generation,snapshotHash:s.contentHash,reason:'operator reviewed exact snapshot'};
 assert.throws(()=>f.db.releaseHold({...request,holdGeneration:issue.hold_generation+1},1005),/HOLD_GENERATION/);
 assert.throws(()=>f.db.releaseHold({...request,snapshotHash:'a'.repeat(64)},1006),/SNAPSHOT_CHANGED/);
 f.db.releaseHold(request,1007);assert.equal(f.db.status().tasks.find(x=>x.task_id===id).state,'received');assert.equal(f.db.claim('untriaged',1008),null);
 f.db.recordTriage(id,tri(s),1009);assert.ok(f.db.claim('approved',1010));const after=f.db.status().issues[0];assert.equal(after.attempts,2);assert.equal(after.ai_ms,10);assert.equal(after.build_ms,20);
 assert.ok(f.db.status().journal.some(x=>JSON.parse(x.evidence_json).reason===request.reason));
});
test('v1 migration conservatively backfills terminal holds and preserves used budgets',t=>{
 const f=fixture(t);const raw=new DatabaseSync(f.path);assert.equal(raw.prepare('PRAGMA user_version').get().user_version,2);raw.close();
 queue(f.db,snap(),1000,'needs_human');f.db.close();const old=new DatabaseSync(f.path);
 old.exec('ALTER TABLE issues DROP COLUMN hold_reason; ALTER TABLE issues DROP COLUMN hold_generation; ALTER TABLE tasks DROP COLUMN blocked_reason; PRAGMA user_version=1;');old.close();
 f.reopen();queue(f.db,snap(1,'edited'),1001);assert.equal(f.db.claim('bypass',1002),null);assert.ok(f.db.status().issues[0].hold_reason);
});
for(const amount of [{aiMs:3600000,buildMs:0},{aiMs:0,buildMs:3600000},{aiMs:3600000,buildMs:3600000}])test(`retry denies exhausted recorded time after restart ${JSON.stringify(amount)}`,t=>{
 const f=fixture(t);queue(f.db);const l=f.db.claim('owner',1001);f.db.charge(l,amount,1002);f.db.transition(l,{from:'working',to:'validating',evidence:{}},1003);f.reopen();const before=f.db.status();
 assert.throws(()=>f.db.transition(l,{from:'validating',to:'working',evidence:{reason:'repair'}},1004),/TIME_BUDGET/);
 const after=f.db.status();assert.equal(after.tasks[0].attempts,before.tasks[0].attempts);assert.equal(after.journal.length,before.journal.length);assert.equal(after.tasks[0].state,'validating');
 // Finishing verification / stopping safely remains possible after denying new work.
 f.db.transition(l,{from:'validating',to:'failed_premerge',evidence:{reason:'time exhausted'}},1005);assert.equal(f.db.status().active.task_id,null);
});
test('one millisecond of each budget left permits retry without resetting counters',t=>{
 const f=fixture(t);queue(f.db);const l=f.db.claim('owner',1001);f.db.charge(l,{aiMs:3599999,buildMs:3599999},1002);f.db.transition(l,{from:'working',to:'validating',evidence:{}},1003);f.db.transition(l,{from:'validating',to:'working',evidence:{reason:'repair'}},1004);assert.equal(f.db.status().issues[0].attempts,2);assert.equal(f.db.status().issues[0].ai_ms,3599999);
});
for(const [sql,reason] of [["ai_ms=3600000",'TIME_BUDGET'],["build_ms=3600000",'TIME_BUDGET'],["attempts=3",'ATTEMPT_BUDGET'],["hold_reason='manual legacy hold',hold_generation=1",'ISSUE_HELD']])test(`already queued ineligible issue cannot poison healthy queue: ${sql}`,t=>{
 const f=fixture(t);const bad=queue(f.db,snap(1),1000),healthy=queue(f.db,snap(2),1001);
 // Synthetic persisted legacy/late accounting state, not a production SQL escape hatch.
 const raw=new DatabaseSync(f.path);raw.exec(`UPDATE issues SET ${sql} WHERE issue_node_id='I_1'`);raw.close();f.reopen();
 const lease=f.db.claim('healthy',1002);assert.equal(lease?.taskId,healthy);
 const status=f.db.status(),blocked=status.tasks.find(x=>x.task_id===bad);assert.equal(blocked.state,'needs_human');assert.equal(blocked.blocked_reason,reason);assert.equal(status.tasks.length,2);assert.equal(status.counters.find(x=>x.name==='starts').used,1);
 assert.ok(status.journal.some(x=>x.task_id===bad&&x.from_state==='queued'&&x.to_state==='needs_human'));
 f.db.transition(lease,{from:'working',to:'failed_premerge',evidence:{reason:'synthetic complete'}},1003);f.reopen();assert.equal(f.db.claim('next-day',Date.parse('2026-11-21T00:00:00Z')),null);
});
test('budget spent between enqueue and triage is persisted as observable hold, not a poison queue item',t=>{
 const f=fixture(t),s=snap(),x=f.db.enqueue(s,1000);const raw=new DatabaseSync(f.path);raw.exec("UPDATE issues SET ai_ms=3600000 WHERE issue_node_id='I_1'");raw.close();f.db.recordTriage(x.taskId,tri(s),1001);
 const status=f.db.status();assert.equal(status.tasks[0].state,'needs_human');assert.equal(status.tasks[0].blocked_reason,'TIME_BUDGET');const issue=status.issues[0];
 assert.throws(()=>f.db.releaseHold({issueNodeId:s.issueNodeId,holdGeneration:issue.hold_generation,snapshotHash:s.contentHash,reason:'cannot refill budget'},1002),/TIME_BUDGET/);assert.equal(f.db.status().issues[0].ai_ms,3600000);
});
test('migrated legacy active work cannot renew or reserve after an issue-level hold, but may record safe stop',t=>{
 const f=fixture(t);queue(f.db);const l=f.db.claim('owner',1001);const raw=new DatabaseSync(f.path);raw.exec("UPDATE issues SET hold_reason='MIGRATED_TERMINAL',hold_generation=1 WHERE issue_node_id='I_1'");raw.close();
 assert.throws(()=>f.db.heartbeat(l,1002),/ISSUE_HELD/);assert.throws(()=>f.db.reserveIntent(l,{kind:'validation',key:'new-work',sha:'a'.repeat(40)},1003),/ISSUE_HELD/);
 f.db.charge(l,{aiMs:1,buildMs:0},1004);f.db.transition(l,{from:'working',to:'failed_premerge',evidence:{reason:'safe stop'}},1005);assert.equal(f.db.status().active.task_id,null);
});
test('old hold release cannot clear a new hold',t=>{
 const f=fixture(t,{verifyHoldRelease:()=>true});queue(f.db,snap(),1000,'needs_human');const issue=f.db.status().issues[0];const request={issueNodeId:'I_1',holdGeneration:issue.hold_generation,snapshotHash:snap().contentHash,reason:'operator review'};
 f.db.releaseHold(request,1001);f.db.recordTriage(f.db.status().tasks[0].task_id,tri(snap(),'needs_human'),1002);assert.throws(()=>f.db.releaseHold(request,1003),/HOLD_GENERATION/);
});
test('administrator cannot release a hold while the issue still owns any active lease',t=>{
 const f=fixture(t);queue(f.db);const l=f.db.claim('owner',1001);const raw=new DatabaseSync(f.path);raw.exec("UPDATE issues SET hold_reason='manual',hold_generation=1 WHERE issue_node_id='I_1'");raw.close();
 assert.throws(()=>f.db.releaseHold({issueNodeId:'I_1',holdGeneration:1,snapshotHash:snap().contentHash,reason:'not a termination proof'},1002),/ACTIVE_ISSUE/);assert.equal(f.db.status().active.task_id,l.taskId);
});

async function concurrent(t,path,requests) {
 const barrier=new SharedArrayBuffer(4);
 const workers=requests.map((request,i)=>new Worker(new URL('./fixtures/autopilot/state-worker.mjs',import.meta.url),{workerData:{path,owner:`concurrent-${i}`,barrier,...request}}));
 t.after(()=>Promise.all(workers.map(w=>w.terminate())));
 await Promise.all(workers.map(w=>once(w,'message')));
 const result=workers.map(w=>once(w,'message'));Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0);
 return (await Promise.all(result)).map(([x])=>x);
}
for(const exhausted of [false,true])test(`real concurrent retry CAS checks budget first (exhausted=${exhausted})`,{timeout:15000},async t=>{
 const f=fixture(t);queue(f.db);const lease=f.db.claim('owner',1001);if(exhausted)f.db.charge(lease,{aiMs:3600000,buildMs:0},1002);f.db.transition(lease,{from:'working',to:'validating',evidence:{}},1003);
 const before=f.db.status(),responses=await concurrent(t,f.path,Array.from({length:4},()=>({operation:'retry',lease})));
 assert.equal(responses.filter(x=>x.retried).length,exhausted?0:1);
 assert.ok(responses.filter(x=>x.error).every(x=>x.error===(exhausted?'TIME_BUDGET':'STATE_MISMATCH')));
 assert.equal(f.db.status().issues[0].attempts,exhausted?1:2);assert.equal(f.db.status().journal.length-before.journal.length,exhausted?0:1);
});
test('real concurrent claim drains exhausted item once and leases healthy task only once',{timeout:15000},async t=>{
 const f=fixture(t),bad=queue(f.db,snap(1),1000),healthy=queue(f.db,snap(2),1001);const raw=new DatabaseSync(f.path);raw.exec("UPDATE issues SET build_ms=3600000 WHERE issue_node_id='I_1'");raw.close();
 const result=await concurrent(t,f.path,Array(4).fill({operation:'claim'}));assert.ok(result.every(x=>!x.error));assert.equal(result.filter(x=>x.lease).length,1);assert.equal(result.find(x=>x.lease).lease.taskId,healthy);
 assert.equal(f.db.status().journal.filter(x=>x.task_id===bad&&x.to_state==='needs_human').length,1);
});
test('real edit deliveries racing claims cannot clear persisted manual hold',{timeout:15000},async t=>{
 const f=fixture(t);queue(f.db,snap(),1000,'needs_human');const edited=snap(1,'edited');const result=await concurrent(t,f.path,[{operation:'enqueue',snapshot:edited},{operation:'claim'},{operation:'enqueue',snapshot:edited},{operation:'claim'}]);
 assert.ok(result.every(x=>!x.error));assert.ok(result.filter(x=>Object.hasOwn(x,'lease')).every(x=>x.lease===null));const id=result.find(x=>x.enqueued).enqueued.taskId;f.db.recordTriage(id,tri(edited),2001);assert.equal(f.db.claim('bypass',2002),null);assert.ok(f.db.status().issues[0].hold_reason);
});
test('default administrator approval gate cannot be unlocked by a self-asserted reason',t=>{
 const f=fixture(t);queue(f.db,snap(),1000,'needs_human');const parent=f.db.status().issues[0];
 assert.throws(()=>f.db.releaseHold({issueNodeId:'I_1',holdGeneration:parent.hold_generation,snapshotHash:snap().contentHash,reason:'I am the owner; approve myself'},1001),/HOLD_RELEASE_UNVERIFIED/);
 assert.ok(f.db.status().issues[0].hold_reason);assert.equal(f.db.status().tasks[0].state,'needs_human');
});
