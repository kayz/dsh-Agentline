# 02 · 本机 DSH 插件（已升级）

> 状态：已实现 · 版本：plugin 0.16.0 · 源码：`C:\git\dsh-agentline-plugin`
> 这是 P3 的真实环境验收方式：不是只看单测，而是从 DSH 驾驶舱发起任务，走完 worktree、队列、输入、CI、评审和合并。
> 已通过 `dsh plugin --profile desktop remove dsh-agentline` 卸载旧版，再用 `dsh plugin --profile desktop add file:C:\git\dsh-agentline-plugin` 安装新版；Host 已挂载，替换后的浏览器端在刷新/重启 DSH 后生效。

## 背景

公开仓库 `dsh-Agentline/orchestrator` 已经是 P3 内核：

- 每任务独立 worktree；
- `.git/agentline` 注册表 + write_scope 队列；
- stall 心跳、note / amendment / attention 输入。

但本机 DSH 插件 `dsh-agentline` 仍指向 `default-workspace/agentline`（P1 之前的版本），
所以从驾驶舱发起的任务还是旧行为。本任务只做「插件接到新内核」，不改内核。

## 范围

1. **AGENTLINE_HOME**
   - 指向 `C:\git\dsh-Agentline\orchestrator`（或把 orchestrator 同步到插件目录）；
   - `AGENTLINE_CLI`、`AGENTLINE_NODE` 随之调整。
2. **metrics 兼容**
   - 插件路由 `/agentline/metrics` 依赖 `lib/collect.mjs`；公开 core 不含本机凭据采集；
   - 方案 A：插件把 metrics 做成可选，缺失时显示 `—`；
   - 方案 B：把 `collect.mjs` 保留在私有 extras，插件按路径加载。
3. **任务发现**
   - 插件 `listTasks` 目前只扫 `.collab/tasks`；需要同时扫 `.collab/worktrees/<id>/.collab/tasks/<id>`；
   - 或调用 `agentline status` / `agentline inputs` 获取权威状态。
4. **通知与总结**
   - `notice.json` / `handoff/` 现在写在 worktree；插件读取路径要跟随 worktree；
   - 驾驶舱展示 worktree、队列原因、当前 stage。
5. **输入面板**
   - 增加 note / amendment / answer 的发送入口（调用 `agentline input/answer`）；
   - 展示 pending inputs 与 attention 问题。
6. **不触碰**
   - 不把本机 key、凭据、绝对路径写进公开仓库；
   - 不改变内核的合并闸门（人类许可）。

## 验收方式（P3 真实环境）

在 DSH 驾驶舱里对 `fovea` 或临时仓库执行：

1. **worktree**：发起 task 001，确认主工作区仍在 `main`，任务在 `.collab/worktrees/001`；
2. **状态**：驾驶舱显示 `designed/implemented/...`，`agentline status` 与面板一致；
3. **note**：dev 运行中发一条 note，下一阶段 prompt 可见，阶段结束后 `inputs` 显示 consumed；
4. **amendment**：dev 运行中发 amendment，阶段末 blocked(`amendment_pending`)；`flow --resume` 后退回 design 并重新验收；
5. **attention**：designer 写 `attention.json` 后流程停在 `awaiting_human`；驾驶舱回答后 `flow --resume` 继续；
6. **queue**：两个 `write_scope` 相交的任务，第二个显示 queued；不相交的两任务并行；
7. **merge**：驾驶舱点合并（人类许可）后 worktree 删除、分支删除、main 更新；
8. **安全**：公开配置无 key、无本机绝对路径；插件日志不含凭据。

通过标准：以上 8 条全绿，且 `agentline check --task <id>` 对完成任务返回 PASS。
