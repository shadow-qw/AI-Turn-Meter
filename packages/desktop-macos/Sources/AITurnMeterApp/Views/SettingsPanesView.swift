import AITurnMeterCore
import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct ProviderSettingsDetailView: View {
  @ObservedObject var vm: MeterViewModel
  let key: String

  var body: some View {
    if vm.isExternalProvider(key) {
      ExternalProviderDetailView(vm: vm, key: key)
    } else {
      builtInBody
    }
  }

  @ViewBuilder
  private var builtInBody: some View {
    let entry = vm.apps[key]
    let installed = entry?.installed ?? false
    let enabled = vm.isToolEnabled(key)
    let active = installed && vm.isActiveOverall && enabled
    let isDimmed = !installed || !enabled || !vm.masterEnabled
    let needsInline = installed && vm.isActiveOverall && enabled && entry?.cdpPort == nil
    let card = vm.usageData?.cards?[key]
    let latestTurn = entry?.latestTurn
    let windows = card?.quotaWindows ?? []

    let statusText: String = {
      if !installed { return "未安装" }
      if !vm.daemonOnline { return "后台未启动" }
      if !vm.masterEnabled { return "全局暂停" }
      if !enabled { return "已关闭" }
      if let port = entry?.cdpPort { return "正常运行 · CDP:\(port)" }
      return "未开启调试口"
    }()

    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        // Card 1: Clean Provider Header & Core Info
        SettingsGroupCard {
          HStack(spacing: 10) {
            ToolGlyph.iconView(for: key, size: 20)
              .foregroundColor(installed && enabled && vm.masterEnabled ? .primary : .secondary)
              .frame(width: 24, height: 24)

            Text(vm.displayTitle(for: key))
              .font(.system(size: 14.5, weight: .semibold))
              .foregroundColor(enabled && vm.masterEnabled ? .primary : .secondary)

            Spacer()

            Button {
              vm.refreshDoctorAndBootstrap()
              vm.fetchUsageSummary(forceRefresh: true)
            } label: {
              Image(systemName: "arrow.clockwise")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
            }
            .buttonStyle(.borderless)
            .help("刷新")

            Toggle("", isOn: Binding(
              get: { installed && enabled && vm.isActiveOverall },
              set: { vm.setToolEnabled(key, enabled: $0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .controlSize(.small)
            .disabled(!installed || vm.busy || vm.runtime.runningFromDmg)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 11)

          VStack(spacing: 0) {
            Divider().padding(.leading, 14)

            HStack(spacing: 8) {
              Text("状态")
                .font(.system(size: 12.5))
              Spacer()
              if needsInline && !vm.runtime.runningFromDmg {
                Button("重启并开启") {
                  vm.openAppWithInlineCdp(key)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.mini)
                .disabled(vm.busy)
                .help("温和退出并带调试口重新打开 \(vm.displayTitle(for: key))，以显示消息旁 TPS")
              } else if installed, let appPath = entry?.appPath {
                Button("打开") {
                  NSWorkspace.shared.open(URL(fileURLWithPath: appPath))
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
              }
              Text(statusText)
                .font(.system(size: 12.5))
                .foregroundColor(!enabled || !vm.masterEnabled ? .secondary : (active ? .secondary : .orange))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            Divider().padding(.leading, 14)
            settingsControlRow(title: "软件内置 TPS 显示") {
              Toggle("", isOn: Binding(
                get: { installed && vm.inlineMasterEnabled && vm.isInlineToolEnabled(key) && vm.isActiveOverall },
                set: { vm.setInlineToolEnabled(key, enabled: $0) }
              ))
              .toggleStyle(.switch)
              .labelsHidden()
              .controlSize(.small)
              .disabled(!installed || !enabled || !vm.isActiveOverall || vm.busy || vm.runtime.runningFromDmg)
            }

            if card?.accountEmail != nil || card?.planTitle != nil {
              Divider().padding(.leading, 14)
              settingsKVRow(
                title: "账户",
                value: [card?.accountEmail, card?.planTitle].compactMap { $0 }.joined(separator: " · ")
              )
            }

            if key == "cursor" {
              Divider().padding(.leading, 14)
              HStack(spacing: 8) {
                Text("会话授权")
                  .font(.system(size: 12.5))
                Spacer()
                Button(vm.hasCursorCookie ? "已连接 · 重新登录…" : "网页登录同步…") {
                  vm.showCursorLoginSheet = true
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                Button("Cookie…") {
                  vm.cursorCookieDraft = ""
                  vm.showCursorCookieSheet = true
                }
                .buttonStyle(.borderless)
                .font(.system(size: 12))
                .foregroundColor(CodexBarPalette.accentBlue)
              }
              .padding(.horizontal, 14)
              .padding(.vertical, 10)
            }

            if let turn = latestTurn {
              let summaryText = turn.inlineText ?? turn.tps.map { MeterFormat.tps($0) }
              if let summary = summaryText, !summary.isEmpty {
                Divider().padding(.leading, 14)
                HStack(spacing: 8) {
                  Text("最近轮次")
                    .font(.system(size: 12.5))
                  Spacer()
                  Text(summary)
                    .font(.system(size: 12))
                    .monospacedDigit()
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                  Button("查看") {
                    vm.recentTurnsFilterTool = key
                    vm.openSettingsPane(.turns)
                  }
                  .buttonStyle(.borderless)
                  .font(.system(size: 12))
                  .foregroundColor(CodexBarPalette.accentBlue)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
              }
            }
          }
          .opacity(isDimmed ? 0.42 : 1.0)
          .disabled(isDimmed)
        }

        // Card 2: Quota & Spend (Core Focus)
        VStack(alignment: .leading, spacing: 8) {
          Text("额度与用量")
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundColor(.secondary)
            .padding(.horizontal, 2)

          SettingsGroupCard {
            if !windows.isEmpty {
              ForEach(Array(windows.enumerated()), id: \.element.id) { idx, win in
                if idx > 0 {
                  Divider().padding(.leading, 14)
                }
                providerQuotaRow(win: win)
              }
              if let resetCredits = card?.resetCreditsText, !resetCredits.isEmpty {
                Divider().padding(.leading, 14)
                settingsKVRow(title: key == "cursor" ? "按需超额用量" : "附加额度", value: resetCredits)
              }
              Divider().padding(.leading, 14)
            } else if key == "cursor" {
              HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                  Text("套餐剩余额度")
                    .font(.system(size: 12.5))
                    .foregroundColor(.primary)
                  Text(
                    card?.quotaHint ?? (
                      vm.hasCursorCookie
                        ? "未读取到套餐限额，可读取本机凭证或重新登录"
                        : "需连接 cursor.com 会话，才可同步套餐剩余百分比与重置时间"
                    )
                  )
                  .font(.system(size: 11))
                  .foregroundColor(.secondary)
                  .lineLimit(2)
                }
                Spacer(minLength: 8)
                Button("读取本机") {
                  vm.syncCursorFromLocalApp()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.mini)
                .tint(CodexBarPalette.accentBlue)
                .disabled(vm.busy)

                Button(vm.hasCursorCookie ? "重登…" : "网页登录…") {
                  vm.showCursorLoginSheet = true
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)

                Button("Cookie…") {
                  vm.cursorCookieDraft = ""
                  vm.showCursorCookieSheet = true
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
              }
              .padding(.horizontal, 14)
              .padding(.vertical, 10)
              if let resetCredits = card?.resetCreditsText, !resetCredits.isEmpty {
                Divider().padding(.leading, 14)
                settingsKVRow(title: "按需超额用量", value: resetCredits)
              }
              Divider().padding(.leading, 14)
            }
            settingsKVRow(
              title: "今日",
              value: "\(MeterFormat.usd(card?.today.costUsd)) · \(MeterFormat.tokens(card?.today.totalTokens ?? 0))"
            )
            Divider().padding(.leading, 14)
            settingsKVRow(
              title: "近 30 天",
              value: "\(MeterFormat.usd(card?.days30.costUsd)) · \(MeterFormat.tokens(card?.days30.totalTokens ?? 0))"
            )
          }
        }
        .opacity(isDimmed ? 0.42 : 1.0)
        .disabled(isDimmed)
      }
      .padding(24)
    }
  }

  private func providerQuotaRow(win: CardQuotaWindow) -> some View {
    let pct = vm.quotaDisplayMode.displayPct(fromRemaining: win.remainingPct)
    let clamped = min(1.0, max(0.0, pct / 100.0))
    let pctRounded = Int(pct.rounded())

    return VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("\(win.title) \(vm.quotaDisplayMode.verbLabel) \(pctRounded)%")
          .font(.system(size: 12.5, weight: .medium))
          .monospacedDigit()
        Spacer()
        if let resetText = win.resetText, !resetText.isEmpty {
          Text(resetText)
            .font(.system(size: 11.5))
            .monospacedDigit()
            .foregroundColor(.secondary)
        }
      }

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule()
            .fill(Color.primary.opacity(0.09))
          if clamped > 0 {
            Capsule()
              .fill(CodexBarPalette.tealBar)
              .frame(width: max(5, geo.size.width * CGFloat(clamped)))
          }
          if let pacePct = vm.quotaDisplayMode.displayPacePct(fromRemainingPace: win.pacePct) {
            let paceFrac = min(1.0, max(0.0, pacePct / 100.0))
            let paceX = min(max(0, geo.size.width - 5.0), max(0, geo.size.width * CGFloat(paceFrac) - 2.5))
            ZStack {
              RoundedRectangle(cornerRadius: 1)
                .fill(Color(nsColor: .controlBackgroundColor))
                .frame(width: 5.0, height: 8)
              RoundedRectangle(cornerRadius: 0.75)
                .fill(CodexBarPalette.paceGreen)
                .frame(width: 2.0, height: 8)
            }
            .offset(x: paceX)
          }
        }
      }
      .frame(height: 6)

      if let sub = win.subtitle, !sub.isEmpty {
        Text(sub)
          .font(.system(size: 11))
          .monospacedDigit()
          .foregroundColor(.secondary)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
  }
}

struct ExternalProviderDetailView: View {
  @ObservedObject var vm: MeterViewModel
  let key: String
  @State private var selectedSectionId: String = ""
  @State private var hoveredDay: CardDailyPoint? = nil
  @State private var showRemoveConfirm: Bool = false

  var body: some View {
    let meta = vm.externalProviderMeta(for: key)
    let enabled = vm.isToolEnabled(key)
    let isDimmed = !enabled || !vm.masterEnabled
    let card = vm.usageData?.cards?[key]
    let windows = card?.quotaWindows ?? []
    let curSym = card?.resolvedCurrencySymbol ?? meta?.currencySymbol ?? "$"
    let breakdowns = card?.breakdowns ?? []
    let activeSection: CardBreakdownSection? =
      breakdowns.first(where: { $0.id == selectedSectionId }) ?? breakdowns.first
    let detailUrlStr = card?.detailUrl ?? meta?.detailUrl

    let statusText: String = {
      if !vm.daemonOnline { return "后台未启动" }
      if !vm.masterEnabled { return "全局暂停" }
      if !enabled { return "已关闭" }
      if meta?.ok == false { return card?.statusText ?? "同步异常" }
      return card?.statusText ?? "已同步"
    }()

    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        // Card 1: Plugin Header & Metadata
        SettingsGroupCard {
          HStack(spacing: 10) {
            ToolGlyph.iconView(for: key, sfSymbolOverride: vm.toolIconSymbol(for: key), size: 20)
              .foregroundColor(enabled && vm.masterEnabled ? vm.toolAccentColor(for: key) : .secondary)
              .frame(width: 24, height: 24)

            Text(vm.displayTitle(for: key))
              .font(.system(size: 14.5, weight: .semibold))
              .foregroundColor(enabled && vm.masterEnabled ? .primary : .secondary)

            Spacer()

            Button {
              vm.reloadExternalProviders()
            } label: {
              Image(systemName: "arrow.clockwise")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
            }
            .buttonStyle(.borderless)
            .help("刷新插件数据")

            Toggle("", isOn: Binding(
              get: { enabled && vm.isActiveOverall },
              set: { vm.setToolEnabled(key, enabled: $0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .controlSize(.small)
            .disabled(vm.busy || vm.runtime.runningFromDmg)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 11)

          VStack(spacing: 0) {
            Divider().padding(.leading, 14)

            HStack(spacing: 8) {
              Text("状态")
                .font(.system(size: 12.5))
              Spacer()
              if let rawUrl = detailUrlStr, let url = URL(string: rawUrl) {
                Button("打开控制台") {
                  NSWorkspace.shared.open(url)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
              }
              Text(statusText)
                .font(.system(size: 12.5))
                .foregroundColor(
                  !enabled || !vm.masterEnabled
                    ? .secondary
                    : (meta?.ok == false ? .orange : .secondary)
                )
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            Divider().padding(.leading, 14)
            HStack(spacing: 8) {
              Text("状态栏显示")
                .font(.system(size: 12.5))
              Spacer()
              let pinned = vm.menuBarProvider == key
              if pinned {
                Text(vm.menuBarDisplayMode.title)
                  .font(.system(size: 12))
                  .foregroundColor(.secondary)
              }
              Menu {
                Button("剩余金额（如 \(curSym)1085）") { vm.pinProviderToMenuBar(key, mode: .remainingAmount) }
                Button("剩余百分比") { vm.pinProviderToMenuBar(key, mode: .quotaRemaining) }
                Button("百分比 + 剩余金额") { vm.pinProviderToMenuBar(key, mode: .quotaAndAmount) }
                Button("仅图标（进度条）") { vm.pinProviderToMenuBar(key, mode: .iconOnly) }
                if pinned {
                  Divider()
                  Button("取消固定（自动）") { vm.pinProviderToMenuBar(key, mode: nil) }
                }
              } label: {
                Text(pinned ? "更改…" : "固定到状态栏…")
              }
              .menuStyle(.borderlessButton)
              .fixedSize()
              .font(.system(size: 12))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            if let auth = meta?.auth, auth.isWebCookie {
              Divider().padding(.leading, 14)
              HStack(spacing: 8) {
                Text("登录授权")
                  .font(.system(size: 12.5))
                Spacer()
                Text(meta?.hasCredentials == true ? "已授权" : "未授权")
                  .font(.system(size: 12))
                  .foregroundColor(meta?.hasCredentials == true ? .secondary : .orange)
                Button(meta?.hasCredentials == true ? "重新登录…" : auth.displayLabel + "…") {
                  vm.startPluginLogin(key)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.mini)
                .tint(CodexBarPalette.accentBlue)
                if meta?.hasCredentials == true {
                  Button("退出登录") {
                    vm.clearPluginCredentials(key)
                  }
                  .buttonStyle(.borderless)
                  .font(.system(size: 12))
                  .foregroundColor(.red)
                }
              }
              .padding(.horizontal, 14)
              .padding(.vertical, 10)
            }

            if let fileName = meta?.fileName {
              Divider().padding(.leading, 14)
              HStack(spacing: 8) {
                Text("插件脚本")
                  .font(.system(size: 12.5))
                Spacer()
                Text(fileName)
                  .font(.system(size: 12, design: .monospaced))
                  .foregroundColor(.secondary)
                  .lineLimit(1)
                Button("替换…") {
                  vm.pickAndImportPluginFiles(targetFileName: fileName)
                }
                .buttonStyle(.borderless)
                .font(.system(size: 12))
                .foregroundColor(CodexBarPalette.accentBlue)
                Button("目录") {
                  vm.openProvidersFolder()
                }
                .buttonStyle(.borderless)
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                if meta != nil {
                  Button("移除") {
                    showRemoveConfirm = true
                  }
                  .buttonStyle(.borderless)
                  .font(.system(size: 12))
                  .foregroundColor(.red)
                }
              }
              .padding(.horizontal, 14)
              .padding(.vertical, 10)
            }

            if card?.accountEmail != nil || card?.planTitle != nil {
              Divider().padding(.leading, 14)
              settingsKVRow(
                title: "账户",
                value: [card?.accountEmail, card?.planTitle].compactMap { $0 }.joined(separator: " · ")
              )
            }
          }
          .opacity(isDimmed ? 0.42 : 1.0)
          .disabled(isDimmed)
        }

        // Card 2: Quota Windows & Billing Totals
        VStack(alignment: .leading, spacing: 8) {
          Text("额度与消耗")
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundColor(.secondary)
            .padding(.horizontal, 2)

          SettingsGroupCard {
            if !windows.isEmpty {
              ForEach(Array(windows.enumerated()), id: \.element.id) { idx, win in
                if idx > 0 { Divider().padding(.leading, 14) }
                externalQuotaRow(win: win)
              }
              Divider().padding(.leading, 14)
            } else if let hint = card?.quotaHint ?? meta?.error, !hint.isEmpty {
              HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                  .foregroundColor(.orange)
                  .font(.system(size: 12))
                Text(hint)
                  .font(.system(size: 12))
                  .foregroundColor(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
                Spacer()
              }
              .padding(.horizontal, 14)
              .padding(.vertical, 11)
              Divider().padding(.leading, 14)
            }

            let b = card?.billingSummary
            let periodLabel = b?.periodLabel ?? "本月"
            if let rem = b?.periodRemaining {
              settingsKVRow(
                title: "\(periodLabel)剩余余额",
                value: MeterFormat.money(rem, symbol: curSym),
                valueColor: .primary
              )
              if let limit = b?.periodLimit, limit > 0 {
                Divider().padding(.leading, 14)
                settingsKVRow(title: "\(periodLabel)限额", value: MeterFormat.money(limit, symbol: curSym))
              }
              Divider().padding(.leading, 14)
              settingsKVRow(
                title: "今日消耗",
                value: MeterFormat.money(b?.todayCost ?? card?.today.costUsd, symbol: curSym)
              )
            } else {
              settingsKVRow(
                title: "今日消耗",
                value: MeterFormat.money(b?.todayCost ?? card?.today.costUsd, symbol: curSym)
              )
              Divider().padding(.leading, 14)
              settingsKVRow(
                title: "\(periodLabel)已用",
                value: MeterFormat.money(b?.periodCost ?? card?.days30.costUsd, symbol: curSym)
              )
              if let limit = b?.periodLimit, limit > 0 {
                Divider().padding(.leading, 14)
                settingsKVRow(title: "\(periodLabel)限额", value: MeterFormat.money(limit, symbol: curSym))
              }
            }
          }
        }
        .opacity(isDimmed ? 0.42 : 1.0)
        .disabled(isDimmed)

        // Card 3: Daily Trend Chart
        if let daily = card?.daily30, !daily.isEmpty {
          let maxVal = max(0.000001, daily.map { max(0, $0.costUsd ?? 0) }.max() ?? 0)
          let peakDate = daily.max(by: { ($0.costUsd ?? 0) < ($1.costUsd ?? 0) })?.date

          VStack(alignment: .leading, spacing: 8) {
            Text("每日消耗趋势")
              .font(.system(size: 12.5, weight: .semibold))
              .foregroundColor(.secondary)
              .padding(.horizontal, 2)

            SettingsGroupCard {
              VStack(alignment: .leading, spacing: 10) {
                HStack {
                  if let pt = hoveredDay {
                    Text("\(pt.date) · \(MeterFormat.money(pt.costUsd, symbol: curSym))")
                      .font(.system(size: 11.5, weight: .medium))
                      .monospacedDigit()
                  } else {
                    let peakCost = daily.compactMap(\.costUsd).max() ?? 0
                    Text("日峰值 \(MeterFormat.money(peakCost, symbol: curSym))")
                      .font(.system(size: 11.5))
                      .monospacedDigit()
                      .foregroundColor(.secondary)
                  }
                  Spacer()
                  Text(card?.footnote ?? "外部数据源插件")
                    .font(.system(size: 10.5))
                    .foregroundColor(.secondary)
                }

                VStack(spacing: 0) {
                  HStack(alignment: .bottom, spacing: 0) {
                    ForEach(daily) { pt in
                      let val = max(0, pt.costUsd ?? 0)
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
                            let w = max(1, geo.size.width)
                            let idx = min(daily.count - 1, max(0, Int((loc.x / w) * CGFloat(daily.count))))
                            let target = daily[idx]
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
                  if let first = daily.first { Text(MeterFormat.shortDate(first.date)) }
                  Spacer()
                  if let last = daily.last { Text(MeterFormat.shortDate(last.date)) }
                }
                .font(.system(size: 10))
                .foregroundColor(.secondary)
              }
              .padding(14)
            }
          }
          .opacity(isDimmed ? 0.42 : 1.0)
          .disabled(isDimmed)
        }

        // Card 4: Breakdowns (Products / Groups / Models)
        if !breakdowns.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Text("消耗明细")
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundColor(.secondary)
              Spacer()
              if breakdowns.count > 1 {
                Picker("", selection: Binding(
                  get: { activeSection?.id ?? breakdowns[0].id },
                  set: { selectedSectionId = $0 }
                )) {
                  ForEach(breakdowns) { sec in
                    Text(sec.title).tag(sec.id)
                  }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .frame(width: min(260, CGFloat(breakdowns.count * 96)))
              }
            }
            .padding(.horizontal, 2)

            if let sec = activeSection {
              let maxCost = max(0.0001, sec.items.compactMap(\.cost).max() ?? 0)
              SettingsGroupCard {
                ForEach(Array(sec.items.enumerated()), id: \.element.id) { idx, item in
                  if idx > 0 { Divider().padding(.leading, 14) }
                  let barFrac: Double = {
                    if let pct = item.usagePct, item.limit != nil {
                      return min(1.0, max(0.0, pct / 100.0))
                    }
                    if let share = item.sharePct {
                      return min(1.0, max(0.0, share / 100.0))
                    }
                    if let cost = item.cost, maxCost > 0 {
                      return min(1.0, max(0.0, cost / maxCost))
                    }
                    return 0
                  }()

                  VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                      Text(item.name)
                        .font(.system(size: 12.5, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                      Spacer(minLength: 6)
                      if let share = item.sharePct {
                        Text("\(String(format: "%.1f", share))%")
                          .font(.system(size: 11))
                          .monospacedDigit()
                          .foregroundColor(.secondary)
                      }
                      if let limit = item.limit, limit > 0 {
                        Text("\(MeterFormat.money(item.cost, symbol: curSym)) / \(MeterFormat.money(limit, symbol: curSym))")
                          .font(.system(size: 12, weight: .semibold))
                          .monospacedDigit()
                      } else if let cost = item.cost {
                        Text(MeterFormat.money(cost, symbol: curSym))
                          .font(.system(size: 12, weight: .semibold))
                          .monospacedDigit()
                      }
                    }

                    if barFrac > 0 {
                      GeometryReader { geo in
                        ZStack(alignment: .leading) {
                          Capsule().fill(Color.primary.opacity(0.08))
                          Capsule()
                            .fill((item.usagePct ?? 0) >= 90 && item.limit != nil ? Color.red.opacity(0.85) : CodexBarPalette.tealBar)
                            .frame(width: max(4, geo.size.width * CGFloat(barFrac)))
                        }
                      }
                      .frame(height: 4)
                    }

                    if let sub = item.subtitle, !sub.isEmpty {
                      Text(sub)
                        .font(.system(size: 10.5))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                    }
                  }
                  .padding(.horizontal, 14)
                  .padding(.vertical, 10)
                }
              }
            }
          }
          .opacity(isDimmed ? 0.42 : 1.0)
          .disabled(isDimmed)
        }
      }
      .padding(24)
    }
    .alert("确认移除插件？", isPresented: $showRemoveConfirm) {
      Button("取消", role: .cancel) {}
      Button("移除", role: .destructive) {
        if let meta = vm.externalProviderMeta(for: key) {
          vm.removeExternalPlugin(meta)
        }
      }
    } message: {
      Text("将从本机插件目录删除 \(vm.externalProviderMeta(for: key)?.fileName ?? key)，不影响其他数据。")
    }
  }

  private func externalQuotaRow(win: CardQuotaWindow) -> some View {
    let pct = vm.quotaDisplayMode.displayPct(fromRemaining: win.remainingPct)
    let clamped = min(1.0, max(0.0, pct / 100.0))
    let pctRounded = Int(pct.rounded())

    return VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("\(win.title) \(vm.quotaDisplayMode.verbLabel) \(pctRounded)%")
          .font(.system(size: 12.5, weight: .medium))
          .monospacedDigit()
        Spacer()
        if let resetText = win.resetText, !resetText.isEmpty {
          Text(resetText)
            .font(.system(size: 11.5))
            .monospacedDigit()
            .foregroundColor(.secondary)
        }
      }

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.primary.opacity(0.09))
          if clamped > 0 {
            Capsule()
              .fill(CodexBarPalette.tealBar)
              .frame(width: max(5, geo.size.width * CGFloat(clamped)))
          }
          if let pacePct = vm.quotaDisplayMode.displayPacePct(fromRemainingPace: win.pacePct) {
            let paceFrac = min(1.0, max(0.0, pacePct / 100.0))
            let paceX = min(max(0, geo.size.width - 5.0), max(0, geo.size.width * CGFloat(paceFrac) - 2.5))
            ZStack {
              RoundedRectangle(cornerRadius: 1)
                .fill(Color(nsColor: .controlBackgroundColor))
                .frame(width: 5.0, height: 8)
              RoundedRectangle(cornerRadius: 0.75)
                .fill(CodexBarPalette.paceGreen)
                .frame(width: 2.0, height: 8)
            }
            .offset(x: paceX)
          }
        }
      }
      .frame(height: 6)

      if let sub = win.subtitle, !sub.isEmpty {
        Text(sub)
          .font(.system(size: 11))
          .monospacedDigit()
          .foregroundColor(.secondary)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
  }
}

struct PluginsSettingsPaneView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var isDropTargeted: Bool = false
  @State private var pendingRemove: ExternalProviderMeta? = nil

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        // Drop Zone + Quick Import Actions
        VStack(spacing: 12) {
          Image(systemName: isDropTargeted ? "arrow.down.doc.fill" : "puzzlepiece.extension")
            .font(.system(size: 28, weight: .light))
            .foregroundColor(isDropTargeted ? CodexBarPalette.accentBlue : .secondary)

          VStack(spacing: 3) {
            Text(isDropTargeted ? "松开即可校验并导入插件" : "拖拽 .mjs 插件文件到这里导入")
              .font(.system(size: 13.5, weight: .semibold))
              .foregroundColor(isDropTargeted ? CodexBarPalette.accentBlue : .primary)
            Text("插件自动校验语法后保存在本机用户目录，软件升级不会覆盖，也不会写入公开仓库")
              .font(.system(size: 11.5))
              .foregroundColor(.secondary)
              .multilineTextAlignment(.center)
          }

          HStack(spacing: 10) {
            Button {
              vm.pickAndImportPluginFiles()
            } label: {
              Label("选择 .mjs 文件导入…", systemImage: "folder.badge.plus")
            }
            .buttonStyle(.borderedProminent)
            .tint(CodexBarPalette.accentBlue)
            .controlSize(.regular)
            .disabled(vm.pluginImportBusy)

            Button {
              vm.showPluginCodeSheet = true
            } label: {
              Label("粘贴代码导入…", systemImage: "doc.on.clipboard")
            }
            .buttonStyle(.bordered)
            .controlSize(.regular)
            .disabled(vm.pluginImportBusy)
          }

          HStack(spacing: 14) {
            Button("复制示例模板") {
              vm.copySamplePluginTemplate()
            }
            .buttonStyle(.borderless)
            .font(.system(size: 11.5))
            .foregroundColor(CodexBarPalette.accentBlue)

            Text("·")
              .foregroundColor(.secondary.opacity(0.5))

            Button("在 Finder 中打开插件目录") {
              vm.openProvidersFolder()
            }
            .buttonStyle(.borderless)
            .font(.system(size: 11.5))
            .foregroundColor(.secondary)

            Text("·")
              .foregroundColor(.secondary.opacity(0.5))

            Button("重新扫描") {
              vm.reloadExternalProviders()
            }
            .buttonStyle(.borderless)
            .font(.system(size: 11.5))
            .foregroundColor(.secondary)
          }
          .padding(.top, 2)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
        .padding(.horizontal, 18)
        .background(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(
              isDropTargeted
                ? CodexBarPalette.accentBlue.opacity(0.08)
                : Color(nsColor: .controlBackgroundColor)
            )
        )
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(
              isDropTargeted ? CodexBarPalette.accentBlue : Color.primary.opacity(0.14),
              style: StrokeStyle(lineWidth: isDropTargeted ? 1.5 : 1, dash: [5, 4])
            )
        )
        .onDrop(of: [.fileURL], isTargeted: $isDropTargeted) { providers in
          handleFileDrop(providers)
        }

        // Installed Plugins List
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text("已导入的外部插件（\(vm.externalProviders.count)）")
              .font(.system(size: 12.5, weight: .semibold))
              .foregroundColor(.secondary)
            Spacer()
            Text(vm.providersDir)
              .font(.system(size: 10.5, design: .monospaced))
              .foregroundColor(.secondary.opacity(0.8))
              .lineLimit(1)
              .truncationMode(.middle)
          }
          .padding(.horizontal, 2)

          SettingsGroupCard {
            if vm.externalProviders.isEmpty {
              VStack(spacing: 6) {
                Text("暂无已导入插件")
                  .font(.system(size: 13, weight: .medium))
                  .foregroundColor(.secondary)
                Text("拖入或选择任意符合协议的 .mjs 文件后，即可在顶部菜单栏与「用量」页查看该数据源的额度与账单。")
                  .font(.system(size: 11.5))
                  .foregroundColor(.secondary.opacity(0.85))
                  .multilineTextAlignment(.center)
              }
              .frame(maxWidth: .infinity)
              .padding(.vertical, 26)
              .padding(.horizontal, 18)
            } else {
              ForEach(Array(vm.externalProviders.enumerated()), id: \.element.id) { idx, meta in
                if idx > 0 { Divider().padding(.leading, 14) }
                let enabled = vm.isToolEnabled(meta.key)
                let card = vm.usageData?.cards?[meta.key]
                let sym = card?.resolvedCurrencySymbol ?? meta.currencySymbol ?? "$"
                let firstWin = card?.quotaWindows?.first

                HStack(spacing: 10) {
                  ToolGlyph.iconView(for: meta.key, sfSymbolOverride: meta.icon, size: 18)
                    .foregroundColor(enabled ? vm.toolAccentColor(for: meta.key) : .secondary)
                    .frame(width: 24, height: 24)

                  VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                      Text(meta.name)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(enabled ? .primary : .secondary)
                      if let cur = meta.currency, !cur.isEmpty {
                        Text(cur)
                          .font(.system(size: 9.5, weight: .medium))
                          .foregroundColor(.secondary)
                          .padding(.horizontal, 5)
                          .padding(.vertical, 1)
                          .background(Color.primary.opacity(0.06))
                          .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                      }
                      if meta.ok == false {
                        Text("异常")
                          .font(.system(size: 9.5, weight: .medium))
                          .foregroundColor(.orange)
                      }
                    }

                    let subText: String = {
                      if let err = meta.error, !err.isEmpty { return err }
                      if let win = firstWin {
                        let pct = Int(vm.quotaDisplayMode.displayPct(fromRemaining: win.remainingPct).rounded())
                        let costStr = (card?.billingSummary?.periodCost ?? card?.days30.costUsd)
                          .map { " · \(MeterFormat.money($0, symbol: sym))" } ?? ""
                        return "\(win.title) \(vm.quotaDisplayMode.verbLabel) \(pct)%\(costStr)"
                      }
                      return meta.fileName ?? meta.key
                    }()
                    Text(subText)
                      .font(.system(size: 11))
                      .foregroundColor(meta.ok == false ? .orange : .secondary)
                      .lineLimit(1)
                      .truncationMode(.tail)
                  }

                  Spacer(minLength: 8)

                  Button("详情") {
                    vm.openSettingsPane(.provider(meta.key))
                  }
                  .buttonStyle(.bordered)
                  .controlSize(.mini)

                  if let fileName = meta.fileName {
                    Button("替换") {
                      vm.pickAndImportPluginFiles(targetFileName: fileName)
                    }
                    .buttonStyle(.borderless)
                    .font(.system(size: 11.5))
                    .foregroundColor(CodexBarPalette.accentBlue)
                  }

                  Button {
                    pendingRemove = meta
                  } label: {
                    Image(systemName: "trash")
                      .font(.system(size: 11.5))
                      .foregroundColor(.secondary)
                  }
                  .buttonStyle(.borderless)
                  .help("移除插件")

                  Toggle("", isOn: Binding(
                    get: { enabled && vm.isActiveOverall },
                    set: { vm.setToolEnabled(meta.key, enabled: $0) }
                  ))
                  .toggleStyle(.switch)
                  .labelsHidden()
                  .controlSize(.small)
                  .disabled(vm.busy || vm.runtime.runningFromDmg)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
              }
            }
          }
        }
      }
      .padding(24)
    }
    .alert(
      "确认移除插件？",
      isPresented: Binding(
        get: { pendingRemove != nil },
        set: { if !$0 { pendingRemove = nil } }
      )
    ) {
      Button("取消", role: .cancel) { pendingRemove = nil }
      Button("移除", role: .destructive) {
        if let meta = pendingRemove {
          vm.removeExternalPlugin(meta)
        }
        pendingRemove = nil
      }
    } message: {
      Text("将从本机插件目录删除 \(pendingRemove?.fileName ?? "")，可随时重新导入。")
    }
  }

  private func handleFileDrop(_ providers: [NSItemProvider]) -> Bool {
    var matchedAny = false
    let group = DispatchGroup()
    var urls: [URL] = []
    let lock = NSLock()

    for item in providers where item.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      matchedAny = true
      group.enter()
      item.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { data, _ in
        defer { group.leave() }
        var resolved: URL? = nil
        if let urlData = data as? Data {
          resolved = URL(dataRepresentation: urlData, relativeTo: nil)
        } else if let url = data as? URL {
          resolved = url
        } else if let str = data as? String {
          resolved = URL(string: str)
        }
        if let u = resolved, u.isFileURL {
          lock.lock()
          urls.append(u)
          lock.unlock()
        }
      }
    }

    if matchedAny {
      group.notify(queue: .main) {
        vm.importPluginFileURLs(urls)
      }
    }
    return matchedAny
  }
}

