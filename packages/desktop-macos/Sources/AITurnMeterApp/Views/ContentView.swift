import AITurnMeterCore
import AppKit
import SwiftUI

private struct SettingsAppPaneItem: Identifiable {
  let id: String
  let pane: SettingsPane
  let title: String
  let icon: String
}

struct ContentView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var searchText: String = ""
  @State private var hoveredPane: SettingsPane? = nil

  private let appPanes: [SettingsAppPaneItem] = [
    SettingsAppPaneItem(id: "general", pane: .general, title: "通用", icon: "gearshape"),
    SettingsAppPaneItem(id: "usage", pane: .usage, title: "用量", icon: "chart.bar"),
    SettingsAppPaneItem(id: "turns", pane: .turns, title: "轮次", icon: "clock"),
    SettingsAppPaneItem(id: "fingerprint", pane: .fingerprint, title: "降智检测", icon: "checkmark.shield"),
    SettingsAppPaneItem(id: "plugins", pane: .plugins, title: "插件", icon: "puzzlepiece.extension"),
    SettingsAppPaneItem(id: "menubar", pane: .menuBar, title: "菜单栏", icon: "menubar.rectangle"),
    SettingsAppPaneItem(id: "remote", pane: .remote, title: "远程", icon: "network"),
    SettingsAppPaneItem(id: "about", pane: .about, title: "关于", icon: "info.circle"),
  ]

  private var filteredAppPanes: [SettingsAppPaneItem] {
    let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !q.isEmpty else { return appPanes }
    return appPanes.filter { $0.title.lowercased().contains(q) }
  }

  private var providerKeys: [String] {
    let preferred = ["codex", "cursor", "antigravity", "codebuddy"]
    let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !q.isEmpty else { return preferred }
    return preferred.filter {
      vm.toolShortTitle(for: $0).lowercased().contains(q) || vm.displayTitle(for: $0).lowercased().contains(q)
    }
  }

  private var filteredExternalProviders: [ExternalProviderMeta] {
    let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !q.isEmpty else { return vm.externalProviders }
    return vm.externalProviders.filter {
      $0.name.lowercased().contains(q) ||
      $0.shortName.lowercased().contains(q) ||
      $0.key.lowercased().contains(q)
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      if vm.runtime.runningFromDmg {
        HStack(spacing: 10) {
          Image(systemName: "externaldrive.badge.exclamationmark")
            .foregroundColor(.orange)
          Text("请先将「AI Turn Meter.app」拖入「应用程序」")
            .font(.system(size: 12))
          Spacer()
          Button("打开应用程序") { vm.openApplicationsFolder() }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.08))
        Divider()
      }

      if let msg = vm.statusBanner {
        HStack(spacing: 8) {
          Image(systemName: vm.bannerIsError ? "exclamationmark.triangle" : "checkmark.circle")
            .foregroundColor(vm.bannerIsError ? .red : .secondary)
          Text(msg)
            .font(.system(size: 12))
            .lineLimit(1)
          Spacer()
          Button("关闭") { vm.statusBanner = nil }
            .buttonStyle(.plain)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(Color.primary.opacity(0.04))
        Divider()
      }

      HStack(spacing: 0) {
        // Minimal Linear / Apple Notes Sidebar
        VStack(alignment: .leading, spacing: 0) {
          HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
              .font(.system(size: 11))
              .foregroundColor(.secondary)
            TextField("搜索", text: $searchText)
              .textFieldStyle(.plain)
              .font(.system(size: 12))
            if !searchText.isEmpty {
              Button {
                searchText = ""
              } label: {
                Image(systemName: "xmark.circle.fill")
                  .font(.system(size: 11))
                  .foregroundColor(.secondary)
              }
              .buttonStyle(.plain)
            }
          }
          .padding(.horizontal, 8)
          .padding(.vertical, 5)
          .background(Color.primary.opacity(0.05))
          .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
          .padding(.horizontal, 10)
          .padding(.top, 12)
          .padding(.bottom, 10)

          ScrollView {
            VStack(alignment: .leading, spacing: 2) {
              ForEach(filteredAppPanes) { item in
                let isSelected = vm.settingsPane == item.pane
                sidebarRow(pane: item.pane, isSelected: isSelected) {
                  Image(systemName: item.icon)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundColor(isSelected ? .primary : .secondary)
                    .frame(width: 18)
                  Text(item.title)
                    .font(.system(size: 12.5, weight: isSelected ? .medium : .regular))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                  Spacer(minLength: 0)
                }
              }

              if !providerKeys.isEmpty {
                Text("提供商")
                  .font(.system(size: 11, weight: .medium))
                  .foregroundColor(.secondary)
                  .padding(.horizontal, 10)
                  .padding(.top, 14)
                  .padding(.bottom, 4)

                ForEach(providerKeys, id: \.self) { key in
                  let entry = vm.apps[key]
                  let installed = entry?.installed ?? false
                  let enabled = vm.isToolEnabled(key)
                  let isSelected = vm.settingsPane == .provider(key)
                  let dotColor: Color = {
                    if !installed || !enabled || !vm.isActiveOverall { return Color.gray.opacity(0.35) }
                    if entry?.cdpPort == nil { return .orange }
                    return Color(red: 0.20, green: 0.72, blue: 0.42)
                  }()

                  sidebarRow(pane: .provider(key), isSelected: isSelected) {
                    ToolGlyph.iconView(for: key, size: 14)
                      .foregroundColor(installed && enabled && vm.isActiveOverall ? .primary : .secondary.opacity(0.6))
                      .frame(width: 18)
                    Text(vm.toolShortTitle(for: key))
                      .font(.system(size: 12.5, weight: isSelected ? .medium : .regular))
                      .foregroundColor(installed && enabled && vm.isActiveOverall ? .primary : .secondary)
                      .lineLimit(1)
                    Spacer(minLength: 4)
                    Circle()
                      .fill(dotColor)
                      .frame(width: 6, height: 6)
                  }
                }
              }

              if !filteredExternalProviders.isEmpty {
                HStack {
                  Text("外部插件")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.secondary)
                  Spacer()
                  Button {
                    vm.pickAndImportPluginFiles()
                  } label: {
                    Image(systemName: "plus")
                      .font(.system(size: 10.5, weight: .semibold))
                      .foregroundColor(.secondary)
                  }
                  .buttonStyle(.plain)
                  .help("导入 .mjs 插件")
                }
                .padding(.horizontal, 10)
                .padding(.top, 14)
                .padding(.bottom, 4)

                ForEach(filteredExternalProviders) { meta in
                  let enabled = vm.isToolEnabled(meta.key)
                  let isSelected = vm.settingsPane == .provider(meta.key)
                  let dotColor: Color = {
                    if !enabled || !vm.isActiveOverall { return Color.gray.opacity(0.35) }
                    if meta.ok == false { return .orange }
                    return Color(red: 0.20, green: 0.72, blue: 0.42)
                  }()

                  sidebarRow(pane: .provider(meta.key), isSelected: isSelected) {
                    ToolGlyph.iconView(for: meta.key, sfSymbolOverride: meta.icon, size: 14)
                      .foregroundColor(enabled && vm.isActiveOverall ? .primary : .secondary.opacity(0.6))
                      .frame(width: 18)
                    Text(meta.shortName)
                      .font(.system(size: 12.5, weight: isSelected ? .medium : .regular))
                      .foregroundColor(enabled && vm.isActiveOverall ? .primary : .secondary)
                      .lineLimit(1)
                    Spacer(minLength: 4)
                    Circle()
                      .fill(dotColor)
                      .frame(width: 6, height: 6)
                  }
                }
              }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 12)
          }
        }
        .frame(width: 196)
        .background(Color(nsColor: .windowBackgroundColor))

        Divider()

        // Right Detail Area
        Group {
          switch vm.settingsPane {
          case .provider(let key):
            ProviderSettingsDetailView(vm: vm, key: key)
          case .general:
            GeneralSettingsPaneView(vm: vm)
          case .menuBar:
            MenuBarSettingsPaneView(vm: vm)
          case .remote:
            RemoteHooksSettingsPaneView(vm: vm)
          case .about:
            AboutSettingsPaneView(vm: vm)
          case .usage:
            UsageSummaryTabView(vm: vm)
              .padding(16)
          case .turns:
            RecentTurnsTabView(vm: vm)
              .padding(16)
          case .fingerprint:
            FingerprintTabView(vm: vm)
              .padding(16)
          case .plugins:
            PluginsSettingsPaneView(vm: vm)
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .underPageBackgroundColor).opacity(0.30))
      }
    }
    .frame(minWidth: 720, minHeight: 520)
    .onAppear { vm.ensureStarted() }
    .onChange(of: vm.settingsPane) { newPane in
      switch newPane {
      case .usage:
        vm.activeTab = .usage
        vm.fetchUsageSummary()
        if vm.usageGroupMode == "daily" {
          vm.fetchReceipt(silent: true)
        }
      case .turns:
        vm.activeTab = .turns
        vm.fetchRecentTurns()
      case .fingerprint:
        vm.activeTab = .control
        vm.fetchFingerprintOverview()
      default:
        vm.activeTab = .control
      }
    }
    .alert("确认彻底卸载？", isPresented: $vm.showUninstallAlert) {
      Button("取消", role: .cancel) {}
      Button("卸载", role: .destructive) {
        vm.runAction(args: ["uninstall"], successText: "已移除后台服务与扩展")
      }
    } message: {
      Text("将停止后台服务并移除 Hooks 与 IDE 扩展，历史统计库会保留。")
    }
    .sheet(isPresented: $vm.showSshSheet) {
      RemoteSshSheetView(vm: vm)
    }
    .sheet(isPresented: $vm.showCursorLoginSheet) {
      CursorWebLoginSheetView(vm: vm)
    }
    .sheet(isPresented: $vm.showPluginCodeSheet) {
      PluginCodeImportSheetView(vm: vm)
    }
    .sheet(isPresented: $vm.showCursorCookieSheet) {
      VStack(alignment: .leading, spacing: 12) {
        Text("配置 Cursor 会话 Cookie")
          .font(.headline)
        Text("1. 点击下方「网页登录同步…」或浏览器打开 cursor.com/dashboard?tab=usage 完成登录；\n2. 若手动粘贴，请打开开发者工具（⌥⌘I）→ Network，复制任意请求头中的 Cookie（含 WorkosCursorSessionToken）；\n3. 粘贴保存后即可同步 Cursor 套餐剩余额度。")
          .font(.system(size: 12))
          .foregroundColor(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        TextField("WorkosCursorSessionToken=user_...%3A%3AeyJ...", text: $vm.cursorCookieDraft)
          .textFieldStyle(.roundedBorder)
          .font(.system(size: 11.5, design: .monospaced))
        HStack {
          Button("网页登录同步…") {
            vm.showCursorCookieSheet = false
            vm.showCursorLoginSheet = true
          }
          .controlSize(.small)
          if let url = URL(string: "https://cursor.com/dashboard?tab=usage") {
            Button("浏览器打开") { NSWorkspace.shared.open(url) }
              .controlSize(.small)
          }
          if vm.hasCursorCookie {
            Button("清除", role: .destructive) {
              vm.showCursorCookieSheet = false
              vm.saveCursorCookie(nil)
            }
            .controlSize(.small)
          }
          Spacer()
          Button("取消") { vm.showCursorCookieSheet = false }
          Button("保存") {
            let val = vm.cursorCookieDraft
            vm.showCursorCookieSheet = false
            vm.saveCursorCookie(val)
          }
          .buttonStyle(.borderedProminent)
        }
      }
      .padding(18)
      .frame(width: 490)
    }
    .sheet(isPresented: $vm.showUpdateSheet) {
      VStack(alignment: .leading, spacing: 14) {
        Text("检查软件更新")
          .font(.headline)
        Text(vm.updateStatusText)
          .font(.system(size: 12.5))
          .foregroundColor(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        if let info = vm.availableUpdate, !info.notes.isEmpty {
          ScrollView {
            Text(info.notes)
              .font(.system(size: 11.5))
              .foregroundColor(.primary)
              .frame(maxWidth: .infinity, alignment: .leading)
              .textSelection(.enabled)
              .padding(10)
          }
          .frame(maxHeight: 150)
          .background(Color(nsColor: .textBackgroundColor))
          .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .stroke(Color.primary.opacity(0.08), lineWidth: 1)
          )
        }
        HStack {
          if vm.updateChecking || vm.updateDownloading {
            ProgressView().controlSize(.small)
          }
          Spacer()
          if let info = vm.availableUpdate {
            Button("立即更新并重启") { vm.downloadAndOpenUpdate(info) }
              .buttonStyle(.borderedProminent)
              .disabled(vm.updateDownloading)
          }
          Button("关闭") { vm.showUpdateSheet = false }
        }
      }
      .padding(18)
      .frame(width: 460)
    }
  }

  private func sidebarRow<RowContent: View>(
    pane: SettingsPane,
    isSelected: Bool,
    @ViewBuilder content: () -> RowContent
  ) -> some View {
    let isHovered = hoveredPane == pane
    return Button {
      vm.openSettingsPane(pane)
    } label: {
      HStack(spacing: 8) {
        content()
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(isSelected ? Color.primary.opacity(0.08) : (isHovered ? Color.primary.opacity(0.04) : Color.clear))
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { inside in
      if inside { hoveredPane = pane }
      else if hoveredPane == pane { hoveredPane = nil }
    }
  }
}

struct SettingsGroupCard<Content: View>: View {
  let content: Content
  init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  var body: some View {
    VStack(spacing: 0) {
      content
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(Color.primary.opacity(0.08), lineWidth: 1)
    )
  }
}

func settingsKVRow(title: String, value: String, valueColor: Color = .secondary) -> some View {
  HStack {
    Text(title)
      .font(.system(size: 12.5))
      .foregroundColor(.primary)
    Spacer(minLength: 12)
    Text(value)
      .font(.system(size: 12.5))
      .monospacedDigit()
      .foregroundColor(valueColor)
      .lineLimit(1)
      .truncationMode(.middle)
  }
  .padding(.horizontal, 14)
  .padding(.vertical, 10)
}

func settingsControlRow<Accessory: View>(
  title: String,
  @ViewBuilder accessory: () -> Accessory
) -> some View {
  HStack(spacing: 12) {
    Text(title)
      .font(.system(size: 12.5))
      .foregroundColor(.primary)
      .lineLimit(1)
    Spacer(minLength: 12)
    accessory()
  }
  .padding(.horizontal, 14)
  .padding(.vertical, 10)
}
