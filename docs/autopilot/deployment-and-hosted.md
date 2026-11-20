# B：冷启动audit与临时Linux合成隔离预检（未部署）

## 已可审查代码，不是启用凭证

`deployment_guard.py`没有CLI路径、环境开关或verifier=true授权；生产从固定`/etc/ai-turn-meter/autopilot/approval.json`读外置root批准。所有祖先root所有、不可组/全局写，批准清单须带repoId=1461122513、40位revision、绝对installRoot/stateRoot、64位stateIdentity、完整15文件files映射；每项SHA256及root所有只读文件验证，运行guard必须来自批准安装路径。默认不存在批准，保持关闭。本repo trust-manifest只是指纹不是批准。受信入口还必须用系统`/usr/bin/python3 -I -B`，隔离PYTHONPATH/user site；未isolated模式拒绝。初始guard自身必须由外部操作者按审阅commit安装到只读位置，不能靠checkout中自执行脚本给自身背书。

状态目录0700、属协调器UID，固定文件名仅deployment.lock/enrollment.json/ledger.sqlite及两个sidecar；拒绝符号链接、多硬链接、不私有文件和daemon DB名称。逐级dir_fd+O_NOFOLLOW，不是先realpath后重新按字符串打开；持有fcntl独占锁，已有持锁进程立即拒绝。测试包括独立进程抢锁、父进程退出而继承fd的子进程仍阻止接管、目录改名后替代symlink不改变固定fd。

实际systemd只读观察固定`ai-turn-meter-autopilot.service`和`ai-turn-meter-autopilot-jobs.slice`：二者均masked/inactive/dead、ControlGroup空、TasksCurrent=0或not-set，controller MainPID=0。未找到、disabled代替masked、任一存活或查不出均拒绝。没有传入成功verifier的入口；纯assert_stopped的测试JSON不授予生产权限。box没有可用user manager，这里未实际验证可用systemd部署。

所有未登记旧库（包括已关闭v1）一律拒绝；即使伪造enrollment，v1仍拒绝。WAL/SHM存在、active lease、任一远程intent（complete仅代表创建应答，不能证明job停止）均拒绝。既不重放sidecar、不清锁、不删除日志，也不直接迁移。这是停止后检查合同，不是滚动升级实现；旧v1直接调用库仍可能写，未经本gate的库调用仍只是离线组件。

**F1尚未完整关闭：** 实际stop/mask、生命周期supervisor/Node SQLite fd交接、可信新库登记及升级备份/回退未实施；真实远程job停止adapter未接。当前audit不启动/迁移controller、不颁发可脱离锁的permit。未来supervisor必须一直持锁并保证本地jobs继承fd；远程jobs不受本地flock控制，不允许把本地units空当远程停止证明。无这些证据，部署保持阻断。

## 路径剩余边界

以上改进属于新audit；原`openState(path)`接口尚未强制通过guard，也未修复其任意父symlink/完整TOCTOU入口。未来必须限制唯一受信startup入口，保留目录/DB/sidecar身份直到SQLite实际打开并验证，无第三方进程可交换目录或叶子。当前同UID共享box不是对其他同UID进程的隔离；不得把这些组件说成已部署的安全服务。状态永不使用daemon正式库；未访问正式DB。本轮只在mkdtemp内测试。

## rootless临时VM路径

`hosted-preflight/run-synthetic.mjs`是真实Podman create→inspect→start→检查→kill/rm代码，仅五个固定合成fixture，不接受候选路径/ref/环境/命令。固定官方amd64 Node digest来自公开元数据，此前42诊断越过pull/架构/RepoDigest门但0容器；新source仍须独立复审后重新采证，不沿用旧运行结果。先建立空HOME/空registry-auth/独立storage和hooks，再读host rootless/systemd/cgroup2及cpu-memory-pids委派；缺失直接失败，不sudo、不改cgroup、不退rootful。

inspect在start之前核验镜像、65534用户、空capabilities、NNP、只读root/source、精确三个Type=bind mount（source只读、out可写、受控零字节resolver只读）、私有PID/IPC/cgroup、无设备/额外cap/凭据env、network=none和资源。CPU接受官方NanoCpus或严格等价quota/period，矛盾值拒绝。start barrier等待host抓取活PID/cgroup后才执行资源fixture，避免短任务退出丢失证据。

五项：baseline伪secret/只读/空HOME/网络/内核NNP-seccomp/cgroup精确值；有界CPU节流；最多12个有限寿命子进程验证pids；最多192MiB分配验证128MiB cgroup OOM；超时子进程late-write及cgroup空。额度128MiB/32pids/0.25CPU仅合成预检，不偷换生产2GiB/128pids/2CPU。输出写入仅可信fixture固定小文件；此bind输出方式**没有生产磁盘配额**，绝不能接候选。未实现完整mountinfo/fd/namespace审计、生产资源、真实取消/失联/VM销毁证明或H/B/T无.git快照传输。

