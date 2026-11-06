# AgentLine Blueprint 20261106：设计 v6 契约修补（design-v6-contract）

- 状态：**局部契约修补**。本轮只处理 review-v5 中剩下的 B1-1、B1-2、B1-3、M4 和 Minor。不重开架构，不改 Q1–Q6，也不再询问 D1–D4（D1 统一表述为 decisions.md 的 **A＝授权 K1**）。
- 日期：2026-11-06
- 主设计：Claude Opus 5.5；最终契约复核：GPT-6 Astra
- 基线：v1 + v2-delta + v3-delta + v4-contract + v5-contract。本文件只写**替换或新增**的章节，未提到的内容保持 v5 合并后的原样。
- 已静态核对的源码事实（在 v5 §头部列出的基础上补充）：
  - `inputs.mjs:20-34`：`appendInput` 在函数内部生成随机 id（`in-<base36 时间>-<6 位 hex>`），然后执行 `appendFileSync`。这个函数不取锁，也不接受调用方传入 id。
  - `inputs.mjs:53-65`：`markConsumed` 依次执行“整读、写 tmp、rename”，同样不取锁。
  - `exec.mjs:130`：pending 在候选循环内读取，读取时间**早于** `adapter.run`（`exec.mjs:148`，CallGuard 的 beforeCall 就在这里执行）。`exec.mjs:199` 的 `markConsumed` 只标记这一次读到的 id。
  - `exec.mjs:29-39`：`live.json` 中有 `pid`、`at`、`started_at`，**没有 `proc_start`**。`clearLive`（`exec.mjs:155`）只在 adapter 返回之后执行。
  - `flow.mjs:304`：runFlow 通过 `appendInput` 注入 `WRITE_SCOPE_NOTE`，id 随机。runFlow 本身不改。
  - `agentline.mjs:186-213`：`cmdInput` 和 `cmdAnswer` 直接调用 `appendInput`，不取锁，不写账本。`agentline.mjs:304-316`：`cmdRun` 不取锁，也不登记。
  - `lock.mjs:15-18`：`alive()` 只检查 pid。
- 本轮不写产品代码，不修改仓库。

---

## 0. 关闭对照与替换清单

### 0.1 review-v5 问题 → 本文件章节

| 问题 | v6 处理 | 章节 |
|---|---|---|
| B1-1 系统 note 身份 | 删除 `input.intent`。系统 note 由 Supervisor 生成**确定性 id 和完整 entry**，在 P2 之前写入 `input.append{by: system}`；runStep 按 id 去重后追加，不再调用会生成随机 id 的 `appendInput`。W0 的四种现场各有唯一结果 | §1.2、§1.3 |
| B1-1 旧 CLI 与 rename 竞争 | 引入**输入锁**。当前核心中所有会写入 `inputs.jsonl` 的路径（新版 `input`/`answer`、P2、对账、P6 窗口）都在锁内执行；beforeCall 在锁内 adopt 账本中没有的 pending 条目。append-only 状态事件需要修改 `inputs.mjs`，超出 K1 授权，因此只列为备选。不取锁的外部写入者作为**范围决定 S1** 交用户裁决 | §1.4、§1.5、§8.1 |
| B1-2 晚到归档 | 主归档与晚到归档使用**各自的、只写一次的目录和 ref**（`calls/<id>/`、`calls-late/<id>/`；`refs/agentline/calls/<id>`、`refs/agentline/late/<id>`）。新增 W1b-L 窗口，并给出“late 已写、end 未写”的唯一恢复结果 | §2 |
| B1-3 POSIX 终止证明 | POSIX 第二层不再允许“遇到更早创建的祖先就排除”。改为依据**生成时记录的祖先链**：凡是父进程属于“可能接管孤儿的进程”（祖先链或 init）、且创建时间晚于 target 的进程，都列为候选。没有祖先链 → `unknown`。Windows 不存在重新挂接，保留 v5 的上行判定 | §3 |
| M4 入口退出后的遗留后代 | 执行者记录在入口退出后**保留**，直到 §3 证明结果为 `proven_dead` 才删除；新增来源 (g) 旧入口观测记录、(h) 旧运行残留证据、(i) 升级屏障。A6-15 拆成 5 个分支 | §4 |
| Minor | `C_auth` 公式补上初始 adopt；D3 用例改号为 A3L；合并稿清理清单补齐 recording、命令 ID、错误码和 D1 字母 | §5 |

### 0.2 替换章节清单（合并 v1–v6 时按此拼装）

| 合并基线中的位置 | 处理 | v6 来源 |
|---|---|---|
| v5 §1.2 中 `C_auth`、`K_auth` 的定义 | 替换 | §1.1 |
| v5 §1.3 事件表中的 `input.intent` 行；规则 1、2、3 | **删除** `input.intent`；规则 1–3 替换 | §1.2、§1.4 |
| v4 §1.1 P1–P2 两行 | 在 P1、P2 之间插入 P1b；P2 的说明替换 | §1.3 |
| v4 §1.2 中“前置处理幂等：用 `meta.key = call_id` 去重” | 替换为按确定性 id 去重 | §1.2 |
| v5 §1.4 中的 I-IN、“执行方式”最后一条（“通过 input.append 自愈”） | 替换 | §1.5 |
| v5 §1.7 的 A1-8c | 替换；新增 A1-9 系列 | §1.7 |
| v5 §2.1 中 `call.archive_late` 的字段；§2.2；§2.3 中的 W1b 行；§2.4 中“归档校验通过”的定义 | 替换；新增 W1b-L、W1e 两行 | §2 |
| v5 §2.5 的 A1-8i | 替换；新增 A1-10 系列 | §2.6 |
| v5 §3.2 中“第一层判定”的第 4 行；§3.3 整节 | §3.3 拆成 3.3W（Windows，保留原规则）和 3.3P（POSIX，新规则） | §3 |
| v5 §3.6 的 A1-8r | 增补；新增 A1-11 系列 | §3.6 |
| v4 §5.1“进程退出时删除自己的记录”；v5 §5.1 中“退出时删除”；v5 §5.1 汇总公式；v5 §5.2 的 A6-15、A6-6 | 替换 | §4 |
| v5 §6.4 的 A3-1 至 A3-9 | 改号为 A3L-1 至 A3L-9 | §5.2 |
| v5 §7.3 清理清单 | 增补 | §5.3 |

---

## 1. B1-1：输入账本——系统 note 的身份绑定与写入互斥

### 1.1 定义（替换 v5 §1.2 中 `C_auth`、`K_auth` 的定义）

- `C_init = { a.id | a ∈ input.adopt, a.phase = initial, a.status_at_adopt = consumed }`
- `C_auth = C_init ∪ ⋃ { step.end.inputs_consumed[].id | step.end.ok == true }`
- `K_auth`：输入账本中出现过的全部 id（`input.append`、`input.adopt`）。`input.intent` 已删除。
- `P_auth = K_auth − C_auth`
- 只有 `phase = initial` 的 adopt 能把 consumed 状态带进 `C_auth`。其他阶段 adopt 到的 consumed 条目，**不计入** `C_auth`（处理方式见 §1.5）。

