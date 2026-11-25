import AITurnMeterCore
import AppKit
import SwiftUI
import UniformTypeIdentifiers

private struct MenuBarWrapLayout: Layout {
  var spacing: CGFloat = 6
  var rowSpacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let maxWidth = proposal.width ?? .infinity
    var x: CGFloat = 0
    var y: CGFloat = 0
    var rowHeight: CGFloat = 0
    var totalWidth: CGFloat = 0

    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > maxWidth {
        totalWidth = max(totalWidth, x - spacing)
        x = 0
        y += rowHeight + rowSpacing
        rowHeight = 0
      }
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
    totalWidth = max(totalWidth, max(0, x - spacing))
    return CGSize(
      width: maxWidth.isFinite ? maxWidth : totalWidth,
      height: y + rowHeight
    )
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX
    var y = bounds.minY
    var rowHeight: CGFloat = 0

    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > bounds.minX && x + size.width > bounds.maxX {
        x = bounds.minX
        y += rowHeight + rowSpacing
        rowHeight = 0
      }
      subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
  }
}

private struct MetricItemReorderDropDelegate: DropDelegate {
  let targetItem: MenuBarMetricItem
  @Binding var draggingItem: MenuBarMetricItem?
  let onMove: (MenuBarMetricItem, MenuBarMetricItem) -> Void

  func dropEntered(info: DropInfo) {
    guard let source = draggingItem, source != targetItem else { return }
    withAnimation(.easeInOut(duration: 0.14)) {
      onMove(source, targetItem)
    }
  }

  func dropUpdated(info: DropInfo) -> DropProposal? {
    DropProposal(operation: .move)
  }

  func performDrop(info: DropInfo) -> Bool {
    draggingItem = nil
    return true
  }
}

