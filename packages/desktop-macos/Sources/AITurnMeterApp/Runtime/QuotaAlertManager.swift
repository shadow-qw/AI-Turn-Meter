import AITurnMeterCore
import Foundation
import UserNotifications

private final class ForegroundNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }
}

@MainActor
final class QuotaAlertManager {
  static let enabledPrefKey = "atm.alertsEnabled.v1"

  var onDeliveryErrorChanged: ((String?) -> Void)?

  private(set) var lastDeliveryError: String? = nil {
    didSet {
      if oldValue != lastDeliveryError {
        onDeliveryErrorChanged?(lastDeliveryError)
      }
    }
  }

  var enabled: Bool {
    didSet {
      UserDefaults.standard.set(enabled, forKey: Self.enabledPrefKey)
      if enabled && !oldValue {
        evaluator.reset()
        lastDeliveryError = nil
        requestPermissionIfNeeded()
      } else if enabled {
        requestPermissionIfNeeded()
      } else {
        lastDeliveryError = nil
      }
    }
  }

  private var evaluator: QuotaAlertEvaluator
  private var didRequestAuthPrompt = false
  private let notificationDelegate = ForegroundNotificationDelegate()

  init(
    enabled: Bool? = nil,
    cooldownSeconds: TimeInterval = 30 * 60,
    maxLongContextTurnAgeSeconds: TimeInterval = 10 * 60
  ) {
    let resolvedEnabled: Bool
    if let explicit = enabled {
      resolvedEnabled = explicit
    } else if let stored = UserDefaults.standard.object(forKey: Self.enabledPrefKey) as? Bool {
      resolvedEnabled = stored
    } else {
      resolvedEnabled = true
    }
    self.enabled = resolvedEnabled
    self.evaluator = QuotaAlertEvaluator(
      cooldownSeconds: cooldownSeconds,
      maxLongContextTurnAgeSeconds: maxLongContextTurnAgeSeconds
    )
  }

  private var supportsUserNotifications: Bool {
    guard let bundleId = Bundle.main.bundleIdentifier, !bundleId.isEmpty else {
      return false
    }
    return Bundle.main.bundleURL.pathExtension == "app"
  }

  func refreshPermissionStatus() {
    checkAndRequestPermission(allowPrompt: false)
  }

  func requestPermissionIfNeeded() {
    checkAndRequestPermission(allowPrompt: true)
  }

  private func checkAndRequestPermission(allowPrompt: Bool) {
    guard enabled, supportsUserNotifications else {
      if !enabled { lastDeliveryError = nil }
      return
    }
    let center = UNUserNotificationCenter.current()
    if center.delegate == nil {
      center.delegate = notificationDelegate
    }
    center.getNotificationSettings { [weak self] settings in
      let status = settings.authorizationStatus
      Task { @MainActor [weak self] in
        guard let self = self, self.enabled else { return }
        switch status {
        case .denied:
          self.lastDeliveryError = "系统通知权限已关闭"
        case .authorized, .provisional:
          self.lastDeliveryError = nil
        case .notDetermined:
          guard allowPrompt, !self.didRequestAuthPrompt else { return }
          self.didRequestAuthPrompt = true
          do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            self.lastDeliveryError = granted ? nil : "用户拒绝了通知权限"
          } catch {
            self.lastDeliveryError = error.localizedDescription
          }
        @unknown default:
          break
        }
      }
    }
  }

  func evaluate(
    usage: UsageSummaryResponse?,
    apps: [String: StatusAppEntry],
    displayNames: [String: String] = [:],
    masterEnabled: Bool = true,
    enabledTools: Set<String>? = nil
  ) {
    guard enabled else { return }
    let events = evaluator.evaluate(
      usage: usage,
      apps: apps,
      displayNames: displayNames,
      now: Date(),
      masterEnabled: masterEnabled,
      enabledTools: enabledTools
    )
    guard !events.isEmpty, supportsUserNotifications else { return }
    requestPermissionIfNeeded()
    let center = UNUserNotificationCenter.current()
    for event in events {
      let content = UNMutableNotificationContent()
      content.title = event.title
      content.body = event.body
      content.sound = .default
      let identifier = Self.notificationIdentifier(for: event.dedupeKey)
      let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
      center.add(request) { [weak self] error in
        Task { @MainActor [weak self] in
          if let error = error {
            self?.lastDeliveryError = error.localizedDescription
          } else {
            self?.lastDeliveryError = nil
          }
        }
      }
    }
  }

  func resetState() {
    evaluator.reset()
    lastDeliveryError = nil
  }

  private static func notificationIdentifier(for dedupeKey: String) -> String {
    let safe = dedupeKey
      .replacingOccurrences(of: ":", with: ".")
      .replacingOccurrences(of: " ", with: "_")
    return "atm.alert.\(safe)"
  }
}
