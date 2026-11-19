import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = p => readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
test('GitHub API, HEAD fallback, custom JSON and download all use stable gates', () => {
  const app=read('packages/desktop-macos/Sources/AITurnMeterApp/Runtime/MeterViewModel.swift');
  const core=read('packages/desktop-macos/Sources/AITurnMeterCore/UpdateChecker.swift');
  assert.match(app,/UpdatePolicy\.secureURL\(rawUrl\)/);
  assert.match(app,/UpdatePolicy\.isStable\(self.version\)/);
  assert.match(app,/UpdatePolicy\.githubCandidate\(/);
  assert.match(app,/UpdatePolicy\.secureURL\(info.downloadUrl\)/);
  assert.equal((app.match(/UpdateChecker\.parseReleaseJson\(/g)||[]).length,2);
  assert.doesNotMatch(app,/compareSemver/);
  assert.match(core,/UpdatePolicy\.jsonCandidate\(/);
  assert.match(core,/UpdatePolicy\.stableVersion/);
  assert.match(core,/expectedSha256:/); assert.match(app,/verifyDownloadedDmgSha256IfAvailable/);
});
test('SwiftPM owns policy source and behavior tests; DMG retains SwiftPM build', () => {
  assert.ok(existsSync(new URL('../packages/desktop-macos/Sources/AITurnMeterCore/UpdatePolicy.swift',import.meta.url)));
  assert.match(read('scripts/build-dmg.mjs'),/swiftBinDir/);
  assert.match(read('scripts/test-update-policy.sh'),/Sources\/AITurnMeterCore\/UpdatePolicy.swift/);
  assert.match(read('packages/desktop-macos/Tests/AITurnMeterCoreTests/UpdateIsolationTests.swift'),/expectedSha256/);
  assert.match(read('packages/desktop-macos/Tests/AITurnMeterCoreTests/UpdatePolicyTests.swift'),/policyCases/);
  assert.ok(!existsSync(new URL('../packages/desktop-macos/main.swift',import.meta.url)));
});
test('strengthened CI retains all existing main validation steps on real macOS', () => {
  const s=read('.github/workflows/ci.yml');
  for (const value of ['runs-on: macos-15','Check version parity','npm run test:all','npm run build:macos','npm run package:vsix','sh scripts/test-update-policy.sh','uname -sm']) assert.ok(s.includes(value),value);
});
