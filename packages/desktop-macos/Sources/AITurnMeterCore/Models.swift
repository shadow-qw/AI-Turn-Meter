import Foundation

public struct TurnSummary: Decodable, Identifiable {
  public var id: String { turnUid ?? "\(tool ?? "turn")-\(completedAtMs ?? 0)-\(inlineText ?? "")" }
  public let turnUid: String?
  public let tool: String?
  public let host: String?
  public let toolLabel: String?
  public let model: String?
  public let workspacePath: String?
  public let callCount: Int?
  public let totalInputTokens: Int?
  public let cacheReadTokens: Int?
  public let outputTokens: Int?
  public let thinkingTokens: Int?
  public let cacheRatePct: Double?
  public let inlineText: String?
  public let tps: Double?
  public let completedAtMs: Double?
  public let estimatedCostUsd: Double?
  public let cacheSavingsUsd: Double?
  public let replyPreview: String?

  public init(
    turnUid: String? = nil,
    tool: String? = nil,
    host: String? = nil,
    toolLabel: String? = nil,
    model: String? = nil,
    workspacePath: String? = nil,
    callCount: Int? = nil,
    totalInputTokens: Int? = nil,
    cacheReadTokens: Int? = nil,
    outputTokens: Int? = nil,
    thinkingTokens: Int? = nil,
    cacheRatePct: Double? = nil,
    inlineText: String? = nil,
    tps: Double? = nil,
    completedAtMs: Double? = nil,
    estimatedCostUsd: Double? = nil,
    cacheSavingsUsd: Double? = nil,
    replyPreview: String? = nil
  ) {
    self.turnUid = turnUid
    self.tool = tool
    self.host = host
    self.toolLabel = toolLabel
    self.model = model
    self.workspacePath = workspacePath
    self.callCount = callCount
    self.totalInputTokens = totalInputTokens
    self.cacheReadTokens = cacheReadTokens
    self.outputTokens = outputTokens
    self.thinkingTokens = thinkingTokens
    self.cacheRatePct = cacheRatePct
    self.inlineText = inlineText
    self.tps = tps
    self.completedAtMs = completedAtMs
    self.estimatedCostUsd = estimatedCostUsd
    self.cacheSavingsUsd = cacheSavingsUsd
    self.replyPreview = replyPreview
  }
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

  public init(
    turnCount: Int = 0,
    callCount: Int = 0,
    totalInputTokens: Int = 0,
    uncachedInputTokens: Int = 0,
    cacheReadTokens: Int = 0,
    cacheWriteTokens: Int = 0,
    outputTokens: Int = 0,
    thinkingTokens: Int = 0,
    totalTokens: Int = 0,
    cacheRatePct: Double? = nil,
    avgTps: Double? = nil,
    estimatedCostUsd: Double? = nil,
    cacheSavingsUsd: Double? = nil,
    pricedTurnCount: Int = 0,
    unpricedTurnCount: Int = 0
  ) {
    self.turnCount = turnCount
    self.callCount = callCount
    self.totalInputTokens = totalInputTokens
    self.uncachedInputTokens = uncachedInputTokens
    self.cacheReadTokens = cacheReadTokens
    self.cacheWriteTokens = cacheWriteTokens
    self.outputTokens = outputTokens
    self.thinkingTokens = thinkingTokens
    self.totalTokens = totalTokens
    self.cacheRatePct = cacheRatePct
    self.avgTps = avgTps
    self.estimatedCostUsd = estimatedCostUsd
    self.cacheSavingsUsd = cacheSavingsUsd
    self.pricedTurnCount = pricedTurnCount
    self.unpricedTurnCount = unpricedTurnCount
  }
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
  public let thinkingTokens: Int?
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
  public let thinkingTokens: Int?
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

public struct ExternalProviderAuth: Decodable, Equatable, Sendable {
  public let type: String
  public let loginUrl: String?
  public let cookieDomains: [String]?
  public let requiredCookies: [String]?
  public let successUrlPrefixes: [String]?
  public let excludePathKeywords: [String]?
  public let captureStorageKeys: [String]?
  public let label: String?
  public let hint: String?

