import AITurnMeterCore
import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

enum ActiveMainSheet: Identifiable, Equatable {
  case ssh
  case cursorLogin
  case cursorCookie
  case pluginLogin(String)
  case pluginCode
  case update

  var id: String {
    switch self {
    case .ssh: return "ssh"
    case .cursorLogin: return "cursorLogin"
    case .cursorCookie: return "cursorCookie"
    case .pluginLogin(let key): return "pluginLogin:\(key)"
    case .pluginCode: return "pluginCode"
    case .update: return "update"
    }
  }
}

@MainActor
final class MeterViewModel: ObservableObject {
  nonisolated static let cursorSessionCookieNames: Set<String> = [
    "WorkosCursorSessionToken",
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
    "wos-session",
    "__Secure-wos-session",
    "authjs.session-token",
    "__Secure-authjs.session-token",
  ]

  let runtime = MeterRuntime()
  private let bundleVersion: String? = Bundle.main.bundlePath.hasSuffix(".app")
    ? (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String)
    : nil

  private static func resolveInitialDaemonPort() -> Int {
    if let raw = ProcessInfo.processInfo.environment["AI_TURN_METER_PORT"]?
        .trimmingCharacters(in: .whitespacesAndNewlines),
       let p = Int(raw), (1...65535).contains(p) {
      return p
    }
    return 47831
  }

  private nonisolated static func detectAppAutostartEnabled() -> Bool {
    FileManager.default.fileExists(
      atPath: (NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents/com.local.ai-turn-meter.app.plist")
    )
  }

  private enum PrefKey {
    static let showMenuBarExtra = "aiTurnMeter.showMenuBarExtra"
    static let showMenuBarSummary = "aiTurnMeter.showMenuBarSummary"
    static let menuBarDisplayMode = "atm.menuBarDisplayMode.v3"
    static let menuBarIconStyle = "atm.menuBarIconStyle.v1"
    static let menuBarProvider = "atm.menuBarProvider.v1"
    static let menuBarUsageScope = "atm.menuBarUsageScope.v1"
    static let menuBarCustomConfig = "atm.menuBarCustomConfig.v1"
    static let providerOrder = "atm.providerOrder.v1"
    static let quotaDisplayMode = "atm.quotaDisplayMode.v1"
    static let hideDockIcon = "aiTurnMeter.hideDockIcon"
    static let showRecentWindowsInMenu = "atm.showRecentWindowsInMenu.v2"
    static let receiptCurrencyMode = "atm.receiptCurrencyMode.v1"
    static let receiptUsdToCny = "atm.receiptUsdToCny.v1"
    static let receiptTheme = "atm.receiptTheme.v1"
    static let receiptHideProjects = "atm.receiptHideProjects.v1"
    static let alertsEnabled = "atm.alertsEnabled.v1"
  }

  @Published var version: String = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.2.33"
  @Published var daemonVersion: String? = nil
  @Published var updateFeedUrl: String? = nil
  @Published var daemonOnline: Bool = false
  @Published var daemonPort: Int = MeterViewModel.resolveInitialDaemonPort()
  @Published var launchAgentExists: Bool = false
  @Published var launchAgentLoaded: Bool = false

  @Published var masterEnabled: Bool = true
  @Published var toolToggles: [String: Bool] = [
    "antigravity": true,
    "codex": true,
    "cursor": true,
    "codebuddy": true,
  ]
  @Published var inlineMasterEnabled: Bool = true
  @Published var inlineToolToggles: [String: Bool] = [
    "antigravity": true,
    "codex": true,
    "cursor": true,
    "codebuddy": true,
  ]
  @Published var hasCursorCookie: Bool = false
  @Published var activeSheet: ActiveMainSheet? = nil
  @Published var cursorCookieDraft: String = ""

  var showCursorCookieSheet: Bool {
    get { activeSheet == .cursorCookie }
    set { setSheet(.cursorCookie, presented: newValue) }
  }
  var showCursorLoginSheet: Bool {
    get { activeSheet == .cursorLogin }
    set { setSheet(.cursorLogin, presented: newValue) }
  }
  var showPluginCodeSheet: Bool {
    get { activeSheet == .pluginCode }
    set { setSheet(.pluginCode, presented: newValue) }
  }
  var showSshSheet: Bool {
    get { activeSheet == .ssh }
    set { setSheet(.ssh, presented: newValue) }
  }
  var showUpdateSheet: Bool {
    get { activeSheet == .update }
    set { setSheet(.update, presented: newValue) }
  }
  var pluginLoginKey: String? {
    get {
      if case .pluginLogin(let k) = activeSheet { return k }
      return nil
    }
    set {
      if let k = newValue {
        presentSheet(.pluginLogin(k))
      } else if case .pluginLogin = activeSheet {
        activeSheet = nil
      }
    }
  }

  private func setSheet(_ sheet: ActiveMainSheet, presented: Bool) {
    if presented {
      presentSheet(sheet)
    } else if activeSheet == sheet {
      activeSheet = nil
    }
  }

  func presentSheet(_ target: ActiveMainSheet) {
    if activeSheet == nil {
      activeSheet = target
    } else if activeSheet != target {
      activeSheet = nil
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) { [weak self] in
        self?.activeSheet = target
      }
    }
  }

  private func daemonUrl(_ path: String, query: [(String, String?)] = []) -> URL? {
    var comps = URLComponents()
    comps.scheme = "http"
    comps.host = "127.0.0.1"
    comps.port = daemonPort
    comps.path = path.hasPrefix("/") ? path : "/\(path)"
    let items = query.compactMap { name, val -> URLQueryItem? in
      guard let val = val else { return nil }
      return URLQueryItem(name: name, value: val)
    }
    if !items.isEmpty {
      comps.queryItems = items
    }
    return comps.url
  }

  @Published var showMenuBarExtra: Bool = UserDefaults.standard.object(forKey: PrefKey.showMenuBarExtra) as? Bool ?? true
  @Published var menuBarDisplayMode: MenuBarDisplayMode = {
    if let raw = UserDefaults.standard.string(forKey: PrefKey.menuBarDisplayMode),
       let mode = MenuBarDisplayMode(rawValue: raw) {
      return mode
    }
    return .iconOnly
  }()
  @Published var menuBarIconStyle: MenuBarIconStyle = {
    if let raw = UserDefaults.standard.string(forKey: PrefKey.menuBarIconStyle),
       let style = MenuBarIconStyle(rawValue: raw) {
      return style
    }
    return .dualBar
  }()
  @Published var menuBarProvider: String = {
    let raw = UserDefaults.standard.string(forKey: PrefKey.menuBarProvider) ?? "auto"
    let allowed: Set<String> = ["auto", "codex", "cursor", "antigravity", "codebuddy"]
    if allowed.contains(raw) || raw.hasPrefix("ext:") {
      return raw
    }
    return "auto"
  }()
  @Published var menuBarUsageScope: MenuBarUsageScope = {
    if let raw = UserDefaults.standard.string(forKey: PrefKey.menuBarUsageScope),
       let scope = MenuBarUsageScope(rawValue: raw) {
      return scope
    }
    return .all
  }()
  @Published var quotaDisplayMode: QuotaDisplayMode = {
    if let raw = UserDefaults.standard.string(forKey: PrefKey.quotaDisplayMode),
       let mode = QuotaDisplayMode(rawValue: raw) {
      return mode
    }
    return .remaining
  }()
  @Published var hideDockIcon: Bool = UserDefaults.standard.bool(forKey: PrefKey.hideDockIcon)
  @Published var showRecentWindowsInMenu: Bool = UserDefaults.standard.bool(forKey: PrefKey.showRecentWindowsInMenu)
  @Published var menuBarConfig: MenuBarCustomConfig = MeterViewModel.loadMenuBarConfig()
  @Published var alertsEnabled: Bool = UserDefaults.standard.object(forKey: PrefKey.alertsEnabled) as? Bool ?? true
  @Published var alertDeliveryError: String? = nil
  @Published var launchAtLogin: Bool = MeterViewModel.detectAppAutostartEnabled()

  @Published var settingsPane: SettingsPane = .provider("antigravity")
  @Published var activeTab: MainTab = .control
  @Published var popoverSelection: String = "all" {
    didSet {
      if oldValue != popoverSelection {
        onStateUpdated?()
      }
    }
  }
  @Published var lastSyncedAt: Date? = nil
  @Published var todaySummary: UsageTotals? = nil
  @Published var usageDays: Int = 7
  @Published var usageToolFilter: String = "all"
  @Published var usageGroupMode: String = "model"
  @Published var usageData: UsageSummaryResponse? = nil
  @Published var usageLoading: Bool = false

  // Daily Receipt (Day Card) state
  @Published var receiptData: ReceiptDataResponse? = nil
  @Published var receiptLoading: Bool = false
  @Published var receiptError: String? = nil
  @Published var receiptDate: String = MeterFormat.makeIsoDayFormatter().string(from: Date()) {
    didSet {
      guard !isUpdatingReceiptDateAutomatically else { return }
      isReceiptDateAutoToday = (receiptDate == Self.currentIsoDayString())
    }
  }
  @Published var receiptScope: String = "day"
  @Published var receiptGroupBy: String = "model"
  @Published var receiptCurrencyMode: String = UserDefaults.standard.string(forKey: PrefKey.receiptCurrencyMode) ?? "both"
  @Published var receiptUsdToCny: Double = {
    let v = UserDefaults.standard.double(forKey: PrefKey.receiptUsdToCny)
    return v > 0 ? v : 7.0
  }()
  @Published var receiptTheme: String = UserDefaults.standard.string(forKey: PrefKey.receiptTheme) ?? "paper"
  @Published var receiptHideProjects: Bool = UserDefaults.standard.bool(forKey: PrefKey.receiptHideProjects)
  @Published var receiptPunchlineIndex: Int = 0

  // Model Fingerprint / Degradation Detection state
  @Published var fingerprintOverview: FingerprintOverviewResponse? = nil
  @Published var fingerprintLoading: Bool = false
  @Published var fingerprintRunningAction: String? = nil

  @Published var recentTurns: [TurnSummary] = []
  @Published var recentTurnsFilterTool: String = "all"
  @Published var recentTurnsSearch: String = ""
  @Published var recentTurnsLoading: Bool = false
  @Published var recentTurnsByTool: [String: [TurnSummary]] = [:]

  @Published var apps: [String: StatusAppEntry] = [:]
  @Published var vsixVersions: [String: String] = [:]
  @Published var externalProviders: [ExternalProviderMeta] = []
  @Published var providerOrder: [String] = UserDefaults.standard.stringArray(forKey: PrefKey.providerOrder) ?? ProviderOrder.defaultBuiltIn
  @Published var providersDir: String = (NSHomeDirectory() as NSString).appendingPathComponent(".local/share/ai-turn-meter/providers")
  @Published var pluginImportBusy: Bool = false

  @Published var busy: Bool = false
  @Published var statusBanner: String? = nil
  @Published var bannerIsError: Bool = false
  @Published var showUninstallAlert: Bool = false
  @Published var sshHost: String = ""
  @Published var sshPreview: String = ""
  @Published var sshOneLiner: String = ""
  @Published var sshApplyStatus: String? = nil
  @Published var sshApplyIsError: Bool = false
  @Published var sshApplying: Bool = false
  @Published var knownSshHosts: [String] = []

  @Published var updateChecking: Bool = false
  @Published var updateDownloading: Bool = false
  @Published var updateDownloadProgress: Double? = nil
  @Published var updateStage: UpdateStage = .idle
  @Published var updateErrorDetail: String? = nil
  @Published var updateDownloadedBytes: Int64 = 0
  @Published var updateTotalBytes: Int64 = 0
  @Published var updateSpeedBytesPerSec: Double? = nil
  @Published var availableUpdate: UpdateReleaseInfo? = nil
  @Published var updateStatusText: String = ""

  var onStateUpdated: (() -> Void)?
  var onPreferencesChanged: (() -> Void)?

  private var pollTimer: Timer?
  private let sseClient = DaemonSSEClient()
  private let alertManager = QuotaAlertManager()
  private var sseConnected: Bool = false
  private var sseTurnRefreshWorkItem: DispatchWorkItem?
  private var didBootstrap = false
  private var doctorBootstrapInFlight = false
  private var didTryRestoreWebCookie = false
  private var hasStarted = false
  private var lastUsageRefreshAt: Date = .distantPast
  private var isReceiptDateAutoToday: Bool = true
  private var isUpdatingReceiptDateAutomatically: Bool = false
  private var appsStatusSeq: UInt64 = 0
  private var stateLightSeq: UInt64 = 0
  private var usageFetchSeq: UInt64 = 0
  private var usageInFlightIsForce: Bool = false
  private var usageLastStartedAt: Date = .distantPast
  private var usageLastFilter: String = "all"
  private var usageLastDays: Int = 7
  private var turnsFetchSeq: UInt64 = 0
  private var receiptFetchSeq: UInt64 = 0
  private var fingerprintSeq: UInt64 = 0
  private var sshSnippetSeq: UInt64 = 0
  private var activeUpdateDownloader: UpdateDownloader? = nil

  private static func loadMenuBarConfig() -> MenuBarCustomConfig {
    let defaults = UserDefaults.standard
    if let data = defaults.data(forKey: PrefKey.menuBarCustomConfig),
       var decoded = try? JSONDecoder().decode(MenuBarCustomConfig.self, from: data) {
      decoded.normalize()
      return decoded
    }
    let legacyDisplay: MenuBarDisplayMode = {
      if let raw = defaults.string(forKey: PrefKey.menuBarDisplayMode),
         let mode = MenuBarDisplayMode(rawValue: raw) {
        return mode
      }
      return .iconOnly
    }()
    let legacyProvider = defaults.string(forKey: PrefKey.menuBarProvider) ?? "auto"
    let legacyRecent = defaults.bool(forKey: PrefKey.showRecentWindowsInMenu)
    return MenuBarCustomConfig.migrated(
      displayMode: legacyDisplay,
      provider: legacyProvider,
      showRecentWindows: legacyRecent
    )
  }

