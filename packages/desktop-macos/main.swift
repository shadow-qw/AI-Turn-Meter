import AppKit
import Foundation
import SwiftUI

struct TurnSummary: Decodable {
  let model: String?
  let inlineText: String?
  let callCount: Int?
  let cacheRatePct: Double?
}

struct StatusAppEntry: Decodable {
  let name: String
  let appPath: String?
  let installed: Bool
  let cdpPort: Int?
  let latestTurn: TurnSummary?
}

struct StatusResponse: Decodable {
  let version: String?
  let port: Int
  let online: Bool
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
  @Published var daemonPid: Int? = nil
  @Published var daemonVersion: String? = nil
  @Published var daemonPort: Int = 47831
  @Published var launchAgentExists: Bool = false
  @Published var launchAgentLoaded: Bool = false
  @Published var cursorHooksOk: Bool = false
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

  var canEnableAnyInlineCdp: Bool {
    ["codex", "cursor", "codebuddy"].contains { key in
      guard let entry = apps[key] else { return false }
      return entry.installed && entry.cdpPort == nil
    }
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

  func placementHint(for key: String, cdpPort: Int?) -> String {
    switch key {
    case "antigravity":
      return "每次启动自动识别 · 统计显示在消息操作栏左侧"
    case "codex":
      return cdpPort != nil ? "底栏胶囊已激活 · 回复底栏左侧实时展示" : "点右侧「开启底栏」重启后即可直接在对话里展示"
    case "cursor":
      return cdpPort != nil ? "右下角状态栏 + 消息底栏胶囊均已开启" : "右下角状态栏已就绪 · 想显示在消息旁可点右侧「开启底栏」"
    case "codebuddy":
      return cdpPort != nil ? "右下角状态栏 + 消息底栏胶囊均已开启" : "右下角状态栏已就绪 · 想显示在消息旁可点右侧「开启底栏」"
    default:
      return ""
    }
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
        if let v = parsed.version { self.version = v }
        self.daemonOnline = parsed.online
        self.daemonPort = parsed.port
        self.apps = parsed.apps
      }
    }
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
        if let doc = doc {
          self.applyDoctor(doc)
        }
        if let st = st {
          self.daemonOnline = st.online
          self.daemonPort = st.port
          self.apps = st.apps
        }

