# AgentLine Blueprint 20261106：设计 v3 增量（design-v3-delta）

- 状态：设计第 3 轮（共 3 轮），待审核。**本轮不通过就交用户裁决，不再自动开第 4 轮**（§11）。
- 日期：2026-11-06
- 主设计：Claude Opus 5.5；审核：GPT-6 Astra
- 基线：`design-v1.md` 加 `design-v2-delta.md`。本文件只写**替换或新增**的内容，没提到的章节原样保留。
- 输入：`review-v2.md`、`brief.md`、`decisions.md`，以及以下源码的静态核对：`orchestrator/lib/{flow,exec,git,routing,inputs,prompt,recovery}.mjs`、`orchestrator/agentline.mjs`、`plugin/lib/index.js`。
- 本轮不改仓库代码，也不执行产品流程。
- 需要用户裁决的事项集中在 §10。正文中写作 `⚑D<n>`，设计师没有替用户拍板。

---

## 0. 读法、关闭对照与替换章节清单

### 0.1 review-v2 问题 → 本文件章节

| 问题 | v3 结论 | 章节 |
|---|---|---|
| **B1** CallGuard 恢复契约 | **撤回“K0 足够”。**用源码状态迁移证明 K0 在 3 类现场中无法兑现。改为提出 **K1：在 `flow.mjs` 中新增单步入口 `runStep`**；`runFlow` 和 `exec.mjs` 都不改，由 Supervisor 驱动循环。业务轮次按步骤计数，不再按摘要计数。K1 违反 Q1“flow 零侵入”的字面要求，所以交 ⚑D1 裁决；不授权时，Q5 的承诺要按 §1.10 降级 | §1 |
| **B2** G2 验证对象 | G2 批准的是**固定的历史集成快照 I**，不是当前 main。I 只能由 `milestone e2e` 显式选定。`manual-checks.json` 和检查定义都进入内容集合。下游准入检查同一个 I | §2 |
| **B4** 合并与封存 | 规定普通合并的提交拓扑（C → S → M → K）。**补封存移出范围。**`build merge` 不调用旧 merge 的 CLI 或函数。T 的结果是派生缓存，不进 git | §3 |
| **M2** 执行配置唯一来源 | 执行时只用 LockedConfig；项目 routing 只在生成锁时读一次；provider 对象原样冻结，可以从锁中重建 | §4 |
| **M3/M5** Git 写入事务 | 统一 MainWrite 协议：共享写锁、`git commit --only`、事务日志加回滚；旧 merge 的 `commitAll` 也纳入协议 | §5 |
| **M4** 兼容与 drain | 删除“新插件配旧核心时写 `brief.md`”的例外；drain 改为统一的准入函数，覆盖所有会启动工作进程的命令 | §6 |
| Minor | 补齐命令表；恢复预算改为“第 3 次调用前决定是否轮换”；按操作区分有效性链；删除 D3/U1 中越界的选项 | §7 |

### 0.2 替换章节清单（合并 v1 + v2 + v3 时按此拼装）

| 原章节 | 处理 | v3 来源 |
|---|---|---|
| v2 §1.1 结论、§1.2 接缝清单 | 整节替换 | §1.1、§1.2 |
| v2 §1.3 build worker | 替换。worker 调 `runStep`，不再调 `runFlow` | §1.3 |
| v2 §1.4 CallGuard | 替换。CallGuard 退化为记录器加安全网，**删除“评审重放”** | §1.6 |
| v2 §1.5 业务轮次归约器 | 整节替换。按步骤计轮，`r = \|S_e\|` 作废 | §1.4 |
| v2 §1.6 统一恢复预算与动作 | 整节替换 | §1.5 |
| v2 §1.7 控制接口 | 并入 §8 命令表 | §8 |
| v2 §1.8 时序 S1–S5 | 整节替换为 S1–S8 | §1.7 |
| v2 §1.9 B9、B10 | 替换为 B9'、B10'；B11 由 §5 的 MainWrite 取代 | §1.8、§5 |
| v2 §1.10 K1 | 整节替换 | §1.2、§1.10 |
| v2 §1.11 验收 | 替换 | §1.9 |
| v2 §2.2 证据表的 E2E 和人工勾选两行 | 替换 | §2.3 |
| v2 §2.3 G2 三行和“内容集合”一段 | 替换 | §2.4 |
| v2 §4.2 封存步骤 6、8 | 替换 | §3.2 |
| v2 §4.3 `build merge` 时序 | 整节替换 | §3.3 |
| v2 §4.4 中 `T.reachable` 一行，“内容集合”一段 | 替换 | §3.4 |
| v2 §4.5 末行（补封存）和 §3 第 6 条的补救 | 删除，改为“移出范围” | §3.5 |
| v2 §5.2 命令表 | 按 §8 增删改 | §8 |
| v2 §6.1 中 `readonly_args_digest` 字段和执行时只读锁的说明 | 替换 | §4 |
| v2 §7.3 中“`git add -A` 只会更新旧任务文件”一段 | 替换 | §5.5 |
| v2 §8.1 插件 0.18 × 核心 0.4 一格，§8.3 drain | 替换 | §6 |
| v2 §9.1 锁、原子性两行 | 替换 | §5.4 |
| v2 §9.3 `depends_on` 行 | 替换 | §3.6 |
| v2 §10.2 有效性链 | 替换为按操作区分 | §7.3 |
| v2 §12.2 实现切分中的 W7a、W15、W16 | 替换 | §9.2 |
| v2 §13.2 中 ⚑D1、⚑D3、U1 | 替换 | §10 |

---

## 1. B1：Build 控制方式与恢复契约

### 1.1 结论：K0 撤回

v2 声称“不改 flow 和 exec，靠 `adapterFactory` 加 CallGuard 就能兑现”。按源码的实际状态迁移逐条核对，**以下 3 类现场兑现不了**，所以撤回这一结论。

**(a) review-repair 期间失败后续跑，单评审候选必然 `no_candidate`（review-v2 B1 第一点）**

| 步骤 | 源码 | `state.json` |
|---|---|---|
| 1 | 评审调用成功 → `executeRole` 写 `status = spec.to = 'reviewed'`，`model = 评审模型 R`（`exec.mjs:191-196`、`prompt.mjs:22`） | `{status: reviewed, model: R}` |
| 2 | verdict = revise → `commitAll` → dev 修复调用（`flow.mjs:377-380`） | 同上 |
| 3 | dev 遇到 429 → 失败路径写 `{...st, status: 'blocked', role: 'dev'}`，其中 `st` 是第 1 步的状态（`exec.mjs:101`、`exec.mjs:248-255`） | `{status: blocked, model: R, blocked_reason: rate_limit}` |
| 4 | `runFlow(resume)`：`back` 取 history 中最后一个非 blocked 的 `to`，即 `'reviewed'`（`flow.mjs:265-273`） | `{status: reviewed}` |
| 5 | `reviewed` 不属于 draft、designed 或 implemented/reviewable 中的任何一个，直接落到 `doCI('after dev')`（`flow.mjs:342`）。**而且没有申请执行槽**（`flow.mjs:337` 的条件不成立） | — |
| 6 | 评审循环 `round = 1`：`devModelId = state.model = R`，于是 `allowed` 排除了 R（`flow.mjs:358-362`） | — |
| 7 | 评审候选只有 `[R]` 时，返回 `no_candidate`。**此时还没有调用 adapter，CallGuard 没有机会介入** | `blocked(no_candidate)` |

