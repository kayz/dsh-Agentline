# AgentLine Blueprint 20261106：设计 v4 契约收口（design-v4-contract）

- 状态：**局部契约收口**，不重新讨论范式。只处理 review-v3 中尚未关闭的 Blocking（B1、B4、B5）、Major（M3/M5、M4）和 Minor。
- 日期：2026-11-06
- 主设计：Claude Opus 5.5；终审：GPT-6 Astra
- 基线：`design-v1.md` + `design-v2-delta.md` + `design-v3-delta.md`。本文件只列出**替换或新增**的契约；未提到的部分保持 v3 合并后的原样。
- 用户裁决：D1=A（授权 K1）、D2（允许人工登记例外，并始终标为 unverified）、D3（每次显式追加一轮）、D4（本机 CLI 是受信任的审批入口，依据是账户信任约定）均已确认。本文只写这些裁决的落地方式（§6），不再把它们列为待裁决项。
- 静态核对的源码：`orchestrator/lib/{exec,flow,inputs,git,lock}.mjs`、`orchestrator/agentline.mjs`。本轮不改仓库，也不写产品代码。

---

## 0. 关闭对照与替换章节清单

### 0.1 review-v3 问题 → 本文件章节

| 问题 | v4 处理 | 章节 |
|---|---|---|
| **B1** K1 恢复与逐调用证据 | 每个步骤写成带阶段的事务；ledger 事件有幂等键；定义 W0–W6 七个崩溃窗口各自的恢复结果；“先归档，再调用”成为 beforeCall 的硬前置；amendment 与纪元一次性绑定；进程树终止证明取代“静止指纹” | §1 |
| **B4** 合并校验循环、重入、缓存 | T 拆成 `T_content`、`T_pre`、`T_final`；合并改为单一 MainWrite 事务（prepared→merging→merged→recorded→verified）；**只能凭事务日志重入**；只有不可变部分进缓存，动态部分每次重新求值 | §2 |
| **B5** 批准检查不在锁内 | 所有权威状态（批准、撤销、豁免、grant、身份例外）的变更都必须持 MainWrite 锁；合并和 materialize 的最终检查放在锁内，与写入处于同一事务边界 | §3 |
| **M3/M5** 目标路径保护 | 目标路径上的未跟踪文件、被忽略的文件以及大小写冲突，一律返回 `E_PATH_CONFLICT`；前滚和回滚都要按原定的路径、模式、blob 校验 | §4 |
| **M4** drain 零计数不可靠 | 准入登记（admission）与 drain 标志在同一把锁下线性化；登记的生命周期覆盖“已准入、未启动”的阶段，以及 worker 交接；旧 `cmdRun`/`flow` 通过 `live.json` 和准入登记双重计数；任何来源不可读时结果为 `unknown`，不当作 0 | §5 |
| Minor | 命令命名规则、预算措辞、G2 下游条件、合并稿清理清单 | §7 |

### 0.2 替换章节清单（合并 v1+v2+v3+v4 时按此拼装）

| 合并基线中的章节 | 处理 | v4 来源 |
|---|---|---|
| v3 §1.2 `runStep` 签名表中的 `stepId`、`note` 行，以及“提交”列 | 替换：区分 step_id 和 call_id，提交使用双 trailer，并保证总会产生一个提交 | §1.2 |
| v3 §1.3 build worker | 增补：worker 身份、心跳、进程树登记 | §1.6 |
| v3 §1.4 规则 1 与规则 7 | 替换：规则 1 采用 §6.2 中的轮次上限 L；规则 7 改为 amendment 绑定 | §1.5、§6.2 |
| v3 §1.5 末段“worker 崩溃后的对账” | **整段删除**，改用 §1.3、§1.4 | §1.3、§1.4 |
| v3 §1.6 CallGuard 最后一条（“日志覆盖不影响审计”） | 删除，改用 §1.4 的“先归档，再调用” | §1.4 |
| v3 §1.7 S6 | 替换为 §1.8 的 R 系列时序 | §1.8 |
| v3 §1.9 A1-7 | 替换为 A1-7a 至 A1-7k | §1.9 |
| v3 §3.2 第 8 步（T 缓存） | 替换 | §2.5 |
| v3 §3.3 `build merge` 时序及“重入”段 | **整节替换** | §2.3、§2.4 |
| v3 §3.4 `T.reachable` | **整节替换**为 T 的三分 | §2.2 |
| v3 §3.6 `depends_on` | 替换 | §2.6 |
| v3 §3.7 中的 A4-10 | 替换为 A4-10a 至 A4-10f；新增 A4-14 至 A4-18 | §2.7 |
| v3 §5.1 共享写锁的覆盖范围 | 增补“权威状态变更” | §3.1 |
| v3 §5.2 MainWrite 第 2、3、5 步 | 替换 | §4 |
| v3 §5.4 materialize | 替换 | §3.3 |
| v3 §6.2 末尾两条（drain status、静态测试） | 替换 | §5 |
| v3 §7.3 有效性链表 | 增补列：“检查位置” | §3.2 |
| v2 §2.3 G2 的用户门 / v3 §2.5 第一句 | 替换措辞 | §7.3 |
| v2 §3 第 4 条（可豁免项白名单）、v2 §13.2 中的 ⚑D2/⚑D3/⚑D4 | 替换为已裁决的落地方式 | §6 |
| v3 §8 命令表、错误码 | 按 §8 增删改 | §8 |
| v3 §9.2 实现切分 | 按 §9 调整依赖 | §9 |
| v3 §10、§11 | 替换为 §10 | §10 |

---

## 1. B1：K1 下的步骤事务与崩溃恢复

### 1.1 写入次序（源码事实）

一次 `runStep(dev|design|review)` 中依次发生以下持久化动作：

| # | 动作 | 写在哪里 | 代码位置 |
|---|---|---|---|
| P1 | worker 写 `step.begin` | ledger | Supervisor |
| P2 | runStep 的前置处理：注入 note、清理 attention | `inputs.jsonl`、`attention.json` | runStep |
| P3 | beforeCall：先确认归档前置条件（§1.4），再写 `call.start` | ledger | CallGuard |
| P4 | `adapter.run`：写日志 `logs/<role>-r<k>-1.log`（单候选时 idx 恒为 0），并改动工作区 | 任务 worktree | `exec.mjs:135`、`exec.mjs:148` |
| P5 | afterCall：归档日志，生成 checkpoint，写 `call.archive`；然后写 `call.end` | C 级归档目录、`refs/agentline/calls/*`、ledger | CallGuard |
| P6 | executeRole 记账：`appendRun` → `markConsumed` → `writeState`（失败时只做 appendRun 加 writeState(blocked)） | `run.json`、`inputs.jsonl`、`state.json` | `exec.mjs:198-202`、`exec.mjs:255` |
| P7 | runStep 提交，信息中带 `Agentline-Step` 和 `Agentline-Call` 两个 trailer | 任务分支 | runStep |
| P8 | worker 写 `step.end` | ledger | Supervisor |
| P9 | worker 的归约器写 `round.close`、`round.open`、`epoch.open` 等派生事件 | ledger | Supervisor |

注意：P5 在 P6 之前，因为 afterCall 是 `adapter.run` 包装层的一部分。

