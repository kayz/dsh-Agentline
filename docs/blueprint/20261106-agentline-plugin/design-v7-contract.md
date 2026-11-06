# AgentLine Blueprint 20261106：设计 v7 契约收口（design-v7-contract）

- **状态：**最终局部收口。只处理 review-v6 的 B6-2，S1 裁决的落地，以及四项 Minor。不重开架构，不改 Q1–Q6，也不再询问 D1–D4 和 S1。
- **日期：**2026-11-06
- **主设计：**Claude Opus 5.5；**最终契约复核：**GPT-6 Astra
- **基线：**v1、v2-delta、v3-delta、v4-contract、v5-contract、v6-contract。本文件只写**替换或新增**的内容。未提到的部分保持 v6 合并后的原样。
- **已落盘的裁决（`decisions.md` § S1）：**
  - **S1-1=A：**运行期间不支持 L-foreign 并发写输入。新版输入命令与 runStep 用输入锁互斥。`inputs.mjs` 的格式保持不变。
  - **S1-2=A：**可证明的旧执行者保持非零或 `unknown`，直到得到终止证明。“从未被观测、且没有残留证据的旧 L-foreign 执行者”排除在 drain 保证之外，并且必须显式写明。
- **本轮补充核对的源码事实：**
  - `agentline.mjs:304-316`：`cmdRun` 直接调用 `executeRole`，**没有**传入 `adapterFactory`，也不取任何锁。
  - `agentline.mjs:317-320`：`cmdFlow` 调用 `runFlow`，也**没有**传入 `adapterFactory`。
  - `flow.mjs:61`：`runFlow` 的签名已经接受 `adapterFactory`，并在 `flow.mjs:70` 透传给 `executeRole`。因此接入 L-cur 只需要改 `agentline.mjs`，**不需要**改 `flow.mjs`、`exec.mjs` 或 `inputs.mjs`。
  - `flow.mjs:91-93`：`acquireTaskLock` 失败时立即返回，不会等待。
  - `exec.mjs:130 → 148 → 155 → 197-200`：执行顺序是读取 pending → `adapter.run`（处于网络重试循环内）→ `clearLive` → `appendRun`、`markConsumed`、`writeState`。
  - `lock.mjs:24-42`：`acquireLock` 先读后写，**不是原子操作**，stale 判定也只看 pid。输入锁不复用它（见 §2.2）。
- 本轮不写产品代码，不修改仓库。

---

## 0. 关闭对照与替换清单

### 0.1 review-v6 问题 → 本文件章节

| 问题 | v7 处理 | 章节 |
|---|---|---|
| **B6-1** S1 未裁决 | 已裁决为 S1-1=A、S1-2=A。删除 S1-B 和 A1-9l。输入锁覆盖 L-cur 的 `run`/`flow`。L-foreign 有检测事件、提示和审计；drain 排除 D-EXCL，并写明日志和 UI 的披露方式。同步 W7a、W16 和验收边界 | §2 |
| **B6-2** POSIX 判空 | 第二层按平台拆开。**Linux**：只有在 C1–C4（`/proc` 归属、可见性、逐项可读、`processes` 计数稳定）全部满足时，`Cand = ∅` 才能得到 `proven_dead`；任一条件不满足 → `unknown`。候选分类改为“父进程缺失、嵌套命名空间一律计为候选”。**macOS 与其他 POSIX**：第二层**永远返回** `unknown(enum_unsupported)`。给出 4 个反例及其唯一结果 | §1 |
| Minor：L-cur 锁接入 | 持锁区段模型：执行 `executeRole` 的进程整段持锁，只在 `adapter.run` 期间让出。列出包裹点、正常返回、异常和 `process.exit` 时的释放点；`runFlow` 自己写入的 note 也被覆盖 | §2.3 |
| Minor：reserved ID 优先级 | 所有 adopt 阶段共用一张判定次序表；`in-sys-` 检查先于任何 adopt | §3.1 |
| Minor：清零验收 | 引入夹具 Z 和对照证明；环境噪声判为 `inconclusive`，不判为 pass | §3.2 |
| Minor：合并稿清理 | 增补 v7 清单，并给出错误码总表的增量 | §3.3、§4 |

### 0.2 替换章节清单（合并 v1–v7 时按此拼装）

| 合并基线中的位置 | 处理 | v7 来源 |
|---|---|---|
| v6 §3.3P 整节 | 替换为 3.3L（Linux）和 3.3X（其他 POSIX） | §1.2、§1.3 |
| v5 §3.3 第 1 步中 Windows 的快照来源 | 增补 W-ENUM 约束 | §1.4 |
| v6 §3.5 的 `unknown` 行 | 替换 | §1.6 |
| v6 §3.6 的 A1-11b、A1-11d、A1-11f | 修订；新增 A1-12 系列 | §1.7 |
| v6 §1.4 的“锁”“锁保护的范围”和持锁区间表；v5 §1.3 中的短锁 `inputs.ledger.lock` | 替换（两把锁合并为一把输入锁） | §2.2、§2.3 |
| v6 §1.4 L 类表的 L-cur 行和 L-foreign 行 | 替换 | §2.3、§2.4 |
| v6 §1.5 B-ADOPT 表；v6 §1.5 对账表中“文件中有、账本中没有”一行 | 替换为统一判定次序 | §3.1 |
| v6 §1.7 的 A1-9l | **删除** | §2.8 |
| v5 §5.1 来源 (f) 的 `unknown` 条件 | 增补 Linux 的可见性条件 | §2.6 |
| v6 §4.2 中 (g) 的字段，以及“汇总”一条 | 增补 `class` 字段、`coverage` 字段和 drain 日志 | §2.5、§2.6 |
| v6 §4.5 的 A6-15b–e | 加上夹具 Z 的前置条件 | §3.2 |
| v6 §6 增量表 | 增补 | §4 |
| v6 §7 中的 W7a、W7p、W16 | 替换 | §2.7 |
| v6 §8.1 整节 | 替换为“S1 已裁决”的落地表 | §2.1 |
| v6 §8.2 的 N15 | 替换为 N15′；新增 N18–N21 | §5.2 |
| v6 §8.3 流程 | 替换 | §7 |
| v6 §9 复核清单 | 增补第 31–40 项 | §6 |

---

## 1. B6-2：POSIX 第二层判空需要枚举完整性

### 1.1 原则

- **观测到空集合，不等于后代集合为空。**只有能够证明“枚举结束时刻仍然存活的每一个进程都已被枚举，并且父子关系读取正确”，`Cand = ∅` 才构成证明。
- 证明不了完整性，就返回 `unknown`。不提供人工放行开关，也不能在实现时降级为“尽力扫描”。
- **层级次序不变：**第一层（守护）→ 第二层 → 第三层（开机时间）。第二层的收紧**不影响**第一层和第三层（见 §1.5）。

