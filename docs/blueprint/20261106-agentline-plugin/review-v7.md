# AgentLine Blueprint 20261106 — Review v7

## Verdict

**REVISE**

S1 的用户决定、W7a/W16 和保证范围披露已同步；reserved ID 优先级已关闭。但 **B6-2 仍存在可导致错误判空的反例**，并新增两处恢复正确性缺口。

以下均可局部修补，不需要新架构，也不需要重裁 S1／D1–D4。本次为静态契约与相关源码复核，未修改文件，未将验收表视为已经通过的测试。

## Blocking

### B7-1：B6-2 未关闭——C2 对 `hidepid=4` 的组豁免判断不成立

[v7 C2](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v7-contract.md:74) 允许调用者属于挂载的 `gid=` 时通过可见性检查。

但 Linux 的 `has_pid_permissions()` 在 `hidepid=4` 时直接返回 ptrace 权限检查结果，**不会走后面的组豁免分支**；枚举会静默跳过不满足权限的进程。[Linux v6.12 实现](https://github.com/torvalds/linux/blob/v6.12/fs/proc/base.c#L701-L716)

因此可以构造：

- 有效 `anc`，调用者属于 `gid=`；
- 后代 M 存活，但不可 ptrace，因此未被枚举；
- 已枚举项全部可读，扫描期间没有创建进程；
- 按 v7，C1–C4 通过，仍可能得到 `Cand = ∅ → proven_dead`。

这也影响直接复用 C2 的 drain 来源 (f)。

**关闭条件：**按实际 `hidepid` 模式区分可见性条件；`hidepid=4` 不能仅凭组成员身份通过。无法证明完整可见性时返回 `unknown(enum_visibility)`。补充“匹配 gid、仍有隐藏后代”的验收，同时覆盖第二层证明和 (f)。

### B7-2：`proc_start` 改为 tick，但第三层仍按绝对时间比较

[v7 §1.2](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v7-contract.md:91) 令 `T0 = target.proc_start`，与 `starttime` tick 比较，并要求祖先记录使用同一单位；但仍保留 [v6 §3.4](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v6-contract.md:307) 的“本次开机时间晚于 `target.proc_start` → `proven_dead`”。

Linux `starttime` 是**本次开机后的 tick 数**，不是绝对创建时间，不能直接与开机时间比较。[Linux 手册](https://www.man7.org/linux/man-pages/man5/proc_pid_stat.5.html)

合并后的契约因此不能唯一实现：按 tick 保存会破坏第三层比较；按绝对时间保存又不满足第二层公式。前者可能让同一次开机中的 `unknown` 被第三层错误放行。

**关闭条件：**明确持久化身份、tick 和跨开机证明各自的字段及时间基准，统一三层使用方式；缺失必要信息时保持 `unknown`。补充“同一 boot 不得由第三层放行”和“重启后正确放行”的验收。

### B7-3：损坏输入锁被直接删除，绕过了互斥前提

[v7 §2.2](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v7-contract.md:250) 规定 `recover sweep` 删除损坏的输入锁，但没有要求先排除仍处于临界区的持锁者。

“锁内容无法解析”不等于“持锁进程已经退出”。例如原写者暂停在读写窗口中，锁内容损坏；sweep 删除后，第二个写者成功取锁，原写者恢复，便出现两个写者。L-REAP 的“确认身份已死、认领后重读”证明不能覆盖这个分支。

**关闭条件：**损坏锁的清理必须有明确的排他恢复条件，保证没有仍可继续写入的原持有者，并防止并发恢复误删新锁；无法建立条件时保持阻塞。A1-13g 应增加“锁损坏但原持有者仍存活”的反例。

## Major

**无独立新增 Major。**

M4 的退出记录保留和范围定义可以保留；安全清除仍依赖 B7-1、B7-2。输入锁的正常持锁区段已明确，但整体正确性仍依赖 B7-3。

## Minor

以下为**实现前契约整理**，不单独阻塞：

- **清零夹具仍需限定被测 target 的候选集合。**Z2 的对照 target 启动更晚，其证明成功不能排除“晚于被测 target、早于对照 target”的无关候选。Windows 用例尤其应显式排除这些候选；Linux ZL 还应说明扫描者的启动时机。[v7 §3.2](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v7-contract.md:388)
- **L-cur 接入补齐边界。**`cmdFlow` 必须锁住最终实际写入的任务目录，覆盖首次创建 worktree 的路径；现有 `runFlow` 会在内部改变 `runDir`。此外，Ctrl-C 清理不能只依赖 `exit` 监听，需明确信号处理与同步释放。[现有目录定位](/C:/git/dsh-Agentline/orchestrator/lib/flow.mjs:78)、[Node.js 退出与信号语义](https://nodejs.org/api/process.html)
- **统一表限定状态修正时机。**§3.1 第 6、7 行应明确与 `step.end.inputs_consumed` 采集的先后关系，避免在记录本次消费前将 consumed 重置为 pending；A1-13h 的审计阶段也应与实际首次发现边界一致。[v7 §3.1](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v7-contract.md:372)
- **单一合并稿尚待实际生成和清理。**替换清单已经具体，但“有清单”不等于“清理已完成”。统一锁名、`recording`、命令 ID、错误码、D1 字母及 A3/A3L 后，才能作为实现基线。

## Review-v6 逐项核对

| 项目 | 结论 | 核对结果 |
|---|---|---|
| B6-1：S1 未裁决 | **已关闭** | S1-1=A、S1-2=A 已落盘；不再需要范围裁决。 |
| W7a／W16／验收边界 | **已同步** | 输入兼容、D-EXCL、coverage、日志及回滚披露均已进入工作流和验收。 |
| B6-2：枚举完整性 | **未关闭** | 平台拆分和保守返回方向正确，但 C2 存在 B7-1 反例。 |
| L-cur 输入锁 | **部分关闭** | run／flow、note、返回及异常路径已明确；新增损坏锁恢复缺口见 B7-3。 |
| reserved ID 优先级 | **已关闭** | 全部 adopt 阶段先检查 `in-sys-`，阻塞时不写 adopt；A1-9m 已覆盖。 |
| 清零验收夹具 | **部分关闭，待整理** | 已明确 `inconclusive` 不算 pass；还需排除被测 target 的其他候选。 |
| 合并稿清理 | **方案明确，尚未完成** | 属于实现前契约整理，不独立构成阻塞。 |
| 系统 note、晚到归档、`C_init`、K/T、D3 | **保持关闭** | 本轮未发现这些已关闭契约被实质改变。 |

## 新引入的问题

新增正确性问题为 **B7-2 的时间基准冲突**和 **B7-3 的损坏锁恢复旁路**；B7-1 是 B6-2 的延续。

未发现需要新架构的依赖环或未授权的产品范围扩张。macOS 第二层返回 `unknown`、Windows W-ENUM、输入锁和 drain 披露，均属于现有保证的局部明确化。

## 是否可进入实现切分

**no，暂不能整体进入正式实现切分。**

前置条件：

1. 局部关闭 B7-1、B7-2、B7-3，并明确对应反例的唯一结果。
2. 完成上述实现前契约整理，生成单一合并基线。

已关闭的架构、UX、归档、K/T 和用户裁决继续有效，无需重新设计。

## 仍需用户裁决的问题

**无新增产品范围裁决。**

S1／D1–D4 不重裁。上述阻塞项属于正确性修补，不能通过人工放行替代证明或互斥条件。