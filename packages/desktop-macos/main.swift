import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers
import WebKit

struct TurnSummary: Decodable, Identifiable {
  var id: String { turnUid ?? "\(tool ?? "turn")-\(completedAtMs ?? 0)-\(inlineText ?? "")" }
  let turnUid: String?
  let tool: String?
  let toolLabel: String?
  let model: String?
  let workspacePath: String?
  let totalInputTokens: Int?
  let cacheReadTokens: Int?
  let outputTokens: Int?
  let cacheRatePct: Double?
  let inlineText: String?
  let tps: Double?
  let completedAtMs: Double?
  let estimatedCostUsd: Double?
  let cacheSavingsUsd: Double?
  let replyPreview: String?
}

struct TurnsListResponse: Decodable {
  let turns: [TurnSummary]
}

struct UsageTotals: Decodable {
  let turnCount: Int
  let callCount: Int
  let totalInputTokens: Int
  let uncachedInputTokens: Int
  let cacheReadTokens: Int
  let cacheWriteTokens: Int
  let outputTokens: Int
  let thinkingTokens: Int
  let totalTokens: Int
  let cacheRatePct: Double?
  let avgTps: Double?
  let estimatedCostUsd: Double?
  let cacheSavingsUsd: Double?
  let pricedTurnCount: Int
  let unpricedTurnCount: Int
}

struct UsageToolRow: Decodable, Identifiable {
  var id: String { tool }
  let tool: String
  let toolLabel: String
  let sharePct: Double
  let turnCount: Int
  let callCount: Int
  let totalInputTokens: Int
  let cacheReadTokens: Int
  let outputTokens: Int
  let totalTokens: Int
  let cacheRatePct: Double?
  let avgTps: Double?
  let estimatedCostUsd: Double?
  let cacheSavingsUsd: Double?
}

struct UsageModelRow: Decodable, Identifiable {
  var id: String { "\(tool):\(model)" }
  let tool: String
  let toolLabel: String
  let model: String
  let priced: Bool
  let sharePct: Double
  let turnCount: Int
  let callCount: Int
  let totalInputTokens: Int
  let cacheReadTokens: Int
  let outputTokens: Int
  let totalTokens: Int
  let cacheRatePct: Double?
  let avgTps: Double?
  let estimatedCostUsd: Double?
  let cacheSavingsUsd: Double?
}

struct UsageDailyPoint: Decodable, Identifiable {
  var id: String { date }
  let date: String
  let turnCount: Int
  let totalInputTokens: Int
  let outputTokens: Int
  let totalTokens: Int
  let estimatedCostUsd: Double?
  let cacheSavingsUsd: Double?
}

struct CardTodayMetrics: Decodable {
  let costUsd: Double?
  let totalTokens: Int
  let totalInputTokens: Int
  let outputTokens: Int
  let turnCount: Int
  let callCount: Int
  let cacheRatePct: Double?
  let avgTps: Double?
  let cacheSavingsUsd: Double?
}

struct CardWindowMetrics: Decodable {
  let costUsd: Double?
  let totalTokens: Int
  let turnCount: Int
}

struct CardDailyModelItem: Decodable, Identifiable {
  var id: String { model }
  let model: String
  let costUsd: Double?
  let totalTokens: Int
}

struct CardDailyPoint: Decodable, Identifiable {
  var id: String { date }
  let date: String
  let label: String
  let totalTokens: Int
  let costUsd: Double?
  let turnCount: Int
  let models: [CardDailyModelItem]?
}

struct CardProjectBreakdown: Decodable, Identifiable {
  var id: String { "\(name)-\(path)" }
  let name: String
  let path: String
  let costUsd: Double?
  let totalTokens: Int
  let turnCount: Int
}

struct CardRecentWindow: Decodable, Identifiable {
  var id: Int { index }
  let index: Int
  let title: String
  let rangeText: String
  let costUsd: Double?
  let totalTokens: Int
  let turnCount: Int
}

struct CardQuotaWindow: Decodable, Identifiable {
  let id: String
  let title: String
  let remainingPct: Double
  let resetText: String?
  let pacePct: Double?
  let subtitle: String?
}

struct CodexBarCardSnapshot: Decodable {
  let accountEmail: String?
  let planTitle: String?
  let quotaWindows: [CardQuotaWindow]?
  let resetCreditsText: String?
  let latestTpsText: String?
  let latestCacheText: String?
  let latestTurnSubline: String?
  let today: CardTodayMetrics
  let currentWindow: CardWindowMetrics
  let days30: CardWindowMetrics
  let daily30: [CardDailyPoint]
  let projects: [CardProjectBreakdown]?
  let recentWindows: [CardRecentWindow]
  let topModel: String?
}

struct UsageProjectRow: Decodable, Identifiable {
  var id: String { "\(name)-\(path)" }
  let name: String
  let path: String
  let sharePct: Double
  let turnCount: Int
  let callCount: Int
  let totalInputTokens: Int
  let cacheReadTokens: Int
  let outputTokens: Int
  let totalTokens: Int
  let cacheRatePct: Double?
  let avgTps: Double?
  let estimatedCostUsd: Double?
  let cacheSavingsUsd: Double?
}

struct UsageSummaryResponse: Decodable {
  let days: Int
  let tool: String?
  let today: UsageTotals
  let totals: UsageTotals
  let byTool: [UsageToolRow]
  let byModel: [UsageModelRow]
  let byProject: [UsageProjectRow]?
  let daily: [UsageDailyPoint]
  let cards: [String: CodexBarCardSnapshot]?
}

struct DaemonStateResponse: Decodable {
  let config: MeterConfigPayload?
  let byTool: [String: TurnSummary?]?
  let latest: TurnSummary?
  let todaySummary: UsageTotals?
  let recent: [TurnSummary]?
}

struct MeterConfigPayload: Decodable {
  let enabled: Bool
  let tools: [String: Bool]
  let inlineEnabled: Bool?
  let inlineTools: [String: Bool]?
  let hasCursorCookie: Bool?
}

struct StatusAppEntry: Decodable {
  let name: String
  let appPath: String?
  let installed: Bool
  let running: Bool?
  let cdpPort: Int?
  let latestTurn: TurnSummary?
}

struct StatusResponse: Decodable {
  let version: String?
  let port: Int
  let online: Bool
  let config: MeterConfigPayload?
  let apps: [String: StatusAppEntry]
  let state: DaemonStateResponse?
}

enum SettingsPane: Hashable {
  case general
  case usage
  case menuBar
  case turns
  case remote
  case about
  case provider(String)
}

enum MainTab: String, CaseIterable {
  case control = "客户端与设置"
  case usage = "用量仪表盘"
  case turns = "最近轮次"

  var icon: String {
    switch self {
    case .control: return "slider.horizontal.3"
    case .usage: return "chart.bar.xaxis"
    case .turns: return "clock.arrow.circlepath"
    }
  }
}

enum MenuBarDisplayMode: String, CaseIterable {
  case iconOnly = "iconOnly"
  case quotaRemaining = "quotaRemaining"
  case todayCost = "todayCost"
  case todayTokensAndCost = "todayTokensAndCost"
  case tps = "tps"
  case latestInline = "latestInline"

  var title: String {
    switch self {
    case .iconOnly: return "仅图标"
    case .quotaRemaining: return "剩余额度"
    case .todayCost: return "今日费用"
    case .todayTokensAndCost: return "今日用量 + 费用"
    case .tps: return "实时速度"
    case .latestInline: return "最近一轮简报"
    }
  }
}

enum MeterFormat {
  static func tokens(_ n: Int?) -> String {
    guard let n = n, n >= 0 else { return "N/A" }
    if n < 1000 { return "\(n)" }
    if n < 1_000_000 {
      return String(format: "%.1fk", Double(n) / 1000.0).replacingOccurrences(of: ".0k", with: "k")
    }
    let m = String(format: "%.2f", Double(n) / 1_000_000.0)
    var trimmed = m
    while trimmed.contains(".") && (trimmed.hasSuffix("0") || trimmed.hasSuffix(".")) {
      trimmed.removeLast()
    }
    return "\(trimmed)M"
  }

  static func usd(_ val: Double?) -> String {
    guard let val = val, val.isFinite, val > 0 else { return "$0.00" }
    if val < 0.01 { return String(format: "$%.4f", val) }
    return String(format: "$%.2f", val)
  }

  static func tps(_ val: Double?) -> String {
    guard let val = val, val.isFinite, val > 0 else { return "N/A" }
    let str = val >= 100
      ? String(Int(val.rounded()))
      : String(format: "%.1f", val).replacingOccurrences(of: ".0", with: "")
    return "\(str) tok/s"
  }

  static func pct(_ val: Double?) -> String {
    guard let val = val, val.isFinite else { return "--" }
    let str = String(format: "%.1f", val).replacingOccurrences(of: ".0", with: "")
    return "\(str)%"
  }

  static func timeText(_ ms: Double?) -> String {
    guard let ms = ms, ms > 0 else { return "" }
    let date = Date(timeIntervalSince1970: ms / 1000.0)
    let fmt = DateFormatter()
    fmt.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "MM-dd HH:mm"
    return fmt.string(from: date)
  }

  static func shortDate(_ ymd: String) -> String {
    let parts = ymd.split(separator: "-")
    if parts.count == 3 { return "\(parts[1])/\(parts[2])" }
    return ymd
  }
}

struct DoctorDaemon: Decodable {
  let ok: Bool
  let pid: Int?
  let port: Int
  let version: String?
  let root: String?
}

struct DoctorLaunchAgent: Decodable {
  let plistPath: String
  let plistExists: Bool
  let launchAgentLoaded: Bool
  let pointsToCurrentRoot: Bool?
  let managedByApp: Bool?
}

struct DoctorCursorHooks: Decodable {
  let validVersion: Bool
  let configured: Bool
}

struct DoctorAppEntry: Decodable {
  let name: String
  let appPath: String?
  let installed: Bool
  let cdpPort: Int?
  let vsixVersion: String?
}

struct DoctorResponse: Decodable {
  let version: String?
  let updateFeedUrl: String?
  let daemon: DoctorDaemon
  let launchAgent: DoctorLaunchAgent
  let cursorHooks: DoctorCursorHooks
  let apps: [String: DoctorAppEntry]
}

struct UpdateReleaseInfo {
  let version: String
  let downloadUrl: String
  let notes: String
}

struct CommandResult {
  let exitCode: Int32
  let stdout: String
  let stderr: String
}

final class MeterRuntime: Sendable {
  let runtimeDir: String
  let nodeBin: String
  let cliScript: String
  let runningFromDmg: Bool

  init() {
    let resDir = Bundle.main.resourcePath ?? Bundle.main.bundlePath
    self.runtimeDir = (resDir as NSString).appendingPathComponent("runtime")
    self.nodeBin = (self.runtimeDir as NSString).appendingPathComponent("node")
    self.cliScript = (self.runtimeDir as NSString).appendingPathComponent("packages/daemon/bin/cli.mjs")
    self.runningFromDmg = Bundle.main.bundlePath.hasPrefix("/Volumes/")
  }

  func runCli(_ args: [String], timeoutSec: TimeInterval = 25) -> CommandResult {
    guard FileManager.default.isExecutableFile(atPath: nodeBin),
          FileManager.default.fileExists(atPath: cliScript) else {
      return CommandResult(exitCode: 1, stdout: "", stderr: "内置 Node 运行时缺失，请重新从安装包拖入应用程序。")
    }

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: nodeBin)
    proc.arguments = [cliScript] + args

