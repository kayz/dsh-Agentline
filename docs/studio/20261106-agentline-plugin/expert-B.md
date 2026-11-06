## 1. 核心判断

**建议 `accept_with_notes`：三阶段方向正确，但正式编排上线前，必须先补齐模型身份、错误恢复和阶段 gate 的公共契约。** 0.18–0.21 可以作为交付顺序，不能理解为只改四轮插件页面。

本评审已阅读全部指定文件，并补查执行、恢复、CI、合并和证据检查实现；仅做静态评审，未修改仓库、未执行模型调用或测试。以下新增字段、错误码和命令均为建议契约。

当前最需要解决的具体问题：

| 优先级 | 代码事实 | 对改造的影响 |
|---|---|---|
| P0 | `exec.mjs` 使用 `res.modelResolved || model.id`；Codex adapter 返回 `null`，Gemini adapter直接返回请求模型。见 [执行记录](/C:/git/dsh-Agentline/orchestrator/lib/exec.mjs:158)、[Codex](/C:/git/dsh-Agentline/orchestrator/lib/adapters/codex.mjs:117)、[Gemini](/C:/git/dsh-Agentline/orchestrator/lib/adapters/gemini.mjs:119) | 当前 `model_resolved` 不能普遍证明实际模型，无法支撑严格隔离和禁止降级 |
| P0 | `flow` 按请求模型排除评审候选；`check-task` 在实际模型缺失时也回退到请求模型。见 [flow](/C:/git/dsh-Agentline/orchestrator/lib/flow.mjs:357)、[check-task](/C:/git/dsh-Agentline/AgentLine/tools/check-task.ps1:248) | 不同别名、不同渠道或内部回退可能绕过隔离 |
| P0 | quota、session limit、429 合并为 `rate_limit`；没有明确识别裸 403。见 [错误分类](/C:/git/dsh-Agentline/orchestrator/lib/exec.mjs:268) | 无法可靠决定等待、换模型还是立即阻塞 |
| P1 | 网络重试立即执行，多次调用最终合成一条 run；`maxSwitchesPerStage=2` 的当前实现通常只允许尝试两个候选，并且局部计数随调用重置。见 [执行循环](/C:/git/dsh-Agentline/orchestrator/lib/exec.mjs:110) | 重试次数、切换次数、费用和恢复行为难以审计 |
| P1 | `/projects` 查询会触发恢复写状态；`/flow`、停止操作可由 GET 触发。见 [Host 路由](/C:/git/dsh-Agentline/plugin/lib/index.js:550) | “只读驾驶舱”目前并非严格只读 |
| P1 | 合并入口检查状态、风险档位和许可，但没有调用完整证据检查。见 [合并实现](/C:/git/dsh-Agentline/orchestrator/agentline.mjs:324) | 新增 gate 必须进入执行路径，不能只用于展示 |

另有一个直接的数据契约问题：`routing.catalog()` 读取 `m.backend`，发现配置主要记录 `provider`，客户端却直接调用 `m.backend.replace()`。这类缺口应在 0.18 用 schema 和契约测试消除，见 [catalog](/C:/git/dsh-Agentline/orchestrator/lib/routing.mjs:94)、[客户端](/C:/git/dsh-Agentline/plugin/lib/client.js:505)。

## 2. 推荐架构与边界

按 [SCOPE.md](/C:/git/dsh-Agentline/SCOPE.md) 和 [三阶段协议](/C:/git/dsh-Agentline/docs/03-three-stage-pipeline.md)，保留单任务 Build 内核。改造输入中的“核心有正式命令和状态机”，应解释为 **AgentLine 产品提供统一入口，Studio/Blueprint 状态机由独立控制面模块实现**。

| 层 | 应负责 | 不应负责 |
|---|---|---|
| 插件 UI／Host | 展示、收集用户输入、调用公开命令、订阅状态和通知 | 拼角色 prompt、判断 gate、写业务状态、实施重试 |
| Pipeline 控制面 | Studio/Blueprint 会话、轮次、确认、审批、任务图依赖调度 | 再实现一次 Build 执行循环 |
| 公共运行层 | Provider adapter、模型目录与身份、预算、调用记录、错误策略 | 决定业务设计是否通过 |
| Build 内核 | 单任务 design→dev→CI→review、worktree、执行槽、范围检查、合并门禁 | 跨项目优先级、Studio 讨论 |
| 契约与证据层 | JSON Schema、gate evaluator、审批引用、版本和摘要校验 | 从 Markdown 标题或文件存在推断批准 |

