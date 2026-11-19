import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyRelease, assertChannelProof } from '../scripts/release-channel.mjs';
const rc = {eventName:'push', ref:'refs/tags/v0.3.0-rc.1', tag:'v0.3.0-rc.1', version:'0.3.0-rc.1', extensionVersion:'0.3.0-rc.1'};
test('RC tag is explicitly prerelease and never latest', () => {
  assert.deepEqual(classifyRelease(rc), {channel:'rc', prerelease:true, makeLatest:false});
});
test('stable requires manual main dispatch and confirmation bound to exact tag', () => {
  const stable = {...rc, tag:'v0.3.0', version:'0.3.0', extensionVersion:'0.3.0', ref:'refs/tags/v0.3.0'};
  assert.throws(() => classifyRelease(stable));
  assert.throws(() => classifyRelease({...stable,eventName:'workflow_dispatch',ref:'refs/heads/main', confirmedStableTag:'v0.2.9'}));
  assert.throws(() => classifyRelease({...stable,eventName:'workflow_dispatch',ref:'refs/heads/evil', confirmedStableTag:'v0.3.0'}));
  assert.deepEqual(classifyRelease({...stable,eventName:'workflow_dispatch',ref:'refs/heads/main',confirmedStableTag:'v0.3.0'}), {channel:'stable',prerelease:false,makeLatest:true});
});
test('bad versions, mismatched tags/manifests or events fail closed', () => {
  for (const patch of [{version:'0.3.0'},{tag:'v0.3.0-rc.2'},{extensionVersion:'0.3.0'},{eventName:'issues'},{ref:'refs/tags/v0.4.0-rc.1'}]) assert.throws(() => classifyRelease({...rc,...patch}));
  for (const version of ['', '0.3.0-beta.1','0.03.0-rc.1','0.3.0-rc.0','0.3.0-rc.1;echo bad','0.3.0+build']) assert.throws(() => classifyRelease({...rc,tag:`v${version}`,ref:`refs/tags/v${version}`,version,extensionVersion:version}));
});
test('release workflow separates read-only builds from write-only publishing and classifies before executing tag code', () => {
  const s = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url),'utf8');
  assert.match(s,/workflow_dispatch:/); assert.match(s,/confirm_stable_tag:/);
  assert.match(s,/ref: main/); assert.match(s,/node scripts\/release-channel.mjs/);
  assert.match(s,/needs: \[classify, build\]/);
  assert.match(s,/prerelease: \$\{\{ needs.classify.outputs.prerelease \}\}/);
  assert.match(s,/make_latest: \$\{\{ needs.classify.outputs.make_latest \}\}/);
  assert.doesNotMatch(s,/uses: [^\s]+@v\d/);
  const publish = s.split('\n  publish:')[1];
  assert.ok(publish); assert.doesNotMatch(publish,/checkout@|npm |node scripts|run:|release:tarball|release:dmg/);
});

test('RC publication fails closed without exact-SHA channel proof', () => {
  const sha='a'.repeat(40);
  assert.throws(() => assertChannelProof('rc',sha,undefined));
  assert.throws(() => assertChannelProof('rc',sha,'b'.repeat(40)));
  assert.doesNotThrow(() => assertChannelProof('rc',sha,sha));
  assert.doesNotThrow(() => assertChannelProof('stable',sha,undefined));
});