  public var isWebCookie: Bool { type == "web_cookie" && loginUrl != nil }
  public var displayLabel: String {
    if let l = label, !l.isEmpty { return l }
    return isWebCookie ? "网页登录授权" : "配置凭证"
  }
}

public struct ExternalProviderMeta: Decodable, Identifiable, Equatable, Sendable {
  public var id: String { key }
  public let key: String
  public let providerId: String?
  public let name: String
  public let shortName: String
  public let icon: String?
  public let accentColor: String?
  public let currency: String?
  public let currencySymbol: String?
  public let detailUrl: String?
  public let auth: ExternalProviderAuth?
  public let hasCredentials: Bool?
  public let credentialsSavedAtMs: Double?
  public let fileName: String?
  public let filePath: String?
  public let enabled: Bool?
  public let ok: Bool?
  public let error: String?
}

public struct CardBillingSummary: Decodable {
  public let todayCost: Double?
  public let todayTokens: Int?
  public let periodLabel: String?
  public let periodCost: Double?
  public let periodLimit: Double?
  public let periodRemaining: Double?
  public let periodTokens: Int?
  public let updatedAtMs: Double?

  public init(
    todayCost: Double? = nil,
    todayTokens: Int? = nil,
    periodLabel: String? = nil,
    periodCost: Double? = nil,
    periodLimit: Double? = nil,
    periodRemaining: Double? = nil,
    periodTokens: Int? = nil,
    updatedAtMs: Double? = nil
  ) {
    self.todayCost = todayCost
    self.todayTokens = todayTokens
    self.periodLabel = periodLabel
    self.periodCost = periodCost
    self.periodLimit = periodLimit
    self.periodRemaining = periodRemaining
    self.periodTokens = periodTokens
    self.updatedAtMs = updatedAtMs
  }
}

public struct CardBreakdownItem: Decodable, Identifiable {
  public let id: String
  public let name: String
  public let cost: Double?
  public let limit: Double?
  public let usagePct: Double?
  public let sharePct: Double?
  public let tokens: Int?
  public let subtitle: String?
}

public struct CardBreakdownSection: Decodable, Identifiable {
  public let id: String
  public let title: String
  public let items: [CardBreakdownItem]
}

public struct CardQuotaWindow: Decodable, Identifiable {
  public let id: String
  public let title: String
  public let remainingPct: Double
  public let resetText: String?
  public let pacePct: Double?
  public let subtitle: String?
  public let group: String?
  public let windowKind: String?

  public var healthLevel: QuotaHealthLevel {
    QuotaHealthLevel.quotaHealth(remainingPct: remainingPct)
  }

  public init(
    id: String,
    title: String,
    remainingPct: Double,
    resetText: String? = nil,
    pacePct: Double? = nil,
    subtitle: String? = nil,
    group: String? = nil,
    windowKind: String? = nil
  ) {
    self.id = id
    self.title = title
    self.remainingPct = remainingPct
    self.resetText = resetText
    self.pacePct = pacePct
    self.subtitle = subtitle
    self.group = group
    self.windowKind = windowKind
  }
}

public struct CardSessionSummary: Decodable, Identifiable, Equatable {
  public var id: String { "\(tool):\(sessionId)" }
  public let sessionId: String
  public let tool: String
  public let title: String
  public let workspacePath: String?
  public let model: String?
  public let modelCount: Int?
  public let subagentCount: Int?
  public let totalTokens: Int
  public let thinkingTokens: Int?
  public let estimatedCostUsd: Double?
  public let turnCount: Int?
  public let lastActiveAtMs: Double?
  public let isActive: Bool?

