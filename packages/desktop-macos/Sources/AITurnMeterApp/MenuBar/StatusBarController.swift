import AITurnMeterCore
import AppKit
import SwiftUI

@MainActor
final class StatusBarController: NSObject, NSPopoverDelegate {
  private struct IconCacheKey: Equatable {
    let style: MenuBarIconStyle
    let provider: String
    let quotaMode: QuotaDisplayMode
    let active: Bool
    let stale: Bool
    let primaryTenths: Int?
    let secondaryTenths: Int?
  }

  private let vm: MeterViewModel
  private let onOpenMainTab: (MainTab?) -> Void
  private let onCheckUpdates: () -> Void
  private var statusItem: NSStatusItem?
  private lazy var gaugeTemplateIcon: NSImage = Self.makeGaugeTemplateIcon()
  private var cachedIconKey: IconCacheKey?
  private var cachedIconImage: NSImage?
  private var lastPopoverHeight: CGFloat = 0
  private var didCreatePopover: Bool = false
  private lazy var popover: NSPopover = {
    didCreatePopover = true
    let pop = NSPopover()
    pop.behavior = .transient
    pop.animates = true
    pop.delegate = self
    let hosting = NSHostingController(rootView: MenuBarPopoverView(
      vm: vm,
      onOpenMainTab: { [weak self] tab in
        self?.onOpenMainTab(tab)
      },
      onCheckUpdates: { [weak self] in
        self?.onCheckUpdates()
      },
      onClosePopover: { [weak self] in
        self?.closePopover()
      },
      onContentHeightChanged: { [weak self] height in
        self?.updatePopoverHeight(height)
      }
    ))
    hosting.sizingOptions = []
    pop.contentViewController = hosting
    CostHistoryFlyoutController.shared.anchorPopover = pop
    return pop
  }()

