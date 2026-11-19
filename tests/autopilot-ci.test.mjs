import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = () => readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('baseline CI tests the exact event SHA with read-only permission', () => {
  const s = workflow();
  assert.match(s, /pull_request:/);
  assert.match(s, /push:\s*\n\s+branches: \[main\]/);
  assert.match(s, /permissions:\s*\n  contents: read/);
  assert.match(s, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(s, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/);
  assert.doesNotMatch(s, /pull_request_target|workflow_run|issues:|secrets\.|: write|continue-on-error/);
});

test('CI actions are SHA pinned and checkout does not persist credentials', () => {
  const s = workflow();
  const uses = [...s.matchAll(/uses: ([^\s#]+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const action of uses) assert.match(action, /^actions\/(checkout|setup-node)@[a-f0-9]{40}$/);
  assert.equal((s.match(/uses: actions\/checkout@/g) || []).length, (s.match(/persist-credentials: false/g) || []).length);
  assert.match(s, /node-version: '24'/);
  assert.doesNotMatch(s, /cache:|registry-url:|token:|ssh-key:/);
});

test('CI isolates fixture data without publishing', () => {
  const s = workflow();
  assert.match(s, /npm run test:all/);
  assert.match(s, /env -i PATH="\$PATH" HOME="\$scratch"/);
  assert.match(s, /XDG_CONFIG_HOME="\$scratch\/config"/);
  assert.doesNotMatch(s, /release:dmg|release:tarball|install:all|uninstall:all|verify:local|gh release/);
  assert.equal((s.match(/timeout-minutes: 20/g) || []).length, 1);
});
