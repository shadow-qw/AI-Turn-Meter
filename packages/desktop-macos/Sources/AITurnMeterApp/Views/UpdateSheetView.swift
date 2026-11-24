import AITurnMeterCore
import AppKit
import SwiftUI

struct UpdateSheetView: View {
  @ObservedObject var vm: MeterViewModel

  private var isDownloadBusy: Bool {
    vm.updateStage == .downloading
  }

  private var isLockedBusy: Bool {
    vm.updateStage == .verifying || vm.updateStage == .installing
  }

  private var headerTitle: String {
    switch vm.updateStage {
    case .checking:
      return "检查软件更新"
    case .available:
      if let v = vm.availableUpdate?.version {
        return "发现新版本 v\(v)"
      }
      return "发现新版本"
    case .downloading, .verifying, .installing:
      if let v = vm.availableUpdate?.version {
        return "正在更新到 v\(v)"
      }
      return "正在更新"
    case .upToDate:
      return "已是最新版本"
    case .completedManualOpen:
      return "安装包已就绪"
    case .cancelled:
      return "已取消更新"
    case .failed:
      return "更新未能完成"
    case .idle:
      return "检查软件更新"
    }
  }

  private var resolvedSizeBytes: Int64 {
    if vm.updateTotalBytes > 0 { return vm.updateTotalBytes }
    return vm.availableUpdate?.assetSizeBytes ?? 0
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      headerSection

      if vm.updateStage == .checking || isDownloadBusy || isLockedBusy {
        progressCard
      }

      statusBannerSection

      if let info = vm.availableUpdate, !info.notes.isEmpty {
        releaseNotesSection(info)
      }

      actionBar
    }
    .padding(20)
    .frame(width: 520)
    .interactiveDismissDisabled(isDownloadBusy || isLockedBusy)
  }

  private var headerSection: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(nsImage: NSApplication.shared.applicationIconImage)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

      VStack(alignment: .leading, spacing: 4) {
        Text(headerTitle)
          .font(.system(size: 15, weight: .semibold))
          .foregroundColor(.primary)

        HStack(spacing: 6) {
          if let info = vm.availableUpdate {
            Text("v\(vm.version) → v\(info.version)")
              .font(.system(size: 11.5, weight: .medium, design: .monospaced))
              .foregroundColor(.primary)
              .padding(.horizontal, 7)
              .padding(.vertical, 2)
              .background(Color.accentColor.opacity(0.12))
              .clipShape(Capsule())

            if resolvedSizeBytes > 0 {
              Text(MeterFormat.bytes(resolvedSizeBytes))
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(.secondary)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Color.primary.opacity(0.06))
                .clipShape(Capsule())
            }
          } else {
            Text("当前版本 v\(vm.version)")
              .font(.system(size: 11.5, design: .monospaced))
              .foregroundColor(.secondary)
          }
        }
      }

      Spacer()
    }
  }

  private var progressCard: some View {
    VStack(alignment: .leading, spacing: 8) {
      switch vm.updateStage {
      case .checking:
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("正在连接 GitHub Releases 检查最新版本…")
            .font(.system(size: 12.5))
            .foregroundColor(.secondary)
        }

      case .downloading:
        HStack(alignment: .firstTextBaseline) {
          Text("正在下载安装包…")
            .font(.system(size: 12.5, weight: .medium))
            .foregroundColor(.primary)
          Spacer()
          if let progress = vm.updateDownloadProgress {
            Text("\(Int((progress * 100).rounded()))%")
              .font(.system(size: 12, weight: .medium, design: .monospaced))
              .monospacedDigit()
              .foregroundColor(.secondary)
          }
        }

        if let progress = vm.updateDownloadProgress {
          ProgressView(value: progress)
            .progressViewStyle(.linear)
        } else {
          ProgressView()
            .progressViewStyle(.linear)
        }

        HStack {
          let leftText: String = {
            if vm.updateTotalBytes > 0 {
              return "\(MeterFormat.bytes(vm.updateDownloadedBytes)) / \(MeterFormat.bytes(vm.updateTotalBytes))"
            }
            if vm.updateDownloadedBytes > 0 {
              return "已下载 \(MeterFormat.bytes(vm.updateDownloadedBytes))"
            }
            return "准备下载…"
          }()
          Text(leftText)
            .font(.system(size: 11, design: .monospaced))
            .monospacedDigit()
            .foregroundColor(.secondary)

          Spacer()

          let rightText = downloadRateAndEtaText()
          if !rightText.isEmpty {
            Text(rightText)
              .font(.system(size: 11, design: .monospaced))
              .monospacedDigit()
              .foregroundColor(.secondary)
          }
        }

      case .verifying:
        Text("正在校验安装包完整性…")
          .font(.system(size: 12.5, weight: .medium))
          .foregroundColor(.primary)
        ProgressView()
          .progressViewStyle(.linear)
        Text("校验 SHA-256 哈希，防止安装包损坏")
          .font(.system(size: 11))
          .foregroundColor(.secondary)

      case .installing:
        Text("正在安装更新并准备重启…")
          .font(.system(size: 12.5, weight: .medium))
          .foregroundColor(.primary)
        ProgressView()
          .progressViewStyle(.linear)
        Text("正在替换应用程序并自动重启，请稍候…")
          .font(.system(size: 11))
          .foregroundColor(.secondary)

      default:
        EmptyView()
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.primary.opacity(0.035))
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(Color.primary.opacity(0.08), lineWidth: 1)
    )
  }

  @ViewBuilder
  private var statusBannerSection: some View {
    switch vm.updateStage {
    case .failed:
      let msg = vm.updateErrorDetail ?? vm.updateStatusText
      bannerCard(
        icon: "exclamationmark.triangle.fill",
        iconColor: .red,
        bgColor: Color.red.opacity(0.08),
        borderColor: Color.red.opacity(0.22),
        text: msg
      )

    case .upToDate:
      bannerCard(
        icon: "checkmark.circle.fill",
        iconColor: .green,
        bgColor: Color.green.opacity(0.08),
        borderColor: Color.green.opacity(0.22),
        text: vm.updateStatusText.isEmpty ? "当前已是最新版本（v\(vm.version)）。" : vm.updateStatusText
      )

    case .cancelled:
      bannerCard(
        icon: "pause.circle.fill",
        iconColor: .orange,
        bgColor: Color.orange.opacity(0.08),
        borderColor: Color.orange.opacity(0.22),
        text: vm.updateStatusText
      )

    case .completedManualOpen:
      bannerCard(
        icon: "arrow.down.circle.fill",
        iconColor: .accentColor,
        bgColor: Color.accentColor.opacity(0.08),
        borderColor: Color.accentColor.opacity(0.22),
        text: vm.updateStatusText
      )

    default:
      EmptyView()
    }
  }

  private func bannerCard(
    icon: String,
    iconColor: Color,
    bgColor: Color,
    borderColor: Color,
    text: String
  ) -> some View {
    HStack(alignment: .top, spacing: 9) {
      Image(systemName: icon)
        .font(.system(size: 13.5))
        .foregroundColor(iconColor)
        .padding(.top, 1)
      Text(text)
        .font(.system(size: 12))
        .foregroundColor(.primary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    }
    .padding(11)
    .background(bgColor)
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(borderColor, lineWidth: 1)
    )
  }

  private func releaseNotesSection(_ info: UpdateReleaseInfo) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("更新内容")
          .font(.system(size: 12, weight: .semibold))
          .foregroundColor(.secondary)
        Spacer()
        if let pageStr = info.releasePageUrl, let pageUrl = URL(string: pageStr) {
          Link("Release 页面 ↗", destination: pageUrl)
            .font(.system(size: 11.5))
        }
      }

      ScrollView {
        ReleaseNotesMarkdownView(notes: info.notes)
          .padding(12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .frame(minHeight: 130, maxHeight: 230)
      .background(Color(nsColor: .textBackgroundColor))
      .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(Color.primary.opacity(0.08), lineWidth: 1)
      )
    }
  }

  private var actionBar: some View {
    HStack(spacing: 10) {
      if vm.availableUpdate != nil {
        Button {
          vm.openUpdateDirectDownload()
        } label: {
          Label("浏览器下载", systemImage: "arrow.up.right.square")
        }
      } else if vm.updateStage == .failed {
        Button {
          vm.openUpdateReleasePage()
        } label: {
          Label("打开 Release 页", systemImage: "arrow.up.right.square")
        }
      }

      Spacer()

      if isDownloadBusy {
        Button("取消下载") {
          vm.cancelUpdateDownload()
        }
      } else if isLockedBusy {
        Button("正在安装…") {}
          .disabled(true)
      } else if let info = vm.availableUpdate {
        Button("关闭") {
          vm.activeSheet = nil
        }
        Button(vm.updateStage == .failed || vm.updateStage == .cancelled ? "重新下载并更新" : "立即更新并重启") {
          vm.downloadAndOpenUpdate(info)
        }
        .buttonStyle(.borderedProminent)
      } else if vm.updateStage == .failed {
        Button("关闭") {
          vm.activeSheet = nil
        }
        Button("重试") {
          vm.checkForUpdates()
        }
        .buttonStyle(.borderedProminent)
      } else {
        Button(vm.updateStage == .upToDate || vm.updateStage == .completedManualOpen ? "完成" : "关闭") {
          vm.activeSheet = nil
        }
      }
    }
  }

  private func downloadRateAndEtaText() -> String {
    guard let speed = vm.updateSpeedBytesPerSec, speed.isFinite, speed > 0 else {
      return ""
    }
    var parts: [String] = []
    let rateStr = MeterFormat.byteRate(speed)
    if !rateStr.isEmpty {
      parts.append(rateStr)
    }
    let remaining = vm.updateTotalBytes - vm.updateDownloadedBytes
    if remaining > 0 {
      let etaStr = MeterFormat.eta(Double(remaining) / speed)
      if !etaStr.isEmpty {
        parts.append(etaStr)
      }
    }
    return parts.joined(separator: " · ")
  }
}

