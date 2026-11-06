# AgentLine Blueprint 20261106：设计 v2 增量（design-v2-delta）

- 状态：设计 Round 2（共 3 轮），待审核
- 日期：2026-11-06
- 主设计：Claude Opus 5.5；审核：GPT-6 Astra
- 基线：`design-v1.md`。本文件只写**替换或新增**的章节。没提到的 v1 章节原样保留。
- 输入：`brief.md`、`design-v1.md`、`review-v1.md`、`decisions.md`，以及以下源码的静态核对：`orchestrator/lib/flow.mjs`、`exec.mjs`、`worktree.mjs`、`ci.mjs`、`inputs.mjs`、`routing.mjs`、`git.mjs`、`adapters/*`，`orchestrator/agentline.mjs`，`AgentLine/tools/check-task.ps1`，`plugin/lib/index.js`。
- 本轮不改仓库代码，也不执行产品流程。
- 需要用户裁决的问题集中在第 13 节，正文中标为 `⚑D<n>`。设计师没有替用户拍板。

---

## 0. 读法、关闭对照与合并清单

### 0.1 review-v1 问题 → 本文件章节

| 问题 | 结论 | 本文件章节 |
|---|---|---|
| B1 Supervisor 无法兑现三轮上限和统一预算 | **承认 v1 的“flow 退出后在外层分类”不够。**v2 改为在 flow 进程内设置调用守卫（CallGuard），通过 flow 已有的 `adapterFactory` 参数注入，flow/exec 代码不改。三轮上限、统一恢复预算和逐调用证据都可以兑现，有 4 条残余限制。另给出最小内核改动方案 K1，由用户在 ⚑D1 中选择 | §1 |
| B2 证据未绑定被验证对象 | 为每类证据定义输入摘要、执行身份和新鲜度；“旧 pass + 新内容”一律判为 `stale_evidence` | §2 |
| B3 `--override-gate` 绕过硬约束 | **取消。**不设任何整体绕过。T gate 中只有 `T.identity_verified` 一项可豁免（取决于 ⚑D2） | §3 |
| B4 合并后证据消失 | 合并前封存（seal 提交）并归档 B 级记录；合并后用不可变提交加 `check-task -Sealed` 校验；本机和新 clone 规则一致 | §4 |
| M1 单 CLI 命令表 | 完整列出“用户动作 → 一条 CLI → 状态变化”；复合动作由核心完成；长操作改为 job | §5 |
| M2 角色锁定和 probe 超时 | `roles.lock` 冻结完整执行配置；规定备选确认流程；probe 和锁定改为 job；去掉“不提供建议”选项 | §6 |
| M3 Git 分级留存 | 按文件列出边界；规定迁移的完成状态和 `build start` 前置条件 | §7 |
| M4 版本兼容 | 给出 4 种新旧组合的矩阵；明确 GET 写路由**不再兼容**；增加 drain 与回滚流程 | §8 |
| M5 materialize 和 worktree 交接 | 编号预留、计划摘要、原子提交、幂等；brief 经 main 提交进入 worktree；规定 `depends_on`、`user_gate` 和里程碑的满足条件 | §9 |
| M6 人工授权 | 明确信任边界是“本机用户账户”，这是约定，不是机器证明；规定有效性链在 start、materialize 和 merge 时的检查 | §10 |
| Minor | Studio 轮次、错误类别和终态、重试术语、`E_REPEATED` 的重置、summary etag、模块路径 | §11 |

### 0.2 v1 章节处理表（合并后的文档按此拼装）

| v1 章节 | 处理 | 替换来源 |
|---|---|---|
| §1.2 T1 | 替换该行 | §1.1 |
| §2.1 总图 | 增加 `build-worker` 和 `control/guard.mjs` 两个框；模块路径定为 `orchestrator/lib/` | §1.3、§11.6 |
| §2.2 边界规则 | B1 保留；新增 B9（内核摘要）、B10（Supervisor 写内核文件的白名单）、B11（封存提交只用显式路径） | §1.9 |
| §3.1 三级留存 | 整节替换 | §7 |
| §3.2 布局 | `build/<NNN>.json` 改为 `build/<NNN>/` 目录；新增 `answers.jsonl` 的 B 级位置 | §4.2、§7.1 |
| §3.3 `build/NNN.json` | 整节替换为 ledger、seal 和 supervisor 运行态 | §1.4、§4.2 |
| §3.3 `roles.lock.json` | 替换为 v2 schema | §6.1 |
| §3.3 `questions.json` | `answer` 字段改为只存哈希 | §7.1 |
| §4.2、§4.3 命令表与白名单 | 整节替换 | §5 |
| §5.3 Studio 步骤组 | 替换“每次 run 执行一组”及相关段落 | §11.1 |
| §5.6 角色编辑第 4 步 | 替换 | §6.3 |
| §5.10 轮询依据 | `revision` 改为 `etag` | §11.5 |
| §5.11 旧语法第 3 步、按钮对应表 | 替换 | §5.3 |
| §5.12 防绕过 | 整节替换 | §3 |
| §6.3 维护方式 | 删除“不提供建议”选项 | §6.5 |
| §6.4 `ALL.callable` | 改为“锁内候选” | §6.2 |
| §6.5 probe | 超时和执行方式替换 | §6.4 |
| §7.1 类别定义、`E_TIMEOUT`/`E_CLI_CRASH`/`E_UNKNOWN_SIDE_EFFECTS`/`E_REPEATED` 行、统一恢复预算、幂等与副作用 | 替换 | §1.6、§11.2–11.4 |
| §7.2 Build 行 | 替换 | §1.5 |
| §7.3 G0/G1/T/G2 | 替换内容集合和相应 check 行 | §2.3、§4.4 |
| §8.3 审计链 | 补充封存链 | §4 |
| §9.1、§9.2、§9.7 | 替换 | §8 |
| §10 实现切分 | W7 拆分，新增 W15 和 W16 | §12.2 |
| §11 测试策略 | 增补 | §12.1 |
| §12 风险与裁决 | R3、R4、R6 替换；裁决表替换 | §13 |

### 0.3 设计师在本轮直接确定的事项（不属于用户裁决）

| 事项 | 决定 | 依据 |
|---|---|---|
| 模块路径（原 U4） | `orchestrator/lib/{studio,blueprint,build-ctl}.mjs` 和 `orchestrator/lib/control/*` | 与 `flow.mjs` 实际位置平级；review-v1 认为这是常规实现选择 |
| Blueprint 中间版本留存（原 U6） | 保持 v1 默认：结构化 verdict 进 git，全文放外部 | Q6 |
| Build 业务轮次（原 U10） | 3 | Q5 写的是“三轮后交用户” |
| 行业建议 | 必须提供；维护方式只在 A 和 B 中选（⚑U5） | Q3 |
| 审批、豁免、裁决的原话 | 留在 A 级（git），每条 ≤ 500 字符 | 这是授权记录；现有 `merge` 本来就把许可原话写进提交信息 |
| Studio 问题的自由文本回答 | 移到 B 级，A 级只存哈希 | Q6 写明“用户回答”不进 git |

---

## 1. B1：Build 的轮次、恢复预算与逐调用证据

### 1.1 结论（替换 v1 §1.2 T1 和 R3）

**v1 的说法不成立，予以撤回。**v1 认为在 flow 退出后读取 `state.json`、`run.json` 和 `verdict-r*.json` 就足以控制。review-v1 指出的 4 个事实在源码中都能确认：

1. 每次调用 `runFlow` 时，评审循环都从 `round = 1` 开始（`flow.mjs:357`）。`--max-rounds` 只是本次调用内循环的上限。
2. 最后一轮评审拒绝后，flow 仍会调用 dev 修复并跑 CI，之后才报 `review_exhausted`（`flow.mjs:377-390`）。
3. CI 失败后的修复在评审循环之外（`flow.mjs:342-351`），而且日志名同为 `dev-r1-1.log`，会互相覆盖（`exec.mjs:135`）。
4. 网络重试和候选切换都发生在 `executeRole` 内部（`exec.mjs:147-153`、`exec.mjs:217-221`）。`run.json` 中 `model_resolved` 取不到时会回退成请求的模型（`exec.mjs:160`），掩盖了身份未验证。

**v2 的结论：在 `flow.mjs` 和 `exec.mjs` 一行不改的前提下可以兑现，但前提是 Supervisor 不再“事后”控制，而是在调用边界上控制。**具体做法分三点：

- `build start` 拉起核心进程 `build worker`。它在**同一进程内**调用 `runFlow()`，不再 spawn `agentline flow`。
- 通过 `runFlow` 现有的 `adapterFactory` 参数（`flow.mjs:61`、`flow.mjs:70`，经 `exec.mjs:110` 生效）注入 **CallGuard**。flow 的每一次物理模型调用都必须经过它：调用前可以放行、拒绝或重放，调用后负责记账和归档。
- 通过传入的 `config` 对象关闭 flow 的内部恢复（`policy.networkRetries = 0`、`policy.maxSwitchesPerStage = 1`），并只暴露已锁定的模型（只把锁内模型放进 `config.models`）。这样所有恢复都由 Supervisor 一处决定。

这条路线兑现与否取决于下面 4 项；其中第 4 项无法兑现：

| 承诺 | 能否兑现 | 依据 |
|---|---|---|
| 业务轮次 ≤ 3，跨 resume 累计 | 能 | §1.5：轮次由 ledger 归约得出，不读文件名；第 4 次 dev 在调用**之前**就被拒绝 |
| 每个逻辑步骤的物理调用 ≤ 3（重试和轮换合计） | 能 | §1.6：内部重试已关闭，每次物理调用都要经过 CallGuard |
| 未知副作用不自动重放 | 能 | CallGuard 在调用前后各取一次 worktree 指纹（§1.4） |
| 每次调用都有独立审计记录 | 能 | 调用结束后立即按 `call_id` 归档日志和产物（§1.4），不受 flow 覆盖文件名的影响 |
| CI 在 flow 内部运行，CallGuard 无法拦截 | **不能拦截，只能观测** | CI 结果在下一次调用开始时或 flow 退出时读取（§1.5）。T gate 不采信 flow 的 CI，而是用封存时 Supervisor 自己跑的 gate CI（§2） |

**残余限制（必须如实写明）**

