---
name: AgentLine
description: 设计→开发→验证三角色协作协议。当任务需要不同 agent 或模型分别设计、实现、验收，并通过 .collab/tasks/<NNN>/ 下的固定文件交接时使用。
version: 0.4.0
---

# AgentLine

## 何时使用

- 任务需要 designer、developer、verifier 分阶段交接。
- 开发与验证需要使用不同模型，并记录模型信息。
- 验收需要通过可独立运行的 PowerShell 7 命令复现。
- 需要保留设计、实现说明、验证结论与原始执行输出。

单人小改动、无需独立验收的任务通常不需要本协议。本 skill 约定人工或 agent 的交接行为；调度器（`orchestrator/`）是可选实现，负责建分支、派活、CI、评审与交班。

## 上游三阶段（可选）

AgentLine 核心只负责 **Build**：一个任务的 design → develop → verify。
在它之前可以有可选的 **Studio**（多模型讨论/立项）和 **Blueprint**（系统设计、任务图、测试架构）两个控制面阶段。三阶段的角色、闸门、测试设计时机和模型隔离见
[`docs/03-three-stage-pipeline.md`](../docs/03-three-stage-pipeline.md)。

该文档是协议层扩展，调度器尚未内置 `blueprint` 命令；不要把它写成已经实现的能力。

## 角色

### designer（设计）

- 输入：brief.md。
- 输出：design.md、acceptance.md。
- 明确目标、非目标、写入范围（`write_scope`）、失败/取消边界、资源约束和判定逻辑；禁止写产品代码。

### developer（开发）

- 输入：brief.md、design.md、acceptance.md。
- 输出：产品代码、impl.md，记录逐条 AC 自测结果。
- 填写 state.json 的 dev_model；禁止修改 design.md、acceptance.md。
- 只能写 design 的 `write_scope` 允许的路径。

### verifier（验证；调度器中对应 review）

- 输入：全部交接文件及产品代码。
- 输出：run.log、review.md（或 review-r<N>.md）、verdict.json（或 verdict-r<N>.json）。
- 不得修改产品代码；通过模型隔离检查后逐条执行验收命令。

## 交接文件

任务目录固定为 `.collab/tasks/<NNN>/`，NNN 为三位补零编号，例如 `001`。

### 手动模式（7 个文件）

从 [templates/](templates/) 取六个模板，run.log 在验证时生成。

| 文件名 | 写入者 | 内容 | 写入时机 |
|---|---|---|---|
| brief.md | 人 / 发起方 | 目标、约束、建议验收方向、非目标 | 任务开始前 |
| design.md | designer | 目标与非目标、结构、接口与判定逻辑、写入范围 | design 阶段 |
| acceptance.md | designer | AC 编号、单行命令、明确期望 | design 阶段 |
| impl.md | developer | 变更清单、逐条 AC 自测、偏离及原因、遗留问题 | develop 阶段结束时 |
| review.md | verifier | PASS/FAIL、双方模型信息、逐条 AC 结果、问题清单 | verify 阶段结束时 |
| state.json | 当前阶段的角色 | task、phase、dev_model、verifier_model、round、updated | 每次阶段切换时 |
| run.log | verifier | 每条 AC 的命令、退出码和原始输出 | verify 阶段，只追加 |

### 调度器模式（附加机器产物）

Orchestrator 模式下，任务目录还会出现：

| 文件 | 写入者 | 内容 |
|---|---|---|
| run.json | 调度器 | 每次执行的候选、模型、effort、退出码、耗时、usage、日志路径 |
| ci-results.json | CI | 每条 AC 的命令、退出码、原始输出、passed/total |
| verdict.json / verdict-r<N>.json | verifier | verdict、passed/total、findings、被验收的 git_sha |
| logs/ | 调度器 | 每次执行的原始 CLI 输出 |
| handoff/ | 调度器 | 换候选时的 checkpoint 与交班单 |
| notice.json | 调度器 | 任务结束通知（pr_open / merged / blocked） |
| live.json / control.json | 调度器 | 运行中状态与控制面（运行时文件，不是证据） |

## 状态与产物

### 手动模式（phase）

`brief` → `design` → `develop` → `verify` → `done`；超过轮次上限为 `blocked`。
每阶段结束由当前角色更新 state.json 的 phase 与 updated；状态不会自动推进。

### 调度器模式（status）