### 1.2 系统 note 的确定性身份（替换 v5 §1.3 规则 2，以及 v4 §1.2 的 `meta.key` 去重）

系统 note 共两种：

| purpose | 触发时机 | 去重键 `key` |
|---|---|---|
| `keep` | `interrupted_choice` 的结果为 keep，之后该步骤的下一次调用 | 下一次调用的 `call_id` |
| `write_scope` | `(e, design_scope, 0)` 步骤 | `step_id`（同一步骤的 a1、a2… 共用一条，重试时不会出现重复提示） |

- **id：**`in-sys-` + `sha256(key + "\n" + purpose)` 的前 16 位 hex。用户输入的 id 格式是 `in-<base36>-<hex6>`，两者不会重名。
- **entry：**`{id, at, kind: "note", by: "agentline", text, status: "pending", meta: {key, purpose}}`。`text` 取自代码常量（`WRITE_SCOPE_NOTE`、`KEEP_NOTE`）。
- **生成规则：**先在输入账本中按 ikey `append:<id>` 查找。找到就**原样复用**账本里的 entry，包括 `at`；没找到才新建。所以同一个 id 永远只对应一份内容，重入时不会触发 `E_LEDGER_CONFLICT`。
- runFlow 中的 `flow.mjs:304` 保持不变。系统 note 规则只用于 runStep 路径。

### 1.3 写入次序（替换 v4 §1.1 的 P1–P2）

| # | 动作 | 写在哪里 | 执行者 |
|---|---|---|---|
| P1 | `step.begin` | ledger | Supervisor |
| **P1b** | **S-NOTE：**如果本次调用需要系统 note，先取输入锁，按 §1.2 得到 entry。账本中没有这条时，写 `input.append{by: system, entry, content_sha256}` 并 fsync，然后释放锁 | 输入账本 | Supervisor |
| P2 | runStep 新参数 `systemInputs: [entry]`：取输入锁；文件中**没有这个 id** 时，用 `appendFileSync` 追加一行（不 rename）；然后释放锁。attention 的清理保持原样 | `inputs.jsonl` | runStep |
| (exec) | `exec.mjs:130` 读取 pending，生成提示词 | — | exec（不改） |
| P3 | beforeCall：执行 §1.5 的 B-ADOPT 和 I-IN，然后写 `call.start` | ledger | CallGuard |

**W0 的恢复结果（崩溃发生在 `step.begin` 之后、`call.start` 之前）**

| 输入账本中有这条系统 note | 文件中有这一行 | 恢复结果（唯一） |
|---|---|---|
| 否 | 否 | 再写一条 `step.begin`。P1b 生成的 id **相同**（key 不变，因为 call_id 只在 `call.start` 之后递增），重新写入账本，P2 追加 |
| 是 | 否 | R0 对账发现该 id 属于 `K_auth` 但文件中缺这一行 → `restore`（pending）。之后 P1b 复用 entry，P2 发现文件中已有这一行，直接跳过 |
| 是 | 是 | 对账没有差异；P1b 复用，P2 跳过 |
| 否 | 是 | 按写入次序不可能出现 → `E_LEDGER_ORDER` → `blocked(integrity)`。**不 adopt**：`in-sys-` 开头的 id 只能来自 P1b |

在所有分支中，账本里这个 id 恰好有 1 条 `input.append`，文件中恰好有 1 行，后面只会出现 1 条 `call.start`。

### 1.4 输入锁：当前核心内所有写入者互斥（替换 v5 §1.3 规则 1、3）

- **锁：**`<B>/build/NNN/inputs.lock`，内容为 `{pid, proc_start, purpose, at}`。stale 判定：持有者的 `(pid, proc_start)` 已经不存在，就可以接管。
  - 这把锁不需要 §3 的终止证明。理由是：只有持锁进程自身会写 `inputs.jsonl` 和输入账本，它的子进程（adapter、git）从不写这两个文件。
- **锁保护的范围：**`inputs.jsonl` 和 `inputs.ledger.jsonl` 的每一次写入。

| 写入者 | 持锁区间 |
|---|---|
| 新版 `input` / `answer`（CLI、Host、slash 都经由 CLI） | 取锁 → `appendInput` → 写 `input.append` 并 fsync → 释放锁 → **之后**才报告成功。等锁最多 60 秒，超时返回 `E_INPUT_BUSY`（非零退出），**不写任何内容** |
| P1b、P2 | 见 §1.3 |
| 对账（`reconcileInputs`） | 从校验 `expect_before_sha256` 一直到 rename 完成 |
| **P6 窗口** | CallGuard 在 afterCall 的末尾（`call.end` 已经 fsync）**取锁**，在下列两个时刻中先到的那个**释放**：下一次 beforeCall 的 I-IN 检查完成（exec 的网络重试会再次调用 `adapter.run`），或 executeRole 返回 runStep。因此 `markConsumed` 的“整读 → rename”始终处于锁内 |
| `step.end` 的 `inputs_consumed` 计算及其附带的 adopt | worker 持锁 |

- `build start` 的初始 adopt 也在锁内执行，写入 `input.adopt{phase: initial}`。
- **结果：**当前核心内的写入者不会再与 rename 交错。v5 中“新版命令被吞 → 由 `input.append` 恢复”的路径不会再发生；`restore` 只用来处理文件被删除或被截断（A1-8d）。

**为什么不采用 append-only 状态事件：**

- 把“改状态”也改成追加行，需要修改 `inputs.mjs` 中 `readInputs` 和 `markConsumed` 的语义（按 id 折叠、只追加）。这属于 K1 授权以外的内核改动（D1 只授权在 `flow.mjs` 中增加 `runStep`）。
- 升级前的核心会把状态行误读成新的输入。

因此它只作为 S1 的选项 B（§8.1），不是默认方案。**也不采用“禁用旧路径”**：当前核心中的 `input` 命令就是新版命令，没有需要禁用的旧路径。需要处理的只有不取锁的外部写入者，见下面的 L 分类。

**不取锁写入者（L 类）的分类与处理**

| 类别 | 定义 | 处理 |
|---|---|---|
| L-cur | 升级后当前核心中的 `input` / `answer` / `run` / `flow` | 已经取锁、写账本，属于受支持的写入者 |
| L-pre | 升级前启动、跨越升级时仍在运行的旧 `input` 进程 | 升级规程（§4.4 U2）要求：切换之前 `drain status` 中的来源 (f) 必须为 0。`input` 进程只存活几毫秒，(f) 能看到它 |
| L-foreign | 升级后仍被调用的其他旧核心副本、脚本或编辑器直接写入的 `inputs.jsonl` | **范围决定 S1**（§8.1，需要用户裁决）：worker 处于运行窗口时，这类写入**不受支持**（可能被 rename 吞掉）；任务不在运行时（blocked、awaiting、已停止），写入会在下一个边界被 adopt，与 v5 相同 |