1. 依赖 exec 的内部约定：日志名格式 `<role>-r<n>-<i>.log`、`classifyError` 的关键词、`policy` 的两个字段。由“接缝契约测试”和运行时内核摘要检查兜底（§1.9）。
2. CallGuard 拒绝调用时，flow 自己的 `state.json` 会显示 `blocked_reason: run_failed`。旧工具看到的是 run_failed，真实原因只记录在 Supervisor 的 ledger 中。
3. 断点续跑时，flow 会对已经评审过的代码再请求一次评审。CallGuard 用“评审重放”处理：把已归档的评审产物原样写回，不发起模型调用（§1.4）。这是 Supervisor 写内核产物的唯一例外（边界规则 B10）。
4. 每次 resume 都会重跑一次 CI（`flow.mjs:342`）。这只花时间，不消耗模型调用。

如果用户不接受上面的第 1–3 项，可选 **K1：最小内核接口调整**（§1.10）。由 ⚑D1 裁决，设计师推荐 K0。

### 1.2 现有接缝清单（全部不需要改代码）

| 接缝 | 位置 | Supervisor 的用法 |
|---|---|---|
| `runFlow({ …, adapterFactory })` | `flow.mjs:61,70` → `exec.mjs:110` | 注入 CallGuard 包装后的 adapter |
| `adapter.run({prompt, cwd, model, effort, timeoutMs, logPath})` | 各 adapter | CallGuard 包住 `run`，`check` 和其他方法原样透传 |
| `config.policy.networkRetries` / `maxSwitchesPerStage` | `exec.mjs:112-113` | 分别设为 0 和 1，flow 内部不再重试、不再切换候选 |
| `config.models` 只放锁内模型 | `routing.mjs` 中 `effectiveRole` 按 `config.models` 过滤 | 锁定模型集合；轮换时从可见集合中移除失败的候选 |
| `args.resume` / `args.keep` / `args['max-rounds']` | `flow.mjs:258-274`、`flow.mjs:68` | 每次都带 `resume` 和 `keep`；`max-rounds` 固定为 3，只是每次调用的内循环上限 |
| `control.json` 停止请求 | `control.mjs` | 用户停止时沿用现有机制 |
| `logPath` 命名 | `exec.mjs:135` | 从中解析 `role` 和 `flow_round`；**由契约测试固定** |

### 1.3 build worker 与 LockedConfig

- **进程：**`agentline build start` 校验通过后，detached 拉起 `node agentline.mjs build worker --repo R --task NNN --run <run_id>`。这是核心内部命令，不在 Host 白名单里。registry 和锁记录的 pid 就是 worker 的 pid，所以现有 `stop --now` 的整树终止照常有效。
- **LockedConfig：**在 `build start` 时由 `agentline.local.json`、发现缓存和 `build` 角色锁合成，写入 `B:/build/NNN/lock.json`，并计算 `exec_config_digest`。字段与 §6.1 相同。每次 resume 都用同一份锁，不重新读全局配置。
- **一次 worker 调用一次 `runFlow`。**flow 退出后，worker 用归约器（§1.5）和动作表（§1.6）决定下一步：再次调用 `runFlow`（resume）、在本进程内等待（`waiting`）后再调用，或者结束并写出 `view_status`。
- **worker 崩溃：**ledger 每次写入都 fsync。如果找到只有 `call.start` 没有 `call.end` 的记录，就判定为中断调用，用 `pre.fingerprint` 和当前指纹做副作用判断（§1.6）。

### 1.4 CallGuard 契约与 ledger

**位置：**`orchestrator/lib/control/guard.mjs`（核心代码）。

**调用前（beforeCall）**依次判断，命中即停：

1. 读取取消标记（`B:/build/NNN/control.json` 的 `cancel`）。设置了 → 拒绝，原因 `G_CANCEL`。
2. 内核摘要不在支持列表中 → 拒绝，原因 `G_KERNEL`（§1.9）。
3. CLI 指纹与锁中记录的不一致 → 拒绝，原因 `G_DRIFT`。
4. 角色是 review：
   - 评审者的 identity_group 落在 dev 贡献者集合 D 中 → 拒绝，原因 `G_ISOLATION`。
   - 当前代码摘要已有缓存的 verdict → **重放**。
   - 这是一份新的代码摘要，且 `r ≥ 3` → 拒绝，原因 `G_ROUND_CAP`。
5. 角色是 dev，`r ≥ 3`，且最近一次评估结论为失败 → 拒绝，原因 `G_ROUND_CAP`。
6. 该逻辑步骤的物理调用次数已达 3 → 拒绝，原因 `G_STEP_CAP`。
7. 已用预算达到上限 → 拒绝，原因 `G_BUDGET`。

**拒绝的编码方式**

- 返回 `{ exitCode: 97, error: "AGENTLINE_GUARD_DENY <G_CODE> call=<call_id>" }`，同时向 `logPath` 写一行说明，保证 `run.json` 里的 `log_ref` 对应的文件存在。
- 错误文本刻意避开 `classifyError` 的所有关键词（auth、limit、context、timeout、network 等），确保它被归为 `run_failed`。由于 `maxSwitchesPerStage = 1`，exec 不会切换候选，也不会写交班单或 checkpoint。

**重放**

- 把归档中的 `review*.md` 和 `verdict*.json` 按 flow 当前轮次的文件名写回（例如 `verdict-r1.json`），并返回 `{ exitCode: 0, modelResolved: <原值>, replay: true }`。
- `readVerdict` 按 mtime 取最新文件（`exec.mjs:281-291`），所以会读到重放内容。
- 重放不产生模型调用，也不计入预算。

**调用后（afterCall）**

1. 写 `call.end`。
2. 把 `logPath` 以及本次调用产生的评审产物复制到 `B:/build/NNN/calls/<call_id>/`，并记录 sha256。
3. 记录 `post.fingerprint`。
4. 如果 adapter 拿到了 `identity`（W2），而 resolved 与请求的 identity_group 不同：把成功结果**改写**为拒绝（`G_IDENTITY_MISMATCH`），保留现场。

**ledger 条目**（B 级 `ledger.jsonl` 只追加；A 级 `ledger.json` 是去掉原文后的同构摘要，在封存时写入）：

```json
{ "schema": "agentline.ledger/v1", "seq": 17, "call_id": "c-004-0017",
  "epoch": 1, "step": { "role": "dev", "business_round": 2, "flow_round": 2, "candidate": 1 },
  "kind": "model_call",
  "model": { "key": "gpt-6.1-sol", "provider": "codex", "model_id": "gpt-6.1-sol",
             "resolved": null, "identity": "unverified", "cli_fingerprint": "sha256:…" },
  "pre":  { "head": "a1b2…", "fingerprint": "sha256:…", "code_digest": "sha256:…",
            "ci_observed": { "sha256": "…", "ok": false, "passed": 3, "total": 5, "code_digest": "sha256:…" } },
  "post": { "exit": 0, "error_code": null, "fingerprint": "sha256:…", "duration_ms": 412000,
            "usage": { "in": 98000, "out": 7100 },
            "artifacts": [ { "name": "verdict-r2.json", "sha256": "…" } ] },
  "decision": "allow",
  "archive": "calls/c-004-0017/",
  "at": "…" }
```

- `decision` 取值：`allow | deny:<G_CODE> | replay:<call_id>`。
- `kind` 取值：`model_call | flow_start | flow_exit | ci_observed | user_action`。

### 1.5 业务轮次的持久依据（替换 v1 §7.2 Build 行）

**代码摘要 `code_digest`** 的算法见 §2.1。概括地说：用临时索引把工作区内容（排除 `.collab/**`）算成一个树摘要。它与提交无关，所以“已提交”和“未提交但内容相同”得到同一个值。

**归约器（纯函数，输入是 ledger）**

- **纪元（epoch）：**任务开始时为 1。观测到一条 amendment 被消费（`inputs.jsonl` 中 `kind=amendment` 的条目变为 consumed）时加 1。amendment 是用户改需求，新纪元的轮次从 0 计。
- **评估点：**
  - CI 观测：在 `ci_observed` 中，CI 结果对应某个 `code_digest`。
  - 评审调用开始：评审者拿到的是当时的 `code_digest`。
- **`S_e`：**本纪元内经历过评估点的不同 `code_digest` 集合，不含任务起点的基线摘要。
- **业务轮次 `r_e = |S_e|`。**
- **`last_eval`：**最近一个被评估摘要的结论。只要有一次 CI 失败或评审拒绝，就记为 `fail`；评审通过记为 `pass`。
- **verdict 缓存键：**`(code_digest, acceptance_digest)`。**不含评审者。**换一个评审者重审同一份代码，本质是“再问一次直到通过”，会掩盖业务分歧，所以不允许。

**规则**

- dev 调用前：`r_e ≥ 3` 且 `last_eval = fail` → 拒绝（`G_ROUND_CAP`）。
- 评审调用前：缓存命中 → 重放；新摘要且 `r_e ≥ 3` → 拒绝。
- flow 退出后：`r_e = 3`、`last_eval = fail` 且没有基础设施故障待处理 → `awaiting_user(round_limit)`。
- flow 因 `ci_failed` 或 `review_exhausted` 退出，但 `r_e < 3` → 自动 resume。这不是重试，而是 flow 自己提前停下，由 Supervisor 把剩下的业务轮次跑完。

**CI 观测为什么完整：**CI 只在两次模型调用之间运行（`flow.mjs:342-351`、`flow.mjs:383`），而每次 CI 之后要么紧跟一次模型调用，要么 flow 退出。CallGuard 在下一次 `beforeCall` 时读取 `ci-results.json`，worker 在 flow 退出时也读一次。所以每份 CI 结果都会在被覆盖之前记账。

### 1.6 统一恢复预算与动作（替换 v1 §7.1“统一恢复预算”和“幂等与副作用”）

**术语（全文统一）**

| 术语 | 定义 |
|---|---|
| 逻辑步骤 | `(epoch, role, business_round)`。Studio/Blueprint 中为 `(round, role)` |
| 物理调用 | 一次 `adapter.run`。重放不算 |
| 重试 | 同一模型、同一逻辑步骤的又一次物理调用 |
| 轮换 | 换到锁内另一个候选的又一次物理调用 |
| attempt | 某逻辑步骤内物理调用的序号，从 1 开始 |

**预算优先级（从外到内，先到先停）**

1. 每个逻辑步骤的物理调用 ≤ 3，重试和轮换**都计入**。
2. 每个角色每个会话（或任务）的轮换 ≤ 1。
3. 单会话（或任务）累计自动等待 ≤ maxWait（⚑U8）。
4. 各错误码自己的上限（v1 §7.1 的“上限”列）只在前三项范围内生效。

**副作用判定（Build 写角色：design 和 dev）**

| 现场 | 处理 |
|---|---|
| `post.fingerprint == pre.fingerprint`（工作区没动） | 视为无副作用。可重试或轮换，计入步骤预算 |
| 工作区有变化，且调用失败 | `E_UNKNOWN_SIDE_EFFECTS` → `awaiting_user(interrupted_choice)`，**不自动重放** |
| 进程树未能确认终止 | `E_PROCESS_LINGERING` → `blocked` |