`draft` → `designed` → `implemented` → `reviewable` → `reviewed` → `pr_open` → `merged`；失败为 `blocked`。

调度器写 state.json 的 `id`（手动模板用 `task`），`check-task.ps1` 两者都接受。

| status | 必需证据 |
|---|---|
| draft | brief.md、state.json |
| designed | + design.md、acceptance.md |
| implemented | + impl.md、run.json |
| reviewable | + ci-results.json |
| reviewed | + review*.md、verdict*.json |
| pr_open | + state.pr.branch、state.merge_risk（等待人类许可合并） |
| merged | + state.pr.sha、state.pr.permission、state.pr.permission_kind（`explicit` / `grant`，后者带 `grant_id`） |
| blocked | + state.blocked_reason；已有产物保留 |

### 证据与模型隔离

- **没有 run.json 的执行不算数**；没有 ci-results.json 的验收不算数。
- 模型隔离以 `run.json` 的 `model_resolved`（回退 `model_requested`）为准，不采信 state 里自填的模型名。
- `verdict*.json` 必须包含 `verdict`、`passed`、`total`、`findings`、`git_sha`；`git_sha` 必须是当前 HEAD 的祖先。
- 评审引用 CI 的每条命令与退出码；不能只写「我看过了」。

### write_scope（机器可读的写入范围）

designer 在 design.md 的 YAML front matter 里声明允许写入的路径（相对仓库根，`*` 匹配单段，`**` 匹配多段）：

```markdown
---
write_scope:
  - crates/app/src/**
  - crates/app/tests/**
---
```

developer 只能修改这些路径；`check-task.ps1` 会用 git diff 校验，越界即失败。`write_scope: []` 表示本任务不改产品代码。

调度器模式下 write_scope 必须声明：design 阶段结束时 design.md 没有 write_scope，调度器会追加一条 note 要求 designer 补写并重跑一次 design；仍然没有则 blocked(`write_scope_missing`)。

### 合并分档

到 `pr_open` 时调度器写入 `state.merge_risk`（`tier`、`reasons`、`metrics`、`limits`），分两档：

| 档位 | 条件 | 合并方式 |
|---|---|---|
| low | 评审 ≤ 3 轮；声明了 write_scope 且改动全部落在其中；改动 ≤ 8 个文件且增删 ≤ 3000 行 | 可以用预授权（`merge --grant`） |
| confirm | 任一条件不满足 | 必须逐个任务给出 `--permission "<用户原话>"` |

- 统计基于 `main...task/<NNN>` 的 diff，任务自己的 `.collab/tasks/<NNN>/` 不计入；阈值可在 `policy.merge.low` 或 `.collab/agentline.json` 的 `merge.low` 覆盖。
- 预授权把用户的口头授权变成记录：有任务范围、有时限（≤ 168 小时）、带用户原话，可撤销，存放在 `<repo>/.git/agentline/grants.json`。
- `merge --check` 只评估不合并；`--grant` 与 `--permission` 只能二选一；confirm 档拒绝 `--grant`。
- 预授权防的是临场批量放行，不防伪造：CLI 无法验证调用者是不是人，所以 agent 只能在用户明确说出授权时创建 grant，并把原话写进 `--text`。

## 流程

1. 发起方准备 brief.md，确定任务范围，并以模板初始化 state.json。
2. designer 阅读 brief.md，进入 design，交付 design.md 与 acceptance.md，声明 write_scope，然后将 phase/status 推进到下一阶段。
3. developer 完整阅读上述文件，记录 dev_model，按设计实现并自测；完成 impl.md 后推进状态。
4. CI 逐条执行 acceptance.md：命令退出码 0 且输出包含 `AC-n OK` 才算通过；原始输出写入 ci-results.json。
5. verifier 记录 verifier_model，先检查模型隔离规则，再独立复核；写 review.md 与 verdict.json。
6. 全部通过：进入 reviewed / pr_open，等待人类许可后合并。未通过：round 加 1，developer 按 findings 修复后再次交接；超过上限进入 blocked。

调度器模式另有换候选交班：新的候选先读 handoff 单，明确选择保留现场继续或回滚重做，并用新产出证明不是「继承即完成」。

调度器默认每个任务在独立 git worktree 中执行，主工作区停在 main；进入 dev 前按 `write_scope` 申请执行槽，范围相交的任务排队而不是并发写同一片区域。

