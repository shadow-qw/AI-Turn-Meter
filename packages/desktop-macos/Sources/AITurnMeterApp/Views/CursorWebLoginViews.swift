import AITurnMeterCore
import SwiftUI
import WebKit

struct CursorAuthWebView: NSViewRepresentable {
  let clearExistingCookies: Bool
  let manualCheckToken: Int
  let onStatusChanged: (String) -> Void
  let onCapturedCookie: (String) -> Void

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    var parent: CursorAuthWebView
    weak var webView: WKWebView?
    var didCapture = false
    var lastManualToken = 0
    var pollTimer: Timer?

    init(_ parent: CursorAuthWebView) {
      self.parent = parent
      self.lastManualToken = parent.manualCheckToken
    }

    deinit {
      pollTimer?.invalidate()
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

      store.getAllCookies { [weak self] cookies in
        guard let self = self, !self.didCapture else { return }
        let sessionNames: Set<String> = [
          "WorkosCursorSessionToken",
          "__Secure-next-auth.session-token",
          "next-auth.session-token",
          "wos-session",
          "__Secure-wos-session",
          "authjs.session-token",
          "__Secure-authjs.session-token",
        ]
        let cursorCookies = cookies.filter {
          let dom = $0.domain.lowercased()
          return (dom.contains("cursor.com") || dom.contains("cursor.sh")) && !$0.value.isEmpty
        }
        let hasSession = cursorCookies.contains { sessionNames.contains($0.name) }
        guard hasSession else {
          if force {
            DispatchQueue.main.async {
              self.parent.onStatusChanged("尚未检测到登录凭证，请在下方完成 Cursor 账号登录后再试。")
            }
          }
          return
        }
        let header = cursorCookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
        self.didCapture = true
        DispatchQueue.main.async {
          self.stopPolling()
          self.parent.onCapturedCookie(header)
        }
      }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
      if let host = webView.url?.host {
        parent.onStatusChanged("正在打开 \(host)…")
      }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      parent.onStatusChanged("请在下方登录 Cursor 账号；登录完成后将自动同步额度。")
      checkCookies(force: false)
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
          $0.domain.lowercased().contains("cursor.com") && $0.name == "WorkosCursorSessionToken"
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
  }

  static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
    coordinator.stopPolling()
    nsView.navigationDelegate = nil
    nsView.uiDelegate = nil
  }
}

struct CursorWebLoginSheetView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var statusText: String = "正在加载 cursor.com 登录页…"
  @State private var manualCheckToken: Int = 0
  @State private var clearOnOpen: Bool = false

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
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
        Button("同步当前登录态") {
          manualCheckToken += 1
        }
        .buttonStyle(.bordered)
        .controlSize(.small)

        Button("粘贴 Cookie…") {
          vm.showCursorLoginSheet = false
          vm.cursorCookieDraft = ""
          vm.showCursorCookieSheet = true
        }
        .buttonStyle(.bordered)
        .controlSize(.small)

        Button("关闭") {
          vm.showCursorLoginSheet = false
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
        onStatusChanged: { msg in statusText = msg },
        onCapturedCookie: { cookieHeader in
          vm.showCursorLoginSheet = false
          vm.saveCursorCookie(cookieHeader)
        }
      )
    }
    .frame(width: 720, height: 560)
    .onAppear {
      clearOnOpen = vm.hasCursorCookie
    }
  }
}
