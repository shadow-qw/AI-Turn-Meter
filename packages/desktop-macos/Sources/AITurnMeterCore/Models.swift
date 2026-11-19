import Foundation

public struct TurnSummary: Decodable, Identifiable {
  public var id: String { turnUid ?? "\(tool ?? "turn")-\(completedAtMs ?? 0)-\(inlineText ?? "")" }
  public let turnUid: String?
  public let tool: String?
  public let toolLabel: String?
  public let model: String?
  public let workspacePath: String?
  public let totalInputTokens: Int?
  public let cacheReadTokens: Int?
  public let outputTokens: Int?
  public let cacheRatePct: Double?
  public let inlineText: String?
  public let tps: Double?
  public let completedAtMs: Double?
  public let estimatedCostUsd: Double?
  public let cacheSavingsUsd: Double?
  public let replyPreview: String?
}

public struct TurnsListResponse: Decodable {
  public let turns: [TurnSummary]
}

public struct UsageTotals: Decodable {
  public let turnCount: Int
  public let callCount: Int
  public let totalInputTokens: Int
  public let uncachedInputTokens: Int
  public let cacheReadTokens: Int
  public let cacheWriteTokens: Int
  public let outputTokens: Int
  public let thinkingTokens: Int
  public let totalTokens: Int
  public let cacheRatePct: Double?
  public let avgTps: Double?
  public let estimatedCostUsd: Double?
  public let cacheSavingsUsd: Double?
  public let pricedTurnCount: Int
  public let unpricedTurnCount: Int
}

public struct UsageToolRow: Decodable, Identifiable {
  public var id: String { tool }
  public let tool: String
  public let toolLabel: String
  public let sharePct: Double
  public let turnCount: Int
  public let callCount: Int
  public let totalInputTokens: Int
  public let cacheReadTokens: Int
  public let outputTokens: Int
  public let totalTokens: Int
  public let cacheRatePct: Double?
  public let avgTps: Double?
  public let estimatedCostUsd: Double?
  public let cacheSavingsUsd: Double?
}

public struct UsageModelRow: Decodable, Identifiable {
  public var id: String { "\(tool):\(model)" }
  public let tool: String
  public let toolLabel: String
  public let model: String
  public let priced: Bool
  public let sharePct: Double
  public let turnCount: Int
  public let callCount: Int
  public let totalInputTokens: Int
  public let cacheReadTokens: Int
  public let outputTokens: Int
  public let totalTokens: Int
  public let cacheRatePct: Double?
  public let avgTps: Double?
  public let estimatedCostUsd: Double?
  public let cacheSavingsUsd: Double?
}

public struct UsageDailyPoint: Decodable, Identifiable {
  public var id: String { date }
  public let date: String
  public let turnCount: Int
  public let totalInputTokens: Int
  public let outputTokens: Int
  public let totalTokens: Int
  public let estimatedCostUsd: Double?
  public let cacheSavingsUsd: Double?
}

public struct CardTodayMetrics: Decodable {
  public let costUsd: Double?
  public let totalTokens: Int
  public let totalInputTokens: Int
  public let outputTokens: Int
  public let turnCount: Int
  public let callCount: Int
  public let cacheRatePct: Double?
  public let avgTps: Double?
  public let cacheSavingsUsd: Double?

  public init(
    costUsd: Double?,
    totalTokens: Int,
    totalInputTokens: Int,
    outputTokens: Int,
    turnCount: Int,
    callCount: Int,
    cacheRatePct: Double?,
    avgTps: Double?,
    cacheSavingsUsd: Double?
  ) {
    self.costUsd = costUsd
    self.totalTokens = totalTokens
    self.totalInputTokens = totalInputTokens
    self.outputTokens = outputTokens
    self.turnCount = turnCount
    self.callCount = callCount
    self.cacheRatePct = cacheRatePct
    self.avgTps = avgTps
    self.cacheSavingsUsd = cacheSavingsUsd
  }
}

public struct CardWindowMetrics: Decodable {
  public let costUsd: Double?
  public let totalTokens: Int
  public let turnCount: Int

  public init(costUsd: Double?, totalTokens: Int, turnCount: Int) {
    self.costUsd = costUsd
    self.totalTokens = totalTokens
    self.turnCount = turnCount
  }
}

public struct CardDailyModelItem: Decodable, Identifiable {
  public var id: String { model }
  public let model: String
  public let costUsd: Double?
  public let totalTokens: Int
}

public struct CardDailyPoint: Decodable, Identifiable {
  public var id: String { date }
  public let date: String
  public let label: String
  public let totalTokens: Int
  public let costUsd: Double?
  public let turnCount: Int
  public let models: [CardDailyModelItem]?
}

