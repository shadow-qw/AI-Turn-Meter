import Foundation

public enum MenuBarMetricItem: String, CaseIterable, Codable, Identifiable, Sendable {
  case quotaPct = "quotaPct"
  case billingAmount = "billingAmount"
  case todayTokens = "todayTokens"
  case todayCost = "todayCost"
  case days30Cost = "days30Cost"
  case latestTps = "latestTps"
  case latestTokens = "latestTokens"
  case latestCacheRate = "latestCacheRate"
  case todayTurns = "todayTurns"

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .quotaPct: return "配额百分比"
    case .billingAmount: return "配额 / 周期金额"
    case .todayTokens: return "今日 Token 用量"
    case .todayCost: return "今日估算费用"
    case .days30Cost: return "近 30 天估算费用"
    case .latestTps: return "最近生成速率"
    case .latestTokens: return "最近轮次输入规模"
    case .latestCacheRate: return "最近缓存命中率"
    case .todayTurns: return "今日对话轮次"
    }
  }

  public var shortTitle: String {
    switch self {
    case .quotaPct: return "配额%"
    case .billingAmount: return "金额"
    case .todayTokens: return "今日用量"
    case .todayCost: return "今日费用"
    case .days30Cost: return "30天费用"
    case .latestTps: return "速率"
    case .latestTokens: return "末轮规模"
    case .latestCacheRate: return "缓存率"
    case .todayTurns: return "今日轮次"
    }
  }

  public var subtitle: String {
    switch self {
    case .quotaPct: return "如 剩75% / 用25%"
    case .billingAmount: return "外部或按额度的可用/已用金额"
    case .todayTokens: return "今日累计输入与输出 Token"
    case .todayCost: return "今日按模型定价估算的费用"
    case .days30Cost: return "近 30 天累计估算费用"
    case .latestTps: return "最近一轮流式解码速度 tok/s"
    case .latestTokens: return "最近一轮上下文输入 Token 数"
    case .latestCacheRate: return "最近一轮 Prompt 缓存命中率"
    case .todayTurns: return "今日已采集完成的对话轮数"
    }
  }

  public var systemImage: String {
    switch self {
    case .quotaPct: return "percent"
    case .billingAmount: return "yensign.circle"
    case .todayTokens: return "sum"
    case .todayCost: return "dollarsign.circle"
    case .days30Cost: return "calendar"
    case .latestTps: return "gauge.with.needle"
    case .latestTokens: return "text.bubble"
    case .latestCacheRate: return "memorychip"
    case .todayTurns: return "bubble.left.and.bubble.right"
    }
  }

  public var usesUsageScope: Bool {
    switch self {
    case .todayTokens, .todayCost, .days30Cost, .todayTurns:
      return true
    default:
      return false
    }
  }

  public var usesProviderMetric: Bool {
    self == .quotaPct || self == .billingAmount
  }

  public func sampleValue(
    quotaMode: QuotaDisplayMode,
    showProviderName: Bool,
    showQuotaPrefix: Bool,
    showMetricLabels: Bool
  ) -> String {
    let pctVal = quotaMode == .used ? "25%" : "75%"
    let pctCore = showQuotaPrefix ? "\(quotaMode.compactPrefix)\(pctVal)" : pctVal
    switch self {
    case .quotaPct:
      return showProviderName ? "Codex \(pctCore)" : pctCore
    case .billingAmount:
      return showProviderName ? "司内 ¥1085" : "¥1085"
    case .todayTokens:
      return showMetricLabels ? "今 12.4M" : "12.4M"
    case .todayCost:
      return showMetricLabels ? "今 $18.20" : "$18.20"
    case .days30Cost:
      return "30d $246"
    case .latestTps:
      return showMetricLabels ? "末 52 tok/s" : "52 tok/s"
    case .latestTokens:
      return showMetricLabels ? "末 64.2k" : "64.2k"
    case .latestCacheRate:
      return "缓 94%"
    case .todayTurns:
      return showMetricLabels ? "今 24 轮" : "24 轮"
    }
  }
}