**flow 退出后 worker 的动作（替换 v1 中按 `blocked_reason` 白名单 resume 的做法）**

| ledger 最后一条非 allow 的原因 / flow 退出原因 | worker 动作 |
|---|---|
| 基础设施码（`E_RATE_LIMIT`、`E_CAPACITY`、`E_NETWORK` 等），且工作区干净，预算没用完 | 按 v1 §7.1 的等待或轮换规则处理，然后调用 `runFlow(resume, keep)` |
| `deny:G_ROUND_CAP` | `awaiting_user(round_limit)` |
| `deny:G_STEP_CAP` | 按该错误码的终态处理（通常为 `blocked(infra)`） |
| `deny:G_ISOLATION` / `G_IDENTITY_MISMATCH` / `G_DRIFT` / `G_KERNEL` | `blocked`（integrity 或 config） |
| `deny:G_BUDGET` | `awaiting_user(budget)` |
| `deny:G_CANCEL` | `blocked(halted)` |
| flow 返回 `ci_failed` 或 `review_exhausted`，且 `r_e < 3` | 自动 resume |
| `awaiting_human` / `amendment_pending` | `awaiting_user(attention)` |
| `pr_open` | 进入封存（§4） |

### 1.7 Supervisor 控制接口

| 命令 | 作用 | 前置条件 |
|---|---|---|
| `build start --task NNN` | 有效性链检查（§10.2）、生成 LockedConfig、建 worktree，然后拉起 worker | 状态为 draft 或 held；`user_gate` 任务要求人类通道（§9.3） |
| `build resume --task NNN --keep\|--discard` | 处理 `interrupted_choice` 或 `blocked` 修复后继续 | `--discard` 只接受人类通道 |
| `build retry-now --task NNN` | 跳过剩余等待时间，立即继续 | 状态为 `waiting` |
| `build stop --task NNN [--now]` | 设置 `cancel` 标记，并转调现有 `stop` | — |
| `build decide --task NNN --ruling <…> --text` | 处理 `round_limit`，选项由 ⚑D3 决定 | 人类通道 |
| `build merge` / `build seal` | 见 §4 | — |

**运行态位置：**`B:/build/NNN/supervisor.json`，包含 `view_status`、等待截止时间和计数器。它不写入仓库，避免弄脏 main 工作区。裁决记录写在 `B:/build/NNN/decisions.jsonl`，等任务锁空闲后由 Supervisor 用显式路径提交到任务分支的 `.collab/build/NNN/decisions.json`（B11）。

### 1.8 时序

下表中：`r` 是归约后的业务轮次，`d_k` 是第 k 份代码摘要。

**S1 第三轮评审拒绝（没有基础设施错误）**

| # | flow 动作 | CallGuard | ledger / r |
|---|---|---|---|
| 1 | design r1 | allow | — |
| 2 | dev（flow r1） | allow | 产出 d1 |
| 3 | CI 通过 | （下一次调用时观测） | d1 进入 S，r=1 |
| 4 | review flow-r1 | allow（无缓存） | 拒绝 d1 |
| 5 | dev flow-r2 | r=1 < 3 → allow | 产出 d2 |
| 6–7 | CI 通过，review flow-r2 | allow | r=2，拒绝 d2 |
| 8 | dev flow-r3 | allow | 产出 d3 |
| 9 | CI 通过，review flow-r3 | allow | r=3，拒绝 d3 |
| 10 | dev flow-r4 | **deny `G_ROUND_CAP`**，不调用模型 | exec 记一条 exit 97 的 run，flow 进入 `blocked(run_failed)` |
| 11 | worker | 归约：r=3 且 fail | `awaiting_user(round_limit)`，Inbox 出现裁决卡 |

模型调用共 7 次（design 1、dev 3、review 3）。v1 会多一次 dev 和一次 CI。

**S2 第一次 CI 就失败**

| # | 事件 | r |
|---|---|---|
| 1 | dev 产出 d1；CI 失败；flow 进行修复：dev call（beforeCall 观测到 CI 失败） | r=1 → allow |
| 2 | dev 产出 d2；CI 通过；评审拒绝 d2 | r=2 |
| 3 | dev 产出 d3；CI 失败；flow 返回 `ci_failed` | r=3（d3 经 CI 评估，结论 fail） |
| 4 | worker 归约：r=3 且 fail | `awaiting_user(round_limit)` |

**变体：**第 3 步如果发生在 r=2 时，worker 会自动 resume，flow 从 `implemented` 继续，跑 CI 后进入修复。CI 失败**计入**业务轮次，与 v1 表中 `E_CI_FAILED` 的“计轮”一致。

**S3 跨 resume：修复调用遇到 429**

| # | 事件 | 处理 |
|---|---|---|
| 1 | 评审拒绝 d1（r=1）→ dev flow-r2 → 429 | ledger 记录：步骤 (1, dev, 2) 的 attempt 1，`E_RATE_LIMIT`；工作区干净 |
| 2 | flow 进入 `blocked(rate_limit)`，worker 等待 `retry_after` | `waiting`，不计轮 |
| 3 | `runFlow(resume, keep)`：flow 从 `reviewable` 继续，CI 观测到 d1 | r 仍为 1 |
| 4 | review flow-r1（d1） | **重放**缓存中的拒绝，不调用模型 |
| 5 | dev flow-r2 | 同一步骤的 attempt 2 ≤ 3 → allow，产出 d2，r=2 |

如果第 1 步连续发生 3 次，步骤预算用尽：有剩余轮换额度就轮换（在 resume 前从 `config.models` 中移除失败的候选），否则 `blocked(infra)`。

**S4 dev 超时，现场已脏**

1. dev 超时，指纹变化 → `awaiting_user(interrupted_choice)`。
2. 用户选择 `--keep` → resume。flow 跑 CI，然后评审这份半成品的新摘要 d'。d' 进入 S，r 加 1。
3. 用户选择 `--discard` → 先在 worktree 中执行 flow 已有的丢弃逻辑（resume 不带 `keep`），再 resume。基线不变，r 不变。

**S5 中途改需求**

用户执行 `input --kind amendment`，flow 回到 design 并消费该条 amendment。ledger 中 `epoch` 加 1，r 从 0 重新计数。UI 显示“第 2 纪元 · 轮次 1/3”。

### 1.9 接缝守护（新增边界规则）

| 编号 | 规则 | 检查方式 |
|---|---|---|
| B9 | `flow.mjs`、`exec.mjs`、`state.mjs`、`inputs.mjs` 的组合摘要必须在 `orchestrator/config/kernel-seam.json` 的支持列表中 | ① CI 中跑接缝契约测试：假 adapter，断言日志名格式、拒绝文本被归为 `run_failed`、`maxSwitchesPerStage = 1` 时不写交班单、resume 从 `reviewable` 重跑 CI 和 r1。② worker 启动时计算摘要，不在列表中则 `blocked(E_KERNEL_SEAM_UNVERIFIED)`。只有接缝测试通过后才能更新列表 |
| B10 | Supervisor 和 CallGuard 只能写以下内核位置：`logPath` 的单行说明、重放时写回与归档逐字节相同的评审产物。不得写 `state.json` 或 `run.json` | 单元测试加代码扫描 |
| B11 | Supervisor 的提交只用显式路径（`git add -- .collab/build/NNN`），从不使用 `-A` | 代码扫描 |

### 1.10 备选方案 K1：最小内核接口调整（仅当 ⚑D1 选 B 时采用）

**改动范围**（约 40 行，单独开一个 Blueprint 提交）：

- `exec.mjs`：
  - `executeRole` 接受 `hooks.beforeCall(ctx)` 和 `hooks.afterCall(ctx, res)`；`ctx` 为 `{role, round, candidate, model, logPath, cwd}`。
  - 拒绝时写 `blocked_reason: "guard:<code>"`。
  - `model_resolved` 不再回退为请求值；新增 `model_resolved_source` 字段。
- `flow.mjs`：
  - 透传 `hooks`。
  - 每次 CI 后调用 `hooks.onCI(result, head)`。
  - 在 CI 修复调用和评审循环的修复调用**之前**调用 `hooks.allowRepair({kind, round})`；返回 false 时直接 `finish(review_exhausted 或 ci_failed)`。
  - 接受 `args['start-round']`，让日志名和 verdict 文件名在 resume 后继续编号。

**K1 的收益：**不再依赖日志名和关键词约定，不需要重放，CI 可以直接观测，`state.json` 中的原因真实。

**K1 的代价：**违反 Q1 中“flow 零侵入”的字面要求；`flow.mjs` 的哈希守卫需要重新建立基线。

两种方案下，§1.5 的归约器、§1.6 的预算和 §2 的证据绑定都**完全相同**；差别只在 §1.4 拿到信号的方式。

### 1.11 B1 验收例子

| # | 场景 | 期望结果 |
|---|---|---|
| A1-1 | 假 adapter：评审 3 次都返回 revise | dev 调用恰好 3 次；第 4 次 dev 的 ledger 记 `deny:G_ROUND_CAP`，且 adapter 的调用计数没有增加；`view_status = awaiting_user`，`awaiting.kind = round_limit` |
| A1-2 | CI 失败、通过评审拒绝、再 CI 失败（S2） | 第 3 份摘要被评估后，r=3 时停止；ledger 中有 3 条 `ci_observed`，其中 2 条 `ok:false` |
| A1-3 | dev 修复遇到 429 后 resume（S3） | review flow-r1 的 ledger 记 `replay:c-…`，adapter 的评审调用计数不变；该步骤 attempt=2；r 不因 429 增加 |
| A1-4 | 同一 dev 步骤连续 3 次 429，且没有轮换候选 | 第 4 次物理调用不会发生；`blocked(infra)`；`E_REPEATED` 计数为 3 |
| A1-5 | dev 超时，工作区已改动 | 不自动 resume；进入 `interrupted_choice`；选 `--keep` 后，新摘要进入 S |
| A1-6 | 修改 `exec.mjs` 一行后启动 worker | `blocked(E_KERNEL_SEAM_UNVERIFIED)`，flow 没有被调用 |
| A1-7 | 换一个评审者重审同一份 d1 | 重放原 verdict，不出现第二份评审结论 |

---

## 2. B2：证据与被验证对象的绑定

### 2.1 摘要定义

