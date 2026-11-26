import CFNetwork
import Foundation
import LocalAuthentication
import Security

enum HeadlessCliHelper {
  static func readCursorSafeStoragePasswords(allowPrompt: Bool) -> [String] {
    readSafeStoragePasswords(service: "Cursor Safe Storage", accounts: ["Cursor Key", "Cursor"], allowPrompt: allowPrompt)
  }

  static func readClaudeCredentials(allowPrompt: Bool) -> (passwords: [String], cliCredentials: [String]) {
    let passwords = readSafeStoragePasswords(
      service: "Claude Safe Storage",
      accounts: ["Claude Key", "Claude"],
      allowPrompt: allowPrompt
    )
    var cliCredentials: [String] = []
    let cliRes = readKeychainPassword(service: "Claude Code-credentials", account: nil, allowPrompt: allowPrompt)
    if let raw = cliRes.password?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
      cliCredentials.append(raw)
    }
    return (passwords, cliCredentials)
  }

  private static func readSafeStoragePasswords(
    service: String,
    accounts: [String],
    allowPrompt: Bool
  ) -> [String] {
    var results: [String] = []
    for acct in accounts {
      let res = readKeychainPassword(service: service, account: acct, allowPrompt: allowPrompt)
      if let pw = res.password, !results.contains(pw) {
        results.append(pw)
        if allowPrompt {
          return results
        }
      }
      if allowPrompt && (res.status == errSecUserCanceled || res.status == errSecAuthFailed) {
        return results
      }
    }
    if results.isEmpty {
      let res = readKeychainPassword(service: service, account: nil, allowPrompt: allowPrompt)
      if let pw = res.password, !results.contains(pw) {
        results.append(pw)
      }
    }
    return results
  }

  private typealias FnCopyAccess = @convention(c) (SecKeychainItem, UnsafeMutablePointer<SecAccess?>) -> OSStatus
  private typealias FnCopyMatchingACLs = @convention(c) (SecAccess, CFTypeRef) -> Unmanaged<CFArray>?
  private typealias FnCopyACLContents = @convention(c) (
    SecACL,
    UnsafeMutablePointer<CFArray?>,
    UnsafeMutablePointer<CFString?>,
    UnsafeMutablePointer<SecKeychainPromptSelector>
  ) -> OSStatus
  private typealias FnValidateTrustedApp = @convention(c) (SecTrustedApplication, UnsafePointer<CChar>) -> OSStatus

  private nonisolated(unsafe) static let securityHandle = dlopen(
    "/System/Library/Frameworks/Security.framework/Security",
    RTLD_NOW
  )

  private static func securityFn<T>(_ name: String, as _: T.Type) -> T? {
    guard let handle = securityHandle, let sym = dlsym(handle, name) else { return nil }
    return unsafeBitCast(sym, to: T.self)
  }

  private static func isKeychainDecryptAllowedWithoutUI(service: String, account: String?) -> Bool {
    guard let copyAccess = securityFn("SecKeychainItemCopyAccess", as: FnCopyAccess.self),
          let copyACLs = securityFn("SecAccessCopyMatchingACLList", as: FnCopyMatchingACLs.self),
          let copyACLContents = securityFn("SecACLCopyContents", as: FnCopyACLContents.self),
          let validateApp = securityFn("SecTrustedApplicationValidateWithPath", as: FnValidateTrustedApp.self),
          let exePath = Bundle.main.executablePath else {
      return false
    }

    let ctx = LAContext()
    ctx.interactionNotAllowed = true
    var refQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnRef as String: true,
      kSecUseAuthenticationContext as String: ctx,
    ]
    if let account = account {
      refQuery[kSecAttrAccount as String] = account
    }
    var refObj: CFTypeRef?
    guard SecItemCopyMatching(refQuery as CFDictionary, &refObj) == errSecSuccess,
          let rawRef = refObj else {
      return false
    }
    let item = unsafeDowncast(rawRef as AnyObject, to: SecKeychainItem.self)
    var access: SecAccess?
    guard copyAccess(item, &access) == errSecSuccess,
          let access = access,
          let acls = copyACLs(access, kSecACLAuthorizationDecrypt)?.takeRetainedValue() as? [SecACL] else {
      return false
    }
    for acl in acls {
      var apps: CFArray?
      var desc: CFString?
      var selector = SecKeychainPromptSelector()
      guard copyACLContents(acl, &apps, &desc, &selector) == errSecSuccess else { continue }
      guard selector.rawValue == 0 else { continue }
      guard let trustedApps = apps as? [SecTrustedApplication] else {
        return true
      }
      if trustedApps.contains(where: { app in
        exePath.withCString { validateApp(app, $0) == errSecSuccess }
      }) {
        return true
      }
    }
    return false
  }

  private static func readKeychainPassword(
    service: String,
    account: String?,
    allowPrompt: Bool
  ) -> (password: String?, status: OSStatus) {
    if !allowPrompt && !isKeychainDecryptAllowedWithoutUI(service: service, account: account) {
      return (nil, errSecInteractionNotAllowed)
    }
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    if let account = account {
      query[kSecAttrAccount as String] = account
    }
    if !allowPrompt {
      let ctx = LAContext()
      ctx.interactionNotAllowed = true
      query[kSecUseAuthenticationContext as String] = ctx
    }
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data else {
      return (nil, status)
    }
    return (String(data: data, encoding: .utf8), status)
  }

  static func runIfRequested() -> Bool {
    let args = CommandLine.arguments
    if args.contains("--net-fetch-json") {
      runNetFetchJson()
      return true
    }
    if args.contains("--read-cursor-safe-storage") {
      let allowPrompt = args.contains("--allow-prompt")
      let passwords = readCursorSafeStoragePasswords(allowPrompt: allowPrompt)
      if let out = try? JSONSerialization.data(withJSONObject: ["ok": !passwords.isEmpty, "passwords": passwords]),
         let text = String(data: out, encoding: .utf8) {
        print(text)
      } else {
        print("{\"ok\":false,\"passwords\":[]}")
      }
      return true
    }
    if args.contains("--read-claude-credentials") {
      let allowPrompt = args.contains("--allow-prompt")
      let creds = readClaudeCredentials(allowPrompt: allowPrompt)
      let ok = !creds.passwords.isEmpty || !creds.cliCredentials.isEmpty
      if let out = try? JSONSerialization.data(withJSONObject: [
        "ok": ok,
        "passwords": creds.passwords,
        "cliCredentials": creds.cliCredentials,
      ]),
         let text = String(data: out, encoding: .utf8) {
        print(text)
      } else {
        print("{\"ok\":false,\"passwords\":[],\"cliCredentials\":[]}")
      }
      return true
    }
    return false
  }

  private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
      _ session: URLSession,
      task: URLSessionTask,
      willPerformHTTPRedirection response: HTTPURLResponse,
      newRequest request: URLRequest,
      completionHandler: @escaping (URLRequest?) -> Void
    ) {
      completionHandler(nil)
    }
  }

  private final class FetchResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var payload: [String: Any] = ["ok": false]
    private var completed = false

    func finishFromResponse(data: Data?, resp: URLResponse?, err: Error?) -> Bool {
      lock.lock()
      defer { lock.unlock() }
      if completed { return false }
      completed = true
      if let http = resp as? HTTPURLResponse {
        payload["status"] = http.statusCode
        payload["ok"] = (200...299).contains(http.statusCode)
        if let finalUrl = http.url?.absoluteString {
          payload["url"] = finalUrl
        }
        var respHeaders: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
          respHeaders[String(describing: k).lowercased()] = String(describing: v)
        }
        payload["headers"] = respHeaders
      }
      if let data = data, let text = String(data: data, encoding: .utf8) {
        payload["body"] = text
      }
      if let err = err {
        payload["error"] = err.localizedDescription
      }
      return true
    }

    func markTimedOutIfPending() {
      lock.lock()
      defer { lock.unlock() }
      if !completed {
        completed = true
        payload["error"] = "timeout"
      }
    }

    func snapshotJsonData() -> Data? {
      lock.lock()
      let copy = payload
      lock.unlock()
      return try? JSONSerialization.data(withJSONObject: copy)
    }
  }

  static func hasActiveSystemProxy() -> Bool {
    guard let raw = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any] else {
      return false
    }
    let keys = ["HTTPEnable", "HTTPSEnable", "SOCKSEnable", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"]
    return keys.contains { key in
      if let n = raw[key] as? NSNumber { return n.intValue == 1 }
      if let b = raw[key] as? Bool { return b }
      return false
    }
  }

  private static func isLoopbackHost(_ host: String?) -> Bool {
    let h = (host ?? "").lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    return h == "127.0.0.1" || h == "localhost" || h == "::1"
  }

  private static func buildConnectionProxyDictionary(proxyUrl: String) -> [AnyHashable: Any]? {
    guard let comps = URLComponents(string: proxyUrl),
          let scheme = comps.scheme?.lowercased(),
          let host = comps.host?.trimmingCharacters(in: .whitespacesAndNewlines),
          !host.isEmpty else {
      return nil
    }
    let defaultPort: Int? = {
      switch scheme {
      case "http": return 80
      case "https": return 443
      case "socks5", "socks5h": return 1080
      default: return nil
      }
    }()
    guard let fallbackPort = defaultPort else { return nil }
    let port = comps.port ?? fallbackPort
    guard (1...65535).contains(port) else { return nil }

    var dict: [AnyHashable: Any] = [
      "ExcludeSimpleHostnames": 0,
      // Loopback stays direct; remote hosts never bypass the explicit proxy.
      "ExceptionsList": ["localhost", "127.0.0.1", "::1"] as [String],
    ]
    if scheme == "socks5" || scheme == "socks5h" {
      dict["SOCKSEnable"] = 1
      dict["SOCKSProxy"] = host
      dict["SOCKSPort"] = port
    } else {
      dict["HTTPEnable"] = 1
      dict["HTTPProxy"] = host
      dict["HTTPPort"] = port
      dict["HTTPSEnable"] = 1
      dict["HTTPSProxy"] = host
      dict["HTTPSPort"] = port
    }
    if let user = comps.user, !user.isEmpty {
      dict[kCFProxyUsernameKey as String] = user
    }
    if let pass = comps.password, !pass.isEmpty {
      dict[kCFProxyPasswordKey as String] = pass
    }
    return dict
  }

  private static func runNetFetchJson() {
    let inputData = FileHandle.standardInput.readDataToEndOfFile()
    guard let obj = try? JSONSerialization.jsonObject(with: inputData) as? [String: Any],
          let urlStr = obj["url"] as? String,
          let url = URL(string: urlStr) else {
      print("{\"ok\":false,\"error\":\"invalid input\"}")
      return
    }
    let method = (obj["method"] as? String)?.uppercased() ?? "GET"
    let timeoutMs = (obj["timeoutMs"] as? Double) ?? 8000.0
    let timeoutSec = max(1.0, timeoutMs / 1000.0)
    let manualRedirect = (obj["redirect"] as? String)?.lowercased() == "manual"
    let proxyUrl = (obj["proxyUrl"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let strictProxy = (obj["strictProxy"] as? Bool) ?? false

    let cfg = URLSessionConfiguration.ephemeral
    cfg.httpShouldSetCookies = false
    cfg.httpCookieAcceptPolicy = .never
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = timeoutSec
    cfg.timeoutIntervalForResource = timeoutSec + 2.0

    if !proxyUrl.isEmpty {
      guard let proxyDict = buildConnectionProxyDictionary(proxyUrl: proxyUrl) else {
        print("{\"ok\":false,\"error\":\"invalid proxyUrl\"}")
        return
      }
      cfg.connectionProxyDictionary = proxyDict
    } else if strictProxy && !isLoopbackHost(url.host) && !hasActiveSystemProxy() {
      print("{\"ok\":false,\"error\":\"strictProxy: no system proxy\"}")
      return
    }

    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeoutSec)
    req.httpMethod = method
    if let headers = obj["headers"] as? [String: String] {
      for (k, v) in headers {
        req.setValue(v, forHTTPHeaderField: k)
      }
    }
    if let bodyStr = obj["body"] as? String {
      req.httpBody = bodyStr.data(using: .utf8)
    }

    let sem = DispatchSemaphore(value: 0)
    let box = FetchResultBox()
    let delegate: URLSessionTaskDelegate? = manualRedirect ? NoRedirectDelegate() : nil
    let session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
    let task = session.dataTask(with: req) { data, resp, err in
      _ = box.finishFromResponse(data: data, resp: resp, err: err)
      sem.signal()
    }
    task.resume()
    if sem.wait(timeout: .now() + timeoutSec + 2.0) == .timedOut {
      box.markTimedOutIfPending()
      task.cancel()
    }
    session.invalidateAndCancel()
    if let json = box.snapshotJsonData(),
       let text = String(data: json, encoding: .utf8) {
      print(text)
    } else {
      print("{\"ok\":false,\"error\":\"encode error\"}")
    }
  }
}