具体建议：

- 继续使用同一 CLI，但新增独立 `studio`、`blueprint`、`pipeline` 子命令；不扩张现有 `flow` 的语义。
- Adapter 放在公共 provider 层。初期可以仍在同一仓库，无须立即拆 npm 包或常驻服务。
- 每个资源只有一个状态写入者；插件通过公开接口访问，逐步替换 `importFresh()` 对内部模块的依赖。
- Studio/Blueprint 的产品仓库访问必须只读。测试框架骨架保存在 Blueprint 产物区，由 Build 任务落入产品目录；不能直接复用当前 `acceptEdits`／`workspace-write` 权限配置。
- 既有 worktree、交班、CI、合并预授权可以复用，但必须接入统一 gate。

## 3. CLI / 模型 / 错误 / Gate 的具体规则

**A. Provider manifest 与运行时 capability descriptor 分开。**

Manifest 描述“适配器经过验证支持什么”；descriptor 描述“当前这台机器、这个版本和账户实际具备什么”。

| 类别 | 必需字段 |
|---|---|
| 标识与版本 | `schema_version`、`provider_id`、`adapter_id`、`adapter_version` |
| 可执行程序 | `command`、解析后的 `executable_path`、`executable_fingerprint`、`cli_version` |
| 兼容性 | `supported_version_ranges`、`tested_versions`、`command_profile`、`protocol_version`、`fixture_suite_version` |
| 调用方式 | argv 构造器 ID、输入方式、输出编码、JSON/JSONL 格式、必需结束事件、取消及进程树终止能力 |
| 认证 | `auth_methods`、检查命令及解析器 ID、`auth_status`、脱敏 `account_scope_id`、`checked_at` |
| 模型发现 | 来源类型、解析器 ID、分页能力、缓存 TTL、账户作用域、发现可信度 |
| 能力 | 显式模型选择、实际模型上报、工具能力、只读能力、结构化输出、usage、effort 支持集合 |
| 恢复能力 | CLI 内部重试上限是否可控、是否支持安全恢复、是否能判断调用已开始产生副作用 |
| 错误映射 | 结构化错误映射版本、文本兼容规则版本、HTTP／退出码保留规则 |
| 运行限制 | 调用超时、API 静默阈值、工具超时、并发限制、输出大小限制 |

执行规则：

1. `check()` 返回安装、版本兼容、认证、能力四项结果，不能压成一个 `ok`。
2. 版本或二进制指纹变化，立即失效能力探测缓存。未验证版本返回 `E_CLI_VERSION_UNSUPPORTED`，不自动删参数继续尝试。
3. 已知结束事件缺失、输出截断或必需事件无法解析，返回 `E_CLI_PROTOCOL_MISMATCH`；**退出码 0 不等于调用成功**。
4. 非零退出且没有已知错误，返回 `E_CLI_EXIT_UNKNOWN`，保留退出码、signal、stdout/stderr 引用。
5. Adapter 输出统一事件：`started / model_resolved / tool_started / tool_finished / usage / completed / failed`。
6. 契约测试至少覆盖：正常完成、401、403、429、session limit、quota、非零退出、空输出、截断 JSON、结束事件缺失、多模型输出。
7. CLI 内部重试也必须声明。不能声称“最多调用三次”就等于“底层最多发送三次请求”。

**B. 顶级模型采用显式、版本化 allowlist；发现结果只证明可见。**

模型目录至少包含：

```text
model_key                 provider_id + provider_model_id，避免渠道同名碰撞
provider_id               调用渠道
origin_vendor             原始模型厂商
canonical_model_id        规范模型身份
identity_group            同一底层模型及其别名的等价组
tier                      top | advanced | standard | unknown
capabilities              tools / structured_output / context 等
discovery_source          api | cli | cli_scan | manual
availability              unknown | callable | unavailable | blocked
availability_scope        account_scope_id + endpoint + CLI 指纹
observed_at / expires_at
```

当前发现合并按裸 `m.id` 去重，存在跨渠道同名覆盖问题，见 [配置合并](/C:/git/dsh-Agentline/orchestrator/lib/config.mjs:41)。

机械校验顺序：

