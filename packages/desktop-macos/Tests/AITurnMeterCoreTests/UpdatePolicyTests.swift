import Foundation
import Testing
@testable import AITurnMeterCore

struct UpdatePolicyTests {
  @Test func policyCases() throws {
    var assertions = 0
    func expect(_ condition: Bool, _ message: String) {
      assertions += 1
      #expect(condition, "\(message)")
    }
    for value in ["0.2.26", "v0.2.26", "V0.2.26", " 0.2.26 ", "0.10.0", "1.0.0"] {
      expect(UpdatePolicy.isStable(value), "valid stable: \(value)")
    }
    for value in ["", "0.2", "0.2.26-rc.1", "v0.3.0-beta", "0.3.0+build.1", "vv0.2.26", "0.02.26", "-1.2.3", "0.2.bad", "0.2.26/evil", "0.2.26%0a", "99999999999999999999999.0.0"] {
      expect(!UpdatePolicy.isStable(value), "invalid version: \(value)")
    }
    expect(UpdatePolicy.isStable("0.2.26", prerelease: false), "explicit stable flag")
    expect(!UpdatePolicy.isStable("0.2.26", prerelease: true), "explicit prerelease flag rejects stable-looking tag")
    expect(UpdatePolicy.compareStable("0.2.26", "0.2.25") == 1, "patch increases")
    expect(UpdatePolicy.compareStable("0.10.0", "0.9.99") == 1, "numeric minor sorting")
    expect(UpdatePolicy.compareStable("1.0.0", "0.99.99") == 1, "numeric major sorting")
    expect(UpdatePolicy.compareStable("v0.2.25", "0.2.25") == 0, "same stable")
    expect(UpdatePolicy.compareStable("0.2.24", "0.2.25") == -1, "old stable")
    expect(UpdatePolicy.compareStable("0.3.0-rc.1", "0.2.25") == nil, "no RC comparison")
    expect(UpdatePolicy.compareStable("0.3.0", "0.2.25-rc.1") == nil, "RC current needs manual channel choice")

    for raw in ["file:///tmp/feed.json", "javascript:alert(1)", "http://example.com/feed", "/feed.json", "https://u:p@example.com/feed", "https://example.com/feed#fragment", "https://example.com/a%0d%0aHost:evil", "https://example.com/\nfeed"] {
      expect(UpdatePolicy.secureURL(raw) == nil, "unsafe URL: \(raw)")
    }
    expect(UpdatePolicy.secureURL("https://updates.example.com/download?signature=abc%2Fdef") != nil, "signed HTTPS custom URL remains supported")
    let feed = URL(string: "https://github.com/shadow-qw/AI-Turn-Meter/releases/latest")!
    expect(UpdatePolicy.isGitHubLatest(feed), "default latest")
    expect(!UpdatePolicy.isGitHubLatest(URL(string: "https://github.com.evil.test/shadow-qw/AI-Turn-Meter/releases/latest")!), "lookalike not GitHub")
    func latest(_ path: String, status: Int = 200) -> StableUpdate? {
      UpdatePolicy.githubCandidate(feed: feed, finalURL: URL(string: path)!, statusCode: status, currentVersion: "0.2.25")
    }
    let releasePrefix = "https://github.com/shadow-qw/AI-Turn-Meter/releases/tag/"
    let stable = latest(releasePrefix + "v0.2.26")
    expect(stable?.version == "0.2.26", "stable redirect offered")
    expect(stable?.downloadURL.absoluteString == "https://github.com/shadow-qw/AI-Turn-Meter/releases/download/v0.2.26/AI-Turn-Meter-0.2.26-arm64.dmg", "canonical stable asset URL")
    for url in [releasePrefix + "v0.3.0-rc.1", releasePrefix + "0.2.25", releasePrefix + "bad", "https://evil.test/shadow-qw/AI-Turn-Meter/releases/tag/v0.3.0", "https://github.com/other/repo/releases/tag/v0.3.0", releasePrefix + "v0.3.0/extra", releasePrefix + "v0.3.0?next=rc"] {
      expect(latest(url) == nil, "invalid/old/RC redirect: \(url)")
    }
    expect(latest(releasePrefix + "v0.3.0", status: 404) == nil, "HTTP error cannot offer update")
    func candidate(_ json: [String: Any], status: Int = 200, current: String = "0.2.25") throws -> StableUpdate? {
      let data = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
      return UpdatePolicy.jsonCandidate(data: data, statusCode: status, currentVersion: current)
    }
    let dmg = "https://updates.example.com/download?signature=abc"
    expect(try candidate(["version": "0.2.26", "dmgUrl": dmg, "notes": "stable"])?.notes == "stable", "custom stable feed without optional flags supported")
    expect(try candidate(["tag_name": "v0.3.0", "prerelease": false, "draft": false, "assets": [["name": "app.dmg", "browser_download_url": dmg]], "url": "https://api.github.com/releases/1"])?.downloadURL.absoluteString == dmg, "GitHub assets preferred to REST metadata URL")
    expect(try candidate(["version": "0.2.26", "url": dmg]) != nil, "legacy generic HTTPS url supported")
    for version in ["0.3.0-rc.1", "v0.3.0-beta", "0.3.0+rc", "bad", "", "0.2.25", "0.2.24"] {
      expect(try candidate(["version": version, "dmgUrl": dmg]) == nil, "no RC/invalid/old JSON: \(version)")
    }
    for key in ["draft", "prerelease"] {
      for value in [true, "false", "true", 0, 1, NSNull()] as [Any] {
        expect(try candidate(["version": "0.3.0", "dmgUrl": dmg, key: value]) == nil, "strict \(key) boolean")
      }
    }
    for url in ["file:///tmp/update.dmg", "javascript:alert(1)", "http://example.com/update.dmg", "https://u:p@example.com/a.dmg", "", "/relative.dmg"] {
      expect(try candidate(["version": "0.3.0", "dmgUrl": url]) == nil, "unsafe download rejected")
    }
    expect(try candidate(["tag_name": "v0.3.0-rc.1", "version": "0.3.0", "url": dmg]) == nil, "conflicting RC tag cannot hide behind stable version")
    expect(try candidate(["tag_name": "v0.3.0", "version": "0.4.0", "url": dmg]) == nil, "conflicting stable versions rejected")
    expect(try candidate(["version": 3, "url": dmg]) == nil, "wrong version type")
    expect(try candidate(["version": "0.3.0"]) == nil, "missing download")
    expect(try candidate(["version": "0.3.0", "assets": []]) == nil, "empty assets")
    expect(try candidate(["version": "0.3.0", "url": dmg], status: 500) == nil, "JSON HTTP error")
    expect(try candidate(["version": "0.3.0", "url": dmg], current: "0.2.25-rc.1") == nil, "stable updater not silently used by RC current")
    for payload in ["", "null", "[]", "not json", "{\"version\":null}"] {
      expect(UpdatePolicy.jsonCandidate(data: Data(payload.utf8), statusCode: 200, currentVersion: "0.2.25") == nil, "malformed or empty feed")
    }
    print("UpdatePolicy: PASS (\(assertions) assertions; \(ProcessInfo.processInfo.operatingSystemVersionString))")
  }
}