  public init(
    sessionId: String,
    tool: String,
    title: String,
    workspacePath: String? = nil,
    model: String? = nil,
    modelCount: Int? = nil,
    subagentCount: Int? = nil,
    totalTokens: Int,
    thinkingTokens: Int? = nil,
    estimatedCostUsd: Double? = nil,
    turnCount: Int? = nil,
    lastActiveAtMs: Double? = nil,
    isActive: Bool? = nil
  ) {
    self.sessionId = sessionId
    self.tool = tool
    self.title = title
    self.workspacePath = workspacePath
    self.model = model
    self.modelCount = modelCount
    self.subagentCount = subagentCount
    self.totalTokens = totalTokens
    self.thinkingTokens = thinkingTokens
    self.estimatedCostUsd = estimatedCostUsd
    self.turnCount = turnCount
    self.lastActiveAtMs = lastActiveAtMs
    self.isActive = isActive
  }
}

public enum ProviderOrder {
  public static let defaultBuiltIn: [String] = ["codex", "cursor", "antigravity", "codebuddy"]

  public static func resolve(saved: [String], available: [String]) -> [String] {
    let availSet = Set(available)
    var seen = Set<String>()
    var out: [String] = []
    for key in saved where availSet.contains(key) && !seen.contains(key) {
      seen.insert(key)
      out.append(key)
    }
    for key in available where !seen.contains(key) {
      seen.insert(key)
      out.append(key)
    }
    return out
  }

  public static func move(order: [String], from sourceKey: String, to targetKey: String) -> [String] {
    guard sourceKey != targetKey,
          let fromIdx = order.firstIndex(of: sourceKey),
          let toIdx = order.firstIndex(of: targetKey) else {
      return order
    }
    var next = order
    let item = next.remove(at: fromIdx)
    next.insert(item, at: toIdx)
    return next
  }

  public static func sortOverviewWindows(
    _ windows: [CardQuotaWindow],
    by order: [String]
  ) -> [CardQuotaWindow] {
    guard windows.count > 1, !order.isEmpty else { return windows }
    var rankMap: [String: Int] = [:]
    for (idx, key) in order.enumerated() {
      rankMap[key] = idx
    }
    return windows.enumerated().sorted { lhs, rhs in
      let lKey = lhs.element.id.hasPrefix("overview-")
        ? String(lhs.element.id.dropFirst("overview-".count))
        : lhs.element.id
      let rKey = rhs.element.id.hasPrefix("overview-")
        ? String(rhs.element.id.dropFirst("overview-".count))
        : rhs.element.id
      let lRank = rankMap[lKey] ?? Int.max
      let rRank = rankMap[rKey] ?? Int.max
      if lRank != rRank { return lRank < rRank }
      return lhs.offset < rhs.offset
    }.map(\.element)
  }
}

public struct CodexBarCardSnapshot: Decodable {
  public let isExternal: Bool?
  public let providerName: String?
  public let providerShortName: String?
  public let providerIcon: String?
  public let accentColor: String?
  public let currencyCode: String?
  public let currencySymbol: String?
  public let detailUrl: String?
  public let statusText: String?
  public let footnote: String?
  public let stale: Bool?
  public let needsAuth: Bool?
  public let accountEmail: String?
  public let planTitle: String?
  public let quotaWindows: [CardQuotaWindow]?
  public let resetCreditsText: String?
  public let quotaHint: String?
  public let latestTpsText: String?
  public let latestCacheText: String?
  public let latestTurnSubline: String?
  public let billingSummary: CardBillingSummary?
  public let today: CardTodayMetrics
  public let currentWindow: CardWindowMetrics
  public let days30: CardWindowMetrics
  public let daily30: [CardDailyPoint]
  public let projects: [CardProjectBreakdown]?
  public let recentWindows: [CardRecentWindow]
  public let breakdowns: [CardBreakdownSection]?
  public let topModel: String?
  public let recentSessions: [CardSessionSummary]?