1. 人工维护 `model-policy.json`，每条授权绑定准确模型身份、允许角色、档位、有效期、依据及策略版本；不能用名称包含 `opus/pro` 判断顶级。
2. Provider 元数据补充能力；CLI 扫描仅进入 `discovered`，不能自动加入 top allowlist。
3. 阶段开始时求出完整角色分配，校验全部候选，包括备用模型。
4. 请求模型必须显式指定；禁止 `auto`、未绑定的滚动别名及未批准备用项。
5. 运行中验证实际身份，结束时再次验证。身份未知返回 `E_MODEL_UNVERIFIED`，不补成请求模型；不符返回 `E_MODEL_MISMATCH`。
6. 同一运行出现多个参与判断的模型时记录 `resolved_models[]`；所有身份都须符合策略，不能取 `modelUsage` 的第一个键作为全部证明。
7. 切换只能进入同档、已批准、满足能力和隔离要求的候选；任何变化写入事件和 UI。
8. `effort_requested`、`effort_effective` 分开。未授权的 effort 下调返回 `E_EFFORT_UNSUPPORTED`，不继续静默 clamp。

建议角色硬约束：

| 阶段 | 约束 |
|---|---|
| Studio | 三专家使用不同 `identity_group`；专家及主持须 top；书记按协议的角色特例允许 advanced；主持与书记不同模型 |
| Blueprint | 三角色均 top、模型两两不同；设计师和评审不同原始厂商；测试架构师跨厂商为偏好 |
| Build | verifier 不得等于保留在最终代码中的任何开发贡献模型，包括交班前候选；不能只比较最后一次 dev |
| 全部阶段 | 角色上下文独立；模型无法确认时不能宣称隔离通过 |

本机配置里的三个字符串只证明已选择候选，**不能据此认定档位、可调用性或真实隔离**。

**C. 错误必须先结构化，再决定动作。**

统一错误字段：

```text
code, category, provider_code, http_status, exit_code,
scope, retry_after_ms, reset_at, evidence_ref,
classification_source, side_effects, recovery_action
```

分类优先级：可信 provider 错误码 → 协议事件 → 进程错误 → 版本化文本规则。未知情况不猜成可重试错误。

| 错误码／类别 | 默认动作与上限 |
|---|---|
| `E_AUTH_REQUIRED / E_AUTH_EXPIRED` → `auth` | 立即 `blocked(auth)`；重试 0、切换 0。认证恢复后显式恢复 |
| `E_ACCESS_DENIED` → `access_denied` | 裸 403、明确无权限：立即 blocked；重试 0、切换 0。不能把所有 403 当登录过期 |
| `E_RATE_LIMIT` → `rate_limit` | 短期限流可重试 2 次；尊重 Retry-After；单次等待 ≤60 秒、累计 ≤120 秒，超出则 blocked 并显示恢复时间 |
| `E_SESSION_LIMIT` → `session_limit` | 若明确为账户使用窗口耗尽，同池重试 0；允许一次预授权、同档、独立额度池切换，否则 blocked |
| `E_QUOTA_EXHAUSTED` → `quota` | 同池重试 0；同上。禁止新建会话“刷新额度” |
| `E_MODEL_UNAVAILABLE` → `model_unavailable` | 已确认下线／不可用：同模型重试 0；合规备用切换最多 1 次 |
| `E_PROVIDER_CAPACITY` → `capacity` | 短暂拥塞按 rate_limit 等待规则处理 |
| `E_TRANSIENT_NETWORK` → `transient_network` | 仅安全可重放时，同模型重试最多 2 次；建议 2 秒、8 秒加抖动 |
| `E_CLI_CRASH / E_TIMEOUT / E_API_STALL` | 已证明没有不明副作用时，最多重试 1 次；否则 `blocked(interrupted)` |
| `E_TOOL_STALL / E_SIDE_EFFECT_UNKNOWN` | 停止并确认进程树退出，立即 blocked；不自动重复工具操作 |
| `E_INVALID_OUTPUT` | 协议完成、仅业务 JSON 不合格时允许格式修复 1 次；不得借修复重新讨论或修改产品代码 |
| `E_CLI_MISSING / E_CLI_VERSION_UNSUPPORTED / E_CLI_PROTOCOL_MISMATCH` | 立即 blocked；重试 0、切换 0，修复环境或适配器 |
| `E_CI_FAILED` | 在已批准范围内允许开发修复 1 次并重跑 CI；仍失败则 blocked |
| `E_REVIEW_REJECTED` | 进入剩余的业务修订轮次；不更换评审寻找通过意见 |
| `E_BUDGET_EXCEEDED / E_ROUND_LIMIT` | 立即 blocked；不得由 resume 重置计数 |
| `E_USER_CANCELLED` | `cancelled`；无自动重试或恢复 |
| 未知错误、证据损坏、模型冲突、范围越界 | 立即 blocked，保留现场 |

