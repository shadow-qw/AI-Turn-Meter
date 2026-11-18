import AppKit
import Foundation
import SwiftUI

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

struct CardDailyPoint: Decodable, Identifiable {
  var id: String { date }
  let date: String
  let label: String
  let totalTokens: Int
  let costUsd: Double?
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

struct CodexBarCardSnapshot: Decodable {
  let today: CardTodayMetrics
  let currentWindow: CardWindowMetrics
  let days30: CardWindowMetrics
  let daily30: [CardDailyPoint]
  let recentWindows: [CardRecentWindow]
  let topModel: String?
}

struct UsageSummaryResponse: Decodable {
  let days: Int
  let tool: String?
  let today: UsageTotals
  let totals: UsageTotals
  let byTool: [UsageToolRow]
  let byModel: [UsageModelRow]
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
  case tps = "tps"
  case todayCost = "todayCost"
  case todayTokensAndCost = "todayTokensAndCost"
  case latestInline = "latestInline"

  var title: String {
    switch self {
    case .iconOnly: return "仅图标"
    case .tps: return "实时速度"
    case .todayCost: return "今日费用"
    case .todayTokensAndCost: return "今日用量 + 费用"
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
    guard let val = val, val.isFinite else { return "N/A" }
    if val <= 0 { return "$0.00" }
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
  }

  @Published var version: String = "0.2.6"
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

  @Published var showMenuBarExtra: Bool = UserDefaults.standard.object(forKey: PrefKey.showMenuBarExtra) as? Bool ?? true
  @Published var menuBarDisplayMode: MenuBarDisplayMode = {
    if let raw = UserDefaults.standard.string(forKey: PrefKey.menuBarDisplayMode),
       let mode = MenuBarDisplayMode(rawValue: raw) {
      return mode
    }
    return UserDefaults.standard.bool(forKey: PrefKey.showMenuBarSummary) ? .tps : .iconOnly
  }()
  @Published var hideDockIcon: Bool = UserDefaults.standard.bool(forKey: PrefKey.hideDockIcon)
  @Published var launchAtLogin: Bool = FileManager.default.fileExists(
    atPath: (NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents/com.local.ai-turn-meter.app.plist")
  )

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

  private func applyDaemonState(_ parsed: DaemonStateResponse) {
    self.lastSyncedAt = Date()
    if let cfg = parsed.config {
      self.masterEnabled = cfg.enabled
      for (k, v) in cfg.tools { self.toolToggles[k] = v }
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

  func fetchUsageSummary(silent: Bool = false) {
    guard let url = URL(
      string: "http://127.0.0.1:\(daemonPort)/v1/usage?days=\(usageDays)\(usageToolFilter == "all" ? "" : "&tool=\(usageToolFilter)")"
    ) else { return }
    if !silent { usageLoading = true }
    var req = URLRequest(url: url, timeoutInterval: 4)
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
      self.masterEnabled = cfg.enabled
      for (k, v) in cfg.tools { self.toolToggles[k] = v }
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
}

private enum CodexBarPalette {
  static let cardTop = Color(red: 0.05, green: 0.43, blue: 0.96)
  static let cardBottom = Color(red: 0.02, green: 0.27, blue: 0.76)
  static let accentBlue = Color(red: 0.05, green: 0.40, blue: 0.94)
}

struct ContentView: View {
  @ObservedObject var vm: MeterViewModel

  private var installedCount: Int {
    vm.orderedKeys.filter { vm.apps[$0]?.installed ?? false }.count
  }

  private var connectedCount: Int {
    vm.orderedKeys.filter {
      (vm.apps[$0]?.installed ?? false) && vm.isToolEnabled($0) && vm.isActiveOverall
    }.count
  }

  var body: some View {
    VStack(spacing: 0) {
      if vm.runtime.runningFromDmg {
        HStack(spacing: 10) {
          Image(systemName: "externaldrive.badge.exclamationmark")
            .foregroundColor(.orange)
          Text("请先将「AI Turn Meter.app」拖入「应用程序」后再打开使用。")
            .font(.system(size: 12))
          Spacer()
          Button("打开应用程序") { vm.openApplicationsFolder() }
            .buttonStyle(.borderedProminent)
            .tint(.orange)
            .controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Color.orange.opacity(0.12))
      }

      // Top Header + Capsule Tab Bar
      HStack(spacing: 12) {
        HStack(spacing: 9) {
          ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(LinearGradient(
                colors: [CodexBarPalette.cardTop, CodexBarPalette.cardBottom],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              ))
              .frame(width: 28, height: 28)
            Image(systemName: "gauge.with.dots.needle.67percent")
              .font(.system(size: 13.5, weight: .semibold))
              .foregroundColor(.white)
          }

          VStack(alignment: .leading, spacing: 1) {
            Text("AI Turn Meter")
              .font(.system(size: 13, weight: .semibold))
            HStack(spacing: 5) {
              Circle()
                .fill(vm.isActiveOverall ? Color.green : (vm.daemonOnline ? Color.orange : Color.gray.opacity(0.5)))
                .frame(width: 6.5, height: 6.5)
              Text(vm.isActiveOverall ? "运行中" : (vm.daemonOnline ? "已暂停" : "未启动"))
                .font(.system(size: 10.5, weight: .medium))
                .foregroundColor(.secondary)
              Text("v\(vm.version)")
                .font(.system(size: 10))
                .foregroundColor(.secondary.opacity(0.8))
            }
          }
        }

        Spacer(minLength: 8)

        HStack(spacing: 3) {
          ForEach(MainTab.allCases, id: \.self) { tab in
            let selected = vm.activeTab == tab
            Button {
              vm.activeTab = tab
            } label: {
              HStack(spacing: 5) {
                Image(systemName: tab.icon)
                  .font(.system(size: 11, weight: .semibold))
                Text(tab.rawValue)
                  .font(.system(size: 11.5, weight: selected ? .semibold : .medium))
              }
              .padding(.horizontal, 10)
              .padding(.vertical, 5.5)
              .foregroundColor(selected ? .white : .primary.opacity(0.82))
              .background(
                Group {
                  if selected {
                    Capsule().fill(CodexBarPalette.accentBlue)
                  } else {
                    Capsule().fill(Color.clear)
                  }
                }
              )
            }
            .buttonStyle(.plain)
          }
        }
        .padding(3)
        .background(Color.primary.opacity(0.06))
        .clipShape(Capsule())

        Spacer(minLength: 8)

        HStack(spacing: 7) {
          if vm.busy {
            ProgressView().controlSize(.small)
          } else if !vm.daemonOnline && !vm.runtime.runningFromDmg {
            Button("开启后台") { vm.setMasterEnabled(true) }
              .buttonStyle(.borderedProminent)
              .tint(CodexBarPalette.accentBlue)
              .controlSize(.small)
          } else if !vm.masterEnabled && !vm.runtime.runningFromDmg {
            Button("恢复显示") { vm.setMasterEnabled(true) }
              .buttonStyle(.borderedProminent)
              .tint(.orange)
              .controlSize(.small)
          } else if let today = vm.todaySummary {
            Button {
              vm.activeTab = .usage
              vm.fetchUsageSummary()
            } label: {
              HStack(spacing: 5) {
                Text("今日")
                  .font(.system(size: 10.5))
                  .foregroundColor(.secondary)
                Text(MeterFormat.usd(today.estimatedCostUsd))
                  .font(.system(size: 11.5, weight: .semibold))
                  .monospacedDigit()
                  .foregroundColor(.primary)
              }
              .padding(.horizontal, 9)
              .padding(.vertical, 4.5)
              .background(Color.primary.opacity(0.06))
              .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .help("查看今日用量与费用详情")
          }

          Button {
            vm.refreshDoctorAndBootstrap()
            vm.fetchUsageSummary(silent: true)
            if vm.activeTab == .turns { vm.fetchRecentTurns() }
          } label: {
            Image(systemName: "arrow.clockwise")
              .font(.system(size: 11.5, weight: .medium))
              .frame(width: 24, height: 24)
              .background(Color.primary.opacity(0.06))
              .clipShape(Circle())
          }
          .buttonStyle(.plain)
          .help("刷新状态与统计")
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 11)
      .background(Color(nsColor: .windowBackgroundColor))

      Divider()

      if let msg = vm.statusBanner {
        HStack(spacing: 8) {
          Image(systemName: vm.bannerIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
            .foregroundColor(vm.bannerIsError ? .red : .green)
          Text(msg)
            .font(.system(size: 12))
            .lineLimit(3)
          Spacer()
          Button("关闭") { vm.statusBanner = nil }
            .buttonStyle(.plain)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background((vm.bannerIsError ? Color.red : Color.green).opacity(0.1))
        Divider()
      }

      Group {
        switch vm.activeTab {
        case .control:
          ControlPanelTabView(vm: vm)
        case .usage:
          UsageSummaryTabView(vm: vm)
        case .turns:
          RecentTurnsTabView(vm: vm)
        }
      }
      .padding(16)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color(nsColor: .underPageBackgroundColor).opacity(0.45))

      Divider()

      // Footer Status + Maintenance Bar
      HStack(spacing: 10) {
        HStack(spacing: 6) {
          Text(vm.relativeUpdateLabel())
            .font(.system(size: 11))
            .foregroundColor(.secondary)
          Text("·")
            .foregroundColor(.secondary.opacity(0.6))
          Text("\(connectedCount)/\(installedCount) 个客户端监控中")
            .font(.system(size: 11))
            .foregroundColor(.secondary)
        }

        Spacer()

        Button {
          vm.knownSshHosts = MeterRuntime.readSshConfigHosts()
          if vm.sshHost.isEmpty, let first = vm.knownSshHosts.first {
            vm.sshHost = first
          }
          vm.sshApplyStatus = nil
          vm.generateSshSnippet()
          vm.showSshSheet = true
        } label: {
          Label("Remote-SSH", systemImage: "network")
            .font(.system(size: 11.5))
        }
        .buttonStyle(.bordered)
        .controlSize(.small)

        Button {
          vm.checkForUpdates()
        } label: {
          Label("检查更新", systemImage: "arrow.triangle.2.circlepath")
            .font(.system(size: 11.5))
        }
        .buttonStyle(.bordered)
        .controlSize(.small)

        Menu {
          Button("修复或重新同步扩展配置") {
            vm.runAction(args: ["install"], successText: "已重新同步全部配置与扩展")
          }
          Button("刷新全部数据") {
            vm.refreshDoctorAndBootstrap()
            vm.fetchUsageSummary()
            if vm.activeTab == .turns { vm.fetchRecentTurns() }
          }
          if vm.daemonOnline {
            Button(vm.masterEnabled ? "暂停全部显示" : "恢复全部显示") {
              vm.setMasterEnabled(!vm.masterEnabled)
            }
          }
          Divider()
          if vm.daemonOnline {
            Button("彻底退出后台进程") {
              vm.runAction(args: ["stop-daemon"], successText: "后台进程已退出")
            }
          }
          Button("完全卸载本地配置…", role: .destructive) {
            vm.showUninstallAlert = true
          }
        } label: {
          Label("更多", systemImage: "ellipsis.circle")
            .font(.system(size: 11.5))
        }
        .menuStyle(.borderedButton)
        .controlSize(.small)
        .fixedSize()
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 9)
      .background(Color(nsColor: .windowBackgroundColor))
    }
    .frame(minWidth: 640, minHeight: 520)
    .onAppear { vm.ensureStarted() }
    .onChange(of: vm.activeTab) { newTab in
      if newTab == .usage { vm.fetchUsageSummary() }
      else if newTab == .turns { vm.fetchRecentTurns() }
    }
    .alert("确认彻底卸载？", isPresented: $vm.showUninstallAlert) {
      Button("取消", role: .cancel) {}
      Button("卸载", role: .destructive) {
        vm.runAction(args: ["uninstall"], successText: "已移除后台服务、Cursor Hooks 与 IDE 扩展")
      }
    } message: {
      Text("将停止后台服务，移除开机自启、Cursor Hooks 与 IDE 扩展；历史统计库会保留。")
    }
    .sheet(isPresented: $vm.showSshSheet) {
      RemoteSshSheetView(vm: vm)
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
}

struct ControlPanelTabView: View {
  @ObservedObject var vm: MeterViewModel

  private let gridCols = [
    GridItem(.flexible(), spacing: 10),
    GridItem(.flexible(), spacing: 10),
  ]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        if vm.isActiveOverall && !vm.appsNeedingInlineCdp.isEmpty {
          HStack(spacing: 10) {
            Image(systemName: "sparkles")
              .font(.system(size: 14, weight: .semibold))
              .foregroundColor(CodexBarPalette.accentBlue)
            VStack(alignment: .leading, spacing: 2) {
              Text("有客户端尚未开启消息旁胶囊")
                .font(.system(size: 12, weight: .semibold))
              Text("Codex / Cursor / CodeBuddy 支持重启接入，直接在每条消息旁展示用量与速率。")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
            }
            Spacer()
            Button("一键全部接入") {
              vm.runAction(args: ["open", "all"], successText: "已开启全部消息旁显示")
            }
            .buttonStyle(.borderedProminent)
            .tint(CodexBarPalette.accentBlue)
            .controlSize(.small)
            .disabled(vm.busy || vm.runtime.runningFromDmg)
          }
          .padding(12)
          .background(CodexBarPalette.accentBlue.opacity(0.09))
          .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
              .stroke(CodexBarPalette.accentBlue.opacity(0.22), lineWidth: 1)
          )
        }

        // 2x2 Client Cards
        VStack(alignment: .leading, spacing: 8) {
          Text("受监控客户端")
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(.secondary)
            .padding(.horizontal, 2)

          LazyVGrid(columns: gridCols, spacing: 10) {
            ForEach(vm.orderedKeys, id: \.self) { key in
              clientCard(key: key)
            }
          }
        }

        // Grouped System-Settings-Style Preferences
        VStack(alignment: .leading, spacing: 8) {
          Text("菜单栏、驻留与远程")
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(.secondary)
            .padding(.horizontal, 2)

          VStack(spacing: 0) {
            preferenceRow(
              icon: "menubar.rectangle",
              iconColor: CodexBarPalette.accentBlue,
              title: "显示顶部菜单栏状态图标",
              subtitle: "在系统顶部菜单栏常驻展示概览卡片与实时数据"
            ) {
              Toggle("", isOn: Binding(
                get: { vm.showMenuBarExtra },
                set: { vm.setShowMenuBarExtra($0) }
              ))
              .toggleStyle(.switch)
              .labelsHidden()
              .controlSize(.small)
            }

            if vm.showMenuBarExtra {
              Divider().padding(.leading, 44)
              preferenceRow(
                icon: "textformat.123",
                iconColor: Color.indigo,
                title: "菜单栏标题内容",
                subtitle: "决定顶部状态图标右侧附加的简短实时数值"
              ) {
                Picker("", selection: Binding(
                  get: { vm.menuBarDisplayMode },
                  set: { vm.setMenuBarDisplayMode($0) }
                )) {
                  ForEach(MenuBarDisplayMode.allCases, id: \.self) { m in
                    Text(m.title).tag(m)
                  }
                }
                .labelsHidden()
                .frame(width: 155)
                .controlSize(.small)
              }
            }

            Divider().padding(.leading, 44)
            preferenceRow(
              icon: "dock.rectangle",
              iconColor: Color.purple,
              title: "隐藏程序坞 (Dock) 图标",
              subtitle: "开启后应用仅驻留在顶部菜单栏，不占用程序坞图标位置"
            ) {
              Toggle("", isOn: Binding(
                get: { vm.hideDockIcon },
                set: { vm.setHideDockIcon($0) }
              ))
              .toggleStyle(.switch)
              .labelsHidden()
              .controlSize(.small)
            }

            Divider().padding(.leading, 44)
            preferenceRow(
              icon: "power",
              iconColor: Color.green,
              title: "开机自动启动菜单栏",
              subtitle: "登录 macOS 时静默后台启动并保持采集统计"
            ) {
              Toggle("", isOn: Binding(
                get: { vm.launchAtLogin },
                set: { vm.setLaunchAtLogin($0) }
              ))
              .toggleStyle(.switch)
              .labelsHidden()
              .controlSize(.small)
              .disabled(vm.busy || vm.runtime.runningFromDmg)
            }

            Divider().padding(.leading, 44)
            preferenceRow(
              icon: "network",
              iconColor: Color.orange,
              title: "Cursor Remote-SSH 远程写入",
              subtitle: "自动向 ~/.ssh/config 与远端主机注入端口转发与统计支持"
            ) {
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
          .background(Color(nsColor: .controlBackgroundColor))
          .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(Color.primary.opacity(0.07), lineWidth: 1)
          )
        }
      }
      .padding(.bottom, 4)
    }
  }

  @ViewBuilder
  private func clientCard(key: String) -> some View {
    let entry = vm.apps[key]
    let installed = entry?.installed ?? false
    let enabled = vm.isToolEnabled(key)
    let active = installed && vm.isActiveOverall && enabled
    let accent = vm.toolAccentColor(for: key)
    let needsInline = installed && vm.isActiveOverall && enabled && key != "antigravity" && entry?.cdpPort == nil

    VStack(alignment: .leading, spacing: 9) {
      HStack(spacing: 9) {
        ZStack {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(installed ? accent.opacity(0.14) : Color.primary.opacity(0.06))
            .frame(width: 30, height: 30)
          Image(systemName: ToolGlyph.iconName(for: key))
            .font(.system(size: 13.5, weight: .semibold))
            .foregroundColor(installed ? accent : .secondary)
        }

        VStack(alignment: .leading, spacing: 2) {
          Text(vm.displayTitle(for: key))
            .font(.system(size: 13, weight: .semibold))
            .foregroundColor(installed ? .primary : .secondary)
            .lineLimit(1)

          HStack(spacing: 4) {
            Circle()
              .fill(active ? (entry?.cdpPort != nil ? Color.green : accent) : (installed ? Color.orange : Color.gray.opacity(0.45)))
              .frame(width: 6, height: 6)
            Text(
              !installed
                ? "未安装"
                : (!vm.masterEnabled
                    ? "全局暂停"
                    : (!enabled
                        ? "已关闭"
                        : (entry?.cdpPort != nil ? "消息旁胶囊已连接" : "状态栏就绪")))
            )
            .font(.system(size: 10.5))
            .foregroundColor(.secondary)
            .lineLimit(1)
          }
        }

        Spacer(minLength: 4)

        Toggle("", isOn: Binding(
          get: { installed && enabled && vm.isActiveOverall },
          set: { vm.setToolEnabled(key, enabled: $0) }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
        .controlSize(.small)
        .disabled(!installed || vm.busy || vm.runtime.runningFromDmg)
      }

      Text(vm.appSubtitle(for: key))
        .font(.system(size: 11))
        .foregroundColor(.secondary)
        .lineLimit(2)
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .topLeading)

      HStack(spacing: 8) {
        if needsInline {
          Button(vm.inlineBtnLabel(for: key)) {
            vm.runAction(args: ["open", key], successText: "已为 \(vm.displayTitle(for: key)) 开启消息旁显示")
          }
          .buttonStyle(.borderedProminent)
          .tint(accent)
          .controlSize(.mini)
          .disabled(vm.busy)
        } else if let port = entry?.cdpPort, active {
          Text("CDP :\(port)")
            .font(.system(size: 10, weight: .medium))
            .monospacedDigit()
            .foregroundColor(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.primary.opacity(0.05))
            .clipShape(Capsule())
        } else if let ver = vm.vsixVersions[key], installed {
          Text("扩展 v\(ver)")
            .font(.system(size: 10))
            .foregroundColor(.secondary)
        }

        Spacer()

        if installed {
          Button("历史") {
            vm.recentTurnsFilterTool = key
            vm.activeTab = .turns
            vm.fetchRecentTurns()
          }
          .buttonStyle(.borderless)
          .font(.system(size: 11, weight: .medium))
          .foregroundColor(accent)

          if let appPath = entry?.appPath {
            Button("打开") {
              NSWorkspace.shared.open(URL(fileURLWithPath: appPath))
            }
            .buttonStyle(.borderless)
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(.secondary)
          }
        }
      }
    }
    .padding(12)
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(active ? accent.opacity(0.22) : Color.primary.opacity(0.07), lineWidth: 1)
    )
    .opacity(installed ? 1.0 : 0.6)
  }

  private func preferenceRow<Accessory: View>(
    icon: String,
    iconColor: Color,
    title: String,
    subtitle: String,
    @ViewBuilder accessory: () -> Accessory
  ) -> some View {
    HStack(spacing: 12) {
      ZStack {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(iconColor.opacity(0.14))
          .frame(width: 26, height: 26)
        Image(systemName: icon)
          .font(.system(size: 12, weight: .semibold))
          .foregroundColor(iconColor)
      }

      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 12.5, weight: .medium))
        Text(subtitle)
          .font(.system(size: 10.5))
          .foregroundColor(.secondary)
          .lineLimit(1)
      }

      Spacer(minLength: 10)
      accessory()
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }
}

struct UsageSummaryTabView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var hoveredDay: UsageDailyPoint? = nil

  private let dayOptions: [(Int, String)] = [
    (1, "今日"),
    (7, "近 7 天"),
    (30, "近 30 天"),
    (0, "全部"),
  ]

  private var selectedPeriodTitle: String {
    dayOptions.first(where: { $0.0 == vm.usageDays })?.1 ?? "近 \(vm.usageDays) 天"
  }

  private var selectedToolLabel: String {
    vm.usageToolFilter == "all" ? "全部客户端" : vm.displayTitle(for: vm.usageToolFilter)
  }

  var body: some View {
    VStack(spacing: 11) {
      // Modern Capsule Filters Row
      HStack(spacing: 8) {
        HStack(spacing: 3) {
          ForEach(dayOptions, id: \.0) { opt in
            let active = vm.usageDays == opt.0
            Button(opt.1) {
              vm.usageDays = opt.0
              vm.fetchUsageSummary()
            }
            .buttonStyle(.plain)
            .font(.system(size: 11, weight: active ? .semibold : .medium))
            .foregroundColor(active ? .white : .secondary)
            .padding(.horizontal, 9)
            .padding(.vertical, 4.5)
            .background(active ? CodexBarPalette.accentBlue : Color.clear)
            .clipShape(Capsule())
          }
        }
        .padding(3)
        .background(Color.primary.opacity(0.06))
        .clipShape(Capsule())

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
        }
      }

      if let data = vm.usageData {
        ScrollView {
          VStack(spacing: 11) {
            // CodexBar-style Deep Blue Hero Card
            VStack(alignment: .leading, spacing: 14) {
              HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                  HStack(spacing: 6) {
                    Text(selectedToolLabel)
                      .font(.system(size: 14, weight: .bold))
                      .foregroundColor(.white)
                    Text("·")
                      .foregroundColor(.white.opacity(0.55))
                    Text(selectedPeriodTitle)
                      .font(.system(size: 12.5, weight: .medium))
                      .foregroundColor(.white.opacity(0.86))
                  }
                  Text("按模型官方 API 单价估算 · 本地离线统计，非订阅账单")
                    .font(.system(size: 10.5))
                    .foregroundColor(.white.opacity(0.72))
                }
                Spacer()
                Text(vm.relativeUpdateLabel())
                  .font(.system(size: 10.5, weight: .medium))
                  .foregroundColor(.white.opacity(0.9))
                  .padding(.horizontal, 8)
                  .padding(.vertical, 3)
                  .background(Color.white.opacity(0.16))
                  .clipShape(Capsule())
              }

              HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                  Text("API 等效估算费用")
                    .font(.system(size: 11))
                    .foregroundColor(.white.opacity(0.78))
                  Text(MeterFormat.usd(data.totals.estimatedCostUsd))
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(.white)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)

                  HStack(spacing: 8) {
                    if let saved = data.totals.cacheSavingsUsd, saved > 0 {
                      Text("缓存节省 \(MeterFormat.usd(saved))")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.white.opacity(0.92))
                    } else if data.totals.unpricedTurnCount > 0 {
                      Text("含 \(data.totals.unpricedTurnCount) 轮未定价模型")
                        .font(.system(size: 11))
                        .foregroundColor(.white.opacity(0.8))
                    } else {
                      Text("共 \(data.totals.turnCount) 轮对话")
                        .font(.system(size: 11))
                        .foregroundColor(.white.opacity(0.85))
                    }
                  }
                }
                .frame(minWidth: 165, alignment: .leading)

                Spacer(minLength: 4)

                VStack(spacing: 7) {
                  HStack(spacing: 7) {
                    heroTile(
                      title: "总 Token",
                      value: MeterFormat.tokens(data.totals.totalTokens),
                      sub: "入 \(MeterFormat.tokens(data.totals.totalInputTokens)) · 出 \(MeterFormat.tokens(data.totals.outputTokens))"
                    )
                    heroTile(
                      title: "平均缓存命中",
                      value: MeterFormat.pct(data.totals.cacheRatePct),
                      sub: "\(data.totals.turnCount) 轮 · \(data.totals.callCount) 次"
                    )
                  }
                  HStack(spacing: 7) {
                    heroTile(
                      title: "平均输出速度",
                      value: MeterFormat.tps(data.totals.avgTps),
                      sub: "基于模型流式采样"
                    )
                    heroTile(
                      title: "今日已消耗",
                      value: MeterFormat.usd(data.today.estimatedCostUsd),
                      sub: "\(MeterFormat.tokens(data.today.totalTokens)) token"
                    )
                  }
                }
              }
            }
            .padding(14)
            .background(
              LinearGradient(
                colors: [CodexBarPalette.cardTop, CodexBarPalette.cardBottom],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))

            // Daily Trend Bars (Hover Interactive)
            if !data.daily.isEmpty {
              let visibleDays = Array(data.daily.suffix(14))
              let maxTok = max(1, visibleDays.map(\.totalTokens).max() ?? 1)
              let maxUsd = visibleDays.compactMap(\.estimatedCostUsd).max() ?? 0

              VStack(alignment: .leading, spacing: 8) {
                HStack {
                  Text("每日用量趋势")
                    .font(.system(size: 12, weight: .semibold))
                  Spacer()
                  if let pt = hoveredDay {
                    Text("\(pt.date) · \(MeterFormat.usd(pt.estimatedCostUsd)) · \(MeterFormat.tokens(pt.totalTokens)) (\(pt.turnCount) 轮)")
                      .font(.system(size: 11, weight: .semibold))
                      .monospacedDigit()
                      .foregroundColor(CodexBarPalette.accentBlue)
                  } else {
                    Text(maxUsd > 0 ? "日峰值 \(MeterFormat.usd(maxUsd)) · 悬停柱条查看详情" : "悬停柱条查看单日明细")
                      .font(.system(size: 10.5))
                      .foregroundColor(.secondary)
                  }
                }

                HStack(alignment: .bottom, spacing: 6) {
                  ForEach(visibleDays) { pt in
                    let frac = CGFloat(pt.totalTokens) / CGFloat(maxTok)
                    let isHovered = hoveredDay?.id == pt.id
                    VStack(spacing: 3) {
                      if pt.totalTokens > 0 {
                        Text(MeterFormat.usd(pt.estimatedCostUsd))
                          .font(.system(size: 9))
                          .monospacedDigit()
                          .foregroundColor(isHovered ? CodexBarPalette.accentBlue : .secondary)
                          .lineLimit(1)
                      }
                      RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(
                          pt.totalTokens > 0
                            ? LinearGradient(
                                colors: isHovered
                                  ? [CodexBarPalette.accentBlue, CodexBarPalette.cardTop]
                                  : [CodexBarPalette.cardTop.opacity(0.85), CodexBarPalette.cardBottom.opacity(0.75)],
                                startPoint: .top,
                                endPoint: .bottom
                              )
                            : LinearGradient(
                                colors: [Color.primary.opacity(0.08), Color.primary.opacity(0.08)],
                                startPoint: .top,
                                endPoint: .bottom
                              )
                        )
                        .frame(height: max(4, frac * 60))
                      Text(MeterFormat.shortDate(pt.date))
                        .font(.system(size: 9.5, weight: isHovered ? .semibold : .regular))
                        .foregroundColor(isHovered ? .primary : .secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                    .onHover { hovering in
                      if hovering { hoveredDay = pt }
                      else if hoveredDay?.id == pt.id { hoveredDay = nil }
                    }
                  }
                }
                .frame(height: 94, alignment: .bottom)
              }
              .padding(12)
              .background(Color(nsColor: .controlBackgroundColor))
              .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
              .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                  .stroke(Color.primary.opacity(0.07), lineWidth: 1)
              )
            }

            // Breakdown Card: Ranked by Model or Client
            VStack(alignment: .leading, spacing: 10) {
              HStack {
                HStack(spacing: 3) {
                  groupModeButton(id: "model", label: "按模型排行")
                  groupModeButton(id: "tool", label: "按客户端占比")
                }
                .padding(3)
                .background(Color.primary.opacity(0.06))
                .clipShape(Capsule())

                Spacer()
                Text("支持 ~/.local/share/ai-turn-meter/custom-pricing.json 自定义单价")
                  .font(.system(size: 10))
                  .foregroundColor(.secondary)
              }

              if vm.usageGroupMode == "tool" {
                if data.byTool.isEmpty {
                  emptyTip("所选周期内暂无统计记录")
                } else {
                  ForEach(Array(data.byTool.enumerated()), id: \.element.id) { idx, row in
                    breakdownRow(
                      rank: idx + 1,
                      color: vm.toolAccentColor(for: row.tool),
                      title: row.toolLabel,
                      badge: "\(String(format: "%.1f", row.sharePct))%",
                      share: row.sharePct / 100.0,
                      detail: "\(row.turnCount) 轮 · \(row.callCount) 次 · 入 \(MeterFormat.tokens(row.totalInputTokens)) (缓存 \(MeterFormat.pct(row.cacheRatePct))) · 出 \(MeterFormat.tokens(row.outputTokens)) · \(MeterFormat.tps(row.avgTps))",
                      costText: MeterFormat.usd(row.estimatedCostUsd)
                    )
                  }
                }
              } else {
                if data.byModel.isEmpty {
                  emptyTip("所选周期内暂无模型记录")
                } else {
                  ForEach(Array(data.byModel.prefix(15).enumerated()), id: \.element.id) { idx, row in
                    breakdownRow(
                      rank: idx + 1,
                      color: vm.toolAccentColor(for: row.tool),
                      title: row.model,
                      badge: row.toolLabel,
                      share: row.sharePct / 100.0,
                      detail: "\(row.turnCount) 轮 · \(row.callCount) 次 · 入 \(MeterFormat.tokens(row.totalInputTokens)) (缓存 \(MeterFormat.pct(row.cacheRatePct))) · 出 \(MeterFormat.tokens(row.outputTokens)) · \(MeterFormat.tps(row.avgTps))",
                      costText: row.priced ? MeterFormat.usd(row.estimatedCostUsd) : "未定价"
                    )
                  }
                }
              }
            }
            .padding(12)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.primary.opacity(0.07), lineWidth: 1)
            )
          }
          .padding(.bottom, 4)
        }
      } else {
        Spacer()
        Text(vm.usageLoading ? "正在加载统计数据…" : "暂无统计数据")
          .font(.system(size: 12.5))
          .foregroundColor(.secondary)
        Spacer()
      }
    }
  }

  private func filterChip(key: String, label: String) -> some View {
    let active = vm.usageToolFilter == key
    let color = vm.toolAccentColor(for: key)
    return Button {
      vm.usageToolFilter = key
      vm.fetchUsageSummary()
    } label: {
      HStack(spacing: 4) {
        if key != "all" {
          Circle().fill(active ? Color.white : color).frame(width: 6, height: 6)
        }
        Text(label)
          .font(.system(size: 11, weight: active ? .semibold : .medium))
      }
      .foregroundColor(active ? .white : .primary.opacity(0.82))
      .padding(.horizontal, 9)
      .padding(.vertical, 4.5)
      .background(active ? color : Color.primary.opacity(0.06))
      .clipShape(Capsule())
    }
    .buttonStyle(.plain)
  }

  private func groupModeButton(id: String, label: String) -> some View {
    let active = vm.usageGroupMode == id
    return Button(label) {
      vm.usageGroupMode = id
    }
    .buttonStyle(.plain)
    .font(.system(size: 11, weight: active ? .semibold : .medium))
    .foregroundColor(active ? .white : .secondary)
    .padding(.horizontal, 10)
    .padding(.vertical, 4)
    .background(active ? CodexBarPalette.accentBlue : Color.clear)
    .clipShape(Capsule())
  }

  private func heroTile(title: String, value: String, sub: String) -> some View {
    VStack(alignment: .leading, spacing: 2.5) {
      Text(title)
        .font(.system(size: 10))
        .foregroundColor(.white.opacity(0.75))
      Text(value)
        .font(.system(size: 14, weight: .bold))
        .monospacedDigit()
        .foregroundColor(.white)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
      Text(sub)
        .font(.system(size: 9.5))
        .foregroundColor(.white.opacity(0.72))
        .lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(Color.white.opacity(0.14))
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
  }

  private func breakdownRow(
    rank: Int,
    color: Color,
    title: String,
    badge: String,
    share: Double,
    detail: String,
    costText: String
  ) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        Text("#\(rank)")
          .font(.system(size: 10, weight: .bold))
          .monospacedDigit()
          .foregroundColor(rank <= 3 ? color : .secondary)
          .frame(width: 22, alignment: .leading)

        Circle()
          .fill(color)
          .frame(width: 7, height: 7)

        Text(title)
          .font(.system(size: 12, weight: .semibold))
          .lineLimit(1)

        Text(badge)
          .font(.system(size: 10, weight: .medium))
          .foregroundColor(color)
          .padding(.horizontal, 6)
          .padding(.vertical, 1.5)
          .background(color.opacity(0.12))
          .clipShape(Capsule())

        Spacer()

        Text(costText)
          .font(.system(size: 12.5, weight: .bold))
          .monospacedDigit()
      }

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.primary.opacity(0.08))
          Capsule()
            .fill(color.opacity(0.85))
            .frame(width: max(4, geo.size.width * CGFloat(min(1, max(0, share)))))
        }
      }
      .frame(height: 5.5)

      Text(detail)
        .font(.system(size: 10.5))
        .foregroundColor(.secondary)
        .monospacedDigit()
        .lineLimit(1)
    }
    .padding(.vertical, 4)
  }

  private func emptyTip(_ msg: String) -> some View {
    Text(msg)
      .font(.system(size: 11.5))
      .foregroundColor(.secondary)
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.vertical, 18)
  }
}