### 1.2 `runStep` 的补充约束（替换 v3 §1.2 的对应行）

- **两种标识：**`step_id = "e{e}/{role}/{k}"`（design 的 k=0；design_scope 的 role 写作 `design_scope`）；`call_id = "{step_id}/a{n}"`，n 是该步骤的第 n 次物理调用，n 从 1 起，跨崩溃和 resume 单调递增。
- **提交必定产生：**dev、design、design_scope、review、pr_open 的步骤提交一律带上 `--allow-empty`，信息尾部为：
  ```
  Agentline-Step: <step_id>
  Agentline-Call: <call_id>
  ```
  所以“HEAD 带有该 call_id 的 trailer”恰好等价于“该调用的步骤提交已经完成”。
- **前置处理幂等：**`note` 输入用 `meta.key = call_id` 去重。同一个 call_id 已经有 note（pending 或 consumed 均算）时，不再追加。attention 的清理本身幂等。
- **重新绑定输入（新增参数 `rebindInputs: [input_id]`，仅由恢复流程传入）：**如果某个 id 在工作区的 `inputs.jsonl` 中是 `consumed`，而在 `HEAD:<path>` 中是 `pending`，runStep 就把它改回 `pending`。做法是原子重写，并保留 HEAD 之后新追加的行。随后写 ledger `inputs.rebind {call_id, ids}`。这件事由 runStep 完成（`flow.mjs` 在 K1 授权范围内），Supervisor 不直接写这个文件，B10' 依然成立。
- **新增 step 种类 `finalize`（只用于恢复，不发起模型调用）：**参数为 `{call_id, expect: {role, k, run_count_after, history_len_after, to_status}}`。runStep 先校验 §1.3 W3 的成功证据，再执行与正常路径相同的提交，返回 `{ok, head}`。证据不足时返回 `{ok:false, reason:'finalize_evidence_missing'}`，并且**不提交**。

### 1.3 ledger 事件与崩溃窗口

**ledger 的写入纪律**

- 只追加，每行一个 JSON，写完 fsync。
- 每个事件带 `seq`（严格递增）、`at`、`type`，以及**幂等键** `ikey`。
- 归约器遇到 ikey 相同且载荷相同的事件，忽略重复；遇到 ikey 相同但载荷不同的事件，返回 `E_LEDGER_CONFLICT`，进入 `blocked(integrity)`。
- 最后一行如果解析失败（写到一半），把它原样移到 `ledger.torn/<seq>.txt`，然后从截断处继续。

| type | ikey | 关键字段 |
|---|---|---|
| `epoch.open` | `epoch:<e>` | `e`、`amendment_ids[]`、`after_step_id` |
| `step.begin` | `begin:<step_id>:<begin_seq>` | `step_id`、`worker {run_id, pid, proc_start}`、`pre {head, fingerprint, code_digest, run_count, history_len, inputs_pending[]}` |
| `call.start` | `call:<call_id>` | `call_id`、`model`、`effort`、`log_name`、`pre {head, fingerprint}` |
| `call.archive` | `archive:<call_id>` | `by: afterCall\|recovery`、`log {dst, sha256, bytes}\|null`、`checkpoint {ref, sha}\|null`、`artifacts[{path, sha256}]`、`partial: bool` |
| `call.end` | `end:<call_id>` | `exit`、`error`、`resolved`、`post.fingerprint`、`usage`、`by: afterCall\|recovery` |
| `inputs.rebind` | `rebind:<call_id>` | `ids[]` |
| `step.end` | `stepend:<step_id>:<call_id>` | `ok`、`reason`、`head`、`commit`、`verdict?`、`ci?`、`code_digest?`、`by: worker\|recovery` |
| `round.open` | `ropen:<e>:<k>` | 由 `(e, dev, k)` 的第一条 `call.start` 派生 |
| `round.close` | `rclose:<e>:<k>` | `result`、`by: ci\|review\|cache`、`cause: step_id` |
| `recovery` | `recovery:<recovery_id>` | `window`、`actions[]`、`liveness` 证明（§1.6） |

**派生事件可以重算：**`round.open`、`round.close`，以及 verdict 缓存，都是 `step.end` 和 `call.start` 的纯函数。恢复时只需重跑归约器，补齐缺失的派生事件即可，不需要猜测。

**崩溃窗口与恢复结果（取代 v3 §1.5 的“对账”）**

恢复入口：worker 启动、`build resume`、`recover sweep`。前提是 §1.6 的终止证明已经通过，并且恢复者持有任务锁。下面的“最后一个调用”指 ledger 中该步骤 call_id 最大的那条。

| 窗口 | ledger 现场 | Git 与文件现场 | 恢复结果 | 计入 |
|---|---|---|---|---|
| **W0** | 有 `step.begin`，没有 `call.start` | 可能已执行 P2 | 不发起调用。直接进入下一次 `step.begin`；P2 是幂等的 | 不占调用预算 |
| **W1** | 有 `call.start`，没有 `call.archive` | 日志和工作区可能残留 | ①先按 §1.4 归档（`by: recovery`，`partial: true`）；②补写 `call.end {error: E_WORKER_LOST, by: recovery}`；③进入 W2 的判定 | 占 1 次调用 |
| **W2** | 有 `call.end`，HEAD 上**没有**该 call_id 的 trailer | 可能已部分执行 P6 | 按 executeRole 留下的证据分三种情况：**(a) 成功证据完整**（见下）→ `runStep(finalize)` → 提交 → W3；**(b) 失败证据完整**（`state.status == blocked`，`history_len == pre.history_len + 1`，最后一条 run 的 `error ≠ null`）→ 补写 `step.end {ok:false, reason: classifyError(error)}` → 按 v3 §1.5 的副作用规则处理；**(c) 证据不完整**（P6 中途崩溃）→ 补写 `step.end {ok:false, reason: E_WORKER_LOST_POSTCALL}`，下一次调用带 `rebindInputs = pre.inputs_pending`，并按副作用规则处理 | 结果 (a) 不额外占用预算；(b)(c) 本次调用已计入 |
| **W3** | 有 `call.end`，HEAD **就是**带该 call_id trailer 的提交，没有 `step.end` | 步骤提交已完成 | 补写 `step.end {ok:true, head, commit, by: recovery}`。review 的 verdict 从 `git show <commit>:<task>/verdict-r{k}.json` 读取，不读工作区。**不重跑** | — |
| **W3'** | trailer 出现在 HEAD 的某个祖先上，而不是 HEAD 本身 | 有人在 worker 之后提交过 | `E_TASK_HEAD_DIVERGED` → `blocked(integrity)` | — |
| **W4** | 有 `step.end`，缺少对应的派生事件（`round.close`、`round.open`） | — | 重跑归约器补写，再求 `next()` | — |
| **W5** | 派生事件完整，没有下一条 `step.begin` | — | 正常执行 `next()` | — |
| **W6** | ci 或 discard 步骤，有 `step.begin`，没有 `step.end` | ci-results 或 discard 可能执行了一半 | ci：在同一 HEAD 上重跑，结果覆盖；discard：重新执行 `runStep(discard)`，并校验摘要。两者都不涉及模型调用 | — |

**W2(a) 中“成功证据完整”的判定（全部满足）**

