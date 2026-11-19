import Foundation
import CoreFoundation

struct StableUpdate {
  let version: String
  let downloadURL: URL
  let notes: String
}

enum UpdatePolicy {
  private static func versionParts(_ raw: String) -> [Int]? {
    var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.hasPrefix("v") || text.hasPrefix("V") { text.removeFirst() }
    let parts = text.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3 else { return nil }
    var result: [Int] = []
    for part in parts {
      guard !part.isEmpty,
            part.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
            part == "0" || !part.hasPrefix("0"),
            let value = Int(part) else { return nil }
      result.append(value)
    }
    return result
  }

  static func isStable(_ version: String, prerelease: Bool = false) -> Bool {
    !prerelease && versionParts(version) != nil
  }

  static func compareStable(_ a: String, _ b: String) -> Int? {
    guard let left = versionParts(a), let right = versionParts(b) else { return nil }
    for i in 0..<3 {
      if left[i] != right[i] { return left[i] < right[i] ? -1 : 1 }
    }
    return 0
  }

  static func secureURL(_ raw: String) -> URL? {
    guard let decoded = raw.removingPercentEncoding,
          !decoded.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          raw == raw.trimmingCharacters(in: .whitespacesAndNewlines),
          let url = URL(string: raw),
          url.scheme?.lowercased() == "https",
          let host = url.host, !host.isEmpty,
          url.user == nil, url.password == nil, url.fragment == nil else { return nil }
    return url
  }

  static func isGitHubLatest(_ url: URL) -> Bool {
    let parts = url.path.split(separator: "/", omittingEmptySubsequences: false)
    return secureURL(url.absoluteString) != nil &&
      ["github.com", "www.github.com"].contains(url.host?.lowercased() ?? "") &&
      (url.port == nil || url.port == 443) && url.query == nil &&
      parts.count == 5 && parts[0].isEmpty && !parts[1].isEmpty && !parts[2].isEmpty &&
      parts[3] == "releases" && parts[4] == "latest"
  }

  static func githubCandidate(feed: URL, finalURL: URL, statusCode: Int, currentVersion: String) -> StableUpdate? {
    guard (200..<300).contains(statusCode), isGitHubLatest(feed),
          secureURL(finalURL.absoluteString) != nil,
          ["github.com", "www.github.com"].contains(finalURL.host?.lowercased() ?? ""),
          (finalURL.port == nil || finalURL.port == 443), finalURL.query == nil else { return nil }
    let source = feed.path.split(separator: "/")
    let target = finalURL.path.split(separator: "/", omittingEmptySubsequences: false)
    guard target.count == 6, target[0].isEmpty,
          target[1].lowercased() == source[0].lowercased(),
          target[2].lowercased() == source[1].lowercased(),
          target[3] == "releases", target[4] == "tag" else { return nil }
    let tag = String(target[5])
    guard let parts = versionParts(tag), compareStable(tag, currentVersion) == 1 else { return nil }
    let version = parts.map(String.init).joined(separator: ".")
    let rawURL = "https://github.com/\(source[0])/\(source[1])/releases/download/\(tag)/AI-Turn-Meter-\(version)-arm64.dmg"
    guard let downloadURL = secureURL(rawURL) else { return nil }
    return StableUpdate(version: version, downloadURL: downloadURL, notes: "")
  }

  private static func falseOrAbsent(_ json: [String: Any], _ key: String) -> Bool {
    guard let raw = json[key] else { return true }
    guard let number = raw as? NSNumber,
          CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
    return !number.boolValue
  }

  static func jsonCandidate(data: Data, statusCode: Int, currentVersion: String) -> StableUpdate? {
    guard (200..<300).contains(statusCode),
          let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          falseOrAbsent(json, "prerelease"), falseOrAbsent(json, "draft"),
          let tag = (json["tag_name"] ?? json["version"]) as? String,
          let parts = versionParts(tag), compareStable(tag, currentVersion) == 1 else { return nil }
    if let other = json["version"] {
      guard let text = other as? String, compareStable(tag, text) == 0 else { return nil }
    }
    let downloadURL: URL?
    if let direct = json["dmgUrl"] {
      guard let text = direct as? String else { return nil }
      downloadURL = secureURL(text)
    } else if let assetsValue = json["assets"] {
      guard let assets = assetsValue as? [[String: Any]] else { return nil }
      downloadURL = assets.lazy.compactMap { asset -> URL? in
        guard let name = asset["name"] as? String, name.hasSuffix(".dmg"),
              let raw = asset["browser_download_url"] as? String else { return nil }
        return secureURL(raw)
      }.first
    } else {
      downloadURL = (json["url"] as? String).flatMap(secureURL)
    }
    guard let url = downloadURL else { return nil }
    return StableUpdate(version: parts.map(String.init).joined(separator: "."), downloadURL: url,
                        notes: (json["body"] as? String) ?? (json["notes"] as? String) ?? "")
  }
}
