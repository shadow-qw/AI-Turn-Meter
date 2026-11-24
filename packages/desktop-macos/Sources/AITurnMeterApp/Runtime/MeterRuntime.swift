import AITurnMeterCore
import Foundation

private final class PipeDataBuffer: @unchecked Sendable {
  private let lock = NSLock()
  private var data = Data()

  func append(_ chunk: Data) {
    guard !chunk.isEmpty else { return }
    lock.lock()
    data.append(chunk)
    lock.unlock()
  }

  func snapshot() -> Data {
    lock.lock()
    let copy = data
    lock.unlock()
    return copy
  }
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
    let values = try? Bundle.main.bundleURL.resourceValues(forKeys: [.volumeIsReadOnlyKey])
    self.runningFromDmg = Bundle.main.bundlePath.hasPrefix("/Volumes/") && (values?.volumeIsReadOnly == true)
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

    let outHandle = outPipe.fileHandleForReading
    let errHandle = errPipe.fileHandleForReading
    let outBuffer = PipeDataBuffer()
    let errBuffer = PipeDataBuffer()

    let ioGroup = DispatchGroup()
    ioGroup.enter()
    DispatchQueue.global(qos: .userInitiated).async {
      defer {
        try? outHandle.close()
        ioGroup.leave()
      }
      while let chunk = try? outHandle.read(upToCount: 65_536), !chunk.isEmpty {
        outBuffer.append(chunk)
      }
    }

    ioGroup.enter()
    DispatchQueue.global(qos: .userInitiated).async {
      defer {
        try? errHandle.close()
        ioGroup.leave()
      }
      while let chunk = try? errHandle.read(upToCount: 65_536), !chunk.isEmpty {
        errBuffer.append(chunk)
      }
    }

    let procGroup = DispatchGroup()
    procGroup.enter()
    DispatchQueue.global(qos: .userInitiated).async {
      proc.waitUntilExit()
      procGroup.leave()
    }

    if procGroup.wait(timeout: .now() + timeoutSec) == .timedOut {
      let pid = proc.processIdentifier
      if proc.isRunning {
        Self.signalChildProcesses(parentPid: pid, signalFlag: "-TERM")
        proc.terminate()
      }
      if procGroup.wait(timeout: .now() + 0.5) == .timedOut && proc.isRunning {
        Self.signalChildProcesses(parentPid: pid, signalFlag: "-KILL")
        kill(pid, SIGKILL)
        _ = procGroup.wait(timeout: .now() + 0.5)
      }
      _ = ioGroup.wait(timeout: .now() + 0.5)
      return CommandResult(exitCode: 124, stdout: "", stderr: "命令执行超时")
    }

    _ = ioGroup.wait(timeout: .now() + 2.0)

    let stdoutData = outBuffer.snapshot()
    let stderrData = errBuffer.snapshot()
    let stdout = String(data: stdoutData, encoding: .utf8) ?? String(decoding: stdoutData, as: UTF8.self)
    let stderr = String(data: stderrData, encoding: .utf8) ?? String(decoding: stderrData, as: UTF8.self)
    return CommandResult(exitCode: proc.terminationStatus, stdout: stdout, stderr: stderr)
  }

  static func compareSemver(_ a: String, _ b: String) -> Int {
    UpdateChecker.compareSemver(a, b)
  }

  private static func signalChildProcesses(parentPid: pid_t, signalFlag: String) {
    guard parentPid > 0 else { return }
    let pkill = Process()
    pkill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
    pkill.arguments = [signalFlag, "-P", "\(parentPid)"]
    pkill.standardOutput = FileHandle.nullDevice
    pkill.standardError = FileHandle.nullDevice
    try? pkill.run()
    pkill.waitUntilExit()
  }

  static func readSshConfigHosts() -> [String] {
    let path = (NSHomeDirectory() as NSString).appendingPathComponent(".ssh/config")
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
    var hosts: [String] = []
    for rawLine in text.components(separatedBy: .newlines) {
      let withoutComment = rawLine.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? rawLine
      let line = withoutComment.trimmingCharacters(in: .whitespaces)
      guard !line.isEmpty else { continue }
      let lower = line.lowercased()
      let remainder: Substring
      if lower.hasPrefix("host ") || lower.hasPrefix("host\t") {
        remainder = line.dropFirst(4)
      } else if lower.hasPrefix("host=") {
        remainder = line.dropFirst(5)
      } else {
        continue
      }
      let parts = remainder.split(whereSeparator: { $0 == " " || $0 == "\t" })
      for p in parts {
        let s = String(p).trimmingCharacters(in: .whitespaces)
        if s.isEmpty || s == "=" || s == "*" || s.contains("*") || s.contains("?") || s.hasPrefix("!") || hosts.contains(s) {
          continue
        }
        hosts.append(s)
      }
    }
    return hosts
  }
}
