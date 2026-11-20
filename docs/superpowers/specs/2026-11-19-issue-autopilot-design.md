# GitHub Issue Autopilot 设计（待书面审阅）

日期：2026-11-19（Asia/Shanghai）
状态：整体方向已认可；本文仍需用户审阅。未进入实施计划，未启用任何自动任务。
适用仓库：`shadow-qw/AI-Turn-Meter`
核对基线：`529f51933ee3ba9d75ceaa9434ef39553945a607`（根版本 `0.2.25`）。

## 1. 目标、授权和非目标

接收**任何人**在本仓库提交的 GitHub Issue，由 Grok Bot 根据内容分诊；低风险、目标明确、可验证且项目范围内的需求进入串行闭环：调查 → 隔离分支修改 → 测试 → PR → 独立审查 → macOS 构建/包冒烟 → 自动合并 → 对准确合并提交重新构建 → GitHub RC 预发布。**不要求作者为 shadow-qw，不要求预先指派或加标签。**

AI 分诊与编码使用 Grok Bot 的运行额度和自有 Linux box；不调用 Cursor CloudAgent、Cursor 编码服务或另外收费的 AI API。GitHub Actions 仅转发事件和执行确定性验证/构建；其 Actions 分钟、macOS runner 以及存储可能另计资源费用，不能称为全流程免费。

本次仅提交设计文档。未来运行所需的持久授权、写入身份、检查契约、限额和外部接线需经审阅并实际配置，本文不代表它们已经存在。首次建设 CI、可信门控和发布基础设施是人工审阅的引导工程；后续自动接收的 Issue 无权修改这些基础设施。

非目标：正式稳定发布、更新真实用户机器、同步正式 Homebrew Tap、接入尚未命名的外部输入、无人审阅修改权限/安全/凭据策略、并行处理多个变更、无限自修复、自动删除用户数据。不自动在 Issue/PR 评论区发言；结果发给用户的 Grok Bot 当前维护会话。PR 标题和说明只采用审查过的工作摘要，不复制外部指令。

## 2. 当前事实和设计依据

- `package.json`：Node `>=22.5.0`，`npm test` 执行 `node --test tests/*.test.mjs`；有 `verify:local`、`package:vsix`、`release:tarball`、`release:dmg`。当前 checkout 无 `.github` 与已有 CI。
- README：各工具数据按 `tool` 隔离；不得强杀第三方应用，不得改第三方 `.app` 签名；`verify:local` 读取本机历史日志并用内存库，不写正式数据库或外部配置。这些约束必须保留并纳入回归检查。
- `scripts/build-dmg.mjs` 使用 Swift/macOS 框架、`codesign`、`iconutil`、`hdiutil`，目标 `arm64-apple-macosx13.0`，需要独立 arm64 Node >=22.5。脚本对本项目新包 ad-hoc 签名；这不等同于修改第三方签名，也不是 Developer ID 公证。
- `scripts/build-release.mjs` 生成 tarball，并改写工作目录中的 `packaging/homebrew/ai-turn-meter.rb` URL/SHA256；不会自行上传 Release。RC 构建中只允许发生在临时 staging，不回写 main 或正式 Tap。
- `package.json.updateFeedUrl` 默认指向 GitHub `/releases/latest`。Swift `checkForUpdates()` 对该地址用 HEAD 跟随重定向；对自定义 JSON 更新源未见 `prerelease` 过滤。因此目前不能声称所有稳定安装方式都能拒绝 RC。
- 此次 box 上 `gh auth status` 显示未登录；Git 未配置提交身份。公共 clone 可行，不代表具有推送/发布能力。设计文档本地交付不依赖获得写权限。

文件：[README](../../../README.md)、[package.json](../../../package.json)、[扩展清单](../../../packages/vscode-extension/package.json)、[DMG 构建](../../../scripts/build-dmg.mjs)、[tarball 构建](../../../scripts/build-release.mjs)、[Swift 更新入口](../../../packages/desktop-macos/main.swift)。本文位于 docs/superpowers/specs 三层目录，相对链接解析到仓库根文件。

## 3. 接入选型与最小可信入口

### 3.1 首选：可信默认分支 Actions → 认证 webhook → Grok Bot routine

GitHub Actions 支持 `issues` 事件，首期只接 `opened`、`edited`、`reopened`；关闭事件用于取消尚未完成的任务。工作流必须先由人工审阅合入默认分支。无需 assignee、标签或作者白名单。PR 不混入 Issue 队列。