public enum MenuBarSeparatorStyle: String, CaseIterable, Codable, Identifiable, Sendable {
  case dot = "dot"
  case pipe = "pipe"
  case slash = "slash"
  case space = "space"

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .dot: return "圆点 ·"
    case .pipe: return "竖线 |"
    case .slash: return "斜杠 /"
    case .space: return "空格"
    }
  }

  public var chipTitle: String {
    switch self {
    case .dot: return "·"
    case .pipe: return "|"
    case .slash: return "/"
    case .space: return "空格"
    }
  }

  public var rawSeparator: String {
    switch self {
    case .dot: return " · "
    case .pipe: return " | "
    case .slash: return " / "
    case .space: return "  "
    }
  }
}

public enum MenuBarPreset: String, CaseIterable, Identifiable, Sendable {
  case iconOnly = "iconOnly"
  case todayUsage = "todayUsage"
  case quotaPct = "quotaPct"
  case quotaAndAmount = "quotaAndAmount"
  case billingAmount = "billingAmount"
  case performance = "performance"
  case allInOne = "allInOne"

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .iconOnly: return "仅图标"
    case .todayUsage: return "今日用量 + 费用"
    case .quotaPct: return "配额百分比"
    case .quotaAndAmount: return "百分比 + 金额"
    case .billingAmount: return "仅金额"
    case .performance: return "最近速度 + 上下文"
    case .allInOne: return "配额 + 今日费用 + 速度"
    }
  }

  public var items: [MenuBarMetricItem] {
    switch self {
    case .iconOnly: return []
    case .todayUsage: return [.todayTokens, .todayCost]
    case .quotaPct: return [.quotaPct]
    case .quotaAndAmount: return [.quotaPct, .billingAmount]
    case .billingAmount: return [.billingAmount]
    case .performance: return [.latestTokens, .latestTps]
    case .allInOne: return [.quotaPct, .todayCost, .latestTps]
    }
  }
}

public struct PopoverSectionsConfig: Equatable, Codable, Sendable {
  public var showMiniChart: Bool
  public var showRecentWindows: Bool
  public var showRecentSessions: Bool
  public var showFooterModelInfo: Bool

  public init(
    showMiniChart: Bool = true,
    showRecentWindows: Bool = false,
    showRecentSessions: Bool = true,
    showFooterModelInfo: Bool = true
  ) {
    self.showMiniChart = showMiniChart
    self.showRecentWindows = showRecentWindows
    self.showRecentSessions = showRecentSessions
    self.showFooterModelInfo = showFooterModelInfo
  }

  private enum CodingKeys: String, CodingKey {
    case showMiniChart
    case showRecentWindows
    case showRecentSessions
    case showFooterModelInfo
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.showMiniChart = try c.decodeIfPresent(Bool.self, forKey: .showMiniChart) ?? true
    self.showRecentWindows = try c.decodeIfPresent(Bool.self, forKey: .showRecentWindows) ?? false
    self.showRecentSessions = try c.decodeIfPresent(Bool.self, forKey: .showRecentSessions) ?? true
    self.showFooterModelInfo = try c.decodeIfPresent(Bool.self, forKey: .showFooterModelInfo) ?? true
  }
}

public struct MenuBarCustomConfig: Equatable, Codable, Sendable {
  public var items: [MenuBarMetricItem]
  public var selectedProviders: [String]
  public var separator: MenuBarSeparatorStyle
  public var showProviderName: Bool
  public var showQuotaPrefix: Bool
  public var showMetricLabels: Bool
  public var popoverSections: PopoverSectionsConfig

  public init(
    items: [MenuBarMetricItem] = [.todayTokens, .todayCost],
    selectedProviders: [String] = [],
    separator: MenuBarSeparatorStyle = .dot,
    showProviderName: Bool = true,
    showQuotaPrefix: Bool = true,
    showMetricLabels: Bool = false,
    popoverSections: PopoverSectionsConfig = PopoverSectionsConfig()
  ) {
    self.items = Self.deduplicated(items)
    self.selectedProviders = Self.deduplicated(selectedProviders.filter { !$0.isEmpty && $0 != "auto" })
    self.separator = separator
    self.showProviderName = showProviderName
    self.showQuotaPrefix = showQuotaPrefix
    self.showMetricLabels = showMetricLabels
    self.popoverSections = popoverSections
  }