struct PluginCodeImportSheetView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var fileName: String = "my-provider.mjs"
  @State private var sourceCode: String = ""
  @State private var errorMsg: String? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("粘贴代码导入外部插件")
          .font(.headline)
        Spacer()
        Button("从剪贴板粘贴") {
          if let text = NSPasteboard.general.string(forType: .string), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            sourceCode = text
            errorMsg = nil
          }
        }
        .controlSize(.small)
        Button("填入示例模板") {
          sourceCode = MeterViewModel.samplePluginTemplate
          errorMsg = nil
        }
        .controlSize(.small)
      }

      HStack(spacing: 8) {
        Text("文件名")
          .font(.system(size: 12.5))
          .foregroundColor(.secondary)
        TextField("my-provider.mjs", text: $fileName)
          .textFieldStyle(.roundedBorder)
          .font(.system(size: 12, design: .monospaced))
      }

      TextEditor(text: $sourceCode)
        .font(.system(size: 11.5, design: .monospaced))
        .frame(height: 260)
        .padding(4)
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(Color.primary.opacity(0.12), lineWidth: 1)
        )

      if let err = errorMsg, !err.isEmpty {
        HStack(spacing: 6) {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundColor(.orange)
            .font(.system(size: 11.5))
          Text(err)
            .font(.system(size: 11.5))
            .foregroundColor(.orange)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      HStack {
        Text("导入前会自动检查 ESM 语法与 fetch(ctx) 导出")
          .font(.system(size: 11))
          .foregroundColor(.secondary)
        Spacer()
        Button("取消") {
          vm.showPluginCodeSheet = false
        }
        Button(vm.pluginImportBusy ? "校验中…" : "校验并导入") {
          errorMsg = nil
          vm.importPlugin(fileName: fileName, content: sourceCode, navigateToImported: true) { ok, err in
            if ok {
              vm.showPluginCodeSheet = false
            } else {
              errorMsg = err ?? "导入失败"
            }
          }
        }
        .buttonStyle(.borderedProminent)
        .tint(CodexBarPalette.accentBlue)
        .disabled(
          vm.pluginImportBusy ||
          fileName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
          sourceCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
      }
    }
    .padding(18)
    .frame(width: 560)
  }
}

