import AITurnMeterCore
import AppKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Daily Thermal Receipt (Day Card) Views

private struct ReceiptBottomZigzagShape: Shape {
  var toothWidth: CGFloat = 8
  var toothHeight: CGFloat = 5

  func path(in rect: CGRect) -> Path {
    guard rect.width > 0, rect.height > 0 else { return Path() }
    if rect.height <= toothHeight {
      return Path(rect)
    }
    var path = Path()
    let count = max(4, Int(floor(rect.width / toothWidth)))
    let step = rect.width / CGFloat(count)
    // Flat crisp top edge, finely serrated bottom edge
    path.move(to: CGPoint(x: 0, y: 0))
    path.addLine(to: CGPoint(x: rect.width, y: 0))
    path.addLine(to: CGPoint(x: rect.width, y: rect.height - toothHeight))
    for i in stride(from: count, through: 0, by: -1) {
      let x = CGFloat(i) * step
      let y: CGFloat = (i % 2 == 0) ? rect.height : rect.height - toothHeight
      path.addLine(to: CGPoint(x: x, y: y))
    }
    path.closeSubpath()
    return path
  }
}

private struct ReceiptDashedDivider: View {
  let color: Color
  var body: some View {
    GeometryReader { geo in
      Path { p in
        p.move(to: CGPoint(x: 0, y: 0.5))
        p.addLine(to: CGPoint(x: geo.size.width, y: 0.5))
      }
      .stroke(color, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
    }
    .frame(height: 1)
  }
}

private struct ReceiptMistyBackdropView: View {
  let isDark: Bool

  var body: some View {
    GeometryReader { geo in
      let w = max(1, geo.size.width)
      let h = max(1, geo.size.height)
      ZStack {
        LinearGradient(
          colors: isDark
            ? [
                Color(red: 0.14, green: 0.17, blue: 0.19),
                Color(red: 0.09, green: 0.12, blue: 0.14),
                Color(red: 0.06, green: 0.09, blue: 0.10),
              ]
            : [
                Color(red: 0.80, green: 0.83, blue: 0.81),
                Color(red: 0.56, green: 0.63, blue: 0.60),
                Color(red: 0.28, green: 0.36, blue: 0.33),
                Color(red: 0.20, green: 0.28, blue: 0.26),
              ],
          startPoint: .top,
          endPoint: .bottom
        )

        // Distant misty mountain ridge
        Path { p in
          p.move(to: CGPoint(x: 0, y: h * 0.36))
          p.addLine(to: CGPoint(x: w * 0.18, y: h * 0.22))
          p.addLine(to: CGPoint(x: w * 0.42, y: h * 0.33))
          p.addLine(to: CGPoint(x: w * 0.72, y: h * 0.18))
          p.addLine(to: CGPoint(x: w, y: h * 0.30))
          p.addLine(to: CGPoint(x: w, y: h))
          p.addLine(to: CGPoint(x: 0, y: h))
          p.closeSubpath()
        }
        .fill(isDark ? Color(red: 0.07, green: 0.10, blue: 0.11).opacity(0.65) : Color(red: 0.19, green: 0.27, blue: 0.24).opacity(0.42))

        // Foreground pine bank & lake reflection
        Path { p in
          p.move(to: CGPoint(x: 0, y: h * 0.54))
          p.addQuadCurve(to: CGPoint(x: w, y: h * 0.56), control: CGPoint(x: w * 0.48, y: h * 0.48))
          p.addLine(to: CGPoint(x: w, y: h))
          p.addLine(to: CGPoint(x: 0, y: h))
          p.closeSubpath()
        }
        .fill(isDark ? Color(red: 0.05, green: 0.08, blue: 0.09).opacity(0.70) : Color(red: 0.14, green: 0.22, blue: 0.19).opacity(0.50))

        // Soft top mist haze
        RadialGradient(
          colors: [Color.white.opacity(isDark ? 0.06 : 0.26), Color.clear],
          center: .top,
          startRadius: 10,
          endRadius: max(20, max(w, h) * 0.65)
        )
      }
    }
  }
}

private struct ThermalReceiptCardView: View {
  let receipt: ReceiptDataResponse
  let theme: String
  let currencyMode: String
  let usdToCny: Double
  let hideProjects: Bool

