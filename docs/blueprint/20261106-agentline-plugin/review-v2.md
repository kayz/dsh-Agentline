# AgentLine Blueprint 20261106 — Review v2

## Verdict

**REVISE**

v2 有实质进展：取消整体 gate override、补充证据摘要、引入合并前归档、将长操作改为 job，都超过了措辞修订。**B3 已关闭；B1 尚未关闭；B2、B4 部分关闭。**

目前仍不宜进入正式实现切分。主要障碍集中在 CallGuard 恢复时序、G2 的验证对象，以及封存与合并的提交关系，无需重写整个设计。

本审核合并阅读了五份必读文件，并静态核对相关源码；未修改文件、未执行产品流程。仓库没有 `scripts/check-fast.ps1`。

## Blocking

### B1．CallGuard 接缝存在，但所承诺的恢复时序仍不成立

关闭内部重试、逐调用记账、在调用前拒绝执行，方向正确。但以下问题不能靠“接缝测试以后确认”视为已关闭。

**第一，S3 的 429 恢复无法按文档执行。**

评审拒绝后，成功的 review 调用已经把 `state.model` 写成评审模型，状态写成 `reviewed`。随后 dev 修复遇到 429，失败路径保留这个模型字段。resume 恢复后，flow 用 `state.model` 排除评审候选；只有一个评审候选时，直接返回 `no_candidate`，**尚未进入 CallGuard，就不可能重放旧 verdict**。v2 写的“从 reviewable 继续并重放”与源码不符。

依据：[v2 S3](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:295)、[角色状态](/C:/git/dsh-Agentline/orchestrator/lib/prompt.mjs:20)、[exec 状态写入](/C:/git/dsh-Agentline/orchestrator/lib/exec.mjs:190)、[flow 候选过滤](/C:/git/dsh-Agentline/orchestrator/lib/flow.mjs:357)。

**第二，S4 的 discard 并不能处理文档列出的全部中断现场。**

v2 规定 dev 超时后选择 discard，只需 resume 不带 keep。但现有丢弃逻辑仅在 `blocked_reason === interrupted` 时运行；`timeout`、`run_failed` 等原因不会进入该分支。不能承诺用户选择“丢弃”后现场确实已丢弃。

依据：[v2 S4](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:307)、[实际恢复条件](/C:/git/dsh-Agentline/orchestrator/lib/flow.mjs:258)。

**第三，不同代码摘要的数量不能完整代表业务轮次。**

`r = |S_e|` 会合并回到旧摘要的修复尝试，并排除基线摘要。连续修复不改变产品摘要时，业务分歧可能最终以 `G_STEP_CAP/blocked(infra)` 结束，而不是“三轮不收敛交用户”。此外，第三份摘要经 CI 后已使 `r=3`；评审守卫中的“新摘要”究竟相对 `S_e` 还是 verdict 缓存判断，未定义清楚，无法直接推出 S1 所写的第三次评审会获准。

依据：[守卫规则](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:133)、[轮次归约器](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:185)。

**关闭条件：**给出与实际状态迁移一致的恢复契约，覆盖单评审候选、失败后的 keep/discard、重复摘要和第三轮评审；明确业务轮次与物理调用预算各自何时占用、何时结束。若 K0 无法在既定边界内完成，应据此提出边界裁决。K1 也需要解释续跑如何避免重复步骤，不能仅以新增钩子和预计行数证明可行。

### B2．G1、T 的绑定明显改善，但 G2 仍缺少当前验证对象的定义

G1 的设计／任务图／测试策略摘要，以及 T 的代码摘要、验收命令和贡献者集合，已经实质回应了 v1。

剩余缺口在 G2：

- `M.e2e_pass` 检查的是 `code_digest(I)` 与结果文件一致，却没有规定**当前应验证的 I 如何确定和更新**。I1 通过后 main 出现产品变化，只要不重跑 E2E，现有条件仍可继续使用 I1。A2-7 只覆盖“已经在 I2 重跑”的情况。
- 新增 `manual-checks.json`，但 G2 内容集合没有明确纳入它。人工结论改变后，旧批准究竟如何失效，仍不能从哈希契约推出。

依据：[证据表与 G2 判定](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:378)、[保留的 G2 内容集合](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:1355)。

**关闭条件：**明确 G2 是批准固定的历史集成快照，还是当前集成版本；下游准入必须验证同一个目标。若采用固定快照，不能将它展示或使用为当前 main 已验收。人工检查、检查定义及其变更必须进入批准有效性判断。

