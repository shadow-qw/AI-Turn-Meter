# AI Turn Meter

一套面向 macOS 的单后台多客户端 AI 用量与回合监控工具，统一采集并展示 **Antigravity**、**Codex Desktop (`ChatGPT.app`)**、**Cursor**、**CodeBuddy CN** 每轮对话的输入 Token、输出 Token、缓存命中率、生成速度（TPS）、API 等效费用、套餐剩余配额、**每日 AI 账单小票**以及**模型指纹与降智检测**。

全套能力由 **1 个常驻本地守护进程**（`com.local.ai-turn-meter.daemon`）、**1 个原生 macOS 控制台与可选菜单栏应用**（`AI Turn Meter.app`）、**1 个 CLI**（`ai-turn-meter`）与 **1 个通用 VSIX 扩展**（`dist/ai-turn-meter.vsix`）完成。

---

## 1. 整体架构

```text
  Codex JSONL (~/.codex/sessions) ──────────────┐
  Antigravity Logs + LanguageServer RPC ─────────┼─▶ Daemon (127.0.0.1:47831)
  CodeBuddy IDE history + CLI JSONL ─────────────┤     ├─ TurnStore (SQLite meter.db)
  Cursor Hooks (本地 node / Remote-SSH curl) ────┘     ├─ Pricing & Quota Probes
                                                       ├─ Receipt Renderer (ASCII / SVG)
                                                       ├─ Fingerprint & Degradation Engine
                                                       ├─ HTTP + SSE API (/v1/*, /events)
                                                       └─ CdpInlineInjector (WebSocket)
                                                             ├─ Antigravity (DevToolsActivePort / :47924)
                                                             ├─ Codex Desktop (:47921)
                                                             ├─ Cursor (:47922, 可选)
                                                             └─ CodeBuddy CN (:47923, 可选)
```

核心源码与入口分布：

- 守护进程与 HTTP/SSE 服务：[packages/daemon/bin/daemon.mjs](packages/daemon/bin/daemon.mjs)、[packages/daemon/src/server.mjs](packages/daemon/src/server.mjs)
- 存储、用量聚合与账单引擎：[packages/daemon/src/store.mjs](packages/daemon/src/store.mjs)、[packages/daemon/src/pricing.mjs](packages/daemon/src/pricing.mjs)、[packages/daemon/src/quota.mjs](packages/daemon/src/quota.mjs)
- 每日 AI 账单（热敏小票 ASCII / SVG 渲染）：[packages/daemon/src/receipt.mjs](packages/daemon/src/receipt.mjs)
- 模型指纹与降智检测引擎：[packages/daemon/src/fingerprint.mjs](packages/daemon/src/fingerprint.mjs)
- 口径归一化与格式化：[packages/daemon/src/format.mjs](packages/daemon/src/format.mjs)
- 各客户端适配器：[packages/daemon/src/adapters/](packages/daemon/src/adapters/)（`codex.mjs`、`antigravity.mjs`、`cursor.mjs`、`codebuddy.mjs`）
- CDP 内嵌脚本注入器：[packages/daemon/src/cdp-injector.mjs](packages/daemon/src/cdp-injector.mjs)
- 统一 CLI 与安装器：[packages/daemon/bin/cli.mjs](packages/daemon/bin/cli.mjs)、[packages/daemon/src/installer.mjs](packages/daemon/src/installer.mjs)、[packages/daemon/src/apps.mjs](packages/daemon/src/apps.mjs)
- IDE 状态栏扩展：[packages/vscode-extension/package.json](packages/vscode-extension/package.json)、[packages/vscode-extension/extension.js](packages/vscode-extension/extension.js)
- 原生 macOS 控制台与菜单栏软件：[packages/desktop-macos/main.swift](packages/desktop-macos/main.swift)
- 安装、发布打包与 Homebrew Formula：[scripts/](scripts/)（`install.mjs`、`package-vsix.mjs`、`build-dmg.mjs`、`build-release.mjs`、`verify-local.mjs`、`uninstall.mjs`）、[packaging/homebrew/ai-turn-meter.rb](packaging/homebrew/ai-turn-meter.rb)

---

