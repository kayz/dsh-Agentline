# P8：Build 接入

状态：等待 P7 完成后再启动。

## 目标

把 Build 接到 P6/P7 的控制面：

- 复用 K1 `runStep` / `runBuild`
- 来源校验：Blueprint 批准和节点哈希失效时拒绝执行，零模型调用
- 新角色：designer、developer、verifier；兼容旧 design/dev/review
- Build 页读取真实来源、test_levels、T gate、模型、业务轮次/基础设施重试
- `T.ci_all_pass` 缺失证据返回未知，不能把空报告当通过
- 角色锁约束实际调用，实际身份进入证据和 gate
- 不修改 `flow.mjs` 旧语义

## 约束

- 从 P7 合并后的 `main` 创建 `task/005`。
- dev 使用 `cursor-wsl-grok-4.7`（WSL Cursor）。


## 验收格式（必须）

`acceptance.md` 必须使用 `tools/ci-runner.ps1` 可解析格式：每个 `## AC-n` 下一个 ```pwsh 代码块，最后一行输出 `AC-n OK`，并写明期望。

至少覆盖：插件语法；Build 来源校验；K1 step/runBuild 到 pr_open；T gate 缺失证据；角色锁/实际身份；Build UI 真实/空/错误状态；完整回归。