1. `state.json.status == ROLE_SPECS[role].to`，且 `history_len == pre.history_len + 1`；
2. `run.json` 的记录数为 `pre.run_count + 1`，最后一条的 `role`、`round` 与当前步骤一致，`error == null`，`log_ref` 等于本次调用的 `log_name`；
3. 当前工作区指纹等于 `call.end.post.fingerprint`，即调用结束后工作区没有再被改动；
4. review 步骤还要求 `verdict-r{k}.json` 的 mtime ≥ 本次调用的 `call.start.at`，并且可以解析。

**`step.end` 之后的固定顺序：**worker 先写 `step.end`，再写派生事件。崩溃落在这两者之间，就是 W4。

### 1.4 证据先归档，再允许下一次调用

- **硬前置条件（beforeCall）：**对同一个 step_id，如果上一个 call_id 有 `call.start`，却没有 `call.archive`，就拒绝发起新的调用，返回 `G_EVIDENCE_PENDING`（exit 97）。在正常路径上这种拒绝不应该出现；一旦出现，说明恢复流程有缺陷，进入 `blocked(integrity)`。
- **归档内容（afterCall 与恢复流程使用同一个函数 `archiveCall(call_id)`）：**
  1. 日志：把 `logs/<log_name>` 复制到 C 级目录 `calls/<call_id>/log`，记录 sha256 和字节数。文件不存在时记为 `log: null`，并注明 `reason: missing`。
  2. 部分产物：写角色（design、dev）执行 `checkpointWorktree(repo, "calls/<call_id>")`，得到 `refs/agentline/calls/<call_id>`。它覆盖未跟踪文件，也覆盖 `.collab`；被忽略的文件不在其中，这一点要在 UI 中说明。review 不生成 checkpoint，但记录 `verdict-r{k}.json`、`review-r{k}.md` 的 sha256。
  3. `live.json`：如果存在，复制到归档目录。
  4. 写 `call.archive`。**只有这一条落盘之后**，afterCall 才写 `call.end`。
- **checkpoint 的留存：**`refs/agentline/calls/*` 保留到任务封存之后；封存时把这些 ref 列入 `manifest.json`，然后删除 ref（对象仍可能留在 reflog 或 gc 之前）。原始日志按 v2 Q6 的 C 级留存规则处理。
- **keep 和 discard 的依据：**`--discard` 的 `discardTo` 取最后一次调用的 `pre.head`；`--keep` 保留现场。不论选哪个，被中断调用的部分产物都已经在 checkpoint 中。

### 1.5 amendment 与纪元一次性绑定（替换 v3 §1.4 规则 7）

- **绑定集合：**`bound = ∪ epoch.open.amendment_ids`，由 ledger 折叠得出。
- **步骤之间（只在 W5 的位置）：**`fresh = pendingInputs(['amendment']).ids − bound`。
  - `fresh ≠ ∅` → 写 `epoch.open {e+1, amendment_ids: fresh}`，下一步为 `(e+1, design)`；
  - `fresh = ∅`，即使还有 pending 的 amendment（说明它们已经绑定，但 design 尚未成功），**也不开新纪元**，下一步继续 `(e, design)`，受该步骤的调用预算约束。
- **消费：**amendment 只在 `(e, design)` 的步骤提交中随 `inputs.jsonl` 一同被标记为 consumed。W2(c) 的情况下，通过 `rebindInputs` 恢复为 pending，保证重试时提示词里仍然包含这条 amendment。
- **结论：**同一个 amendment id 至多出现在一条 `epoch.open` 中。design 失败、崩溃、resume 都不会增加纪元。
- **重叠情形：**纪元 e 的 design 还没成功时又来了新的 amendment → 下一个步骤边界开启 e+1，并且只绑定新 id。e 中已绑定但未消费的 amendment 仍然 pending，所以会一并出现在 e+1 的 design 提示词中。e+1 的 design 成功时，两者一起被消费。

### 1.6 续跑前确认旧执行者已终止（替换 v3 中的“10 秒静止指纹”）

**worker 身份：**`{run_id, pid, proc_start}`，其中 `proc_start` 是操作系统报告的进程创建时间。
- 任务锁的 meta 中写入 `proc_start`。`acquireLock` 的 meta 原本就可以透传，lock.mjs 的判定逻辑不改。
- 恢复者判断锁的持有者是否存活，用的是“pid 存活且 proc_start 相同”。pid 存活但 proc_start 不同 → 视为 stale，可以接管，并在 ledger 中记录。

**进程树登记：**
- POSIX：worker 以 `setsid` 启动，成为进程组长，`pgid = pid`。
- Windows：worker 每 2 秒写一次心跳 `<B>/build/NNN/worker.json {run_id, pid, proc_start, descendants: [{pid, proc_start, image}], at}`。后代按 `ParentProcessId` 递归求得，并要求子进程的创建时间不早于父进程，以此排除 pid 复用。

**终止证明 `liveness_proof`（写入 `recovery` 事件），以下全部成立才算通过：**

1. `(pid, proc_start)` 的 worker 已经不存在；
2. POSIX：`kill(-pgid, 0)` 返回 ESRCH。Windows：心跳中记录的每个后代都已不存在或 pid 已被复用；**并且**按 `ParentProcessId` 递归扫描，找不到父进程是已死 worker、且创建时间晚于 `worker.proc_start` 的存活进程。Windows 上孤儿进程会保留 `ParentProcessId`，所以这项扫描可以覆盖“最后一次心跳之后才启动的子进程”。
3. 扫描本身成功。扫描失败（权限不足、WMI 不可用）→ 结果为 `unknown`，**不算通过**。

**未通过时：**
- 如果存活的是本任务的进程树（身份已逐一核对），恢复者执行与 `build stop --now` 相同的整树终止，然后重新证明；
- 重新证明仍未通过，或结果为 `unknown` → `E_PROCESS_LINGERING` → `blocked(integrity)`；
- **不做自动重试。**静止指纹只作为辅助展示，不能用来授权。

### 1.7 物理调用预算的补充

- W1 和 W2(c) 中，被中断的调用照常占用该步骤的自动预算（因为 `call.start` 已经发生）。
- W2(a) 和 W3 不额外占用预算。
- `E_WORKER_LOST` 和 `E_WORKER_LOST_POSTCALL` 都属于基础设施错误，可以参与 v3 §1.5 的轮换条件判断。

### 1.8 恢复时序（替换 v3 S6）

| # | 场景 | 恢复 |
|---|---|---|
| R1 | review 调用中途崩溃（W1） | 终止证明 → 归档部分日志 → `E_WORKER_LOST` → 评审不改产品代码，指纹不变 → 发起 a2，评审者不变 |
| R2 | dev 调用正常结束，`appendRun` 之前崩溃（W2c） | `E_WORKER_LOST_POSTCALL`；指纹已变 → `interrupted_choice`；用户选 keep → a2 带 note，并重新绑定输入 |
| R3 | dev 的 `writeState` 之后、提交之前崩溃（W2a） | `finalize` 提交 → `step.end ok` → 归约 → 进入 `(e, ci, k)` |
| R4 | review 提交之后、`step.end` 之前崩溃（W3） | 从提交中读取 revise → `step.end` → 补写 `round.close fail(review)` |
| R5 | `step.end(ci, 3, fail)` 之后、`round.close` 之前崩溃（W4） | 补写 `round.close(3)` → 达到上限 L → `awaiting_user(round_limit)` |
| R6 | 纪元 2 的 design 失败 3 次 | `blocked(step_cap)`；e 仍为 2；amendment 仍然 pending，但已绑定 |