### 1.2 3.3L：Linux 第二层（替换 v6 §3.3P 在 Linux 下的规则）

**前置条件**（任一不满足即返回，本层不给出结论）

| # | 条件 | 不满足时 |
|---|---|---|
| P0 | 有 `anc` 记录 | `unknown(no_ancestry)` |
| C1 | **`/proc` 属于调用者的 pid 命名空间：**`readlink("/proc/self") == getpid()`，并且 `/proc/self/ns/pid` 的 inode 等于记录中的 `pidns` | `unknown(pidns)` |
| C2 | **可见性：**`/proc/self/mountinfo` 中挂载在 `/proc` 的最上层 procfs，其超级块选项中 `hidepid` 不存在，或取值为 `0`/`off`；否则，调用者的有效组或附加组必须包含该挂载的 `gid=` | `unknown(enum_visibility)` |
| C3 | **逐项可读：**枚举到的每个 pid，`/proc/<pid>/stat` 和 `/proc/<pid>/status` 都必须读得出来。ENOENT 或 ESRCH 视为已退出，直接丢弃；其他任何错误（EACCES、EPERM、解析失败） | `unknown(enum_visibility)` |
| C4 | **稳定性：**在一次尝试的首尾，分别读取 `/proc/stat` 的 `processes` 字段（开机以来 `copy_process` 的累计次数，覆盖所有命名空间，**线程创建也会计入**），得到 F0 和 F1，要求 F0 = F1 | 本次尝试作废，重试；最多 5 次，总时长不超过 2 秒；都不稳定 → `unknown(enum_unstable)` |

**单次尝试**

1. 读 F0。
2. 用 `readdir("/proc")` 取得全部数字目录名。
3. 对每个 pid 读取：
   - `stat` 的第 4 字段 `ppid` 和第 22 字段 `starttime`（单位为时钟 tick）。从**最后一个** `)` 之后开始解析，以免 comm 字段干扰。
   - `status` 的 `NSpid` 行（取它的项数作为 `depth`）。
4. 读 F1。F0 ≠ F1 → 本次尝试作废。

**判定**（在一次稳定的快照上进行）

- **L4：**快照中存在 target 的身份 `(pid, starttime)` → `alive([target])`。
- **记号：**
  - `T0 = target.proc_start`。`anc` 中的 `proc_start` 一律使用 `starttime` tick，与快照同一单位。
  - `Young = { X | X.starttime ≥ T0 − 1 }`。
  - `Anc* = anc 中的身份集合 ∪ { 本命名空间 pid 1 的身份 }`。这里只做身份比较，**不要求存活**。
  - `d_self` = 调用者 `NSpid` 的项数。
- **分类 cls(X)**，对每个 X ∈ Young 求值，按以下次序取第一条命中的规则：

| 次序 | 条件 | cls(X) |
|---|---|---|
| 1 | `X.depth ≠ d_self`（X 处于嵌套的 pid 命名空间） | `cand(nested_ns)` |
| 2 | `X.ppid = 0`，或快照中没有 `X.ppid`，或 `snap[X.ppid].starttime > X.starttime` | `cand(parent_missing)` |
| 3 | `id(snap[X.ppid]) ∈ Anc*` | `cand(parent_in_R)` |
| 4 | `snap[X.ppid] ∈ Young` | `cls(父进程)`（带记忆化；出现环时为 `cand(cycle)`） |
| 5 | 其余情况：父进程较旧、在同一命名空间、且 ∉ `Anc*` | `excluded` |

- `Cand = { X ∈ Young | cls(X) = cand(·) }`
- `Cand = ∅` → **`proven_dead`**（证明时刻为 F1 的读取时刻）。
- `Cand ≠ ∅` → 与 v6 相同：所有候选的身份都出现在 `members` 或心跳的 `descendants` 中时为 `alive(Cand)`，否则为 `unknown(reparent_possible, Cand)`。
- 进程状态为 `Z` 时**按存活处理**。原因是线程组长退出后，如果其他线程仍在运行，它也显示为 `Z`；只看 `stat` 无法区分这种情况。

**可靠性依据**

前提：C1–C4 成立。信任边界是本机主线 Linux 内核的 procfs 语义，与 Windows 第一层信任 Job Object 的边界同级。

1. **完整：**F0 = F1，说明尝试期间没有创建任何任务，进程集合只会减少。`readdir("/proc")` 按 tgid 升序推进游标，所以在整个尝试期间都存在的进程一定会被列出。C2 排除了 `hidepid` 造成的隐藏，C3 排除了静默跳过。因此，**F1 时刻仍然存活的每个进程都在快照中。**
2. **父子关系为真：**每条 `ppid` 都是读取那一刻真实的父进程。尝试期间没有新进程，所以 pid 不可能被复用；`snap[ppid]` 要么就是那个父进程，要么不存在（父进程已退出，由规则 2 计为候选）。
3. **不漏判：**设 D 是 target 的一个历史后代，在 F1 时刻仍然存活。沿记录的父链向上走，每一步得到的父进程只可能是以下几类：
   - 另一个后代（属于 Young，由规则 4 继续向上）；
   - 父进程已退出（规则 2）；
   - 接管孤儿的 reaper。同一命名空间内的 reaper 只能是祖先 subreaper（身份 ∈ anc）、本命名空间的 init（∈ `Anc*`），或者子树内部的 subreaper（属于后代，由规则 4 继续向上）。
   - 进入嵌套命名空间的进程，其 reaper 可能是嵌套命名空间的 init，并且这个 init 的年龄任意。这类进程由规则 1 直接计为候选。
   
   所以，后代的父链永远不会落在规则 5 上，D ∈ Cand。
4. **稳定：**只有存活的后代才能产生新的后代；非后代也永远不会变成后代。所以，F1 时刻没有存活后代，此后也不会出现。
5. 规则 1 的代价是：在 target 之后由容器内进程派生的进程，都会被计为候选，结果偏保守。这一点在 N15′ 中披露。

### 1.3 3.3X：macOS、FreeBSD 及其他 POSIX（替换 v6 §3.3P 在这些平台下的规则）

- **第二层一律返回 `unknown(enum_unsupported)`。**
- **理由：**本设计范围内，在这些平台上还没有建立与 C2–C4 等价、并且语义有文档依据的“枚举完整 + 期间无创建”证明原语。v6 §3.3P 第 4 条（launchd 接管）只论证了“不漏判祖先接管”，没有论证枚举的完整性，因此不足以支持判空。
- **macOS 没有第一层**（没有 Job，也没有 subreaper）。所以在 macOS 上，任何需要终止证明的场景，**只能由第三层（重启）给出 `proven_dead`**。
- 将来如果要在这些平台提供第二层，必须作为单独的设计提交复核，不在本轮范围内。