  private enum CodingKeys: String, CodingKey {
    case items
    case selectedProviders
    case separator
    case showProviderName
    case showQuotaPrefix
    case showMetricLabels
    case popoverSections
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    if let rawItems = try c.decodeIfPresent([String].self, forKey: .items) {
      self.items = Self.deduplicated(rawItems.compactMap { MenuBarMetricItem(rawValue: $0) })
    } else {
      self.items = [.todayTokens, .todayCost]
    }
    let rawProviders = try c.decodeIfPresent([String].self, forKey: .selectedProviders) ?? []
    self.selectedProviders = Self.deduplicated(rawProviders.filter { !$0.isEmpty && $0 != "auto" })
    if let rawSep = try c.decodeIfPresent(String.self, forKey: .separator),
       let sep = MenuBarSeparatorStyle(rawValue: rawSep) {
      self.separator = sep
    } else {
      self.separator = .dot
    }
    self.showProviderName = try c.decodeIfPresent(Bool.self, forKey: .showProviderName) ?? true
    self.showQuotaPrefix = try c.decodeIfPresent(Bool.self, forKey: .showQuotaPrefix) ?? true
    self.showMetricLabels = try c.decodeIfPresent(Bool.self, forKey: .showMetricLabels) ?? false
    self.popoverSections = try c.decodeIfPresent(PopoverSectionsConfig.self, forKey: .popoverSections)
      ?? PopoverSectionsConfig()
  }

  private static func deduplicated<T: Hashable>(_ seq: [T]) -> [T] {
    var seen = Set<T>()
    var out: [T] = []
    for element in seq where seen.insert(element).inserted {
      out.append(element)
    }
    return out
  }

  public mutating func normalize() {
    items = Self.deduplicated(items)
    selectedProviders = Self.deduplicated(selectedProviders.filter { !$0.isEmpty && $0 != "auto" })
  }

  public static func migrated(
    displayMode: MenuBarDisplayMode,
    provider: String,
    showRecentWindows: Bool
  ) -> MenuBarCustomConfig {
    let items: [MenuBarMetricItem] = {
      switch displayMode {
      case .iconOnly: return []
      case .quotaRemaining: return [.quotaPct]
      case .remainingAmount: return [.billingAmount]
      case .quotaAndAmount: return [.quotaPct, .billingAmount]
      case .todayCost: return [.todayCost]
      case .todayTokensAndCost: return [.todayTokens, .todayCost]
      case .tps: return [.latestTps]
      case .latestInline: return [.latestTokens, .latestTps]
      }
    }()
    let providers = (!provider.isEmpty && provider != "auto") ? [provider] : []
    return MenuBarCustomConfig(
      items: items,
      selectedProviders: providers,
      popoverSections: PopoverSectionsConfig(showRecentWindows: showRecentWindows)
    )
  }

  public mutating func toggleItem(_ item: MenuBarMetricItem) {
    if let idx = items.firstIndex(of: item) {
      items.remove(at: idx)
    } else {
      items.append(item)
    }
  }

  public mutating func moveItem(_ item: MenuBarMetricItem, direction: Int) {
    guard let idx = items.firstIndex(of: item) else { return }
    let target = idx + direction
    guard target >= 0, target < items.count, target != idx else { return }
    items.swapAt(idx, target)
  }

  public mutating func moveItem(from sourceItem: MenuBarMetricItem, to targetItem: MenuBarMetricItem) {
    guard sourceItem != targetItem,
          let fromIdx = items.firstIndex(of: sourceItem),
          let toIdx = items.firstIndex(of: targetItem) else {
      return
    }
    let moved = items.remove(at: fromIdx)
    items.insert(moved, at: toIdx)
  }

  public mutating func toggleProvider(_ key: String) {
    guard !key.isEmpty, key != "auto" else { return }
    if let idx = selectedProviders.firstIndex(of: key) {
      selectedProviders.remove(at: idx)
    } else {
      selectedProviders.append(key)
    }
  }

  public var matchingPreset: MenuBarPreset? {
    MenuBarPreset.allCases.first { $0.items == items }
  }

  public var activeSummaryText: String {
    if items.isEmpty { return "仅图标" }
    return items.map(\.shortTitle).joined(separator: " · ")
  }
}

public struct MenuBarRenderSnapshot {
  public let isActiveOverall: Bool
  public let orderedProviderKeys: [String]
  public let providerLabels: [String: String]
  public let cards: [String: CodexBarCardSnapshot]
  public let todayFallback: UsageTotals?
  public let latestTurn: TurnSummary?
  public let useSampleFallback: Bool

