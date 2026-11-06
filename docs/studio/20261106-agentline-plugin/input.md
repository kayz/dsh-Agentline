# Studio 评审：AgentLine 插件的三阶段改造

日期：2026-11-06
状态：Round 1 输入
评审对象：AgentLine 插件从“Build 单任务驾驶舱”升级为“Studio / Blueprint / Build 三阶段流水线驾驶舱”的修改方向和优先序。

## 1. 当前事实

- 插件版本：`dsh-agentline@0.17.0`，源码在 `plugin/`。
- 当前 Host 路由：`/agentline/{metrics,projects,tasks,task,merge,flow,control,routing,models}`。
- 当前 UI：单页任务驾驶舱；项目、任务列表、任务详情、模型路由、额度、合并、通知。
- 当前角色配置只有 `design / dev / review`；本机候选分别为 `claude-opus-5-5 / gpt-6.1-sol / claude-opus-4-5`。
- 当前协议文档：`AgentLine/SKILL.md`（v0.4.0）、`docs/03-three-stage-pipeline.md`。
- `docs/03` 已定义 Studio / Blueprint / Build，但调度器只实现 Build 的单任务 `flow`；Studio/Blueprint 尚未有命令、状态机或插件页面。
- 插件通过外部 CLI（Claude / Codex / CodeBuddy / Gemini）执行模型；模型列表来自 CLI 扫描/配置缓存。
- 失败处理中仍存在手工操作：认证失败、限流、模型不可用、任务卡住、阶段推进和“是否再开一轮”等场景，部分依赖人判断或手工命令。

## 2. 提议的插件变化

### 2.1 信息架构

从单页任务驾驶舱变成三阶段：

```text
Studio     讨论、立项、拍板
Blueprint  系统设计、任务图、测试架构
Build      现有任务执行、CI、评审、合并
```

加一个 Home/Pipeline 总览，显示三阶段状态、当前闸门、阻塞项。

### 2.2 数据模型

```text
.collab/studio/<id>/
  session.json
  participants.json
  rounds/
  questions.json
  facts.md
  minutes-final.md
  moderator-brief.md
  confirmations/

.collab/blueprint/<id>/
  state.json
  design-v1.md
  review-v1.md
  task-graph.json
  test-strategy.md
  acceptance-matrix.md
  approvals.json

.collab/tasks/<NNN>/   # Build 保持现状
```

新增 pipeline summary，把三个阶段串起来。

### 2.3 Host 路由

建议新增：

```text
/agentline/pipeline/summary
/agentline/studio/sessions
/agentline/studio/session
/agentline/studio/answer
/agentline/studio/confirm
/agentline/blueprint/sessions
/agentline/blueprint/session
/agentline/blueprint/start-round
/agentline/blueprint/approve
```

原则：插件不直接拼 prompt、不自己跑三阶段；Studio/Blueprint 应先在 AgentLine 核心有正式命令和状态机，插件只做 UI 和调用。

### 2.4 模型角色矩阵

从 3 个角色扩为：

```text
Studio:
  experts[3]
  moderator
  scribe

Blueprint:
  designer
  reviewer
  test_architect

Build:
  designer
  developer
  verifier
```

需要：顶级模型白名单、禁止静默降级、每阶段预算、认证失败显示 `blocked(auth)`、主持/书记不能同模型、设计师/评审不能同模型。

### 2.5 用户闸门

- Studio：待回答问题、FACT、纪要、确认状态；用户回答后继续。
- Blueprint：设计、评审 verdict、任务图、测试策略；用户批准后才能 Build。
- Build：里程碑验收、合并许可。
- 达到轮次上限后进入 `awaiting_user`；不自动开下一轮；必须显式授权，并记录偏离。

### 2.6 报告与确认

- `minutes-final.md`、`moderator-brief.md`、`decisions.md` 分开展示；
- 专家 `accept_with_notes` / `reject`、blocking、未解决异议；
- 事实报告与主持人判断的署名分开；
- 原始 raw 输出按需展开。

### 2.7 Build 页面

任务显示来源 Blueprint 节点、`test_levels`、测试策略/验收矩阵、模型隔离、CI 门禁、用户闸门。

