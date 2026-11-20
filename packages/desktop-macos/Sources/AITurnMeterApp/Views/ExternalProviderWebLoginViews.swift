import AITurnMeterCore
import SwiftUI
import WebKit

/// Generic in-app web login for external provider plugins.
/// The plugin declares `auth` (loginUrl / cookieDomains / ...); the app only captures
/// what the user's own interactive login produces and hands it to the local daemon.
struct ExternalProviderAuthWebView: NSViewRepresentable {
  let auth: ExternalProviderAuth
  let manualCheckToken: Int
  let onStatusChanged: (String) -> Void
  let onCaptured: ([String: Any]) -> Void

  private static let userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    var parent: ExternalProviderAuthWebView
    weak var webView: WKWebView?
    var didCapture = false
    var lastManualToken = 0
    var pollTimer: Timer?

    init(_ parent: ExternalProviderAuthWebView) {
      self.parent = parent
      self.lastManualToken = parent.manualCheckToken
    }

    deinit { pollTimer?.invalidate() }

    func startPolling() {
      pollTimer?.invalidate()
      pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
        self?.check(force: false)
      }
    }

    func stopPolling() {
      pollTimer?.invalidate()
      pollTimer = nil
    }

    private var domains: [String] {
      (parent.auth.cookieDomains ?? []).map { $0.lowercased() }
    }

    func cookieApplies(_ cookie: HTTPCookie) -> Bool {
      let cd = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
      return domains.contains { t in
        cd == t || t.hasSuffix("." + cd) || cd.hasSuffix("." + t)
      }
    }

    private func onTargetPage(_ url: URL?) -> Bool {
      guard let url = url, let host = url.host?.lowercased() else { return false }
      let hostOk = domains.contains { host == $0 || host.hasSuffix("." + $0) }
      guard hostOk else { return false }
      let prefixes = parent.auth.successUrlPrefixes ?? []
      if !prefixes.isEmpty {
        return prefixes.contains { url.absoluteString.hasPrefix($0) }
      }
      let path = url.path.lowercased()
      let keywords = parent.auth.excludePathKeywords ?? []
      return !keywords.contains { path.contains($0.lowercased()) }
    }

    func check(force: Bool) {
      guard !didCapture, let wv = webView else { return }
      guard force || onTargetPage(wv.url) else { return }
      let store = wv.configuration.websiteDataStore.httpCookieStore
      store.getAllCookies { [weak self] all in
        guard let self = self, !self.didCapture else { return }
        let cookies = all.filter { self.cookieApplies($0) && !$0.value.isEmpty }
        let required = self.parent.auth.requiredCookies ?? []
        let names = Set(cookies.map(\.name))
        let missing = required.filter { !names.contains($0) }
        guard !cookies.isEmpty, missing.isEmpty else {
          if force {
            DispatchQueue.main.async {
              self.parent.onStatusChanged("尚未检测到登录凭证，请先在下方完成登录后再试。")
            }
          }
          return
        }
        var cookieMap: [String: String] = [:]
        for c in cookies { cookieMap[c.name] = c.value }
        let header = cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
        self.captureStorage(from: wv) { storage in
          guard !self.didCapture else { return }
          self.didCapture = true
          var creds: [String: Any] = [
            "cookie": header,
            "cookies": cookieMap,
            "userAgent": ExternalProviderAuthWebView.userAgent,
          ]
          if let origin = wv.url, let scheme = origin.scheme, let host = origin.host {
            creds["origin"] = "\(scheme)://\(host)"
          }
          if !storage.isEmpty { creds["storage"] = storage }
          self.stopPolling()
          self.parent.onCaptured(creds)
        }
      }
    }

    private func captureStorage(from wv: WKWebView, completion: @escaping ([String: Any]) -> Void) {
      let keys = parent.auth.captureStorageKeys ?? []
      guard !keys.isEmpty,
            let data = try? JSONSerialization.data(withJSONObject: keys),
            let keysJson = String(data: data, encoding: .utf8) else {
        completion([:])
        return
      }
      let js = """
      (function(){
        var keys = \(keysJson);
        function pick(s){ var o = {}; try { keys.forEach(function(k){ var v = s.getItem(k); if (v) o[k] = v; }); } catch(e){} return o; }
        return JSON.stringify({ local: pick(window.localStorage), session: pick(window.sessionStorage) });
      })()
      """
      wv.evaluateJavaScript(js) { result, _ in
        var out: [String: Any] = [:]
        if let s = result as? String,
           let d = s.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
          if let l = obj["local"] as? [String: String], !l.isEmpty { out["local"] = l }
          if let ss = obj["session"] as? [String: String], !ss.isEmpty { out["session"] = ss }
        }
        completion(out)
      }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
      if let host = webView.url?.host {
        parent.onStatusChanged("正在打开 \(host)…")
      }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      parent.onStatusChanged("请在下方完成登录；登录成功后将自动同步。")
      check(force: false)
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

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> WKWebView {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default()
    let wv = WKWebView(frame: .zero, configuration: cfg)
    wv.customUserAgent = Self.userAgent
    wv.navigationDelegate = context.coordinator
    wv.uiDelegate = context.coordinator
    context.coordinator.webView = wv
    context.coordinator.startPolling()

    guard let raw = auth.loginUrl, let target = URL(string: raw) else { return wv }
    // Drop stale target-domain cookies so re-login really re-authenticates;
    // identity-provider cookies on other domains are kept, so SSO stays seamless.
    let store = cfg.websiteDataStore.httpCookieStore
    store.getAllCookies { cookies in
      let stale = cookies.filter { context.coordinator.cookieApplies($0) }
      let group = DispatchGroup()
      for c in stale {
        group.enter()
        store.delete(c) { group.leave() }
      }
      group.notify(queue: .main) {
        wv.load(URLRequest(url: target))
      }
    }
    return wv
  }

  func updateNSView(_ nsView: WKWebView, context: Context) {
    context.coordinator.parent = self
    if manualCheckToken != context.coordinator.lastManualToken {
      context.coordinator.lastManualToken = manualCheckToken
      context.coordinator.check(force: true)
    }
  }

  static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
    coordinator.stopPolling()
    nsView.navigationDelegate = nil
    nsView.uiDelegate = nil
  }
}