| 摘要 | 算法 | 覆盖对象 |
|---|---|---|
| `content_hash(files)` | 沿用 v1 §3.3：UTF-8、LF、去 BOM、按路径排序、RFC 8785 | 文本产物 |
| `design_digest` | `content_hash(design.md, interfaces.md, risks.md)` | Blueprint 设计 |
| `graph_digest` | `content_hash(task-graph.json)` | 任务图 |
| `strategy_digest` | `content_hash(test-strategy.md, acceptance-matrix.md)` | 测试策略 |
| `node_sha256` | 任务图中该节点的 canonical JSON | 单个任务节点 |
| `code_digest(X)` | X 是提交时用 `git ls-tree -r X`；X 是工作区时，用临时 `GIT_INDEX_FILE` 执行 `git add -A` 后 `git ls-files -s`。两种情况都排除 `.collab/**`，把 `(mode, blob, path)` 排序后取 sha256 | 产品代码快照 |
| `acceptance_digest` | `content_hash(tasks/NNN/acceptance.md)` | 验收定义 |
| `commands_digest` | ci-runner 解析出的 `[(AC-id, command)]` 列表做 canonical 后取 sha256 | 实际执行的验收命令 |
| `runner_digest` | `sha256(ci-runner.ps1)` | 执行器 |
| `decision_digest(i)` | `decisions.json` 第 i 项的 canonical JSON | Studio 单条决策 |

**“不改变产品快照”的定义：**`code_digest` 不变，即变化只发生在 `.collab/**` 之内。审计文件追加、封存提交和 merged 标记都属于这类变化，不会让证据失效。

### 2.2 证据表

| 证据 | 产生者 / 执行身份 | 绑定的输入摘要（写在证据中，由核心写入，不由模型填写） | 新鲜度：何时有效 |
|---|---|---|---|
| Studio 专家确认 | stage-exec；身份为专家模型的 `{key, identity_group, identity, probe_ref}` | `minutes_digest` 加上逐条 `decision_digest` | 被确认的那条决策摘要不变 |
| Studio 用户确认 / 回答 | 人类通道 `{channel, at}` | `decision_digest` 或 `question_id + options_digest` | 同上 |
| Blueprint testability | stage-exec；测试架构师模型 | `design_digest`、`graph_digest`、`strategy_digest` | 三项摘要都等于当前值 |
| Blueprint review verdict（`review-rN.verdict.json`） | stage-exec；评审模型。核心把模型输出包进外层：`{round, reviewer, input_digests, model_output_sha256, verdict, findings}` | 同上，另加 G0 的 hash | 同上 |
| Build review verdict | CallGuard；评审模型，身份来自 ledger | 评审开始时的 `code_digest`、`acceptance_digest`，以及 `pre.head`。模型写的 `git_sha` 必须等于 `pre.head`，否则判 `E_INVALID_OUTPUT` | 封存候选的 `code_digest` 与它**相等** |
| Build gate CI（`ci-gate.json`） | Supervisor 在干净的 detached 快照中运行 ci-runner；身份为 `{core, runner_digest, pwsh_version, os, host_key}` | `candidate_commit`、`code_digest`、`acceptance_digest`、`commands_digest`、`runner_digest` | 五项都等于封存值。**不使用** flow 的 `ci-results.json` |
| dev 贡献者集合 D | ledger | 所有 `role=dev`、`exit=0` 或现场已脏的调用 | 用于封存时的计算 |
| E2E（`e2e-results.json`） | `milestone e2e` job，在 main 的 detached 快照上运行；身份同 gate CI | `integration_commit I`、`code_digest(I)`、`commands_digest`（来自 milestone.e2e）、`runner_digest` | I 包含该里程碑所有任务的合并提交，且以上摘要不变 |
| 人工验收勾选 | 人类通道 | `check_id`、`integration_commit I`、`code_digest(I)` | `code_digest(I)` 等于当前 E2E 的值 |
| 模型身份 / probe | probe.mjs；`cli_fingerprint` | `exec_config_digest` | 沿用 12 小时缓存；锁在会话或任务期间不变 |

所有确定性证据（verdict、CI、E2E）**没有时间上的有效期**，只要摘要相等就有效。只有 probe 有时间限制。

### 2.3 Gate check 修订（替换 v1 §7.3 对应行）

**G0**

| check | 新判定 |
|---|---|
| `G0.each_decision_confirmed` | 每条决策都有确认记录，且记录中的 `decision_digest` 等于当前值 |
| `G0.experts_confirmed` | 每位专家确认中的 `minutes_digest` 等于当前值，且其中的 `decision_digest` 集合等于当前集合 |

**G1**

| check | 新判定 |
|---|---|
| `G1.review_pass` | 最后一轮 verdict 为 `pass`，没有 open blocking，且 `input_digests` 的 4 项都等于当前值。否则 detail 写 `stale_evidence:<哪一项>` |
| `G1.testability_clear` | 最新的 `testability.json` 中 `input_digests` 等于当前值，且没有 open blocker |

**T**（完整定义见 §4.4）：`T.verdict_bound`、`T.ci_bound`、`T.isolation` 取代 v1 的 `T.verdict_pass`、`T.ci_all_pass`、`T.isolation`。

| check | 判定 |
|---|---|
| `T.verdict_bound` | 封存 verdict 为 pass，`verdict.code_digest == seal.code_digest`，`acceptance_digest` 相等，`git_sha == 评审时的 pre.head`，且该提交是 `candidate_commit` 的祖先 |
| `T.ci_bound` | `ci-gate.json` 全部通过，且与封存的 5 项摘要相等 |
| `T.isolation` | 封存 verdict 的评审者 identity_group ∉ D。D 中有 `unverified` 时按 ⚑D2 处理 |

**G2**

| check | 新判定 |
|---|---|
| `M.e2e_pass` | E2E 结果全部通过；I 包含所有任务的 `merge_commit`；`code_digest(I)` 和 `commands_digest` 等于结果文件中的值 |
| `M.manual_checks` | 每一项人工检查都有勾选，且勾选绑定的 `code_digest` 等于当前 `code_digest(I)` |
| `M.origin_current`（新增，不可豁免） | 里程碑内所有任务引用的 G1 批准当前仍有效，没有撤销也没有失效 |

**内容集合**也同步扩展：G2 加入 I 和 `code_digest(I)`，所以对新的 I 重跑 E2E 后，旧批准失效。

### 2.4 B2 验收例子

| # | 操作 | 期望结果 |
|---|---|---|
| A2-1 | G1 已 passed。人工修改 `design.md` 一行，然后 `gate eval`、`approve` | `G1.review_pass = fail (stale_evidence:design_digest)`；approve 返回 `E_GATE_NOT_READY`；必须再跑一轮（会占用轮次） |
| A2-2 | 只修改 `test-strategy.md` | `G1.review_pass` 和 `G1.testability_clear` 都 fail，原因为 `strategy_digest` |
| A2-3 | Build 评审通过后，有人往任务分支追加一个产品代码提交 | 封存时 `code_digest ≠ verdict.code_digest`，`T.verdict_bound = fail`，合并被拒 |
| A2-4 | 评审通过后只追加 `.collab/build/004/` 下的审计文件 | `code_digest` 不变，T 保持 pass |
| A2-5 | 修改 `acceptance.md` 中一个 AC 的命令 | `acceptance_digest` 和 `commands_digest` 都变；`T.ci_bound` 和 `T.verdict_bound` 都 fail |
| A2-6 | dev 先用模型 A，轮换到 B 后提交；评审者是 A | 评审调用前 CallGuard 就拒绝（`G_ISOLATION`），不会出现能用于 T 的 verdict。如果构造一份这样的 ledger，封存时 `T.isolation = fail` |
| A2-7 | 里程碑 E2E 在 I1 上通过并获批准；之后在 I2 上重跑 | 批准失效（内容哈希改变）；I1 上的人工勾选在 I2 上不被计入 |
| A2-8 | Studio 修改第 3 条决策的文字 | 只有第 3 条的确认失效；`G0.each_decision_confirmed` fail，并指出是第 3 条 |

---

## 3. B3：取消 `--override-gate`（整节替换 v1 §5.12）

1. **只能经物化产生 Blueprint 任务：**Blueprint 来源任务的 `brief.md` 和 `origin.json` 只由 `blueprint materialize` 生成，它要求 G1 通过（§9）。
2. **只能经 Supervisor 启动：**UI、斜杠命令和工具 `agentline_flow` 都走 `build start`，它会检查有效性链（§10.2）。
3. **合并只有一条路：**
   - 一个任务只要出现在任一 `materialized.json` 中，或带有 `origin.json`，就视为 Blueprint 来源。依据是 main 上的物化记录，所以删除 `origin.json` 也改变不了这个身份。
   - 对这类任务，旧的 `agentline merge` 直接拒绝，返回 `E_USE_BUILD_MERGE`。这是 `agentline.mjs` CLI 分发层的前置检查，不属于 flow。
   - `build merge` 求 T gate；不通过就拒绝，**没有任何绕过参数**。
4. **可豁免项白名单：**T gate 中只有 `T.identity_verified` 可以豁免，前提是 ⚑D2 选择 explicit_exception。其余 T check 全部 `waivable:false`，`waive` 返回 `E_WAIVER_FORBIDDEN`。
5. **不能用 grant：**Blueprint 来源任务中 `user_gate:true` 或 `risk ≠ low` 的，不能用 grant 合并。
6. **残余风险与检测：**
   - 有人在 AgentLine 之外直接 `git merge`，无法阻止。但该任务没有封存，`M.task_gates` 会 fail（不可豁免），里程碑 G2 无法通过。Inbox 显示 `unsealed_merge`。
   - 唯一补救是 `build seal --post-merge`（§4.5），而且只有证据本身完整时才能通过。
   - 手动执行 `node agentline.mjs flow` 仍能运行，但没有 ledger，封存时 `T.ledger_present` fail，合并会被拦。
7. **协议变更：**允许越过不可豁免项属于协议变更。本设计**不提供**这种能力，也不把它作为默认待裁决项。只有当用户主动提出要放宽时，才单独开一个 Blueprint。

**B3 验收例子**

| # | 操作 | 期望结果 |
|---|---|---|
| A3-1 | `agentline merge --task 004 --permission "…" --override-gate "…"` | 参数未知；即使去掉该参数，也返回 `E_USE_BUILD_MERGE`（004 在 `materialized.json` 中） |
| A3-2 | T 中 `T.ci_bound` fail，执行 `waive --check T.ci_bound` | `E_WAIVER_FORBIDDEN`（退出码 4） |
| A3-3 | 删除任务分支上的 `origin.json` 后执行 `build merge` | 依据 `materialized.json` 仍判为 Blueprint 来源；`T.origin_valid` fail，合并被拒 |
| A3-4 | G1 批准已撤销，执行 `build merge` | `E_APPROVAL_REVOKED`，合并被拒 |

