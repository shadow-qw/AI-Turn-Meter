import AITurnMeterCore
import AppKit
import SwiftUI

private struct ProviderSwitcherBar: View {
  @ObservedObject var vm: MeterViewModel
  let switcherKeys: [String]
  @Binding var selection: String
  @State private var hoveredKey: String? = nil

  private func isToolAvailable(_ key: String) -> Bool {
    if vm.isExternalProvider(key) {
      return vm.externalProviderMeta(for: key) != nil || vm.usageData?.cards?[key] != nil
    }
    if vm.apps[key]?.installed ?? false { return true }
    if vm.apps[key]?.latestTurn != nil { return true }
    let card = vm.usageData?.cards?[key]
    return !(card?.quotaWindows?.isEmpty ?? true)
      || (card?.accountEmail != nil)
      || ((card?.today.turnCount ?? 0) > 0)
      || ((card?.days30.turnCount ?? 0) > 0)
  }

  private func indicatorFraction(for key: String, installed: Bool, active: Bool) -> Double {
    guard key != "all", installed, active else { return 0 }
    if let rem = vm.usageData?.cards?[key]?.quotaWindows?.first?.remainingPct {
      let pct = vm.quotaDisplayMode.displayPct(fromRemaining: rem)
      return max(0.08, min(1.0, pct / 100.0))
    }
    return 1.0
  }

  private func indicatorHealthColor(for key: String, active: Bool) -> Color {
    guard active else { return Color.gray.opacity(0.45) }
    if let firstWin = vm.usageData?.cards?[key]?.quotaWindows?.first {
      switch firstWin.healthLevel {
      case .critical: return Color(red: 0.88, green: 0.24, blue: 0.24)
      case .warning: return Color(red: 0.94, green: 0.56, blue: 0.14)
      case .normal: break
      }
    }
    return vm.toolAccentColor(for: key)
  }

  @ViewBuilder
  private func tabButton(for key: String, index: Int, compactWidth: Bool) -> some View {
    let isSelected = selection == key
    let isHovered = hoveredKey == key
    let isAll = key == "all"
    let installed = isAll || isToolAvailable(key)
    let active = !isAll && installed && vm.isActiveOverall && vm.isToolEnabled(key)
    let frac = indicatorFraction(for: key, installed: installed, active: active)
    let fillColor: Color = isSelected ? .white : indicatorHealthColor(for: key, active: active)

    Button {
      selection = key
    } label: {
      VStack(spacing: 3) {
        ToolGlyph.iconView(for: key, sfSymbolOverride: vm.toolIconSymbol(for: key), size: 15)
          .frame(height: 16)
        Text(vm.toolShortTitle(for: key))
          .font(.system(size: 9.5, weight: isSelected ? .semibold : .medium))
          .lineLimit(1)
          .minimumScaleFactor(0.72)
          .frame(height: 13)
          .padding(.horizontal, 2)

        GeometryReader { geo in
          ZStack(alignment: .leading) {
            Capsule()
              .fill(isAll ? Color.clear : (isSelected ? Color.white.opacity(0.35) : Color.primary.opacity(0.12)))
            if !isAll && frac > 0 {
              Capsule()
                .fill(fillColor)
                .frame(width: max(4, geo.size.width * CGFloat(frac)))
            }
          }
        }
        .frame(height: 2)
        .padding(.horizontal, 6)
      }
      .foregroundColor(
        isSelected
          ? .white
          : (isHovered
              ? .primary
              : (installed ? .secondary : .secondary.opacity(0.55)))
      )
      .frame(minWidth: compactWidth ? 54 : nil, maxWidth: compactWidth ? nil : .infinity)
      .padding(.vertical, 5)
      .padding(.horizontal, compactWidth ? 4 : 2)
      .background(
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(isSelected ? CodexBarPalette.accentBlue : (isHovered ? Color.primary.opacity(0.06) : Color.clear))
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help(index < 9 ? "\(vm.toolShortTitle(for: key)) (⌘\(index + 1))" : vm.toolShortTitle(for: key))
    .onHover { inside in
      if inside { hoveredKey = key }
      else if hoveredKey == key { hoveredKey = nil }
    }
  }

  var body: some View {
    Group {
      if switcherKeys.count > 5 {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 4) {
            ForEach(Array(switcherKeys.enumerated()), id: \.element) { idx, key in
              tabButton(for: key, index: idx, compactWidth: true)
            }
          }
          .padding(.horizontal, 10)
        }
      } else {
        HStack(spacing: 4) {
          ForEach(Array(switcherKeys.enumerated()), id: \.element) { idx, key in
            tabButton(for: key, index: idx, compactWidth: false)
          }
        }
        .padding(.horizontal, 10)
      }
    }
    .padding(.top, 7)
    .padding(.bottom, 5)
    .onChange(of: switcherKeys) { keys in
      if !keys.contains(selection) {
        selection = "all"
      }
    }
  }
}

private struct MiniUsageBarsView: View {
  let points: [CardDailyPoint]
  let cardHovered: Bool
  var currencySymbol: String = "$"
  var billingOnly: Bool = false
  @State private var hovered: CardDailyPoint? = nil

  private var useCostScale: Bool {
    billingOnly || points.contains { ($0.costUsd ?? 0) > 0 }
  }

  private func metricValue(_ pt: CardDailyPoint) -> Double {
    if useCostScale { return max(0, pt.costUsd ?? 0) }
    return Double(max(0, pt.totalTokens))
  }

  private var peakLabel: String {
    if useCostScale {
      let peak = points.map { max(0, $0.costUsd ?? 0) }.max() ?? 0
      if peak > 0 { return MeterFormat.compactMoney(peak, symbol: currencySymbol) }
      return "\(currencySymbol)0"
    }
    let peakTok = points.map(\.totalTokens).max() ?? 0
    return peakTok > 0 ? MeterFormat.tokens(peakTok) : "0"
  }