public struct CardProjectBreakdown: Decodable, Identifiable {
  public var id: String { "\(name)-\(path)" }
  public let name: String
  public let path: String
  public let costUsd: Double?
  public let totalTokens: Int
  public let turnCount: Int
}

public struct CardRecentWindow: Decodable, Identifiable {
  public var id: Int { index }
  public let index: Int
  public let title: String
  public let rangeText: String
  public let costUsd: Double?
  public let totalTokens: Int
  public let turnCount: Int
}

public struct CardQuotaWindow: Decodable, Identifiable {
  public let id: String
  public let title: String
  public let remainingPct: Double
  public let resetText: String?
  public let pacePct: Double?
  public let subtitle: String?
}

public struct CodexBarCardSnapshot: Decodable {
  public let accountEmail: String?
  public let planTitle: String?
  public let quotaWindows: [CardQuotaWindow]?
  public let resetCreditsText: String?
  public let quotaHint: String?
  public let latestTpsText: String?
  public let latestCacheText: String?
  public let latestTurnSubline: String?
  public let today: CardTodayMetrics
  public let currentWindow: CardWindowMetrics
  public let days30: CardWindowMetrics
  public let daily30: [CardDailyPoint]
  public let projects: [CardProjectBreakdown]?
  public let recentWindows: [CardRecentWindow]
  public let topModel: String?

  public init(
    accountEmail: String?,
    planTitle: String?,
    quotaWindows: [CardQuotaWindow]?,
    resetCreditsText: String?,
    quotaHint: String?,
    latestTpsText: String?,
    latestCacheText: String?,
    latestTurnSubline: String?,
    today: CardTodayMetrics,
    currentWindow: CardWindowMetrics,
    days30: CardWindowMetrics,
    daily30: [CardDailyPoint],
    projects: [CardProjectBreakdown]?,
    recentWindows: [CardRecentWindow],
    topModel: String?
  ) {
    self.accountEmail = accountEmail
    self.planTitle = planTitle
    self.quotaWindows = quotaWindows
    self.resetCreditsText = resetCreditsText
    self.quotaHint = quotaHint
    self.latestTpsText = latestTpsText
    self.latestCacheText = latestCacheText
    self.latestTurnSubline = latestTurnSubline
    self.today = today
    self.currentWindow = currentWindow
    self.days30 = days30
    self.daily30 = daily30
    self.projects = projects
    self.recentWindows = recentWindows
    self.topModel = topModel
  }
}

public struct UsageProjectRow: Decodable, Identifiable {
  public var id: String { "\(name)-\(path)" }
  public let name: String
  public let path: String
  public let sharePct: Double
  public let turnCount: Int
  public let callCount: Int
  public let totalInputTokens: Int
  public let cacheReadTokens: Int
  public let outputTokens: Int
  public let totalTokens: Int
  public let cacheRatePct: Double?
  public let avgTps: Double?
  public let estimatedCostUsd: Double?
  public let cacheSavingsUsd: Double?
}

public struct UsageSummaryResponse: Decodable {
  public let days: Int
  public let tool: String?
  public let today: UsageTotals
  public let totals: UsageTotals
  public let byTool: [UsageToolRow]
  public let byModel: [UsageModelRow]
  public let byProject: [UsageProjectRow]?
  public let daily: [UsageDailyPoint]
  public let cards: [String: CodexBarCardSnapshot]?
}

public struct DaemonStateResponse: Decodable {
  public let config: MeterConfigPayload?
  public let byTool: [String: TurnSummary?]?
  public let latest: TurnSummary?
  public let todaySummary: UsageTotals?
  public let recent: [TurnSummary]?
}

public struct MeterConfigPayload: Decodable {
  public let enabled: Bool
  public let tools: [String: Bool]
  public let inlineEnabled: Bool?
  public let inlineTools: [String: Bool]?
  public let hasCursorCookie: Bool?
}

public struct StatusAppEntry: Decodable {
  public let name: String
  public let appPath: String?
  public let installed: Bool
  public let running: Bool?
  public let cdpPort: Int?
  public let latestTurn: TurnSummary?

  public init(
    name: String,
    appPath: String?,
    installed: Bool,
    running: Bool?,
    cdpPort: Int?,
    latestTurn: TurnSummary?
  ) {
    self.name = name
    self.appPath = appPath
    self.installed = installed
    self.running = running
    self.cdpPort = cdpPort
    self.latestTurn = latestTurn
  }
}

public struct StatusResponse: Decodable {
  public let version: String?
  public let port: Int
  public let online: Bool
  public let config: MeterConfigPayload?
  public let apps: [String: StatusAppEntry]
  public let state: DaemonStateResponse?
}

