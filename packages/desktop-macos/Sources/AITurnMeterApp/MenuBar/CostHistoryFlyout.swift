import AITurnMeterCore
import AppKit
import SwiftUI

@MainActor
final class CostHistoryFlyoutController: NSObject {
  static let shared = CostHistoryFlyoutController()

  weak var anchorPopover: NSPopover?
  private weak var attachedParentWindow: NSWindow?
  private var panel: NSPanel?
  private var vfxView: NSVisualEffectView?
  private var hostingView: NSHostingView<CostHistoryDetailFlyoutView>?
  private var isCardHovered: Bool = false
  private var isFlyoutHovered: Bool = false
  private var hideWorkItem: DispatchWorkItem?
  private var showWorkItem: DispatchWorkItem?
  private var lastMeasuredContentHeight: CGFloat = 0

  func setCardHovered(_ hovered: Bool, vm: MeterViewModel, card: CodexBarCardSnapshot, selection: String) {
    isCardHovered = hovered
    if hovered {
      hideWorkItem?.cancel()
      hideWorkItem = nil
      showWorkItem?.cancel()
      let item = DispatchWorkItem { [weak self] in
        MainActor.assumeIsolated {
          guard let self = self, self.isCardHovered else { return }
          self.present(vm: vm, card: card, selection: selection)
        }
      }
      showWorkItem = item
      let delay: TimeInterval = (panel?.isVisible ?? false) ? 0.0 : 0.08
      DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    } else {
      showWorkItem?.cancel()
      showWorkItem = nil
      scheduleHideIfNeeded()
    }
  }

  func setFlyoutHovered(_ hovered: Bool) {
    isFlyoutHovered = hovered
    if hovered {
      hideWorkItem?.cancel()
      hideWorkItem = nil
    } else {
      scheduleHideIfNeeded()
    }
  }

  private func scheduleHideIfNeeded() {
    guard !isCardHovered && !isFlyoutHovered else { return }
    hideWorkItem?.cancel()
    let item = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        guard let self = self, !self.isCardHovered && !self.isFlyoutHovered else { return }
        self.hideImmediately()
      }
    }
    hideWorkItem = item
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: item)
  }

  func hideImmediately() {
    showWorkItem?.cancel()
    showWorkItem = nil
    hideWorkItem?.cancel()
    hideWorkItem = nil
    isCardHovered = false
    isFlyoutHovered = false
    if let p = panel {
      if let parent = attachedParentWindow {
        parent.removeChildWindow(p)
        attachedParentWindow = nil
      }
      p.orderOut(nil)
    }
  }

  private func ensurePanel(rootView: CostHistoryDetailFlyoutView) -> NSPanel {
    if let existing = panel, let hosting = hostingView {
      hosting.rootView = rootView
      return existing
    }

    let hosting = NSHostingView(rootView: rootView)
    let vfx = NSVisualEffectView()
    vfx.material = .popover
    vfx.blendingMode = .behindWindow
    vfx.state = .active
    vfx.wantsLayer = true
    vfx.layer?.cornerRadius = 12
    vfx.layer?.masksToBounds = true
    vfx.layer?.borderWidth = 0.5
    vfx.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.35).cgColor
    vfx.addSubview(hosting)
    hosting.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      hosting.topAnchor.constraint(equalTo: vfx.topAnchor),
      hosting.leadingAnchor.constraint(equalTo: vfx.leadingAnchor),
      hosting.trailingAnchor.constraint(equalTo: vfx.trailingAnchor),
      hosting.bottomAnchor.constraint(equalTo: vfx.bottomAnchor),
    ])

    let p = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 286, height: 340),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    p.isOpaque = false
    p.backgroundColor = .clear
    p.level = .popUpMenu
    p.hasShadow = true
    p.hidesOnDeactivate = true
    p.acceptsMouseMovedEvents = true
    p.collectionBehavior = [.transient, .ignoresCycle]
    p.contentView = vfx

    self.panel = p
    self.vfxView = vfx
    self.hostingView = hosting
    return p
  }

  private func present(vm: MeterViewModel, card: CodexBarCardSnapshot, selection: String) {
    guard let pop = anchorPopover, pop.isShown,
          let popWindow = pop.contentViewController?.view.window else {
      return
    }
    guard !card.daily30.isEmpty || !(card.projects ?? []).isEmpty || !(card.breakdowns ?? []).isEmpty else { return }

    lastMeasuredContentHeight = 0
    let view = CostHistoryDetailFlyoutView(
      selection: selection,
      card: card,
      onHoverChanged: { [weak self] inside in
        self?.setFlyoutHovered(inside)
      },
      onContentHeightChanged: { [weak self] height in
        self?.updatePanelHeight(height)
      }
    )
    let p = ensurePanel(rootView: view)
    guard let hosting = hostingView else { return }

    let visiblePopRect: NSRect = {
      if let cv = pop.contentViewController?.view, cv.window === popWindow {
        return popWindow.convertToScreen(cv.convert(cv.bounds, to: nil))
      }
      return popWindow.frame
    }()
    let screenFrame = (popWindow.screen ?? NSScreen.main)?.visibleFrame
      ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let maxH = min(620, max(240, screenFrame.height - 24))

    hosting.layoutSubtreeIfNeeded()
    let rawHeight = lastMeasuredContentHeight > 40 ? lastMeasuredContentHeight : hosting.fittingSize.height
    let panelWidth: CGFloat = 286
    let panelHeight = min(max(ceil(rawHeight), 200), maxH)

    let gap: CGFloat = 4
    let x: CGFloat = (visiblePopRect.minX - panelWidth - gap >= screenFrame.minX)
      ? (visiblePopRect.minX - panelWidth - gap)
      : min(screenFrame.maxX - panelWidth - 6, visiblePopRect.maxX + gap)
    let rawY = visiblePopRect.maxY - panelHeight
    let y = min(screenFrame.maxY - panelHeight - 6, max(screenFrame.minY + 8, rawY))

    p.setFrame(NSRect(x: x, y: y, width: panelWidth, height: panelHeight), display: true)
    if let oldParent = attachedParentWindow, oldParent !== popWindow {
      oldParent.removeChildWindow(p)
      attachedParentWindow = nil
    }
    if attachedParentWindow == nil {
      popWindow.addChildWindow(p, ordered: .above)
      attachedParentWindow = popWindow
    }
    p.orderFront(nil)
  }

  func updatePanelHeight(_ rawHeight: CGFloat) {
    guard rawHeight.isFinite, rawHeight > 40 else { return }
    lastMeasuredContentHeight = rawHeight
    guard let p = panel, p.isVisible else { return }
    let screenFrame = (p.screen ?? NSScreen.main)?.visibleFrame
      ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let maxH = min(620, max(240, screenFrame.height - 24))
    let panelHeight = min(max(ceil(rawHeight), 180), maxH)
    var frame = p.frame
    if abs(frame.height - panelHeight) < 1 { return }
    let topY = frame.maxY
    frame.size.height = panelHeight
    frame.origin.y = max(screenFrame.minY + 8, topY - panelHeight)
    p.setFrame(frame, display: true)
  }

  func refreshPanelHeightPreservingTop() {
    guard let p = panel, p.isVisible, let hosting = hostingView else { return }
    hosting.layoutSubtreeIfNeeded()
    let rawHeight = lastMeasuredContentHeight > 40 ? lastMeasuredContentHeight : hosting.fittingSize.height
    updatePanelHeight(rawHeight)
  }
}