`.github/workflows/autopilot-synthetic.yml`现在仅是固定维护分支的一次性push诊断，**不响应PR/Issue，不是常驻候选门**。外置仓库variables `ATM_SYNTHETIC_APPROVED_SOURCE_SHA`须等于待本轮独立复审的源55114549a4f6841789bc3ac14218de0d2641c62b，`ATM_SYNTHETIC_APPROVED_WORKFLOW_SHA`须由独立复审后固定为包含本定义的准确最终commit；默认未配置、不启动job。下一次push before必须为42bb66fb37373a707a8d6c2aa891906be4c4c533，仓库ID/维护分支/actor/event after/github.sha/github.workflow_sha严格一致，强推/删除/未知值拒绝。这是人工bootstrap身份限制，不改变未来全作者Issue接入。

checkout只取待独立批准的源55114549到trusted-bootstrap，绝不checkout待审PR/github.sha；九个实际执行器/harness/fixture的固定SHA256在inline builtin校验后才允许运行。没有npm/package scripts或PR测试宿主执行。checkout/setup-node固定SHA、contents:read、不持久化凭据。job条件在动作前检查外置批准，inline事件门在checkout前再检查。公开只读API核对PR2当前head/base/merge及tree元数据，不下载或执行它们；head不是准确workflow批准值、base变化、merge未知或API失败则停止。driver source与workflow/PR SHA分别记录，不能将driver结果说成验证了PR合并树。

本临时机制不是对有仓库写权限者任意改写/新增workflow的生产防线；未来可信默认workflow/规则隔离仍属Task8/9。下一次只可在独立复审和两个外置准确批准值设置后，普通push最终head获取固定bootstrap的有限诊断；不可单独push中间source commit（它不是最终受审workflow context），不可接任意候选。真实原始inspect全字段、完整cgroup统计/递归清理/VM销毁证据仍缺，不给完整安全证书。现有Mac CI及发布硬禁用不变。


## 启动前外部步骤（本轮不执行）

1. 独立审查准确最终commit/九文件合成bootstrap与workflow；15文件生产批准是另一件未就绪事项。先逐项成功完成[写前只读运行册](../superpowers/runbooks/synthetic-preflight.md)（完整新鲜PR身份门、before/base/actor/九字节/变量不存在与测试），之后有权父助手才可按另行安排的准确最终head/source设置两个临时批准值并普通push最终head采集有限诊断；本轮不设置/推送/运行。若host缺委派，不调整共享box，不自动sudo；保留失败日志，再审一次性VM引导是否需授权。
2. 外部可信操作者审阅root所有批准路径/只读安装树与专用管理身份的具体部署差异；现在无批准、无安装、无unit。
3. 先补齐持锁supervisor、可信enrollment、真正旧进程/远程jobs停止证明及离线备份/回退，再审冷升级；v1历史数据不能通过写一个JSON标记强行接入。
4. 真实hosted五canary及原始inspect/controller值、镜像/Node/runner版本、exact SHA证据通过后，才实施生产adapter与快照/输出配额。`sandbox.mjs`现有候选入口仍SANDBOX_UNAVAILABLE；不是本轮合成运行器的别名。

未遗忘：Task4实际AI/build幂等计时与snapshot失效后的历史结算；Task5/8执行中30min强停与2h runner等待；Task8/9远程副作用查询/重放和终止证明；Task10可信发布链。全部仍在ledger，不进入C。

新workflow用JSON子集序列化（合法YAML），便于在无PyYAML/actionlint、且不安装依赖的环境用标准库精确解析；已验证结构不等于GitHub服务端语义或真实CI通过。


CPU修复：NanoCpus/CpuQuota/CpuPeriod每个已出现字段必须非负安全整数；缺省/0仅是未设置family。quota与period必须成对形成0.25；负数（包括-1无限制）、string/null/小数/溢出/不完整pair均拒绝。保留Nano-only、quota-only、双表示一致。真实Podman兼容仍待固定bootstrap实跑，合成完整inspect对象不冒充真实运行样本。

外置批准缺失/不符导致job skipped时，不能把绿色/跳过的check UI视为canary通过。需要实际执行日志与明确结果；没有任何生产gate消费本诊断check。

Podman4.9.3兼容修复详见运行册第5节：不使用与none网络冲突的DNS参数，不继承宿主DNS；显式只读空resolver与严格三绑定、无外部接口/路由及有界DNS/TCP canary均未获新source真实运行证明。跨平台checksum使用Node内建SHA256、拒symlink，不能把本地158项绿灯叫Mac/容器通过。

## main 0.2.27前向整合边界

本次在独立worktree正常merge main601e777，外部provider/GUI/版本/Homebrew指向均保留，不代表自动化获取导入插件的执行权。原工作树fb19及VSIX删除保持不动；只读预检的本地分支与远端目的分支分开，详见synthetic-preflight。九执行文件与773相同，新source为上述含main的merge提交；workflow最终HEAD必须另审，不沿用fb19批准。ci/release定义相对原fb19未改，发布硬停未解锁；main上的v0.2.27版本/公式是原作者变更，不是本自动维护发布，也未更改外部main发布策略。