评审候选是 `[R, X]` 时会选 X：如果 X 就是 dev 模型，被 `G_ISOLATION` 拒绝；否则就成了“换评审者重审”，v2 只能靠重放来掩盖。

**(b) discard 只对 `interrupted` 生效（review-v2 B1 第二点）**

`flow.mjs:269` 只在 `blocked_reason === 'interrupted'` 时执行 `discardWorkingChanges`。`timeout`、`run_failed`、`stall` 以及 CallGuard 制造的 `run_failed`，都不会丢弃现场。K0 不改 flow，就无法兑现“用户选 discard，现场就被丢弃”。

**(c) worker 崩溃后的续跑同样落入 (a) 的路径**

`sweepInterrupted` 把任务标成 `blocked(interrupted)`，`back` 仍是 `'reviewed'`，后续与 (a) 第 5–7 步相同。

**(d) `r = |S_e|` 不能代表业务轮次（review-v2 B1 第三点）**

修复后代码摘要回到旧值时，`|S_e|` 不增加；最终只会以 `G_STEP_CAP` 结束，而不会进入 `round_limit`。第三份摘要经 CI 后 `r` 已经等于 3，按“新摘要且 r ≥ 3 → 拒绝”，第三次评审反而会被拒。**v2 的 S1 与它自己的守卫规则矛盾**，承认这一错误。

**结论：K0 无法兑现 Q5 的“三轮后交用户，可逆故障不计轮”。**要兑现，必须让 Supervisor 精确决定“下一步是什么”，而这需要内核提供单步入口，见 K1。

### 1.2 K1：`flow.mjs` 新增单步入口 `runStep`（⚑D1 选项 B）

**改动边界（全部改动）**

| 文件 | 改动 | 不改的部分 |
|---|---|---|
| `orchestrator/lib/flow.mjs` | 新增 `export const STEP_API = 1` 和 `export async function runStep(…)`，放在 `runFlow` 之后 | `runFlow` 的函数体逐字节不变；`agentline flow` 的行为不变 |
| `exec.mjs`、`state.mjs`、`inputs.mjs`、`ci.mjs`、`worktree.mjs`、`git.mjs` | **不改** | — |
| `orchestrator/agentline.mjs` | 只改 CLI 分发层：`E_USE_BUILD_MERGE`、drain 准入（§6.2）、旧 merge 改为显式路径提交（§5.5） | `cmdFlow` 和 `cmdRun` 的语义不变 |

**为什么是新增入口，而不是改 `runFlow`：**要让续跑不重复步骤，`runFlow` 需要同时改掉 4 处：resume 的落点、评审者的选取、discard 的条件、轮次文件名。这样会改变临时任务（adhoc）的现有行为。新增入口则让旧路径保持不变。

**签名与约束**

```js
export const STEP_API = 1
// 只供 build worker 调用：不取任务锁、不占执行槽、不读项目 routing、不循环、不重试
export async function runStep({
  config,            // 由 LockedConfig 构造（§4.2）
  repo, taskId,
  step,              // 'design' | 'design_scope' | 'dev' | 'ci' | 'review' | 'pr_open' | 'discard'
  stepId,            // 'e1/dev/2/a3'，写入提交信息的 trailer：Agentline-Step: <stepId>
  round,             // 业务轮次 k；决定 dev-r{k}、review-r{k}、verdict-r{k} 的文件名
  model, effort,     // 锁中的唯一候选和 effort；作为 candidateOverride: [model] 传给 executeRole
  note,              // 可选；通过 appendInput(kind:'note') 注入（用于 keep 续做）
  discardTo,         // 仅用于 step='discard'
  adapterFactory, log,
}) // → { ok, reason, head, verdict?, ci?, record? }
```

| step | 动作（全部复用内核已有函数） | 返回 ok 的条件 | 任务 worktree 内的提交 |
|---|---|---|---|
| `design` | 先做与 `flow.mjs:277-293` 相同的 attention/answer/amendment 处理，再 `executeRole(design, 1)`。缺 write_scope 时返回 `reason: write_scope_missing` | executeRole 成功 | `stage(design)` + trailer |
| `design_scope` | `appendInput(WRITE_SCOPE_NOTE)`，再 `executeRole(design, 2)` | 成功，且 write_scope 已声明 | 同上 |
| `dev` | 有 `note` 时先 `appendInput`，再 `executeRole(dev, k)` | executeRole 成功 | `stage(dev-r{k})` + trailer |
| `ci` | `runCI` → `ci-results.json`，加 `appendRun` | 总是 ok；结果在 `ci` 字段中 | 无 |
| `review` | `executeRole(review, k, [reviewer])`，再 `readVerdict(dir, k)`；要求 verdict 文件的 mtime 不早于步骤开始，否则返回 `invalid_output` | 拿到有效 verdict | `stage(review-r{k}): <verdict>` + trailer |
| `pr_open` | 与 `flow.mjs:393-404` 相同 | — | `chore: pr_open state` + trailer |
| `discard` | 只把产品路径恢复到 `discardTo`：`git restore --source=<discardTo> --staged --worktree -- :/ ':(exclude).collab'`，加 `git clean -fd -- :/ ':(exclude).collab'`。不加 `-x`，被忽略的文件保留 | 恢复后 `code_digest(worktree) == code_digest(discardTo)`，否则 `E_DISCARD_INCOMPLETE` | 无 |

- 传入的 `config.policy.networkRetries = 0`，且候选只有一个。因此**每次 `runStep` 至多一次物理调用**（`exec.mjs:121`、`exec.mjs:147`、`exec.mjs:218`）。
- 评审者由参数指定，**不读 `state.model`**，所以 (a) 的过滤问题不存在。
- `state.json` 仍由 `executeRole` 和 `setStatusAt` 写入，状态值仍是现有集合，供旧工具展示。**Supervisor 不读它来做决策。**

### 1.3 build worker（替换 v2 §1.3）

- `build start` 依次执行：有效性链（§7.3）→ 生成 LockedConfig（§4）→ `ensureTaskWorktree(baseRef = main)` → 以 detached 方式拉起 `build worker`。
- worker 启动后取 `acquireTaskLock`，持有到退出；需要占执行槽时调 `acquireCapacity`。
- **调度函数是 ledger 的纯函数：**`next(ledger, inputs) → {step, round, model, effort, …} | {await: kind} | {done}`。worker 循环“求 next → 调用 `runStep` → 记 ledger”。
- **启动时核对 `STEP_API`。**不等于 1 → `blocked(E_KERNEL_API)`。这条取代 v2 的内核摘要白名单。

### 1.4 业务轮次（替换 v2 §1.5）

**单位：**第 e 纪元的第 k 轮 = 步骤 `(e, dev, k)`，加上对它产出的评估 `(e, ci, k)`，以及 CI 通过时的 `(e, review, k)`。

