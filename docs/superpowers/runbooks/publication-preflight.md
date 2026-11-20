# P：只评估发表既有PR head，不批准诊断

当前实际 `.github/workflows/autopilot-synthetic.yml` 只有literal `${{ false }}` job与`exit 1`单步；没有checkout/metadata/driver/变量解锁路径。未知org/environment/repo批准也不能启动本checkpoint诊断。不要将skipped当canary通过。普通Mac CI定义保持原只读PR机制。

## 只读P门

1. 本次一次live完整PR2与独立远端refs、actor的来源/时间/原文必须保留。若实际快照已变则停止，不复制历史记录充数。以下两个base字段刻意不同，不声称旧API base等于当前main：
   - PR H42bb66fb37373a707a8d6c2aa891906be4c4c533，head.ref docs/issue-autopilot-design-20261119；repo ID1461122513/full_name shadow-qw/AI-Turn-Meter，两侧准确；number2/open/unmerged。
   - 原始API observed base759f3ea525b64281060b14ed43c6f35ae15705c8/ref main、merge_commit_sha=null、mergeable=false/dirty；独立remote head42与main601e7775e5f9b5748f4426cfd0f741e337c2eeca。
2. 保存数据envelope（不是receipt）：键恰好为`purpose: "publication-only-snapshot"`, `pr: 完整原始PR对象`, `refs: {head: 上述42, main: 上述601}`, `actor: "shadow-qw"`, `approvalsObserved: []`。明确已观察到的预设批准非空则停，不覆盖/删除。空列表不证明未知作用域；安全性依赖checkpoint硬停，而非假装枚举完所有vars。数据文件不证明新鲜度/来源，操作者需记录live provenance。
3. 必须由外置独立复审提供准确P SHA和本工具字节摘要；不能从HEAD自动自批。先以Node crypto/O_NOFOLLOW/fstat验证工具普通文件原始SHA256为 `4c71243952c16f4232a973b9eb81f420805ead1d0f8e2c3ef800134f2bff803f`，再用`python3 -I -B tools/autopilot/publication_preflight.py <snapshot.json> <独立受审P完整SHA>`。这不是push命令。
4. CLI只读核验：当前整合树HEAD等于准确P、分支integration/issue-autopilot-main-601e777、index/worktree干净；42与601祖先；本工具与workflow均等于该P的Git字节；workflow严格等于硬停白名单；普通CI/release与原fb19字节相同；原树仍fb19和唯一VSIX删除且binary diff固定相同。工具不联网，不能替代独立fresh refs/PR读取；任何变化都停。
5. 成功只输出purpose=`publication-evaluation`、marker=`PUBLICATION_ONLY_EVALUATION_OK`，diagnosticApproved=false/candidateValidated=false。它只供父助手评估后续普通既有PR head发表，不是GitHub/AI权限，不是诊断凭证；任何异常固定PUBLICATION_ONLY_REJECTED，exit1。不得作为PREFLIGHT_PR_IDENTITY_OK或D证据使用；代码没有phase开关、外部写操作或诊断授权CLI。

## 后续目的分离（本轮不执行）

- 在独立复审准确P且具适用用户授权后，父助手才可单独安排一次普通快进HEAD到既有PR2维护分支，不推main/不新建PR/不推中间source；零诊断批准。另行读取真实发表H=P/B601/T及准确Mac运行。旧B/dirty/null则停止，不把P门说成验证了merge。原worktree不动。
- 只有真实P及新H/B/T可验证，才准备新的独立D提交：source可保留55114549a4f6841789bc3ac14218de0d2641c62b（九文件不变），但before与写前head须为真实已发表P，目标base601，workflow准确D。修改validator字节需重定hash、重新独立审查；不得自批future D、用phase开关解锁P或rerun旧P事件。
- `validate_diagnostic_observation`仅是为未来D测试的数据校验helper：明确不同purpose、发表H/base/T/精确merge父顺序，拒绝P envelope/receipt与null merge；没有D CLI/批准/receipt输出，也没有workflow消费它。未来D仍须自己完整准确身份门与双SHA批准，不能凭此helper或P的Mac结果跳过验证。
- 冻结旧诊断workflow在tests fixture，不在Actions路径、没有任何当前入口执行它。旧漏洞测试仍对其真实inline代码运行本地替身；这些结果不是当前P的容器/候选验收。

P CLI及其新字节是新增可信工具，不包含在旧九driver文件批准内；新P及工具hash必须独立复审。本轮没有发表/vars/CI/容器/生产启用，B/F1仍未完成。人工快照与git检查间仍有TOCTOU，receipt不是生产原子授权或凭据。