    var env = ProcessInfo.processInfo.environment
    env["AI_TURN_METER_NODE_BIN"] = nodeBin
    env["AI_TURN_METER_STABLE_ROOT"] = runtimeDir
    let basePath = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    env["PATH"] = "\(runtimeDir):/opt/homebrew/bin:/usr/local/bin:\(basePath)"
    proc.environment = env

    let outPipe = Pipe()
    let errPipe = Pipe()
    proc.standardOutput = outPipe
    proc.standardError = errPipe

    do {
      try proc.run()
    } catch {
      return CommandResult(exitCode: 1, stdout: "", stderr: error.localizedDescription)
    }

    let group = DispatchGroup()
    group.enter()
    DispatchQueue.global().async {
      proc.waitUntilExit()
      group.leave()
    }
    if group.wait(timeout: .now() + timeoutSec) == .timedOut {
      proc.terminate()
      return CommandResult(exitCode: 124, stdout: "", stderr: "命令执行超时")
    }

    let stdout = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let stderr = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return CommandResult(exitCode: proc.terminationStatus, stdout: stdout, stderr: stderr)
  }

  static func compareSemver(_ a: String, _ b: String) -> Int {
    let cleanA = a.trimmingCharacters(in: CharacterSet(charactersIn: "vV ")).split(separator: ".").map { Int($0) ?? 0 }
    let cleanB = b.trimmingCharacters(in: CharacterSet(charactersIn: "vV ")).split(separator: ".").map { Int($0) ?? 0 }
    let count = max(cleanA.count, cleanB.count)
    for i in 0..<count {
      let va = i < cleanA.count ? cleanA[i] : 0
      let vb = i < cleanB.count ? cleanB[i] : 0
      if va != vb { return va < vb ? -1 : 1 }
    }
    return 0
  }

  static func readSshConfigHosts() -> [String] {
    let path = (NSHomeDirectory() as NSString).appendingPathComponent(".ssh/config")
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
    var hosts: [String] = []
    for rawLine in text.components(separatedBy: .newlines) {
      let line = rawLine.trimmingCharacters(in: .whitespaces)
      guard line.lowercased().hasPrefix("host ") else { continue }
      let parts = line.dropFirst(5).split(whereSeparator: { $0 == " " || $0 == "\t" })
      for p in parts {
        let s = String(p)
        if s == "*" || s.contains("*") || s.contains("?") || hosts.contains(s) { continue }
        hosts.append(s)
      }
    }
    return hosts
  }
}

@MainActor
final class MeterViewModel: ObservableObject {
  let runtime = MeterRuntime()

  private enum PrefKey {
    static let showMenuBarExtra = "aiTurnMeter.showMenuBarExtra"
    static let showMenuBarSummary = "aiTurnMeter.showMenuBarSummary"
    static let menuBarDisplayMode = "aiTurnMeter.menuBarDisplayMode"
    static let hideDockIcon = "aiTurnMeter.hideDockIcon"
    static let showRecentWindowsInMenu = "atm.showRecentWindowsInMenu.v2"
  }

  @Published var version: String = "0.2.15"
  @Published var updateFeedUrl: String? = nil
  @Published var daemonOnline: Bool = false
  @Published var daemonPort: Int = 47831
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
  @Published var showCursorCookieSheet: Bool = false
  @Published var showCursorLoginSheet: Bool = false
  @Published var cursorCookieDraft: String = ""