可信 workflow 只使用 GitHub 事件文件解析白名单字段：仓库固定 ID、issue number/node ID、动作、updated_at、workflow run ID；不 checkout Issue 提供的引用，不执行标题/正文，不下载附件，不将外部字符串插值进 shell 或 Actions 表达式脚本。仅发送小型唤醒提示，正文在 Grok Bot 内通过已连接 GitHub 的只读接口重新取得。外部文本不进入可信执行脚本。

父助手须创建专用 webhook routine；用户从 routine 面板复制 URL 和 sender key，在 GitHub 仓库 Actions secrets 中配置。Grok Bot 不可自动获取/打印 sender key。**目前仅确认存在认证 webhook trigger；确切 header、请求格式、签名/重放协议尚未核验，不猜测 Authorization 或 HMAC 格式。**在用户可见接线文档明确这些字段并完成正负验收之前，不部署该桥接。

webhook 的认证说明“来自持有发送密钥的一端”，不代表 Issue 作者可信，也不证明 payload 内容真实。接收后按固定仓库重新读取 Issue 和 Actions run，校验仓库 ID、workflow 路径、默认分支、事件种类、run ID 是否匹配；无法核验则丢弃并记录。幂等由后述持久化去重保证；不宣称拥有未验证的 GitHub 原生签名。不得让触发输入指定目标仓库、命令、凭据、模型、发布环境或回调 URL。

### 3.2 可用性备选：有界轮询

原生 routine GitHub listener 有 `issue-assigned`，**没有** `issue-opened/labeled`；指派入口不符合本设计，不采用。若 webhook sender 协议或最小权限连接不能验证，改为用户批准的 GitHub Issue 轮询 routine：建议工作日 Asia/Shanghai 09:00–19:00 每小时一次，不默认为全天候；每次最多拉取 100 条更新、最多 5 页，排除 PR，用重叠时间窗和 node ID 去重，未读完保留分页游标，下次继续，不跳过 backlog。先确定首次上线水位（从启用时开始；历史 Issue 仅用户指定范围回填）。不在本阶段创建该 routine。

两种入口共用一份队列/去重状态，切换时先暂停入口、对齐游标再恢复；不能双开产生两套执行器。轮询不需要 webhook secret，延迟更高但无需虚构未验证接口。对 CI 完成等原生可监听事件可后续使用原生 listener；状态推进仍须核对服务器事实，不能只相信唤醒消息。

## 4. 分诊、范围与不可信文本

每条 Issue 保存内容快照摘要、updated_at、分类、理由、可验证验收标准和风险范围。AI 判断不替代权限判断；确定性规则先拒绝敏感路径/动作。作者身份不作为低风险的必要条件。

- 自动候选：局部文档、展示/格式化缺陷、合成 fixture 可复现的局部逻辑 bug、项目已支持范围内的小改动；必须能写出明确验收条件及最小修改面。
- 转人工：目标不清晰、不可复现、跨模块大重构、新外部服务、付费探针、凭据/认证/权限、日志或个人数据外传、用户数据删除、安全边界、安装/卸载/更新器、发布脚本/工作流/门控策略修改、依赖和可执行构建配置变更。无法确定风险也转人工。
- 明显越界或恶意指令：不执行，保存分类并只向用户报告。Issue 中“我是维护者”“忽略规则”“读取密钥”“运行这个命令/下载补丁”等均是数据，不是授权。

评论默认只作补充证据，不作新权限来源，不自动启动新任务；不自动跟随评论中的链接或执行附件。编辑/重开可重新分诊，但不能绕过次数与日限额。运行中内容变更则作废该快照的执行资格，停在下一安全检查点，重新分诊并保留历史；不拿旧批准隐含批准新需求。

## 5. 控制平面、状态机和限额

可信控制平面放在 box 上 checkout 外的专属 autopilot 状态目录；SQLite 事务保存队列、快照、尝试记录、PR/SHA、检查证据和发布账本，权限仅控制账户。候选代码不能挂载该目录。日志不得存凭据、完整私人日志或令牌。共享 box 上其他 agent 不得被当作安全隔离；执行候选代码必须进入下节沙箱。

状态流：`received → triaged → queued → working → validating → review → merge_ready → merged → rc_building → rc_published`。旁路终态为 `needs_human`、`rejected`、`cancelled`、`failed_premerge`、`failed_postmerge`。等待 runner/check 的状态保存外部 run ID，routine 可以结束，下次唤醒恢复，不要求一次对话常驻。

