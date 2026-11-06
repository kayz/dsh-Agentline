# AgentLine 插件三阶段改造 — Studio 纪要 v2

日期：2026-11-06
状态：Round 1 完成；待专家确认、待用户裁决
参与：专家 A（Claude Opus 5.5）、专家 B（GPT-6 Astra）、专家 C（Gemini 4 Argon High）、Moderator（Kimi K3.1 Pro）、书记（当前 agent）

## 1. 输入与范围

- 输入文档：`input.md`、`docs/03-three-stage-pipeline.md`、`plugin/README.md`、当前 Host 路由、角色配置、`SCOPE.md`。
- 评审对象：AgentLine 插件从 Build 单任务驾驶舱升级为 Studio / Blueprint / Build 三阶段流水线驾驶舱的修改方向。
- 特别关注：外部 CLI 导入、模型认定、出错时手工管理、阶段准入/准出条件。

## 2. 三个专家的核心判断

### 专家 A（产品/流水线/交互）

- 三阶段方向正确，但**路线顺序反了**：当前最痛的是 Build 出错依赖人看日志和手工 resume，而 Studio/Blueprint 尚无核心实现；三阶段只读外壳不应先于核心状态机。
- 用户界面不应是三个平铺页面，而应是**“待我处理”的 Inbox + 一条阶段进度条**：每条是一个问题、默认选项和证据链接。
- 现有错误分类不足以做规则引擎：子串匹配有误判，quota/session/429 混为 `rate_limit`，裸 403 未识别；`rate_limit` 会自动换候选，与“Studio/Blueprint 禁止静默降级”冲突。
- 当前配置不能满足 Blueprint 角色隔离：design/review 同厂商，review 也不一定是顶级；需要用户先决定模型供应。
- 明确核心/插件边界：核心拥有所有改变下一步行为的状态（阶段状态机、gate、错误动作、model_resolved）；插件只做展示、收集输入、调用公开 CLI。
- 给出 G0 Studio、G1 Blueprint、Build 的 gate 条件，以及“批准绑定内容哈希”的要求。

### 专家 B（技术/CLI/模型/错误状态机）

- 建议 `accept_with_notes`：方向正确，但正式编排前必须先补齐**模型身份、错误恢复、阶段 gate 的公共契约**。
- 当前 `model_resolved` 不能普遍证明实际模型：Codex adapter 可能返回 null，Gemini 直接回显请求模型；`check-task` 在缺失时回退到请求模型。
- 需要 provider manifest 与运行时 capability descriptor 分离；清单描述“适配器支持什么”，descriptor 描述“本机当前实际能用什么”。
- 模型目录要有 provider/origin/canonical identity/tier/availability/scope 等字段；顶级模型必须显式版本化 allowlist，CLI 扫描只能证明 discovered，不能自动进入 top。
- 错误要先结构化再决定动作；`quota`、`session limit`、`429`、`403`、`invalid_output`、`cli_crash` 必须分开，不能只靠文本子串。
- 给出 Studio/Blueprint/Build 的模型隔离规则，以及 0.18 先做能力查询、只读 summary、版本化 DTO 的建议。

### 专家 C（风险/运维/安全）

- 三阶段方向成立，但存在**致命边界冲突**：`SCOPE.md`/`docs/03` 说内核只负责 Build，而输入要求“核心有正式命令和状态机”。
- 建议同仓分层：在 `orchestrator/` 下新增与 `flow.mjs` 平级、解耦的 `studio.mjs` / `blueprint.mjs`，通过 `agentline studio|blueprint` 暴露；`flow` 零侵入，插件只做无状态投影与意图转发。
- 三阶段把外部 CLI 故障面从 3 个角色槽扩到 11 个；现有 OAuth refresh token 轮换、输出正则看门狗误杀、恢复清空未提交改动、Codex 模型解析缺失等问题会被放大。
- 讨论记录、用户回答和原始 CLI 日志可能包含商业决策和代码上下文；是否进入产品仓库 git 必须单独决定。
- 强调：未知副作用、进程树未停止或交班失败时不得自动重放。

