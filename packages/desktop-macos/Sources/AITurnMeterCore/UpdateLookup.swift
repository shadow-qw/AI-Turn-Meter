import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct UpdateHTTPResponse: Sendable {
  public let statusCode: Int
  public let finalURL: URL
  public let data: Data
  public init(statusCode: Int, finalURL: URL, data: Data) {
    self.statusCode = statusCode; self.finalURL = finalURL; self.data = data
  }
}
public enum UpdateTransportFailure: Error { case unavailable, invalidResponse }
public protocol UpdateTransport: Sendable {
  func fetch(_ url: URL, method: String) async throws -> UpdateHTTPResponse
}
public struct URLSessionUpdateTransport: UpdateTransport {
  public init() {}
  public func fetch(_ url: URL, method: String) async throws -> UpdateHTTPResponse {
    var request = URLRequest(url: url, timeoutInterval: 10)
    request.httpMethod = method
    request.setValue("AI-Turn-Meter", forHTTPHeaderField: "User-Agent")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, let finalURL = http.url else {
      throw UpdateTransportFailure.invalidResponse
    }
    return UpdateHTTPResponse(statusCode: http.statusCode, finalURL: finalURL, data: data)
  }
}
public enum UpdateLookupFailure: Equatable, Sendable {
  case transport, noRelease, rejected(String)
}
public enum UpdateLookupResult: Equatable, Sendable {
  case available(UpdateReleaseInfo), upToDate(String), failed(UpdateLookupFailure)
}

// One bounded state machine is shared by the application and injected-transport
// tests. Safety rejection is terminal; discovery alone never grants a download.
public enum UpdateLookup {
  private static func trustedAPIOrigin(_ response: UpdateHTTPResponse) -> Bool {
    UpdatePolicy.secureURL(response.finalURL.absoluteString) != nil &&
      response.finalURL.host?.lowercased() == "api.github.com" &&
      (response.finalURL.port == nil || response.finalURL.port == 443)
  }
  private static func metadata(_ response: UpdateHTTPResponse, current: String, github: Bool = false) -> UpdateLookupResult {
    guard UpdatePolicy.secureURL(response.finalURL.absoluteString) != nil,
          !github || trustedAPIOrigin(response) else {
      return .failed(.rejected("更新源重定向地址无效。"))
    }
    guard (200..<300).contains(response.statusCode) else {
      if response.statusCode == 404 { return .failed(.noRelease) }
      if response.statusCode >= 500 || response.statusCode == 403 || response.statusCode == 429 { return .failed(.transport) }
      return .failed(.rejected("更新源HTTP响应无效。"))
    }
    switch UpdateChecker.parseReleaseJson(response.data, currentVersion: current) {
    case .updateAvailable(let info): return .available(info)
    case .upToDate(let version): return .upToDate(version)
    case .invalidResponse(let message): return .failed(.rejected(message))
    }
  }

  public static func check(feed: URL, currentVersion: String, transport: any UpdateTransport) async -> UpdateLookupResult {
    guard UpdatePolicy.secureURL(feed.absoluteString) != nil, UpdatePolicy.isStable(currentVersion) else {
      return .failed(.rejected("更新源或当前稳定版本无效。"))
    }
    guard let api = UpdateChecker.githubApiLatestUrl(from: feed) else {
      do { return metadata(try await transport.fetch(feed, method: "GET"), current: currentVersion) }
      catch UpdateTransportFailure.invalidResponse { return .failed(.rejected("更新源响应无效。")) }
      catch { return .failed(.transport) }
    }
    do {
      let response = try await transport.fetch(api, method: "GET")
      guard trustedAPIOrigin(response) else { return .failed(.rejected("GitHub元数据来源无效。")) }
      if response.statusCode < 500 && response.statusCode != 403 && response.statusCode != 429 {
        return metadata(response, current: currentVersion, github: true)
      }
      // Only transport/server unavailability may enter discovery, not a 2xx
      // payload rejected by policy, nor an explicit 404/no-release response.
    } catch UpdateTransportFailure.invalidResponse {
      return .failed(.rejected("更新源响应无效。"))
    } catch { /* bounded recovery below */ }

    do {
      let head = try await transport.fetch(feed, method: "HEAD")
      guard let discovered = UpdatePolicy.githubCandidate(feed: feed, finalURL: head.finalURL,
              statusCode: head.statusCode, currentVersion: currentVersion) else {
        return .failed(.rejected("无法确认稳定Release身份。"))
      }
      let tag = head.finalURL.lastPathComponent
      let source = feed.path.split(separator: "/")
      var components = URLComponents()
      components.scheme = "https"; components.host = "api.github.com"
      components.path = "/repos/\(source[0])/\(source[1])/releases/tags/\(tag)"
      guard let exact = components.url else { return .failed(.rejected("Release地址无效。")) }
      let result = metadata(try await transport.fetch(exact, method: "GET"), current: currentVersion, github: true)
      guard case .available(let info) = result else {
        if case .upToDate = result { return .failed(.rejected("发现的Release与元数据不一致。")) }
        return result
      }
      guard UpdatePolicy.compareStable(info.version, discovered.version) == 0,
            info.expectedSha256 != nil || info.sha256Url != nil else {
        return .failed(.rejected("恢复路径缺少匹配Release与校验声明。"))
      }
      return .available(info)
    } catch UpdateTransportFailure.invalidResponse { return .failed(.rejected("更新源响应无效。")) }
    catch { return .failed(.transport) }
  }
}