### 1.9 B1 验收例子（替换 A1-7）

| # | 注入 | 期望 |
|---|---|---|
| A1-7a | W0：在 `step.begin` 之后杀死 worker | 恢复后 dev 的 `call.start` 只有 1 条；note 输入只有 1 条（同一 `meta.key`） |
| A1-7b | W1：dev 调用写了 2 KB 日志并改动 1 个文件之后杀死 worker | `calls/<a1>/log` 的 sha256 等于崩溃时的日志；`refs/agentline/calls/e1/dev/1/a1` 包含该文件；`call.end.by = recovery`；用户执行 resume 之前没有 a2 的 `call.start` |
| A1-7c | 删除 W1 归档函数，直接发起 a2（故障夹具） | beforeCall 返回 `G_EVIDENCE_PENDING`；adapter 调用计数不变 |
| A1-7d | W2a：在 `writeState` 之后、提交之前杀死 worker | 恢复产生 1 个带 `Agentline-Call: e1/dev/1/a1` 的提交；`step.end.by = recovery`；没有 a2；调用总数为 1 |
| A1-7e | W2c：在 `appendRun` 之后、`writeState` 之前杀死 worker；该步骤绑定了 amendment X | `step.end reason = E_WORKER_LOST_POSTCALL`；a2 的提示词中包含 X（`inputs.rebind` 中有 X） |
| A1-7f | W3：review 提交之后杀死 worker | 没有新的 review `call.start`；`round.close(k) by review` 恰好 1 条 |
| A1-7g | W4：`step.end(ci, 3, fail)` 之后杀死 worker | `round.close(3)` 恰好 1 条；`awaiting.kind = round_limit`；没有 `(e, dev, 4)` |
| A1-7h | amendment X 到达；design 连续失败 3 次；用户 resume 一次，又失败 | 只有 1 条 `epoch.open` 含 X；e 始终为 2 |
| A1-7i | e2 的 design 失败后又来 amendment Y | 出现 `epoch.open {3, [Y]}`；X 不出现在其中；e3 的 design 提示词同时包含 X 和 Y；成功后 X、Y 都被消费 |
| A1-7j | 杀死 worker 但保留 adapter 子进程，让它继续写文件 | 恢复报告 liveness 失败 → 按身份逐一终止整树 → 重新证明通过后才进入 W1；如果终止失败 → `E_PROCESS_LINGERING`，没有新的 `call.start` |
| A1-7k | ledger 末行只写了一半 | 末行移入 `ledger.torn/`；归约结果与截断前一致 |

---

## 2. B4：T 的三分与受控合并事务

### 2.1 原则

- 正常合并期间，**任何时候都不要求“K 已经存在”**。K 只出现在 `T_final` 中，而 `T_final` 只在 K 写入之后才求值。
- 重入**只认事务日志**。仅凭“存在一个 M 满足 `M^2 == S`”，不构成任何恢复依据。

### 2.2 T 的三个部分（替换 v3 §3.4）

| 部分 | 内容 | 输入是否可变 | 缓存 |
|---|---|---|---|
| `T_content(S)` | 除可达性和当前批准之外的全部 T check：CI、评审、隔离、身份（含 D2 例外）、`seal.files` 的哈希、来源节点的 canonical 哈希与封存记录一致 | 对给定的 S 和策略不可变 | 可以缓存，键见 §2.5 |
| `T_pre(S)` | `T_content(S)` ∧ `T.reachable_pre` ∧ `T.origin_current` | 动态 | **不缓存** |
| `T_final(S)` | `T_content(S)` ∧ `T.reachable_final` ∧ `T.origin_at_merge` | 动态 | **不缓存**（`T_content` 部分可以命中缓存） |

| check | 判定 |
|---|---|
| `T.reachable_pre` | `refs/heads/task/NNN == S`；`S^1 == C`；`git diff --name-only C S` ⊆ `.collab/build/NNN/`。**不读取也不要求 `merged.json`** |
| `T.origin_current` | 有效性链（§3.2 的 merge 列）按当前权威状态全部通过 |
| `T.reachable_final` | main 上存在 `.collab/build/NNN/merged.json`，满足：`seal_commit == S`；`merge_commit = M` 是 main HEAD 的祖先；`M^2 == S`；M 和 K 的提交信息中都带 `Agentline-Txn: <merged.txn_id>`；`K^1 == M`；`diff-tree K` 恰好是 v3 §3.1 规定的 2 个路径。浅克隆 → `error(E_SHALLOW_CLONE)` |
| `T.origin_at_merge` | `merged.json.authority` 快照中的 G0/G1 内容哈希，等于 S 封存的来源哈希；权限记录完整。**合并之后的撤销不会让它失败**，只在 UI 中提示“批准已于合并后撤销” |

**结果：**
- 合并锁内检查使用 `T_pre`；
- `depends_on`、G2 的 `M.task_gates` 使用 `T_final`；
- 状态为 merged、但 `T.reachable_final` 失败的任务（例如外部合并、K 缺失、M 被改写掉），显示为 `unsealed_merge` 或 `record_lost`，不可豁免。

### 2.3 `build merge` 事务（替换 v3 §3.3）

| # | 步骤 | 失败时 |
|---|---|---|
| 0 | **锁外预检（只作参考）：**有效性链、`T_pre`、归档完整；任务 HEAD ≠ 最近一次封存的 S → 先在任务 worktree 中重新封存，得到新的 S | 停止；不取锁 |
| 1 | 取 MainWrite 锁；处理遗留的事务日志（§2.4、§4.4） | `E_MAIN_BUSY` |
| 2 | **锁内最终检查**（§3.2）：任务分支 HEAD == S；`T_pre(S)` 为 pass；有效性链；权限或 grant 当前有效 | `E_SEAL_STALE`、`E_GATE_NOT_PASSED`、`E_APPROVAL_STALE`、`E_APPROVAL_REVOKED`、`E_GRANT_INVALID`；释放锁；main 不变 |
| 3 | 前置条件：main 已检出；index == HEAD；没有 `MERGE_HEAD`；K 的两个路径按 §4.2 无冲突。记下 `P = HEAD` | `E_MAIN_INDEX_DIRTY`、`E_MAIN_NOT_CHECKED_OUT`、`E_PATH_CONFLICT` |
| 4 | 写事务日志，`phase: prepared`（字段见下） | — |
| 5 | 把 phase 写成 `merging`，再执行 `git merge --no-ff --no-edit -m "<msg>\n\nAgentline-Txn: <id>" S` | 冲突 → `merge --abort`，校验 HEAD == P，删除日志 → `E_MERGE_CONFLICT`。git 报告未跟踪或未暂存文件会被覆盖 → `E_MAIN_WORKTREE_CONFLICT` |
| 6 | 校验 `M^1 == P`、`M^2 == S`，M 的 trailer 等于 id → 写 `phase: merged, merge_commit: M` | `E_POST_MERGE_VERIFY` → `blocked(integrity)`，**不自动回退 main** |
| 7 | 在**同一事务、同一把锁**内写 K：生成 `merged.json` 和 `state.json` → `commit --only`（带 trailer）→ 校验 `diff-tree` → 写 `phase: recorded, record_commit: K` | 同 §4.3 |
| 8 | 求 `T_final(S)`，必须为 pass → `phase: verified` → 把日志移入 `txn/done/` | `E_POST_MERGE_VERIFY` → `blocked(integrity)` |
| 9 | 释放锁；清理 worktree 和分支 | 只告警 |

