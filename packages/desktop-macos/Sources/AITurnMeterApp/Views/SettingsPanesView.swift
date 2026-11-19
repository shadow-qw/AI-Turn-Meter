import AITurnMeterCore
import AppKit
import SwiftUI

struct ProviderSettingsDetailView: View {
  @ObservedObject var vm: MeterViewModel
  let key: String

  var body: some View {
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
                ForEach(["codex", "cursor", "antigravity", "codebuddy"], id: \.self) { key in
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