struct RecentTurnsTabView: View {
  @ObservedObject var vm: MeterViewModel

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
    let color = vm.toolAccentColor(for: key)
    return Button {
      vm.recentTurnsFilterTool = key
      vm.fetchRecentTurns()
    } label: {
      HStack(spacing: 4) {
        if key != "all" {
          Circle().fill(active ? Color.white : color).frame(width: 6, height: 6)
        }
        Text(label)
          .font(.system(size: 11, weight: active ? .semibold : .medium))
      }
      .foregroundColor(active ? .white : .primary.opacity(0.82))
      .padding(.horizontal, 9)
      .padding(.vertical, 4.5)
      .background(active ? color : Color.primary.opacity(0.06))
      .clipShape(Capsule())
    }
    .buttonStyle(.plain)
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

private struct ProviderSwitcherBar: View {
  @ObservedObject var vm: MeterViewModel
  @Binding var selection: String

  private let switcherKeys = ["all", "codex", "cursor", "antigravity", "codebuddy"]

  var body: some View {
    HStack(spacing: 4) {
      ForEach(switcherKeys, id: \.self) { key in
        let isSelected = selection == key
        let isAll = key == "all"
        let entry = vm.apps[key]
        let installed = isAll || (entry?.installed ?? false)
        let active = !isAll && installed && vm.isActiveOverall && vm.isToolEnabled(key)
        let indicatorColor: Color = {
          if isAll { return .clear }
          if active { return vm.toolAccentColor(for: key) }
          if installed { return Color.gray.opacity(0.35) }
          return .clear
        }()

        Button {
          selection = key
        } label: {
          VStack(spacing: 3) {
            Image(systemName: ToolGlyph.iconName(for: key))
              .font(.system(size: 13.5, weight: .semibold))
              .frame(height: 15)
            Text(vm.toolShortTitle(for: key))
              .font(.system(size: 9.5, weight: isSelected ? .semibold : .medium))
              .lineLimit(1)
              .minimumScaleFactor(0.78)
          }
          .foregroundColor(isSelected ? .white : (installed ? .primary.opacity(0.82) : .secondary.opacity(0.55)))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 6)
          .padding(.horizontal, 2)
          .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(isSelected ? CodexBarPalette.accentBlue : Color.clear)
          )
          .overlay(alignment: .bottom) {
            if !isSelected && indicatorColor != .clear {
              Capsule()
                .fill(indicatorColor)
                .frame(width: 24, height: 2.5)
                .offset(y: 1)
            }
          }
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.horizontal, 10)
    .padding(.top, 8)
    .padding(.bottom, 6)
  }
}

private struct MiniUsageBarsView: View {
  let points: [CardDailyPoint]
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