private struct FlyoutContentHeightKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    let next = nextValue()
    if next > 0 { value = next }
  }
}

private enum FlyoutChartMetric: Hashable {
  case tokens
  case cost
}

private struct CostHistoryDetailFlyoutView: View {
  let selection: String
  let card: CodexBarCardSnapshot
  let onHoverChanged: (Bool) -> Void
  let onContentHeightChanged: (CGFloat) -> Void

  @State private var metric: FlyoutChartMetric = .tokens
  @State private var hoveredDate: String? = nil

  private var curSym: String {
    card.resolvedCurrencySymbol
  }

  private var isBillingOnly: Bool {
    (card.isExternal == true) && !card.daily30.contains(where: { $0.totalTokens > 0 })
  }

  private var activeMetric: FlyoutChartMetric {
    isBillingOnly ? .cost : metric
  }

  private func pointValue(_ pt: CardDailyPoint) -> Double {
    switch activeMetric {
    case .tokens: return Double(max(0, pt.totalTokens))
    case .cost: return max(0, pt.costUsd ?? 0)
    }
  }

  private func axisLabel(_ val: Double) -> String {
    if val <= 0 { return "0" }
    switch activeMetric {
    case .tokens:
      return MeterFormat.tokens(Int(val.rounded()))
    case .cost:
      return MeterFormat.compactMoney(val, symbol: curSym)
    }
  }