## 3. 专家共识

1. **不要把 Studio/Blueprint 塞进现有 `flow.mjs` 或插件 Host。**
2. **插件不能成为第二套 orchestrator**；状态、gate、错误动作、审批由控制面/核心写，插件只展示和转发。
3. **先补公共契约，再做三阶段 UI**：provider 能力、模型身份、错误分类、gate 状态必须先定。
4. **Build 单任务内核保持零侵入**，Studio/Blueprint 作为独立控制面模块，与 Build 平级。
5. **UI 以用户闸门/Inbox 为中心**，不是把内部轮次全部铺开。
6. **批准必须绑定内容哈希**；任务图或测试策略变化后批准自动失效。
7. **轮次耗尽不能自动继续**；进入 `awaiting_user` 或 `blocked(E_ROUND_LIMIT)`，由用户显式授权并记录偏离。
8. **禁止静默降级**；模型不可用/身份未知时必须 blocked 或明确记录例外，不得用请求模型冒充实际模型。

## 4. 主要分歧

| 议题 | A | B | C |
|---|---|---|---|
| 控制面落点 | 状态机/gate/错误策略归核心，provider 层在核心下 | 统一入口 + 独立控制面模块，公共运行层分开 | 同仓新增 studio/blueprint 模块，flow 零侵入 |
| 0.18 首切片 | 先做 Build 错误规则化、自动恢复、Inbox | 先做能力查询、只读 summary、版本化 DTO、模型身份 | 先裁断控制面落点，再谈目录/路由 |
| 轮次耗尽 | `awaiting_user`，可授权加 1 轮 | 三轮硬停 + `blocked(E_ROUND_LIMIT)`，用户裁决后新会话 | 未给出独立方案 |
| 错误自动恢复 | `invalid_output` 硬停；rate_limit 可在 reset ≤30min 内等待 | 格式修复最多 1 次；rate_limit 最多 2 次、单次 ≤60s、累计 ≤120s；CI 修复 1 次 | 强调未知副作用不得自动重放 |
| Blueprint 测试架构师模型 | B6 要求三角色两两不同，但默认方案允许复用 | 三角色均 top 且两两不同 | 未给出例外 |

## 5. Moderator 提出的待决问题

### Q1 控制面边界（blocking）

Studio/Blueprint 控制面落在哪里？

- A（推荐）：同仓分层，`orchestrator/studio.mjs` / `blueprint.mjs`，`agentline studio|blueprint` 暴露；flow 零侵入；插件只调用公开 CLI。
- B：独立 `pipeline-cli` 控制面包，插件分别调用控制面和 Build CLI。
- C：修改 `SCOPE.md`，正式扩展为三阶段全周期调度器。

### Q2 版本顺序与首个最小切片（blocking）

- A：0.18 Build 结构化错误/动作表/rate_limit 自动续跑/Inbox/pipeline summary；0.19 tiers/probe/Blueprint gate 校验器/手工产物导入；0.20 Blueprint 编排；Studio 后置。
- B：0.18 能力查询/只读 summary/版本化 DTO/模型身份；0.19 Studio 最小闭环；0.20 Blueprint；0.21 Build 集成。
- C：保持输入原路线，0.18 三阶段只读外壳，未实现阶段显示 unsupported/not_started。

### Q3 顶级模型供应（blocking）

- A：top 仅纳入已确认的 `claude-opus-5-5` 与 `gpt-6.1-sol`；测试架构师复用其中之一，跨厂商仅警告。
- B：先验证 gemini/codebuddy 顶级模型通过身份与 callable probe，再启动 Blueprint 编排；此前只做 Build 加固和 gate 校验。
- C：放宽协议，允许同厂商不同模型担任评审，每次记录 deviation。