### 1.5 I-IN 与 beforeCall 的 adopt（替换 v5 §1.4 中的 I-IN 和“执行方式”最后一条）

**B-ADOPT（beforeCall 内持输入锁执行，在 I-IN 之前）**

| 文件中的条目 | 动作 |
|---|---|
| id ∉ `K_auth`，status 为 pending，id 不以 `in-sys-` 开头 | 写 `input.adopt{phase: precall, entry, status_at_adopt: pending}` |
| id ∉ `K_auth`，status 为 consumed | `G_INPUT_UNRECONCILED`（exit 97）→ `blocked(integrity)`。当前核心中，只有 exec 会标记 consumed，而它只标记已经读到的 id，这些 id 在上一个边界都已经完成 adopt |
| id ∉ `K_auth`，且以 `in-sys-` 开头 | `E_LEDGER_ORDER` → `blocked(integrity)` |

**I-IN（B-ADOPT 之后检查）**

对每个 `id ∈ K_auth`：
- 文件中存在该 id，且 `content_sha256` 一致；
- 文件中的状态 = (id ∈ `C_auth` ? consumed : pending)。

不满足 → `G_INPUT_UNRECONCILED`，不发起调用。

**对账（替换 v5 §1.4 对账表的第 4 行，其余行保留）**

| 文件现场 | 动作 |
|---|---|
| 文件中有、账本中没有 | 先写 `input.adopt{phase: reconcile, status_at_adopt}`，再按其余行判定。consumed 且 ∉ `C_auth` 的条目会因此被 `set_pending` |

- **`step.end` 附带的 adopt**（v5 §1.3 规则 4）写为 `phase: stepend`。
- **审计字段：**`call.start.inputs_pre` 的快照取在 beforeCall，晚于 `exec.mjs:130` 读取 pending 的时刻，所以可能比提示词中实际出现的输入多。它只用于审计，这一点在字段说明中写明。
- 删除 v5 中“重写过程中又被追加的行，在下一个边界由 `input.append` 恢复，所以竞态可以自愈”这句话。

### 1.6 W2(c) 与对账（补充 v5 §1.5）

W2(c) 中，如果一个 consumed 条目在 `exec.mjs:130` 读取时已经存在于文件中，但还没有完成 adopt（例如 L-foreign 在空闲期写入）：
- 恢复流程写 `step.end{ok:false, inputs_consumed: []}`；
- 对账先写 `adopt{phase: reconcile, status_at_adopt: consumed}`，再执行 `set_pending`。

结果是唯一的：这一条不进入 `C_auth`，并出现在下一次调用的提示词中。

### 1.7 B1-1 验收（A1-8c 替换；新增 A1-9 系列）

| # | 注入 | 期望 |
|---|---|---|
| A1-8c（替换） | 用测试中的 fs 钩子，让 `markConsumed` 暂停在“整读”和 rename 之间；同时执行新版 `agentline input --text Y` | `input` 进程在等锁（钩子放行之前，Y 不在文件中，也不在账本中）；放行后 Y 写入文件和账本，`input` 退出码为 0；`inputs.reconcile.restored` 为空；下一次调用的提示词包含 Y |
| A1-9a | 钩子同上，暂停 70 秒 | `input` 返回 `E_INPUT_BUSY`，非零退出；文件和账本中都没有这条输入；钩子放行后 worker 正常完成 |
| A1-9b | **正常 keep：**e1/dev/2 的 a1 被中断 → 用户选择 keep | 输入账本中有 `input.append{by: system, id: in-sys-…, meta: {key: e1/dev/2/a2, purpose: keep}}`，它的 seq 早于 a2 的 `call.start`；beforeCall 通过，没有 `G_INPUT_UNRECONCILED`；a2 的提示词包含 keep note；a2 成功后，该 id 恰好出现在 1 条 `step.end.inputs_consumed` 中 |
| A1-9c | **正常 design_scope：**design 成功但缺少 `write_scope` | `(e, design_scope, 0)` 的 a1：账本中的 `input.append` 早于 `call.start`；I-IN 通过；a1 成功后这条 note 被消费；文件中只有 1 行 `in-sys-` 条目 |
| A1-9d | design_scope 的 a1 返回 `no_changes`，然后 a2 | 两次调用共用同一个 write_scope note id；a2 的提示词中这条 note 只出现 1 次；结束时文件和账本中都只有 1 条 |
| A1-9e | W0：在 P1b 写完之后、P2 之前杀死 worker | 恢复：`inputs.reconcile.restored = [in-sys-…]`；P2 跳过；账本中有 1 条 `input.append`，文件中有 1 行，有 1 条 `call.start` |
| A1-9f | W0：在 `step.begin` 之后、P1b 之前杀死 worker | 生成的 id 与崩溃前计算的值相同；账本中有 1 条，文件中有 1 行 |
| A1-9g | 故障夹具：文件中有 `in-sys-` 开头的行，账本中没有对应记录 | `E_LEDGER_ORDER`；没有 `call.start` |
| A1-9h | **L-foreign 空闲写入：**任务处于 blocked 时，用不取锁的 `appendFileSync` 写入 Z，然后 resume | 对账写 `adopt{phase: reconcile}`；下一次调用的提示词包含 Z |
| A1-9i | 在 `exec.mjs:130` 之后、beforeCall 之前，用不取锁的写入追加 pending 条目 Z | B-ADOPT 写 `adopt{phase: precall}`；I-IN 通过；Z 不在本次提示词中，`markConsumed` 也不标记 Z；下一次调用包含 Z |
| A1-9j | 用不取锁的写入追加一行 consumed 状态的条目 W | `G_INPUT_UNRECONCILED`；adapter 调用计数不变 |
| A1-9k | 初始 adopt 时，文件中已有 consumed 的 V | `C_init = {V}`；I-IN 通过；对账不对 V 执行 `set_pending` |
| A1-9l（只在 S1 选 B 时启用） | 与 A1-8c 相同，但改用不取锁的写入 | Y 不丢失 |

---

## 2. B1-2：主归档与晚到归档的不可变存储

### 2.1 存储与引用（替换 v5 §2.1 中 `call.archive_late` 的字段，以及 v5 §2.2）

| | 主归档 | 晚到归档 |
|---|---|---|
| 目录 | `calls/<call_id>/` | `calls-late/<call_id>/` |
| checkpoint ref | `refs/agentline/calls/<call_id>` | `refs/agentline/late/<call_id>`（单独的命名空间，避免与 `calls/<call_id>` 发生目录与文件的 ref 冲突） |
| 事件 | `call.archive`（ikey `archive:<call_id>`） | `call.archive_late`（ikey `late:<call_id>`） |
| 数量 | 每个 call 恰好 1 份 | 每个 call 至多 1 份 |