  init() {
    if hideDockIcon && !showMenuBarExtra {
      showMenuBarExtra = true
      UserDefaults.standard.set(true, forKey: PrefKey.showMenuBarExtra)
    }
    showRecentWindowsInMenu = menuBarConfig.popoverSections.showRecentWindows
    menuBarProvider = menuBarConfig.selectedProviders.first ?? "auto"
  }

  func isExternalProvider(_ key: String) -> Bool {
    key.hasPrefix("ext:")
  }

  var externalProviderKeys: [String] {
    externalProviders.map(\.key)
  }

  var orderedAllProviderKeys: [String] {
    ProviderOrder.resolve(
      saved: providerOrder,
      available: ProviderOrder.defaultBuiltIn + externalProviderKeys
    )
  }

  var orderedKeys: [String] {
    orderedAllProviderKeys.filter { !isExternalProvider($0) }
  }

  var allQuotaProviderKeys: [String] {
    orderedAllProviderKeys
  }

  func moveProvider(from sourceKey: String, to targetKey: String) {
    let current = orderedAllProviderKeys
    let updated = ProviderOrder.move(order: current, from: sourceKey, to: targetKey)
    guard updated != current else { return }
    providerOrder = updated
    UserDefaults.standard.set(updated, forKey: PrefKey.providerOrder)
    onPreferencesChanged?()
    onStateUpdated?()
  }

  func externalProviderMeta(for key: String) -> ExternalProviderMeta? {
    externalProviders.first(where: { $0.key == key })
  }

  func toolIconSymbol(for key: String) -> String? {
    if let meta = externalProviderMeta(for: key), let icon = meta.icon, !icon.isEmpty {
      return icon
    }
    if let icon = usageData?.cards?[key]?.providerIcon, !icon.isEmpty {
      return icon
    }
    return nil
  }

  func openProvidersFolder() {
    let dir = providersDir.isEmpty
      ? (NSHomeDirectory() as NSString).appendingPathComponent(".local/share/ai-turn-meter/providers")
      : providersDir
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    NSWorkspace.shared.open(URL(fileURLWithPath: dir))
  }