  public init(
    isActiveOverall: Bool,
    orderedProviderKeys: [String],
    providerLabels: [String: String] = [:],
    cards: [String: CodexBarCardSnapshot] = [:],
    todayFallback: UsageTotals? = nil,
    latestTurn: TurnSummary? = nil,
    useSampleFallback: Bool = false
  ) {
    self.isActiveOverall = isActiveOverall
    self.orderedProviderKeys = orderedProviderKeys
    self.providerLabels = providerLabels
    self.cards = cards
    self.todayFallback = todayFallback
    self.latestTurn = latestTurn
    self.useSampleFallback = useSampleFallback
  }
}

public enum MenuBarFormatter {
  public static func format(
    config: MenuBarCustomConfig,
    usageScope: MenuBarUsageScope,
    quotaDisplayMode: QuotaDisplayMode,
    snapshot: MenuBarRenderSnapshot
  ) -> String {
    if !snapshot.isActiveOverall && !snapshot.useSampleFallback {
      return ""
    }
    if config.items.isEmpty {
      return ""
    }

    let ordered = snapshot.orderedProviderKeys
    let targetProviders: [String] = config.selectedProviders.isEmpty
      ? ordered
      : config.selectedProviders.filter { ordered.contains($0) }

    var segments: [String] = []
    var i = 0
    while i < config.items.count {
      let item = config.items[i]
      if i + 1 < config.items.count {
        let next = config.items[i + 1]
        if (item == .quotaPct && next == .billingAmount) ||
           (item == .billingAmount && next == .quotaPct) {
          let merged = formatMergedQuotaAndAmount(
            firstIsPct: item == .quotaPct,
            targetProviders: targetProviders,
            config: config,
            quotaDisplayMode: quotaDisplayMode,
            snapshot: snapshot
          )
          if !merged.isEmpty {
            segments.append(merged)
          }
          i += 2
          continue
        }
      }

      let part = formatSingleMetric(
        item,
        targetProviders: targetProviders,
        config: config,
        usageScope: usageScope,
        quotaDisplayMode: quotaDisplayMode,
        snapshot: snapshot
      )
      if !part.isEmpty {
        segments.append(part)
      }
      i += 1
    }

    if segments.isEmpty && !snapshot.useSampleFallback && config.items == [.quotaPct] {
      let fallbackCost = formatSingleMetric(
        .todayCost,
        targetProviders: targetProviders,
        config: config,
        usageScope: usageScope,
        quotaDisplayMode: quotaDisplayMode,
        snapshot: snapshot
      )
      if !fallbackCost.isEmpty {
        return fallbackCost
      }
    }

    return segments.joined(separator: config.separator.rawSeparator)
  }

  private static func label(for key: String, snapshot: MenuBarRenderSnapshot) -> String {
    if let custom = snapshot.providerLabels[key], !custom.isEmpty {
      return custom
    }
    if key == "antigravity" { return "AGY" }
    return key.hasPrefix("ext:") ? String(key.dropFirst(4)) : key
  }

  private static func resolvedBillingAmount(
    for card: CodexBarCardSnapshot,
    quotaMode: QuotaDisplayMode
  ) -> Double? {
    guard let b = card.billingSummary else { return nil }
    if quotaMode == .used {
      if let cost = b.periodCost { return cost }
      if let limit = b.periodLimit, let rem = b.periodRemaining {
        return max(0, limit - rem)
      }
      return nil
    }
    return b.periodRemaining
  }

  private static func formatPctText(
    remainingPct: Double,
    quotaMode: QuotaDisplayMode,
    showPrefix: Bool
  ) -> String {
    let pct = Int(quotaMode.displayPct(fromRemaining: remainingPct).rounded())
    return showPrefix ? "\(quotaMode.compactPrefix)\(pct)%" : "\(pct)%"
  }