**I-ARC（不变量）**
- `call.archive` 落盘之后，`calls/<call_id>/` 中的文件和 `refs/agentline/calls/<call_id>` **只读**。
- `call.archive_late` 落盘之后，`calls-late/<call_id>/` 和 `refs/agentline/late/<call_id>` 同样只读。
- 晚到归档**从不**读取、写入、移动主归档的目录或 ref。

**API**
- `archiveCall(call_id, kind: primary|late)`：
  - `kind = primary` 时，如果 `call.archive` 已经存在，就拒绝执行（`E_LEDGER_ORDER`）；
  - `kind = late` 时，如果 `call.archive` 不存在，或者 `call.archive_late` 已经存在，就拒绝执行。
- **两种 kind 使用相同的原子流程：**先写 `<dir>.tmp-<nonce>/`，再 rename 到目标目录。目标目录已经存在、却没有对应事件时，把旧目录改名为 `<dir>.orphan-<n>/`，记入事件的 `orphans[]`。目标 ref 已有值、却没有对应事件时，记入 `checkpoint.prior`。
- **`call.archive_late` 的字段：**`{dir, log {dst, sha256, bytes}|null, checkpoint {ref, sha, prior?}|null, artifacts [{path, sha256}], fingerprint, orphans[], reason: post_archive_change}`
- **校验函数：**
  - `verifyPrimary(call_id)` 只读取 `call.archive`、`calls/<call_id>/` 和主 ref；
  - `verifyLate(call_id)` 只读取 `call.archive_late`、`calls-late/<call_id>/` 和 late ref。
  - **“归档校验通过”** = `verifyPrimary` 通过，并且（存在 `call.archive_late` 时）`verifyLate` 也通过。

### 2.2 窗口表（替换 v5 §2.3 的 W1b 行，新增 W1b-L、W1e 两行）

前提：§3 的结果为 `proven_dead`，并且恢复者持有任务锁。

| 窗口 | ledger 现场 | 恢复结果（唯一） | 计费 |
|---|---|---|---|
| **W1b** | 有 `call.archive{by: afterCall}`，没有 `call.archive_late`，没有 `call.end` | ① `verifyPrimary`，失败转 W1d；② 比较当前指纹与 `outcome.post_fingerprint`：**相等** → `call.end = outcome`，附 `{by: recovery, from: archive}`；**不相等** → `archiveCall(late)` → 写 `call.archive_late` → 然后**按 W1b-L 继续** | 占 1 次调用；usage 取 `outcome.usage` |
| **W1b-L** | 有 `call.archive{by: afterCall}`，有 `call.archive_late`，没有 `call.end` | ① `verifyPrimary`；② `verifyLate`，两者任一失败转 W1d；③ 写 `call.end{error: E_WORKER_LOST, by: recovery, from: archive, late_write: true, outcome_ref: "archive:<id>", late_ref: "late:<id>", usage: outcome.usage, usage_source: outcome.usage_source}`；④ 进入 W2 判定，结果必然是 (c)，否则返回 `E_LEDGER_ORDER`。**不再比较指纹，不再归档** | 同 W1b |
| W1c | 有 `call.archive{by: recovery}`，没有 `call.end` | 与 v5 相同。此时如果出现 `call.archive_late` → `E_LEDGER_ORDER`（恢复流程的归档本来就晚于写入者死亡，不存在“晚到”） | 同 v5 |
| W1d | `verifyPrimary` 或 `verifyLate` 失败 | `E_EVIDENCE_CORRUPT{which: primary\|late}` → `blocked(integrity)` | — |
| **W1e** | 有 `call.archive_late`，没有 `call.archive` | `E_LEDGER_ORDER` → `blocked(integrity)` | — |

- **载荷确定性：**W1b-L 中 `call.end` 的全部字段都取自 ledger，不读取当前现场。因此不论重复恢复多少次，写出的载荷都相同（ikey 比较时不计 `seq` 和 `at`），不会触发 `E_LEDGER_CONFLICT`。
- **“late 已写、end 未写时再次崩溃”**的唯一结果是：走 W1b-L，最终得到 1 条 `call.archive`、1 条 `call.archive_late`、1 条 `call.end{late_write: true}`。两次崩溃之间如果工作区又发生变化，这些变化不进入证据，由 `interrupted_choice` 的 keep 或 discard 处理（discard 的目标仍然是 `pre.head`）。
- **在晚到归档的 rename 之后、写事件之前崩溃：**此时现场属于 W1b（还没有 late 事件）。重新进入 ② 并比较指纹：
  - 仍然不相等（常见情况）→ 旧的 `calls-late/<id>/` 被改名为 `.orphan-1` 保留，生成新的晚到归档，`orphans` 中列出它；
  - 相等（用户已经把文件改回原样）→ 写 `call.end = outcome`，孤立目录保留在原处，并在 `recovery` 事件中记录。

### 2.3 后续动作的硬前置（替换 v5 §2.4 第 1 条中“归档校验通过”的含义）

对同一个 step_id，执行 beforeCall、`runStep(discard)`、`runStep(finalize)` 之前，**每个** call_id 都必须满足以下全部条件：
- 有 `call.archive`；
- 有 `call.end`；
- 按 §2.1 的定义，归档校验通过（存在 late 时，主归档和晚到归档都要通过）。

### 2.4 封存与本机证据（增补）

- **封存：**`manifest.json` 中同时列出 `refs/agentline/calls/*` 和 `refs/agentline/late/*`，然后删除这两组 ref。
- **本机证据：**`T.local_evidence` 的本机位置增加 `calls-late/<call_id>/…`。

### 2.5 静态约束

- 代码中不能出现以 `calls/<call_id>` 为目标、并且 `kind ≠ primary` 的写入。
- `update-ref refs/agentline/calls/*` 只能出现在 `archiveCall(primary)` 中。

### 2.6 B1-2 验收（A1-8i 替换；新增 A1-10 系列）