---

## 4. B4：封存、归档与合并后的严格校验

### 4.1 原则

- T gate 的内容只依赖 **git 中的不可变对象**：封存提交 S 及其祖先。
- B 级原始日志属于**审计**，不属于 gate：本机存在时必须与哈希一致，不存在时标为 `not_local`，不判失败。
- 这条规则在本机和新 clone 上相同。因此 T 在 worktree 删除、分支删除和新 clone 三种情况下都能用同一套规则重新求值。

### 4.2 封存（seal）

**时机：**flow 以 `pr_open` 退出后，worker 自动执行一次 `build seal`；`build merge` 开始时如果发现 HEAD 已变，会重新封存。

**做法**（持有任务锁，flow 不在运行）：

1. 设 `C = 任务分支 HEAD`，`B0 = merge-base(C, main)`。
2. 计算 `code_digest(C)`，并检查 `C` 的工作区是干净的。
3. 在 `AGENTLINE_DATA` 中为 `C` 建一个 detached 快照，在里面跑 gate CI，生成 `ci-gate.json`。
4. 生成 `manifest.json`：`run.json` 中每个 `log_ref`、每个交班单、`inputs.jsonl`、`ci-results.json` 和 ledger 中各调用归档的 `{path, sha256, size}`。
5. **归档：**把以上文件复制到 `B:/build/NNN/archive/<sha256>`，再逐个重新计算哈希核对。任何一项失败 → `E_ARCHIVE_FAILED`，停止。
6. 写 `.collab/build/NNN/{seal.json, ledger.json, ci-gate.json, manifest.json, t-gate.json, decisions.json}`，并做一次显式路径的提交 `agentline(seal): task NNN`，得到 S。
7. 校验 `diff(C, S) ⊆ .collab/build/NNN/**`，因此 `code_digest(S) == code_digest(C)`。
8. 在 S 上按 §4.4 求 T，写入 `t-gate.json`。

**`seal.json` 结构：**

```json
{ "schema": "agentline.seal/v1", "task": "004", "seal_seq": 1,
  "base_commit": "B0", "candidate_commit": "C", "code_digest": "sha256:…",
  "acceptance_digest": "sha256:…", "commands_digest": "sha256:…", "runner_digest": "sha256:…",
  "origin": { "blueprint": "…", "node": "T-002", "node_sha256": "…", "g1_approval_id": "apv-…", "graph_digest": "…" },
  "review": { "call_id": "c-004-0021", "reviewed_head": "…", "code_digest": "sha256:…",
              "verdict_file": "verdict-r1.json", "verdict_sha256": "…",
              "reviewer": { "identity_group": "openai/gpt-6.1-sol", "identity": "unverified" } },
  "dev_contributors": [ { "identity_group": "anthropic/claude-opus-5-5", "identity": "verified", "calls": ["c-004-0003", "c-004-0017"] } ],
  "files": { "ledger.json": "sha256:…", "ci-gate.json": "sha256:…", "manifest.json": "sha256:…" },
  "kernel_digest": "sha256:…", "core": "0.5.0", "sealed_at": "…" }
```

### 4.3 `build merge` 的新时序（detached job）

| # | 步骤 | 失败时 |
|---|---|---|
| 1 | 有效性链检查（§10.2） | `E_APPROVAL_STALE` 或 `E_APPROVAL_REVOKED`，停止 |
| 2 | HEAD 不等于 S → 重新封存 | 按 §4.2 的错误码停止 |
| 3 | 在 S 上求 T；必须 pass | `E_GATE_NOT_PASSED` |
| 4 | 确认归档完整（manifest 中每一项在 B 级都存在且哈希一致） | `E_ARCHIVE_FAILED` |
| 5 | 调用现有 `merge --permission … --keep-worktree --keep-branch`（`agentline.mjs:381`、`agentline.mjs:401` 已支持这两个参数），以 `--no-ff` 合并 S | 现有错误 |
| 6 | 合并后校验：`main` 的 `M^2 == S`；在 main 上用封存模式求 T（§4.4） | `E_POST_MERGE_VERIFY` → `blocked(integrity)`，**保留** worktree 和分支，Inbox 报警 |
| 7 | 写 `.collab/build/NNN/merged.json`：`{merge_commit M, seal_commit S, t_post_merge: "pass", at}`，显式路径提交到 main | — |
| 8 | 清理：移除 worktree，删除分支 | 失败只告警，不影响校验 |

### 4.4 T gate（替换 v1 §7.3 T）与 `check-task -Sealed`

**内容集合：**`seal.json` 及其 `files` 中列出的文件、`S` 的提交 ID，以及 `origin` 指向的节点 canonical JSON。

| check | 判定 | 可豁免 |
|---|---|---|
| `T.sealed` | `.collab/build/NNN/seal.json` 存在于 S 中，且 `files` 中的哈希逐项一致 | 否 |
| `T.seal_shape` | `diff(seal.candidate_commit, S) ⊆ .collab/build/NNN/**` | 否 |
| `T.reachable` | 合并前：S 是任务分支 HEAD；合并后：S 是 main 的祖先，且有 `merged.json` 时 `M^2 == S`。浅克隆返回 `error(E_SHALLOW_CLONE)` | 否 |
| `T.ledger_present` | `ledger.json` 存在，且其中没有未闭合的 `call.start` | 否 |
| `T.check_task` | 在 S 的临时 detached worktree 中运行 `check-task.ps1 -Sealed -BaseRef <seal.base_commit>`，退出码为 0 | 否 |
| `T.verdict_bound` / `T.ci_bound` / `T.isolation` | 见 §2.3 | 否 |
| `T.ac_coverage` | 同 v1 | 否 |
| `T.origin_valid` | 合并前：G1 批准当前有效，且 `node_sha256` 一致。合并后：该批准在 `merged_at` 时有效。之后的撤销由 G2 的 `M.origin_current` 处理 | 否 |
| `T.identity_verified` | 见 ⚑D2 | 视 ⚑D2 |

**`check-task.ps1 -Sealed`**

新增参数；不带该参数时行为与现在逐字节相同，旧夹具回归测试保持不变。各检查项在封存模式下的变化：

| 检查项 | 封存模式下的判定 |
|---|---|
| C3 | 用 `ledger.json` 的 D 和封存评审者判断，不再只看最后一次 dev 和最后一次 review |
| C4 | 读 `.collab/build/NNN/ci-gate.json`，不读 `ci-results.json` |
| C5 | 按 `seal.review` 校验：`verdict_sha256` 一致，`reviewed_head` 是 `candidate_commit` 的祖先；不再要求“是 HEAD 的祖先” |
| C6 | 每个 `log_ref` 和交班单都必须出现在 `manifest.json` 中，不在就 **FAIL**。文件在本机（worktree 或 B 级归档）时哈希必须一致，不一致就 **FAIL**；不在本机时输出 `[INFO] not_local`，不计 FAIL 也不计 WARN |
| C7 | 用 `git diff --name-only <base_commit>..<candidate_commit>` 并排除 `.collab/`，不再使用 `main...HEAD`（合并后这个差异为空） |
| C8 | 不变 |

### 4.5 边界情况

| 情况 | 处理 |
|---|---|
| 新 clone（非浅克隆） | A 级证据都在 git 里，T 可以重新求值；C6 对所有日志报 `not_local`；`audit verify` 显示“过程记录不在本机” |
| 浅克隆 | `T.reachable = error(E_SHALLOW_CLONE)`，提示 `git fetch --unshallow`；不判为 pass |
| 有人用 squash 或 rebase 合并 | 不会出现 `M^2 == S`，S 也不是 main 的祖先 → `T.reachable` fail。核心只使用 `--no-ff` |
| 仓库忽略了 `.collab/`（本仓库根 `.gitignore` 就是这样） | `build start` 前置检查 `git check-ignore .collab/tasks/x .collab/build/x` 命中 → `E_COLLAB_IGNORED`（config），Blueprint 来源任务不能启动。旧任务和临时任务不受影响 |
| 回滚期间合并、没有封存的任务 | `build seal --post-merge --task NNN`：以 `M^2` 为候选，验证 ledger 和归档的证据（必须完整），在 main 上做封存提交。证据不完整则保持 fail |

### 4.6 B4 验收例子

| # | 场景 | 期望结果 |
|---|---|---|
| A4-1 | 本机：`build merge 004` 成功后 worktree 和分支都已删除，执行 `gate eval T:004` | pass；C6 中日志报 `[OK]`，来源是 B 级归档 |
| A4-2 | 新 clone，执行 `gate eval T:004` | pass；C6 对所有日志报 `[INFO] not_local`，结果仍为 pass；`audit verify` 输出 `not_local` |
| A4-3 | 新 clone，用 `--depth 1` | `T.reachable = error(E_SHALLOW_CLONE)`，gate 状态为 `failing` |
| A4-4 | 本机篡改归档中某个日志的 1 个字节，然后 eval | C6 FAIL，报 `hash mismatch` |
| A4-5 | 合并前删除 B 级归档目录 | 步骤 4 报 `E_ARCHIVE_FAILED`，不合并，worktree 保留 |
| A4-6 | 在 main 上 squash 合并 004 | `T.reachable` fail；`M.task_gates` fail；Inbox 显示 `unsealed_merge` |
| A4-7 | 合并后，`M.task_gates` 对里程碑内所有任务重新求 T | 不需要任何 worktree 或分支即可全部求值 |

---

## 5. M1：单条 CLI 命令表（替换 v1 §4.2、§4.3 白名单和 §5.11 对应表）

### 5.1 约定

- 一个用户动作对应 **一条**公开 CLI。复合业务动作由核心在这条命令内部完成。
- 执行方式分两种：
  - **sync**：Host 等待，超时 30 秒。
  - **job**：CLI 在 5 秒内返回 `{job_id}`，进度从 `/v2/jobs` 读取。Host 侧不再有 120 秒的同步调用。
- **job 记录：**C 级 `orchestrator/data/jobs/<id>.json`，内容为 `{id, command, argv_digest, pid, state: queued|running|succeeded|failed|cancelled, started_at, ended_at, envelope}`。
- 下表中 H 表示只接受人类通道，并且需要原话；W 表示写，R 表示只读。

### 5.2 命令表

