class AiTurnMeter < Formula
  desc "Unified local daemon and inline token/TPS meter for Antigravity, Codex, Cursor, and CodeBuddy CN"
  homepage "https://github.com/shadow-qw/AI-Turn-Meter"
  url "https://github.com/shadow-qw/AI-Turn-Meter/releases/download/v0.2.12/ai-turn-meter-0.2.12.tar.gz"
  sha256 "a4ea8a135d90fae28ef2a6353ae17bba47211fcac6173ba13b6ac8fec0fb0c23"

  depends_on :macos
  depends_on "node"

  def install
    libexec.install "package.json", "README.md", "packages", "scripts", "dist"

    (bin/"ai-turn-meter").write <<~SH
      #!/bin/bash
      export AI_TURN_METER_NODE_BIN="#{Formula["node"].opt_bin}/node"
      export AI_TURN_METER_STABLE_ROOT="#{opt_libexec}"
      export AI_TURN_METER_MANAGED_BY="homebrew"
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/packages/daemon/bin/cli.mjs" "$@"
    SH
    chmod 0755, bin/"ai-turn-meter"
  end

  def caveats
    <<~EOS
      Finish user-level setup once (registers LaunchAgent, Cursor hooks, and VSIX):
        ai-turn-meter install

      Verify installation and CDP status:
        ai-turn-meter doctor
        ai-turn-meter status

      Clean up LaunchAgent, VSIX, and Cursor hooks before uninstalling:
        ai-turn-meter uninstall
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/ai-turn-meter --version")
    assert_match "RemoteForward 47831", shell_output("#{bin}/ai-turn-meter ssh-info example.com")
  end
end