| 事件 | 何时发生 | 写入 ledger |
|---|---|---|
| **轮次开始（占用）** | 步骤 `(e, dev, k)` 的**第一次物理调用**通过 `beforeCall` 时 | `round.open {e, k}` |
| 轮次以失败结束 | `(e, ci, k)` 失败；或 `(e, review, k)` 给出 revise；或 dev 的产出命中“已被拒绝的摘要”（见下面的缓存） | `round.close {e, k, result: fail, by: ci\|review\|cache}` |
| 轮次以通过结束 | `(e, review, k)` 给出 pass | `round.close {…, pass}` → 进入 `pr_open` 步骤，然后封存 |
| 轮次保持开放 | dev 或 review 步骤因基础设施或模型质量问题失败、用户选择 keep 或 discard、worker 崩溃 | 不写 close；**后续调用仍属于同一轮** |

**规则**

1. `round.close(fail)` 且 `k = 3` → `awaiting_user(round_limit)`。**不会发起第 4 次 dev 调用**，也不需要用 deny 来拦。
2. `round.close(fail)` 且 `k < 3` → 下一步是 `(e, dev, k+1)`。
3. **第三轮评审：**第 3 轮是开放的，且 `(e, ci, 3)` 通过 → `(e, review, 3)` 正常执行。它是第 3 轮的评估，不是新的一轮。
4. **CI 失败计轮**（与 v1 的 `E_CI_FAILED` 一致）。这里与 `runFlow` 不同：`runFlow` 在 CI 失败后有一次轮外修复（`flow.mjs:343-351`），runStep 路径没有。
5. **代码摘要不变：**在 dev 步骤前后取 `code_digest`，若 `write_scope ≠ []` 且摘要不变 → `E_NO_PRODUCT_CHANGE`（`model_quality`）。这次调用计入物理调用预算，**不计轮**；同一步骤再调用一次。
6. **重复摘要（回到旧代码）：**verdict 缓存的键为 `(code_digest, acceptance_digest, impl_digest_if_scope_empty)`，不包含评审者。dev 产出的摘要命中缓存中的 revise → 跳过 review 调用，本轮以 `by: cache` 关闭为失败。这样“改回旧代码”不能换来一次重审，也不会被吞掉不计。
7. **纪元：**worker 在两个步骤之间读 `pendingInputs(['amendment'])`；有内容时 `epoch + 1`，下一步为 `(e+1, design)`，`k` 从 0 开始。纪元由 worker **决定并写入 ledger**，不靠事后观测。

### 1.5 物理调用预算（替换 v2 §1.6）

| 预算 | 何时占用 | 何时结束 | 用尽时 |
|---|---|---|---|
| 步骤自动预算：每个 `(e, role, k)` 最多 3 次 | 每次 `call.start`，即通过 `beforeCall` 之后 | 步骤成功（`step.end ok`），或进入终态 | `blocked(infra, step_cap)` |
| 用户追加：每次 `build resume` 加 1 次 | 用户执行 `resume`，ledger 记 `user_action: grant_call` | 这 1 次调用被用掉 | 回到 `blocked` |
| 轮换：每个角色每个任务 1 次 | 第 3 次调用**之前**决定 | 任务结束或重新锁定（relock） | 不再轮换 |
| 自动等待：累计不超过 maxWait（⚑U8） | 进入 `waiting` 时开始计时 | 等待结束 | `awaiting_user(budget)` |
| 任务预算（tokens/usd） | 每次调用结束（`call.end`）时累加 | — | `awaiting_user(budget)` |

**轮换时机（修正 v2 中的矛盾句）：**第 1、2 次调用用主选；在第 3 次调用之前，满足以下全部条件才轮换到锁内备选，否则第 3 次仍用主选：

- 前两次都是基础设施错误；
- 该角色的轮换额度未用；
- 备选的 identity_group 与评审者不同（避免把评审者带进 D）。

第 3 次失败后**不再轮换**。轮换一旦发生，到任务结束或 relock 为止都使用该备选。

**副作用判定（写角色 design 和 dev）：**`post.fingerprint == pre.fingerprint` → 视为现场干净，可以自动重试。否则 → `awaiting_user(interrupted_choice)`，**不分错误原因**（timeout、run_failed、崩溃都一样）。

| 现场 | 用户动作 | 实现 | 轮次 | 预算 |
|---|---|---|---|---|
| 已脏 | `build resume --keep` | 保留现场；下一次调用带 `note:"上次调用中断，工作区保留了部分改动，请在此基础上继续"` | 同一轮 | 用户追加 1 次 |
| 已脏 | `build resume --discard --text`（H） | `runStep(discard, discardTo = pre.head)`，校验摘要后再调用 | 同一轮 | 用户追加 1 次 |

**worker 崩溃后的对账：**

- 找到只有 `call.start`、没有 `call.end` 的记录。
- 任务 HEAD 的提交带有该步骤的 `Agentline-Step` trailer → 步骤实际已完成，补记 `step.end ok`，**不重跑**。
- 否则补记 `call.end {error: E_WORKER_LOST}`，再按指纹做副作用判定。
- 间隔 10 秒连续取两次指纹，结果不同 → `E_PROCESS_LINGERING` → `blocked`。
- ci 步骤没有模型调用，可以直接重跑。

### 1.6 CallGuard（替换 v2 §1.4）

- 位置不变，仍通过 `adapterFactory` 注入。**职责缩小为“记录器加安全网”：**
  - `beforeCall` 写 `call.start`（`pre.head`、`pre.fingerprint`、`pre.code_digest`），并检查取消标记和 CLI 指纹漂移（`G_CANCEL`、`G_DRIFT`）。
  - `afterCall` 把 `logPath` 和本次调用的产物归档到 `calls/<call_id>/`，记录 resolved 身份和 `post.fingerprint`；身份不符 → `G_IDENTITY_MISMATCH`。
- **删除“评审重放”**：不需要了，因为续跑从 ledger 精确定位下一步。
- **删除“dev r ≥ 3 拒绝”**：worker 本来就不会发起这次调用。
- 安全网拒绝时仍返回 exit 97，`runStep` 的结果是 `run_failed`；真实原因在 ledger 的 `decision` 字段，由 worker 按 §1.5 处理。正常路径上不会出现拒绝。
- 日志名 `dev-r{k}-1.log` 在同一步骤的多次尝试之间会被覆盖。这不影响审计：每次调用结束时已按 `call_id` 归档，而且调用是串行的。

### 1.7 时序（替换 v2 §1.8）

**S1 三轮评审都拒绝**

| # | worker 调用 | 物理调用 | ledger |
|---|---|---|---|
| 1 | `design` | 1 | — |
| 2 | `dev`, k=1 | 1 | `round.open 1` |
| 3 | `ci`, k=1 → 通过；`review`, k=1 → revise | 1 | `round.close 1 fail(review)` |
| 4 | `dev`/`ci`/`review`, k=2 → revise | 2 | open 2 → close 2 fail |
| 5 | `dev`/`ci`/`review`, k=3 → revise | 2 | open 3 → close 3 fail |
| 6 | `next()` → `{await: round_limit}` | 0 | `awaiting_user(round_limit)` |

共 7 次模型调用；没有第 4 次 dev，也没有任何 deny。

**S2 CI 失败计轮：**k=1 时 CI 失败 → close 1。k=2 时 CI 通过、review 拒绝 → close 2。k=3 时 CI 失败 → close 3 → `round_limit`。共 5 次模型调用（design 1、dev 3、review 1）。