  private var isDark: Bool { theme == "dark" }
  private var paperColor: Color {
    isDark ? Color(red: 0.10, green: 0.11, blue: 0.13) : Color(red: 0.965, green: 0.957, blue: 0.933)
  }
  private var inkColor: Color {
    isDark ? Color(red: 0.95, green: 0.96, blue: 0.97) : Color(red: 0.09, green: 0.09, blue: 0.09)
  }
  private var mutedColor: Color {
    isDark ? Color(red: 0.58, green: 0.61, blue: 0.66) : Color(red: 0.43, green: 0.42, blue: 0.40)
  }
  private var subtleColor: Color {
    isDark ? Color(red: 0.43, green: 0.46, blue: 0.51) : Color(red: 0.60, green: 0.58, blue: 0.55)
  }
  private var dashColor: Color {
    isDark ? Color.white.opacity(0.14) : Color.black.opacity(0.14)
  }

  private func fmtNumber(_ value: Double, digits: Int = 2) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.minimumFractionDigits = digits
    f.maximumFractionDigits = digits
    return f.string(from: NSNumber(value: abs(value))) ?? String(format: "%.\(digits)f", abs(value))
  }

  private func fmtInt(_ value: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    return f.string(from: NSNumber(value: value)) ?? "\(value)"
  }

  private func fmtSingleMoney(_ usd: Double?) -> String {
    guard let usd = usd, usd.isFinite else { return "N/A" }
    let rate = usdToCny > 0 ? usdToCny : 7.0
    let targetVal = currencyMode == "cny" ? usd * rate : usd
    let prefix = currencyMode == "cny" ? "¥" : "$"
    let sign = targetVal < 0 ? "-" : ""
    let digits = (abs(targetVal) > 0 && abs(targetVal) < 0.01) ? 4 : 2
    return "\(sign)\(prefix)\(fmtNumber(targetVal, digits: digits))"
  }

  private var heroPrimaryMoney: String {
    fmtSingleMoney(receipt.totals.estimatedCostUsd)
  }

  private var heroSecondaryCny: String? {
    guard currencyMode == "both", let usd = receipt.totals.estimatedCostUsd, usd.isFinite else { return nil }
    let rate = usdToCny > 0 ? usdToCny : 7.0
    let cny = usd * rate
    let digits = (abs(cny) > 0 && abs(cny) < 0.01) ? 4 : 2
    return "≈ ¥\(fmtNumber(cny, digits: digits)) · 汇率 1:\(String(format: "%.4g", rate))"
  }

  private var titleText: String {
    switch receipt.scope {
    case "week": return "7 日 AI 账单"
    case "month": return "30 日 AI 账单"
    default: return "每日 AI 账单"
    }
  }

