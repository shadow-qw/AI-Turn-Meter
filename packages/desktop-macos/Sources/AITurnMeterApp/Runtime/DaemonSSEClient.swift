import AITurnMeterCore
import Foundation

final class DaemonSSEClient: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let stateLock = NSLock()
  private var _onConnected: (() -> Void)?
  private var _onDisconnected: (() -> Void)?
  private var _onEvent: ((SSEEvent) -> Void)?
  private var _stoppedGeneration: Int = 0
  private var _clientRunning: Bool = false

  var onConnected: (() -> Void)? {
    get { stateLock.lock(); defer { stateLock.unlock() }; return _onConnected }
    set { stateLock.lock(); defer { stateLock.unlock() }; _onConnected = newValue }
  }

  var onDisconnected: (() -> Void)? {
    get { stateLock.lock(); defer { stateLock.unlock() }; return _onDisconnected }
    set { stateLock.lock(); defer { stateLock.unlock() }; _onDisconnected = newValue }
  }

  var onEvent: ((SSEEvent) -> Void)? {
    get { stateLock.lock(); defer { stateLock.unlock() }; return _onEvent }
    set { stateLock.lock(); defer { stateLock.unlock() }; _onEvent = newValue }
  }

  private let delegateQueue: OperationQueue = {
    let q = OperationQueue()
    q.name = "com.local.ai-turn-meter.sse"
    q.maxConcurrentOperationCount = 1
    return q
  }()

  private var port: Int = 47831
  private var isRunning: Bool = false
  private var session: URLSession?
  private var activeTask: URLSessionDataTask?
  private var parser = DaemonSSEParser()
  private var backoffSeconds: TimeInterval = 2.0
  private var reconnectGeneration: Int = 0

  func start(port: Int) {
    stateLock.lock()
    _clientRunning = true
    stateLock.unlock()
    delegateQueue.addOperation { [weak self] in
      guard let self = self else { return }
      if self.isRunning && self.port == port && self.activeTask != nil {
        return
      }
      self.port = port
      self.isRunning = true
      self.backoffSeconds = 2.0
      self.connectNow()
    }
  }

  func reconnect(port: Int? = nil) {
    stateLock.lock()
    _clientRunning = true
    stateLock.unlock()
    delegateQueue.addOperation { [weak self] in
      guard let self = self else { return }
      if let port = port { self.port = port }
      self.isRunning = true
      self.backoffSeconds = 2.0
      self.connectNow()
    }
  }

  func stop() {
    stateLock.lock()
    _clientRunning = false
    _stoppedGeneration &+= 1
    stateLock.unlock()
    delegateQueue.addOperation { [weak self] in
      guard let self = self else { return }
      self.isRunning = false
      self.reconnectGeneration += 1
      self.activeTask?.cancel()
      self.activeTask = nil
      self.session?.invalidateAndCancel()
      self.session = nil
      self.parser.reset()
    }
  }

  private func connectNow() {
    reconnectGeneration += 1
    activeTask?.cancel()
    activeTask = nil
    session?.invalidateAndCancel()
    session = nil
    parser.reset()

    guard isRunning, let url = URL(string: "http://127.0.0.1:\(port)/events") else { return }

    let cfg = URLSessionConfiguration.ephemeral
    cfg.connectionProxyDictionary = [:]
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = 60
    cfg.timeoutIntervalForResource = 86400

    let sess = URLSession(configuration: cfg, delegate: self, delegateQueue: delegateQueue)
    var req = DaemonAuth.authorizedRequest(url: url, method: "GET", timeout: 60)
    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    let task = sess.dataTask(with: req)
    self.session = sess
    self.activeTask = task
    task.resume()
  }

  private func scheduleReconnect() {
    guard isRunning else { return }
    let gen = reconnectGeneration
    let delay = backoffSeconds
    backoffSeconds = min(10.0, backoffSeconds * 2.0)
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay) { [weak self] in
      self?.delegateQueue.addOperation { [weak self] in
        guard let self = self, self.isRunning, self.reconnectGeneration == gen else { return }
        self.connectNow()
      }
    }
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard dataTask === activeTask else {
      completionHandler(.cancel)
      return
    }
    if let http = response as? HTTPURLResponse, http.statusCode == 200 {
      backoffSeconds = 2.0
      stateLock.lock()
      let cb = _onConnected
      let stopGen = _stoppedGeneration
      let canRun = _clientRunning
      stateLock.unlock()
      guard canRun else {
        completionHandler(.cancel)
        return
      }
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.stateLock.lock()
        let valid = self._clientRunning && self._stoppedGeneration == stopGen
        self.stateLock.unlock()
        if valid { cb?() }
      }
      completionHandler(.allow)
    } else {
      completionHandler(.cancel)
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard dataTask === activeTask else { return }
    let events = parser.feed(data)
    guard !events.isEmpty else { return }
    stateLock.lock()
    let cb = _onEvent
    let stopGen = _stoppedGeneration
    let canRun = _clientRunning
    stateLock.unlock()
    guard canRun else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.stateLock.lock()
      let valid = self._clientRunning && self._stoppedGeneration == stopGen
      self.stateLock.unlock()
      guard valid else { return }
      for ev in events {
        cb?(ev)
      }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard task === activeTask else { return }
    activeTask = nil
    self.session?.invalidateAndCancel()
    self.session = nil
    stateLock.lock()
    let cb = _onDisconnected
    let stopGen = _stoppedGeneration
    let canRun = _clientRunning
    stateLock.unlock()
    if canRun {
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.stateLock.lock()
        let valid = self._clientRunning && self._stoppedGeneration == stopGen
        self.stateLock.unlock()
        if valid { cb?() }
      }
      scheduleReconnect()
    }
  }
}