## 2. 核心功能与展示形态

### 2.1 四家客户端回合监控位置

| 客户端 | 常驻展示位置 | 可选聊天底栏内嵌胶囊（CDP） |
|---|---|---|
| **Antigravity Desktop** | 每条回复操作栏（`1m ago 📋 👍 👎` 左侧，优先检测 `DevToolsActivePort`，未开启时可带 `:47924` 调试口拉起） | 自动检测或 `ai-turn-meter open antigravity` |
| **Codex Desktop (`ChatGPT.app`)** | 聊天回复操作栏左侧（`47921` 端口） | 运行 `ai-turn-meter open codex` 拉起 |
| **Cursor** | 右下角状态栏（VSIX，含 Remote-SSH 本机 UI 运行） | 手动退出 Cursor 后运行 `ai-turn-meter open cursor`（`47922`） |
| **CodeBuddy CN** | 右下角状态栏（VSIX） | 手动退出 CodeBuddy CN 后运行 `ai-turn-meter open codebuddy`（`47923`） |

> 安全约束：`ai-turn-meter open` 在目标进程已运行时仅通过 AppleScript 温和请求退出（最长等待 8 秒），绝不强制 `pkill`，也不会修改任何 `.app` 安装包签名。

### 2.2 展示格式与顶部菜单栏

- **单行主摘要（内嵌胶囊 & 状态栏）**：只显示**当前这一轮**指标，不混入整场对话累计值：
  `输入 1.13M (96%) · 输出 13.5k · 289 tok/s`
- **悬浮详情卡 / 状态栏 Tooltip**：顶部模型名 + 调用数，中部四列（`输入` | `输出` | `缓存率` | `速度`），底部当前会话累计参考。
- **原生 macOS 菜单栏（可在「设置 → 菜单栏」自由开关与定制）**：
  - 图标样式支持 `配额进度条（自适应单/双栏，默认）`、`仪表盘` 以及 **`无图标（仅文字）`**（适合直接在顶栏展示 `Token · 金额`）；
  - 文本模式支持 `仅图标`、`配额百分比`、`今日费用`、`今日用量 + 费用`、`实时速度`、`最近一轮简报`；
  - 用量与费用范围支持 `全部软件汇总（默认）` 与 `仅当前展示软件`，与配额图标软件独立解耦；
  - 套餐配额支持 Codex（5h/周窗口）、Antigravity 多模型池、Cursor 双池（Cursor 模型 / 其他模型）与独立 **Grok Bot** 周配额池。

### 2.3 每日 AI 账单（热敏小票风 Day Card）

在 macOS 应用的 **`用量 → 每日账单`** 或 CLI `ai-turn-meter receipt` 中查看和分享：
- **极简热敏小票视觉**：顶平底锯齿米白热敏纸（支持热敏纸 / 暗夜双主题）搭配雾感山林湖畔渐变衬底；
- **六段式账单结构**：居中「每日 AI 账单」与日期/开具时间 → 超大居中 API 总费用 → 连续使用天数 / 请求数 / 对话轮次 / 对比近 30 天日均倍数 → 两级 **`AGENT / 模型`** 费用明细清单（也可切换按项目分组并支持隐私隐藏项目名） → 底部 Token 总量 / 输入 / 输出 / 缓存命中率与缓存节省汇总；
- **多币种与一键分享**：支持 `USD+¥` / `USD` / `CNY ¥` 三种模式与自定义汇率（默认 `1:7`），支持一键**复制高清图片、保存 2x PNG、导出矢量 SVG 与复制终端纯文本小票**。

### 2.4 模型指纹与降智检测

