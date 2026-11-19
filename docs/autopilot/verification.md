# Autopilot 批次 A 验证状态

## 当前集成基线

- main `759f3ea525b64281060b14ed43c6f35ae15705c8`（v0.2.26），正常merge提交`95015896ae822a2b5db453d559b16dfc2ca042f6`；未rebase/重写已推送历史。
- 保留新SwiftPM布局；旧`packages/desktop-macos/main.swift`没有复活。策略位于`Sources/AITurnMeterCore/UpdatePolicy.swift`，行为测试进入既有SwiftPM test target。
- `UpdateReleaseInfo`及SHA256文件/数据计算、下载校验函数保持；新认证/SSE、daemon/扩展代码、DMG SwiftPM构建流程均保留，没有用旧App覆盖新产品功能。

## 稳定更新

- GitHub API主路与custom JSON均通过`UpdateChecker.parseReleaseJson`调用严格策略；HEAD fallback通过同仓库稳定tag策略，入口/下载使用无凭据HTTPS URL。
- 严格三段稳定版本、数值排序；拒RC/后缀/畸形/溢出/前导零；JSON draft/prerelease只能缺省或严格bool false；当前RC不自动进稳定通道。
- 保留历史无flag稳定feed、dmgUrl、generic HTTPS url、签名query；GitHub assets优先于REST元数据url，arm64优先，并保留对应SHA256 URL/值与原下载校验。
- 原公开`compareSemver`的短版本兼容API保留，但更新路径不再用它作门控。

## CI 与发布定义

- CI仍在macos-15/Node24执行原有version parity、`npm run test:all`、SwiftPM release build、VSIX打包；增加策略独立测试、精确github.sha checkout/HEAD断言、空HOME/XDG、read-only token、persist-credentials:false与全action SHA固定。不是未来autopilot可信合并gate。
- 发布按三job拆分：trusted main只读分类、准确source SHA只读构建、无候选checkout/脚本的写权限publish。固定官方action SHA；不把发布write token交给测试/build。
- `v*` push中的RC必须明确`prerelease=true`、`make_latest=false`；stable tag push拒绝，稳定版必须main上的手动workflow_dispatch并输入完全相同的confirm_stable_tag。
- RC另要求受控仓库变量`RC_CHANNEL_PROOF_SHA`与准确tag source SHA一致，否则分类立即失败、不能build/publish。本轮不创建/设置变量。必须先完成旧feed风险验收及人工证据审阅才能批准该值；它只是临时人工fail-closed gate，不是完整自动可信证据链。
- 本轮只改定义，没有push/tag/触发run/发布/改远程规则。当前定义仍非Task10精确M重构建、不可变tag/竞态/幂等发布控制器，不得据此启用无人值守发布。

## 实际证据与范围

- 新main原始JSON解析代码在Linux按原始函数提取执行，RC/prerelease=true/draft=true共3项错误offer得到真实red；不是沿用旧48测试结论。
- 当前合并树的Node全套：隔离HOME＋独立XDG、XDG未设均60/60、0 fail/skip；包含上游新增安全测试、Task0 fixture、CI/更新/发布契约。
- 生产纯Swift策略Linux实际编译执行：88断言通过；新SwiftPM测试文件另在显式纯parser诊断package执行3个Swift Testing用例（同一Models/Policy与删去CryptoKit hash方法的实际UpdateChecker片段），含arm64/SHA256 metadata保留。该诊断不是整个生产SwiftPM/Mac验收。
- 真正执行`npm run test:all`失败：此Linux无项目脚本硬编码的`/usr/bin/swift`。用现有官方Linux Swift直接执行生产SwiftPM test也实际失败：无CryptoKit。没有跳过测试、替换CryptoKit或伪造Mac成功；完整Mac suite/build/DMG仍待真实runner运行。
- 新main扩展（含认证/SSE变更）重新在临时staging打`0.2.26-rc.1`，官方VS Code1.147.0 Linux x64真实Extension Host发现同版本、activate/isActive与命令注册通过。空HOME/profile/stateDir、daemonUrl=127.0.0.1:9，未访问真实daemon或凭据。此fixture不是下一版本/tag；不代表Marketplace/Cursor/旧VS Code兼容。
- 旧JSON客户端依然可能误选RC；无法追溯修复。发布前必须取得稳定feed过滤证据，或用户明确认可受限支持范围。默认GitHub latest只读实测HTTP200→v0.2.26；未创建真实RC演练。
- Linux box不是候选沙箱。最新preflight为SANDBOX_UNAVAILABLE，后续Task5保持fail-closed；本批未安装/启用沙箱或执行不可信Issue候选。

本地详细报告与准确最终SHA：`/workspace/atm-phase-a-report.md`。未启用routine、Issue接入、自动合并或无人值守发布；B–F未实施。
