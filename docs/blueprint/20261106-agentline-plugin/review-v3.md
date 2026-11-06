# AgentLine Blueprint 20261106 — Review v3

## Verdict

**REVISE**

v3 已实质关闭 G2 验证对象和角色锁配置来源问题；K1 也明确标为需要用户裁决，没有擅自修改 Q1。普通合并拓扑可以成立，补封存移出范围也是有效的范围收缩。

但 **K1 的崩溃恢复与逐调用证据尚未闭合，合并校验存在循环前置条件，并新增了批准检查与实际合并之间的竞态**。这些影响正确性，不能仅作为实现备注放行。

这是协议内最后一轮。剩余 Blocking 属于**必须局部再设计**，不自动开启第四轮，也不需要重写整个设计。

本审核合并阅读六份指定文档，并静态核对相关源码；未修改文件、未执行产品流程。仓库没有 `scripts/check-fast.ps1`。

## Blocking

### B1．K1 正常计轮成立，但恢复与逐调用证据仍未关闭

单候选加 `networkRetries = 0` 能限制每步最多一次 adapter 调用；由 ledger 调度也解决了单评审候选过滤、第三轮评审被拒及非 `interrupted` 原因不能 discard 的旧问题。

剩余缺口：

1. **恢复只检查“有 call.start、无 call.end”，遗漏“调用已结束、步骤尚未完成记账”。**  
   adapter 包装层的 afterCall 先发生，随后 `executeRole` 才写 run/state，`runStep` 再提交，最后 worker 记 ledger。因此，崩溃可以发生在 call.end 之后、步骤提交之前，也可以发生在提交之后、step.end 之前。现有恢复入口均不会处理这些情况；trailer 规则没有覆盖真正需要它的全部窗口。参见 [恢复规则](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v3-delta.md:190)、[实际调用及状态写入顺序](/C:/git/dsh-Agentline/orchestrator/lib/exec.mjs:147)。

2. **中断调用的原始证据可能被下一次尝试覆盖。**  
   若 worker 在 afterCall 归档前死亡，恢复规则仅补记 `E_WORKER_LOST`，随后重试仍使用相同日志名。文档没有要求先归档遗留日志和部分产物，再允许下一次调用。“调用串行”不能消除这个崩溃窗口。[逐调用归档约定](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v3-delta.md:198)

3. **同一 amendment 可能重复开启纪元。**  
   v3 规定步骤之间只要看到 pending amendment 就增加 epoch；现有 `executeRole` 仅在成功后消费输入。因而 design 失败后，该 amendment 仍 pending，再调度可能再次增加 epoch，使同一需求变更反复获得新的步骤预算。需要明确 amendment ID 与纪元的一次性绑定。[纪元规则](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v3-delta.md:163)、[输入消费时点](/C:/git/dsh-Agentline/orchestrator/lib/exec.mjs:198)

此外，两次相隔十秒的静止指纹只能证明期间未观察到改动，不能证明遗留模型进程已经退出，不能单独授权自动重试。

**关闭条件：**补齐调用结束、归档完成、步骤提交、step.end、round.close 之间各崩溃窗口的恢复结果；中断证据先封存再重试；同一 amendment 只开启一次纪元；续跑前确认旧执行者已终止。现有 A1-7 不足以覆盖这些窗口。

### B4．普通拓扑成立，但正常合并无法按当前校验顺序完成

`C → S → M → K`、`M^2 == S`、T 派生结果不进任务分支，以及不复用旧 merge CLI，都解决了上一轮的重要矛盾。仍有三处：

- **循环前置条件：**合并第 7 步在 M 上求 T，失败即停止；新的 `T.reachable` 却要求已经存在 merged.json，并明确“只有 M 没有 K”为 `fail(pending_record)`。K 要到第 8 步才写。正常合并因此也会在第 7 步失败。[合并时序](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v3-delta.md:376)、[T.reachable](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v3-delta.md:394)
- **重入判据过宽：**只要发现某个 `M^2 == S` 就直接补第 8 步，既可能跳过之前失败的第 7 步，也可能接纳 AgentLine 之外完成的普通合并。这与 §3.5“外部普通合并也判 unsealed_merge、不提供补救”冲突。
- **缓存键不能覆盖完整 T：**缓存键只有 `(S, content_hash, evaluator_version)`，但 `T.reachable` 会随 K、main 可达性变化，`T.origin_valid` 也依赖当前或合并时的批准状态。相同缓存键可能先后对应不同结果；不能直接把完整 T 缓存用于依赖准入。[缓存定义](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v3-delta.md:370)

**关闭条件：**明确 M 阶段校验与 K 完成后的完整 T 的边界；重入必须关联本次受控合并事务并保留校验结果；动态检查必须重新求值，或具有完整的缓存失效依据。无需恢复补封存功能。

### B5．新增：批准有效性检查不在合并的共享锁内

当前顺序是先检查有效性链和 T，再取得 MainWrite 锁。与此同时，撤销批准也通过 MainWrite 执行。

因此存在明确时序：合并预检通过 → 撤销命令取得锁并提交 → 合并取得锁 → 合并旧批准对应的 S。当前没有规定持锁后重新检查批准、来源节点及许可，无法保证“批准在合并时有效”。[合并步骤](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v3-delta.md:380)、[共享写锁覆盖范围](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v3-delta.md:457)

**关闭条件：**在产生 M 前，持共享锁完成最终有效性检查，或使用具有等价保证的版本校验。materialize 的计划与批准检查也应明确落在同一事务边界内。

## Major

### M3／M5．MainWrite 已补提交隔离，但目标路径冲突检查还不完整

`commit --only`、共享编号锁和事务日志，已实质解决上一轮的暂存内容夹带及失败恢复问题。