### 1.4 W-ENUM：Windows 第二层快照来源（增补 v5 §3.3 第 1 步，一致性收紧）

3.3W 的依据（父链不会重新挂接）保持不变。但“扫描结果为空”同样需要完整性前提：

- **W-ENUM 要求：**一次调用就返回包含全部进程 `(pid, ppid, create_time)` 的快照，并且不按调用者权限过滤（候选来源：`NtQuerySystemInformation(SystemProcessInformation)`）。
- 逐个查询的 CIM/WMI 枚举、需要 `OpenProcess` 才能取得 `create_time` 的组合，都**不得**作为证明来源。
- 实现无法满足 W-ENUM，或者快照调用失败 → `unknown(enum_unstable)`。由 A1-12w 验证。

### 1.5 对已证明路径和受守护路径的影响（明确：不阻塞）

| 路径 | 是否经过第二层 | v7 的影响 |
|---|---|---|
| 受守护的 worker、merge job、CI job 正常结束（守护记录为 `drained`），或守护存活且 `query = 0` | 否（第一层） | 无 |
| 守护存活，`query > 0` → terminate → 重新证明 | 否 | 无 |
| 任务锁、MainWrite 锁被持有者正常释放 | 不需要证明 | 无 |
| 输入锁的 stale 接管 | 不需要证明（v6 §1.4 的理由不变） | 无 |
| 守护被杀，或没有守护记录（Linux） | 是 | C1–C4 满足时可能得到 `proven_dead`；否则为 `unknown`，可以用第三层 |
| 当前核心 `run`/`flow` 的 `exited` 记录（这类入口没有守护） | 是 | Windows 用 3.3W；Linux 按条件判定；macOS 要等到重启（N18） |
| macOS 上的任何崩溃恢复 | 第二层恒为 `unknown` | 只能重启（第三层） |

### 1.6 未通过时的处理（替换 v6 §3.5 中的 `unknown` 行）

| 结果 | 动作和提示 |
|---|---|
| `unknown(reparent_possible, Cand)` | 与 v6 相同：`E_PROCESS_LINGERING` → `blocked(integrity)`。列出 `candidates[{pid, proc_start, ppid, parent_image, cmdline, cwd, why}]`，其中 `why ∈ {parent_in_R, parent_missing, nested_ns, cycle}` |
| `unknown(enum_visibility)` | 提示：“进程枚举不完整（`/proc` 使用了 hidepid，或有进程不可读）。可以由管理员把 `/proc` 改为 `hidepid=0` 后执行 `recover sweep`，或者重启。” |
| `unknown(enum_unstable)` | 提示：“系统在扫描期间持续创建进程，无法得到稳定快照。可以稍后执行 `recover sweep`，或者重启。” |
| `unknown(enum_unsupported)` | 提示：“此平台无法在不重启的情况下证明进程已结束，请重启后重试。” |
| `unknown(no_ancestry)` / `unknown(pidns)` | 与 v6 相同 |
| 所有 `unknown` | **不提供人工放行开关**，不自动结束任何进程，没有新的 `call.start` |

### 1.7 反例、唯一恢复结果与验收（修订 A1-11b/d/f；新增 A1-12 系列）

**反例一：有效 `anc`，但后代没有被枚举（可见性）**

- **夹具：**Linux，`/proc` 以 `hidepid=2` 挂载。model M 由 setuid 夹具以另一个用户身份运行。守护进程 G、worker W 被杀，M 存活并继续写文件。
- **v6 的结论：**M 不可见，快照中没有 M，也没有读取错误 → Cand = ∅ → `proven_dead`。**这是错误结果。**
- **v7 的唯一结果：**C2 不满足 → `unknown(enum_visibility)` → `E_PROCESS_LINGERING`，没有新的 `call.start`。
- **恢复：**
  - 改为 `hidepid=0` 后执行 `recover sweep`：M 可见，父进程身份 ∈ `Anc*` → `unknown(reparent_possible, [M])`；用户结束 M，再执行 `recover sweep` → `proven_dead` → W1a；
  - 或者直接重启 → 第三层 → W1a。

**反例二：有效 `anc`，但后代没有被枚举（枚举期间 pid 回绕）**

- **夹具：**一个干净的 pid 命名空间。后代 D 的 pid 为 900。扫描游标经过 500 之后，D 通过 `ns_last_pid` 夹具派生出 pid 为 120 的 E，然后 D 退出。
- **单次扫描的结论：**120 已经被游标跳过，900 已经退出 → Cand = ∅。**这是错误结果。**
- **v7 的唯一结果：**F0 ≠ F1 → 重试。如果钩子在每次尝试中都注入同样的情况 → `unknown(enum_unstable)`。

**反例三：父子关系的读取不同时**

- **情形：**X 被读到时 `ppid = Y`（Y 属于 Young，是后代）。随后 Y 退出，X 被重新挂到 U ∈ R。Y 的 `stat` 读取得到 ENOENT。
- **v6 的结论：**X 的父进程 Y ∉ R → X 不是候选。**这是错误结果。**
- **v7 的唯一结果：**规则 2 → `cand(parent_missing)`。

**反例四：外部旧 subreaper 接管（v6 的 A1-11a，结论保持）以及嵌套命名空间的旧 init**

- **A1-11a：**U ∈ `Anc*` → `cand(parent_in_R)` → `unknown(reparent_possible, [M])`。
- **嵌套变体：**rootless 容器 C 在 target 之前启动。后代 P 进入 C 的 pid 命名空间，派生 Q；Q 再派生 R2，然后 Q 被杀。R2 被 C 的 init（较旧，∉ `Anc*`）接管。
  - **按 v6 规则：**R2 的父进程是较旧的非 R 进程 → 被排除。**这是错误结果。**
  - **v7 的唯一结果：**规则 1 → `cand(nested_ns)` → `unknown`。
- **恢复（各变体相同）：**结束列出的候选，然后执行 `recover sweep`。如果候选中有无法结束的无关进程（例如 `systemd --user` 下的服务，或容器内的服务）→ 重启。每次求值的结果都由当次快照唯一确定；只有得到 `proven_dead` 之后，才进入 v6 §2.2 的窗口表。

**验收**