“session limit”若实际表示并发槽不足，应根据结构化子码归为 `concurrency_limit`；上下文过长归为 `context_limit`。不能只匹配单词 `session`。

统一上限建议：

- **每个逻辑操作最多 3 次模型调用**，首次调用、重试、格式修复、备用调用合计计算。
- **每个角色在一个阶段会话内最多自动切换 1 次模型**，跨轮次和 resume 累计。
- 每次物理调用单独生成 `attempt_id`、日志和 usage；失败调用也计费计数。
- 达到任一上限即停止。阶段还必须配置总调用数和总时长预算；可信的 token／金额预算可叠加，未知 usage 不能记为 0。
- 仅在确认旧进程树停止、现场快照完成后重试或切换；交班失败返回 `E_HANDOFF_FAILED`。
- 默认保留修改、未跟踪文件、原始输出和失败产物。当前 interrupted 恢复默认丢弃改动，应改为显式 `restart_clean` 才清理，见 [恢复路径](/C:/git/dsh-Agentline/orchestrator/lib/flow.mjs:258)。

**D. 状态与轮次分开。**

新增控制面状态建议：

```text
draft → ready → running → completed
                  ├→ retry_wait → running
                  ├→ awaiting_user
                  ├→ blocked
                  ├→ cancelled
                  └→ failed
```

- `awaiting_user`：正常问答、阶段批准、里程碑验收。
- `blocked`：执行或质量条件失败，没有获准的自动恢复路径。
- `failed`：任务被明确终止，或不可恢复的内部错误。
- 轮次耗尽统一为 `blocked + E_ROUND_LIMIT + requires_user=true`；UI 可显示“等待裁决”，不能继续执行。
- Studio 每个决策最多两轮；默认值必须有用户明确采用记录。
- Blueprint 最多三个设计版本；按照本轮输入，下一轮由明确的 `start-round` 授权启动，不自动连续跑三轮。
- Build 默认最多两次评审；最后一次拒绝后立即停止，不再额外修复。当前循环会在最后一次拒绝后继续修复，随后才报 exhausted，应修正。

**E. Gate 用固定校验器和结构化证据表达。**

新增建议命令：

```text
node orchestrator/agentline.mjs gate check --repo <repo> --stage studio --session S1 --json
node orchestrator/agentline.mjs gate check --repo <repo> --stage blueprint --session B1 --json
node orchestrator/agentline.mjs gate check --repo <repo> --stage build --task 001 --json
```

建议退出码：`0=通过`、`10=待用户操作`、`20=阻塞`、`30=契约或内部错误`。日志走 stderr，stdout 只输出 JSON。

```json
{
  "schema_version": "agentline.gate/1",
  "gate_id": "blueprint.enter_build",
  "resource_id": "B1",
  "revision": 7,
  "subject_digest": "sha256:...",
  "policy_version": "pipeline-policy/1",
  "result": "awaiting_user",
  "checks": [
    {
      "id": "graph.acyclic",
      "status": "pass",
      "evidence_ref": "task-graph.json"
    },
    {
      "id": "approval.current_digest",
      "status": "pending",
      "code": "E_APPROVAL_REQUIRED"
    }
  ],
  "allowed_actions": ["blueprint.approve"]
}
```

Gate 条件：

| Gate | 必须机械满足 |
|---|---|
| Studio→Blueprint | 输入和参与者冻结；三专家完成观点、拆台及确认；纪要存在且摘要匹配；FACT 有来源及状态；blocking 问题全部回答；逐项决策被用户确认；blocking 异议已解决 |
| Blueprint→Build | 当前版本评审通过；测试架构师确认可测试；无 testability blocker；任务图无环、依赖存在；每任务具有输入、输出、范围、验收及测试层级；验收矩阵完整覆盖；G1 批准绑定当前产物摘要 |
| Build→`pr_open` | design/acceptance 完整；实际变更未越界；当前代码快照的 CI 全通过；独立模型评审通过；全部证据属于本任务、本次执行及同一代码快照 |
| `pr_open`→`merged` | 再校验证据及代码快照；显式许可或有效且覆盖该任务的低风险预授权；批准后发生代码变化则重新评估 |
| 里程碑完成 | 所需任务已集成；集成快照的跨任务测试、回归及人工验收证据完整；G2 用户接受 |
| 可发布 | 交付物绑定已验收快照、必需检查通过、G3 用户接受；发布部署仍由外部控制面执行 |

