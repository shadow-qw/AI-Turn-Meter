import Foundation
import Testing
@testable import AITurnMeterCore

private enum LookupReply: Sendable { case http(UpdateHTTPResponse), offline, invalid }
private actor ScriptedUpdateTransport: UpdateTransport {
  var replies: [LookupReply]
  var calls: [String] = []
  init(_ replies: [LookupReply]) { self.replies = replies }
  func fetch(_ url: URL, method: String) async throws -> UpdateHTTPResponse {
    calls.append("\(method) \(url.absoluteString)")
    guard !replies.isEmpty else { throw UpdateTransportFailure.invalidResponse }
    switch replies.removeFirst() {
    case .http(let value): return value
    case .offline: throw UpdateTransportFailure.unavailable
    case .invalid: throw UpdateTransportFailure.invalidResponse
    }
  }
  func history() -> [String] { calls }
}

@Suite("Update transport state machine")
struct UpdateLookupTests {
  let feed = URL(string: "https://github.com/shadow-qw/AI-Turn-Meter/releases/latest")!
  let release = URL(string: "https://github.com/shadow-qw/AI-Turn-Meter/releases/tag/v0.3.0")!
  let dmg = "https://github.com/shadow-qw/AI-Turn-Meter/releases/download/v0.3.0/AI-Turn-Meter-0.3.0-arm64.dmg"
  func response(_ payload: [String:Any], status: Int = 200) throws -> UpdateHTTPResponse {
    UpdateHTTPResponse(statusCode: status, finalURL: URL(string:"https://api.github.com/repos/shadow-qw/AI-Turn-Meter/releases/latest")!, data: try JSONSerialization.data(withJSONObject: payload))
  }
  private func head() -> LookupReply { .http(UpdateHTTPResponse(statusCode: 200, finalURL: release, data: Data())) }

  @Test("API security rejection is terminal even if HEAD and valid metadata are queued")
  func rejectionCannotDowngrade() async throws {
    for patch in [["sha256":String(repeating:"x",count:64)], ["draft":true], ["version":"0.3.0-rc.1"], ["dmgUrl":"https://github.com/shadow-qw/AI-Turn-Meter/releases/download/v0.3.0-rc.1/AI-Turn-Meter-0.3.0-rc.1-arm64.dmg"]] as [[String:Any]] {
      var payload: [String:Any] = ["version":"0.3.0", "dmgUrl":dmg]
      payload.merge(patch) { _, right in right }
      let transport = ScriptedUpdateTransport([.http(try response(payload)),head(),.http(try response(["version":"0.3.0","dmgUrl":dmg,"sha256":String(repeating:"a",count:64)]))])
      let result = await UpdateLookup.check(feed:feed,currentVersion:"0.2.26",transport:transport)
      guard case .failed(.rejected) = result else { Issue.record("Rejected API was downgraded"); continue }
      #expect(await transport.history().count == 1)
    }
  }

  @Test("Transport failure may discover HEAD but must fetch exact release with checksum intact")
  func transportRecoveryRetainsMetadata() async throws {
    let hash=String(repeating:"a",count:64)
    let transport=ScriptedUpdateTransport([.offline,head(),.http(try response(["version":"0.3.0","dmgUrl":dmg,"sha256":hash]))])
    let result=await UpdateLookup.check(feed:feed,currentVersion:"0.2.26",transport:transport)
    guard case .available(let info)=result else { Issue.record("Valid fallback broken"); return }
    #expect(info.expectedSha256 == hash)
    let calls=await transport.history()
    #expect(calls.count == 3)
    #expect(calls[1] == "HEAD \(feed.absoluteString)")
    #expect(calls[2] == "GET https://api.github.com/repos/shadow-qw/AI-Turn-Meter/releases/tags/v0.3.0")
  }

