# Autopilot trust manifest（未批准/未部署）

固定仓库shadow-qw/AI-Turn-Meter，repository id `1461122513`。

本轮15文件bundle fingerprint（SHA256，非审批）：`6739527eec425a786cae9b0d67737dfe8f95d060ea4ad1eb4d627656357f2fef`。批准revision仍为**无**；enabled/autoMerge/publish全部false。

| 固定源码 | SHA256 |
|---|---|
| tools/autopilot/contracts.mjs | `adc4d6977916e9b25e83bf7a26c59b0e91c3ddcdf3653661222784ca0ddae815` |
| tools/autopilot/policy.mjs | `03d610e0fd43e99263b5bf724133a143f223abce804adb60d4e89e287a00d995` |
| tools/autopilot/policy.json | `8116b5ab4e50fc76582831f1442effa6789c08d80f5e62bcbffe1e8770878a76` |
| tools/autopilot/state.mjs | `f43af58dcc3851bc712291cf857823bd9e1d9fe53a675cb93878573cf54de919` |
| tools/autopilot/sandbox.mjs | `ac26f575ef3e6ca7825a8d4ea835027792e8afe70fae2ac67cd08a1c6bcaa830` |
| tools/autopilot/deployment_guard.py | `f7f2534dc625efa685ccc53e2e869588bc1f3584e5ff3ffe53d514f4c0758740` |
| tools/autopilot/hosted-preflight/contract.mjs | `ac65bd7acde1c1471a97ac1ac6c9c4138dcfff742b77a456aa57b589bb836433` |
| tools/autopilot/hosted-preflight/host-probe.mjs | `214d04b23dbe92350f1e82abf4e18893522002fe374c5915c90fc842ba2d8a02` |
| tools/autopilot/hosted-preflight/run-synthetic.mjs | `4a7619da39860dfb5c6f3df5bf5eca6db8c91d74e2e0d90fc843b079acf8ee75` |
| tools/autopilot/hosted-preflight/harness.mjs | `df13509af0f39e5f2f4440a9e4a225c3450f04f5676b44cb27d34c747fd2c403` |
| tools/autopilot/hosted-preflight/fixtures/baseline.mjs | `0f8480dbe21cfa51c0acc7c9e213a74fb0471fc73571d9806baff8e102ea8873` |
| tools/autopilot/hosted-preflight/fixtures/cpu.mjs | `c2be86a353ddc000537b7000da19b2eea1009c187074d4f97226aa66a779ec2e` |
| tools/autopilot/hosted-preflight/fixtures/pids.mjs | `47cf55cb7dcca77aa12c1b07c79c6619b006cff933ade077c4416467fdf2cec1` |
| tools/autopilot/hosted-preflight/fixtures/memory.mjs | `eb3452b61450e1bbc27482c485f152d023d72c369a40b2477e8a601a92af1d72` |
| tools/autopilot/hosted-preflight/fixtures/timeout.mjs | `30aa97ffd9be2bc7d336a12178cff6c44d37505fb164169e9e38df19b822961c` |

新增可信模块已扩展固定闭包，不能因为是新文件就绕过批准。该表/自算指纹不是权限；外部root操作者必须审阅准确commit，从checkout外的root所有只读安装和固定批准文件核验全部15文件及revision。现无安装器/生命周期supervisor、已批准部署或真实job停止/带外批准核验adapter。新guard只有冷audit，不自签批准/登记/迁移/启动。

详见[当前边界](state-and-sandbox.md)及[部署与合成合同](deployment-and-hosted.md)。临时Linux VM仅合成CI定义待审，不能运行真实Issue候选；共享box不是沙箱。A历史Mac不等于当前B证据。候选不接触状态/HOME/browser/socket/凭据，发布硬禁用保留。