  public var resolvedCurrencySymbol: String {
    if let sym = currencySymbol, !sym.isEmpty { return sym }
    if currencyCode?.uppercased() == "CNY" { return "¥" }
    return "$"
  }

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
    topModel: String?,
    isExternal: Bool? = nil,
    providerName: String? = nil,
    providerShortName: String? = nil,
    providerIcon: String? = nil,
    accentColor: String? = nil,
    currencyCode: String? = nil,
    currencySymbol: String? = nil,
    detailUrl: String? = nil,
    statusText: String? = nil,
    footnote: String? = nil,
    stale: Bool? = nil,
    billingSummary: CardBillingSummary? = nil,
    breakdowns: [CardBreakdownSection]? = nil,
    needsAuth: Bool? = nil,
    recentSessions: [CardSessionSummary]? = nil
  ) {
    self.needsAuth = needsAuth
    self.isExternal = isExternal
    self.providerName = providerName
    self.providerShortName = providerShortName
    self.providerIcon = providerIcon
    self.accentColor = accentColor
    self.currencyCode = currencyCode
    self.currencySymbol = currencySymbol
    self.detailUrl = detailUrl
    self.statusText = statusText
    self.footnote = footnote
    self.stale = stale
    self.accountEmail = accountEmail
    self.planTitle = planTitle
    self.quotaWindows = quotaWindows
    self.resetCreditsText = resetCreditsText
    self.quotaHint = quotaHint
    self.latestTpsText = latestTpsText
    self.latestCacheText = latestCacheText
    self.latestTurnSubline = latestTurnSubline
    self.billingSummary = billingSummary
    self.today = today
    self.currentWindow = currentWindow
    self.days30 = days30
    self.daily30 = daily30
    self.projects = projects
    self.recentWindows = recentWindows
    self.breakdowns = breakdowns
    self.topModel = topModel
    self.recentSessions = recentSessions
  }
}

public struct UsageWorkspaceRow: Decodable, Identifiable, Equatable {
  public var id: String { workspacePath }
  public let workspacePath: String
  public let workspaceName: String
  public let turnCount: Int
  public let totalTokens: Int
  public let thinkingTokens: Int?
  public let outputTokens: Int?
  public let estimatedCostUsd: Double?
  public let sharePct: Double
  public let tools: [String]?

  public init(
    workspacePath: String,
    workspaceName: String,
    turnCount: Int,
    totalTokens: Int,
    thinkingTokens: Int? = nil,
    outputTokens: Int? = nil,
    estimatedCostUsd: Double? = nil,
    sharePct: Double,
    tools: [String]? = nil
  ) {
    self.workspacePath = workspacePath
    self.workspaceName = workspaceName
    self.turnCount = turnCount
    self.totalTokens = totalTokens
    self.thinkingTokens = thinkingTokens
    self.outputTokens = outputTokens
    self.estimatedCostUsd = estimatedCostUsd
    self.sharePct = sharePct
    self.tools = tools
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
  public let byWorkspace: [UsageWorkspaceRow]?
  public let daily: [UsageDailyPoint]
  public let cards: [String: CodexBarCardSnapshot]?
  public let externalProviders: [ExternalProviderMeta]?
  public let providersDir: String?

  public init(
    days: Int = 7,
    tool: String? = nil,
    today: UsageTotals = UsageTotals(),
    totals: UsageTotals = UsageTotals(),
    byTool: [UsageToolRow] = [],
    byModel: [UsageModelRow] = [],
    byProject: [UsageProjectRow]? = nil,
    byWorkspace: [UsageWorkspaceRow]? = nil,
    daily: [UsageDailyPoint] = [],
    cards: [String: CodexBarCardSnapshot]? = nil,
    externalProviders: [ExternalProviderMeta]? = nil,
    providersDir: String? = nil
  ) {
    self.days = days
    self.tool = tool
    self.today = today
    self.totals = totals
    self.byTool = byTool
    self.byModel = byModel
    self.byProject = byProject
    self.byWorkspace = byWorkspace
    self.daily = daily
    self.cards = cards
    self.externalProviders = externalProviders
    self.providersDir = providersDir
  }
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
  public let externalProviders: [ExternalProviderMeta]?
  public let providersDir: String?
  public let state: DaemonStateResponse?
}

public enum SettingsPane: Hashable {
  case general
  case usage
  case menuBar
  case turns
  case fingerprint
  case plugins
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
  case remainingAmount = "remainingAmount"
  case quotaAndAmount = "quotaAndAmount"
  case todayCost = "todayCost"
  case todayTokensAndCost = "todayTokensAndCost"
  case tps = "tps"
  case latestInline = "latestInline"

