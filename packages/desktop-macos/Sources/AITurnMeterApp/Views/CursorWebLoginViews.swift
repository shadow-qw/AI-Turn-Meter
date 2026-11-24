import AITurnMeterCore
import SwiftUI
import WebKit

struct CursorAuthWebView: NSViewRepresentable {
  let clearExistingCookies: Bool
  let manualCheckToken: Int
  let reloadToken: Int
  let onStatusChanged: (String) -> Void
  let onCapturedCookie: (String) -> Void

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    var parent: CursorAuthWebView
    weak var webView: WKWebView?
    var didCapture = false
    var lastManualToken = 0
    var lastReloadToken = 0
    var pollTimer: Timer?
    var popupWindows: [WKWebView: NSWindow] = [:]

    init(_ parent: CursorAuthWebView) {
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
      let onDashboard: Bool = {
        guard let url = currentUrl, let host = url.host?.lowercased(), host.contains("cursor.com") else {
          return false
        }
        let path = url.path.lowercased()
        return !path.contains("login") && !path.contains("auth") && !path.contains("sign-in")
      }()
      guard force || onDashboard else { return }

      let now = Date()
      store.getAllCookies { [weak self] cookies in
        guard let self = self, !self.didCapture else { return }
        let cursorCookies = cookies.filter {
          let dom = $0.domain.lowercased()
          let notExpired = $0.expiresDate.map { $0 > now } ?? true
          return (dom.contains("cursor.com") || dom.contains("cursor.sh")) && notExpired && !$0.value.isEmpty
        }
        var deduped: [String: HTTPCookie] = [:]
        for c in cursorCookies.sorted(by: { $0.domain.count < $1.domain.count || $0.path.count < $1.path.count }) {
          deduped[c.name] = c
        }
        let uniqueCookies = Array(deduped.values).sorted { $0.name < $1.name }
        let hasSession = uniqueCookies.contains { MeterViewModel.cursorSessionCookieNames.contains($0.name) }
        guard hasSession else {
          if force {
            DispatchQueue.main.async {
              self.parent.onStatusChanged("尚未检测到登录凭证，请在下方完成 Cursor 账号登录后再试。")
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
      parent.onStatusChanged("请在下方登录 Cursor 账号；登录完成后将自动同步额度。")
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
        win.title = "Cursor 登录授权"
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
    cfg.websiteDataStore = .default()
    let wv = WKWebView(frame: .zero, configuration: cfg)
    wv.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    wv.navigationDelegate = context.coordinator
    wv.uiDelegate = context.coordinator
    context.coordinator.webView = wv
    context.coordinator.startPolling()

    let target = URL(string: "https://cursor.com/dashboard?tab=usage")!
    if clearExistingCookies {
      let cookieStore = cfg.websiteDataStore.httpCookieStore
      cookieStore.getAllCookies { cookies in
        let toDelete = cookies.filter {
          let dom = $0.domain.lowercased()
          return (dom.contains("cursor.com") || dom.contains("cursor.sh")) &&
            MeterViewModel.cursorSessionCookieNames.contains($0.name)
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
      } else if let target = URL(string: "https://cursor.com/dashboard?tab=usage") {
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

struct CursorWebLoginSheetView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var statusText: String = "正在加载 cursor.com 登录页…"
  @State private var manualCheckToken: Int = 0
  @State private var reloadToken: Int = 0
  @State private var clearOnOpen: Bool

  @MainActor
  init(vm: MeterViewModel) {
    self.vm = vm
    self._clearOnOpen = State(initialValue: vm.hasCursorCookie)
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Image(systemName: "person.badge.key")
          .foregroundColor(CodexBarPalette.accentBlue)
        VStack(alignment: .leading, spacing: 2) {
          Text("连接 Cursor 网页会话")
            .font(.system(size: 13.5, weight: .semibold))
          Text(statusText)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
            .lineLimit(1)
        }
        Spacer()
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

        Button("粘贴 Cookie…") {
          vm.cursorCookieDraft = ""
          vm.presentSheet(.cursorCookie)
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

      CursorAuthWebView(
        clearExistingCookies: clearOnOpen,
        manualCheckToken: manualCheckToken,
        reloadToken: reloadToken,
        onStatusChanged: { msg in statusText = msg },
        onCapturedCookie: { cookieHeader in
          vm.activeSheet = nil
          vm.saveCursorCookie(cookieHeader)
        }
      )
    }
    .frame(width: 720, height: 560)
  }
}
