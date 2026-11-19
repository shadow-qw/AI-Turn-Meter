import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = p => readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
test('wiring contract: UI delegates lookup; no duplicate weak fallback remains', () => {
  const app=read('packages/desktop-macos/Sources/AITurnMeterApp/Runtime/MeterViewModel.swift');
  const core=read('packages/desktop-macos/Sources/AITurnMeterCore/UpdateChecker.swift');
  const lookup=read('packages/desktop-macos/Sources/AITurnMeterCore/UpdateLookup.swift');
  assert.match(app,/UpdatePolicy\.secureURL\(rawUrl\)/);
  assert.match(app,/UpdatePolicy\.isStable\(self.version\)/);
  assert.match(app,/UpdatePolicy\.artifactURL\(info.downloadUrl, version: info.version\)/);
  assert.equal((app.match(/UpdateLookup\.check\(/g)||[]).length,1);
  assert.doesNotMatch(app,/checkUpdateFallback|githubCandidate|parseReleaseJson|compareSemver/);
  assert.match(lookup,/UpdateChecker\.parseReleaseJson\(/);
  assert.match(lookup,/UpdatePolicy\.githubCandidate\(/);
  assert.match(core,/UpdatePolicy\.jsonCandidate\(/);
  assert.match(core,/expectedSha256:/);
  assert.match(app,/verifyDownloadedDmgSha256IfAvailable/);
  assert.match(app,/UpdateChecker\.matchesChecksum\(/);
});
test('wiring contract: SwiftPM owns policy tests and DMG retains SwiftPM build', () => {
  assert.ok(existsSync(new URL('../packages/desktop-macos/Sources/AITurnMeterCore/UpdatePolicy.swift',import.meta.url)));
  assert.match(read('scripts/build-dmg.mjs'),/swiftBinDir/);
  assert.match(read('scripts/test-update-policy.sh'),/Sources\/AITurnMeterCore\/UpdatePolicy.swift/);
  assert.match(read('packages/desktop-macos/Tests/AITurnMeterCoreTests/UpdateIsolationTests.swift'),/expectedSha256/);
  assert.match(read('packages/desktop-macos/Tests/AITurnMeterCoreTests/UpdatePolicyTests.swift'),/policyCases/);
  assert.ok(!existsSync(new URL('../packages/desktop-macos/main.swift',import.meta.url)));
});
test('wiring contract: CI retains main validation commands; execution is separate evidence', () => {
  const s=read('.github/workflows/ci.yml');
  for (const value of ['runs-on: macos-15','Check version parity','npm run test:all','npm run build:macos','npm run package:vsix','sh scripts/test-update-policy.sh','uname -sm']) assert.ok(s.includes(value),value);
});