| # | 注入 | 期望 |
|---|---|---|
| A1-11b（修订） | 接 A1-11a，在夹具 **ZL**（全新 pid 命名空间，`--mount-proc`，`hidepid=0`，没有其他晚于 W 的进程）中：用户结束 M，然后执行 `recover sweep` | 一次稳定的尝试 → Cand = ∅ → `proven_dead` → W1a |
| A1-11d（修订） | 同 A1-11a，并且 U 又启动了无关进程 N | `unknown([M, N])`；只结束 M → `unknown([N])`；重启之后 → `proven_dead` |
| A1-11f（修订） | macOS：model 两次 fork 之后被 launchd 接管 | `unknown(enum_unsupported)`（不进入候选判定）；重启之后 → `proven_dead` |
| A1-12a | 反例一 | `unknown(enum_visibility)`；断言：用 v6 规则重放同一份快照得到 `proven_dead`，**而这个结果没有被采用** |
| A1-12b | 反例二（每次尝试都注入） | 5 次尝试之后为 `unknown(enum_unstable)`；尝试次数和耗时写入 `recovery` 事件 |
| A1-12c | 反例三（用钩子让 Y 在 X 之后读取，并在两次读取之间退出） | X ∈ Cand，`why = parent_missing` |
| A1-12d | 反例四的嵌套变体 | R2 ∈ Cand，`why = nested_ns` |
| A1-12e | 容器内的 `/proc` 是宿主机的 procfs（bind mount） | C1 不满足 → `unknown(pidns)` |
| A1-12f | 在 ZL 中，守护和全部后代都已结束 | 第一次或某次重试稳定 → `proven_dead`（证明 Linux 第二层可以通过） |
| A1-12g | Linux 守护存活，`query = 0`；同时把枚举钩子设为“总是失败” | 第一层直接得到 `proven_dead`，没有调用第二层（证明第二层的收紧不阻塞受守护路径） |
| A1-12h | 后代的线程组长执行 `pthread_exit`，其余线程继续写文件 | 线程组长显示为 `Z`，按存活处理 → 候选 → 不为 `proven_dead` |
| A1-12i | 枚举中途某个 pid 的 `stat` 返回 EACCES | `unknown(enum_visibility)` |
| A1-12w | Windows：静态检查 3.3W 只使用满足 W-ENUM 的来源；动态注入“快照调用失败” | 静态检查通过；动态注入 → `unknown`，不是 pass |

---

## 2. S1 落地

### 2.1 裁决对照（替换 v6 §8.1）

| 裁决 | 落地 | 章节 |
|---|---|---|
| S1-1=A：运行期间不支持 L-foreign 写入 | 输入锁覆盖当前核心的全部写入者；L-foreign 被检测到时发出 `W_INPUT_FOREIGN`，写审计事件并提示；丢失无法检测，这一点写进文档 | §2.2–§2.4 |
| S1-1=A：不改 `inputs.mjs` | 锁加在 `agentline.mjs`（CLI 层）、CallGuard 和 adapter 包装层；`flow.mjs` 中只有 v6 已经授权的 runStep 参数 | §2.3 |
| S1-2=A：可证明的旧执行者保持非零或 `unknown` | (f)(g)(h)(i) 的规则不变 | v6 §4 |
| S1-2=A：未观测、无证据的执行者被排除，且必须明确写出 | D-EXCL 的定义、`coverage` 字段、drain 日志、界面文案、回滚日志 | §2.5、§2.6 |
| S1-B 和 A1-9l | **删除**。不保留为备选 | §3.3 |

### 2.2 输入锁原语（替换 v6 §1.4 的“锁”一条和 v5 §1.3 的短锁）

- **唯一名称：**`INPUT_LOCK(taskDir)` = `<C>/data/run/inputs-lock/<k>/`，其中 `k = sha256(norm(realpath(taskDir)))` 的前 16 位 hex（win32 下统一为小写）。
  - 放在机器本地的 `<C>` 下，而不放在任务目录或 `<B>` 下。这样，不知道 `<B>` 的当前核心 `run`/`flow` 也能找到同一把锁，而且不会在 OneDrive 同步的仓库中生成锁文件。
  - v6 的 `<B>/build/NNN/inputs.lock` 和 v5 的 `inputs.ledger.lock` 都作废。**一把输入锁同时保护 `inputs.jsonl` 和 `inputs.ledger.jsonl`。**
- **内容：**`{pid, proc_start, nonce, purpose, at}`。
  - `purpose ∈ {input, answer, run, flow, step, note, reconcile, stepend, adopt_initial}`
- **获取（L-ACQ）：**
  1. 把内容完整写入 `<dir>/t-<nonce>` 并 fsync。
  2. `link(t, <dir>/lock)`：成功即持有；EEXIST 进入第 3 步。
  3. 读取 `lock` 得到持有者 H：
     - H 的身份存活 → 等待（每 50 毫秒轮询一次）；
     - H 的身份已死 → 执行 L-REAP。
- **stale 接管（L-REAP）：**
  1. `link(t, <dir>/succ-<H.nonce>)` 认领。EEXIST 时，对认领文件的持有者递归执行同构的 L-REAP（认领名为 `succ-<H.nonce>.succ-<认领者 nonce>`）。
  2. 认领成功后**重新读取** `lock`。只有其中的 nonce 仍然是 `H.nonce` 时，才删除 `lock`；否则放弃接管。
  3. 删除认领文件，回到 L-ACQ 第 2 步。
  
  **互斥依据：**内容为 `H.nonce` 的 `lock` 只能被持有 `succ-<H.nonce>` 的一方删除；H 已死，不会再释放。所以，“认领之后重读”与“删除”之间，`lock` 不会被其他人改变。由于有重读这一步，过期的认领被清理之后也不会误删新的锁。
- **释放：**只删除 nonce 等于自己的 `lock`。
- **同一进程内可重入：**每个进程只有一个锁对象，带计数。
  - `suspend()` 要求计数 ≥ 1，保存计数，然后物理释放；
  - `resume()` 不设超时等待重新获取，然后恢复计数。
- **损坏：**正常持有者写入的内容总是完整的（先写完 tmp，再 link），所以 `lock` 读不出或无法解析，只可能来自外部篡改或磁盘错误：
  - worker 遇到时 → `E_INPUT_LOCK_CORRUPT` → `blocked(integrity)`；
  - `input`/`answer` 遇到时 → 同一个错误码，非零退出，不写任何内容；
  - `recover sweep` 删除损坏的锁，并写 `inputs.lock_corrupt_removed`。
- **锁次序（L-ORD）：**输入锁是最内层的锁。持有输入锁时，**不得阻塞等待**任何其他锁。非阻塞尝试允许，例如 `flow.mjs:91` 的 `acquireTaskLock`。
- **安装检查：**`<C>/data/run` 必须支持硬链接（`doctor` 检查）。不支持时报 `config` 错误。

### 2.3 持锁区段：当前核心的全部写入者（替换 v6 §1.4 的持锁区间表和 L-cur 行）

**区段模型：**正在执行 `executeRole` 的进程**整段持有**输入锁，**只在 `adapter.run` 期间让出**。所以 `exec.mjs:130` 读取 pending、`runFlow` 的 note 写入、`exec.mjs:199` 的 `markConsumed`，都在锁内执行；耗时最长的模型运行阶段不持锁。

