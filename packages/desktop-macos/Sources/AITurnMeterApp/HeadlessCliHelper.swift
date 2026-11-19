import Foundation
import LocalAuthentication
import Security

enum HeadlessCliHelper {
  static func readCursorSafeStoragePasswords(allowPrompt: Bool) -> [String] {
    var results: [String] = []
    let accounts = ["Cursor Key", "Cursor"]
    for acct in accounts {
      if let pw = readKeychainPassword(service: "Cursor Safe Storage", account: acct, allowPrompt: allowPrompt),
         !results.contains(pw) {
        results.append(pw)
      }
    }
    if results.isEmpty,
       let pw = readKeychainPassword(service: "Cursor Safe Storage", account: nil, allowPrompt: allowPrompt),
       !results.contains(pw) {
      results.append(pw)
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

  private static func readKeychainPassword(service: String, account: String?, allowPrompt: Bool) -> String? {
    if !allowPrompt && !isKeychainDecryptAllowedWithoutUI(service: service, account: account) {
      return nil
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
    guard status == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
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
    return false
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

    let cfg = URLSessionConfiguration.ephemeral
    cfg.httpShouldSetCookies = false
    cfg.httpCookieAcceptPolicy = .never
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = timeoutSec
    cfg.timeoutIntervalForResource = timeoutSec + 2.0

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
    var outPayload: [String: Any] = ["ok": false]
    let session = URLSession(configuration: cfg)
    session.dataTask(with: req) { data, resp, err in
      if let http = resp as? HTTPURLResponse {
        outPayload["status"] = http.statusCode
        outPayload["ok"] = (200...299).contains(http.statusCode)
        var respHeaders: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
          respHeaders[String(describing: k).lowercased()] = String(describing: v)
        }
        outPayload["headers"] = respHeaders
      }
      if let data = data, let text = String(data: data, encoding: .utf8) {
        outPayload["body"] = text
      }
      if let err = err {
        outPayload["error"] = err.localizedDescription
      }
      sem.signal()
    }.resume()
    if sem.wait(timeout: .now() + timeoutSec + 2.0) == .timedOut {
      outPayload["error"] = "timeout"
    }
    session.invalidateAndCancel()
    if let json = try? JSONSerialization.data(withJSONObject: outPayload),
       let text = String(data: json, encoding: .utf8) {
      print(text)
    } else {
      print("{\"ok\":false,\"error\":\"encode error\"}")
    }
  }
}
