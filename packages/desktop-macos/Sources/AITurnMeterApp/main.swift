import AppKit
import Foundation

if HeadlessCliHelper.runIfRequested() {
  exit(0)
}

if let bundleId = Bundle.main.bundleIdentifier, !bundleId.isEmpty {
  let myPid = ProcessInfo.processInfo.processIdentifier
  let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
    .filter { $0.processIdentifier != myPid && !$0.isTerminated }
  if let existing = others.first {
    if !CommandLine.arguments.contains("--background") {
      DistributedNotificationCenter.default().postNotificationName(
        Notification.Name("com.local.ai-turn-meter.openControlPanel"),
        object: nil,
        userInfo: nil,
        deliverImmediately: true
      )
      existing.activate(options: [.activateIgnoringOtherApps])
    }
    exit(0)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
