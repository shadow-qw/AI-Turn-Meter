import Foundation

public enum DaemonAuth {
  public static let tokenHeader = "X-ATM-Token"

  /// Direct loopback session bypassing system HTTP/SOCKS proxies so 127.0.0.1 daemon calls never get proxied.
  public static let localSession: URLSession = {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.connectionProxyDictionary = [:]
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    return URLSession(configuration: cfg)
  }()

  public static func defaultTokenPath(stateDir: String? = nil) -> String {
    if let dir = stateDir, !dir.isEmpty {
      return (dir as NSString).appendingPathComponent("daemon.token")
    }
    if let envDir = ProcessInfo.processInfo.environment["AI_TURN_METER_STATE_DIR"], !envDir.isEmpty {
      return (envDir as NSString).appendingPathComponent("daemon.token")
    }
    let home = NSHomeDirectory() as NSString
    return home.appendingPathComponent(".local/share/ai-turn-meter/daemon.token")
  }

  public static func readToken(tokenPath: String? = nil) -> String? {
    if tokenPath == nil,
       let envTok = ProcessInfo.processInfo.environment["AI_TURN_METER_TOKEN"]?
         .trimmingCharacters(in: .whitespacesAndNewlines),
       !envTok.isEmpty {
      return envTok
    }
    let path = tokenPath ?? defaultTokenPath()
    guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else {
      return nil
    }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  public static func authorizedRequest(
    url: URL,
    method: String = "GET",
    timeout: TimeInterval = 10,
    tokenPath: String? = nil
  ) -> URLRequest {
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    req.httpMethod = method
    if let token = readToken(tokenPath: tokenPath) {
      req.setValue(token, forHTTPHeaderField: tokenHeader)
    }
    return req
  }
}
