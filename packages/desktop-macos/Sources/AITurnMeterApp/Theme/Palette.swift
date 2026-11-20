import SwiftUI

enum CodexBarPalette {
  static let cardTop = Color(red: 0.05, green: 0.43, blue: 0.96)
  static let cardBottom = Color(red: 0.02, green: 0.27, blue: 0.76)
  static let accentBlue = Color(red: 0.05, green: 0.40, blue: 0.94)
  static let tealBar = Color(red: 0.29, green: 0.65, blue: 0.72)
  static let paceGreen = Color(red: 0.20, green: 0.72, blue: 0.42)

  static func color(hex: String?) -> Color? {
    guard var s = hex?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
    if s.hasPrefix("#") { s.removeFirst() }
    if s.count == 3 {
      s = s.map { "\($0)\($0)" }.joined()
    }
    guard s.count == 6, let value = UInt64(s, radix: 16) else { return nil }
    let r = Double((value >> 16) & 0xFF) / 255.0
    let g = Double((value >> 8) & 0xFF) / 255.0
    let b = Double(value & 0xFF) / 255.0
    return Color(red: r, green: g, blue: b)
  }
}
