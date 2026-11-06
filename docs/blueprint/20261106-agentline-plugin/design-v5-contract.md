# AgentLine Blueprint 20261106：设计 v5 契约修补（design-v5-contract）

- 状态：**局部契约修补**。只处理 review-v4 中仍未关闭的问题：B1、B4、M4、D3 和 Minor。不重开架构，不改 Q1–Q6，也不再询问 D1–D4。
- 日期：2026-11-06
- 主设计：Claude Opus 5.5；最终契约复核：GPT-6 Astra
- 基线：v1 + v2-delta + v3-delta + v4-contract。本文件只写**替换或新增**的章节。未提到的内容保持 v4 合并后的原样。
- 已静态核对的源码事实：
  - `exec.mjs:130`：在候选循环内读取 pending。
  - `exec.mjs:139`、`exec.mjs:155`：`writeLive` 和 `clearLive` 只包住 adapter 调用。
  - `exec.mjs:198-202`：先 `appendRun`，再 `markConsumed`，最后 `writeState`。
  - `inputs.mjs:53-65`：`markConsumed` 的流程是“整读 → tmp → rename”，它与 `appendInput` 的 `appendFileSync` 之间存在丢行竞态。
  - `agentline.mjs:304-317`：`cmdRun` 不取任何锁。
  - `agentline.mjs:531`：旧 `input` 命令直接写 `inputs.jsonl`。
  - `registry.mjs:20-23`：`alive()` 只看 pid。
- 本轮不写产品代码，不修改仓库。

---

## 0. 关闭对照与替换清单

### 0.1 review-v4 问题 → 本文件章节

| 问题 | v5 处理 | 章节 |
|---|---|---|
| B1-1 输入恢复 | 改用 B 级**输入账本**作为输入的权威来源。“是否消费”只由 `step.end{ok:true}.inputs_consumed` 决定，`inputs.jsonl` 只是投影。每次调用前做双向对账（reconcile），恢复不再读取 `HEAD` | §1 |
| B1-2 archive/end 窗口 | `call.archive` 增加 `outcome` 字段。把原 W1 拆成 W1a–W1d。只有 archive 和 end 都齐全，才允许下一次调用、discard 或 finalize | §2 |
| B1-3 终止证明 | 三态结果：`proven_dead` / `alive` / `unknown`。证明依次走三层：完整跟踪原语（Windows Job Object、Linux subreaper）→ 孤儿扫描 → 开机时间。按父进程递归枚举、心跳、指纹都不能作为证明 | §3 |
| B4-1 K 恢复 | merge 事务新增 `recording` 阶段，先把 K 的计划写入日志。补齐“K 已写入或已暂存、尚未提交”和“K 已提交、phase 未更新”两类窗口。被接受的 K 必须与本事务一一关联 | §4.1 |
| B4-2 缓存 | `T_content` 必须是纯函数（T-PURE）。`check-task -Sealed -NoLocalEvidence` 可以缓存；本机证据由新的动态检查 `T.local_evidence` 负责，从不缓存 | §4.2 |
| M4 旧 CLI drain | 新增来源 (f)：按进程枚举 agentline 入口，覆盖旧进程的整个生命周期。所有新 CLI 进程都要登记。无法读取命令行 → `unknown` | §5 |
| D3 | 轮次上限按纪元计算，记为 `L_e`。调度规则 1–3 统一使用 L。`G1.rounds_le_3` 改为 `G1.rounds_within_limit`；Build 侧新增 `T.rounds_within_limit` | §6 |
| Minor | 命令 ID 规则改为“规则 + 封闭别名表”；“创建 / 登记 / 放行”三段式；补充合并稿清理清单 | §7 |

### 0.2 替换章节清单（合并 v1–v5 时按此拼装）

| 合并基线中的位置 | 处理 | v5 来源 |
|---|---|---|
| v4 §1.2 中的 `rebindInputs` 条目 | **删除**，改为 `reconcileInputs` | §1.4 |
| v4 §1.3 事件表 | 增补字段：`call.archive.outcome`、`step.end.inputs_consumed`；新增事件 `call.archive_late`、`inputs.reconcile` | §1.3、§2.1 |
| v4 §1.3 窗口表中的 W1 行，以及 W2(c) 的“带 rebindInputs” | 替换为 W1a–W1d；W2(c) 改为“在 W5 边界执行 reconcile” | §2.3、§1.5 |
| v4 §1.4 的硬前置条件 | 替换 | §2.4 |
| v4 §1.5 中的“消费”和 `fresh` 定义 | 替换 | §1.6 |
| v4 §1.6（终止证明） | **整节替换** | §3 |
| v4 §1.9 中的 A1-7e、A1-7j | 替换；新增 A1-8 系列 | §1.7、§2.5、§3.6 |
| v4 §2.3 第 7 步，§2.4 中 `merged`、`recorded` 两行 | 替换；新增 `recording` 行 | §4.1 |
| v4 §2.2 中 `T_content` 的定义，§2.5 缓存条款中的“键已经覆盖全部输入” | 替换 | §4.2 |
| v4 §5.1 生命周期第 1 条，§5.2 来源表，A6-8 | 替换或增补 | §5、§7.2 |
| v3 §1.4 规则 1–3，v4 §6.2 第 1 条 | 替换 | §6.1 |
| v1 §7.x 的 `G1.rounds_le_3` 行；v1 §5 Blueprint 轮次耗尽规则 | 替换 | §6.2、§6.3 |
| v4 §7.1、§8 中的 `models.exception_add` / `models.exception_revoke` | 替换 | §7.1 |
| v4 §7.4 清理清单 | 增补 | §7.3 |

---

## 1. B1-1：输入账本与对账（不依赖 Git 中的原文）

### 1.1 事实与结论

- 按 v2 §7.1 的留存规则，`tasks/NNN/inputs.jsonl` 属于 B 级并被 gitignore。符合规则的任务里，`HEAD:<path>` 根本不存在这个文件。
- `markConsumed`（P6）发生在步骤提交（P7）之前。它的写法是“整读 → 改写 → rename”，可能吞掉同时追加的输入行。
- 因此，v4 的 `rebindInputs`（以 HEAD 为依据）和“amendment 随步骤提交一同被消费”两条均**作废**。用户原文不进入 Git，Q6 保持不变。

### 1.2 权威来源

| 对象 | 位置 | 级别 | 角色 |
|---|---|---|---|
| 输入账本 | `<B>/build/NNN/inputs.ledger.jsonl`，与 `ledger.jsonl` 位于同一个 B 根目录 | B（含原文，不进 git） | **输入内容的权威来源** |
| 步骤 ledger | `<B>/build/NNN/ledger.jsonl` | B | **消费状态的权威来源**（`step.end`） |
| `inputs.jsonl` | 任务 worktree | B（gitignore） | 内核读取的**投影**。runFlow 和 exec 照旧使用 |
| `manifest.json` 中的 inputs 段 | `.collab/build/NNN/` | A | 封存时写入 `{id, kind, content_sha256, consumed_by}`，不含原文 |

