import AITurnMeterCore
import Network
import SwiftUI
import WebKit

enum ClaudeWebProxyHelper {
  static let storeIdentifier = UUID(uuidString: "A17E9C42-6D14-4F08-9B3C-2C8E7A1F5B04")!

  enum ProxyBindOutcome {
    case boundCustom(WKWebsiteDataStore, String)
    case useSystemProxy(WKWebsiteDataStore)
    case blocked(String)
  }

  @MainActor
  static func claudeWebsiteDataStore() -> WKWebsiteDataStore {
    if #available(macOS 14.0, *) {
      return WKWebsiteDataStore(forIdentifier: storeIdentifier)
    }
    return .default()
  }

  @MainActor
  static func prepareWebsiteDataStore(proxyUrl: String?) -> ProxyBindOutcome {
    let trimmed = (proxyUrl ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
      if #available(macOS 14.0, *) {
        guard let comps = URLComponents(string: trimmed),
              let scheme = comps.scheme?.lowercased(),
              let rawHost = comps.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rawHost.isEmpty else {
          return .blocked("Claude 代理地址无效，请检查后重试。")
        }
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let defaultPort: Int? = {
          switch scheme {
          case "http": return 80
          case "https": return 443
          case "socks5", "socks5h": return 1080
          default: return nil
          }
        }()
        guard let fallbackPort = defaultPort else {
          return .blocked("Claude 代理地址仅支持 http://、https:// 或 socks5:// 协议。")
        }
        let portInt = comps.port ?? fallbackPort
        guard (1...65535).contains(portInt),
              let nwPort = NWEndpoint.Port(rawValue: UInt16(portInt)) else {
          return .blocked("Claude 代理端口无效，请检查后重试。")
        }
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(host), port: nwPort)
        var config: ProxyConfiguration
        if scheme == "socks5" || scheme == "socks5h" {
          config = ProxyConfiguration(socksv5Proxy: endpoint)
        } else {
          let tlsOpts: NWProtocolTLS.Options? = (scheme == "https") ? NWProtocolTLS.Options() : nil
          config = ProxyConfiguration(httpCONNECTProxy: endpoint, tlsOptions: tlsOpts)
        }
        if let user = comps.user, !user.isEmpty, let pass = comps.password {
          config.applyCredential(username: user, password: pass)
        }
        let store = WKWebsiteDataStore(forIdentifier: storeIdentifier)
        store.proxyConfigurations = [config]
        return .boundCustom(store, trimmed)
      }
      if HeadlessCliHelper.hasActiveSystemProxy() {
        return .useSystemProxy(.default())
      }
      return .blocked("当前 macOS 13 不支持给内置网页单独绑定代理，请先开启系统代理，或使用「读取本机」/「粘贴 Cookie…」。")
    }

    if HeadlessCliHelper.hasActiveSystemProxy() {
      if #available(macOS 14.0, *) {
        let store = WKWebsiteDataStore(forIdentifier: storeIdentifier)
        store.proxyConfigurations = []
        return .useSystemProxy(store)
      }
      return .useSystemProxy(.default())
    }

    return .blocked("未检测到可用代理，已阻止内置网页直连 claude.ai（防止暴露真实 IP）。请先配置代理（如 http://127.0.0.1:17890）或开启 macOS 系统代理。")
  }
}

struct ClaudeAuthWebView: NSViewRepresentable {
  let websiteDataStore: WKWebsiteDataStore
  let clearExistingCookies: Bool
  let manualCheckToken: Int
  let reloadToken: Int
  let onStatusChanged: (String) -> Void
  let onCapturedCookie: (String) -> Void

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    var parent: ClaudeAuthWebView
    weak var webView: WKWebView?
    var didCapture = false
    var lastManualToken = 0
    var lastReloadToken = 0
    var pollTimer: Timer?
    var popupWindows: [WKWebView: NSWindow] = [:]

    init(_ parent: ClaudeAuthWebView) {
      self.parent = parent
      self.lastManualToken = parent.manualCheckToken
      self.lastReloadToken = parent.reloadToken
    }

    deinit {
      pollTimer?.invalidate()
    }

    func closeAllPopups() {
      for (popup, win) in popupWindows {
        popup.navigationDelegate = nil
        popup.uiDelegate = nil
        win.close()
      }
      popupWindows.removeAll()
    }

