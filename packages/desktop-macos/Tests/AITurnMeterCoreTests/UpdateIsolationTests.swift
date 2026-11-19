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
}
