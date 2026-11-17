import AppKit
import Foundation
import SwiftUI

struct TurnSummary: Decodable {
  let model: String?
  let inlineText: String?
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

  @Published var version: String = "0.2.1"
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

  @Published var apps: [String: StatusAppEntry] = [:]
  @Published var vsixVersions: [String: String] = [:]

  @Published var busy: Bool = false
  @Published var statusBanner: String? = nil
  @Published var bannerIsError: Bool = false
  @Published var showUninstallAlert: Bool = false
  @Published var showSshSheet: Bool = false
  @Published var sshHost: String = ""
  @Published var sshPreview: String = ""
  @Published var knownSshHosts: [String] = []

  @Published var showUpdateSheet: Bool = false
  @Published var updateChecking: Bool = false
  @Published var updateDownloading: Bool = false
  @Published var availableUpdate: UpdateReleaseInfo? = nil
  @Published var updateStatusText: String = ""

  private var pollTimer: Timer?
  private var didBootstrap = false

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

  func start() {
    knownSshHosts = MeterRuntime.readSshConfigHosts()
    refreshDoctorAndBootstrap()
    pollTimer?.invalidate()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
      Task { @MainActor [weak self] in
        self?.pollStatusOnly()
      }
    }
  }

  func stopPolling() {
    pollTimer?.invalidate()
    pollTimer = nil
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

  private func applyStatus(_ st: StatusResponse) {
    if let v = st.version { self.version = v }
    self.daemonOnline = st.online
    self.daemonPort = st.port
    self.apps = st.apps
    if let cfg = st.config {
      self.masterEnabled = cfg.enabled
      for (k, v) in cfg.tools { self.toolToggles[k] = v }
    }
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
          let needsAppUpgrade =
            (doc.launchAgent.managedByApp ?? false) &&
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
    sshPreview = res.exitCode == 0 ? res.stdout : res.stderr
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

struct ContentView: View {
  @ObservedObject var vm: MeterViewModel

  var body: some View {
    VStack(spacing: 12) {
      if vm.runtime.runningFromDmg {
        HStack(spacing: 10) {
          Image(systemName: "externaldrive.badge.exclamationmark")
            .foregroundColor(.orange)
          Text("请先将「AI Turn Meter.app」拖入「应用程序」后再打开使用。")
            .font(.system(size: 12))
          Spacer()
          Button("打开应用程序") { vm.openApplicationsFolder() }
            .controlSize(.small)
        }
        .padding(10)
        .background(Color.orange.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 8))
      }

      // Compact Top Status Header (no redundant master toggle button)
      HStack(spacing: 8) {
        Circle()
          .fill(vm.isActiveOverall ? Color.green : (vm.daemonOnline ? Color.orange : Color.gray.opacity(0.5)))
          .frame(width: 8, height: 8)
        Text(
          vm.isActiveOverall
            ? "后台运行中"
            : (vm.daemonOnline ? "已暂停显示" : "后台未启动")
        )
        .font(.system(size: 13, weight: .semibold))
        Text("v\(vm.version)")
          .font(.system(size: 11))
          .foregroundColor(.secondary)
        Spacer()
        if vm.busy {
          ProgressView().controlSize(.small)
        } else if !vm.daemonOnline && !vm.runtime.runningFromDmg {
          Button("开启后台") { vm.setMasterEnabled(true) }
            .controlSize(.small)
        } else if !vm.masterEnabled && !vm.runtime.runningFromDmg {
          Button("恢复显示") { vm.setMasterEnabled(true) }
            .controlSize(.small)
        } else {
          Text("关闭窗口后仍在后台生效")
            .font(.system(size: 11))
            .foregroundColor(.secondary)
        }
      }
      .padding(.horizontal, 4)
      .padding(.vertical, 2)

      if vm.isActiveOverall && !vm.appsNeedingInlineCdp.isEmpty {
        HStack(spacing: 10) {
          Image(systemName: "sparkles")
            .foregroundColor(.accentColor)
          Text("Codex / Cursor / CodeBuddy 如需在聊天消息旁直接显示，点右侧一键重启接入：")
            .font(.system(size: 11.5))
            .foregroundColor(.secondary)
          Spacer()
          Button("一键全部接入") {
            vm.runAction(args: ["open", "all"], successText: "已开启全部消息旁显示")
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
          .disabled(vm.busy || vm.runtime.runningFromDmg)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.accentColor.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 9))
      }

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
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background((vm.bannerIsError ? Color.red : Color.green).opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
      }

      // 4 Apps Toggle List
      VStack(spacing: 8) {
        ForEach(vm.orderedKeys, id: \.self) { key in
          let entry = vm.apps[key]
          let installed = entry?.installed ?? false
          let enabled = vm.isToolEnabled(key)
          let needsInline = installed && vm.isActiveOverall && enabled && key != "antigravity" && entry?.cdpPort == nil

          HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 6) {
                Text(vm.displayTitle(for: key))
                  .font(.system(size: 13.5, weight: .semibold))
                  .foregroundColor(installed ? .primary : .secondary)
                if installed && vm.isActiveOverall && enabled && entry?.cdpPort != nil {
                  Circle()
                    .fill(Color.green)
                    .frame(width: 6, height: 6)
                }
              }
              Text(vm.appSubtitle(for: key))
                .font(.system(size: 11.5))
                .foregroundColor(.secondary)
                .lineLimit(1)
            }

            Spacer()

            if needsInline {
              Button(vm.inlineBtnLabel(for: key)) {
                vm.runAction(args: ["open", key], successText: "已为 \(vm.displayTitle(for: key)) 开启消息旁显示")
              }
              .controlSize(.small)
              .disabled(vm.busy)
            }

            Toggle("", isOn: Binding(
              get: { installed && enabled && vm.isActiveOverall },
              set: { vm.setToolEnabled(key, enabled: $0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .disabled(!installed || vm.busy || vm.runtime.runningFromDmg)
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .background(Color(nsColor: .controlBackgroundColor))
          .clipShape(RoundedRectangle(cornerRadius: 10))
          .overlay(
            RoundedRectangle(cornerRadius: 10)
              .stroke(Color.primary.opacity(0.07), lineWidth: 1)
          )
          .opacity(installed ? 1.0 : 0.55)
        }
      }

      Spacer(minLength: 2)

      // Minimal Footer
      HStack {
        Button {
          vm.checkForUpdates()
        } label: {
          Label("检查更新", systemImage: "arrow.triangle.2.circlepath")
            .font(.system(size: 12))
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        Spacer()
        Menu {
          Button("Cursor Remote-SSH 配置…") {
            vm.knownSshHosts = MeterRuntime.readSshConfigHosts()
            if vm.sshHost.isEmpty, let first = vm.knownSshHosts.first {
              vm.sshHost = first
            }
            vm.generateSshSnippet()
            vm.showSshSheet = true
          }
          Divider()
          Button("修复或重新同步扩展配置") {
            vm.runAction(args: ["install"], successText: "已重新同步全部配置与扩展")
          }
          Button("刷新状态") { vm.refreshDoctorAndBootstrap() }
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
          Label("更多设置", systemImage: "gearshape")
            .font(.system(size: 12))
        }
        .menuStyle(.borderedButton)
        .controlSize(.small)
        .fixedSize()
      }
    }
    .padding(16)
    .frame(minWidth: 500, minHeight: 380)
    .onAppear { vm.start() }
    .alert("确认彻底卸载？", isPresented: $vm.showUninstallAlert) {
      Button("取消", role: .cancel) {}
      Button("卸载", role: .destructive) {
        vm.runAction(args: ["uninstall"], successText: "已移除后台服务、Cursor Hooks 与 IDE 扩展")
      }
    } message: {
      Text("将停止后台服务，移除开机自启、Cursor Hooks 与 IDE 扩展；历史统计库会保留。")
    }
    .sheet(isPresented: $vm.showSshSheet) {
      VStack(alignment: .leading, spacing: 12) {
        Text("Cursor Remote-SSH 上报配置")
          .font(.headline)
        Text("连接远端服务器时，在 Mac ~/.ssh/config 加上端口转发，并将下方 hooks.json 放到远端服务器即可。")
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
          Button("生成") { vm.generateSshSnippet() }
        }
        ScrollView {
          Text(vm.sshPreview)
            .font(.system(size: 11, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
        }
        .frame(height: 210)
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        HStack {
          Spacer()
          Button("复制全部") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(vm.sshPreview, forType: .string)
          }
          Button("完成") { vm.showSshSheet = false }
            .buttonStyle(.borderedProminent)
        }
      }
      .padding(18)
      .frame(width: 540, height: 420)
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

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow?
  private var vm: MeterViewModel?

  func applicationDidFinishLaunching(_ notification: Notification) {
    MainActor.assumeIsolated {
      NSApp.setActivationPolicy(.regular)
      let model = MeterViewModel()
      self.vm = model
      let view = ContentView(vm: model)
      let win = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 520, height: 400),
        styleMask: [.titled, .closable, .miniaturizable, .resizable],
        backing: .buffered,
        defer: false
      )
      win.title = "AI Turn Meter"
      win.center()
      win.isReleasedWhenClosed = false
      win.contentView = NSHostingView(rootView: view)
      win.makeKeyAndOrderFront(nil)
      self.window = win
      NSApp.activate(ignoringOtherApps: true)
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    MainActor.assumeIsolated {
      if !flag {
        window?.makeKeyAndOrderFront(nil)
        vm?.refreshDoctorAndBootstrap()
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