补充硬规则：

- `accept_with_notes` 只能携带非 blocking 意见；`reject` 不能直接变成通过。
- Markdown 为阅读视图。FACT、问题、验收矩阵、确认和批准应有 JSON 权威记录。
- 审批绑定 `subject_digest`，产物改变后自动失效；文件存在不代表批准有效。
- 豁免包含 `rule_id / actor / reason / subject_digest / expires_at`，只能豁免策略明确允许的软规则。模型身份、必需用户批准、测试可执行性等硬条件不能靠泛化 `force=true` 绕过。
- 校验器验证证据完整性和签署关系，不声称能自动证明设计正确。

## 4. 数据与接口

**插件和 CLI 使用同一版本化契约。**

新增能力查询建议返回：

```json
{
  "api_version": "agentline/1",
  "core_version": "0.x",
  "features": {
    "studio.read": true,
    "studio.execute": false,
    "blueprint.execute": false,
    "build.flow": true
  },
  "schema_versions": {
    "pipeline": 1,
    "gate": 1,
    "run": 2
  }
}
```

接口规则：

- GET 严格只读；回答、确认、启动、停止、批准统一 POST。
- 写请求携带 `request_id`、`idempotency_key`、`expected_revision`；旧版本返回 `E_REVISION_CONFLICT`／HTTP 409。
- 长任务返回 HTTP 202 和持久化 `operation_id`；不能仅返回内存 `jobs` 和 PID 就认定已开始执行。
- 响应提供服务端计算的 `allowed_actions`；UI 不根据颜色、退出码或文件名自行推断。
- 状态文件损坏显示 `E_STATE_CORRUPT`，不能当空会话。
- 生命周期记录、审批和 gate 由可信控制进程写入；角色只能提交候选产物。仅写 `"actor":"user"` 不构成人类批准证据。

Run v2 至少增加：

```text
run_id, operation_id, attempt_id, stage, session_id, task_id, role,
round, decision_id, provider_id, account_scope_id,
cli_version, adapter_version, capability_digest, policy_digest,
model_requested, model_reported, model_resolved,
resolution_status, resolution_evidence_ref, resolved_models[],
effort_requested, effort_effective,
context_id, input_digest, output_digest, code_digest,
error, recovery_action, retry_of, switched_from,
usage, usage_completeness, checkpoint_ref
```

UI 必须并列显示“请求模型／实际模型／验证状态”。历史记录缺证据时标记 `legacy_unverified`，不能回填成已验证。

**Blueprint→Build 的接口应是已批准、可验证、可幂等导入的任务包。**

```json
{
  "schema_version": "agentline.task-graph/1",
  "blueprint_id": "B1",
  "revision": 3,
  "approval_ref": "approval-17",
  "milestone": "M1",
  "base_commit": "<sha>",
  "test_strategy_ref": "test-strategy.md",
  "acceptance_matrix_ref": "acceptance-matrix.json",
  "tasks": [
    {
      "node_id": "N1",
      "title": "建立运行状态接口",
      "depends_on": [],
      "inputs": ["interfaces.md#run"],
      "outputs": ["run-status-api"],
      "write_scope": ["orchestrator/lib/", "orchestrator/test/"],
      "acceptance": ["AC-001"],
      "test_levels": ["contract", "integration"],
      "acceptance_commands": [
        {
          "id": "AC-001",
          "executable": "pwsh",
          "args": ["-NoProfile", "-File", "scripts/check-fast.ps1"],
          "cwd": ".",
          "expected_exit_code": 0
        }
      ],
      "user_gate": false
    }
  ]
}
```

上例命令必须在实际目标仓库中存在并通过检查，不能直接作为所有项目默认值。

导入器负责：