  static let samplePluginTemplate: String = #"""
export default {
  id: 'my-gateway',
  name: 'Custom Token Gateway',
  shortName: 'Gateway',
  icon: 'building.2',
  accentColor: '#1677FF',
  currency: 'CNY',
  detailUrl: 'https://gateway.example.com/dashboard',
  async fetch({ nowMs, helpers }) {
    // Replace with your endpoint & auth logic
    const used = 120.5;
    const limit = 1000;
    return {
      account: 'demo-user',
      planTitle: 'Monthly Plan',
      quotaWindows: [
        {
          id: 'monthly',
          title: '本月额度',
          used,
          limit,
          resetAtMs: nowMs + 15 * 86400 * 1000,
          windowSeconds: 30 * 86400,
        },
      ],
      metrics: {
        todayCost: 12.8,
        periodLabel: '本月',
        periodCost: used,
        periodLimit: limit,
      },
      daily: [],
      breakdowns: [],
    };
  },
};
"""#

  func copySamplePluginTemplate() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(Self.samplePluginTemplate, forType: .string)
    bannerIsError = false
    statusBanner = "已复制外部插件示例模板到剪贴板"
  }

  func pickAndImportPluginFiles(targetFileName: String? = nil) {
    let panel = NSOpenPanel()
    panel.title = targetFileName == nil ? "选择外部数据源插件 (.mjs)" : "选择用于替换 \(targetFileName!) 的插件文件 (.mjs)"
    panel.message = "导入的插件会保存在本机用户目录，升级软件不会被覆盖"
    panel.prompt = "导入"
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = targetFileName == nil
    if let mjsType = UTType(filenameExtension: "mjs") {
      panel.allowedContentTypes = [mjsType]
    }
    guard panel.runModal() == .OK, !panel.urls.isEmpty else { return }
    if let overrideName = targetFileName, let first = panel.urls.first {
      importPluginFileURL(first, overrideFileName: overrideName, navigateToImported: false)
    } else {
      importPluginFileURLs(panel.urls)
    }
  }

  func importPluginFileURLs(_ urls: [URL]) {
    guard !pluginImportBusy else {
      bannerIsError = true
      statusBanner = "正在导入其他插件，请稍候"
      return
    }
    let mjsUrls = urls.filter { $0.pathExtension.lowercased() == "mjs" }
    guard !mjsUrls.isEmpty else {
      bannerIsError = true
      statusBanner = "仅支持导入 .mjs 格式的外部数据源插件"
      return
    }
    if mjsUrls.count == 1 {
      importPluginFileURL(mjsUrls[0], overrideFileName: nil, navigateToImported: true, clearBusyOnFinish: true)
      return
    }
    pluginImportBusy = true
    var remaining = mjsUrls
    var successCount = 0
    var lastError: String? = nil

    func next() {
      guard !remaining.isEmpty else {
        self.pluginImportBusy = false
        if let err = lastError, successCount == 0 {
          self.bannerIsError = true
          self.statusBanner = err
        } else if let err = lastError {
          self.bannerIsError = true
          self.statusBanner = "已导入 \(successCount) 个插件，部分失败：\(err)"
        } else {
          self.bannerIsError = false
          self.statusBanner = "已成功导入 \(successCount) 个外部插件"
        }
        return
      }
      let url = remaining.removeFirst()
      self.importPluginFileURL(
        url,
        overrideFileName: nil,
        navigateToImported: remaining.isEmpty && successCount == 0,
        clearBusyOnFinish: false
      ) { ok, err in
        if ok { successCount += 1 }
        else if let err = err { lastError = err }
        next()
      }
    }
    next()
  }

  private func importPluginFileURL(
    _ fileUrl: URL,
    overrideFileName: String?,
    navigateToImported: Bool,
    clearBusyOnFinish: Bool = true,
    completion: ((Bool, String?) -> Void)? = nil
  ) {
    guard let content = try? String(contentsOf: fileUrl, encoding: .utf8) else {
      let msg = "无法读取文件：\(fileUrl.lastPathComponent)"
      bannerIsError = true
      statusBanner = msg
      if clearBusyOnFinish { pluginImportBusy = false }
      completion?(false, msg)
      return
    }
    let fileName = overrideFileName ?? fileUrl.lastPathComponent
    performImportPlugin(
      fileName: fileName,
      content: content,
      navigateToImported: navigateToImported,
      clearBusyOnFinish: clearBusyOnFinish,
      completion: completion
    )
  }

  func importPlugin(
    fileName: String,
    content: String,
    navigateToImported: Bool = true,
    completion: ((Bool, String?) -> Void)? = nil
  ) {
    guard !pluginImportBusy else {
      completion?(false, "正在导入其他插件，请稍候")
      return
    }
    performImportPlugin(
      fileName: fileName,
      content: content,
      navigateToImported: navigateToImported,
      clearBusyOnFinish: true,
      completion: completion
    )
  }

  private func performImportPlugin(
    fileName: String,
    content: String,
    navigateToImported: Bool,
    clearBusyOnFinish: Bool,
    completion: ((Bool, String?) -> Void)?
  ) {
    guard let url = daemonUrl("/v1/providers/import"),
          let jsonData = try? JSONSerialization.data(withJSONObject: [
            "fileName": fileName,
            "content": content,
          ]) else {
      if clearBusyOnFinish { pluginImportBusy = false }
      completion?(false, "无法构建导入请求")
      return
    }
    pluginImportBusy = true
    bannerIsError = false
    statusBanner = "正在校验并导入插件 \(fileName)…"

    var req = DaemonAuth.authorizedRequest(url: url, method: "POST", timeout: 25)
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = jsonData

    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        if clearBusyOnFinish {
          self.pluginImportBusy = false
        }
        if let err = err {
          let msg = "导入失败：\(err.localizedDescription)"
          self.bannerIsError = true
          self.statusBanner = msg
          completion?(false, msg)
          return
        }
        guard let http = resp as? HTTPURLResponse else {
          let msg = "后台服务无响应"
          self.bannerIsError = true
          self.statusBanner = msg
          completion?(false, msg)
          return
        }
        if http.statusCode == 404 {
          let msg = "当前后台守护进程版本过旧，请先在「通用 → 同步扩展与后台配置」点击重新同步"
          self.bannerIsError = true
          self.statusBanner = msg
          completion?(false, msg)
          return
        }
        struct ImportRes: Decodable {
          let ok: Bool?
          let error: String?
          let imported: ExternalProviderMeta?
          let providersDir: String?
          let providers: [ExternalProviderMeta]?
        }
        let parsed = data.flatMap { try? JSONDecoder().decode(ImportRes.self, from: $0) }
        if http.statusCode == 200, parsed?.ok == true {
          if let dir = parsed?.providersDir, !dir.isEmpty { self.providersDir = dir }
          if let list = parsed?.providers { self.applyExternalProviders(list) }
          let importedName = parsed?.imported?.name ?? fileName
          self.bannerIsError = false
          self.statusBanner = "已导入外部插件：\(importedName)"
          self.fetchAppsStatusHttp(forceRefresh: true)
          self.fetchUsageSummary(silent: false, forceRefresh: true)
          if navigateToImported, let key = parsed?.imported?.key {
            self.openSettingsPane(.provider(key))
          }
          completion?(true, nil)
        } else {
          let msg = parsed?.error ?? "插件校验失败（HTTP \(http.statusCode)）"
          self.bannerIsError = true
          self.statusBanner = msg
          completion?(false, msg)
        }
      }
    }.resume()
  }

  func removeExternalPlugin(_ meta: ExternalProviderMeta) {
    var query: [(String, String?)] = [("key", meta.key)]
    if let fileName = meta.fileName, !fileName.isEmpty {
      query.append(("fileName", fileName))
    }
    guard let url = daemonUrl("/v1/providers", query: query) else { return }
    let req = DaemonAuth.authorizedRequest(url: url, method: "DELETE", timeout: 10)
    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        if let err = err {
          self.bannerIsError = true
          self.statusBanner = "移除插件失败：\(err.localizedDescription)"
          return
        }
        struct RemoveRes: Decodable {
          let ok: Bool?
          let deleted: Bool?
          let error: String?
          let providers: [ExternalProviderMeta]?
        }
        let parsed = data.flatMap { try? JSONDecoder().decode(RemoveRes.self, from: $0) }
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200, parsed?.ok == true else {
          self.bannerIsError = true
          self.statusBanner = parsed?.error ?? "移除插件失败"
          return
        }
        if parsed?.deleted == false {
          self.bannerIsError = true
          self.statusBanner = "移除插件失败（未找到插件文件：\(meta.fileName ?? meta.key)）"
          return
        }
        if let list = parsed?.providers {
          self.applyExternalProviders(list)
        } else {
          self.externalProviders.removeAll(where: { $0.key == meta.key })
        }
        if self.settingsPane == .provider(meta.key) {
          self.settingsPane = .plugins
        }
        if self.popoverSelection == meta.key {
          self.popoverSelection = "all"
        }
        if self.menuBarProvider == meta.key || self.menuBarConfig.selectedProviders.contains(meta.key) {
          self.updateMenuBarConfig { cfg in
            cfg.selectedProviders.removeAll { $0 == meta.key }
          }
        }
        self.bannerIsError = false
        self.statusBanner = "已移除外部插件：\(meta.name)"
        self.fetchAppsStatusHttp(forceRefresh: true)
        self.fetchUsageSummary(silent: true, forceRefresh: true)
      }
    }.resume()
  }

  func startPluginLogin(_ key: String) {
    guard let meta = externalProviderMeta(for: key), meta.auth?.isWebCookie == true else {
      bannerIsError = true
      statusBanner = "该插件未声明网页登录方式"
      return
    }
    pluginLoginKey = key
  }

  func savePluginCredentials(key: String, credentials: [String: Any]) {
    guard let url = daemonUrl("/v1/providers/auth"),
          let body = try? JSONSerialization.data(withJSONObject: ["key": key, "credentials": credentials]) else { return }
    bannerIsError = false
    statusBanner = "已获取登录凭证，正在同步额度…"
    var req = DaemonAuth.authorizedRequest(url: url, method: "POST", timeout: 25)
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = body
    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        struct AuthRes: Decodable {
          let ok: Bool?
          let error: String?
          let provider: ExternalProviderMeta?
          let providers: [ExternalProviderMeta]?
        }
        let http = resp as? HTTPURLResponse
        let parsed = data.flatMap { try? JSONDecoder().decode(AuthRes.self, from: $0) }
        if err == nil, http?.statusCode == 200, parsed?.ok == true {
          if let list = parsed?.providers { self.applyExternalProviders(list) }
          if let prov = parsed?.provider, prov.ok == false {
            self.bannerIsError = true
            self.statusBanner = prov.error ?? "已保存登录凭证，但同步额度失败"
          } else {
            self.bannerIsError = false
            self.statusBanner = "登录授权成功"
          }
          self.fetchAppsStatusHttp(forceRefresh: true)
          self.fetchUsageSummary(silent: false, forceRefresh: true)
        } else {
          self.bannerIsError = true
          self.statusBanner = parsed?.error ?? err?.localizedDescription ?? "保存登录凭证失败"
        }
      }
    }.resume()
  }

  func clearPluginCredentials(_ key: String) {
    guard let url = daemonUrl("/v1/providers/auth", query: [("key", key)]) else { return }
    let req = DaemonAuth.authorizedRequest(url: url, method: "DELETE", timeout: 25)
    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        if let err = err {
          self.bannerIsError = true
          self.statusBanner = "清除登录凭证失败：\(err.localizedDescription)"
          return
        }
        struct Res: Decodable {
          let ok: Bool?
          let error: String?
          let providers: [ExternalProviderMeta]?
        }
        let http = resp as? HTTPURLResponse
        let parsed = data.flatMap { try? JSONDecoder().decode(Res.self, from: $0) }
        guard http?.statusCode == 200, parsed?.ok == true else {
          self.bannerIsError = true
          self.statusBanner = parsed?.error ?? "清除登录凭证失败（HTTP \(http?.statusCode ?? 0)）"
          return
        }
        if let auth = self.externalProviderMeta(for: key)?.auth, auth.isWebCookie {
          let domains = (auth.cookieDomains ?? []).map { $0.lowercased() }
          let store = WKWebsiteDataStore.default().httpCookieStore
          store.getAllCookies { cookies in
            for c in cookies {
              let cd = c.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
              if domains.contains(where: { cd == $0 || cd.hasSuffix("." + $0) }) {
                store.delete(c, completionHandler: nil)
              }
            }
          }
        }
        if let list = parsed?.providers {
          self.applyExternalProviders(list)
        }
        self.bannerIsError = false
        self.statusBanner = "已清除登录凭证"
        self.fetchUsageSummary(silent: true, forceRefresh: true)
      }
    }.resume()
  }

  func reloadExternalProviders() {
    guard let url = daemonUrl("/v1/providers/reload") else { return }
    var req = DaemonAuth.authorizedRequest(url: url, method: "POST", timeout: 25)
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data("{}".utf8)
    statusBanner = "正在重新扫描外部数据源插件…"
    bannerIsError = false

    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        if let err = err {
          self.bannerIsError = true
          self.statusBanner = "重新扫描插件失败：\(err.localizedDescription)"
          return
        }
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
          self.bannerIsError = true
          self.statusBanner = "重新扫描插件失败（后台服务未响应）"
          return
        }
        struct ReloadRes: Decodable {
          let ok: Bool?
          let providersDir: String?
          let providers: [ExternalProviderMeta]?
        }
        if let data = data, let parsed = try? JSONDecoder().decode(ReloadRes.self, from: data) {
          if let dir = parsed.providersDir, !dir.isEmpty { self.providersDir = dir }
          if let list = parsed.providers {
            self.applyExternalProviders(list)
          }
          self.bannerIsError = false
          self.statusBanner = "已重新扫描插件（共 \(self.externalProviders.count) 个）"
        }
        self.fetchAppsStatusHttp(forceRefresh: true)
        self.fetchUsageSummary(silent: false, forceRefresh: true)
      }
    }.resume()
  }

  private func applyExternalProviders(_ list: [ExternalProviderMeta]) {
    self.externalProviders = list
    for p in list {
      if let enabled = p.enabled {
        self.toolToggles[p.key] = enabled
      } else if self.toolToggles[p.key] == nil {
        self.toolToggles[p.key] = true
      }
    }
    if isExternalProvider(popoverSelection) && !list.contains(where: { $0.key == popoverSelection && isToolEnabled($0.key) }) {
      popoverSelection = "all"
    }
    if (isExternalProvider(menuBarProvider) && !list.contains(where: { $0.key == menuBarProvider })) ||
       menuBarConfig.selectedProviders.contains(where: { key in isExternalProvider(key) && !list.contains(where: { $0.key == key }) }) {
      updateMenuBarConfig { cfg in
        cfg.selectedProviders.removeAll { key in isExternalProvider(key) && !list.contains(where: { $0.key == key }) }
      }
    }
    if case .provider(let activeKey) = settingsPane,
       isExternalProvider(activeKey),
       !list.contains(where: { $0.key == activeKey }) {
      settingsPane = .plugins
    }
  }

  var isActiveOverall: Bool {
    daemonOnline && masterEnabled
  }

  var appsNeedingInlineCdp: [String] {
    ["antigravity", "codex", "cursor", "codebuddy"].filter { key in
      guard isToolEnabled(key), let entry = apps[key] else { return false }
      return entry.installed && entry.cdpPort == nil
    }
  }

  func isToolEnabled(_ key: String) -> Bool {
    toolToggles[key] ?? true
  }

  func isInlineToolEnabled(_ key: String) -> Bool {
    inlineToolToggles[key] ?? true
  }

  func setShowMenuBarExtra(_ value: Bool) {
    if !value && hideDockIcon {
      hideDockIcon = false
      UserDefaults.standard.set(false, forKey: PrefKey.hideDockIcon)
      bannerIsError = false
      statusBanner = "关闭菜单栏图标后已自动恢复程序坞图标，以保留打开控制面板的入口"
    }
    showMenuBarExtra = value
    UserDefaults.standard.set(value, forKey: PrefKey.showMenuBarExtra)
    onPreferencesChanged?()
  }

  func updateMenuBarConfig(_ mutate: (inout MenuBarCustomConfig) -> Void) {
    var next = menuBarConfig
    mutate(&next)
    next.normalize()
    if next.items.isEmpty && menuBarIconStyle == .none {
      menuBarIconStyle = .dualBar
      UserDefaults.standard.set(MenuBarIconStyle.dualBar.rawValue, forKey: PrefKey.menuBarIconStyle)
    }
    menuBarConfig = next
    if let data = try? JSONEncoder().encode(next) {
      UserDefaults.standard.set(data, forKey: PrefKey.menuBarCustomConfig)
    }
    let firstProvider = next.selectedProviders.first ?? "auto"
    if menuBarProvider != firstProvider {
      menuBarProvider = firstProvider
      UserDefaults.standard.set(firstProvider, forKey: PrefKey.menuBarProvider)
    }
    if showRecentWindowsInMenu != next.popoverSections.showRecentWindows {
      showRecentWindowsInMenu = next.popoverSections.showRecentWindows
      UserDefaults.standard.set(next.popoverSections.showRecentWindows, forKey: PrefKey.showRecentWindowsInMenu)
    }
    UserDefaults.standard.set(!next.items.isEmpty, forKey: PrefKey.showMenuBarSummary)
    onPreferencesChanged?()
  }

  func applyMenuBarPreset(_ preset: MenuBarPreset) {
    updateMenuBarConfig { cfg in
      cfg.items = preset.items
    }
  }

  func resetMenuBarConfigToDefaults() {
    menuBarIconStyle = .dualBar
    UserDefaults.standard.set(MenuBarIconStyle.dualBar.rawValue, forKey: PrefKey.menuBarIconStyle)
    menuBarUsageScope = .all
    UserDefaults.standard.set(MenuBarUsageScope.all.rawValue, forKey: PrefKey.menuBarUsageScope)
    quotaDisplayMode = .remaining
    UserDefaults.standard.set(QuotaDisplayMode.remaining.rawValue, forKey: PrefKey.quotaDisplayMode)
    updateMenuBarConfig { cfg in
      cfg = MenuBarCustomConfig()
    }
  }

  func buildMenuBarRenderSnapshot(useSampleFallback: Bool = false) -> MenuBarRenderSnapshot {
    let enabledOrdered = orderedAllProviderKeys.filter { isToolEnabled($0) }
    var labels: [String: String] = [:]
    for key in orderedAllProviderKeys {
      labels[key] = (key == "antigravity") ? "AGY" : toolShortTitle(for: key)
    }

    let turnCandidateKeys: [String] = menuBarConfig.selectedProviders.isEmpty
      ? orderedKeys.filter { isToolEnabled($0) }
      : menuBarConfig.selectedProviders.filter { !isExternalProvider($0) && isToolEnabled($0) }
    var bestTurn: (turn: TurnSummary, ts: Double)? = nil
    for key in turnCandidateKeys {
      guard let entry = apps[key],
            (entry.installed || entry.latestTurn != nil),
            let turn = entry.latestTurn else { continue }
      let ts = turn.completedAtMs ?? 0
      if bestTurn == nil || ts > bestTurn!.ts {
        bestTurn = (turn, ts)
      }
    }

    return MenuBarRenderSnapshot(
      isActiveOverall: isActiveOverall,
      orderedProviderKeys: enabledOrdered,
      providerLabels: labels,
      cards: usageData?.cards ?? [:],
      todayFallback: todaySummary,
      latestTurn: bestTurn?.turn,
      useSampleFallback: useSampleFallback
    )
  }

  func formattedMenuBarTitle(useSampleFallback: Bool = false) -> String {
    let snapshot = buildMenuBarRenderSnapshot(useSampleFallback: useSampleFallback)
    return MenuBarFormatter.format(
      config: menuBarConfig,
      usageScope: menuBarUsageScope,
      quotaDisplayMode: quotaDisplayMode,
      snapshot: snapshot
    )
  }

  func setMenuBarDisplayMode(_ mode: MenuBarDisplayMode) {
    menuBarDisplayMode = mode
    UserDefaults.standard.set(mode.rawValue, forKey: PrefKey.menuBarDisplayMode)
    let migrated = MenuBarCustomConfig.migrated(
      displayMode: mode,
      provider: menuBarProvider,
      showRecentWindows: showRecentWindowsInMenu
    )
    updateMenuBarConfig { cfg in
      cfg.items = migrated.items
    }
  }

  func setMenuBarIconStyle(_ style: MenuBarIconStyle) {
    menuBarIconStyle = style
    UserDefaults.standard.set(style.rawValue, forKey: PrefKey.menuBarIconStyle)
    if style == .none && menuBarConfig.items.isEmpty {
      updateMenuBarConfig { cfg in
        cfg.items = [.todayTokens, .todayCost]
      }
      return
    }
    onPreferencesChanged?()
  }

  /// One-click: show this provider in the menu bar with the given text style.
  /// `mode == nil` restores automatic selection.
  func pinProviderToMenuBar(_ key: String, mode: MenuBarDisplayMode?) {
    if !showMenuBarExtra { setShowMenuBarExtra(true) }
    guard let mode = mode else {
      setMenuBarProvider("auto")
      return
    }
    let migrated = MenuBarCustomConfig.migrated(
      displayMode: mode,
      provider: key,
      showRecentWindows: showRecentWindowsInMenu
    )
    updateMenuBarConfig { cfg in
      cfg.selectedProviders = [key]
      cfg.items = migrated.items
    }
    bannerIsError = false
    statusBanner = "已在菜单栏显示 \(toolShortTitle(for: key))"
  }

  func setMenuBarProvider(_ provider: String) {
    updateMenuBarConfig { cfg in
      if provider.isEmpty || provider == "auto" {
        cfg.selectedProviders = []
      } else {
        cfg.selectedProviders = [provider]
      }
    }
  }

  func setMenuBarUsageScope(_ scope: MenuBarUsageScope) {
    menuBarUsageScope = scope
    UserDefaults.standard.set(scope.rawValue, forKey: PrefKey.menuBarUsageScope)
    onPreferencesChanged?()
  }

  func setQuotaDisplayMode(_ mode: QuotaDisplayMode) {
    quotaDisplayMode = mode
    UserDefaults.standard.set(mode.rawValue, forKey: PrefKey.quotaDisplayMode)
    onPreferencesChanged?()
  }

  func setLaunchAtLogin(_ enabled: Bool) {
    guard !busy, !runtime.runningFromDmg else { return }
    let bundlePath = Bundle.main.bundlePath
    let rt = runtime
    busy = true
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var args = ["app-autostart", enabled ? "enable" : "disable", "--json"]
      if bundlePath.hasSuffix(".app") {
        args.append("--app=\(bundlePath)")
      }
      let res = rt.runCli(args, timeoutSec: 8)
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.busy = false
        if res.exitCode == 0 {
          self.launchAtLogin = enabled
          self.bannerIsError = false
          self.statusBanner = enabled ? "已开启开机自动驻留顶部菜单栏" : "已关闭开机自动启动菜单栏"
        } else {
          self.bannerIsError = true
          struct CliErrRes: Decodable { let error: String? }
          let stdoutErr = res.stdout.data(using: .utf8)
            .flatMap { try? JSONDecoder().decode(CliErrRes.self, from: $0) }?
            .error?
            .trimmingCharacters(in: .whitespacesAndNewlines)
          let stderrMsg = res.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
          let msg = (stdoutErr?.isEmpty == false ? stdoutErr! : stderrMsg)
          self.statusBanner = msg.isEmpty ? "设置开机自启失败" : msg
        }
      }
    }
  }

  func setHideDockIcon(_ value: Bool) {
    hideDockIcon = value
    UserDefaults.standard.set(value, forKey: PrefKey.hideDockIcon)
    if value && !showMenuBarExtra {
      showMenuBarExtra = true
      UserDefaults.standard.set(true, forKey: PrefKey.showMenuBarExtra)
    }
    onPreferencesChanged?()
  }

  func setShowRecentWindowsInMenu(_ value: Bool) {
    updateMenuBarConfig { cfg in
      cfg.popoverSections.showRecentWindows = value
    }
  }

  func setAlertsEnabled(_ value: Bool) {
    alertsEnabled = value
    alertManager.enabled = value
    onPreferencesChanged?()
  }

  func openNotificationSettings() {
    if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
      NSWorkspace.shared.open(url)
    }
  }

  private func evaluateAlerts() {
    var names: [String: String] = [:]
    for key in orderedAllProviderKeys {
      names[key] = displayTitle(for: key)
    }
    for key in apps.keys where names[key] == nil {
      names[key] = displayTitle(for: key)
    }
    if let cards = usageData?.cards {
      for key in cards.keys where key != "all" && names[key] == nil {
        names[key] = displayTitle(for: key)
      }
    }
    let enabledTools = Set(orderedAllProviderKeys.filter { isToolEnabled($0) })
    alertManager.evaluate(
      usage: usageData,
      apps: apps,
      displayNames: names,
      masterEnabled: masterEnabled,
      enabledTools: enabledTools
    )
  }

  func openSettingsPane(_ pane: SettingsPane) {
    settingsPane = pane
    switch pane {
    case .usage:
      activeTab = .usage
    case .turns:
      activeTab = .turns
    default:
      activeTab = .control
    }
    if pane == .general {
      alertManager.refreshPermissionStatus()
    }
  }

  func ensureStarted() {
    if !hasStarted {
      start()
    }
  }

  func start() {
    guard !hasStarted else { return }
    hasStarted = true
    alertManager.onDeliveryErrorChanged = { [weak self] err in
      self?.alertDeliveryError = err
    }
    alertManager.enabled = alertsEnabled
    if alertsEnabled {
      alertManager.requestPermissionIfNeeded()
    }
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let hosts = MeterRuntime.readSshConfigHosts()
      DispatchQueue.main.async { [weak self] in
        self?.knownSshHosts = hosts
      }
    }
    configureSSE()
    sseClient.start(port: daemonPort)
    refreshDoctorAndBootstrap()
    fetchUsageSummary(silent: true)
    pollTimer?.invalidate()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 10.0, repeats: true) { [weak self] _ in
      Task { @MainActor [weak self] in
        self?.pollTick()
      }
    }
  }

  func stopPolling() {
    pollTimer?.invalidate()
    pollTimer = nil
    sseTurnRefreshWorkItem?.cancel()
    sseTurnRefreshWorkItem = nil
    activeUpdateDownloader?.cancel()
    activeUpdateDownloader = nil
    sseClient.stop()
    sseConnected = false
    hasStarted = false
  }

  private func configureSSE() {
    sseClient.onConnected = { [weak self] in
      self?.sseConnected = true
    }
    sseClient.onDisconnected = { [weak self] in
      guard let self = self else { return }
      self.sseConnected = false
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
        guard let self = self, !self.busy, !self.sseConnected else { return }
        self.fetchDaemonStateLight()
      }
    }
    sseClient.onEvent = { [weak self] ev in
      guard let self = self else { return }
      if ev.event == "state",
         let data = ev.data.data(using: .utf8),
         let parsed = try? JSONDecoder().decode(DaemonStateResponse.self, from: data) {
        self.daemonOnline = true
        self.applyDaemonState(parsed)
        self.onStateUpdated?()
      } else if ev.event == "turn" {
        self.daemonOnline = true
        self.scheduleSseTurnRefresh()
      }
    }
  }

  private var hasVisibleAppWindow: Bool {
    NSApp.windows.contains { win in
      guard win.isVisible, !win.isMiniaturized, win.alphaValue > 0.01 else { return false }
      let className = NSStringFromClass(type(of: win))
      if className.contains("Popover") {
        return true
      }
      if className.contains("StatusBar") || win.level == .statusBar {
        return false
      }
      if className.contains("ToolTip") {
        return false
      }
      return true
    }
  }

  private func scheduleSseTurnRefresh() {
    sseTurnRefreshWorkItem?.cancel()
    let item = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        guard let self = self else { return }
        let hasVisibleWindow = self.hasVisibleAppWindow
        if (hasVisibleWindow || self.showMenuBarExtra),
           Date().timeIntervalSince(self.usageLastStartedAt) >= 0.6 {
          self.fetchUsageSummary(silent: true)
        }
        if self.activeTab == .turns && hasVisibleWindow {
          self.fetchRecentTurns(silent: true)
        }
        if self.settingsPane == .usage && self.usageGroupMode == "daily" && hasVisibleWindow {
          _ = self.syncReceiptDateForCurrentDayIfNeeded()
          if self.receiptDate == Self.currentIsoDayString() {
            self.fetchReceipt(silent: true)
          }
        }
      }
    }
    sseTurnRefreshWorkItem = item
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: item)
  }

  func pollTick() {
    guard !busy else { return }
    let receiptRolledOver = syncReceiptDateForCurrentDayIfNeeded()
    if receiptRolledOver {
      fetchReceipt(silent: true)
    }
    if hasVisibleAppWindow {
      fetchAppsStatusHttp()
      if Date().timeIntervalSince(lastUsageRefreshAt) >= 30 || receiptRolledOver {
        fetchUsageSummary(silent: true)
      }
      if activeTab == .turns && !sseConnected {
        fetchRecentTurns(silent: true)
      }
    } else if showMenuBarExtra {
      if !sseConnected {
        fetchDaemonStateLight()
      }
      if Date().timeIntervalSince(lastUsageRefreshAt) >= 45 || receiptRolledOver {
        fetchUsageSummary(silent: true)
      }
    }
  }

  func toolAccentColor(for key: String) -> Color {
    if let meta = externalProviderMeta(for: key), let c = CodexBarPalette.color(hex: meta.accentColor) {
      return c
    }
    if let hex = usageData?.cards?[key]?.accentColor, let c = CodexBarPalette.color(hex: hex) {
      return c
    }
    switch key {
    case "antigravity": return Color(red: 0.15, green: 0.45, blue: 0.96)
    case "codex": return Color(red: 0.06, green: 0.72, blue: 0.50)
    case "cursor": return Color(red: 0.96, green: 0.52, blue: 0.14)
    case "codebuddy": return Color(red: 0.56, green: 0.36, blue: 0.96)
    default: return Color(red: 0.05, green: 0.38, blue: 0.92)
    }
  }

  func toolShortTitle(for key: String) -> String {
    if let meta = externalProviderMeta(for: key) { return meta.shortName }
    if let short = usageData?.cards?[key]?.providerShortName, !short.isEmpty { return short }
    switch key {
    case "all": return "概览"
    case "antigravity": return "Antigravity"
    case "codex": return "Codex"
    case "cursor": return "Cursor"
    case "codebuddy": return "CodeBuddy"
    default: return key.hasPrefix("ext:") ? String(key.dropFirst(4)) : key
    }
  }

  func relativeUpdateLabel() -> String {
    guard let d = lastSyncedAt else { return "同步中…" }
    let sec = Int(Date().timeIntervalSince(d))
    if sec < 15 { return "刚刚更新" }
    if sec < 60 { return "\(sec) 秒前更新" }
    return "\(sec / 60) 分钟前更新"
  }

  func displayTitle(for key: String) -> String {
    if let meta = externalProviderMeta(for: key) { return meta.name }
    if let name = usageData?.cards?[key]?.providerName, !name.isEmpty { return name }
    switch key {
    case "antigravity": return "Antigravity"
    case "codex": return "Codex Desktop"
    case "cursor": return "Cursor"
    case "codebuddy": return "CodeBuddy CN"
    default: return key.hasPrefix("ext:") ? String(key.dropFirst(4)) : key
    }
  }

  func appSubtitle(for key: String) -> String {
    guard let entry = apps[key], (entry.installed || entry.latestTurn != nil) else { return "未安装" }
    if !masterEnabled { return "全局已暂停显示" }
    if !isToolEnabled(key) { return "已关闭此软件显示" }

    if let turn = entry.latestTurn, let inline = turn.inlineText {
      let modelStr = (turn.model != nil && turn.model != "unknown") ? "\(turn.model!) · " : ""
      return "\(modelStr)\(inline)"
    }
    if !entry.installed {
      return "CLI 已就绪，等待新对话记录"
    }
    if key == "cursor" || key == "codebuddy" {
      return entry.cdpPort != nil ? "已开启状态栏与消息旁胶囊，等待首轮对话" : "已在右下角状态栏就绪，等待首轮对话"
    }
    if key == "codex" && entry.cdpPort == nil {
      return (entry.running ?? false) ? "正在运行（需点右侧按钮重启一次以显示胶囊）" : "未启动（点右侧按钮即可带统计启动）"
    }
    return "等待新对话记录"
  }

  func inlineBtnLabel(for key: String) -> String {
    let isRunning = apps[key]?.running ?? false
    return isRunning ? "重启并显示在消息旁" : "启动并显示在消息旁"
  }

  func fetchAppsStatusHttp(forceRefresh: Bool = false) {
    guard !busy else { return }
    let query: [(String, String?)] = forceRefresh ? [("refresh", "1")] : []
    guard let url = daemonUrl("/v1/apps", query: query) else { return }
    appsStatusSeq &+= 1
    let seq = appsStatusSeq
    let req = DaemonAuth.authorizedRequest(url: url, method: "GET", timeout: 4)

    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self, self.appsStatusSeq == seq else { return }
        if err != nil {
          self.daemonOnline = false
          self.onStateUpdated?()
          return
        }
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let data = data,
              let parsed = try? JSONDecoder().decode(StatusResponse.self, from: data) else {
          return
        }
        self.applyStatus(parsed)
      }
    }.resume()
  }

  func fetchDaemonStateLight() {
    guard let url = daemonUrl("/v1/state", query: [("limit", "30")]) else { return }
    stateLightSeq &+= 1
    let seq = stateLightSeq
    let req = DaemonAuth.authorizedRequest(url: url, method: "GET", timeout: 2)

    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self, self.stateLightSeq == seq else { return }
        if err != nil {
          self.daemonOnline = false
          self.onStateUpdated?()
          return
        }
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let data = data,
              let parsed = try? JSONDecoder().decode(DaemonStateResponse.self, from: data) else {
          return
        }
        self.daemonOnline = true
        self.applyDaemonState(parsed)
        self.onStateUpdated?()
      }
    }.resume()
  }

  private func updateRecentTurnsCache(_ recent: [TurnSummary]?) {
    guard let recent = recent else { return }
    var grouped: [String: [TurnSummary]] = [:]
    for t in recent {
      guard let tool = t.tool else { continue }
      var arr = grouped[tool] ?? []
      if arr.count < 3 {
        arr.append(t)
        grouped[tool] = arr
      }
    }
    self.recentTurnsByTool = grouped
  }

  private func applyDaemonConfig(_ cfg: MeterConfigPayload) {
    self.masterEnabled = cfg.enabled
    for (k, v) in cfg.tools { self.toolToggles[k] = v }
    if self.popoverSelection != "all" && !self.isToolEnabled(self.popoverSelection) {
      self.popoverSelection = "all"
    }
    if let ie = cfg.inlineEnabled { self.inlineMasterEnabled = ie }
    if let it = cfg.inlineTools {
      for (k, v) in it { self.inlineToolToggles[k] = v }
    }
    if let hasCookie = cfg.hasCursorCookie {
      self.hasCursorCookie = hasCookie
      if !hasCookie && !didTryRestoreWebCookie && !busy && !runtime.runningFromDmg {
        didTryRestoreWebCookie = true
        restoreCursorWebCookieIfPresent()
      }
    }
  }

  private func applyDaemonState(_ parsed: DaemonStateResponse) {
    self.lastSyncedAt = Date()
    if let cfg = parsed.config {
      applyDaemonConfig(cfg)
    }
    if let today = parsed.todaySummary {
      let prevTurns = self.todaySummary?.turnCount ?? -1
      self.todaySummary = today
      if (today.turnCount != prevTurns || self.usageData == nil),
         !self.usageInFlightIsForce,
         Date().timeIntervalSince(self.usageLastStartedAt) >= 0.6 {
        self.fetchUsageSummary(silent: true)
      }
    }
    updateRecentTurnsCache(parsed.recent)
    if let byTool = parsed.byTool {
      var nextApps = self.apps
      for (k, maybeTurn) in byTool {
        if let existing = nextApps[k] {
          nextApps[k] = StatusAppEntry(
            name: existing.name,
            appPath: existing.appPath,
            installed: existing.installed,
            running: existing.running,
            cdpPort: existing.cdpPort,
            latestTurn: maybeTurn
          )
        } else {
          nextApps[k] = StatusAppEntry(
            name: self.displayTitle(for: k),
            appPath: nil,
            installed: maybeTurn != nil,
            running: nil,
            cdpPort: nil,
            latestTurn: maybeTurn
          )
        }
      }
      self.apps = nextApps
    }
    self.evaluateAlerts()
  }

  func fetchUsageSummary(silent: Bool = false, forceRefresh: Bool = false) {
    let toolFilter = usageToolFilter
    let days = usageDays
    if !forceRefresh {
      if usageInFlightIsForce {
        return
      }
      if silent && days == usageLastDays && toolFilter == usageLastFilter && Date().timeIntervalSince(usageLastStartedAt) < 0.5 && usageLoading {
        return
      }
    }
    var query: [(String, String?)] = [("days", "\(days)")]
    if toolFilter != "all" { query.append(("tool", toolFilter)) }
    if forceRefresh { query.append(("refresh", "1")) }
    guard let url = daemonUrl("/v1/usage", query: query) else { return }
    usageFetchSeq &+= 1
    let seq = usageFetchSeq
    usageInFlightIsForce = forceRefresh
    usageLastStartedAt = Date()
    usageLastFilter = toolFilter
    usageLastDays = days
    if !silent { usageLoading = true }
    let req = DaemonAuth.authorizedRequest(url: url, method: "GET", timeout: 20)

    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, _ in
      DispatchQueue.main.async { [weak self] in
        guard let self = self, self.usageFetchSeq == seq else { return }
        self.usageLoading = false
        self.usageInFlightIsForce = false
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let data = data,
              let parsed = try? JSONDecoder().decode(UsageSummaryResponse.self, from: data) else {
          return
        }
        self.usageData = parsed
        if let dir = parsed.providersDir, !dir.isEmpty {
          self.providersDir = dir
        }
        if let extList = parsed.externalProviders {
          self.applyExternalProviders(extList)
        }
        self.lastSyncedAt = Date()
        self.lastUsageRefreshAt = Date()
        if toolFilter == "all" && self.usageToolFilter == "all" {
          self.todaySummary = parsed.today
        }
        self.evaluateAlerts()
        self.onStateUpdated?()
      }
    }.resume()
  }

  func fetchRecentTurns(silent: Bool = false) {
    var query: [(String, String?)] = [("limit", "80")]
    if recentTurnsFilterTool != "all" { query.append(("tool", recentTurnsFilterTool)) }
    guard let url = daemonUrl("/v1/turns", query: query) else { return }
    turnsFetchSeq &+= 1
    let seq = turnsFetchSeq
    if !silent { recentTurnsLoading = true }
    let req = DaemonAuth.authorizedRequest(url: url, method: "GET", timeout: 4)

    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, _ in
      DispatchQueue.main.async { [weak self] in
        guard let self = self, self.turnsFetchSeq == seq else { return }
        self.recentTurnsLoading = false
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let data = data,
              let parsed = try? JSONDecoder().decode(TurnsListResponse.self, from: data) else {
          return
        }
        self.recentTurns = parsed.turns
      }
    }.resume()
  }

  private func applyStatus(_ st: StatusResponse) {
    if bundleVersion == nil, let v = st.version { self.version = v }
    self.daemonOnline = st.online
    if self.daemonPort != st.port {
      self.daemonPort = st.port
      if self.hasStarted {
        self.sseClient.reconnect(port: st.port)
      }
    }
    self.apps = st.apps
    if let dir = st.providersDir, !dir.isEmpty {
      self.providersDir = dir
    }
    if let extList = st.externalProviders {
      self.applyExternalProviders(extList)
    } else if st.online {
      self.applyExternalProviders([])
    }
    self.lastSyncedAt = Date()
    if let cfg = st.config {
      applyDaemonConfig(cfg)
    }
    if let state = st.state {
      if let today = state.todaySummary {
        let prevTurns = self.todaySummary?.turnCount ?? -1
        self.todaySummary = today
        if (today.turnCount != prevTurns || self.usageData == nil),
           !self.usageInFlightIsForce,
           Date().timeIntervalSince(self.usageLastStartedAt) >= 0.6 {
          self.fetchUsageSummary(silent: true)
        }
      }
      updateRecentTurnsCache(state.recent)
    }
    self.evaluateAlerts()
    self.onStateUpdated?()
  }

  private func applyDoctor(_ doc: DoctorResponse) {
    if bundleVersion == nil, let v = doc.version { self.version = v }
    self.daemonVersion = doc.daemon.version
    self.updateFeedUrl = doc.updateFeedUrl
    self.daemonOnline = doc.daemon.ok
    if self.daemonPort != doc.daemon.port {
      self.daemonPort = doc.daemon.port
      if self.hasStarted {
        self.sseClient.reconnect(port: doc.daemon.port)
      }
    }
    self.launchAgentExists = doc.launchAgent.plistExists
    self.launchAgentLoaded = doc.launchAgent.launchAgentLoaded
    var map: [String: String] = [:]
    for (k, v) in doc.apps {
      if let vv = v.vsixVersion { map[k] = vv }
    }
    self.vsixVersions = map
    self.onStateUpdated?()
  }

  func refreshDoctorAndBootstrap() {
    guard !busy, !doctorBootstrapInFlight else { return }
    let rt = runtime
    let shouldAutoBootstrap = !didBootstrap
    doctorBootstrapInFlight = true

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let docRes = rt.runCli(["doctor", "--json"], timeoutSec: 12)
      let stRes = rt.runCli(["status", "--json"], timeoutSec: 6)

      let doc = docRes.stdout.data(using: .utf8).flatMap { try? JSONDecoder().decode(DoctorResponse.self, from: $0) }
      let st = stRes.stdout.data(using: .utf8).flatMap { try? JSONDecoder().decode(StatusResponse.self, from: $0) }

      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.doctorBootstrapInFlight = false
        if let doc = doc { self.applyDoctor(doc) }
        if let st = st { self.applyStatus(st) }

        if shouldAutoBootstrap, !rt.runningFromDmg, let doc = doc, !self.busy {
          self.didBootstrap = true
          let targetVersion = doc.version ?? self.version
          let isBundledApp = Bundle.main.bundlePath.hasSuffix(".app")
          let daemonVersionMismatch = doc.daemon.ok && doc.daemon.version != targetVersion
          let vsixNeedsUpgrade = (doc.vsixVersionMismatch == true)
          let needsAppUpgrade =
            (isBundledApp && doc.launchAgent.pointsToCurrentRoot == false) ||
            daemonVersionMismatch ||
            vsixNeedsUpgrade

          if !doc.launchAgent.plistExists {
            self.runAction(args: ["install"], successText: "已完成首次安装并开启") { [weak self] in
              self?.fetchUsageSummary(silent: true)
              self?.fetchReceipt(silent: true)
              if let p = self?.daemonPort { self?.sseClient.reconnect(port: p) }
            }
          } else if needsAppUpgrade {
            self.runAction(args: ["install"], successText: "已自动更新到 v\(targetVersion)") { [weak self] in
              self?.fetchUsageSummary(silent: true)
              self?.fetchReceipt(silent: true)
              if let p = self?.daemonPort { self?.sseClient.reconnect(port: p) }
            }
          } else if !doc.daemon.ok && self.masterEnabled {
            self.runAction(args: ["start-daemon"], successText: "已开启后台统计") { [weak self] in
              self?.fetchUsageSummary(silent: true)
              self?.fetchReceipt(silent: true)
              if let p = self?.daemonPort { self?.sseClient.reconnect(port: p) }
            }
          }
        }
      }
    }
  }

  func setMasterEnabled(_ enabled: Bool) {
    guard !busy, !runtime.runningFromDmg else { return }
    masterEnabled = enabled
    if enabled && (!launchAgentExists || !daemonOnline) {
      let args = launchAgentExists ? ["start-daemon"] : ["install"]
      runAction(args: args, successText: "已一键开启") { [weak self] in
        if let p = self?.daemonPort { self?.sseClient.reconnect(port: p) }
        self?.postConfig(["enabled": true], quietBanner: true)
      }
      return
    }
    postConfig(["enabled": enabled], quietBanner: false, bannerText: enabled ? "已一键开启全部显示" : "已一键关闭全部显示")
  }

  func setToolEnabled(_ key: String, enabled: Bool) {
    guard !busy, !runtime.runningFromDmg else { return }
    toolToggles[key] = enabled
    if !enabled && popoverSelection == key {
      popoverSelection = "all"
    }
    if enabled && (!launchAgentExists || !daemonOnline) {
      masterEnabled = true
      let args = launchAgentExists ? ["start-daemon"] : ["install"]
      runAction(args: args, successText: "\(displayTitle(for: key)) 已开启") { [weak self] in
        if let p = self?.daemonPort { self?.sseClient.reconnect(port: p) }
        self?.postConfig(["enabled": true, "tools": [key: true]], quietBanner: true)
      }
      return
    }
    var body: [String: Any] = ["tools": [key: enabled]]
    if enabled && !masterEnabled {
      masterEnabled = true
      body["enabled"] = true
    }
    postConfig(body, quietBanner: false, bannerText: "\(displayTitle(for: key)) 已\(enabled ? "开启" : "关闭")")
  }

  func setInlineMasterEnabled(_ enabled: Bool) {
    guard !busy, !runtime.runningFromDmg else { return }
    inlineMasterEnabled = enabled
    postConfig(
      ["inlineEnabled": enabled],
      quietBanner: false,
      bannerText: enabled ? "已开启软件内置 TPS 显示" : "已关闭软件内置 TPS 显示"
    )
  }

  func setInlineToolEnabled(_ key: String, enabled: Bool) {
    guard !busy, !runtime.runningFromDmg else { return }
    inlineToolToggles[key] = enabled
    var body: [String: Any] = ["inlineTools": [key: enabled]]
    if enabled && !inlineMasterEnabled {
      inlineMasterEnabled = true
      body["inlineEnabled"] = true
    }
    let needsRestart = enabled && (apps[key]?.cdpPort == nil)
    let banner = needsRestart
      ? "\(displayTitle(for: key)) 内置显示开关已开启，请点击「重启并开启」以激活调试口"
      : "\(displayTitle(for: key)) 内置 TPS 已\(enabled ? "开启" : "关闭")"
    postConfig(
      body,
      quietBanner: false,
      bannerText: banner
    )
  }

  private final class CursorSyncBox: @unchecked Sendable {
    private let lock = NSLock()
    var syncOk = false
    var email: String? = nil
    var errorMsg: String? = nil
    var timedOut = false

    func finishWithResponse(_ data: Data?, error: Error?) {
      lock.lock()
      defer { lock.unlock() }
      guard !timedOut else { return }
      if let error = error {
        errorMsg = "同步本机 Cursor 登录态失败：\(error.localizedDescription)"
        return
      }
      if let data = data,
         let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        syncOk = (obj["ok"] as? Bool) == true
        email = obj["email"] as? String
        errorMsg = obj["error"] as? String
      }
    }

    func markTimedOut() {
      lock.lock()
      defer { lock.unlock() }
      timedOut = true
      errorMsg = "同步本机 Cursor 登录态超时，请重试或使用「网页登录同步…」"
    }

    func snapshot() -> (syncOk: Bool, email: String?, errorMsg: String?) {
      lock.lock()
      defer { lock.unlock() }
      return (syncOk, email, errorMsg)
    }
  }

  func openAppWithInlineCdp(_ key: String) {
    guard !busy, !runtime.runningFromDmg else { return }
    let title = displayTitle(for: key)
    runAction(args: ["open", key], successText: "已为 \(title) 开启消息旁显示")
  }

  func openAllAppsWithInlineCdp() {
    guard !busy, !runtime.runningFromDmg else { return }
    runAction(args: ["open", "all"], successText: "已开启全部消息旁显示")
  }

  func saveCursorCookie(_ raw: String?) {
    guard !busy, !runtime.runningFromDmg else { return }
    let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    didTryRestoreWebCookie = true
    hasCursorCookie = !trimmed.isEmpty
    if trimmed.isEmpty {
      let cookieStore = WKWebsiteDataStore.default().httpCookieStore
      cookieStore.getAllCookies { cookies in
        for c in cookies {
          let dom = c.domain.lowercased()
          if (dom.contains("cursor.com") || dom.contains("cursor.sh")) &&
              Self.cursorSessionCookieNames.contains(c.name) {
            cookieStore.delete(c, completionHandler: nil)
          }
        }
      }
    }
    postConfig(
      ["cursorCookie": trimmed],
      quietBanner: false,
      bannerText: trimmed.isEmpty ? "已清除 Cursor 会话 Cookie" : "已保存 Cursor 会话 Cookie，正在同步额度…"
    ) { [weak self] in
      self?.fetchUsageSummary(silent: false, forceRefresh: true)
    }
  }

  func syncCursorFromLocalApp() {
    guard !busy, !runtime.runningFromDmg else { return }
    busy = true
    bannerIsError = false
    statusBanner = "正在读取本机 Cursor 登录凭证…"
    let port = daemonPort

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let passwords = HeadlessCliHelper.readCursorSafeStoragePasswords(allowPrompt: true)
      let box = CursorSyncBox()

      if let url = URL(string: "http://127.0.0.1:\(port)/v1/cursor/sync-local"),
         let jsonData = try? JSONSerialization.data(withJSONObject: ["passwords": passwords]) {
        var req = DaemonAuth.authorizedRequest(url: url, method: "POST", timeout: 15)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = jsonData
        let sem = DispatchSemaphore(value: 0)
        let task = DaemonAuth.localSession.dataTask(with: req) { data, _, err in
          box.finishWithResponse(data, error: err)
          sem.signal()
        }
        task.resume()
        if sem.wait(timeout: .now() + 16) == .timedOut {
          box.markTimedOut()
          task.cancel()
        }
      } else {
        box.markTimedOut()
      }

      let result = box.snapshot()
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.busy = false
        if result.syncOk {
          self.hasCursorCookie = true
          self.bannerIsError = false
          self.statusBanner = result.email != nil
            ? "已从本机 Cursor 同步账号（\(result.email!)）"
            : "已从本机 Cursor 同步套餐额度"
          self.fetchAppsStatusHttp()
          self.fetchUsageSummary(silent: false, forceRefresh: true)
        } else {
          self.bannerIsError = true
          self.statusBanner = result.errorMsg ?? "未检测到本机 Cursor 登录态，请使用「登录同步…」"
        }
      }
    }
  }

  private func restoreCursorWebCookieIfPresent() {
    let now = Date()
    WKWebsiteDataStore.default().httpCookieStore.getAllCookies { [weak self] cookies in
      let validCookies = cookies.filter { c in
        let dom = c.domain.lowercased()
        let isCursorDom = dom.contains("cursor.com") || dom.contains("cursor.sh")
        let notExpired = c.expiresDate.map { $0 > now } ?? true
        return isCursorDom && notExpired && !c.value.isEmpty
      }
      var deduped: [String: HTTPCookie] = [:]
      for c in validCookies.sorted(by: { $0.domain.count < $1.domain.count || $0.path.count < $1.path.count }) {
        deduped[c.name] = c
      }
      let finalCookies = Array(deduped.values).sorted { $0.name < $1.name }
      guard finalCookies.contains(where: { Self.cursorSessionCookieNames.contains($0.name) }) else { return }
      let header = finalCookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
      DispatchQueue.main.async {
        guard let self = self, !self.hasCursorCookie else { return }
        self.hasCursorCookie = true
        self.postConfig(["cursorCookie": header], quietBanner: true) { [weak self] in
          self?.fetchUsageSummary(silent: true, forceRefresh: true)
        }
      }
    }
  }

  func exportUsageCsv() {
    guard let data = usageData else { return }
    var lines = ["date,turns,total_input_tokens,output_tokens,total_tokens,estimated_cost_usd,cache_savings_usd"]
    for pt in data.daily where pt.totalTokens > 0 || pt.turnCount > 0 {
      let usdStr = pt.estimatedCostUsd.map { String(format: "%.6f", $0) } ?? ""
      let savStr = pt.cacheSavingsUsd.map { String(format: "%.6f", $0) } ?? ""
      lines.append("\(pt.date),\(pt.turnCount),\(pt.totalInputTokens),\(pt.outputTokens),\(pt.totalTokens),\(usdStr),\(savStr)")
    }
    let panel = NSSavePanel()
    panel.allowedContentTypes = [.commaSeparatedText]
    panel.nameFieldStringValue = "ai-turn-meter-usage-\(usageDays == 0 ? "all" : "\(usageDays)d").csv"
    if panel.runModal() == .OK, let url = panel.url {
      do {
        try lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
        statusBanner = "已导出用量账单：\(url.lastPathComponent)"
        bannerIsError = false
      } catch {
        bannerIsError = true
        statusBanner = "导出 CSV 失败：\(error.localizedDescription)"
      }
    }
  }

  // MARK: - Daily Thermal Receipt Actions

  func setReceiptCurrencyMode(_ mode: String) {
    receiptCurrencyMode = mode
    UserDefaults.standard.set(mode, forKey: PrefKey.receiptCurrencyMode)
  }

  func setReceiptUsdToCny(_ rate: Double) {
    let clamped = max(0.01, min(1000.0, rate))
    receiptUsdToCny = clamped
    UserDefaults.standard.set(clamped, forKey: PrefKey.receiptUsdToCny)
  }

  func setReceiptTheme(_ theme: String) {
    receiptTheme = theme
    UserDefaults.standard.set(theme, forKey: PrefKey.receiptTheme)
  }

  func setReceiptHideProjects(_ hide: Bool) {
    receiptHideProjects = hide
    UserDefaults.standard.set(hide, forKey: PrefKey.receiptHideProjects)
  }

  func formatReceiptMoney(_ usd: Double?) -> String {
    guard let usd = usd, usd.isFinite else { return "N/A" }
    let rate = receiptUsdToCny > 0 ? receiptUsdToCny : 7.0
    func fmt(_ n: Double) -> String {
      let a = abs(n)
      if a == 0 { return "0.00" }
      if a < 0.01 { return String(format: "%.4f", a) }
      return String(format: "%.2f", a)
    }
    let sign = usd < 0 ? "-" : ""
    let u = "\(sign)$\(fmt(usd))"
    let c = "\(sign)¥\(fmt(usd * rate))"
    switch receiptCurrencyMode {
    case "usd": return u
    case "cny": return c
    default: return "\(u) (\(c))"
    }
  }

  private static func currentIsoDayString(now: Date = Date()) -> String {
    MeterFormat.makeIsoDayFormatter().string(from: now)
  }

  @discardableResult
  private func syncReceiptDateForCurrentDayIfNeeded(now: Date = Date()) -> Bool {
    guard isReceiptDateAutoToday else { return false }
    let todayStr = Self.currentIsoDayString(now: now)
    guard receiptDate != todayStr else { return false }
    isUpdatingReceiptDateAutomatically = true
    receiptDate = todayStr
    isUpdatingReceiptDateAutomatically = false
    receiptPunchlineIndex = 0
    return true
  }

  func shiftReceiptDate(byDays delta: Int) {
    let f = MeterFormat.makeIsoDayFormatter()
    let cal = Calendar(identifier: .gregorian)
    let base = f.date(from: receiptDate) ?? Date()
    if let next = cal.date(byAdding: .day, value: delta, to: base) {
      let today = cal.startOfDay(for: Date())
      let clamped = min(cal.startOfDay(for: next), today)
      receiptDate = f.string(from: clamped)
      receiptPunchlineIndex = 0
      fetchReceipt()
    }
  }

  func selectReceiptToday() {
    let todayStr = Self.currentIsoDayString()
    isReceiptDateAutoToday = true
    isUpdatingReceiptDateAutomatically = true
    receiptDate = todayStr
    isUpdatingReceiptDateAutomatically = false
    receiptPunchlineIndex = 0
    fetchReceipt()
  }

  func fetchReceipt(silent: Bool = false) {
    syncReceiptDateForCurrentDayIfNeeded()
    var comps = URLComponents(string: "http://127.0.0.1:\(daemonPort)/v1/receipt")
    var q: [URLQueryItem] = [
      URLQueryItem(name: "date", value: receiptDate),
      URLQueryItem(name: "scope", value: receiptScope),
      URLQueryItem(name: "groupBy", value: receiptGroupBy),
    ]
    if usageToolFilter != "all" {
      q.append(URLQueryItem(name: "tool", value: usageToolFilter))
    }
    comps?.queryItems = q
    guard let url = comps?.url else { return }
    receiptFetchSeq &+= 1
    let seq = receiptFetchSeq
    if !silent {
      receiptLoading = true
      receiptError = nil
    }
    let req = DaemonAuth.authorizedRequest(url: url, method: "GET", timeout: 20)

    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self, self.receiptFetchSeq == seq else { return }
        self.receiptLoading = false
        if let err = err {
          self.receiptError = "无法连接本地统计服务（\(err.localizedDescription)）"
          return
        }
        guard let http = resp as? HTTPURLResponse else {
          self.receiptError = "本地统计服务无响应"
          return
        }
        if http.statusCode == 404 {
          self.receiptError = "后台守护进程版本过旧，不支持每日账单接口，请点击「同步并重启后台」"
          return
        }
        guard http.statusCode == 200, let data = data else {
          self.receiptError = "获取账单失败（HTTP \(http.statusCode)）"
          return
        }
        do {
          let parsed = try JSONDecoder().decode(ReceiptDataResponse.self, from: data)
          self.receiptData = parsed
          self.receiptError = nil
        } catch {
          self.receiptError = "账单数据解析失败（\(error.localizedDescription)）"
        }
      }
    }.resume()
  }

  private func buildReceiptExportUrl(format: String) -> URL? {
    var comps = URLComponents(string: "http://127.0.0.1:\(daemonPort)/v1/receipt")
    var q: [URLQueryItem] = [
      URLQueryItem(name: "date", value: receiptDate),
      URLQueryItem(name: "scope", value: receiptScope),
      URLQueryItem(name: "groupBy", value: receiptGroupBy),
      URLQueryItem(name: "format", value: format),
      URLQueryItem(name: "theme", value: receiptTheme),
      URLQueryItem(name: "currency", value: receiptCurrencyMode),
      URLQueryItem(name: "rate", value: String(format: "%.4g", receiptUsdToCny)),
      URLQueryItem(name: "punchline", value: String(receiptPunchlineIndex)),
    ]
    if receiptHideProjects {
      q.append(URLQueryItem(name: "hideProjects", value: "1"))
    }
    if usageToolFilter != "all" {
      q.append(URLQueryItem(name: "tool", value: usageToolFilter))
    }
    comps?.queryItems = q
    return comps?.url
  }

  func copyReceiptAsciiToClipboard() {
    guard let url = buildReceiptExportUrl(format: "ascii") else { return }
    let req = DaemonAuth.authorizedRequest(url: url, method: "GET", timeout: 15)
    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, _ in
      DispatchQueue.main.async { [weak self] in
        guard let self = self,
              let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let data = data, let text = String(data: data, encoding: .utf8) else {
          self?.bannerIsError = true
          self?.statusBanner = "获取文本小票失败"
          return
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        self.bannerIsError = false
        self.statusBanner = "已复制文本小票到剪贴板"
      }
    }.resume()
  }

  func exportReceiptSvg() {
    guard let url = buildReceiptExportUrl(format: "svg") else { return }
    let req = DaemonAuth.authorizedRequest(url: url, method: "GET", timeout: 15)
    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, _ in
      DispatchQueue.main.async { [weak self] in
        guard let self = self,
              let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let data = data else {
          self?.bannerIsError = true
          self?.statusBanner = "生成 SVG 小票失败"
          return
        }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.svg]
        panel.nameFieldStringValue = "ai-turn-meter-receipt-\(self.receiptDate).svg"
        if panel.runModal() == .OK, let outUrl = panel.url {
          do {
            try data.write(to: outUrl, options: .atomic)
            self.bannerIsError = false
            self.statusBanner = "已导出小票 SVG：\(outUrl.lastPathComponent)"
          } catch {
            self.bannerIsError = true
            self.statusBanner = "导出 SVG 失败：\(error.localizedDescription)"
          }
        }
      }
    }.resume()
  }

  // MARK: - Model Fingerprint & Degradation Detection Actions

  func fetchFingerprintOverview(silent: Bool = false) {
    guard let url = daemonUrl("/v1/fingerprint/overview", query: [("days", "7")]) else { return }
    fingerprintSeq &+= 1
    let seq = fingerprintSeq
    if !silent { fingerprintLoading = true }
    let req = DaemonAuth.authorizedRequest(url: url, method: "GET", timeout: 10)

    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, _ in
      DispatchQueue.main.async { [weak self] in
        guard let self = self, self.fingerprintSeq == seq else { return }
        self.fingerprintLoading = false
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let data = data,
              let parsed = try? JSONDecoder().decode(FingerprintOverviewResponse.self, from: data) else {
          return
        }
        self.fingerprintOverview = parsed
      }
    }.resume()
  }

  func runFingerprintCheck(actionId: String, payload: [String: Any], timeout: TimeInterval = 120) {
    guard fingerprintRunningAction == nil,
          let url = daemonUrl("/v1/fingerprint/run"),
          let jsonData = try? JSONSerialization.data(withJSONObject: payload) else {
      return
    }
    fingerprintRunningAction = actionId
    var req = DaemonAuth.authorizedRequest(url: url, method: "POST", timeout: timeout)
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = jsonData

    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.fingerprintRunningAction = nil
        if let err = err {
          self.bannerIsError = true
          self.statusBanner = "检测请求失败：\(err.localizedDescription)"
          return
        }
        guard let http = resp as? HTTPURLResponse else {
          self.bannerIsError = true
          self.statusBanner = "后台服务无响应"
          return
        }
        let parsed = data.flatMap { try? JSONDecoder().decode(FingerprintRunResponse.self, from: $0) }
        if http.statusCode != 200 {
          self.bannerIsError = true
          self.statusBanner = parsed?.error ?? parsed?.run?.summary ?? "检测失败（HTTP \(http.statusCode)）"
          return
        }
        guard let parsed = parsed else {
          self.bannerIsError = true
          self.statusBanner = "检测响应解析失败"
          return
        }
        if let run = parsed.run {
          self.bannerIsError = !parsed.ok
          self.statusBanner = run.summary
        } else if let errMsg = parsed.error {
          self.bannerIsError = true
          self.statusBanner = errMsg
        } else {
          self.bannerIsError = false
          self.statusBanner = "检测完成"
        }
        self.fetchFingerprintOverview(silent: true)
      }
    }.resume()
  }

  func saveFingerprintEndpoint(name: String, protocolType: String, baseUrl: String, model: String, apiKey: String) {
    guard let url = daemonUrl("/v1/fingerprint/endpoints"),
          let jsonData = try? JSONSerialization.data(withJSONObject: [
            "name": name,
            "protocol": protocolType,
            "baseUrl": baseUrl,
            "model": model,
            "apiKey": apiKey,
          ]) else {
      return
    }
    var req = DaemonAuth.authorizedRequest(url: url, method: "POST", timeout: 8)
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = jsonData

    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        if let err = err {
          self.bannerIsError = true
          self.statusBanner = "保存端点失败：\(err.localizedDescription)"
          return
        }
        struct SaveErrRes: Decodable { let ok: Bool?; let error: String? }
        let parsed = data.flatMap { try? JSONDecoder().decode(SaveErrRes.self, from: $0) }
        if let http = resp as? HTTPURLResponse, http.statusCode == 200, parsed?.ok != false {
          self.bannerIsError = false
          self.statusBanner = "已保存检测端点：\(name.isEmpty ? model : name)"
          self.fetchFingerprintOverview(silent: true)
        } else {
          self.bannerIsError = true
          self.statusBanner = parsed?.error ?? "保存端点失败，请检查 Base URL 与模型名"
        }
      }
    }.resume()
  }

  func deleteFingerprintEndpoint(id: String) {
    guard let url = daemonUrl("/v1/fingerprint/endpoints", query: [("id", id)]) else { return }
    let req = DaemonAuth.authorizedRequest(url: url, method: "DELETE", timeout: 6)
    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        if let err = err {
          self.bannerIsError = true
          self.statusBanner = "删除端点失败：\(err.localizedDescription)"
          return
        }
        struct DelRes: Decodable { let ok: Bool?; let error: String? }
        let http = resp as? HTTPURLResponse
        let parsed = data.flatMap { try? JSONDecoder().decode(DelRes.self, from: $0) }
        guard http?.statusCode == 200, parsed?.ok != false else {
          self.bannerIsError = true
          self.statusBanner = parsed?.error ?? "删除端点失败（HTTP \(http?.statusCode ?? 0)）"
          return
        }
        self.bannerIsError = false
        self.statusBanner = "已删除检测端点"
        self.fetchFingerprintOverview(silent: true)
      }
    }.resume()
  }

  func deleteFingerprintBaseline(id: String) {
    guard let url = daemonUrl("/v1/fingerprint/baselines", query: [("id", id)]) else { return }
    let req = DaemonAuth.authorizedRequest(url: url, method: "DELETE", timeout: 6)
    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        if let err = err {
          self.bannerIsError = true
          self.statusBanner = "删除基线失败：\(err.localizedDescription)"
          return
        }
        struct DelRes: Decodable { let ok: Bool?; let error: String? }
        let http = resp as? HTTPURLResponse
        let parsed = data.flatMap { try? JSONDecoder().decode(DelRes.self, from: $0) }
        guard http?.statusCode == 200, parsed?.ok != false else {
          self.bannerIsError = true
          self.statusBanner = parsed?.error ?? "删除基线失败（HTTP \(http?.statusCode ?? 0)）"
          return
        }
        self.bannerIsError = false
        self.statusBanner = "已删除参考基线"
        self.fetchFingerprintOverview(silent: true)
      }
    }.resume()
  }

  private func postConfig(
    _ bodyObj: [String: Any],
    quietBanner: Bool,
    bannerText: String = "",
    onSuccess: (() -> Void)? = nil
  ) {
    guard let url = daemonUrl("/v1/config"),
          let jsonData = try? JSONSerialization.data(withJSONObject: bodyObj) else {
      return
    }
    var req = DaemonAuth.authorizedRequest(url: url, method: "POST", timeout: 4)
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = jsonData

    DaemonAuth.localSession.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        if let err = err {
          if !quietBanner {
            self.bannerIsError = true
            self.statusBanner = "设置同步失败：\(err.localizedDescription)"
          }
          self.fetchDaemonStateLight()
          return
        }
        struct CfgErrRes: Decodable { let ok: Bool?; let error: String? }
        let parsed = data.flatMap { try? JSONDecoder().decode(CfgErrRes.self, from: $0) }
        if let http = resp as? HTTPURLResponse, http.statusCode == 200, parsed?.ok != false {
          if !quietBanner && !bannerText.isEmpty {
            self.bannerIsError = false
            self.statusBanner = bannerText
          }
          self.fetchAppsStatusHttp()
          self.fetchUsageSummary(silent: true)
          self.onStateUpdated?()
          onSuccess?()
        } else {
          let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
          if !quietBanner {
            self.bannerIsError = true
            self.statusBanner = parsed?.error ?? "设置同步失败（HTTP \(code)）"
          }
          self.fetchDaemonStateLight()
        }
      }
    }.resume()
  }

  private nonisolated static func waitForDaemonHealth(port: Int, maxWaitSec: TimeInterval = 4.0) {
    guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return }
    let deadline = Date().addingTimeInterval(maxWaitSec)
    while Date() < deadline {
      let sem = DispatchSemaphore(value: 0)
      var healthy = false
      var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 0.6)
      req.httpMethod = "GET"
      DaemonAuth.localSession.dataTask(with: req) { _, resp, _ in
        if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
          healthy = true
        }
        sem.signal()
      }.resume()
      _ = sem.wait(timeout: .now() + 0.7)
      if healthy { return }
      Thread.sleep(forTimeInterval: 0.2)
    }
  }

  func runAction(args: [String], successText: String, onSuccess: (() -> Void)? = nil) {
    guard !busy else { return }
    busy = true
    statusBanner = "正在处理…"
    bannerIsError = false
    let rt = runtime
    let port = daemonPort
    let openAllTimeout = max(45.0, Double(max(1, appsNeedingInlineCdp.count)) * 20.0)

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let cliTimeout: TimeInterval = (args == ["open", "all"]) ? openAllTimeout : (args.first == "open" ? 45.0 : 30.0)
      let res = rt.runCli(args, timeoutSec: cliTimeout)
      if res.exitCode == 0 && (args.first == "install" || args.first == "start-daemon") {
        Self.waitForDaemonHealth(port: port)
      }
      let docRes = rt.runCli(["doctor", "--json"], timeoutSec: 12)
      let stRes = rt.runCli(["status", "--json"], timeoutSec: 6)
      let doc = docRes.stdout.data(using: .utf8).flatMap { try? JSONDecoder().decode(DoctorResponse.self, from: $0) }
      let st = stRes.stdout.data(using: .utf8).flatMap { try? JSONDecoder().decode(StatusResponse.self, from: $0) }
      let autostartEnabled = args.first == "uninstall" ? Self.detectAppAutostartEnabled() : nil

      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.busy = false
        if let autostart = autostartEnabled {
          self.launchAtLogin = autostart
        }
        if let doc = doc { self.applyDoctor(doc) }
        if let st = st { self.applyStatus(st) }
        if res.exitCode == 0 {
          self.bannerIsError = false
          self.statusBanner = successText
          onSuccess?()
        } else {
          self.bannerIsError = true
          let msg = res.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
          self.statusBanner = msg.isEmpty ? "操作失败（退出码 \(res.exitCode)）" : msg
        }
      }
    }
  }

  func generateSshSnippet() {
    let targetHost = sshHost.trimmingCharacters(in: .whitespacesAndNewlines)
    let args = targetHost.isEmpty ? ["ssh-info"] : ["ssh-info", targetHost]
    sshSnippetSeq &+= 1
    let seq = sshSnippetSeq
    let rt = runtime
    sshPreview = "正在生成配置预览…"
    sshOneLiner = ""

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let res = rt.runCli(args, timeoutSec: 5)
      let out = res.exitCode == 0 ? res.stdout : res.stderr
      let lines = out.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }
      let oneLiner = lines.last(where: { $0.hasPrefix("ssh ") }) ?? ""
      DispatchQueue.main.async { [weak self] in
        guard let self = self, self.sshSnippetSeq == seq else { return }
        self.sshPreview = out
        self.sshOneLiner = oneLiner
      }
    }
  }

  func applySshConfig(includeRemote: Bool) {
    let targetHost = sshHost.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !targetHost.isEmpty else {
      sshApplyIsError = true
      sshApplyStatus = "请先输入或选择一个远端 Host"
      return
    }
    guard !sshApplying else { return }
    sshApplying = true
    sshApplyStatus = includeRemote ? "正在写入本机 ~/.ssh/config 并通过 SSH 配置远端…" : "正在写入本机 ~/.ssh/config…"
    sshApplyIsError = false
    let rt = runtime

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var args = ["ssh-apply", targetHost, "--json"]
      if includeRemote { args.insert("--remote", at: 2) }
      let res = rt.runCli(args, timeoutSec: 18)
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.sshApplying = false
        if res.exitCode == 0 {
          self.sshApplyIsError = false
          DispatchQueue.global(qos: .utility).async { [weak self] in
            let hosts = MeterRuntime.readSshConfigHosts()
            DispatchQueue.main.async { [weak self] in
              self?.knownSshHosts = hosts
            }
          }
          self.sshApplyStatus = includeRemote
            ? "已完成：本机 ~/.ssh/config 与远端 \(targetHost) 的 ~/.cursor/hooks.json 均已自动配置"
            : "已安全写入本机 ~/.ssh/config（Host \(targetHost)），已自动保留原文件备份"
        } else {
          self.sshApplyIsError = true
          let errText = res.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
          if includeRemote && !errText.isEmpty {
            self.sshApplyStatus = "远端免密 SSH 写入失败（可能需要交互登录或密码），请点击下方「复制远端单行命令」在终端执行。详情：\(errText)"
          } else {
            self.sshApplyStatus = errText.isEmpty ? "配置写入失败（退出码 \(res.exitCode)）" : errText
          }
        }
      }
    }
  }

  func openApplicationsFolder() {
    NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications"))
  }

  func checkForUpdates() {
    guard !updateChecking, !updateDownloading else {
      showUpdateSheet = true
      return
    }
    availableUpdate = nil
    updateDownloadProgress = nil
    updateStage = .checking
    updateErrorDetail = nil
    updateDownloadedBytes = 0
    updateTotalBytes = 0
    updateSpeedBytesPerSec = nil
    showUpdateSheet = true
    guard let rawUrl = updateFeedUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
          !rawUrl.isEmpty,
          let url = URL(string: rawUrl) else {
      updateChecking = false
      updateStage = .failed
      let msg = "当前是离线独立安装包。\n\n收到新版 .dmg 时直接拖入「应用程序」覆盖原软件并打开一次，后台与扩展就会自动完成更新。"
      updateErrorDetail = msg
      updateStatusText = msg
      return
    }

    updateChecking = true
    updateStatusText = "正在检查更新…"
    let curVersion = self.version

    if let ghApiUrl = UpdateChecker.githubApiLatestUrl(from: url) {
      var apiReq = URLRequest(url: ghApiUrl, timeoutInterval: 10)
      apiReq.setValue("AI-Turn-Meter/\(curVersion)", forHTTPHeaderField: "User-Agent")
      apiReq.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
      URLSession.shared.dataTask(with: apiReq) { [weak self] data, resp, _ in
        DispatchQueue.main.async { [weak self] in
          guard let self = self else { return }
          if let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode),
             let data = data {
            switch UpdateChecker.parseReleaseJson(data, currentVersion: curVersion) {
            case .updateAvailable(let info):
              self.updateChecking = false
              self.availableUpdate = info
              self.updateStage = .available
              self.updateTotalBytes = info.assetSizeBytes ?? 0
              self.updateStatusText = "发现新版本 v\(info.version)（当前 v\(curVersion)）"
              return
            case .upToDate(let v):
              self.updateChecking = false
              self.updateStage = .upToDate
              self.updateStatusText = "当前已是最新版本（v\(v)）。"
              return
            case .invalidResponse:
              break
            }
          }
          self.checkUpdateFallback(url: url, curVersion: curVersion)
        }
      }.resume()
      return
    }

    checkUpdateFallback(url: url, curVersion: curVersion)
  }

  private func checkUpdateFallback(url: URL, curVersion: String) {
    var req = URLRequest(url: url, timeoutInterval: 10)
    req.setValue("AI-Turn-Meter/\(curVersion)", forHTTPHeaderField: "User-Agent")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    let trimmedPath = url.path.hasSuffix("/") && url.path.count > 1
      ? String(url.path.dropLast())
      : url.path
    let lowerHost = url.host?.lowercased() ?? ""
    let isGithubReleasesLatest =
      (lowerHost == "github.com" || lowerHost == "www.github.com") && trimmedPath.hasSuffix("/releases/latest")
    if isGithubReleasesLatest {
      req.httpMethod = "HEAD"
    }

    URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.updateChecking = false
        if let err = err {
          let msg = "检查更新失败：\(err.localizedDescription)"
          self.updateStage = .failed
          self.updateErrorDetail = msg
          self.updateStatusText = msg
          return
        }

        if isGithubReleasesLatest {
          guard let finalUrl = (resp as? HTTPURLResponse)?.url else {
            let msg = "无法解析最新版本页面。"
            self.updateStage = .failed
            self.updateErrorDetail = msg
            self.updateStatusText = msg
            return
          }
          let abs = finalUrl.absoluteString
          guard let range = abs.range(of: "/releases/tag/") else {
            let msg = "当前仓库尚未发布 GitHub Release（当前运行 v\(curVersion)）。"
            self.updateStage = .failed
            self.updateErrorDetail = msg
            self.updateStatusText = msg
            return
          }
          let rawPart = String(abs[range.upperBound...])
          let cleanTag = rawPart
            .split(separator: "?", maxSplits: 1).first
            .flatMap { $0.split(separator: "#", maxSplits: 1).first }
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "/ \t\r\n")) } ?? ""
          let remoteVer = cleanTag.trimmingCharacters(in: CharacterSet(charactersIn: "vV "))
          let repoPrefix = String(abs[..<range.lowerBound])
          if remoteVer.isEmpty {
            let msg = "当前仓库尚未发布版本标签。"
            self.updateStage = .failed
            self.updateErrorDetail = msg
            self.updateStatusText = msg
            return
          }
          if UpdateChecker.compareSemver(remoteVer, curVersion) > 0 {
            let dlUrl = "\(repoPrefix)/releases/download/\(cleanTag)/AI-Turn-Meter-\(remoteVer)-arm64.dmg"
            let sha256Url = "\(dlUrl).sha256"
            self.availableUpdate = UpdateReleaseInfo(
              version: remoteVer,
              downloadUrl: dlUrl,
              notes: "",
              sha256Url: sha256Url,
              releasePageUrl: abs
            )
            self.updateStage = .available
            self.updateTotalBytes = 0
            self.updateStatusText = "发现新版本 v\(remoteVer)（当前 v\(curVersion)）"
          } else {
            self.updateStage = .upToDate
            self.updateStatusText = "当前已是最新版本（v\(curVersion)）。"
          }
          return
        }

        guard let data = data else {
          let msg = "更新源未返回数据。"
          self.updateStage = .failed
          self.updateErrorDetail = msg
          self.updateStatusText = msg
          return
        }
        switch UpdateChecker.parseReleaseJson(data, currentVersion: curVersion) {
        case .updateAvailable(let info):
          self.availableUpdate = info
          self.updateStage = .available
          self.updateTotalBytes = info.assetSizeBytes ?? 0
          self.updateStatusText = "发现新版本 v\(info.version)（当前 v\(curVersion)）"
        case .upToDate(let v):
          self.updateStage = .upToDate
          self.updateStatusText = "当前已是最新版本（v\(v)）。"
        case .invalidResponse(let msg):
          self.updateStage = .failed
          self.updateErrorDetail = msg
          self.updateStatusText = msg
        }
      }
    }.resume()
  }

  func openUpdateReleasePage() {
    let raw = availableUpdate?.releasePageUrl
      ?? updateFeedUrl
      ?? "https://github.com/shadow-qw/AI-Turn-Meter/releases/latest"
    if let url = URL(string: raw) {
      NSWorkspace.shared.open(url)
    }
  }

  func openUpdateDirectDownload() {
    if let raw = availableUpdate?.downloadUrl, let url = URL(string: raw) {
      NSWorkspace.shared.open(url)
      return
    }
    openUpdateReleasePage()
  }

  func cancelUpdateDownload() {
    guard updateStage == .downloading else { return }
    activeUpdateDownloader?.cancel()
    activeUpdateDownloader = nil
    updateDownloading = false
    updateDownloadProgress = nil
    updateSpeedBytesPerSec = nil
    updateStage = .cancelled
    updateStatusText = "已取消下载，你可以随时重新开始或改用浏览器下载。"
  }

  func downloadAndOpenUpdate(_ info: UpdateReleaseInfo) {
    guard !updateDownloading, let url = URL(string: info.downloadUrl) else { return }
    let knownTotalBytes = info.assetSizeBytes ?? 0
    updateDownloading = true
    updateStage = .downloading
    updateErrorDetail = nil
    updateDownloadedBytes = 0
    updateTotalBytes = knownTotalBytes
    updateDownloadProgress = knownTotalBytes > 0 ? 0.0 : nil
    updateSpeedBytesPerSec = nil
    updateStatusText = "正在下载 v\(info.version) 安装包…"

    let bundleUrl = Bundle.main.bundleURL
    let canSelfReplace =
      !runtime.runningFromDmg &&
      bundleUrl.path.hasSuffix(".app") &&
      FileManager.default.isWritableFile(atPath: bundleUrl.deletingLastPathComponent().path)

    let urlLast = url.lastPathComponent
    let dmgFilename = urlLast.lowercased().hasSuffix(".dmg") ? urlLast : "AI-Turn-Meter-\(info.version).dmg"
    let assetFilename = urlLast.isEmpty ? dmgFilename : urlLast
    let downloadsDir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
    let dest = downloadsDir.appendingPathComponent(dmgFilename)

    let downloader = UpdateDownloader(
      url: url,
      destinationUrl: dest,
      userAgent: "AI-Turn-Meter/\(self.version)",
      onProgress: { [weak self] written, expected, speed in
        DispatchQueue.main.async { [weak self] in
          guard let self = self, self.updateStage == .downloading else { return }
          self.updateDownloadedBytes = written
          let resolvedTotal = expected > 0 ? expected : (info.assetSizeBytes ?? 0)
          self.updateTotalBytes = resolvedTotal
          if resolvedTotal > 0 {
            self.updateDownloadProgress = min(1.0, max(0.0, Double(written) / Double(resolvedTotal)))
          } else {
            self.updateDownloadProgress = nil
          }
          if let speed = speed {
            self.updateSpeedBytesPerSec = speed
          }
        }
      },
      onFinish: { [weak self] result in
        DispatchQueue.main.async { [weak self] in
          guard let self = self else { return }
          self.activeUpdateDownloader = nil

          switch result {
          case .failure(let err):
            let nsErr = err as NSError
            if nsErr.domain == NSURLErrorDomain && nsErr.code == NSURLErrorCancelled {
              return
            }
            let msg = "下载失败：\(err.localizedDescription)"
            self.updateDownloading = false
            self.updateDownloadProgress = nil
            self.updateSpeedBytesPerSec = nil
            self.updateStage = .failed
            self.updateErrorDetail = msg
            self.updateStatusText = msg

          case .success(let downloadedUrl):
            self.updateStage = .verifying
            self.updateDownloadProgress = nil
            self.updateSpeedBytesPerSec = nil
            self.updateStatusText = "正在校验安装包完整性（SHA-256）…"

            // Run SHA-256 verification and hdiutil/ditto off the main thread.
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
              guard let self = self else { return }
              let fileSize = (try? FileManager.default.attributesOfItem(atPath: downloadedUrl.path)[.size] as? NSNumber)?.int64Value ?? 0
              guard fileSize >= 1_000_000 else {
                try? FileManager.default.removeItem(at: downloadedUrl)
                let msg = "下载文件异常（仅 \(MeterFormat.bytes(fileSize))，不足 1 MB），可能是网络代理拦截或更新源链接失效。请重试或改用浏览器下载。"
                DispatchQueue.main.async {
                  self.updateDownloading = false
                  self.updateDownloadProgress = nil
                  self.updateSpeedBytesPerSec = nil
                  self.updateStage = .failed
                  self.updateErrorDetail = msg
                  self.updateStatusText = msg
                }
                return
              }

              if let shaErr = Self.verifyDownloadedDmgSha256IfAvailable(dest: downloadedUrl, filename: assetFilename, info: info) {
                try? FileManager.default.removeItem(at: downloadedUrl)
                DispatchQueue.main.async {
                  self.updateDownloading = false
                  self.updateDownloadProgress = nil
                  self.updateSpeedBytesPerSec = nil
                  self.updateStage = .failed
                  self.updateErrorDetail = shaErr
                  self.updateStatusText = shaErr
                }
                return
              }

              if canSelfReplace {
                DispatchQueue.main.async {
                  self.updateStage = .installing
                  self.updateDownloadProgress = 1.0
                  self.updateStatusText = "校验通过，正在解压安装 v\(info.version) 并准备重启…"
                }
                if let errMsg = Self.installAppUpdateAndRelaunch(dmgUrl: downloadedUrl, targetAppUrl: bundleUrl) {
                  let msg = "自动覆盖失败（\(errMsg)），已保存到「下载」并打开安装包。"
                  DispatchQueue.main.async {
                    self.updateDownloading = false
                    self.updateDownloadProgress = nil
                    self.updateSpeedBytesPerSec = nil
                    self.updateStage = .failed
                    self.updateErrorDetail = msg
                    self.updateStatusText = msg
                    NSWorkspace.shared.open(downloadedUrl)
                  }
                } else {
                  DispatchQueue.main.async {
                    self.terminateForUpdateRelaunch()
                  }
                }
                return
              }

              DispatchQueue.main.async {
                self.updateDownloading = false
                self.updateDownloadProgress = nil
                self.updateSpeedBytesPerSec = nil
                self.updateStage = .completedManualOpen
                self.updateStatusText = "已下载到「下载」文件夹并打开安装包，拖入「应用程序」覆盖即可。"
                NSWorkspace.shared.open(downloadedUrl)
              }
            }
          }
        }
      }
    )

    activeUpdateDownloader = downloader
    downloader.start()
  }

  private nonisolated static func verifyDownloadedDmgSha256IfAvailable(
    dest: URL,
    filename: String,
    info: UpdateReleaseInfo
  ) -> String? {
    let hasDeclaredChecksum = (info.expectedSha256 != nil) || (info.sha256Url != nil)
    if !hasDeclaredChecksum {
      return nil
    }
    var expected = info.expectedSha256?.lowercased()
    if expected == nil, let shaUrlStr = info.sha256Url {
      guard let shaUrl = URL(string: shaUrlStr) else {
        return "无法获取或解析安装包 SHA-256 校验文件，已中止更新。"
      }
      let config = URLSessionConfiguration.ephemeral
      config.timeoutIntervalForRequest = 10
      config.timeoutIntervalForResource = 12
      let session = URLSession(configuration: config)
      defer { session.finishTasksAndInvalidate() }

      let sem = DispatchSemaphore(value: 0)
      var fetchedText: String? = nil
      var req = URLRequest(url: shaUrl, timeoutInterval: 10)
      req.setValue("AI-Turn-Meter/\(info.version)", forHTTPHeaderField: "User-Agent")
      let task = session.dataTask(with: req) { data, resp, _ in
        if let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode),
           let data = data {
          fetchedText = String(data: data, encoding: .utf8)
        }
        sem.signal()
      }
      task.resume()
      if sem.wait(timeout: .now() + 12) == .timedOut {
        task.cancel()
        return "获取安装包 SHA-256 校验文件超时，已中止更新。"
      }
      if let text = fetchedText {
        expected = UpdateChecker.parseSha256Checksum(from: text, filename: filename)
      }
    }
    guard let expectedHash = expected, expectedHash.count == 64 else {
      return "无法获取或解析安装包 SHA-256 校验文件，已中止更新。"
    }
    guard let actualHash = try? UpdateChecker.sha256Hex(ofFileAt: dest) else {
      return "无法计算安装包 SHA-256 校验值，已中止更新。"
    }
    if actualHash.lowercased() != expectedHash.lowercased() {
      return "安装包 SHA-256 校验不匹配，已中止更新。"
    }
    return nil
  }

  private nonisolated static func runSync(_ launchPath: String, _ args: [String], timeoutSec: TimeInterval = 60) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: launchPath)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    let group = DispatchGroup()
    group.enter()
    p.terminationHandler = { _ in group.leave() }
    do {
      try p.run()
    } catch {
      group.leave()
      return -1
    }
    if group.wait(timeout: .now() + timeoutSec) == .timedOut {
      if p.isRunning { p.terminate() }
      if group.wait(timeout: .now() + 1.0) == .timedOut && p.isRunning {
        kill(p.processIdentifier, SIGKILL)
        _ = group.wait(timeout: .now() + 0.5)
      }
      return -1
    }
    return p.terminationStatus
  }

  private nonisolated static func detachDmg(at mntPath: String) {
    if runSync("/usr/bin/hdiutil", ["detach", mntPath, "-quiet"], timeoutSec: 15) != 0 {
      _ = runSync("/usr/bin/hdiutil", ["detach", mntPath, "-force", "-quiet"], timeoutSec: 15)
    }
  }

  private nonisolated static func installAppUpdateAndRelaunch(dmgUrl: URL, targetAppUrl: URL) -> String? {
    let fm = FileManager.default
    let stageDir = fm.temporaryDirectory.appendingPathComponent("ai-turn-meter-upd-\(UUID().uuidString)", isDirectory: true)
    let mntDir = stageDir.appendingPathComponent("mnt", isDirectory: true)
    let stagedApp = stageDir.appendingPathComponent("AI Turn Meter.app", isDirectory: true)

    do {
      try fm.createDirectory(at: mntDir, withIntermediateDirectories: true)
    } catch {
      return "准备更新目录失败"
    }

    let attachRc = runSync("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mntDir.path, dmgUrl.path])
    guard attachRc == 0 else {
      try? fm.removeItem(at: stageDir)
      return "挂载镜像失败"
    }

    let srcApp = mntDir.appendingPathComponent("AI Turn Meter.app", isDirectory: true)
    guard fm.fileExists(atPath: srcApp.appendingPathComponent("Contents/MacOS/AITurnMeter").path) else {
      detachDmg(at: mntDir.path)
      try? fm.removeItem(at: stageDir)
      return "安装包内未找到应用文件"
    }

    let copyRc = runSync("/usr/bin/ditto", [srcApp.path, stagedApp.path])
    detachDmg(at: mntDir.path)
    try? fm.removeItem(at: mntDir)

    guard copyRc == 0 else {
      try? fm.removeItem(at: stageDir)
      return "解压新版应用失败"
    }

    let pid = ProcessInfo.processInfo.processIdentifier
    let daemonPlistPath = (NSHomeDirectory() as NSString)
      .appendingPathComponent("Library/LaunchAgents/com.local.ai-turn-meter.daemon.plist")
    let script = #"""
    target="${3%/}"
    updating="${target}.updating"
    backup="${target}.backup"
    uid="$(/usr/bin/id -u)"
    plist="$5"
    dmgPath="$6"

