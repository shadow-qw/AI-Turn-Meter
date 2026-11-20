import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
test('publication checkpoint cannot execute a synthetic driver under any external approval',()=>{
 const w=JSON.parse(readFileSync(new URL('../.github/workflows/autopilot-synthetic.yml',import.meta.url)));
 assert.deepEqual(w.permissions,{contents:'read'});
 assert.deepEqual(Object.keys(w.jobs),['publication-no-diagnostic']);
 const j=w.jobs['publication-no-diagnostic'];assert.equal(j.if,'${{ false }}');
 assert.deepEqual(j.steps,[{name:'No diagnostic approval in publication checkpoint',run:'exit 1'}]);
 assert.doesNotMatch(JSON.stringify(w),/vars\.|secrets\.|checkout|setup-node|github.token|workflow_dispatch|pull_request_target/);
});
test('real publication purpose and diagnostic-observation boundaries survive Python optimization',()=>{
 const p=new URL('./fixtures/autopilot/publication_test.py',import.meta.url).pathname;
 const r=spawnSync('python3',['-B',p],{env:{PATH:process.env.PATH,HOME:'/nonexistent'},encoding:'utf8',timeout:15000});
 assert.equal(r.status,0,r.stdout+r.stderr);
});
