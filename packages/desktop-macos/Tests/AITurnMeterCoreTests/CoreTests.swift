import Foundation
import Testing
@testable import AITurnMeterCore

@Suite("AITurnMeterCore Tests")
struct AITurnMeterCoreTests {
  @Test("DaemonSSEParser handles chunked CRLF, comments, and multi-line data")
  func sseParserChunkedCRLFAndComments() {
    var parser = DaemonSSEParser()

    let chunk1 = Data(": keepalive\r\n\r\nevent: state\r\ndata: {\"master".utf8)
    let ev1 = parser.feed(chunk1)
    #expect(ev1.isEmpty)

    let chunk2 = Data("Enabled\":true}\r\n\r\nevent: turn\ndata: {\"tool\":\"codex\"}\n\n".utf8)
    let ev2 = parser.feed(chunk2)
    #expect(ev2.count == 2)
    #expect(ev2[0] == SSEEvent(event: "state", data: "{\"masterEnabled\":true}"))
    #expect(ev2[1] == SSEEvent(event: "turn", data: "{\"tool\":\"codex\"}"))

    let chunk3 = Data("data: line1\ndata: line2\n\n".utf8)
    let ev3 = parser.feed(chunk3)
    #expect(ev3 == [SSEEvent(event: "message", data: "line1\nline2")])
  }

