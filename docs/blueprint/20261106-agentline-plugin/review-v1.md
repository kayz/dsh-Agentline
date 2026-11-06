# AgentLine Blueprint 20261106 — Review v1

## Verdict

**REVISE**

v1 已覆盖完整产品面：页面与交互、slash 命令、监控、模型目录、probe、错误分类和 gate 均有具体设计，不需要推倒重写。

但目前**尚不足以进入正式实现切分**。主要障碍是：Supervisor 对现有 flow 的控制能力被高估；gate 尚不能保证证据对应当前内容；正常合并会破坏后续 gate 所需证据。不能把这些问题留到 W7 实现时再决定。

本轮仅进行了文档和源码静态核对，未修改文件、未执行产品流程。

## Blocking

### B1．Supervisor 尚不能兑现三轮上限及统一恢复规则

设计将控制放在 flow 退出后，并在 R3 提议“统计 `verdict-r*.json`，把剩余轮次传给 flow”。现有实现不支持这一推论：

- 每次 flow 调用都从 `round = 1` 开始；合法 verdict 还包括不带轮次的 `verdict.json`。文件数量不能可靠表示跨 resume 的业务轮次。
- 最后一轮 review 拒绝后，仍调用 dev 修复并执行 CI，之后才报 `review_exhausted`。
- CI 失败及修复发生在评审循环之外，不能通过 verdict 数量计入设计声明的业务预算。
- `exec.mjs` 在 Supervisor 接管前已经执行内部重试、候选切换；网络重试只生成合并后的 run 记录，新增 adapter `identity` 字段也不会自动进入现有 run 记录。

因此，外层事后分类无法保证“最多三轮”“每逻辑步骤最多三次物理调用”“未知副作用不自动重放”和每次调用独立审计。

证据：[设计 §7.1](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:1242)、[设计 R3](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:1560)、[flow 评审循环](/C:/git/dsh-Agentline/orchestrator/lib/flow.mjs:357)、[exec 内部重试及记录](/C:/git/dsh-Agentline/orchestrator/lib/exec.mjs:146)。

**关闭条件：**明确无需修改 flow 即可使用的控制接口、持久化轮次依据、内部重试预算及逐调用证据通道，并给出跨 resume、CI 失败、第三轮拒绝的执行时序。若现有接口不能满足，应明确提交边界调整裁决，不能继续声称外层已足够。

### B2．批准绑定了文件，但评审和测试证据未充分绑定被验证对象

当前哈希算法能发现文件变化，这是正确方向；但重新求 gate 后，仍可能把旧证据用于新内容：

- **G1：**只检查最后 verdict 为 pass、testability 无 blocker，没有明确要求二者绑定所评审的设计、任务图和测试策略版本。修改设计后重新 eval、重新批准，可能继续使用旧 pass。
- **T：**`verdict.git_sha` 是 HEAD 祖先并不足够。评审通过后追加产品代码提交，旧 verdict 仍满足该条件；CI 也未明确绑定相同代码快照和验收命令。
- **T.isolation：**没有明确覆盖最终代码中保留的全部开发贡献模型；现有 `check-task` 实际只比较最后一次成功 dev/review。
- **G2：**需要明确 E2E 和人工验收对应哪个集成提交，以及该提交变化后的失效规则。

证据：[G1/T/G2 定义](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:1315)、[现有模型隔离校验](/C:/git/dsh-Agentline/AgentLine/tools/check-task.ps1:238)。

**关闭条件：**定义各类证据的输入摘要、代码快照、执行身份及新鲜度条件。至少保证“旧 pass + 新内容”不能重新评估通过；允许审计文件追加时，应明确哪些变化不改变被验证的产品快照。

### B3．`--override-gate` 绕过了“不可豁免”的硬约束

§5.12 允许通过 `merge --override-gate "<原话>"` 绕过整个 T gate；§7.3 却将 CI、评审、隔离、来源有效性等全部定义为不可豁免。

记录 deviation 不会消除这个矛盾。按当前文字，来源批准失效、CI 失败或评审未通过的任务均可直接合并。

证据：[合并 override](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:1057)、[T gate 硬约束](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:1342)。

**关闭条件：**取消整体绕过，或限定为明确允许豁免的检查。若要允许越过硬门禁，必须作为协议变更交用户裁决。

### B4．正常合并会使合并后的 T/G2 无法重新验证

设计把 Build 日志留在任务 worktree，仅保存哈希索引；同时要求 merged 状态的 T 继续通过严格 `check-task`。

现有 merge 默认会：

1. 删除任务 worktree；
2. 删除任务分支。

由此产生两个确定问题：