  private func formatZhDate(_ dateStr: String) -> String {
    let parts = dateStr.split(separator: "-")
    if parts.count == 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) {
      return "\(y)年\(m)月\(d)日"
    }
    return dateStr
  }

  private var dateDisplayText: String {
    if receipt.scope == "day" {
      return formatZhDate(receipt.date)
    }
    return "\(formatZhDate(receipt.startDate)) - \(formatZhDate(receipt.date))"
  }

  private var issuedDisplayText: String {
    let d = Date(timeIntervalSince1970: receipt.generatedAtMs / 1000.0)
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "zh_CN")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy年M月d日 HH:mm"
    return f.string(from: d)
  }

  private func modelGlyphSymbol(_ model: String) -> String {
    let lower = model.lowercased()
    if lower.contains("claude") { return "sparkle" }
    if lower.contains("gemini") { return "diamond.fill" }
    if lower.contains("gpt") || lower.contains("codex") || lower.hasPrefix("o3") || lower.hasPrefix("o4") {
      return "hexagon.fill"
    }
    if lower.contains("grok") { return "bolt.fill" }
    if lower.contains("deepseek") { return "waveform" }
    return "circle.fill"
  }

  private var useAgentHierarchy: Bool {
    receipt.groupBy != "project" && !(receipt.agentBreakdown ?? []).isEmpty
  }

  var body: some View {
    VStack(spacing: 0) {
      // Section 1: Title & Dates
      VStack(spacing: 5) {
        Text(titleText)
          .font(.system(size: 20, weight: .bold))
          .tracking(2.0)
          .foregroundColor(inkColor)
        Text("由 AI Turn Meter 统计")
          .font(.system(size: 10.5))
          .foregroundColor(mutedColor)
      }
      .padding(.top, 26)
      .padding(.bottom, 16)

      VStack(spacing: 5) {
        kvRow("日期", dateDisplayText)
        kvRow("开具", issuedDisplayText)
      }
      .padding(.bottom, 14)

      ReceiptDashedDivider(color: dashColor)

      // Section 2: Hero API Total Cost
      VStack(spacing: 5) {
        Text("API 总费用")
          .font(.system(size: 11))
          .foregroundColor(mutedColor)
        Text(heroPrimaryMoney)
          .font(.system(size: 35, weight: .heavy, design: .monospaced))
          .tracking(-0.8)
          .foregroundColor(inkColor)
          .monospacedDigit()
          .minimumScaleFactor(0.75)
          .lineLimit(1)
        if let cnyLine = heroSecondaryCny {
          Text(cnyLine)
            .font(.system(size: 11, design: .monospaced))
            .foregroundColor(mutedColor)
        }
        Text("按 API 价格折算 · 非发票")
          .font(.system(size: 10))
          .foregroundColor(subtleColor)
          .padding(.top, 1)
      }
      .padding(.vertical, 16)

      ReceiptDashedDivider(color: dashColor)

      // Section 3: 4 Key Summary Stats
      VStack(spacing: 6) {
        kvRow("连续使用", "\(receipt.streakDays ?? 0) 天")
        kvRow("请求数", fmtInt(receipt.totals.callCount))
        kvRow("对话轮次", fmtInt(receipt.totals.turnCount))
        kvRow("对比日均", receipt.vsDailyAvgRatio.map { String(format: "%.1f×", $0) } ?? "--")
      }
      .padding(.vertical, 13)

      ReceiptDashedDivider(color: dashColor)

      // Section 4: 2-Level AGENT / MODEL Breakdown (or Project breakdown)
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Text(receipt.groupBy == "project" ? "项目" : "AGENT / 模型")
          Spacer()
          Text("费用")
        }
        .font(.system(size: 10.5))
        .foregroundColor(subtleColor)

        if useAgentHierarchy, let groups = receipt.agentBreakdown {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(groups) { ag in
              VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                  ToolGlyph.iconView(for: ag.tool, size: 13)
                    .foregroundColor(inkColor)
                    .frame(width: 15, alignment: .center)
                  Text(ag.label)
                    .font(.system(size: 12.5, weight: .bold, design: .monospaced))
                    .foregroundColor(inkColor)
                    .lineLimit(1)
                  Spacer(minLength: 6)
                  Text(ag.priced ? fmtSingleMoney(ag.estimatedCostUsd) : "未定价")
                    .font(.system(size: 12.5, weight: .bold, design: .monospaced))
                    .foregroundColor(inkColor)
                    .monospacedDigit()
                }

                ForEach(ag.models.prefix(8)) { m in
                  HStack(spacing: 6) {
                    Image(systemName: modelGlyphSymbol(m.model))
                      .font(.system(size: 6.5))
                      .foregroundColor(inkColor.opacity(0.72))
                      .frame(width: 12, alignment: .center)
                    Text(m.label)
                      .font(.system(size: 11, design: .monospaced))
                      .foregroundColor(inkColor.opacity(0.88))
                      .lineLimit(1)
                      .truncationMode(.middle)
                    Spacer(minLength: 6)
                    Text(m.priced ? fmtSingleMoney(m.estimatedCostUsd) : "未定价")
                      .font(.system(size: 11, design: .monospaced))
                      .foregroundColor(inkColor.opacity(0.88))
                      .monospacedDigit()
                  }
                  .padding(.leading, 15)
                }
              }
            }
          }
        } else if receipt.items.isEmpty {
          Text("当日暂无消费记录")
            .font(.system(size: 11.5))
            .foregroundColor(mutedColor)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 12)
        } else {
          VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(receipt.items.prefix(12).enumerated()), id: \.element.id) { idx, item in
              HStack(spacing: 6) {
                Image(systemName: "folder.fill")
                  .font(.system(size: 9))
                  .foregroundColor(inkColor.opacity(0.75))
                Text(hideProjects && receipt.groupBy == "project" ? "PROJECT #\(idx + 1)" : item.label.uppercased())
                  .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                  .foregroundColor(inkColor)
                  .lineLimit(1)
                  .truncationMode(.middle)
                Spacer(minLength: 6)
                Text(item.priced ? fmtSingleMoney(item.estimatedCostUsd) : "未定价")
                  .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                  .foregroundColor(inkColor)
                  .monospacedDigit()
              }
            }
          }
        }
      }
      .padding(.vertical, 13)

      ReceiptDashedDivider(color: dashColor)

      // Section 5: Bottom Token Summary
      VStack(alignment: .leading, spacing: 6) {
        kvRow("TOKEN 总量", MeterFormat.tokens(receipt.totals.totalTokens))
        kvRow("输入", MeterFormat.tokens(receipt.totals.totalInputTokens))
        kvRow("输出", MeterFormat.tokens(receipt.totals.outputTokens))
        kvRow(
          "缓存命中率",
          receipt.totals.cacheRatePct.map { "\(Int($0.rounded()))%" } ?? "--"
        )
        if let saved = receipt.totals.cacheSavingsUsd, saved > 0 {
          kvRow("缓存节省", fmtSingleMoney(saved))
        }
        if receipt.totals.unpricedTurnCount > 0 {
          Text("\(receipt.totals.unpricedTurnCount) 次请求没有价格")
            .font(.system(size: 10))
            .foregroundColor(subtleColor)
            .padding(.top, 2)
        }
      }
      .padding(.vertical, 13)

      ReceiptDashedDivider(color: dashColor)

      // Section 6: Clean Centered Footer
      VStack(spacing: 3) {
        Text("AI Turn Meter · \(receipt.receiptNo)")
          .font(.system(size: 10, design: .monospaced))
          .foregroundColor(subtleColor)
        Text("在 macOS 上统计每个 Agent 的 AI 用量")
          .font(.system(size: 10))
          .foregroundColor(subtleColor)
      }
      .padding(.top, 14)
      .padding(.bottom, 22)
    }
    .padding(.horizontal, 26)
    .frame(width: 358)
    .background(paperColor)
    .clipShape(ReceiptBottomZigzagShape(toothWidth: 8, toothHeight: 5))
    .shadow(color: Color.black.opacity(isDark ? 0.50 : 0.28), radius: 14, x: 0, y: 8)
  }

  private func kvRow(_ label: String, _ value: String) -> some View {
    HStack {
      Text(label)
        .font(.system(size: 11.5))
        .foregroundColor(mutedColor)
      Spacer(minLength: 8)
      Text(value)
        .font(.system(size: 11.5, design: .monospaced))
        .foregroundColor(inkColor)
        .monospacedDigit()
    }
  }
}

