import AITurnMeterCore
import AppKit
import SwiftUI
import UniformTypeIdentifiers

private struct SettingsAppPaneItem: Identifiable {
  let id: String
  let pane: SettingsPane
  let title: String
  let icon: String
}

private struct ProviderReorderDropDelegate: DropDelegate {
  let targetKey: String
  @Binding var draggingKey: String?
  let onMove: (String, String) -> Void

  func dropEntered(info: DropInfo) {
    guard let source = draggingKey, source != targetKey else { return }
    withAnimation(.easeInOut(duration: 0.16)) {
      onMove(source, targetKey)
    }
  }

  func dropUpdated(info: DropInfo) -> DropProposal? {
    DropProposal(operation: .move)
  }

  func performDrop(info: DropInfo) -> Bool {
    draggingKey = nil
    return true
  }
}

struct ContentView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var searchText: String = ""
  @State private var hoveredPane: SettingsPane? = nil
  @State private var draggingProviderKey: String? = nil

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

  private var isSearching: Bool {
    !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var unifiedProviderKeys: [String] {
    let all = vm.orderedAllProviderKeys
    let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !q.isEmpty else { return all }
    return all.filter { key in
      vm.toolShortTitle(for: key).lowercased().contains(q) ||
      vm.displayTitle(for: key).lowercased().contains(q) ||
      key.lowercased().contains(q)
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

              if !unifiedProviderKeys.isEmpty {
                HStack {
                  Text("提供商")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.secondary)
                  Spacer()
                  if !isSearching {
                    Text("拖动排序")
                      .font(.system(size: 9.5))
                      .foregroundColor(.secondary.opacity(0.6))
                  }
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

                ForEach(unifiedProviderKeys, id: \.self) { key in
                  let isExternal = vm.isExternalProvider(key)
                  let meta = isExternal ? vm.externalProviderMeta(for: key) : nil
                  let entry = isExternal ? nil : vm.apps[key]
                  let card = isExternal ? nil : vm.usageData?.cards?[key]
                  let hasCliActivity = !isExternal && (
                    entry?.latestTurn != nil || (card?.today.turnCount ?? 0) > 0 || (card?.days30.turnCount ?? 0) > 0
                  )
                  let installed = isExternal ? true : ((entry?.installed ?? false) || (key == "claude" && hasCliActivity))
                  let enabled = vm.isToolEnabled(key)
                  let pane = SettingsPane.provider(key)
                  let isSelected = vm.settingsPane == pane
                  let isHovered = hoveredPane == pane
                  let dotColor: Color = {
                    if !installed || !enabled || !vm.isActiveOverall { return Color.gray.opacity(0.35) }
                    if isExternal {
                      return meta?.ok == false ? .orange : Color(red: 0.20, green: 0.72, blue: 0.42)
                    }
                    if key == "claude" {
                      if !vm.claudeQuotaEnabled {
                        return Color(red: 0.20, green: 0.72, blue: 0.42)
                      }
                      let hasQuotaOrAuth = !(card?.quotaWindows ?? []).isEmpty || card?.accountEmail != nil || vm.hasClaudeCookie
                      return (vm.hasUsableClaudeProxy && hasQuotaOrAuth)
                        ? Color(red: 0.20, green: 0.72, blue: 0.42)
                        : .orange
                    }
                    if entry?.cdpPort == nil { return .orange }
                    return Color(red: 0.20, green: 0.72, blue: 0.42)
                  }()

                  let rowView = sidebarRow(pane: pane, isSelected: isSelected) {
                    ToolGlyph.iconView(for: key, sfSymbolOverride: vm.toolIconSymbol(for: key), size: 14)
                      .foregroundColor(installed && enabled && vm.isActiveOverall ? .primary : .secondary.opacity(0.6))
                      .frame(width: 18)
                    Text(vm.toolShortTitle(for: key))
                      .font(.system(size: 12.5, weight: isSelected ? .medium : .regular))
                      .foregroundColor(installed && enabled && vm.isActiveOverall ? .primary : .secondary)
                      .lineLimit(1)
                    Spacer(minLength: 4)
                    if isHovered && !isSearching {
                      Image(systemName: "line.3.horizontal")
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundColor(.secondary.opacity(0.55))
                    }
                    Circle()
                      .fill(dotColor)
                      .frame(width: 6, height: 6)
                  }
                  .opacity(draggingProviderKey == key ? 0.45 : 1.0)

                  if isSearching {
                    rowView
                  } else {
                    rowView
                      .onDrag {
                        draggingProviderKey = key
                        return NSItemProvider(object: key as NSString)
                      }
                      .onDrop(
                        of: [UTType.plainText],
                        delegate: ProviderReorderDropDelegate(
                          targetKey: key,
                          draggingKey: $draggingProviderKey,
                          onMove: { src, dst in
                            vm.moveProvider(from: src, to: dst)
                          }
                        )
                      )
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
    .sheet(item: $vm.activeSheet) { sheet in
      switch sheet {
      case .ssh:
        RemoteSshSheetView(vm: vm)
      case .cursorLogin:
        CursorWebLoginSheetView(vm: vm)
      case .claudeLogin:
        ClaudeWebLoginSheetView(vm: vm)
      case .pluginLogin(let key):
        ExternalProviderLoginSheetView(vm: vm, key: key)
      case .pluginCode:
        PluginCodeImportSheetView(vm: vm)
      case .cursorCookie:
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
              vm.presentSheet(.cursorLogin)
            }
            .controlSize(.small)
            if let url = URL(string: "https://cursor.com/dashboard?tab=usage") {
              Button("浏览器打开") { NSWorkspace.shared.open(url) }
                .controlSize(.small)
            }
            if vm.hasCursorCookie {
              Button("清除", role: .destructive) {
                vm.activeSheet = nil
                vm.saveCursorCookie(nil)
              }
              .controlSize(.small)
            }
            Spacer()
            Button("取消") { vm.activeSheet = nil }
            Button("保存") {
              let val = vm.cursorCookieDraft
              vm.activeSheet = nil
              vm.saveCursorCookie(val)
            }
            .buttonStyle(.borderedProminent)
          }
        }
        .padding(18)
        .frame(width: 490)
      case .claudeCookie:
        VStack(alignment: .leading, spacing: 12) {
          Text("配置 Claude 会话 Cookie")
            .font(.headline)
          Text("1. 优先尝试在「设置 → Claude Desktop」点击「读取本机」或「网页登录同步…」；\n2. 若手动粘贴，请打开 claude.ai/settings/usage 开发者工具（⌥⌘I）→ Network，复制请求头中的 Cookie（含 sessionKey）或仅粘贴 sessionKey 值；\n3. 粘贴保存后即可同步 5 小时与每周套餐剩余额度。")
            .font(.system(size: 12))
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
          TextField("sessionKey=sk-ant-sid01-...", text: $vm.claudeCookieDraft)
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 11.5, design: .monospaced))
          HStack {
            Button("网页登录同步…") {
              vm.presentSheet(.claudeLogin)
            }
            .controlSize(.small)
            if let url = URL(string: "https://claude.ai/settings/usage") {
              Button("浏览器打开") { NSWorkspace.shared.open(url) }
                .controlSize(.small)
            }
            if vm.hasClaudeCookie {
              Button("清除", role: .destructive) {
                vm.activeSheet = nil
                vm.saveClaudeCookie(nil)
              }
              .controlSize(.small)
            }
            Spacer()
            Button("取消") { vm.activeSheet = nil }
            Button("保存") {
              let val = vm.claudeCookieDraft
              vm.activeSheet = nil
              vm.saveClaudeCookie(val)
            }
            .buttonStyle(.borderedProminent)
          }
        }
        .padding(18)
        .frame(width: 490)
      case .claudeProxy:
        VStack(alignment: .leading, spacing: 12) {
          Text("配置 Claude 专用代理")
            .font(.headline)
          Text("所有发往 api.anthropic.com 与 claude.ai 的额度请求及内置网页登录均强制走代理（防暴露真实 IP）；代理不可用或未配置时会直接阻止直连。\n留空可自动继承 ~/.claude/settings.json 的 HTTPS_PROXY 或 macOS 系统代理。")
            .font(.system(size: 12))
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
          HStack(spacing: 6) {
            Text("当前生效：")
              .font(.system(size: 11.5))
              .foregroundColor(.secondary)
            Text(vm.claudeActiveProxySummary)
              .font(.system(size: 11.5, design: .monospaced))
              .foregroundColor(vm.hasUsableClaudeProxy ? .primary : .orange)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          TextField("http://127.0.0.1:17890", text: $vm.claudeProxyDraft)
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 12, design: .monospaced))
          HStack {
            if !vm.claudeProxyUrl.isEmpty {
              Button("清除（恢复自动检测）", role: .destructive) {
                vm.activeSheet = nil
                vm.saveClaudeProxyUrl(nil)
              }
              .controlSize(.small)
            }
            Spacer()
            Button("取消") { vm.activeSheet = nil }
            Button("保存") {
              let val = vm.claudeProxyDraft
              vm.activeSheet = nil
              vm.saveClaudeProxyUrl(val)
            }
            .buttonStyle(.borderedProminent)
          }
        }
        .padding(18)
        .frame(width: 500)
      case .update:
        UpdateSheetView(vm: vm)
      }
    }
  }

  private func sidebarRow<RowContent: View>(
    pane: SettingsPane,
    isSelected: Bool,
    @ViewBuilder content: () -> RowContent
  ) -> some View {
    let isHovered = hoveredPane == pane
    return Button {
      draggingProviderKey = nil
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
      if inside {
        if draggingProviderKey != nil && NSEvent.pressedMouseButtons == 0 {
          draggingProviderKey = nil
        }
        hoveredPane = pane
      } else if hoveredPane == pane {
        hoveredPane = nil
      }
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