| 用户动作（UI / 斜杠） | command id | CLI（唯一） | 类型 | 方式 | 状态变化 |
|---|---|---|---|---|---|
| 新建 Studio | `studio.new` | `studio new --repo --title --input` | W | sync | → draft |
| 导入手工 Studio | `studio.import` | `studio import --from` | W·H | sync | → concluded（imported） |
| 指定角色 | `studio.assign` | `studio assign --id --role --models` | W | sync | 仅 draft |
| 预检 / 探测 / 锁定 | `studio.lock` | `studio lock --id`（内部依次执行 preflight、需要的 probe 和约束求值） | W | **job** | draft → ready，或保持 draft 并给出原因 |
| 运行 | `studio.run` | `studio run --id` | W | job | ready 或 awaiting → running → 下一个人工停点 |
| 故障修复后继续 | `studio.resume` | `studio resume --id` | W | job | blocked → running |
| 立即重试（跳过等待） | `studio.retry_now` | `studio retry-now --id` | W | sync | waiting → running |
| 回答问题 / 采用默认 | `studio.answer` | `studio answer --id --question (--choice\|--text\|--accept-default)` | W·H | sync | 问题 → answered |
| 决策用尽 2 轮后的处理 | `studio.rule` | `studio rule --id --question --ruling default\|text\|unresolved --text` | W·H | sync | 问题 → default_adopted / answered / unresolved |
| 确认单条决策 | `studio.confirm` | `studio confirm --id --decision --text` | W·H | sync | 该决策 → confirmed |
| 确认备选模型 | `studio.confirm_model` | `studio confirm-model --id --role --use <key> --text` | W·H | job | 见 §6.3 |
| 追加预算 | `studio.budget` | `studio budget --id --add-calls/--add-tokens/--add-usd --text` | W·H | sync | awaiting(budget) → ready |
| 结束并评估 G0 | `studio.conclude` | `studio conclude --id`（内部包含 gate eval） | W | sync | → concluded |
| 取消 | `studio.cancel` | `studio cancel --id --text` | W·H | sync | → cancelled |
| Blueprint 的同类动作 | `blueprint.*` | `blueprint new\|import\|assign\|lock\|run\|resume\|retry-now\|confirm-model\|budget\|cancel` | 同上 | 同上 | 同上 |
| 继续下一轮 | `blueprint.continue` | `blueprint continue --id --text` | W·H | job | awaiting(continue_round) → running |
| 轮次耗尽后裁决 | `blueprint.decide` | `blueprint decide --id --ruling --text` | W·H | sync | 按 ⚑D3 |
| 预览物化 | `blueprint.materialize_plan` | `blueprint materialize --id --dry-run` | R | sync | 返回 `plan_digest` |
| 生成 Build 任务 | `blueprint.materialize` | `blueprint materialize --id --plan <digest>` | W | sync | → materialized（§9） |
| 新建临时任务（含旧语法 `/agentline <目标>`） | `task.new` | `task new --repo --goal [--adhoc-reason] [--start]`（`--start` 时核心内部完成 build start） | W | sync，带 `--start` 时为 job | 新任务，可选进入 running |
| 开始任务 | `build.start` | `build start --task`（`user_gate` 任务需 H） | W | job | → running |
| 按里程碑排队 | `build.queue` | `build queue --blueprint [--milestone]` | W | sync | → queued |
| 保留现场继续 | `build.resume_keep` | `build resume --task --keep` | W | job | → running |
| 丢弃改动继续 | `build.resume_discard` | `build resume --task --discard --text` | W·H | job | → running |
| 立即重试 | `build.retry_now` | `build retry-now --task` | W | sync | waiting → running |
| 停止 | `build.stop` | `build stop --task [--now]` | W | sync | → blocked(halted) |
| 轮次耗尽后裁决 | `build.decide` | `build decide --task --ruling --text` | W·H | sync | 按 ⚑D3 |
| 合并 | `build.merge` | `build merge --task (--permission\|--grant)` | W·H | **job** | → merged（§4.3） |
| 补封存 | `build.seal_post_merge` | `build seal --task --post-merge --text` | W·H | job | §4.5 |
| 运行 E2E | `milestone.e2e` | `milestone e2e --blueprint --milestone` | W | job | 写 `e2e-results.json` |
| 人工验收勾选 | `milestone.check` | `milestone check --milestone --check --result pass\|fail --text` | W·H | sync | 写 `manual-checks.json` |
| 评估 gate | `gate.eval` | `gate eval --gate` | W | sync，T 和 G2 为 job | 写 `gate.json` |
| 批准 / 撤销 / 豁免 | `gate.approve` / `gate.revoke` / `gate.waive` | `approve …` / `approve --revoke …` / `waive …` | W·H | sync | 见 v1 |
| 扫描模型 | `models.discover` | `models discover` | W | job | C 级缓存 |
| 探测模型 | `models.probe` | `models probe <key>\|--role\|--all` | W | **job** | 写 probe 记录 |
| 手工登记 / 设档位 / 下线 | `models.add` / `models.tier` / `models.retire` | 同 v1 | W·H | sync | 新 config rev |
| 应用角色（含自动 probe） | `roles.set` | `roles set --stage --role --models --expected-revision`（同步写入 rev，内部启动 probe job） | W·H | sync，返回 `{rev, probe_job}` | 新 rev；probe 异步回填 |
| 回滚配置 | `config.rollback` | `config rollback --to --text` | W·H | sync | 新 rev |
| 标记中断任务 | `recover.sweep` | `recover --repo` | W | sync | 将中断任务标为 interrupted |
| 迁移 | `migrate.*` | `migrate plan\|apply --what` | apply 为 W·H | sync / job | §7.3 |
| 停止接收新运行（回滚前） | `ops.drain` / `ops.undrain` | `drain --text` / `undrain --text` | W·H | sync | §8.3 |
| 查看 job | — | `job show --id` | R | sync | — |

Read 类命令同 v1 §4.2。Host 白名单与上表一一对应。`build worker` 是内部命令，**不进入**白名单。

### 5.3 斜杠和按钮的修订

- **旧语法第 3 步：**改为调用**一条** `task new --goal … --adhoc-reason "slash:legacy" --start`。插件里不再出现“先建任务、再启动”两步。
- **“我已登录，继续”：**按阶段分别映射到 `studio.resume`、`blueprint.resume` 或 `build.resume_keep`。
- **新增斜杠命令：**
  - `/agentline task decide <NNN> <ruling> "<原话>"`
  - `/agentline milestone e2e|check …`
  - `/agentline budget <S|B> …`
  - `/agentline job <id>`
- **job 类命令的回复：**`✔ 已开始：build.merge job-7f3a（合并前将封存并校验）`。完成后由现有 followup 注入结果。

---

## 6. M2：角色锁定、probe 与超时

### 6.1 `roles.lock.json` v2（替换 v1 schema；Build 的 `B:/build/NNN/lock.json` 使用同一结构）

```json
{ "schema": "agentline.roleslock/v2", "stage": "blueprint", "locked_at": "…", "config_revision": 13,
  "roles": { "designer": { "candidates": [ {
      "key": "claude-opus-5-5", "provider": "claude", "adapter": "claude-cli", "model_id": "claude-opus-5-5",
      "vendor": "anthropic", "identity_group": "anthropic/claude-opus-5-5",
      "tier": "top", "tier_source": "allowlist", "tier_evidence_sha256": "…",
      "effort": "high", "readonly_args_digest": "sha256:…",
      "limits": { "timeoutMinutes": 60, "stallMinutes": 10 },
      "cli": { "path": "C:/…/claude.cmd", "version": "2.3.1", "fingerprint": "sha256:…" },
      "probe": { "ref": "probes/claude/claude-opus-5-5/20261106T0912.json", "sha256": "…", "identity": "verified" } } ] } },
  "constraints": { "rules_version": "roles/2", "evaluated": [ … ] },
  "exec_config_digest": "sha256:…" }
```

- **执行时只读锁。**每次调用前比对当前 CLI 指纹与锁中的值。不一致 → `E_CLI_VERSION_DRIFT`，进入 `blocked(config)`，不静默继续。
- **重新锁定：**`<stage> lock --id --relock --text`（H），重新 probe 并生成新锁。旧锁保留在 history 中。

### 6.2 约束修订

`ALL.callable` 的判定改为：**锁内**每个候选的 probe 都通过。没进锁的候选不参与判定。

### 6.3 主选失败后的备选确认与角色应用

**确认备选**

1. `lock` job 中主选 X 的 probe 失败，而备选 Y 通过 → 会话进入 `awaiting_user(model_change_confirm)`，仍保持 draft。
2. 用户执行 `confirm-model --role r --use Y --text`。核心依次：
   - 在**本会话的草稿**中，把 r 的候选设为 `[Y, 其余通过的备选]`，移除 X。全局配置不变；Inbox 另外提示“是否同步更新全局角色”。
   - 重新求全部约束；对缓存过期的候选补 probe。
   - 全部通过 → 写锁，进入 ready；否则保持 draft，并列出原因。
3. 整个过程是一条 CLI、一个 job。

**设置页“应用角色”**（替换 v1 §5.6 第 4 步）

1. 发出一条 `roles.set`。
2. 核心同步写入新的 rev，并在内部启动 probe job，立即返回 `{rev, probe_job}`。
3. UI 按 `probe_job` 显示进度。插件不会再发第二条命令。

### 6.4 probe 的超时与执行方式

| 项 | 值 |
|---|---|
| 单次尝试 | 90 秒 |
| 尝试次数 | 1 次加 2 次重试，只针对基础设施错误；退避 5 秒、15 秒 |
| 单候选最坏耗时 | 3 × 90 + 20 = 290 秒；job 内单候选的截止时间为 300 秒 |
| 并发 | 同一 provider 最多 2 个，不同 provider 并行 |
| 执行方式 | 一律 job（`models probe`、`lock`、`roles set` 内部的 probe），不受 Host 同步超时限制 |

### 6.5 行业建议（替换 v1 §6.3 维护方式）

“不提供建议”的选项删除，因为 Q3 要求提供建议。维护方式只在两项中选（⚑U5）：

- **A：**只通过人工 PR 更新。
- **B：**由 top 模型检索公开资料生成草稿，人工审核后提 PR。

设计师倾向 B。

---

## 7. M3：Git 分级留存（替换 v1 §3.1）

### 7.1 逐文件边界

“A”表示进 git，“B”表示放在 `AGENTLINE_DATA`，进 git 的只有哈希。

