import AITurnMeterCore
import Foundation

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
    UpdateChecker.compareSemver(a, b)
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