    i=0
    while kill -0 "$1" 2>/dev/null && [ "$i" -lt 150 ]; do
      sleep 0.1
      i=$((i + 1))
    done
    sleep 0.2

    rm -rf "$updating"
    if ! /usr/bin/ditto "$2" "$updating"; then
      rm -rf "$updating" "$4"
      exit 1
    fi
    /usr/bin/xattr -dr com.apple.quarantine "$updating" >/dev/null 2>&1 || true

    /bin/launchctl bootout "gui/${uid}/com.local.ai-turn-meter.daemon" >/dev/null 2>&1 || \
      ([ -n "$plist" ] && [ -f "$plist" ] && /bin/launchctl bootout "gui/${uid}" "$plist" >/dev/null 2>&1) || true
    w=0
    while /bin/launchctl print "gui/${uid}/com.local.ai-turn-meter.daemon" >/dev/null 2>&1 && [ "$w" -lt 25 ]; do
      sleep 0.1
      w=$((w + 1))
    done
    sleep 0.3

    rm -rf "$backup"
    if [ -e "$target" ]; then
      if ! /bin/mv "$target" "$backup"; then
        rm -rf "$updating" "$4"
        if [ -n "$plist" ] && [ -f "$plist" ]; then
          /bin/launchctl bootstrap "gui/${uid}" "$plist" >/dev/null 2>&1 || true
        fi
        exit 1
      fi
    fi

