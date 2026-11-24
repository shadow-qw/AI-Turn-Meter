import Foundation

public enum DaemonAuth {
  public static let tokenHeader = "X-ATM-Token"

  private struct FileStamp: Equatable {
    let inode: UInt64
    let size: Int64
    let mtimeSec: Int
    let mtimeNsec: Int
  }

  private struct CachedToken {
    let stamp: FileStamp
    let token: String?
  }

  private final class TokenCache: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String: CachedToken] = [:]

    func get(path: String, stamp: FileStamp) -> (hit: Bool, token: String?) {
      lock.lock()
      defer { lock.unlock() }
      guard let entry = entries[path], entry.stamp == stamp else {
        return (false, nil)
      }
      return (true, entry.token)
    }

    func set(path: String, stamp: FileStamp, token: String?) {
      lock.lock()
      defer { lock.unlock() }
      if entries.count >= 64 && entries[path] == nil {
        entries.removeAll(keepingCapacity: true)
      }
      entries[path] = CachedToken(stamp: stamp, token: token)
    }

    func remove(path: String) {
      lock.lock()
      defer { lock.unlock() }
      entries.removeValue(forKey: path)
    }

    func clear() {
      lock.lock()
      defer { lock.unlock() }
      entries.removeAll(keepingCapacity: false)
    }
  }

  private static let tokenCache = TokenCache()

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

  public static func invalidateTokenCache() {
    tokenCache.clear()
  }

  private static func fileStamp(atPath path: String) -> FileStamp? {
    var st = stat()
    guard stat(path, &st) == 0 else { return nil }
    return FileStamp(
      inode: UInt64(st.st_ino),
      size: Int64(st.st_size),
      mtimeSec: st.st_mtimespec.tv_sec,
      mtimeNsec: st.st_mtimespec.tv_nsec
    )
  }

  public static func readToken(tokenPath: String? = nil) -> String? {
    if tokenPath == nil,
       let envTok = ProcessInfo.processInfo.environment["AI_TURN_METER_TOKEN"]?
         .trimmingCharacters(in: .whitespacesAndNewlines),
       !envTok.isEmpty {
      return envTok
    }
    let path = tokenPath ?? defaultTokenPath()
    guard let stamp = fileStamp(atPath: path) else {
      tokenCache.remove(path: path)
      return nil
    }
    let cached = tokenCache.get(path: path, stamp: stamp)
    if cached.hit {
      return cached.token
    }
    guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else {
      tokenCache.remove(path: path)
      return nil
    }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let token = trimmed.isEmpty ? nil : trimmed
    tokenCache.set(path: path, stamp: stamp, token: token)
    return token
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
