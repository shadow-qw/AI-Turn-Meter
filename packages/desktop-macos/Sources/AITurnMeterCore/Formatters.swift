import Foundation

public enum MeterFormat {
  private static let timeFmtLock = NSLock()
  private static let todayTimeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "HH:mm"
    return f
  }()
  private static let pastDateTimeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "MM-dd HH:mm"
    return f
  }()

  private static func trimFixedDecimal(_ raw: String) -> String {
    var trimmed = raw
    while trimmed.contains(".") && (trimmed.hasSuffix("0") || trimmed.hasSuffix(".")) {
      trimmed.removeLast()
    }
    return trimmed
  }

  public static func tokens(_ n: Int?) -> String {
    guard let n = n, n >= 0 else { return "N/A" }
    if n < 1000 { return "\(n)" }
    if n < 999_950 {
      return String(format: "%.1fk", Double(n) / 1000.0).replacingOccurrences(of: ".0k", with: "k")
    }
    if n < 999_995_000 {
      return trimFixedDecimal(String(format: "%.2f", Double(n) / 1_000_000.0)) + "M"
    }
    return trimFixedDecimal(String(format: "%.2f", Double(n) / 1_000_000_000.0)) + "B"
  }

  public static func bytes(_ count: Int64) -> String {
    if count <= 0 { return "0 B" }
    if count < 1024 { return "\(count) B" }
    let kb = Double(count) / 1024.0
    if count < 1024 * 1024 {
      return trimFixedDecimal(String(format: "%.1f", kb)) + " KB"
    }
    let mb = kb / 1024.0
    if count < 1024 * 1024 * 1024 {
      return trimFixedDecimal(String(format: "%.1f", mb)) + " MB"
    }
    let gb = mb / 1024.0
    return trimFixedDecimal(String(format: "%.2f", gb)) + " GB"
  }

  public static func byteRate(_ bytesPerSec: Double) -> String {
    guard bytesPerSec.isFinite, bytesPerSec > 0 else { return "" }
    let rounded = Int64(bytesPerSec.rounded())
    guard rounded > 0 else { return "" }
    return "\(bytes(rounded))/s"
  }

  public static func eta(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 1 else { return "" }
    if seconds < 60 {
      return "剩余约 \(Int(seconds.rounded())) 秒"
    }
    if seconds < 3600 {
      return "剩余约 \(Int((seconds / 60.0).rounded())) 分钟"
    }
    return ""
  }

  public static func money(_ val: Double?, symbol: String = "$") -> String {
    guard let val = val, val.isFinite else { return "--" }
    let sym = symbol.isEmpty ? "$" : symbol
    if val <= 0 { return "\(sym)0.00" }
    if val < 0.01 { return "\(sym)\(String(format: "%.4f", val))" }
    return "\(sym)\(String(format: "%.2f", val))"
  }

  public static func compactMoney(_ val: Double?, symbol: String = "$") -> String {
    guard let val = val, val.isFinite else { return "--" }
    let sym = symbol.isEmpty ? "$" : symbol
    if val >= 10 { return "\(sym)\(Int(val.rounded()))" }
    return money(val, symbol: sym)
  }

  public static func usd(_ val: Double?) -> String {
    money(val, symbol: "$")
  }

  public static func tps(_ val: Double?) -> String {
    guard let val = val, val.isFinite, val > 0 else { return "N/A" }
    let str = val >= 100
      ? String(Int(val.rounded()))
      : String(format: "%.1f", val).replacingOccurrences(of: ".0", with: "")
    return "\(str) tok/s"
  }

  public static func pct(_ val: Double?) -> String {
    guard let val = val, val.isFinite else { return "--" }
    let str = String(format: "%.1f", val).replacingOccurrences(of: ".0", with: "")
    return "\(str)%"
  }

  public static func timeText(_ ms: Double?) -> String {
    guard let ms = ms, ms.isFinite, ms > 0 else { return "" }
    let date = Date(timeIntervalSince1970: ms / 1000.0)
    let isToday = Calendar.current.isDateInToday(date)
    timeFmtLock.lock()
    defer { timeFmtLock.unlock() }
    let fmt = isToday ? todayTimeFormatter : pastDateTimeFormatter
    fmt.timeZone = TimeZone.current
    return fmt.string(from: date)
  }

  public static func shortDate(_ ymd: String) -> String {
    let parts = ymd.split(separator: "-")
    if parts.count == 3 { return "\(parts[1])/\(parts[2])" }
    return ymd
  }

  public static func makeIsoDayFormatter() -> DateFormatter {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd"
    return f
  }
}