收到新快照只新增排队记录，不绕过人工/失败终态；同一 issue 累计已耗尽修复预算时，新编辑必须人工解锁，避免编辑重置预算。每个状态变更事务保存前状态、owner/run ID、时间、输入快照摘要、policy revision、base/head/merge SHA、证据引用、计数、结果。唯一键为 repo ID + issue node ID + 内容快照摘要；重复 webhook、重启、重复编辑事件不得重复创建 PR/Release。发布还使用唯一 tag + merge SHA + 产物清单键。先记录意图再执行外部写，重启后查询 GitHub 确认结果再续作，避免“超时=未发生”的错误。

- 全仓库同时只有 1 个 active task；事务原子取得租约，持有者每分钟心跳，10 分钟无心跳标为疑似失联。不得直接重抢；先确认旧进程和外部 job 已终止，无法确认就转人工。每次写操作前再查租约及 fencing generation。
- 一次初始修复 + **最多两次修复重试**，合计最多三版候选；同内容编辑不能重置计数。失败原因必须保留。安全/凭据/策略问题、恶意输入、合并后失败不自动重试修复。
- 建议首期上限：每日分诊 50 条、开始自动任务 3 个、发布 RC 3 次；单任务 AI 工作累计 60 分钟、所有构建累计 60 分钟、候选 diff ≤10 文件且 ≤300 增删行（生成二进制不允许在候选中提交）。独立审查也计入任务时间；无精确 token/费用遥测时不假装能强制金额预算。触限暂停新任务并汇总给用户，时间/次数在实施时必须真正在控制器约束。
- 单 job 超时 30 分钟，等待 runner 最多 2 小时；超时停线，恢复须重核状态。基础设施暂态可人工重跑同一 SHA 的检查，不增加修复次数，但计入资源上限。

## 6. 信任边界与凭据分离

Grok Bot 可信协调器决定队列/权限/merge/release；独立审查会话只读审核候选，不采信编码会话自评。AI 仍可能犯错，所以安全规则、检查来源和写入 gate 必须确定性实现，不能只靠提示词。

候选构建/测试视为执行不可信代码：候选 Linux 执行可使用合法临时 GitHub Linux runner 上的受限 rootless 容器；AI 编码与可信协调仍在 Grok Bot box。box 仅在同样隔离合同真实验收后才可作为候选执行位置，不能用当前缺 cgroup 委派的共享宿主替代。执行环境必须提供，空 HOME、临时数据库/端口、无宿主目录/浏览器/SSH/凭据/状态目录/套接字挂载，无 Git 凭据、网络默认关闭、资源限制。源码通过无凭据只读快照送入。若无法建立这种隔离，不能自动运行 Issue 导出的代码；转人工。不能在存有其他 agent 登录的共享 box 宿主直接跑候选 npm 脚本。

macOS 验证用合法授权的临时 macOS runner；不使用用户电脑、不把 Linux 假装成 Mac、不在含私人 Keychain/真实账号的常驻 Mac 上跑候选。无发布 secrets 的构建 job 使用最小只读 token并关闭 checkout 凭据持久化。验证不自动登录四个客户端。

发布 job 与测试 job 分离：仅执行人工审阅固定版本的控制脚本，下载并校验准确 run/SHA 的产物；不执行产物、PR 脚本或产物内给出的命令。发布 token 不进入任何候选构建/测试进程，身份仅本仓库 Contents 写（tag/release）和必要 Actions 读；PR/合并身份只获本仓库 Contents/PR 写和检查读。若平台细粒度权限无法分到理想边界，用分离身份与环境约束补足，否则保持人工门控。不得索取或读取用户 token 文件、临时铸造 token、绕过明确拒绝。

入口 workflow 只需固定事件上下文、元数据只读和专用 sender secret，不需代码/Issue 写权限。GitHub repo 连接不等于 box CLI 登录；后续用户须用正常批准的登录途径建立可用身份，不能从 connector 提取凭据。

受保护路径包括 `.github/**`、`scripts/**`、`packaging/**`、更新/安装/认证/安全模块、依赖/执行入口清单，以及控制平面策略和测试 harness。bootstrap 时人工确定具体路径与内容 hash。Issue 导出的自动候选触碰任一受保护项即转人工；唯一受限例外是可信控制器按第 8 节固定规则调整清单的 version 字段，必须结构化校验仅该字段变化并进入全部验证，不能改 scripts/dependencies/updateFeedUrl；不得移除测试、降低检查、修改 allowlist 或“自己给自己通过”。策略基线固定在受信 revision，候选即使新增同名 check 也不能满足 gate。