struct DailyReceiptSectionView: View {
  @ObservedObject var vm: MeterViewModel
  @State private var rateText: String = ""

  private func renderReceiptPngData(_ receipt: ReceiptDataResponse) -> (image: NSImage, png: Data)? {
    let exportView = ThermalReceiptCardView(
      receipt: receipt,
      theme: vm.receiptTheme,
      currencyMode: vm.receiptCurrencyMode,
      usdToCny: vm.receiptUsdToCny,
      hideProjects: vm.receiptHideProjects
    )
    .padding(.horizontal, 52)
    .padding(.vertical, 42)
    .background {
      ReceiptMistyBackdropView(isDark: vm.receiptTheme == "dark")
    }
    .environment(\.colorScheme, vm.receiptTheme == "dark" ? .dark : .light)

    let renderer = ImageRenderer(content: exportView)
    renderer.scale = 2.0
    if let cgImg = renderer.cgImage {
      let rep = NSBitmapImageRep(cgImage: cgImg)
      if let png = rep.representation(using: .png, properties: [:]) {
        let img = NSImage(cgImage: cgImg, size: NSSize(width: CGFloat(cgImg.width) / 2.0, height: CGFloat(cgImg.height) / 2.0))
        return (img, png)
      }
    }
    if let img = renderer.nsImage,
       let tiff = img.tiffRepresentation,
       let rep = NSBitmapImageRep(data: tiff),
       let png = rep.representation(using: .png, properties: [:]) {
      return (img, png)
    }
    return nil
  }

  private func copyReceiptPng(_ receipt: ReceiptDataResponse) {
    guard let rendered = renderReceiptPngData(receipt) else {
      vm.bannerIsError = true
      vm.statusBanner = "渲染小票图片失败"
      return
    }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.writeObjects([rendered.image])
    pb.setData(rendered.png, forType: .png)
    vm.bannerIsError = false
    vm.statusBanner = "已复制高清小票图片到剪贴板"
  }

