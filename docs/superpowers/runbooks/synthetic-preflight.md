# 冻结的旧诊断预检：仅离线回归，不是当前操作入口

**当前发表checkpoint P已将实际synthetic workflow固定硬停。以下旧门只作离线回归，不得执行此旧单阶段清单来配置vars/push，也不是未来D的批准。** 当前发表入口见publication-preflight.md；未来D须在P真实发表及新H/B/T后另建准确checkpoint/validator/hash/before，不能重跑P旧事件。

这里只保留此前受审固定bootstrap的安全回归，不是生产Issue入口或不可重放授权系统。
**本文没有设置vars/push命令，不授予外部操作权限。** 必须先成功结束只读阶段，再由有权操作者按单独批准进行写操作；不要把“可能失败的解析”和写操作放在同一Shell用换行串接。

## 1. 固定本次身份，先取完整快照

- source固定`55114549a4f6841789bc3ac14218de0d2641c62b`；next-before固定`42bb66fb37373a707a8d6c2aa891906be4c4c533`；main/base固定`601e7775e5f9b5748f4426cfd0f741e337c2eeca`。
- reviewed-head由**独立审查结果**提供完整40hex值，不从当前branch或workflow自动批准。若变化，重新审查；本文不是对未来HEAD的批准。
- 用live GitHub只读工具get_pull_request(owner=shadow-qw, repo=AI-Turn-Meter, pull_number=2)。保存**完整JSON对象**到`/workspace/atm-preflight/pr-before.json`。工具展示/围栏/省略号/截断及工具结果包装不是JSON；必须先读取工具提供的完整原始文件，不能靠正则抽取几段字段或用旧快照补齐。
- 快照必须来自本次live读取，保留来源、时间与原文件。下面检查JSON身份，不证明文件新鲜度或来源，不代替操作者核对live provenance。

## 2. PR身份解析是独立、无写入的硬停止步骤

将下面唯一Python代码块逐字节保存到本次证据目录的`validate-pr.py`（UTF-8、LF、恰好一个末尾换行），然后单独执行。Node内建crypto对原始字节核验，不依赖GNU sha256sum选项；O_NOFOLLOW与fstat拒绝脚本symlink/非普通文件。先核对文件与经独立审查的本提交内固定SHA256，不运行任意复制/变更版本；固定摘要不是自行批准新版本的权限：

```bash
set -euo pipefail
node --input-type=commonjs -e '
const fs=require("node:fs"),crypto=require("node:crypto"),p="/workspace/atm-preflight/validate-pr.py";
const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
try {
 if(!fs.fstatSync(fd).isFile()||crypto.createHash("sha256").update(fs.readFileSync(fd)).digest("hex")!=="ddcf50dc5f675a1910f90bddb923402c4f48354671c07059371d5bdd383fe1c6")process.exitCode=1;
} finally {fs.closeSync(fd);}
'
python3 -B /workspace/atm-preflight/validate-pr.py /workspace/atm-preflight/pr-before.json
```

身份/大小检查使用显式require/异常，不使用可被Python优化编译删除的assert。保留PYTHONOPTIMIZE或使用-O/-OO时仍必须正确拒绝；不能靠删环境变量掩盖。安全判断不依赖__debug__。

成功必须退出0且**只有**`PREFLIGHT_PR_IDENTITY_OK`。任何非零/解析错误/包装/缺字段都停止，禁止继续vars或push。不要凭先前部分可见文本推断“应该通过”。

```python
import json, sys

def require(ok):
    if not ok:
        raise ValueError('rejected')

try:
    with open(sys.argv[1], encoding='utf-8') as f:
        raw = f.read(1048577)
    require(len(raw) <= 1048576)
    p = json.loads(raw)
    require(type(p) is dict and type(p['number']) is int and p['number'] == 2)
    require(p['state'] == 'open' and p['merged'] is False)
    for side in ['head', 'base']:
        repo = p[side]['repo']
        require(type(repo['id']) is int and repo['id'] == 1461122513)
        require(repo['full_name'] == 'shadow-qw/AI-Turn-Meter')
    require(p['head']['ref'] == 'docs/issue-autopilot-design-20261119')
    require(p['head']['sha'] == '42bb66fb37373a707a8d6c2aa891906be4c4c533')
    require(p['base']['ref'] == 'main')
    require(p['base']['sha'] == '601e7775e5f9b5748f4426cfd0f741e337c2eeca')
except Exception:
    print('PREFLIGHT_PR_REJECTED', file=sys.stderr)
    sys.exit(1)
print('PREFLIGHT_PR_IDENTITY_OK')
```

这检查的是**push前PR head==remote before**，不是尚未推送的新reviewed-head。push后必须live核对新head/base/合成merge；workflow仍会独立验证新head/base/merge parents，不采用box查询结果替代gate。

## 3. 其余只读核对全部成功，记录后结束该阶段

每个Shell从`set -euo pipefail`开始；上一步失败就不要发下一步。不要使用`; true`、`|| true`、`echo exit=$?`后继续写，或在不同工具调用间假定Shell失败会自动阻止后续调用。

