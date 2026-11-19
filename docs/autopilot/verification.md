# 批次 A：修复波后仍待复审，不可合并/发布

审查起点4a6a923，base/main 759f3ea。I1/I2已在本地代码修复；I3–I5选择审查允许的分阶段硬禁用，而非声称实现Task E。A完成状态必须等独立复审及真实Mac证据。

## I1：可识别的包身份不能与稳定声明矛盾

策略同时检查顶层稳定tag/version、GitHub release download tag、项目版本化包文件名、被选中资产名及checksum资产名/URL。显式RC/不同版本拒绝；App下载和checksum响应的最终redirect URL也重新检查。

**自定义feed契约与支持面：** 只接受用户明确配置的可信HTTPS feed；它须准确声明稳定三段版本、不得标draft/prerelease、显式tag/包名/校验对象须互相一致。合法签名query和无flags旧feed继续兼容。对不透明下载URL/通用包名，只信任该用户配置的feed对内容身份的声明；字符串校验没有证明不透明包内的实际版本或来源。若声明checksum，必须校验且错误终止；旧feed未声明checksum的兼容路径不是“完整性已验证”。这类兼容不构成旧稳定客户端/RC channel proof，不能给自动发布授权。以后可信包manifest/证据链需Task E独立审查。

## I2：生产状态机取代弱降级

App只调用Core `UpdateLookup.check`，真实URLSession adapter与测试注入transport共享同一状态机，移除App重复HEAD offer路径。

- 2xx metadata安全拒绝/非法协议响应是终局；404区分为无Release，不进入HEAD。
- 仅网络/服务不可用（含rate limit）可有界恢复：HEAD仅发现同仓库稳定tag → 获取该准确tag的Release metadata → 再次稳定/身份校验，且必须带checksum声明；只HEAD、缺metadata/缺checksum、错版本、坏checksum均不offer。
- 已声明SHA256不再在fallback中丢失；错误字节hash停止下载，不重走lookup。原CryptoKit计算/校验流程保留，比较函数进入Core以便真实测试。
- 正常主路稳定更新及可信旧custom feed正例保留。没有删除有效更新渠道来隐藏失败。

## I3–I5：新发布定义硬禁用，不是已完成的发布功能

本地`release.yml`只有固定`exit 1` job；全局/job仅contents:read，无actions/checkout/脚本/secret/write job/publisher，也无变量或inputs控制放行。tag、dispatch、proof值均不能在这个定义中解锁。分类helper只保留为未获发布权的未来意图测试，不再被workflow调用。

这不阻止有tag写权限者选择历史commit里的旧workflow，亦不改变当前远程定义或权限。仓库级可信workflow来源、不可变tag/source、可信manifest/draft完整性与并发对象策略仍属Task E及部署约束，尚未完成；未证明任何已发生外部攻击。未来stable仍必须本人确认准确对象，不能将暂时禁用当最终发布功能。当前远程不要创建RC tag；本轮未改外部规则/推送/tag/dispatch/发布。

## 测试证据和限制

- I1在实际parser诊断package上先出现多项矛盾包offer红灯，含opaque checksum URL但RC资产名；修复后绿。
- 新增生产SwiftPM transport测试：安全拒绝→预排HEAD成功仍只GET一次；offline/503/rate-limit→HEAD→准确Release带checksum恢复；无Release、错误协议、HEAD-only、缺/错checksum、错版本均停；正常稳定/legacy signed URL正例。它们执行真实Core状态机，不是源码正则。
- 结构检查统一命名wiring contract，不代替行为证明。发布硬禁用测试还执行从该workflow取出的精确`exit 1`命令，在tag/dispatch/proof组合下全部失败。
- Linux诊断package使用实际Models/Policy/Lookup及仅去掉CryptoKit import/hash方法的Checker；不代替完整Mac生产target、CryptoKit或AppKit验收。新加原生实际字节SHA256正确/错误回归留待Mac完整suite。
- CI原有version parity、完整test:all、SwiftPM arm64 build、VSIX检查全部保留，未以skip/断言降级换绿。当前不重复已知Linux无法运行Mac全套的失败命令；普通分支push及真实Mac run仍待本轮复审后执行。
- 旧稳定兼容性/channel proof没有验收；sandbox仍SANDBOX_UNAVAILABLE；B–F未开始。未使用CloudAgent/用户电脑/真实凭据。

准确最终SHA、红绿命令与计数见box报告 `/workspace/atm-phase-a-report.md`；本地提交未push。无自动化已上线声明。