**定义**

- `content_sha256(entry) = sha256(canonical_json(entry 去掉 status 字段))`。它与状态无关，同一条输入在 pending 和 consumed 两种状态下摘要相同。
- `C_auth = ∪ { step.end.inputs_consumed[].id | step.end.ok == true }`，即权威的已消费集合。
- `K_auth`：输入账本中出现过的全部 id（`input.append`、`input.intent`、`input.adopt`）。
- `P_auth = K_auth − C_auth`，即权威的待处理集合。

### 1.3 写入规则与事件

**输入账本事件**（只追加，写完 fsync；短锁 `<B>/build/NNN/inputs.ledger.lock`）

| type | ikey | 字段 | 写入者 |
|---|---|---|---|
| `input.append` | `append:<id>` | 完整 entry（含原文）、`content_sha256` | 新版输入命令（`input` / `answer`） |
| `input.intent` | `intent:<meta.key>` | `{kind, text, meta.key = call_id}` | Supervisor：在把 note 交给 runStep **之前**写入 |
| `input.adopt` | `adopt:<id>` | 完整 entry、`source: file`、`status_at_adopt` | Supervisor：对账时发现文件中有、账本中没有的条目 |

**规则**

1. **新版输入命令**的顺序是：`appendInput` → 取短锁写 `input.append` → 释放 → **之后**才向用户报告成功。如果两步之间崩溃，用户看不到成功提示；文件中已有的条目会在下次对账时被 adopt。
2. **Supervisor 生成的 note**（keep 提示、`WRITE_SCOPE_NOTE`）：先写 `input.intent`，再调用 runStep。runStep 按 `meta.key` 去重，v4 §1.2 的规则保留。
3. **旧版 CLI 或手工写入的条目**由对账时 adopt。`build start` 时对当前文件做一次初始 adopt，文件中已经 consumed 的条目写成 `step.end` 之外的 `input.adopt{status_at_adopt: consumed}`，并计入初始的 `C_auth`。
4. **`step.end` 新增字段 `inputs_consumed: [{id, content_sha256}]`**：
   - `ok: true` 时 = 写 `step.end` 时文件中为 consumed、且 ∉ `C_auth` 的条目。其中账本没有的 id，先 adopt 再写 `step.end`。
   - `ok: false` 时**恒为空**。即使 executeRole 已经执行了 `markConsumed`（例如 review 返回 `invalid_output`、design 返回 `write_scope_missing`），该输入在权威上仍是 pending。
5. `call.start` 增加审计字段 `inputs_pre: {file_sha256, entries: [{id, kind, status, content_sha256}]}`。它**不参与**恢复判定。

### 1.4 不变量 I-IN 与 `reconcileInputs`（替换 v4 的 `rebindInputs`）

**I-IN（beforeCall 时检查）**

对每个 `id ∈ K_auth`，以下全部成立：
- 文件中存在该 id，且 `content_sha256` 一致；
- 文件中的状态 = (id ∈ `C_auth` ? consumed : pending)。

文件中不能有账本以外的 id。

不满足时返回 `G_INPUT_UNRECONCILED`（exit 97），不发起调用。正常路径上它不会出现；一旦出现，进入 `blocked(integrity)`。

**对账**

执行时机：在 W5 边界上执行 `next()` 之前；以及恢复流程把最后一个调用的 `step.end` 补齐之后。

| 文件现场 | 动作 |
|---|---|
| consumed 且 ∉ `C_auth` | `set_pending` |
| pending 且 ∈ `C_auth` | `set_consumed` |
| ∈ `K_auth`，但文件中缺这一行（被竞态吞掉或被删） | `restore`：用账本中的 entry 恢复，状态按 `C_auth` 决定 |
| 文件中有、账本中没有 | 先 `input.adopt`，再按上面几行判定 |
| 同一个 id，`content_sha256` 不同 | `E_INPUT_TAMPERED` → `blocked(integrity)`，**不写文件** |
| 输入账本缺失或无法解析（不含可截断的末行） | `E_INPUT_LEDGER_MISSING` → `blocked(integrity)` |

**执行方式**

- runStep 新增参数 `reconcileInputs: {expect_before_sha256, set_pending[], set_consumed[], restore[entry]}`，只能由 Supervisor 在对账时传入。它属于 K1 授权范围，修改发生在 `flow.mjs`，不改 `exec.mjs` 和 `inputs.mjs`。
- runStep 先校验当前文件的 sha256 等于 `expect_before_sha256`，否则返回 `{ok:false, reason:'input_race'}`，由 Supervisor 重新对账一次。
- 校验通过后用“tmp + rename”原子重写，并返回 `after_sha256`。
- Supervisor 写入 ledger 事件 `inputs.reconcile {before_sha256, after_sha256, set_pending, set_consumed, restored, adopted}`，ikey 为 `reconcile:<before>:<after>`。
- 对账本身幂等。重写过程中又被追加的行，在下一个边界由 `input.append` 恢复，所以竞态可以自愈。

### 1.5 对 v4 窗口表的影响

| 窗口 | v5 结果 |
|---|---|
| W2(a) | `finalize` → `step.end ok`，其 `inputs_consumed` 按 §1.3 第 4 条计算 → 对账没有差异 |
| W2(b) | `markConsumed` 没有执行，对账没有差异 |
| W2(c) | `step.end {ok:false, reason: E_WORKER_LOST_POSTCALL}`，`inputs_consumed = ∅` → 对账时对文件中已被 consumed 的条目执行 `set_pending` → 下一次调用的提示词中包含它们。**不再使用 `rebindInputs`** |
| W3 | 同 W2(a)：从当前文件计算 `inputs_consumed` |

### 1.6 amendment 绑定（替换 v4 §1.5 中的“消费”和 `fresh`）

- `fresh = { id ∈ P_auth | kind == amendment } − bound`，在**对账之后**求值。
- 消费的唯一依据是 `(e, design)` 的 `step.end{ok:true}.inputs_consumed`。“随步骤提交消费”的表述全部删除。
- v4 §1.5 中的其余结论（同一 id 至多出现在一条 `epoch.open` 中、重叠情形的处理）保持不变。

### 1.7 B1-1 验收

