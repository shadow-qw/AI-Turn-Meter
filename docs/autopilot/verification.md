# Autopilot 验证状态

> **并发基线变更：不可直接推送/合并本轮实现。** 开工时main为`529f519`；本地实现期间再次fetch发现main已推进至`759f3ea525b64281060b14ed43c6f35ae15705c8`（v0.2.26），迁移至SwiftPM、删除旧`main.swift`，另增CI/Release workflow。本轮仅在原专用分支保留旧基线实现供审阅，没有merge/rebase/覆盖新main。必须将策略及测试移入新`AITurnMeterCore/UpdateChecker.swift`，保留新增SHA256校验，并与新CI整合后重新验收；以下结果不代表新main或PR测试合并SHA已通过。

## 批次 A：基线 CI

- Task0基线修复已独立审阅：真实时钟，空HOME＋独立XDG及XDG未设均42/42通过，无跳过。修复仅测试fixture，不改变产品凭据/过期逻辑。
- `baseline/node`检查PR的GitHub合并测试SHA（`github.sha`），不是仅head分支；checkout后断言实际HEAD准确匹配事件SHA。push事件仅main。
- permissions仅contents:read；PR无secrets；checkout `persist-credentials:false`；测试子进程以`env -i`和空HOME/XDG运行，无账号、缓存、安装/发布步骤。
- Node固定major24，不依赖runner默认版本。actions SHA由官方Git仓库tag核验（2026-11-19 Asia/Shanghai）：checkout v4.3.1=`34e114876b0b11c390a56381ad16ebd13914f8d5`，setup-node v4.4.0=`49933ea5288caeca8642d1e84afbd3f7d6820020`。
- CI定义的静态契约测试不是GitHub实际run证明；尚未推送本轮实现，无run URL。本检查不是后续autopilot可信SHA合并gate，也未配置required checks或自动合并。

## 批次 A：稳定更新拒绝 RC

- 纯Foundation `UpdatePolicy`：严格三段稳定版本（保留可选v/V、外层空白兼容），数值排序；后缀/前导零/溢出/错误类型拒绝。当前版本为RC时不自动选稳定通道。
- 默认GitHub latest HEAD和自定义JSON两路共用策略；HEAD仅接受同仓库稳定tag；JSON拒绝draft/prerelease=true及非布尔畸形flag、矛盾tag/version、非法或非HTTPS下载地址。保留无flag的历史自定义稳定feed、dmgUrl、generic HTTPS url及签名query；GitHub assets优先于REST元数据url。
- 真实旧Swift更新决策代码（22bd5e9）在Linux提取执行：RC JSON、prerelease=true、draft=true、unsafe URL、RC HEAD redirect共5项拒绝断言失败；不是用JS重写模拟。修复后直接编译同一生产Swift策略，88条断言通过（Swift6.2.1、Debian13）。这只证明纯策略，不证明AppKit/SwiftUI/macOS构建。
- JS契约测试3项从0/3到3/3；加上CI契约3项，隔离HOME＋独立XDG与XDG未设两种环境，真实时钟`npm test`均48/48、0 fail/skip。Swift策略的实际运行不包含在npm静态契约测试里，须另跑`sh scripts/test-update-policy.sh`。
- `baseline/macos-policy`使用真实标准`macos-15`标签，记录uname/ImageVersion/Xcode/Swift，执行纯策略和arm64/macOS13目标完整旧App源码typecheck；动作固定SHA、空HOME、无账号。尚未推送，**没有真实macOS run/typecheck/DMG通过证据**；此job也需随新SwiftPM布局调整。
- 只在临时staging将扩展版本改为`0.2.26-rc.1`：现有打包脚本生成VSIX；官方VS Code1.147.0 Linux x64（8a14f0cc1b08d531eb83255ea3764ae22aa932b5）CLI安装成功，真实Extension Host发现同一版本、activate成功、isActive=true且注册refresh命令。临时空HOME/profile、禁遥测/自动更新、daemonUrl指向127.0.0.1:9，未连接真实daemon/账号；源码manifest未改。仅证明该VS Code版本兼容，不证明Marketplace、Cursor、旧VS Code或新main扩展兼容；没有臆测版本映射。
- 只读检查默认latest：2026-11-19（Asia/Shanghai）实际HTTP200重定向至v0.2.26。官方GitHub latest定义排除draft/prerelease：https://docs.github.com/en/rest/releases/releases#get-the-latest-release 。没有创建测试RC；实际旧客户端对真实发布RC的隔离尚无演练证据。旧自定义JSON客户端已由上述真实旧代码证明会误选RC，无法被本补丁追溯修复；必须取得服务端稳定feed过滤证据，或用户明确接受受限支持范围，才能满足后续channelProof。
- 本轮未推正式Homebrew、未改第三方app/签名、未执行项目安装/卸载脚本或verify:local（仅上述临时profile的VSIX安装测试）、未改正式数据库/外部配置。更新策略只校验声明元数据/URL，不是二进制来源或签名证明。

## 不可越过的发布门

Task10与常态自动化仍不可启用：新main整合与独立review、真实Mac编译/DMG/包冒烟、旧feed支持面和当前main VSIX验证均待完成。新main另有独立`v*` tag发布workflow，未显式设置`prerelease`/`make_latest`，不能把它当已验收的RC发布管道；任何RC tag写入前必须先审查并补足该边界。本轮没有触发、停用或修改远程发布workflow，不能声称远程全仓库发布已关闭。
