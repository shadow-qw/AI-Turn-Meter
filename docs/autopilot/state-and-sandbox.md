# 批次B：离线控制面检查点（未部署、未完成整个B）

本页记录Tasks3–5的当前检查点。只在Grok Bot box编码；Issue/评论/AI输出均不是权限来源。本轮新增仅本地冷启动audit与合成预检workflow定义，尚未推送/部署；部署位置调整在spec和deployment-and-hosted.md明确记录。没有Issue入口、routine或外部服务接线。

## 接口与权限边界

- `contracts.mjs`：严格字段白名单、类型/大小/ID/摘要检查。`snapshotDigest` v1为UTF-8 JSON数组 `[repoId,issueNodeId,number,updatedAt,title,body,state]` 的SHA256；ingress以后必须重新读取GitHub并生成同一摘要，不能信任webhook自述hash。作者/标签不作为权限字段。`policyRevision`为64位小写SHA256可信代码bundle摘要，Git commit/head/test SHA仍为40位，不能混用。
- `policy.mjs`：固定仓库1461122513、关闭全部自动开关，不接受调用者替换策略。配置及代码bundle指纹均不是审批。`classifyScope`是**必要范围过滤而非充分授权**；文件/行数及git对象属性今后必须由可信diff/tree读取器提供，不能使用AI自述数量或binary=false。
- 首期保护全部SwiftPM原生目录，保留旧设计“整个main.swift敏感”的保守边界，不以迁移到多文件为由扩大权限。daemon仅format.mjs可进入范围筛选；认证、数据、网络、安装、配额、扩展执行入口等均转人工。依赖清单、工具/策略、workflow、打包及维护说明受保护。删除测试需人工；仅新增行无法证明不弱化断言，独立审查仍必需。
- `openState(absolutePath,{verifyTermination})`仅供可信协调器。存储路径必须由部署配置指定到checkout外私有目录（目录0700、文件0600），不得用daemon正式库/AI_TURN_METER_DB，不读取认证/用户历史。代码目前未安装任何持久目录。生产时整个目录及SQLite WAL/SHM不能暴露给候选；文件权限不能隔离共享box同UID，必须另有真正沙箱。
- `enqueue` / `recordTriage`是可信ingress/Grok Bot的内部调用；并非可公开接收HTTP请求的授权API。received→queued需要校验快照及candidate结果；其他结果终止/转人工。已关闭Issue不能成为候选。没有实现AI语义分诊或全Issue监听，不能把schema验证说成AI已辨识风险。

## 状态、锁和计数

SQLite使用WAL、synchronous=FULL、busy_timeout、内部DB schema v2（v1保守迁移、未来版本拒绝）及BEGIN IMMEDIATE。未来schema拒绝启动。任务、journal、全局锁、issue跨快照预算和intent的变更在事务内；异常rollback业务变更。拒绝操作也保留可信时钟high-water，禁止在过期写被拒后回拨时间续租。时间参数必须来自可信协调器时钟，不得来自Issue/候选；当前没有对外时间输入接口。

- 一个固定仓库只能有一个active锁。claim只取当前快照queued任务；过期不自动释放/抢占；心跳、transition、charge、intent核对owner/generation/实际DB到期时间及最新快照。新编辑作废旧资格但不直接解锁。
- `reconcile`默认恒拒绝。未来需独立可信终止adapter，证明该准确执行和外部jobs已停止；当前没有真实adapter。测试注入的是合成verifier，不是实际停止证明。核验通过后仍将旧任务转needs_human，再增加generation；旧owner所有受租约保护写都拒绝。
- pause冻结任务写并保留锁；人工resume/reconcile属可信管理员恢复接口，可在暂停期间工作，不授予执行权限。启停和恢复审计保留理由/有界run引用。无人可由Issue请求传入verifier或调用管理接口。
- 初始+两次重试，共三版；编辑不重置issue级attempts或AI/build累计。每日分诊50、启动任务3，日期固定Asia/Shanghai。`charge`原子限制已记账AI/build各3600000ms，超额不部分写入。**实际AI/runner用时采集和运行中停止尚待调度/执行adapter接入，当前不是已测费用或物理执行时间限流。** job30min、runner等待2h目前只是策略约定，未实现调度计时器。
- `reserveIntent`只支持pr/validation离线账本；同key/同SHA重放复用，同key不同SHA/任务拒绝。重启不丢reserved/complete结果。它不调用GitHub，不代表外部副作用exactly-once；之后必须先查询远程结果再续作，尚未实现此adapter。merge/release intent明确拒绝，3次RC限额配置不代表RC发布链已实现。
- 当前只实现到merge_ready及premerge终态；merged/rc状态推进必须等D/E可信门控，不能由此库伪造上线结果。

## 沙箱：硬停止而不是假验收

`sandboxArgs`仅离线规划固定镜像和unit/package-check命令；命令脚本属于控制器而非Issue/package scripts。只接受同一受控/tmp staging根的source/out路径；无调用者env、mount、自由命令或可换镜像。参数含离线、非root UID、只读root/source、cap-drop、NNP、private命名空间、2GiB/128pids/2CPU及受限tmpfs。**这不证明目录真实无symlink/凭据、内核实际执行限额或镜像已获批准。**

`inspectSandbox`无条件SANDBOX_UNAVAILABLE，`runSandbox`也无条件拒绝，不能用输入flag、注入spawn或伪造inspect/canary JSON解锁。没有运行/拉取容器、安装运行时、改cgroup/rootful fallback、执行真实Issue代码，亦没有修改现有发布硬停止。