| 路径 | 级别 | 规则 |
|---|---|---|
| `studio/<sid>/input.md` | A | 需求输入，属于契约，等同于 `brief.md` |
| `studio/<sid>/questions.json` | A | `answer` 只存 `{choice, text_sha256, text_len, channel, at}` |
| `studio/<sid>/answers.jsonl` | **B** | 用户自由文本回答 |
| `studio/<sid>/{facts,minutes-final,moderator-brief,decisions}.md`、`decisions.json` | A | 定稿摘要 |
| `studio/<sid>/confirmations.json` | A | 专家备注每条 ≤ 1000 字符；超出部分移到 B，A 中存哈希 |
| `studio/<sid>/rounds/**`、专家全文 | B | — |
| `*/approvals.json`、`gate.json`、`decisions.json` 中的原话 | A | 授权记录，每条 ≤ 500 字符 |
| `blueprint/<bid>/` 定稿文件、`review-rN.verdict.json`、`testability.json` | A | — |
| 设计各版本全文、评审全文 | B | — |
| `tasks/NNN/{brief,design,acceptance,impl}.md`、`review*.md`、`verdict*.json`、`state.json`、`run.json`、`origin.json`、`attention.json` | A | 沿用现状 |
| `tasks/NNN/ci-results.json` | **B（新增忽略）** | 其中包含完整命令输出；A 级用 `build/NNN/ci-gate.json` 代替，每个用例只保留 `{id, passed, exit, duration, last_line ≤ 200 字符（已脱敏）, output_sha256}` |
| `tasks/NNN/inputs.jsonl` | **B（新增忽略）** | 用户原文；`manifest.json` 中存哈希、条数和类型 |
| `tasks/NNN/{logs,handoff}/`、`live.json`、`control.json`、`mailbox*.md`、`notice.json` | B 或运行态 | — |
| `build/NNN/{seal,ledger,ci-gate,manifest,t-gate,decisions,merged}.json` | A | 不含原文 |
| `milestones/<M>/{gate,approvals,e2e-results,manual-checks}.json` | A | E2E 输出同样只保留摘要 |

### 7.2 `.collab/.gitignore`（替换 v1 的模板）

```gitignore
# agentline: process records (Q6)  rules_version=retention/2
tasks/*/logs/
tasks/*/handoff/
tasks/*/live.json
tasks/*/control.json
tasks/*/mailbox*.md
tasks/*/notice.json
tasks/*/ci-results.json
tasks/*/inputs.jsonl
studio/*/answers.jsonl
studio/*/rounds/
blueprint/*/rounds/
worktrees/
```

### 7.3 迁移与完成状态

`migrate apply --what git-retention` 分 3 步，每一步都需要人类确认：

1. 在 main 上用显式路径提交 `.collab/.gitignore`。
2. 列出“已被跟踪但应当忽略”的文件（`git ls-files -ci --exclude-standard`）。
3. 可选：对上一步的文件执行 `git rm --cached`。这一步不改写历史，而且需要单独确认。

**完成状态**（写在 C 级 `retention.json`，设置页显示）：

| 状态 | 条件 |
|---|---|
| `not_applied` | 第 1 步未完成 |
| `partial` | 第 1 步完成；还有 N 个旧文件被跟踪，用户拒绝或尚未执行第 3 步 |
| `applied` | 第 1 步完成，且 N = 0 |

**`build start`（Blueprint 来源任务）的前置条件**

- base ref 中 `.collab/.gitignore` 存在，且 `rules_version` ≥ `retention/2`。不满足 → `E_RETENTION_NOT_APPLIED`（config）。
- worktree 建好后，用 `git check-ignore` 抽查新任务的 `logs/` 和 `ci-results.json`，必须被忽略。

`partial` 状态**允许**启动：新任务的过程文件都是新文件，会被忽略；仍被跟踪的只有旧任务的文件，而 `git add -A`（`git.mjs:68`）只会在旧任务重跑时更新它们。UI 对此标黄提示。

---

## 8. M4：版本兼容（替换 v1 §9.1、§9.2、§9.7）

### 8.1 组合矩阵

| 插件 \ 核心 | 核心 0.4.0 | 核心 0.5.x |
|---|---|---|
| **插件 0.17.0** | 基线 | **受限支持。**旧路由和旧 CLI 可用。旧插件直接 spawn `flow`，对临时任务照常运行；对 Blueprint 来源任务，合并会被 `E_USE_BUILD_MERGE` 拒绝。旧插件 GET 请求中的写行为仍然存在（已知）。不支持 v2 界面 |
| **插件 0.18.x** | **降级。**`version --json` 不可用时进入 `legacy-core` 模式：只显示 Build 驾驶舱，写操作走旧 CLI（`flow`、`merge`、`stop`、`input`、`answer`）。旧语法 `/agentline <目标>` 在该模式下**仍由插件写 `brief.md`**，这是对边界规则 B3 的、仅限此模式的例外，UI 会标注 | **完整支持** |

### 8.2 路由修订（如实收窄承诺）

| 路由 | 插件 0.18 的行为 | 兼容性 |
|---|---|---|
| `GET /agentline/flow` | 返回 **405**，提示改用 `POST /agentline/v2/command`。插件自己的 client 已改为 POST | **破坏性**：外部 GET 调用方失效 |
| `GET /agentline/control?action=*` | 405 | 破坏性 |
| `GET /agentline/projects` | 只读；不再执行 sweep | 返回字段向后兼容 |
| `POST /agentline/{models,routing}` | 内部调用 `roles set` | 请求和响应格式兼容 |
| 其余只读路由 | 不变 | 兼容 |

v1 中“v1 路由继续可用”的说法改为：**只读路由继续可用；用 GET 执行写操作的路由不再兼容。**

### 8.3 运行中进程与回滚

- **`drain`**（H）：
  - 写入 C 级 `drain.json`。
  - `build start`、`build queue`、`* run` 一律返回 `E_DRAINING`。
  - Studio/Blueprint worker 在当前步骤结束后退出。
  - Build worker 通过现有的 `requestStop(after_stage)` 在阶段结束时退出。
  - `drain status` 列出仍在运行的进程。
- **回滚核心到 0.4.0：**
  - 要求 `drain status` 为 0。
  - 如果强制回滚（`migrate rollback-core --force --text`，H）：内存中已在运行的 worker 会跑完；之后 Blueprint 来源任务落在旧核心手里，**gate 兜底失效**。这是用户在原话中确认过的降级。
  - 重新升级时，Supervisor 接管这些任务；回滚期间合并的任务按 §4.5 处理。
- **回滚插件到 0.17.0：**同 v1；v2 数据对旧插件不可见。
- **数据：**同 v1；`.collab/build/**` 对旧核心无害。

---

## 9. M5：物化与 worktree 交接

### 9.1 `blueprint materialize`

| 项 | 规则 |
|---|---|
| 计划 | `--dry-run` 返回映射表和 `plan_digest = H(mapping, graph_digest, g1_approval_id, main HEAD)` |
| 执行 | 必须带 `--plan <digest>`；重新计算后不一致 → `E_PLAN_STALE`（预览之后任务图、批准或 main 发生了变化） |
| 锁 | 仓库级锁 `.git/agentline/materialize.lock` |
| 编号预留 | NNN = max(main 上 `.collab/tasks/*`、所有 `task/*` 分支、全部 `materialized.json`、registry) + 1，按拓扑顺序依次分配 |
| 原子性 | 先在临时目录生成全部 `brief.md`、`origin.json` 和 `materialized.json`，再在 main 上用显式路径**一次提交**。提交失败则什么都不可见；没有“部分物化”的中间状态 |
| 前置条件 | main 工作区当前分支是 `main`（否则 `E_MAIN_NOT_CHECKED_OUT`）；目标路径不存在；有效性链通过 |
| 幂等 | 键为 `(g1_approval_id, graph_digest)`。键相同 → 返回已有映射（`replayed:true`，退出码 0）；键不同而已经物化过 → `E_ALREADY_MATERIALIZED`，可加 `--supersede --text`（H）：新建一批任务，旧批中尚未开始的任务标为 cancelled |

### 9.2 进入 worktree

- `brief.md` 和 `origin.json` 已经提交到 main。`build start` 时调用现有的 `ensureTaskWorktree(baseRef = main)`（`worktree.mjs:42`），从**当时的** main 创建 worktree，文件自然就在里面，依赖任务的合并结果也在里面。
- 留存规则（`.collab/.gitignore`）同样随 main 进入 worktree，并按 §7.3 检查。
- worktree 只在 `build start` 时创建，物化时不创建。

### 9.3 调度条件

| 字段 | 满足条件 | 在什么时候检查 |
|---|---|---|
| `depends_on` | 每个依赖任务都已 `merged`，且合并后的 T 为 pass（`merged.json.t_post_merge = pass`） | `build start` 和 `build queue` 调度时 |
| 任务的 `user_gate:true` | `build start` 必须来自人类通道并带原话；不能被 queue 自动启动；合并不能用 grant | 启动时和合并时 |
| 里程碑的 `user_gate:true` | 下一里程碑的任务要等本里程碑 G2 为 passed 才能启动 | 启动时 |
| 里程碑的 `user_gate:false` | 只看 `depends_on` | — |
| `write_scope` 冲突 | 沿用 registry 排队 | flow 内部 |

---

## 10. M6：人工授权的信任边界

### 10.1 明确声明（替换 v1 T5、R4 中的承诺表述）

- **可以承诺：**插件不计算也不写入 gate；人类通道命令不注册为 LLM 工具；每条授权都记录通道和原话。
- **不能承诺：**机器已经证明某次批准来自人。本机 CLI 以 OS 用户账户为信任边界：凡是以该用户身份运行的进程（包括有 shell 权限的 agent）都能调用 `approve`，并能自称任意 `--channel`。这是**信任约定，不是机器证明**。UI 与文档统一使用这一表述。
- **是否增加 Host 签名**（让伪造 `ui` 或 `slash` 通道必须刻意读取私钥文件，从而在 agent 记录中可见）由 ⚑D4 裁决。即使增加，也只是提高门槛，不能证明来自人。

### 10.2 有效性链（start、materialize、merge 都必须全部通过）

有效性链只读、按顺序求值：

1. 对来源 G0 重新计算内容哈希，与批准的哈希比较。
2. `approvals.json` 中该 `approval_id` 的 `revoked_at` 为空。
3. G1 同样执行第 1、2 步，且 `G1.studio_link` 当前为 pass。
4. `materialized.json` 中有该任务，且 `origin.node_sha256` 等于当前任务图中该节点的哈希。
5. merge 时额外要求：`merge --permission` 的原话来自人类通道；grant 符合 §3 第 5 条。

任一步失败分别返回 `E_APPROVAL_STALE`、`E_APPROVAL_REVOKED`、`E_ORIGIN_MISMATCH`。**不能只比较内容哈希。**

---

## 11. Minor 修订

### 11.1 Studio 轮次语义（替换 v1 §5.3 的步骤组段落）