- 被 gitignore 的日志没有随合并进入 main，也没有被设计要求复制留存，严格 `check-task` 会报告 `log_ref` 缺失。
- T 的内容集合包含“任务分支 HEAD”，但该分支可能已经不存在。

这不仅是 R6 所说的“新 clone”问题，**同一台机器正常合并后也会发生**，进而阻止 `M.task_gates`。

证据：[留存策略](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:124)、[T 内容集合](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:1340)、[merge 清理路径](/C:/git/dsh-Agentline/orchestrator/agentline.mjs:381)、[日志存在性校验](/C:/git/dsh-Agentline/AgentLine/tools/check-task.ps1:345)。

**关闭条件：**明确合并前证据归档、合并后不可变提交定位，以及本机/新 clone 的校验契约。不能仅靠哈希索引或改用 `-Lenient`，同时继续宣称严格 T gate 成立。

## Major

### M1．“一个操作对应一条 CLI”尚有例外，命令表也未闭合

- 旧 `/agentline <目标>` 被定义为 `task new` **加** `build start`，按文字会在插件中形成两步编排。
- 设置页“应用角色后自动 probe”没有明确由 `roles set` 内部完成，还是插件再次发命令。
- 页面已使用 `studio/blueprint resume`、`build.e2e`、追加预算、人工验收记录、模型变更确认等动作，§4.2 尚未给出对应完整契约。

应补齐“用户动作 → 单条公开 CLI → 状态变化”，复合业务动作由核心负责。参见[旧语法处理](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:993)、[角色应用流程](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:836)。

### M2．模型配置与手工兜底已具体化，但仍有执行断点

- `roles.lock.json` 未明确冻结实际执行所需的 provider、model_id、CLI 配置等；仅冻结 key 和身份摘要不足以支撑“运行中不受配置变化影响”的承诺。
- 主选 probe 失败后允许确认备用，但 `ALL.callable` 又要求全部候选通过。应明确确认后如何移除失败候选、重新求约束并锁定。
- probe 最长可能需要约 290 秒，Host 同步超时却为 120 秒；`roles.set` 的 30 秒响应也需与自动 probe 的完成语义协调。
- “行业建议不提供”不是可直接采用的选项，已确认 Q3 要求提供建议。

参见[角色约束与 probe](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:1106)。

### M3．Git 分级留存还没有覆盖实际写入内容

忽略 `logs/handoff` 不等于过程数据已经退出 Git：

- Studio 的 A 级 `questions.json` 直接保存自由文本回答。
- Build 的 `inputs.jsonl` 保存用户原文，未进入忽略清单。
- `ci-results.json` 包含完整命令输出。
- 已被跟踪的日志不会因新增 `.gitignore` 停止更新；现有提交使用 `git add -A`。

需要逐文件明确“定稿摘要”和“过程原文”的边界，并定义拒绝取消跟踪时迁移的实际完成状态。参见[Q6 决策](/C:/git/dsh-Agentline/docs/studio/20261106-agentline-plugin/decisions.md:60)、[输入存储](/C:/git/dsh-Agentline/orchestrator/lib/inputs.mjs:20)、[CI 原始输出](/C:/git/dsh-Agentline/orchestrator/tools/ci-runner.ps1:107)。

### M4．版本兼容承诺需要收窄并给出组合矩阵

§9.2 一面保留 GET `/flow` 启动任务，一面称其满足“GET 不写”；同时把旧 GET control 改为 405，不能再笼统称旧路由保持兼容。

此外，新插件依赖旧核心不存在的 `build start`、`task new` 和 Read API，却承诺核心回滚后 Build 照常使用。需要明确新旧插件、新旧核心的支持组合、降级路径，以及回滚前如何处理仍在运行的 Supervisor/stage worker。

参见[兼容与回滚](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:1427)。

### M5．任务物化与调度交接缺少必要契约

需补充：

- materialize 的任务编号预留、部分失败恢复、重复调用处理，以及预览后任务图变化的拒绝条件。
- brief、origin 和留存规则如何进入实际执行 worktree。现有 worktree 从 base ref 创建，不会自动复制主工作区未提交的新文件。
- `depends_on` 以何种状态满足，`user_gate` 在启动还是合并时检查，跨里程碑是否等待 G2 批准。

这些字段不能只出现在任务图和 UI 中。参见[materialize 定义](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v1.md:490)、[worktree 创建逻辑](/C:/git/dsh-Agentline/orchestrator/lib/worktree.mjs:42)。

### M6．审批通道标记不能证明人工授权

Host 覆盖请求中的 `channel`、不注册审批工具，能降低误用；但公开 CLI 接受调用者自行填写的 channel 和原话，R4 也承认代理仍能调用。

