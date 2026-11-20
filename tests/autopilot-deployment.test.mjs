import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('Linux cold-deployment contract: real process/lock, legacy refusal, trusted bytes and paths',{skip:process.platform!=='linux'},()=>{
 const r=spawnSync('python3',['-B','tests/fixtures/autopilot/deployment_test.py'],{encoding:'utf8',timeout:30000});
 assert.equal(r.status,0,r.stdout+r.stderr);
});