**S3 修复调用遇到 429，只有一个评审候选**

| # | 事件 | 处理 |
|---|---|---|
| 1 | k=1 评审 revise → close 1 | — |
| 2 | `(1, dev, 2)` attempt 1 → 429，现场干净 | `round.open 2`；`waiting(retry_after)` |
| 3 | 等待结束 → `(1, dev, 2)` attempt 2 → 成功 | 不重跑 d1 的 CI，**不重审 d1** |
| 4 | `ci` k=2；`review` k=2，评审者从锁中取 | 单评审候选不受影响 |

如果第 2 次调用也是 429：第 3 次调用前按 §1.5 判断是否轮换。第 3 次仍失败 → `blocked(step_cap)`；用户 `resume` 后加 1 次。

**S4 dev 超时，现场已脏：**`(1, dev, 2)` attempt 1 超时，指纹变化 → `interrupted_choice`。`--keep` → 带 note 发起 attempt 2，仍是第 2 轮；`--discard` → `runStep(discard)` → 摘要校验通过 → attempt 2。**`timeout`、`run_failed` 和崩溃都适用同一处理。**

**S5 中途改需求：**amendment 待处理 → `epoch = 2`，下一步为 `(2, design)`；UI 显示“第 2 纪元 · 轮次 0/3”。

**S6 评审调用期间 worker 崩溃：**对账发现悬空的 `call.start`。HEAD 上没有该步骤的 trailer，且评审不写产品文件，所以指纹不变 → 补记 `E_WORKER_LOST`，自动发起 attempt 2，评审者不变。

**S7 重复摘要：**

- `(1, dev, 2)` 没有改动产品代码 → `E_NO_PRODUCT_CHANGE`，发起 attempt 2，第 2 轮保持开放。
- `(1, dev, 2)` 把代码恢复成 d1 → 命中缓存中的 revise → `close 2 fail(cache)`，不发起评审调用。

**S8 第三轮评审：**第 3 轮开放，`ci` k=3 通过 → `review` k=3 正常执行。pass → `pr_open`，然后封存；revise → `round_limit`。

### 1.8 边界规则（替换 v2 的 B9、B10）

| 编号 | 规则 | 检查方式 |
|---|---|---|
| B9' | worker 只通过 `runStep` 执行步骤，`STEP_API` 必须等于 1；`flow.mjs` 的哈希守卫按 K1 改动后的版本重新建立基线 | 契约测试；worker 启动时核对 |
| B10' | Supervisor 和 CallGuard 不直接写任务目录下任何内核文件（`state.json`、`run.json`、`inputs.jsonl`、verdict）；需要写时只通过 `runStep` 的参数 | 代码扫描 |
| B11 | 由 §5 的 MainWrite 和 TaskWrite 协议取代 | — |

### 1.9 B1 验收例子

| # | 场景 | 期望结果 |
|---|---|---|
| A1-1 | 假 adapter，评审 3 次都返回 revise | dev 恰好调用 3 次；ledger 中有 3 条 `round.close fail`；**没有第 4 次 dev 的 `call.start`**；`awaiting.kind = round_limit` |
| A1-2 | S2 | 3 条 `ci` 步骤记录，其中 2 条失败；共 5 次模型调用 |
| A1-3 | S3，锁中评审候选只有 1 个 | 不出现 `no_candidate`；d1 只被评审 1 次；attempt 2 成功后 `round = 2` |
| A1-4 | 同一 dev 步骤连续 3 次 429，没有可用的轮换候选 | 第 3 次调用使用主选；没有第 4 次调用；`blocked(step_cap)`。用户 `resume` 后恰好多 1 次调用 |
| A1-5 | 同上，但有备选 Y，且 Y 的组别 ≠ 评审者组别 | 第 3 次调用使用 Y；之后的 dev 步骤也使用 Y |
| A1-6 | dev 超时，现场已脏，用户选 discard | `blocked_reason = timeout` 时同样执行丢弃；`code_digest(worktree) == code_digest(pre.head)`；轮次不变 |
| A1-7 | 在 dev 调用中途杀死 worker | 有 trailer 的情况下不重跑步骤；没有 trailer 且现场干净时自动续做；现场已脏时进入 `interrupted_choice` |
| A1-8 | dev 把代码恢复到 d1 | 评审调用计数不变；`close fail(cache)` |
| A1-9 | `STEP_API = 2` | `blocked(E_KERNEL_API)`，不调用 `runStep` |
| A1-10 | 回归：执行 `agentline flow --task <adhoc>` | 输出和状态迁移与 K1 改动前逐字节一致 |

### 1.10 如果用户不授权 K1（⚑D1 选项 C）

- Blueprint 来源任务仍走 `runFlow`，CallGuard 只做记录。
- **无法承诺：**Q5 的“三轮后交用户”，以及“可逆故障不计轮”；S3 单评审候选的情况必然以 `blocked(no_candidate)` 结束；discard 只在 `interrupted` 时生效。
- **仍然成立：**T gate、封存、逐调用归档、隔离检查。
- 这等于**降低已确认的 Q5**，所以只能由用户选择，设计师不推荐。

---

## 2. B2：G2 的验证对象

### 2.1 决定

**G2 批准的是一个固定的历史集成快照 `I`。**G2 不表示“当前 main 已验收”，UI、API、Inbox 都不得这样表述。

### 2.2 I 的确定、更新与失效

| 事件 | 规则 |
|---|---|
| 选定 I | 只能通过 `milestone e2e --milestone M [--at <commit>]` 选定，默认取当时的 main HEAD。job 依次校验：里程碑的每个成员任务都有 `merged.json`；`M_task` 和 `S_task` 都是 I 的祖先；对 `S_task` 当场求 T 为 pass。通过后，用 MainWrite 写入 `milestones/M/integration.json`：`{I, code_digest_I, members: [{task, S, M}], selected_at}` |
| 运行 E2E | 在 I 的 detached 快照上运行，结果写入 `e2e-results.json` 并绑定 I |
| 更新 I | 只有再次执行 `milestone e2e` 才会更新。**main 前进不会自动更新 I，也不会让 G2 失效** |
| 新成员任务合并 | 成员集合以 integration.json 为准。之后新增成员（例如 supersede）时，`M.e2e_pass` 判定为 fail（`member_not_in_I`），必须重新运行 E2E |
| 人工勾选 | 每条勾选绑定 `(check_id, def_sha256, I, code_digest_I)`。I 改变后，旧勾选一律不计 |
| main 被改写，I 不再是 main 的祖先 | G2 状态显示 `target_lost`，下游准入失败 |

### 2.3 证据表修订（替换 v2 §2.2 的两行）

| 证据 | 绑定 | 有效条件 |
|---|---|---|
| E2E | `I`、`code_digest_I`、`e2e_def_digest`（`milestone.e2e` 的命令列表）、`runner_digest` | 与 integration.json 和当前定义一致 |
| 人工勾选（`manual-checks.json`） | 每条为 `{check_id, def_sha256, I, code_digest_I, result, text ≤ 500, channel, at}`，追加写；同一 `check_id` 以最后一条为准 | `def_sha256` 等于当前定义；I 等于 integration.I；`result = pass` |

