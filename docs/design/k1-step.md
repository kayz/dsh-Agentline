# K1 Step Executor（P4.1）

状态：单步执行器 seed，已接入 CLI；worktree/锁/Supervisor 全量集成仍是 P4.2
日期：2026-11-06

## 已完成

- `orchestrator/lib/step.mjs`
  - `nextStep(state)`：draft→design→dev→ci→review→pr
  - `runStep({step})`：只执行一个步骤，不自动跑下一步
  - `runBuild({maxSteps})`：最小 Supervisor 循环，逐步执行并在失败/预算处停止
- CLI：
  - `agentline build plan --task 001 [--json]`
  - `agentline build step --task 001 [--step design|dev|ci|review|pr]`
  - `agentline build run --task 001 [--max-steps 10]`
- 测试：
  - `nextStep` 状态映射
  - design 只调用一次模型
  - design → dev 两次调用
  - 错误步骤不调用模型
  - Supervisor 预算停止

## 当前限制

`runStep` 只接受已定位的任务目录，**不创建 worktree、不获取 task lock、不申请执行槽**。  
这是刻意的 P4.1 边界：先固定单步状态迁移和 CLI 契约，P4.2 再把 Supervisor 接到 worktree/锁/容量上。

因此：

- `build run` 适合在已有任务目录、单任务、无并发场景使用；
- 并发/多 worktree/崩溃恢复仍应使用现有 `flow`，或等 P4.2；
- `runStep` 不替代 `runFlow`，`flow.mjs` 旧语义不变。

## P4.2 待做

1. `ensureTaskWorktree` + `acquireTaskLock` + `acquireCapacity` 包住每一步；
2. 输入账本/终止证明接入；
3. step ledger（step.begin/end、call.archive/end）；
4. 失败/取消/恢复的单一恢复结果；
5. 插件 `build step` 命令与 Supervisor 状态。