但前置条件只检查 cached diff 和未暂存修改，没有明确拒绝**目标路径上已有的未跟踪文件**。这类文件可能不出现在上述 diff 中，却被写入步骤覆盖。materialize 保留的“目标不存在”能保护该命令，不能自动覆盖 approve、check 等其他 MainWrite 调用方。[MainWrite 协议](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v3-delta.md:465)

应把未跟踪目标冲突纳入统一契约，并要求恢复前滚时确认事务提交满足原定路径和结果约束。这可以作为明确验收条件带入实现。

### M4．兼容矩阵已收口，但 drain 的零计数仍不可靠

新版插件配旧核心时禁用建任务、取消插件写盘例外，已经关闭兼容边界问题。`starts_work` 也补齐了 resume、retry-now 等入口。

剩余问题是**准入与存活登记之间没有契约**：

- 旧 `cmdRun` 直接调用 `executeRole`，没有任务锁、job 或 worker 登记；已运行的旧 run 可能不进入 v3 定义的三个计数集合。
- 两次 `admit` 检查也未说明如何与 job／进程登记原子协调，仍可能发生检查通过、drain 观察到零、随后工作启动的竞态。

参见 [drain 定义](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v3-delta.md:524)、[旧 cmdRun](/C:/git/dsh-Agentline/orchestrator/agentline.mjs:304)。

需要统一覆盖已准入但尚未启动、旧 CLI 正在执行、worker 及其子进程的登记与释放。A6-2 只测 drain 生效后的命令拒绝，尚不足以证明回滚条件稳定。

## Minor

- 将“不会发起第 4 次 dev 调用”统一写成“不会自动开启第 4 个业务轮次”。基础设施重试允许物理 dev 调用超过三次。
- G2 下游条件应统一措辞：v2 规定前一**里程碑**的 `user_gate:true` 约束下一里程碑任务；v3 §2.5 写成下一里程碑的“`user_gate` 任务”，容易被实现为只检查任务级标记。
- 最终合并稿应清理旧摘要和测试说明中的 K0、摘要计轮、内核摘要白名单及 `t-gate.json`；v3 §11 的审核状态 `ACCEPT` 应统一为 `APPROVE`。
- 新增 build budget、relock、E2E 命名和首次 materialize 有效性链，已回应上一轮 Minor，不再构成独立障碍。

## Review-v2 逐项核对

| 项目 | 结论 | 本轮判断 |
|---|---|---|
| **B1** | **部分关闭** | 正常计轮、单评审候选、keep/discard 已改正；崩溃恢复、证据保全和纪元幂等仍未闭合。 |
| **B2** | **已关闭：目标与证据绑定契约** | 固定 I、显式更新、人工结论及定义入哈希、下游验证同一 I 均已明确；完整运行仍受 B4 影响。 |
| **B4** | **部分关闭** | 拓扑、调用边界、派生结果位置及补封存范围已明确；校验顺序、重入和缓存仍有矛盾。 |
| **M2** | **已关闭：配置来源问题** | routing 只在锁定时求值，执行从锁重建 provider、候选和 effort，并检查漂移。 |
| **M3** | **部分关闭** | 提交隔离、共享锁、事务日志已补；目标路径保护及 B5 的锁内检查仍需完成。 |
| **M4** | **部分关闭** | 插件写盘例外已删除，兼容矩阵成立；drain 的存活统计和准入原子性尚欠。 |
| **M5** | **部分关闭** | 首次物化前置、编号互斥及回滚方向已补；继承 MainWrite 的剩余问题。 |
| 上轮 Minor | **基本关闭** | 剩余为命名、表述和合并稿清理。 |

## 新引入的问题

主要集中在：

- 从 CallGuard 控制改为 runStep 后，调用完成与步骤完成之间增加了需要恢复的持久化边界。
- 新 `T.reachable` 与写 K 的顺序形成循环，完整 T 缓存又忽略动态条件。
- MainWrite 串行化了写入，但没有自动串行化写入前的批准检查。
- drain 定义了统一拒绝规则，却尚未定义统一存活登记。

**没有发现必须新增产品功能的范围膨胀。**runStep、MainWrite 和 drain 都服务于原承诺；补封存删除属于收缩。K1 属于明确提出、尚待授权的边界变化。

## 是否可进入实现切分

**no。当前属于“必须局部再设计”，不能仅带着已知 Blocking 开始完整实现切分。**

前置条件：

1. 收口 B1 的持久化与恢复契约。
2. 消除 B4 的校验循环，限定重入与缓存语义。
3. 关闭 B5 的批准竞态。
4. 将 MainWrite 目标保护、drain 登记与准入要求写成明确契约及验收条件。
5. 完成 D1 及影响落地的必要用户裁决。

不自动开启第四轮。由用户决定这些局部契约如何收口或缩小范围；其余已完成的架构、UX、命令和模型管理设计可以保留。

## 需要用户裁决的问题

1. **D1：是否授权 K1。**v3 已清楚标明新增 `flow.mjs/runStep` 是 Q1 的例外。授权 K1 不等于 B1 已关闭；选择 C 则明确降低 Q5，且不能沿用 K1 的恢复承诺。
2. **D2：身份未验证策略及手工导入例外。**确定 strict／显式例外的适用阶段，始终保留未验证标记。
3. **D3：三轮后的人工追加政策。**未裁决前保持三轮后停下；`accept_as_is` 已删除，不再作为本设计选项。
4. **D4：本机账户信任约定及 Host 签名。**签名不能证明操作者是人。
5. **最后一轮后的处理。**选择完成上述局部契约收口，或缩小相关功能范围；不能用普通 gate 豁免代替正确性修复。

插件写盘例外已经删除，无需再裁决。G2 固定快照和补封存移出范围作为明确的行为边界保留。