| 写入者 | 获取 | 让出与恢复 | 释放点（含异常） |
|---|---|---|---|
| **当前核心 `run`**（`agentline.mjs` 中的 `cmdRun`） | 定位任务目录之后、调用 `executeRole` 之前获取，`purpose: run`；等待最多 60 秒，超时 → `E_INPUT_BUSY`，退出码为 1，不调用模型 | 向 `executeRole` 传入 `adapterFactory = p => wrapInputLock(getAdapter(p))`。包装层的 `run`：`suspend()` → 调用原 `run` → 在 `finally` 中 `resume()` | `executeRole` 返回或抛出之后，在 `finally` 中释放，然后才调用 `process.exit`。另外注册 `process.on('exit')` 作为兜底，处理 Ctrl-C；被 kill -9 时依靠 L-REAP |
| **当前核心 `flow`**（`agentline.mjs` 中的 `cmdFlow`） | 调用 `runFlow` 之前获取，`purpose: flow` | 用 `runFlow` 已有的 `adapterFactory` 参数传入同一个包装层。`flow.mjs:304` 的 `appendInput` 处于锁内 | `runFlow` 返回或抛出之后，在 `finally` 中释放；`exit` 兜底同上。**`flow.mjs` 不做任何修改** |
| **runStep 的 role 步骤**（Build worker） | 进入 runStep 时获取，`purpose: step`；在同一个进程中，P1b 之后重入 | CallGuard 包装：beforeCall（B-ADOPT、I-IN、`call.start`）**在锁内执行** → `suspend()` → 调用原 `run` → afterCall（archive、`call.end`）→ `resume()` → 返回 exec | runStep 返回或抛出时释放。**v6 的“P6 窗口”规则由本行取代** |
| P1b（S-NOTE） | Supervisor 获取，`purpose: note` | — | 写入并 fsync `input.append` 之后释放（如果随后进入 runStep，就改为重入） |
| P2（`systemInputs`） | 在 runStep 区段内 | — | 同 runStep |
| 对账（`reconcileInputs`） | Supervisor 获取，`purpose: reconcile`；runStep 重入 | — | 写完 `inputs.reconcile` 之后释放 |
| `step.end` 的 `inputs_consumed` 计算，以及附带的 adopt | Supervisor 获取，`purpose: stepend` | — | 写完 `step.end` 之后释放 |
| `build start` 的初始 adopt | `purpose: adopt_initial` | — | 写完 `input.adopt{phase: initial}` 之后释放 |
| **新版 `input` / `answer`** | 获取，`purpose: input`/`answer`；等待最多 60 秒 | — | 在锁内执行 `appendInput` → 写 `input.append` 并 fsync（只有 Build 任务需要写，其他任务没有输入账本）→ 释放 → **之后**才报告成功。超时 → `E_INPUT_BUSY{holder: {purpose, pid, since}}`，退出码为 1，不写任何内容 |

- **resume 的等待：**worker 和 `run`/`flow` 在 `resume()` 中不设超时。其他持有者的临界区是有界的：`input` 只做追加和 fsync；另一个 `run`/`flow` 的持锁段不含模型运行。等待超过 60 秒时，写入 `attention{kind: input_lock_wait, holder}`，界面显示这条提示，但不破坏一个仍然存活的持锁者。
- **非 Build 任务**（用 `run`/`flow` 直接执行的旧任务）只取锁，不写输入账本；它们的行为与原来相同。
- **静态约束：**
  - 代码中调用 `appendInput` 和 `markConsumed` 的位置，都必须处于输入锁的作用域内（检查 `agentline.mjs` 和 Supervisor）；
  - `cmdRun`、`cmdFlow` 必须传入经过 `wrapInputLock` 包装的 `adapterFactory`；
  - 禁止用 `lock.mjs` 的 `acquireLock` 实现输入锁。

### 2.4 L-foreign：运行期间不受支持，检测、提示与审计（替换 v6 §1.4 的 L-foreign 行）

**定义：**不持输入锁写入 `inputs.jsonl` 的写入者，包括其他旧核心副本、脚本、编辑器，以及直接改文件的模型或进程。

| 时段 | 支持级别 | 系统行为 |
|---|---|---|
| 任务空闲（blocked、awaiting、已停止） | **支持** | 在下一个边界由对账 adopt（A1-9h）。`during_run: false`，不发警告 |
| worker 或 `run`/`flow` 运行期间 | **不支持** | 写入可能被 `markConsumed` 或对账的 rename **静默吞掉**；被吞掉的内容**无法检测**。没有被吞掉、并且在下一个持锁边界被发现的条目，按 §3.1 处理（pending → adopt），同时发出 `W_INPUT_FOREIGN` |

**检测点：**B-ADOPT（`phase: precall`）、`stepend`、worker 启动之后的非首次对账（`phase: reconcile`，`during_run: true`）。

**检测到时的动作**

- **审计：**
  - 输入账本中的 `input.adopt` 增加字段 `foreign: true, during_run: true|false`；
  - ledger 中写 `inputs.foreign {phase, call_id?, ids_added[], ids_missing[], file_sha256, during_run}`，ikey 为 `foreign:<file_sha256>:<phase>:<call_id|->`。其中 `ids_missing` 是 `K_auth` 中有、文件中缺失的 id；在运行期间，当前核心不会造成这种缺失，所以这也是外部改写的证据。缺失的条目照常 `restore`。
- **提示：**写入 `attention{kind: input_foreign}`，Host 和 slash 显示以下文案：
  > 检测到运行期间有不经 agentline 的方式写入了输入（编辑器、脚本或其他 agentline 副本）。这些条目已被收录，但运行期间的此类写入不受支持，**可能已有其他条目丢失且无法检测**。请只通过 `agentline input` / `answer`（CLI、插件、slash）提交输入。
  
  这条提示不阻塞运行。
- **错误码：**`W_INPUT_FOREIGN` 是警告，不改变退出码，也不进入 `blocked`。以下情形仍按原来的阻塞规则处理：consumed 状态的外部条目 → `G_INPUT_UNRECONCILED`；`in-sys-` 开头的外部条目 → `E_LEDGER_ORDER`。
- **文档与帮助：**`agentline input --help`、`docs` 的输入章节，以及插件“提交输入”面板的说明文字，都写入：“运行期间只支持通过当前 agentline 提交输入；直接编辑 `inputs.jsonl` 或使用其他 agentline 副本，可能导致输入丢失。”
- **分类局限（写入文档）：**在上一次运行期间发生、直到 resume 后的首次对账才被发现的写入，会被归类为 `during_run: false`。检测是尽力而为的审计，**不是保证**。

### 2.5 D-EXCL：drain 保证的显式排除（新增，落实 S1-2=A）

