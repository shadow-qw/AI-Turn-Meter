import AITurnMeterCore
import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
  private static let openPanelNotification = Notification.Name("com.local.ai-turn-meter.openControlPanel")
  private var window: NSWindow?
  private var vm: MeterViewModel?
  private var statusBarController: StatusBarController?
  private var openPanelObserver: NSObjectProtocol?

  func applicationDidFinishLaunching(_ notification: Notification) {
    MainActor.assumeIsolated {
      setupMainMenu()

      let model = MeterViewModel()
      self.vm = model

      let view = ContentView(vm: model)
      let win = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 780, height: 580),
        styleMask: [.titled, .closable, .miniaturizable, .resizable],
        backing: .buffered,
        defer: false
      )
      win.title = "AI Turn Meter 设置"
      win.center()
      win.isReleasedWhenClosed = false
      win.contentView = NSHostingView(rootView: view)
      self.window = win

      let sb = StatusBarController(
        vm: model,
        onOpenMainTab: { [weak self] tab in
          self?.showControlPanel(tab: tab)
        },
        onCheckUpdates: { [weak self] in
          self?.vm?.openSettingsPane(.general)
          self?.showControlPanel(tab: nil)
          self?.vm?.checkForUpdates()
        }
      )
      self.statusBarController = sb

      model.onStateUpdated = { [weak sb] in
        sb?.updateButtonAppearance()
      }
      model.onPreferencesChanged = { [weak self] in
        self?.applyActivationPolicy(keepWindowVisible: true)
        self?.statusBarController?.syncVisibilityAndAppearance()
      }

      openPanelObserver = DistributedNotificationCenter.default().addObserver(
        forName: Self.openPanelNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        Task { @MainActor [weak self] in
          self?.showControlPanel()
        }
      }

      applyActivationPolicy(keepWindowVisible: false)
      sb.syncVisibilityAndAppearance()
      model.ensureStarted()

      let launchInBackground = CommandLine.arguments.contains("--background")
      if !launchInBackground {
        if model.hideDockIcon {
          DispatchQueue.main.async { [weak win] in
            win?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
          }
        } else {
          win.makeKeyAndOrderFront(nil)
          NSApp.activate(ignoringOtherApps: true)
        }
      }
    }
  }

  private func setupMainMenu() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "关于 AI Turn Meter", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(NSMenuItem.separator())
    let openItem = NSMenuItem(title: "设置…", action: #selector(openControlPanelFromMenu), keyEquivalent: ",")
    openItem.target = self
    appMenu.addItem(openItem)
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "隐藏 AI Turn Meter", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = NSMenuItem(title: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(hideOthers)
    appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "退出 AI Turn Meter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appMenuItem.submenu = appMenu
    mainMenu.addItem(appMenuItem)

    let editMenuItem = NSMenuItem()
    let editMenu = NSMenu(title: "编辑")
    editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editMenuItem.submenu = editMenu
    mainMenu.addItem(editMenuItem)

    let windowMenuItem = NSMenuItem()
    let windowMenu = NSMenu(title: "窗口")
    windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowMenuItem.submenu = windowMenu
    mainMenu.addItem(windowMenuItem)

    NSApp.mainMenu = mainMenu
  }

  @MainActor
  @objc private func openControlPanelFromMenu() {
    if let sb = statusBarController, sb.isPopoverShown, let vm = vm {
      let targetPane: SettingsPane = vm.popoverSelection == "all"
        ? .general
        : .provider(vm.popoverSelection)
      sb.closePopover()
      vm.openSettingsPane(targetPane)
    }
    showControlPanel(tab: nil)
  }

  @MainActor
  private func showControlPanel(tab: MainTab? = nil) {
    if let tab = tab {
      switch tab {
      case .usage: vm?.openSettingsPane(.usage)
      case .turns: vm?.openSettingsPane(.turns)
      case .control:
        if vm?.settingsPane == .usage || vm?.settingsPane == .turns {
          vm?.openSettingsPane(.general)
        }
      }
    }
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    vm?.refreshDoctorAndBootstrap()
  }

  @MainActor
  private func applyActivationPolicy(keepWindowVisible: Bool) {
    guard let vm = vm else { return }
    let desired: NSApplication.ActivationPolicy = vm.hideDockIcon ? .accessory : .regular
    if NSApp.activationPolicy() != desired {
      let wasVisible = keepWindowVisible && (window?.isVisible ?? false)
      NSApp.setActivationPolicy(desired)
      if wasVisible {
        DispatchQueue.main.async { [weak self] in
          self?.window?.makeKeyAndOrderFront(nil)
          NSApp.activate(ignoringOtherApps: true)
        }
      }
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    MainActor.assumeIsolated {
      if !(window?.isVisible ?? false) {
        showControlPanel()
      }
      return true
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    MainActor.assumeIsolated {
      if let obs = openPanelObserver {
        DistributedNotificationCenter.default().removeObserver(obs)
        openPanelObserver = nil
      }
      vm?.stopPolling()
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return false
  }
}