| # | 注入 | 期望 |
|---|---|---|
| A1-8i（替换） | dev 调用成功；在 `call.archive` 之后、`call.end` 之前杀死 worker；恢复之前由夹具修改 1 个文件 | 有 1 条 `call.archive_late`，它的 checkpoint（`refs/agentline/late/<id>`）包含该文件；`call.end.late_write = true`；进入 `interrupted_choice` |
| A1-10a | 同 A1-8i；比较晚到归档前后的主归档 | `refs/agentline/calls/<id>` 的 sha 不变；`calls/<id>/` 中每个文件的 sha256 不变；`verifyPrimary` 通过 |
| A1-10b | **late 已写、end 未写时再次崩溃**：在 `call.archive_late` fsync 之后、`call.end` 之前杀死恢复者，然后再恢复一次 | 走 W1b-L：1 条 archive、1 条 late、1 条 end；不新建 `calls-late` 目录；`call.end.usage = outcome.usage` |
| A1-10c | 同 A1-10b，并且在两次恢复之间再修改 1 个文件 | 结果与 A1-10b 相同（不产生第二份 late）；进入 `interrupted_choice`，该文件留在工作区中 |
| A1-10d | 在晚到归档的 rename 之后、写 `call.archive_late` 之前杀死恢复者 | 再次恢复时存在 `calls-late/<id>.orphan-1/`，新的 late 事件的 `orphans` 中列出它；两份内容都保留；主归档不变 |
| A1-10e | late 写完之后，篡改 `calls-late/<id>/log` 的 1 个字节 | `E_EVIDENCE_CORRUPT{which: late}`；没有 a2、discard 或 finalize |
| A1-10f | 故障夹具：只写 `call.archive_late`，不写 `call.archive` | `E_LEDGER_ORDER` |
| A1-10g | 对已经有 `call.archive` 的 call 调用 `archiveCall(primary)` | 拒绝执行；目录和 ref 都不变 |

---

## 3. B1-3：POSIX 终止证明——重新挂接无法排除时必须返回 `unknown`

### 3.1 祖先链记录（新增）

- `spawnGuarded()` 在**放行之前**，向守护记录写入：
  - `anc`：守护进程自身及其祖先链 `[{pid, proc_start}]`，一直记录到 pid 1；
  - `pidns`：Linux 下为 `/proc/self/ns/pid` 的 inode，其他平台为 null。
- target 的祖先链 = `[guard] ++ guard.anc`。
- 任务锁、准入记录、procs 记录（§4）也记录持有者自身的 `anc` 和 `pidns`。
- 守护进程在成员集合变化时更新 `members: [{pid, proc_start}]`（最多每秒 1 次）。**这个字段只用于归属判断和界面展示，不作为“集合完整”的证明。**

### 3.2 第一层判定（替换 v5 §3.2 判定表的第 4 行）

| 现场 | 结果 |
|---|---|
| 守护进程已死，记录不是 `drained`；或者没有守护记录 | 转入第二层（Windows 走 3.3W，POSIX 走 3.3P） |

### 3.3W 第二层（Windows）：保留 v5 §3.3 原规则

适用理由：Windows 没有重新挂接机制。进程的 `ParentProcessId` 在创建时确定，此后不会改变。所以，一条父链如果每一步都满足“父进程存活、`parent.create_time ≤ child.create_time`”，并且到达一个 `create_time < target.proc_start` 的进程，这条链就不经过 target，可以排除。A1-8m、A1-8n 保持有效。

### 3.3P 第二层（POSIX：Linux、macOS 及其他）：替换 v5 §3.3 在 POSIX 下的规则

**删除**的规则：“走到 `create_time < target.proc_start` 的进程即排除”。在 POSIX 下，孤儿可能被重新挂接到一个更早创建的 subreaper 或 init 下面，而 `(pid, ppid, create_time)` 无法证明这种挂接没有发生。

**新规则**

1. 读取全量快照 `(pid, ppid, create_time)`。快照失败，或任一进程的 `ppid`、`create_time` 读不出 → `unknown`。
2. 没有 `anc` 记录（旧任务、没有经过守护的 target）→ **`unknown(no_ancestry)`**，本层不给出结论。
3. Linux 下 `pidns` 与当前进程不一致，或者读取失败 → `unknown(pidns)`。
4. **可接管集合** `R = { anc 中身份（pid 与 proc_start）仍然一致的存活进程 } ∪ { 本命名空间的 pid 1 }`。
5. **候选** `Cand = { X 存活 | X.create_time ≥ target.proc_start − 1 tick，并且 X 的父进程身份 ∈ R }`。
6. `Cand = ∅` → `proven_dead`。`Cand ≠ ∅`：
   - 全部候选的身份都出现在守护进程的 `members` 或心跳的 `descendants` 中 → `alive(Cand)`；
   - 否则 → `unknown(reparent_possible, Cand)`。

**可靠性依据**

1. 设 D 是 target 的任一存活后代。沿 D 的**当前**父链向上走，第一个不属于 target 历史子树的进程记为 A，它下面那个进程记为 X。X 属于子树，所以 `X.create_time ≥ target.proc_start`。
2. X 原来的父进程在子树内，现在的父进程 A 在子树外，所以 X 一定经历过重新挂接。按 Linux 的规定，接管者只能是“当时正在死亡的进程的最近存活 subreaper 祖先”，或者命名空间的 init。A 在子树外，所以 A 是 target 的祖先，或者是 init。
3. target 的祖先链只会减少，不会增加。存活的 subreaper 祖先不会从链中脱落；脱落的只能是非 subreaper，而非 subreaper 不会接管孤儿。所以 A ∈ R，X ∈ Cand。因此本规则**不会漏判**。
4. macOS 没有 subreaper，孤儿一律交给 launchd（pid 1），pid 1 ∈ R，同样成立。FreeBSD 的 reaper 只能由祖先进程设置，同样成立。
5. 如果 anc 中某个 pid 被复用，新进程的身份不一致，不属于 R。它不是 target 的祖先，不可能接管 target 的后代，所以按它排除是安全的。
6. **代价：**祖先进程（例如 shell、`systemd --user`）或 pid 1 在 target 之后启动的无关子进程，也会进入候选。结果偏保守，表现为 `unknown`。

### 3.4 第三层

不变（开机时间晚于 `target.proc_start`，并且晚于守护进程的 `proc_start` → `proven_dead`）。

### 3.5 未通过时的处理（增补 v5 §3.5）

| 结果 | 动作 |
|---|---|
| `alive`（来自 3.3P，所有候选都能归属） | 只对这些身份已核对的进程发送 SIGKILL，然后重新证明 |
| `unknown(reparent_possible, Cand)` | `E_PROCESS_LINGERING{liveness: unknown, reason: reparent_possible, candidates[{pid, proc_start, ppid, parent_image, cmdline, cwd}]}` → `blocked(integrity)`。**不自动结束任何进程。**用户可以结束列出的进程，然后执行 `recover sweep`；也可以重启电脑（第三层） |
| `unknown(no_ancestry)` / `unknown(pidns)` | 同上，`candidates` 为空，界面只提供“重启后重试”。**不提供任何人工放行开关** |

### 3.6 B1-3 验收（A1-8r 增补；新增 A1-11 系列）

