# Autopilot 验证状态

## 批次 A：基线 CI

- Task0基线修复已独立审阅：真实时钟，空HOME＋独立XDG及XDG未设均42/42通过，无跳过。修复仅测试fixture，不改变产品凭据/过期逻辑。
- `baseline/node`检查PR的GitHub合并测试SHA（`github.sha`），不是仅head分支；checkout后断言实际HEAD准确匹配事件SHA。push事件仅main。
- permissions仅contents:read；PR无secrets；checkout `persist-credentials:false`；测试子进程以`env -i`和空HOME/XDG运行，无账号、缓存、安装/发布步骤。
- Node固定major24，不依赖runner默认版本。actions SHA由官方Git仓库tag核验（2026-11-19 Asia/Shanghai）：checkout v4.3.1=`34e114876b0b11c390a56381ad16ebd13914f8d5`，setup-node v4.4.0=`49933ea5288caeca8642d1e84afbd3f7d6820020`。
- CI定义的静态契约测试不是GitHub实际run证明；尚未推送本轮实现，无run URL。本检查不是后续autopilot可信SHA合并gate，也未配置required checks或自动合并。