### B4．归档机制补上了，但封存与合并契约仍有不可同时满足的条件

“归档后删除 worktree”“新 clone 将原始日志标为 not_local”已经解决原始证据丢失问题；新增 `-Sealed` 模式也明确区别于放宽旧校验。

但提交关系尚未闭合：

1. **入口相互冲突。**§3 规定 Blueprint 来源任务调用旧 `agentline merge` 一律拒绝；§4.3 又要求 `build merge` 调用这条旧命令。尚未定义可以复用、同时不会开放绕过的内部接口。
2. **补封存无法满足正常封存规则。**`--post-merge` 在 main 上创建新的封存提交 S，而原合并提交 M 的第二父提交已经固定，必然无法再满足 `M^2 == S`。现有 `T.reachable` 没有补封存分支。
3. **封存结果的落盘位置不明确。**先提交得到 S，再求 T 并写 `t-gate.json`，会产生 S 之后的改动。需要明确这是派生缓存还是另一个提交，避免再次改变被合并的 HEAD。

依据：[旧 merge 禁用规则](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:444)、[封存与合并时序](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:479)、[补封存规则](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:551)。

**关闭条件：**明确普通合并和补封存各自的提交拓扑、内部调用边界、不可变证据与派生结果的存储位置。若本轮不支持补封存，可以明确移出范围，但不能继续列为可执行补救路径。

## Major

### M2．角色锁仍没有覆盖实际执行的全部配置来源

v2 冻结了更多字段，但 `runFlow` 每次仍读取项目的 `.collab/agentline.json`；`effectiveRole` 让项目 routing 覆盖候选顺序和 effort。仅将 `config.models` 限制为锁内模型的并集，不能保证每个角色使用自己的锁定候选。

锁中还有 `readonly_args_digest`，却没有对应可重建的参数内容；provider 执行配置也需要明确冻结范围。

依据：[LockedConfig](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:122)、[锁结构](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:650)、[项目配置读取](/C:/git/dsh-Agentline/orchestrator/lib/flow.mjs:65)、[routing 优先级](/C:/git/dsh-Agentline/orchestrator/lib/routing.mjs:40)。

**必须在设计定稿前明确：**执行配置的唯一来源、项目 routing 的处理方式，以及调用时对角色候选和参数的校验。序列化等实现细节可以后置。

### M3／M5．Git 写入的隔离与失败恢复仍被高估

“显式 `git add` 路径”不等于提交只包含这些路径，已经暂存的用户改动仍可能进入提交。复用的旧 merge 更会调用 `commitAll`，执行 `git add -A`。

materialize 的“先临时生成，再一次提交”也不能直接保证提交失败时没有工作区或索引残留。专用 `materialize.lock` 尚未说明如何与 `task new`、merge 等其他写入者协调编号和 main 更新。

依据：[物化契约](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:818)、[旧 merge 提交](/C:/git/dsh-Agentline/orchestrator/agentline.mjs:387)、[commitAll](/C:/git/dsh-Agentline/orchestrator/lib/git.mjs:65)。

**必须先明确事务边界：**对已有暂存内容的处理、共享写锁、提交失败后的恢复状态。临时目录命名、清理代码和故障注入测试可在实现中完成。

### M4．兼容矩阵更诚实，但新增了未经确认的边界例外

新插件配旧核心时重新允许插件写 `brief.md`，直接例外化了用户 Q1 的“插件不写 `.collab/**`”。这是范围决定，不能由兼容设计自行授权。

另外，drain 只列出禁止 start、queue、run；resume、retry-now 和其他会启动 worker 的 job 是否被禁止，没有统一规则。因此 `drain status = 0` 尚不足以构成稳定的回滚前置条件。

依据：[兼容与 drain](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:780)、[用户 Q1](/C:/git/dsh-Agentline/docs/studio/20261106-agentline-plugin/decisions.md:8)。

前者需要删除例外或提交用户裁决；后者需要设计统一的运行准入规则。

## Minor

以下可在实现契约整理中处理，不单独阻止切分：