    VStack(spacing: 4) {
      HStack {
        if let pt = hovered {
          Text("\(pt.label) · \(MeterFormat.usd(pt.costUsd)) · \(MeterFormat.tokens(pt.totalTokens))")
            .font(.system(size: 10, weight: .semibold))
            .monospacedDigit()
            .foregroundColor(.white)
            .lineLimit(1)
        } else {
          Text("近 30 天趋势")
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(.white.opacity(0.72))
        }
        Spacer()
        Text(peakLabel)
          .font(.system(size: 10.5, weight: .semibold))
          .monospacedDigit()
          .foregroundColor(.white.opacity(0.88))
      }

      HStack(alignment: .bottom, spacing: 2.5) {
        ForEach(points) { pt in
          let val = metricValue(pt)
          let ratio = val > 0 ? CGFloat(val / maxVal) : 0
          let isHovered = hovered?.id == pt.id

          RoundedRectangle(cornerRadius: 2, style: .continuous)
            .fill(
              val > 0
                ? Color.white.opacity(isHovered ? 1.0 : 0.82)
                : Color.white.opacity(isHovered ? 0.55 : 0.25)
            )
            .frame(maxWidth: .infinity)
            .frame(height: val > 0 ? max(5, ratio * 34) : 2.5)
            .contentShape(Rectangle())
            .onHover { inside in
              if inside { hovered = pt }
              else if hovered?.id == pt.id { hovered = nil }
            }
        }
      }
      .frame(height: 36, alignment: .bottom)
    }
  }
}

