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

  private(set) var lastDeliveryError: String? = nil

  var enabled: Bool {
    didSet {
      UserDefaults.standard.set(enabled, forKey: Self.enabledPrefKey)
      if enabled && !oldValue {
        evaluator.reset()
        lastDeliveryError = nil
        requestPermissionIfNeeded()
      } else if enabled {
        requestPermissionIfNeeded()
      }
    }
  }

  private var evaluator: QuotaAlertEvaluator
  private var permissionRequested = false
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

  func requestPermissionIfNeeded() {
    guard enabled, supportsUserNotifications, !permissionRequested else { return }
    permissionRequested = true
    let center = UNUserNotificationCenter.current()
    if center.delegate == nil {
      center.delegate = notificationDelegate
    }
    center.getNotificationSettings { [weak self] settings in
      if settings.authorizationStatus == .denied {
        Task { @MainActor [weak self] in
          self?.lastDeliveryError = "系统通知权限已关闭"
        }
        return
      }
      guard settings.authorizationStatus == .notDetermined else { return }
      DispatchQueue.main.async {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
          Task { @MainActor [weak self] in
            if let error = error {
              self?.lastDeliveryError = error.localizedDescription
            } else if !granted {
              self?.lastDeliveryError = "用户拒绝了通知权限"
            } else {
              self?.lastDeliveryError = nil
            }
          }
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