public enum SettingsPane: Hashable {
  case general
  case usage
  case menuBar
  case turns
  case fingerprint
  case remote
  case about
  case provider(String)
}

public enum MainTab: String, CaseIterable {
  case control = "客户端与设置"
  case usage = "用量仪表盘"
  case turns = "最近轮次"

  public var icon: String {
    switch self {
    case .control: return "slider.horizontal.3"
    case .usage: return "chart.bar.xaxis"
    case .turns: return "clock.arrow.circlepath"
    }
  }
}

public enum MenuBarDisplayMode: String, CaseIterable {
  case iconOnly = "iconOnly"
  case quotaRemaining = "quotaRemaining"
  case todayCost = "todayCost"
  case todayTokensAndCost = "todayTokensAndCost"
  case tps = "tps"
  case latestInline = "latestInline"

  public var title: String {
    switch self {
    case .iconOnly: return "仅图标"
    case .quotaRemaining: return "配额百分比"
    case .todayCost: return "今日费用"
    case .todayTokensAndCost: return "今日用量 + 费用"
    case .tps: return "实时速度"
    case .latestInline: return "最近一轮简报"
    }
  }
}

public enum MenuBarIconStyle: String, CaseIterable {
  case dualBar = "dualBar"
  case gauge = "gauge"
  case none = "none"

  public var title: String {
    switch self {
    case .dualBar: return "配额进度条（默认）"
    case .gauge: return "仪表盘"
    case .none: return "无图标（仅文字）"
    }
  }
}

public enum MenuBarUsageScope: String, CaseIterable {
  case all = "all"
  case provider = "provider"

  public var title: String {
    switch self {
    case .all: return "全部软件汇总（默认）"
    case .provider: return "仅当前展示软件"
    }
  }
}

public enum QuotaDisplayMode: String, CaseIterable {
  case remaining = "remaining"
  case used = "used"

  public var title: String {
    switch self {
    case .remaining: return "按剩余比例（默认）"
    case .used: return "按已用用量"
    }
  }

  public var verbLabel: String {
    switch self {
    case .remaining: return "剩余"
    case .used: return "已用"
    }
  }

  public var compactPrefix: String {
    switch self {
    case .remaining: return "剩"
    case .used: return "用"
    }
  }

  public func displayPct(fromRemaining remainingPct: Double) -> Double {
    let clamped = min(100.0, max(0.0, remainingPct))
    return self == .used ? max(0.0, min(100.0, 100.0 - clamped)) : clamped
  }

  public func displayPacePct(fromRemainingPace pacePct: Double?) -> Double? {
    guard let pacePct = pacePct else { return nil }
    let clamped = min(100.0, max(0.0, pacePct))
    return self == .used ? max(0.0, min(100.0, 100.0 - clamped)) : clamped
  }
}

public struct DoctorDaemon: Decodable {
  public let ok: Bool
  public let pid: Int?
  public let port: Int
  public let version: String?
  public let root: String?
}

public struct DoctorLaunchAgent: Decodable {
  public let plistPath: String
  public let plistExists: Bool
  public let launchAgentLoaded: Bool
  public let pointsToCurrentRoot: Bool?
  public let managedByApp: Bool?
}

public struct DoctorCursorHooks: Decodable {
  public let validVersion: Bool
  public let configured: Bool
}

public struct DoctorAppEntry: Decodable {
  public let name: String
  public let appPath: String?
  public let installed: Bool
  public let cdpPort: Int?
  public let vsixVersion: String?
}

public struct DoctorResponse: Decodable {
  public let version: String?
  public let updateFeedUrl: String?
  public let daemon: DoctorDaemon
  public let launchAgent: DoctorLaunchAgent
  public let cursorHooks: DoctorCursorHooks
  public let apps: [String: DoctorAppEntry]
}

public struct UpdateReleaseInfo: Equatable, Sendable {
  public let version: String
  public let downloadUrl: String
  public let notes: String
  public let sha256Url: String?
  public let expectedSha256: String?

  public init(
    version: String,
    downloadUrl: String,
    notes: String,
    sha256Url: String? = nil,
    expectedSha256: String? = nil
  ) {
    self.version = version
    self.downloadUrl = downloadUrl
    self.notes = notes
    self.sha256Url = sha256Url
    self.expectedSha256 = expectedSha256
  }
}

public struct CommandResult {
  public let exitCode: Int32
  public let stdout: String
  public let stderr: String

  public init(exitCode: Int32, stdout: String, stderr: String) {
    self.exitCode = exitCode
    self.stdout = stdout
    self.stderr = stderr
  }
}