  var body: some View {
    let maxVal = max(0.000001, points.map(metricValue).max() ?? 0)

    VStack(spacing: 3) {
      HStack {
        if let pt = hovered {
          let hoverText = (billingOnly && pt.totalTokens == 0)
            ? "\(pt.label) · \(MeterFormat.money(pt.costUsd, symbol: currencySymbol))"
            : "\(pt.label) · \(MeterFormat.money(pt.costUsd, symbol: currencySymbol)) · \(MeterFormat.tokens(pt.totalTokens))"
          Text(hoverText)
            .font(.system(size: 10, weight: .medium))
            .monospacedDigit()
            .foregroundColor(cardHovered ? .white : .primary)
            .lineLimit(1)
        }
        Spacer()
        Text(peakLabel)
          .font(.system(size: 10.5, weight: .medium))
          .monospacedDigit()
          .foregroundColor(cardHovered ? .white.opacity(0.88) : .secondary)
      }
      .frame(height: 13)

      VStack(spacing: 0) {
        HStack(alignment: .bottom, spacing: 0) {
          ForEach(points) { pt in
            let val = metricValue(pt)
            let ratio = val > 0 ? CGFloat(val / maxVal) : 0
            let isHovered = hovered?.id == pt.id

            RoundedRectangle(cornerRadius: 1.5, style: .continuous)
              .fill(
                val > 0
                  ? (cardHovered
                      ? Color.white.opacity(isHovered ? 1.0 : 0.88)
                      : CodexBarPalette.tealBar.opacity(isHovered ? 1.0 : 0.88))
                  : (cardHovered
                      ? Color.white.opacity(isHovered ? 0.45 : 0.20)
                      : Color.primary.opacity(isHovered ? 0.30 : 0.12))
              )
              .frame(maxWidth: .infinity)
              .frame(height: val > 0 ? max(4, ratio * 24) : 2.0)
              .padding(.horizontal, 1.0)
              .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
          }
        }
        .frame(height: 26, alignment: .bottom)
        .overlay {
          GeometryReader { geo in
            Color.clear
              .contentShape(Rectangle())
              .onContinuousHover { phase in
                switch phase {
                case .active(let loc):
                  guard !points.isEmpty else { return }
                  let w = max(1, geo.size.width)
                  let idx = min(points.count - 1, max(0, Int((loc.x / w) * CGFloat(points.count))))
                  let target = points[idx]
                  if hovered?.id != target.id { hovered = target }
                case .ended:
                  hovered = nil
                }
              }
          }
        }

        Rectangle()
          .fill(cardHovered ? Color.white.opacity(0.28) : Color.primary.opacity(0.12))
          .frame(height: 1)
      }
    }
  }
}

private struct CodexBarStyleCardView: View {
  @ObservedObject var vm: MeterViewModel
  let selection: String
  let card: CodexBarCardSnapshot
  var onLoginRequested: (String) -> Void = { _ in }
  @State private var isCardHovered: Bool = false

  private var isAll: Bool { selection == "all" }

  private var isExternal: Bool {
    (card.isExternal == true) || vm.isExternalProvider(selection)
  }

  private var curSym: String {
    card.resolvedCurrencySymbol
  }

  private var isBillingOnlyExternal: Bool {
    guard isExternal else { return false }
    let b = card.billingSummary
    return b?.todayTokens == nil && b?.periodTokens == nil && card.today.totalTokens == 0 && card.days30.totalTokens == 0
  }

  private var headerTitle: String {
    isAll ? "全部客户端" : vm.toolShortTitle(for: selection)
  }

  private var primaryText: Color {
    isCardHovered ? .white : .primary
  }

  private var secondaryText: Color {
    isCardHovered ? .white.opacity(0.78) : .secondary
  }

  private var hasCliActivity: Bool {
    guard !isAll && !isExternal else { return false }
    return !(card.quotaWindows?.isEmpty ?? true)
      || card.accountEmail != nil
      || card.today.turnCount > 0
      || card.days30.turnCount > 0
      || vm.apps[selection]?.latestTurn != nil
  }

  private func isBuiltInAvailable(_ key: String) -> Bool {
    if vm.apps[key]?.installed ?? false { return true }
    if vm.apps[key]?.latestTurn != nil { return true }
    let c = vm.usageData?.cards?[key]
    return !(c?.quotaWindows?.isEmpty ?? true)
      || c?.accountEmail != nil
      || ((c?.today.turnCount ?? 0) > 0)
      || ((c?.days30.turnCount ?? 0) > 0)
  }

  private var statusLabel: String {
    if isAll {
      let availableKeys = vm.orderedKeys.filter { isBuiltInAvailable($0) }
      let active = availableKeys.filter { vm.isActiveOverall && vm.isToolEnabled($0) }.count
      if !vm.daemonOnline { return "后台未启动" }
      if !vm.masterEnabled { return "已暂停" }
      return "\(active)/\(availableKeys.count) 监控中"
    }
    if isExternal {
      if !vm.daemonOnline { return "后台未启动" }
      if !vm.masterEnabled || !vm.isToolEnabled(selection) { return "已暂停" }
      return card.statusText ?? "外部插件"
    }
    let entry = vm.apps[selection]
    let appInstalled = entry?.installed ?? false
    guard appInstalled || hasCliActivity else { return "未安装" }
    if !vm.daemonOnline { return "后台未启动" }
    if !vm.masterEnabled || !vm.isToolEnabled(selection) { return "已暂停" }
    if let port = entry?.cdpPort { return "CDP:\(port)" }
    if !appInstalled { return "CLI 监控中" }
    return "监控中"
  }

  private var latestTurn: TurnSummary? {
    if !isAll { return vm.apps[selection]?.latestTurn }
    var best: TurnSummary? = nil
    for key in vm.orderedKeys {
      guard vm.isToolEnabled(key),
            let turn = vm.apps[key]?.latestTurn else { continue }
      if best == nil || (turn.completedAtMs ?? 0) > (best?.completedAtMs ?? 0) {
        best = turn
      }
    }
    return best
  }

  private var resolvedTpsBadge: String? {
    if let tps = card.latestTpsText, !tps.isEmpty {
      return tps
    }
    if let raw = latestTurn?.tps, raw > 0 {
      return MeterFormat.tps(raw)
    }
    return nil
  }

  private var visibleWindows: [CardRecentWindow] {
    guard vm.menuBarConfig.popoverSections.showRecentWindows else { return [] }
    return card.recentWindows.filter { $0.index == 0 || $0.turnCount > 0 }
  }

  private var visibleSessions: [CardSessionSummary] {
    guard vm.menuBarConfig.popoverSections.showRecentSessions,
          !isBillingOnlyExternal,
          let sessions = card.recentSessions,
          !sessions.isEmpty else {
      return []
    }
    return Array(sessions.prefix(3))
  }

