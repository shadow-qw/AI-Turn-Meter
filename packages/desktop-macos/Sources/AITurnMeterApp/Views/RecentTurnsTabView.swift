import AITurnMeterCore
import AppKit
import SwiftUI

struct RecentTurnsTabView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var hoveredTurnChip: String? = nil

  private var filteredTurns: [TurnSummary] {
    let q = vm.recentTurnsSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !q.isEmpty else { return vm.recentTurns }
    return vm.recentTurns.filter { t in
      (t.model?.lowercased().contains(q) ?? false) ||
      (t.workspacePath?.lowercased().contains(q) ?? false) ||
      (t.replyPreview?.lowercased().contains(q) ?? false) ||
      (t.toolLabel?.lowercased().contains(q) ?? false)
    }
  }

  var body: some View {
    VStack(spacing: 10) {
      HStack(spacing: 8) {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 4) {
            turnToolChip(key: "all", label: "全部")
            ForEach(vm.orderedKeys, id: \.self) { k in
              turnToolChip(key: k, label: vm.toolShortTitle(for: k))
            }
          }
        }

        HStack(spacing: 5) {
          Image(systemName: "magnifyingglass")
            .font(.system(size: 11))
            .foregroundColor(.secondary)
          TextField("搜索模型 / 目录 / 回复摘要…", text: $vm.recentTurnsSearch)
            .textFieldStyle(.plain)
            .font(.system(size: 11.5))
          if !vm.recentTurnsSearch.isEmpty {
            Button {
              vm.recentTurnsSearch = ""
            } label: {
              Image(systemName: "xmark.circle.fill")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .frame(width: 210)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(Capsule())
        .overlay(Capsule().stroke(Color.primary.opacity(0.08), lineWidth: 1))

        if vm.recentTurnsLoading {
          ProgressView().controlSize(.small)
        }
      }

      if filteredTurns.isEmpty {
        Spacer()
        VStack(spacing: 6) {
          Image(systemName: "tray")
            .font(.system(size: 24))
            .foregroundColor(.secondary.opacity(0.55))
          Text(vm.recentTurnsLoading ? "正在读取历史轮次…" : "暂无匹配的轮次记录")
            .font(.system(size: 12.5))
            .foregroundColor(.secondary)
        }
        Spacer()
      } else {
        ScrollView {
          LazyVStack(spacing: 8) {
            ForEach(filteredTurns) { t in
              turnCard(t)
            }
          }
          .padding(.bottom, 4)
        }
      }
    }
  }

  private func turnToolChip(key: String, label: String) -> some View {
    let active = vm.recentTurnsFilterTool == key
    let hovered = hoveredTurnChip == key
    let color = vm.toolAccentColor(for: key)
    return Button {
      vm.recentTurnsFilterTool = key
      vm.fetchRecentTurns()
    } label: {
      HStack(spacing: 4) {
        if key != "all" {
          Circle().fill(hovered ? Color.white : color).frame(width: 6, height: 6)
        }
        Text(label)
          .font(.system(size: 11, weight: active ? .semibold : .medium))
      }
      .foregroundColor(hovered ? .white : (active ? .primary : .primary.opacity(0.82)))
      .padding(.horizontal, 9)
      .padding(.vertical, 4.5)
      .background(hovered ? color : (active ? Color.primary.opacity(0.10) : Color.primary.opacity(0.05)))
      .clipShape(Capsule())
    }
    .buttonStyle(.plain)
    .onHover { inside in
      if inside { hoveredTurnChip = key }
      else if hoveredTurnChip == key { hoveredTurnChip = nil }
    }
  }

  private func openWorkspacePath(_ path: String) {
    var isDir: ObjCBool = false
    if FileManager.default.fileExists(atPath: path, isDirectory: &isDir) {
      if isDir.boolValue {
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
      } else {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
      }
    } else {
      vm.bannerIsError = true
      vm.statusBanner = "目录不存在或已被移动：\(path)"
    }
  }

  private func turnCard(_ t: TurnSummary) -> some View {
    let toolKey = t.tool ?? ""
    let accent = vm.toolAccentColor(for: toolKey)
    let toolName = t.toolLabel ?? vm.displayTitle(for: toolKey)
    let modelName = (t.model != nil && t.model != "unknown") ? t.model! : toolName
    let workspacePath = t.workspacePath?.trimmingCharacters(in: .whitespacesAndNewlines)
    let hasWorkspacePath = !(workspacePath ?? "").isEmpty
    let wsName = workspacePath.map { ($0 as NSString).lastPathComponent }
    let appPath = vm.apps[toolKey]?.appPath

    return HStack(spacing: 0) {
      RoundedRectangle(cornerRadius: 2)
        .fill(accent)
        .frame(width: 3.5)
        .padding(.vertical, 8)
        .padding(.leading, 6)

      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          Text(toolName)
            .font(.system(size: 10.5, weight: .semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(accent.opacity(0.14))
            .foregroundColor(accent)
            .clipShape(Capsule())

          Text(modelName)
            .font(.system(size: 12, weight: .semibold))
            .lineLimit(1)

          if let ws = wsName, !ws.isEmpty {
            HStack(spacing: 3) {
              Image(systemName: "folder")
                .font(.system(size: 9.5))
              Text(ws)
                .lineLimit(1)
            }
            .font(.system(size: 10.5))
            .foregroundColor(.secondary)
          }

          Spacer()

          if let cost = t.estimatedCostUsd {
            Text(MeterFormat.usd(cost))
              .font(.system(size: 11, weight: .semibold))
              .monospacedDigit()
              .foregroundColor(CodexBarPalette.accentBlue)
              .padding(.horizontal, 6)
              .padding(.vertical, 1.5)
              .background(CodexBarPalette.accentBlue.opacity(0.10))
              .clipShape(Capsule())
          }

          Text(MeterFormat.timeText(t.completedAtMs))
            .font(.system(size: 10.5))
            .monospacedDigit()
            .foregroundColor(.secondary)
        }

        if let inTok = t.totalInputTokens, let outTok = t.outputTokens {
          HStack(spacing: 6) {
            metricPill(
              "输入 \(MeterFormat.tokens(inTok))" +
              (t.cacheRatePct != nil ? " (\(MeterFormat.pct(t.cacheRatePct)))" : "")
            )
            metricPill("输出 \(MeterFormat.tokens(outTok))")
            if let tps = t.tps, tps > 0 {
              metricPill(MeterFormat.tps(tps))
            }
            if let saved = t.cacheSavingsUsd, saved > 0 {
              metricPill("省 \(MeterFormat.usd(saved))")
            }
          }
        } else if let inline = t.inlineText {
          Text(inline)
            .font(.system(size: 11.5))
            .monospacedDigit()
        }

        if let preview = t.replyPreview, !preview.isEmpty {
          Text(preview)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
            .lineLimit(2)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.035))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }

        if hasWorkspacePath || appPath != nil {
          HStack(spacing: 8) {
            Spacer()
            if let ws = workspacePath, !ws.isEmpty {
              Button {
                openWorkspacePath(ws)
              } label: {
                Label("打开目录", systemImage: "folder")
                  .font(.system(size: 10.5))
              }
              .buttonStyle(.bordered)
              .controlSize(.mini)
            }
            if let appPath = appPath {
              Button {
                NSWorkspace.shared.open(URL(fileURLWithPath: appPath))
              } label: {
                Label("打开 \(toolName)", systemImage: "arrow.up.forward.app")
                  .font(.system(size: 10.5))
              }
              .buttonStyle(.bordered)
              .controlSize(.mini)
            }
          }
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 9)
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .stroke(Color.primary.opacity(0.07), lineWidth: 1)
    )
  }

  private func metricPill(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 10.5, weight: .medium))
      .monospacedDigit()
      .foregroundColor(.primary.opacity(0.85))
      .padding(.horizontal, 7)
      .padding(.vertical, 2.5)
      .background(Color.primary.opacity(0.055))
      .clipShape(Capsule())
  }
}
