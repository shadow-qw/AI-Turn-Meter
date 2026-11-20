import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { policy } from './policy.mjs';
import { validateSnapshot, validateTriage, exactObject, requireValue as check, text, integer, hex } from './contracts.mjs';
const terminal=new Set(['needs_human','rejected','cancelled','failed_premerge']);
const edges={working:['validating','needs_human','cancelled','failed_premerge'],validating:['review','working','needs_human','cancelled','failed_premerge'],review:['merge_ready','working','needs_human','cancelled','failed_premerge'],merge_ready:['needs_human','cancelled','failed_premerge']};
const day=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
/** Offline trusted-control-plane library. No ingress, process launch or GitHub writes. */
export function openState(path,{verifyTermination=()=>false,verifyHoldRelease=()=>false}={}) {
 check(typeof verifyTermination==='function'&&typeof verifyHoldRelease==='function');
 if(path!==':memory:') {
  check(typeof path==='string'&&isAbsolute(path),'STATE_PATH');
  try { closeSync(openSync(path,'wx',0o600)); } catch(error) { if(error.code!=='EEXIST')throw error; }
  const stat=lstatSync(path);check(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&stat.uid===process.getuid(),'STATE_PERMISSIONS');
 }
 const db=new DatabaseSync(path);let closed=false;
 const get=(sql,...args)=>db.prepare(sql).get(...args), all=(sql,...args)=>db.prepare(sql).all(...args), run=(sql,...args)=>db.prepare(sql).run(...args);
 try {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
  const version=get('PRAGMA user_version').user_version;check([0,1,2].includes(version),'SCHEMA_VERSION');
  if(version===0) db.exec(`
   CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   INSERT INTO metadata VALUES('paused','0'),('clock','0'),('pause_reason','');
   CREATE TABLE issues(issue_node_id TEXT PRIMARY KEY,latest_hash TEXT NOT NULL,updated_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,ai_ms INTEGER NOT NULL DEFAULT 0,build_ms INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE tasks(task_id TEXT PRIMARY KEY,issue_node_id TEXT NOT NULL REFERENCES issues(issue_node_id),snapshot_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,state TEXT NOT NULL,triage_json TEXT,created_ms INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,ai_elapsed_ms INTEGER NOT NULL DEFAULT 0,build_elapsed_ms INTEGER NOT NULL DEFAULT 0,UNIQUE(issue_node_id,snapshot_hash));
   CREATE TABLE singleton_lock(id INTEGER PRIMARY KEY CHECK(id=1),task_id TEXT,owner TEXT,generation INTEGER NOT NULL,expires_at_ms INTEGER);
   INSERT INTO singleton_lock VALUES(1,NULL,NULL,0,NULL);
   CREATE TABLE intents(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,kind TEXT NOT NULL,intent_key TEXT UNIQUE NOT NULL,sha TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT);
   CREATE TABLE journal(seq INTEGER PRIMARY KEY,task_id TEXT,at_ms INTEGER NOT NULL,from_state TEXT,to_state TEXT,generation INTEGER,evidence_json TEXT NOT NULL);
   CREATE TABLE counters(day_shanghai TEXT NOT NULL,name TEXT NOT NULL,used INTEGER NOT NULL,PRIMARY KEY(day_shanghai,name));
   PRAGMA user_version=1;`);
  if(version<2) {
   db.exec(`ALTER TABLE issues ADD COLUMN hold_reason TEXT;
    ALTER TABLE issues ADD COLUMN hold_generation INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;
    UPDATE issues SET hold_reason='MIGRATED_TERMINAL',hold_generation=1
      WHERE EXISTS(SELECT 1 FROM tasks t WHERE t.issue_node_id=issues.issue_node_id
        AND t.state IN ('needs_human','rejected','failed_premerge','cancelled'));
    PRAGMA user_version=2;`);
  }
  db.exec('COMMIT');
 } catch(error) {try{db.exec('ROLLBACK');}catch{}db.close();throw error;}
 function meta(key) {return get('SELECT value FROM metadata WHERE key=?',key).value;}
 // Persist high-water clock even on rejected operations. Savepoint rolls back all
 // task changes, not the clock, so a rejected expired write cannot be backdated.
 function tx(now,fn,{admin=false}={}) {
  integer(now);
  check(Number.isFinite(new Date(now).getTime()),'INVALID_TIME');
  db.exec('BEGIN IMMEDIATE');
  try {
   check(now>=Number(meta('clock')),'CLOCK_REGRESSION');
   run("UPDATE metadata SET value=? WHERE key='clock'",String(now));
   db.exec('SAVEPOINT operation');
   try {
    check(admin||meta('paused')==='0','PAUSED');
    const result=fn();
    db.exec('RELEASE operation; COMMIT');
    return result;
   } catch(error) {
    db.exec('ROLLBACK TO operation; RELEASE operation; COMMIT');
    throw error;
   }
  } catch(error) {
   try {db.exec('ROLLBACK');} catch {}
   throw error;
  }
 }
 function journal(id,from,to,now,generation=null,evidence={}) {run('INSERT INTO journal(task_id,at_ms,from_state,to_state,generation,evidence_json) VALUES(?,?,?,?,?,?)',id,now,from,to,generation,JSON.stringify(evidence));}
 function budget(name,limit,now) {const date=day(now),old=get('SELECT used FROM counters WHERE day_shanghai=? AND name=?',date,name)?.used??0;check(old<limit,'DAILY_BUDGET');run('INSERT INTO counters VALUES(?,?,1) ON CONFLICT(day_shanghai,name) DO UPDATE SET used=used+1',date,name);}
 function task(id) {text(id,100);const t=get('SELECT * FROM tasks WHERE task_id=?',id);check(t,'TASK_NOT_FOUND');return t;}
 function issue(id) {return get('SELECT * FROM issues WHERE issue_node_id=?',id);}
 function eligibility(row) {
  if(row.hold_reason)return 'ISSUE_HELD';
  if(row.attempts>=policy.limits.attemptsPerIssue)return 'ATTEMPT_BUDGET';
  if(row.ai_ms>=policy.limits.aiMs||row.build_ms>=policy.limits.buildMs)return 'TIME_BUDGET';
  return null;
 }
 function holdIssue(id,reason) {
  run(`UPDATE issues SET hold_generation=hold_generation+CASE WHEN hold_reason IS NULL THEN 1 ELSE 0 END,
    hold_reason=COALESCE(hold_reason,?) WHERE issue_node_id=?`,reason,id);
  return issue(id).hold_generation;
 }
 function leaseRow(lease,now,{allowExpired=false}={}) {
  exactObject(lease,['taskId','owner','generation','expiresAtMs']);text(lease.taskId,100);text(lease.owner,100);integer(lease.generation,1);integer(lease.expiresAtMs);
  const lock=get('SELECT * FROM singleton_lock WHERE id=1');check(lock.task_id===lease.taskId&&lock.owner===lease.owner&&lock.generation===lease.generation,'STALE_LEASE');
  check(allowExpired||now<lock.expires_at_ms,'LEASE_EXPIRED');return lock;
 }
 function active(lease,now,{allowHeld=false}={}) {
  const lock=leaseRow(lease,now);
  const t=task(lease.taskId);
  const parent=issue(t.issue_node_id);
  check(parent.latest_hash===t.snapshot_hash,'SNAPSHOT_CHANGED');
  check(allowHeld||!parent.hold_reason,'ISSUE_HELD');
  return {lock,t};
 }
 const value=lock=>({taskId:lock.task_id,owner:lock.owner,generation:lock.generation,expiresAtMs:lock.expires_at_ms});
 function release() {run('UPDATE singleton_lock SET task_id=NULL,owner=NULL,expires_at_ms=NULL,generation=generation+1 WHERE id=1');}
 return {
  enqueue(snapshot,now) {return tx(now,()=>{
   const s=validateSnapshot(snapshot),old=get('SELECT task_id FROM tasks WHERE issue_node_id=? AND snapshot_hash=?',s.issueNodeId,s.contentHash);if(old)return {taskId:old.task_id,inserted:false};
   const issue=get('SELECT updated_at FROM issues WHERE issue_node_id=?',s.issueNodeId);check(!issue||Date.parse(s.updatedAt)>=Date.parse(issue.updated_at),'STALE_SNAPSHOT');
   run('INSERT INTO issues(issue_node_id,latest_hash,updated_at) VALUES(?,?,?) ON CONFLICT(issue_node_id) DO UPDATE SET latest_hash=excluded.latest_hash,updated_at=excluded.updated_at',s.issueNodeId,s.contentHash,s.updatedAt);
   const id=randomUUID();run('INSERT INTO tasks(task_id,issue_node_id,snapshot_hash,snapshot_json,state,created_ms) VALUES(?,?,?,?,?,?)',id,s.issueNodeId,s.contentHash,JSON.stringify(s),'received',now);journal(id,null,'received',now);return {taskId:id,inserted:true};
  });},
  recordTriage(id,result,now) {return tx(now,()=>{
   const t=task(id);
   const r=validateTriage(result);
   const snapshot=JSON.parse(t.snapshot_json);
   check(r.snapshotHash===t.snapshot_hash,'SNAPSHOT_HASH_MISMATCH');
   if(t.triage_json===JSON.stringify(r))return;
   check(t.state==='received','STATE_MISMATCH');
   const parent=issue(t.issue_node_id);
   check(parent.latest_hash===t.snapshot_hash,'SNAPSHOT_CHANGED');
   let reason=null;
   if(r.outcome==='candidate') {
    check(snapshot.state==='open','SNAPSHOT_CLOSED');
    reason=eligibility(parent);
   }
   budget('triages',policy.limits.triagesPerDay,now);
   const next=r.outcome==='candidate'?(reason?'needs_human':'queued'):r.outcome;
   let holdGeneration=null;
   if(terminal.has(next))holdGeneration=holdIssue(t.issue_node_id,reason??`TRIAGE_${r.outcome.toUpperCase()}`);
   run('UPDATE tasks SET state=?,triage_json=?,blocked_reason=? WHERE task_id=?',next,JSON.stringify(r),reason,id);
   journal(id,t.state,next,now,null,{reason,holdGeneration});
  });},
  claim(owner,now) {return tx(now,()=>{
   text(owner,100);
   if(get('SELECT task_id FROM singleton_lock WHERE id=1').task_id!==null)return null;
   // Every rejected queue item becomes durable manual work. Each iteration
   // removes one queued item, so this scan makes progress rather than retrying it.
   while(true) {
    const t=get(`SELECT t.* FROM tasks t JOIN issues i ON t.issue_node_id=i.issue_node_id
      WHERE t.state='queued' AND t.snapshot_hash=i.latest_hash
      ORDER BY t.created_ms,t.task_id LIMIT 1`);
    if(!t)return null;
    const parent=issue(t.issue_node_id);
    const reason=eligibility(parent);
    if(reason) {
     const holdGeneration=holdIssue(t.issue_node_id,reason);
     run("UPDATE tasks SET state='needs_human',blocked_reason=? WHERE task_id=?",reason,t.task_id);
     journal(t.task_id,'queued','needs_human',now,null,{reason,holdGeneration});
     continue;
    }
    budget('starts',policy.limits.startsPerDay,now);
    run('UPDATE issues SET attempts=attempts+1 WHERE issue_node_id=?',t.issue_node_id);
    run("UPDATE tasks SET state='working',attempts=? WHERE task_id=?",parent.attempts+1,t.task_id);
    run(`UPDATE singleton_lock SET task_id=?,owner=?,generation=generation+1,
      expires_at_ms=? WHERE id=1`,t.task_id,owner,now+policy.limits.leaseMs);
    const lock=get('SELECT * FROM singleton_lock WHERE id=1');
    journal(t.task_id,'queued','working',now,lock.generation);
    return value(lock);
   }
  });},
  heartbeat(lease,now) {return tx(now,()=>{active(lease,now);run('UPDATE singleton_lock SET expires_at_ms=? WHERE id=1',now+policy.limits.leaseMs);return value(get('SELECT * FROM singleton_lock WHERE id=1'));});},
  transition(lease,change,now) {return tx(now,()=>{
   const {t}=active(lease,now,{allowHeld:terminal.has(change?.to)});
   exactObject(change,['from','to','evidence']);
   check(t.state===change.from,'STATE_MISMATCH');
   check(edges[t.state]?.includes(change.to),'TRANSITION_DENIED');
   exactObject(change.evidence,['reason','baseSha','headSha','testSha','snapshotHash','policyRevision','runId']);
   for(const [key,v] of Object.entries(change.evidence)) {
    if(key.endsWith('Sha'))hex(v,40);
    else if(['snapshotHash','policyRevision'].includes(key))hex(v,64);
    else text(v,500);
   }
   if(change.to==='working') {
    const parent=issue(t.issue_node_id);
    const reason=eligibility(parent);
    check(!reason,reason);
    text(change.evidence.reason,500);
    run('UPDATE issues SET attempts=attempts+1 WHERE issue_node_id=?',t.issue_node_id);
    run('UPDATE tasks SET attempts=? WHERE task_id=?',parent.attempts+1,t.task_id);
   }
   const exhausted=issue(t.issue_node_id).attempts>=policy.limits.attemptsPerIssue;
   const next=change.to==='failed_premerge'&&exhausted?'needs_human':change.to;
   run('UPDATE tasks SET state=? WHERE task_id=?',next,t.task_id);
   journal(t.task_id,t.state,next,now,lease.generation,change.evidence);
   if(terminal.has(next)) {
    holdIssue(t.issue_node_id,`TERMINAL_${next.toUpperCase()}`);
    release();
   }
  });},
  charge(lease,amount,now) {return tx(now,()=>{
   const {t}=active(lease,now,{allowHeld:true});
   exactObject(amount,['aiMs','buildMs']);
   integer(amount.aiMs);
   integer(amount.buildMs);
   const parent=issue(t.issue_node_id);
   check(parent.ai_ms+amount.aiMs<=policy.limits.aiMs&&
     parent.build_ms+amount.buildMs<=policy.limits.buildMs,'TIME_BUDGET');
   run('UPDATE issues SET ai_ms=ai_ms+?,build_ms=build_ms+? WHERE issue_node_id=?',
     amount.aiMs,amount.buildMs,t.issue_node_id);
   run('UPDATE tasks SET ai_elapsed_ms=ai_elapsed_ms+?,build_elapsed_ms=build_elapsed_ms+? WHERE task_id=?',
     amount.aiMs,amount.buildMs,t.task_id);
  });},
  reserveIntent(lease,spec,now) {return tx(now,()=>{
   active(lease,now);exactObject(spec,['kind','key','sha']);check(['pr','validation'].includes(spec.kind),'EXTERNAL_GATE_UNIMPLEMENTED');text(spec.key,200);hex(spec.sha,40);const key=`${spec.kind}:${spec.key}`,old=get('SELECT * FROM intents WHERE intent_key=?',key);
   if(old){check(old.task_id===lease.taskId&&old.sha===spec.sha,'INTENT_CONFLICT');return {id:old.id,exists:true};}
   const id=randomUUID();run('INSERT INTO intents(id,task_id,kind,intent_key,sha,status) VALUES(?,?,?,?,?,?)',id,lease.taskId,spec.kind,key,spec.sha,'reserved');return {id,exists:false};
  });},
  completeIntent(lease,id,result,now) {return tx(now,()=>{
   active(lease,now,{allowHeld:true});exactObject(result,['externalId']);text(result.externalId,100);const old=get('SELECT * FROM intents WHERE id=?',text(id,100));check(old&&old.task_id===lease.taskId,'INTENT_CONFLICT');const json=JSON.stringify(result);check(old.status!=='complete'||old.result_json===json,'INTENT_CONFLICT');run("UPDATE intents SET status='complete',result_json=? WHERE id=?",json,id);
  });},
  reconcile(lease,evidence,now) {return tx(now,()=>{
   const lock=leaseRow(lease,now,{allowExpired:true});
   check(now>=lock.expires_at_ms,'LEASE_NOT_EXPIRED');
   // Pinned trusted code must verify the actual old execution; never an Issue flag.
   check(verifyTermination(structuredClone(evidence),structuredClone(lease))===true,'TERMINATION_UNVERIFIED');
   exactObject(evidence,['runId','generation','digest']);
   text(evidence.runId,100);
   check(evidence.generation===lease.generation,'RECOVERY_EVIDENCE_MISMATCH');
   if(evidence.digest!==undefined)hex(evidence.digest,64);
   const t=task(lease.taskId);
   holdIssue(t.issue_node_id,'RECOVERY_REQUIRES_HUMAN');
   run("UPDATE tasks SET state='needs_human' WHERE task_id=?",t.task_id);
   journal(t.task_id,t.state,'needs_human',now,lease.generation,
     {reason:'trusted termination confirmed',...evidence});
   release();
  },{admin:true});},
  pause(reason,now) {return tx(now,()=>{text(reason,500);run("UPDATE metadata SET value='1' WHERE key='paused'");run("UPDATE metadata SET value=? WHERE key='pause_reason'",reason);journal(null,'running','paused',now,null,{reason});},{admin:true});},
  resume(reason,now) {return tx(now,()=>{text(reason,500);run("UPDATE metadata SET value='0' WHERE key='paused'");run("UPDATE metadata SET value=? WHERE key='pause_reason'",reason);journal(null,'paused','running',now,null,{reason});},{admin:true});},
  // Trusted administrative API only; no ingress/Issue can invoke this operation.
  releaseHold(request,now) {return tx(now,()=>{
   exactObject(request,['issueNodeId','holdGeneration','snapshotHash','reason']);
   text(request.issueNodeId,200);integer(request.holdGeneration,1);hex(request.snapshotHash,64);text(request.reason,500);
   const parent=issue(request.issueNodeId);
   check(parent&&parent.hold_reason,'ISSUE_NOT_HELD');
   check(parent.hold_generation===request.holdGeneration,'HOLD_GENERATION');
   check(parent.latest_hash===request.snapshotHash,'SNAPSHOT_CHANGED');
   const lock=get('SELECT task_id FROM singleton_lock WHERE id=1');
   check(!lock.task_id||task(lock.task_id).issue_node_id!==request.issueNodeId,'ACTIVE_ISSUE');
   const ineligible=eligibility({...parent,hold_reason:null});
   check(!ineligible,ineligible);
   // A reason or caller-controlled flag is not owner approval. The trusted,
   // read-only adapter must verify out-of-band approval bound to this tuple.
   check(verifyHoldRelease(structuredClone(request))===true,'HOLD_RELEASE_UNVERIFIED');
   run('UPDATE issues SET hold_reason=NULL,hold_generation=hold_generation+1 WHERE issue_node_id=?',request.issueNodeId);
   const latest=get('SELECT * FROM tasks WHERE issue_node_id=? AND snapshot_hash=?',request.issueNodeId,request.snapshotHash);
   check(latest&&terminal.has(latest.state),'STATE_MISMATCH');
   run("UPDATE tasks SET state='received',triage_json=NULL,blocked_reason=NULL WHERE task_id=?",latest.task_id);
   journal(latest.task_id,latest.state,'received',now,null,{...request,administrative:true});
  },{admin:true});},
  status() {
   return {
    schemaVersion:1,
    paused:meta('paused')==='1',
    reason:meta('pause_reason'),
    active:get('SELECT * FROM singleton_lock WHERE id=1'),
    issues:all('SELECT * FROM issues'),
    tasks:all(`SELECT task_id,issue_node_id,snapshot_hash,state,blocked_reason,
      attempts,ai_elapsed_ms,build_elapsed_ms FROM tasks`),
    intents:all('SELECT * FROM intents').map(x=>({...x,result:x.result_json?JSON.parse(x.result_json):null})),
    counters:all('SELECT * FROM counters'),
    journal:all('SELECT * FROM journal')
   };
  },
  close() {if(!closed){db.close();closed=true;}}
 };
}
