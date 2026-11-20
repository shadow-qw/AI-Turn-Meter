# 固定合成诊断：写入前只读 preflight

这里只检查一次受审固定bootstrap，不是生产Issue入口或不可重放授权系统。
**本文没有设置vars/push命令，不授予外部操作权限。** 必须先成功结束只读阶段，再由有权操作者按单独批准进行写操作；不要把“可能失败的解析”和写操作放在同一Shell用换行串接。

## 1. 固定本次身份，先取完整快照

- source固定`87d3d39d40e63f18752443a6aee10e6797e75adb`；next-before固定`c6c5d4fd0a6ba167f3a2cbcf1fa123ee712656f8`；main/base固定`759f3ea525b64281060b14ed43c6f35ae15705c8`。
- reviewed-head由**独立审查结果**提供完整40hex值，不从当前branch或workflow自动批准。若变化，重新审查；本文不是对未来HEAD的批准。
- 用live GitHub只读工具get_pull_request(owner=shadow-qw, repo=AI-Turn-Meter, pull_number=2)。保存**完整JSON对象**到`/workspace/atm-preflight/pr-before.json`。工具展示/围栏/省略号/截断及工具结果包装不是JSON；必须先读取工具提供的完整原始文件，不能靠正则抽取几段字段或用旧快照补齐。
- 快照必须来自本次live读取，保留来源、时间与原文件。下面检查JSON身份，不证明文件新鲜度或来源，不代替操作者核对live provenance。

## 2. PR身份解析是独立、无写入的硬停止步骤

将下面代码保存到本次证据目录的`validate-pr.py`，然后单独执行：

```bash
set -euo pipefail
python3 -B /workspace/atm-preflight/validate-pr.py /workspace/atm-preflight/pr-before.json
```

成功必须退出0且**只有**`PREFLIGHT_PR_IDENTITY_OK`。任何非零/解析错误/包装/缺字段都停止，禁止继续vars或push。不要凭先前部分可见文本推断“应该通过”。

```python
import json, sys
try:
    with open(sys.argv[1], encoding='utf-8') as f:
        raw = f.read(1048577)
    assert len(raw) <= 1048576
    p = json.loads(raw)
    assert type(p) is dict and type(p['number']) is int and p['number'] == 2
    assert p['state'] == 'open' and p['merged'] is False
    for side in ['head', 'base']:
        repo = p[side]['repo']
        assert type(repo['id']) is int and repo['id'] == 1461122513
        assert repo['full_name'] == 'shadow-qw/AI-Turn-Meter'
    assert p['head']['ref'] == 'docs/issue-autopilot-design-20261119'
    assert p['head']['sha'] == 'c6c5d4fd0a6ba167f3a2cbcf1fa123ee712656f8'
    assert p['base']['ref'] == 'main'
    assert p['base']['sha'] == '759f3ea525b64281060b14ed43c6f35ae15705c8'
except Exception:
    print('PREFLIGHT_PR_REJECTED', file=sys.stderr)
    sys.exit(1)
print('PREFLIGHT_PR_IDENTITY_OK')
```

这检查的是**push前PR head==remote before**，不是尚未推送的新reviewed-head。push后必须live核对新head/base/合成merge；workflow仍会独立验证新head/base/merge parents，不采用box查询结果替代gate。

## 3. 其余只读核对全部成功，记录后结束该阶段

每个Shell从`set -euo pipefail`开始；上一步失败就不要发下一步。不要使用`; true`、`|| true`、`echo exit=$?`后继续写，或在不同工具调用间假定Shell失败会自动阻止后续调用。

- branch必须为`docs/issue-autopilot-design-20261119`；HEAD必须与独立reviewed-head完整相等，index空。
- `git status --porcelain=v1`只能为既有` D dist/ai-turn-meter.vsix`；保留该删除，不restore/stage。出现其他变化停止。
- `git ls-remote origin refs/heads/main refs/heads/docs/issue-autopilot-design-20261119`必须恰好返回上述base与before；before必须是reviewed-head祖先。
- 对workflow固定九摘要，分别比较source Git blob、最终HEAD Git blob和工作树SHA256；每项都相等。不能仅自算当前树或读旧测试报告。
- 核对最终workflow字节：固定action SHA、contents:read、source87d/beforec6、非force/delete、GITHUB_SHA/GITHUB_WORKFLOW_SHA/外置批准相等、单步metadata token env、checkout不持久、driver env-i不变；发布硬失败保持。
- 运行目标`node --test tests/autopilot-bootstrap.test.mjs tests/autopilot-metadata.test.mjs`和`git diff --check`；保存真实退出码及完整证据。
- 正常只读列出repo vars；本次两个临时名称都必须不存在。已有任何值（即使恰好相同）也停止，不擅自覆盖/删除他人配置。不要读取secret/token/认证日志。
- 在写入前再次live核对PR及remote身份。如果刚才工具展示/原文件/解析状态有疑问，停在只读阶段，不补一个“推送后再确认”。

## 4. 外部写入是下一独立授权阶段

只有以上每项已成功且准确reviewed-head另获本次批准，父助手才可单独安排临时双vars、读回、一次普通push最终HEAD、真实run采证和finally清理。中间旧commit不单独推、不force、不自动rerun。新代码或remote变化即停止复用批准。

任何设置/推送/读回失败，先清理**本次确已新建且值仍匹配**的变量并验证，不能删除别人配置。实时metadata失败保持fail-closed；不扩权、不用共享box/其他凭据/跳过SHA门替代。该人工检查表不能消除网络检查与写入之间的竞态，更不是生产Task8/9原子授权门。