| # | 注入 | 期望 |
|---|---|---|
| A1-8r（增补） | Linux，守护进程存活：adapter 子进程执行 `setsid` 之后，父进程退出 | 孤儿被挂到守护进程下 → 第一层 `alive` → terminate → `proven_dead`（与 v5 相同） |
| **A1-11a（反例）** | Linux。夹具进程 U 先执行 `PR_SET_CHILD_SUBREAPER`（模拟 `systemd --user`）；U → shell → `build start` → 守护进程 G → worker W → `sh -c` → model M。M 启动之后，用 SIGKILL 杀死 G、W 和 `sh`，M 被挂到 U 下面，并且继续写文件 | 第一层：G 已死，记录不是 `drained` → 3.3P：M 的父进程是 U，U ∈ anc ⊆ R，且 `M.create_time ≥ W.proc_start` → M ∈ Cand。M 不在 `members` 中（它是在最后一次快照之后启动的）→ `unknown(reparent_possible, [M])` → `E_PROCESS_LINGERING`；**没有新的 `call.start`**。断言：按 v5 规则（“遇到更早的祖先即排除”）得到的 `proven_dead` 没有被采用 |
| A1-11b | 接 A1-11a 的恢复：用户结束 M，然后执行 `recover sweep` | U 下面没有其他晚于 W 启动的子进程 → `proven_dead` → 进入 W1a；M 的写入在 checkpoint 中，此后没有新的写入 |
| A1-11c | 同 A1-11a，但 M 出现在守护进程最后一次 `members` 快照中 | `alive([M])` → SIGKILL → 重新证明 → `proven_dead` |
| A1-11d | 同 A1-11a，并且 U 在 W 之后又启动了一个无关进程 N | Cand = {M, N} → `unknown`；用户只结束 M → 仍为 `unknown([N])`；重启后 → 第三层 `proven_dead` |
| A1-11e | Linux 上的旧任务，没有守护记录，也没有 `anc` | `unknown(no_ancestry)`，不是 pass；重启后 `proven_dead` |
| A1-11f | macOS：model 两次 fork 之后被 launchd 接管 | 父进程是 pid 1 → 候选 → `unknown` |
| A1-11g | anc 中 shell 的 pid 被一个更晚启动的无关进程 P 复用，P 有子进程 Q | P 的身份与 anc 不一致，不属于 R → Q 不是候选（不因 Q 产生误报） |
| A1-11h | Windows：同 A1-11a，但没有守护（旧任务），父进程 cmd 已死 | 走 3.3W：结果与 A1-8m 相同，为 `unknown` |

---

## 4. M4：入口退出后，遗留后代仍要计数

### 4.1 执行者记录在退出后保留（替换 v4 §5.1 和 v5 §5.1 中的“退出时删除”）

- **范围：**`starts_work` 命令（包括当前核心的 `run`、`flow`）的准入记录 (a) 和 procs 记录 (f-reg)。
- **退出时**不删除记录，改为写入 `{state: exited, exited_at}`。被 kill -9 时来不及写，记录保持原状。
- **删除条件：**`drain status` 以记录的 holder 为 target，按 §3 求得 `proven_dead`（第二层使用记录中的 `anc`）之后，才删除记录。证明结果为 `alive` 或 `unknown` 时，这条记录继续计入结果（分别计为 `n` 或 `unknown`）。
- `starts_work = false` 的 R 类命令仍然在退出时直接删除记录。这类命令不派生会写仓库的进程。

### 4.2 新增来源 (g)(h)(i)

| 来源 | 内容 | 计入条件 | 删除或清除 |
|---|---|---|---|
| **(g) 旧入口观测记录** | 来源 (f) 每次识别到 `legacy_or_starting` 进程（没有 procs 记录的 agentline 入口）时，持久化 `<C>/data/run/legacy/<pid>-<proc_start>.json {pid, proc_start, cmdline, anc, pidns, first_seen, last_seen}`。识别发生在 `drain status`、`drain`、`build start`、worker 启动、`recover sweep` 时 | 入口存活 → 计入（与 (f) 去重）。入口已退出 → 以它为 target 执行 §3，结果不是 `proven_dead` 就计入 | §3 结果为 `proven_dead` 时删除 |
| **(h) 旧运行残留证据** | 扫描 registry 中的仓库：`live.json`，以及**没有 `proc_start` 字段**（旧格式）的任务锁、registry 条目、`.flow.lock`。条件：其中的 pid 已死，或 pid 当前对应的进程不是 agentline 入口。pid 与 (a)、(f-reg)、(g) 中的记录一致时，按那条记录去重 | `unknown(legacy_stale)`。这类证据没有 `proc_start`，第二层无法使用，只看第三层 | 开机时间 > 证据中的时间（`live.json` 取 `started_at`，锁取 `at`）→ 在 `<C>/data/run/legacy/cleared/<sha256(路径 + 内容)>` 写入清除标记。**不删除、不改动**任务目录中的文件 |
| **(i) 升级屏障** | 从已有安装升级时，新核心第一次启用就写入 `<C>/data/run/upgrade.json {from_version, installed_at, boot_id, state: pre_upgrade_unverified}`。全新安装不写 | `state = pre_upgrade_unverified` → `unknown(pre_upgrade)` | 开机时间 > `installed_at`（第三层：升级前启动的所有进程都已不存在）→ 改为 `verified` |

- **汇总（替换 v5 §5.1）：**`drain status = (a) ∪ (b) ∪ (c) ∪ (e) ∪ (f) ∪ (g) ∪ (h) ∪ (i)`，按 `(pid, proc_start)` 去重。任一来源为 `unknown`，整体就是 `unknown`。
- 同一次 `drain status` 中，所有证明共用一次进程快照。
- `drain status` 只写 `<C>/data/run/legacy/`、`upgrade.json`，以及 (a)、(f-reg) 中满足删除条件的记录。它不写仓库，也不写任务目录。
- **(d) `live.json`** 仍然只作为明细展示。它的残留形态由 (h) 处理。

### 4.3 旧 `cmdRun` 入口退出、模型子进程存活时的结果

| 情形 | 结果 |
|---|---|
| 当前核心的 `cmdRun` 被杀，model 存活 | (a) 和 (f-reg) 的记录保留 → 以 cmdRun 为 target 执行 §3：Windows 下，model 的父链断在已死的 cmdRun → 候选；POSIX 下，model 的父进程属于 R → 候选。结果为 `unknown`（或者在 members 可以归属时为 `alive`）→ **不为 0** |
| 升级前的 `cmdRun`，曾经被 (f) 观测到，之后被杀 | (g) 的记录保留 → 同上 |
| 升级前的 `cmdRun`，从未被观测到，在 adapter 运行期间被杀 | `live.json` 残留，并且 pid 已死 → (h) `unknown(legacy_stale)` |
| 升级前的 `cmdRun`，从未被观测到，也没有留下证据 | (i) `unknown(pre_upgrade)`，直到升级之后重启过一次 |

### 4.4 升级与回滚规程（替换 v5 §5.1 的回滚步骤）

- **U1：**新核心并行安装，暂不启用。
- **U2：**停止旧运行（使用旧核心的 `stop` 或等待结束）。在新核心中执行两次 `drain status`，(f) 和 (h) 都必须为 0。这同时排空了 L-pre 类型的 `input` 进程（§1.4）。**要求先排空旧运行。**
- **U3：**切换 shim，开始写 `upgrade.json`。
- **回滚：**沿用 v5 的规则（第一步和切换前最后一步各执行一次 `drain status`，两次都为 `0`，drain 标志在两次之间一直处于设置状态）。由于 (i) 的存在，**升级之后至少要重启一次，才可能得到 `0`**。