  @Published var showMenuBarExtra: Bool = UserDefaults.standard.object(forKey: PrefKey.showMenuBarExtra) as? Bool ?? true
  @Published var menuBarDisplayMode: MenuBarDisplayMode = {
    if let raw = UserDefaults.standard.string(forKey: PrefKey.menuBarDisplayMode),
       let mode = MenuBarDisplayMode(rawValue: raw) {
      return mode
    }
    return UserDefaults.standard.bool(forKey: PrefKey.showMenuBarSummary) ? .tps : .iconOnly
  }()
  @Published var hideDockIcon: Bool = UserDefaults.standard.bool(forKey: PrefKey.hideDockIcon)
  @Published var showRecentWindowsInMenu: Bool = UserDefaults.standard.bool(forKey: PrefKey.showRecentWindowsInMenu)
  @Published var launchAtLogin: Bool = FileManager.default.fileExists(
    atPath: (NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents/com.local.ai-turn-meter.app.plist")
  )

  @Published var settingsPane: SettingsPane = .provider("antigravity")
  @Published var activeTab: MainTab = .control
  @Published var popoverSelection: String = "all"
  @Published var lastSyncedAt: Date? = nil
  @Published var todaySummary: UsageTotals? = nil
  @Published var usageDays: Int = 7
  @Published var usageToolFilter: String = "all"
  @Published var usageGroupMode: String = "model"
  @Published var usageData: UsageSummaryResponse? = nil
  @Published var usageLoading: Bool = false

  @Published var recentTurns: [TurnSummary] = []
  @Published var recentTurnsFilterTool: String = "all"
  @Published var recentTurnsSearch: String = ""
  @Published var recentTurnsLoading: Bool = false
  @Published var recentTurnsByTool: [String: [TurnSummary]] = [:]

  @Published var apps: [String: StatusAppEntry] = [:]
  @Published var vsixVersions: [String: String] = [:]

  @Published var busy: Bool = false
  @Published var statusBanner: String? = nil
  @Published var bannerIsError: Bool = false
  @Published var showUninstallAlert: Bool = false
  @Published var showSshSheet: Bool = false
  @Published var sshHost: String = ""
  @Published var sshPreview: String = ""
  @Published var sshOneLiner: String = ""
  @Published var sshApplyStatus: String? = nil
  @Published var sshApplyIsError: Bool = false
  @Published var sshApplying: Bool = false
  @Published var knownSshHosts: [String] = []

  @Published var showUpdateSheet: Bool = false
  @Published var updateChecking: Bool = false
  @Published var updateDownloading: Bool = false
  @Published var availableUpdate: UpdateReleaseInfo? = nil
  @Published var updateStatusText: String = ""

  var onStateUpdated: (() -> Void)?
  var onPreferencesChanged: (() -> Void)?

  private var pollTimer: Timer?
  private var didBootstrap = false
  private var hasStarted = false
  private var lastUsageRefreshAt: Date = .distantPast

  let orderedKeys = ["antigravity", "codex", "cursor", "codebuddy"]

  var isActiveOverall: Bool {
    daemonOnline && masterEnabled
  }

  var appsNeedingInlineCdp: [String] {
    ["codex", "cursor", "codebuddy"].filter { key in
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

  func setMenuBarDisplayMode(_ mode: MenuBarDisplayMode) {
    menuBarDisplayMode = mode
    UserDefaults.standard.set(mode.rawValue, forKey: PrefKey.menuBarDisplayMode)
    UserDefaults.standard.set(mode != .iconOnly, forKey: PrefKey.showMenuBarSummary)
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
          let msg = res.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
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
    showRecentWindowsInMenu = value
    UserDefaults.standard.set(value, forKey: PrefKey.showRecentWindowsInMenu)
  }

  func openSettingsPane(_ pane: SettingsPane) {
    settingsPane = pane
    switch pane {
    case .usage:
      activeTab = .usage
      fetchUsageSummary()
    case .turns:
      activeTab = .turns
      fetchRecentTurns()
    default:
      activeTab = .control
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
    knownSshHosts = MeterRuntime.readSshConfigHosts()
    refreshDoctorAndBootstrap()
    fetchUsageSummary(silent: true)
    pollTimer?.invalidate()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
      Task { @MainActor [weak self] in
        self?.pollTick()
      }
    }
  }

  func stopPolling() {
    pollTimer?.invalidate()
    pollTimer = nil
    hasStarted = false
  }

  func pollTick() {
    guard !busy else { return }
    if NSApp.windows.contains(where: { $0.isVisible }) {
      pollStatusOnly()
      if activeTab == .usage {
        fetchUsageSummary(silent: true)
      } else if activeTab == .turns {
        fetchRecentTurns(silent: true)
      }
    } else if showMenuBarExtra {
      fetchDaemonStateLight()
      if Date().timeIntervalSince(lastUsageRefreshAt) >= 45 {
        fetchUsageSummary(silent: true)
      }
    }
  }

  func toolAccentColor(for key: String) -> Color {
    switch key {
    case "antigravity": return Color(red: 0.15, green: 0.45, blue: 0.96)
    case "codex": return Color(red: 0.06, green: 0.72, blue: 0.50)
    case "cursor": return Color(red: 0.96, green: 0.52, blue: 0.14)
    case "codebuddy": return Color(red: 0.56, green: 0.36, blue: 0.96)
    default: return Color(red: 0.05, green: 0.38, blue: 0.92)
    }
  }

  func toolShortTitle(for key: String) -> String {
    switch key {
    case "all": return "概览"
    case "antigravity": return "Antigravity"
    case "codex": return "Codex"
    case "cursor": return "Cursor"
    case "codebuddy": return "CodeBuddy"
    default: return key
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
    switch key {
    case "antigravity": return "Antigravity"
    case "codex": return "Codex Desktop"
    case "cursor": return "Cursor"
    case "codebuddy": return "CodeBuddy CN"
    default: return key
    }
  }

  func appSubtitle(for key: String) -> String {
    guard let entry = apps[key], entry.installed else { return "未安装" }
    if !masterEnabled { return "全局已暂停显示" }
    if !isToolEnabled(key) { return "已关闭此软件显示" }

    if let turn = entry.latestTurn, let inline = turn.inlineText {
      let modelStr = (turn.model != nil && turn.model != "unknown") ? "\(turn.model!) · " : ""
      return "\(modelStr)\(inline)"
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

  func pollStatusOnly() {
    guard !busy, NSApp.windows.contains(where: { $0.isVisible }) else { return }
    let rt = runtime
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let res = rt.runCli(["status", "--json"], timeoutSec: 6)
      guard res.exitCode == 0,
            let data = res.stdout.data(using: .utf8),
            let parsed = try? JSONDecoder().decode(StatusResponse.self, from: data) else {
        return
      }
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.applyStatus(parsed)
      }
    }
  }

  func fetchDaemonStateLight() {
    guard let url = URL(string: "http://127.0.0.1:\(daemonPort)/v1/state?limit=30") else { return }
    var req = URLRequest(url: url, timeoutInterval: 2)
    req.cachePolicy = .reloadIgnoringLocalCacheData

    URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
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
    if let hasCookie = cfg.hasCursorCookie { self.hasCursorCookie = hasCookie }
  }

  private func applyDaemonState(_ parsed: DaemonStateResponse) {
    self.lastSyncedAt = Date()
    if let cfg = parsed.config {
      applyDaemonConfig(cfg)
    }
    if let today = parsed.todaySummary {
      let prevTurns = self.todaySummary?.turnCount ?? -1
      self.todaySummary = today
      if today.turnCount != prevTurns || self.usageData == nil {
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
  }

  func fetchUsageSummary(silent: Bool = false, forceRefresh: Bool = false) {
    let toolQs = usageToolFilter == "all" ? "" : "&tool=\(usageToolFilter)"
    let refreshQs = forceRefresh ? "&refresh=1" : ""
    guard let url = URL(
      string: "http://127.0.0.1:\(daemonPort)/v1/usage?days=\(usageDays)\(toolQs)\(refreshQs)"
    ) else { return }
    if !silent { usageLoading = true }
    var req = URLRequest(url: url, timeoutInterval: 6)
    req.cachePolicy = .reloadIgnoringLocalCacheData

    URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.usageLoading = false
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let data = data,
              let parsed = try? JSONDecoder().decode(UsageSummaryResponse.self, from: data) else {
          return
        }
        self.usageData = parsed
        self.lastSyncedAt = Date()
        self.lastUsageRefreshAt = Date()
        if self.usageToolFilter == "all" {
          self.todaySummary = parsed.today
        }
        self.onStateUpdated?()
      }
    }.resume()
  }

  func fetchRecentTurns(silent: Bool = false) {
    let qs = recentTurnsFilterTool == "all" ? "limit=80" : "limit=80&tool=\(recentTurnsFilterTool)"
    guard let url = URL(string: "http://127.0.0.1:\(daemonPort)/v1/turns?\(qs)") else { return }
    if !silent { recentTurnsLoading = true }
    var req = URLRequest(url: url, timeoutInterval: 4)
    req.cachePolicy = .reloadIgnoringLocalCacheData

    URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
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
    if let v = st.version { self.version = v }
    self.daemonOnline = st.online
    self.daemonPort = st.port
    self.apps = st.apps
    self.lastSyncedAt = Date()
    if let cfg = st.config {
      applyDaemonConfig(cfg)
    }
    if let state = st.state {
      if let today = state.todaySummary {
        let prevTurns = self.todaySummary?.turnCount ?? -1
        self.todaySummary = today
        if today.turnCount != prevTurns || self.usageData == nil {
          self.fetchUsageSummary(silent: true)
        }
      }
      updateRecentTurnsCache(state.recent)
    }
    self.onStateUpdated?()
  }

  private func applyDoctor(_ doc: DoctorResponse) {
    if let v = doc.version { self.version = v }
    self.updateFeedUrl = doc.updateFeedUrl
    self.daemonOnline = doc.daemon.ok
    self.daemonPort = doc.daemon.port
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
    guard !busy else { return }
    let rt = runtime
    let shouldAutoBootstrap = !didBootstrap
    didBootstrap = true

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let docRes = rt.runCli(["doctor", "--json"], timeoutSec: 12)
      let stRes = rt.runCli(["status", "--json"], timeoutSec: 6)

      let doc = docRes.stdout.data(using: .utf8).flatMap { try? JSONDecoder().decode(DoctorResponse.self, from: $0) }
      let st = stRes.stdout.data(using: .utf8).flatMap { try? JSONDecoder().decode(StatusResponse.self, from: $0) }

      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        if let doc = doc { self.applyDoctor(doc) }
        if let st = st { self.applyStatus(st) }

        if shouldAutoBootstrap, !rt.runningFromDmg, let doc = doc {
          let targetVersion = doc.version ?? self.version
          let isBundledApp = Bundle.main.bundlePath.hasSuffix(".app")
          let needsAppUpgrade =
            isBundledApp &&
            (doc.launchAgent.pointsToCurrentRoot == false ||
              (doc.daemon.version != nil && doc.daemon.version != targetVersion))

          if !doc.launchAgent.plistExists {
            self.runAction(args: ["install"], successText: "已完成首次安装并开启")
          } else if needsAppUpgrade {
            self.runAction(args: ["install"], successText: "已自动更新到 v\(targetVersion)")
          } else if !doc.daemon.ok && self.masterEnabled {
            self.runAction(args: ["start-daemon"], successText: "已开启后台统计")
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
    postConfig(
      body,
      quietBanner: false,
      bannerText: "\(displayTitle(for: key)) 内置 TPS 已\(enabled ? "开启" : "关闭")"
    )
  }

  func saveCursorCookie(_ raw: String?) {
    guard !busy, !runtime.runningFromDmg else { return }
    let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    hasCursorCookie = !trimmed.isEmpty
    postConfig(
      ["cursorCookie": trimmed],
      quietBanner: false,
      bannerText: trimmed.isEmpty ? "已清除 Cursor 会话 Cookie" : "已保存 Cursor 会话 Cookie，正在同步额度…"
    )
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
      self?.fetchUsageSummary(silent: false, forceRefresh: true)
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
      try? lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
      statusBanner = "已导出用量账单：\(url.lastPathComponent)"
      bannerIsError = false
    }
  }

  private func postConfig(_ bodyObj: [String: Any], quietBanner: Bool, bannerText: String = "") {
    guard let url = URL(string: "http://127.0.0.1:\(daemonPort)/v1/config"),
          let jsonData = try? JSONSerialization.data(withJSONObject: bodyObj) else {
      return
    }
    var req = URLRequest(url: url, timeoutInterval: 4)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = jsonData

    URLSession.shared.dataTask(with: req) { [weak self] _, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        if let err = err {
          self.bannerIsError = true
          self.statusBanner = "设置同步失败：\(err.localizedDescription)"
          return
        }
        if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
          if !quietBanner && !bannerText.isEmpty {
            self.bannerIsError = false
            self.statusBanner = bannerText
          }
          self.pollStatusOnly()
          self.fetchUsageSummary(silent: true)
          self.onStateUpdated?()
        }
      }
    }.resume()
  }

  func runAction(args: [String], successText: String, onSuccess: (() -> Void)? = nil) {
    guard !busy else { return }
    busy = true
    statusBanner = "正在处理…"
    bannerIsError = false
    let rt = runtime

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let cliTimeout = args.first == "open" ? 45.0 : 30.0
      let res = rt.runCli(args, timeoutSec: cliTimeout)
      if res.exitCode == 0 {
        Thread.sleep(forTimeInterval: 0.5)
      }
      let docRes = rt.runCli(["doctor", "--json"], timeoutSec: 12)
      let stRes = rt.runCli(["status", "--json"], timeoutSec: 6)
      let doc = docRes.stdout.data(using: .utf8).flatMap { try? JSONDecoder().decode(DoctorResponse.self, from: $0) }
      let st = stRes.stdout.data(using: .utf8).flatMap { try? JSONDecoder().decode(StatusResponse.self, from: $0) }

      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.busy = false
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
    let res = runtime.runCli(args, timeoutSec: 5)
    let out = res.exitCode == 0 ? res.stdout : res.stderr
    sshPreview = out
    let lines = out.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }
    sshOneLiner = lines.last(where: { $0.hasPrefix("ssh ") }) ?? ""
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
          self.knownSshHosts = MeterRuntime.readSshConfigHosts()
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
    availableUpdate = nil
    showUpdateSheet = true
    guard let rawUrl = updateFeedUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
          !rawUrl.isEmpty,
          let url = URL(string: rawUrl) else {
      updateChecking = false
      updateStatusText = "当前是离线独立安装包。\n\n收到新版 .dmg 时直接拖入「应用程序」覆盖原软件并打开一次，后台与扩展就会自动完成更新。"
      return
    }

    updateChecking = true
    updateStatusText = "正在检查更新…"
    let curVersion = self.version

    var req = URLRequest(url: url, timeoutInterval: 10)
    req.setValue("AI-Turn-Meter/\(curVersion)", forHTTPHeaderField: "User-Agent")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    let isGithubReleasesLatest =
      (url.host == "github.com" || url.host == "www.github.com") && url.path.hasSuffix("/releases/latest")
    if isGithubReleasesLatest {
      req.httpMethod = "HEAD"
    }

    URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.updateChecking = false
        if let err = err {
          self.updateStatusText = "检查更新失败：\(err.localizedDescription)"
          return
        }

        if isGithubReleasesLatest {
          guard let finalUrl = (resp as? HTTPURLResponse)?.url else {
            self.updateStatusText = "无法解析最新版本页面。"
            return
          }
          let abs = finalUrl.absoluteString
          guard let range = abs.range(of: "/releases/tag/") else {
            self.updateStatusText = "当前仓库尚未发布 GitHub Release（当前运行 v\(curVersion)）。"
            return
          }
          let rawTag = String(abs[range.upperBound...]).split(separator: "?").first.map(String.init) ?? ""
          let remoteVer = rawTag.trimmingCharacters(in: CharacterSet(charactersIn: "vV "))
          let repoPrefix = String(abs[..<range.lowerBound])
          if remoteVer.isEmpty {
            self.updateStatusText = "当前仓库尚未发布版本标签。"
            return
          }
          if MeterRuntime.compareSemver(remoteVer, curVersion) > 0 {
            let dlUrl = "\(repoPrefix)/releases/download/\(rawTag)/AI-Turn-Meter-\(remoteVer)-arm64.dmg"
            self.availableUpdate = UpdateReleaseInfo(version: remoteVer, downloadUrl: dlUrl, notes: "")
            self.updateStatusText = "发现新版本 v\(remoteVer)（当前 v\(curVersion)）"
          } else {
            self.updateStatusText = "当前已是最新版本（v\(curVersion)）。"
          }
          return
        }

        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
          self.updateStatusText = "更新源返回格式无效。"
          return
        }

        let remoteTag = (json["tag_name"] as? String) ?? (json["version"] as? String) ?? ""
        let remoteVer = remoteTag.trimmingCharacters(in: CharacterSet(charactersIn: "vV "))
        var dmgUrl = (json["dmgUrl"] as? String) ?? (json["url"] as? String)
        if dmgUrl == nil, let assets = json["assets"] as? [[String: Any]] {
          for asset in assets {
            if let name = asset["name"] as? String, name.hasSuffix(".dmg"),
               let dl = asset["browser_download_url"] as? String {
              dmgUrl = dl
              break
            }
          }
        }
        let notes = (json["body"] as? String) ?? (json["notes"] as? String) ?? ""

        if remoteVer.isEmpty {
          self.updateStatusText = "未能在更新源中解析到版本号。"
          return
        }
        if MeterRuntime.compareSemver(remoteVer, curVersion) > 0, let dlUrl = dmgUrl {
          self.availableUpdate = UpdateReleaseInfo(version: remoteVer, downloadUrl: dlUrl, notes: notes)
          self.updateStatusText = "发现新版本 v\(remoteVer)（当前 v\(curVersion)）"
        } else {
          self.updateStatusText = "当前已是最新版本（v\(curVersion)）。"
        }
      }
    }.resume()
  }

  func downloadAndOpenUpdate(_ info: UpdateReleaseInfo) {
    guard !updateDownloading, let url = URL(string: info.downloadUrl) else { return }
    updateDownloading = true
    updateStatusText = "正在下载 v\(info.version) 更新包…"

    let bundleUrl = Bundle.main.bundleURL
    let canSelfReplace =
      !runtime.runningFromDmg &&
      bundleUrl.path.hasSuffix(".app") &&
      FileManager.default.isWritableFile(atPath: bundleUrl.deletingLastPathComponent().path)

    URLSession.shared.downloadTask(with: url) { [weak self] tempUrl, _, err in
      guard let self = self else { return }
      if let err = err {
        DispatchQueue.main.async {
          self.updateDownloading = false
          self.updateStatusText = "下载失败：\(err.localizedDescription)"
        }
        return
      }
      guard let tempUrl = tempUrl else {
        DispatchQueue.main.async {
          self.updateDownloading = false
          self.updateStatusText = "下载未返回文件。"
        }
        return
      }

      // Move synchronously before URLSession cleans up `tempUrl` when this handler returns.
      let downloadsDir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
      let dest = downloadsDir.appendingPathComponent("AI-Turn-Meter-\(info.version)-arm64.dmg")
      let fm = FileManager.default
      try? fm.removeItem(at: dest)
      do {
        try fm.moveItem(at: tempUrl, to: dest)
      } catch {
        let msg = error.localizedDescription
        DispatchQueue.main.async {
          self.updateDownloading = false
          self.updateStatusText = "保存安装包失败：\(msg)"
        }
        return
      }

      if canSelfReplace {
        DispatchQueue.main.async {
          self.updateStatusText = "正在安装 v\(info.version) 并准备重启…"
        }
        if let errMsg = Self.installAppUpdateAndRelaunch(dmgUrl: dest, targetAppUrl: bundleUrl) {
          DispatchQueue.main.async {
            self.updateDownloading = false
            self.updateStatusText = "自动覆盖失败（\(errMsg)），已保存到「下载」并打开安装包。"
            NSWorkspace.shared.open(dest)
          }
        }
        return
      }

      DispatchQueue.main.async {
        self.updateDownloading = false
        self.updateStatusText = "已下载到「下载」文件夹并打开安装包，拖入「应用程序」覆盖即可。"
        NSWorkspace.shared.open(dest)
      }
    }.resume()
  }

  private nonisolated static func runSync(_ launchPath: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: launchPath)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do {
      try p.run()
      p.waitUntilExit()
      return p.terminationStatus
    } catch {
      return -1
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
      _ = runSync("/usr/bin/hdiutil", ["detach", mntDir.path, "-quiet"])
      try? fm.removeItem(at: stageDir)
      return "安装包内未找到应用文件"
    }

    let copyRc = runSync("/usr/bin/ditto", [srcApp.path, stagedApp.path])
    _ = runSync("/usr/bin/hdiutil", ["detach", mntDir.path, "-quiet"])
    try? fm.removeItem(at: mntDir)

    guard copyRc == 0 else {
      try? fm.removeItem(at: stageDir)
      return "解压新版应用失败"
    }
    try? fm.removeItem(at: dmgUrl)

    let pid = ProcessInfo.processInfo.processIdentifier
    let script = """
    while kill -0 "$1" 2>/dev/null; do sleep 0.1; done
    rm -rf "$3" && /usr/bin/ditto "$2" "$3" && (/usr/bin/xattr -dr com.apple.quarantine "$3" >/dev/null 2>&1 || true) && /usr/bin/open -n "$3"
    rm -rf "$4"
    """
    let launcher = Process()
    launcher.executableURL = URL(fileURLWithPath: "/bin/zsh")
    launcher.arguments = ["-c", script, "atm-updater", "\(pid)", stagedApp.path, targetAppUrl.path, stageDir.path]
    launcher.standardOutput = FileHandle.nullDevice
    launcher.standardError = FileHandle.nullDevice
    do {
      try launcher.run()
    } catch {
      try? fm.removeItem(at: stageDir)
      return "启动替换脚本失败"
    }

    DispatchQueue.main.async {
      NSApp.terminate(nil)
    }
    return nil
  }
}