1. 验证批准与当前产物摘要一致；检查 DAG、路径、命令及验收引用。
2. 以 `blueprint_id + revision + node_id` 去重，原子分配任务号并生成 `brief.md` 和来源记录。
3. 首版只有上游节点 `merged` 且提交已进入当前集成基线，才启动下游；`pr_open` 不满足依赖。
4. Build designer 继续生成任务级 design、acceptance、write_scope；不得放宽 Blueprint 已批准范围或删除验收义务。
5. 范围扩大返回 `E_BLUEPRINT_SCOPE_EXPANSION`；返回 Blueprint 修订并使受影响批准失效。

插件不应重复实现任务编号分配、依赖排序、brief 生成、write_scope 匹配、重试、模型隔离、CI 判定或合并许可检查。

## 5. 路线与最小切片

| 版本 | 最小交付 | 放行标准 |
|---|---|---|
| **0.18** | 能力查询、只读 pipeline summary、版本化 DTO；展示已有产物和真实缺失状态；模型 requested/resolved/unknown 可见 | 刷新不写业务状态；没有会话显示 `not_started`，没有引擎显示 `unsupported`；不从文件存在推断批准 |
| **0.19** | Studio 控制面及共用运行层；先打通一个决策的一轮“专家→拆台→纪要→确认→用户决策” | 至少满足角色策略所需的模型身份；auth、协议漂移、身份未知均可确定性阻塞；恢复不重复执行已完成操作 |
| **0.20** | Blueprint 三角色、单轮设计评审、测试矩阵、G1；先支持单节点任务图及导入预览 | 同一审批摘要可复核；图和验收关系机械可查；版本变更使批准失效；轮次计数持久化 |
| **0.21** | 批准任务图导入 Build、依赖调度、来源追踪、统一任务和合并 gate、G2/G3 展示 | 重复导入不重复派活；失败不丢现场；上游未集成不启动下游；审批和 CI 与实际代码快照一致 |

**第一版最小切片建议：一个项目的 Pipeline 总览＋一个 Build 任务的结构化 gate 详情＋真实模型身份状态。** Studio/Blueprint 先显示能力和已有产物，不开放编排按钮。

需要后置的内容：自动质量排名、动态“顶级模型”榜单、健康度驱动隐式重排、通用可编程工作流、多提供商同时完整适配、未合并任务之间的复杂产物传递、自动发布部署。

每版验证重点应是失败路径：重复请求、进程中断、未知模型、过期审批、解析漂移、轮次耗尽。不能仅凭正常演示放行。

## 6. 风险

1. **模型身份的证据不足。** 当前 adapter 无法普遍证明实际执行模型。严格执行规则可能使部分现有候选暂时不可用；接受请求参数作为证明，则会削弱隔离承诺。这是 Studio/Blueprint 上线的关键前置条件。

2. **重试放大成本并污染现场。** CLI 内部重试、调度器重试、业务修订、resume 若分别计数，名义上的“两次重试”会变成持续执行。必须持久化操作标识、统一预算、保留每次调用，并区分安全重放与未知副作用。

3. **插件、控制面与内核各自判断状态。** 当前已存在查询触发恢复、从退出码推断终态、直接写配置和任务文件等做法。若照此扩展，会出现 UI 已批准而执行端未批准、任务已完成但证据属于旧代码等问题。状态写入者、摘要绑定和 gate 执行路径必须先统一。

## 7. 需要用户裁决的问题

以下为评审产生的裁决项，不影响本次只读评审完成；分别阻塞严格模型策略和轮次扩展规则定稿。

```json
{
  "ask_user": [
    {
      "id": "model_identity_evidence",
      "blocking": true,
      "question": "CLI 无法提供可信的实际模型身份时，是否允许它参与要求模型隔离的阶段？",
      "options": [
        {
          "id": "strict",
          "label": "不允许，blocked(model_unverified)",
          "recommended": true
        },
        {
          "id": "explicit_exception",
          "label": "允许人工登记的固定版本例外，持续显示 unverified，且不得宣称实际隔离已验证"
        }
      ]
    },
    {
      "id": "round_limit_override",
      "blocking": true,
      "question": "Blueprint 三轮不收敛后，采用协议中的硬停止，还是允许输入文档所述的显式授权追加轮次？",
      "options": [
        {
          "id": "hard_limit",
          "label": "原会话最多三轮；用户裁决或修订输入后建立有来源关联的新会话",
          "recommended": true
        },
        {
          "id": "bounded_extension",
          "label": "允许一次追加一轮；记录授权、原因和新增预算，最多四轮"
        }
      ]
    }
  ]
}
```