import CryptoKit
import Foundation

public enum UpdateCheckOutcome: Equatable {
  case upToDate(currentVersion: String)
  case updateAvailable(UpdateReleaseInfo)
  case invalidResponse(message: String)
}

public enum UpdateChecker {
  private static func stripBuildAndPrefix(_ raw: String) -> (core: String, prerelease: String?) {
    var s = raw.trimmingCharacters(in: CharacterSet(charactersIn: "vV \t\r\n"))
    if let plusIdx = s.firstIndex(of: "+") {
      s = String(s[..<plusIdx])
    }
    if let dashIdx = s.firstIndex(of: "-") {
      let core = String(s[..<dashIdx])
      let pre = String(s[s.index(after: dashIdx)...])
      return (core, pre.isEmpty ? nil : pre)
    }
    return (s, nil)
  }

  public static func compareSemver(_ a: String, _ b: String) -> Int {
    let parsedA = stripBuildAndPrefix(a)
    let parsedB = stripBuildAndPrefix(b)
    let numsA = parsedA.core.split(separator: ".").map { Int($0) ?? 0 }
    let numsB = parsedB.core.split(separator: ".").map { Int($0) ?? 0 }
    let count = max(numsA.count, numsB.count)
    for i in 0..<count {
      let va = i < numsA.count ? numsA[i] : 0
      let vb = i < numsB.count ? numsB[i] : 0
      if va != vb { return va < vb ? -1 : 1 }
    }
    switch (parsedA.prerelease, parsedB.prerelease) {
    case (nil, nil):
      return 0
    case (nil, .some):
      return 1
    case (.some, nil):
      return -1
    case (.some(let preA), .some(let preB)):
      let partsA = preA.split(separator: ".").map(String.init)
      let partsB = preB.split(separator: ".").map(String.init)
      let pCount = max(partsA.count, partsB.count)
      for i in 0..<pCount {
        if i >= partsA.count { return -1 }
        if i >= partsB.count { return 1 }
        let ia = partsA[i]
        let ib = partsB[i]
        switch (Int(ia), Int(ib)) {
        case (.some(let na), .some(let nb)):
          if na != nb { return na < nb ? -1 : 1 }
        case (.some, nil):
          return -1
        case (nil, .some):
          return 1
        case (nil, nil):
          if ia != ib { return ia < ib ? -1 : 1 }
        }
      }
      return 0
    }
  }

  public static func githubApiLatestUrl(from feedUrl: URL) -> URL? {
    guard let host = feedUrl.host?.lowercased(),
          host == "github.com" || host == "www.github.com" else {
      return nil
    }
    let parts = feedUrl.path.split(separator: "/").map(String.init)
    guard parts.count >= 4, parts[2] == "releases", parts[3] == "latest" else {
      return nil
    }
    return URL(string: "https://api.github.com/repos/\(parts[0])/\(parts[1])/releases/latest")
  }

  public static func parseReleaseJson(_ data: Data, currentVersion: String) -> UpdateCheckOutcome {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return .invalidResponse(message: "更新源返回格式无效。")
    }

    let remoteTag = (json["tag_name"] as? String) ?? (json["version"] as? String) ?? ""
    let remoteVer = remoteTag.trimmingCharacters(in: CharacterSet(charactersIn: "vV "))
    if remoteVer.isEmpty {
      return .invalidResponse(message: "未能在更新源中解析到版本号。")
    }

    if compareSemver(remoteVer, currentVersion) <= 0 {
      return .upToDate(currentVersion: currentVersion)
    }

    let notes = ((json["body"] as? String) ?? (json["notes"] as? String) ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)

    let rawDmgUrl = (json["dmgUrl"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    var dmgUrl: String? = (rawDmgUrl?.isEmpty == false) ? rawDmgUrl : nil
    var dmgName: String? = dmgUrl.flatMap { URL(string: $0)?.lastPathComponent }
    var sha256Url = json["sha256Url"] as? String
    let expectedSha256 = (json["sha256"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()

    let assets = json["assets"] as? [[String: Any]]
    if let assets = assets {
      if dmgUrl == nil {
        let arm64Dmg = assets.first { asset in
          let name = (asset["name"] as? String)?.lowercased() ?? ""
          return name.hasSuffix(".dmg") && name.contains("arm64")
        }
        let anyDmg = arm64Dmg ?? assets.first { asset in
          ((asset["name"] as? String)?.lowercased() ?? "").hasSuffix(".dmg")
        }
        if let picked = anyDmg, let dl = picked["browser_download_url"] as? String {
          dmgUrl = dl
          dmgName = picked["name"] as? String
        }
      }

      if sha256Url == nil {
        if let dn = dmgName?.lowercased(),
           let exactSha = assets.first(where: { (($0["name"] as? String)?.lowercased() ?? "") == "\(dn).sha256" }),
           let dl = exactSha["browser_download_url"] as? String {
          sha256Url = dl
        } else if let anySha = assets.first(where: {
          let n = ($0["name"] as? String)?.lowercased() ?? ""
          return n.hasSuffix(".dmg.sha256") || n == "sha256sums.txt" || n == "sha256sums"
        }), let dl = anySha["browser_download_url"] as? String {
          sha256Url = dl
        }
      }
    }

    // Fallback for custom flat JSON feeds (`{ version, url }`) when no GitHub `assets` array is present.
    if dmgUrl == nil && assets == nil,
       let fallbackUrl = (json["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
       !fallbackUrl.isEmpty,
       !(fallbackUrl.contains("/repos/") && fallbackUrl.contains("/releases/")) {
      dmgUrl = fallbackUrl
      dmgName = URL(string: fallbackUrl)?.lastPathComponent
    }

    guard let finalDmgUrl = dmgUrl, !finalDmgUrl.isEmpty else {
      return .invalidResponse(message: "新版本 v\(remoteVer) 尚未附带 .dmg 安装包。")
    }

    return .updateAvailable(
      UpdateReleaseInfo(
        version: remoteVer,
        downloadUrl: finalDmgUrl,
        notes: notes,
        sha256Url: sha256Url,
        expectedSha256: (expectedSha256?.count == 64) ? expectedSha256 : nil
      )
    )
  }

  public static func parseSha256Checksum(from text: String, filename: String) -> String? {
    let targetBase = (filename as NSString).lastPathComponent.lowercased()
    var standaloneHash: String? = nil

    for rawLine in text.components(separatedBy: .newlines) {
      let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
      if line.isEmpty { continue }
      let parts = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
      guard let first = parts.first else { continue }
      let candidate = first.lowercased()
      guard candidate.count == 64, candidate.allSatisfy({ $0.isHexDigit }) else {
        continue
      }
      if parts.count == 1 {
        if standaloneHash == nil { standaloneHash = candidate }
        continue
      }
      let fileField = parts.dropFirst().joined(separator: " ").trimmingCharacters(in: CharacterSet(charactersIn: "* "))
      let lineBase = (fileField as NSString).lastPathComponent.lowercased()
      if lineBase == targetBase {
        return candidate
      }
    }
    return standaloneHash
  }

  public static func sha256Hex(of data: Data) -> String {
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  public static func sha256Hex(ofFileAt url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
      if chunk.isEmpty { break }
      hasher.update(data: chunk)
    }
    let digest = hasher.finalize()
    return digest.map { String(format: "%02x", $0) }.joined()
  }
}