  private var activeSessionCount: Int {
    guard !isBillingOnlyExternal, let sessions = card.recentSessions else { return 0 }
    return sessions.filter { $0.isActive == true }.count
  }

  private func toggleQuotaDisplayMode() {
    vm.setQuotaDisplayMode(vm.quotaDisplayMode == .remaining ? .used : .remaining)
  }

  private func quotaFillColor(for level: QuotaHealthLevel) -> Color {
    switch level {
    case .normal:
      return isCardHovered ? Color.white.opacity(0.95) : CodexBarPalette.tealBar
    case .warning:
      return isCardHovered
        ? Color(red: 1.0, green: 0.86, blue: 0.32)
        : Color(red: 0.94, green: 0.56, blue: 0.14)
    case .critical:
      return isCardHovered
        ? Color(red: 1.0, green: 0.50, blue: 0.48)
        : Color(red: 0.88, green: 0.24, blue: 0.24)
    }
  }

  private func quotaPctLabelColor(for level: QuotaHealthLevel) -> Color {
    if isCardHovered { return .white }
    switch level {
    case .critical: return Color(red: 0.85, green: 0.20, blue: 0.20)
    case .warning: return Color(red: 0.84, green: 0.46, blue: 0.08)
    case .normal: return .primary
    }
  }

  private enum QuotaDisplayItem: Identifiable {
    case paired(group: String, primary: CardQuotaWindow, secondary: CardQuotaWindow)
    case single(CardQuotaWindow)

    var id: String {
      switch self {
      case .paired(let group, let p, let s): return "pair:\(group):\(p.id):\(s.id)"
      case .single(let w): return w.id
      }
    }
  }

  private func groupedQuotaItems(from windows: [CardQuotaWindow]) -> [QuotaDisplayItem] {
    guard !isAll else { return windows.map { .single($0) } }
    var consumed = Set<Int>()
    var items: [QuotaDisplayItem] = []

    for i in windows.indices {
      if consumed.contains(i) { continue }
      let w = windows[i]
      if let grp = w.group?.trimmingCharacters(in: .whitespacesAndNewlines), !grp.isEmpty,
         let kind = w.windowKind?.lowercased(), (kind == "5h" || kind == "weekly") {
        let partnerKind = (kind == "5h") ? "weekly" : "5h"
        if let j = windows.indices.first(where: { idx in
          idx > i && !consumed.contains(idx) &&
          windows[idx].group?.trimmingCharacters(in: .whitespacesAndNewlines) == grp &&
          windows[idx].windowKind?.lowercased() == partnerKind
        }) {
          consumed.insert(i)
          consumed.insert(j)
          let fiveH = (kind == "5h") ? w : windows[j]
          let weekly = (kind == "weekly") ? w : windows[j]
          items.append(.paired(group: grp, primary: fiveH, secondary: weekly))
          continue
        }
      }
      consumed.insert(i)
      items.append(.single(w))
    }
    return items
  }

  private var dividerLine: some View {
    Rectangle()
      .fill(isCardHovered ? Color.white.opacity(0.22) : Color.primary.opacity(0.08))
      .frame(height: 0.5)
  }

  var body: some View {
    let rawWindows = card.quotaWindows ?? []
    let windows = isAll
      ? ProviderOrder.sortOverviewWindows(rawWindows, by: vm.orderedAllProviderKeys)
      : rawWindows
    let showModeToggle = !windows.isEmpty || isBillingOnlyExternal

    VStack(alignment: .leading, spacing: 8) {
      // Card Header (CodexBar compact density: concise title + Email / Plan)
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 1.5) {
          Text(headerTitle)
            .font(.system(size: 13.5, weight: .bold))
            .foregroundColor(primaryText)
          HStack(spacing: 5) {
            Text(vm.relativeUpdateLabel())
              .font(.system(size: 10))
              .foregroundColor(secondaryText)
            if showModeToggle {
              Button(action: toggleQuotaDisplayMode) {
                HStack(spacing: 2) {
                  Text(vm.quotaDisplayMode.verbLabel)
                  Image(systemName: "arrow.left.arrow.right")
                    .font(.system(size: 7.5, weight: .semibold))
                }
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(isCardHovered ? .white.opacity(0.92) : .secondary)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(
                  Capsule()
                    .fill(isCardHovered ? Color.white.opacity(0.18) : Color.primary.opacity(0.07))
                )
              }
              .buttonStyle(.plain)
              .help("点击切换显示剩余 / 已用比例")
            }
          }
        }

        Spacer(minLength: 6)

        VStack(alignment: .trailing, spacing: 1.5) {
          Text(card.accountEmail ?? statusLabel)
            .font(.system(size: 11.5, weight: .semibold))
            .foregroundColor(primaryText)
            .lineLimit(1)
          Text(card.planTitle ?? (isExternal ? "外部插件" : "本地监控"))
            .font(.system(size: 10))
            .foregroundColor(secondaryText)
            .lineLimit(1)
        }
      }

      dividerLine