在 macOS 应用左侧边栏的 **`降智检测`** 或 CLI `ai-turn-meter fingerprint` 中全部手动触发：
- **一键全面体检**：单次点击自动扫描全四家近 7 天历史对话异常（速度突增疑似切轻量模型、思考深度骤降/归零、同会话旗舰回退轻量）并核验本地 Codex 官方路由；
- **Codex 本地端点专项核验**：复用 `~/.codex/auth.json` 与 `config.toml`，适配官方 `/backend-api/codex/responses` SSE 流式响应，核对实际返回模型、套餐档位与流内 `safety_buffering` 状态，并支持一键跑 8 题能力探针（`测智商`）；
- **私有客户端两步出题验证**：针对 Antigravity / Cursor / CodeBuddy 提供标准 5 题测试包，一键复制发给模型后自动读取回复评分；
- **中转站 / 自定义 API 真伪指纹**：支持添加 OpenAI / Anthropic 兼容端点（API Key 仅存本机 `config.json`），结合 8 题确定性能力探针与单 Token 概率分布指纹（Jensen-Shannon 散度 + 自录参考基线）识别偷换模型与静默量化。

---

## 3. 各软件采集来源与 TPS 计算口径

所有指标经 [normalizeTurn](packages/daemon/src/format.mjs) 统一规整：
- 缓存率：`cacheReadTokens / totalInputTokens * 100`
- 最小有效统计耗时门槛：`150ms`（低于门槛视为 `unavailable`，避免极短样本算出异常高 TPS）

| 工具 | 数据来源 | 速度与延迟口径 |
|---|---|---|
| **Antigravity** | 扫描 `~/.gemini/{antigravity,antigravity-ide,antigravity-cli}/brain/<sessionId>/.system_generated/logs/transcript.jsonl` 与对话元数据库；结合本地 `language_server` RPC（`GetCascadeTrajectoryGeneratorMetadata`） | 优先使用 RPC 返回的 `streamingDuration` 与 `timeToFirstToken`（`streaming_decode`）；`antigravity-subagent` 子代理单独标记并在主界面内嵌胶囊中过滤 |
| **Codex** | 监听 `~/.codex/sessions/**/*.jsonl` 中的 `token_usage_record`、`token_count`、`response_item`、`event_msg` | 合并 `event_msg:item_completed` 中 `Reasoning` 与 `AgentMessage` 的 `[started_at_ms, completed_at_ms]` 区间作为解码活跃时长（`streaming_decode`），`ttftMs` 取首个模型生成开始相对用户提交锚点延迟；无 `item_completed` 时扣除工具等待时间，且仅在 `callCount === 1 && thinkingTokens === 0` 时扣除 `time_to_first_token_ms`，避免把前置隐藏思考算进可见首字延迟导致 TPS 虚高 |
| **Cursor** | 通过 `~/.cursor/hooks.json`（根字段要求数字 `"version": 1`）挂载 7 个生命周期事件：`beforeSubmitPrompt` / `beforeShellExecution` / `afterShellExecution` / `beforeMCPExecution` / `afterMCPExecution` / `afterAgentResponse` / `stop` | 按 `conversation_id:generation_id` 去重 `afterAgentResponse`/`stop`；从整轮耗时中扣除 Shell 与 MCP 执行等待时间（`e2e_minus_tools` / `e2e_turn`）；本地 Daemon 离线时自动落盘到 `~/.local/share/ai-turn-meter/cursor-spool.jsonl` 并在恢复后回放 |
| **CodeBuddy CN** | 监听 `~/Library/Application Support/CodeBuddyExtension/Data/<user>/CodeBuddyIDE/<user>/history/<workspaceHash>/<session>/index.json`（及 `messages/*.json` 中的 `statsSnapshot`）与 `~/.codebuddy/projects/**/*.jsonl` | IDE 优先使用 `statsSnapshot.elapsedMs`（`active_model`），回退 `completedAt - startedAt`；CLI 对每次调用按 `providerData.rawUsage` 去重并扣除工具等待耗时（`e2e_minus_tools`） |

---

## 4. 软件间与窗口隔离机制

1. **存储与会话累计隔离**：
   SQLite 表 `turns`（`~/.local/share/ai-turn-meter/meter.db`）以带工具前缀的 `turn_uid` 为主键，所有轮次带独立 `tool` 字段，会话累计固定按 `WHERE tool = ? AND session_id = ?` 聚合。
2. **CDP 内嵌胶囊隔离**：
   四家绑定各自独立的本地调试端口，[CdpInlineInjector](packages/daemon/src/cdp-injector.mjs) 只向对应端口推送所属 `tool` 的最新主对话记录，不会跨软件推送。
   （注：同一款软件同时打开多个窗口时，CDP 内嵌胶囊按工具维度推送该软件最新一轮。）
