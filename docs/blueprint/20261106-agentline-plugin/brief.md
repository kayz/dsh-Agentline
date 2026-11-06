# Blueprint 20261106 — AgentLine 插件与三阶段控制面

状态：设计 Round 1
日期：2026-11-06
主设计：Claude Opus 5.5
审核：GPT-6 Astra

## 1. 目标

为 AgentLine 插件及其 Studio / Blueprint / Build 控制面完成一份**可直接进入实现切分**的完整设计，重点包括：

- 三阶段的界面与用户体验；
- 对话框里的 slash 命令；
- 插件监控内容；
- 模型维护与配置界面；
- 控制面、插件、Build 内核的边界；
- 错误、gate、审批、轮次规则；
- 设计通过后再切分实现工作轮次。

本阶段只做设计，不写产品代码。

## 2. 输入

- `docs/studio/20261106-agentline-plugin/decisions.md`（用户已确认）
- `docs/studio/20261106-agentline-plugin/minutes-final.md`
- `docs/studio/20261106-agentline-plugin/input.md`
- `docs/03-three-stage-pipeline.md`
- `SCOPE.md`
- `AgentLine/SKILL.md`
- `plugin/README.md`
- `plugin/lib/index.js`
- `plugin/lib/client.js`
- `orchestrator/config/agentline.config.json`
- `orchestrator/config/agentline.local.json`
- 现有 `orchestrator/lib/*`、adapters、flow、exec、supervisor、check-task
- `docs/design-final.md`（Shimeji 的设计参考，仅作为跨项目借鉴，不是本仓库规范）

## 3. 已确认的用户决定

1. **控制面**：同仓分层，`orchestrator/studio.mjs` / `blueprint.mjs`，通过 `agentline studio|blueprint` 暴露；`flow.mjs` 保持单任务 Build 内核，零侵入；插件只做无状态投影和公开 CLI 调用。
2. **先完整 Blueprint，再切工作轮次**：不得先做三阶段只读外壳；必须先把界面/UX、slash 命令、监控、模型配置、错误/gate/审批设计完整，再拆实现。
3. **模型维护**：自动/手动维护结合；基于行业公认信息给建议；手工指定兜底；必须有配置界面。
4. **模型验证**：角色指定后做短上下文 probe，记录 requested/resolved、provider、CLI 版本、耗时、错误。
5. **轮次/错误**：可逆基础设施问题（模型限制、断网、429）通过轮换模型/重试继续，不记业务硬停；三轮后 dev/review 业务不收敛才交用户。
6. **Git 留存**：定稿契约/状态/run/verdict 进 git；过程日志/rounds/handoff 外置或 gitignore，本地保留哈希索引。

## 4. 必须覆盖的设计内容

### 4.1 控制面架构

- Studio / Blueprint 的模块位置、命令、状态机、文件布局；
- 与 `flow.mjs` 的边界和共享层；
- 插件如何调用公开 CLI，如何只读状态；
- 如何避免插件写 `.collab/**`、如何避免第二套 orchestrator；
- 与现有 worktree/queue/merge/metrics 的复用。

### 4.2 界面与用户体验

必须给出具体界面和交互，不只是信息架构：

- Home / Inbox：现在卡在哪、需要用户做什么、证据链接；
- Studio：轮次、专家、主持、书记、问题、FACT、纪要、确认；
- Blueprint：设计/评审/测试架构轮次、任务图、测试策略、批准；
- Build：现有任务驾驶舱 + Blueprint 来源、test_levels、gate；
- Settings：模型配置、角色矩阵、provider 能力、预算、轮次上限；
- Artifact viewer：Markdown/JSON、raw 输出按需展开；
- 空状态、未实现状态、blocked/auth/awaiting_user 状态；
- 移动/窄屏/深色模式是否支持，给出底线；
- 哪些内容默认收起，哪些必须一屏可见。

### 4.3 对话框 slash 命令