struct ExternalProviderLoginSheetView: View {
  @ObservedObject var vm: MeterViewModel
  let key: String
  @State private var statusText: String = "正在加载登录页…"
  @State private var manualCheckToken: Int = 0

  var body: some View {
    let meta = vm.externalProviderMeta(for: key)
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "person.badge.key")
          .foregroundColor(CodexBarPalette.accentBlue)
        VStack(alignment: .leading, spacing: 2) {
          Text("登录授权 · \(meta?.name ?? key)")
            .font(.system(size: 13.5, weight: .semibold))
          Text(meta?.auth?.hint ?? statusText)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
            .lineLimit(1)
        }
        Spacer()
        Button("同步当前登录态") { manualCheckToken += 1 }
          .buttonStyle(.bordered)
          .controlSize(.small)
        Button("关闭") { vm.pluginLoginKey = nil }
          .buttonStyle(.bordered)
          .controlSize(.small)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)

      Divider()

      if let auth = meta?.auth, auth.isWebCookie {
        ExternalProviderAuthWebView(
          auth: auth,
          manualCheckToken: manualCheckToken,
          onStatusChanged: { msg in statusText = msg },
          onCaptured: { creds in
            vm.pluginLoginKey = nil
            vm.savePluginCredentials(key: key, credentials: creds)
          }
        )
      } else {
        VStack(spacing: 8) {
          Image(systemName: "exclamationmark.triangle")
            .foregroundColor(.orange)
          Text("该插件未声明网页登录方式")
            .font(.system(size: 12.5))
            .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .frame(width: 760, height: 580)
  }
}