    func startPolling() {
      pollTimer?.invalidate()
      pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
        self?.checkCookies(force: false)
      }
    }

    func stopPolling() {
      pollTimer?.invalidate()
      pollTimer = nil
    }

    func checkCookies(force: Bool) {
      guard !didCapture, let wv = webView else { return }
      let store = wv.configuration.websiteDataStore.httpCookieStore
      let currentUrl = wv.url
      let onTargetPage: Bool = {
        guard let url = currentUrl, let host = url.host?.lowercased(), host.contains("claude.ai") else {
          return false
        }
        let path = url.path.lowercased()
        return !path.contains("login") && !path.contains("oauth") && !path.contains("auth")
      }()
      guard force || onTargetPage else { return }

      let now = Date()
      store.getAllCookies { [weak self] cookies in
        guard let self = self, !self.didCapture else { return }
        let claudeCookies = cookies.filter {
          let dom = $0.domain.lowercased()
          let notExpired = $0.expiresDate.map { $0 > now } ?? true
          return dom.contains("claude.ai") && notExpired && !$0.value.isEmpty
        }
        var deduped: [String: HTTPCookie] = [:]
        for c in claudeCookies.sorted(by: { $0.domain.count < $1.domain.count || $0.path.count < $1.path.count }) {
          deduped[c.name] = c
        }
        let uniqueCookies = Array(deduped.values).sorted { $0.name < $1.name }
        let hasSession = uniqueCookies.contains { MeterViewModel.claudeSessionCookieNames.contains($0.name) }
        guard hasSession else {
          if force {
            DispatchQueue.main.async {
              self.parent.onStatusChanged("尚未检测到登录凭证，请在下方完成 Claude 账号登录后再试。")
            }
          }
          return
        }
        let header = uniqueCookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
        self.didCapture = true
        DispatchQueue.main.async {
          self.stopPolling()
          self.closeAllPopups()
          self.parent.onCapturedCookie(header)
        }
      }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
      guard webView === self.webView else { return }
      if let host = webView.url?.host {
        parent.onStatusChanged("正在打开 \(host)…")
      }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      guard webView === self.webView else {
        checkCookies(force: false)
        return
      }
      parent.onStatusChanged("请在下方登录 Claude 账号；登录完成后将自动同步额度。")
      checkCookies(force: false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
      let nsErr = error as NSError
      if nsErr.domain == NSURLErrorDomain && nsErr.code == NSURLErrorCancelled { return }
      DispatchQueue.main.async { [weak self] in
        self?.parent.onStatusChanged("页面加载失败：\(error.localizedDescription)")
      }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
      let nsErr = error as NSError
      if nsErr.domain == NSURLErrorDomain && nsErr.code == NSURLErrorCancelled { return }
      DispatchQueue.main.async { [weak self] in
        self?.parent.onStatusChanged("页面加载失败：\(error.localizedDescription)")
      }
    }

    func webView(
      _ webView: WKWebView,
      createWebViewWith configuration: WKWebViewConfiguration,
      for navigationAction: WKNavigationAction,
      windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      if navigationAction.targetFrame == nil {
        let w = max(420, windowFeatures.width?.doubleValue ?? 540)
        let h = max(480, windowFeatures.height?.doubleValue ?? 640)
        let popup = WKWebView(frame: NSRect(x: 0, y: 0, width: w, height: h), configuration: configuration)
        popup.customUserAgent = webView.customUserAgent
        popup.navigationDelegate = self
        popup.uiDelegate = self
        let win = NSWindow(
          contentRect: NSRect(x: 0, y: 0, width: w, height: h),
          styleMask: [.titled, .closable, .resizable],
          backing: .buffered,
          defer: false
        )
        win.isReleasedWhenClosed = false
        win.title = "Claude 登录授权"
        win.center()
        win.contentView = popup
        win.makeKeyAndOrderFront(nil)
        popupWindows[popup] = win
        return popup
      }
      return nil
    }

    func webViewDidClose(_ webView: WKWebView) {
      if let win = popupWindows.removeValue(forKey: webView) {
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        win.close()
      }
    }
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(self)
  }

  func makeNSView(context: Context) -> WKWebView {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = websiteDataStore
    let wv = WKWebView(frame: .zero, configuration: cfg)
    wv.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    wv.navigationDelegate = context.coordinator
    wv.uiDelegate = context.coordinator
    context.coordinator.webView = wv
    context.coordinator.startPolling()

    let target = URL(string: "https://claude.ai/settings/usage")!
    if clearExistingCookies {
      let cookieStore = cfg.websiteDataStore.httpCookieStore
      cookieStore.getAllCookies { cookies in
        let toDelete = cookies.filter {
          let dom = $0.domain.lowercased()
          return dom.contains("claude.ai") && MeterViewModel.claudeSessionCookieNames.contains($0.name)
        }
        let group = DispatchGroup()
        for c in toDelete {
          group.enter()
          cookieStore.delete(c) { group.leave() }
        }
        group.notify(queue: .main) {
          wv.load(URLRequest(url: target))
        }
      }
    } else {
      wv.load(URLRequest(url: target))
    }
    return wv
  }

  func updateNSView(_ nsView: WKWebView, context: Context) {
    context.coordinator.parent = self
    if manualCheckToken != context.coordinator.lastManualToken {
      context.coordinator.lastManualToken = manualCheckToken
      context.coordinator.checkCookies(force: true)
    }
    if reloadToken != context.coordinator.lastReloadToken {
      context.coordinator.lastReloadToken = reloadToken
      if nsView.url != nil {
        nsView.reload()
      } else if let target = URL(string: "https://claude.ai/settings/usage") {
        nsView.load(URLRequest(url: target))
      }
    }
  }

  static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
    coordinator.stopPolling()
    coordinator.closeAllPopups()
    nsView.navigationDelegate = nil
    nsView.uiDelegate = nil
  }
}

