import AITurnMeterCore
import AppKit
import SwiftUI

struct FingerprintTabView: View {
  private static let tsFmtLock = NSLock()
  private static let tsFormatter: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "MM-dd HH:mm"
    return f
  }()

  @ObservedObject var vm: MeterViewModel

  @State private var showAddEndpointSheet: Bool = false
  @State private var epName: String = ""
  @State private var epProtocol: String = "openai"
  @State private var epBaseUrl: String = ""
  @State private var epModel: String = ""
  @State private var epApiKey: String = ""

  @State private var showManualProbeSheet: Bool = false
  @State private var manualClient: String = "antigravity"
  @State private var manualReplyDraft: String = ""
  @State private var showAnomaliesExpanded: Bool = false
  @State private var showAllRuns: Bool = false
  @State private var expandedRunId: String? = nil
  @State private var pendingDeleteEndpoint: FingerprintEndpointItem? = nil
  @State private var pendingDeleteBaseline: FingerprintBaselineItem? = nil

  private func verdictColor(_ verdict: String) -> Color {
    switch verdict {
    case "healthy", "pass", "baseline_recorded":
      return CodexBarPalette.paceGreen
    case "warning", "no_baseline":
      return .orange
    case "degraded", "suspected_swap", "error":
      return .red
    default:
      return .secondary
    }
  }

  private func verdictLabel(_ verdict: String) -> String {
    switch verdict {
    case "healthy", "pass": return "正常"
    case "warning": return "有波动"
    case "degraded": return "疑似降智"
    case "suspected_swap": return "疑似换模"
    case "baseline_recorded": return "已存基线"
    case "no_baseline": return "待建基线"
    case "insufficient_data": return "样本不足"
    case "unavailable": return "未登录"
    case "error": return "检测失败"
    default: return verdict
    }
  }

  private func modeLabel(_ mode: String) -> String {
    switch mode {
    case "one_click": return "一键体检"
    case "passive": return "日志诊断"
    case "codex_protocol": return "路由核验"
    case "quick": return "智商测试"
    case "deep": return "深度指纹"
    case "manual": return "出题验证"
    default: return mode
    }
  }

  private func formatTimestamp(_ ms: Double) -> String {
    guard ms.isFinite, ms > 0 else { return "" }
    let d = Date(timeIntervalSince1970: ms / 1000.0)
    Self.tsFmtLock.lock()
    defer { Self.tsFmtLock.unlock() }
    Self.tsFormatter.timeZone = TimeZone.current
    return Self.tsFormatter.string(from: d)
  }

  private var heroStatus: (icon: String, color: Color, title: String, subtitle: String) {
    guard let ov = vm.fingerprintOverview else {
      return ("checkmark.shield", .secondary, "准备就绪", "点击右侧「一键体检」，自动检查各客户端是否存在降智或换模")
    }
    let anomCount = ov.passive.anomalies.count
    let codexTip = ov.codex.configured ? "Codex 当前 \(ov.codex.model)" : "Codex 未登录"
    let baseSub = "近 \(ov.passive.days) 天共分析 \(ov.passive.totalTurnsScanned) 轮对话 · \(codexTip)"

    let nowMs = Date().timeIntervalSince1970 * 1000.0
    if let activeRun = ov.runs.first(where: { run in
      (run.targetType == "codex" || run.targetType == "client") || (nowMs - run.createdAtMs <= 86_400_000)
    }) {
      switch activeRun.verdict {
      case "suspected_swap":
        return ("xmark.shield.fill", .red, "检测到疑似换模（\(activeRun.targetName)）", activeRun.summary)
      case "degraded":
        return ("exclamationmark.shield.fill", .red, "检测到疑似降智（\(activeRun.targetName)）", activeRun.summary)
      case "error":
        return ("exclamationmark.triangle.fill", .orange, "最近体检失败（\(activeRun.targetName)）", activeRun.summary)
      default:
        break
      }
    }
    if anomCount == 0 {
      return ("checkmark.shield.fill", CodexBarPalette.paceGreen, "状态正常 · 未发现降智", baseSub)
    }
    let hasHigh = ov.passive.anomalies.contains { $0.severity == "high" }
    return (
      hasHigh ? "exclamationmark.shield.fill" : "exclamationmark.triangle.fill",
      hasHigh ? .red : .orange,
      "发现 \(anomCount) 条疑似波动",
      baseSub
    )
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        // 1. One-Click Hero Card + 4 Clients List
        SettingsGroupCard {
          VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
              Image(systemName: heroStatus.icon)
                .font(.system(size: 26, weight: .medium))
                .foregroundColor(heroStatus.color)
                .frame(width: 34)

              VStack(alignment: .leading, spacing: 3) {
                Text(heroStatus.title)
                  .font(.system(size: 15, weight: .semibold))
                Text(heroStatus.subtitle)
                  .font(.system(size: 11.5))
                  .foregroundColor(.secondary)
                  .lineLimit(2)
              }

              Spacer(minLength: 8)

              if let running = vm.fingerprintRunningAction {
                HStack(spacing: 6) {
                  ProgressView().controlSize(.small)
                  Text(running)
                    .font(.system(size: 11.5))
                    .foregroundColor(.secondary)
                }
              } else {
                Button {
                  vm.runFingerprintCheck(actionId: "一键体检中…", payload: ["mode": "one_click", "days": 7])
                } label: {
                  Label("一键体检", systemImage: "sparkles")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
              }
            }
            .padding(14)

            if let ov = vm.fingerprintOverview {
              Divider()

              ForEach(Array(["codex", "claude", "antigravity", "cursor", "codebuddy"].enumerated()), id: \.element) { idx, key in
                if idx > 0 { Divider().padding(.leading, 40) }
                let info = ov.passive.byTool[key]
                let modelText: String = {
                  if key == "codex" && ov.codex.configured { return ov.codex.model }
                  return info?.latestModel ?? "暂无对话"
                }()
                let status = info?.status ?? "insufficient_data"
                let anomCount = info?.anomalyCount ?? 0

                HStack(spacing: 10) {
                  ToolGlyph.iconView(for: key, size: 15)
                    .frame(width: 20)

                  VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                      Text(vm.toolShortTitle(for: key))
                        .font(.system(size: 12.5, weight: .medium))
                      Text(modelText)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    }
                    HStack(spacing: 6) {
                      Circle()
                        .fill(verdictColor(status))
                        .frame(width: 6, height: 6)
                      Text(anomCount > 0 ? "近 7 天发现 \(anomCount) 条波动" : verdictLabel(status))
                        .font(.system(size: 10.5))
                        .foregroundColor(anomCount > 0 ? verdictColor(status) : .secondary)
                      if let tc = info?.turnCount, tc > 0 {
                        Text("· \(tc) 轮")
                          .font(.system(size: 10.5))
                          .foregroundColor(.secondary)
                      }
                    }
                  }

                  Spacer()

                  if key == "codex" {
                    Button("测智商") {
                      vm.runFingerprintCheck(actionId: "Codex 智商测试…", payload: ["mode": "quick", "target": "codex"])
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(vm.fingerprintRunningAction != nil || !ov.codex.configured)

                    Menu {
                      Button("核验官方路由（极快）") {
                        vm.runFingerprintCheck(actionId: "Codex 路由核验…", payload: ["mode": "codex_protocol"])
                      }
                      Button("深度指纹比对（防量化）") {
                        vm.runFingerprintCheck(
                          actionId: "Codex 深度指纹…",
                          payload: ["mode": "deep", "target": "codex", "sampleCount": 50]
                        )
                      }
                      Divider()
                      Button("将当前 Codex 录为参考基线") {
                        vm.runFingerprintCheck(
                          actionId: "录制 Codex 基线…",
                          payload: ["mode": "deep", "target": "codex", "sampleCount": 50, "recordBaseline": true]
                        )
                      }
                    } label: {
                      Image(systemName: "ellipsis.circle")
                        .font(.system(size: 14))
                        .foregroundColor(.secondary)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .disabled(vm.fingerprintRunningAction != nil || !ov.codex.configured)
                  } else {
                    Button("出题验证") {
                      manualClient = key
                      manualReplyDraft = ""
                      showManualProbeSheet = true
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(vm.fingerprintRunningAction != nil)
                  }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
              }

              // Collapsible passive anomalies drawer
              if !ov.passive.anomalies.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                  Button {
                    showAnomaliesExpanded.toggle()
                  } label: {
                    HStack(spacing: 6) {
                      Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 11))
                        .foregroundColor(.orange)
                      Text("查看 \(ov.passive.anomalies.count) 条异常波动详情")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundColor(.primary)
                      Spacer()
                      Image(systemName: showAnomaliesExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10.5))
                        .foregroundColor(.secondary)
                    }
                    .contentShape(Rectangle())
                  }
                  .buttonStyle(.plain)

                  if showAnomaliesExpanded {
                    ForEach(ov.passive.anomalies.prefix(8)) { item in
                      HStack(alignment: .top, spacing: 8) {
                        Circle()
                          .fill(item.severity == "high" ? Color.red : Color.orange)
                          .frame(width: 6, height: 6)
                          .padding(.top, 5)
                        VStack(alignment: .leading, spacing: 2) {
                          HStack {
                            Text("\(item.toolLabel) · \(item.model)：\(item.title)")
                              .font(.system(size: 11.5, weight: .medium))
                            Spacer()
                            Text(formatTimestamp(item.completedAtMs))
                              .font(.system(size: 10, design: .monospaced))
                              .foregroundColor(.secondary)
                          }
                          Text(item.detail)
                            .font(.system(size: 10.5))
                            .foregroundColor(.secondary)
                        }
                      }
                      .padding(8)
                      .background(Color.primary.opacity(0.03))
                      .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                  }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
              }
            }
          }
        }

        // 2. Third-party Relay / Custom API Verification (Compact Card)
        SettingsGroupCard {
          VStack(alignment: .leading, spacing: 10) {
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text("中转站 / 自定义 API 真伪验证")
                  .font(.system(size: 13, weight: .semibold))
                Text("怀疑第三方 API 掺水、偷换模型或静默量化？添加后一键检测")
                  .font(.system(size: 11))
                  .foregroundColor(.secondary)
              }
              Spacer()
              Button {
                epName = ""
                epProtocol = "openai"
                epBaseUrl = ""
                epModel = ""
                epApiKey = ""
                showAddEndpointSheet = true
              } label: {
                Label("添加 API", systemImage: "plus")
              }
              .buttonStyle(.bordered)
              .controlSize(.small)
            }

            let endpoints = vm.fingerprintOverview?.endpoints ?? []
            if !endpoints.isEmpty {
              Divider()
              ForEach(Array(endpoints.enumerated()), id: \.element.id) { idx, ep in
                if idx > 0 { Divider() }
                HStack(spacing: 10) {
                  VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                      Text(ep.name)
                        .font(.system(size: 12.5, weight: .medium))
                      Text(ep.model)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundColor(.secondary)
                    }
                    Text("\(ep.protocolType.uppercased()) · \(ep.baseUrl)")
                      .font(.system(size: 10, design: .monospaced))
                      .foregroundColor(.secondary)
                      .lineLimit(1)
                      .truncationMode(.middle)
                  }
                  Spacer()
                  Button("一键测真伪") {
                    vm.runFingerprintCheck(
                      actionId: "正在检测 \(ep.name)…",
                      payload: ["mode": "quick", "target": ep.id]
                    )
                  }
                  .buttonStyle(.borderedProminent)
                  .controlSize(.small)
                  .disabled(vm.fingerprintRunningAction != nil)

                  Menu {
                    Button("深度指纹比对（防量化）") {
                      vm.runFingerprintCheck(
                        actionId: "深度指纹比对中…",
                        payload: ["mode": "deep", "target": ep.id, "sampleCount": 50]
                      )
                    }
                    Button("录制为官方标准基线") {
                      vm.runFingerprintCheck(
                        actionId: "正在录制基线…",
                        payload: [
                          "mode": "deep",
                          "target": ep.id,
                          "sampleCount": 50,
                          "recordBaseline": true,
                          "baselineName": "\(ep.name) (\(ep.model))",
                        ]
                      )
                    }
                    Divider()
                    Button("删除此端点", role: .destructive) {
                      pendingDeleteEndpoint = ep
                    }
                  } label: {
                    Image(systemName: "ellipsis.circle")
                      .font(.system(size: 14))
                      .foregroundColor(.secondary)
                  }
                  .menuStyle(.borderlessButton)
                  .fixedSize()
                  .disabled(vm.fingerprintRunningAction != nil)
                }
                .padding(.vertical, 2)
              }
            }

            let baselines = vm.fingerprintOverview?.baselines ?? []
            if !baselines.isEmpty {
              Divider()
              HStack {
                Text("已保存标准基线")
                  .font(.system(size: 11, weight: .medium))
                  .foregroundColor(.secondary)
                Spacer()
              }
              ForEach(baselines) { bl in
                HStack(spacing: 6) {
                  Image(systemName: "waveform.path.ecg")
                    .font(.system(size: 10.5))
                    .foregroundColor(CodexBarPalette.tealBar)
                  Text(bl.name)
                    .font(.system(size: 11.5))
                  Text("\(bl.sampleCount) 样本")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.secondary)
                  Spacer()
                  Button(role: .destructive) {
                    pendingDeleteBaseline = bl
                  } label: {
                    Image(systemName: "xmark.circle")
                      .font(.system(size: 11))
                  }
                  .buttonStyle(.borderless)
                }
              }
            }
          }
          .padding(14)
        }

        // 3. Recent History (Compact)
        let runs = vm.fingerprintOverview?.runs ?? []
        if !runs.isEmpty {
          SettingsGroupCard {
            VStack(alignment: .leading, spacing: 8) {
              HStack {
                Text("最近体检记录")
                  .font(.system(size: 13, weight: .semibold))
                Spacer()
                if runs.count > 5 {
                  Button(showAllRuns ? "收起" : "查看全部 (\(runs.count))") {
                    showAllRuns.toggle()
                  }
                  .buttonStyle(.plain)
                  .font(.system(size: 11))
                  .foregroundColor(CodexBarPalette.accentBlue)
                }
              }

              Divider()

              let visibleRuns = showAllRuns ? Array(runs.prefix(20)) : Array(runs.prefix(5))
              ForEach(Array(visibleRuns.enumerated()), id: \.element.id) { idx, run in
                if idx > 0 { Divider() }
                let isExpanded = expandedRunId == run.id
                VStack(alignment: .leading, spacing: 6) {
                  Button {
                    expandedRunId = isExpanded ? nil : run.id
                  } label: {
                    HStack(spacing: 8) {
                      Text(verdictLabel(run.verdict))
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(verdictColor(run.verdict))
                        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))

                      VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                          Text(run.targetName)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(.primary)
                          Text(modeLabel(run.mode))
                            .font(.system(size: 10))
                            .foregroundColor(.secondary)
                        }
                        Text(run.summary)
                          .font(.system(size: 11))
                          .foregroundColor(.secondary)
                          .lineLimit(isExpanded ? 4 : 1)
                      }
                      Spacer()
                      if let score = run.score {
                        Text("\(score) 分")
                          .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                          .foregroundColor(verdictColor(run.verdict))
                      }
                      Text(formatTimestamp(run.createdAtMs))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.secondary)
                      Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                    }
                    .contentShape(Rectangle())
                  }
                  .buttonStyle(.plain)

                  if isExpanded, let d = run.details {
                    VStack(alignment: .leading, spacing: 4) {
                      if let rm = run.responseModel, !rm.isEmpty {
                        Text("服务端实际返回模型：\(rm)\(d.avgLatencyMs.map { " · 平均耗时 \($0)ms" } ?? "")")
                          .font(.system(size: 10.5, design: .monospaced))
                          .foregroundColor(.secondary)
                      }
                      if let js = d.meanJsDistance {
                        Text(String(format: "指纹偏离度 (JS)：%.3f（<0.08 一致，>0.18 疑似换模）", js))
                          .font(.system(size: 10.5, design: .monospaced))
                          .foregroundColor(.secondary)
                      }
                      if let probes = d.probes, !probes.isEmpty {
                        ForEach(probes) { p in
                          HStack(spacing: 6) {
                            Image(systemName: p.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                              .font(.system(size: 10.5))
                              .foregroundColor(p.passed ? CodexBarPalette.paceGreen : .red)
                            Text(p.name)
                              .font(.system(size: 11, weight: .medium))
                            Text(p.reason ?? "")
                              .font(.system(size: 10.5))
                              .foregroundColor(.secondary)
                              .lineLimit(1)
                            Spacer()
                          }
                        }
                      }
                    }
                    .padding(8)
                    .background(Color.primary.opacity(0.03))
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                  }
                }
                .padding(.vertical, 2)
              }
            }
            .padding(14)
          }
        }
      }
      .padding(.bottom, 10)
    }
    .onAppear {
      vm.fetchFingerprintOverview(silent: vm.fingerprintOverview != nil)
    }
    // 2-step Friendly Manual Probe Sheet for Antigravity / Cursor / CodeBuddy
    .sheet(isPresented: $showManualProbeSheet) {
      VStack(alignment: .leading, spacing: 14) {
        HStack {
          ToolGlyph.iconView(for: manualClient, size: 18)
          Text("给 \(vm.toolShortTitle(for: manualClient)) 出题测智商")
            .font(.headline)
          Spacer()
        }

        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 10) {
            Text("1")
              .font(.system(size: 11, weight: .bold))
              .foregroundColor(.white)
              .frame(width: 20, height: 20)
              .background(CodexBarPalette.accentBlue)
              .clipShape(Circle())
            Text("复制 5 道标准智商题，粘贴发给 \(vm.toolShortTitle(for: manualClient))")
              .font(.system(size: 12.5))
            Spacer()
            Button {
              if let prompt = vm.fingerprintOverview?.manualProbe.prompt {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(prompt, forType: .string)
                vm.bannerIsError = false
                vm.statusBanner = "已复制测试题，请发给 \(vm.toolShortTitle(for: manualClient))"
              }
            } label: {
              Label("复制测试题", systemImage: "doc.on.doc")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
          }

          Divider()

          HStack(spacing: 10) {
            Text("2")
              .font(.system(size: 11, weight: .bold))
              .foregroundColor(.white)
              .frame(width: 20, height: 20)
              .background(CodexBarPalette.paceGreen)
              .clipShape(Circle())
            Text("等它回复完后点击「自动评分」（或手动粘贴回复）")
              .font(.system(size: 12.5))
            Spacer()
          }

          ZStack(alignment: .topLeading) {
            TextEditor(text: $manualReplyDraft)
              .font(.system(size: 11.5, design: .monospaced))
              .padding(4)
            if manualReplyDraft.isEmpty {
              Text("可选：直接粘贴模型回复的 JSON（留空则自动读取最新一轮）")
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundColor(Color(nsColor: .placeholderTextColor))
                .padding(.horizontal, 9)
                .padding(.vertical, 8)
                .allowsHitTesting(false)
            }
          }
          .frame(height: 84)
          .background(Color(nsColor: .textBackgroundColor))
          .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
              .stroke(Color.primary.opacity(0.14), lineWidth: 1)
          )
        }

        HStack {
          Spacer()
          Button("关闭") { showManualProbeSheet = false }
          Button("自动评分") {
            let reply = manualReplyDraft
            let client = manualClient
            showManualProbeSheet = false
            vm.runFingerprintCheck(
              actionId: "正在评分…",
              payload: ["mode": "manual_score", "tool": client, "replyText": reply]
            )
          }
          .buttonStyle(.borderedProminent)
          .disabled(vm.fingerprintRunningAction != nil)
        }
      }
      .padding(18)
      .frame(width: 470)
    }
    // Add Custom API Sheet
    .sheet(isPresented: $showAddEndpointSheet) {
      VStack(alignment: .leading, spacing: 12) {
        Text("添加自定义 API / 中转站")
          .font(.headline)
        Text("API Key 仅保存在本机 config.json 中，仅在你手动点击检测时调用。")
          .font(.system(size: 11.5))
          .foregroundColor(.secondary)

        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text("名称").font(.system(size: 12)).frame(width: 68, alignment: .leading)
            TextField("例如：中转站 Opus / 官方直连", text: $epName).textFieldStyle(.roundedBorder)
          }
          HStack {
            Text("接口类型").font(.system(size: 12)).frame(width: 68, alignment: .leading)
            Picker("", selection: $epProtocol) {
              Text("OpenAI 兼容").tag("openai")
              Text("Anthropic 兼容").tag("anthropic")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
          }
          HStack {
            Text("Base URL").font(.system(size: 12)).frame(width: 68, alignment: .leading)
            TextField("https://api.example.com/v1", text: $epBaseUrl)
              .textFieldStyle(.roundedBorder)
              .font(.system(size: 11.5, design: .monospaced))
          }
          HStack {
            Text("模型名").font(.system(size: 12)).frame(width: 68, alignment: .leading)
            TextField("claude-opus-4-6 / gpt-5.4", text: $epModel)
              .textFieldStyle(.roundedBorder)
              .font(.system(size: 11.5, design: .monospaced))
          }
          HStack {
            Text("API Key").font(.system(size: 12)).frame(width: 68, alignment: .leading)
            SecureField("sk-...", text: $epApiKey)
              .textFieldStyle(.roundedBorder)
              .font(.system(size: 11.5, design: .monospaced))
          }
        }

        HStack {
          Spacer()
          Button("取消") { showAddEndpointSheet = false }
          Button("保存") {
            let n = epName.trimmingCharacters(in: .whitespacesAndNewlines)
            let b = epBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            let m = epModel.trimmingCharacters(in: .whitespacesAndNewlines)
            let k = epApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !b.isEmpty, !m.isEmpty else { return }
            showAddEndpointSheet = false
            vm.saveFingerprintEndpoint(name: n.isEmpty ? m : n, protocolType: epProtocol, baseUrl: b, model: m, apiKey: k)
          }
          .buttonStyle(.borderedProminent)
          .disabled(epBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || epModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      .padding(18)
      .frame(width: 460)
    }
    .alert("确认删除检测端点？", isPresented: Binding(
      get: { pendingDeleteEndpoint != nil },
      set: { if !$0 { pendingDeleteEndpoint = nil } }
    )) {
      Button("取消", role: .cancel) { pendingDeleteEndpoint = nil }
      Button("删除", role: .destructive) {
        if let ep = pendingDeleteEndpoint {
          pendingDeleteEndpoint = nil
          vm.deleteFingerprintEndpoint(id: ep.id)
        }
      }
    } message: {
      Text("将移除自定义端点「\(pendingDeleteEndpoint?.name ?? "")」及其 API 配置。")
    }
    .alert("确认删除参考基线？", isPresented: Binding(
      get: { pendingDeleteBaseline != nil },
      set: { if !$0 { pendingDeleteBaseline = nil } }
    )) {
      Button("取消", role: .cancel) { pendingDeleteBaseline = nil }
      Button("删除", role: .destructive) {
        if let bl = pendingDeleteBaseline {
          pendingDeleteBaseline = nil
          vm.deleteFingerprintBaseline(id: bl.id)
        }
      }
    } message: {
      Text("将永久删除参考基线「\(pendingDeleteBaseline?.name ?? "")」（\(pendingDeleteBaseline?.sampleCount ?? 0) 样本）。")
    }
  }
}
