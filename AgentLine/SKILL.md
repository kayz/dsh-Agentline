---
name: AgentLine
description: 设计→开发→验证三角色协作协议。当任务需要不同 agent 或模型分别设计、实现、验收，并通过 .collab/tasks/<NNN>/ 下的固定文件交接时使用。
version: 0.1.0
---

# AgentLine

## 何时使用

- 任务需要 designer、developer、verifier 分阶段交接。
- 开发与验证需要使用不同模型，并记录模型信息。
- 验收需要通过可独立运行的 PowerShell 7 命令复现。
- 需要保留设计、实现说明、验证结论与原始执行输出。

单人小改动、无需独立验收的任务通常不需要本协议。本 skill 约定人工或 agent 的交接行为，不提供调度器、模型 API 调用、多任务并发或锁。

## 角色

### designer（设计）

- 输入：brief.md。
- 输出：design.md、acceptance.md。
- 明确目标、非目标、写入范围和判定逻辑；禁止写产品代码。

### developer（开发）

- 输入：brief.md、design.md、acceptance.md。
- 输出：产品代码、impl.md，记录逐条 AC 自测结果。
- 填写 state.json 的 dev_model；禁止修改 design.md、acceptance.md。

### verifier（验证）

- 输入：全部交接文件及产品代码。
- 输出：run.log、review.md；禁止修改产品代码。
- 填写 state.json 的 verifier_model，通过模型隔离检查后逐条执行验收命令。

## 交接文件

任务目录固定为 `.collab/tasks/<NNN>/`，NNN 为三位补零编号，例如 `001`。任务目录仅放以下七个文件；从 [templates/](templates/) 取六个模板，run.log 在验证时生成。

| 文件名 | 写入者 | 内容 | 写入时机 |
|---|---|---|---|
| brief.md | 人 / 发起方 | 目标、约束、建议验收方向、非目标 | 任务开始前 |
| design.md | designer | 目标与非目标、结构、接口与判定逻辑、写入范围 | design 阶段 |
| acceptance.md | designer | AC 编号、单行命令、明确期望 | design 阶段 |
| impl.md | developer | 变更清单、逐条 AC 自测、偏离及原因、遗留问题 | develop 阶段结束时 |
| review.md | verifier | PASS/FAIL、双方模型信息、逐条 AC 结果、问题清单 | verify 阶段结束时 |
| state.json | 当前阶段的角色 | task、phase、dev_model、verifier_model、round、updated | 每次阶段切换时 |
| run.log | verifier | 每条 AC 的命令、退出码和原始输出 | verify 阶段，只追加 |

state.json 的 task 是三位任务号字符串；phase 只能是 brief、design、develop、verify、done、blocked。dev_model 和 verifier_model 分别由对应角色填写实际模型标识，updated 使用 ISO 8601 时间。round 从 0 开始。

## 流程

1. 发起方准备 brief.md，确定任务范围，并以模板初始化 state.json，phase 为 brief。
2. designer 阅读 brief.md，进入 design，交付 design.md 与 acceptance.md，然后将 phase 更新为 develop。
3. developer 完整阅读上述三份文件，记录 dev_model，按设计实现并自测；完成 impl.md 后将 phase 更新为 verify。
4. verifier 记录 verifier_model，先检查模型隔离规则，再独立执行各条 AC。每轮向 run.log 追加 `=== round <n> <ISO8601> ===`，随后追加每条命令、退出码及原始输出，并在 review.md 记录结果。
5. 全部通过：phase 更新为 done。verify 未通过：round 加 1，phase 返回 develop，developer 根据 review.md 修复后再次交接；round 超过上限时将 phase 设为 blocked，交给人处理，上限以 `squad.yaml` 的 `review_rounds.max_rounds` 为准。

阶段顺序为 brief → design → develop → verify → done。每个角色结束时更新 state.json 的 phase 和 updated；状态不会自动推进。

## 规则