private struct ReleaseNotesMarkdownView: View {
  let notes: String

  private enum LineKind {
    case heading(String)
    case bullet(String)
    case changelogLink(URL)
    case paragraph(String)
  }

  private var parsedLines: [LineKind] {
    var items: [LineKind] = []
    for raw in notes.components(separatedBy: .newlines) {
      let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if line.isEmpty { continue }

      if line.hasPrefix("### ") {
        items.append(.heading(String(line.dropFirst(4)).trimmingCharacters(in: .whitespaces)))
      } else if line.hasPrefix("## ") {
        items.append(.heading(String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)))
      } else if line.hasPrefix("# ") {
        items.append(.heading(String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)))
      } else if line.hasPrefix("* ") || line.hasPrefix("- ") || line.hasPrefix("• ") {
        let body = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
        items.append(.bullet(body))
      } else if line.lowercased().hasPrefix("full changelog:") {
        let rawUrl = String(line.dropFirst("Full Changelog:".count)).trimmingCharacters(in: .whitespaces)
        if let url = URL(string: rawUrl) {
          items.append(.changelogLink(url))
        } else {
          items.append(.paragraph(line))
        }
      } else {
        items.append(.paragraph(line))
      }
    }
    return items
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(parsedLines.enumerated()), id: \.offset) { idx, entry in
        switch entry {
        case .heading(let title):
          Text(title)
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundColor(.primary)
            .padding(.top, idx == 0 ? 0 : 6)

        case .bullet(let text):
          HStack(alignment: .top, spacing: 6) {
            Text("•")
              .font(.system(size: 12, weight: .semibold))
              .foregroundColor(.secondary)
            inlineMarkdownText(text)
              .font(.system(size: 11.5))
              .foregroundColor(.primary)
              .fixedSize(horizontal: false, vertical: true)
          }

        case .changelogLink(let url):
          Link("查看完整变更记录 →", destination: url)
            .font(.system(size: 11.5))
            .padding(.top, 4)

        case .paragraph(let text):
          inlineMarkdownText(text)
            .font(.system(size: 11.5))
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func inlineMarkdownText(_ raw: String) -> Text {
    if let attr = try? AttributedString(
      markdown: raw,
      options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    ) {
      return Text(attr)
    }
    return Text(raw)
  }
}