## 运行中输入

调度器模式下，运行中可以追加三类输入（记录在 `<task>/inputs.jsonl`）：

- `note`：实现提示，注入下一阶段提示词；阶段成功后标记 consumed。
- `amendment`：需求/规格修正；当前 dev/review 轮作废，流程在阶段末 blocked(`amendment_pending`)，`flow --resume` 后退回 design 升版。
- `answer`：对 designer 的 `attention.json` 的回答；design 重新读取后继续。

designer 认为需求存在致命歧义时，写 `<task>/attention.json`（question/options/default），不要猜；流程停在 `awaiting_human`，等人回答后 resume。

## 规则

1. 每个角色只写自己负责的交接文件（见上表）；产品代码写入范围以 design.md 的 write_scope 为准，state.json 由当前阶段角色或调度器维护。
2. 验证模型不得与开发模型相同：verifier 开始前比较 dev 与 verifier 的实际模型标识；相同或任一为空则拒绝验证，并在 review.md 写明原因。调度器模式以 run.json 的 model_resolved 为准。
3. acceptance.md 只能由 designer 修改。developer 认为某条无法执行时，在 impl.md 写明原因并退回 design，不自行修改 design.md 或 acceptance.md。
4. 每条验收必须是 PowerShell 7 单行命令、零第三方依赖、能独立判定通过或失败；acceptance.md 使用 `## AC-n 标题`、`- 命令:`、`- 期望:` 格式。涉及 I/O、异步任务或持久化状态变更时，除正常路径外，须包含至少一条针对失败/取消恢复或底层调用次数/资源上限的可执行断言。
5. 交接文件名全部小写、固定；修改时覆盖原文件，历史版本靠 git 保留；run.log 只能追加。
6. 调度器模式下 state.json 的 status 只能由调度器或明确授权的阶段推进；手工改 status 视为伪造证据。
7. `write_scope` 只允许缩小，不允许在开发阶段扩大；需要扩大时退回 designer 修改 design.md 并重新验收。
8. 合并永远需要人类许可；agent 只把分支准备到 pr_open，不自我放行。低档任务的许可可以来自用户事先给出的预授权（有范围、有时限），confirm 档必须逐个确认。

## 自检

```powershell
# 只读检查 skill 本体（C1–C9）
pwsh -NoProfile -File AgentLine/tools/check-skill.ps1

# 只读检查某个任务的证据链
pwsh -NoProfile -File AgentLine/tools/check-task.ps1 -RepoRoot <repo> -TaskDir .collab/tasks/<NNN>
```

`check-task.ps1` 校验 state/run/ci/verdict、模型隔离、日志引用、write_scope 与必需产物；
默认严格，`-Lenient` 把历史 verdict/日志缺失降级为 WARN，`-Strict` 要求 write_scope 必须存在。
它不执行 acceptance，也不修改任何文件。

## 失败模式速查

执行失败（认证失效、传输层故障）不改 round，按下表重跑；验收不通过按「流程」第 5 步推进 round。

| 现象 | 判定 | 处置 |
|---|---|---|
| 认证失效：CLI 报 401/403、token 过期或提示未登录，角色没有产出交接文件 | 错误信息指向认证或登录；不重新登录则每次重跑都以同样错误失败 | 由人重新登录后以同一角色原样重跑；重跑最多 2 次，换模型不升深度，仍失败则将 state.json 的 phase 设为 blocked，交给人处理 |
| 后端传输层故障：连接超时、中途断流、代理或 DNS 错误，或 CLI 版本过旧导致与后端不兼容 | 错误来自 CLI 或网络而非任务内容；CLI 版本低于后端要求，或网络连通性检查失败 | 升级 CLI 或恢复网络后重跑同一角色；重跑最多 2 次，换模型不升深度，换模型后同步更新 state.json 的 dev_model 或 verifier_model 并重新做模型隔离检查，仍失败则将 phase 设为 blocked |
| 验收不通过：verifier 判定 needs_revision | review.md 结论为 FAIL（needs_revision），问题清单列出待修复项 | round 加 1、phase 返回 develop，developer 按 review.md 逐项修复并更新 impl.md 后再次交给 verify；round 超过上限时将 phase 设为 blocked，交给人处理，上限以 `squad.yaml` 的 `review_rounds.max_rounds` 为准 |