- 本地整合worktree必须为`/workspace/AI-Turn-Meter-integration`、branch为`integration/issue-autopilot-main-601e777`；HEAD必须与独立reviewed-head完整相等，index空。未来获批推送目的仍固定`refs/heads/docs/issue-autopilot-design-20261119`，不是自动取本地branch；只允许普通HEAD到该目的分支的快进。
- 整合worktree的`git status --porcelain=v1`必须为空；原`/workspace/AI-Turn-Meter`仍停在fb19，且只能有既有` D dist/ai-turn-meter.vsix`。保留原删除，不restore/stash/stage，也不把原工作树改到整合HEAD。任一worktree出现其他变化停止。
- `git ls-remote origin refs/heads/main refs/heads/docs/issue-autopilot-design-20261119`必须恰好返回上述base与before；before必须是reviewed-head祖先。
- 对workflow固定九摘要，分别比较source Git blob、最终HEAD Git blob和工作树SHA256；每项都相等。不能仅自算当前树或读旧测试报告。
- 核对最终workflow字节：固定action SHA、contents:read、source`55114549a4f6841789bc3ac14218de0d2641c62b`/before`42bb66fb37373a707a8d6c2aa891906be4c4c533`、非force/delete、GITHUB_SHA/GITHUB_WORKFLOW_SHA/外置批准相等、单步metadata token env、checkout不持久、driver env-i不变；发布硬失败保持。
- 正常只读核对GitHub当前actor必须是`shadow-qw`，不读取token/认证日志。
- 运行目标`node --test tests/autopilot-bootstrap.test.mjs tests/autopilot-metadata.test.mjs`和`git diff --check`；保存真实退出码及完整证据。
- 正常只读列出repo vars；本次两个临时名称都必须不存在。已有任何值（即使恰好相同）也停止，不擅自覆盖/删除他人配置。不要读取secret/token/认证日志。
- 在写入前再次live核对PR及remote身份。如果刚才工具展示/原文件/解析状态有疑问，停在只读阶段，不补一个“推送后再确认”。

## 4. 外部写入是下一独立授权阶段

只有以上每项已成功且准确reviewed-head另获本次批准，父助手才可单独安排临时双vars、读回、一次普通push最终HEAD、真实run采证和finally清理。中间旧commit不单独推、不force、不自动rerun。新代码或remote变化即停止复用批准。

任何设置/推送/读回失败，先清理**本次确已新建且值仍匹配**的变量并验证，不能删除别人配置。实时metadata失败保持fail-closed；不扩权、不用共享box/其他凭据/跳过SHA门替代。该人工检查表不能消除网络检查与写入之间的竞态，更不是生产Task8/9原子授权门。

本次source是正常merge提交`55114549a4f6841789bc3ac14218de0d2641c62b`，含main `601e7775e5f9b5748f4426cfd0f741e337c2eeca`，九个执行文件字节与历史773一致但仍需要对新source/final独立审查；没有自动批准。写前live PR的base字段也必须已经准确等于上述main；旧API快照B759/dirty/null不得代用。若尚未刷新或任一远端再变化，停止而非放宽门。

## 5. Podman 4.9.3 兼容合同（待新revision独立审查/真实采证）

本地source只是审查对象，不是已批准运行。此前87d/42批准不能用于本source；本次没有配置vars/push/运行容器。

- 官方4.9.3 [run手册](https://docs.podman.io/en/v4.9.3/markdown/podman-run.1.html#dns-ipaddr)明确`--dns=none`也不得与`--network=none`组合；其语义只是保留image内resolver，并非保证空DNS。**不删除无网要求**，保留none独立network namespace，并用本次私有root下新建的零字节、0444普通文件只读bind到`/etc/resolv.conf`，不复制宿主resolver。
- 非tmpfs用户挂载严格为三个且Type=bind、Source/Destination/RW全部准确：`root/src → /src ro`、`root/out → /out rw`、`root/resolv.conf → /etc/resolv.conf ro`。缺失、额外、重复、错误来源/类型、可写resolver均在start前拒绝。官方[inspect生成源码](https://github.com/containers/podman/blob/v4.9.3/libpod/container_inspect.go)的GetMounts排除tmpfs，故不是接受任意Mounts或放宽成“至少三个”。
- 显式`--read-only-tmpfs=false`防Podman自动增加/var/tmp等可写tmpfs，只保留固定32MiB /tmp与4MiB /run；out bind用4.9手册明确支持的`ro=false`（不依赖仅image部分列出的rw别名）。其余user/capabilities/seccomp/no-new-privileges/PID/IPC/cgroup私有、128MiB内存+零swap/32pids/0.25CPU、env-i/unsetenv-all/无proxy/不可变image/私有storage与空hooks均不放宽。
- 固定baseline实际运行时强制：空resolver且不可写、/proc/net/dev只有lo、os.networkInterfaces只有loopback地址、IPv4无路由项、IPv6只允许lo条目（含内核unreachable loopback条目），再做有界DNS失败与直接IP TCP不可达验证。contract.mjs同为九摘要内文件，复制进/src供baseline导入纯证据校验函数。其他fixture、start barrier和严格CPU矛盾拒绝保持。
- 宿主probe通过后立即记录经校验host字段、image校验后立即记录固定digest/amd64，避免失败前完全丢失已通过边界；不打印任意API响应/凭据。这里只表示将要采集，并无本revision真实runtime结果。
- [全局手册](https://docs.podman.io/en/v4.9.3/markdown/podman.1.html)支持root/runroot/hooks-dir/cgroup-manager；run手册覆盖所有固定create/run参数。文档/源码核对不是本机CLI或实际容器验收；rootless映射/可写委派、内核/OCI权限、实际inspect形状和mount优先级、五canary及销毁仍须独立复审后在一次临时Ubuntu runner真实验证。未知或不符必须停，不能自动放宽/换rootful/共享box。

checksum/JSON校验之间仍有同UID文件替换TOCTOU；该人工只读预检不是生产FD生命周期、锁或原子授权系统。完整F1和生产SANDBOX_UNAVAILABLE不因这些兼容修复解除。修改了固定source/九摘要/next-before，最终workflow SHA必须由独立审查与适用用户授权另行确认，不能从本地自动批准。