private struct CodexBarStyleCardView: View {
  @ObservedObject var vm: MeterViewModel
  let selection: String
  let card: CodexBarCardSnapshot

  private var isAll: Bool { selection == "all" }

  private var headerTitle: String {
    isAll ? "全部客户端" : vm.displayTitle(for: selection)
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

  private var visibleWindows: [CardRecentWindow] {
    card.recentWindows.filter { $0.index == 0 || $0.turnCount > 0 }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 11) {
      // Card Header
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 2) {
          Text(headerTitle)
            .font(.system(size: 16, weight: .bold))
            .foregroundColor(.white)
          Text(vm.relativeUpdateLabel())
            .font(.system(size: 10.5))
            .foregroundColor(.white.opacity(0.78))
        }

        Spacer()

        VStack(alignment: .trailing, spacing: 2) {
          Text(statusLabel)
            .font(.system(size: 11.5, weight: .semibold))
            .foregroundColor(.white)
          Text(
            latestTurn?.model != nil && latestTurn?.model != "unknown"
              ? latestTurn!.model!
              : "本地 Token 统计"
          )
          .font(.system(size: 10))
          .foregroundColor(.white.opacity(0.76))
          .lineLimit(1)
        }
      }

      // Bar 1: Latest Turn Cache Hit + TPS
      progressBlock(
        title: "最近一轮缓存",
        pct: latestTurn?.cacheRatePct,
        rightText: (latestTurn?.tps ?? 0) > 0 ? MeterFormat.tps(latestTurn?.tps) : "等待采样",
        subtitle: {
          if let t = latestTurn {
            let costStr = t.estimatedCostUsd != nil ? " · 本轮 \(MeterFormat.usd(t.estimatedCostUsd))" : ""
            return "入 \(MeterFormat.tokens(t.totalInputTokens)) · 出 \(MeterFormat.tokens(t.outputTokens))\(costStr)"
          }
          return "完成下一轮 AI 回复后自动更新速率与缓存命中"
        }()
      )