3. **IDE 右下角状态栏严格隔离**：
   [getMatchForIde](packages/daemon/src/store.mjs) 在传入 `tool` 时严格按 `同 tool + workspace_path` -> `同 tool + workspace_hash` -> `同 tool 最新记录` 顺序匹配；若该软件尚未产生任何记录，直接返回 `null`（状态栏显示 `等待首轮回复`），不会跨软件兜底显示其他工具在同一目录的记录。

---

## 5. Cursor Remote-SSH 接入方案

针对在 Mac 本地使用 Cursor 连接远端 Linux 开发机（如 `dev-server.example.com`）的场景，项目做了三层适配：

1. **VSIX 本地 UI 模式执行**：
   [packages/vscode-extension/package.json](packages/vscode-extension/package.json) 设置 `"extensionKind": ["ui"]`，确保状态栏扩展始终运行在 Mac 本地 UI Extension Host，直接访问本机 `http://127.0.0.1:47831`（不会尝试连接远端回环地址；若此前在远端装过旧版 `0.1.0` 需从 `~/.cursor-server` 卸载）。
2. **Daemon 原生 Hook 接口**：
   [server.mjs](packages/daemon/src/server.mjs) 提供 `POST /v1/ingest/cursor-hook`，可直接接收 Cursor Hook 的原始 stdin JSON 并交由 `processCursorHookPayload` 处理，远端主机无需安装 Node.js 或拷贝脚本，只需系统自带 `curl`。
3. **SSH 反向端口转发与隔离配置**：
   - 在 Mac `~/.ssh/config` 仅为目标开发机（例如 `Host dev-server.example.com`）添加 `RemoteForward 47831 127.0.0.1:47831` 与 `ExitOnForwardFailure no`（避免影响如 Codex 使用的 `-o ExitOnForwardFailure=yes` 的其他 SSH Host）。
   - 在远端主机 `~/.cursor/hooks.json` 配置 `"version": 1` 与 7 个事件 `curl` 上报。
   - 执行 `ai-turn-meter ssh-info <host>` 可随时生成对应的 `~/.ssh/config` 与远端 `hooks.json` 模板。

---

## 6. 分发与给其他人使用（macOS `.dmg` 软件 / Homebrew）

### 方式一：分发 `.dmg` 桌面软件（零环境依赖，推荐）

执行打包命令（需本机存在独立 arm64 Node >= 22.5，如 nvm Node 24）：

```bash
npm run release:dmg -- --repo=shadow-qw/AI-Turn-Meter
```

会编译原生 Swift 应用（[packages/desktop-macos/main.swift](packages/desktop-macos/main.swift)），并把独立 Node 24 运行时、`packages/` 与 `dist/ai-turn-meter.vsix` 一起打入 `dist/AI-Turn-Meter-<version>-arm64.dmg`。

收到 `.dmg` 的用户（Apple Silicon Mac，无需装 Node）：
1. 打开 `.dmg`，将 **AI Turn Meter.app** 拖入 `Applications`（应用程序）。
2. 如经浏览器/聊天工具下载触发 macOS 未公证拦截，可在「系统设置 -> 隐私与安全性」点击「仍要打开」（或终端执行 `xattr -dr com.apple.quarantine "/Applications/AI Turn Meter.app"`）。
3. 双击打开 `AI Turn Meter.app`：软件会自动完成首次本地安装并拉起后台服务，可在界面内查看 4 家实时状态与配额、切换菜单栏样式、生成每日 AI 账单小票、一键运行降智检测、生成 Cursor Remote-SSH 配置或检查更新。

### 方式二：通过 Homebrew Tap 分发 CLI

1. 在发布机器执行打包脚本：
   ```bash
   npm test
   npm run release:tarball -- --repo=shadow-qw/AI-Turn-Meter
   ```
   脚本会构建 `dist/ai-turn-meter.vsix` 与 `dist/ai-turn-meter-<version>.tar.gz`，并将 `sha256`、`homepage`、`url` 自动写入 [packaging/homebrew/ai-turn-meter.rb](packaging/homebrew/ai-turn-meter.rb)。
