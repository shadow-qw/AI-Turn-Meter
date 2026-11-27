import AITurnMeterCore
import SwiftUI

struct UsageSummaryTabView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var hoveredDay: UsageDailyPoint? = nil
  @State private var hoveredPeriod: Int? = nil
  @State private var hoveredToolChip: String? = nil
  @State private var chartMetric: String = "cost"

  private let dayOptions: [(Int, String)] = [
    (1, "今日"),
    (7, "7 天"),
    (30, "30 天"),
    (90, "90 天"),
    (0, "全部"),
  ]

  private let groupTabs: [(String, String)] = [
    ("tool", "提供商"),
    ("model", "模型"),
    ("project", "项目"),
    ("daily", "每日账单"),
  ]

  private func periodTitle(for days: Int) -> String {
    dayOptions.first(where: { $0.0 == days })?.1 ?? "\(days) 天"
  }

  private func toolLabel(for tool: String?) -> String {
    let resolved = (tool ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if resolved.isEmpty || resolved == "all" { return "全部提供商" }
    return vm.displayTitle(for: resolved)
  }

  private func dayMetricValue(_ pt: UsageDailyPoint) -> Double {
    chartMetric == "cost" ? max(0, pt.estimatedCostUsd ?? 0) : Double(max(0, pt.totalTokens))
  }

  var body: some View {
    VStack(spacing: 12) {
      // Top Range + Tool Filters + Export
      HStack(spacing: 8) {
        HStack(spacing: 2) {
          ForEach(dayOptions, id: \.0) { opt in
            let active = vm.usageDays == opt.0
            let hovered = hoveredPeriod == opt.0
            Button(opt.1) {
              vm.usageDays = opt.0
              vm.fetchUsageSummary()
            }
            .buttonStyle(.plain)
            .font(.system(size: 11, weight: active ? .medium : .regular))
            .foregroundColor(active ? .primary : (hovered ? .primary : .secondary))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(active ? Color.primary.opacity(0.10) : (hovered ? Color.primary.opacity(0.05) : Color.clear))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .onHover { inside in
              if inside { hoveredPeriod = opt.0 }
              else if hoveredPeriod == opt.0 { hoveredPeriod = nil }
            }
          }
        }
        .padding(2)
        .background(Color.primary.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

        Spacer()

        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 4) {
            filterChip(key: "all", label: "全部")
            ForEach(vm.orderedKeys, id: \.self) { k in
              filterChip(key: k, label: vm.toolShortTitle(for: k))
            }
          }
        }

        if vm.usageLoading {
          ProgressView().controlSize(.small)
        } else {
          Button {
            vm.fetchUsageSummary(forceRefresh: true)
            if vm.usageGroupMode == "daily" {
              vm.fetchReceipt()
            }
          } label: {
            Image(systemName: "arrow.clockwise")
              .font(.system(size: 11.5))
              .foregroundColor(.secondary)
          }
          .buttonStyle(.borderless)
          .help("刷新")
        }

        Button("导出") {
          vm.exportUsageCsv()
        }
        .buttonStyle(.bordered)
        .controlSize(.mini)
        .disabled(!vm.canExportUsageCsv)
      }

      if let data = vm.usageData {
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
            // Hero Spend & Token Mix Card
            SettingsGroupCard {
              VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                  VStack(alignment: .leading, spacing: 2) {
                    Text("\(toolLabel(for: data.tool)) · \(periodTitle(for: data.days))")
                      .font(.system(size: 12.5, weight: .medium))
                      .foregroundColor(.secondary)
                    Text(MeterFormat.usd(data.totals.estimatedCostUsd))
                      .font(.system(size: 28, weight: .bold))
                      .monospacedDigit()
                  }
                  Spacer()
                  if let saved = data.totals.cacheSavingsUsd, saved > 0 {
                    Text("缓存节省 \(MeterFormat.usd(saved))")
                      .font(.system(size: 11.5))
                      .monospacedDigit()
                      .foregroundColor(.secondary)
                  }
                }

                Divider()

                HStack(spacing: 0) {
                  summaryCol(title: "总 Token", value: MeterFormat.tokens(data.totals.totalTokens))
                  summaryCol(title: "输入", value: MeterFormat.tokens(data.totals.totalInputTokens))
                  summaryCol(title: "缓存率", value: MeterFormat.pct(data.totals.cacheRatePct))
                  summaryCol(title: "输出", value: MeterFormat.tokens(data.totals.outputTokens))
                  summaryCol(title: "今日", value: MeterFormat.usd(data.today.estimatedCostUsd))
                }

                if data.totals.thinkingTokens > 0 {
                  Divider()
                  thinkingRatioBlock(
                    thinkingTokens: data.totals.thinkingTokens,
                    outputTokens: data.totals.outputTokens
                  )
                }
              }
              .padding(14)
            }

            // Historical Daily Trend Card (Supports up to 90 bars + cost/token scale)
            if !data.daily.isEmpty {
              let visibleDays = Array(data.daily.suffix(90))
              let maxVal = max(0.000001, visibleDays.map(dayMetricValue).max() ?? 0)
              let peakDate = visibleDays.max(by: { dayMetricValue($0) < dayMetricValue($1) })?.date

              SettingsGroupCard {
                VStack(alignment: .leading, spacing: 10) {
                  HStack {
                    if let pt = hoveredDay {
                      Text("\(pt.date) · \(MeterFormat.usd(pt.estimatedCostUsd)) · \(MeterFormat.tokens(pt.totalTokens)) · \(pt.turnCount) 轮")
                        .font(.system(size: 11.5, weight: .medium))
                        .monospacedDigit()
                        .foregroundColor(.primary)
                    } else {
                      let peakUsd = visibleDays.compactMap(\.estimatedCostUsd).max() ?? 0
                      let peakTok = visibleDays.map(\.totalTokens).max() ?? 0
                      Text("日峰值 \(chartMetric == "cost" ? MeterFormat.usd(peakUsd) : MeterFormat.tokens(peakTok))")
                        .font(.system(size: 11.5))
                        .monospacedDigit()
                        .foregroundColor(.secondary)
                    }
                    Spacer()
                    Picker("", selection: $chartMetric) {
                      Text("费用").tag("cost")
                      Text("Token").tag("tokens")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .controlSize(.mini)
                    .frame(width: 100)
                  }

                  VStack(spacing: 0) {
                    HStack(alignment: .bottom, spacing: 0) {
                      ForEach(visibleDays) { pt in
                        let val = dayMetricValue(pt)
                        let frac = val > 0 ? CGFloat(val / maxVal) : 0
                        let isHov = hoveredDay?.id == pt.id
                        let isPeak = val > 0 && pt.date == peakDate

                        RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                          .fill(
                            val > 0
                              ? (isHov ? CodexBarPalette.accentBlue : CodexBarPalette.tealBar)
                              : Color.primary.opacity(isHov ? 0.24 : 0.08)
                          )
                          .frame(maxWidth: .infinity)
                          .frame(height: val > 0 ? max(4, frac * 68) : 2)
                          .overlay(alignment: .top) {
                            if isPeak {
                              RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                                .fill(Color(nsColor: .systemYellow))
                                .frame(height: 3)
                            }
                          }
                          .padding(.horizontal, 1.0)
                          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                      }
                    }
                    .frame(height: 70, alignment: .bottom)
                    .overlay {
                      GeometryReader { geo in
                        Color.clear
                          .contentShape(Rectangle())
                          .onContinuousHover { phase in
                            switch phase {
                            case .active(let loc):
                              guard !visibleDays.isEmpty else { return }
                              let w = max(1, geo.size.width)
                              let idx = min(visibleDays.count - 1, max(0, Int((loc.x / w) * CGFloat(visibleDays.count))))
                              let target = visibleDays[idx]
                              if hoveredDay?.id != target.id { hoveredDay = target }
                            case .ended:
                              hoveredDay = nil
                            }
                          }
                      }
                    }

                    Rectangle()
                      .fill(Color.primary.opacity(0.10))
                      .frame(height: 1)
                  }

                  HStack {
                    if let first = visibleDays.first {
                      Text(MeterFormat.shortDate(first.date))
                    }
                    Spacer()
                    if let last = visibleDays.last {
                      Text(MeterFormat.shortDate(last.date))
                    }
                  }
                  .font(.system(size: 10))
                  .foregroundColor(.secondary)
                }
                .padding(14)
              }
            }

            // 4-Dimension Historical Breakdown (Providers / Models / Projects / Daily Ledger)
            SettingsGroupCard {
              VStack(alignment: .leading, spacing: 10) {
                Picker("", selection: $vm.usageGroupMode) {
                  ForEach(groupTabs, id: \.0) { t in
                    Text(t.1).tag(t.0)
                  }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .frame(maxWidth: 320, alignment: .leading)
                .onChange(of: vm.usageGroupMode) { nextMode in
                  if nextMode == "daily" {
                    vm.fetchReceipt(silent: vm.receiptData != nil)
                  }
                }

                Divider()

                switch vm.usageGroupMode {
                case "tool":
                  if data.byTool.isEmpty {
                    emptyTip("暂无记录")
                  } else {
                    ForEach(Array(data.byTool.enumerated()), id: \.element.id) { idx, row in
                      if idx > 0 { Divider() }
                      breakdownRow(
                        title: row.toolLabel,
                        subtitle: "\(row.turnCount) 轮 · \(MeterFormat.tokens(row.totalTokens)) · 缓存 \(MeterFormat.pct(row.cacheRatePct))",
                        share: row.sharePct / 100.0,
                        costText: MeterFormat.usd(row.estimatedCostUsd)
                      )
                    }
                  }
                case "project":
                  let workspaces = data.byWorkspace ?? []
                  let legacyProjects = data.byProject ?? []
                  if !workspaces.isEmpty {
                    ForEach(Array(workspaces.enumerated()), id: \.element.id) { idx, row in
                      if idx > 0 { Divider() }
                      workspaceRow(row)
                    }
                  } else if !legacyProjects.isEmpty {
                    ForEach(Array(legacyProjects.enumerated()), id: \.element.id) { idx, row in
                      if idx > 0 { Divider() }
                      breakdownRow(
                        title: row.name,
                        subtitle: "\(row.path) · \(row.turnCount) 轮 · \(MeterFormat.tokens(row.totalTokens))",
                        share: row.sharePct / 100.0,
                        costText: MeterFormat.usd(row.estimatedCostUsd)
                      )
                    }
                  } else {
                    emptyTip("暂无项目记录")
                  }
                case "daily":
                  DailyReceiptSectionView(vm: vm)
                default:
                  if data.byModel.isEmpty {
                    emptyTip("暂无模型记录")
                  } else {
                    ForEach(Array(data.byModel.enumerated()), id: \.element.id) { idx, row in
                      if idx > 0 { Divider() }
                      let thinkingPart: String = {
                        guard let think = row.thinkingTokens, think > 0 else { return "" }
                        let denom = max(row.outputTokens, think)
                        let pct = denom > 0 ? (Double(think) / Double(denom)) * 100.0 : 0
                        return " · 思考 \(MeterFormat.tokens(think)) (\(MeterFormat.pct(pct)))"
                      }()
                      breakdownRow(
                        title: row.model,
                        subtitle: "\(row.toolLabel) · \(row.turnCount) 轮 · \(MeterFormat.tokens(row.totalTokens))\(thinkingPart)",
                        share: row.sharePct / 100.0,
                        costText: row.priced ? MeterFormat.usd(row.estimatedCostUsd) : "未定价"
                      )
                    }
                  }
                }
              }
              .padding(14)
            }

            // Workspace / Project Spend Ranking Card (byWorkspace)
            if vm.usageGroupMode != "project", let workspaces = data.byWorkspace, !workspaces.isEmpty {
              let topWorkspaces = Array(workspaces.prefix(10))
              SettingsGroupCard {
                VStack(alignment: .leading, spacing: 10) {
                  HStack {
                    Text("项目消耗排行")
                      .font(.system(size: 12.5, weight: .semibold))
                      .foregroundColor(.secondary)
                    Spacer()
                    Text("Top \(topWorkspaces.count) 工作区")
                      .font(.system(size: 10.5))
                      .foregroundColor(.secondary)
                  }

                  ForEach(Array(topWorkspaces.enumerated()), id: \.element.id) { idx, row in
                    if idx > 0 { Divider() }
                    workspaceRow(row)
                  }
                }
                .padding(14)
              }
            }

            // External Provider Plugin Cards (kept separate from local USD token estimates)
            let activeExternal: [ExternalProviderMeta] = vm.orderedAllProviderKeys.compactMap { key in
              guard vm.isExternalProvider(key), vm.isToolEnabled(key) else { return nil }
              return vm.externalProviderMeta(for: key)
            }
            if !activeExternal.isEmpty && vm.usageToolFilter == "all" {
              SettingsGroupCard {
                VStack(alignment: .leading, spacing: 10) {
                  HStack {
                    Text("外部插件额度与账单")
                      .font(.system(size: 12.5, weight: .semibold))
                      .foregroundColor(.secondary)
                    Spacer()
                    Text("独立结算口径 · 不计入本地估算")
                      .font(.system(size: 10.5))
                      .foregroundColor(.secondary)
                  }

                  ForEach(Array(activeExternal.enumerated()), id: \.element.id) { idx, meta in
                    if idx > 0 { Divider() }
                    let card = data.cards?[meta.key]
                    let sym = card?.resolvedCurrencySymbol ?? meta.currencySymbol ?? "$"
                    let periodLabel = card?.billingSummary?.periodLabel ?? "本月"
                    let periodLimit = card?.billingSummary?.periodLimit
                    let derivedPeriodCost: Double? = {
                      if let explicit = card?.billingSummary?.periodCost { return explicit }
                      if let limit = periodLimit, let rem = card?.billingSummary?.periodRemaining {
                        return max(0, limit - rem)
                      }
                      return card?.days30.costUsd
                    }()
                    let periodCost = derivedPeriodCost
                    let todayCost = card?.billingSummary?.todayCost ?? card?.today.costUsd
                    let firstWin = card?.quotaWindows?.first

                    Button {
                      vm.openSettingsPane(.provider(meta.key))
                    } label: {
                      VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                          ToolGlyph.iconView(for: meta.key, sfSymbolOverride: meta.icon, size: 15)
                            .foregroundColor(vm.toolAccentColor(for: meta.key))
                          Text(meta.name)
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundColor(.primary)
                          if let plan = card?.planTitle, !plan.isEmpty {
                            Text(plan)
                              .font(.system(size: 10.5))
                              .foregroundColor(.secondary)
                          }
                          Spacer()
                          if let limit = periodLimit, limit > 0 {
                            Text("\(periodLabel) \(MeterFormat.money(periodCost, symbol: sym)) / \(MeterFormat.money(limit, symbol: sym))")
                              .font(.system(size: 12, weight: .semibold))
                              .monospacedDigit()
                              .foregroundColor(.primary)
                          } else if let cost = periodCost {
                            Text("\(periodLabel) \(MeterFormat.money(cost, symbol: sym))")
                              .font(.system(size: 12, weight: .semibold))
                              .monospacedDigit()
                              .foregroundColor(.primary)
                          }
                          Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(.secondary)
                        }

                        if let win = firstWin {
                          let pct = vm.quotaDisplayMode.displayPct(fromRemaining: win.remainingPct)
                          let barColor: Color = {
                            switch win.healthLevel {
                            case .critical: return .red
                            case .warning: return .orange
                            case .normal: return CodexBarPalette.tealBar
                            }
                          }()
                          HStack(spacing: 8) {
                            GeometryReader { geo in
                              ZStack(alignment: .leading) {
                                Capsule().fill(Color.primary.opacity(0.08))
                                Capsule()
                                  .fill(barColor)
                                  .frame(width: max(4, geo.size.width * CGFloat(min(1, max(0, pct / 100.0)))))
                              }
                            }
                            .frame(height: 4.5)

                            Text("\(win.title) \(vm.quotaDisplayMode.verbLabel) \(Int(pct.rounded()))% · 今日 \(MeterFormat.money(todayCost, symbol: sym))")
                              .font(.system(size: 10.5))
                              .monospacedDigit()
                              .foregroundColor(.secondary)
                              .lineLimit(1)
                          }
                        } else if let hint = card?.quotaHint ?? meta.error {
                          Text(hint)
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                        }
                      }
                      .contentShape(Rectangle())
                      .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
                  }
                }
                .padding(14)
              }
            }
          }
          .padding(.bottom, 8)
          .opacity(vm.canExportUsageCsv ? 1.0 : 0.65)
        }
      } else {
        Spacer()
        Text(vm.usageLoading ? "正在加载…" : "暂无统计数据")
          .font(.system(size: 12.5))
          .foregroundColor(.secondary)
        Spacer()
      }
    }
  }

  private func summaryCol(title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title)
        .font(.system(size: 10.5))
        .foregroundColor(.secondary)
      Text(value)
        .font(.system(size: 13.5, weight: .semibold))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func filterChip(key: String, label: String) -> some View {
    let active = vm.usageToolFilter == key
    let hovered = hoveredToolChip == key
    return Button(label) {
      vm.usageToolFilter = key
      vm.fetchUsageSummary()
      if vm.usageGroupMode == "daily" {
        vm.fetchReceipt(silent: true)
      }
    }
    .buttonStyle(.plain)
    .font(.system(size: 11, weight: active ? .medium : .regular))
    .foregroundColor(active ? .primary : (hovered ? .primary : .secondary))
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(active ? Color.primary.opacity(0.10) : (hovered ? Color.primary.opacity(0.05) : Color.clear))
    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    .onHover { inside in
      if inside { hoveredToolChip = key }
      else if hoveredToolChip == key { hoveredToolChip = nil }
    }
  }

  private func breakdownRow(
    title: String,
    subtitle: String,
    share: Double,
    costText: String
  ) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(title)
          .font(.system(size: 12, weight: .medium))
          .lineLimit(1)
          .truncationMode(.middle)
        Spacer()
        Text(costText)
          .font(.system(size: 12.5, weight: .semibold))
          .monospacedDigit()
      }

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.primary.opacity(0.07))
          Capsule()
            .fill(CodexBarPalette.tealBar)
            .frame(width: max(4, geo.size.width * CGFloat(min(1, max(0, share)))))
        }
      }
      .frame(height: 4)

      Text(subtitle)
        .font(.system(size: 10.5))
        .foregroundColor(.secondary)
        .monospacedDigit()
        .lineLimit(1)
        .truncationMode(.middle)
    }
    .padding(.vertical, 6)
  }

  private func thinkingRatioBlock(thinkingTokens: Int, outputTokens: Int) -> some View {
    let denom = max(outputTokens, thinkingTokens)
    let ratio = denom > 0 ? min(1.0, max(0.0, Double(thinkingTokens) / Double(denom))) : 0.0
    let pct = ratio * 100.0
    let thinkingColor = Color(red: 0.56, green: 0.36, blue: 0.96)

    return VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Circle()
          .fill(thinkingColor)
          .frame(width: 6, height: 6)
        Text("思考 Token 占比")
          .font(.system(size: 11, weight: .medium))
          .foregroundColor(.secondary)
        Text(MeterFormat.pct(pct))
          .font(.system(size: 11.5, weight: .semibold))
          .monospacedDigit()
          .foregroundColor(.primary)
        Spacer()
        Text("思考 \(MeterFormat.tokens(thinkingTokens)) / 输出 \(MeterFormat.tokens(outputTokens))")
          .font(.system(size: 11))
          .monospacedDigit()
          .foregroundColor(.secondary)
      }

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule()
            .fill(CodexBarPalette.tealBar.opacity(0.28))
          if ratio > 0 {
            Capsule()
              .fill(thinkingColor)
              .frame(width: max(4, geo.size.width * CGFloat(ratio)))
          }
        }
      }
      .frame(height: 5)
    }
  }

  private func workspaceRow(_ row: UsageWorkspaceRow) -> some View {
    let share = min(1.0, max(0.0, row.sharePct / 100.0))
    let tools = row.tools ?? []
    let subtitleParts: [String] = {
      var parts: [String] = ["\(row.turnCount) 轮", MeterFormat.tokens(row.totalTokens)]
      if let think = row.thinkingTokens, think > 0 {
        parts.append("思考 \(MeterFormat.tokens(think))")
      }
      if !row.workspacePath.isEmpty && row.workspacePath != row.workspaceName && row.workspacePath != "未关联工作区" {
        parts.append(row.workspacePath)
      }
      return parts
    }()

    return VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        Text(row.workspaceName)
          .font(.system(size: 12, weight: .medium))
          .lineLimit(1)
          .truncationMode(.middle)

        if !tools.isEmpty {
          HStack(spacing: 4) {
            ForEach(tools.prefix(4), id: \.self) { t in
              Text(vm.toolShortTitle(for: t))
                .font(.system(size: 9.5, weight: .medium))
                .foregroundColor(vm.toolAccentColor(for: t))
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(vm.toolAccentColor(for: t).opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            }
          }
        }

        Spacer(minLength: 6)

        Text(MeterFormat.pct(row.sharePct))
          .font(.system(size: 10.5))
          .monospacedDigit()
          .foregroundColor(.secondary)

        Text(MeterFormat.usd(row.estimatedCostUsd))
          .font(.system(size: 12.5, weight: .semibold))
          .monospacedDigit()
      }

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.primary.opacity(0.07))
          if share > 0 {
            Capsule()
              .fill(CodexBarPalette.tealBar)
              .frame(width: max(4, geo.size.width * CGFloat(share)))
          }
        }
      }
      .frame(height: 4)

      Text(subtitleParts.joined(separator: " · "))
        .font(.system(size: 10.5))
        .foregroundColor(.secondary)
        .monospacedDigit()
        .lineLimit(1)
        .truncationMode(.middle)
    }
    .padding(.vertical, 4)
  }

  private func emptyTip(_ msg: String) -> some View {
    Text(msg)
      .font(.system(size: 12))
      .foregroundColor(.secondary)
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.vertical, 18)
  }
}