### 2.4 G2 判定与内容集合（替换 v2 §2.3 的 G2 部分）

**内容集合（批准哈希的输入）**

```
g2_content = canonical({
  milestone_def_digest,     // 任务图中里程碑节点、成员 node_sha256 列表、e2e 定义、人工检查定义
  integration: integration.json,
  e2e_results_sha256,
  manual_checks_sha256,     // 整个 manual-checks.json 的 canonical 哈希
  g1_approval_id
})
```

| check | 判定 | 可豁免 |
|---|---|---|
| `M.e2e_pass` | 结果全部通过；结果中的 I 和 `code_digest_I` 等于 integration.json；`e2e_def_digest` 等于当前定义 | 否 |
| `M.members_in_I` | 当前成员集合中的每个任务都在 integration.members 中，且 M、S 都是 I 的祖先 | 否 |
| `M.manual_checks` | 每个已定义的检查，其最后一条勾选按 §2.3 有效 | 否 |
| `M.task_gates` | 对每个成员的 S 求 T，结果为 pass | 否 |
| `M.origin_current` | 同 v2 | 否 |

修改人工结论（无论 pass 改为 fail 还是相反）、修改检查定义、重新运行 E2E，都会改变 `g2_content`，**批准随即失效**。

### 2.5 下游准入检查同一个目标

下一里程碑的 `user_gate` 任务，在 `build start` 和 `build queue` 调度时都要求：

1. G2(M) 的批准当前有效：重新计算 `g2_content` 的哈希并与批准比较，且批准未撤销；
2. `merge-base --is-ancestor integration.I <本次 worktree 的 base_commit>` 成立，否则返回 `E_G2_TARGET_NOT_IN_BASE`。

准入用的 I 和 G2 求值用的 I 来自同一个 integration.json。**不使用“当前 main 是否已验收”作为判据。**

**展示：**“M1 已验收（快照 `I=abc1234`，2026-11-06）”。另起一行显示“main 相对快照：产品代码已变化 / 未变化”，只作提示。

### 2.6 B2 验收例子

| # | 操作 | 期望结果 |
|---|---|---|
| A2-9 | G2 在 I1 上已批准；随后一个临时任务把产品改动合并进 main | G2 仍为 passed，显示“快照 I1；main 已偏离”；下游 `build start` 通过 |
| A2-10 | 把一项人工检查从 pass 改为 fail | `manual_checks_sha256` 变化 → 批准失效；下游启动返回 `E_APPROVAL_STALE` |
| A2-11 | 再次执行 `milestone e2e`，得到 I2 | 在 I1 上的勾选不计；`M.manual_checks` fail；旧批准失效 |
| A2-12 | 新 G1 修改了某项人工检查的定义 | 该检查的 `def_sha256` 不一致 → fail |
| A2-13 | 选定 I1 之后，supersede 产生的新成员任务合并 | `M.members_in_I` fail |
| A2-14 | main 被强推改写，I1 不再是 main 的祖先 | `E_G2_TARGET_NOT_IN_BASE` |

---

## 3. B4：封存与合并

### 3.1 提交拓扑

```
main:  … P ─────────────── M ── K
                          /
task:  B0 ─ … ─ C ─ S ───┘
```

| 提交 | 位置 | 内容 | 是否可变 |
|---|---|---|---|
| C | 任务分支 | 产品代码，加流程状态（含 `pr_open` 提交） | — |
| S | 任务分支，父提交为 C | **只有** `.collab/build/NNN/{seal,ledger,ci-gate,manifest,decisions}.json` | 不可变证据 |
| M | main，`git merge --no-ff <S 的提交 ID>` | `M^1 = P`，`M^2 = S` | — |
| K | main，父提交为 M | **只有** `.collab/build/NNN/merged.json` 和 `.collab/tasks/NNN/state.json`（status 改为 merged） | 合并记录 |

### 3.2 封存（替换 v2 §4.2 第 6、8 步）

- 第 6 步：S 中不再包含 `t-gate.json`。在任务 worktree 中按 TaskWrite 协议（§5.3）提交 S。
- 第 8 步：T 的结果是**派生缓存**，写入 C 级 `orchestrator/data/gates/T/<repo_id>/<NNN>/<S>.json`，键为 `(S, content_hash, evaluator_version)`。缓存可以随时删除并重算。**派生结果一律不进 git**，因此 S 之后不会再出现任何提交。
- G0、G1、G2 的 `gate.json` 同样视为派生快照：不属于任何内容集合，可以覆盖重算。

### 3.3 `build merge` 时序（替换 v2 §4.3）

内部调用边界：`build merge` 由 `orchestrator/lib/build-merge.mjs` 实现，使用 `lib/main-write.mjs`。它**不调用** `agentline merge` 命令，也不调用 `cmdMerge`，**不新增任何内部旁路参数**。旧 `merge` 对 Blueprint 来源任务继续返回 `E_USE_BUILD_MERGE`。

| # | 步骤 | 失败时 |
|---|---|---|
| 1 | 有效性链（§7.3，merge 列） | 停止 |
| 2 | 任务 HEAD ≠ 最近一次封存的 S → 重新封存，得到新的 S | 按封存规则 |
| 3 | 对 S 求 T，结果必须为 pass | `E_GATE_NOT_PASSED` |
| 4 | 确认归档完整 | `E_ARCHIVE_FAILED` |
| 5 | 取 MainWrite 锁。前置条件：main 已检出；`git diff --cached --quiet`，即 index 等于 HEAD（git merge 本身也要求如此）；没有 `MERGE_HEAD`。记下 `P = HEAD` | `E_MAIN_INDEX_DIRTY`、`E_MAIN_NOT_CHECKED_OUT`。**不自动 stash** |
| 6 | `git merge --no-ff --no-edit -m "<msg>" <S>`，信息中带 `Agentline-Txn` trailer | 冲突 → `git merge --abort`，校验 `HEAD == P` → `E_MERGE_CONFLICT`。工作区中未暂存的改动与合并冲突时，git 会在开始前拒绝 → `E_MAIN_WORKTREE_CONFLICT` |
| 7 | 校验 `M^1 == P`、`M^2 == S`；在 M 上以封存模式求 T | `E_POST_MERGE_VERIFY` → `blocked(integrity)`。**不自动回退 main**；保留 worktree 和分支 |
| 8 | 按 MainWrite 写 K：`merged.json = {merge_commit M, seal_commit S, base_main P, permission ≤ 500 \| grant_id, channel, at, core}`，**不含任何 gate 结果** | 进入“合并已完成、记录待写”状态；再次执行 `build merge` 时只补做第 8 步 |
| 9 | 清理 worktree 和分支 | 只告警 |

**重入：**检测到“存在 M 满足 `M^2 == S`，但没有 `merged.json`”时，只执行第 8 步。

### 3.4 T 修订（替换 v2 §4.4 对应行）

| check | 判定 |
|---|---|
| `T.reachable` | **合并前：**S 是任务分支 HEAD。**合并后：**main 上存在 `merged.json`，其 `seal_commit == S`，`merge_commit` 是 main 的祖先，且 `rev-parse M^2 == S`。只有 M 没有 K 时为 `fail(pending_record)`。浅克隆返回 `error(E_SHALLOW_CLONE)` |

