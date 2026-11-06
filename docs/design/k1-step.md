# K1 Step Executor（P4）

状态：P4.1 单步执行器 + P4.2 worktree/lock/capacity/step ledger 已完成；P4.3 输入账本/终止证明仍待接
日期：2026-11-06

## 已完成

- `orchestrator/lib/step.mjs`
  - `nextStep(state)`：draft→design→dev→ci→review→pr
  - `runStep({step})`：只执行一个步骤，不自动跑下一步
  - `runBuild({maxSteps})`：最小 Supervisor 循环
    - `ensureTaskWorktree` 创建/复用 worktree
    - `acquireTaskLock` 防止同任务并发
    - dev 前 `acquireCapacity`，按 design 的 write_scope 排队
    - 每步写 `step-ledger.jsonl`（step.begin/step.end）
    - 结束释放 capacity/task lock
- CLI：
  - `agentline build plan --task 001 [--json]`
  - `agentline build step --task 001 [--step design|dev|ci|review|pr]`
  - `agentline build run --task 001 [--max-steps 10]`
- 测试：
  - state mapping、单步模型调用、错误步骤不调用模型
  - Supervisor 预算停止
  - worktree + task lock + step ledger
- 未改 `flow.mjs` 旧语义；`runFlow` 仍是完整 Build 入口。

## P4.3 待接

1. 输入账本（`inputs.ledger.jsonl` / 确定性 note）进入 `runStep`；
2. 终止证明（tree guard）进入 `runBuild` 的 resume 判定；
3. `call.archive` / `call.end` 逐调用证据；
4. 失败/取消/恢复的单一恢复结果；
5. 插件侧 `build step` 状态展示。

## 使用边界

- `build run` 现在创建 worktree 并持锁，适合单任务；
- 跨项目并发仍受 `acquireCapacity`/`maxTasks` 限制；
- `build step` 本身不创建 worktree，适合 Supervisor/调试；
- 输入/终止的完整 K1 语义仍以 v7 契约和 P4.3 为准。
