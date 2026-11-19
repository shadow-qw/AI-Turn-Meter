import CryptoKit
import Foundation

public enum UpdateCheckOutcome: Equatable {
  case upToDate(currentVersion: String)
  case updateAvailable(UpdateReleaseInfo)
  case invalidResponse(message: String)
}

public enum UpdateChecker {
  // Legacy abbreviated-version API; update eligibility must use compareStable instead.
  public static func compareSemver(_ a: String, _ b: String) -> Int {
    let cleanA = a.trimmingCharacters(in: CharacterSet(charactersIn: "vV ")).split(separator: ".").map { Int($0) ?? 0 }
    let cleanB = b.trimmingCharacters(in: CharacterSet(charactersIn: "vV ")).split(separator: ".").map { Int($0) ?? 0 }
    let count = max(cleanA.count, cleanB.count)
    for i in 0..<count {
      let va = i < cleanA.count ? cleanA[i] : 0
      let vb = i < cleanB.count ? cleanB[i] : 0
      if va != vb { return va < vb ? -1 : 1 }
    }
    return 0
  }

  public static func githubApiLatestUrl(from feedUrl: URL) -> URL? {
    guard UpdatePolicy.isGitHubLatest(feedUrl) else { return nil }
    let parts = feedUrl.path.split(separator: "/").map(String.init)
    return URL(string: "https://api.github.com/repos/\(parts[0])/\(parts[1])/releases/latest")
  }

  public static func parseReleaseJson(_ data: Data, currentVersion: String) -> UpdateCheckOutcome {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return .invalidResponse(message: "更新源返回格式无效。")
    }

    guard let remoteVer = UpdatePolicy.stableVersion(in: json),
          let comparison = UpdatePolicy.compareStable(remoteVer, currentVersion) else {
      return .invalidResponse(message: "更新源不是有效稳定版本，或当前为预发布版本。")
    }
    if comparison <= 0 { return .upToDate(currentVersion: currentVersion) }
    guard let candidate = UpdatePolicy.jsonCandidate(data: data, statusCode: 200, currentVersion: currentVersion) else {
      return .invalidResponse(message: "稳定更新下载地址无效。")
    }

    let notes = ((json["body"] as? String) ?? (json["notes"] as? String) ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)

    let dmgUrl: String? = candidate.downloadURL.absoluteString
    var dmgName: String? = dmgUrl.flatMap { URL(string: $0)?.lastPathComponent }
    var sha256Url = json["sha256Url"] as? String
    let expectedSha256 = (json["sha256"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()

    if let assets = json["assets"] as? [[String: Any]] {
      if let picked = assets.first(where: { ($0["browser_download_url"] as? String) == candidate.downloadURL.absoluteString }) {
        dmgName = picked["name"] as? String
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

    guard let finalDmgUrl = dmgUrl, !finalDmgUrl.isEmpty else {
      return .invalidResponse(message: "新版本 v\(remoteVer) 尚未附带 .dmg 安装包。")
    }

    if let raw = json["sha256Url"] {
      guard let text = raw as? String, UpdatePolicy.artifactURL(text, version: remoteVer) != nil else {
        return .invalidResponse(message: "校验文件地址无效。")
      }
    }
    if let url = sha256Url {
      let assets = json["assets"] as? [[String: Any]] ?? []
      let assetName = assets.first(where: { ($0["browser_download_url"] as? String) == url })?["name"] as? String
      guard UpdatePolicy.artifactURL(url, version: remoteVer, assetName: assetName) != nil else {
        return .invalidResponse(message: "校验文件身份无效。")
      }
    }
    if json["sha256"] != nil {
      guard let hash = expectedSha256, hash.count == 64,
            hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
        return .invalidResponse(message: "SHA256格式无效。")
      }
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

  public static func matchesChecksum(expected: String, actual: String) -> Bool {
    let left = expected.lowercased(), right = actual.lowercased()
    let valid: (String) -> Bool = { value in
      value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    return valid(left) && valid(right) && left == right
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