| # | 注入 | 期望 |
|---|---|---|
| A1-7e（替换） | 前置条件：`git cat-file -e HEAD:.collab/tasks/NNN/inputs.jsonl` 失败（文件不在 git 中）。纪元 2 的 design 绑定了 X；在 `markConsumed` 之后、`writeState` 之前杀死 worker | `step.end.reason = E_WORKER_LOST_POSTCALL`，`inputs_consumed = []`；`inputs.reconcile.set_pending = [X]`；a2 的提示词包含 X；a2 成功后，X 恰好出现在 1 条 `step.end.inputs_consumed` 中 |
| A1-8a | 在 design 的 `writeState` 之后、提交之前杀死 worker（W2a） | `finalize` 提交；`inputs_consumed = [X]`；没有 a2；没有 `set_pending` |
| A1-8b | review 的 executeRole 已经消费了 note N，随后 runStep 返回 `invalid_output` | `step.end ok:false`；对账时对 N 执行 `set_pending`；下一次尝试的提示词包含 N |
| A1-8c | 在 `markConsumed` 的“整读”与 rename 之间暂停（测试中的 fs 钩子），同时执行 `input` 追加 Y | Y 从文件中丢失，但 `input.append(Y)` 存在 → 下一个边界 `restored = [Y]`；下一次调用的提示词包含 Y |
| A1-8d | worker 处于 blocked 时删除 worktree 中的 `inputs.jsonl`，然后 resume | 文件从账本恢复；每条 `content_sha256` 一致；pending 与 consumed 的划分等于 `C_auth` |
| A1-8e | 手工修改一条已知 pending 输入的 text | `E_INPUT_TAMPERED`；没有新的 `call.start`；文件不被改写 |
| A1-8f | 删除 `inputs.ledger.jsonl` 后 resume | `E_INPUT_LEDGER_MISSING`；没有新的 `call.start` |
| A1-8g | 绕过对账直接发起调用（故障夹具），此时文件中某个 consumed 条目 ∉ `C_auth` | beforeCall 返回 `G_INPUT_UNRECONCILED`；adapter 调用计数不变 |

---

## 2. B1-2：archive / end 窗口与“先封存，再重试”

### 2.1 事件变更

- **`call.archive` 新增 `outcome` 字段**：
  - `by: afterCall` 时为 `{exit, error, resolved, usage, usage_source, post_fingerprint}`，取值是**身份校验改写之后**的最终结果（`G_IDENTITY_MISMATCH` 已经应用）；
  - `by: recovery` 时为 `null`。
- **afterCall 的固定顺序：**计算 outcome → `archiveCall` → 写 `call.archive{outcome}`（fsync）→ 写 `call.end`（复制 outcome，`from: afterCall`）→ 返回 executeRole。
- **推论 O1：**没有 `call.end`，就说明 P6（`appendRun`、`markConsumed`、`writeState`）还没有开始，因为 afterCall 返回之后才会执行 P6。
- **新增事件 `call.archive_late`**（ikey `late:<call_id>`）：`{log, checkpoint, fingerprint, reason: post_archive_change}`，用于记录归档之后的晚到写入。

### 2.2 `archiveCall` 的原子性

- 先写入暂存目录 `calls/<call_id>.tmp-<nonce>/`，完成后再 rename 为 `calls/<call_id>/`。
- 如果 `calls/<call_id>/` 已经存在，却没有对应的 `call.archive` 事件（上次在 rename 之后、写事件之前崩溃），就把旧目录改名为 `calls/<call_id>.orphan-<n>/` 保留，**不删除**，并在事件中记下 `orphans[]`。
- checkpoint ref 用 `update-ref` 写入；如果 ref 原来已有值，在事件中记下 `checkpoint.prior`。旧对象由 manifest 列出。

### 2.3 窗口表（替换 v4 的 W1 行）

前提：§3 的终止证明结果为 `proven_dead`，并且恢复者持有任务锁。

| 窗口 | ledger 现场 | 恢复结果 | 计费 |
|---|---|---|---|
| **W1a** | 有 `call.start`，没有 `call.archive` | 与 v4 W1 相同：`archiveCall(by: recovery, partial: true)` → `call.end{error: E_WORKER_LOST, by: recovery}` → 进入 W2 判定 | 占 1 次调用；`usage = null, usage_source = lost` |
| **W1b** | 有 `call.archive{by: afterCall}`，没有 `call.end` | ① 校验归档：目录中的文件哈希、checkpoint ref 与事件一致，否则转 W1d；② 当前指纹与 `outcome.post_fingerprint` 比较：**相等** → 写 `call.end = outcome`，附 `{by: recovery, from: archive}`；**不相等**（归档之后有晚到写入）→ 先 `archiveCall` 写 `call.archive_late`，再写 `call.end{error: E_WORKER_LOST, by: recovery, outcome_ref: archive, late_write: true}`；③ 进入 W2 判定。按 O1，结果**必然**是 W2(c)。如果判定得到 (a) 或 (b)，返回 `E_LEDGER_ORDER` → `blocked(integrity)` | 占 1 次调用；usage 取 `outcome.usage`，**不丢失** |
| **W1c** | 有 `call.archive{by: recovery}`，没有 `call.end`（上一次恢复在两条事件之间崩溃） | 校验归档 → `call.end{error: E_WORKER_LOST, by: recovery}` → W2。**不重新归档** | 同 W1a |
| **W1d** | 有 `call.archive`，但归档文件缺失或哈希不一致 | `E_EVIDENCE_CORRUPT` → `blocked(integrity)`；不发起调用，不 discard，不 finalize | — |

副作用判定（v3 §1.5）使用**当前**指纹与 `pre.fingerprint` 的比较。W1b 出现晚到写入时，工作区必然已脏 → `interrupted_choice`。

### 2.4 硬前置条件（替换 v4 §1.4 第 1 条）

- 对同一个 step_id，以下三类动作执行之前，**每个**已有的 call_id 都必须同时有 `call.archive` 和 `call.end`，并且归档校验通过：beforeCall（发起新调用）、`runStep(discard)`、`runStep(finalize)`。
- 不满足时返回 `G_EVIDENCE_PENDING`（exit 97）→ `blocked(integrity)`。
- 因此，被中断的调用一定先封存日志和部分产物，然后才允许重试、丢弃或补提交。

### 2.5 B1-2 验收

| # | 注入 | 期望 |
|---|---|---|
| A1-8h | dev 调用成功；在 `call.archive` fsync 之后、`call.end` 之前杀死 worker | `call.end.by = recovery`，`from = archive`；`usage` 等于 `outcome.usage`；W2 结果为 (c)；`run.json` 的记录数不变；调用计数为 1；对账之前没有 a2 的 `call.start` |
| A1-8i | 同 A1-8h，但在恢复之前由夹具修改工作区中的 1 个文件（模拟晚到写入，写入者已经死亡） | 有 1 条 `call.archive_late`，其 checkpoint 包含该文件；`call.end.late_write = true`；状态为 `interrupted_choice` |
| A1-8j | 在 `archiveCall` 的 rename 之后、写事件之前杀死 worker | 存在 `calls/<id>.orphan-1/`；新的 `call.archive.orphans` 列出它；两份内容都保留 |
| A1-8k | `call.archive` 之后、恢复之前修改归档日志的 1 个字节 | `E_EVIDENCE_CORRUPT`；没有 a2、discard 或 finalize |
| A1-8l | 恢复流程在 `call.archive(by: recovery)` 之后被杀，再次恢复 | 只有 1 条 `call.archive`、1 条 `call.end`；没有重复归档 |
| A1-7c（增补） | 夹具跳过 `call.end`，直接调用 `runStep(discard)` 或 `finalize` | 返回 `G_EVIDENCE_PENDING`；工作区和 HEAD 不变 |