**内容集合：**`seal.json` 及其 `files` 中列出的文件、S 的提交 ID、来源节点的 canonical JSON。**不包含** `merged.json`；`merged.json` 只参与 `T.reachable` 的判定。

### 3.5 补封存：移出范围（替换 v2 §4.5 末行和 §3 第 6 条）

- **删除** `build seal --post-merge` 命令及其所有提法。
- 在 AgentLine 之外合并的任务（squash、rebase、普通 `git merge`，以及强制回滚期间由旧核心合并的任务），统一判为 `unsealed_merge`：`T.reachable` fail，不可豁免；所属里程碑的 G2 **无法通过**。
- **本设计不提供补救路径。**若要支持补救，需要单独开一个协议变更 Blueprint。这是失败关闭，不需要裁决，但用户应知道后果（§10 知会项 N1）。

### 3.6 `depends_on`（替换 v2 §9.3 对应行）

依赖任务视为满足，需要同时具备：main 上有 `merged.json`；对其 `seal_commit` 当场求 T（或命中缓存）为 pass。不再读 `t_post_merge` 字段，该字段已删除。

### 3.7 B4 验收例子

| # | 场景 | 期望结果 |
|---|---|---|
| A4-8 | main 上有用户已暂存但无关的文件，执行 `build merge` | `E_MAIN_INDEX_DIRTY`；main、index、工作区均不变 |
| A4-9 | main 上有用户未暂存的无关改动，且不与合并冲突 | 合并成功；K 的 `diff-tree` 只包含 2 个路径；用户的改动仍未暂存 |
| A4-10 | 第 6 步完成后、第 8 步之前进程被杀 | `T.reachable = fail(pending_record)`；再次执行 `build merge` 只写 K |
| A4-11 | 合并之后 | `M^2 == S`；`git diff --name-only C S` ⊆ `.collab/build/NNN/`；S 的树中没有 `t-gate.json` |
| A4-12 | squash 合并 | 判为 `unsealed_merge`；执行 `build seal --post-merge` 返回“未知命令” |
| A4-13 | 封存后任务分支上又出现一个只改 `.collab` 的提交 | 第 2 步重新封存得到 S2，合并的是 S2 |

---

## 4. M2：执行配置的唯一来源

### 4.1 规则

| 项 | 规则 |
|---|---|
| 唯一来源 | 运行时**只用** LockedConfig（`B:/build/NNN/lock.json`）构造传给 `runStep` 的 `config`，不读 `agentline.local.json`，也不读 `.collab/agentline.json` |
| 项目 routing | **只在生成锁时读一次**：`effectiveRole(config, role, projectCfg)` 的结果写进锁，同时记录 `sources = {global_rev, project_routing_sha256}`。生成锁之后，项目 routing 再改动也不影响本任务，只在 UI 中提示“配置已变，relock 后生效”。`runStep` 不调用 `effectiveRole` |
| 角色候选与 effort | 每次调用都是 `candidateOverride: [锁中的当前候选]` 加 `effortOverride: 锁中的 effort`。`beforeCall` 校验 adapter 收到的 `model` 和 `effort` 等于锁中的值，不一致返回 `G_DRIFT` |
| 临时任务 | 仍走 `runFlow`，项目 routing 照常生效，与现状相同 |

### 4.2 provider 参数可以重建（替换 `readonly_args_digest`）

- 锁中保存 `providers.<name>`：adapter 读取的**完整** provider 对象，原样冻结。包括 `adapter`、`command`、`args` 模板、`limits`、`effort` 表，以及环境变量的**名字**（不含值）。
- `exec_config_digest = H(canonical({models, providers, roles, policy}))`。
- 运行时的 `config` 由锁原样构造：
  ```
  { models: {<key>: 锁中条目}, providers: 锁中条目, roles: {design|dev|review: {candidates: [当前候选]}},
    policy: {networkRetries: 0}, effort: {default: 锁中的 effort}, collabDir }
  ```
- **契约测试**：用 Proxy 记录 adapter 访问了 provider 的哪些字段；若有字段不在冻结集合中，测试失败。provider 配置中出现形似密钥的值时，生成锁失败（`E_SECRET_IN_CONFIG`）。

### 4.3 Build 重新锁定

- `build relock --task --text`（H）。只能在任务处于 `waiting`、`awaiting_user` 或 `blocked` 时执行。
- 生成新锁，旧锁移入 history；ledger 记 `user_action: relock`。
- **轮次和预算不重置。**verdict 缓存的键不含评审者，所以换评审者也无法让同一份代码重审。

---

## 5. M3/M5：Git 写入事务

### 5.1 共享写锁

- 所有写 main 的命令都要先取 `<git-common-dir>/agentline/main-write.lock`；用 `--git-common-dir`，worktree 与主仓库共享同一把锁。锁沿用 `lock.mjs` 的 pid 存活判定。
- 写 main 的命令包括：`blueprint materialize`、`task new`、`approve`/`revoke`/`waive`、`milestone e2e`/`check` 的记录写入、`build merge` 的 M 和 K、`migrate apply` 第 1 步，以及**旧的 `merge`**。
- 等待上限：同步命令 10 秒，job 5 分钟；超时返回 `E_MAIN_BUSY`。
- 任务编号分配 `allocTaskIds(n)` 只在持锁时执行。取以下各项的最大值再加 1：main 树、所有 `task/*` 分支、全部 `materialized.json`、registry，以及**未完成事务日志中预留的编号**。
- 取代 v2 的 `materialize.lock`。

### 5.2 MainWrite 协议

1. 取锁；处理遗留的事务日志（第 5 步）。
2. **前置条件**：main 已检出；没有正在进行的 merge 或 rebase；目标路径既不在 `git diff --cached --name-only` 中，也没有未暂存的修改，否则返回 `E_PATH_CONFLICT`。**目标路径之外**的暂存内容允许存在，并会保持原样。
3. 写事务日志 `<common>/agentline/txn/<id>.json`：
   ```
   {id, cmd, base_head, paths: [{path, existed, blob_before}], phase: prepared}
   ```
4. 写文件 → `git add -- <paths>` → `git commit --only -m "<msg>\n\nAgentline-Txn: <id>" -- <paths>` → 校验 `git diff-tree --name-only HEAD^ HEAD` 等于 paths → 删除事务日志。
   - `--only` 使提交只包含 paths，**用户已暂存的其他内容不会进入提交**，提交后仍然处于暂存状态。
   - 用户仓库的 pre-commit hook 失败视为提交失败。
5. **恢复**（下一个取锁者，或 `recover` 命令）发现遗留事务日志时：
   - HEAD 的祖先中有带该 `Agentline-Txn` 的提交 → 只删除日志（前滚）；
   - 否则 `HEAD == base_head` → 回滚：只对这些 paths 按 `blob_before` 恢复或删除，再执行 `git reset -q -- <paths>`，然后删除日志；
   - 否则 → `E_TXN_DIVERGED`，进入 `blocked(integrity)`，把日志内容展示给用户。

### 5.3 TaskWrite（任务 worktree）

- 内核步骤沿用 `commitAll`，因为 worktree 由 AgentLine 独占。
- 封存提交 S 使用 `git commit --only -- .collab/build/NNN/...`。前置条件是 worktree 除被忽略的文件外是干净的。