        if shouldAutoBootstrap, !rt.runningFromDmg, let doc = doc {
          let targetVersion = doc.version ?? self.version
          let needsAppUpgrade =
            (doc.launchAgent.managedByApp ?? false) &&
            (doc.launchAgent.pointsToCurrentRoot == false ||
              (doc.daemon.version != nil && doc.daemon.version != targetVersion))

          if !doc.launchAgent.plistExists {
            self.runAction(args: ["install"], successText: "已完成首次自动配置并启动后台服务")
          } else if needsAppUpgrade {
            self.runAction(args: ["install"], successText: "已自动将后台与扩展更新至 v\(targetVersion)")
          } else if !doc.daemon.ok {
            self.runAction(args: ["start-daemon"], successText: "已拉起后台服务")
          }
        }
      }
    }
  }

  private func applyDoctor(_ doc: DoctorResponse) {
    if let v = doc.version { self.version = v }
    self.updateFeedUrl = doc.updateFeedUrl
    self.daemonOnline = doc.daemon.ok
    self.daemonPid = doc.daemon.pid
    self.daemonVersion = doc.daemon.version
    self.daemonPort = doc.daemon.port
    self.launchAgentExists = doc.launchAgent.plistExists
    self.launchAgentLoaded = doc.launchAgent.launchAgentLoaded
    self.cursorHooksOk = doc.cursorHooks.validVersion && doc.cursorHooks.configured
    var map: [String: String] = [:]
    for (k, v) in doc.apps {
      if let vv = v.vsixVersion { map[k] = vv }
    }
    self.vsixVersions = map
  }

  func runAction(args: [String], successText: String) {
    guard !busy else { return }
    busy = true
    statusBanner = "正在执行…"
    bannerIsError = false
    let rt = runtime

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let res = rt.runCli(args, timeoutSec: 30)
      if res.exitCode == 0 {
        Thread.sleep(forTimeInterval: 0.6)
      }
      let docRes = rt.runCli(["doctor", "--json"], timeoutSec: 12)
      let stRes = rt.runCli(["status", "--json"], timeoutSec: 6)
      let doc = docRes.stdout.data(using: .utf8).flatMap { try? JSONDecoder().decode(DoctorResponse.self, from: $0) }
      let st = stRes.stdout.data(using: .utf8).flatMap { try? JSONDecoder().decode(StatusResponse.self, from: $0) }

      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.busy = false
        if let doc = doc { self.applyDoctor(doc) }
        if let st = st {
          self.daemonOnline = st.online
          self.daemonPort = st.port
          self.apps = st.apps
        }
        if res.exitCode == 0 {
          self.bannerIsError = false
          self.statusBanner = successText
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
      updateStatusText = "当前是离线独立安装包（未绑定在线更新源）。\n\n以后拿到新版 .dmg 时，只需把新版「AI Turn Meter.app」拖进「应用程序」覆盖原软件并打开一次，后台服务与 IDE 扩展就会自动更新生效。"
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
    updateStatusText = "正在下载 v\(info.version) 安装镜像…"

    URLSession.shared.downloadTask(with: url) { [weak self] tempUrl, _, err in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.updateDownloading = false
        if let err = err {
          self.updateStatusText = "下载失败：\(err.localizedDescription)"
          return
        }
        guard let tempUrl = tempUrl else {
          self.updateStatusText = "下载未返回文件。"
          return
        }
        let downloadsDir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        let fileName = url.lastPathComponent.isEmpty ? "AI-Turn-Meter-\(info.version)-arm64.dmg" : url.lastPathComponent
        let dest = downloadsDir.appendingPathComponent(fileName)
        try? FileManager.default.removeItem(at: dest)
        do {
          try FileManager.default.moveItem(at: tempUrl, to: dest)
          self.updateStatusText = "已下载到「下载」文件夹，正在打开安装包。请将新版拖入「应用程序」覆盖原软件，打开后将自动升级。"
          NSWorkspace.shared.open(dest)
        } catch {
          self.updateStatusText = "保存安装包失败：\(error.localizedDescription)"
        }
      }
    }.resume()
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
          Text("当前正在安装包内打开。请先将「AI Turn Meter.app」拖入「应用程序」，再打开即可自动完成配置。")
            .font(.system(size: 12))
          Spacer()
          Button("打开应用程序") { vm.openApplicationsFolder() }
            .controlSize(.small)
        }
        .padding(10)
        .background(Color.orange.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 8))
      }

      // Header card
      HStack(spacing: 12) {
        Circle()
          .fill(vm.daemonOnline ? Color.green : Color.red)
          .frame(width: 9, height: 9)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(vm.daemonOnline ? "后台运行中" : "后台未启动")
              .font(.system(size: 14, weight: .semibold))
            Text("v\(vm.version)")
              .font(.system(size: 11))
              .foregroundColor(.secondary)
          }
          Text(
            (vm.launchAgentLoaded ? "开机自启已开" : "未设开机自启") +
            (vm.daemonPid != nil ? " · 端口 \(vm.daemonPort)" : "")
          )
          .font(.system(size: 11.5))
          .foregroundColor(.secondary)
        }
        Spacer()
        if vm.busy {
          ProgressView().controlSize(.small)
        }
        if vm.canEnableAnyInlineCdp {
          Button("全部开启底栏") {
            vm.runAction(args: ["open", "all"], successText: "已为已安装的软件统一开启底栏胶囊")
          }
          .buttonStyle(.borderedProminent)
          .disabled(vm.busy || vm.runtime.runningFromDmg)
        } else {
          Button(vm.daemonOnline ? "重启后台" : "启动后台") {
            vm.runAction(args: ["start-daemon"], successText: "后台服务已就绪")
          }
          .disabled(vm.busy || vm.runtime.runningFromDmg)
        }
        Button("修复/同步扩展") {
          vm.runAction(args: ["install"], successText: "已重新同步后台、Cursor Hooks 与 IDE 扩展")
        }
        .disabled(vm.busy || vm.runtime.runningFromDmg)
      }
      .padding(12)
      .background(Color(nsColor: .controlBackgroundColor))
      .clipShape(RoundedRectangle(cornerRadius: 10))
      .overlay(
        RoundedRectangle(cornerRadius: 10)
          .stroke(Color.primary.opacity(0.08), lineWidth: 1)
      )

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
        .padding(.vertical, 8)
        .background((vm.bannerIsError ? Color.red : Color.green).opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
      }

      // 4 Apps List
      VStack(spacing: 8) {
        ForEach(vm.orderedKeys, id: \.self) { key in
          let entry = vm.apps[key]
          let installed = entry?.installed ?? false
          let cdpPort = entry?.cdpPort
          let vsixVer = vm.vsixVersions[key]

          HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
              HStack(spacing: 6) {
                Text(vm.displayTitle(for: key))
                  .font(.system(size: 13.5, weight: .semibold))
                if !installed {
                  badge("未安装", color: .gray)
                } else {
                  if cdpPort != nil {
                    badge("底栏胶囊已开启", color: .green)
                  } else if key != "antigravity" {
                    badge("未开底栏", color: .secondary)
                  } else {
                    badge("等待窗口打开", color: .secondary)
                  }
                  if key == "cursor" || key == "codebuddy" {
                    if let vv = vsixVer {
                      badge("状态栏就绪 (v\(vv))", color: .teal)
                    } else {
                      badge("状态栏未安装", color: .orange)
                    }
                  }
                }
              }

              Text(vm.placementHint(for: key, cdpPort: cdpPort))
                .font(.system(size: 11))
                .foregroundColor(.secondary)

              if let turn = entry?.latestTurn, let inline = turn.inlineText {
                let modelStr = (turn.model != nil && turn.model != "unknown") ? "\(turn.model!) · " : ""
                Text("\(modelStr)\(inline)")
                  .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                  .foregroundColor(.primary.opacity(0.88))
                  .lineLimit(1)
              } else {
                Text("暂无对话记录")
                  .font(.system(size: 11))
                  .foregroundColor(.secondary.opacity(0.75))
              }
            }

            Spacer()

            if installed {
              if key == "antigravity" || cdpPort != nil {
                Button("切到窗口") {
                  vm.runAction(args: ["open", key], successText: "已切换到 \(vm.displayTitle(for: key))")
                }
                .controlSize(.small)
                .disabled(vm.busy)
              } else {
                Button("开启底栏") {
                  vm.runAction(args: ["open", key], successText: "已带调试口重新打开 \(vm.displayTitle(for: key))")
                }
                .controlSize(.small)
                .disabled(vm.busy)
              }
            }
          }
          .padding(11)
          .background(Color(nsColor: .controlBackgroundColor))
          .clipShape(RoundedRectangle(cornerRadius: 10))
          .overlay(
            RoundedRectangle(cornerRadius: 10)
              .stroke(Color.primary.opacity(0.07), lineWidth: 1)
          )
        }
      }

      Text("提示：关掉本窗口后统计仍在后台自动运行；收到新版 .dmg 时拖入覆盖打开一次即自动更新。")
        .font(.system(size: 11))
        .foregroundColor(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)

      // Bottom utility bar
      HStack {
        Button("检查更新") { vm.checkForUpdates() }
          .controlSize(.small)

        Button("Cursor SSH 配置") {
          vm.knownSshHosts = MeterRuntime.readSshConfigHosts()
          if vm.sshHost.isEmpty, let first = vm.knownSshHosts.first {
            vm.sshHost = first
          }
          vm.generateSshSnippet()
          vm.showSshSheet = true
        }
        .controlSize(.small)

        Spacer()

        if vm.daemonOnline {
          Button("停止后台") {
            vm.runAction(args: ["stop-daemon"], successText: "后台服务已停止")
          }
          .controlSize(.small)
          .disabled(vm.busy)
        }

        Button("刷新") {
          vm.refreshDoctorAndBootstrap()
        }
        .controlSize(.small)
        .disabled(vm.busy)

        Button("完全卸载…") {
          vm.showUninstallAlert = true
        }
        .controlSize(.small)
        .foregroundColor(.red)
        .disabled(vm.busy)
      }
    }
    .padding(16)
    .frame(minWidth: 580, minHeight: 560)
    .onAppear { vm.start() }
    .alert("确认彻底卸载本地集成？", isPresented: $vm.showUninstallAlert) {
      Button("取消", role: .cancel) {}
      Button("卸载", role: .destructive) {
        vm.runAction(args: ["uninstall"], successText: "已移除开机自启、Cursor Hooks、IDE 扩展与 CLI")
      }
    } message: {
      Text("将停止后台服务，移除开机自启、Cursor Hooks 与 IDE 扩展；已采集的历史记录（~/.local/share/ai-turn-meter/meter.db）会保留。")
    }
    .sheet(isPresented: $vm.showSshSheet) {
      VStack(alignment: .leading, spacing: 12) {
        Text("Cursor Remote-SSH 上报配置")
          .font(.headline)
        Text("Remote-SSH 模式下，Cursor Hook 在远端服务器执行。请在 Mac ~/.ssh/config 为目标主机添加端口转发，并将下方 hooks.json 写入远端服务器。")
          .font(.system(size: 12))
          .foregroundColor(.secondary)
        if !vm.knownSshHosts.isEmpty {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
              Text("检测到配置:")
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
          Button("生成配置") { vm.generateSshSnippet() }
        }
        ScrollView {
          Text(vm.sshPreview)
            .font(.system(size: 11, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
        }
        .frame(height: 220)
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
      .frame(width: 550, height: 440)
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
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(8)
          }
          .frame(height: 120)
          .background(Color(nsColor: .textBackgroundColor))
          .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        HStack {
          if vm.updateChecking || vm.updateDownloading {
            ProgressView().controlSize(.small)
          }
          Spacer()
          if let info = vm.availableUpdate {
            Button("下载新版安装包") { vm.downloadAndOpenUpdate(info) }
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

  @ViewBuilder
  private func badge(_ text: String, color: Color) -> some View {
    Text(text)
      .font(.system(size: 10.5, weight: .medium))
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .foregroundColor(color)
      .background(color.opacity(0.12))
      .clipShape(Capsule())
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
        contentRect: NSRect(x: 0, y: 0, width: 610, height: 580),
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
