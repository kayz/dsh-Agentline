# AgentLine Blueprint 20261106 — Review v4

## Verdict

**REVISE**

v4 已关闭 B5 和 M3/M5 的原问题，也消除了 B4 的正常合并校验循环；但 **B1 的恢复契约、B4 的事务恢复与缓存边界仍未闭合，M4 仍可能误报零运行，D3 尚未贯通调度与 gate**。

这些包含可复现的契约矛盾，不能全部归为实现细节。需要局部契约修补，不需要重新讨论范式或重写整体设计。

本次依据六份指定文档合并审核，并静态核对相关源码；未修改文件、未执行产品流程。仓库没有 `scripts/check-fast.ps1`。

## Blocking

### B1．部分关闭：输入恢复依据不存在，仍有未覆盖的崩溃窗口

**1. `rebindInputs` 依赖被留存契约排除的 Git 内容。**

v4 要求从 `HEAD:<path>` 读取 `inputs.jsonl` 的 pending 状态，并称 amendment 随步骤提交消费。但 v2 明确将该文件归为 B 级、加入 gitignore；对于符合留存规则的新任务，HEAD 中根本没有该文件。实际 `markConsumed` 又发生在步骤提交之前。

因此，“输入已经消费、步骤尚未提交”时，当前恢复条件无法恢复 amendment，A1-7e 的承诺不成立。不能通过把用户原文重新纳入 Git 来默默解决，否则改变 Q6。[v4 输入恢复](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:84)、[v2 留存规则](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:728)、[实际消费次序](/C:/git/dsh-Agentline/orchestrator/lib/exec.mjs:198)。

**2. `call.archive` 已落盘、`call.end` 未落盘的窗口没有恢复分支。**

两者明确是依次写入、分别持久化的事件。此时既不满足 W1 的“没有 call.archive”，也不满足 W2 的“有 call.end”。beforeCall 的归档前置检查却已经满足。恢复表仍不能唯一决定如何结束旧调用、计费和续跑。[事件次序与恢复表](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:115)。

**3. Windows 的终止证明仍可能漏掉存活后代。**

按文档的枚举规则即可构造反例：最后一次心跳之后出现 `worker → 中间进程 → 模型进程`，随后 worker 与中间进程退出，模型进程仍存活。旧心跳没有它；从已死 worker 沿当前进程的父子关系递归，也缺少中间节点。扫描成功不等于后代集合完整，不能据此证明可以续跑。[终止证明](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:162)。

**关闭条件：**明确不依赖 Git 原文的输入恢复依据；补齐 archive/end 之间的持久化窗口；对无法完整证明终止的进程树返回 `unknown`。相应故障注入必须包含上述三个反例。

### B4．部分关闭：K 的恢复存在空档，`T_content` 仍混入动态检查

**1. K 已提交、phase 尚未更新时，受控事务会被误判为分歧。**

第 7 步顺序为：提交 K → 校验 → 写 `phase: recorded`。若在提交后崩溃，现场是 `phase=merged、HEAD=K`。恢复表只接受该 phase 下 `HEAD=M`，因此落入 `E_TXN_DIVERGED`。这没有任何人工改动，却无法完成已承诺的事务恢复。

K 文件已写入或暂存、尚未提交的窗口，也需要明确如何接续，不能直接重新套用正常路径的冲突检查。merge 事务又被明确排除在通用恢复规则之外。[K 写入顺序](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:250)、[恢复表](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:280)、[通用恢复排除条款](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:407)。

**2. 缓存键没有覆盖 `T.check_task` 的本机日志检查。**

v4 把除可达性和当前批准外的全部 T check 放进可缓存的 `T_content`。但仍有效的 `check-task -Sealed` C6 要求：本机日志存在时，哈希不一致必须 FAIL；A4-4 也要求修改归档一个字节后 eval 失败。

先缓存 pass、再修改本机日志，S、content_hash、evaluator_version、policy_digest 均可不变，缓存仍会命中。因此“键已覆盖全部输入”的声明不成立。[T_content 定义](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:223)、[缓存键](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:295)、[C6 与验收要求](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:547)。

**关闭条件：**补齐 K 写入各边界的恢复结果；明确本机日志检查如何在缓存命中时继续成立。无需恢复外部合并补封存功能。

## Major

### M4．部分关闭：新准入登记改善了竞态，但旧 CLI 的零计数仍不可靠

旧 `executeRole` 在一次 adapter 调用结束后立即 `clearLive`，随后才记账、处理失败及切换候选；下一候选开始时才重新 `writeLive`。升级前已经运行的 `cmdRun` 没有 admission，也没有任务锁。

因此存在明确窗口：**旧调用清除 live → drain 扫描得到零 → 旧进程启动下一候选。**这里没有扫描失败，`unknown` 规则不会自动兜底。只验证“adapter 正在运行时能看到 live”的 A6-6 不足以证明安全回滚。[旧 CLI 覆盖承诺](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:437)、[实际调用循环](/C:/git/dsh-Agentline/orchestrator/lib/exec.mjs:121)、[clearLive 时点](/C:/git/dsh-Agentline/orchestrator/lib/exec.mjs:155)。