1. 每个角色只写自己负责的交接文件（见上表）；产品代码写入范围以 design.md 为准，state.json 由当前阶段角色维护。
2. 验证模型不得与开发模型相同：verifier 开始前比较 state.json 的 dev_model 与 verifier_model，相同或任一为空则拒绝验证，并在 review.md 写明原因。模型标识只记录和比较，不请求 API 校验其真实性。
3. acceptance.md 只能由 designer 修改。developer 认为某条无法执行时，在 impl.md 写明原因并退回 design，不自行修改 design.md 或 acceptance.md。
4. 每条验收必须是 PowerShell 7 单行命令、零第三方依赖、能独立判定通过或失败；acceptance.md 使用 `## AC-n 标题`、`- 命令:`、`- 期望:` 格式。
5. 交接文件名全部小写、固定，不加日期、前缀、后缀或版本号；修改时覆盖原文件，历史版本靠 git 保留；run.log 只能追加。

## 并发约定

锁由调度器 `flow` 实现，本 skill 本身不提供锁，以下只记录使用时要遵守的约定。

1. 同一仓库同一时刻只允许一个 `flow` 运行。后启动的 `flow` 会打印锁持有者信息并以退出码 2 退出，不会排队等待。
2. 锁文件为仓库根下的 `.collab/.flow.lock`，内容是 JSON，字段依次为 pid、host、at、task、cmd（持有进程号、主机、加锁时间、任务号、命令）。它是运行时文件，不属于交接文件。
3. 遇到退出码 2 时，先在锁文件 host 对应的机器上确认 pid 对应的进程是否仍在运行：仍在运行就等它结束后再跑，不要删除锁文件；进程已死（例如被 kill -9）可直接重跑 `flow`，它会判定 pid 已死并自动接管旧锁，无需手动删除。
4. 锁是仓库级兜底，不是替代池策略：哪些任务串行、哪些并行仍按「同池串行、跨池并行」安排；锁只保证同一仓库不会同时有两个 `flow` 进程，不改变池策略本身。

## 自检

在 PowerShell 7 执行 `pwsh -NoProfile -File AgentLine/tools/check-skill.ps1`。也可使用 `-SkillRoot <path>` 指定 skill 根目录；默认不依赖当前工作目录。

脚本只读检查本 skill 的编码、元数据、必要章节、角色、交接文件名、模型隔离规则及模板。它不检查任务目录、内容质量，也不执行任务验收；全部通过时末行输出 PASS 并退出 0。

## 失败模式速查

执行失败（认证失效、传输层故障）不改 round，按下表重跑；验收不通过按「流程」第 5 步推进 round。

| 现象 | 判定 | 处置 |
|---|---|---|
| 认证失效：CLI 报 401/403、token 过期或提示未登录，角色没有产出交接文件 | 错误信息指向认证或登录；不重新登录则每次重跑都以同样错误失败 | 由人重新登录后以同一角色原样重跑；重跑最多 2 次，换模型不升深度，仍失败则将 state.json 的 phase 设为 blocked，交给人处理 |
| 后端传输层故障：连接超时、中途断流、代理或 DNS 错误，或 CLI 版本过旧导致与后端不兼容 | 错误来自 CLI 或网络而非任务内容；CLI 版本低于后端要求，或网络连通性检查失败 | 升级 CLI 或恢复网络后重跑同一角色；重跑最多 2 次，换模型不升深度，换模型后同步更新 state.json 的 dev_model 或 verifier_model 并重新做模型隔离检查，仍失败则将 phase 设为 blocked |
| 验收不通过：verifier 判定 needs_revision | review.md 结论为 FAIL（needs_revision），问题清单列出待修复项 | round 加 1、phase 返回 develop，developer 按 review.md 逐项修复并更新 impl.md 后再次交给 verify；round 超过上限时将 phase 设为 blocked，交给人处理，上限以 `squad.yaml` 的 `review_rounds.max_rounds` 为准 |