### 4.5 M4 验收（替换 A6-15；修订 A6-6；新增 A6-16 至 A6-18）

| # | 注入 | 期望 |
|---|---|---|
| A6-15a | **入口退出，后代存活（升级前的旧核心）：**A6-9 中的旧 `cmdRun` 被 (f) 观测过；然后杀死 cmdRun，model 继续写文件 | 在 Windows 和 Linux（同时执行 A1-11a 的 subreaper 夹具）下，两次 `drain status` 都是 `unknown` 或 ≥ 1，来源为 (g)；**任意时刻都不为 0** |
| A6-15b | 接 A6-15a：结束 model | (g) 证明得到 `proven_dead` → 记录被删除；没有其他来源时结果为 `0` |
| A6-15c | **入口退出，后代存活（当前核心）：**新核心的 `agentline run` 被 kill -9，model 存活 | (a) 和 (f-reg) 的记录仍在（没有写 `exited`）→ `unknown` 或 ≥ 1；结束 model 后为 `0` |
| A6-15d | 当前核心的 `agentline run` 正常结束，但 model 派生的后台进程 B 仍然存活 | 记录为 `state: exited`，证明发现 B 是候选 → 不为 0；结束 B 后为 `0` |
| A6-15e | A6-9 中的旧进程正常退出，并且没有任何后代 | (g) 证明为 `proven_dead` → `0`（原 A6-15 的语义） |
| A6-6（修订） | 使用升级前的核心执行 `agentline run`，覆盖全程，并在 adapter 运行期间杀死入口 | 入口存活期间：(f) ≥ 1；入口退出后：(g)（被观测过时）或 (h)（`live.json` 残留时）计入；任意采样时刻都不为 0 |
| A6-16 | 从未被观测过的旧 `cmdRun` 在 adapter 运行期间被杀，本次开机期间执行 `drain status` | `unknown(legacy_stale)`；重启之后 → 写入清除标记，`live.json` 原样保留 → `0` |
| A6-17 | 从已有安装升级（U3）之后、重启之前执行 `drain status` | `unknown(pre_upgrade)`；重启之后 `upgrade.json.state = verified`，结果可以为 `0` |
| A6-18 | 全新安装 | 没有 `upgrade.json`；(i) 不参与汇总 |

---

## 5. Minor

### 5.1 `C_auth`

见 §1.1。v5 §1.3 规则 3 中“计入初始的 `C_auth`”的说法，以 §1.1 的公式为准。

### 5.2 A3 编号去重

- v2 的反绕过 gate 用例 **A3-1 至 A3-4 保持原号**。
- v5 §6.4 的 D3 用例改号为 **A3L-1 至 A3L-9**（L 表示 limit），内容不变。
- v5 §11 第 22 项的依据改为“§6、A3L-1–9”。
- 合并稿中所有引用 D3 用例的位置（v5 §0.1、§9 W18）同步改号。

### 5.3 合并稿清理清单（增补 v4 §7.4 和 v5 §7.3，审核时逐项 grep）

**输入与归档**
- `input.intent`、`intent:<meta.key>`，以及“先写 `input.intent`，再调用 runStep”；
- “重写过程中又被追加的行，在下一个边界由 `input.append` 恢复”“竞态可以自愈”；
- v4 §1.2 中“用 `meta.key = call_id` 去重”（改为按确定性 id 去重）；
- “文件中不能有账本以外的 id”（改为 §1.5 的 B-ADOPT 加 I-IN）；
- W1b 中“先 `archiveCall` 写 `call.archive_late`”，且目标目录为 `calls/<call_id>/` 的写法。

**终止证明与 drain**
- 在 POSIX 语境下，“走到 `create_time < target.proc_start` 的进程：不可能是 target 的后代”；
- “macOS 和没有守护进程的旧任务，在 §3.3 下仍然可以得到可靠的判定”（改为 §8.2 的 N15）；
- 准入记录或 procs 记录“退出时删除”（`starts_work` 命令改为 `state: exited`）；
- v5 的 A6-15“旧进程退出 → 0”原文。

**merge 事务：`recording` 阶段**
- v4 §2.3 事务日志 schema 中的 `"phase": "prepared|merging|merged|recorded|verified"`，改为 `prepared|merging|merged|recording|recorded|verified`；
- v4 §2.3 第 7 步原文，改为 v5 §4.1 的 7a–7c；
- v4 §2.4 `merged` 行的“继续第 7、8 步”；
- 所有列举 merge phase 的界面文案和测试枚举，都要包含 `recording`。

**命令 ID**
- 命令表的每一行都满足 R1，或出现在 v5 §7.1 的封闭别名表中；
- 删除 `models.exception_add`、`models.exception_revoke`、`build.resume_keep`、`build.resume_discard`、`recover --repo`；
- Host 白名单的键集合 = 命令表的 id 集合（静态测试）。

**错误码**
- 合并稿的错误码总表一次性收录 v4 §8、v5 §8 和本文 §6 的全部新增码，每个码都写明 exit code、UI 类别，以及是否进入 `blocked(integrity)`；
- 删除 `G_ROUND_CAP`、`E_KERNEL_SEAM_UNVERIFIED`；
- `E_PROCESS_LINGERING` 和 `E_EVIDENCE_CORRUPT` 采用本文给出的载荷字段。

**D1 字母**
- 全文只保留“D1：decisions.md 的 **A ＝ 授权 K1**”；
- 删除 v2 中“A（K0）/B（K1）/C”、v3 中“⚑D1 选项 B / 选项 C”、“前提是 ⚑D1 = B”、“如果裁决为 C”等旧映射；
- v3 §1.10“如果用户不授权 K1”整节标为**已失效**（D1 已裁决）。

**编号**
- 不再有两组含义不同的 `A3-1`（A3L 已改号）。

---

## 6. 命令、错误码、事件的增量（相对 v5 §8）

| 类别 | 变更 |
|---|---|
| 命令 | 新版 `input` / `answer`：持输入锁，并写入 `input.append`（command id 不变） |
| 新增错误码 | `E_INPUT_BUSY`：等待输入锁超时，非零退出，不写入任何内容 |
| 载荷变更 | `E_EVIDENCE_CORRUPT{which: primary\|late}`；`E_PROCESS_LINGERING.reason ∈ {reparent_possible, no_ancestry, pidns, …}`；`drain status` 的 `unknown` 原因新增 `legacy_exited_unproven`、`legacy_stale`、`pre_upgrade` |
| 事件 | **删除** `input.intent`；`input.append` 增加 `by: user\|system`；`input.adopt` 增加 `phase: initial\|precall\|stepend\|reconcile`；`call.archive_late` 采用 §2.1 的字段；`call.end` 增加 `late_write`、`late_ref` |
| 记录 | 守护记录增加 `anc`、`pidns`、`members`；准入记录和 procs 记录增加 `anc`、`pidns`、`state: live\|exited`、`exited_at`；新增 `<C>/data/run/legacy/`、`legacy/cleared/`、`upgrade.json` |
| 内核参数（K1 范围内，在 `flow.mjs` 中） | runStep 新增 `systemInputs: [entry]`。runStep 的 P2 和对账都持输入锁 |
| ref | 新增命名空间 `refs/agentline/late/*` |