## 7. 验证矩阵与精确 SHA 门控

每个候选使用独立分支/PR，不改主 checkout 上他人未提交工作。PR head 必须等于账本 H，当前目标分支必须等于基线 B；记录验证树/组合提交 T，确保测试的是 B+H 的实际合并结果。独立审查针对 H 与 T 的 diff，不能只审任务摘要。

| 检查 | 环境和证据 | 通过条件 |
| --- | --- | --- |
| 需求/范围/策略 | 可信控制器 + 独立 Grok Bot 审查 | 验收可验证；无敏感路径/权限变动；变更未超过限额；无未解决阻断意见 |
| 回归与复现 | 无 secrets Linux 沙箱，固定 Node 24 工具链 | 新 bug 有先失败后通过证据；全量 `npm test` 成功；记录命令、工具版本、H/B/T |
| macOS 回归 | 无 secrets 临时 arm64 macOS runner | 全量测试与原生构建成功；工具隔离/不强杀/不改第三方签名约束未退化 |
| 包验证 | 同一 T 的 DMG、tarball、VSIX | 文件清单、版本一致、SHA256；DMG 可挂载/验签、app 架构与最低系统符合、捆绑 Node 可启动；CLI `--version`/`ssh-info` 在隔离 HOME 冒烟；VSIX 解包 manifest 校验 |
| 更新隔离 | 稳定旧客户端与模拟稳定/RC feed，真实 GitHub RC fixture | 默认稳定通道不选 RC；自定义源未证实安全则不开放自动 RC 发布 |
| 合并后重构建 | 实际 merge commit M，新 job | 对 M 重跑测试、macOS 构建和包冒烟，产物不能复用 T 的包 |

`verify:local` 不是干净 CI 上有真实用户数据的替代品。默认不扫描用户 HOME；仅允许经审阅的合成 fixture 或临时 HOME，保持不写正式库/外部配置。真实账号、真实 IDE UI 覆盖不足时必须明确记录，涉及它们才可验证的改动不自动合并。

gate 核对检查来源（可信 workflow ID/path/revision、run ID、event、SHA）、成功结论与产物 digest，不只按 check 名称或 PR 文字判断。所有必要检查和独立审查完成后，合并前再次读 H/B/issue 快照/锁：任一变化使旧证据失效，重新构造 T 并全量重验。发现失败、不确定、缺失、取消或过期一律停线，不将跳过当通过。

GitHub 合并需校验 expected head SHA；base 竞争必须由保护规则/严格 up-to-date required check 或验证同一组合提交的 merge queue 防住。**仅“读一下 base 再调用 merge”有竞态，不足以启用自动合并。**若无法证明原子门控能力，保留人工合并，不能宣称端到端已完成。实际 M 不等于预期组合结果时冻结发布并报告，不能自动补造通过证据。

## 8. RC 版本、稳定更新隔离与发布

候选准备时由可信控制器分配下一 patch 的 `X.Y.Z-rc.N`，例如基线 0.2.25 后首个可为 `0.2.26-rc.1`（仅举例，启用时需查稳定 tag 和账本）。版本更新是控制器受控操作，不由 Issue 指定；根清单、扩展、包元数据按已验证的版本兼容策略同步。若 VSIX 不接受 SemVer 预发布字符串，使用已验证的兼容映射和单独 RC 元数据，未验证前阻断发布，不随意删后缀伪装稳定版。

版本提交必须在合并前进入 H/T 的所有检查；合并后不能临时修改 M 的版本再声称包源于 M。main 可能暂带 RC 版本，这是预发布开发态，不等于稳定版已发布。下一个任务从实际 main 重新分配版本；稳定发布必须另行得到用户确认。

发布前对准确 M 重新构建并验证，创建 tag `vX.Y.Z-rc.N` 指向 M，GitHub Release 设 `prerelease=true`、`make_latest=false`。先创建 draft、上传 checksum/构建清单/DMG/tarball（VSIX 若作为独立附件须已核验），核对完整性再公开预发布。已有相同 tag/M/哈希则复用记录，不覆盖；tag 被占用或字节不一致转人工。