- **保证范围：**能被 (a)(b)(c)(e)(f)(g)(h)(i) 中任一来源计数的执行者，在得到 `proven_dead` 之前，保持非零或 `unknown`（v6 §4 不变）。
- **排除集合 D-EXCL：**同时满足以下全部条件的执行者 X：
  - **x1：**不是由当前核心启动的（没有准入记录，也没有 procs 记录）；
  - **x2：**从未被任何一次 (f) 枚举观测到，因此没有 (g) 记录；
  - **x3：**没有留下 (h) 可识别的残留证据（`live.json`、没有 `proc_start` 的旧格式锁或 registry 条目）；
  - **x4：**不受 (i) 覆盖，也就是在升级屏障已经 `verified` 之后启动，或者属于全新安装。升级前启动的进程**不会**落入 D-EXCL。
  
  **典型例子：**
  - 升级并重启之后，另一个旧核心副本在两次 `drain status` 之间启动又退出，没有留下 `live.json`，它派生的后台进程仍然存活；
  - 入口文件名不在 `ENTRYPOINTS` 中的 agentline 副本；
  - 不经过 agentline、直接运行模型 CLI 或脚本的执行者（这类执行者从来不在范围内，这里一并写明）。
- **结论表述：**`drain status = 0` 的含义是“**保证范围内**没有执行者”，不是“机器上没有任何写仓库的进程”。

### 2.6 drain 的日志与界面披露（增补 v6 §4.2 和 v5 §5.1）

- **`drain status --json`** 增加一个固定字段，在结果为 0、n 或 `unknown` 时都输出：
  ```
  "coverage": {"excluded": ["unobserved_foreign_executor"], "rule": "D-EXCL", "since_upgrade_verified": <bool>}
  ```
- **文本输出的最后一行固定为：**
  > 范围说明：未被观测、且没有残留证据的外部执行者（非当前核心启动）不在统计范围内（D-EXCL）。
- **(g) 记录**增加字段 `class: pre_upgrade|foreign`。如果 `first_seen` 早于 `upgrade.json.installed_at`，或者升级屏障还没有 `verified`，则为 `pre_upgrade`，否则为 `foreign`。
- **drain 日志：**`<C>/data/run/drain.log`（jsonl，只追加）。每次执行 `drain status` 写一条 `{at, result, sources, coverage}`。首次观测到 `class = foreign` 的入口时，追加 `foreign_observed{pid, proc_start, cmdline}`。这个文件加入 v6 §4.2 中“`drain status` 只写这些位置”的列表。
- **界面：**
  - 运维面板中 drain 的结果显示为“0（范围：D-EXCL ⓘ）”，提示框中给出 §2.5 的定义；
  - 出现 `foreign_observed` 时，显示“检测到不属于当前核心的 agentline 入口：<cmdline>”。
- **回滚脚本：**两次 `drain status` 都把 `coverage` 原样写入回滚日志。这只是披露，**不增加放行开关**，也不需要额外确认。
- **(f) 在 Linux 上的可见性（增补 v5 §5.1 的 `unknown` 条件）：**`/proc` 不满足 §1.2 的 C2 时，(f) 返回 `unknown(enum_visibility)`。理由与 v5 A6-13 相同：看不见，不等于没有。

### 2.7 工作流同步（替换 v6 §7 中的 W7a、W7p、W16）

| 工作流 | 内容 |
|---|---|
| **W7a** | 输入锁原语（L-ACQ、L-REAP、重入、`suspend`/`resume`、L-ORD、损坏处理）；`INPUT_LOCK` 的路径；`cmdRun`、`cmdFlow` 的包裹与 `wrapInputLock`；CallGuard 的让出与恢复；新版 `input`/`answer` 持锁；P1b、`systemInputs`、B-ADOPT 和 §3.1 的判定次序；`C_init`；`W_INPUT_FOREIGN`、`inputs.foreign`、`input_foreign` attention 和文案；`archiveCall(kind)`、`calls-late`、W1b-L、W1e。**删除** `input.intent`、S1-B 和 `inputs.mjs` 的改造项 |
| **W7p** | 3.3L 的 C1–C4、分类规则 1–5、重试参数；3.3X 恒为 `unknown(enum_unsupported)`；W-ENUM；`anc` 和 `pidns` 的记录（统一使用 `starttime` tick）；`members` 快照；§1.6 的提示文案 |
| **W16** | 执行者记录的 `exited` 状态和删除条件；(g)(h)(i)，以及 (g) 的 `class`；`coverage` 字段、文本中的范围说明行、`drain.log`、`foreign_observed`；(f) 的 Linux 可见性条件；回滚日志中的 `coverage`；规程 U1–U3；夹具 Z（§3.2） |
| 依赖 | W7a 依赖 W7p 中的 `proc-identity`（锁的身份判定）。W16 依赖 W7p 中的证明。W7a 和 W16 之间没有依赖 |

**影响面：**S1 已经裁决，W7a 不再有等待项。所有工作流都可以进入切分。

### 2.8 S1 的验收（删除 A1-9l；新增 A1-13 系列和 A6-19 系列）

**验收边界：**L-foreign 在运行期间的写入属于“**不保证**”的行为。验收**只断言**以下几点：检测到时的审计与提示；不出现完整性误报；不出现“报告成功但内容丢失”。**不断言**这类写入一定保留，也不断言它们一定被检测到。