设计 DSH 聊天中的命令面，例如：

```text
/agentline status
/agentline studio ...
/agentline blueprint ...
/agentline task ...
/agentline models
/agentline approve ...
/agentline answer ...
```

要求：

- 命令如何发现、补全、权限、参数校验；
- 哪些命令会写状态、哪些只读；
- 命令与插件 UI 按钮的对应关系；
- 命令失败/权限不足/阶段不允许时的错误；
- 如何避免用户绕过 gate 直接 `flow`；
- 命令是否支持自然语言别名。

### 4.4 插件监控内容

明确插件要显示什么、不显示什么：

- 当前阶段/轮次/模型/耗时/预算；
- 运行中的 Studio/Blueprint/Build 任务；
- 待用户回答的问题、待批准 gate；
- provider/CLI 健康：安装、版本、认证、callable、最近失败；
- 模型 requested/resolved、tier、隔离状态；
- 错误分类、重试/轮换、是否硬停；
- token/费用/额度；
- 事件时间线和审计链接；
- 不显示 raw prompt/敏感日志的默认策略。

### 4.5 模型维护与配置界面

- 自动发现 + 手动登记；
- 行业建议的来源、置信度、过期；
- top/advanced/standard 档位如何认定；
- 角色分配、候选、备用、手工兜底；
- 短上下文 probe 的触发、结果、缓存、失败处理；
- 模型下线/新版本/别名/厂商变化；
- 配置变更的审批和回滚；
- UI 字段和交互。

### 4.6 错误与轮次规则

- 结构化错误表：code/category/provider/http/exit/retry_after/scope/side_effects/recovery；
- 可逆 vs 业务失败；
- 自动重试/轮换/换现场/blocked/用户介入；
- 次数、等待、预算、幂等；
- 何时记录 `blocked`，何时记录 `awaiting_user`；
- 业务三轮不收敛交用户；基础设施错误不计业务硬停；
- 失败证据保留和审计。

### 4.7 Gate 与审批

- G0 Studio、G1 Blueprint、Build 任务/里程碑/发布 gate；
- 机器可校验的 JSON 结构；
- checks、waivers、approval hash、revision；
- 插件只渲染 core 计算的 gate；
- 未评估/通过/失败/豁免的状态；
- 审批绑定内容哈希，内容改动后失效。

### 4.8 迁移与兼容

- 现有 Build 任务、路由、`flow` 命令保持兼容；
- 新增 CLI/路由/数据目录的版本；
- 旧 `.collab/tasks` 不受影响；
- 插件设置迁移；
- 回滚路径；
- 不能因为升级破坏正在运行的任务。

## 5. 输出

输出 `design-v1.md`，至少包含：

1. 结论摘要与关键取舍；
2. 控制面/插件/Build 内核架构图；
3. 数据模型和文件布局；
4. CLI 命令和 Host API 契约；
5. 界面/UX 流程与 slash 命令；
6. 模型维护与配置设计；
7. 错误/轮次/gate 表；
8. 监控与审计；
9. 迁移/兼容/回滚；
10. 实现切分建议（通过 Blueprint 后再生成具体任务图）；
11. 测试策略；
12. 风险与待用户裁决项。

设计要具体到字段、状态、错误码、命令、页面和交互；不要只给原则，不要写产品代码。

## 6. 审核标准

- 是否真正覆盖 UI/UX、slash 命令、监控、模型配置，而不只是后端；
- 插件是否仍然是无状态投影；
- 模型身份、短上下文 probe、手工兜底是否可执行；
- 错误/轮次规则是否区分业务失败和基础设施失败；
- gate 是否机器可校验，审批是否绑定内容；
- 迁移是否不破坏现有 Build；
- 是否与用户 Q1–Q6 决策冲突；
- 是否能进入实现切分，而不是继续讨论。

审核输出 `APPROVE | REVISE | REJECT`，最多 3 轮。