  private static func formatMergedQuotaAndAmount(
    firstIsPct: Bool,
    targetProviders: [String],
    config: MenuBarCustomConfig,
    quotaDisplayMode: QuotaDisplayMode,
    snapshot: MenuBarRenderSnapshot
  ) -> String {
    var providerStrings: [String] = []
    let innerJoin = targetProviders.count > 1 ? " " : config.separator.rawSeparator

    for key in targetProviders {
      guard let card = snapshot.cards[key] else { continue }
      let pctText = card.quotaWindows?.first.map {
        formatPctText(
          remainingPct: $0.remainingPct,
          quotaMode: quotaDisplayMode,
          showPrefix: config.showQuotaPrefix
        )
      }
      let amtText = resolvedBillingAmount(for: card, quotaMode: quotaDisplayMode).map {
        MeterFormat.compactMoney($0, symbol: card.resolvedCurrencySymbol)
      }

      let pieces: [String] = firstIsPct
        ? [pctText, amtText].compactMap { $0 }
        : [amtText, pctText].compactMap { $0 }
      guard !pieces.isEmpty else { continue }

      let joinedPieces = pieces.joined(separator: innerJoin)
      if config.showProviderName {
        providerStrings.append("\(label(for: key, snapshot: snapshot)) \(joinedPieces)")
      } else {
        providerStrings.append(joinedPieces)
      }
    }

    if !providerStrings.isEmpty {
      return providerStrings.joined(separator: config.separator.rawSeparator)
    }
    if snapshot.useSampleFallback {
      let sPct = MenuBarMetricItem.quotaPct.sampleValue(
        quotaMode: quotaDisplayMode,
        showProviderName: false,
        showQuotaPrefix: config.showQuotaPrefix,
        showMetricLabels: config.showMetricLabels
      )
      let sAmt = MenuBarMetricItem.billingAmount.sampleValue(
        quotaMode: quotaDisplayMode,
        showProviderName: false,
        showQuotaPrefix: config.showQuotaPrefix,
        showMetricLabels: config.showMetricLabels
      )
      let core = firstIsPct ? "\(sPct)\(innerJoin)\(sAmt)" : "\(sAmt)\(innerJoin)\(sPct)"
      return config.showProviderName ? "司内 \(core)" : core
    }
    return ""
  }

  private static func formatSingleMetric(
    _ item: MenuBarMetricItem,
    targetProviders: [String],
    config: MenuBarCustomConfig,
    usageScope: MenuBarUsageScope,
    quotaDisplayMode: QuotaDisplayMode,
    snapshot: MenuBarRenderSnapshot
  ) -> String {
    switch item {
    case .quotaPct:
      var parts: [String] = []
      for key in targetProviders {
        guard let rem = snapshot.cards[key]?.quotaWindows?.first?.remainingPct else { continue }
        let pctStr = formatPctText(
          remainingPct: rem,
          quotaMode: quotaDisplayMode,
          showPrefix: config.showQuotaPrefix
        )
        parts.append(config.showProviderName ? "\(label(for: key, snapshot: snapshot)) \(pctStr)" : pctStr)
      }
      if !parts.isEmpty { return parts.joined(separator: config.separator.rawSeparator) }

    case .billingAmount:
      var parts: [String] = []
      for key in targetProviders {
        guard let card = snapshot.cards[key],
              let amt = resolvedBillingAmount(for: card, quotaMode: quotaDisplayMode) else { continue }
        let moneyStr = MeterFormat.compactMoney(amt, symbol: card.resolvedCurrencySymbol)
        parts.append(config.showProviderName ? "\(label(for: key, snapshot: snapshot)) \(moneyStr)" : moneyStr)
      }
      if !parts.isEmpty { return parts.joined(separator: config.separator.rawSeparator) }

    case .todayTokens:
      if let tok = scopedTodayTokens(targetProviders: targetProviders, config: config, usageScope: usageScope, snapshot: snapshot) {
        let base = MeterFormat.tokens(tok)
        return config.showMetricLabels ? "今 \(base)" : base
      }

    case .todayCost:
      if let costStr = scopedMoneyString(
        isDays30: false,
        targetProviders: targetProviders,
        config: config,
        usageScope: usageScope,
        snapshot: snapshot
      ) {
        return config.showMetricLabels ? "今 \(costStr)" : costStr
      }

    case .days30Cost:
      if let costStr = scopedMoneyString(
        isDays30: true,
        targetProviders: targetProviders,
        config: config,
        usageScope: usageScope,
        snapshot: snapshot
      ) {
        return "30d \(costStr)"
      }

    case .todayTurns:
      if let turns = scopedTodayTurns(targetProviders: targetProviders, config: config, usageScope: usageScope, snapshot: snapshot) {
        let base = "\(turns) 轮"
        return config.showMetricLabels ? "今 \(base)" : base
      }

    case .latestTps:
      if let tps = snapshot.latestTurn?.tps, tps.isFinite, tps > 0 {
        let base = MeterFormat.tps(tps)
        return config.showMetricLabels ? "末 \(base)" : base
      }

    case .latestTokens:
      if let inTok = snapshot.latestTurn?.totalInputTokens {
        let base = MeterFormat.tokens(inTok)
        return config.showMetricLabels ? "末 \(base)" : base
      }

    case .latestCacheRate:
      if let rate = snapshot.latestTurn?.cacheRatePct, rate.isFinite {
        return "缓 \(Int(rate.rounded()))%"
      }
    }

    if snapshot.useSampleFallback {
      return item.sampleValue(
        quotaMode: quotaDisplayMode,
        showProviderName: config.showProviderName,
        showQuotaPrefix: config.showQuotaPrefix,
        showMetricLabels: config.showMetricLabels
      )
    }
    return ""
  }