struct ClaudeWebLoginSheetView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var statusText: String = "正在加载 claude.ai 登录页…"
  @State private var manualCheckToken: Int = 0
  @State private var reloadToken: Int = 0
  @State private var proxyCheckTick: Int = 0
  @State private var clearOnOpen: Bool
  @State private var proxyOutcome: ClaudeWebProxyHelper.ProxyBindOutcome

  @MainActor
  init(vm: MeterViewModel) {
    self.vm = vm
    self._clearOnOpen = State(initialValue: vm.hasClaudeCookie)
    self._proxyOutcome = State(
      initialValue: ClaudeWebProxyHelper.prepareWebsiteDataStore(proxyUrl: vm.effectiveClaudeProxyUrl)
    )
  }

  private func refreshProxyOutcome() {
    vm.refreshSystemProxyStatus()
    proxyOutcome = ClaudeWebProxyHelper.prepareWebsiteDataStore(proxyUrl: vm.effectiveClaudeProxyUrl)
  }

  var body: some View {
    let badgeText: String = {
      switch proxyOutcome {
      case .boundCustom(_, let p): return "代理：\(p)"
      case .useSystemProxy: return "系统代理"
      case .blocked: return "已阻止直连"
      }
    }()
    let isBlocked: Bool = {
      if case .blocked = proxyOutcome { return true }
      return false
    }()

    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Image(systemName: isBlocked ? "shield.lefthalf.filled.slash" : "person.badge.key")
          .foregroundColor(isBlocked ? .orange : CodexBarPalette.accentBlue)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text("连接 Claude 网页会话")
              .font(.system(size: 13.5, weight: .semibold))
            Text(badgeText)
              .font(.system(size: 10.5, weight: .medium))
              .foregroundColor(isBlocked ? .orange : .secondary)
              .padding(.horizontal, 6)
              .padding(.vertical, 1)
              .background(
                Capsule()
                  .fill(isBlocked ? Color.orange.opacity(0.14) : Color.primary.opacity(0.06))
              )
              .lineLimit(1)
          }
          Text(isBlocked ? "未检测到可用代理，已暂停加载网页以防暴露真实 IP" : statusText)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
            .lineLimit(1)
        }
        Spacer()
        if !isBlocked {
          Button("重新加载") {
            statusText = "正在重新加载…"
            reloadToken += 1
          }
          .buttonStyle(.bordered)
          .controlSize(.small)

          Button("同步当前登录态") {
            manualCheckToken += 1
          }
          .buttonStyle(.bordered)
          .controlSize(.small)
        }

        Button("粘贴 Cookie…") {
          vm.claudeCookieDraft = ""
          vm.presentSheet(.claudeCookie)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)

        Button("关闭") {
          vm.activeSheet = nil
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)

      Divider()

      switch proxyOutcome {
      case .boundCustom(let store, _), .useSystemProxy(let store):
        ClaudeAuthWebView(
          websiteDataStore: store,
          clearExistingCookies: clearOnOpen,
          manualCheckToken: manualCheckToken,
          reloadToken: reloadToken,
          onStatusChanged: { msg in statusText = msg },
          onCapturedCookie: { cookieHeader in
            vm.activeSheet = nil
            vm.saveClaudeCookie(cookieHeader)
          }
        )
        .id("\(vm.effectiveClaudeProxyUrl ?? "sys")-\(proxyCheckTick)")
      case .blocked(let reason):
        VStack(spacing: 14) {
          Spacer()
          Image(systemName: "shield.lefthalf.filled")
            .font(.system(size: 36))
            .foregroundColor(.orange)
          Text("已阻止直连 claude.ai")
            .font(.system(size: 15, weight: .semibold))
          Text(reason)
            .font(.system(size: 12.5))
            .foregroundColor(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: 460)
          HStack(spacing: 10) {
            Button("配置代理…") {
              vm.claudeProxyDraft = vm.claudeProxyUrl
              vm.presentSheet(.claudeProxy)
            }
            .buttonStyle(.borderedProminent)
            Button("重新检测") {
              proxyCheckTick += 1
              vm.fetchDaemonStateLight()
            }
            .buttonStyle(.bordered)
            Button("粘贴 Cookie…") {
              vm.claudeCookieDraft = ""
              vm.presentSheet(.claudeCookie)
            }
            .buttonStyle(.bordered)
          }
          Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
      }
    }
    .frame(width: 720, height: 560)
    .onChange(of: vm.effectiveClaudeProxyUrl) { _ in
      refreshProxyOutcome()
    }
    .onChange(of: proxyCheckTick) { _ in
      refreshProxyOutcome()
    }
  }
}