关闭条件是覆盖旧进程的完整存活期间，包括首次调用前和候选切换间隙；不能把“没有 live 文件”等同于“没有旧执行者”。

### D3．部分落地：追加授权尚未贯通调度与 G1

v4 已规定每次授权增加一轮、记录预算及 deviations，也删除了直接接受未通过版本的选项。但仍有两处契约冲突：

- v4 只替换 v3 调度规则 1，规则 2 仍为 `k < 3` 才进入下一轮。授权后 `L=4、k=3` 失败时，两条规则都不匹配。
- v1 的不可豁免检查 `G1.rounds_le_3` 未被替换。合法追加的第 4 轮即使评审通过，仍无法通过 G1。

这会实际缩小用户已经授权的 D3，必须同步修正，无需重新请用户决定是否允许追加。[D3 落地](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:480)、[原调度规则](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v3-delta.md:155)、[G1 固定三轮检查](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:1328)。

## Minor

以下属于**实现前契约整理**，不单独阻塞：

- 命令 ID 的生成规则与例子不一致：按“CLI 路径用点连接”，应产生 `models.exception.add`；正文却使用 `models.exception_add`，`ops.*` 也属于例外。统一规则或显式别名即可。[命名规则](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:501)。
- 准入正文要求“登记早于开始干活”，A6-8 却要求先写含 PID 的记录、再启动子进程。应区分进程创建与工作放行，统一验收措辞。[准入生命周期](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v4-contract.md:433)。
- 按 §7.4 清理旧术语和失效分支；D1 必须统一指向 **decisions.md 的 A＝K1**，不能遗留旧版本的选项字母映射。

## Review-v3 逐项核对

| 项目 | 结论 | 依据 |
|---|---|---|
| B1 | **部分关闭** | 证据先归档、amendment 一次绑定、提交 trailer 已明确；输入恢复、归档中间窗口和终止证明仍有缺口。 |
| B4 | **部分关闭** | T_pre/T_final 消除了原循环；重入关联事务正确。K 恢复窗口及动态检查缓存仍未闭合。 |
| B5 | **已关闭** | merge、materialize 最终检查与写入共用 MainWrite 锁；权威状态变更也纳入该锁。 |
| M3/M5 | **已关闭原问题** | 统一保护未跟踪、忽略及大小写冲突路径；通用事务前滚校验路径、模式和结果 blob。merge 的剩余问题归 B4。 |
| M4 | **部分关闭** | 新准入与 drain 已线性化；旧 CLI 的完整生命周期仍未覆盖。 |
| B2／G2 | **保持关闭** | 固定快照 I、定义与人工结论绑定、里程碑下游条件保留；整体执行仍受 B4 影响。 |
| M2 | **保持关闭** | LockedConfig 的唯一配置来源未被破坏。 |
| 原 Minor | **基本关闭** | 业务轮次措辞、G2 下游范围及清理清单已回应；命令映射仍需整理。 |
| D1 | **授权边界落地，验收未完成** | 保持新增 runStep 的有限例外，没有授权改写 runFlow/exec 既有语义；B1 不能因授权而视为关闭。 |
| D2 | **按决定落地** | 人工固定版本例外、范围与审计字段、持续 unverified、不得宣称隔离已验证均已规定。 |
| D3 | **部分落地** | 单次追加与留痕正确，调度及 G1 硬门禁尚未同步。 |
| D4 | **按决定落地** | 本机账户信任约定、审批字段及禁止代理代批均保留；没有宣称机器能证明操作者是人。 |

## 新引入的问题

主要是修补方案与保留契约之间的冲突：

- Git 外输入记录与基于 HEAD 的恢复条件冲突。
- 新增持久化阶段后，archive/end、K/recorded 之间仍缺恢复分支。
- `T_content` 的不可变声明与 C6 的本机状态检查冲突。
- D3 的可追加上限与旧调度、固定三轮 gate 冲突。

未发现需要推倒重做的架构依赖环，也未发现必须新增产品功能才能解决的问题。

## 是否可进入实现切分

**no。必须先完成局部契约修补，不能带着上述 Blocking 进入正式实现切分。**

前置条件：

1. 关闭 B1 的输入恢复、持久化窗口及终止证明缺口。
2. 关闭 B4 的 K 恢复空档和缓存边界问题。
3. 明确旧 CLI 全生命周期的 drain 判定。
4. 将 D3 同步到调度、gate 和对应验收。
5. 拼装合并稿，完成实现前契约整理。

现有架构、UX、配置来源及已关闭的契约可以保留。

## 仍需用户裁决的问题

**没有新的 D 类产品裁决；D1–D4 不需要重裁。**

上述问题应在现有授权内局部修补。只有选择缩小已经承诺的恢复或兼容范围时，才需要用户另行确认；不能以普通 gate 豁免替代正确性修复。