  public var title: String {
    switch self {
    case .iconOnly: return "仅图标"
    case .quotaRemaining: return "配额百分比"
    case .remainingAmount: return "剩余金额（如 ¥1085）"
    case .quotaAndAmount: return "百分比 + 剩余金额"
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
  public let vsixVersionMismatch: Bool?
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

public enum QuotaHealthLevel: Equatable, Sendable {
  case normal
  case warning
  case critical

  public static func quotaHealth(remainingPct: Double) -> QuotaHealthLevel {
    guard remainingPct.isFinite else { return .normal }
    if remainingPct <= 5.0 { return .critical }
    if remainingPct <= 20.0 { return .warning }
    return .normal
  }
}

public struct QuotaAlertEvent: Equatable, Sendable {
  public let dedupeKey: String
  public let title: String
  public let body: String

  public init(dedupeKey: String, title: String, body: String) {
    self.dedupeKey = dedupeKey
    self.title = title
    self.body = body
  }
}

public struct QuotaAlertEvaluator: Sendable {
  public static let warningThresholdPct: Double = 20.0
  public static let criticalThresholdPct: Double = 5.0
  public static let rearmQuotaThresholdPct: Double = 25.0
  public static let resetPreviousMaxPct: Double = 50.0
  public static let resetRefillMinPct: Double = 95.0
  public static let budgetWarningRatio: Double = 0.80
  public static let budgetCriticalRatio: Double = 0.90
  public static let budgetRearmRatio: Double = 0.70
  public static let longContextThresholdTokens: Int = 200_000

  public let cooldownSeconds: TimeInterval
  public let maxLongContextTurnAgeSeconds: TimeInterval?

  private var hasSeededBaseline: Bool = false
  private var hasSeededAppsBaseline: Bool = false
  private var lastRemainingByWindow: [String: Double] = [:]
  private var alertedQuotaTiersByWindow: [String: Set<String>] = [:]
  private var alertedBudgetTiersByKey: [String: Set<String>] = [:]
  private var alertedLongContextTurnUids: Set<String> = []
  private var lastSentAtByDedupeKey: [String: Date] = [:]

  public init(
    cooldownSeconds: TimeInterval = 0,
    maxLongContextTurnAgeSeconds: TimeInterval? = nil
  ) {
    self.cooldownSeconds = max(0, cooldownSeconds)
    self.maxLongContextTurnAgeSeconds = maxLongContextTurnAgeSeconds
  }

  public static func quotaHealth(remainingPct: Double) -> QuotaHealthLevel {
    QuotaHealthLevel.quotaHealth(remainingPct: remainingPct)
  }

  public mutating func reset() {
    hasSeededBaseline = false
    hasSeededAppsBaseline = false
    lastRemainingByWindow.removeAll()
    alertedQuotaTiersByWindow.removeAll()
    alertedBudgetTiersByKey.removeAll()
    alertedLongContextTurnUids.removeAll()
    lastSentAtByDedupeKey.removeAll()
  }

  private mutating func seedUsageBaseline(cards: [String: CodexBarCardSnapshot]) {
    for providerKey in cards.keys.sorted() {
      guard providerKey != "all", let card = cards[providerKey] else { continue }

      for win in card.quotaWindows ?? [] {
        guard win.remainingPct.isFinite else { continue }
        let windowKey = "\(providerKey):\(win.id)"
        lastRemainingByWindow[windowKey] = win.remainingPct
        switch QuotaHealthLevel.quotaHealth(remainingPct: win.remainingPct) {
        case .critical:
          alertedQuotaTiersByWindow[windowKey] = ["warning", "critical"]
        case .warning:
          alertedQuotaTiersByWindow[windowKey] = ["warning"]
        case .normal:
          alertedQuotaTiersByWindow[windowKey] = []
        }
      }

      if let billing = card.billingSummary,
         let limit = billing.periodLimit,
         limit.isFinite,
         limit > 0 {
        let used: Double? = {
          if let cost = billing.periodCost, cost.isFinite { return max(0, cost) }
          if let rem = billing.periodRemaining, rem.isFinite { return max(0, limit - rem) }
          return nil
        }()
        if let used = used {
          let ratio = used / limit
          let periodTag = (billing.periodLabel?.isEmpty == false ? billing.periodLabel! : "period")
          let budgetKey = "\(providerKey):\(periodTag)"
          if ratio >= Self.budgetCriticalRatio {
            alertedBudgetTiersByKey[budgetKey] = ["80", "90"]
          } else if ratio >= Self.budgetWarningRatio {
            alertedBudgetTiersByKey[budgetKey] = ["80"]
          } else {
            alertedBudgetTiersByKey[budgetKey] = []
          }
        }
      }
    }
  }

  private mutating func seedAppsBaseline(apps: [String: StatusAppEntry]) {
    for app in apps.values {
      if let turnUid = app.latestTurn?.turnUid, !turnUid.isEmpty {
        alertedLongContextTurnUids.insert(turnUid)
      }
    }
  }

  private mutating func shouldEmit(dedupeKey: String, now: Date) -> Bool {
    if cooldownSeconds > 0, let prev = lastSentAtByDedupeKey[dedupeKey] {
      if now.timeIntervalSince(prev) < cooldownSeconds {
        return false
      }
    }
    if cooldownSeconds > 0 {
      lastSentAtByDedupeKey = lastSentAtByDedupeKey.filter { _, sentAt in
        now.timeIntervalSince(sentAt) < cooldownSeconds
      }
    }
    if lastSentAtByDedupeKey.count >= 500 {
      let overflow = lastSentAtByDedupeKey.count - 450
      for (k, _) in lastSentAtByDedupeKey.sorted(by: { $0.value < $1.value }).prefix(overflow) {
        lastSentAtByDedupeKey.removeValue(forKey: k)
      }
    }
    lastSentAtByDedupeKey[dedupeKey] = now
    return true
  }

  public mutating func evaluate(
    usage: UsageSummaryResponse?,
    apps: [String: StatusAppEntry],
    displayNames: [String: String] = [:],
    now: Date = Date(),
    masterEnabled: Bool = true,
    enabledTools: Set<String>? = nil
  ) -> [QuotaAlertEvent] {
    let cards = usage?.cards
    let hasRealCards = cards?.keys.contains(where: { $0 != "all" }) ?? false

    if !hasSeededBaseline && hasRealCards, let cards = cards {
      seedUsageBaseline(cards: cards)
      hasSeededBaseline = true
      if !hasSeededAppsBaseline && !apps.isEmpty {
        seedAppsBaseline(apps: apps)
        hasSeededAppsBaseline = true
      }
      return []
    }

    var seededAppsThisCall = false
    if !hasSeededAppsBaseline && !apps.isEmpty {
      seedAppsBaseline(apps: apps)
      hasSeededAppsBaseline = true
      seededAppsThisCall = true
    }

    guard masterEnabled else {
      lastRemainingByWindow.removeAll(keepingCapacity: true)
      return []
    }

    if let enabledTools = enabledTools {
      lastRemainingByWindow = lastRemainingByWindow.filter { key, _ in
        if key.hasPrefix("ext:") {
          let afterPrefix = key.index(key.startIndex, offsetBy: 4)
          guard let sep = key[afterPrefix...].firstIndex(of: ":") else { return false }
          return enabledTools.contains(String(key[..<sep]))
        }
        guard let sep = key.firstIndex(of: ":") else { return false }
        return enabledTools.contains(String(key[..<sep]))
      }
    }

    var events: [QuotaAlertEvent] = []

    if let cards = cards {
      for providerKey in cards.keys.sorted() {
        guard providerKey != "all", let card = cards[providerKey] else { continue }
        if let enabledTools = enabledTools, !enabledTools.contains(providerKey) {
          continue
        }
        let providerTitle = displayNames[providerKey]
          ?? card.providerName
          ?? card.providerShortName
          ?? providerKey

        for win in card.quotaWindows ?? [] {
          guard win.remainingPct.isFinite else { continue }
          let windowKey = "\(providerKey):\(win.id)"
          let previousRemaining = lastRemainingByWindow[windowKey]
          lastRemainingByWindow[windowKey] = win.remainingPct

          if let prev = previousRemaining,
             prev < Self.resetPreviousMaxPct,
             win.remainingPct >= Self.resetRefillMinPct {
            alertedQuotaTiersByWindow[windowKey] = []
            let dedupeKey = "quota-reset:\(providerKey):\(win.id)"
            if shouldEmit(dedupeKey: dedupeKey, now: now) {
              events.append(QuotaAlertEvent(
                dedupeKey: dedupeKey,
                title: "\(providerTitle) 配额已重置",
                body: "\(win.title) 已恢复至 \(MeterFormat.pct(win.remainingPct))"
              ))
            }
            continue
          }

          if win.remainingPct > Self.rearmQuotaThresholdPct {
            alertedQuotaTiersByWindow[windowKey] = []
            continue
          }

          let level = QuotaHealthLevel.quotaHealth(remainingPct: win.remainingPct)
          var alertedTiers = alertedQuotaTiersByWindow[windowKey] ?? []
          let resetSuffix: String = {
            if let rt = win.resetText, !rt.isEmpty { return "（\(rt)）" }
            return ""
          }()

          switch level {
          case .critical:
            if !alertedTiers.contains("critical") {
              alertedTiers.insert("warning")
              alertedTiers.insert("critical")
              alertedQuotaTiersByWindow[windowKey] = alertedTiers
              let dedupeKey = "quota:\(providerKey):\(win.id):critical"
              if shouldEmit(dedupeKey: dedupeKey, now: now) {
                events.append(QuotaAlertEvent(
                  dedupeKey: dedupeKey,
                  title: "\(providerTitle) 配额告急",
                  body: "\(win.title) 仅剩 \(MeterFormat.pct(win.remainingPct))\(resetSuffix)"
                ))
              }
            }
          case .warning:
            if !alertedTiers.contains("warning") {
              alertedTiers.insert("warning")
              alertedQuotaTiersByWindow[windowKey] = alertedTiers
              let dedupeKey = "quota:\(providerKey):\(win.id):warning"
              if shouldEmit(dedupeKey: dedupeKey, now: now) {
                events.append(QuotaAlertEvent(
                  dedupeKey: dedupeKey,
                  title: "\(providerTitle) 配额偏低",
                  body: "\(win.title) 剩余 \(MeterFormat.pct(win.remainingPct))\(resetSuffix)"
                ))
              }
            }
          case .normal:
            break
          }
        }

        if let billing = card.billingSummary,
           let limit = billing.periodLimit,
           limit.isFinite,
           limit > 0 {
          let used: Double? = {
            if let cost = billing.periodCost, cost.isFinite { return max(0, cost) }
            if let rem = billing.periodRemaining, rem.isFinite { return max(0, limit - rem) }
            return nil
          }()

          if let used = used {
            let ratio = used / limit
            let periodTag = (billing.periodLabel?.isEmpty == false ? billing.periodLabel! : "period")
            let budgetKey = "\(providerKey):\(periodTag)"
            let periodDisplay = (billing.periodLabel?.isEmpty == false ? billing.periodLabel! : "本期")
            let sym = card.resolvedCurrencySymbol
            let usedStr = MeterFormat.money(used, symbol: sym)
            let limitStr = MeterFormat.money(limit, symbol: sym)
            let pctStr = MeterFormat.pct(ratio * 100.0)

            if ratio < Self.budgetRearmRatio {
              alertedBudgetTiersByKey[budgetKey] = []
            } else {
              var alerted = alertedBudgetTiersByKey[budgetKey] ?? []
              if ratio >= Self.budgetCriticalRatio {
                if !alerted.contains("90") {
                  alerted.insert("80")
                  alerted.insert("90")
                  alertedBudgetTiersByKey[budgetKey] = alerted
                  let dedupeKey = "budget:\(providerKey):\(periodTag):90"
                  if shouldEmit(dedupeKey: dedupeKey, now: now) {
                    events.append(QuotaAlertEvent(
                      dedupeKey: dedupeKey,
                      title: "\(providerTitle) 预算即将用尽",
                      body: "\(periodDisplay)已用 \(usedStr) / \(limitStr)（\(pctStr)）"
                    ))
                  }
                }
              } else if ratio >= Self.budgetWarningRatio {
                if !alerted.contains("80") {
                  alerted.insert("80")
                  alertedBudgetTiersByKey[budgetKey] = alerted
                  let dedupeKey = "budget:\(providerKey):\(periodTag):80"
                  if shouldEmit(dedupeKey: dedupeKey, now: now) {
                    events.append(QuotaAlertEvent(
                      dedupeKey: dedupeKey,
                      title: "\(providerTitle) 预算预警",
                      body: "\(periodDisplay)已用 \(usedStr) / \(limitStr)（\(pctStr)）"
                    ))
                  }
                }
              }
            }
          }
        }
      }
    }

    if !seededAppsThisCall {
      for toolKey in apps.keys.sorted() {
        if let enabledTools = enabledTools, !enabledTools.contains(toolKey) {
          continue
        }
        guard let app = apps[toolKey],
              let turn = app.latestTurn,
              let turnUid = turn.turnUid, !turnUid.isEmpty,
              let totalIn = turn.totalInputTokens, totalIn > 0 else {
          continue
        }
        let calls = max(1, turn.callCount ?? 1)
        let avgContextTokens = totalIn / calls
        guard avgContextTokens > Self.longContextThresholdTokens else { continue }
        guard !alertedLongContextTurnUids.contains(turnUid) else { continue }

        if let maxAge = maxLongContextTurnAgeSeconds,
           let completedMs = turn.completedAtMs,
           completedMs > 0 {
          let age = now.timeIntervalSince1970 - (completedMs / 1000.0)
          if age > maxAge {
            alertedLongContextTurnUids.insert(turnUid)
            continue
          }
        }

        alertedLongContextTurnUids.insert(turnUid)
        if alertedLongContextTurnUids.count > 500 {
          var retained = Set(apps.values.compactMap { $0.latestTurn?.turnUid })
          retained.insert(turnUid)
          alertedLongContextTurnUids = retained
        }

        let dedupeKey = "context200k:\(toolKey):\(turnUid)"
        if shouldEmit(dedupeKey: dedupeKey, now: now) {
          let toolTitle = displayNames[toolKey] ?? turn.toolLabel ?? app.name
          let modelPart = (turn.model?.isEmpty == false) ? "（\(turn.model!)）" : ""
          events.append(QuotaAlertEvent(
            dedupeKey: dedupeKey,
            title: "\(toolTitle) 触发 200k 长上下文档",
            body: "单次平均上下文约 \(MeterFormat.tokens(avgContextTokens)) tokens\(modelPart)"
          ))
        }
      }
    }

    return events
  }
}