  var body: some View {
    let points = card.daily30
    let maxVal = max(0.0, points.map(pointValue).max() ?? 0)
    let scaleMax = max(0.000001, maxVal)
    let peakDate = points.max(by: { pointValue($0) < pointValue($1) })?.date
    let selectedPt: CardDailyPoint? = points.first(where: { $0.date == hoveredDate })
      ?? points.last(where: { $0.totalTokens > 0 || ($0.costUsd ?? 0) > 0 })
      ?? points.last
    let projects = Array((card.projects ?? []).prefix(5))
    let breakdowns = card.breakdowns ?? []

    ScrollView(.vertical, showsIndicators: false) {
      VStack(alignment: .leading, spacing: 10) {
        // 30-day vertical bar chart with Y-axis + yellow peak cap + continuous bar scrubbing
      if !points.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          HStack(alignment: .bottom, spacing: 6) {
            VStack(alignment: .leading) {
              Text(maxVal > 0 ? axisLabel(maxVal) : (activeMetric == .tokens ? "0" : "\(curSym)0"))
              Spacer()
              Text(maxVal > 0 ? axisLabel(maxVal / 2.0) : "")
              Spacer()
              Text("0")
            }
            .font(.system(size: 10))
            .monospacedDigit()
            .foregroundColor(Color(nsColor: .tertiaryLabelColor))
            .frame(width: 40, height: 102, alignment: .leading)

            HStack(alignment: .bottom, spacing: 0) {
              ForEach(points, id: \.id) { pt in
                flyoutBar(
                  pt: pt,
                  scaleMax: scaleMax,
                  maxVal: maxVal,
                  peakDate: peakDate,
                  selectedDate: selectedPt?.date
                )
              }
            }
            .frame(height: 102, alignment: .bottom)
            .overlay {
              GeometryReader { geo in
                Color.clear
                  .contentShape(Rectangle())
                  .onContinuousHover { phase in
                    switch phase {
                    case .active(let loc):
                      guard !points.isEmpty else { return }
                      let w = max(1, geo.size.width)
                      let idx = min(points.count - 1, max(0, Int((loc.x / w) * CGFloat(points.count))))
                      let d = points[idx].date
                      if hoveredDate != d { hoveredDate = d }
                    case .ended:
                      hoveredDate = nil
                    }
                  }
              }
            }
          }

          HStack {
            if let firstLabel = points.first?.label {
              Text(firstLabel)
            }
            Spacer()
            if let lastLabel = points.last?.label {
              Text(lastLabel)
            }
          }
          .font(.system(size: 10))
          .foregroundColor(Color(nsColor: .tertiaryLabelColor))
          .padding(.leading, 46)
        }

        // token | 费用 segmented toggle
        if !isBillingOnly {
          HStack {
            Spacer()
            Picker("", selection: $metric) {
              Text("token").tag(FlyoutChartMetric.tokens)
              Text("费用").tag(FlyoutChartMetric.cost)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .frame(width: 112)
          }
        }
      }

      // Selected day detail + per-model breakdown
      if let pt = selectedPt {
        let dayModels: [CardDailyModelItem] = Array((pt.models ?? []).prefix(4))
        let daySummaryText = (isBillingOnly && pt.totalTokens == 0)
          ? "\(pt.label): \(MeterFormat.money(pt.costUsd, symbol: curSym))"
          : "\(pt.label): \(MeterFormat.money(pt.costUsd, symbol: curSym)) · \(MeterFormat.tokens(pt.totalTokens)) tokens"

        VStack(alignment: .leading, spacing: 6) {
          Text(daySummaryText)
            .font(.system(size: 11.5))
            .monospacedDigit()
            .foregroundColor(.secondary)
            .lineLimit(1)

          ForEach(dayModels) { m in
            HStack(alignment: .center, spacing: 8) {
              Rectangle()
                .fill(CodexBarPalette.tealBar)
                .frame(width: 2, height: 26)
              VStack(alignment: .leading, spacing: 1) {
                Text(m.model)
                  .font(.system(size: 11))
                  .foregroundColor(.secondary)
                  .lineLimit(1)
                  .truncationMode(.middle)
                Text("\(MeterFormat.money(m.costUsd, symbol: curSym)) · \(MeterFormat.tokens(m.totalTokens))")
                  .font(.system(size: 10.5))
                  .monospacedDigit()
                  .foregroundColor(Color(nsColor: .tertiaryLabelColor))
              }
            }
          }
        }
      }

      // Period total + footnote
      VStack(alignment: .leading, spacing: 2) {
        if card.isExternal == true {
          let periodLabel = card.billingSummary?.periodLabel ?? "本月"
          let totalCost = card.billingSummary?.periodCost ?? card.days30.costUsd
          Text("\(periodLabel)总计: \(MeterFormat.money(totalCost, symbol: curSym))")
            .font(.system(size: 11.5))
            .monospacedDigit()
            .foregroundColor(.secondary)
        } else {
          Text("估算总计 (近 30 天): \(MeterFormat.money(card.days30.costUsd, symbol: curSym))")
            .font(.system(size: 11.5))
            .monospacedDigit()
            .foregroundColor(.secondary)
        }
        Text(card.footnote ?? "根据 Token 用量估算 · 不是订阅账单")
          .font(.system(size: 10))
          .foregroundColor(Color(nsColor: .tertiaryLabelColor))
      }

      // External provider breakdowns (products / models)
      if !breakdowns.isEmpty {
        ForEach(breakdowns.prefix(2)) { sec in
          VStack(alignment: .leading, spacing: 5) {
            Text(sec.title)
              .font(.system(size: 11.5, weight: .medium))
              .foregroundColor(.secondary)

            ForEach(sec.items.prefix(5)) { item in
              VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                  Text(item.name)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                  Spacer(minLength: 4)
                  if let share = item.sharePct {
                    Text("\(String(format: "%.1f", share))%")
                      .font(.system(size: 10))
                      .monospacedDigit()
                      .foregroundColor(Color(nsColor: .tertiaryLabelColor))
                  }
                  if let limit = item.limit, limit > 0 {
                    Text("\(MeterFormat.money(item.cost, symbol: curSym)) / \(MeterFormat.money(limit, symbol: curSym))")
                      .font(.system(size: 10.5))
                      .monospacedDigit()
                      .foregroundColor(.secondary)
                      .lineLimit(1)
                  } else if let cost = item.cost {
                    Text(MeterFormat.money(cost, symbol: curSym))
                      .font(.system(size: 10.5))
                      .monospacedDigit()
                      .foregroundColor(.secondary)
                      .lineLimit(1)
                  }
                }
                if let pct = item.usagePct, item.limit != nil {
                  GeometryReader { geo in
                    ZStack(alignment: .leading) {
                      Capsule().fill(Color.primary.opacity(0.10))
                      Capsule()
                        .fill(pct >= 90 ? Color.red.opacity(0.8) : CodexBarPalette.tealBar)
                        .frame(width: max(3, geo.size.width * CGFloat(min(1.0, max(0.0, pct / 100.0)))))
                    }
                  }
                  .frame(height: 3.5)
                }
              }
            }
          }
        }
      }