### Q4 实际模型身份证据（blocking）

- strict（推荐）：无法可信证明实际模型时，不允许参与要求隔离的阶段，`blocked(model_unverified)`。
- explicit_exception：允许人工登记的固定版本例外，但持续显示 unverified，且不得宣称隔离已验证。

### Q5 轮次上限（blocking）

- hard_limit（推荐）：原会话最多三轮，超限 `blocked(E_ROUND_LIMIT)`；用户裁决后建立有来源关联的新会话。
- bounded_extension：允许一次追加一轮，最多四轮。
- repeatable_single_round：每次显式授权加一轮，逐次记录偏离。

### Q6 讨论记录的 Git 留存（blocking）

- A（推荐）：定稿契约/状态/run/verdict 进 git；logs/rounds/handoff 外置或 gitignore，本地保留哈希索引。
- B：全部进 git，仅限纯内部私有仓库。
- C：整个 `.collab/` 不进产品仓库，外置控制面数据目录。

## 6. 四个特例化问题的评审结论

### 6.1 外部 CLI 导入

- 需要 provider manifest + runtime capability descriptor，区分“适配器支持什么”和“本机当前能用什么”。
- UI 只显示 `ready / degraded / unavailable(reason)`，不暴露参数细节；修复命令可显示。
- `discovered` 与 `callable` 分开；Studio/Blueprint 只允许 callable 且符合角色档位策略的模型：Studio 专家及主持须 top、书记允许 advanced；Blueprint 三角色均须 top。
- 版本/二进制指纹变化使能力缓存失效；退出码 0 不等于成功，必须检查结束事件/输出结构。
- 版本漂移不自动删参数继续尝试；返回结构化错误并保留证据。

### 6.2 模型认定

- 顶级模型用显式、版本化 allowlist；不能按名称包含 opus/pro 判断。
- 模型身份用 provider + canonical id + identity_group；不能只用裸模型字符串。
- 当前 `model_resolved` 不可信；需要 adapter 返回实际身份，未知时 `blocked(model_unverified)`。
- 所有角色候选（包括备用）在阶段开始时校验；禁止 auto/滚动别名/未批准备用。
- 按角色表达模型档位：Studio 专家/主持必须 top，书记允许 advanced 特例；Blueprint 设计师/评审/测试架构师均 top，且模型两两不同；设计师与评审不同原始厂商；测试架构师跨厂商只是偏好，不是硬约束。
- 同一模型不能同时担任设计师和评审；测试架构师复用设计师或评审的模型会被“两两不同”拒绝，不属于“跨厂商偏好”冲突。

### 6.3 出错规则化

- 错误先结构化：`code/category/provider_code/http_status/exit_code/scope/retry_after/reset_at/evidence_ref/classification_source/side_effects/recovery_action`。
- 至少区分：auth、403、rate_limit、session_limit、quota、model_unavailable、invalid_output、cli_crash、ci_failed、review_rejected、user_cancelled、budget_exceeded。
- 每类错误定义：是否重试、换模型、保留现场、是否 blocked、是否需要用户、最大次数/等待。
- 禁止未知副作用自动重放；恢复默认清空未提交改动是危险行为，应改为显式确认。
- 手工操作应成为“有审计的例外”，而不是主流程。

### 6.4 阶段准入/准出

- G0 Studio：decisions 非空；每个 decision 有用户确认或**用户明确采用默认值**的记录；专家确认；没有 open blocking；每个 decision 最多 2 轮，超过时 blocking 异议必须解决，不能用“记录 dissent”代替；minutes-final 存在；书记≠主持模型。
- G1 Blueprint：task-graph schema、依赖无环、AC 双向覆盖、review verdict pass 且 ≤3 轮、testability 无 open blocker、三角色模型隔离、用户批准绑定内容哈希。
- Build：任务完成以 `pr_open/merged` + check-task + acceptance 覆盖为准；里程碑要求全部 merged + E2E + 用户批准；发布暂不做。
- gate 文件由核心写，插件只渲染；`pass = checks 全部通过或被 waiver 覆盖`；不可豁免项不能 waiver。
- 轮次耗尽进入 `awaiting_user` 或 `blocked(E_ROUND_LIMIT)`，显式授权才能追加。

