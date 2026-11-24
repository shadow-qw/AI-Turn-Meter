import Foundation

/// Byte-level download helper backed by URLSessionDownloadDelegate with EWMA speed estimation.
final class UpdateDownloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  private let url: URL
  private let destinationUrl: URL
  private let userAgent: String
  private let onProgress: @Sendable (Int64, Int64, Double?) -> Void
  private let onFinish: @Sendable (Result<URL, Error>) -> Void

  private let lock = NSLock()
  private var session: URLSession?
  private var task: URLSessionDownloadTask?
  private var didMoveFile = false
  private var finished = false
  private var httpStatusError: Error?
  private var lastEmitAt: CFAbsoluteTime = 0
  private var lastSampleAt: CFAbsoluteTime = 0
  private var lastSampleBytes: Int64 = 0
  private var ewmaSpeed: Double?

  init(
    url: URL,
    destinationUrl: URL,
    userAgent: String,
    onProgress: @escaping @Sendable (Int64, Int64, Double?) -> Void,
    onFinish: @escaping @Sendable (Result<URL, Error>) -> Void
  ) {
    self.url = url
    self.destinationUrl = destinationUrl
    self.userAgent = userAgent
    self.onProgress = onProgress
    self.onFinish = onFinish
    super.init()
  }

  func start() {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 600
    config.requestCachePolicy = .reloadIgnoringLocalCacheData

    var req = URLRequest(url: url, timeoutInterval: 30)
    req.cachePolicy = .reloadIgnoringLocalCacheData
    req.setValue(userAgent, forHTTPHeaderField: "User-Agent")

    let createdSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    let createdTask = createdSession.downloadTask(with: req)

    lock.lock()
    if finished {
      lock.unlock()
      createdSession.invalidateAndCancel()
      return
    }
    self.session = createdSession
    self.task = createdTask
    let now = CFAbsoluteTimeGetCurrent()
    self.lastSampleAt = now
    self.lastEmitAt = 0
    self.lastSampleBytes = 0
    self.ewmaSpeed = nil
    lock.unlock()

    createdTask.resume()
  }

  func cancel() {
    lock.lock()
    let t = task
    let s = session
    task = nil
    session = nil
    lock.unlock()

    t?.cancel()
    s?.invalidateAndCancel()
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    let now = CFAbsoluteTimeGetCurrent()
    var shouldEmit = false
    var speedToEmit: Double?

    lock.lock()
    let sampleDt = now - lastSampleAt
    if sampleDt >= 0.25 && totalBytesWritten >= lastSampleBytes {
      let inst = Double(totalBytesWritten - lastSampleBytes) / sampleDt
      ewmaSpeed = ewmaSpeed.map { 0.35 * inst + 0.65 * $0 } ?? inst
      lastSampleAt = now
      lastSampleBytes = totalBytesWritten
    }
    let atEnd = totalBytesExpectedToWrite > 0 && totalBytesWritten >= totalBytesExpectedToWrite
    if atEnd || (now - lastEmitAt) >= 0.10 {
      shouldEmit = true
      lastEmitAt = now
      speedToEmit = ewmaSpeed
    }
    lock.unlock()

    if shouldEmit {
      onProgress(totalBytesWritten, totalBytesExpectedToWrite, speedToEmit)
    }
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    if let http = downloadTask.response as? HTTPURLResponse,
       !(200...299).contains(http.statusCode) {
      lock.lock()
      httpStatusError = NSError(
        domain: "AITurnMeterUpdate",
        code: http.statusCode,
        userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"]
      )
      lock.unlock()
      return
    }

    let fm = FileManager.default
    try? fm.removeItem(at: destinationUrl)
    do {
      try fm.moveItem(at: location, to: destinationUrl)
      let actualSize = (try? fm.attributesOfItem(atPath: destinationUrl.path)[.size] as? NSNumber)?.int64Value
        ?? max(downloadTask.countOfBytesReceived, 0)
      lock.lock()
      didMoveFile = true
      lock.unlock()
      onProgress(actualSize, actualSize, nil)
    } catch {
      lock.lock()
      httpStatusError = error
      lock.unlock()
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.lock()
    let s = self.session
    let moved = self.didMoveFile
    let statusErr = self.httpStatusError
    let alreadyFinished = self.finished
    self.finished = true
    self.session = nil
    self.task = nil
    lock.unlock()

    s?.finishTasksAndInvalidate()
    guard !alreadyFinished else { return }

    if let err = error {
      onFinish(.failure(err))
    } else if let statusErr = statusErr {
      onFinish(.failure(statusErr))
    } else if moved {
      onFinish(.success(destinationUrl))
    } else {
      onFinish(
        .failure(
          NSError(
            domain: "AITurnMeterUpdate",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "下载未返回文件。"]
          )
        )
      )
    }
  }
}