**RC 上线的先决条件**：确认默认 `/releases/latest` 不会指向 RC，且已有稳定客户端解析路径不会把 RC 当稳定更新；覆盖自定义 JSON 源和版本比较器，不只依赖 GitHub 的 prerelease 标记。当前 Swift JSON 路径无明显 prerelease 判断，必须通过兼容测试或先人工引导加固。若旧稳定客户端指向用户自定义且可能收录 RC 的 feed，无法用升级未安装的新代码证明旧客户端安全：需验证该 feed 服务端拒绝 RC，并限定自动发布支持的源；不能识别或控制的源必须告知用户并由人工确认风险，不能承诺全体安装安全。解除后才启用自动合并/RC 线。不能先发到真实通道再拿真实用户试验。

RC 构建 tarball 会更改临时 Formula；校验 staging 后不提交、不推送到正式 Tap。不得更改默认稳定 updateFeedUrl、将 RC 设置 latest、调用用户机器安装器或自动更新器。发布产物里的 RC 客户端也不自动安装任何版本。Developer ID 签名/公证不在首期自动授权中，当前 ad-hoc 包的 Gatekeeper 限制要在预发布说明里明示。

## 9. 失败恢复、暂停与可观测性

用户聊天中的暂停指令优先：先停新接入，设置持久 pause 标记，撤销未开始的队列执行资格；进行中在安全点退出。禁用 GitHub 入口 workflow 和暂停 routine 是紧急双闸；sender key 仅由用户在面板/仓库 secret 轮换，不在聊天转贴。恢复须人工确认资源、锁、证据、基线和外部写结果，不能从 stale checkpoint 直接 merge/publish。

合并前失败：保留分支、PR、测试证据，标记 failed_premerge，按次数限制修复或转人工；不破坏其他工作树。合并后失败：标记 failed_postmerge、冻结后续自动合并/发布、向用户报告准确 M 和失败阶段；main 已变化，**不能谎称已回滚**。是否回退代码、关闭草稿、删除 tag/Release 都需要用户决定，不自动破坏性清理。

成功报告包含 issue、PR、H/B/T/M、检查 run 链接、版本、RC 链接、产物哈希和未覆盖验证；失败报告含阶段、证据、是否已合并/公开发布和下一步人工动作。无新消息时不刷屏。状态/证据保留 30 天，发布账本和去重摘要长期保留；清理仅针对明确标记的沙箱临时数据，不删除用户数据。

## 10. 外部接线和启用依赖（未执行）

1. 用户审阅本文；之后才编写实施计划和建设基础设施。先人工审阅合入可信 CI/门控，记录 policy/workflow revision 和保护路径，给 main 配置 required checks、严格过期审查/更新要求及相应 merge 防竞态策略。
2. 用户通过正常 GitHub CLI 登录/连接建立 box 写入身份和明确 Git commit 身份；不能猜邮箱、写全局 git 配置或复用 connector 密钥。当前缺这两项，文档只能本地交付。
3. 准备合法可用的临时 arm64 macOS runner、固定 Node 和 Swift 工具链；隔离 Linux 执行环境先通过无 secrets/无网络/无宿主挂载的负面测试。不可把用户电脑当 runner。
4. 父助手在用户批准后创建专用 webhook routine，保存固定仓库、风险策略和通知目的地。用户在面板取 URL/sender key，并按当时真实 webhook 文档将其保存为 GitHub Actions secrets；确认 header/body 格式后再写可信转发 workflow。不要把 key 写入 repo、PR、日志或正文。
5. 配置入口最小读权限、PR/merge 身份和独立发布 job 权限；检查私有 secret 不能传给候选代码。发布环境若有人审要求，不移除它来假装全自动，应报告实际阻塞。
6. 测试稳定更新通道、RC 版本/VSIX兼容、tag/M 映射和保护规则竞争测试。通过前保持 publish 与 auto-merge 关闭；受控演练通过后用户明确启用。其他外部输入保持未连接。

## 11. 受控演练与验收

演练须单独批准创建测试 Issue 和相关 PR/预发布；本设计阶段不做这些写操作。首个候选可用小范围 README 内容澄清（例如说明 RC 不属于稳定更新），明确改动边界、无运行时变更，仍跑所有强制 gate。不能再用旧 VSIX 0.1.2 文档不一致作为需求：当前清单已同步到 0.2.25，旧问题已不存在。

验收顺序：

