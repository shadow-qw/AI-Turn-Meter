import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { openState } from '../tools/autopilot/state.mjs';
import { snapshotDigest } from '../tools/autopilot/contracts.mjs';
function snapshot(number=1,body='fix text') { const s={repoId:'1461122513',issueNodeId:`I_${number}`,number,updatedAt:'2026-11-20T00:00:00Z',title:'typo',body,state:'open'};return {...s,contentHash:snapshotDigest(s)}; }
function queued(db,number=1,now=1000,body='fix text') { const s=snapshot(number,body),x=db.enqueue(s,now);db.recordTriage(x.taskId,{schemaVersion:1,outcome:'candidate',snapshotHash:s.contentHash,summary:'typo',acceptance:['text matches'],riskReasons:[]},now);return x.taskId; }
function fixture(t,options) { const dir=mkdtempSync(join(tmpdir(),'atm-state-'));const path=join(dir,'state.db');let db=openState(path,options);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return {path,get db(){return db;},reopen(){db.close();db=openState(path,options);return db;}}; }
test('dedupe and one active lease survive restart',t=>{ const f=fixture(t),s=snapshot();const id=queued(f.db);assert.deepEqual(f.db.enqueue(s,1000),{taskId:id,inserted:false});const lease=f.db.claim('one',1001);assert.equal(lease.taskId,id);f.reopen();assert.equal(f.db.claim('two',1002),null);assert.equal(f.db.status().tasks.length,1); });
async function race(t,path,payload={}) {
 const barrier=new SharedArrayBuffer(4),workers=Array.from({length:4},(_,i)=>new Worker(new URL('./fixtures/autopilot/state-worker.mjs',import.meta.url),{workerData:{path,owner:`worker-${i}`,barrier,...payload}}));
 t.after(()=>Promise.all(workers.map(w=>w.terminate())));
 await Promise.all(workers.map(w=>once(w,'message')));
 const results=workers.map(w=>once(w,'message'));Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0);
 const values=(await Promise.all(results)).map(([x])=>x);assert.ok(values.every(x=>!x.error),JSON.stringify(values));return values;
}
test('four real concurrent SQLite connections cannot claim two tasks',{timeout:15000},async t=>{
 const f=fixture(t);queued(f.db,1);queued(f.db,2);
 const values=await race(t,f.path);assert.equal(values.filter(x=>x.lease).length,1);
});
test('four real concurrent deliveries dedupe one snapshot atomically',{timeout:15000},async t=>{
 const f=fixture(t);const values=await race(t,f.path,{operation:'enqueue',snapshot:snapshot()});
 assert.equal(values.filter(x=>x.enqueued.inserted).length,1);assert.equal(new Set(values.map(x=>x.enqueued.taskId)).size,1);assert.equal(f.db.status().tasks.length,1);
});
test('expired lease cannot write, renew, reclaim or travel backward in time',t=>{ const {db}=fixture(t);queued(db);const l=db.claim('old',1001);const expiry=l.expiresAtMs;assert.throws(()=>db.heartbeat(l,expiry),/LEASE_EXPIRED/);assert.throws(()=>db.heartbeat(l,expiry-1),/CLOCK_REGRESSION/);assert.equal(db.claim('new',expiry+1),null);assert.throws(()=>db.transition(l,{from:'working',to:'validating',evidence:{}},expiry+2),/LEASE_EXPIRED/);assert.throws(()=>db.reconcile(l,{runId:'run'},expiry+3),/TERMINATION_UNVERIFIED/); });
test('reconcile needs trusted termination adapter; recovery fences previous owner',t=>{
 const {db}=fixture(t,{verifyTermination:(e,l)=>e.runId==='synthetic-stopped'&&e.generation===l.generation});queued(db,1);queued(db,2);const old=db.claim('old',1001);
 db.reconcile(old,{runId:'synthetic-stopped',generation:old.generation},old.expiresAtMs);const fresh=db.claim('new',old.expiresAtMs+1);assert.ok(fresh.generation>old.generation);
 for(const fn of [()=>db.heartbeat(old,old.expiresAtMs+2),()=>db.reserveIntent(old,{kind:'pr',key:'stale',sha:'a'.repeat(40)},old.expiresAtMs+2),()=>db.completeIntent(old,'anything',{},old.expiresAtMs+2),()=>db.charge(old,{aiMs:1,buildMs:0},old.expiresAtMs+2),()=>db.transition(old,{from:'working',to:'validating',evidence:{}},old.expiresAtMs+2)])assert.throws(fn,/STALE_LEASE/);
 assert.equal(db.status().tasks.find(x=>x.task_id===old.taskId).state,'needs_human');
});
test('pause gates every task mutation and never releases active lease',t=>{
 const {db}=fixture(t);const id=queued(db),s=snapshot(2),lease=db.claim('owner',1001);db.pause('operator inspection',1002);
 for(const fn of [()=>db.enqueue(s,1003),()=>db.recordTriage(id,{},1003),()=>db.claim('other',1003),()=>db.heartbeat(lease,1003),()=>db.transition(lease,{from:'working',to:'validating',evidence:{}},1003),()=>db.reserveIntent(lease,{kind:'pr',key:'x',sha:'a'.repeat(40)},1003),()=>db.charge(lease,{aiMs:1,buildMs:1},1003),()=>db.completeIntent(lease,'anything',{},1003)])assert.throws(fn,/PAUSED/);
 assert.equal(db.status().active.task_id,lease.taskId);db.resume('operator reviewed',1004);assert.ok(db.heartbeat(lease,1005));
});
test('snapshot edits invalidate running evidence but do not silently free lease',t=>{
 const {db}=fixture(t);queued(db);const l=db.claim('owner',1001);db.enqueue(snapshot(1,'new instructions'),1002);assert.throws(()=>db.heartbeat(l,1003),/SNAPSHOT_CHANGED/);assert.equal(db.claim('other',1004),null);
});
test('fenced intents dedupe across restart and reject same key different SHA',t=>{
 const f=fixture(t);queued(f.db);const l=f.db.claim('owner',1001),spec={kind:'pr',key:'issue-1:pr',sha:'a'.repeat(40)};const x=f.db.reserveIntent(l,spec,1002);assert.equal(x.exists,false);f.reopen();assert.deepEqual(f.db.reserveIntent(l,spec,1003),{id:x.id,exists:true});assert.throws(()=>f.db.reserveIntent(l,{...spec,sha:'b'.repeat(40)},1004),/INTENT_CONFLICT/);
 f.db.completeIntent(l,x.id,{externalId:'42'},1005);assert.deepEqual(f.db.status().intents[0].result,{externalId:'42'});assert.throws(()=>f.db.completeIntent(l,x.id,{externalId:'43'},1006),/INTENT_CONFLICT/);
 assert.throws(()=>f.db.reserveIntent(l,{kind:'release',key:'v0.3.0-rc.1',sha:spec.sha},1007),/EXTERNAL_GATE_UNIMPLEMENTED/);
});
test('transition CAS rollback, retry budget across edits and cumulative time are enforced',t=>{
 const {db}=fixture(t);queued(db);const l=db.claim('owner',1001);
 assert.throws(()=>db.transition(l,{from:'review',to:'working',evidence:{}},1002),/STATE_MISMATCH/);
 db.charge(l,{aiMs:3600000,buildMs:3600000},1003);assert.throws(()=>db.charge(l,{aiMs:1,buildMs:0},1004),/TIME_BUDGET/);
 assert.equal(db.status().tasks[0].ai_elapsed_ms,3600000);
});
test('initial plus two retries only, even after editing snapshot',t=>{
 const {db}=fixture(t);queued(db);const l=db.claim('owner',1001);
 for(let i=0;i<2;i++){db.transition(l,{from:'working',to:'validating',evidence:{}},1010+i*2);db.transition(l,{from:'validating',to:'working',evidence:{reason:'test failure'}},1011+i*2);}
 db.transition(l,{from:'working',to:'validating',evidence:{}},1020);assert.throws(()=>db.transition(l,{from:'validating',to:'working',evidence:{reason:'again'}},1021),/ATTEMPT_BUDGET/);
 db.transition(l,{from:'validating',to:'failed_premerge',evidence:{reason:'budget exhausted'}},1022);assert.equal(db.status().tasks.find(x=>x.task_id===l.taskId).state,'needs_human');
 const s=snapshot(1,'edited');const x=db.enqueue(s,1023);assert.throws(()=>db.recordTriage(x.taskId,{schemaVersion:1,outcome:'candidate',snapshotHash:s.contentHash,summary:'retry',acceptance:['test'],riskReasons:[]},1024),/ATTEMPT_BUDGET/);
});
test('daily start cap uses Shanghai dates and rejected claims do not consume slots',t=>{
 const {db}=fixture(t);const before=Date.parse('2026-11-20T15:59:00Z');for(let i=1;i<=4;i++)queued(db,i,before);
 for(let i=0;i<3;i++){const l=db.claim(`owner-${i}`,before+i);db.transition(l,{from:'working',to:'failed_premerge',evidence:{reason:'synthetic'}},before+i);}
 assert.throws(()=>db.claim('four',before+5),/DAILY_BUDGET/);assert.ok(db.claim('next-day',Date.parse('2026-11-20T16:00:00Z')));
});
test('triage quota, closed snapshots and future schemas fail closed',t=>{
 const {db}=fixture(t);for(let i=1;i<=50;i++)queued(db,i,1000);assert.throws(()=>queued(db,51,1001),/DAILY_BUDGET/);
 const f=fixture(t);f.db.close();const raw=new DatabaseSync(f.path);raw.exec('PRAGMA user_version=2');raw.close();chmodSync(f.path,0o600);assert.throws(()=>openState(f.path),/SCHEMA_VERSION/);
});
test('pause/resume and verified recovery retain bounded audit references',t=>{
 const {db}=fixture(t,{verifyTermination:()=>true});queued(db);const l=db.claim('owner',1001);db.pause('manual check',1002);db.resume('manual resume',1003);
 db.reconcile(l,{runId:'synthetic-stopped',generation:l.generation},l.expiresAtMs);
 const journal=db.status().journal;assert.ok(journal.some(x=>x.to_state==='paused'));assert.ok(journal.some(x=>x.from_state==='paused'));
 assert.equal(JSON.parse(journal.at(-1).evidence_json).runId,'synthetic-stopped');
});
test('recovery must bind generation even if a future verifier wrongly returns true',t=>{
 const {db}=fixture(t,{verifyTermination:()=>true});queued(db);const l=db.claim('owner',1001);
 assert.throws(()=>db.reconcile(l,{runId:'synthetic-stopped',generation:l.generation+1},l.expiresAtMs),/RECOVERY_EVIDENCE_MISMATCH/);
 assert.equal(db.status().active.task_id,l.taskId);
});
test('closed issues never become candidates and elapsed budgets survive edited task records',t=>{
 const {db}=fixture(t);const s=snapshot();s.state='closed';s.contentHash=snapshotDigest(s);const x=db.enqueue(s,1000);
 assert.throws(()=>db.recordTriage(x.taskId,{schemaVersion:1,outcome:'candidate',snapshotHash:s.contentHash,summary:'closed',acceptance:['test'],riskReasons:[]},1001),/SNAPSHOT_CLOSED/);
 const f=fixture(t);queued(f.db);const l=f.db.claim('owner',1001);f.db.charge(l,{aiMs:3600000,buildMs:0},1002);f.db.transition(l,{from:'working',to:'failed_premerge',evidence:{reason:'done'}},1003);queued(f.db,1,1004,'edited');assert.throws(()=>f.db.claim('other',1005),/TIME_BUDGET/);
});
test('reordered duplicate triage is idempotent and does not spend daily quota twice',t=>{
 const {db}=fixture(t),s=snapshot(),x=db.enqueue(s,1000);
 const first={schemaVersion:1,outcome:'candidate',snapshotHash:s.contentHash,summary:'typo',acceptance:['test'],riskReasons:[]};db.recordTriage(x.taskId,first,1001);
 const reordered=Object.fromEntries(Object.entries(first).reverse());assert.doesNotThrow(()=>db.recordTriage(x.taskId,reordered,1002));
 assert.equal(db.status().counters.find(x=>x.name==='triages').used,1);
});
