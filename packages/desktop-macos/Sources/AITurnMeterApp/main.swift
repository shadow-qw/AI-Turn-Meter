import AppKit
import Foundation

if HeadlessCliHelper.runIfRequested() {
  exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