### 2.8 版本路线

- `0.18`：流水线外壳，只读展示三阶段状态和产物，不伪造未实现能力。
- `0.19`：Studio 编排。
- `0.20`：Blueprint 编排。
- `0.21`：Build 集成。

### 2.9 明确不做

- 插件自己维护一套 Studio/Blueprint 状态，和核心各写一份；
- 自动连续跑 3 轮；
- 把所有 raw 输出塞进 UI；
- 伪造 Blueprint 已批准；
- 把 Studio/Blueprint 塞进现有 `flow` 命令。

## 3. 本轮尤其要评审的四个特例化问题

### 3.1 外部 CLI 的导入

- 当前插件/调度器强依赖本机 Claude/Codex/CodeBuddy/Gemini CLI 的命令、参数、输出格式和登录状态。
- 需要判断：CLI adapter 应该是核心能力、插件能力，还是独立 provider 层？
- 如何处理 CLI 版本漂移、命令参数变化、输出格式变化、安装缺失、认证失败、限流、超时、非零退出但未报错？
- 是否需要一个显式的 `provider manifest` / capability descriptor，而不是在代码里散落 `if (provider === ...)`？
- 插件的“模型可见性”和“实际可调用性”如何区分？

### 3.2 模型的认定

- 当前模型通过 CLI 扫描/配置缓存发现，角色候选是字符串 ID；没有统一的“档位/能力/厂商/上下文/工具能力”元数据。
- 需要判断：如何认定“顶级模型”？按显式 allowlist、provider 元数据、人工配置，还是三者结合？
- 如何避免静默回退到低档模型？如何在阶段开始时校验设计师/评审/主持的模型不冲突？
- 模型别名、版本漂移、同厂商模型、模型下线、额度耗尽、session limit、403 等如何进入统一状态？
- `model_requested` 与 `model_resolved` 如何进入 UI 和审计？

### 3.3 流程出错时靠手工管理，而不是规则

- 当前很多异常依赖人看日志、手工执行 `flow --resume`、`stop`、重新派活或改状态。
- 需要判断：哪些错误应自动重试、换模型、换现场、降级、暂停、升级给用户？
- 需要一套失败分类和状态机：auth / rate_limit / quota / model_unavailable / transient_network / cli_crash / invalid_output / ci_failed / review_rejected / user_cancelled / budget_exceeded。
- 每类错误的动作、最大重试、是否换模型、是否保留现场、是否产生 `blocked`、是否需要用户批准，必须由规则决定，而不是默认靠人。
- 但要避免“自动重试掩盖真实失败”；哪些情况必须硬停并保留证据？

### 3.4 每个阶段的准入/准出条件

- Studio：输入、参与者、问题、FACT、纪要、专家确认、用户决策；什么状态算“可进入 Blueprint”？
- Blueprint：设计轮次、评审 verdict、任务图、测试策略/验收矩阵、用户批准；什么状态算“可进入 Build”？
- Build：任务 brief/design/write_scope/acceptance/test_levels/CI/review/merge；什么状态算“任务完成”“阶段完成”“可发布”？
- 需要机器可校验的 gate，而不是“看起来差不多了”。
- 轮次上限、未解决异议、blocking、用户豁免、审批记录如何表达？
- 插件 UI 上的状态必须来自这些 gate，不能自己推断或伪造。

## 4. 专家要回答的问题

1. 三阶段插件方向是否正确？哪些应该做，哪些应该砍掉或后置？
2. Studio/Blueprint 的状态和命令应该归 AgentLine 核心，还是独立控制面/插件？边界怎么划？
3. 四个特例化问题分别怎么规则化？给出具体状态机、字段、错误码或准入条件。
4. 0.18–0.21 路线是否合理？第一版最小切片是什么？
5. 最大的三个风险是什么？
6. 还有哪些必须由用户拍板的问题？

## 5. 约束

- 只做评审和建议，不写产品代码。
- 不修改仓库。
- 不要只讲原则；关键状态、错误分类、gate 条件要可执行。
- 不要假设现有代码已经支持三阶段。
