import Foundation

public enum MeterFormat {
  public static func tokens(_ n: Int?) -> String {
    guard let n = n, n >= 0 else { return "N/A" }
    if n < 1000 { return "\(n)" }
    if n < 1_000_000 {
      return String(format: "%.1fk", Double(n) / 1000.0).replacingOccurrences(of: ".0k", with: "k")
    }
    let m = String(format: "%.2f", Double(n) / 1_000_000.0)
    var trimmed = m
    while trimmed.contains(".") && (trimmed.hasSuffix("0") || trimmed.hasSuffix(".")) {
      trimmed.removeLast()
    }
    return "\(trimmed)M"
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
    guard let ms = ms, ms > 0 else { return "" }
    let date = Date(timeIntervalSince1970: ms / 1000.0)
    let fmt = DateFormatter()
    fmt.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "MM-dd HH:mm"
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