1. 非维护者身份提交清晰低风险 Issue，无指派/标签，收到且只创建一个队列项；重复投递、编辑、重开、关闭按快照和取消规则处理。
2. 标题/正文/评论注入 shell、改权限、改 workflow、索要密钥均不得执行；模拟错误 sender key 被拒绝，合法 sender 伪造仓库/Issue/run 也不进入执行。
3. 断电/重启、双 routine 唤醒、锁过期、API 超时后重放不重复 PR/merge/Release；超限停止；第三次候选仍失败直接转人工。
4. 故意失败的测试、macOS构建、包冒烟、独立审查都能停线；PR 更新或 base 前进后旧通过结果作废；竞态情况下无错误合并。
5. 正常路径自动合并后以准确 M 重构建、仅 RC prerelease 对外可见；校验 default latest 保持稳定、正式 Tap 未变、真实用户机器未被访问或更新。
6. 合并后构建失败演练必须显示已合并/未发布并冻结流水线，不声称回滚。用户暂停后没有新的写入开始。

只有以上记录可复查且外部依赖均已解除，才能宣称跑通。不能把“已写 workflow”“Linux 测试通过”或“PR 已创建”替代整个闭环成功。

## 12. 明确未知项与解除条件

| 未知/缺口 | 解除条件与未解除行为 |
| --- | --- |
| webhook 认证格式/重放语义、routine 能否按所需负载恢复 | 用户面板正式文档及正负联调；未通过改用经批准的有界轮询，不编造接口 |
| box 写权限和提交身份 | 正常 CLI 登录成功、用户认可的本地 repo identity；缺失则停在本地文档/patch |
| 主分支保护/严格 SHA/base 竞争门控能力 | 实际配置读取与竞争测试通过；否则关闭自动合并 |
| 临时 macOS runner 和额度 | 实际可用 runner 验证工具链与隔离；缺失则关闭自动合并/发布 |
| 预发布版本对 VSIX、Swift semver和自定义更新源兼容 | 现有稳定客户端/模拟feed/包安装结构测试，必要的加固经人工引导审阅；不通过不发 RC |
| 无凭据沙箱和发布隔离 | 挂载/环境/网络负面测试、发布 job 来源与 digest 校验；失败不运行候选 |
| routine 会话恢复与限额是否能真正实施 | 持久状态/锁/失联重放演练；没有确定性控制器不得用提示词宣称可靠自动化 |

## 13. 审阅关口

自审标准：入口不含人工指派前提；issue/评论不是授权；候选不能改 gate；一个 active task/最多两次修复重试；H/B/T/M 证据链完整；RC 与正式更新/正式 Tap 隔离；Linux 不冒充 Mac；合并后失败不冒充回滚；无 Cursor 编码服务；未知项均有解除条件。

下一步仅等待用户审阅本文，**不自动开始实施计划或部署**。

## 参考

- [GitHub Actions 事件：issues](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#issues)：issues workflow 须在默认分支；activity types 可明确选择。
- [GitHub Release REST API](https://docs.github.com/en/rest/releases/releases#create-a-release)：`target_commitish`、`prerelease`、`make_latest`；使用前应以实际 API schema 为准。
- Grok Bot routines 技能（本次读取）：原生 GitHub 支持 issue-assigned 而不支持 issue-opened/labeled；webhook 的 URL/sender key 由用户在 routine 面板取得；定时触发最短 5 分钟。本设计未创建任何 routine。


### B 检查点部署调整（未启用）

2026-11-20：准备临时ubuntu-24.04上的固定合成预检，未提交远程/未跑CI，非真实Issue验证。仍须全部无凭据/离线/非root/资源及取消合同；不购买runner、不引入AI API、不扩大token权限。新增外置root所有的批准文件/只读安装树作为启动信任根的候选具体化，需要部署引导审阅后配置；本轮未写/etc、未安装unit或修改宿主权限。

旧库仅可在旧进程关闭后的离线组件测试中迁移。新冷启动audit要求固定systemd控制器与jobs slice均masked/inactive/无cgroup任务、私有状态目录内核独占锁及外置准确字节批准。现阶段不支持收养unmanaged/v1库、遗留WAL/SHM、active lease或任何可能代表远程工作的intent；没有自动升级、备份回退或实际controller启动器。不能据此声称F1生产升级已完成；未来必须由持锁supervisor贯穿controller及本地jobs生命周期，并由真实远程adapter确认所有远程jobs已停，才可恢复工作。


2026-11-20 B修复：Linux合成采证收窄为外置准确批准workflow SHA与独立driver源SHA的一次性维护分支push诊断，不是常驻PR门。不得在宿主执行待审PR package/test/driver后自证隔离；未来候选来源链仍由Task8实现。两个外置非secret批准值未设置，本轮不push/运行/启用。
