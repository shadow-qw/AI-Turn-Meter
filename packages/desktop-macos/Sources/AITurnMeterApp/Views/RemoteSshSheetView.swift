import AppKit
import SwiftUI

struct RemoteSshSheetView: View {
  @ObservedObject var vm: MeterViewModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Cursor Remote-SSH 上报配置")
        .font(.headline)
      Text("支持一键写入本机 ~/.ssh/config 的 RemoteForward 转发，并自动或通过单行命令配置远端 ~/.cursor/hooks.json。")
        .font(.system(size: 12))
        .foregroundColor(.secondary)

      if !vm.knownSshHosts.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            Text("本机 Host:")
              .font(.system(size: 11))
              .foregroundColor(.secondary)
            ForEach(vm.knownSshHosts, id: \.self) { h in
              Button(h) {
                vm.sshHost = h
                vm.sshApplyStatus = nil
                vm.generateSshSnippet()
              }
              .controlSize(.mini)
            }
          }
        }
      }

      HStack {
        TextField("远端 Host（如 dev-server.example.com）", text: $vm.sshHost)
          .textFieldStyle(.roundedBorder)
        Button("生成预览") { vm.generateSshSnippet() }
      }

      if let status = vm.sshApplyStatus {
        HStack(spacing: 6) {
          Image(systemName: vm.sshApplyIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
            .foregroundColor(vm.sshApplyIsError ? .red : .green)
          Text(status)
            .font(.system(size: 11.5))
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((vm.sshApplyIsError ? Color.red : Color.green).opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 7))
      }

      ScrollView {
        Text(vm.sshPreview)
          .font(.system(size: 11, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(10)
      }
      .frame(height: 195)
      .background(Color(nsColor: .textBackgroundColor))
      .clipShape(RoundedRectangle(cornerRadius: 8))

      HStack(spacing: 8) {
        Button("一键写入本机 ~/.ssh/config") {
          vm.applySshConfig(includeRemote: false)
        }
        .disabled(vm.sshApplying || vm.sshHost.trimmingCharacters(in: .whitespaces).isEmpty)

        Button("一键写入本机+远端") {
          vm.applySshConfig(includeRemote: true)
        }
        .disabled(vm.sshApplying || vm.sshHost.trimmingCharacters(in: .whitespaces).isEmpty)

        if vm.sshApplying {
          ProgressView().controlSize(.small)
        }

        Spacer()

        if !vm.sshOneLiner.isEmpty {
          Button("复制单行命令") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(vm.sshOneLiner, forType: .string)
            vm.sshApplyIsError = false
            vm.sshApplyStatus = "已复制远端 hooks.json 一键安装命令"
          }
        }
        Button("完成") { vm.showSshSheet = false }
          .buttonStyle(.borderedProminent)
      }
      .controlSize(.small)
    }
    .padding(18)
    .frame(width: 600, height: 470)
  }
}