      // Primary Quota Windows (Remaining % + Reset countdown + Pace marker)
      if !windows.isEmpty {
        let items = groupedQuotaItems(from: windows)
        VStack(alignment: .leading, spacing: 7.5) {
          ForEach(items) { item in
            switch item {
            case .paired(let group, let primary, let secondary):
              pairedQuotaBlock(group: group, primary: primary, secondary: secondary)
            case .single(let win):
              quotaBlock(
                win: win,
                isPrimaryBillingWindow: windows.count == 1 || win.id == windows.first?.id
              )
            }
          }
        }
      } else {
        HStack(spacing: 6) {
          Text(
            isAll
              ? "正在同步客户端登录与额度信息…"
              : (isExternal
                  ? (card.quotaHint ?? "等待外部插件返回配额数据")
                  : (((vm.apps[selection]?.installed ?? false) || hasCliActivity)
                      ? (card.quotaHint ?? (
                          selection == "cursor"
                            ? (vm.hasCursorCookie
                                ? "未读取到套餐限额 · 请重新登录"
                                : "需在「设置 → Cursor」授权读取或网页登录")
                            : (selection == "codex"
                                ? (card.accountEmail != nil
                                    ? "正在同步配额 · 请点击刷新或运行 Codex 后自动获取"
                                    : "当前为 API Key / 企业按量模式，或尚未登录 ChatGPT 账号")
                                : (selection == "antigravity"
                                    ? "暂无法读取本地配额 · 请在 Antigravity 内查看剩余额度"
                                    : "企业/团队按量模式 · 无固定个人会话限额"))))
                      : "未检测到该客户端安装"))
          )
          .font(.system(size: 10.5))
          .foregroundColor(secondaryText)
          .lineLimit(2)
          Spacer(minLength: 4)
          if isExternal, card.needsAuth == true,
             let auth = vm.externalProviderMeta(for: selection)?.auth, auth.isWebCookie {
            if isCardHovered {
              Button {
                onLoginRequested(selection)
              } label: {
                Text(auth.displayLabel)
                  .font(.system(size: 10, weight: .semibold))
                  .foregroundColor(CodexBarPalette.cardBottom)
                  .padding(.horizontal, 8)
                  .padding(.vertical, 3)
                  .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                      .fill(Color.white.opacity(0.95))
                  )
              }
              .buttonStyle(.plain)
            } else {
              Button(auth.displayLabel) {
                onLoginRequested(selection)
              }
              .buttonStyle(.borderedProminent)
              .controlSize(.mini)
              .tint(CodexBarPalette.accentBlue)
            }
          } else if selection == "cursor", !vm.hasCursorCookie, windows.isEmpty {
            if isCardHovered {
              Button {
                onLoginRequested("cursor")
              } label: {
                Text("网页登录…")
                  .font(.system(size: 10, weight: .semibold))
                  .foregroundColor(CodexBarPalette.cardBottom)
                  .padding(.horizontal, 8)
                  .padding(.vertical, 3)
                  .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                      .fill(Color.white.opacity(0.95))
                  )
              }
              .buttonStyle(.plain)
            } else {
              Button("网页登录…") {
                onLoginRequested("cursor")
              }
              .buttonStyle(.borderedProminent)
              .controlSize(.mini)
              .tint(CodexBarPalette.accentBlue)
            }
          } else {
            Text(statusLabel)
              .font(.system(size: 10, weight: .medium))
              .foregroundColor(isCardHovered ? .white.opacity(0.88) : .secondary)
          }
        }
      }

      if let resetCredits = card.resetCreditsText, !resetCredits.isEmpty {
        if selection == "cursor" {
          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
              Text("按需超额用量")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(primaryText)
              Spacer(minLength: 4)
              Text(resetCredits)
                .font(.system(size: 11.5, weight: .medium))
                .monospacedDigit()
                .foregroundColor(primaryText)
                .lineLimit(1)
            }
            if let cycleReset = card.quotaWindows?.first?.resetText, !cycleReset.isEmpty {
              Text(cycleReset)
                .font(.system(size: 10))
                .monospacedDigit()
                .foregroundColor(secondaryText)
                .lineLimit(1)
            }
          }
        } else {
          VStack(alignment: .leading, spacing: 2) {
            Text("限额重置额度")
              .font(.system(size: 11, weight: .semibold))
              .foregroundColor(primaryText)
            Text(resetCredits)
              .font(.system(size: 10.5))
              .foregroundColor(secondaryText)
              .lineLimit(1)
          }
        }
      }

      dividerLine

      // Cost & Usage Grid
      if isBillingOnlyExternal {
        let b = card.billingSummary
        let periodLabel = b?.periodLabel ?? "本月"
        let periodUsed: Double? = b?.periodCost ?? {
          if let limit = b?.periodLimit, let rem = b?.periodRemaining {
            return max(0, limit - rem)
          }
          return nil
        }()
        if vm.quotaDisplayMode == .used, let used = periodUsed {
          VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
              Text("\(periodLabel)已消耗")
                .font(.system(size: 10.5))
                .foregroundColor(secondaryText)
              Text(MeterFormat.money(used, symbol: curSym))
                .font(.system(size: 26, weight: .bold))
                .monospacedDigit()
                .foregroundColor(primaryText)
            }
            if let rem = b?.periodRemaining {
              metricGridRow(
                leftLabel: "\(periodLabel)剩余",
                leftVal: MeterFormat.money(rem, symbol: curSym),
                rightLabel: "今日消耗",
                rightVal: MeterFormat.money(b?.todayCost ?? card.today.costUsd, symbol: curSym)
              )
            } else {
              metricGridRow(
                leftLabel: "\(periodLabel)限额",
                leftVal: MeterFormat.money(b?.periodLimit, symbol: curSym),
                rightLabel: "今日消耗",
                rightVal: MeterFormat.money(b?.todayCost ?? card.today.costUsd, symbol: curSym)
              )
            }
          }
        } else if let rem = b?.periodRemaining {
          VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
              Text("\(periodLabel)剩余余额")
                .font(.system(size: 10.5))
                .foregroundColor(secondaryText)
              Text(MeterFormat.money(rem, symbol: curSym))
                .font(.system(size: 26, weight: .bold))
                .monospacedDigit()
                .foregroundColor(primaryText)
            }
            if let used = periodUsed {
              metricGridRow(
                leftLabel: "\(periodLabel)已消耗",
                leftVal: MeterFormat.money(used, symbol: curSym),
                rightLabel: "今日消耗",
                rightVal: MeterFormat.money(b?.todayCost ?? card.today.costUsd, symbol: curSym)
              )
            } else {
              metricGridRow(
                leftLabel: "\(periodLabel)限额",
                leftVal: MeterFormat.money(b?.periodLimit, symbol: curSym),
                rightLabel: "今日消耗",
                rightVal: MeterFormat.money(b?.todayCost ?? card.today.costUsd, symbol: curSym)
              )
            }
          }
        } else {
          VStack(alignment: .leading, spacing: 6) {
            metricGridRow(
              leftLabel: "今日消耗",
              leftVal: MeterFormat.money(b?.todayCost ?? card.today.costUsd, symbol: curSym),
              rightLabel: "\(periodLabel)已消耗",
              rightVal: MeterFormat.money(periodUsed ?? card.days30.costUsd, symbol: curSym)
            )
          }
        }
      } else {
        VStack(alignment: .leading, spacing: 6) {
          metricGridRow(
            leftLabel: "今日",
            leftVal: MeterFormat.money(card.today.costUsd, symbol: curSym),
            rightLabel: "估算：当前窗口",
            rightVal: MeterFormat.money(card.currentWindow.costUsd, symbol: curSym)
          )
          metricGridRow(
            leftLabel: "今日 token 用量",
            leftVal: MeterFormat.tokens(card.today.totalTokens),
            rightLabel: "估算：当前窗口 token 用量",
            rightVal: MeterFormat.tokens(card.currentWindow.totalTokens)
          )
          metricGridRow(
            leftLabel: "近 30 天",
            leftVal: MeterFormat.money(card.days30.costUsd, symbol: curSym),
            rightLabel: "近 30 天 token 用量",
            rightVal: MeterFormat.tokens(card.days30.totalTokens)
          )
        }
      }

      // 30-day Mini Usage Chart
      if vm.menuBarConfig.popoverSections.showMiniChart && !card.daily30.isEmpty {
        MiniUsageBarsView(
          points: card.daily30,
          cardHovered: isCardHovered,
          currencySymbol: curSym,
          billingOnly: isBillingOnlyExternal
        )
      }

      // Recent Rolling 7-day Windows
      if !visibleWindows.isEmpty {
        VStack(alignment: .leading, spacing: 5) {
          Text("最近窗口")
            .font(.system(size: 10.5, weight: .medium))
            .foregroundColor(secondaryText)

          ForEach(visibleWindows) { win in
            VStack(alignment: .leading, spacing: 1) {
              HStack(spacing: 6) {
                Text(win.title)
                  .font(.system(size: 11, weight: .semibold))
                  .foregroundColor(primaryText)
                  .lineLimit(1)
                Spacer()
                Text("\(MeterFormat.money(win.costUsd, symbol: curSym)) · \(MeterFormat.tokens(win.totalTokens))")
                  .font(.system(size: 11, weight: .semibold))
                  .monospacedDigit()
                  .foregroundColor(primaryText)
              }
              Text("估算：\(win.rangeText)")
                .font(.system(size: 10))
                .foregroundColor(secondaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.9)
            }
          }
        }
      }

      // Recent Sessions (compact, up to 3)
      if !visibleSessions.isEmpty {
        dividerLine
        recentSessionsSection(sessions: visibleSessions, activeCount: activeSessionCount)
      }

      // Quiet Unboxed Footer Lines
      VStack(alignment: .leading, spacing: 2) {
        if vm.menuBarConfig.popoverSections.showFooterModelInfo {
          if let topModel = card.topModel {
            let tpsSuffix: String = resolvedTpsBadge.map {
              let clean = $0.hasPrefix("均 ") ? String($0.dropFirst(2)) : $0
              return " · \(clean)"
            } ?? ""
            Text("最常用模型: \(topModel)\(tpsSuffix)")
              .font(.system(size: 10.5))
              .monospacedDigit()
              .foregroundColor(secondaryText)
              .lineLimit(1)
              .truncationMode(.middle)
          } else if let tps = resolvedTpsBadge {
            Text("最近速率: \(tps)")
              .font(.system(size: 10.5))
              .monospacedDigit()
              .foregroundColor(secondaryText)
              .lineLimit(1)
          }
        }
        Text(card.footnote ?? "根据 Token 用量估算 · 不是订阅账单")
          .font(.system(size: 10))
          .foregroundColor(secondaryText)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(
      Group {
        if isCardHovered {
          LinearGradient(
            colors: [CodexBarPalette.cardTop, CodexBarPalette.cardBottom],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        } else {
          Color.clear
        }
      }
    )
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    .contentShape(Rectangle())
    .onHover { inside in
      isCardHovered = inside
      CostHistoryFlyoutController.shared.setCardHovered(inside, vm: vm, card: card, selection: selection)
    }
    .padding(.horizontal, 6)
  }

  private func pairedQuotaBlock(
    group: String,
    primary: CardQuotaWindow,
    secondary: CardQuotaWindow
  ) -> some View {
    VStack(alignment: .leading, spacing: 3.5) {
      Text(group)
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundColor(primaryText)
        .lineLimit(1)

      HStack(alignment: .top, spacing: 8) {
        miniQuotaColumn(win: primary, kindLabel: "5h")
        miniQuotaColumn(win: secondary, kindLabel: "每周")
      }
    }
  }

  private func miniQuotaColumn(win: CardQuotaWindow, kindLabel: String) -> some View {
    let pct = vm.quotaDisplayMode.displayPct(fromRemaining: win.remainingPct)
    let clamped = min(1.0, max(0.0, pct / 100.0))
    let pctRounded = Int(pct.rounded())
    let health = win.healthLevel
    let trackColor = isCardHovered ? Color.white.opacity(0.24) : Color.primary.opacity(0.10)
    let fillColor = quotaFillColor(for: health)
    let tickColor = isCardHovered ? Color.white.opacity(0.26) : Color.primary.opacity(0.14)

    return VStack(alignment: .leading, spacing: 2.5) {
      Button(action: toggleQuotaDisplayMode) {
        HStack(spacing: 3) {
          Text(kindLabel)
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(secondaryText)
            .lineLimit(1)
          Spacer(minLength: 2)
          Text("\(vm.quotaDisplayMode.verbLabel) \(pctRounded)%")
            .font(.system(size: 10.5, weight: .semibold))
            .monospacedDigit()
            .foregroundColor(quotaPctLabelColor(for: health))
            .lineLimit(1)
            .minimumScaleFactor(0.85)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help("点击切换显示剩余 / 已用比例")

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule()
            .fill(trackColor)
          if clamped > 0 {
            Capsule()
              .fill(fillColor)
              .frame(width: max(4, geo.size.width * CGFloat(clamped)))
          }
          HStack {
            Spacer()
            Rectangle().fill(tickColor).frame(width: 1, height: 5.5)
            Spacer()
            Rectangle().fill(tickColor).frame(width: 1, height: 5.5)
            Spacer()
            Rectangle().fill(tickColor).frame(width: 1, height: 5.5)
            Spacer()
          }
          if let pacePct = vm.quotaDisplayMode.displayPacePct(fromRemainingPace: win.pacePct) {
            let paceFrac = min(1.0, max(0.0, pacePct / 100.0))
            let paceX = min(max(0, geo.size.width - 4.0), max(0, geo.size.width * CGFloat(paceFrac) - 2.0))
            ZStack {
              RoundedRectangle(cornerRadius: 1)
                .fill(isCardHovered ? CodexBarPalette.cardTop : Color(nsColor: .windowBackgroundColor).opacity(0.92))
                .frame(width: 4.5, height: 7.0)
              RoundedRectangle(cornerRadius: 0.75)
                .fill(isCardHovered ? Color.white : CodexBarPalette.paceGreen)
                .frame(width: 2.0, height: 7.0)
            }
            .offset(x: paceX)
          }
        }
      }
      .frame(height: 5.5)
      .help((win.subtitle?.isEmpty == false ? win.subtitle : win.resetText) ?? "")

      let cleanReset = win.resetText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let cleanSub = win.subtitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let captionText = !cleanReset.isEmpty ? cleanReset : cleanSub
      if !captionText.isEmpty {
        Text(captionText)
          .font(.system(size: 9.5))
          .monospacedDigit()
          .foregroundColor(isCardHovered ? .white.opacity(0.82) : .secondary)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
          .help(!cleanSub.isEmpty ? cleanSub : captionText)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func quotaBlock(win: CardQuotaWindow, isPrimaryBillingWindow: Bool) -> some View {
    let pct = vm.quotaDisplayMode.displayPct(fromRemaining: win.remainingPct)
    let clamped = min(1.0, max(0.0, pct / 100.0))
    let pctRounded = Int(pct.rounded())
    let health = win.healthLevel
    let trackColor = isCardHovered ? Color.white.opacity(0.24) : Color.primary.opacity(0.10)
    let fillColor = quotaFillColor(for: health)
    let tickColor = isCardHovered ? Color.white.opacity(0.26) : Color.primary.opacity(0.14)

    return VStack(alignment: .leading, spacing: 3.5) {
      HStack(spacing: 6) {
        Button(action: toggleQuotaDisplayMode) {
          Text("\(win.title) \(vm.quotaDisplayMode.verbLabel) \(pctRounded)%")
            .font(.system(size: 12, weight: .semibold))
            .monospacedDigit()
            .foregroundColor(quotaPctLabelColor(for: health))
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("点击切换显示剩余 / 已用比例")
        Spacer(minLength: 4)
        if let resetText = win.resetText, !resetText.isEmpty {
          Text(resetText)
            .font(.system(size: 10))
            .monospacedDigit()
            .foregroundColor(isCardHovered ? .white.opacity(0.88) : .secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
        }
      }

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule()
            .fill(trackColor)
          if clamped > 0 {
            Capsule()
              .fill(fillColor)
              .frame(width: max(4, geo.size.width * CGFloat(clamped)))
          }
          // Subtle 25/50/75 tick marks
          HStack {
            Spacer()
            Rectangle().fill(tickColor).frame(width: 1, height: 6)
            Spacer()
            Rectangle().fill(tickColor).frame(width: 1, height: 6)
            Spacer()
            Rectangle().fill(tickColor).frame(width: 1, height: 6)
            Spacer()
          }
          // Linear pace marker with crisp background punch-out border
          if let pacePct = vm.quotaDisplayMode.displayPacePct(fromRemainingPace: win.pacePct) {
            let paceFrac = min(1.0, max(0.0, pacePct / 100.0))
            let paceX = min(max(0, geo.size.width - 5.0), max(0, geo.size.width * CGFloat(paceFrac) - 2.5))
            ZStack {
              RoundedRectangle(cornerRadius: 1)
                .fill(isCardHovered ? CodexBarPalette.cardTop : Color(nsColor: .windowBackgroundColor).opacity(0.92))
                .frame(width: 5.0, height: 7.5)
              RoundedRectangle(cornerRadius: 0.75)
                .fill(isCardHovered ? Color.white : CodexBarPalette.paceGreen)
                .frame(width: 2.0, height: 7.5)
            }
            .offset(x: paceX)
          }
        }
      }
      .frame(height: 6)

      let resolvedSub: String? = {
        if isBillingOnlyExternal,
           isPrimaryBillingWindow,
           vm.quotaDisplayMode == .used,
           let b = card.billingSummary,
           let limit = b.periodLimit, limit > 0,
           let used = b.periodCost ?? b.periodRemaining.map({ max(0, limit - $0) }) {
          return "已用 \(MeterFormat.money(used, symbol: curSym)) / 限额 \(MeterFormat.money(limit, symbol: curSym))"
        }
        return win.subtitle
      }()
      if let sub = resolvedSub, !sub.isEmpty {
        Text(sub)
          .font(.system(size: 10))
          .monospacedDigit()
          .foregroundColor(secondaryText)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
      }
    }
  }

  private func recentSessionsSection(sessions: [CardSessionSummary], activeCount: Int) -> some View {
    let activeDotColor = isCardHovered ? Color(red: 0.45, green: 0.98, blue: 0.65) : CodexBarPalette.paceGreen

    return VStack(alignment: .leading, spacing: 4.5) {
      HStack(spacing: 6) {
        Text("会话")
          .font(.system(size: 10.5, weight: .semibold))
          .foregroundColor(secondaryText)
        Spacer(minLength: 4)
        if activeCount > 0 {
          HStack(spacing: 4) {
            ZStack {
              Circle()
                .fill(activeDotColor.opacity(0.28))
                .frame(width: 9, height: 9)
              Circle()
                .fill(activeDotColor)
                .frame(width: 5, height: 5)
            }
            Text("\(activeCount) 个运行中")
              .font(.system(size: 9.5, weight: .semibold))
              .monospacedDigit()
              .foregroundColor(isCardHovered ? .white : CodexBarPalette.paceGreen)
          }
          .padding(.horizontal, 5.5)
          .padding(.vertical, 1.5)
          .background(
            Capsule()
              .fill(isCardHovered ? Color.white.opacity(0.18) : CodexBarPalette.paceGreen.opacity(0.13))
          )
        }
      }

      ForEach(sessions) { session in
        let isActive = session.isActive == true
        let metaText = sessionMetaLine(session)

        HStack(alignment: .center, spacing: 6) {
          if isActive {
            ZStack {
              Circle()
                .fill(activeDotColor.opacity(0.28))
                .frame(width: 8, height: 8)
              Circle()
                .fill(activeDotColor)
                .frame(width: 4.5, height: 4.5)
            }
          } else {
            Circle()
              .fill(isCardHovered ? Color.white.opacity(0.30) : Color.secondary.opacity(0.32))
              .frame(width: 4.5, height: 4.5)
              .padding(.horizontal, 1.75)
          }

          VStack(alignment: .leading, spacing: 1) {
            Text(session.title)
              .font(.system(size: 11, weight: .medium))
              .foregroundColor(primaryText)
              .lineLimit(1)
              .truncationMode(.tail)
            if !metaText.isEmpty {
              Text(metaText)
                .font(.system(size: 9.5))
                .monospacedDigit()
                .foregroundColor(secondaryText)
                .lineLimit(1)
                .truncationMode(.middle)
            }
          }

          Spacer(minLength: 4)

          Text(MeterFormat.tokens(session.totalTokens))
            .font(.system(size: 10.5, weight: .semibold))
            .monospacedDigit()
            .foregroundColor(primaryText)
            .lineLimit(1)
        }
      }
    }
  }

  private func sessionMetaLine(_ session: CardSessionSummary) -> String {
    var parts: [String] = []
    if let count = session.modelCount, count > 1 {
      parts.append("\(count) models")
    } else if let model = session.model, !model.isEmpty, model.lowercased() != "unknown" {
      parts.append(model)
    }
    if let subCount = session.subagentCount, subCount > 0 {
      parts.append("\(subCount) 个子代理")
    }
    if let rel = relativeSessionTime(ms: session.lastActiveAtMs, isActive: session.isActive == true) {
      parts.append(rel)
    }
    return parts.joined(separator: " · ")
  }

  private func relativeSessionTime(ms: Double?, isActive: Bool) -> String? {
    guard let ms = ms, ms > 0 else {
      return isActive ? "刚刚" : nil
    }
    let delta = max(0, Int(Date().timeIntervalSince1970 - (ms / 1000.0)))
    if delta < 60 { return "刚刚" }
    if delta < 3600 { return "\(delta / 60) 分钟前" }
    if delta < 86400 { return "\(delta / 3600) 小时前" }
    return "\(delta / 86400) 天前"
  }

  private func metricColumn(label: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 1.5) {
      Text(label)
        .font(.system(size: 10))
        .foregroundColor(secondaryText)
        .lineLimit(1)
        .minimumScaleFactor(0.85)
      Text(value)
        .font(.system(size: 13.5, weight: .bold))
        .monospacedDigit()
        .foregroundColor(primaryText)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func metricGridRow(
    leftLabel: String,
    leftVal: String,
    rightLabel: String,
    rightVal: String
  ) -> some View {
    HStack(alignment: .top, spacing: 8) {
      metricColumn(label: leftLabel, value: leftVal)
      metricColumn(label: rightLabel, value: rightVal)
    }
  }
}

private struct PopoverActionRow: View {
  let title: String
  var shortcut: String? = nil
  var trailingSymbol: String? = nil
  var badgeText: String? = nil
  var isLoading: Bool = false
  var action: () -> Void

  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Text(title)
          .font(.system(size: 12))
          .foregroundColor(hovering ? .white : .primary)
        if isLoading {
          ProgressView().controlSize(.mini)
        }
        Spacer()
        if let badge = badgeText, !badge.isEmpty {
          Text(badge)
            .font(.system(size: 10))
            .foregroundColor(hovering ? .white.opacity(0.9) : .secondary)
        }
        if let trailing = trailingSymbol {
          Image(systemName: trailing)
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(hovering ? .white : .secondary)
        }
        if let shortcut = shortcut {
          Text(shortcut)
            .font(.system(size: 10.5))
            .foregroundColor(hovering ? .white.opacity(0.9) : .secondary)
        }
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(hovering ? CodexBarPalette.accentBlue : Color.clear)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

private struct PopoverSectionHeights: Equatable {
  var header: CGFloat = 0
  var card: CGFloat = 0
  var footer: CGFloat = 0

  var total: CGFloat { header + card + footer }
}

private struct PopoverContentHeightKey: PreferenceKey {
  static var defaultValue = PopoverSectionHeights()
  static func reduce(value: inout PopoverSectionHeights, nextValue: () -> PopoverSectionHeights) {
    let next = nextValue()
    if next.header > 0 { value.header = next.header }
    if next.card > 0 { value.card = next.card }
    if next.footer > 0 { value.footer = next.footer }
  }
}

struct MenuBarPopoverView: View {
  @ObservedObject var vm: MeterViewModel
  let onOpenMainTab: (MainTab?) -> Void
  let onCheckUpdates: () -> Void
  let onClosePopover: () -> Void
  let onContentHeightChanged: (CGFloat) -> Void
  @State private var measuredCardHeight: CGFloat = 0

  private func isSwitcherToolAvailable(_ key: String) -> Bool {
    if vm.isExternalProvider(key) {
      return vm.externalProviderMeta(for: key) != nil || vm.usageData?.cards?[key] != nil
    }
    if vm.apps[key]?.installed ?? false { return true }
    if vm.apps[key]?.latestTurn != nil { return true }
    let card = vm.usageData?.cards?[key]
    return !(card?.quotaWindows?.isEmpty ?? true)
      || (card?.accountEmail != nil)
      || ((card?.today.turnCount ?? 0) > 0)
      || ((card?.days30.turnCount ?? 0) > 0)
  }

  private var switcherKeys: [String] {
    let useFallback = vm.apps.isEmpty
    let ordered = vm.orderedAllProviderKeys.filter { key in
      let available = useFallback ? true : isSwitcherToolAvailable(key)
      return available && vm.isToolEnabled(key)
    }
    return ["all"] + ordered
  }

  private var effectiveSelection: String {
    let candidate = vm.popoverSelection
    if candidate == "all" { return "all" }
    if vm.isExternalProvider(candidate) {
      let exists = vm.externalProviderMeta(for: candidate) != nil || vm.usageData?.cards?[candidate] != nil
      return (exists && vm.isToolEnabled(candidate)) ? candidate : "all"
    }
    let available = vm.apps.isEmpty ? true : isSwitcherToolAvailable(candidate)
    return (available && vm.isToolEnabled(candidate)) ? candidate : "all"
  }

  private var activeCard: CodexBarCardSnapshot {
    if let snapshot = vm.usageData?.cards?[effectiveSelection] {
      return snapshot
    }
    let todayTotals = effectiveSelection == "all" ? vm.todaySummary : nil
    let emptyToday = CardTodayMetrics(
      costUsd: todayTotals?.estimatedCostUsd,
      totalTokens: todayTotals?.totalTokens ?? 0,
      totalInputTokens: todayTotals?.totalInputTokens ?? 0,
      outputTokens: todayTotals?.outputTokens ?? 0,
      turnCount: todayTotals?.turnCount ?? 0,
      callCount: todayTotals?.callCount ?? 0,
      cacheRatePct: todayTotals?.cacheRatePct,
      avgTps: todayTotals?.avgTps,
      cacheSavingsUsd: todayTotals?.cacheSavingsUsd
    )
    let emptyWin = CardWindowMetrics(
      costUsd: todayTotals?.estimatedCostUsd,
      totalTokens: todayTotals?.totalTokens ?? 0,
      turnCount: todayTotals?.turnCount ?? 0
    )
    return CodexBarCardSnapshot(
      accountEmail: nil,
      planTitle: nil,
      quotaWindows: nil,
      resetCreditsText: nil,
      quotaHint: nil,
      latestTpsText: nil,
      latestCacheText: nil,
      latestTurnSubline: nil,
      today: emptyToday,
      currentWindow: emptyWin,
      days30: emptyWin,
      daily30: [],
      projects: nil,
      recentWindows: [],
      topModel: nil
    )
  }

  private var showsContextStrip: Bool {
    !vm.runtime.runningFromDmg && (!vm.daemonOnline || !vm.masterEnabled)
  }

  private var popoverHeader: some View {
    let tabs = switcherKeys
    return VStack(alignment: .leading, spacing: 0) {
      ProviderSwitcherBar(vm: vm, switcherKeys: tabs, selection: $vm.popoverSelection)

      Divider().padding(.horizontal, 12).padding(.bottom, 2)
    }
    .fixedSize(horizontal: false, vertical: true)
    .background(
      GeometryReader { geo in
        Color.clear.preference(
          key: PopoverContentHeightKey.self,
          value: PopoverSectionHeights(header: geo.size.height)
        )
      }
    )
  }

  private var popoverFooter: some View {
    VStack(alignment: .leading, spacing: 0) {
      if showsContextStrip {
        HStack {
          Text(vm.daemonOnline ? "全局监控已暂停" : "后台采集服务未运行")
            .font(.system(size: 11))
            .foregroundColor(.secondary)
          Spacer()
          Button(vm.daemonOnline ? "恢复显示" : "开启后台") {
            vm.setMasterEnabled(true)
          }
          .buttonStyle(.borderedProminent)
          .tint(CodexBarPalette.accentBlue)
          .controlSize(.mini)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 5)
      } else {
        Spacer().frame(height: 4)
      }

      Divider().padding(.horizontal, 10)

      VStack(spacing: 1) {
        if let rawUrl = activeCard.detailUrl ?? vm.externalProviderMeta(for: effectiveSelection)?.detailUrl,
           let url = URL(string: rawUrl) {
          PopoverActionRow(title: "打开控制台", trailingSymbol: "arrow.up.right") {
            onClosePopover()
            NSWorkspace.shared.open(url)
          }
        }

        PopoverActionRow(title: "用量仪表盘") {
          onClosePopover()
          onOpenMainTab(.usage)
        }

        PopoverActionRow(title: "最近轮次") {
          onClosePopover()
          onOpenMainTab(.turns)
        }
      }
      .padding(.horizontal, 6)
      .padding(.vertical, 3)

      Divider().padding(.horizontal, 10)

      VStack(spacing: 1) {
        PopoverActionRow(title: "刷新", shortcut: "⌘ R", isLoading: vm.usageLoading) {
          vm.refreshDoctorAndBootstrap()
          vm.fetchUsageSummary(silent: false, forceRefresh: true)
        }
        .keyboardShortcut("r", modifiers: .command)

        PopoverActionRow(title: "设置...", shortcut: "⌘ ,") {
          let targetPane: SettingsPane = effectiveSelection == "all"
            ? .general
            : .provider(effectiveSelection)
          onClosePopover()
          vm.openSettingsPane(targetPane)
          onOpenMainTab(nil)
        }
        .keyboardShortcut(",", modifiers: .command)

        PopoverActionRow(title: "退出", shortcut: "⌘ Q") {
          NSApp.terminate(nil)
        }
        .keyboardShortcut("q", modifiers: .command)
      }
      .padding(.horizontal, 6)
      .padding(.top, 3)
      .padding(.bottom, 6)
    }
    .fixedSize(horizontal: false, vertical: true)
    .background(
      GeometryReader { geo in
        Color.clear.preference(
          key: PopoverContentHeightKey.self,
          value: PopoverSectionHeights(footer: geo.size.height)
        )
      }
    )
  }

  var body: some View {
    let tabs = switcherKeys
    return VStack(alignment: .leading, spacing: 0) {
      popoverHeader
        .layoutPriority(2)

      ScrollView(.vertical, showsIndicators: false) {
        CodexBarStyleCardView(
          vm: vm,
          selection: effectiveSelection,
          card: activeCard,
          onLoginRequested: { key in
            onClosePopover()
            onOpenMainTab(nil)
            DispatchQueue.main.async {
              if key == "cursor" {
                vm.showCursorLoginSheet = true
              } else {
                vm.startPluginLogin(key)
              }
            }
          }
        )
        .fixedSize(horizontal: false, vertical: true)
        .background(
          GeometryReader { geo in
            Color.clear.preference(
              key: PopoverContentHeightKey.self,
              value: PopoverSectionHeights(card: geo.size.height)
            )
          }
        )
      }
      .id(effectiveSelection)
      .frame(maxHeight: measuredCardHeight > 0 ? measuredCardHeight : nil)
      .layoutPriority(1)

      popoverFooter
        .layoutPriority(2)
    }
    .background(
      ZStack {
        ForEach(Array(tabs.prefix(9).enumerated()), id: \.offset) { idx, key in
          Button("") {
            vm.popoverSelection = key
          }
          .keyboardShortcut(KeyEquivalent(Character("\(idx + 1)")), modifiers: .command)
          .frame(width: 0, height: 0)
          .opacity(0.001)
          .accessibilityHidden(true)
        }
      }
    )
    .frame(minWidth: 310, idealWidth: 310, maxWidth: 310, maxHeight: .infinity, alignment: .top)
    .onPreferenceChange(PopoverContentHeightKey.self) { heights in
      if heights.card > 0, abs(measuredCardHeight - heights.card) > 0.5 {
        measuredCardHeight = heights.card
      }
      if heights.header > 0 && heights.card > 0 && heights.footer > 0 {
        onContentHeightChanged(heights.total)
      }
    }
    .onChange(of: vm.popoverSelection) { _ in
      CostHistoryFlyoutController.shared.hideImmediately()
    }
  }
}