- **M1 尚有命令缺口：**Build 达到预算上限后的追加预算，以及 Build 的重新锁定入口，未在完整命令表中明确；`build.e2e` 等旧名称也应统一为 `milestone.e2e`。
- **恢复预算存在一句反向规则：**S3 写连续三次失败后仍可轮换，与“重试和轮换合计最多三次”冲突；应在第三次调用前决定是否轮换。
- **有效性链需按操作区分：**首次 materialize 尚未生成 `materialized.json`，不能要求先通过“其中已有该任务”的检查。该项应只适用于已物化任务的 start/merge。
- **裁决表残留越界选项：**D3 的 `accept_as_is`、U1 沿用的隔离豁免选项，与正文“不越过硬门禁、不再询问放宽隔离”不一致，应删除或明确移至独立协议变更。

## Review-v1 逐项核对

| 项目 | 结论 | 说明 |
|---|---|---|
| **B1** | **未关闭** | 调用接缝真实存在，但 S3、S4 和业务轮次归约仍不成立。 |
| **B2** | **部分关闭** | G1、T 的绑定已实质补齐；G2 的目标更新和人工证据失效仍缺契约。 |
| **B3** | **已关闭** | 正文取消整体 override，硬检查不能通过通用 waiver 绕过；裁决表残留需清理。 |
| **B4** | **部分关闭** | 归档及新 clone 校验规则补齐；合并入口、补封存拓扑和结果落盘仍冲突。 |
| **M1** | **基本关闭** | 单 CLI 复合动作和 job 机制补齐；少量恢复命令可在实现契约中补齐。 |
| **M2** | **部分关闭** | 备选确认、异步 probe、行业建议已补齐；运行配置仍可能被项目 routing 改变。 |
| **M3** | **部分关闭** | 逐文件留存和迁移状态补齐；提交隔离及旧 merge 的 `add -A` 尚未处理。 |
| **M4** | **部分关闭** | 版本矩阵、GET 写路由的不兼容已明确；插件写盘例外及 drain 准入仍需处理。 |
| **M5** | **部分关闭** | 编号映射、摘要、worktree 输入、依赖和 user_gate 已定义；事务恢复与首次物化前置条件仍有缺口。 |
| **M6** | **技术表述已关闭** | 已明确本机账户是信任约定，并补上撤销和上游有效性检查；该信任约定仍需用户接受。 |

v1 的 Studio 步骤组、错误类别、未知副作用终态、重复错误计数和模块位置问题，已得到明确修订。

## 新引入的问题

主要是四类：

- CallGuard 绕过了“事后观察”的限制，却仍受 flow 内部状态和候选过滤控制。
- 不同代码摘要计数，被用于承担业务轮次计数。
- 不可变封存提交，与补封存、结果回写之间出现提交关系冲突。
- 为兼容旧核心，重新引入插件直接写业务文件的例外。

job、归档、gate CI 本身是补齐原需求所必需的工作，不应仅因新增模块数量而判定为范围膨胀。

## 是否可进入实现切分

**no。**

前置条件：

1. 关闭 B1，证明选定控制方式的恢复与计轮契约成立。
2. 明确 G2 的批准对象和完整失效条件。
3. 统一普通封存、合并及补封存的提交关系。
4. 明确角色锁的执行来源、Git 写入事务边界及兼容模式边界。
5. 完成影响上述契约的必要用户裁决。

可留到实现中的内容包括：命令名称整理、schema 细化、错误文案、临时目录管理、测试夹具和 UI 展示细节。

第 3 轮应集中提交这些问题的关闭证据，无需扩展产品范围或重写已有 UX。

## 需要用户裁决的问题

1. **D1：控制边界。**先修正 K0/K1 的可行性说明，再由用户决定是否接受接缝限制，或授权最小内核改动。当前不能以“K0 已能兑现全部承诺”为裁决前提。
2. **D2：身份未验证策略与手工导入例外。**需要确定 strict／显式例外的适用阶段，并始终保留“未验证”标记。
3. **D4：人工授权的信任边界。**是否接受本机账户约定；Host 签名只能提高伪造门槛，不能证明操作者是人。
4. **兼容模式写盘例外。**若坚持新插件配旧核心时直接写 `brief.md`，需明确批准对 Q1 的例外；否则维持插件禁写边界。
5. **D3：是否允许三轮后的显式追加。**未获授权时继续保持三轮后交用户，不自动延长。接受未通过评审版本属于另一项协议变更。

模型建议维护方式、预算默认值和过程目录可以作为配置决定处理；不应重新裁决已经确认的三轮原则、Git 分级留存和角色隔离要求。