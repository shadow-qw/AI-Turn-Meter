# Autopilot trust manifest（未批准/未部署）

固定仓库：shadow-qw/AI-Turn-Meter，GitHub repository id `1461122513`。来源为已核对的官方GitHub live CI run repository.id（run44661626585），不是Issue字段。

本轮bundle fingerprint（SHA256，非审批）：`04ffb94de2151c8c78757efd408d0e7e05b34c8ee9fc208aa4b9ed0bf5e99f44`。可信模块改动必须重新生成/独立审阅；添加可信模块必须扩展固定bundle清单，不能因文件不在旧清单就允许执行。

| 固定源码 | SHA256 |
|---|---|
| tools/autopilot/contracts.mjs | `adc4d6977916e9b25e83bf7a26c59b0e91c3ddcdf3653661222784ca0ddae815` |
| tools/autopilot/policy.mjs | `3d80820b0204341e9396b41d555544e6e32551ad824e9bff5ec2752122335e34` |
| tools/autopilot/policy.json | `8116b5ab4e50fc76582831f1442effa6789c08d80f5e62bcbffe1e8770878a76` |
| tools/autopilot/state.mjs | `f43af58dcc3851bc712291cf857823bd9e1d9fe53a675cb93878573cf54de919` |
| tools/autopilot/sandbox.mjs | `ac26f575ef3e6ca7825a8d4ea835027792e8afe70fae2ac67cd08a1c6bcaa830` |

## 批准与部署状态

- approved deployment revision：**无**；enabled=false、autoMerge=false、publish=false。本文件及模块自算hash都不能自我授权。
- 后续安装器/启动器必须从独立人工审阅的Git commit与外置只读manifest核对全部可信字节，部署到checkout外只读version目录；不得从候选checkout或Issue加载策略/脚本/approvalId。
- 当前没有安装器/启动器、部署目录或权限接线，也没有受信GitHub写入adapter；仅有内部离线库。本文件不是完整boot签名/供应链验证实现，下一阶段缺批准或hash不匹配必须拒绝启动。
- 候选不得挂载可信目录/状态库/浏览器/HOME/socket。共享box同UID不是隔离。未来运行身份的仓库读/PR写/发布写须分离；本检查点未授予/扩大任何权限，发布仍硬禁用。
- `state-and-sandbox.md`列出真实恢复、预算采集、运行时、部署位置及验收缺口；真实macOS A run不等于新B代码已在Mac跑过。