struct GeneralSettingsPaneView: View {
  @ObservedObject var vm: MeterViewModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        SettingsGroupCard {
          settingsControlRow(title: "开启采集与显示") {
            Toggle("", isOn: Binding(
              get: { vm.masterEnabled },
              set: { vm.setMasterEnabled($0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .disabled(vm.busy || vm.runtime.runningFromDmg)
          }

          Divider().padding(.leading, 14)
          settingsControlRow(title: "软件内置 TPS 显示") {
            Toggle("", isOn: Binding(
              get: { vm.inlineMasterEnabled },
              set: { vm.setInlineMasterEnabled($0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .disabled(!vm.masterEnabled || vm.busy || vm.runtime.runningFromDmg)
          }

          Divider().padding(.leading, 14)
          settingsControlRow(title: "开机自动启动") {
            Toggle("", isOn: Binding(
              get: { vm.launchAtLogin },
              set: { vm.setLaunchAtLogin($0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .disabled(vm.busy || vm.runtime.runningFromDmg)
          }

          Divider().padding(.leading, 14)
          settingsControlRow(title: "隐藏程序坞图标") {
            Toggle("", isOn: Binding(
              get: { vm.hideDockIcon },
              set: { vm.setHideDockIcon($0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
          }
        }

        SettingsGroupCard {
          if vm.isActiveOverall && !vm.appsNeedingInlineCdp.isEmpty {
            settingsControlRow(title: "接入消息旁胶囊") {
              Button("全部开启") {
                vm.openAllAppsWithInlineCdp()
              }
              .buttonStyle(.bordered)
              .controlSize(.small)
              .disabled(vm.busy || vm.runtime.runningFromDmg)
            }
            Divider().padding(.leading, 14)
          }

          settingsControlRow(title: "检查更新 (v\(vm.version))") {
            Button("检查…") {
              vm.checkForUpdates()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
          }

          Divider().padding(.leading, 14)
          settingsControlRow(title: "外部数据源插件（\(vm.externalProviders.count) 个）") {
            HStack(spacing: 6) {
              Button("导入插件…") {
                vm.pickAndImportPluginFiles()
              }
              .buttonStyle(.borderedProminent)
              .tint(CodexBarPalette.accentBlue)
              .controlSize(.small)
              .disabled(vm.pluginImportBusy)

              Button("管理…") {
                vm.openSettingsPane(.plugins)
              }
              .buttonStyle(.bordered)
              .controlSize(.small)
            }
          }

          Divider().padding(.leading, 14)
          settingsControlRow(title: "同步扩展与后台配置") {
            Button("重新同步") {
              vm.runAction(args: ["install"], successText: "已重新同步全部配置")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(vm.busy || vm.runtime.runningFromDmg)
          }

          Divider().padding(.leading, 14)
          settingsControlRow(title: "卸载本地配置") {
            Button("卸载…", role: .destructive) {
              vm.showUninstallAlert = true
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(vm.busy)
          }
        }
      }
      .padding(24)
    }
  }
}

struct MenuBarSettingsPaneView: View {
  @ObservedObject var vm: MeterViewModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        SettingsGroupCard {
          settingsControlRow(title: "显示顶部菜单栏图标") {
            Toggle("", isOn: Binding(
              get: { vm.showMenuBarExtra },
              set: { vm.setShowMenuBarExtra($0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
          }

          if vm.showMenuBarExtra {
            Divider().padding(.leading, 14)
            settingsControlRow(title: "展示软件") {
              Picker("", selection: Binding(
                get: { vm.menuBarProvider },
                set: { vm.setMenuBarProvider($0) }
              )) {
                Text("自动（默认）").tag("auto")
                ForEach(vm.allQuotaProviderKeys, id: \.self) { key in
                  Text(vm.toolShortTitle(for: key)).tag(key)
                }
              }
              .labelsHidden()
              .frame(width: 160)
              .controlSize(.small)
            }
            Divider().padding(.leading, 14)
            settingsControlRow(title: "菜单栏图标") {
              Picker("", selection: Binding(
                get: { vm.menuBarIconStyle },
                set: { vm.setMenuBarIconStyle($0) }
              )) {
                ForEach(MenuBarIconStyle.allCases, id: \.self) { s in
                  Text(s.title).tag(s)
                }
              }
              .labelsHidden()
              .frame(width: 160)
              .controlSize(.small)
            }
            Divider().padding(.leading, 14)
            settingsControlRow(title: "菜单栏文本") {
              Picker("", selection: Binding(
                get: { vm.menuBarDisplayMode },
                set: { vm.setMenuBarDisplayMode($0) }
              )) {
                ForEach(MenuBarDisplayMode.allCases, id: \.self) { m in
                  Text(m.title).tag(m)
                }
              }
              .labelsHidden()
              .frame(width: 160)
              .controlSize(.small)
            }
            if vm.menuBarDisplayMode == .todayCost || vm.menuBarDisplayMode == .todayTokensAndCost {
              Divider().padding(.leading, 14)
              settingsControlRow(title: "用量与费用范围") {
                Picker("", selection: Binding(
                  get: { vm.menuBarUsageScope },
                  set: { vm.setMenuBarUsageScope($0) }
                )) {
                  ForEach(MenuBarUsageScope.allCases, id: \.self) { sc in
                    Text(sc.title).tag(sc)
                  }
                }
                .labelsHidden()
                .frame(width: 160)
                .controlSize(.small)
              }
            }
          }

          Divider().padding(.leading, 14)
          settingsControlRow(title: "配额展示方式") {
            Picker("", selection: Binding(
              get: { vm.quotaDisplayMode },
              set: { vm.setQuotaDisplayMode($0) }
            )) {
              ForEach(QuotaDisplayMode.allCases, id: \.self) { mode in
                Text(mode.title).tag(mode)
              }
            }
            .labelsHidden()
            .frame(width: 160)
            .controlSize(.small)
          }

          Divider().padding(.leading, 14)
          settingsControlRow(title: "在菜单卡片中显示「最近窗口」") {
            Toggle("", isOn: Binding(
              get: { vm.showRecentWindowsInMenu },
              set: { vm.setShowRecentWindowsInMenu($0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
          }
        }
      }
      .padding(24)
    }
  }
}

struct RemoteHooksSettingsPaneView: View {
  @ObservedObject var vm: MeterViewModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        SettingsGroupCard {
          settingsControlRow(title: "Cursor Remote-SSH") {
            Button("配置…") {
              vm.knownSshHosts = MeterRuntime.readSshConfigHosts()
              if vm.sshHost.isEmpty, let first = vm.knownSshHosts.first {
                vm.sshHost = first
              }
              vm.sshApplyStatus = nil
              vm.generateSshSnippet()
              vm.showSshSheet = true
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
          }
        }

        SettingsGroupCard {
          settingsKVRow(title: "守护进程", value: vm.daemonOnline ? "127.0.0.1:\(vm.daemonPort)" : "未运行")
          Divider().padding(.leading, 14)
          settingsKVRow(title: "LaunchAgent", value: vm.launchAgentLoaded ? "已加载" : (vm.launchAgentExists ? "未加载" : "未注册"))
          ForEach(["cursor", "codebuddy"], id: \.self) { key in
            if let ver = vm.vsixVersions[key] {
              Divider().padding(.leading, 14)
              settingsKVRow(title: "\(vm.displayTitle(for: key)) 扩展", value: "v\(ver)")
            }
          }
        }
      }
      .padding(24)
    }
  }
}

struct AboutSettingsPaneView: View {
  @ObservedObject var vm: MeterViewModel

  var body: some View {
    VStack(spacing: 12) {
      Spacer()
      Image(systemName: "gauge.with.dots.needle.67percent")
        .font(.system(size: 34, weight: .medium))
        .foregroundColor(.secondary)
      Text("AI Turn Meter")
        .font(.system(size: 16, weight: .semibold))
      Text("v\(vm.version)")
        .font(.system(size: 12))
        .foregroundColor(.secondary)

      HStack(spacing: 12) {
        Button("检查更新") {
          vm.checkForUpdates()
        }
        .buttonStyle(.bordered)
        .controlSize(.small)

        if let url = URL(string: "https://github.com/shadow-qw/AI-Turn-Meter") {
          Link("GitHub", destination: url)
            .font(.system(size: 12))
        }
      }
      .padding(.top, 4)
      Spacer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(24)
  }
}
