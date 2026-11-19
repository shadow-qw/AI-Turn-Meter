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

  private var selectedPeriodTitle: String {
    dayOptions.first(where: { $0.0 == vm.usageDays })?.1 ?? "\(vm.usageDays) 天"
  }

  private var selectedToolLabel: String {
    vm.usageToolFilter == "all" ? "全部提供商" : vm.displayTitle(for: vm.usageToolFilter)
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
        .disabled(vm.usageData == nil)
      }

      if let data = vm.usageData {
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
            // Hero Spend & Token Mix Card
            SettingsGroupCard {
              VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                  VStack(alignment: .leading, spacing: 2) {
                    Text("\(selectedToolLabel) · \(selectedPeriodTitle)")
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
                  let projs = data.byProject ?? []
                  if projs.isEmpty {
                    emptyTip("暂无项目记录")
                  } else {
                    ForEach(Array(projs.enumerated()), id: \.element.id) { idx, row in
                      if idx > 0 { Divider() }
                      breakdownRow(
                        title: row.name,
                        subtitle: "\(row.path) · \(row.turnCount) 轮 · \(MeterFormat.tokens(row.totalTokens))",
                        share: row.sharePct / 100.0,
                        costText: MeterFormat.usd(row.estimatedCostUsd)
                      )
                    }
                  }
                case "daily":
                  DailyReceiptSectionView(vm: vm)
                default:
                  if data.byModel.isEmpty {
                    emptyTip("暂无模型记录")
                  } else {
                    ForEach(Array(data.byModel.enumerated()), id: \.element.id) { idx, row in
                      if idx > 0 { Divider() }
                      breakdownRow(
                        title: row.model,
                        subtitle: "\(row.toolLabel) · \(row.turnCount) 轮 · \(MeterFormat.tokens(row.totalTokens))",
                        share: row.sharePct / 100.0,
                        costText: row.priced ? MeterFormat.usd(row.estimatedCostUsd) : "未定价"
                      )
                    }
                  }
                }
              }
              .padding(14)
            }
          }
          .padding(.bottom, 8)
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

  private func emptyTip(_ msg: String) -> some View {
    Text(msg)
      .font(.system(size: 12))
      .foregroundColor(.secondary)
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.vertical, 18)
  }
}