## 6.5 专家补充的非阻塞约束

### 专家 A 补充

- 插件硬约束：插件代码不得写 `.collab/**`（CI 可用 grep 拦截）；每个按钮只对应一条核心 CLI 命令，不做多步编排；插件里不得有自动恢复策略代码；Home 只读核心 `pipeline summary`。
- gate 文件不存在时阶段徽章显示“未评估”，不显示“进行中”；徽章只以 `gate.pass` 为数据源。
- 同一错误码在同一任务连续出现 3 次，升级为 `blocked(repeated:<code>)`；`model_mismatch` 硬停。
- 豁免一旦常态化，gate 会失去意义；先 run preflight，看本机实际能满足几条规则，再决定是否放宽协议。
- 0.19 还应包含 stage preflight 与 task-graph → brief.md 导入命令；Studio 第一版可以只是“导入 decisions.json → 用户逐项确认”；9 角色配置 UI 改成每阶段一个 preflight 结果面板。

### 专家 B 补充

- 统一恢复预算：每个逻辑操作最多 3 次模型调用；每角色每阶段最多自动切换 1 次，跨轮次和 resume 累计；每次物理调用独立记录。
- Studio/Blueprint 对产品仓库必须只读；测试框架骨架由 Build 任务落入产品目录。
- Build 隔离必须覆盖最终代码中的所有开发贡献模型；`pr_open` 与 `merged` 分别校验，合并前重新核验证据、代码快照和许可。

## 7. 审计发现

- 专家 C 的原始输出在传输中被截断；本纪要只使用其可见判断和提出的两个裁决问题，未推断缺失部分。
- 专家 A 的 B6“三角色模型两两不同”与其默认方案“测试架构师复用”存在直接矛盾；v2 已按角色档位拆开，未把“跨厂商偏好”误写成硬冲突。
- 当前 `model_resolved` 存在回退/回显，不能作为普遍的实际身份证据。
- 错误分类存在子串误匹配；quota/session/429 合并，裸 403 未独立。
- 插件 Host 存在 GET 触发恢复写状态、flow/stop 的路径，不符合“只读驾驶舱”；写操作需 POST + 幂等键 + expected_revision。
- 中断恢复可能默认清空未提交改动；未知副作用/进程树未停止/交班失败时不得自动重放。
- 合并入口尚未执行完整证据检查；新 gate 必须进入执行路径，不只是 UI。
- `routing.catalog()` 的 `backend/provider` 字段不一致，需要版本化 DTO/契约测试。
- `.collab` 提交行为与过程日志泄漏风险冲突，需在 Q6 后调整提交边界。
- Build 最后一次 review reject 后仍可能继续修复再报 exhausted，需与最终评审轮次/E_REVIEW_REJECTED 对齐。

## 8. 本纪要的结论

`docs/03` 的三阶段方向成立，但 **0.18 不能先做“三阶段页面”**。应先补齐：

1. 控制面落点（Q1）；
2. provider 能力与模型身份契约；
3. 结构化错误与动作表；
4. G0/G1/Build gate 的机器可校验格式；
5. 用户对 Q2–Q6 的裁决。

在这些完成前，插件最多做只读状态投影，不应写业务状态、不应自动推进阶段。

## 9. 确认状态

| 专家 | 状态 | 备注 |
|---|---|---|
| A | accept_with_notes | 非阻塞备注已纳入 v2；无 blocking |
| B | 待复核 | 已按 blocking 修正模型档位、测试架构师冲突、G0 默认值/轮次/异议规则；等待复核 |
| C | accept_with_notes | 原始输出截断；只使用可见部分 |

