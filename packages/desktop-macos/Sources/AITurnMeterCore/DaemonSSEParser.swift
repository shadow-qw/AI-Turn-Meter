import Foundation

public struct SSEEvent: Equatable {
  public let event: String
  public let data: String

  public init(event: String, data: String) {
    self.event = event
    self.data = data
  }
}

public struct DaemonSSEParser {
  private var buffer: String = ""

  public init() {}

  public mutating func feed(_ chunk: Data) -> [SSEEvent] {
    guard !chunk.isEmpty, let str = String(data: chunk, encoding: .utf8) else {
      return []
    }
    let normalized = str
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
    buffer.append(normalized)

    var events: [SSEEvent] = []
    while let range = buffer.range(of: "\n\n") {
      let block = String(buffer[..<range.lowerBound])
      buffer.removeSubrange(buffer.startIndex..<range.upperBound)
      if let ev = parseBlock(block) {
        events.append(ev)
      }
    }
    return events
  }

  public mutating func reset() {
    buffer = ""
  }

  private func parseBlock(_ block: String) -> SSEEvent? {
    var eventName = "message"
    var dataLines: [String] = []

    for rawLine in block.components(separatedBy: "\n") {
      if rawLine.isEmpty || rawLine.hasPrefix(":") {
        continue
      }
      if rawLine.hasPrefix("event:") {
        eventName = String(rawLine.dropFirst(6)).trimmingCharacters(in: .whitespaces)
      } else if rawLine.hasPrefix("data:") {
        var val = String(rawLine.dropFirst(5))
        if val.hasPrefix(" ") { val.removeFirst() }
        dataLines.append(val)
      }
    }

    guard !dataLines.isEmpty else { return nil }
    return SSEEvent(event: eventName.isEmpty ? "message" : eventName, data: dataLines.joined(separator: "\n"))
  }
}