  private func updatePopoverHeight(_ rawHeight: CGFloat) {
    guard rawHeight.isFinite, rawHeight > 80 else { return }
    let screenH = (statusItem?.button?.window?.screen ?? NSScreen.main)?.visibleFrame.height ?? 900
    let maxH = max(420, screenH - 36)
    let targetH = min(maxH, ceil(rawHeight))
    lastPopoverHeight = targetH
    let targetSize = NSSize(width: 310, height: targetH)
    if abs(popover.contentSize.height - targetSize.height) < 0.5 &&
       abs(popover.contentSize.width - targetSize.width) < 0.5 {
      return
    }
    let wasAnimates = popover.animates
    popover.animates = false
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0
      ctx.allowsImplicitAnimation = false
      popover.contentSize = targetSize
    }
    popover.animates = wasAnimates
  }

  func popoverWillClose(_ notification: Notification) {
    CostHistoryFlyoutController.shared.hideImmediately()
  }

  init(
    vm: MeterViewModel,
    onOpenMainTab: @escaping (MainTab?) -> Void,
    onCheckUpdates: @escaping () -> Void
  ) {
    self.vm = vm
    self.onOpenMainTab = onOpenMainTab
    self.onCheckUpdates = onCheckUpdates
    super.init()
  }

  func syncVisibilityAndAppearance() {
    if vm.showMenuBarExtra {
      if statusItem == nil {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = item.button {
          btn.target = self
          btn.action = #selector(togglePopover(_:))
          btn.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item
      }
      updateButtonAppearance()
    } else {
      closePopover()
      if let existing = statusItem {
        NSStatusBar.system.removeStatusItem(existing)
        statusItem = nil
      }
    }
  }

  var isPopoverShown: Bool {
    didCreatePopover && popover.isShown
  }

  @objc private func togglePopover(_ sender: AnyObject?) {
    if popover.isShown {
      closePopover()
      return
    }
    guard let btn = statusItem?.button else { return }
    vm.fetchDaemonStateLight()
    vm.fetchUsageSummary(silent: true)
    if lastPopoverHeight > 80 {
      popover.contentSize = NSSize(width: 310, height: lastPopoverHeight)
    } else if let view = popover.contentViewController?.view {
      view.frame = NSRect(x: 0, y: 0, width: 310, height: 480)
      view.layoutSubtreeIfNeeded()
      let fitH = view.fittingSize.height
      if fitH > 80 {
        updatePopoverHeight(fitH)
      }
    }
    popover.show(relativeTo: btn.bounds, of: btn, preferredEdge: .minY)
    NSApp.activate(ignoringOtherApps: true)
    popover.contentViewController?.view.window?.makeKey()
  }

  func closePopover() {
    CostHistoryFlyoutController.shared.hideImmediately()
    if didCreatePopover && popover.isShown {
      popover.performClose(nil)
    }
  }

  func updateButtonAppearance() {
    guard let btn = statusItem?.button else { return }
    let usesGlobalToday =
      (vm.menuBarDisplayMode == .todayCost || vm.menuBarDisplayMode == .todayTokensAndCost) &&
      vm.menuBarUsageScope == .all &&
      vm.menuBarIconStyle == .none
    let pinnedPaused = !usesGlobalToday && vm.menuBarProvider != "auto" && !vm.isToolEnabled(vm.menuBarProvider)
    btn.appearsDisabled = !vm.isActiveOverall || pinnedPaused

    let summary = compactMenuBarTitle()
    if vm.menuBarIconStyle == .none && !summary.isEmpty {
      btn.image = nil
      btn.title = summary
      btn.imagePosition = .noImage
      btn.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
    } else if summary.isEmpty {
      btn.image = resolvedMenuBarIcon()
      btn.title = ""
      btn.imagePosition = .imageOnly
    } else {
      btn.image = resolvedMenuBarIcon()
      btn.title = " \(summary)"
      btn.imagePosition = .imageLeft
      btn.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
    }
    btn.toolTip = buildTooltip()
  }

  private func resolvedIconQuotaPair() -> (primary: Double?, secondary: Double?, stale: Bool) {
    guard vm.isActiveOverall else {
      return (nil, nil, true)
    }
    let candidateKeys: [String]
    if vm.menuBarProvider != "auto" {
      guard vm.isToolEnabled(vm.menuBarProvider) else {
        return (nil, nil, true)
      }
      candidateKeys = [vm.menuBarProvider]
    } else if vm.popoverSelection != "all", vm.isToolEnabled(vm.popoverSelection) {
      candidateKeys = [vm.popoverSelection] + vm.allQuotaProviderKeys.filter { $0 != vm.popoverSelection }
    } else {
      candidateKeys = vm.allQuotaProviderKeys
    }
    for key in candidateKeys {
      guard vm.isToolEnabled(key) else { continue }
      if let windows = vm.usageData?.cards?[key]?.quotaWindows, !windows.isEmpty {
        let primary = vm.quotaDisplayMode.displayPct(fromRemaining: windows[0].remainingPct)
        let secondary = windows.count > 1 ? vm.quotaDisplayMode.displayPct(fromRemaining: windows[1].remainingPct) : nil
        return (primary, secondary, !vm.daemonOnline)
      }
    }
    return (nil, nil, !vm.daemonOnline)
  }

  private func resolvedMenuBarIcon() -> NSImage {
    if vm.menuBarIconStyle == .gauge {
      return gaugeTemplateIcon
    }
    let (primary, secondary, stale) = resolvedIconQuotaPair()
    let pTenths = primary.map { Int((min(100.0, max(0.0, $0)) * 10.0).rounded()) }
    let sTenths = secondary.map { Int((min(100.0, max(0.0, $0)) * 10.0).rounded()) }
    let key = IconCacheKey(
      style: vm.menuBarIconStyle,
      provider: vm.menuBarProvider == "auto" ? vm.popoverSelection : vm.menuBarProvider,
      quotaMode: vm.quotaDisplayMode,
      active: vm.isActiveOverall,
      stale: stale,
      primaryTenths: pTenths,
      secondaryTenths: sTenths
    )
    if cachedIconKey == key, let img = cachedIconImage {
      return img
    }
    let img = Self.makeQuotaBarTemplateIcon(
      primaryPct: primary,
      secondaryPct: secondary,
      stale: stale || !vm.isActiveOverall
    )
    cachedIconKey = key
    cachedIconImage = img
    return img
  }

  private func latestActiveTurn(for providerFilter: String = "auto") -> (key: String, turn: TurnSummary)? {
    guard vm.isActiveOverall else { return nil }
    let keys = providerFilter == "auto" ? vm.orderedKeys : [providerFilter]
    var best: (key: String, turn: TurnSummary, ts: Double)? = nil
    for key in keys {
      guard vm.isToolEnabled(key),
            let entry = vm.apps[key],
            (entry.installed || entry.latestTurn != nil),
            let turn = entry.latestTurn else { continue }
      let ts = turn.completedAtMs ?? 0
      if best == nil || ts > best!.ts {
        best = (key, turn, ts)
      }
    }
    return best.map { ($0.key, $0.turn) }
  }

  private func menuBarLabel(for key: String) -> String {
    key == "antigravity" ? "AGY" : vm.toolShortTitle(for: key)
  }

  private func scopedTodayMetrics() -> (tokens: Int, cost: Double?, symbol: String, isBillingOnly: Bool)? {
    if vm.menuBarUsageScope == .provider && vm.menuBarProvider != "auto" {
      guard vm.isToolEnabled(vm.menuBarProvider),
            let card = vm.usageData?.cards?[vm.menuBarProvider] else { return nil }
      let sym = card.resolvedCurrencySymbol
      let isExtBillingOnly =
        (card.isExternal == true || vm.isExternalProvider(vm.menuBarProvider)) &&
        card.billingSummary?.todayTokens == nil &&
        card.today.totalTokens == 0
      return (card.today.totalTokens, card.billingSummary?.todayCost ?? card.today.costUsd, sym, isExtBillingOnly)
    }
    if let allToday = vm.usageData?.cards?["all"]?.today,
       (allToday.totalTokens > 0 || (vm.todaySummary?.totalTokens ?? 0) == 0) {
      return (allToday.totalTokens, allToday.costUsd, "$", false)
    }
    guard let today = vm.todaySummary else { return nil }
    return (today.totalTokens, today.estimatedCostUsd, "$", false)
  }

  private func resolvedBillingAmount(for card: CodexBarCardSnapshot) -> Double? {
    guard let b = card.billingSummary else { return nil }
    if vm.quotaDisplayMode == .used {
      if let cost = b.periodCost { return cost }
      if let limit = b.periodLimit, let rem = b.periodRemaining {
        return max(0, limit - rem)
      }
      return nil
    }
    return b.periodRemaining
  }

  private func compactMenuBarTitle() -> String {
    guard vm.isActiveOverall else { return "" }
    switch vm.menuBarDisplayMode {
    case .iconOnly:
      return ""
    case .quotaRemaining:
      let keys = vm.menuBarProvider != "auto"
        ? [vm.menuBarProvider]
        : vm.allQuotaProviderKeys
      var parts: [String] = []
      for key in keys {
        guard vm.isToolEnabled(key),
              let rem = vm.usageData?.cards?[key]?.quotaWindows?.first?.remainingPct else { continue }
        let pct = Int(vm.quotaDisplayMode.displayPct(fromRemaining: rem).rounded())
        parts.append("\(menuBarLabel(for: key)) \(vm.quotaDisplayMode.compactPrefix)\(pct)%")
      }
      if !parts.isEmpty { return parts.joined(separator: " · ") }
      guard let today = scopedTodayMetrics() else { return "" }
      return MeterFormat.money(today.cost, symbol: today.symbol)
    case .remainingAmount, .quotaAndAmount:
      let keys = vm.menuBarProvider != "auto"
        ? [vm.menuBarProvider]
        : vm.allQuotaProviderKeys
      let withPct = vm.menuBarDisplayMode == .quotaAndAmount
      var parts: [String] = []
      for key in keys {
        guard vm.isToolEnabled(key), let card = vm.usageData?.cards?[key] else { continue }
        let amount = resolvedBillingAmount(for: card).map {
          MeterFormat.compactMoney($0, symbol: card.resolvedCurrencySymbol)
        }
        let pct = card.quotaWindows?.first.map {
          "\(vm.quotaDisplayMode.compactPrefix)\(Int(vm.quotaDisplayMode.displayPct(fromRemaining: $0.remainingPct).rounded()))%"
        }
        var pieces: [String] = []
        if withPct, let pct = pct { pieces.append(pct) }
        if let amount = amount { pieces.append(amount) }
        if pieces.isEmpty { continue }
        parts.append("\(menuBarLabel(for: key)) \(pieces.joined(separator: " · "))")
      }
      return parts.joined(separator: " · ")
    case .tps:
      if vm.isExternalProvider(vm.menuBarProvider),
         vm.isToolEnabled(vm.menuBarProvider),
         let card = vm.usageData?.cards?[vm.menuBarProvider] {
        if let rem = card.quotaWindows?.first?.remainingPct {
          let pct = Int(vm.quotaDisplayMode.displayPct(fromRemaining: rem).rounded())
          return "\(menuBarLabel(for: vm.menuBarProvider)) \(vm.quotaDisplayMode.compactPrefix)\(pct)%"
        }
        if let amt = resolvedBillingAmount(for: card) {
          return "\(menuBarLabel(for: vm.menuBarProvider)) \(MeterFormat.compactMoney(amt, symbol: card.resolvedCurrencySymbol))"
        }
      }
      guard let (_, turn) = latestActiveTurn(for: vm.menuBarProvider), let tps = turn.tps, tps > 0 else { return "" }
      return MeterFormat.tps(tps)
    case .todayCost:
      guard let today = scopedTodayMetrics() else { return "" }
      return MeterFormat.money(today.cost, symbol: today.symbol)
    case .todayTokensAndCost:
      guard let today = scopedTodayMetrics() else { return "" }
      if today.isBillingOnly {
        return MeterFormat.money(today.cost, symbol: today.symbol)
      }
      return "\(MeterFormat.tokens(today.tokens)) · \(MeterFormat.money(today.cost, symbol: today.symbol))"
    case .latestInline:
      if vm.isExternalProvider(vm.menuBarProvider),
         vm.isToolEnabled(vm.menuBarProvider),
         let card = vm.usageData?.cards?[vm.menuBarProvider] {
        if let amt = resolvedBillingAmount(for: card) {
          return "\(menuBarLabel(for: vm.menuBarProvider)) \(MeterFormat.compactMoney(amt, symbol: card.resolvedCurrencySymbol))"
        }
        if let rem = card.quotaWindows?.first?.remainingPct {
          let pct = Int(vm.quotaDisplayMode.displayPct(fromRemaining: rem).rounded())
          return "\(menuBarLabel(for: vm.menuBarProvider)) \(vm.quotaDisplayMode.compactPrefix)\(pct)%"
        }
      }
      guard let (_, turn) = latestActiveTurn(for: vm.menuBarProvider) else { return "" }
      let inTok = MeterFormat.tokens(turn.totalInputTokens)
      if let tps = turn.tps, tps > 0 {
        return "\(inTok) · \(MeterFormat.tps(tps))"
      }
      return inTok
    }
  }

  private func buildTooltip() -> String {
    var lines = ["AI Turn Meter v\(vm.version)"]
    for key in vm.orderedAllProviderKeys {
      if vm.isExternalProvider(key) {
        guard let meta = vm.externalProviderMeta(for: key), vm.isToolEnabled(key) else { continue }
        if !vm.isActiveOverall {
          lines.append("\(meta.name): 已暂停")
        } else if let card = vm.usageData?.cards?[meta.key] {
          let sym = card.resolvedCurrencySymbol
          if let firstWin = card.quotaWindows?.first {
            let pct = Int(vm.quotaDisplayMode.displayPct(fromRemaining: firstWin.remainingPct).rounded())
            let costPart: String = {
              if vm.quotaDisplayMode == .used {
                if let used = resolvedBillingAmount(for: card) ?? card.days30.costUsd {
                  return " · \(MeterFormat.money(used, symbol: sym))"
                }
                return ""
              } else {
                if let rem = card.billingSummary?.periodRemaining {
                  return " · \(MeterFormat.money(rem, symbol: sym))"
                }
                if let used = card.billingSummary?.periodCost ?? card.days30.costUsd {
                  return " · 已用 \(MeterFormat.money(used, symbol: sym))"
                }
                return ""
              }
            }()
            lines.append("\(meta.name): \(firstWin.title) \(vm.quotaDisplayMode.verbLabel)\(pct)%\(costPart)")
          } else if let hint = card.quotaHint {
            lines.append("\(meta.name): \(hint)")
          } else {
            lines.append("\(meta.name): \(card.statusText ?? "已同步")")
          }
        }
      } else {
        guard let entry = vm.apps[key], (entry.installed || entry.latestTurn != nil) else { continue }
        let title = vm.displayTitle(for: key)
        if !vm.isActiveOverall || !vm.isToolEnabled(key) {
          lines.append("\(title): 已暂停")
        } else if let inline = entry.latestTurn?.inlineText {
          lines.append("\(title): \(inline)")
        } else {
          lines.append("\(title): 等待新对话")
        }
      }
    }
    return lines.joined(separator: "\n")
  }

  private static func makeQuotaBarTemplateIcon(
    primaryPct: Double?,
    secondaryPct: Double?,
    stale: Bool
  ) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let img = NSImage(size: size, flipped: false) { _ in
      let hasPrimary = primaryPct != nil
      let hasSecondary = secondaryPct != nil

      // Match CodexBar IconRenderer (#3154): when a provider exposes only one quota window
      // (e.g. Codex Pro weekly-only or single-pool Cursor), collapse to a single prominent bar
      // instead of reserving an empty second lane.
      if hasPrimary != hasSecondary {
        let singleRect = NSRect(x: 1.5, y: 5.0, width: 15.0, height: 8.0)
        Self.drawQuotaBar(
          rect: singleRect,
          remainingPct: primaryPct ?? secondaryPct,
          stale: stale,
          dimmed: false
        )
        return true
      }

      let topRect = NSRect(x: 1.5, y: 9.5, width: 15.0, height: 6.0)
      let bottomRect = NSRect(x: 1.5, y: 2.5, width: 15.0, height: 4.0)

      Self.drawQuotaBar(
        rect: topRect,
        remainingPct: primaryPct,
        stale: stale,
        dimmed: false
      )
      Self.drawQuotaBar(
        rect: bottomRect,
        remainingPct: secondaryPct,
        stale: stale,
        dimmed: !hasPrimary && !hasSecondary
      )
      return true
    }
    img.isTemplate = true
    return img
  }

  private static func drawQuotaBar(
    rect: NSRect,
    remainingPct: Double?,
    stale: Bool,
    dimmed: Bool
  ) {
    let radius = rect.height * 0.5
    let trackPath = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

    let fillTrackAlpha: CGFloat = dimmed ? 0.14 : (stale ? 0.18 : 0.28)
    let strokeTrackAlpha: CGFloat = dimmed ? 0.26 : (stale ? 0.28 : 0.44)

    NSColor.black.withAlphaComponent(fillTrackAlpha).setFill()
    trackPath.fill()

    let strokeRect = rect.insetBy(dx: 0.5, dy: 0.5)
    let strokePath = NSBezierPath(
      roundedRect: strokeRect,
      xRadius: strokeRect.height * 0.5,
      yRadius: strokeRect.height * 0.5
    )
    strokePath.lineWidth = 1.0
    NSColor.black.withAlphaComponent(strokeTrackAlpha).setStroke()
    strokePath.stroke()

    guard let pct = remainingPct else { return }
    let clamped = min(100.0, max(0.0, pct)) / 100.0
    guard clamped > 0.0 else { return }

    var fillW = rect.width * CGFloat(clamped)
    fillW = (fillW * 2.0).rounded() / 2.0
    if fillW < 1.5 { fillW = 1.5 }

    let fillAlpha: CGFloat = dimmed ? 0.45 : (stale ? 0.55 : 1.0)
    NSGraphicsContext.saveGraphicsState()
    trackPath.addClip()
    NSColor.black.withAlphaComponent(fillAlpha).setFill()
    NSBezierPath(rect: NSRect(x: rect.minX, y: rect.minY, width: fillW, height: rect.height)).fill()
    NSGraphicsContext.restoreGraphicsState()
  }

  private static func makeGaugeTemplateIcon() -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let img = NSImage(size: size, flipped: false) { _ in
      let cx: CGFloat = 9.0
      let cy: CGFloat = 8.4
      let radius: CGFloat = 6.2

      NSColor.black.setStroke()
      NSColor.black.setFill()

      let arc = NSBezierPath()
      arc.lineWidth = 1.65
      arc.lineCapStyle = .round
      arc.appendArc(
        withCenter: NSPoint(x: cx, y: cy),
        radius: radius,
        startAngle: 205,
        endAngle: -25,
        clockwise: true
      )
      arc.stroke()

      let dotR: CGFloat = 1.45
      let dot = NSBezierPath(ovalIn: NSRect(x: cx - dotR, y: cy - dotR, width: dotR * 2, height: dotR * 2))
      dot.fill()

      let angle = CGFloat.pi * 0.22
      let needle = NSBezierPath()
      needle.lineWidth = 1.55
      needle.lineCapStyle = .round
      needle.move(to: NSPoint(x: cx, y: cy))
      needle.line(to: NSPoint(x: cx + cos(angle) * radius * 0.82, y: cy + sin(angle) * radius * 0.82))
      needle.stroke()

      return true
    }
    img.isTemplate = true
    return img
  }
}