## 7. 实现切分的调整（相对 v5 §9）

| 工作流 | 变更 |
|---|---|
| W7a | 输入锁、P1b（S-NOTE）、`systemInputs`、B-ADOPT、`C_init`、`archiveCall(kind)`、`calls-late`、W1b-L 和 W1e；**删除** `input.intent`。选择 S1-B 时，再加上 `inputs.mjs` 的 append-only 改造 |
| W7p | 3.3P 规则、`anc` 与 `pidns` 的记录、`members` 快照 |
| W16 | 执行者记录的 `exited` 状态及删除条件；来源 (g)、(h)、(i)；规程 U1–U3 |
| W18 | A3L 改号 |
| 合并稿 | §5.3 的 grep 清单作为合并 PR 的检查脚本 |

---

## 8. 范围决定、知会与流程

### 8.1 范围决定 S1（**需要用户裁决**）

**问题：**升级后，不属于当前核心的不取锁写入者和执行者（其他旧核心副本、脚本、编辑器直接写 `inputs.jsonl`，即 L-foreign），是否继续作为受支持的**并发**参与者？

| 选项 | 内容 | 代价 |
|---|---|---|
| **A（设计师推荐）** | 只要 worker 处于运行窗口，L-foreign 的写入就**不受支持**（可能被 `markConsumed` 或对账的 rename 吞掉）。任务空闲时写入的内容仍会被 adopt（A1-9h）。drain 方面，L-foreign 执行者活着时由 (f) 计数、退出后由 (g)(h) 计数；既没被观测到、也没有留下证据的 L-foreign 运行，不在保证范围内。界面和文档都写明这一点 | 缩小了 v5 的“旧版 CLI 或手工写入的条目由对账时 adopt”和“(f) 覆盖旧 cmdRun 生命周期的任意时刻”。所以**必须由用户确认**，不能默认采用 |
| B | 修改 `inputs.mjs`：`markConsumed` 和对账都改为追加状态行，`readInputs` 按 id 折叠（最后一条生效）。L-foreign 的并发追加从此不会丢失（启用 A1-9l） | 超出 D1 授权的 K1 边界（K1 只涉及 `flow.mjs`），需要用户**追加授权** `inputs.mjs` 的修改；升级前的核心读到新格式文件时会把状态行误读成输入，所以回滚之前必须先把文件转换回旧格式（增加一个回滚步骤）。即使选 B，drain 中“既没被观测到、也没有证据的 L-foreign”这部分残余仍然存在，因为它没有范围内的机制可以覆盖 |

**影响面：**只有 W7a 的输入部分需要等待 S1 的裁决。复核和其余工作流的切分不受影响。

### 8.2 知会项（不需要裁决）

- **N14：**`agentline input` 在 worker 处于 P6 或对账窗口时最多等待 60 秒，超时返回 `E_INPUT_BUSY`，**不会出现“报告成功但内容丢失”的情况**。
- **N15：**在 POSIX 下没有守护进程时（macOS，或者 Linux 的守护进程被杀），候选集合包括祖先进程和 pid 1 在 target 之后启动的所有子进程。在桌面系统上，这通常意味着“结束列出的进程”不可行，实际的恢复手段是**重启**。
  - 这没有缩小 v5 的承诺：仍然只有 `proven_dead` 才能续跑，重启和结束候选这两条路径都保留；只是 `unknown` 的出现率更高。
  - 本文没有增加任何人工放行开关。
- **N16：**从已有安装升级之后，回滚之前至少要重启一次（来源 (i)）。在本次开机内异常退出、且留下 `live.json` 的旧运行，同样要等到重启之后才能清除（来源 (h)）。
- **N17：**当前核心中的 `run` / `flow` 正常结束之后，`drain status` 仍要对它们做一次终止证明。在 Windows 上，如果有无关进程的父链断裂，可能出现 `unknown`，处理方式与 N10 相同。

### 8.3 流程

本文件连同 v1–v5，提交 **GPT-6 Astra 做最终契约复核**，复核时按 §9 的清单逐项检查。

- 结论为 **APPROVE**：
  - 按 v4 §0.2、v5 §0.2、本文 §0.2 拼装单一合并稿；
  - 执行 v4 §7.4、v5 §7.3、本文 §5.3 的 grep 清理；
  - 然后**进入实现切分**（v3 §9.2 + v4 §9 + v5 §9 + 本文 §7）。W7a 的输入部分等待 S1 裁决。
- 结论为 **REVISE**：不再开新一轮设计。把未关闭项逐条交给用户，由用户选择“局部修补”或“缩小范围”。

---

## 9. 复核检查清单（增补 v5 §11）

| # | 检查项 | 依据 |
|---|---|---|
| 24 | 系统 note 在 beforeCall 之前已经以确定性 id 写入账本；W0 的四种现场各有唯一结果；正常的 keep 和 design_scope 不会触发 `G_INPUT_UNRECONCILED` | §1.2、§1.3、A1-9b–g |
| 25 | 当前核心中，所有写入 `inputs.jsonl` 和账本的路径都在输入锁内；`markConsumed` 的“整读 → rename”被锁覆盖；新版输入命令不存在“报告成功但内容丢失” | §1.4、A1-8c、A1-9a |
| 26 | 不取锁的外部写入者的承诺范围，已作为 S1 明确交给用户，没有作为默认的实现细节 | §8.1 |
| 27 | 主归档与晚到归档的目录和 ref 分离，并且都只写一次；late 已写、end 未写时再次崩溃，结果唯一；晚到归档不改变 `verifyPrimary` 的结果 | §2、A1-8i、A1-10a–g |
| 28 | POSIX 第二层不再依据“更早的祖先”排除候选；没有 `anc` 时返回 `unknown`；“守护退出、后代被外部旧 subreaper 接管”的反例得到 `unknown`，并有恢复动作；Windows 规则的适用理由已写明 | §3、A1-11a–h |
| 29 | 入口退出之后，`starts_work` 的记录和旧入口观测记录都保留到 `proven_dead`；残留证据和升级屏障是失败关闭的；A6-15 的每个分支在任意时刻都不为 0 | §4、A6-15a–e、A6-16–18 |
| 30 | `C_auth` 包含 `C_init`；A3 和 A3L 不重号；§5.3 的清单可以用 grep 验证 | §5 |