2. 将生成的 `.tar.gz` 上传到 GitHub Release `v<version>`，并把 `ai-turn-meter.rb` 放入 Homebrew Tap 仓库的 `Formula/ai-turn-meter.rb`。
3. 其他 Mac 开发者只需执行（Homebrew 会自动安装 `node`，无需预先配环境）：
   ```bash
   brew tap shadow-qw/tap
   brew install ai-turn-meter
   ai-turn-meter install
   ai-turn-meter doctor
   ```

> 说明：如暂未搭建 Homebrew Tap，也可将仓库或 `npm pack` 包分发给同事，在全局安装后执行 `ai-turn-meter install`。

---

## 7. CLI、HTTP API 与常用命令

### CLI 与 npm 脚本

```bash
ai-turn-meter status                 # 查看守护进程与四家 CDP / 最新轮次状态
ai-turn-meter cost [--days=7]        # 查看今日/本周/历史 Token 用量与 API 等效费用估算
ai-turn-meter receipt [--date=...]   # 打印每日 AI 账单小票（支持 --scope=day|week|month --currency=both|usd|cny --rate=7 --theme=paper|dark --svg=out.svg）
ai-turn-meter fingerprint [--mode=.] # 手动运行降智检测（passive|codex_protocol|quick|deep，支持 --target=codex|<id> --record-baseline）
ai-turn-meter doctor                 # 诊断 Node、LaunchAgent、Cursor Hooks、VSIX 与 CDP 状态
ai-turn-meter install                # 注册 LaunchAgent、合并 Cursor Hooks、装入 VSIX 与 CLI 软链
ai-turn-meter uninstall              # 清理 LaunchAgent、VSIX、Cursor Hooks 与 CLI 软链
ai-turn-meter open <app|all>         # 带调试口拉起 codex | cursor | codebuddy | antigravity | all
ai-turn-meter ssh-info [host]        # 输出 Remote-SSH 所需 RemoteForward 与远端 hooks.json 配置

npm test                             # 运行全部单元测试（node --test tests/*.test.mjs）
npm run verify:local                 # 只读扫描本机历史日志并在内存库验证口径（不写正式库/外部配置）
npm run package:vsix                 # 打包 dist/ai-turn-meter.vsix
npm run release:dmg                  # 编译原生 AI Turn Meter.app 并生成免 Node 的 arm64 DMG
npm run release:tarball              # 生成发布包并更新 Homebrew Formula sha256
npm run install:all                  # 等价于本地仓库执行 ai-turn-meter install
npm run uninstall:all                # 等价于本地仓库运行 ai-turn-meter uninstall
```

### Daemon HTTP / SSE 接口（默认 `http://127.0.0.1:47831`）

- `GET /health`：健康检查（返回 `ok`、`pid`、`port`、`version`）
- `GET /v1/state?limit=20`：最新全局状态与 `byTool` 摘要
- `GET /v1/turns?limit=30&tool=`：按时间倒序的最近轮次列表
- `GET /v1/usage?days=7&tool=`：多维度用量统计、费用估算与各软件剩余配额卡片
- `GET /v1/receipt?date=&scope=day&groupBy=model&format=json|ascii|svg`：每日/周期 AI 账单数据、文本小票与矢量 SVG
- `GET /v1/fingerprint/overview`：被动降智诊断、Codex 配置、自定义端点、基线与历史体检记录
- `POST /v1/fingerprint/run`：手动触发一键体检（`one_click`）、被动诊断、Codex 路由核验、能力探针或单 Token 分布指纹
- `POST / DELETE /v1/fingerprint/endpoints` & `DELETE /v1/fingerprint/baselines`：自定义检测端点与参考基线管理
- `GET /v1/match?tool=&workspace=&workspaceHash=`：IDE 窗口匹配查询（传 `tool` 时严格隔离）
- `GET /events`：SSE 实时推送（`state` / `turn` 事件）
- `POST /v1/ingest`：直接写入已归一化 Turn 对象
- `POST /v1/ingest/cursor-hook`：接收原始 Cursor Hook JSON 并就地转换入库