---

## 3. B1-3：终止证明（整节替换 v4 §1.6）

### 3.1 原则

- 证明结果只有三种：`proven_dead`、`alive(list)`、`unknown`。**只有 `proven_dead` 才允许续跑。**
- **“扫描成功”不等于“后代集合完整”。**以下内容一律不能用作证明，只能在界面上展示：
  - 心跳里记录的后代；
  - 沿 `ParentProcessId` 从 worker 往下递归得到的进程；
  - 静止指纹；
  - WMI 或进程枚举成功返回。
- 被证明的对象 `target = {pid, proc_start}` 包括：build worker、merge job、CI job，以及任何以 detached 方式启动、可能写仓库的进程。

### 3.2 第一层：完整跟踪原语（procguard）

所有 detached 启动都必须经过 `spawnGuarded()`，并由一个独立的守护进程 `agentline-procguard` 承担跟踪。实现可以是小型原生 helper，也可以是 `pwsh -NoProfile` 加 P/Invoke。契约只规定行为，不规定实现。

**Windows（Job Object）**
1. 守护进程本身不在 job 内。它创建 job：设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，**不设** `BREAKAWAY_OK` 或 `SILENT_BREAKAWAY_OK`；job 句柄不可继承，只有守护进程持有。
2. 以 `CREATE_SUSPENDED` 创建 target → `AssignProcessToJobObject` → 写守护记录 `<C>/data/run/guards/<guard_id>.json {guard{pid,proc_start}, target{pid,proc_start}, kind, state: "armed"}` → 准入登记（§7.2）→ `ResumeThread`（放行）。
3. 守护进程等待 `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses == 0`，然后写 `state: "drained", total_processes, at`（fsync）并退出。
4. 守护进程提供一个命名管道，支持 `query`（返回 ActiveProcesses 和 `JobObjectBasicProcessIdList`）与 `terminate`（调用 `TerminateJobObject`）。

**Linux（subreaper）**
- 守护进程设置 `PR_SET_CHILD_SUBREAPER`，然后 fork 出 target。
- 所有脱离进程组的后代（包括 `setsid` 之后成为孤儿的进程）都会被重新挂到守护进程下。守护进程等到自己没有子进程、并且 target 已退出时，写 `drained`。
- terminate：沿守护进程的子树逐个发送 SIGKILL，直到没有子进程。

**第一层判定**

| 现场 | 结果 |
|---|---|
| 守护记录为 `drained` | `proven_dead` |
| 守护进程存活（pid 与 proc_start 一致），`query` 返回 0 | `proven_dead` |
| 守护进程存活，`query` 返回大于 0 | `alive(pids)` |
| 守护进程已死，记录不是 `drained`；或没有守护记录（旧任务） | 转入第二层 |
| 管道无法连接，但守护进程存活 | `unknown` |

### 3.3 第二层：孤儿扫描（在没有完整跟踪原语时使用，判定可靠，但偏保守）

**前提：**target 的 `(pid, proc_start)` 已经不存在。

1. 取全量进程快照 `(pid, ppid, create_time)`。来源：Windows 用 CIM 或 NtQuery，Linux 用 `/proc`，macOS 用 sysctl。快照失败 → `unknown`。
2. 对每个 `create_time ≥ target.proc_start` 的存活进程 Q，沿父链向上走，每一步要求父进程存活，并且 `parent.create_time ≤ child.create_time`（排除 pid 复用）：
   - 走到一个 `create_time < target.proc_start` 的进程：**不可能是 target 的后代**（target 的后代向上走必须经过 target，而 target 已死），排除 Q；
   - 链条断开：父进程已死、父 pid 被复用，或者 POSIX 下父进程为 1 或某个 reaper：Q 记为**无法归属的候选**；
   - 链上任一进程的 `create_time` 或 `ppid` 读不出 → `unknown`。
3. 没有候选 → `proven_dead`。有候选时：如果候选的 `(pid, proc_start)` 与心跳中记录的后代逐一相符，结果为 `alive(这些候选)`；其余情况为 `unknown(candidates)`。界面列出候选，供用户关闭后重试。

**可靠性依据：**任何存活的 target 后代，沿父链向上走，只有两种结局：碰到 target 本身而断开，或者断在某个已死的中间节点上。两种情况都会被记为候选。因此它不会漏判，只会多判（多判的代价是返回 `unknown`）。

### 3.4 第三层：开机时间

操作系统本次开机时间晚于 `target.proc_start`（也晚于守护进程的 `proc_start`，如果有）→ `proven_dead`。开机时间读取失败 → 本层不给结论。

### 3.5 未通过时的处理（替换 v4 中“未通过时”一段）

| 结果 | 动作 |
|---|---|
| `alive` 且来自第一层 | 通过守护进程执行 terminate，然后重新证明 |
| `alive` 且来自第二层（身份与心跳逐一相符） | 只终止这些身份已核对的进程，然后重新证明 |
| `unknown`，或重新证明仍然没有得到 `proven_dead` | `E_PROCESS_LINGERING{liveness: unknown\|alive, candidates}` → `blocked(integrity)`。**不自动重试**。用户可以关闭候选进程后执行 `recover sweep`，也可以重启电脑 |

**范围增补：**
- MainWrite 锁和任务锁的 stale 接管，同样需要对原持有者（含 git 子进程）得到 `proven_dead`。merge job 的 `git` 子进程如果还在运行，会在接管之后继续写入。
- §5 中准入记录的 stale 清除，也使用同一套证明。

### 3.6 B1-3 验收（替换 A1-7j，新增反例）