enum ToolGlyph {
  private static let brandSvgs: [String: String] = [
    "codex": #"""
<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M83.7733 42.8087C84.6678 40.1149 84.9771 37.2613 84.6807 34.4385C84.3843 31.6156 83.489 28.8885 82.0544 26.4394C77.6908 18.8436 68.9203 14.9365 60.3548 16.7725C57.9831 14.1344 54.9591 12.1668 51.5864 11.0673C48.2137 9.96772 44.611 9.77498 41.1402 10.5084C37.6694 11.2418 34.4527 12.8755 31.8132 15.2455C29.1736 17.6155 27.204 20.6383 26.1024 24.0103C23.3212 24.5806 20.6938 25.738 18.3958 27.405C16.0977 29.0721 14.1819 31.2104 12.7765 33.6772C8.36538 41.2609 9.3669 50.8267 15.2527 57.3327C14.3549 60.0251 14.0424 62.8782 14.3361 65.7012C14.6298 68.5241 15.523 71.2518 16.9558 73.7017C21.325 81.3002 30.1011 85.207 38.6712 83.3686C40.5554 85.4904 42.8707 87.1858 45.4623 88.3416C48.0539 89.4975 50.8622 90.0871 53.6999 90.0713C62.4793 90.079 70.2575 84.4114 72.9393 76.0515C75.7201 75.4802 78.347 74.3225 80.6449 72.6555C82.9427 70.9886 84.8587 68.8507 86.2649 66.3846C90.6227 58.8145 89.6172 49.3005 83.7733 42.8087ZM53.6999 84.8356C50.1955 84.8411 46.801 83.6129 44.1116 81.3661L44.5848 81.098L60.5123 71.9043C60.9087 71.6718 61.2379 71.3402 61.4674 70.942C61.6969 70.5439 61.8189 70.0929 61.8215 69.6333V47.1769L68.5553 51.072C68.6225 51.1063 68.6694 51.1707 68.6814 51.2456V69.854C68.6641 78.1208 61.9667 84.8183 53.6999 84.8356ZM21.4977 71.0843C19.7402 68.0497 19.1092 64.4925 19.7156 61.0386L20.1885 61.3225L36.1321 70.5165C36.5266 70.748 36.9757 70.87 37.4331 70.87C37.8905 70.87 38.3396 70.748 38.7341 70.5165L58.21 59.2883V67.0628C58.2081 67.1031 58.1973 67.1424 58.1782 67.1779C58.1591 67.2134 58.1322 67.2441 58.0996 67.2678L41.9671 76.5722C34.798 80.7022 25.6388 78.2463 21.4977 71.0843ZM17.3026 36.3898C19.0723 33.3357 21.8655 31.0062 25.1878 29.8138V48.7376C25.1818 49.1949 25.2986 49.6453 25.5261 50.042C25.7535 50.4387 26.0833 50.7671 26.4809 50.9928L45.8622 62.1739L39.1283 66.069C39.0919 66.0883 39.0513 66.0984 39.0101 66.0984C38.9689 66.0984 38.9283 66.0883 38.8919 66.069L22.7908 56.7809C15.6359 52.6337 13.1822 43.4816 17.3026 36.3112V36.3898ZM72.624 49.2426L53.1792 37.9512L59.8976 34.0718C59.9341 34.0524 59.9747 34.0423 60.016 34.0423C60.0573 34.0423 60.0979 34.0524 60.1344 34.0718L76.2355 43.3761C78.6973 44.7966 80.7043 46.8882 82.0221 49.4065C83.3398 51.9249 83.914 54.7661 83.6775 57.5985C83.4411 60.431 82.4038 63.1377 80.6867 65.4027C78.9696 67.6677 76.6436 69.3975 73.9803 70.3901V51.466C73.9663 51.0096 73.834 50.5647 73.5962 50.1749C73.3584 49.7851 73.0234 49.4638 72.624 49.2426ZM79.3261 39.1657L78.8529 38.8815L62.9411 29.6089C62.5442 29.376 62.0924 29.2532 61.6322 29.2532C61.172 29.2532 60.7202 29.376 60.3233 29.6089L40.8629 40.8374V33.0628C40.8587 33.0233 40.8654 32.9834 40.882 32.9473C40.8987 32.9113 40.9248 32.8803 40.9575 32.8579L57.0586 23.5692C59.5263 22.1476 62.3478 21.458 65.193 21.5811C68.0382 21.7042 70.7896 22.6348 73.1253 24.2642C75.461 25.8936 77.2845 28.1543 78.3825 30.782C79.4806 33.4097 79.8077 36.2957 79.3257 39.1025V39.1657H79.3261ZM37.1888 52.9484L30.455 49.069C30.4213 49.0487 30.3925 49.0212 30.3707 48.9884C30.3488 48.9557 30.3345 48.9186 30.3286 48.8797V30.3188C30.3323 27.4714 31.1466 24.6839 32.6761 22.2822C34.2057 19.8805 36.3874 17.9639 38.9661 16.7564C41.5448 15.549 44.4139 15.1005 47.2381 15.4636C50.0622 15.8267 52.7247 16.9862 54.9141 18.8067L54.4409 19.0748L38.5134 28.2686C38.117 28.5011 37.7879 28.8327 37.5584 29.2308C37.329 29.629 37.207 30.0799 37.2045 30.5395L37.1888 52.9487V52.9484ZM40.8472 45.0632L49.5209 40.0643L58.21 45.0635V55.0615L49.5523 60.0608L40.8632 55.0615L40.8472 45.0632Z" fill="black"/></svg>
"""#,
    "cursor": #"""
<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M84.0704 28.9353L51.9066 10.4454C50.8738 9.85153 49.5994 9.85153 48.5666 10.4454L16.4043 28.9353C15.536 29.4345 15 30.3576 15 31.3575V68.6425C15 69.6424 15.536 70.5655 16.4043 71.0647L48.5681 89.5546C49.6009 90.1485 50.8753 90.1485 51.9081 89.5546L84.0719 71.0647C84.9402 70.5655 85.4762 69.6424 85.4762 68.6425V31.3575C85.4762 30.3576 84.9402 29.4345 84.0719 28.9353H84.0704ZM82.0501 32.8519L51.0006 86.4003C50.7907 86.7611 50.2366 86.6138 50.2366 86.1958V51.1329C50.2366 50.4322 49.8606 49.7842 49.2506 49.4324L18.7553 31.9017C18.3929 31.6927 18.5409 31.141 18.9606 31.141H81.0595C81.9414 31.141 82.4925 32.0927 82.0516 32.8534H82.0501V32.8519Z" fill="black"/></svg>
"""#,
    "antigravity": #"""
<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M85.2843 88.0301C90.1329 91.6664 97.4057 89.2422 90.7389 82.5755C70.7389 63.1816 74.9813 9.84827 50.1329 9.84827C25.2843 9.84827 29.5267 63.1816 9.52673 82.5755C2.25402 89.8483 10.1328 91.6664 14.9813 88.0301C33.7692 75.3028 32.5571 52.8786 50.1329 52.8786C67.7086 52.8786 66.4965 75.3028 85.2843 88.0301Z" fill="black"/></svg>
"""#
  ]

  private static var cachedImages: [String: NSImage] = {
    var out: [String: NSImage] = [:]
    for (key, svg) in brandSvgs {
      if let img = NSImage(data: Data(svg.utf8)) {
        img.isTemplate = true
        img.size = NSSize(width: 16, height: 16)
        out[key] = img
      }
    }
    return out
  }()

  static func brandImage(for key: String) -> NSImage? {
    cachedImages[key]
  }

  static func iconName(for key: String) -> String {
    switch key {
    case "all": return "square.grid.2x2"
    case "antigravity": return "sparkles"
    case "codex": return "terminal"
    case "cursor": return "cursorarrow.rays"
    case "codebuddy": return "chevron.left.forwardslash.chevron.right"
    default: return "app"
    }
  }

  @ViewBuilder
  static func iconView(for key: String, size: CGFloat = 15) -> some View {
    if let img = brandImage(for: key) {
      Image(nsImage: img)
        .resizable()
        .renderingMode(.template)
        .interpolation(.high)
        .scaledToFit()
        .frame(width: size, height: size)
    } else {
      Image(systemName: iconName(for: key))
        .font(.system(size: max(12, size - 2), weight: .semibold))
        .frame(width: size, height: size)
    }
  }
}

private enum CodexBarPalette {
  static let cardTop = Color(red: 0.05, green: 0.43, blue: 0.96)
  static let cardBottom = Color(red: 0.02, green: 0.27, blue: 0.76)
  static let accentBlue = Color(red: 0.05, green: 0.40, blue: 0.94)
  static let tealBar = Color(red: 0.29, green: 0.65, blue: 0.72)
  static let paceGreen = Color(red: 0.20, green: 0.72, blue: 0.42)
}

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
                    if key != "antigravity" && entry?.cdpPort == nil { return .orange }
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
      .frame(width: 440)
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

private struct SettingsGroupCard<Content: View>: View {
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

private func settingsKVRow(title: String, value: String, valueColor: Color = .secondary) -> some View {
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

private func settingsControlRow<Accessory: View>(
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

private struct ProviderSettingsDetailView: View {
  @ObservedObject var vm: MeterViewModel
  let key: String

  var body: some View {
    let entry = vm.apps[key]
    let installed = entry?.installed ?? false
    let enabled = vm.isToolEnabled(key)
    let active = installed && vm.isActiveOverall && enabled
    let isDimmed = !installed || !enabled || !vm.masterEnabled
    let needsInline = installed && vm.isActiveOverall && enabled && key != "antigravity" && entry?.cdpPort == nil
    let card = vm.usageData?.cards?[key]
    let latestTurn = entry?.latestTurn
    let windows = card?.quotaWindows ?? []

    let statusText: String = {
      if !installed { return "未安装" }
      if !vm.daemonOnline { return "后台未启动" }
      if !vm.masterEnabled { return "全局暂停" }
      if !enabled { return "已关闭" }
      if let port = entry?.cdpPort { return "正常运行 · CDP:\(port)" }
      return "正常运行"
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
                Button("开启消息旁") {
                  vm.runAction(args: ["open", key], successText: "已为 \(vm.displayTitle(for: key)) 开启消息旁显示")
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .disabled(vm.busy)
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
                settingsKVRow(title: "附加额度", value: resetCredits)
              }
              Divider().padding(.leading, 14)
            } else if key == "cursor" {
              HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                  Text("套餐剩余额度")
                    .font(.system(size: 12.5))
                    .foregroundColor(.primary)
                  Text(
                    vm.hasCursorCookie
                      ? "未读取到套餐限额，可重新登录或更新会话 Cookie"
                      : "需连接 cursor.com 会话，才可同步套餐剩余百分比与重置时间"
                  )
                  .font(.system(size: 11))
                  .foregroundColor(.secondary)
                  .lineLimit(2)
                }
                Spacer(minLength: 8)
                Button(vm.hasCursorCookie ? "重新登录…" : "登录同步…") {
                  vm.showCursorLoginSheet = true
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.mini)
                .tint(CodexBarPalette.accentBlue)

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
                settingsKVRow(title: "按量支出", value: resetCredits)
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
    let clamped = min(1.0, max(0.0, win.remainingPct / 100.0))
    let pctRounded = Int(win.remainingPct.rounded())

    return VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("\(win.title) 剩余 \(pctRounded)%")
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
          if let pacePct = win.pacePct {
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

private struct GeneralSettingsPaneView: View {
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
                vm.runAction(args: ["open", "all"], successText: "已开启全部消息旁显示")
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

private struct MenuBarSettingsPaneView: View {
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

private struct RemoteHooksSettingsPaneView: View {
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

private struct AboutSettingsPaneView: View {
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
                    HStack(alignment: .bottom, spacing: 2) {
                      ForEach(visibleDays) { pt in
                        let val = dayMetricValue(pt)
                        let frac = val > 0 ? CGFloat(val / maxVal) : 0
                        let isHov = hoveredDay?.id == pt.id
                        let isPeak = val > 0 && pt.date == peakDate

                        RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                          .fill(
                            val > 0
                              ? (isHov ? CodexBarPalette.accentBlue : CodexBarPalette.tealBar)
                              : Color.primary.opacity(0.08)
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
                          .contentShape(Rectangle())
                          .onHover { inside in
                            if inside { hoveredDay = pt }
                            else if hoveredDay?.id == pt.id { hoveredDay = nil }
                          }
                      }
                    }
                    .frame(height: 70, alignment: .bottom)

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
                  let activeDays = Array(data.daily.filter { $0.totalTokens > 0 || $0.turnCount > 0 }.reversed())
                  if activeDays.isEmpty {
                    emptyTip("暂无每日明细")
                  } else {
                    ForEach(Array(activeDays.enumerated()), id: \.element.id) { idx, pt in
                      if idx > 0 { Divider() }
                      HStack {
                        Text(pt.date)
                          .font(.system(size: 12, weight: .medium))
                          .monospacedDigit()
                        Text("\(pt.turnCount) 轮")
                          .font(.system(size: 11))
                          .foregroundColor(.secondary)
                        Spacer()
                        Text("入 \(MeterFormat.tokens(pt.totalInputTokens)) · 出 \(MeterFormat.tokens(pt.outputTokens))")
                          .font(.system(size: 11))
                          .monospacedDigit()
                          .foregroundColor(.secondary)
                        Text(MeterFormat.usd(pt.estimatedCostUsd))
                          .font(.system(size: 12.5, weight: .semibold))
                          .monospacedDigit()
                          .frame(width: 72, alignment: .trailing)
                      }
                      .padding(.vertical, 6)
                    }
                  }
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

struct RecentTurnsTabView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var hoveredTurnChip: String? = nil

  private var filteredTurns: [TurnSummary] {
    let q = vm.recentTurnsSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !q.isEmpty else { return vm.recentTurns }
    return vm.recentTurns.filter { t in
      (t.model?.lowercased().contains(q) ?? false) ||
      (t.workspacePath?.lowercased().contains(q) ?? false) ||
      (t.replyPreview?.lowercased().contains(q) ?? false) ||
      (t.toolLabel?.lowercased().contains(q) ?? false)
    }
  }

  var body: some View {
    VStack(spacing: 10) {
      HStack(spacing: 8) {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 4) {
            turnToolChip(key: "all", label: "全部")
            ForEach(vm.orderedKeys, id: \.self) { k in
              turnToolChip(key: k, label: vm.toolShortTitle(for: k))
            }
          }
        }

        HStack(spacing: 5) {
          Image(systemName: "magnifyingglass")
            .font(.system(size: 11))
            .foregroundColor(.secondary)
          TextField("搜索模型 / 目录 / 回复摘要…", text: $vm.recentTurnsSearch)
            .textFieldStyle(.plain)
            .font(.system(size: 11.5))
          if !vm.recentTurnsSearch.isEmpty {
            Button {
              vm.recentTurnsSearch = ""
            } label: {
              Image(systemName: "xmark.circle.fill")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .frame(width: 210)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(Capsule())
        .overlay(Capsule().stroke(Color.primary.opacity(0.08), lineWidth: 1))

        if vm.recentTurnsLoading {
          ProgressView().controlSize(.small)
        }
      }

      if filteredTurns.isEmpty {
        Spacer()
        VStack(spacing: 6) {
          Image(systemName: "tray")
            .font(.system(size: 24))
            .foregroundColor(.secondary.opacity(0.55))
          Text(vm.recentTurnsLoading ? "正在读取历史轮次…" : "暂无匹配的轮次记录")
            .font(.system(size: 12.5))
            .foregroundColor(.secondary)
        }
        Spacer()
      } else {
        ScrollView {
          LazyVStack(spacing: 8) {
            ForEach(filteredTurns) { t in
              turnCard(t)
            }
          }
          .padding(.bottom, 4)
        }
      }
    }
  }

  private func turnToolChip(key: String, label: String) -> some View {
    let active = vm.recentTurnsFilterTool == key
    let hovered = hoveredTurnChip == key
    let color = vm.toolAccentColor(for: key)
    return Button {
      vm.recentTurnsFilterTool = key
      vm.fetchRecentTurns()
    } label: {
      HStack(spacing: 4) {
        if key != "all" {
          Circle().fill(hovered ? Color.white : color).frame(width: 6, height: 6)
        }
        Text(label)
          .font(.system(size: 11, weight: active ? .semibold : .medium))
      }
      .foregroundColor(hovered ? .white : (active ? .primary : .primary.opacity(0.82)))
      .padding(.horizontal, 9)
      .padding(.vertical, 4.5)
      .background(hovered ? color : (active ? Color.primary.opacity(0.10) : Color.primary.opacity(0.05)))
      .clipShape(Capsule())
    }
    .buttonStyle(.plain)
    .onHover { inside in
      if inside { hoveredTurnChip = key }
      else if hoveredTurnChip == key { hoveredTurnChip = nil }
    }
  }

  private func turnCard(_ t: TurnSummary) -> some View {
    let toolKey = t.tool ?? ""
    let accent = vm.toolAccentColor(for: toolKey)
    let toolName = t.toolLabel ?? vm.displayTitle(for: toolKey)
    let modelName = (t.model != nil && t.model != "unknown") ? t.model! : toolName
    let wsName = t.workspacePath.map { ($0 as NSString).lastPathComponent }
    let wsExists = t.workspacePath.map { FileManager.default.fileExists(atPath: $0) } ?? false
    let appPath = vm.apps[toolKey]?.appPath

    return HStack(spacing: 0) {
      RoundedRectangle(cornerRadius: 2)
        .fill(accent)
        .frame(width: 3.5)
        .padding(.vertical, 8)
        .padding(.leading, 6)

      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          Text(toolName)
            .font(.system(size: 10.5, weight: .semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(accent.opacity(0.14))
            .foregroundColor(accent)
            .clipShape(Capsule())

          Text(modelName)
            .font(.system(size: 12, weight: .semibold))
            .lineLimit(1)

          if let ws = wsName, !ws.isEmpty {
            HStack(spacing: 3) {
              Image(systemName: "folder")
                .font(.system(size: 9.5))
              Text(ws)
                .lineLimit(1)
            }
            .font(.system(size: 10.5))
            .foregroundColor(.secondary)
          }

          Spacer()

          if let cost = t.estimatedCostUsd {
            Text(MeterFormat.usd(cost))
              .font(.system(size: 11, weight: .semibold))
              .monospacedDigit()
              .foregroundColor(CodexBarPalette.accentBlue)
              .padding(.horizontal, 6)
              .padding(.vertical, 1.5)
              .background(CodexBarPalette.accentBlue.opacity(0.10))
              .clipShape(Capsule())
          }

          Text(MeterFormat.timeText(t.completedAtMs))
            .font(.system(size: 10.5))
            .monospacedDigit()
            .foregroundColor(.secondary)
        }

        if let inTok = t.totalInputTokens, let outTok = t.outputTokens {
          HStack(spacing: 6) {
            metricPill(
              "输入 \(MeterFormat.tokens(inTok))" +
              (t.cacheRatePct != nil ? " (\(MeterFormat.pct(t.cacheRatePct)))" : "")
            )
            metricPill("输出 \(MeterFormat.tokens(outTok))")
            if let tps = t.tps, tps > 0 {
              metricPill(MeterFormat.tps(tps))
            }
            if let saved = t.cacheSavingsUsd, saved > 0 {
              metricPill("省 \(MeterFormat.usd(saved))")
            }
          }
        } else if let inline = t.inlineText {
          Text(inline)
            .font(.system(size: 11.5))
            .monospacedDigit()
        }

        if let preview = t.replyPreview, !preview.isEmpty {
          Text(preview)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
            .lineLimit(2)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.035))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }

        if wsExists || appPath != nil {
          HStack(spacing: 8) {
            Spacer()
            if let ws = t.workspacePath, wsExists {
              Button {
                NSWorkspace.shared.open(URL(fileURLWithPath: ws))
              } label: {
                Label("打开目录", systemImage: "folder")
                  .font(.system(size: 10.5))
              }
              .buttonStyle(.bordered)
              .controlSize(.mini)
            }
            if let appPath = appPath {
              Button {
                NSWorkspace.shared.open(URL(fileURLWithPath: appPath))
              } label: {
                Label("打开 \(toolName)", systemImage: "arrow.up.forward.app")
                  .font(.system(size: 10.5))
              }
              .buttonStyle(.bordered)
              .controlSize(.mini)
            }
          }
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 9)
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .stroke(Color.primary.opacity(0.07), lineWidth: 1)
    )
  }

  private func metricPill(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 10.5, weight: .medium))
      .monospacedDigit()
      .foregroundColor(.primary.opacity(0.85))
      .padding(.horizontal, 7)
      .padding(.vertical, 2.5)
      .background(Color.primary.opacity(0.055))
      .clipShape(Capsule())
  }
}

struct RemoteSshSheetView: View {
  @ObservedObject var vm: MeterViewModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Cursor Remote-SSH 上报配置")
        .font(.headline)
      Text("支持一键写入本机 ~/.ssh/config 的 RemoteForward 转发，并自动或通过单行命令配置远端 ~/.cursor/hooks.json。")
        .font(.system(size: 12))
        .foregroundColor(.secondary)

      if !vm.knownSshHosts.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            Text("本机 Host:")
              .font(.system(size: 11))
              .foregroundColor(.secondary)
            ForEach(vm.knownSshHosts, id: \.self) { h in
              Button(h) {
                vm.sshHost = h
                vm.sshApplyStatus = nil
                vm.generateSshSnippet()
              }
              .controlSize(.mini)
            }
          }
        }
      }

      HStack {
        TextField("远端 Host（如 dev-server.example.com）", text: $vm.sshHost)
          .textFieldStyle(.roundedBorder)
        Button("生成预览") { vm.generateSshSnippet() }
      }

      if let status = vm.sshApplyStatus {
        HStack(spacing: 6) {
          Image(systemName: vm.sshApplyIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
            .foregroundColor(vm.sshApplyIsError ? .red : .green)
          Text(status)
            .font(.system(size: 11.5))
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((vm.sshApplyIsError ? Color.red : Color.green).opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 7))
      }

      ScrollView {
        Text(vm.sshPreview)
          .font(.system(size: 11, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(10)
      }
      .frame(height: 195)
      .background(Color(nsColor: .textBackgroundColor))
      .clipShape(RoundedRectangle(cornerRadius: 8))

      HStack(spacing: 8) {
        Button("一键写入本机 ~/.ssh/config") {
          vm.applySshConfig(includeRemote: false)
        }
        .disabled(vm.sshApplying || vm.sshHost.trimmingCharacters(in: .whitespaces).isEmpty)

        Button("一键写入本机+远端") {
          vm.applySshConfig(includeRemote: true)
        }
        .disabled(vm.sshApplying || vm.sshHost.trimmingCharacters(in: .whitespaces).isEmpty)

        if vm.sshApplying {
          ProgressView().controlSize(.small)
        }

        Spacer()

        if !vm.sshOneLiner.isEmpty {
          Button("复制单行命令") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(vm.sshOneLiner, forType: .string)
            vm.sshApplyIsError = false
            vm.sshApplyStatus = "已复制远端 hooks.json 一键安装命令"
          }
        }
        Button("完成") { vm.showSshSheet = false }
          .buttonStyle(.borderedProminent)
      }
      .controlSize(.small)
    }
    .padding(18)
    .frame(width: 600, height: 470)
  }
}

struct CursorAuthWebView: NSViewRepresentable {
  let clearExistingCookies: Bool
  let manualCheckToken: Int
  let onStatusChanged: (String) -> Void
  let onCapturedCookie: (String) -> Void

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    var parent: CursorAuthWebView
    weak var webView: WKWebView?
    var didCapture = false
    var lastManualToken = 0
    var pollTimer: Timer?

    init(_ parent: CursorAuthWebView) {
      self.parent = parent
      self.lastManualToken = parent.manualCheckToken
    }

    deinit {
      pollTimer?.invalidate()
    }

    func startPolling() {
      pollTimer?.invalidate()
      pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
        self?.checkCookies(force: false)
      }
    }

    func stopPolling() {
      pollTimer?.invalidate()
      pollTimer = nil
    }

    func checkCookies(force: Bool) {
      guard !didCapture, let wv = webView else { return }
      let store = wv.configuration.websiteDataStore.httpCookieStore
      let currentUrl = wv.url
      let onDashboard: Bool = {
        guard let url = currentUrl, let host = url.host?.lowercased(), host.contains("cursor.com") else {
          return false
        }
        let path = url.path.lowercased()
        return !path.contains("login") && !path.contains("auth") && !path.contains("sign-in")
      }()
      guard force || onDashboard else { return }

      store.getAllCookies { [weak self] cookies in
        guard let self = self, !self.didCapture else { return }
        let cursorCookies = cookies.filter { $0.domain.lowercased().contains("cursor.com") && !$0.value.isEmpty }
        let hasSession = cursorCookies.contains { $0.name == "WorkosCursorSessionToken" }
        guard hasSession else {
          if force {
            DispatchQueue.main.async {
              self.parent.onStatusChanged("尚未检测到登录凭证，请在下方完成 Cursor 账号登录后再试。")
            }
          }
          return
        }
        let header = cursorCookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
        self.didCapture = true
        DispatchQueue.main.async {
          self.stopPolling()
          self.parent.onCapturedCookie(header)
        }
      }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
      if let host = webView.url?.host {
        parent.onStatusChanged("正在打开 \(host)…")
      }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      parent.onStatusChanged("请在下方登录 Cursor 账号；登录完成后将自动同步额度。")
      checkCookies(force: false)
    }

    func webView(
      _ webView: WKWebView,
      createWebViewWith configuration: WKWebViewConfiguration,
      for navigationAction: WKNavigationAction,
      windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      if navigationAction.targetFrame == nil {
        webView.load(navigationAction.request)
      }
      return nil
    }
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(self)
  }

  func makeNSView(context: Context) -> WKWebView {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default()
    let wv = WKWebView(frame: .zero, configuration: cfg)
    wv.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    wv.navigationDelegate = context.coordinator
    wv.uiDelegate = context.coordinator
    context.coordinator.webView = wv
    context.coordinator.startPolling()

    let target = URL(string: "https://cursor.com/dashboard?tab=usage")!
    if clearExistingCookies {
      let cookieStore = cfg.websiteDataStore.httpCookieStore
      cookieStore.getAllCookies { cookies in
        let toDelete = cookies.filter {
          $0.domain.lowercased().contains("cursor.com") && $0.name == "WorkosCursorSessionToken"
        }
        let group = DispatchGroup()
        for c in toDelete {
          group.enter()
          cookieStore.delete(c) { group.leave() }
        }
        group.notify(queue: .main) {
          wv.load(URLRequest(url: target))
        }
      }
    } else {
      wv.load(URLRequest(url: target))
    }
    return wv
  }

  func updateNSView(_ nsView: WKWebView, context: Context) {
    context.coordinator.parent = self
    if manualCheckToken != context.coordinator.lastManualToken {
      context.coordinator.lastManualToken = manualCheckToken
      context.coordinator.checkCookies(force: true)
    }
  }

  static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
    coordinator.stopPolling()
    nsView.navigationDelegate = nil
    nsView.uiDelegate = nil
  }
}

struct CursorWebLoginSheetView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var statusText: String = "正在加载 cursor.com 登录页…"
  @State private var manualCheckToken: Int = 0
  @State private var clearOnOpen: Bool = false

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "person.badge.key")
          .foregroundColor(CodexBarPalette.accentBlue)
        VStack(alignment: .leading, spacing: 2) {
          Text("连接 Cursor 网页会话")
            .font(.system(size: 13.5, weight: .semibold))
          Text(statusText)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
            .lineLimit(1)
        }
        Spacer()
        Button("同步当前登录态") {
          manualCheckToken += 1
        }
        .buttonStyle(.bordered)
        .controlSize(.small)

        Button("粘贴 Cookie…") {
          vm.showCursorLoginSheet = false
          vm.cursorCookieDraft = ""
          vm.showCursorCookieSheet = true
        }
        .buttonStyle(.bordered)
        .controlSize(.small)

        Button("关闭") {
          vm.showCursorLoginSheet = false
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)

      Divider()

      CursorAuthWebView(
        clearExistingCookies: clearOnOpen,
        manualCheckToken: manualCheckToken,
        onStatusChanged: { msg in statusText = msg },
        onCapturedCookie: { cookieHeader in
          vm.showCursorLoginSheet = false
          vm.saveCursorCookie(cookieHeader)
        }
      )
    }
    .frame(width: 720, height: 560)
    .onAppear {
      clearOnOpen = vm.hasCursorCookie
    }
  }
}

private struct ProviderSwitcherBar: View {
  @ObservedObject var vm: MeterViewModel
  @Binding var selection: String
  @State private var hoveredKey: String? = nil

  private var switcherKeys: [String] {
    let useFallback = vm.apps.isEmpty
    let tools = ["codex", "cursor", "antigravity", "codebuddy"].filter { key in
      let installed = useFallback ? true : (vm.apps[key]?.installed ?? false)
      return installed && vm.isToolEnabled(key)
    }
    return ["all"] + tools
  }

  private func indicatorFraction(for key: String, installed: Bool, active: Bool) -> Double {
    guard key != "all", installed, active else { return 0 }
    if let rem = vm.usageData?.cards?[key]?.quotaWindows?.first?.remainingPct {
      return max(0.08, min(1.0, rem / 100.0))
    }
    return 1.0
  }

  var body: some View {
    HStack(spacing: 4) {
      ForEach(switcherKeys, id: \.self) { key in
        let isSelected = selection == key
        let isHovered = hoveredKey == key
        let isAll = key == "all"
        let entry = vm.apps[key]
        let installed = isAll || (entry?.installed ?? false)
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
        HStack(alignment: .bottom, spacing: 2) {
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
              .contentShape(Rectangle())
              .onHover { inside in
                if inside { hovered = pt }
                else if hovered?.id == pt.id { hovered = nil }
              }
          }
        }
        .frame(height: 26, alignment: .bottom)

        Rectangle()
          .fill(cardHovered ? Color.white.opacity(0.28) : Color.primary.opacity(0.12))
          .frame(height: 1)
      }
    }
  }
}

@MainActor
private final class CostHistoryFlyoutController: NSObject {
  static let shared = CostHistoryFlyoutController()

  weak var anchorPopover: NSPopover?
  private weak var attachedParentWindow: NSWindow?
  private var panel: NSPanel?
  private var vfxView: NSVisualEffectView?
  private var hostingView: NSHostingView<CostHistoryDetailFlyoutView>?
  private var isCardHovered: Bool = false
  private var isFlyoutHovered: Bool = false
  private var hideWorkItem: DispatchWorkItem?
  private var showWorkItem: DispatchWorkItem?

  func setCardHovered(_ hovered: Bool, vm: MeterViewModel, card: CodexBarCardSnapshot, selection: String) {
    isCardHovered = hovered
    if hovered {
      hideWorkItem?.cancel()
      hideWorkItem = nil
      showWorkItem?.cancel()
      let item = DispatchWorkItem { [weak self] in
        MainActor.assumeIsolated {
          guard let self = self, self.isCardHovered else { return }
          self.present(vm: vm, card: card, selection: selection)
        }
      }
      showWorkItem = item
      let delay: TimeInterval = (panel?.isVisible ?? false) ? 0.0 : 0.08
      DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    } else {
      showWorkItem?.cancel()
      showWorkItem = nil
      scheduleHideIfNeeded()
    }
  }

  func setFlyoutHovered(_ hovered: Bool) {
    isFlyoutHovered = hovered
    if hovered {
      hideWorkItem?.cancel()
      hideWorkItem = nil
    } else {
      scheduleHideIfNeeded()
    }
  }

  private func scheduleHideIfNeeded() {
    guard !isCardHovered && !isFlyoutHovered else { return }
    hideWorkItem?.cancel()
    let item = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        guard let self = self, !self.isCardHovered && !self.isFlyoutHovered else { return }
        self.hideImmediately()
      }
    }
    hideWorkItem = item
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: item)
  }

  func hideImmediately() {
    showWorkItem?.cancel()
    showWorkItem = nil
    hideWorkItem?.cancel()
    hideWorkItem = nil
    isCardHovered = false
    isFlyoutHovered = false
    if let p = panel {
      if let parent = attachedParentWindow {
        parent.removeChildWindow(p)
        attachedParentWindow = nil
      }
      p.orderOut(nil)
    }
  }

  private func ensurePanel(rootView: CostHistoryDetailFlyoutView) -> NSPanel {
    if let existing = panel, let hosting = hostingView {
      hosting.rootView = rootView
      return existing
    }

    let hosting = NSHostingView(rootView: rootView)
    let vfx = NSVisualEffectView()
    vfx.material = .popover
    vfx.blendingMode = .behindWindow
    vfx.state = .active
    vfx.wantsLayer = true
    vfx.layer?.cornerRadius = 12
    vfx.layer?.masksToBounds = true
    vfx.layer?.borderWidth = 0.5
    vfx.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.35).cgColor
    vfx.addSubview(hosting)
    hosting.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      hosting.topAnchor.constraint(equalTo: vfx.topAnchor),
      hosting.leadingAnchor.constraint(equalTo: vfx.leadingAnchor),
      hosting.trailingAnchor.constraint(equalTo: vfx.trailingAnchor),
      hosting.bottomAnchor.constraint(equalTo: vfx.bottomAnchor),
    ])

    let p = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 286, height: 340),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    p.isOpaque = false
    p.backgroundColor = .clear
    p.level = .popUpMenu
    p.hasShadow = true
    p.hidesOnDeactivate = true
    p.collectionBehavior = [.transient, .ignoresCycle]
    p.contentView = vfx

    self.panel = p
    self.vfxView = vfx
    self.hostingView = hosting
    return p
  }

  private func present(vm: MeterViewModel, card: CodexBarCardSnapshot, selection: String) {
    guard let pop = anchorPopover, pop.isShown,
          let popWindow = pop.contentViewController?.view.window else {
      return
    }
    guard !card.daily30.isEmpty || !(card.projects ?? []).isEmpty else { return }

    let view = CostHistoryDetailFlyoutView(
      selection: selection,
      card: card,
      onHoverChanged: { [weak self] inside in
        self?.setFlyoutHovered(inside)
      }
    )
    let p = ensurePanel(rootView: view)
    guard let hosting = hostingView else { return }
    hosting.layoutSubtreeIfNeeded()
    let fitSize = hosting.fittingSize
    let panelWidth: CGFloat = 286
    let panelHeight = min(max(fitSize.height, 200), 620)

    let popFrame = popWindow.frame
    let screenFrame = (popWindow.screen ?? NSScreen.main)?.visibleFrame
      ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

    let x: CGFloat = (popFrame.minX - panelWidth - 8 >= screenFrame.minX)
      ? (popFrame.minX - panelWidth - 8)
      : min(screenFrame.maxX - panelWidth - 8, popFrame.maxX + 8)
    let rawY = popFrame.maxY - panelHeight
    let y = min(screenFrame.maxY - panelHeight - 6, max(screenFrame.minY + 8, rawY))

    p.setFrame(NSRect(x: x, y: y, width: panelWidth, height: panelHeight), display: true)
    if let oldParent = attachedParentWindow, oldParent !== popWindow {
      oldParent.removeChildWindow(p)
      attachedParentWindow = nil
    }
    if attachedParentWindow == nil {
      popWindow.addChildWindow(p, ordered: .above)
      attachedParentWindow = popWindow
    }
    p.orderFront(nil)
  }
}

private enum FlyoutChartMetric: Hashable {
  case tokens
  case cost
}

private struct CostHistoryDetailFlyoutView: View {
  let selection: String
  let card: CodexBarCardSnapshot
  let onHoverChanged: (Bool) -> Void

  @State private var metric: FlyoutChartMetric = .tokens
  @State private var hoveredDate: String? = nil

  private func pointValue(_ pt: CardDailyPoint) -> Double {
    switch metric {
    case .tokens: return Double(max(0, pt.totalTokens))
    case .cost: return max(0, pt.costUsd ?? 0)
    }
  }

  private func axisLabel(_ val: Double) -> String {
    if val <= 0 { return "0" }
    switch metric {
    case .tokens:
      return MeterFormat.tokens(Int(val.rounded()))
    case .cost:
      if val >= 10 { return "$\(Int(val.rounded()))" }
      return MeterFormat.usd(val)
    }
  }

  var body: some View {
    let points = card.daily30
    let maxVal = max(0.0, points.map(pointValue).max() ?? 0)
    let scaleMax = max(0.000001, maxVal)
    let peakDate = points.max(by: { pointValue($0) < pointValue($1) })?.date
    let selectedPt: CardDailyPoint? = points.first(where: { $0.date == hoveredDate })
      ?? points.last(where: { $0.totalTokens > 0 || ($0.costUsd ?? 0) > 0 })
      ?? points.last
    let projects = Array((card.projects ?? []).prefix(5))

    VStack(alignment: .leading, spacing: 10) {
      // 30-day vertical bar chart with Y-axis + yellow peak cap (图3)
      if !points.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          HStack(alignment: .bottom, spacing: 6) {
            VStack(alignment: .leading) {
              Text(maxVal > 0 ? axisLabel(maxVal) : (metric == .tokens ? "0" : "$0"))
              Spacer()
              Text(maxVal > 0 ? axisLabel(maxVal / 2.0) : "")
              Spacer()
              Text("0")
            }
            .font(.system(size: 10))
            .monospacedDigit()
            .foregroundColor(Color(nsColor: .tertiaryLabelColor))
            .frame(width: 36, height: 102, alignment: .leading)

            HStack(alignment: .bottom, spacing: 2.5) {
              ForEach(points, id: \.id) { pt in
                flyoutBar(
                  pt: pt,
                  scaleMax: scaleMax,
                  maxVal: maxVal,
                  peakDate: peakDate,
                  selectedDate: selectedPt?.date
                )
              }
            }
          }

          if let firstLabel = points.first?.label {
            Text(firstLabel)
              .font(.system(size: 10))
              .foregroundColor(Color(nsColor: .tertiaryLabelColor))
              .padding(.leading, 42)
          }
        }

        // token | 费用 segmented toggle
        HStack {
          Spacer()
          Picker("", selection: $metric) {
            Text("token").tag(FlyoutChartMetric.tokens)
            Text("费用").tag(FlyoutChartMetric.cost)
          }
          .pickerStyle(.segmented)
          .labelsHidden()
          .controlSize(.small)
          .frame(width: 112)
        }
      }

      // Selected day detail + per-model breakdown
      if let pt = selectedPt {
        let dayModels: [CardDailyModelItem] = Array((pt.models ?? []).prefix(4))

        VStack(alignment: .leading, spacing: 6) {
          Text("\(pt.label): \(MeterFormat.usd(pt.costUsd)) · \(MeterFormat.tokens(pt.totalTokens)) tokens")
            .font(.system(size: 11.5))
            .monospacedDigit()
            .foregroundColor(.secondary)
            .lineLimit(1)

          ForEach(dayModels) { m in
            HStack(alignment: .center, spacing: 8) {
              Rectangle()
                .fill(CodexBarPalette.tealBar)
                .frame(width: 2, height: 26)
              VStack(alignment: .leading, spacing: 1) {
                Text(m.model)
                  .font(.system(size: 11))
                  .foregroundColor(.secondary)
                  .lineLimit(1)
                  .truncationMode(.middle)
                Text("\(MeterFormat.usd(m.costUsd)) · \(MeterFormat.tokens(m.totalTokens))")
                  .font(.system(size: 10.5))
                  .monospacedDigit()
                  .foregroundColor(Color(nsColor: .tertiaryLabelColor))
              }
            }
          }
        }
      }

      // 30-day total estimate + disclaimer
      VStack(alignment: .leading, spacing: 2) {
        Text("估算总计 (近 30 天): \(MeterFormat.usd(card.days30.costUsd))")
          .font(.system(size: 11.5))
          .monospacedDigit()
          .foregroundColor(.secondary)
        Text("根据 Token 用量估算 · 不是订阅账单")
          .font(.system(size: 10))
          .foregroundColor(Color(nsColor: .tertiaryLabelColor))
      }

      // Projects breakdown (项目)
      if !projects.isEmpty {
        VStack(alignment: .leading, spacing: 7) {
          Text("项目")
            .font(.system(size: 11.5))
            .foregroundColor(.secondary)

          ForEach(projects) { proj in
            VStack(alignment: .leading, spacing: 1) {
              HStack(spacing: 6) {
                Text(proj.name)
                  .font(.system(size: 11.5, weight: .medium))
                  .foregroundColor(.secondary)
                  .lineLimit(1)
                Spacer(minLength: 4)
                Text("\(MeterFormat.usd(proj.costUsd)) · \(MeterFormat.tokens(proj.totalTokens)) token 用量")
                  .font(.system(size: 11))
                  .monospacedDigit()
                  .foregroundColor(.secondary)
                  .lineLimit(1)
              }
              Text(proj.path)
                .font(.system(size: 10))
                .foregroundColor(Color(nsColor: .tertiaryLabelColor))
                .lineLimit(1)
                .truncationMode(.middle)
            }
          }
        }
      }
    }
    .padding(16)
    .frame(width: 286, alignment: .leading)
    .contentShape(Rectangle())
    .onHover { onHoverChanged($0) }
  }

  private func flyoutBar(
    pt: CardDailyPoint,
    scaleMax: Double,
    maxVal: Double,
    peakDate: String?,
    selectedDate: String?
  ) -> some View {
    let val = pointValue(pt)
    let ratio: CGFloat = val > 0 ? CGFloat(val / scaleMax) : 0
    let isSelected = selectedDate == pt.date
    let isPeak = maxVal > 0 && pt.date == peakDate

    return ZStack(alignment: .bottom) {
      if isSelected {
        Rectangle()
          .fill(Color.primary.opacity(0.08))
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      RoundedRectangle(cornerRadius: 1.5, style: .continuous)
        .fill(val > 0 ? CodexBarPalette.tealBar : Color.primary.opacity(0.12))
        .frame(maxWidth: .infinity)
        .frame(height: val > 0 ? max(5, ratio * 98) : 1.5)
        .overlay(alignment: .top) {
          if isPeak {
            RoundedRectangle(cornerRadius: 1.5, style: .continuous)
              .fill(Color(nsColor: .systemYellow))
              .frame(height: 4)
          }
        }
    }
    .frame(maxWidth: .infinity)
    .frame(height: 102, alignment: .bottom)
    .contentShape(Rectangle())
    .onHover { inside in
      if inside { hoveredDate = pt.date }
      else if hoveredDate == pt.date { hoveredDate = nil }
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
                  ? (selection == "cursor"
                      ? (vm.hasCursorCookie
                          ? "未读取到套餐限额 · 请重新登录"
                          : "需在「设置 → Cursor」登录同步额度")
                      : "企业/团队按量模式 · 无固定个人会话限额")
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
          leftLabel: "最近 token 用量",
          leftVal: MeterFormat.tokens(card.today.totalTokens),
          rightLabel: "估算：当前窗口 token 用量",
          rightVal: MeterFormat.tokens(card.currentWindow.totalTokens)
        )
        metricGridRow(
          leftLabel: "30d",
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
    let clamped = min(1.0, max(0.0, win.remainingPct / 100.0))
    let pctRounded = Int(win.remainingPct.rounded())
    let trackColor = isCardHovered ? Color.white.opacity(0.24) : Color.primary.opacity(0.10)
    let fillColor = isCardHovered ? Color.white.opacity(0.95) : CodexBarPalette.tealBar
    let tickColor = isCardHovered ? Color.white.opacity(0.26) : Color.primary.opacity(0.14)

    return VStack(alignment: .leading, spacing: 3.5) {
      HStack(spacing: 6) {
        Text("\(win.title) 剩余 \(pctRounded)%")
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
          if let pacePct = win.pacePct {
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
          vm.fetchUsageSummary(silent: true)
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

@MainActor
final class StatusBarController: NSObject, NSPopoverDelegate {
  private let vm: MeterViewModel
  private let onOpenMainTab: (MainTab?) -> Void
  private let onCheckUpdates: () -> Void
  private var statusItem: NSStatusItem?
  private lazy var templateIcon: NSImage = Self.makeTemplateIcon()
  private lazy var popover: NSPopover = {
    let pop = NSPopover()
    pop.behavior = .transient
    pop.animates = true
    pop.delegate = self
    let hosting = NSHostingController(rootView: MenuBarPopoverView(
      vm: vm,
      onOpenMainTab: { [weak self] tab in
        self?.onOpenMainTab(tab)
      },
      onCheckUpdates: { [weak self] in
        self?.onCheckUpdates()
      },
      onClosePopover: { [weak self] in
        self?.closePopover()
      }
    ))
    hosting.sizingOptions = [.preferredContentSize]
    pop.contentViewController = hosting
    CostHistoryFlyoutController.shared.anchorPopover = pop
    return pop
  }()

  func popoverWillClose(_ notification: Notification) {
    CostHistoryFlyoutController.shared.hideImmediately()
  }

  init(
    vm: MeterViewModel,
    onOpenMainTab: @escaping (MainTab?) -> Void,
    onCheckUpdates: @escaping () -> Void
  ) {
    self.vm = vm
    self.onOpenMainTab = onOpenMainTab
    self.onCheckUpdates = onCheckUpdates
    super.init()
  }

  func syncVisibilityAndAppearance() {
    if vm.showMenuBarExtra {
      if statusItem == nil {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = item.button {
          btn.target = self
          btn.action = #selector(togglePopover(_:))
          btn.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item
      }
      updateButtonAppearance()
    } else {
      closePopover()
      if let existing = statusItem {
        NSStatusBar.system.removeStatusItem(existing)
        statusItem = nil
      }
    }
  }

  @objc private func togglePopover(_ sender: AnyObject?) {
    if popover.isShown {
      closePopover()
      return
    }
    guard let btn = statusItem?.button else { return }
    vm.fetchDaemonStateLight()
    vm.fetchUsageSummary(silent: true)
    popover.show(relativeTo: btn.bounds, of: btn, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
  }

  func closePopover() {
    CostHistoryFlyoutController.shared.hideImmediately()
    if popover.isShown {
      popover.performClose(nil)
    }
  }

  func updateButtonAppearance() {
    guard let btn = statusItem?.button else { return }
    btn.image = templateIcon
    btn.appearsDisabled = !vm.isActiveOverall

    let summary = compactMenuBarTitle()
    if summary.isEmpty {
      btn.title = ""
      btn.imagePosition = .imageOnly
    } else {
      btn.title = " \(summary)"
      btn.imagePosition = .imageLeft
      btn.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
    }
    btn.toolTip = buildTooltip()
  }

  private func latestActiveTurn() -> (key: String, turn: TurnSummary)? {
    guard vm.isActiveOverall else { return nil }
    var best: (key: String, turn: TurnSummary, ts: Double)? = nil
    for key in vm.orderedKeys {
      guard vm.isToolEnabled(key),
            let entry = vm.apps[key],
            entry.installed,
            let turn = entry.latestTurn else { continue }
      let ts = turn.completedAtMs ?? 0
      if best == nil || ts > best!.ts {
        best = (key, turn, ts)
      }
    }
    return best.map { ($0.key, $0.turn) }
  }

  private func compactMenuBarTitle() -> String {
    guard vm.isActiveOverall else { return "" }
    switch vm.menuBarDisplayMode {
    case .iconOnly:
      return ""
    case .quotaRemaining:
      var parts: [String] = []
      if vm.isToolEnabled("codex"), let codexPct = vm.usageData?.cards?["codex"]?.quotaWindows?.first?.remainingPct {
        parts.append("Codex \(Int(codexPct.rounded()))%")
      }
      if vm.isToolEnabled("antigravity"), let agyPct = vm.usageData?.cards?["antigravity"]?.quotaWindows?.first?.remainingPct {
        parts.append("AGY \(Int(agyPct.rounded()))%")
      }
      if !parts.isEmpty { return parts.joined(separator: " · ") }
      guard let today = vm.todaySummary else { return "" }
      return MeterFormat.usd(today.estimatedCostUsd)
    case .tps:
      guard let (_, turn) = latestActiveTurn(), let tps = turn.tps, tps > 0 else { return "" }
      return MeterFormat.tps(tps)
    case .todayCost:
      guard let today = vm.todaySummary else { return "" }
      return MeterFormat.usd(today.estimatedCostUsd)
    case .todayTokensAndCost:
      guard let today = vm.todaySummary else { return "" }
      return "\(MeterFormat.tokens(today.totalTokens)) · \(MeterFormat.usd(today.estimatedCostUsd))"
    case .latestInline:
      guard let (_, turn) = latestActiveTurn() else { return "" }
      let inTok = MeterFormat.tokens(turn.totalInputTokens)
      if let tps = turn.tps, tps > 0 {
        return "\(inTok) · \(MeterFormat.tps(tps))"
      }
      return inTok
    }
  }

  private func buildTooltip() -> String {
    var lines = ["AI Turn Meter v\(vm.version)"]
    for key in vm.orderedKeys {
      guard let entry = vm.apps[key], entry.installed else { continue }
      let title = vm.displayTitle(for: key)
      if !vm.isActiveOverall || !vm.isToolEnabled(key) {
        lines.append("\(title): 已暂停")
      } else if let inline = entry.latestTurn?.inlineText {
        lines.append("\(title): \(inline)")
      } else {
        lines.append("\(title): 等待新对话")
      }
    }
    return lines.joined(separator: "\n")
  }

  private static func makeTemplateIcon() -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let img = NSImage(size: size, flipped: false) { _ in
      let cx: CGFloat = 9.0
      let cy: CGFloat = 8.4
      let radius: CGFloat = 6.2

      NSColor.black.setStroke()
      NSColor.black.setFill()

      let arc = NSBezierPath()
      arc.lineWidth = 1.65
      arc.lineCapStyle = .round
      arc.appendArc(
        withCenter: NSPoint(x: cx, y: cy),
        radius: radius,
        startAngle: 205,
        endAngle: -25,
        clockwise: true
      )
      arc.stroke()

      let dotR: CGFloat = 1.45
      let dot = NSBezierPath(ovalIn: NSRect(x: cx - dotR, y: cy - dotR, width: dotR * 2, height: dotR * 2))
      dot.fill()

      let angle = CGFloat.pi * 0.22
      let needle = NSBezierPath()
      needle.lineWidth = 1.55
      needle.lineCapStyle = .round
      needle.move(to: NSPoint(x: cx, y: cy))
      needle.line(to: NSPoint(x: cx + cos(angle) * radius * 0.82, y: cy + sin(angle) * radius * 0.82))
      needle.stroke()

      return true
    }
    img.isTemplate = true
    return img
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow?
  private var vm: MeterViewModel?
  private var statusBarController: StatusBarController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    MainActor.assumeIsolated {
      setupMainMenu()

      let model = MeterViewModel()
      self.vm = model

      let view = ContentView(vm: model)
      let win = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 780, height: 580),
        styleMask: [.titled, .closable, .miniaturizable, .resizable],
        backing: .buffered,
        defer: false
      )
      win.title = "AI Turn Meter 设置"
      win.center()
      win.isReleasedWhenClosed = false
      win.contentView = NSHostingView(rootView: view)
      self.window = win

      let sb = StatusBarController(
        vm: model,
        onOpenMainTab: { [weak self] tab in
          self?.showControlPanel(tab: tab)
        },
        onCheckUpdates: { [weak self] in
          self?.vm?.openSettingsPane(.general)
          self?.showControlPanel(tab: nil)
          self?.vm?.checkForUpdates()
        }
      )
      self.statusBarController = sb

      model.onStateUpdated = { [weak sb] in
        sb?.updateButtonAppearance()
      }
      model.onPreferencesChanged = { [weak self] in
        self?.applyActivationPolicy(keepWindowVisible: true)
        self?.statusBarController?.syncVisibilityAndAppearance()
      }

      applyActivationPolicy(keepWindowVisible: false)
      sb.syncVisibilityAndAppearance()
      model.ensureStarted()

      let launchInBackground = CommandLine.arguments.contains("--background")
      if !launchInBackground {
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
      }
    }
  }

  private func setupMainMenu() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "关于 AI Turn Meter", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(NSMenuItem.separator())
    let openItem = NSMenuItem(title: "设置…", action: #selector(openControlPanelFromMenu), keyEquivalent: ",")
    openItem.target = self
    appMenu.addItem(openItem)
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "隐藏 AI Turn Meter", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = NSMenuItem(title: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(hideOthers)
    appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "退出 AI Turn Meter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appMenuItem.submenu = appMenu
    mainMenu.addItem(appMenuItem)

    let editMenuItem = NSMenuItem()
    let editMenu = NSMenu(title: "编辑")
    editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editMenuItem.submenu = editMenu
    mainMenu.addItem(editMenuItem)

    let windowMenuItem = NSMenuItem()
    let windowMenu = NSMenu(title: "窗口")
    windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowMenuItem.submenu = windowMenu
    mainMenu.addItem(windowMenuItem)

    NSApp.mainMenu = mainMenu
  }

  @MainActor
  @objc private func openControlPanelFromMenu() {
    showControlPanel(tab: nil)
  }

  @MainActor
  private func showControlPanel(tab: MainTab? = nil) {
    if let tab = tab {
      switch tab {
      case .usage: vm?.openSettingsPane(.usage)
      case .turns: vm?.openSettingsPane(.turns)
      case .control:
        if vm?.settingsPane == .usage || vm?.settingsPane == .turns {
          vm?.openSettingsPane(.general)
        }
      }
    }
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    vm?.refreshDoctorAndBootstrap()
  }

  @MainActor
  private func applyActivationPolicy(keepWindowVisible: Bool) {
    guard let vm = vm else { return }
    let desired: NSApplication.ActivationPolicy = vm.hideDockIcon ? .accessory : .regular
    if NSApp.activationPolicy() != desired {
      let wasVisible = keepWindowVisible && (window?.isVisible ?? false)
      NSApp.setActivationPolicy(desired)
      if wasVisible {
        DispatchQueue.main.async { [weak self] in
          self?.window?.makeKeyAndOrderFront(nil)
          NSApp.activate(ignoringOtherApps: true)
        }
      }
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    MainActor.assumeIsolated {
      if !flag {
        showControlPanel()
      }
      return true
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return false
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