本轮已把hosted原型集成为仅固定合成fixture的真实rootless预检适配器，另有外置批准/独占冷audit组件。详见[部署与预检合同](deployment-and-hosted.md)。AI/协调仍box；临时GitHub Linux runner是明确记录的候选执行位置调整，不是把本box说成可用。生产候选入口仍硬拒绝，新的合成适配器尚未实跑容器/CI。

### Task5尚缺的具体门

1. 实际rootless运行时、user manager及cpu/memory/pids可写委派；本box PID1=tini/无委派，不能安装或放宽限制冒充可用。
2. 官方镜像digest实际pull/arch/Node版本复核及可信固定harness打包来源；当前digest仅承接公开元数据，未获运行验收。
3. 真实Podman inspect schema适配及start前核对，不能根据模拟对象或宿主声明发“ready”证书；完整mount/namespace/fd与环境无凭据审阅。
4. 可信H/B/T源码快照制作：无.git/认证文件/符号链接/子模块/敏感宿主挂载，TOCTOU防护、输出磁盘/日志/产物大小上限与摘要归属。argv路径格式验证不是上述证明。
5. 临时VM上真实有界baseline、网络/只读/伪凭据不可读、CPU节流、memory OOM、pids限制、超时子孙清理canary，保存cgroup实际值和残余进程证据；不得在共享box或真实secret旁执行。
6. 取消/失联/VM终止的可信证明与reconcile绑定；单个finally或模拟spawn不是所有故障已清理。
7. 合成adapter代码已备本地审查；真实hosted实跑、生产adapter/完整快照及配额、Task8/D的可信workflow与精确SHA证据接线仍缺。

本检查点仅接受离线单元/真实SQLite并发测试，不宣称容器或整个B完成。没有push、合并、tag、发布、监听或自动化启用。


## B内审查修复：issue资格不是单个task状态

当前修复仍待同一独立审查者复审。共享eligibility先查持久hold，再查跨快照attempts及AI/build余额；triage、claim、新修复版working都使用它。needs_human/rejected/failed_premerge/cancelled及已核验恢复均建立issue级hold。编辑、关闭重开、pause/resume和重启均不清除hold。

DB v1升级v2只增加hold_reason/hold_generation/blocked_reason，从历史人工/失败终态保守回填hold；保留原预算、锁与fencing代次，不自动释放遗留active。已有queued不合资格项由claim事务持久转needs_human、保存blocked reason及journal，再继续找健康任务，不占新attempt/start名额。candidate triage时发现无资格同样持久转人工，而非仅抛异常留下队头。

只有可信管理员内部releaseHold可按准确issue、当前snapshotHash、holdGeneration和理由请求解除，不能用Issue/triage字段触发。拒绝尚有active、预算耗尽或代次/快照不符的请求；成功也只恢复received，必须重新可信分诊，保留所有耗费和历史。当前无公开入口/权限接线；verifyHoldRelease默认恒false。只有未来受信任只读adapter核验来自带外用户批准、与准确请求tuple绑定的证据后才能放行；Issue文本、reason、自称管理员或布尔字段都不构成批准。该adapter及真实批准证据尚未接线，测试中的恒true仅合成fixture。此方法不是一个可由外部JSON调用的管理服务。

| mutation | 前置条件 / 结果 |
|---|---|
| enqueue | 可信来源、字段/摘要/固定repo/时间/非暂停；只新增快照，不清hold |
| recordTriage | received、最新快照、严格triage、日限额；无资格持久转人工，函数返回不代表执行授权 |
| claim | 未暂停/无active；共享issue资格及日限额；原子隔离不合格队列项后领取健康任务 |
| heartbeat | live owner/generation、未过期、最新快照、无hold；不能复活失效租约 |
| transition | live fence+snapshot+CAS；新working必须共享资格，拒绝不消耗attempt/journal；held只允许终态安全停止 |
| charge | live fence+snapshot、双字段原子上限；允许held已耗用量对账，不授新工作资格 |
| reserveIntent | live fence+snapshot、无hold、固定kind及SHA/key；仅本地意图，不是启动job许可 |
| completeIntent | live fence+snapshot、原intent归属/结果一致；允许held已发生副作用对账，不执行远程写 |
| reconcile | 管理恢复、已过期、可信实际终止核验及generation绑定；建立hold、增加fence，默认核验仍恒拒绝 |
| releaseHold | 管理恢复、默认拒绝的带外批准核验、精确hold代次/最新快照、无active且预算有余额；只回到received，不重置预算 |
| pause/resume | 可信管理员、有界理由/审计；不清issue hold/耗费，不授权运行 |

时间正好耗尽不允许进入下一版working，剩余1ms可进入；已开始验证的结果推进和安全终止/结算仍可完成。这里没有把状态迁移或账本intent说成实际runner启动，真实时间测量/runner gate仍属未接线部分。内部数据库v2与对外JSON schemaVersion=1不是同一版本空间。


当前15文件可信闭包包含新guard与合成harness，trust-manifest重算。F1生产升级尚未关闭：原库迁移测试不是在线旧controller停止证明。新audit拒绝未登记/v1/sidecar/active/任何remote intent，且无真实启动/升级或stop-adapter接线；不能用其可用性推出整个B完成。