  @Test("HEAD alone, absent checksum, wrong release or rejected exact metadata cannot authorize download")
  func fallbackMustNotWeaken() async throws {
    let payloads: [[String:Any]] = [
      ["version":"0.3.0","dmgUrl":dmg],
      ["version":"0.4.0","dmgUrl":"https://example.com/app.dmg","sha256":String(repeating:"a",count:64)],
      ["version":"0.3.0","dmgUrl":dmg,"sha256":String(repeating:"x",count:64)],
    ]
    for payload in payloads {
      let t=ScriptedUpdateTransport([.offline,head(),.http(try response(payload))])
      let result=await UpdateLookup.check(feed:feed,currentVersion:"0.2.26",transport:t)
      guard case .failed = result else { Issue.record("Weak fallback authorized update"); continue }
      #expect(await t.history().count == 3)
    }
    let headOnly=ScriptedUpdateTransport([.offline,head(),.offline])
    guard case .failed(.transport) = await UpdateLookup.check(feed:feed,currentVersion:"0.2.26",transport:headOnly) else {
      Issue.record("HEAD alone offered update"); return
    }
  }

  @Test("No Release and policy refusal are distinct from network failure")
  func noReleaseIsTerminal() async throws {
    let t=ScriptedUpdateTransport([.http(try response([:],status:404)),head()])
    #expect(await UpdateLookup.check(feed:feed,currentVersion:"0.2.26",transport:t) == .failed(.noRelease))
    #expect(await t.history().count == 1)
  }

  @Test("Primary stable and legacy opaque custom feeds remain supported; checksum mismatch fails")
  func normalStableStillWorks() async throws {
    let t=ScriptedUpdateTransport([.http(try response(["version":"0.3.0","dmgUrl":dmg,"sha256":String(repeating:"a",count:64)]))])
    guard case .available(let info)=await UpdateLookup.check(feed:feed,currentVersion:"0.2.26",transport:t) else {
      Issue.record("Stable API disabled"); return
    }
    #expect(UpdateChecker.matchesChecksum(expected:info.expectedSha256!,actual:String(repeating:"a",count:64)))
    #expect(!UpdateChecker.matchesChecksum(expected:info.expectedSha256!,actual:String(repeating:"b",count:64)))
    #expect(await t.history().count == 1)
    let custom=URL(string:"https://updates.example.com/latest.json")!
    let legacy=ScriptedUpdateTransport([.http(try response(["version":"0.3.0","url":"https://updates.example.com/download?signature=abc"]))])
    guard case .available = await UpdateLookup.check(feed:custom,currentVersion:"0.2.26",transport:legacy) else {
      Issue.record("Legacy stable custom feed disabled"); return
    }
    #expect(await legacy.history().count == 1)
  }

  @Test("Protocol rejection is terminal; unavailable HTTP server may recover with verified metadata")
  func protocolVersusServerFailure() async throws {
    let invalid=ScriptedUpdateTransport([.invalid,head()])
    guard case .failed(.rejected) = await UpdateLookup.check(feed:feed,currentVersion:"0.2.26",transport:invalid) else {
      Issue.record("Protocol rejection retried"); return
    }
    #expect(await invalid.history().count == 1)
    for status in [403,429,503] {
      let t=ScriptedUpdateTransport([.http(try response([:],status:status)),head(),
        .http(try response(["version":"0.3.0","dmgUrl":dmg,"sha256":String(repeating:"a",count:64)]))])
      guard case .available = await UpdateLookup.check(feed:feed,currentVersion:"0.2.26",transport:t) else {
        Issue.record("Legitimate server unavailability recovery broken"); continue
      }
      #expect(await t.history().count == 3)
    }
  }

  @Test("GitHub metadata redirected outside API origin is rejected without weaker retry")
  func metadataOriginIsBound() async throws {
    let evil=UpdateHTTPResponse(statusCode:200,finalURL:URL(string:"https://evil.example.com/release")!,
      data:try JSONSerialization.data(withJSONObject:["version":"0.3.0","dmgUrl":dmg]))
    let t=ScriptedUpdateTransport([.http(evil),head()])
    guard case .failed(.rejected) = await UpdateLookup.check(feed:feed,currentVersion:"0.2.26",transport:t) else {
      Issue.record("Untrusted metadata redirect accepted"); return
    }
    #expect(await t.history().count == 1)
  }
}