| # | 注入 | 期望 |
|---|---|---|
| A1-13a | **L-cur `run`：**用 fs 钩子让 `cmdRun` 中的 `markConsumed` 暂停在“整读”与 rename 之间，同时执行 `agentline input --text Y` | `input` 在等锁（钩子放行之前，Y 不在文件中）；放行后 Y 写入文件，`input` 退出码为 0；下一次 `run` 的提示词包含 Y |
| A1-13b | **L-cur `flow`：**在 `flow.mjs:304` 写入 `WRITE_SCOPE_NOTE` 的同时，并发执行 `input` | 两行都在文件中；没有重复，也没有丢失 |
| A1-13c | `run` 处于 `adapter.run` 期间时执行 `input` | 1 秒内成功（锁已让出）；当前调用的 `markConsumed` 不标记 Y |
| A1-13d | 当前核心 `flow` 持锁执行一个超过 60 秒的 CI 段时，执行 `input` | `E_INPUT_BUSY{holder.purpose = flow}`，退出码为 1，文件和账本都没有变化 |
| A1-13e | 持锁的 `run` 被 kill -9 之后，两个 `input` 并发接管 | 恰好一方先持有锁，两条输入都写入；用夹具计数器断言任意时刻至多 1 个持有者；`succ-*` 认领文件最终被清理 |
| A1-13f | `executeRole` 抛出异常；另一个用例中进程被 Ctrl-C 中断 | 进程退出之后 `lock` 不存在 |
| A1-13g | 锁的内容被改成非 JSON | worker 进入 `E_INPUT_LOCK_CORRUPT` → `blocked(integrity)`；`input` 报同一个错误码；执行 `recover sweep` 之后可以继续 |
| A1-13h | **L-foreign 写在让出窗口内：**在 `adapter.run` 期间，不取锁直接追加 pending 条目 Z | 下一次 B-ADOPT：`input.adopt{phase: precall, foreign: true, during_run: true}`、`inputs.foreign`、`attention{input_foreign}`；I-IN 通过；下一次调用包含 Z |
| A1-13i | **L-foreign 写在持锁窗口内（不保证用例）：**`markConsumed` 暂停时，不取锁直接追加 Z | **只断言**：没有 `G_INPUT_UNRECONCILED`，任务继续；Z 被保留时，结果同 A1-13h；Z 丢失时，系统中没有任何关于 Z 的“成功”记录 |
| A1-13j | 任务运行期间，外部截断文件，删掉一条已在 `K_auth` 中的条目 | `restore`；`inputs.foreign.ids_missing` 包含该 id；`attention{input_foreign}` |
| A1-13k | 静态检查 | §2.3 的三条静态约束都通过 |
| A6-19a | 分别构造结果为 0、n 和 `unknown` 的 `drain status` | JSON 中都有 `coverage`，文本中都有范围说明行；`drain.log` 中各有 1 条记录 |
| A6-19b | 升级并重启之后，用另一路径下的旧核心副本执行 `run`（运行期间执行 `drain status`） | (f) ≥ 1；(g) 记录的 `class = foreign`；`drain.log` 有 `foreign_observed`；界面显示提示 |
| A6-19c | **D-EXCL 的边界：**升级并重启之后，一个外部脚本派生出 detached 的写入进程后退出，两次 `drain status` 之间没有观测，也没有残留证据 | 结果为 `0`，并带有 `coverage` 范围说明。**这是被明确排除的情形，不是缺陷** |
| A6-19d | 同 A6-19c，但脚本在升级之前启动 | (i) 为 `unknown(pre_upgrade)`，直到重启（**不**落入 D-EXCL） |

---

## 3. Minor

### 3.1 文件中有、账本中没有的条目：统一判定次序（替换 v6 §1.5 的 B-ADOPT 表和对账表的对应行）

适用于所有 adopt 阶段：`initial`、`precall`、`stepend`、`reconcile`。**先在持锁状态下读完并判定整个文件，再写入**；只要命中阻塞项，这一轮就不写任何 adopt 事件。

| 次序 | 条件 | 结果 |
|---|---|---|
| 1 | 输入账本缺失或无法解析 | `E_INPUT_LEDGER_MISSING` |
| 2 | 同一个 id 的 `content_sha256` 不同 | `E_INPUT_TAMPERED` |
| 3 | **id ∉ `K_auth`，并且以 `in-sys-` 开头** | **`E_LEDGER_ORDER`，适用于全部阶段，优先于任何 adopt** |
| 4 | id ∉ `K_auth`，状态为 consumed | `precall`、`stepend` 阶段 → `G_INPUT_UNRECONCILED`；`reconcile` 阶段 → adopt 之后执行 `set_pending`（v6 §1.6）；`initial` 阶段 → adopt，计入 `C_init` |
| 5 | id ∉ `K_auth`，状态为 pending | 写 adopt；在运行期间被发现时，附加 `foreign` 标记（§2.4） |
| 6 | id ∈ `K_auth`，文件中缺失 | `restore` |
| 7 | 状态与 `C_auth` 不一致 | `set_pending` 或 `set_consumed` |

- 新增 **A1-9m**：在 `reconcile` 阶段和 `initial` 阶段，文件中各放一条账本中没有的 `in-sys-` 条目。两种情况都返回 `E_LEDGER_ORDER`；输入账本中没有新的 `input.adopt`；文件不被改写。

### 3.2 清零验收的夹具 Z（修订 v6 A6-15b–e 和 A6-16、A6-17 中的“结果为 0”）

- **Z1：**断言之前，除被测来源以外，(a)(b)(c)(e)(f)(h)(i) 都为空，并且没有尚未清除的屏障。
- **Z2（对照证明）：**在**同一个快照**中，同时对一个对照 target 求证明。对照 target 在被测进程之后启动，自身从未派生子进程，并且已经退出。
  - 对照结果不是 `proven_dead` → 本用例判为 **`inconclusive(env)`**，换到隔离环境重跑：Linux 使用 ZL，Windows 使用 CI VM；
  - `inconclusive` **不计为 pass**。
- **Z3：**Linux 用例在 ZL 中运行；macOS 不运行清零用例（按 §1.3，结果恒为 `unknown`，由 A1-11f 覆盖）。
- 在 Z1–Z3 成立的前提下，“结束后为 0”是**强制断言**。这与 N15′ 和 N17 中“可以保守返回 `unknown`”的规则不冲突，因为夹具已经排除了产生保守结果的环境因素。

### 3.3 合并稿清理清单（增补 v6 §5.3，审核时逐项 grep）

**S1**
- “S1（需要用户裁决）”“S1-B”“选项 B”“A1-9l”“`inputs.mjs` 的 append-only 改造”；
- v6 §8.1 中“只有 W7a 的输入部分需要等待”；
- “旧版 CLI 或手工写入的条目由对账时 adopt”这一类没有区分运行期间与空闲期的表述；
- “(f) 覆盖旧 `cmdRun` 生命周期的任意时刻”。必须加上 D-EXCL 的限定，或者删除。

**锁**
- `<B>/build/NNN/inputs.lock`、`inputs.ledger.lock`，统一改为 `INPUT_LOCK(taskDir)`；
- v6 中“CallGuard 在 afterCall 的末尾取锁……先到的那个释放”，改为 §2.3 的区段模型；
- “stale 判定：持有者的 `(pid, proc_start)` 已经不存在，就可以接管”，补上 L-REAP。

**终止证明**
- v6 §3.3P 第 1 步“读取全量快照”和第 6 步“`Cand = ∅ → proven_dead`”的无条件写法；
- “POSIX（Linux、macOS 及其他）”合在一节的写法，改为分成 3.3L 和 3.3X；
- “macOS……同样成立”（v6 §3.3P 依据第 4 条），删除，或者改为“仅说明不漏判祖先接管，不构成判空依据”。

**继承自 v6、仍须执行的项**
- `recording` phase；
- 命令 ID 满足 R1 或出现在别名表中（v7 没有新增命令 ID，`input`/`answer` 的 id 不变）；
- 错误码总表（加上本文 §4）；
- D1 的统一表述：只保留“D1：decisions.md 的 **A ＝ 授权 K1**”；
- 裁决的表述统一为“S1：**S1-1=A、S1-2=A**”。

---

## 4. 命令、错误码、事件的增量（相对 v6 §6）

