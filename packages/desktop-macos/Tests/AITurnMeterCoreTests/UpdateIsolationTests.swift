import Foundation
import Testing
@testable import AITurnMeterCore

@Suite("Stable update isolation")
struct UpdateIsolationTests {
  @Test("JSON RC, draft and malformed metadata never offers an update")
  func rejectsUnsafeMetadata() throws {
    let url = "https://example.com/app.dmg"
    var payloads: [[String: Any]] = [
      ["version": "0.3.0-rc.1", "dmgUrl": url],
      ["version": "0.3.0", "prerelease": true, "dmgUrl": url],
      ["version": "0.3.0", "draft": true, "dmgUrl": url],
      ["version": "0.3.0", "prerelease": 0, "dmgUrl": url],
      ["version": "0.3.0", "draft": "false", "dmgUrl": url],
      ["tag_name": "v0.3.0-rc.1", "version": "0.3.0", "dmgUrl": url],
      ["version": "0.3.0", "dmgUrl": "file:///tmp/a.dmg"],
      ["version": "0.3.0", "dmgUrl": url, "sha256Url": "http://example.com/a.sha256"],
    ]
    payloads.append(["version": "0.3.0", "dmgUrl": url, "sha256": String(repeating: "x", count: 64)])
    for payload in payloads {
      let data = try JSONSerialization.data(withJSONObject: payload)
      if case .updateAvailable = UpdateChecker.parseReleaseJson(data, currentVersion: "0.2.26") {
        Issue.record("Unsafe metadata offered: \(payload)")
      }
    }
    for text in ["", "null", "[]", "invalid"] {
      if case .updateAvailable = UpdateChecker.parseReleaseJson(Data(text.utf8), currentVersion: "0.2.26") {
        Issue.record("Invalid payload offered")
      }
    }
  }

  @Test("Stable GitHub asset selection keeps arm64 and SHA256 metadata")
  func stableKeepsChecksum() throws {
    let hash = String(repeating: "a", count: 64)
    let payload: [String: Any] = ["tag_name": "v0.3.0", "prerelease": false, "draft": false,
      "url": "https://api.github.com/releases/42", "sha256": hash,
      "assets": [
        ["name": "app-x86_64.dmg", "browser_download_url": "https://example.com/x86.dmg"],
        ["name": "app-arm64.dmg", "browser_download_url": "https://example.com/arm64.dmg"],
        ["name": "app-arm64.dmg.sha256", "browser_download_url": "https://example.com/arm64.sha256"],
      ]]
    let data = try JSONSerialization.data(withJSONObject: payload)
    guard case .updateAvailable(let info) = UpdateChecker.parseReleaseJson(data, currentVersion: "0.2.26") else {
      Issue.record("Valid stable update disabled"); return
    }
    #expect(info.downloadUrl == "https://example.com/arm64.dmg")
    #expect(info.sha256Url == "https://example.com/arm64.sha256")
    #expect(info.expectedSha256 == hash)
    if case .updateAvailable = UpdateChecker.parseReleaseJson(data, currentVersion: "0.2.26-rc.1") {
      Issue.record("RC current silently used stable updater")
    }
  }

  @Test("Stable metadata cannot disguise RC or mismatched package/checksum identities")
  func rejectsContradictoryArtifactIdentity() throws {
    let root = "https://github.com/shadow-qw/AI-Turn-Meter/releases/download/"
    let rc = root + "v0.3.0-rc.1/AI-Turn-Meter-0.3.0-rc.1-arm64.dmg"
    let stable = root + "v0.3.0/AI-Turn-Meter-0.3.0-arm64.dmg"
    let payloads: [[String: Any]] = [
      ["version":"0.3.0", "dmgUrl":rc],
      ["version":"0.3.0", "dmgUrl":root + "v0.4.0/AI-Turn-Meter-0.4.0-arm64.dmg"],
      ["version":"0.3.0", "dmgUrl":"https://updates.example.com/AI-Turn-Meter-0.3.0-rc.1-arm64.dmg?signature=abc"],
      ["version":"0.3.0", "assets":[["name":"AI-Turn-Meter-0.3.0-rc.1-arm64.dmg", "browser_download_url":"https://updates.example.com/download?sig=opaque"]]],
      ["version":"0.3.0", "dmgUrl":stable, "sha256Url":rc + ".sha256"],
      ["version":"0.3.0", "dmgUrl":stable, "sha256Url":"https://updates.example.com/AI-Turn-Meter-0.4.0-arm64.dmg.sha256"],
      ["version":"0.3.0", "dmgUrl":stable, "assets":[["name":"AI-Turn-Meter-0.3.0-rc.1-arm64.dmg.sha256", "browser_download_url":"https://updates.example.com/opaque-checksum"]]],
    ]
    for payload in payloads {
      let data = try JSONSerialization.data(withJSONObject: payload)
      if case .updateAvailable = UpdateChecker.parseReleaseJson(data, currentVersion: "0.2.26") {
        Issue.record("Contradictory package offered: \(payload)")
      }
    }
    let valid: [String:Any] = ["version":"0.3.0", "dmgUrl":stable + "?signature=abc-rc.1",
      "sha256Url":stable + ".sha256?signature=xyz"]
    guard case .updateAvailable = UpdateChecker.parseReleaseJson(try JSONSerialization.data(withJSONObject: valid), currentVersion:"0.2.26") else {
      Issue.record("Valid signed stable URL disabled"); return
    }
  }
}