    if ! /bin/mv "$updating" "$target"; then
      if [ -e "$backup" ] && [ ! -e "$target" ]; then
        /bin/mv "$backup" "$target" >/dev/null 2>&1 || true
      fi
      rm -rf "$updating" "$4"
      if [ -n "$plist" ] && [ -f "$plist" ]; then
        /bin/launchctl bootstrap "gui/${uid}" "$plist" >/dev/null 2>&1 || true
      fi
      exit 1
    fi

    rm -rf "$backup" "$4" "$dmgPath"
    if [ -n "$plist" ] && [ -f "$plist" ]; then
      /bin/launchctl bootstrap "gui/${uid}" "$plist" >/dev/null 2>&1 || true
    fi
    /usr/bin/open -n "$target"
    """#
    let launcher = Process()
    launcher.executableURL = URL(fileURLWithPath: "/usr/bin/nohup")
    launcher.arguments = [
      "/bin/zsh", "-c", script, "atm-updater",
      "\(pid)", stagedApp.path, targetAppUrl.path, stageDir.path, daemonPlistPath, dmgUrl.path,
    ]
    launcher.standardInput = FileHandle.nullDevice
    launcher.standardOutput = FileHandle.nullDevice
    launcher.standardError = FileHandle.nullDevice
    do {
      try launcher.run()
    } catch {
      try? fm.removeItem(at: stageDir)
      return "启动替换脚本失败"
    }

    return nil
  }

  private func terminateForUpdateRelaunch() {
    showUpdateSheet = false
    updateDownloading = false
    CostHistoryFlyoutController.shared.hideImmediately()
    for win in NSApp.windows {
      while let sheet = win.attachedSheet {
        win.endSheet(sheet)
      }
      win.orderOut(nil)
    }
    NSApp.stopModal()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
      NSApp.terminate(nil)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
      exit(0)
    }
  }
}