| # | 注入 | 期望 |
|---|---|---|
| A1-7j（替换） | 在受守护的 worker 上执行 `worker → cmd /c → model.exe`；在最后一次心跳之后启动 model.exe；然后杀死 worker 和 cmd，model.exe 继续写文件 | 第一层：`query = 1` → `alive` → terminate → 0 → `proven_dead`；此后才进入 W1a；model.exe 在 checkpoint 之后没有任何写入 |
| A1-8m | 同上，但运行在没有守护的旧任务上 | 第二层：model.exe 的父进程 cmd 已死 → 候选 → `unknown` → `E_PROCESS_LINGERING`；没有新的 `call.start`。用户结束 model.exe 后执行 `recover sweep`，得到 `proven_dead` |
| A1-8n | 同 A1-8m，并让 cmd 的 pid 被一个更晚创建的无关进程复用 | 父进程的 create_time 晚于子进程 → 视为断链 → 候选 → `unknown` |
| A1-8o | 守护进程和 worker 一起被杀（触发 `KILL_ON_JOB_CLOSE`），且守护记录不是 drained | 转第二层；model.exe 已被操作系统终止 → 没有候选 → `proven_dead` |
| A1-8p | 进程快照注入失败，或某个窗口内进程的 create_time 不可读 | `unknown`，不是 pass |
| A1-8q | 构造 `unknown` 现场后重启电脑，再执行 resume | 第三层 → `proven_dead` → 进入 W1a |
| A1-8r | Linux：adapter 子进程 `setsid` 之后父进程退出 | 孤儿被重新挂到守护进程下 → `alive` → 终止 → `proven_dead` |
| A1-8s | adapter 尝试以 `CREATE_BREAKAWAY_FROM_JOB` 启动进程 | 创建失败；在 probe 阶段即可暴露（probe 也在守护下运行），并归类为 `config` 错误 |
| A1-8t | merge job 被杀，但 `git commit` 子进程被钩子阻塞仍然存活；再执行 `build merge` | 锁的 stale 接管得到 `alive` → 终止 → 重新证明；没有两个写者同时写 main |

---

## 4. B4：K 的恢复窗口与缓存边界

### 4.1 K 的写入与恢复（替换 v4 §2.3 第 7 步，以及 §2.4 的对应行）

**第 7 步拆分**

| # | 动作 |
|---|---|
| 7a | 由日志内容**确定性地**生成 `merged.json` 和 `state.json`。所有时间戳取 M 的 committer date，不读当前时间。预先计算 `blob_after`。写日志 `phase: recording`，同时写入 `k_paths[{path, mode, blob_before, blob_after}]` |
| 7b | 写这两个文件 → `git commit --only <2 个路径>`，提交信息带 `Agentline-Txn: <id>` |
| 7c | 校验 K：`K^1 == merge_commit`；trailer 等于 id；`diff-tree K` 的路径集合与模式等于 `k_paths`，每个 blob 等于 `blob_after` → 写 `phase: recorded, record_commit: K` |

**关联条件 R-TXN：**恢复时只接受满足以下全部条件的 K'：`K'^1 == log.merge_commit`；trailer 等于 `log.id`；`diff-tree K'` 与 `log.k_paths` 的路径、模式、`blob_after` 完全一致；`merged.json.txn_id == log.id`。**外观像 K 不能作为依据。**

**恢复表（替换 v4 §2.4 中 `merged`、`recorded` 两行，并新增 `recording` 行）**