| 类别 | 变更 |
|---|---|
| 命令 | 没有新增命令。`input`/`answer`/`run`/`flow` 持输入锁（command id 不变）；`recover sweep` 增加删除损坏输入锁的动作 |
| 错误码 | **`E_INPUT_BUSY`**：退出码为 1；UI 类别为 `input`；不进入 `blocked`；载荷 `{holder: {purpose, pid, since}}`。<br>**`E_INPUT_LOCK_CORRUPT`**：退出码为 97；UI 类别为 `integrity`；worker 进入 `blocked(integrity)`。<br>**`W_INPUT_FOREIGN`**：警告，不改变退出码；UI 类别为 `input`；不进入 `blocked` |
| `unknown` 原因 | `E_PROCESS_LINGERING.reason` 和 `drain status` 的 `unknown` 原因新增 `enum_visibility`、`enum_unstable`、`enum_unsupported`；`candidates[].why ∈ {parent_in_R, parent_missing, nested_ns, cycle}` |
| 事件 | `input.adopt` 增加 `foreign`、`during_run`；ledger 新增 `inputs.foreign`、`inputs.lock_corrupt_removed`；`recovery` 事件增加 `enum_attempts`、`enum_ms` |
| 记录 | `INPUT_LOCK` 目录（`lock`、`t-*`、`succ-*`）；(g) 增加 `class`；`drain status` 增加 `coverage`；新增 `<C>/data/run/drain.log` |
| attention | 新增 `input_lock_wait`、`input_foreign` |
| 内核文件 | **没有变化**：`flow.mjs` 只有 v6 已经授权的 runStep 参数；`exec.mjs`、`inputs.mjs` 不改 |

> 退出码 97 沿用 v5 中 G 类和 integrity 类的退出码；退出码 1 沿用 `cmdRun` 和 `fail()` 的一般失败码。如果合并稿的错误码总表另有编排，以总表为准，但必须保持“`E_INPUT_BUSY` 可重试、不阻塞；`E_INPUT_LOCK_CORRUPT` 进入 integrity”这两条语义。

---

## 5. 用户裁决与知会

### 5.1 新的用户裁决

**无。**

- B6-2 属于正确性收口：证明不了就返回 `unknown`，不缩小 decisions.md 中的任何承诺。decisions.md 没有对平台作出承诺，3.3X 只是收回了 v6 中“macOS 同样成立”这一处错误论证。
- S1 已经裁决，本文件只做落地。
- 将来如果要在 macOS 上实现“不重启也能证明”，需要提出新的设计，而不是在本轮裁决。

### 5.2 知会项（不需要裁决）

- **N15′（替换 N15）：**
  - **Linux** 在没有守护时，第二层能否给出结论，取决于 `hidepid`、命名空间、容器，以及系统创建进程的频率。在桌面系统和容器密集的主机上，`unknown` 很常见，实际的恢复手段通常是重启。
  - **macOS 及其他 POSIX：**第二层恒为 `unknown`。
  - 受守护的路径不受影响（§1.5）。没有任何人工放行开关。
- **N18：**在 macOS 上，任何崩溃恢复都要重启；当前核心 `run`/`flow` 的 drain 记录，也要等重启之后才能清除。在 Linux 上，这类记录能否清除取决于 C1–C4。
- **N19：**当前核心的 `flow` 在 CI 和 git 段落中持有输入锁。这时执行 `input` 可能返回 `E_INPUT_BUSY`，需要重试。Build 路径（runStep）的 CI 步骤不持锁，所以不受影响。
- **N20：**运行期间直接编辑 `inputs.jsonl`，或者使用其他 agentline 副本写入输入，可能**静默丢失**内容。检测到的部分会给出提示，但检测不保证完整（S1-1=A）。
- **N21：**`drain status = 0` 的含义受 D-EXCL 限定（S1-2=A）。

---

## 6. 最终复核检查清单（增补 v6 §9）

| # | 检查项 | 依据 |
|---|---|---|
| 31 | Linux 第二层的 `proven_dead` 以 C1–C4 全部满足为前提；任一不满足时返回指定的 `unknown` 原因；不存在“扫描没有报错就判空”的路径 | §1.2、A1-12a/b/e/i |
| 32 | 候选分类覆盖父进程缺失、嵌套命名空间、环三种情形；可靠性依据的第 1–4 步逐步成立；反例一到四各有唯一结果和恢复路径 | §1.2、§1.7 |
| 33 | macOS 及其他 POSIX 的第二层恒为 `unknown`，并已明确写出；受守护和已证明的路径不经过第二层（A1-12g） | §1.3、§1.5 |
| 34 | Windows 第二层的快照来源受 W-ENUM 约束 | §1.4、A1-12w |
| 35 | 输入锁的唯一名称，以及 L-ACQ、L-REAP 的互斥依据；锁次序 L-ORD；当前核心 `run`/`flow` 的包裹点和全部释放点；`runFlow` 自身写入的 note 处于锁内；内核文件没有超出 K1 的改动 | §2.2、§2.3、A1-13a–g、A1-13k |
| 36 | L-foreign 在运行期间不受支持，并有明确的错误码、提示、审计和文档文案；验收没有对“不保证”的行为作出保留断言 | §2.4、§2.8、A1-13h–j |
| 37 | D-EXCL 有精确定义（x1–x4）；`coverage` 字段、范围说明行、`drain.log`、界面和回滚日志都有披露；升级前启动的进程不会落入 D-EXCL | §2.5、§2.6、A6-19a–d |
| 38 | W7a、W7p、W16 的内容与依赖已经同步；S1-B 和 A1-9l 已删除；所有工作流都可以进入切分 | §2.7、§3.3 |
| 39 | `in-sys-` 检查在全部 adopt 阶段都优先于 adopt；判定先读完整个文件再写入 | §3.1、A1-9m |
| 40 | 清零断言带有夹具 Z 和对照证明；`inconclusive` 不计为 pass | §3.2 |

---

## 7. 流程（替换 v6 §8.3）

本文件连同 v1–v6，提交 **GPT-6 Astra 做最终契约复核**。复核时按 v4 §11、v5 §11、v6 §9 和本文 §6 逐项检查。

- **APPROVE：**
  1. 按 v4 §0.2、v5 §0.2、v6 §0.2 和本文 §0.2 拼装单一合并稿；
  2. 执行 v4 §7.4、v5 §7.3、v6 §5.3 和本文 §3.3 的 grep 清理，并把错误码总表并入本文 §4；
  3. **进入实现切分**（v3 §9.2 + v4 §9 + v5 §9 + v6 §7 + 本文 §2.7）。不再有等待裁决的工作流。
- **REVISE：**不再开新一轮设计。把未关闭项逐条交给用户，由用户选择“局部修补”或“缩小范围”。不能用人工放行代替终止证明。