- `studio run` 从当前位置**连续执行**，直到遇到下一个人工停点（问题、确认、专家拒绝）、错误或预算上限。
- 步骤组（experts、moderator、scribe、confirm）是持久化和续跑的单位，**不是**停点。
- 两种计数：
  - **讨论轮：**每次 experts → moderator 记一轮。不设上限，受会话预算约束。UI 标为“讨论轮 n”。
  - **决策轮：**每条决策的 `rounds_used`，上限 2（协议常量）。

### 11.2 错误类别（补充 v1 §7.1 的“列说明”）

| 类别 | 含义 | 是否计入业务轮次 |
|---|---|---|
| `business_input` | 输入超出能力范围，如 `E_CONTEXT_OVERFLOW` | 否 |
| `model_quality` | 产物格式不合格，如 `E_INVALID_OUTPUT`、`E_NO_CHANGES`、`E_NO_NEW_WORK` | 否；计入该步骤的物理调用预算 |

v1 中的 `business-input` 和 `model-quality` 统一写成以上下划线形式。

### 11.3 终态统一

| 码 | 终态 |
|---|---|
| `E_UNKNOWN_SIDE_EFFECTS` | **一律** `awaiting_user(interrupted_choice)`；v1 中 `E_TIMEOUT` 和 `E_CLI_CRASH` 行的 “blocked(E_UNKNOWN_SIDE_EFFECTS)” 改成这个 |
| `E_PROCESS_LINGERING`（新增，integrity） | 进程树没能确认终止 → `blocked` |
| `E_TIMEOUT` / `E_CLI_CRASH`（写角色） | 现场干净时可以重试，计入步骤预算；现场已脏时为 `E_UNKNOWN_SIDE_EFFECTS` |

### 11.4 `E_REPEATED`

- **计数单位：**同一主体、同一逻辑步骤、同一错误码的**连续**物理调用失败。
- **重置条件：**该主体内任意一次物理调用成功。用户的 `resume` 和 `retry-now` **不**重置计数，但各自允许多做 1 次调用，仍受步骤预算约束。
- **达到 3 次** → `blocked(repeated:<code>)`。

### 11.5 summary 的刷新依据

- `revision` 改为 **`etag`**，由以下各项算出：
  - 各会话和任务的 revision；
  - 派生的 gate 状态，包括 stale；
  - 内容集合文件的 `(mtime, size)` 指纹；
  - Supervisor 运行态的 revision；
  - job 状态。
- 外部改动文件会让 etag 变化，派生出的失效也会让 etag 变化。
- 插件以 etag 作为条件拉取详情的依据；Gate 视图打开时再做完整的哈希计算。

### 11.6 模块路径

见 §0.3，不再作为用户裁决项。

---

## 12. 测试与实现切分的增量

### 12.1 测试增量（追加到 v1 §11）

| 层 | 对象 | 关键用例 |
|---|---|---|
| 契约 | 内核接缝（B9） | 日志名格式；拒绝文本被归为 `run_failed`；`maxSwitchesPerStage = 1` 时不写交班单；`networkRetries = 0` 时只有一次物理调用；从 `reviewable` resume 时重跑 CI 和 r1 |
| 集成 | CallGuard 与 worker | 验收例子 A1-1 到 A1-7 |
| 单元 | `code_digest` | 已提交与未提交但内容相同 → 摘要相等；只改 `.collab/` → 相等；改 1 字节产品代码 → 不等 |
| 单元 | 证据绑定 | 验收例子 A2-1 到 A2-8 |
| 回归 | check-task | 不带 `-Sealed` 时旧夹具输出逐字节一致 |
| 集成 | 封存与合并 | 验收例子 A4-1 到 A4-7，包含新 clone 和浅克隆 |
| 集成 | 物化 | 计划失效；重复调用；`--supersede`；中途失败没有可见残留；`E_COLLAB_IGNORED` |
| 兼容 | 版本矩阵 | §8.1 的 4 种组合各有一个冒烟夹具 |
| 守卫 | B10、B11 | 扫描 Supervisor 代码中的 `add -A`，以及对 `state.json`、`run.json` 的写入 |

### 12.2 实现切分修订（替换 v1 §10 中的对应行）

| 工作流 | 内容 | 依赖 |
|---|---|---|
| W7a | CallGuard、ledger、归约器、build worker、接缝契约测试 | W1、W4 |
| W7b | Supervisor 命令、等待与轮换、`view_status` | W7a |
| W15 | 封存、归档、gate CI、`check-task -Sealed`、合并时序 | W5、W7a |
| W16 | job 框架、物化、有效性链、drain | W1、W5 |

**关键路径：**W1 → W4/W5 → W7a → W15 → W7b → W10。

W7a 的接缝测试应**最先**完成。如果它表明 exec 的约定不稳定，可以在动工之前把 ⚑D1 改选为 K1。

---

## 13. 风险与待用户裁决项（替换 v1 §12）

### 13.1 风险修订

| # | 风险 | 缓解 |
|---|---|---|
| R3（替换） | 兑现 Build 的轮次和预算依赖 exec 的内部约定 | B9 接缝测试加运行时内核摘要；不稳定时改用 K1（⚑D1） |
| R4（替换） | 无法证明授权来自人 | §10.1 明确是信任约定；可选 Host 签名（⚑D4） |
| R6（替换） | 新 clone 没有日志 | §4：T 只依赖 git；日志属于审计，标为 `not_local`。**不再使用 `-Lenient`** |
| R11（新增） | gate CI 让每个任务多跑一次验收 | 接受这个耗时代价，换取 CI 证据与代码快照绑定；验收命令很慢时提示，但不跳过 |
| R12（新增） | 自动向 main 写 A 级提交（物化、批准、合并标记） | 只用显式路径；要求 main 已检出；遇到冲突拒绝执行，不会改写用户的改动 |

### 13.2 待用户裁决

| # | 问题 | 选项 | 设计师倾向（仅供参考） |
|---|---|---|---|
| **⚑D1**（新增，B1） | Build 控制方式 | **A（K0）：**通过 `adapterFactory` 接缝在 flow 进程内设置 CallGuard，flow/exec 不改；接受 §1.1 的残余限制 1–3（依赖内部约定、拒绝后状态显示 run_failed、评审重放）。**B（K1）：**授权按 §1.10 对 `flow.mjs` 和 `exec.mjs` 做约 40 行的钩子改动，单开 Blueprint，与 Q1 的字面要求冲突。**C：**两者都不接受，那么 Build 的“三轮上限、统一预算、逐调用证据”**不能承诺**，只能事后记录 | A；如果 W7a 的接缝测试不稳定，再改选 B |
| **⚑D2**（合并原 U2 和 U11） | 身份无法证明时怎么办，以及手工 Studio 导入能否作为例外 | strict：`blocked(E_MODEL_UNVERIFIED)`，Build 同样适用（会影响当前使用 gpt-6.1-sol 的 dev 和 review）。explicit_exception：人工为固定版本登记例外，`*.identity_verified` 只能以豁免通过，并始终显示“未验证”，不会显示为已验证。分阶段：Studio/Blueprint 用 strict，Build 用 explicit_exception；手工导入的 Studio 同样以豁免通过并标注“导入” | 分阶段 |
| **⚑D3**（原 U3） | 三轮耗尽后怎么办（Blueprint 和 Build 都适用） | hard_limit：原会话或任务结束，按裁决新建关联会话或任务。bounded_extension：在原会话追加 1 轮（最多 4 轮）。repeatable：每次授权加 1 轮。是否允许 `accept_as_is`（接受未通过评审的版本）？在新授权之前一律停在 round_limit | hard_limit，不提供 accept_as_is |
| **⚑D4**（新增，M6） | 本机 CLI 作为人工授权入口 | A：接受“本机用户账户即信任边界”的约定，不加签名。B：A 加上 Host 签名：`ui` 和 `slash` 通道的命令必须带签名，`cli` 通道的 G1/G2 批准和合并许可在 UI 中标红 | B |
| U1 | top 模型数量不足，Blueprint 三角色无法两两不同 | 同 v1 | A |
| U5 | 行业建议的维护方式 | 只在 A 和 B 中选（§6.5） | B |
| U7 | 有活跃 Blueprint 时如何处理临时任务 | 同 v1 | allow_labeled |
| U8 | 基础设施自动等待的上限和“到点自动继续” | 同 v1 | 30 分钟，默认关 |
| U9 | 过程记录目录 | 同 v1 | `%LOCALAPPDATA%` |
| U12 | 阶段预算默认值 | 同 v1 | 同 v1 |

**不再提交裁决的事项：**

- U4、U6、U10：由设计师确定，理由见 §0.3。
- 是否允许越过不可豁免项：保持现行协议，失败关闭（§3 第 7 条）。
- 是否放宽三角色模型隔离：保持现行协议，不再询问。

---

## 14. 合并后的设计清单（v1 + 本增量）

1. **架构：**控制面位于 `orchestrator/lib/`；flow/exec 零改动；Build 通过 build worker 和 CallGuard 受控（K0，等待 ⚑D1 确认）。
2. **数据：**A/B/C 三级留存，按文件划分边界（§7）；每个任务有 `.collab/build/NNN/` 封存目录；ledger 是业务轮次和调用证据的唯一依据。
3. **证据：**每类证据都绑定输入摘要、执行身份和新鲜度（§2）；`code_digest` 定义了哪些变化不影响产品快照。
4. **Gate：**G0、G1、T、G2 按 §2.3 和 §4.4 修订；T 只依赖 git 中的不可变对象；合并后、本机和新 clone 的规则一致。
5. **合并：**唯一入口是 `build merge` job，依次执行有效性链、封存、T、归档、`--no-ff` 合并、合并后校验、清理；没有 override。
6. **轮次与预算：**Studio 每条决策 2 轮；Blueprint 3 轮；Build 3 轮，以代码摘要计数、按纪元重置；每个逻辑步骤最多 3 次物理调用（重试和轮换合计）。
7. **命令：**每个动作对应一条 CLI；长操作是 job；Host 不再有超过 30 秒的同步调用。
8. **模型：**锁中冻结完整执行配置；指纹漂移时 blocked；备选确认是一条命令；probe 以 job 方式执行。
9. **物化：**计划摘要、编号预留、原子提交和幂等；brief 经 main 提交进入 worktree；`depends_on` 要求依赖任务已合并且 T 通过。
10. **兼容：**4 种组合的矩阵；用 GET 写的路由明确不再兼容；回滚前先 drain。
11. **信任：**本机用户账户即信任边界，这是约定，不是证明（⚑D4）；start、materialize、merge 都检查有效性链。
12. **待裁决：**⚑D1–D4，以及 U1、U5、U7、U8、U9、U12。