      // Bar 2: Today Cache Efficiency & Savings
      progressBlock(
        title: "今日缓存效率",
        pct: card.today.cacheRatePct,
        rightText: "\(card.today.turnCount) 轮 · \(card.today.callCount) 次",
        subtitle: {
          if let saved = card.today.cacheSavingsUsd, saved > 0 {
            return "今日已省 \(MeterFormat.usd(saved)) · 均速 \(MeterFormat.tps(card.today.avgTps))"
          }
          return "今日平均速度 \(MeterFormat.tps(card.today.avgTps)) · 共 \(MeterFormat.tokens(card.today.totalTokens))"
        }()
      )

      Rectangle()
        .fill(Color.white.opacity(0.2))
        .frame(height: 1)

      // Cost & Usage 3x2 Dual-Column Grid
      VStack(alignment: .leading, spacing: 8) {
        Text("费用与用量")
          .font(.system(size: 12.5, weight: .bold))
          .foregroundColor(.white)

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
          leftLabel: "30d",
          leftVal: MeterFormat.usd(card.days30.costUsd),
          rightLabel: "近 30 天 token 用量",
          rightVal: MeterFormat.tokens(card.days30.totalTokens)
        )
      }

      // 30-day Mini Usage Chart
      if !card.daily30.isEmpty {
        MiniUsageBarsView(points: card.daily30)
      }

      // Recent Rolling 7-day Windows
      if !visibleWindows.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text("最近窗口")
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(.white.opacity(0.92))

          ForEach(visibleWindows) { win in
            HStack(alignment: .top) {
              VStack(alignment: .leading, spacing: 1) {
                Text(win.title)
                  .font(.system(size: 11.5, weight: .semibold))
                  .foregroundColor(.white)
                Text("估算：\(win.rangeText)")
                  .font(.system(size: 9.5))
                  .foregroundColor(.white.opacity(0.72))
              }
              Spacer()
              Text("\(MeterFormat.usd(win.costUsd)) · \(MeterFormat.tokens(win.totalTokens))")
                .font(.system(size: 11.5, weight: .semibold))
                .monospacedDigit()
                .foregroundColor(.white)
            }
          }
        }
      }

      // Footer Model & Disclaimer
      VStack(alignment: .leading, spacing: 1.5) {
        if let topModel = card.topModel {
          Text("最常用模型：\(topModel)")
            .font(.system(size: 10.5, weight: .medium))
            .foregroundColor(.white.opacity(0.9))
            .lineLimit(1)
        }
        Text("根据 Token 用量估算 · 不是订阅账单")
          .font(.system(size: 9.5))
          .foregroundColor(.white.opacity(0.7))
      }
    }
    .padding(13)
    .background(
      LinearGradient(
        colors: [CodexBarPalette.cardTop, CodexBarPalette.cardBottom],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
    )
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .padding(.horizontal, 10)
  }

  private func progressBlock(title: String, pct: Double?, rightText: String, subtitle: String) -> some View {
    let clamped = min(1.0, max(0.0, (pct ?? 0) / 100.0))
    let headline = pct != nil ? "\(title) \(MeterFormat.pct(pct))" : title

    return VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(headline)
          .font(.system(size: 12, weight: .bold))
          .foregroundColor(.white)
        Spacer()
        Text(rightText)
          .font(.system(size: 10.5, weight: .medium))
          .monospacedDigit()
          .foregroundColor(.white.opacity(0.88))
          .lineLimit(1)
      }

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule()
            .fill(Color.white.opacity(0.22))
          if clamped > 0 {
            Capsule()
              .fill(Color.white.opacity(0.95))
              .frame(width: max(5, geo.size.width * CGFloat(clamped)))
          }
          // Subtle 25/50/75 tick marks
          HStack {
            Spacer()
            Rectangle().fill(Color.white.opacity(0.28)).frame(width: 1, height: 7)
            Spacer()
            Rectangle().fill(Color.white.opacity(0.28)).frame(width: 1, height: 7)
            Spacer()
            Rectangle().fill(Color.white.opacity(0.28)).frame(width: 1, height: 7)
            Spacer()
          }
        }
      }
      .frame(height: 6.5)

      Text(subtitle)
        .font(.system(size: 10))
        .foregroundColor(.white.opacity(0.8))
        .lineLimit(1)
    }
  }

  private func metricGridRow(
    leftLabel: String,
    leftVal: String,
    rightLabel: String,
    rightVal: String
  ) -> some View {
    HStack(alignment: .top, spacing: 10) {
      VStack(alignment: .leading, spacing: 1.5) {
        Text(leftLabel)
          .font(.system(size: 10.5, weight: .medium))
          .foregroundColor(.white.opacity(0.84))
        Text(leftVal)
          .font(.system(size: 15, weight: .bold))
          .monospacedDigit()
          .foregroundColor(.white)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      VStack(alignment: .leading, spacing: 1.5) {
        Text(rightLabel)
          .font(.system(size: 10.5, weight: .medium))
          .foregroundColor(.white.opacity(0.84))
          .lineLimit(1)
        Text(rightVal)
          .font(.system(size: 15, weight: .bold))
          .monospacedDigit()
          .foregroundColor(.white)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
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
      HStack(spacing: 8) {
        Text(title)
          .font(.system(size: 12.5))
          .foregroundColor(.primary)
        Spacer()
        if let badge = badgeText, !badge.isEmpty {
          Text(badge)
            .font(.system(size: 10.5))
            .foregroundColor(.secondary)
        }
        if let trailing = trailingSymbol {
          Image(systemName: trailing)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundColor(.secondary)
        }
        if let shortcut = shortcut {
          Text(shortcut)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 5.5)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(hovering ? Color.primary.opacity(0.08) : Color.clear)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

struct MenuBarPopoverView: View {
  @ObservedObject var vm: MeterViewModel
  let onOpenMainTab: (MainTab) -> Void
  let onCheckUpdates: () -> Void
  let onClosePopover: () -> Void

  @State private var showDisplayPrefs = false

  private var activeCard: CodexBarCardSnapshot {
    if let snapshot = vm.usageData?.cards?[vm.popoverSelection] {
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
      today: emptyToday,
      currentWindow: emptyWin,
      days30: emptyWin,
      daily30: [],
      recentWindows: [],
      topModel: nil
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ProviderSwitcherBar(vm: vm, selection: $vm.popoverSelection)

      CodexBarStyleCardView(vm: vm, selection: vm.popoverSelection, card: activeCard)

      // Quick Client / Status Context Strip
      quickContextSection
        .padding(.horizontal, 10)
        .padding(.vertical, 7)

      Divider().padding(.horizontal, 10)

      // Expandable Display & Autostart Settings + Main Navigation Actions
      VStack(spacing: 1) {
        PopoverActionRow(
          title: "显示样式与驻留",
          trailingSymbol: showDisplayPrefs ? "chevron.down" : "chevron.right",
          badgeText: vm.menuBarDisplayMode.title
        ) {
          showDisplayPrefs.toggle()
        }

        if showDisplayPrefs {
          VStack(alignment: .leading, spacing: 7) {
            HStack {
              Text("菜单栏文本")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
              Spacer()
              Picker("", selection: Binding(
                get: { vm.menuBarDisplayMode },
                set: { vm.setMenuBarDisplayMode($0) }
              )) {
                ForEach(MenuBarDisplayMode.allCases, id: \.self) { m in
                  Text(m.title).tag(m)
                }
              }
              .labelsHidden()
              .frame(width: 145)
              .controlSize(.small)
            }

            Toggle("隐藏程序坞 (Dock) 图标", isOn: Binding(
              get: { vm.hideDockIcon },
              set: { vm.setHideDockIcon($0) }
            ))
            .toggleStyle(.switch)
            .controlSize(.mini)
            .font(.system(size: 11.5))

            if !vm.runtime.runningFromDmg {
              Toggle("开机自动启动菜单栏", isOn: Binding(
                get: { vm.launchAtLogin },
                set: { vm.setLaunchAtLogin($0) }
              ))
              .toggleStyle(.switch)
              .controlSize(.mini)
              .font(.system(size: 11.5))
              .disabled(vm.busy)
            }

            if vm.daemonOnline && !vm.runtime.runningFromDmg {
              Button(vm.masterEnabled ? "暂停全部监控显示" : "恢复全部监控显示") {
                vm.setMasterEnabled(!vm.masterEnabled)
              }
              .buttonStyle(.bordered)
              .controlSize(.mini)
            }
          }
          .padding(9)
          .background(Color.primary.opacity(0.04))
          .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
          .padding(.horizontal, 6)
          .padding(.vertical, 4)
        }

        PopoverActionRow(title: "用量仪表盘…") {
          onClosePopover()
          onOpenMainTab(.usage)
        }

        PopoverActionRow(title: "最近轮次明细…") {
          onClosePopover()
          onOpenMainTab(.turns)
        }

        PopoverActionRow(title: "控制面板与设置…", shortcut: "⌘ ,") {
          onClosePopover()
          onOpenMainTab(.control)
        }
        .keyboardShortcut(",", modifiers: .command)
      }
      .padding(.horizontal, 6)
      .padding(.vertical, 4)

      Divider().padding(.horizontal, 10)

      VStack(spacing: 1) {
        PopoverActionRow(title: "刷新", shortcut: "⌘ R") {
          vm.refreshDoctorAndBootstrap()
          vm.fetchUsageSummary(silent: true)
        }
        .keyboardShortcut("r", modifiers: .command)

        PopoverActionRow(title: "检查更新…") {
          onClosePopover()
          onCheckUpdates()
        }

        PopoverActionRow(title: "退出控制面板", shortcut: "⌘ Q") {
          NSApp.terminate(nil)
        }
        .keyboardShortcut("q", modifiers: .command)
      }
      .padding(.horizontal, 6)
      .padding(.top, 4)
      .padding(.bottom, 7)
    }
    .frame(width: 356)
  }

  @ViewBuilder
  private var quickContextSection: some View {
    let key = vm.popoverSelection
    if !vm.runtime.runningFromDmg && (!vm.daemonOnline || !vm.masterEnabled) {
      HStack {
        Text(vm.daemonOnline ? "全局监控已暂停" : "后台采集服务未运行")
          .font(.system(size: 11.5))
          .foregroundColor(.secondary)
        Spacer()
        Button(vm.daemonOnline ? "恢复显示" : "开启后台") {
          vm.setMasterEnabled(true)
        }
        .buttonStyle(.borderedProminent)
        .tint(CodexBarPalette.accentBlue)
        .controlSize(.mini)
      }
      .padding(.horizontal, 4)
    } else if key == "all" {
      HStack(spacing: 5) {
        ForEach(vm.orderedKeys, id: \.self) { k in
          let entry = vm.apps[k]
          let installed = entry?.installed ?? false
          let enabled = vm.isToolEnabled(k)
          let active = installed && vm.isActiveOverall && enabled
          Button {
            vm.popoverSelection = k
          } label: {
            HStack(spacing: 4) {
              Circle()
                .fill(active ? vm.toolAccentColor(for: k) : Color.gray.opacity(0.4))
                .frame(width: 5.5, height: 5.5)
              Text(vm.toolShortTitle(for: k))
                .font(.system(size: 10.5, weight: .medium))
                .lineLimit(1)
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 3.5)
            .frame(maxWidth: .infinity)
            .background(Color.primary.opacity(0.05))
            .clipShape(Capsule())
          }
          .buttonStyle(.plain)
        }
      }
    } else {
      let entry = vm.apps[key]
      let installed = entry?.installed ?? false
      let enabled = vm.isToolEnabled(key)
      let needsInline = installed && vm.isActiveOverall && enabled && key != "antigravity" && entry?.cdpPort == nil
      HStack(spacing: 8) {
        if installed {
          Toggle(isOn: Binding(
            get: { enabled },
            set: { vm.setToolEnabled(key, enabled: $0) }
          )) {
            Text("监控 \(vm.toolShortTitle(for: key))")
              .font(.system(size: 11.5))
          }
          .toggleStyle(.switch)
          .controlSize(.mini)
          .disabled(vm.busy || vm.runtime.runningFromDmg)

          Spacer()

          if needsInline && !vm.runtime.runningFromDmg {
            Button("接入消息旁") {
              vm.runAction(args: ["open", key], successText: "已为 \(vm.displayTitle(for: key)) 开启消息旁显示")
            }
            .buttonStyle(.bordered)
            .controlSize(.mini)
          } else if let appPath = entry?.appPath {
            Button("打开应用") {
              onClosePopover()
              NSWorkspace.shared.open(URL(fileURLWithPath: appPath))
            }
            .buttonStyle(.bordered)
            .controlSize(.mini)
          }
        } else {
          Text("未检测到 \(vm.displayTitle(for: key)) 安装")
            .font(.system(size: 11.5))
            .foregroundColor(.secondary)
          Spacer()
        }
      }
      .padding(.horizontal, 4)
    }
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
    return pop
  }()

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
        contentRect: NSRect(x: 0, y: 0, width: 680, height: 560),
        styleMask: [.titled, .closable, .miniaturizable, .resizable],
        backing: .buffered,
        defer: false
      )
      win.title = "AI Turn Meter"
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
          self?.showControlPanel(tab: .control)
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
    let openItem = NSMenuItem(title: "打开控制面板…", action: #selector(openControlPanelFromMenu), keyEquivalent: ",")
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
      vm?.activeTab = tab
    }
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    vm?.refreshDoctorAndBootstrap()
    if vm?.activeTab == .usage { vm?.fetchUsageSummary() }
    else if vm?.activeTab == .turns { vm?.fetchRecentTurns() }
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