      // Projects breakdown (项目)
      if !projects.isEmpty {
        VStack(alignment: .leading, spacing: 7) {
          Text("项目")
            .font(.system(size: 11.5))
            .foregroundColor(.secondary)

          ForEach(projects) { proj in
            VStack(alignment: .leading, spacing: 1) {
              HStack(spacing: 6) {
                Text(proj.name)
                  .font(.system(size: 11.5, weight: .medium))
                  .foregroundColor(.secondary)
                  .lineLimit(1)
                Spacer(minLength: 4)
                Text("\(MeterFormat.money(proj.costUsd, symbol: curSym)) · \(MeterFormat.tokens(proj.totalTokens)) token 用量")
                  .font(.system(size: 11))
                  .monospacedDigit()
                  .foregroundColor(.secondary)
                  .lineLimit(1)
              }
              Text(proj.path)
                .font(.system(size: 10))
                .foregroundColor(Color(nsColor: .tertiaryLabelColor))
                .lineLimit(1)
                .truncationMode(.middle)
            }
          }
        }
      }
    }
      .padding(16)
      .frame(width: 286, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .background(
        GeometryReader { geo in
          Color.clear.preference(key: FlyoutContentHeightKey.self, value: geo.size.height)
        }
      )
    }
    .frame(minWidth: 286, idealWidth: 286, maxWidth: 286, maxHeight: .infinity, alignment: .top)
    .contentShape(Rectangle())
    .onHover { onHoverChanged($0) }
    .onPreferenceChange(FlyoutContentHeightKey.self) { height in
      onContentHeightChanged(height)
    }
    .onChange(of: selectedPt?.date) { _ in
      DispatchQueue.main.async {
        CostHistoryFlyoutController.shared.refreshPanelHeightPreservingTop()
      }
    }
  }

  private func flyoutBar(
    pt: CardDailyPoint,
    scaleMax: Double,
    maxVal: Double,
    peakDate: String?,
    selectedDate: String?
  ) -> some View {
    let val = pointValue(pt)
    let ratio: CGFloat = val > 0 ? CGFloat(val / scaleMax) : 0
    let isSelected = selectedDate == pt.date
    let isPeak = maxVal > 0 && pt.date == peakDate

    return ZStack(alignment: .bottom) {
      if isSelected {
        Rectangle()
          .fill(Color.primary.opacity(0.08))
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      RoundedRectangle(cornerRadius: 1.5, style: .continuous)
        .fill(val > 0 ? CodexBarPalette.tealBar : Color.primary.opacity(0.12))
        .frame(maxWidth: .infinity)
        .frame(height: val > 0 ? max(5, ratio * 98) : 1.5)
        .overlay(alignment: .top) {
          if isPeak {
            RoundedRectangle(cornerRadius: 1.5, style: .continuous)
              .fill(Color(nsColor: .systemYellow))
              .frame(height: 4)
          }
        }
        .padding(.horizontal, 1.0)
    }
    .frame(maxWidth: .infinity)
    .frame(height: 102, alignment: .bottom)
  }
}
