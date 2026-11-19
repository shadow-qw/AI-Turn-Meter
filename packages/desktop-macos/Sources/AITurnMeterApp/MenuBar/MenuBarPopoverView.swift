import AITurnMeterCore
import AppKit
import SwiftUI

private struct ProviderSwitcherBar: View {
  @ObservedObject var vm: MeterViewModel
  @Binding var selection: String
  @State private var hoveredKey: String? = nil

  private func isToolAvailable(_ key: String) -> Bool {
    if vm.apps[key]?.installed ?? false { return true }
    let card = vm.usageData?.cards?[key]
    return !(card?.quotaWindows?.isEmpty ?? true) || (card?.accountEmail != nil)
  }

  private var switcherKeys: [String] {
    let useFallback = vm.apps.isEmpty
    let tools = ["codex", "cursor", "antigravity", "codebuddy"].filter { key in
      let available = useFallback ? true : isToolAvailable(key)
      return available && vm.isToolEnabled(key)
    }
    return ["all"] + tools
  }

  private func indicatorFraction(for key: String, installed: Bool, active: Bool) -> Double {
    guard key != "all", installed, active else { return 0 }
    if let rem = vm.usageData?.cards?[key]?.quotaWindows?.first?.remainingPct {
      let pct = vm.quotaDisplayMode.displayPct(fromRemaining: rem)
      return max(0.08, min(1.0, pct / 100.0))
    }
    return 1.0
  }