### 5.4 materialize（替换 v2 §9.1 锁和原子性两行）

- 在锁内依次执行：分配编号，生成文件（临时目录为 `<common>/agentline/txn/<id>/`，不放在受 OneDrive 同步的工作区里），按 MainWrite 一次提交。
- 中途失败时，按第 5 步回滚，**工作区和 index 中不留残留**，预留的编号随日志删除而释放。
- 失败后的状态：没有 `materialized.json` → 计划仍可执行，`plan_digest` 不变时可以直接重试。

### 5.5 旧 merge 的 `commitAll`（替换 v2 §7.3 中的那一段）

- `build merge` **不复用** `cmdMerge` 和 `commitAll`（§3.3）。
- 对临时任务，旧 `cmdMerge` 保留原有语义，但做两处修正：
  - 进入时取 MainWrite 锁；
  - `agentline.mjs:397` 的 `commitAll(repo, …)` 改为只按 MainWrite 提交 `.collab/tasks/NNN/state.json`。
  - 原因：`git.mjs:68` 的 `add -A` 会把用户在 main 上未暂存的改动一起提交，这是现存缺陷。
- `agentline.mjs:374` 的 `git checkout main` 改为“当前分支不是 main → `E_MAIN_NOT_CHECKED_OUT`”，不再替用户切换分支。
- 这两处改动只改变**提交范围**，合并语义不变，回归夹具相应更新。

### 5.6 M3 验收例子

| # | 场景 | 期望结果 |
|---|---|---|
| A5-1 | main 上已暂存一个无关文件 X，执行 `materialize` | 提交中不含 X；X 仍处于暂存状态 |
| A5-2 | `materialize` 写完文件、提交之前被杀 | 下一个 MainWrite 命令回滚：文件被删除，index 中这些路径干净；编号可以再次分配 |
| A5-3 | `task new` 与 `materialize` 并发 | 编号不冲突；后到者等待锁或返回 `E_MAIN_BUSY` |
| A5-4 | 对临时任务执行旧 `merge`，main 上有未暂存的无关改动 | merged 提交只包含 `state.json` |

---

## 6. M4：兼容与 drain

### 6.1 删除写盘例外（替换 v2 §8.1 一格）

**插件 0.18 × 核心 0.4.0（`legacy-core` 模式）：**

- 只读驾驶舱，加旧核心已有的写命令：`flow`、`merge`、`stop`、`input`、`answer`。
- `/agentline <目标>` 在该模式下**不可用**，提示“需要核心 ≥ 0.5.0（`task new`），或使用插件 0.17”。
- **插件在任何模式下都不写 `.collab/**`**，Q1 无例外。静态扫描断言插件代码中没有写 `.collab` 的路径。
- 设计师不提议例外，所以不提交裁决。如果用户主动要求，属于对 Q1 的变更。

### 6.2 统一运行准入（替换 v2 §8.3 的 drain 部分）

- **分类：**命令定义表中，每条命令带 `starts_work: true|false`。凡是**会启动或继续**模型调用、CI、E2E 或 probe 的命令都标为 true，包括：
  - `studio`/`blueprint` 的 `lock`、`run`、`resume`、`retry-now`、`continue`、`confirm-model`；
  - `build` 的 `start`、`resume`、`retry-now`、`decide`（裁决后会继续时）、`merge`；
  - `task new --start`、`models discover`、`models probe`、`roles set`（其中的 probe job）、`milestone e2e`；
  - 旧 CLI 的 `flow` 和 `run`。
- **唯一入口：**CLI 分发层先调用 `admit(commandId)`；job 框架创建 job 前再调用一次。drain 生效时返回 `E_DRAINING`。
- **不受 drain 限制：**只读命令、`job show`、`build stop`、各类 `cancel`、`undrain`、`drain status`。
- **已在运行的部分：**
  - queue 调度器停止派发；
  - 处于 `waiting` 的 worker 立即退出，状态改为 `held(drain)`；
  - 其余 worker 在当前步骤结束后退出（K1 下天然以步骤为边界）。
- **`drain status`** = registry 中存活的任务锁持有者、job 表中 running 的条目、worker pid 三者的并集。必须为 0 才能回滚。
- **静态测试：**每条标为 `starts_work` 的命令都必须经过 `admit`。

### 6.3 M4 验收例子

| # | 场景 | 期望结果 |
|---|---|---|
| A6-1 | 插件 0.18 × 核心 0.4，执行 `/agentline 加个按钮` | 显示不可用提示；`.collab` 下没有任何新文件 |
| A6-2 | drain 生效后逐条执行 `starts_work` 命令 | 全部返回 `E_DRAINING`；`build stop` 仍然可用 |
| A6-3 | drain 时有一个任务处于 waiting | 其 worker 立即退出；`drain status` 变为 0 |

---

## 7. Minor

### 7.1 命令表

见 §8：补充 `build budget`、`build relock`；`build.e2e` 统一改为 `milestone.e2e`；删除 `build seal --post-merge`；`build seal` 改为内部步骤。

### 7.2 恢复预算

以 §1.5 为准：在第 3 次调用之前决定是否轮换；第 3 次失败后不再轮换。删除 v2 S3 中“连续 3 次失败后仍可轮换”的句子。

### 7.3 有效性链按操作区分（替换 v2 §10.2）

| 检查 | materialize（首次） | start | merge |
|---|---|---|---|
| 1. G0 内容哈希等于批准时的值 | ✓ | ✓ | ✓ |
| 2. G0 批准未撤销 | ✓ | ✓ | ✓ |
| 3. G1 同 1、2，且 `studio_link` 为 pass | ✓ | ✓ | ✓ |
| 4. `plan_digest` 等于预览时的值 | ✓ | — | — |
| 5. `materialized.json` 中有该任务，且 `node_sha256` 一致 | —（此时还没有这份文件） | ✓ | ✓ |
| 6. 人类通道原话，或符合规则的 grant | — | `user_gate` 任务需要 | ✓ |

### 7.4 越界选项清理

- ⚑D3 删除 `accept_as_is`。接受未通过评审的版本属于协议变更，不在本设计中。
- U1 删除“允许同一模型担任两个角色”或任何隔离豁免选项。

---

## 8. 命令与 gate 的完整变更

### 8.1 命令（相对 v2 §5.2）

| 变更 | command id | CLI | 类型 | 方式 | `starts_work` |
|---|---|---|---|---|---|
| 新增 | `build.budget` | `build budget --task --add-calls/--add-tokens/--add-usd --text` | W·H | sync | 否 |
| 新增 | `build.relock` | `build relock --task --text` | W·H | job（含 probe） | 是 |
| 新增 | `ops.drain_status` | `drain status` | R | sync | 否 |
| 修改 | `build.resume_keep` / `build.resume_discard` | 适用于所有失败原因；每次追加 1 次物理调用 | — | job | 是 |
| 修改 | `milestone.e2e` | `milestone e2e --blueprint --milestone [--at <commit>]`，写 integration.json 和 e2e-results | W | job | 是 |
| 修改 | `milestone.check` | 勾选绑定 `def_sha256` 和 I | W·H | sync | 否 |
| 修改 | `recover.sweep` | 同时处理遗留的事务日志 | W | sync | 否 |
| 统一命名 | `build.e2e` → `milestone.e2e` | — | — | — | — |
| 删除 | `build.seal_post_merge` | — | — | — | — |
| 降为内部 | `build seal`、`build worker` | 不进 Host 白名单 | — | — | — |