**merge 事务日志 `<common>/agentline/txn/<id>.json`**

```json
{
  "id": "txn-…", "cmd": "build.merge", "task": "NNN", "repo_id": "…",
  "phase": "prepared|merging|merged|recorded|verified",
  "base_head": "P", "seal_commit": "S", "seal_parent": "C",
  "checks": {
    "at": "…", "evaluator_version": "…",
    "t_content_key": "…", "t_pre": "pass",
    "authority": {
      "g0": {"approval_id": "…", "content_sha256": "…"},
      "g1": {"approval_id": "…", "content_sha256": "…"},
      "node_sha256": "…", "materialized_commit": "…",
      "permission": {"kind": "text|grant", "text_sha256": "…", "grant_id": null,
                     "channel": "cli|ui|slash", "caller": "…", "at": "…"},
      "authority_rev": 42
    }
  },
  "merge_commit": null, "record_commit": null,
  "k_paths": [{"path": "…", "mode": "create|modify", "blob_before": null, "blob_after": "…"}]
}
```

**`merged.json`（替换 v3 §3.3 第 8 步的字段）：**`{txn_id, merge_commit, seal_commit, base_main, authority: checks.authority, permission_text ≤ 500, core}`。仍然**不含 gate 判定结果**。

### 2.4 重入与恢复（只凭事务日志）

| 日志 phase | 现场 | 动作 |
|---|---|---|
| `prepared` | HEAD == P，没有 `MERGE_HEAD` | 删除日志。合并没有发生，用户重新执行 `build merge`，**从第 0 步开始，重新检查** |
| `merging` | 存在 `MERGE_HEAD` | `git merge --abort` → 校验 HEAD == P → 删除日志 |
| `merging` | HEAD = M'，`M'^1 == P`、`M'^2 == S`，trailer 等于 id | 改写为 `phase: merged`，`merge_commit = M'`，然后继续第 7 步 |
| `merging` | HEAD == P | 同 `prepared` |
| `merged` | HEAD == M | 继续第 7、8 步。**沿用日志中的 `checks.authority` 快照，不重新检查批准**：合并已经在锁内按有效批准完成，K 只是记录这一事实 |
| `recorded` | HEAD == K | 继续第 8 步 |
| 任意 phase | 其他现场（例如 main 在崩溃后前进到 M 之后、手工改写） | `E_TXN_DIVERGED` → `blocked(integrity)`，向用户展示日志；不自动处理 |
| **没有日志** | main 上存在 `M^2 == S`，但没有 K | **不重入。**判为 `unsealed_merge`（v3 §3.5），不提供补救 |

**入口：**再次执行 `build merge --task NNN`，或 `recover sweep`。两者都要先取锁，再按上表处理。重入从不跳过第 2 步，除非日志 phase 已经是 `merged` 或之后，此时检查结果已在日志中保留。

### 2.5 T 缓存（替换 v3 §3.2 第 8 步）

- **只缓存 `T_content`。**路径为 `orchestrator/data/gates/T/<repo_id>/<NNN>/<key>.json`，其中：
  ```
  key = H(S, content_hash, evaluator_version, policy_digest)
  policy_digest = H(T check 表及可豁免性, 隔离规则版本,
                    本任务涉及的 identity_group 所对应的身份例外条目 canonical（§6.1）)
  ```
- 键已经覆盖全部输入，不需要额外的失效逻辑：身份例外被登记或撤销，会改变 `policy_digest`，于是旧缓存自然不再命中。
- `T.reachable_pre`、`T.reachable_final`、`T.origin_current`、`T.origin_at_merge`**每次都重新求值**。它们只是 git 祖先判断、读 blob 和比较哈希，成本很低。
- 依赖准入、G2、UI 中的“合并后状态”都通过 `T_final` 求得，从不直接读取缓存文件中的总体结论。缓存文件中**不存放**总体 pass/fail。

### 2.6 `depends_on`（替换 v3 §3.6）

依赖任务满足的条件是：对该任务 `merged.json.seal_commit` 求 `T_final`，结果为 pass。不再接受“有 `merged.json` + 缓存命中”的组合判定。

### 2.7 B4 验收例子（替换 A4-10，新增 A4-14 至 A4-18）

| # | 场景 | 期望 |
|---|---|---|
| A4-10a | 正常合并 | 日志 phase 依次经过 prepared → merging → merged → recorded → verified；第 2 步的 `T_pre` 为 pass，且在没有 `merged.json` 的情况下成立；第 8 步的 `T_final` 为 pass |
| A4-10b | `git merge` 完成后、写 `phase: merged` 之前被杀 | 恢复把 phase 改为 merged → 写 K → verified；main 上只有 1 个 M 和 1 个 K |
| A4-10c | phase 为 merged 时被杀，之后撤销 G1 批准，再执行 `build merge` | 仍然写 K，`merged.json.authority` 等于撤销前的快照；`T_final` 为 pass；UI 显示“批准已于合并后撤销” |
| A4-10d | phase 为 merging 时被杀，并留下 `MERGE_HEAD`（冲突合并到一半） | `merge --abort`，HEAD == P，日志删除，任务仍为 `pr_open` |
| A4-10e | 删除事务日志，只保留 M | 再次执行 `build merge` 不写 K；任务判为 `unsealed_merge` |
| A4-10f | phase 为 merged 时被杀；用户在 main 上手工提交了 X | `E_TXN_DIVERGED`；不写 K |
| A4-14 | 不经过 AgentLine，手工 `git merge --no-ff S` | 没有事务日志 → `unsealed_merge`；`build merge` 不补写 K |
| A4-15 | `T_content` 已缓存为 pass，之后撤销该评审者 identity_group 的身份例外 | `policy_digest` 改变，缓存不命中；重新求值得到 `T.identity_verified` fail |
| A4-16 | 合并后 main 被强推，回退到 M 之前 | `T_final` 的 `reachable_final` 为 fail（`record_lost`）；依赖它的任务启动返回 `E_DEPENDENCY_NOT_MET` |
| A4-17 | 合并 K 之后又提交了另一个任务的 K2 | 对前一个任务求 `T_final` 仍为 pass（祖先关系成立），不需要任何失效逻辑 |
| A4-18 | 某个 M 的 trailer 是 txn-A，而 `merged.json.txn_id` 是 txn-B | `reachable_final` 为 fail |

---

## 3. B5：锁内最终检查与权威状态

### 3.1 权威状态变更必须持 MainWrite 锁（增补 v3 §5.1）

- **权威状态**包括：G0/G1/G2 的批准与撤销、waive、grant 的创建、撤销与过期标记、D2 的身份例外登记与撤销，以及 `materialized.json`。
- 不论这些数据存放在 main 树中，还是存放在 C 级数据目录中，**每次变更都必须在同一个仓库的 MainWrite 锁内完成**，并把 `<common>/agentline/authority_rev` 加 1。
- 只读检查可以在锁外进行，但锁外检查的结果**只作参考**。

### 3.2 有效性链的检查位置（增补 v3 §7.3）

| 操作 | 锁外预检 | **锁内最终检查（权威）** | 与写入是否在同一事务 |
|---|---|---|---|
| materialize（首次） | 可选 | 检查 1–4：G0、G1 的内容哈希与批准状态，`plan_digest` | 是：检查、分配编号、生成文件、提交，在一把锁内连续完成 |
| build merge | 可选 | 检查 1、2、3、5、6，再加任务分支 HEAD == S 和 `T_pre` | 是：§2.3 第 2–8 步 |
| build start | 可选 | 检查 1、2、3、5，以及 `user_gate` 任务的人工原话；在锁内登记一条 run 准入记录 | 准入记录和检查在同一把锁内完成；运行中途撤销批准不会中断 worker，但合并时会被锁内检查拦下 |
| approve、revoke、waive、grant、身份例外 | — | 在锁内读取当前状态再写入 | 是 |

**锁内最终检查失败时：**释放锁，main、index、事务日志都没有任何变化。返回的错误码与锁外预检相同，但信息中带有 `checked_in_lock: true`。

### 3.3 materialize（替换 v3 §5.4）

1. 取锁 → 处理遗留的事务日志；
2. **在锁内**读取当前任务图和 G0/G1 批准，重新计算 `plan_digest`。如果它不等于用户预览时的值 → `E_PLAN_STALE`；如果批准被撤销或内容哈希不一致 → `E_APPROVAL_*`；
3. 分配编号 → 在 `<common>/agentline/txn/<id>/` 生成文件 → 写事务日志（§4.3 的字段，加上 `plan_digest`、`authority` 快照）→ 按 MainWrite 一次提交；
4. `materialized.json` 中记录 `{plan_digest, g0_approval_id, g1_approval_id, authority_rev, txn_id}`。

### 3.4 B5 验收例子

| # | 注入 | 期望 |
|---|---|---|
| A5b-1 | 在合并的锁外预检通过之后插入钩子暂停；另一进程执行 `revoke G1` 并成功；然后让合并继续 | 合并在锁内检查时返回 `E_APPROVAL_REVOKED`；main HEAD 不变；没有遗留事务日志 |
| A5b-2 | 合并持锁期间执行 `revoke` | revoke 等待锁，直到合并 verified 后才完成；`merged.json.authority_rev` 小于撤销后的值 |
| A5b-3 | grant 在合并等锁期间过期 | `E_GRANT_INVALID`，main 不变 |
| A5b-4 | materialize 预览之后，G1 按新内容重新批准 | 锁内重新计算得到不同的 `plan_digest` → `E_PLAN_STALE`；没有分配编号 |
| A5b-5 | 合并等锁期间，任务分支被追加了一个提交 | `E_SEAL_STALE`；释放锁；用户再次执行 `build merge` 时先重新封存 |
| A5b-6 | 在锁外直接写身份例外文件（绕过命令，故障夹具） | 静态测试失败：权威状态写入点没有经过 `withMainWrite` |

---

## 4. M3/M5：MainWrite 的目标保护与恢复校验（替换 v3 §5.2 第 2、3、5 步）

### 4.1 每个目标路径的计划

每个目标路径都要先声明计划 `{path, mode: create|modify|delete, blob_before, blob_after}`：
- `blob_after` 在写文件之前算好（`git hash-object` 预计算）；
- delete 的 `blob_after` 为 null。

### 4.2 前置条件：任一项不满足就返回 `E_PATH_CONFLICT`，并在信息中列出路径

| mode | 要求 |
|---|---|
| create | HEAD 中没有该路径；工作区中该路径**不存在**——不论是未跟踪文件还是被忽略的文件（检查文件系统，而不只是 git 状态）；任何祖先目录都不是普通文件；`core.ignorecase = true` 时，HEAD、index、工作区中都不存在大小写不同的同名路径 |
| modify、delete | HEAD 中有该路径，且 `blob(HEAD) == blob_before`；index 中该路径等于 HEAD；工作区中该路径的内容哈希等于 `blob_before` |
| 所有 mode | 不在 `git diff --cached --name-only` 中；没有正在进行的 merge 或 rebase |

materialize 原有的“目标不存在”检查，现在被 create 模式统一覆盖。approve、check、`task new`、K 的写入都继承同一套规则。

### 4.3 事务日志（替换 v3 §5.2 第 3 步）

```json
{"id": "…", "cmd": "…", "base_head": "…", "phase": "prepared|committed",
 "paths": [{"path": "…", "mode": "create|modify|delete", "blob_before": "…|null", "blob_after": "…|null"}],
 "extra": {…}}