  private func saveReceiptPng(_ receipt: ReceiptDataResponse) {
    guard let rendered = renderReceiptPngData(receipt) else {
      vm.bannerIsError = true
      vm.statusBanner = "渲染小票图片失败"
      return
    }
    let panel = NSSavePanel()
    panel.allowedContentTypes = [.png]
    panel.nameFieldStringValue = "ai-turn-meter-receipt-\(receipt.date).png"
    if panel.runModal() == .OK, let url = panel.url {
      try? rendered.png.write(to: url, options: .atomic)
      vm.bannerIsError = false
      vm.statusBanner = "已保存高清小票：\(url.lastPathComponent)"
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      // Compact Controls Row 1: Date + Scope + View Mode
      HStack(spacing: 8) {
        HStack(spacing: 4) {
          Button {
            vm.shiftReceiptDate(byDays: -1)
          } label: {
            Image(systemName: "chevron.left")
              .font(.system(size: 11, weight: .semibold))
          }
          .buttonStyle(.bordered)
          .controlSize(.mini)
          .help("前一天")

          Text(vm.receiptDate)
            .font(.system(size: 12, weight: .semibold, design: .monospaced))
            .monospacedDigit()
            .padding(.horizontal, 5)

          Button {
            vm.shiftReceiptDate(byDays: 1)
          } label: {
            Image(systemName: "chevron.right")
              .font(.system(size: 11, weight: .semibold))
          }
          .buttonStyle(.bordered)
          .controlSize(.mini)
          .help("后一天")

          Button("今日") {
            vm.selectReceiptToday()
          }
          .buttonStyle(.bordered)
          .controlSize(.mini)
        }

        Picker("", selection: Binding(
          get: { vm.receiptScope },
          set: { vm.receiptScope = $0; vm.fetchReceipt() }
        )) {
          Text("单日").tag("day")
          Text("7天").tag("week")
          Text("30天").tag("month")
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.mini)
        .frame(width: 132)

        Spacer()

        Picker("", selection: Binding(
          get: { vm.receiptGroupBy == "project" ? "project" : "model" },
          set: { vm.receiptGroupBy = $0; vm.fetchReceipt() }
        )) {
          Text("Agent/模型").tag("model")
          Text("按项目").tag("project")
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.mini)
        .frame(width: 148)
      }

      // Compact Controls Row 2: Currency + FX Rate + Theme + Privacy
      HStack(spacing: 10) {
        Picker("", selection: Binding(
          get: { vm.receiptCurrencyMode },
          set: { vm.setReceiptCurrencyMode($0) }
        )) {
          Text("USD+¥").tag("both")
          Text("USD").tag("usd")
          Text("CNY ¥").tag("cny")
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.mini)
        .frame(width: 162)

        if vm.receiptCurrencyMode != "usd" {
          HStack(spacing: 4) {
            Text("1:$ = ¥")
              .font(.system(size: 10.5))
              .foregroundColor(.secondary)
            TextField("7", text: $rateText)
              .textFieldStyle(.roundedBorder)
              .font(.system(size: 11, design: .monospaced))
              .frame(width: 46)
              .onSubmit {
                if let v = Double(rateText.trimmingCharacters(in: .whitespaces)), v > 0 {
                  vm.setReceiptUsdToCny(v)
                }
              }
              .onChange(of: rateText) { newVal in
                if let v = Double(newVal.trimmingCharacters(in: .whitespaces)), v > 0 {
                  vm.setReceiptUsdToCny(v)
                }
              }
          }
        }

        Picker("", selection: Binding(
          get: { vm.receiptTheme },
          set: { vm.setReceiptTheme($0) }
        )) {
          Text("热敏纸").tag("paper")
          Text("暗夜").tag("dark")
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.mini)
        .frame(width: 106)

        if vm.receiptGroupBy == "project" {
          Toggle("隐藏项目名", isOn: Binding(
            get: { vm.receiptHideProjects },
            set: { vm.setReceiptHideProjects($0) }
          ))
          .toggleStyle(.checkbox)
          .font(.system(size: 11))
        }

        Spacer()
      }

      // Main Receipt Preview with Misty Forest Frame
      if vm.receiptLoading && vm.receiptData == nil {
        HStack {
          Spacer()
          ProgressView().controlSize(.small)
          Text("正在生成今日账单…")
            .font(.system(size: 12))
            .foregroundColor(.secondary)
          Spacer()
        }
        .padding(.vertical, 28)
      } else if let receipt = vm.receiptData {
        VStack(spacing: 12) {
          ThermalReceiptCardView(
            receipt: receipt,
            theme: vm.receiptTheme,
            currencyMode: vm.receiptCurrencyMode,
            usdToCny: vm.receiptUsdToCny,
            hideProjects: vm.receiptHideProjects
          )
          .padding(.horizontal, 28)
          .padding(.vertical, 26)
          .frame(maxWidth: .infinity)
          .background {
            ReceiptMistyBackdropView(isDark: vm.receiptTheme == "dark")
          }
          .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

          HStack(spacing: 8) {
            Button {
              copyReceiptPng(receipt)
            } label: {
              Label("复制图片", systemImage: "doc.on.doc")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)

            Button {
              saveReceiptPng(receipt)
            } label: {
              Label("保存 PNG", systemImage: "photo")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            Button {
              vm.exportReceiptSvg()
            } label: {
              Label("保存 SVG", systemImage: "square.and.arrow.down")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            Button {
              vm.copyReceiptAsciiToClipboard()
            } label: {
              Label("复制文本", systemImage: "text.alignleft")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            Spacer()
          }

          if !receipt.availableDates.isEmpty {
            Divider()
              .padding(.top, 2)
            HStack {
              Text("历史每日账单（点击切换）")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(.secondary)
              Spacer()
              Text("近 \(receipt.availableDates.count) 天")
                .font(.system(size: 10.5))
                .foregroundColor(.secondary)
            }

            VStack(spacing: 2) {
              ForEach(Array(receipt.availableDates.prefix(15).enumerated()), id: \.element.id) { idx, day in
                let selected = day.date == vm.receiptDate
                Button {
                  vm.receiptDate = day.date
                  vm.receiptScope = "day"
                  vm.fetchReceipt()
                } label: {
                  HStack {
                    Text(day.date)
                      .font(.system(size: 11.5, weight: selected ? .semibold : .medium, design: .monospaced))
                      .foregroundColor(selected ? CodexBarPalette.accentBlue : .primary)
                    Text("\(day.turnCount) 轮")
                      .font(.system(size: 11))
                      .foregroundColor(.secondary)
                    Spacer()
                    Text("入 \(MeterFormat.tokens(day.totalInputTokens)) · 出 \(MeterFormat.tokens(day.outputTokens))")
                      .font(.system(size: 10.5))
                      .monospacedDigit()
                      .foregroundColor(.secondary)
                    Text(vm.formatReceiptMoney(day.estimatedCostUsd))
                      .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                      .foregroundColor(.primary)
                      .frame(minWidth: 110, alignment: .trailing)
                  }
                  .padding(.horizontal, 8)
                  .padding(.vertical, 5)
                  .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                      .fill(selected ? CodexBarPalette.accentBlue.opacity(0.10) : (idx % 2 == 1 ? Color.primary.opacity(0.02) : Color.clear))
                  )
                }
                .buttonStyle(.plain)
              }
            }
          }
        }
      } else {
        VStack(spacing: 10) {
          Text(vm.receiptError ?? "暂无账单数据，请点击重新加载")
            .font(.system(size: 12))
            .foregroundColor(.secondary)
            .multilineTextAlignment(.center)
          HStack(spacing: 8) {
            Button("重新加载") {
              vm.fetchReceipt()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)

            if (vm.receiptError?.contains("版本过旧") ?? false) || !vm.daemonOnline {
              Button("同步并重启后台") {
                vm.runAction(args: ["install"], successText: "已同步并重启后台服务") {
                  vm.fetchUsageSummary(silent: true)
                  vm.fetchReceipt()
                }
              }
              .buttonStyle(.bordered)
              .controlSize(.small)
              .disabled(vm.busy || vm.runtime.runningFromDmg)
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, 24)
      }
    }
    .onAppear {
      rateText = String(format: "%.4g", vm.receiptUsdToCny)
      vm.fetchReceipt(silent: vm.receiptData != nil)
    }
  }
}