  private static func scopedTodayTokens(
    targetProviders: [String],
    config: MenuBarCustomConfig,
    usageScope: MenuBarUsageScope,
    snapshot: MenuBarRenderSnapshot
  ) -> Int? {
    if usageScope == .provider && !config.selectedProviders.isEmpty {
      var total = 0
      var hasNonBillingOnly = false
      for key in targetProviders {
        guard let card = snapshot.cards[key] else { continue }
        let isBillingOnly = (card.isExternal == true || key.hasPrefix("ext:")) &&
          card.billingSummary?.todayTokens == nil &&
          card.today.totalTokens == 0
        if isBillingOnly { continue }
        hasNonBillingOnly = true
        total += card.billingSummary?.todayTokens ?? card.today.totalTokens
      }
      return hasNonBillingOnly ? total : nil
    }
    if let allCard = snapshot.cards["all"],
       (allCard.today.totalTokens > 0 || (snapshot.todayFallback?.totalTokens ?? 0) == 0) {
      return allCard.today.totalTokens
    }
    return snapshot.todayFallback?.totalTokens
  }

  private static func scopedTodayTurns(
    targetProviders: [String],
    config: MenuBarCustomConfig,
    usageScope: MenuBarUsageScope,
    snapshot: MenuBarRenderSnapshot
  ) -> Int? {
    if usageScope == .provider && !config.selectedProviders.isEmpty {
      var total = 0
      var found = false
      for key in targetProviders {
        guard let card = snapshot.cards[key] else { continue }
        let isBillingOnly = (card.isExternal == true || key.hasPrefix("ext:")) && card.today.turnCount == 0
        if isBillingOnly { continue }
        found = true
        total += card.today.turnCount
      }
      return found ? total : nil
    }
    if let allCard = snapshot.cards["all"],
       (allCard.today.turnCount > 0 || (snapshot.todayFallback?.turnCount ?? 0) == 0) {
      return allCard.today.turnCount
    }
    return snapshot.todayFallback?.turnCount
  }

  private static func scopedMoneyString(
    isDays30: Bool,
    targetProviders: [String],
    config: MenuBarCustomConfig,
    usageScope: MenuBarUsageScope,
    snapshot: MenuBarRenderSnapshot
  ) -> String? {
    if usageScope == .provider && !config.selectedProviders.isEmpty {
      var buckets: [(symbol: String, total: Double)] = []
      for key in targetProviders {
        guard let card = snapshot.cards[key] else { continue }
        let rawVal: Double? = isDays30
          ? (card.days30.costUsd ?? card.billingSummary?.periodCost)
          : (card.billingSummary?.todayCost ?? card.today.costUsd)
        guard let val = rawVal, val.isFinite else { continue }
        let sym = card.resolvedCurrencySymbol
        if let idx = buckets.firstIndex(where: { $0.symbol == sym }) {
          buckets[idx].total += val
        } else {
          buckets.append((symbol: sym, total: val))
        }
      }
      guard !buckets.isEmpty else { return nil }
      return buckets.map { MeterFormat.money($0.total, symbol: $0.symbol) }.joined(separator: " + ")
    }

    if let allCard = snapshot.cards["all"] {
      let val = isDays30 ? allCard.days30.costUsd : allCard.today.costUsd
      if let v = val, v.isFinite {
        return MeterFormat.money(v, symbol: allCard.resolvedCurrencySymbol)
      }
    }
    if !isDays30, let v = snapshot.todayFallback?.estimatedCostUsd, v.isFinite {
      return MeterFormat.money(v, symbol: "$")
    }
    return nil
  }
}
