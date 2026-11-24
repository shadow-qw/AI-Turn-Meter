import Foundation

public struct SSEEvent: Equatable, Sendable {
  public let event: String
  public let data: String

  public init(event: String, data: String) {
    self.event = event
    self.data = data
  }
}

public struct DaemonSSEParser: Sendable {
  private var rawBuffer = Data()
  private var currentEventName: String = "message"
  private var currentDataLines: [String] = []

  public init() {}

  public mutating func feed(_ chunk: Data) -> [SSEEvent] {
    guard !chunk.isEmpty else {
      return []
    }
    rawBuffer.append(chunk)

    var events: [SSEEvent] = []
    var lineStart = rawBuffer.startIndex

    while let newlineIdx = rawBuffer[lineStart...].firstIndex(of: 0x0A) {
      var lineEnd = newlineIdx
      if lineEnd > lineStart && rawBuffer[rawBuffer.index(before: lineEnd)] == 0x0D {
        lineEnd = rawBuffer.index(before: lineEnd)
      }
      let lineData = rawBuffer[lineStart..<lineEnd]
      let line = String(decoding: lineData, as: UTF8.self)
      if let ev = processLine(line) {
        events.append(ev)
      }
      lineStart = rawBuffer.index(after: newlineIdx)
    }

    if lineStart == rawBuffer.endIndex {
      rawBuffer.removeAll(keepingCapacity: rawBuffer.count < 65_536)
    } else if lineStart > rawBuffer.startIndex {
      rawBuffer.removeSubrange(rawBuffer.startIndex..<lineStart)
    }

    return events
  }

  public mutating func reset() {
    rawBuffer.removeAll(keepingCapacity: false)
    currentEventName = "message"
    currentDataLines.removeAll(keepingCapacity: false)
  }

  private mutating func processLine(_ rawLine: String) -> SSEEvent? {
    if rawLine.isEmpty {
      defer {
        currentEventName = "message"
        currentDataLines.removeAll(keepingCapacity: true)
      }
      guard !currentDataLines.isEmpty else { return nil }
      let eventName = currentEventName.isEmpty ? "message" : currentEventName
      return SSEEvent(event: eventName, data: currentDataLines.joined(separator: "\n"))
    }

    if rawLine.hasPrefix(":") {
      return nil
    }
    if rawLine.hasPrefix("event:") {
      currentEventName = String(rawLine.dropFirst(6)).trimmingCharacters(in: .whitespaces)
    } else if rawLine.hasPrefix("data:") {
      var val = String(rawLine.dropFirst(5))
      if val.hasPrefix(" ") { val.removeFirst() }
      currentDataLines.append(val)
    }
    return nil
  }
}