  var body: some View {
    HStack(spacing: 4) {
      ForEach(switcherKeys, id: \.self) { key in
        let isSelected = selection == key
        let isHovered = hoveredKey == key
        let isAll = key == "all"
        let installed = isAll || isToolAvailable(key)
        let active = !isAll && installed && vm.isActiveOverall && vm.isToolEnabled(key)
        let frac = indicatorFraction(for: key, installed: installed, active: active)
        let fillColor: Color = {
          if isSelected { return .white }
          if active { return vm.toolAccentColor(for: key) }
          return Color.gray.opacity(0.45)
        }()

        Button {
          selection = key
        } label: {
          VStack(spacing: 3) {
            ToolGlyph.iconView(for: key, size: 15)
              .frame(height: 16)
            Text(vm.toolShortTitle(for: key))
              .font(.system(size: 9.5, weight: isSelected ? .semibold : .medium))
              .lineLimit(1)
              .minimumScaleFactor(0.72)
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
          .frame(maxWidth: .infinity)
          .padding(.vertical, 5)
          .padding(.horizontal, 2)
          .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
              .fill(isSelected ? CodexBarPalette.accentBlue : (isHovered ? Color.primary.opacity(0.06) : Color.clear))
          )
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { inside in
          if inside { hoveredKey = key }
          else if hoveredKey == key { hoveredKey = nil }
        }
      }
    }
    .padding(.horizontal, 10)
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
  @State private var hovered: CardDailyPoint? = nil

  private var useCostScale: Bool {
    points.contains { ($0.costUsd ?? 0) > 0 }
  }

  private func metricValue(_ pt: CardDailyPoint) -> Double {
    if useCostScale { return max(0, pt.costUsd ?? 0) }
    return Double(max(0, pt.totalTokens))
  }

  private var peakLabel: String {
    if useCostScale {
      let peak = points.map { max(0, $0.costUsd ?? 0) }.max() ?? 0
      if peak >= 10 { return "$\(Int(peak.rounded()))" }
      if peak > 0 { return MeterFormat.usd(peak) }
      return "$0"
    }
    let peakTok = points.map(\.totalTokens).max() ?? 0
    return peakTok > 0 ? MeterFormat.tokens(peakTok) : "0"
  }

  var body: some View {
    let maxVal = max(0.000001, points.map(metricValue).max() ?? 0)

    VStack(spacing: 3) {
      HStack {
        if let pt = hovered {
          Text("\(pt.label) · \(MeterFormat.usd(pt.costUsd)) · \(MeterFormat.tokens(pt.totalTokens))")
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
  @State private var isCardHovered: Bool = false

  private var isAll: Bool { selection == "all" }

  private var headerTitle: String {
    isAll ? "全部客户端" : vm.toolShortTitle(for: selection)
  }

  private var primaryText: Color {
    isCardHovered ? .white : .primary
  }

  private var secondaryText: Color {
    isCardHovered ? .white.opacity(0.78) : .secondary
  }

  private var statusLabel: String {
    if isAll {
      let installed = vm.orderedKeys.filter { vm.apps[$0]?.installed ?? false }.count
      let active = vm.orderedKeys.filter {
        (vm.apps[$0]?.installed ?? false) && vm.isActiveOverall && vm.isToolEnabled($0)
      }.count
      if !vm.daemonOnline { return "后台未启动" }
      if !vm.masterEnabled { return "已暂停" }
      return "\(active)/\(installed) 监控中"
    }
    guard let entry = vm.apps[selection], entry.installed else { return "未安装" }
    if !vm.daemonOnline { return "后台未启动" }
    if !vm.masterEnabled || !vm.isToolEnabled(selection) { return "已暂停" }
    if let port = entry.cdpPort { return "CDP:\(port)" }
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
    guard vm.showRecentWindowsInMenu else { return [] }
    return card.recentWindows.filter { $0.index == 0 || $0.turnCount > 0 }
  }

  private var dividerLine: some View {
    Rectangle()
      .fill(isCardHovered ? Color.white.opacity(0.22) : Color.primary.opacity(0.08))
      .frame(height: 0.5)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      // Card Header (CodexBar compact density: concise title + Email / Plan)
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 1.5) {
          Text(headerTitle)
            .font(.system(size: 13.5, weight: .bold))
            .foregroundColor(primaryText)
          Text(vm.relativeUpdateLabel())
            .font(.system(size: 10))
            .foregroundColor(secondaryText)
        }

        Spacer(minLength: 6)

        VStack(alignment: .trailing, spacing: 1.5) {
          Text(card.accountEmail ?? statusLabel)
            .font(.system(size: 11.5, weight: .semibold))
            .foregroundColor(primaryText)
            .lineLimit(1)
          Text(card.planTitle ?? "本地监控")
            .font(.system(size: 10))
            .foregroundColor(secondaryText)
            .lineLimit(1)
        }
      }

      dividerLine

      // Primary Quota Windows (Remaining % + Reset countdown + Pace marker)
      let windows = card.quotaWindows ?? []
      if !windows.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(windows) { win in
            quotaBlock(win: win)
          }
        }
      } else {
        HStack(spacing: 6) {
          Text(
            isAll
              ? "正在同步客户端登录与额度信息…"
              : ((vm.apps[selection]?.installed ?? false)
                  ? (card.quotaHint ?? (
                      selection == "cursor"
                        ? (vm.hasCursorCookie
                            ? "未读取到套餐限额 · 请重新登录"
                            : "需在「设置 → Cursor」授权读取或网页登录")
                        : (selection == "codex"
                            ? (card.accountEmail != nil
                                ? "正在同步配额 · 请点击刷新或运行 Codex 后自动获取"
                                : "当前为 API Key / 企业按量模式，或尚未登录 ChatGPT 账号")
                            : "企业/团队按量模式 · 无固定个人会话限额")))
                  : "未检测到该客户端安装")
          )
          .font(.system(size: 10.5))
          .foregroundColor(secondaryText)
          .lineLimit(1)
          Spacer(minLength: 4)
          Text(statusLabel)
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(isCardHovered ? .white.opacity(0.88) : .secondary)
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

      // Cost & Usage 3x2 Dual-Column Grid
      VStack(alignment: .leading, spacing: 6) {
        metricGridRow(
          leftLabel: "今日",
          leftVal: MeterFormat.usd(card.today.costUsd),
          rightLabel: "估算：当前窗口",
          rightVal: MeterFormat.usd(card.currentWindow.costUsd)
        )
        metricGridRow(
          leftLabel: "今日 token 用量",
          leftVal: MeterFormat.tokens(card.today.totalTokens),
          rightLabel: "估算：当前窗口 token 用量",
          rightVal: MeterFormat.tokens(card.currentWindow.totalTokens)
        )
        metricGridRow(
          leftLabel: "近 30 天",
          leftVal: MeterFormat.usd(card.days30.costUsd),
          rightLabel: "近 30 天 token 用量",
          rightVal: MeterFormat.tokens(card.days30.totalTokens)
        )
      }

      // 30-day Mini Usage Chart
      if !card.daily30.isEmpty {
        MiniUsageBarsView(points: card.daily30, cardHovered: isCardHovered)
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
                Text("\(MeterFormat.usd(win.costUsd)) · \(MeterFormat.tokens(win.totalTokens))")
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

      // Quiet Unboxed Footer Lines
      VStack(alignment: .leading, spacing: 2) {
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
        Text("根据 Token 用量估算 · 不是订阅账单")
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

  private func quotaBlock(win: CardQuotaWindow) -> some View {
    let pct = vm.quotaDisplayMode.displayPct(fromRemaining: win.remainingPct)
    let clamped = min(1.0, max(0.0, pct / 100.0))
    let pctRounded = Int(pct.rounded())
    let trackColor = isCardHovered ? Color.white.opacity(0.24) : Color.primary.opacity(0.10)
    let fillColor = isCardHovered ? Color.white.opacity(0.95) : CodexBarPalette.tealBar
    let tickColor = isCardHovered ? Color.white.opacity(0.26) : Color.primary.opacity(0.14)

    return VStack(alignment: .leading, spacing: 3.5) {
      HStack(spacing: 6) {
        Text("\(win.title) \(vm.quotaDisplayMode.verbLabel) \(pctRounded)%")
          .font(.system(size: 12, weight: .semibold))
          .monospacedDigit()
          .foregroundColor(primaryText)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
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
                .fill(isCardHovered ? CodexBarPalette.cardTop : Color.white.opacity(0.94))
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

      if let sub = win.subtitle, !sub.isEmpty {
        Text(sub)
          .font(.system(size: 10))
          .monospacedDigit()
          .foregroundColor(secondaryText)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
      }
    }
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
  var action: () -> Void

  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Text(title)
          .font(.system(size: 12))
          .foregroundColor(hovering ? .white : .primary)
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

struct MenuBarPopoverView: View {
  @ObservedObject var vm: MeterViewModel
  let onOpenMainTab: (MainTab?) -> Void
  let onCheckUpdates: () -> Void
  let onClosePopover: () -> Void

  private var effectiveSelection: String {
    let candidate = vm.popoverSelection
    if candidate == "all" { return "all" }
    let installed = vm.apps.isEmpty ? true : (vm.apps[candidate]?.installed ?? false)
    return (installed && vm.isToolEnabled(candidate)) ? candidate : "all"
  }

  private var activeCard: CodexBarCardSnapshot {
    if let snapshot = vm.usageData?.cards?[effectiveSelection] {
      return snapshot
    }
    let todayTotals = vm.todaySummary
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

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ProviderSwitcherBar(vm: vm, selection: $vm.popoverSelection)

      Divider().padding(.horizontal, 12).padding(.bottom, 2)

      CodexBarStyleCardView(vm: vm, selection: effectiveSelection, card: activeCard)

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
        PopoverActionRow(title: "刷新", shortcut: "⌘ R") {
          vm.refreshDoctorAndBootstrap()
          vm.fetchUsageSummary(silent: true, forceRefresh: true)
        }
        .keyboardShortcut("r", modifiers: .command)

        PopoverActionRow(title: "设置...", shortcut: "⌘ ,") {
          let targetPane: SettingsPane = vm.popoverSelection == "all"
            ? .general
            : .provider(vm.popoverSelection)
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
    .frame(width: 310)
  }
}