struct MenuBarSettingsPaneView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var draggingMetricItem: MenuBarMetricItem? = nil

  private var cfg: MenuBarCustomConfig {
    vm.menuBarConfig
  }

  private let metricGridColumns: [GridItem] = [
    GridItem(.flexible(), spacing: 8),
    GridItem(.flexible(), spacing: 8),
  ]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        headerAndPreviewCard

        if vm.showMenuBarExtra {
          customMetricsCard
          providerAndScopeCard
          formattingCard
        }

        popoverSectionsCard
      }
      .padding(24)
    }
  }

  private var headerAndPreviewCard: some View {
    let previewText = vm.formattedMenuBarTitle(useSampleFallback: true)
    let liveText = vm.formattedMenuBarTitle(useSampleFallback: false)
    let usesSamplePreview = liveText.isEmpty && !cfg.items.isEmpty
    let matchedPreset = cfg.matchingPreset

    return SettingsGroupCard {
      HStack(spacing: 10) {
        Text("显示顶部菜单栏图标")
          .font(.system(size: 12.5))
          .foregroundColor(.primary)

        Spacer(minLength: 8)

        Button("恢复默认") {
          vm.resetMenuBarConfigToDefaults()
        }
        .buttonStyle(.borderless)
        .font(.system(size: 11.5))
        .foregroundColor(.secondary)

        Toggle("", isOn: Binding(
          get: { vm.showMenuBarExtra },
          set: { vm.setShowMenuBarExtra($0) }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)

      if vm.showMenuBarExtra {
        Divider().padding(.leading, 14)
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 6) {
            Text("实时预览")
              .font(.system(size: 11.5, weight: .medium))
              .foregroundColor(.secondary)
            Spacer()
            Text(matchedPreset?.title ?? "自定义组合")
              .font(.system(size: 10.5, weight: .medium))
              .foregroundColor(CodexBarPalette.accentBlue)
              .padding(.horizontal, 7)
              .padding(.vertical, 2)
              .background(CodexBarPalette.accentBlue.opacity(0.10))
              .clipShape(Capsule())
          }

          HStack(spacing: 10) {
            Spacer(minLength: 4)

            HStack(spacing: 5) {
              previewStatusIcon

              if !previewText.isEmpty {
                Text(previewText)
                  .font(.system(size: 12, weight: .medium))
                  .monospacedDigit()
                  .foregroundColor(.primary)
                  .lineLimit(1)
              }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
              RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color(nsColor: .windowBackgroundColor))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color.primary.opacity(0.10), lineWidth: 1)
            )

            HStack(spacing: 7) {
              Image(systemName: "wifi")
              Image(systemName: "battery.100")
              Text("19:52")
                .monospacedDigit()
            }
            .font(.system(size: 11))
            .foregroundColor(.secondary.opacity(0.65))
          }
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
          .frame(maxWidth: .infinity)
          .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(Color.primary.opacity(0.045))
          )

          if previewText.count > 34 {
            HStack(spacing: 5) {
              Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 10.5))
                .foregroundColor(.orange)
              Text("当前文本较宽（\(previewText.count) 字符），刘海屏上可能被系统折叠")
                .font(.system(size: 11))
                .foregroundColor(.orange)
            }
          } else if usesSamplePreview {
            Text("当前暂无实时数据，预览以示例数值展示排版效果")
              .font(.system(size: 11))
              .foregroundColor(.secondary)
          }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)

        Divider().padding(.leading, 14)
        VStack(alignment: .leading, spacing: 8) {
          Text("快捷预设")
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(.secondary)

          MenuBarWrapLayout(spacing: 6, rowSpacing: 6) {
            ForEach(MenuBarPreset.allCases) { preset in
              let isActive = matchedPreset == preset
              Button {
                vm.applyMenuBarPreset(preset)
              } label: {
                Text(preset.title)
                  .font(.system(size: 11.5, weight: isActive ? .semibold : .regular))
                  .foregroundColor(isActive ? .white : .primary)
                  .padding(.horizontal, 10)
                  .padding(.vertical, 5)
                  .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                      .fill(isActive ? CodexBarPalette.accentBlue : Color.primary.opacity(0.06))
                  )
                  .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
            }
          }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
      }
    }
  }

  @ViewBuilder
  private var previewStatusIcon: some View {
    switch vm.menuBarIconStyle {
    case .none:
      if cfg.items.isEmpty {
        dualBarPreviewGlyph
      } else {
        EmptyView()
      }
    case .gauge:
      Image(systemName: "gauge.with.needle")
        .font(.system(size: 12.5, weight: .medium))
        .foregroundColor(.primary)
    case .dualBar:
      dualBarPreviewGlyph
    }
  }

  private var dualBarPreviewGlyph: some View {
    VStack(spacing: 2) {
      ZStack(alignment: .leading) {
        Capsule()
          .stroke(Color.primary.opacity(0.45), lineWidth: 0.9)
          .frame(width: 14, height: 5.5)
        Capsule()
          .fill(Color.primary)
          .frame(width: 10.5, height: 5.5)
      }
      ZStack(alignment: .leading) {
        Capsule()
          .stroke(Color.primary.opacity(0.45), lineWidth: 0.9)
          .frame(width: 14, height: 3.5)
        Capsule()
          .fill(Color.primary)
          .frame(width: 7.5, height: 3.5)
      }
    }
  }

  private var customMetricsCard: some View {
    SettingsGroupCard {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text("已选展示项与顺序")
            .font(.system(size: 12.5, weight: .medium))
            .foregroundColor(.primary)
          Spacer()
          if !cfg.items.isEmpty {
            Text("拖动或点 ‹ / › 调整顺序（共 \(cfg.items.count) 项）")
              .font(.system(size: 11))
              .foregroundColor(.secondary)
          }
        }

        if cfg.items.isEmpty {
          HStack(spacing: 6) {
            Image(systemName: "info.circle")
              .font(.system(size: 11.5))
              .foregroundColor(.secondary)
            Text("未选择文本指标，当前仅在顶部菜单栏展示图标；点击下方卡片可自由组合。")
              .font(.system(size: 11.5))
              .foregroundColor(.secondary)
          }
          .padding(.vertical, 4)
        } else {
          MenuBarWrapLayout(spacing: 6, rowSpacing: 6) {
            ForEach(Array(cfg.items.enumerated()), id: \.element) { idx, item in
              activeMetricChip(item: item, index: idx, totalCount: cfg.items.count)
                .opacity(draggingMetricItem == item ? 0.45 : 1.0)
                .onHover { inside in
                  if inside && draggingMetricItem != nil && NSEvent.pressedMouseButtons == 0 {
                    draggingMetricItem = nil
                  }
                }
                .onDrag {
                  draggingMetricItem = item
                  return NSItemProvider(object: item.rawValue as NSString)
                }
                .onDrop(
                  of: [UTType.plainText],
                  delegate: MetricItemReorderDropDelegate(
                    targetItem: item,
                    draggingItem: $draggingMetricItem,
                    onMove: { src, dst in
                      vm.updateMenuBarConfig { $0.moveItem(from: src, to: dst) }
                    }
                  )
                )
            }
          }
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)

      Divider().padding(.leading, 14)

      VStack(alignment: .leading, spacing: 8) {
        Text("自定义展示项（点击切换启用）")
          .font(.system(size: 12, weight: .medium))
          .foregroundColor(.secondary)

        LazyVGrid(columns: metricGridColumns, spacing: 8) {
          ForEach(MenuBarMetricItem.allCases) { item in
            metricPickerCard(item: item)
          }
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
    }
  }

  private func activeMetricChip(item: MenuBarMetricItem, index: Int, totalCount: Int) -> some View {
    HStack(spacing: 4) {
      Text("\(index + 1)")
        .font(.system(size: 10, weight: .bold, design: .monospaced))
        .foregroundColor(CodexBarPalette.accentBlue)
        .frame(width: 14, height: 14)
        .background(Circle().fill(CodexBarPalette.accentBlue.opacity(0.14)))

      Text(item.shortTitle)
        .font(.system(size: 11.5, weight: .medium))
        .foregroundColor(.primary)

      if index > 0 {
        Button {
          withAnimation(.easeInOut(duration: 0.14)) {
            vm.updateMenuBarConfig { $0.moveItem(item, direction: -1) }
          }
        } label: {
          Image(systemName: "chevron.left")
            .font(.system(size: 9, weight: .semibold))
            .foregroundColor(.secondary)
            .padding(.horizontal, 2)
        }
        .buttonStyle(.borderless)
        .help("左移")
      }

      if index + 1 < totalCount {
        Button {
          withAnimation(.easeInOut(duration: 0.14)) {
            vm.updateMenuBarConfig { $0.moveItem(item, direction: 1) }
          }
        } label: {
          Image(systemName: "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .foregroundColor(.secondary)
            .padding(.horizontal, 2)
        }
        .buttonStyle(.borderless)
        .help("右移")
      }

      Button {
        vm.updateMenuBarConfig { $0.toggleItem(item) }
      } label: {
        Image(systemName: "xmark")
          .font(.system(size: 9, weight: .semibold))
          .foregroundColor(.secondary)
          .padding(.horizontal, 2)
      }
      .buttonStyle(.borderless)
      .help("移除此项")
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .fill(CodexBarPalette.accentBlue.opacity(0.08))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .stroke(CodexBarPalette.accentBlue.opacity(0.32), lineWidth: 1)
    )
  }

  private func metricPickerCard(item: MenuBarMetricItem) -> some View {
    let selected = cfg.items.contains(item)
    let sample = item.sampleValue(
      quotaMode: vm.quotaDisplayMode,
      showProviderName: cfg.showProviderName,
      showQuotaPrefix: cfg.showQuotaPrefix,
      showMetricLabels: cfg.showMetricLabels
    )

    return Button {
      vm.updateMenuBarConfig { $0.toggleItem(item) }
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Image(systemName: item.systemImage)
            .font(.system(size: 11.5))
            .foregroundColor(selected ? CodexBarPalette.accentBlue : .secondary)
            .frame(width: 14)

          Text(item.title)
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(.primary)
            .lineLimit(1)

          Spacer(minLength: 4)

          Image(systemName: selected ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 13))
            .foregroundColor(selected ? CodexBarPalette.accentBlue : Color.secondary.opacity(0.35))
        }

        HStack(spacing: 6) {
          Text(item.subtitle)
            .font(.system(size: 10.5))
            .foregroundColor(.secondary)
            .lineLimit(1)

          Spacer(minLength: 4)

          Text(sample)
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .foregroundColor(selected ? CodexBarPalette.accentBlue : .secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(
              RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(selected ? CodexBarPalette.accentBlue.opacity(0.12) : Color.primary.opacity(0.05))
            )
            .lineLimit(1)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(selected ? CodexBarPalette.accentBlue.opacity(0.06) : Color.primary.opacity(0.025))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(selected ? CodexBarPalette.accentBlue.opacity(0.55) : Color.primary.opacity(0.08), lineWidth: 1)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private var providerAndScopeCard: some View {
    let usesScope = cfg.items.contains(where: \.usesUsageScope) && !cfg.selectedProviders.isEmpty

    return SettingsGroupCard {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text("筛选展示软件")
            .font(.system(size: 12.5, weight: .medium))
            .foregroundColor(.primary)
          Spacer()
          Text(cfg.selectedProviders.isEmpty ? "自动显示全部已启用软件" : "已选 \(cfg.selectedProviders.count) 个（支持多选）")
            .font(.system(size: 11))
            .foregroundColor(.secondary)
        }

        MenuBarWrapLayout(spacing: 6, rowSpacing: 6) {
          let isAll = cfg.selectedProviders.isEmpty
          Button {
            vm.updateMenuBarConfig { $0.selectedProviders = [] }
          } label: {
            HStack(spacing: 5) {
              Image(systemName: isAll ? "checkmark.circle.fill" : "sparkles")
                .font(.system(size: 11))
              Text("全部（自动）")
                .font(.system(size: 11.5, weight: isAll ? .semibold : .regular))
            }
            .foregroundColor(isAll ? .white : .primary)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(
              RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isAll ? CodexBarPalette.accentBlue : Color.primary.opacity(0.06))
            )
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)

          ForEach(vm.allQuotaProviderKeys, id: \.self) { key in
            let isSelected = cfg.selectedProviders.contains(key)
            let enabled = vm.isToolEnabled(key)
            Button {
              vm.updateMenuBarConfig { $0.toggleProvider(key) }
            } label: {
              HStack(spacing: 5) {
                ToolGlyph.iconView(for: key, sfSymbolOverride: vm.toolIconSymbol(for: key), size: 12)
                Text(vm.toolShortTitle(for: key))
                  .font(.system(size: 11.5, weight: isSelected ? .semibold : .regular))
                if isSelected {
                  Image(systemName: "checkmark")
                    .font(.system(size: 9.5, weight: .bold))
                }
              }
              .foregroundColor(isSelected ? .white : (enabled ? .primary : .secondary))
              .padding(.horizontal, 9)
              .padding(.vertical, 5)
              .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                  .fill(isSelected ? CodexBarPalette.accentBlue : Color.primary.opacity(0.06))
              )
              .opacity(enabled || isSelected ? 1.0 : 0.6)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
          }
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)

      if usesScope {
        Divider().padding(.leading, 14)
        settingsControlRow(title: "用量与费用统计范围") {
          Picker("", selection: Binding(
            get: { vm.menuBarUsageScope },
            set: { vm.setMenuBarUsageScope($0) }
          )) {
            ForEach(MenuBarUsageScope.allCases, id: \.self) { sc in
              Text(sc.title).tag(sc)
            }
          }
          .labelsHidden()
          .frame(width: 180)
          .controlSize(.small)
        }
      }
    }
  }

  private var formattingCard: some View {
    SettingsGroupCard {
      settingsControlRow(title: "菜单栏图标") {
        Picker("", selection: Binding(
          get: { vm.menuBarIconStyle },
          set: { vm.setMenuBarIconStyle($0) }
        )) {
          ForEach(MenuBarIconStyle.allCases, id: \.self) { s in
            Text(s.title).tag(s)
          }
        }
        .labelsHidden()
        .frame(width: 170)
        .controlSize(.small)
      }

      Divider().padding(.leading, 14)
      settingsControlRow(title: "配额展示方式") {
        Picker("", selection: Binding(
          get: { vm.quotaDisplayMode },
          set: { vm.setQuotaDisplayMode($0) }
        )) {
          ForEach(QuotaDisplayMode.allCases, id: \.self) { mode in
            Text(mode.title).tag(mode)
          }
        }
        .labelsHidden()
        .frame(width: 170)
        .controlSize(.small)
      }

      Divider().padding(.leading, 14)
      settingsControlRow(title: "多项分隔符") {
        Picker("", selection: Binding(
          get: { cfg.separator },
          set: { nextSep in
            vm.updateMenuBarConfig { $0.separator = nextSep }
          }
        )) {
          ForEach(MenuBarSeparatorStyle.allCases) { sep in
            Text(sep.chipTitle).tag(sep)
          }
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .frame(width: 180)
        .controlSize(.small)
      }

      Divider().padding(.leading, 14)
      settingsControlRow(title: "显示软件名称前缀（如 Codex / AGY / 司内）") {
        Toggle("", isOn: Binding(
          get: { cfg.showProviderName },
          set: { val in vm.updateMenuBarConfig { $0.showProviderName = val } }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
      }

      Divider().padding(.leading, 14)
      settingsControlRow(title: "显示「剩 / 用」配额前缀") {
        Toggle("", isOn: Binding(
          get: { cfg.showQuotaPrefix },
          set: { val in vm.updateMenuBarConfig { $0.showQuotaPrefix = val } }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
      }

      Divider().padding(.leading, 14)
      settingsControlRow(title: "显示简短指标标签（如 今 / 末）") {
        Toggle("", isOn: Binding(
          get: { cfg.showMetricLabels },
          set: { val in vm.updateMenuBarConfig { $0.showMetricLabels = val } }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
      }
    }
  }

  private var popoverSectionsCard: some View {
    SettingsGroupCard {
      if !vm.showMenuBarExtra {
        settingsControlRow(title: "配额展示方式") {
          Picker("", selection: Binding(
            get: { vm.quotaDisplayMode },
            set: { vm.setQuotaDisplayMode($0) }
          )) {
            ForEach(QuotaDisplayMode.allCases, id: \.self) { mode in
              Text(mode.title).tag(mode)
            }
          }
          .labelsHidden()
          .frame(width: 170)
          .controlSize(.small)
        }
        Divider().padding(.leading, 14)
      }

      settingsControlRow(title: "在菜单卡片中显示 30 天迷你趋势图") {
        Toggle("", isOn: Binding(
          get: { cfg.popoverSections.showMiniChart },
          set: { val in vm.updateMenuBarConfig { $0.popoverSections.showMiniChart = val } }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
      }

      Divider().padding(.leading, 14)
      settingsControlRow(title: "在菜单卡片中显示「最近窗口」") {
        Toggle("", isOn: Binding(
          get: { cfg.popoverSections.showRecentWindows },
          set: { val in vm.updateMenuBarConfig { $0.popoverSections.showRecentWindows = val } }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
      }

      Divider().padding(.leading, 14)
      settingsControlRow(title: "在菜单卡片中显示「会话」列表") {
        Toggle("", isOn: Binding(
          get: { cfg.popoverSections.showRecentSessions },
          set: { val in vm.updateMenuBarConfig { $0.popoverSections.showRecentSessions = val } }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
      }

      Divider().padding(.leading, 14)
      settingsControlRow(title: "在菜单卡片底部显示常用模型与速率") {
        Toggle("", isOn: Binding(
          get: { cfg.popoverSections.showFooterModelInfo },
          set: { val in vm.updateMenuBarConfig { $0.popoverSections.showFooterModelInfo = val } }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
      }
    }
  }
}