### 8.2 gate check

| gate | 变更 |
|---|---|
| T | `T.reachable` 按 §3.4 替换；内容集合不含 `merged.json`；结果只进 C 级缓存；删除 `t-gate.json` |
| G2 | `M.e2e_pass` 替换；新增 `M.members_in_I`；`M.manual_checks` 替换；内容集合按 §2.4 |
| 依赖 | `depends_on` 按 §3.6 |

### 8.3 错误码

- 新增：`E_KERNEL_API`、`E_NO_PRODUCT_CHANGE`（`model_quality`）、`E_DISCARD_INCOMPLETE`、`E_WORKER_LOST`、`E_G2_TARGET_NOT_IN_BASE`、`E_MAIN_INDEX_DIRTY`、`E_MAIN_WORKTREE_CONFLICT`、`E_MERGE_CONFLICT`、`E_PATH_CONFLICT`、`E_MAIN_BUSY`、`E_TXN_DIVERGED`、`E_SECRET_IN_CONFIG`。
- 删除：`G_ROUND_CAP`（由调度保证不会发起这次调用）、`E_KERNEL_SEAM_UNVERIFIED`。

---

## 9. 测试与实现切分的增量

### 9.1 测试

| 层 | 对象 | 用例 |
|---|---|---|
| 回归 | `runFlow` | 临时任务的夹具输出逐字节不变（A1-10） |
| 契约 | `runStep` | 每种 step 至多一次物理调用；trailer 存在；discard 后摘要校验；验收例子 A1-1 至 A1-9 |
| 契约 | LockedConfig | 用 Proxy 记录 provider 字段访问；项目 routing 改动不影响已锁任务 |
| 集成 | 合并拓扑 | A4-8 至 A4-13 |
| 集成 | MainWrite | A5-1 至 A5-4，加故障注入（在第 4 步的每个子步骤处杀进程） |
| 单元 | G2 | A2-9 至 A2-14 |
| 静态 | 准入与写路径 | 每条 `starts_work` 命令都经过 `admit`；插件不写 `.collab`；Supervisor 不写内核文件 |

### 9.2 实现切分（替换 W7a、W15、W16）

| 工作流 | 内容 | 依赖 |
|---|---|---|
| W7a | `runStep`（K1）、ledger、调度函数 `next()`、worker、对账；**前提是 ⚑D1 = B** | W1、W4 |
| W15 | 封存、`build-merge.mjs`、`check-task -Sealed`、T 缓存 | W5、W7a、W17 |
| W16 | job 框架、`admit`、drain、materialize | W1、W17 |
| W17（新增） | `main-write.mjs`、事务日志、`allocTaskIds`、旧 merge 的两处修正 | W1 |

---

## 10. 用户裁决

### 10.1 需要裁决

| # | 问题 | 选项 | 设计师倾向（仅供参考） |
|---|---|---|---|
| **⚑D1**（重写） | Build 的控制方式：Q1 与 Q5 无法同时按字面满足 | **B（K1）：**在 `flow.mjs` 中新增 `runStep` 导出（`runFlow` 和 `exec.mjs` 都不改），由 Supervisor 驱动循环。这是对 Q1“flow 零侵入”字面要求的例外，需要单独提交并重新建立哈希守卫基线。**C：**不改内核，按 §1.10 降级 Q5 的承诺。**原选项 A（K0）删除，因为它兑现不了** | B |
| ⚑D2 | 同 v2 | 同 v2 | 分阶段 |
| ⚑D3（清理） | 三轮耗尽之后 | hard_limit / bounded_extension / repeatable。**`accept_as_is` 已删除** | hard_limit |
| ⚑D4 | 同 v2 | 同 v2 | B |
| U1（清理） | top 模型数量不足 | 只保留不放宽隔离的选项 | 同 v1 |
| U5、U7、U8、U9、U12 | 同 v2 | — | — |

### 10.2 知会项（不放宽任何边界，所以不需要裁决）

- **N1：**补封存移出范围。任务在 AgentLine 之外被合并，或强制回滚期间被合并，其所属里程碑的 G2 将永久无法通过，直到另开协议变更 Blueprint。
- **N2：**`legacy-core` 模式下不能用旧语法新建任务。
- **N3：**旧 merge 对临时任务的提交范围收窄（§5.5），合并语义不变。
- **N4：**G2 只表示“快照 I 已验收”，不表示“当前 main 已验收”。

### 10.3 不再提交裁决

三轮原则、Git 分级留存、三角色模型隔离、插件不写 `.collab`、不可豁免项不提供 override。

---

## 11. 第 3 轮之后的处理

- 本轮审核结论为 **ACCEPT**：按 ⚑D1 的裁决结果进入实现切分。若裁决为 C，先把 §1.10 的降级写入合并稿。
- 本轮审核结论仍为 **REVISE**：**不开第 4 轮。**把 review-v3 的未关闭项连同本文件 §10 一起交给用户，由用户逐项裁决“接受当前设计并带着已知缺口实现”或“缩小范围”。

---

## 12. 审核检查清单（供 review-v3 逐项勾选）

| # | 检查项 | 依据 |
|---|---|---|
| 1 | K0 失败的证明与源码一致：`exec.mjs:101/191/248`、`flow.mjs:265-273/337/342/358-362/269` | §1.1 |
| 2 | K1 不改 `runFlow` 的函数体，不改 `exec.mjs`；回归测试 A1-10 可以执行 | §1.2 |
| 3 | 每次 `runStep` 至多一次物理调用（单候选，且 `networkRetries = 0`） | §1.2 |
| 4 | 轮次开始和结束的时点有定义，与物理调用预算互相独立；没有第 4 次 dev；第三轮评审能够执行 | §1.4、§1.5 |
| 5 | 单评审候选、keep/discard 适用于所有失败原因、崩溃对账、重复摘要都有时序和验收例子 | §1.7、§1.9 |
| 6 | 如果拒绝 K1，被降级的承诺已逐条列出 | §1.10 |
| 7 | G2 为固定快照；I 的选定、更新、失效规则完整；人工勾选和检查定义进入内容哈希；下游准入使用同一个 I | §2 |
| 8 | 提交拓扑满足 `M^2 == S`；S 之后在任务分支上没有提交；派生结果不进 git；merge 不调用旧 CLI | §3 |
| 9 | 补封存已从命令、gate 和正文中全部删除 | §3.5、§8 |
| 10 | 运行时只用锁；项目 routing 只在生成锁时读取；provider 对象原样冻结 | §4 |
| 11 | `commit --only` 排除用户已暂存的内容；共享锁覆盖所有写 main 的命令，包括旧 merge；事务日志可以前滚或回滚 | §5 |
| 12 | 插件写盘例外已删除；`admit` 覆盖全部 `starts_work` 命令 | §6 |
| 13 | Minor 四项均已处理 | §7 |
| 14 | ⚑D1 的措辞没有把 K0 当作可行选项；没有擅自放宽任何已确认边界 | §10 |