  @Test("Semver comparison and GitHub Releases API URL derivation")
  func semverComparisonAndGithubUrlDerivation() {
    #expect(UpdateChecker.compareSemver("v0.2.26", "0.2.25") == 1)
    #expect(UpdateChecker.compareSemver("0.2.25", "v0.2.25") == 0)
    #expect(UpdateChecker.compareSemver("0.2.24", "0.2.25") == -1)
    #expect(UpdateChecker.compareSemver("1.0", "0.9.9") == 1)

    let latestUrl = URL(string: "https://github.com/shadow-qw/AI-Turn-Meter/releases/latest")!
    #expect(
      UpdateChecker.githubApiLatestUrl(from: latestUrl)?.absoluteString
        == "https://api.github.com/repos/shadow-qw/AI-Turn-Meter/releases/latest"
    )
    let customFeed = URL(string: "https://updates.example.com/latest.json")!
    #expect(UpdateChecker.githubApiLatestUrl(from: customFeed) == nil)
  }

  @Test("parseReleaseJson picks arm64 dmg and matching sha256 asset")
  func parseReleaseJsonPicksArm64DmgAndSha256() throws {
    let payload: [String: Any] = [
      "tag_name": "v0.2.26",
      "body": "- Fix SSE reconnect\n- Add SHA-256 check",
      "assets": [
        [
          "name": "ai-turn-meter-0.2.26.tar.gz",
          "browser_download_url": "https://example.com/ai-turn-meter-0.2.26.tar.gz",
        ],
        [
          "name": "AI-Turn-Meter-0.2.26-x86_64.dmg",
          "browser_download_url": "https://example.com/AI-Turn-Meter-0.2.26-x86_64.dmg",
        ],
        [
          "name": "AI-Turn-Meter-0.2.26-arm64.dmg",
          "browser_download_url": "https://example.com/AI-Turn-Meter-0.2.26-arm64.dmg",
        ],
        [
          "name": "AI-Turn-Meter-0.2.26-arm64.dmg.sha256",
          "browser_download_url": "https://example.com/AI-Turn-Meter-0.2.26-arm64.dmg.sha256",
        ],
      ],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    let outcome = UpdateChecker.parseReleaseJson(data, currentVersion: "0.2.25")
    guard case .updateAvailable(let info) = outcome else {
      Issue.record("Expected .updateAvailable, got \(outcome)")
      return
    }
    #expect(info.version == "0.2.26")
    #expect(info.downloadUrl == "https://example.com/AI-Turn-Meter-0.2.26-arm64.dmg")
    #expect(info.sha256Url == "https://example.com/AI-Turn-Meter-0.2.26-arm64.dmg.sha256")
    #expect(info.notes == "- Fix SSE reconnect\n- Add SHA-256 check")

    let upToDate = UpdateChecker.parseReleaseJson(data, currentVersion: "0.2.26")
    #expect(upToDate == .upToDate(currentVersion: "0.2.26"))
  }

  @Test("parseSha256Checksum handles single-file and SHA256SUMS.txt and sha256Hex matches")
  func parseSha256ChecksumAndHashing() throws {
    let hashA = String(repeating: "a", count: 64)
    let hashB = String(repeating: "b", count: 64)

    let singleLine = "\(hashA)  AI-Turn-Meter-0.2.26-arm64.dmg\n"
    #expect(
      UpdateChecker.parseSha256Checksum(from: singleLine, filename: "AI-Turn-Meter-0.2.26-arm64.dmg") == hashA
    )

    let sumsTxt = """
    \(hashA)  ai-turn-meter-0.2.26.tar.gz
    \(hashB) *AI-Turn-Meter-0.2.26-arm64.dmg
    """
    #expect(
      UpdateChecker.parseSha256Checksum(from: sumsTxt, filename: "AI-Turn-Meter-0.2.26-arm64.dmg") == hashB
    )
    #expect(
      UpdateChecker.parseSha256Checksum(from: hashA.uppercased(), filename: "anything.dmg") == hashA
    )

    let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent("atm-sha-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let sampleFile = tmpDir.appendingPathComponent("sample.bin")
    let sampleData = Data("ai-turn-meter-sha256-payload".utf8)
    try sampleData.write(to: sampleFile)
    #expect(try UpdateChecker.sha256Hex(ofFileAt: sampleFile) == UpdateChecker.sha256Hex(of: sampleData))
  }

  @Test("MeterFormat and DaemonAuth formatters and token headers")
  func meterFormatAndDaemonAuth() throws {
    #expect(MeterFormat.tokens(nil) == "N/A")
    #expect(MeterFormat.tokens(999) == "999")
    #expect(MeterFormat.tokens(1500) == "1.5k")
    #expect(MeterFormat.tokens(2_000_000) == "2M")
    #expect(MeterFormat.usd(0.0042) == "$0.0042")
    #expect(MeterFormat.usd(1.234) == "$1.23")
    #expect(MeterFormat.money(420.5, symbol: "¥") == "¥420.50")
    #expect(MeterFormat.compactMoney(420.5, symbol: "¥") == "¥421")
    #expect(MeterFormat.tps(42.0) == "42 tok/s")
    #expect(MeterFormat.pct(87.0) == "87%")
    #expect(MeterFormat.shortDate("2026-11-19") == "11/19")

    let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent("atm-auth-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let tokenFile = tmpDir.appendingPathComponent("daemon.token")
    try "  secret-test-token-123 \n".write(to: tokenFile, atomically: true, encoding: .utf8)

    #expect(DaemonAuth.readToken(tokenPath: tokenFile.path) == "secret-test-token-123")
    let req = DaemonAuth.authorizedRequest(
      url: URL(string: "http://127.0.0.1:49153/v1/apps")!,
      method: "POST",
      tokenPath: tokenFile.path
    )
    #expect(req.httpMethod == "POST")
    #expect(req.value(forHTTPHeaderField: DaemonAuth.tokenHeader) == "secret-test-token-123")
  }

  @Test("External provider metadata and billing card snapshots decode cleanly")
  func externalProviderDecoding() throws {
    let json = """
    {
      "days": 7,
      "tool": null,
      "today": { "turnCount": 0, "callCount": 0, "totalInputTokens": 0, "uncachedInputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0, "thinkingTokens": 0, "totalTokens": 0, "cacheRatePct": null, "avgTps": null, "estimatedCostUsd": 0, "cacheSavingsUsd": 0, "pricedTurnCount": 0, "unpricedTurnCount": 0 },
      "totals": { "turnCount": 0, "callCount": 0, "totalInputTokens": 0, "uncachedInputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0, "thinkingTokens": 0, "totalTokens": 0, "cacheRatePct": null, "avgTps": null, "estimatedCostUsd": 0, "cacheSavingsUsd": 0, "pricedTurnCount": 0, "unpricedTurnCount": 0 },
      "byTool": [],
      "byModel": [],
      "byProject": [],
      "daily": [],
      "providersDir": "/tmp/providers",
      "externalProviders": [
        { "key": "ext:gw", "providerId": "gw", "name": "Gateway", "shortName": "GW", "icon": "building.2", "accentColor": "#1677FF", "currency": "CNY", "currencySymbol": "¥", "detailUrl": "https://example.com", "fileName": "gw.mjs", "enabled": true, "ok": true }
      ],
      "cards": {
        "ext:gw": {
          "isExternal": true,
          "providerName": "Gateway",
          "providerShortName": "GW",
          "currencyCode": "CNY",
          "currencySymbol": "¥",
          "statusText": "已同步",
          "footnote": "实时账单",
          "accountEmail": "alice",
          "planTitle": "Team",
          "quotaWindows": [{ "id": "ext:gw:m", "title": "本月额度", "remainingPct": 62.5, "resetText": "10 天后重置", "pacePct": 50.0, "subtitle": "已用 ¥375.00 / ¥1000.00" }],
          "billingSummary": { "todayCost": 30.5, "todayTokens": null, "periodLabel": "本月", "periodCost": 375.0, "periodLimit": 1000.0, "periodRemaining": 625.0, "periodTokens": null, "updatedAtMs": 1700000000000 },
          "today": { "costUsd": 30.5, "totalTokens": 0, "totalInputTokens": 0, "outputTokens": 0, "turnCount": 0, "callCount": 0, "cacheRatePct": null, "avgTps": null, "cacheSavingsUsd": null },
          "currentWindow": { "costUsd": 375.0, "totalTokens": 0, "turnCount": 0 },
          "days30": { "costUsd": 375.0, "totalTokens": 0, "turnCount": 0 },
          "daily30": [{ "date": "2026-11-19", "label": "11月19日", "totalTokens": 0, "costUsd": 30.5, "turnCount": 0, "models": [] }],
          "projects": [],
          "recentWindows": [],
          "breakdowns": [{ "id": "models", "title": "模型明细", "items": [{ "id": "m1", "name": "pro-model", "cost": 200.0, "limit": null, "usagePct": null, "sharePct": 53.3, "tokens": null, "subtitle": null }] }],
          "topModel": "pro-model"
        }
      }
    }
    """
    let parsed = try JSONDecoder().decode(UsageSummaryResponse.self, from: Data(json.utf8))
    #expect(parsed.providersDir == "/tmp/providers")
    #expect(parsed.externalProviders?.count == 1)
    #expect(parsed.externalProviders?.first?.key == "ext:gw")
    let card = try #require(parsed.cards?["ext:gw"])
    #expect(card.isExternal == true)
    #expect(card.resolvedCurrencySymbol == "¥")
    #expect(card.billingSummary?.periodRemaining == 625.0)
    #expect(card.breakdowns?.first?.items.first?.name == "pro-model")
  }
}
