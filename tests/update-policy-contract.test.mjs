import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('both update entry paths delegate to stable policy before offering a download', () => {
  const s = read('packages/desktop-macos/main.swift');
  assert.match(s, /UpdatePolicy\.secureURL\(rawUrl\)/);
  assert.match(s, /UpdatePolicy\.isStable\(curVersion\)/);
  assert.match(s, /UpdatePolicy\.githubCandidate\(/);
  assert.match(s, /UpdatePolicy\.jsonCandidate\(/);
  assert.match(s, /UpdatePolicy\.secureURL\(info\.downloadUrl\)/);
  assert.doesNotMatch(s, /compareSemver|json\["tag_name"\]/);
});

test('DMG compilation includes the same pure policy source as the Swift test runner', () => {
  const build = read('scripts/build-dmg.mjs');
  const runner = read('scripts/test-update-policy.sh');
  assert.match(build, /join\(ROOT, 'packages', 'desktop-macos', 'UpdatePolicy.swift'\)/);
  assert.match(runner, /packages\/desktop-macos\/UpdatePolicy.swift/);
  assert.match(runner, /tests\/swift\/UpdatePolicyTests.swift/);
  assert.match(runner, /set -eu/);
  assert.match(runner, /mktemp -d/);
  assert.doesNotMatch(runner, /SKIP|exit 0|curl|sudo/);
});

test('CI includes real macOS policy execution and full application typechecking', () => {
  const s = read('.github/workflows/ci.yml');
  assert.match(s, /runs-on: macos-15/);
  assert.match(s, /sh scripts\/test-update-policy.sh/);
  assert.match(s, /swiftc -typecheck -swift-version 5/);
  assert.match(s, /packages\/desktop-macos\/main.swift packages\/desktop-macos\/UpdatePolicy.swift/);
  assert.match(s, /uname -sm/);
});
