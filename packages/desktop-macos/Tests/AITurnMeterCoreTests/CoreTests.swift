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

  @Test("DaemonSSEParser preserves split multi-byte UTF-8 Chinese characters across chunks and resets cleanly")
  func sseParserSplitMultibyteUTF8AndReset() {
    var parser = DaemonSSEParser()

    let payload = "event: turn\r\ndata: {\"title\":\"中文配额提醒🚀\",\"note\":\"跨分片字节\"}\r\n\r\n"
    let rawBytes = Array(payload.utf8)

    // Find a 3-byte Chinese character ("中" = 0xE4 0xB8 0xAD) and split right through all 3 bytes across 3 chunks,
    // plus split a 4-byte emoji ("🚀" = 0xF0 0x9F 0x9A 0x80) and CRLF ("\r\n") across chunk boundaries.
    let zhongIndex = rawBytes.firstIndex(of: 0xE4)!
    let emojiIndex = rawBytes.firstIndex(of: 0xF0)!
    let lastCrIndex = rawBytes.lastIndex(of: 0x0D)!

    let c1 = Data(rawBytes[0..<(zhongIndex + 1)])           // ends after byte 1 of "中"
    let c2 = Data(rawBytes[(zhongIndex + 1)..<(zhongIndex + 2)]) // byte 2 of "中" alone
    let c3 = Data(rawBytes[(zhongIndex + 2)..<(emojiIndex + 2)]) // byte 3 of "中" .. first 2 bytes of "🚀"
    let c4 = Data(rawBytes[(emojiIndex + 2)..<(lastCrIndex + 1)]) // remaining bytes of "🚀" .. trailing "\r"
    let c5 = Data(rawBytes[(lastCrIndex + 1)...])           // final "\n"

    #expect(parser.feed(c1).isEmpty)
    #expect(parser.feed(c2).isEmpty)
    #expect(parser.feed(c3).isEmpty)
    #expect(parser.feed(c4).isEmpty)

    let events = parser.feed(c5)
    #expect(events.count == 1)
    #expect(events[0] == SSEEvent(event: "turn", data: "{\"title\":\"中文配额提醒🚀\",\"note\":\"跨分片字节\"}"))

    // Partial incomplete UTF-8 bytes and event header must be cleared by reset()
    #expect(parser.feed(Data([0x65, 0x76, 0x65, 0x6E, 0x74, 0x3A, 0x20, 0x73, 0x74, 0x61, 0x74, 0x65, 0x0A, 0x64, 0x61, 0x74, 0x61, 0x3A, 0x20, 0xE4])).isEmpty)
    parser.reset()
    let afterReset = parser.feed(Data("data: ok\n\n".utf8))
    #expect(afterReset == [SSEEvent(event: "message", data: "ok")])
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

    // Cached repeat read returns same token; rotating file picks up new token immediately
    #expect(DaemonAuth.readToken(tokenPath: tokenFile.path) == "secret-test-token-123")
    try "rotated-token-456\n".write(to: tokenFile, atomically: true, encoding: .utf8)
    #expect(DaemonAuth.readToken(tokenPath: tokenFile.path) == "rotated-token-456")

    // Removing token file evicts cached entry
    try FileManager.default.removeItem(at: tokenFile)
    #expect(DaemonAuth.readToken(tokenPath: tokenFile.path) == nil)
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

  @Test("ProviderOrder resolves saved order, moves built-in and external providers, and sorts overview windows")
  func providerOrderResolveMoveAndSort() {
    let available = ["codex", "cursor", "antigravity", "codebuddy", "ext:gw", "ext:extra"]
    let resolved = ProviderOrder.resolve(saved: ["ext:gw", "cursor", "removed-key"], available: available)
    #expect(resolved == ["ext:gw", "cursor", "codex", "antigravity", "codebuddy", "ext:extra"])

    let moved = ProviderOrder.move(order: resolved, from: "codex", to: "ext:gw")
    #expect(moved == ["codex", "ext:gw", "cursor", "antigravity", "codebuddy", "ext:extra"])

    let movedToEnd = ProviderOrder.move(order: moved, from: "codex", to: "ext:extra")
    #expect(movedToEnd == ["ext:gw", "cursor", "antigravity", "codebuddy", "ext:extra", "codex"])

    let windows = [
      CardQuotaWindow(id: "overview-codex", title: "Codex", remainingPct: 80),
      CardQuotaWindow(id: "overview-cursor", title: "Cursor", remainingPct: 50),
      CardQuotaWindow(id: "overview-ext:gw", title: "GW", remainingPct: 30),
    ]
    let sorted = ProviderOrder.sortOverviewWindows(windows, by: ["ext:gw", "cursor", "codex"])
    #expect(sorted.map(\.id) == ["overview-ext:gw", "overview-cursor", "overview-codex"])
  }

  @Test("CardQuotaWindow, CardSessionSummary, and UsageWorkspaceRow decode with optional fields")
  func newModelsDecodingAndHealthLevel() throws {
    #expect(QuotaHealthLevel.quotaHealth(remainingPct: 0) == .critical)
    #expect(QuotaHealthLevel.quotaHealth(remainingPct: 5.0) == .critical)
    #expect(QuotaHealthLevel.quotaHealth(remainingPct: 5.1) == .warning)
    #expect(QuotaHealthLevel.quotaHealth(remainingPct: 20.0) == .warning)
    #expect(QuotaHealthLevel.quotaHealth(remainingPct: 20.1) == .normal)
    #expect(QuotaHealthLevel.quotaHealth(remainingPct: .nan) == .normal)

    let json = """
    {
      "days": 7,
      "tool": null,
      "today": { "turnCount": 2, "callCount": 3, "totalInputTokens": 1000, "uncachedInputTokens": 400, "cacheReadTokens": 600, "cacheWriteTokens": 0, "outputTokens": 500, "thinkingTokens": 200, "totalTokens": 1500, "cacheRatePct": 60.0, "avgTps": 45.0, "estimatedCostUsd": 0.12, "cacheSavingsUsd": 0.03, "pricedTurnCount": 2, "unpricedTurnCount": 0 },
      "totals": { "turnCount": 2, "callCount": 3, "totalInputTokens": 1000, "uncachedInputTokens": 400, "cacheReadTokens": 600, "cacheWriteTokens": 0, "outputTokens": 500, "thinkingTokens": 200, "totalTokens": 1500, "cacheRatePct": 60.0, "avgTps": 45.0, "estimatedCostUsd": 0.12, "cacheSavingsUsd": 0.03, "pricedTurnCount": 2, "unpricedTurnCount": 0 },
      "byTool": [],
      "byModel": [],
      "byWorkspace": [
        {
          "workspacePath": "/Users/dev/ai-turn-meter",
          "workspaceName": "ai-turn-meter",
          "turnCount": 12,
          "totalTokens": 98000,
          "thinkingTokens": 12000,
          "outputTokens": 25000,
          "estimatedCostUsd": 1.45,
          "sharePct": 72.5,
          "tools": ["antigravity", "codex"]
        }
      ],
      "daily": [],
      "cards": {
        "antigravity": {
          "accountEmail": "dev@example.com",
          "planTitle": "Pro",
          "quotaWindows": [
            { "id": "ag-gemini-5h", "title": "Gemini 会话", "remainingPct": 18.0, "group": "Gemini", "windowKind": "5h" },
            { "id": "ag-argon", "title": "Gemini 4 Argon", "remainingPct": 4.0 }
          ],
          "recentSessions": [
            {
              "sessionId": "sess-1",
              "tool": "antigravity",
              "title": "Fix quota pools",
              "workspacePath": "/Users/dev/ai-turn-meter",
              "model": "claude-opus-4-6",
              "modelCount": 2,
              "totalTokens": 42000,
              "thinkingTokens": 8000,
              "estimatedCostUsd": 0.85,
              "turnCount": 4,
              "lastActiveAtMs": 1700000000000,
              "isActive": true
            }
          ],
          "today": { "costUsd": 0.85, "totalTokens": 42000, "totalInputTokens": 30000, "outputTokens": 12000, "turnCount": 4, "callCount": 6, "cacheRatePct": 50.0, "avgTps": 40.0, "cacheSavingsUsd": 0.1 },
          "currentWindow": { "costUsd": 0.85, "totalTokens": 42000, "turnCount": 4 },
          "days30": { "costUsd": 0.85, "totalTokens": 42000, "turnCount": 4 },
          "daily30": [],
          "projects": [],
          "recentWindows": [],
          "topModel": "claude-opus-4-6"
        }
      }
    }
    """

    let parsed = try JSONDecoder().decode(UsageSummaryResponse.self, from: Data(json.utf8))
    let ws = try #require(parsed.byWorkspace?.first)
    #expect(ws.id == "/Users/dev/ai-turn-meter")
    #expect(ws.workspaceName == "ai-turn-meter")
    #expect(ws.thinkingTokens == 12000)
    #expect(ws.outputTokens == 25000)
    #expect(ws.tools == ["antigravity", "codex"])

    let card = try #require(parsed.cards?["antigravity"])
    let windows = try #require(card.quotaWindows)
    #expect(windows.count == 2)
    #expect(windows[0].group == "Gemini")
    #expect(windows[0].windowKind == "5h")
    #expect(windows[0].healthLevel == .warning)
    #expect(windows[1].group == nil)
    #expect(windows[1].windowKind == nil)
    #expect(windows[1].healthLevel == .critical)

    let session = try #require(card.recentSessions?.first)
    #expect(session.id == "antigravity:sess-1")
    #expect(session.title == "Fix quota pools")
    #expect(session.modelCount == 2)
    #expect(session.isActive == true)
  }

  private func makeCard(
    providerName: String? = nil,
    currencySymbol: String? = nil,
    isExternal: Bool? = nil,
    quotaWindows: [CardQuotaWindow]? = nil,
    billingSummary: CardBillingSummary? = nil
  ) -> CodexBarCardSnapshot {
    CodexBarCardSnapshot(
      accountEmail: nil,
      planTitle: nil,
      quotaWindows: quotaWindows,
      resetCreditsText: nil,
      quotaHint: nil,
      latestTpsText: nil,
      latestCacheText: nil,
      latestTurnSubline: nil,
      today: CardTodayMetrics(
        costUsd: nil,
        totalTokens: 0,
        totalInputTokens: 0,
        outputTokens: 0,
        turnCount: 0,
        callCount: 0,
        cacheRatePct: nil,
        avgTps: nil,
        cacheSavingsUsd: nil
      ),
      currentWindow: CardWindowMetrics(costUsd: nil, totalTokens: 0, turnCount: 0),
      days30: CardWindowMetrics(costUsd: nil, totalTokens: 0, turnCount: 0),
      daily30: [],
      projects: nil,
      recentWindows: [],
      topModel: nil,
      isExternal: isExternal,
      providerName: providerName,
      currencySymbol: currencySymbol,
      billingSummary: billingSummary
    )
  }

  @Test("QuotaAlertEvaluator triggers low-quota, escalation, reset recovery, and deduplicates")
  func quotaAlertEvaluatorLowQuotaAndReset() {
    var evaluator = QuotaAlertEvaluator()
    let names = ["codex": "Codex"]

    // Healthy poll (including "all" card which must be ignored) -> no alerts
    let u0 = UsageSummaryResponse(cards: [
      "all": makeCard(quotaWindows: [CardQuotaWindow(id: "overview-codex", title: "Codex", remainingPct: 10)]),
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h 会话", remainingPct: 60)]),
    ])
    #expect(evaluator.evaluate(usage: u0, apps: [:], displayNames: names).isEmpty)

    // Drops to 18% -> warning fires once
    let u1 = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h 会话", remainingPct: 18, resetText: "2h 后重置")]),
    ])
    let ev1 = evaluator.evaluate(usage: u1, apps: [:], displayNames: names)
    #expect(ev1.count == 1)
    #expect(ev1[0].dedupeKey == "quota:codex:5h:warning")

    // Repeat poll at 15% -> deduped
    let u2 = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h 会话", remainingPct: 15)]),
    ])
    #expect(evaluator.evaluate(usage: u2, apps: [:], displayNames: names).isEmpty)

    // Drops to 4% -> critical fires
    let u3 = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h 会话", remainingPct: 4)]),
    ])
    let ev3 = evaluator.evaluate(usage: u3, apps: [:], displayNames: names)
    #expect(ev3.count == 1)
    #expect(ev3[0].dedupeKey == "quota:codex:5h:critical")

    // Jitter to 6% -> neither critical nor warning re-fires
    let u4 = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h 会话", remainingPct: 6)]),
    ])
    #expect(evaluator.evaluate(usage: u4, apps: [:], displayNames: names).isEmpty)

    // Reset recovery (<50% -> >=95%) fires once
    let u5 = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h 会话", remainingPct: 100)]),
    ])
    let ev5 = evaluator.evaluate(usage: u5, apps: [:], displayNames: names)
    #expect(ev5.count == 1)
    #expect(ev5[0].dedupeKey == "quota-reset:codex:5h")

    // Subsequent poll at 99% -> no duplicate reset alert
    let u6 = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h 会话", remainingPct: 99)]),
    ])
    #expect(evaluator.evaluate(usage: u6, apps: [:], displayNames: names).isEmpty)

    // Next cycle drops to 15% -> re-armed warning fires
    let ev7 = evaluator.evaluate(usage: u2, apps: [:], displayNames: names)
    #expect(ev7.count == 1)
    #expect(ev7[0].dedupeKey == "quota:codex:5h:warning")
  }

  @Test("QuotaAlertEvaluator triggers external billing 80% and 90% budget thresholds with dedupe")
  func quotaAlertEvaluatorBudgetThresholds() {
    var evaluator = QuotaAlertEvaluator()
    let names = ["ext:gw": "Gateway"]

    // 75% -> no alert
    let b0 = UsageSummaryResponse(cards: [
      "ext:gw": makeCard(
        providerName: "Gateway",
        currencySymbol: "¥",
        isExternal: true,
        billingSummary: CardBillingSummary(periodLabel: "本月", periodCost: 750, periodLimit: 1000)
      ),
    ])
    #expect(evaluator.evaluate(usage: b0, apps: [:], displayNames: names).isEmpty)

    // 82% -> 80% threshold fires once
    let b1 = UsageSummaryResponse(cards: [
      "ext:gw": makeCard(
        providerName: "Gateway",
        currencySymbol: "¥",
        isExternal: true,
        billingSummary: CardBillingSummary(periodLabel: "本月", periodCost: 820, periodLimit: 1000)
      ),
    ])
    let ev1 = evaluator.evaluate(usage: b1, apps: [:], displayNames: names)
    #expect(ev1.count == 1)
    #expect(ev1[0].dedupeKey == "budget:ext:gw:本月:80")

    // Repeat at 85% -> deduped
    let b2 = UsageSummaryResponse(cards: [
      "ext:gw": makeCard(
        providerName: "Gateway",
        currencySymbol: "¥",
        isExternal: true,
        billingSummary: CardBillingSummary(periodLabel: "本月", periodCost: 850, periodLimit: 1000)
      ),
    ])
    #expect(evaluator.evaluate(usage: b2, apps: [:], displayNames: names).isEmpty)

    // 92% via periodRemaining fallback (periodCost nil) -> 90% threshold fires once
    let b3 = UsageSummaryResponse(cards: [
      "ext:gw": makeCard(
        providerName: "Gateway",
        currencySymbol: "¥",
        isExternal: true,
        billingSummary: CardBillingSummary(periodLabel: "本月", periodCost: nil, periodLimit: 1000, periodRemaining: 80)
      ),
    ])
    let ev3 = evaluator.evaluate(usage: b3, apps: [:], displayNames: names)
    #expect(ev3.count == 1)
    #expect(ev3[0].dedupeKey == "budget:ext:gw:本月:90")

    // Repeat at 95% -> deduped
    let b4 = UsageSummaryResponse(cards: [
      "ext:gw": makeCard(
        providerName: "Gateway",
        currencySymbol: "¥",
        isExternal: true,
        billingSummary: CardBillingSummary(periodLabel: "本月", periodCost: 950, periodLimit: 1000)
      ),
    ])
    #expect(evaluator.evaluate(usage: b4, apps: [:], displayNames: names).isEmpty)
  }

  @Test("QuotaAlertEvaluator triggers 200k long-context alerts per turnUid and respects callCount & cooldown")
  func quotaAlertEvaluatorLongContextAndCooldown() {
    var evaluator = QuotaAlertEvaluator()
    let names = ["codex": "Codex"]

    // Multi-call turn: 300k / 3 calls = 100k avg -> should NOT trigger
    let multiCallLowAvg = StatusAppEntry(
      name: "Codex",
      appPath: nil,
      installed: true,
      running: true,
      cdpPort: nil,
      latestTurn: TurnSummary(turnUid: "turn-low-avg", tool: "codex", model: "claude-opus-4-6", callCount: 3, totalInputTokens: 300_000)
    )
    #expect(evaluator.evaluate(usage: nil, apps: ["codex": multiCallLowAvg], displayNames: names).isEmpty)

    // Single-call turn: 240k > 200k -> triggers once
    let longTurn1 = StatusAppEntry(
      name: "Codex",
      appPath: nil,
      installed: true,
      running: true,
      cdpPort: nil,
      latestTurn: TurnSummary(turnUid: "turn-1", tool: "codex", model: "claude-opus-4-6", callCount: 1, totalInputTokens: 240_000)
    )
    let ev1 = evaluator.evaluate(usage: nil, apps: ["codex": longTurn1], displayNames: names)
    #expect(ev1.count == 1)
    #expect(ev1[0].dedupeKey == "context200k:codex:turn-1")

    // Same turnUid repeated -> deduped
    #expect(evaluator.evaluate(usage: nil, apps: ["codex": longTurn1], displayNames: names).isEmpty)

    // New turnUid with 2 calls totaling 450k (225k avg) -> triggers
    let longTurn2 = StatusAppEntry(
      name: "Codex",
      appPath: nil,
      installed: true,
      running: true,
      cdpPort: nil,
      latestTurn: TurnSummary(turnUid: "turn-2", tool: "codex", model: "claude-opus-4-6", callCount: 2, totalInputTokens: 450_000)
    )
    let ev2 = evaluator.evaluate(usage: nil, apps: ["codex": longTurn2], displayNames: names)
    #expect(ev2.count == 1)
    #expect(ev2[0].dedupeKey == "context200k:codex:turn-2")

    // Stale turn age filter & cooldown check
    let t0 = Date(timeIntervalSince1970: 1_700_000_000)
    var timedEvaluator = QuotaAlertEvaluator(cooldownSeconds: 1800, maxLongContextTurnAgeSeconds: 600)
    let staleTurn = StatusAppEntry(
      name: "Codex",
      appPath: nil,
      installed: true,
      running: true,
      cdpPort: nil,
      latestTurn: TurnSummary(
        turnUid: "turn-stale",
        tool: "codex",
        totalInputTokens: 260_000,
        completedAtMs: (t0.timeIntervalSince1970 - 3600) * 1000
      )
    )
    #expect(timedEvaluator.evaluate(usage: nil, apps: ["codex": staleTurn], displayNames: names, now: t0).isEmpty)

    let healthyUsage = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h", remainingPct: 60)]),
    ])
    let lowUsage = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h", remainingPct: 15)]),
    ])
    let fullUsage = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h", remainingPct: 100)]),
    ])
    // Cold-start baseline seeding produces 0 alerts
    #expect(timedEvaluator.evaluate(usage: healthyUsage, apps: [:], displayNames: names, now: t0).isEmpty)
    // Subsequent drop to 15% fires warning
    #expect(timedEvaluator.evaluate(usage: lowUsage, apps: [:], displayNames: names, now: t0.addingTimeInterval(10)).count == 1)
    _ = timedEvaluator.evaluate(usage: fullUsage, apps: [:], displayNames: names, now: t0.addingTimeInterval(60))
    // Re-armed by reset, but still within 1800s cooldown for warning -> suppressed
    #expect(timedEvaluator.evaluate(usage: lowUsage, apps: [:], displayNames: names, now: t0.addingTimeInterval(120)).isEmpty)
    // After reset + cooldown elapsed -> fires again
    _ = timedEvaluator.evaluate(usage: fullUsage, apps: [:], displayNames: names, now: t0.addingTimeInterval(1900))
    #expect(timedEvaluator.evaluate(usage: lowUsage, apps: [:], displayNames: names, now: t0.addingTimeInterval(2000)).count == 1)
  }

  @Test("QuotaAlertEvaluator cold-start baseline suppresses launch spam while subsequent crossings and resets fire")
  func quotaAlertEvaluatorColdStartBaseline() {
    var evaluator = QuotaAlertEvaluator()
    let names = ["codex": "Codex", "ext:gw": "Gateway"]

    // Cold-start poll already has low quota (14%), 85% budget, and an existing 250k turn -> 0 alerts
    let startupUsage = UsageSummaryResponse(cards: [
      "all": makeCard(quotaWindows: [CardQuotaWindow(id: "overview-codex", title: "Codex", remainingPct: 4)]),
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h 会话", remainingPct: 14)]),
      "ext:gw": makeCard(
        providerName: "Gateway",
        currencySymbol: "¥",
        isExternal: true,
        billingSummary: CardBillingSummary(periodLabel: "本月", periodCost: 850, periodLimit: 1000)
      ),
    ])
    let startupApp = StatusAppEntry(
      name: "Codex",
      appPath: nil,
      installed: true,
      running: true,
      cdpPort: nil,
      latestTurn: TurnSummary(turnUid: "turn-startup", tool: "codex", callCount: 1, totalInputTokens: 250_000)
    )
    #expect(evaluator.evaluate(usage: startupUsage, apps: ["codex": startupApp], displayNames: names).isEmpty)

    // Repeat identical poll -> still 0 alerts
    #expect(evaluator.evaluate(usage: startupUsage, apps: ["codex": startupApp], displayNames: names).isEmpty)

    // Escalate quota 14% -> 4% (critical), budget 85% -> 92% (90% tier), and observe a brand-new 230k turn -> all 3 fire
    let escalatedUsage = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h 会话", remainingPct: 4)]),
      "ext:gw": makeCard(
        providerName: "Gateway",
        currencySymbol: "¥",
        isExternal: true,
        billingSummary: CardBillingSummary(periodLabel: "本月", periodCost: 920, periodLimit: 1000)
      ),
    ])
    let newLongApp = StatusAppEntry(
      name: "Codex",
      appPath: nil,
      installed: true,
      running: true,
      cdpPort: nil,
      latestTurn: TurnSummary(turnUid: "turn-new", tool: "codex", callCount: 1, totalInputTokens: 230_000)
    )
    let escalatedEvents = evaluator.evaluate(usage: escalatedUsage, apps: ["codex": newLongApp], displayNames: names)
    #expect(Set(escalatedEvents.map(\.dedupeKey)) == Set([
      "quota:codex:5h:critical",
      "budget:ext:gw:本月:90",
      "context200k:codex:turn-new",
    ]))

    // Quota refills 4% -> 100% -> reset alert fires
    let refilledUsage = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h 会话", remainingPct: 100)]),
    ])
    let resetEvents = evaluator.evaluate(usage: refilledUsage, apps: ["codex": newLongApp], displayNames: names)
    #expect(resetEvents.map(\.dedupeKey) == ["quota-reset:codex:5h"])

    // reset() clears baseline so next already-critical poll re-seeds with 0 alerts
    evaluator.reset()
    #expect(evaluator.evaluate(usage: escalatedUsage, apps: ["codex": newLongApp], displayNames: names).isEmpty)
  }

  @Test("QuotaAlertEvaluator respects masterEnabled and enabledTools filtering")
  func quotaAlertEvaluatorMasterAndToolFilters() {
    var evaluator = QuotaAlertEvaluator()
    let names = ["codex": "Codex", "cursor": "Cursor"]

    // Baseline healthy poll (even when masterEnabled is false, seeds baseline without alerting)
    let healthy = UsageSummaryResponse(cards: [
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h", remainingPct: 70)]),
      "cursor": makeCard(quotaWindows: [CardQuotaWindow(id: "m", title: "月度", remainingPct: 70)]),
    ])
    let initialApps: [String: StatusAppEntry] = [
      "codex": StatusAppEntry(name: "Codex", appPath: nil, installed: true, running: true, cdpPort: nil, latestTurn: nil),
      "cursor": StatusAppEntry(name: "Cursor", appPath: nil, installed: true, running: true, cdpPort: nil, latestTurn: nil),
    ]
    #expect(evaluator.evaluate(usage: healthy, apps: initialApps, displayNames: names, masterEnabled: false).isEmpty)

    // Both tools drop to low quota & trigger 200k turns while masterEnabled == false -> 0 alerts
    let lowBoth = UsageSummaryResponse(cards: [
      "all": makeCard(quotaWindows: [CardQuotaWindow(id: "overview-codex", title: "Codex", remainingPct: 2)]),
      "codex": makeCard(quotaWindows: [CardQuotaWindow(id: "5h", title: "5h", remainingPct: 12)]),
      "cursor": makeCard(quotaWindows: [CardQuotaWindow(id: "m", title: "月度", remainingPct: 10)]),
    ])
    let longBothApps: [String: StatusAppEntry] = [
      "codex": StatusAppEntry(
        name: "Codex",
        appPath: nil,
        installed: true,
        running: true,
        cdpPort: nil,
        latestTurn: TurnSummary(turnUid: "turn-codex-200k", tool: "codex", callCount: 1, totalInputTokens: 250_000)
      ),
      "cursor": StatusAppEntry(
        name: "Cursor",
        appPath: nil,
        installed: true,
        running: true,
        cdpPort: nil,
        latestTurn: TurnSummary(turnUid: "turn-cursor-200k", tool: "cursor", callCount: 1, totalInputTokens: 260_000)
      ),
    ]
    #expect(evaluator.evaluate(usage: lowBoth, apps: longBothApps, displayNames: names, masterEnabled: false).isEmpty)

    // With masterEnabled == true and only "cursor" enabled (plus "all" which must still be skipped):
    // only cursor alerts fire; paused codex is suppressed
    let filteredEvents = evaluator.evaluate(
      usage: lowBoth,
      apps: longBothApps,
      displayNames: names,
      masterEnabled: true,
      enabledTools: Set(["cursor", "all"])
    )
    #expect(Set(filteredEvents.map(\.dedupeKey)) == Set([
      "quota:cursor:m:warning",
      "context200k:cursor:turn-cursor-200k",
    ]))
  }
}