```

### 4.4 恢复（替换 v3 §5.2 第 5 步）

**前滚**：同时满足以下三项时，只删除日志：
1. 找到带 `Agentline-Txn: <id>` 的提交 X；
2. X 是 HEAD 的祖先；
3. `diff-tree --name-status X^ X` 的路径集合和模式，与 paths 完全一致，且每个路径在 X 中的 blob 都等于 `blob_after`。

任何一项不符 → `E_TXN_DIVERGED`。

**回滚**：没有带该 trailer 的提交，且 HEAD == `base_head` 时执行，对每个路径：
- 工作区内容 ∈ {`blob_before`, `blob_after`}，或者 create 模式下该路径不存在 → 恢复到 `blob_before`（create 模式则删除），然后执行 `git reset -q -- <path>`；
- 其他内容（说明在崩溃后被别人改过）→ **不覆盖**，返回 `E_TXN_DIVERGED`，并列出路径。

**merge 事务**按 §2.4 处理，不走本节的通用规则。

### 4.5 验收例子

| # | 场景 | 期望 |
|---|---|---|
| A5-5 | main 上有未跟踪文件 `.collab/build/007/merged.json`，执行 `build merge` 007 | 锁内第 3 步返回 `E_PATH_CONFLICT`；该文件内容不变；没有 M |
| A5-6 | 目标路径被 `.gitignore` 忽略，但文件存在，执行 `task new` | `E_PATH_CONFLICT` |
| A5-7 | Windows 上存在 `.collab/Tasks/008/`，materialize 要写 `.collab/tasks/008/brief.md` | `E_PATH_CONFLICT`（大小写冲突） |
| A5-8 | 提交成功后、删除日志之前崩溃；随后用户手工修改了提交 X 中的一个路径，再提交 | 前滚校验仍然针对 X 本身，依然成立，日志被删除。如果被篡改的是 X 本身（amend）→ 找不到 trailer 提交 → HEAD ≠ base_head → `E_TXN_DIVERGED` |
| A5-9 | 写文件之后、提交之前崩溃；用户随后又编辑了其中一个目标文件 | 回滚跳过该文件，返回 `E_TXN_DIVERGED`，用户的编辑保留 |

---

## 5. M4：准入登记与 drain（替换 v3 §6.2 末尾两条）

### 5.1 准入登记（admission）

- **`admit(commandId)`**：
  1. 取 `<C>/data/run/drain.lock`（短锁）；
  2. 检查 drain 标志，已设置就返回 `E_DRAINING`；
  3. 写入准入记录 `<C>/data/run/admissions/<adm_id>.json`：
     `{adm_id, cmd, holder: {pid, proc_start}, children: [], state: "admitted", repo, task?, at}`；
  4. 释放锁。

  `drain` 命令在同一把锁内设置标志。因此任何一次准入，要么发生在 drain 生效之前，并被计数；要么被拒绝。
- **生命周期：**
  - 持有准入记录的进程启动 worker、job 或 CI 子进程时，先在记录中追加 `children[]: {pid, proc_start}`，再让子进程开始干活。子进程的“已登记”早于“开始干活”。
  - **交接：**`build start` 在 worker 写入自己的准入记录（`state: running`，worker 自己的 admit 走“继承”模式，**不受 drain 拦截**，但必须带父 `adm_id`）之后，才删除自己的记录。这保证“已准入、未启动”的阶段始终至少有 1 条记录。
  - 进程退出时删除自己的记录。被 kill -9 留下的记录，由 drain status 判定为 stale，需要证明 holder 和所有 children 都已死亡（证明方法同 §1.6）才能清除。
- **旧 CLI**：
  - 当前核心中的 `cmdRun`、`cmdFlow` 由 CLI 分发层调用 `admit`，记录随进程存在。
  - **升级之前就在运行的旧进程**没有准入记录，由 §5.2 的来源 (d)(e) 覆盖。

### 5.2 `drain status`（替换 v3 定义）

| 来源 | 计入条件 |
|---|---|
| (a) admissions | holder 或任一 child 的 `(pid, proc_start)` 存活 |
| (b) 任务锁 / registry | 锁持有者的 `(pid, proc_start)` 存活；旧锁没有 proc_start 时，只要 pid 存活就计入 |
| (c) job 表 | state = running，且 pid 存活 |
| (d) `live.json` 扫描 | 扫描 registry 中所有已知仓库：`<collab>/*/live.json` 以及所有 worktree 中的同名文件，其中 pid 存活。`exec.mjs:139` 在每次 executeRole 调用时都会写这个文件，所以**能覆盖旧 `cmdRun` 和 `runFlow`，与版本无关** |
| (e) `.collab/.flow.lock` | 持有者 pid 存活 |

- **结果为三态：**`0`、`n > 0`（并列出明细）、`unknown`（任一来源不可读、扫描失败，或 registry 之外存在无法枚举的仓库）。
- **只有 `0` 才允许回滚。**`unknown` 时提示用户：先停止所有 agentline 进程，再执行 `drain status`。

### 5.3 验收例子（增补 A6）

| # | 场景 | 期望 |
|---|---|---|
| A6-4 | 在 `admit` 通过之后、写入 child 之前插入暂停钩子，同时执行 `drain` 和 `drain status` | status ≥ 1（admitted 记录被计入）；钩子放行后，worker 照常完成当前步骤，然后退出 |
| A6-5 | `build start` 拉起 worker 之后、交接之前被杀 | 记录的 holder 已死，但 child（worker）存活 → 仍然计入 |
| A6-6 | 用升级之前的核心执行 `agentline run --role dev`（没有准入记录）期间，执行 `drain status` | 通过来源 (d) 计入 1 |
| A6-7 | registry 中有一个仓库路径不可访问 | 结果为 `unknown`，不是 0 |
| A6-8 | 静态测试 | 每条 `starts_work` 命令都经过 `admit`；每个 spawn 点都先写 `children[]` 再启动子进程 |

---

## 6. D1–D4 的落地（已裁决，只写契约）

### 6.1 D2：身份例外

- **登记**：`models exception add --model <key> --version <pinned> --scope <stage[,role]> --reason --text`（W·H，在 MainWrite 锁内执行）。
  - 记录 `{id, model_id, version_pin, scope, operator, channel, caller, at, reason, text_sha256}`。
  - 撤销用 `models exception revoke --id --text`。
- **作用**：`*.identity_verified` 判为 `waived(exception:<id>)`，**不判为 pass**。
- **展示**：UI 和 API 一律显示 `unverified · 例外 #id`。`T.isolation` 在涉及例外身份时显示“按声明身份隔离（未验证）”，**不得**显示为“隔离已验证”。
- **约束**：
  - `version_pin` 必须与调用时解析到的版本一致，否则例外不生效；
  - 自动发现的结果不能进入 top allowlist；
  - 例外条目进入 `policy_digest`（§2.5）。

### 6.2 D3：显式追加一轮

- **上限**：`L = 3 + count(user_action: extend_round)`。v3 §1.4 规则 1 改为：“`round.close(fail)` 且 `k = L` → `awaiting_user(round_limit)`”。
- **命令**：`build decide --task --ruling extend_one --text "<原话>"`，Blueprint 端对应 `blueprint decide`。
  - 只能在 `awaiting.kind = round_limit` 时执行；
  - 每执行一次，L 加 1；
  - ledger 记录 `user_action: extend_round {by, channel, caller, at, text, reason, new_limit, budget_add}`；
  - 同一条记录追加写入 `decisions.json.deviations[]`，封存时进入 S。
- **不提供**自动延长、批量追加或 `accept_as_is`。

### 6.3 D4：本机 CLI 的信任约定

- 审批记录统一包含：`{channel, caller: {os_user, pid, parent_cmd}, text, at, content_sha256}`。
- `cli` 通道的批准**不标红**。详情中显示：“信任依据：本机用户账户约定（非操作者为人的证明）”。
- Host 签名不在本范围内，不阻塞实现。
- 自动化代理不得替用户批准：H 类命令不进入 agent 可调用的 Host 白名单；插件只能在用户交互时触发这类命令（v1、v2 的现有约束保留）。

---

## 7. Minor

### 7.1 命令命名规则

- `command id` 等于 CLI 路径用 `.` 连接，`-` 替换为 `_`；**参数不产生新的 id**。
- 据此统一：
  - `build.resume_keep` 和 `build.resume_discard` 合并为 `build.resume`（参数 `--keep` 或 `--discard`）；
  - `ops.drain`、`ops.undrain`、`ops.drain_status` 分别对应 CLI `drain`、`undrain`、`drain status`；
  - `recover.sweep` 对应 `recover sweep`；
  - `build.retry_now` 对应 `build retry-now`；
  - `milestone.e2e`、`milestone.check` 不变。
- 合并稿的命令表和 Host 白名单都按这条规则校验，并配套一个静态测试。

### 7.2 预算措辞

全文统一写成“**不会自动开启第 L+1 个业务轮次**”（L 见 §6.2）。基础设施重试、`E_NO_PRODUCT_CHANGE`、恢复流程，都可能使同一轮次内的物理 dev 调用超过 3 次。A1-1 的期望改为：“没有 `(e, dev, 4)` 的 `step.begin`”。

### 7.3 G2 下游条件（替换 v3 §2.5 第一句）

> 里程碑 M 的 `user_gate:true` 时，**依赖 M 的下一里程碑中的全部任务**（不论任务自身的 `user_gate` 取值），在 `build start` 和 queue 调度时都要求满足……

任务级 `user_gate` 仍然只管“人工启动、合并不能用 grant”（v2 §9.3）。

### 7.4 合并稿清理清单

合并稿中必须删除或改写以下内容，审核时逐项 grep：
- K0、`r = |S_e|` 和“摘要计轮”；
- 内核摘要白名单（v2 B9）；
- `t-gate.json`、`t_post_merge`；
- `G_ROUND_CAP`、`E_KERNEL_SEAM_UNVERIFIED`、`build seal --post-merge`；
- “评审重放”、`readonly_args_digest`、`materialize.lock`；
- v2 的 A1-1 和 A1-4 原文、v3 §1.5 的“对账”段、v3 §1.6 的“日志覆盖不影响审计”；
- 所有 ⚑D1–⚑D4 待裁决标记（改为“已裁决：见 §6”）；
- `ACCEPT`，改为 `APPROVE`。

---

## 8. 命令、错误码、gate 的增量（相对 v3 §8）

| 变更 | command id | 说明 | starts_work |
|---|---|---|---|
| 新增 | `models.exception_add`、`models.exception_revoke` | §6.1，W·H，持锁执行 | 否 |
| 修改 | `build.decide` | 新增 `--ruling extend_one` | 是（继续运行时） |
| 修改 | `build.merge` | 按 §2.3 执行事务；重入只凭事务日志 | 是 |
| 修改 | `recover.sweep` | 处理任务步骤恢复（§1.3）、merge 事务（§2.4）和通用事务（§4.4） | 否 |

- **新增错误码**：`G_EVIDENCE_PENDING`、`E_WORKER_LOST_POSTCALL`、`E_TASK_HEAD_DIVERGED`、`E_LEDGER_CONFLICT`、`E_SEAL_STALE`、`E_APPROVAL_REVOKED`、`E_GRANT_INVALID`、`E_PLAN_STALE`、`E_DEPENDENCY_NOT_MET`。
- **含义变更**：`E_PROCESS_LINGERING` 现在由 §1.6 的终止证明触发，不再由指纹触发。
- **gate 变更**：
  - T 改为 `T_content`、`T_pre`、`T_final` 三部分（§2.2）；
  - `M.task_gates` 和 `depends_on` 使用 `T_final`；
  - `*.identity_verified` 新增 `waived(exception)` 状态。

---

## 9. 实现切分的依赖调整（相对 v3 §9.2）

| 工作流 | 变更 |
|---|---|
| W7a | 增加：双 trailer 与 `--allow-empty`、`finalize`、`rebindInputs`、ledger 的幂等键与归约器、`archiveCall`、`G_EVIDENCE_PENDING`、终止证明（新模块 `proc-identity.mjs`）、amendment 绑定。前提条件 D1 已满足 |
| W15 | 增加：T 三分、merge 事务及其恢复表、`T_content` 缓存键；依赖 W17 |
| W16 | 增加：admissions 与交接、drain 三态、`live.json` 扫描 |
| W17 | 增加：§4 的路径计划与冲突规则、前滚和回滚校验、权威状态的 `withMainWrite` 包装及 `authority_rev` |
| W18（新增） | D2 身份例外、D3 `extend_one`、D4 审批记录字段；依赖 W17 |

---

## 10. 后续处理与需要用户决定的事项

### 10.1 仍需用户裁决的新问题

**无。**本文件的变更全部是对已确认承诺（Q5、D1–D4、v3 范围）的正确性收口，没有放宽任何边界。

### 10.2 知会项（不需要裁决）

- **N5**：合并在 `merged` 阶段崩溃后，即使批准已被撤销，仍会补写 K（§2.4）。合并的有效性以锁内检查时刻为准。
- **N6**：崩溃之后，如果有人手工改动了 main 或任务分支，相关流程进入 `blocked(integrity)`，不提供自动修复。
- **N7**：checkpoint 不包含被忽略的文件。在中断现场，被忽略的文件只保留在工作区里。
- **N8**：Windows 上的终止证明依赖进程枚举。枚举失败时按 `unknown` 处理，即失败关闭。

### 10.3 流程

本文件提交 **GPT-6 Astra 做最终契约复核**，复核对象为本文件加上 v1、v2、v3。
- 结论为 **APPROVE** → 按 §0.2 拼装合并稿，执行 §7.4 的清理，然后进入实现切分（v3 §9.2 加上本文 §9）。
- 结论为 **REVISE** → 不再开新一轮设计，把未关闭项逐条交给用户，由用户决定“局部修补”或“缩小范围”。

---

## 11. 审核检查清单（供最终契约复核逐项勾选）

| # | 检查项 | 依据 |
|---|---|---|
| 1 | P1–P9 的写入次序与源码一致（afterCall 早于 `appendRun`；`markConsumed` 早于 `writeState`；单候选的日志名为 `-1.log`） | §1.1；`exec.mjs:135/198-202/255` |
| 2 | W0–W6 每个窗口都有确定的恢复结果，并且不会重复调用、重复提交或重复关闭轮次 | §1.3 |
| 3 | W2 把“成功、失败、证据不完整”三种情况区分开，`finalize` 不发起模型调用 | §1.2、§1.3 |
| 4 | 发起新调用之前必须存在 `call.archive`；部分产物进入 checkpoint ref | §1.4、A1-7b/c |
| 5 | 同一 amendment id 至多出现在一条 `epoch.open` 中；崩溃造成的消费丢失可以通过重新绑定恢复 | §1.5、A1-7e/h/i |
| 6 | 续跑之前有进程树终止证明；`unknown` 时失败关闭；不靠静止指纹授权 | §1.6、A1-7j |
| 7 | 合并锁内检查不读取 `merged.json`；`T_final` 只在 K 写入之后求值；不存在循环前置条件 | §2.2、§2.3、A4-10a |
| 8 | 重入只凭事务日志；外部合并（包括 `M^2 == S` 的情况）不会被补写 K | §2.4、A4-10e、A4-14 |
| 9 | 只缓存 `T_content`，缓存键包含身份例外；可达性和批准状态每次都重新求值 | §2.5、A4-15/16 |
| 10 | 所有权威状态变更都持 MainWrite 锁；合并和 materialize 的最终检查与写入在同一把锁内 | §3、A5b-1 至 A5b-5 |
| 11 | MainWrite 拒绝目标路径上的未跟踪文件、被忽略的文件和大小写冲突；前滚和回滚都校验路径、模式和 blob | §4、A5-5 至 A5-9 |
| 12 | 准入与 drain 线性化；“已准入、未启动”的阶段和 worker 交接有计数；旧 `cmdRun` 通过 `live.json` 覆盖；`unknown` 不当作 0 | §5、A6-4 至 A6-7 |
| 13 | D1–D4 只作为已裁决事项落地，没有被重新列为待裁决；D2 例外从不显示为“已验证”；D3 每次只追加一轮，并写入 deviations | §6、§10 |
| 14 | `runFlow` 和 `exec.mjs` 不改；A1-10 的回归测试保持不变 | v3 §1.2 |
| 15 | Minor 四项已处理，清理清单可以通过 grep 验证 | §7 |