因此可以承诺“插件不自行计算或写入 gate”，尚不能承诺“机器已验证批准来自人”。应明确本机 CLI 的信任边界，以及启动、物化、合并时如何检查撤销记录和上游批准有效性；不能仅比较内容哈希。

## Minor

- Studio 同时写了“每次 run 只执行一个步骤组”和“experts → moderator → scribe 连续执行”，需统一。
- 错误表新增 `business-input/model-quality`，却未纳入类别定义；`E_UNKNOWN_SIDE_EFFECTS` 的终态在不同位置分别为 blocked 和 awaiting_user。
- “重试三次”与“物理调用最多三次”需统一术语和优先级；`E_REPEATED` 也需明确连续计数的重置条件。
- `summary.revision` 应覆盖派生的 gate 失效及外部文件变化，否则只按 revision 刷新详情可能保留旧状态。
- 模块落在 `orchestrator/lib/` 属于常规实现选择，无需单独占用用户裁决。

## 覆盖矩阵

“部分”表示已有设计，但关键闭环仍不成立。

| brief 第 4 节 | 结论 | 逐项核对 |
|---|---|---|
| **4.1 控制面架构** | **部分** | 模块、状态枚举、文件布局、Read/Command Bridge、插件禁写均已覆盖；flow 控制能力、worktree 交接和队列准入未闭合。 |
| **4.2 界面与 UX** | **已覆盖** | Home/Inbox、Studio、Blueprint、Build、Settings、产物查看器、空/未实现/故障状态、窄屏/主题及默认折叠均有具体方案；部分动作缺 CLI。 |
| **4.3 slash 命令** | **部分** | 发现、补全降级、参数、读写分类、错误、别名和按钮映射已覆盖；单 CLI 约束、恢复命令及绕过 gate 的规则需修正。 |
| **4.4 监控** | **已覆盖** | 阶段/轮次/模型/耗时/预算、运行项、人工待办、provider 健康、身份/隔离、错误恢复、费用额度、事件及敏感内容策略均已定义；数据可信性受 B1 影响。 |
| **4.5 模型维护/配置** | **部分** | 自动发现、手动登记、档位、建议来源/过期、角色矩阵、probe、生命周期、历史/回滚及 UI 已覆盖；锁定执行配置、失败兜底和超时契约需补齐。 |
| **4.6 错误与轮次** | **部分** | 结构化错误、业务/基础设施区分、动作、预算、状态分类及审计均有设计；Build 的三轮与恢复规则目前不可兑现。 |
| **4.7 Gate 与审批** | **部分** | G0/G1/T/G2、G3 未实现边界、JSON、checks/waiver/hash/revision、核心求值及状态展示已覆盖；证据新鲜度、不可豁免约束和合并后验证存在阻塞。 |
| **4.8 迁移与兼容** | **部分** | 版本号、迁移命令、旧目录和配置策略已覆盖；路由兼容、新旧版本组合、运行任务回滚及日志清理后的校验尚不成立。 |

## 新引入的问题

以下是 v1 新方案产生的衔接问题，不应作为既有缺陷直接继承：

- Supervisor 与 flow 内部各自管理恢复和轮次，形成两套预算。
- 忽略日志与默认删除 worktree 组合，导致成功合并后证据消失。
- “不可豁免”检查之外新增整体 override，使硬约束失去效力。
- 运行会话锁、全局配置、probe 缓存之间缺少明确的不可变执行配置关系。
- `user_gate`、人工验收和部分恢复操作进入界面，却没有对应完整执行契约。

## 需要用户裁决的问题

真正需要用户决定的主要有：

1. **若无法在 flow 零侵入下兑现 B1，是否允许最小内核接口调整？**主设计师应先给出可行性结论和具体范围。
2. **身份无法验证时的策略，以及手工导入是否允许明确例外。**可合并 U2/U11，但例外不能显示为“身份已验证”。
3. **是否放宽三角色模型隔离或允许越过不可豁免 gate。**若保持现行协议，无需再问；实现应按失败关闭处理。
4. **是否接受本机 CLI 作为受信任的人工授权入口。**若接受，应明确这是信任约定，不是机器证明。
5. **三轮后是否允许原会话追加轮次或接受未通过评审的版本。**未获新授权前，保持交用户裁决，不能自动延长。

U4 模块路径、U6 分级留存和 U10“三轮还是两轮”不宜重新裁决：前者可由设计师决定，后两者已有 Q6/Q5 依据。U5 可裁决建议的维护方式，但不能撤销已确认的“提供建议”要求。