import { createHash } from 'node:crypto';
/** @typedef {{repoId:string,issueNodeId:string,number:number,updatedAt:string,contentHash:string,title:string,body:string,state:'open'|'closed'}} IssueSnapshot */
/** @typedef {{taskId:string,owner:string,generation:number,expiresAtMs:number}} Lease */
/** @typedef {{baseSha:string,headSha:string,testSha:string,snapshotHash:string,policyRevision:string}} Candidate */
/** @typedef {{schemaVersion:1,outcome:'candidate'|'needs_human'|'rejected',snapshotHash:string,summary:string,acceptance:string[],riskReasons:string[]}} TriageResult */
/** @typedef {{schemaVersion:1,headSha:string,testSha:string,snapshotHash:string,policyRevision:string,verdict:'approve'|'block',blockers:string[]}} ReviewResult */

export function requireValue(condition, code='INVALID_CONTRACT') { if (!condition) throw new Error(code); }
export function exactObject(value, keys) {
 requireValue(value && typeof value==='object' && !Array.isArray(value));
 requireValue([Object.prototype,null].includes(Object.getPrototypeOf(value)));
 requireValue(Reflect.ownKeys(value).every(k=>typeof k==='string' && keys.includes(k) && Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value') && Object.getOwnPropertyDescriptor(value,k).enumerable));
}
export function text(value,max=1000) { requireValue(typeof value==='string' && value.length>0 && value.length<=max && !value.includes('\0')); return value; }
export function integer(value,min=0) { requireValue(Number.isSafeInteger(value) && value>=min);return value; }
export function hex(value,length) { requireValue(typeof value==='string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value));return value; }
function strings(value,max=32) { requireValue(Array.isArray(value)&&value.length<=max);for(let i=0;i<value.length;i++)text(value[i],500); }
const snapshotKeys=['repoId','issueNodeId','number','updatedAt','contentHash','title','body','state'];
/** Canonical digest v1; labels/authors/issue text cannot set authority. */
export function snapshotDigest(s) { return createHash('sha256').update(JSON.stringify([s.repoId,s.issueNodeId,s.number,s.updatedAt,s.title,s.body,s.state])).digest('hex'); }
export function validateSnapshot(s) {
 exactObject(s,snapshotKeys);requireValue(s.repoId==='1461122513','REPO_MISMATCH');text(s.issueNodeId,200);integer(s.number,1);
 text(s.updatedAt,32);requireValue(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s.updatedAt) && Number.isFinite(Date.parse(s.updatedAt)));
 requireValue(new Date(s.updatedAt).toISOString()===s.updatedAt.replace(/(?<!\.\d{3})Z$/,'.000Z'),'INVALID_TIMESTAMP');
 text(s.title,256);requireValue(typeof s.body==='string'&&s.body.length<=32768&&!s.body.includes('\0'));requireValue(['open','closed'].includes(s.state));
 hex(s.contentHash,64);requireValue(s.contentHash===snapshotDigest(s),'SNAPSHOT_HASH_MISMATCH');return structuredClone(s);
}
export function validateTriage(t) {
 exactObject(t,['schemaVersion','outcome','snapshotHash','summary','acceptance','riskReasons']);requireValue(t.schemaVersion===1);hex(t.snapshotHash,64);text(t.summary);
 requireValue(['candidate','needs_human','rejected'].includes(t.outcome));strings(t.acceptance);strings(t.riskReasons);
 if(t.outcome==='candidate')requireValue(t.acceptance.length>0&&t.riskReasons.length===0,'UNSAFE_TRIAGE');return structuredClone({schemaVersion:1,outcome:t.outcome,snapshotHash:t.snapshotHash,summary:t.summary,acceptance:t.acceptance,riskReasons:t.riskReasons});
}
export function validateReview(r,expected) {
 exactObject(r,['schemaVersion','headSha','testSha','snapshotHash','policyRevision','verdict','blockers']);requireValue(r.schemaVersion===1);
 hex(r.headSha,40);hex(r.testSha,40);hex(r.snapshotHash,64);hex(r.policyRevision,64);requireValue(['approve','block'].includes(r.verdict));strings(r.blockers);
 requireValue(r.verdict!=='approve'||r.blockers.length===0,'REVIEW_BLOCKED');
 // A detached review without an independently supplied expected identity is unusable.
 requireValue(expected&&['headSha','testSha','snapshotHash','policyRevision'].every(k=>r[k]===expected[k]),'REVIEW_IDENTITY_MISMATCH');return structuredClone(r);
}