| 日志 phase | 现场 | 动作 |
|---|---|---|
| `merged` | HEAD == M | 从 7a 开始。这一阶段还没有写过 K 文件，所以 K 路径按 v4 §4.2 的**正常规则**检查。如果不满足（工作区里出现了外来文件），返回 `E_PATH_CONFLICT`：日志保持 merged，main 不变，用户处理后重新执行 |
| `merged` | HEAD 是带本事务 trailer 的 K' | 顺序上不可能出现 → `E_TXN_DIVERGED` |
| `recording` | HEAD == M | 对每个 k_path 检查：工作区内容 ∈ {`blob_before`（create 模式下为“不存在”）、`blob_after`}，index 条目 ∈ {HEAD 中的条目、`blob_after`}。全部满足 → 重写为 `blob_after` → 执行 7b、7c。任一不满足 → `E_TXN_DIVERGED`，列出路径，**不覆盖** |
| `recording` | HEAD == K'，且满足 R-TXN | 写 `phase: recorded, record_commit: K'` → 第 8 步。**不会产生第二个 K** |
| `recording` | HEAD == K'，但不满足 R-TXN；或 HEAD 是其他提交 | `E_TXN_DIVERGED` |
| `recorded` | HEAD == K，且满足 R-TXN（重新校验） | 第 8 步 |
| 任意 phase | 存在 `.git/index.lock` | `E_MAIN_INDEX_LOCKED`。**不自动删除**，由用户确认没有 git 进程后手工处理 |

接管 merge 事务之前，原 merge job 必须按 §3 得到 `proven_dead`。

### 4.2 `T_content` 的纯度与本机证据（替换 v4 §2.2 中 `T_content` 的定义，以及 §2.5 的相应声明）

**T-PURE：**`T_content(S)` 只能读取以下内容：
- S 可达的 git 对象；
- 键中已经包含的策略输入：check 表、隔离规则版本、身份例外条目、`evaluator_version`。

任何读取 S 以外文件的检查都不属于 `T_content`。

| 部分 | 内容 | 缓存 |
|---|---|---|
| `T.check_task`（属于 `T_content`） | 在 S 的 detached worktree 中运行 `check-task.ps1 -Sealed -NoLocalEvidence`。C6 只校验“每个 log_ref 和交班单都出现在 manifest 中”，本机哈希部分输出 `[INFO] local_deferred` | 可以缓存 |
| **`T.local_evidence`（新增，不可豁免）** | 对 manifest 中**每一个**有本机副本可能的条目（日志、交班单、输入账本条目、probe 记录）查找本机位置：任务 worktree（如存在）、B 级归档 `calls/<call_id>/…`、C 级 probe 文件。找到 → sha256 必须一致，否则 FAIL（`hash mismatch`）；读取出错 → `error`（不算 pass）；都不存在 → `[INFO] not_local` | **从不缓存** |
| `T_pre(S)` | `T_content` ∧ `T.local_evidence` ∧ `T.reachable_pre` ∧ `T.origin_current` | 只有 `T_content` 部分可以命中缓存 |
| `T_final(S)` | `T_content` ∧ `T.local_evidence` ∧ `T.reachable_final` ∧ `T.origin_at_merge` | 同上 |

- `-NoLocalEvidence` 是新增开关，只能与 `-Sealed` 一起使用。不带它时，`-Sealed` 保持 v2 行为，用于手工检查和 A4-4。
- **语义等价要求：**同一夹具上，`-Sealed` 的结果必须等于 `T.check_task` ∧ `T.local_evidence`。
- 缓存键保持 `H(S, content_hash, evaluator_version, policy_digest)`，其中 `evaluator_version` 包含 `check-task.ps1` 的 sha256 和 `NoLocalEvidence` 模式标记。v4 中“键已经覆盖全部输入”的声明改为：“**键覆盖了 `T_content` 的全部输入**；本机状态由 `T.local_evidence` 每次重新求值”。
- **会使 gate 失效的本机变化：**做决策的位置（merge 的锁内检查、`depends_on`、G2、`build start` 的准入）每次都会重新求 `T.local_evidence`。UI 中的 T 状态显示 `local_evidence.evaluated_at`；界面缓存不参与任何决策。
- **成本：**每次求值都做全量 sha256，量级为本任务所有日志的总字节数。gate eval 的 T 本来就以 job 方式运行，不受 Host 同步超时限制。

### 4.3 B4 验收

| # | 注入 | 期望 |
|---|---|---|
| A4-10g | 写完 `phase: recording` 之后、写任何文件之前被杀 | 恢复后写入文件并提交；main 上只有 1 个 M、1 个 K |
| A4-10h | 只写了 `merged.json`、还没写 `state.json` 时被杀 | 恢复补齐；K 中两个 blob 都等于计划值 |
| A4-10i | 已暂存（index 为 `blob_after`）、尚未提交时被杀 | 完成 K；结束后 index == HEAD |
| A4-10j | K 已提交、写 `phase: recorded` 之前被杀 | 不产生第二个 K；`record_commit = K`；进入 verified |
| A4-10k | 在 recording 阶段崩溃，之后用户在工作区修改了 `merged.json` | `E_TXN_DIVERGED`；用户的修改保留；没有 K |
| A4-10l | K 已提交、phase 未更新时，用户 amend 了 K（trailer 保留，blob 改变） | 不满足 R-TXN → `E_TXN_DIVERGED` |
| A4-10m | HEAD 上的 K' 带的是另一个事务的 trailer | `E_TXN_DIVERGED` |
| A4-10n | phase 为 merged 时崩溃，工作区中出现外来的未跟踪 `merged.json` | `E_PATH_CONFLICT`；该文件不变；日志仍为 merged |
| A4-19 | `T_content` 已缓存为 pass；之后修改 B 级归档日志的 1 个字节 | 缓存**命中**（需断言）；`T.local_evidence` 为 FAIL；`T_final` 为 fail；依赖它的任务启动返回 `E_DEPENDENCY_NOT_MET`；如在合并前，锁内检查返回 `E_GATE_NOT_PASSED` |
| A4-20 | 把该字节改回原值 | 不需要清缓存，直接重新得到 pass |
| A4-21 | 删除本机日志（不是篡改） | `not_local`，结果为 pass（与 v2 C6、新 clone 的语义一致） |
| A4-22 | 日志无读权限 | `T.local_evidence = error`，gate 不为 pass |
| A4-23 | 纯度测试：用只允许读取 S 对象库和策略输入的读取器执行 `T_content`；夹具中某个 check 读取了 `<B>` | 测试失败 |
| A4-4（保留） | 手工执行 `check-task -Sealed`（不带 `-NoLocalEvidence`），归档被篡改 1 个字节 | C6 FAIL |

---

## 5. M4：旧 CLI 的全生命周期 drain（替换 v4 §5.1 中的旧 CLI 条目和 §5.2 来源表）

### 5.1 新增来源 (f)：入口进程枚举

- **新 CLI 进程登记：**所有新版 CLI 进程（包括 R 类命令）在分发层的第一步写 `<C>/data/run/procs/<pid>-<proc_start>.json {version, cmd, starts_work, adm_id?}`，退出时删除。`starts_work` 命令紧接着执行 `admit`。
- **枚举：**对全量进程快照逐一检查，命令行参数中任一路径的 basename ∈ `ENTRYPOINTS`，即视为 agentline 入口进程。`ENTRYPOINTS` 是代码常量，含 `agentline.mjs` 和各平台 shim 的目标文件名，并配有测试。
- **分类：**

| 匹配到的进程 | 计入 |
|---|---|
| 有 procs 记录（pid 与 proc_start 一致），且 `starts_work = false` | **不计入**（只读命令；也包括 `drain status` 自身及其祖先） |
| 有 procs 记录，且 `starts_work = true` | 计入（与 (a) 去重） |
| **没有 procs 记录** | 计入，标记为 `legacy_or_starting`。这覆盖旧 `cmdRun` 和 `cmdFlow` 生命周期的**任意时刻**（首次调用前、候选切换的间隙、`clearLive` 之后），也覆盖新进程登记之前的启动瞬间 |

- **`unknown` 条件：**
  - 快照失败；
  - 任一镜像名属于 `HOST_IMAGES`（`node`、`bun`）的进程，其命令行不可读（例如提权进程、其他账户的进程）。
  
  界面列出这些 pid，并提示：“以管理员身份重新执行 `drain status`，或结束这些进程”。**不按 0 处理。**
- **(d) `live.json` 的定位：**只作为明细展示。v4 中“能覆盖旧 `cmdRun`，与版本无关”的说法删除。**没有 live 文件不代表没有旧执行者。**
- **汇总：**`drain status = (a) ∪ (b) ∪ (c) ∪ (e) ∪ (f)`，按 `(pid, proc_start)` 去重。任一来源为 `unknown`，整体就是 `unknown`。
- **回滚步骤：**回滚脚本的第一步和切换前的最后一步各执行一次 `drain status`，两次都必须为 `0`，并且 drain 标志在两次之间一直处于设置状态。

### 5.2 M4 验收（增补 A6）

| # | 注入 | 期望 |
|---|---|---|
| A6-9 | 旧 `cmdRun` 有两个候选，第一个失败；在 `clearLive` 之后、下一候选 `writeLive` 之前暂停（阻塞交班单 checkpoint 的 git） | 结果 ≥ 1，来源 (f) `legacy_or_starting` |
| A6-10 | 旧 `cmdRun` 处于首次调用之前（暂停在模型解析或健康检查） | ≥ 1 |
| A6-11 | 旧 `cmdRun` 在最后一次 `clearLive` 之后，正在执行 `appendRun` / `writeState` | ≥ 1 |
| A6-12 | 新版 `agentline status` 与 `drain status` 并发 | 两者都不计入 |
| A6-13 | 存在一个命令行不可读的提权 `node` 进程 | `unknown` |
| A6-14 | 进程快照接口注入失败 | `unknown` |
| A6-15 | A6-9 中的旧进程退出 | `0` |
| A6-6（修订） | 使用升级前的核心执行 `agentline run`，覆盖全程 | 任意采样时刻都 ≥ 1。(d) 只在 adapter 运行期间出现，(f) 覆盖全程 |

---

## 6. D3：把轮次上限 L 贯通到调度和 gate

### 6.1 Build 调度（替换 v3 §1.4 规则 1–3，以及 v4 §6.2 第 1 条）

- **按纪元计算上限：**`L_e = 3 + count(user_action: extend_round 且 epoch == e)`。纪元切换时 k 从 0 重新计数，所以上限也必须按纪元计算。追加的轮次不带入下一个纪元。

**规则**
1. `round.close(fail)` 且 `k = L_e` → `awaiting_user(round_limit)`。
2. `round.close(fail)` 且 `k < L_e` → 下一步为 `(e, dev, k+1)`。
3. 第 k 轮（k ≤ L_e）处于开放状态，且 `(e, ci, k)` 通过 → 执行 `(e, review, k)`。

**补充约定**
- **追加后的走向：**在 `round_limit` 时写入 `extend_round`，L_e 加 1，然后由规则 2 得到 `(e, dev, L_e_old + 1)`。不需要其他特殊规则。
- **不变量：**不存在 `k > L_e` 的 `(e, dev, k)` 的 `step.begin`。A1-1 改为：“没有 `(e, dev, L_e + 1)` 的 `step.begin`”。
- **`extend_round` 的字段：**在 v4 的基础上增加 `epoch`、`from_limit`、`to_limit = from_limit + 1`。只有在“最后一条 `round.close` 为 fail 且 `k == from_limit`，并且当前是 `awaiting.kind = round_limit`”时才有效，否则返回 `E_DECIDE_INVALID`。
- **界面：**显示“第 e 纪元 · 轮次 k/L_e（已追加 n）”。

### 6.2 Blueprint 调度（替换 v1 §5 中的轮次耗尽规则）

- `L_bp = 3 + count(decisions.json.deviations[kind = extend_round])`。
- 第 r 轮评审结果为 revise，或仍有 testability blocker 时：
  - `r < L_bp` → `awaiting_user(continue_round)`（v1 T8 保持不变）；
  - `r = L_bp` → `awaiting_user(round_limit)`。
- `blueprint decide --ruling extend_one --text` 的执行方式改为 **job**：L_bp 加 1，并直接运行第 L_bp 轮（一轮）。这与 `task.new --start` 在执行方式上的先例一致。
- v1 中 `round_limit` 的默认值 `new_session_with_ruling`、“Blueprint 3 轮是协议常量”等表述，改为“基础上限 3，可以逐次显式追加”。

### 6.3 gate

| check | 判定 | 可豁免 |
|---|---|---|
| **`G1.rounds_within_limit`**（替换 `G1.rounds_le_3`） | `rounds ≤ L_bp`，且每条 extend 记录都有效：① `kind = extend_round`；② 通道为人类通道（cli、ui、slash，按 D4），有原话和 `text_sha256`；③ `from_limit` 依次为 3、4、5…；④ 对应轮次 r = from_limit 存在 revise 结论（或 testability blocker）的证据文件。证据：`decisions.json`、`review-rN.verdict.json` | 否 |
| **`T.rounds_within_limit`**（新增，属于 `T_content`，是 S 的纯函数） | 在 S 的 `ledger.json` 中，每个纪元的最大 k ≤ L_e；每条 `extend_round` 都满足 §6.1 的有效性条件，并且与 `decisions.json.deviations` 一一对应 | 否 |

### 6.4 D3 验收

| # | 场景 | 期望 |
|---|---|---|
| A3-1 | Build：三轮都是 revise → 执行 `extend_one` | 出现 `(e, dev, 4)` 的 `step.begin`；ci 通过、review 4 为 pass → `pr_open` → 封存；`T.rounds_within_limit` 为 pass；deviations 中有 1 条 |
| A3-2 | L=4，第 4 轮仍为 fail | 规则 1 命中 → `round_limit`，没有卡死；没有 `(e, dev, 5)` |
| A3-3 | 连续追加两次 | 第 5 轮可以执行；`from_limit` 依次为 3、4 |
| A3-4 | 不在 `round_limit` 状态时执行 `extend_one` | `E_DECIDE_INVALID`；L 不变 |
| A3-5 | 在 e1 追加之后进入纪元 e2 | `L_e2 = 3` |
| A3-6 | Blueprint：三轮 revise → `extend_one` → 第 4 轮 pass | `G1.rounds_within_limit` 为 pass，显示“4/4（追加 1）”；G1 整体可以通过 |
| A3-7 | 手工伪造第 4 轮的 verdict，但没有 extend 记录 | `G1.rounds_within_limit` fail，不可豁免 |
| A3-8 | extend 记录没有原话，或通道不是人类通道 | fail |
| A3-9 | 手工改写 S 中的 ledger，加入第 4 轮但没有对应的 deviation | `T.rounds_within_limit` fail |

---

## 7. Minor

### 7.1 命令 ID（替换 v4 §7.1）

- **规则 R1：**`id` = CLI 路径段用 `.` 连接，`-` 替换为 `_`。
- **规则 R2：**参数不产生新的 id。**唯一例外**是下面这张封闭别名表，用于参数改变了 R/W 或 H 类型、或者 CLI 无法按层级表达的情况。

| command id | CLI | 理由 |
|---|---|---|
| `blueprint.materialize_plan` | `blueprint materialize --dry-run` | R 和 W 不同 |
| `gate.approve` / `gate.revoke` / `gate.waive` | `approve` / `approve --revoke` / `waive` | 沿用 v1 的 CLI |
| `ops.drain` / `ops.undrain` / `ops.drain_status` | `drain` / `undrain` / `drain status` | 运维命令归入 `ops` 组 |

- **按 R1 修正：**
  - `models.exception_add` → **`models.exception.add`**；`models.exception_revoke` → **`models.exception.revoke`**；
  - `recover.sweep` 对应的 CLI 统一为 `recover sweep --repo`，删除 v2 的 `recover --repo`；
  - `build.resume`（`--keep` / `--discard`）保持 v4 的写法。
- **静态测试：**命令表的每一行要么满足 R1，要么出现在别名表中；Host 白名单的键集合等于命令表的 id 集合。

### 7.2 准入、进程创建与放行的次序（替换 v4 §5.1 生命周期第 1 条和 A6-8）

- **三段式：**创建 → 登记 → 放行。pid 和 `proc_start` 只有在进程创建之后才能拿到，所以**创建可以早于登记，但放行必须晚于登记**。放行之前，子进程不得读写仓库，也不得发起网络或模型调用。
- **detached 启动**（worker、merge job、CI job）一律通过 `spawnGuarded()`：
  - Windows：`CREATE_SUSPENDED` → 加入 job → 在准入记录中写入 `children[]{pid, proc_start, guard_id}` → `ResumeThread`；
  - POSIX：守护进程 fork 之后，子进程阻塞在管道上等待 `go`；登记完成后，守护进程才写入 `go`。
- **受守护进程内部派生的子进程**（adapter、git、CI runner）由 job 或 subreaper 覆盖，不需要单独写 `children[]`。
- **drain 来源 (a) 的计入条件：**holder 存活，或任一 child 存活，或守护进程报告 `active > 0`。守护进程已死且记录不是 `drained` 时，计为 `unknown`。
- **A6-8（替换）：**
  - 静态测试：所有 detached 启动都经过 `spawnGuarded()`，代码中没有裸 `spawn(..., {detached: true})`。
  - 动态测试：在“创建”与“放行”之间插入暂停钩子，此时准入记录中已有 child；子进程没有写任何文件，也没有日志。

### 7.3 合并稿清理清单（增补 v4 §7.4，审核时逐项 grep）

- `HEAD:<path>`、`rebindInputs`、`inputs_pending` 作为恢复依据的表述，以及“随步骤提交消费”“随 inputs.jsonl 一同被标记为 consumed”；
- `ParentProcessId` 递归作为证明的表述、“孤儿进程会保留 ParentProcessId，所以这项扫描可以覆盖”、“扫描本身成功”、“10 秒静止指纹”；
- “能覆盖旧 `cmdRun` 和 `runFlow`，与版本无关”；
- “键已经覆盖全部输入，不需要额外的失效逻辑”；
- `G1.rounds_le_3`、`k < 3`、`k = 3`（Build 和 Blueprint 的调度规则中）、“轮次 ≤ 3”、“Blueprint 3 轮（协议常量）”、`new_session_with_ruling`、`hard_limit`；
- `models.exception_add`、`models.exception_revoke`、`recover --repo`；
- **D1 的统一表述：**“D1：decisions.md 的 **A ＝ 授权 K1**”。删除 v2/v3 中 ⚑D1 选项的旧字母映射，以及任何“D1=B”“D1 选项 C”之类的残留；
- v4 §2.4 中 `merged` 行的“继续第 7、8 步”（已由 §4.1 替换）。

---

## 8. 命令、错误码、gate、事件的增量（相对 v4 §8）

| 类别 | 变更 |
|---|---|
| 命令 | `models.exception.add` / `.revoke`（改名）；`blueprint.decide --ruling extend_one` 改为 job；`recover.sweep` 的 CLI 统一 |
| 新增错误码 | `G_INPUT_UNRECONCILED`、`E_INPUT_TAMPERED`、`E_INPUT_LEDGER_MISSING`、`E_EVIDENCE_CORRUPT`、`E_LEDGER_ORDER`、`E_MAIN_INDEX_LOCKED`、`E_DECIDE_INVALID` |
| 含义变更 | `E_PROCESS_LINGERING` 增加 `{liveness: alive\|unknown, candidates}` |
| gate | 新增 `T.local_evidence`（动态，不可豁免）；新增 `T.rounds_within_limit`（属于 `T_content`）；`G1.rounds_le_3` → `G1.rounds_within_limit` |
| 事件 | 输入账本事件 `input.append`、`input.intent`、`input.adopt`；ledger 事件 `inputs.reconcile`、`call.archive_late`；`call.archive.outcome`；`step.end.inputs_consumed`；merge 日志新增 phase `recording` |
| 工具 | `check-task.ps1 -Sealed -NoLocalEvidence`（新开关；不带它时行为不变） |

## 9. 实现切分的调整（相对 v4 §9）

| 工作流 | 变更 |
|---|---|
| **W7p（新增）** | `proc-identity.mjs` + `agentline-procguard`（Windows Job、Linux subreaper）、三层终止证明、`spawnGuarded()`。W7a、W15、W16 都依赖它 |
| W7a | 输入账本与对账（`reconcileInputs`）、`call.archive.outcome`、W1a–W1d、§2.4 前置条件；删除 `rebindInputs` |
| W15 | merge 的 `recording` 阶段与 R-TXN、`T.local_evidence`、`-NoLocalEvidence`、T-PURE 纯度测试 |
| W16 | 来源 (f)、procs 登记、drain 三态的新定义、回滚步骤中的两次 drain 检查 |
| W18 | 按纪元计算的 L_e、Blueprint 的 L_bp、两个 rounds_within_limit 检查、`E_DECIDE_INVALID` |

---

## 10. 用户裁决与知会

### 10.1 新的用户裁决

**无。**本文件的变更都是对已确认承诺（Q5、Q6、D1–D4、v4 的恢复与兼容范围）的正确性收口。没有缩小任何已经承诺的恢复范围或兼容范围：macOS 和没有守护进程的旧任务，在 §3.3 下仍然可以得到可靠的判定，代价是更容易出现 `unknown`。

### 10.2 知会项（不需要裁决）

- **N9：**`agentline-procguard` 是新的随包组件，可以是原生 helper，也可以是 `pwsh` 加 P/Invoke。必须脱离 Job Object 才能运行的 adapter 会在 probe 阶段失败，并归类为 `config` 错误。
- **N10：**没有守护进程时（旧任务、macOS），孤儿扫描偏保守。用户启动的无关程序可能被列为候选，导致 `unknown`；处理办法是关闭列出的进程，或者重启电脑。
- **N11：**B 级输入账本与 `ledger.jsonl` 位于同一个 B 根目录。B 目录丢失时，任务无法续跑（失败关闭），这与 v4 中 ledger 丢失的结果一致。
- **N12：**本机日志被删除时报 `not_local`，T 仍然 pass（沿用 v2 C6 和新 clone 的语义）；被篡改时 FAIL。
- **N13：**如果存在命令行不可读的 `node` 进程，`drain status` 会持续返回 `unknown`，需要以管理员身份执行或结束这些进程。

### 10.3 流程

本文件连同 v1–v4，提交 **GPT-6 Astra 做最终契约复核**，复核时按下面 §11 的清单逐项检查。

- 结论为 **APPROVE**：按 v4 §0.2 和本文 §0.2 拼装合并稿，执行 v4 §7.4 与本文 §7.3 的 grep 清理，然后**进入实现切分**（v3 §9.2 + v4 §9 + 本文 §9）。
- 结论为 **REVISE**：不再开新一轮设计。把未关闭项逐条交给用户，由用户选择“局部修补”或“缩小范围”。

---

## 11. 复核检查清单（增补 v4 §11）

| # | 检查项 | 依据 |
|---|---|---|
| 16 | 输入恢复不读取 HEAD 或任何 Git 原文；消费的唯一依据是 `step.end{ok:true}.inputs_consumed`；对账覆盖 set_pending、set_consumed、restore、adopt、tamper 五种情形 | §1、A1-7e、A1-8a–g |
| 17 | “archive 已落盘、end 未落盘”有唯一结果，usage 不丢失；发起调用、discard、finalize 之前都要求 archive 和 end 同时存在 | §2、A1-8h–l |
| 18 | 终止证明中，“扫描成功”和父进程递归都不构成证明；review-v4 的反例在第一层和第二层分别得到 `alive` 和 `unknown`；`unknown` 不允许续跑 | §3、A1-7j、A1-8m–t |
| 19 | K 写入的每个边界（未写、部分写入、已暂存、已提交但 phase 未更新）都有确定结果；被接受的 K 满足 R-TXN | §4.1、A4-10g–n |
| 20 | `T_content` 满足 T-PURE；本机证据每次重新求值；缓存命中时篡改仍然导致 FAIL | §4.2、A4-19–23 |
| 21 | drain 覆盖旧 CLI 的全生命周期；命令行不可读时为 `unknown` | §5、A6-9–15 |
| 22 | 调度规则 1–3 和两个 gate 都使用 L；显式追加的第 4 轮可以合法通过 G1 和 T | §6、A3-1–9 |
| 23 | 命令 ID 满足 R1 或出现在别名表中；放行晚于登记；清理清单可以用 grep 验证 | §7 |
