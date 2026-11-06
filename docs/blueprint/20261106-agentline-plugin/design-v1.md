# AgentLine Blueprint 20261106：插件与三阶段控制面设计 v1

- 状态：设计 Round 1，待审核
- 日期：2026-11-06
- 主设计：Claude Opus 5.5；审核：GPT-6 Astra
- 输入：`brief.md` 第 2 节列出的全部文件，以及现有 `orchestrator/lib/*`、`adapters/*`、`plugin/lib/index.js`、`plugin/lib/client.js`
- 约束：本文件只做设计，不写产品代码，不改仓库。需要用户裁决的问题集中在第 12 节，正文里遇到时标 `⚑U<n>`，没有自行拍板。

---

## 1. 结论摘要与关键取舍

### 1.1 一句话结论

在 `orchestrator/` 下新增 **控制面层（Studio、Blueprint、Build Supervisor、Gate、Model Catalog）** 和一个 **只读的 Read API**。

- `flow.mjs` 一行不改，Build 仍由它单任务执行。
- 插件分两条通道工作：读，走 Read API（进程内导入纯函数）；写，按白名单把每次操作翻译成**一条** `agentline` CLI 子进程调用。插件本身不保存业务状态。
- 所有“下一步做什么”都由核心计算：阶段状态、gate、错误动作、模型身份、Inbox。插件只负责渲染、收集输入、转发命令。

### 1.2 关键取舍

| # | 取舍 | 选择 | 理由 |
|---|---|---|---|
| T1 | Build 的结构化错误与自动恢复放在哪里 | 新增 `build supervisor`（`agentline build …`），在 flow **外面**读 `state.json`、`run.json`、日志，重新分类后决定 `flow --resume --keep`、等待或升级给用户 | 用户决定 flow 零侵入；flow 本来就会落盘 `blocked_reason` 和 `run.json`，外层足以判断 |
| T2 | 插件怎么读状态 | 进程内导入 `orchestrator/lib/read/index.mjs`（纯读、带版本号）；**不用**每 5 秒起一个 CLI 子进程 | 轮询频率高。纯读模块只要用静态检查保证“不写盘”，就仍属于核心代码，插件依旧是投影 |
| T3 | 插件怎么写状态 | 单一入口 `POST /agentline/v2/command`，按命令白名单映射为一条 CLI argv，带 `idempotency_key` 和 `expected_revision` | 满足“一个按钮对应一条 CLI 命令”，杜绝插件里出现多步编排 |
| T4 | Inbox 存在哪里 | 不存。由 Read API 根据各阶段状态**派生** | 存一份就会出现第二份真相 |
| T5 | 审批来自哪个通道 | approve、waive、answer、decide、merge、config apply **只能来自**斜杠命令或 UI 按钮，不作为 LLM 工具暴露 | 防止模型替用户批准；CLI 无法验证调用者是不是人（沿用 `grant` 的已知限制，见 R4） |
| T6 | gate 状态和内容哈希的关系 | `gate.json` 由核心写入；读取时 Read API 重新算一遍内容哈希，不一致就派生为 `stale`，**不写盘** | 改了内容，批准立即失效，不依赖有人去跑一次 eval |
| T7 | 过程记录放哪里 | 放仓库外的 `AGENTLINE_DATA`，默认 `%LOCALAPPDATA%\AgentLine`（不在 OneDrive 下，⚑U9）。git 里只放定稿文件和 `records_index_sha256` | 对应 Q6，也符合本机“仓库在 OneDrive，不要生成大量临时文件”的约束 |
| T8 | Blueprint 每次跑多少 | 每次 `run` 只执行**一轮**（design → testability → review），然后停在 `awaiting_user(continue_round)`，默认选项“继续下一轮” | input 2.9 明确“不自动连续跑 3 轮”；一键继续也不至于让人一直盯着 |
| T9 | 运行中可以换哪些模型 | 只能换到阶段开始时已经锁定并 probe 过的候选（`roles.lock.json`）。列表外一律不换 | 对应 Q5“轮换继续”，同时满足“禁止静默降级” |
| T10 | 阶段角色配置存在哪 | 新文件 `agentline.stages.local.json`。现有 `agentline.local.json` 的 v1 结构不动 | 回滚时旧核心完全不受影响 |

---

## 2. 架构

### 2.1 总图

```text
┌──────────────────────────── DSH ────────────────────────────┐
│  Chat: /agentline …        Panel: AgentLine 驾驶舱 (client.js)│
│        │                          │ GET /agentline/v2/*        │
│        ▼                          │ POST /agentline/v2/command │
│  plugin host (index.js)  ◄────────┘                            │
│   ├─ ReadBridge ── import ──► orchestrator/lib/read/*  (纯读)   │
│   ├─ CommandBridge ─ spawn ─► node agentline.mjs <one cmd> --json│
│   └─ 插件私有数据: orchestrator/data/plugin/ (origins, UI prefs) │
└──────────────────────────────────────────────────────────────┘
                                    │ 唯一写入通道
┌──────────────────── orchestrator (core) ─────────────────────┐
│ agentline.mjs  (CLI 分发；新增子命令，旧子命令语义不变)         │
│                                                               │
│ ── 控制面 (新增，与 flow.mjs 平级 ⚑U4) ─────────────────────── │
│ lib/studio.mjs      Studio 状态机 / 轮次 / 问题 / 纪要          │
│ lib/blueprint.mjs   Blueprint 状态机 / 三角色轮次 / materialize │
│ lib/build-ctl.mjs   Build Supervisor：外包 flow，错误动作、队列 │
│ lib/control/                                                   │
│   errors.mjs     结构化错误 + 动作表（新分类器，不改 exec 的旧分类）│
│   gate.mjs       G0/G1/T/M/G3 求值、内容哈希、waiver            │
│   approval.mjs   批准记录、失效判定                            │
│   catalog.mjs    模型目录、档位、身份组、生命周期               │
│   providers.mjs  provider manifest + runtime capability        │
│   probe.mjs      短上下文 probe                                │
│   stage-exec.mjs 只读快照里执行一次模型调用（复用 adapters）    │
│   records.mjs    外置过程记录 + 哈希索引                        │
│   events.mjs     事件流                                         │
│   revision.mjs   revision / 锁 / 幂等                            │
│ lib/read/        Read API：summary / inbox / sessions / gates / │
│                  models / providers / artifacts（不 import 写 API）│
│                                                               │
│ ── Build 内核 (不改) ──────────────────────────────────────── │
│ lib/flow.mjs  exec.mjs  ci.mjs  worktree.mjs  registry.mjs ...  │
│ adapters/*    （只做增量：补实际模型身份字段，旧字段保持）        │
└──────────────────────────────────────────────────────────────┘
        │ 读写                                │ 读写
  <repo>/.collab/** (git 定稿)        %LOCALAPPDATA%\AgentLine\ (过程记录)
```

### 2.2 边界规则（全部可以机器检查）

| 编号 | 规则 | 怎么检查 |
|---|---|---|
| B1 | 不修改 `orchestrator/lib/flow.mjs` | 用 CI 守卫比对该文件 hash，与基线不一致即失败；改它需要单独开 Blueprint |
| B2 | Build 状态集合 `draft…merged/blocked` 和 `blocked_reason` 取值不变 | 契约测试：用 v0.4.0 的旧 fixture 跑 `check-task`，结果必须一致 |
| B3 | `plugin/lib/**` 里没有任何指向 `.collab` 的写入：`writeFileSync / appendFileSync / mkdirSync / rmSync / renameSync / unlink` | 静态扫描。只有 `orchestrator/data/plugin/` 白名单内允许写 |
| B4 | 插件里 spawn `agentline.mjs` 只能经过 `CommandBridge`，argv 必须由白名单模板生成 | 静态扫描 + 单元测试 |
| B5 | 插件里没有任何重试、轮换、恢复决策代码（不能出现 `resume` 判断或 `setTimeout` 重发命令） | 代码评审清单 + 扫描关键字 `--resume` |
| B6 | `lib/read/**` 不 import 写盘 API，也不 import `control/revision.mjs` | 静态扫描 |
| B7 | adapters 只做增量：新增 `identity` 字段，旧字段 `modelResolved` 的语义不变 | adapter 契约测试 |
| B8 | 在 Studio/Blueprint 阶段，产品仓库工作区必须保持只读 | `stage-exec` 调用前后比较 `git status --porcelain` 和 HEAD；有变化即 `E_READONLY_VIOLATION`（硬停） |

> 关于“adapters 增量”和“flow 零侵入”是否冲突：adapters 属于共享层，不属于 flow。新增字段不会改变 flow 的行为，因为 flow 只通过 `exec.mjs` 读取 `modelResolved`，而这个字段的语义保持不变。

### 2.3 与现有部件的复用

| 现有部件 | 复用方式 |
|---|---|
| `adapters/*` | `stage-exec` 和 `probe` 直接调用 `adapter.run()`。Studio/Blueprint 调用时使用只读工具集：claude 用 `allowedTools: ["Read","Grep","Glob"]`；codex 用 `sandbox: read-only`；gemini 和 codebuddy 由 `providers.mjs` 的 capability 声明 `readonly_mode`，不支持的 provider 不能担任 Studio/Blueprint 角色 |
| `worktree.mjs` | 不修改。`stage-exec` 另写 `ensureSnapshot()`，用 `git worktree add --detach <AGENTLINE_DATA>/…/snapshots/<sid>` 建 HEAD 快照，阶段结束后删除 |
| `registry.mjs` 容量槽 | `build-ctl` 照常使用。Studio/Blueprint 的调用也占槽（`kind: "stage"`），所以全局 `maxTasks` 对三阶段一起生效 |
| `merge-policy.mjs` | `build merge` 先求 T gate，再调用现有的 `merge`；分档逻辑原样复用 |
| `recovery.mjs` | 由 `agentline recover --repo` 和 `build-ctl` 调用；插件不再在 GET 请求里调用它（见第 9 节） |
| `summary.mjs` / `notice.json` | 继续作为 Build 结束通知的来源；插件现有的 origin 投递机制保留 |
| `plugin/lib/collect.mjs` 额度采集 | 仍在插件里，只用于展示；核心的预算判断不依赖它 |
| `check-task.ps1` | 作为 T gate 的一条 check 调用（`T.check_task`） |

---

## 3. 数据模型与文件布局

### 3.1 三级留存（Q6）

| 级别 | 位置 | 进 git | 内容 |
|---|---|---|---|
| A 定稿 | `<repo>/.collab/{pipeline.json,studio,blueprint,build,milestones}/…` | 是 | 契约、最终状态、verdict 结构化 JSON、gate、approvals、`records_index_sha256` |
| B 过程 | `%LOCALAPPDATA%\AgentLine\repos\<repo-key>\…`（⚑U9） | 否 | rounds、各版设计全文、评审全文、原始 CLI 日志、prompt、handoff、events.jsonl、哈希索引 |
| C 机器 | `orchestrator/data/…`（已经 gitignore） | 否 | probe 缓存、配置历史、幂等记录、插件 origin |

`repo-key = basename(realpath) + "-" + sha1(lower(realpath))[0..10]`

Build 任务目录（`.collab/tasks/<NNN>/logs|handoff`）因为 flow 零侵入而**不搬家**。办法是由 `agentline migrate git-retention` 写一份 `<repo>/.collab/.gitignore`：

```gitignore
# agentline: process records (Q6)
tasks/*/logs/
tasks/*/handoff/
tasks/*/live.json
tasks/*/control.json
tasks/*/mailbox*.md
```

之后由 `build-ctl` 在每次 flow 退出后，把这些文件的哈希写入 B 级索引。

### 3.2 仓库内布局（A 级）

```text
<repo>/.collab/
  pipeline.json                       # 流水线索引
  .gitignore                          # 见 3.1
  studio/<sid>/                       # sid = YYYYMMDD-<slug>，例 20261106-agentline-plugin
    session.json                      # 状态（schema agentline.studio/v1）
    roles.lock.json                   # 角色锁 + probe 引用
    input.md
    questions.json
    facts.md
    minutes-final.md
    moderator-brief.md
    decisions.json  decisions.md      # 机器版 + 人读版（由 decisions.json 渲染）
    confirmations.json                # 专家确认
    gate.json                         # G0
    approvals.json                    # 只追加
  blueprint/<bid>/
    state.json                        # schema agentline.blueprint/v1
    roles.lock.json
    design.md                         # 定稿（= 最后一版）
    interfaces.md  risks.md
    task-graph.json
    test-strategy.md  acceptance-matrix.md  testability.json
    review-r1.verdict.json … review-rN.verdict.json   # 结构化 verdict 每轮进 git（⚑U6）
    decisions.json                    # 轮次耗尽后的用户裁决
    gate.json  approvals.json         # G1
    materialized.json                 # task-graph 节点 → NNN 映射
  build/<NNN>.json                    # Supervisor 记录（基础设施尝试/业务轮次/升级）
  milestones/<M>/gate.json  e2e-results.json  approvals.json
  tasks/<NNN>/…                       # 现状不变
  tasks/<NNN>/origin.json             # 新增（可选）：来源
```

### 3.3 关键 schema

#### pipeline.json

```json
{
  "schema": "agentline.pipeline/v1",
  "studio":    { "active": "20261106-agentline-plugin", "history": [] },
  "blueprint": { "active": "20261106-agentline-plugin", "history": [] },
  "build":     { "adhoc_policy": "allow_labeled" },
  "revision": 3,
  "updated_at": "2026-11-06T10:00:00+08:00"
}
```

`adhoc_policy` 的取值见 ⚑U7。

#### 阶段会话状态（Studio 和 Blueprint 共用的骨架）

```json
{
  "schema": "agentline.blueprint/v1",
  "id": "20261106-agentline-plugin",
  "title": "AgentLine 插件与三阶段控制面",
  "from": { "kind": "studio", "id": "20261106-agentline-plugin", "gate_hash": "sha256:…" },
  "repo_head_at_start": "e701b86",
  "status": "running",
  "phase": "review",
  "round": { "current": 2, "max": 3 },
  "revision": 14,
  "roles_lock_sha256": "sha256:…",
  "running": { "step_id": "r2.review", "role": "reviewer", "model_key": "gpt-6.1-sol", "pid": 1234, "started_at": "…" },
  "waiting": null,
  "awaiting": null,
  "blocked": null,
  "budget": {
    "limit": { "max_model_calls": 30, "max_tokens": 4000000, "max_cost_usd_est": 60 },
    "used":  { "model_calls": 9, "tokens_in": 812000, "tokens_out": 61000, "cost_usd_est": 11.4 }
  },
  "counters": { "business_rounds": 2, "infra_retries": 3, "rotations": { "reviewer": 1 }, "model_calls": 9 },
  "records_index_sha256": "sha256:…",
  "history": [ { "at": "…", "from": "ready", "to": "running", "by": "cli:ui", "reason": null } ],
  "supersedes": null,
  "superseded_by": null,
  "updated_at": "…"
}
```

- `waiting = { "code": "E_RATE_LIMIT", "resume_at": "…", "attempt": 1, "auto": true }`
- `awaiting = { "kind": "round_limit", "refs": ["review-r3.verdict.json"], "default": "new_session_with_ruling", "since": "…" }`
- `blocked = { "code": "E_AUTH", "category": "infra_user", "since": "…", "detail": "codex: not logged in", "error_ref": "events#412", "recover": [ { "action": "relogin", "hint": "codex login" }, { "action": "resume", "command": "blueprint.resume" } ] }`

#### 统一状态枚举（Studio / Blueprint）

| status | 含义 | 谁写 |
|---|---|---|
| `draft` | 已创建，角色未锁定 | core |
| `ready` | 角色已锁定，preflight 和 probe 全部通过 | core |
| `running` | 有一步正在执行 | core |
| `waiting` | 基础设施可逆错误，正在自动等待，到 `resume_at` 自动继续 | core |
| `awaiting_user` | 系统健康，下一步需要人对**内容**做决定 | core |
| `blocked` | 故障、完整性或配置问题，无法继续 | core |
| `concluded` | 模型工作完成，gate 还没通过 | core |
| `passed` | gate 通过（批准有效） | core |
| `materialized` | 仅 Blueprint：已生成 Build 任务 | core |
| `cancelled` / `superseded` | 已取消 / 已被新会话取代 | core |

**`awaiting_user` 与 `blocked` 的判定（硬规则）**

- **`awaiting_user`**：没有未恢复的故障，并且下一步的输入只有人能给。适用于：回答问题、确认决策、批准 gate、轮次耗尽后的裁决、预算追加、继续下一轮、确认模型变更、中断后选择保留或丢弃现场。
- **`blocked`**：存在需要修复的故障，修复之前任何决定都推进不了。适用于：认证失败、CLI 缺失或漂移、身份未验证或不符、只读被破坏、基础设施恢复预算耗尽、同一错误重复出现、中断但进程树没停干净。
- 两者都有时，取 `blocked`。

`awaiting.kind` 的取值：`question | decision_confirm | expert_reject | continue_round | round_limit | gate_approval | budget | model_change_confirm | interrupted_choice | attention`

#### questions.json（Studio）

```json
{ "schema": "agentline.questions/v1", "items": [ {
  "id": "Q-03", "title": "轮次上限", "blocking": true,
  "options": [ { "id": "A", "label": "hard_limit" }, { "id": "B", "label": "bounded_extension" } ],
  "default": "A", "rounds_used": 1, "rounds_max": 2,
  "status": "open",
  "answer": null,
  "raised_by": "moderator", "evidence": ["minutes-final.md#5"]
} ] }
```

- `status` 取值：`open | answered | default_adopted | unresolved`
- `answer` 示例：`{ "choice": "A", "text": "…", "channel": "ui", "at": "…" }`

#### roles.lock.json

```json
{
  "schema": "agentline.roleslock/v1", "stage": "blueprint", "locked_at": "…",
  "roles": {
    "designer":       { "candidates": [ { "key": "claude-opus-5-5", "identity_group": "anthropic/claude-opus-5-5", "vendor": "anthropic", "tier": "top", "probe_ref": "probes/claude/claude-opus-5-5/20261106T0912.json", "identity": "verified" } ] },
    "reviewer":       { "candidates": [ … ] },
    "test_architect": { "candidates": [ … ] }
  },
  "constraints": { "evaluated": [ { "id": "BP.pairwise_distinct", "status": "pass" } ] },
  "config_revision": 13
}
```

#### task-graph.json（在 docs/03 基础上扩展）

```json
{
  "schema": "agentline.taskgraph/v1",
  "milestones": [ { "id": "M1", "title": "…", "e2e": ["pwsh -NoProfile -File tests/e2e/m1.ps1"], "user_gate": true } ],
  "acceptance": [ { "id": "AC-001", "text": "…", "levels": ["integration"], "manual": false } ],
  "tasks": [ {
    "id": "T-002", "milestone": "M1", "title": "…",
    "inputs": ["…"], "outputs": ["…"],
    "depends_on": [], "write_scope": ["orchestrator/lib/control/**"],
    "acceptance": ["AC-001"], "acceptance_direction": ["…可执行方向…"],
    "test_levels": ["unit", "contract"], "risk": "low", "user_gate": false
  } ]
}
```

`T-xxx` 是 Blueprint 节点 ID。materialize 之后会映射成 `NNN`，映射关系写在 `materialized.json`。

#### tasks/NNN/origin.json

```json
{ "schema": "agentline.origin/v1", "kind": "blueprint",
  "blueprint": "20261106-agentline-plugin", "node": "T-002",
  "node_sha256": "sha256:…", "g1_approval_id": "apv-…", "created_at": "…" }
```

- 临时任务的写法：`{ "kind": "adhoc", "reason": "…" }`
- 旧任务没有这个文件，等价于 `kind: "legacy"`

#### build/NNN.json（Supervisor 记录）

```json
{
  "schema": "agentline.buildsup/v1", "task": "004",
  "business": { "rounds_used": 2, "rounds_max": 3, "last_verdict": "revise" },
  "infra": { "attempts": [ { "at": "…", "code": "E_RATE_LIMIT", "action": "wait", "wait_s": 45, "model": "gpt-6.1-sol", "error_ref": "…" } ] },
  "repeat": { "E_RATE_LIMIT": 1 },
  "view_status": "waiting",
  "escalations": [ { "at": "…", "kind": "round_limit", "resolution": null } ],
  "revision": 6
}
```

#### 结构化错误记录

```json
{
  "code": "E_RATE_LIMIT", "category": "infra",
  "provider": "codex", "model_key": "gpt-6.1-sol",
  "provider_code": "rate_limit_exceeded", "http_status": 429, "exit_code": 1,
  "retry_after_s": 40, "reset_at": null,
  "scope": "call",
  "side_effects": "none",
  "classification_source": "structured",
  "evidence_ref": "records:blueprint/…/logs/r2-review-1.log#L120-140",
  "recovery_action": "wait_same_model",
  "attempt": 1, "at": "…"
}
```

- `scope` 取值：`call | model | provider | account | session`
- `side_effects` 取值：`none | readonly | workspace_dirty | unknown`
- `classification_source` 取值：`structured`（JSON 事件或 HTTP 码）`| exit_code | text_pattern | unknown`

#### gate.json

```json
{
  "schema": "agentline.gate/v1",
  "gate_id": "G1:20261106-agentline-plugin",
  "kind": "G1", "subject": { "kind": "blueprint", "id": "20261106-agentline-plugin" },
  "rules_version": "g1/1", "evaluator": { "core": "0.5.0" },
  "evaluated_at": "…", "revision": 7,
  "content": { "hash": "sha256:9f2c…", "files": [ { "path": "task-graph.json", "sha256": "…" } ] },
  "checks": [
    { "id": "G1.graph_acyclic", "status": "pass", "waivable": false, "detail": "", "evidence": ["task-graph.json"] },
    { "id": "G1.test_arch_vendor_diverse", "status": "waived", "waivable": true, "detail": "test_architect 与 designer 同为 anthropic", "evidence": ["roles.lock.json"] }
  ],
  "waivers": [ { "waiver_id": "wvr-…", "check": "G1.test_arch_vendor_diverse", "content_hash": "sha256:9f2c…", "text": "用户原话", "channel": "ui", "at": "…" } ],
  "approval_required": true,
  "approval": { "approval_id": "apv-…", "content_hash": "sha256:9f2c…", "text": "批准 G1", "channel": "slash", "at": "…" },
  "status": "passed",
  "pass": true
}
```

**check 的状态：** `pass | fail | waived | not_evaluated | error`

**gate 的 `status`：**

| 值 | 条件 |
|---|---|
| `not_evaluated` | `gate.json` 不存在 |
| `failing` | 有 check 不是 `pass` 且不是有效的 `waived` |
| `ready_for_approval` | 所有 check 通过，还没有有效批准 |
| `passed` | 所有 check 通过，且批准有效 |
| `stale` | 读取时重新算的内容哈希 ≠ `content.hash`。只由 Read API 派生，不写盘 |
| `not_implemented` | 仅 G3 |

**判定公式：** `pass ⇔ ∀check ∈ {pass, waived(有效且 waivable)} ∧ (¬approval_required ∨ approval.content_hash == 当前内容哈希)`

**内容哈希的算法：**

1. 取该 gate 的内容集合（见 7.3）。
2. 每个文件先做 UTF-8 解码，把 CRLF 统一为 LF，去掉 BOM，再算 sha256。
3. 按 `path` 排序，组成 `[{path, sha256}]`，用 JSON Canonicalization（RFC 8785）序列化后再算 sha256。

#### approvals.json（只追加）

```json
{ "schema": "agentline.approvals/v1", "items": [
  { "approval_id": "apv-20261106-01", "gate_id": "G1:…", "content_hash": "sha256:9f2c…",
    "gate_revision": 7, "text": "用户原话", "channel": "ui|slash|cli", "at": "…",
    "revoked_at": null, "revoked_text": null } ] }
```

#### 事件（B 级，`events.jsonl`）

```json
{ "seq": 412, "ts": "…", "kind": "call.end", "subject": { "kind": "blueprint", "id": "…" },
  "step": "r2.review", "data": { "model_requested": "gpt-6.1-sol", "model_resolved": null, "identity": "unverified", "duration_ms": 381000, "usage": { "in": 120000, "out": 9000 }, "error": null },
  "refs": ["records:…/logs/r2-review-1.log"] }
```

事件种类 `kind`：

`stage.transition | step.start | step.end | call.start | call.end | error | retry | rotate | wait.start | wait.end | probe | gate.eval | approval | approval.revoke | waiver | config.change | budget | user.answer | user.decision | readonly.check`

#### 哈希索引（B 级，`records.index.json`）

```json
{ "schema": "agentline.records/v1", "entries": [
  { "path": "rounds/r1/design-v1.md", "kind": "design_version", "sha256": "…", "size": 18234, "at": "…", "round": 1 } ] }
```

这个索引文件自身的 sha256 写入 A 级的 `records_index_sha256`。`agentline audit verify` 重新计算并比对。

### 3.4 本机配置文件

```text
orchestrator/config/
  agentline.config.json         # 现状不变（configVersion 1）
  agentline.local.json          # 现状不变（Build roles）
  agentline.stages.local.json   # 新增：studio/blueprint 角色、预算、基础设施策略（gitignore 覆盖 *.local.json）
  tiers.json                    # 新增，进 git：版本化 top/advanced allowlist
  model-advice.json             # 新增：行业建议（来源/置信度/过期），维护方式 ⚑U5
orchestrator/data/
  probes/<provider>/<model-key>/<ts>.json ; probes/index.json
  config-history/rev-<n>.json
  idempotency.jsonl
  plugin/origins/…              # 原 data/flow-origins 迁入（兼容读旧位置）
```

---

## 4. CLI 命令与 Host API 契约

### 4.1 CLI 通用约定（新命令全部遵守，旧命令不变）

- `--json`：stdout 只输出一个 JSON 信封，人读文本走 stderr。
- 所有写命令必须带 `--expected-revision <n>`（`new` 和 `discover` 除外）。可选 `--idempotency-key <k>`（插件总是传）和 `--channel ui|slash|cli`（缺省为 `cli`）。

**信封格式：**

```json
{ "api": "agentline.cli/2", "ok": false, "command": "blueprint.approve",
  "data": null, "revision": 7,
  "error": { "code": "E_HASH_MISMATCH", "message": "批准的内容哈希 9f2c… 与当前 a71e… 不一致", "hint": "内容已变更，请重新查看后批准", "retryable": false, "details": { "current": "sha256:a71e…" } } }
```

**退出码：**

| 码 | 含义 |
|---|---|
| 0 | 成功，或幂等重放返回旧结果 |
| 2 | 参数校验失败 `E_VALIDATION` |
| 3 | 状态冲突：`E_STAGE_NOT_ALLOWED` / `E_REVISION_CONFLICT` / `E_LOCKED` |
| 4 | gate 不满足：`E_GATE_NOT_PASSED` / `E_GATE_NOT_READY` / `E_APPROVAL_STALE` / `E_HASH_MISMATCH` / `E_WAIVER_FORBIDDEN` |
| 5 | `E_NOT_FOUND` |
| 6 | 进入 `blocked`（基础设施、配置或完整性问题） |
| 7 | 进入 `awaiting_user` |
| 8 | `E_UNSUPPORTED`：核心版本不支持该功能 |
| 10 | 内部错误 |

### 4.2 命令表

R = 只读，W = 写，H = 只接受人类通道（`--channel ui|slash|cli`；不注册为 LLM 工具）。

| 命令 | 类型 | 说明 |
|---|---|---|
| `agentline version --json` | R | 返回 `{core, api:{cli:2, read:1}, features:[…]}` |
| `pipeline summary --repo R` | R | PipelineSummary DTO（4.4） |
| `inbox --repo R` | R | Inbox 列表 |
| `events --repo R [--subject k:id] [--since seq]` | R | 事件 |
| `audit verify --repo R --subject k:id` | R | 校验哈希索引 |
| `studio new --repo R --title T --input <file> [--slug s]` | W | → `draft` |
| `studio import --repo R --from <dir> [--slug s]` | W | 把手工 Studio 产物导入成会话，状态为 `concluded`（标注 `imported:true`） |
| `studio assign --id S --role <expert_a\|expert_b\|expert_c\|moderator\|scribe> --models k1[,k2]` | W | 只改 draft 草稿 |
| `studio preflight --id S` | W | 写 `preflight.json`：tier、隔离、readonly、CLI 健康 |
| `studio probe --id S [--force]` | W | 对全部候选做短上下文 probe |
| `studio lock --id S` | W | preflight 和 probe 都通过 → 写 `roles.lock.json` → `ready` |
| `studio run --id S` | W | 执行下一个**步骤组**（见 5.3），后台运行，返回 job |
| `studio answer --id S --question Q --choice X\|--text "…"\|--accept-default` | W·H | |
| `studio confirm --id S --decision D --text "…"` | W·H | 用户确认单个决策 |
| `studio conclude --id S` | W | 检查完整性 → `concluded`，然后自动 `gate eval` |
| `studio cancel --id S --text "…"` | W·H | |
| `blueprint new --repo R --from-studio S [--title]` | W | 要求 G0 通过 |
| `blueprint import / assign / preflight / probe / lock` | W | 同 Studio；角色为 `designer\|reviewer\|test_architect` |
| `blueprint run --id B` | W | 执行一轮 |
| `blueprint continue --id B` | W·H | 回应 `awaiting(continue_round)` |
| `blueprint decide --id B --ruling <accept_as_is\|new_session\|narrow_scope\|abandon> --text "…"` | W·H | 轮次耗尽后的裁决（选项集合受 ⚑U3 影响） |
| `blueprint materialize --id B [--dry-run]` | W | 要求 G1 通过；生成 `tasks/NNN/brief.md` 和 `origin.json` |
| `build start --repo R --task NNN [--max-rounds 3]` | W | 检查来源 gate → 由 Supervisor 拉起 flow |
| `build queue --repo R --blueprint B [--milestone M]` | W | 按依赖和 write_scope 排队 |
| `build resume --task NNN --keep\|--discard` | W·H | `--discard` 必须显式给出 |
| `build stop --task NNN [--now]` | W | 转调现有 `stop` |
| `build merge --task NNN --permission "…"\|--grant` | W·H | 先求 T gate，再调现有 `merge` |
| `gate eval --repo R --gate <id>` | W | 写 `gate.json` |
| `gate show --gate <id>` | R | 带派生的 `stale` |
| `approve --gate <id> --hash <sha256 前缀 ≥12 位> --text "…"` | W·H | |
| `approve --revoke <approval_id> --text "…"` | W·H | |
| `waive --gate <id> --check <cid> --hash <前缀> --text "…"` | W·H | 不可豁免的 check 一律 `E_WAIVER_FORBIDDEN` |
| `models discover [--provider p]` | W | 只写 C 级缓存 |
| `models list \| show <key>` | R | |
| `models add <provider> <id> [--key k] [--vendor v]` | W·H | 手工登记 |
| `models probe <key>\|--role <stage.role>\|--all` | W | |
| `models tier <key> <top\|advanced\|standard> --reason "…"` | W·H | 手工档位兜底 |
| `models retire <key> --reason "…"` | W·H | |
| `models suggest [--stage s]` | R | 只给建议，不改配置 |
| `roles show [--stage s]` | R | |
| `roles set --stage <studio\|blueprint\|build> --role r --models k1,k2 --expected-revision n` | W·H | 对 build 阶段等价于旧的 `roles set` |
| `providers status [--refresh]` | R/W | `--refresh` 会写 capability 缓存 |
| `config history \| show --rev n` | R | |
| `config rollback --to n --text "…"` | W·H | |
| `recover --repo R` | W | 原来 `/projects` GET 里的 sweep 动作搬到这里 |
| `task new --repo R --goal "…" [--adhoc-reason "…"]` | W | 替代插件当前直接写 `brief.md` 的做法 |
| `migrate plan\|apply --what <config\|git-retention\|origins>` | W·H | 见第 9 节 |

### 4.3 Host API（v2）

所有 v2 路由统一返回 `{ api: "agentline.host/2", ok, data, error, revision, generated_at }`。

GET 路由**全部只读**，内部调用 `lib/read`。

| 路由 | 方法 | 数据 |
|---|---|---|
| `/agentline/v2/capabilities` | GET | `version --json` 的缓存结果，外加插件版本 |
| `/agentline/v2/summary?repo=` | GET | PipelineSummary |
| `/agentline/v2/inbox?repo=` | GET | InboxItem[] |
| `/agentline/v2/studio?repo=&id=` | GET | 会话列表或详情（state、questions、confirmations、gate、产物清单） |
| `/agentline/v2/blueprint?repo=&id=` | GET | 同上，另加 rounds 摘要、task-graph、verdicts |
| `/agentline/v2/build?repo=&task=` | GET | 现有 task 详情 + origin + supervisor + T gate |
| `/agentline/v2/gate?repo=&gate=` | GET | gate（派生 stale） |
| `/agentline/v2/artifact?repo=&ref=` | GET | 产物内容（allowlist 与脱敏规则见 5.7） |
| `/agentline/v2/events?repo=&subject=&since=` | GET | 事件，分页 |
| `/agentline/v2/models` | GET | 目录 + probe 摘要 + 建议数 |
| `/agentline/v2/roles?stage=` | GET | 角色矩阵 + 约束求值 |
| `/agentline/v2/providers` | GET | 健康 |
| `/agentline/v2/config/history` | GET | 配置历史 |
| `/agentline/v2/command` | **POST** | 唯一写入口 |

**`POST /agentline/v2/command` 请求体：**

```json
{ "command": "gate.approve",
  "args": { "repo": "C:/…", "gate": "G1:…", "hash": "9f2c1a7b3d4e", "text": "批准，按此设计开工" },
  "expected_revision": 7,
  "idempotency_key": "ui-5b1e…",
  "channel": "ui" }
```

**命令白名单（节选；完整表与 4.2 一一对应，每条只映射一个 argv 模板）：**

| command | argv 模板 | 方式 | 超时 |
|---|---|---|---|
| `studio.run` | `studio run --repo {repo} --id {id} --expected-revision {rev}` | detached，返回 job | — |
| `studio.answer` | `studio answer --repo {repo} --id {id} --question {q} (--choice {c}\|--text {t}\|--accept-default)` | 同步 | 30s |
| `blueprint.continue` | `blueprint continue …` | detached | — |
| `gate.approve` | `approve --repo {repo} --gate {gate} --hash {hash} --text {text} --channel {channel}` | 同步 | 30s |
| `gate.waive` | `waive …` | 同步 | 30s |
| `build.start` | `build start --repo {repo} --task {task} --max-rounds 3` | detached | — |
| `build.merge` | `build merge … (--permission {text}\|--grant)` | 同步 | 120s |
| `models.probe` | `models probe {key}` | 同步 | 120s |
| `roles.set` | `roles set --stage {s} --role {r} --models {list}` | 同步 | 30s |
| `config.rollback` | `config rollback --to {n} --text {t}` | 同步 | 30s |
| `recover.sweep` | `recover --repo {repo}` | 同步 | 30s |

**插件侧的校验**只做格式检查：必填字段、类型、长度 ≤ 4000、`repo` 必须在已知项目列表里。业务校验全部交给 CLI。

**`channel` 的来源**由 Host 根据入口决定：面板按钮发 `ui`，斜杠命令发 `slash`。请求体里的 `channel` 字段会被**忽略**并覆盖。

### 4.4 PipelineSummary DTO（`agentline.read/1`）

```json
{
  "schema": "agentline.pipeline-summary/1",
  "repo": { "path": "C:/…", "title": "dsh-Agentline", "key": "…" },
  "core": { "version": "0.5.0", "features": ["studio", "blueprint", "gates", "probe"] },
  "stages": {
    "studio":    { "id": "…", "status": "passed", "gate": { "id": "G0:…", "status": "passed" }, "updated_at": "…" },
    "blueprint": { "id": "…", "status": "running", "phase": "review", "round": { "current": 2, "max": 3 },
                   "gate": { "id": "G1:…", "status": "not_evaluated" } },
    "build":     { "tasks": { "total": 12, "queued": 3, "running": 2, "waiting": 1, "awaiting_user": 0, "blocked": 1, "pr_open": 1, "merged": 4 },
                   "milestones": [ { "id": "M1", "gate": { "status": "failing", "fail": ["M.all_merged"] } } ] }
  },
  "inbox": { "total": 3, "blocking": 1 },
  "running": [ { "kind": "blueprint", "id": "…", "step": "r2.review", "role": "reviewer",
                 "model_key": "gpt-6.1-sol", "model_resolved": null, "identity": "unverified",
                 "started_at": "…", "elapsed_s": 382, "infra_retries": 1 } ],
  "providers": [ { "id": "codex", "state": "degraded", "reason": "E_RATE_LIMIT x2 (15m)" } ],
  "budget": { "blueprint": { "used_pct": 19 } },
  "headline": { "text": "Blueprint 第 2/3 轮 · 评审中 · gpt-6.1-sol · 6 分钟", "severity": "info" }
}
```

`headline` 由核心生成，插件原样显示，不自己拼接状态文案。

### 4.5 InboxItem

```json
{
  "id": "inbox:sha1(kind+subject+revision)",
  "kind": "gate_approval",
  "severity": "blocking",
  "stage": "blueprint", "subject": { "kind": "blueprint", "id": "…" },
  "title": "批准 Blueprint G1",
  "body": "12 项检查全部通过（1 项已豁免）。批准后可生成 9 个 Build 任务。",
  "options": [
    { "id": "approve", "label": "查看并批准", "command": "gate.approve", "needs_text": true, "default": true },
    { "id": "open",    "label": "先看任务图", "action": "open_artifact", "ref": "blueprint/…/task-graph.json" }
  ],
  "evidence": [ { "label": "task-graph.json", "ref": "…" }, { "label": "评审 r2 verdict", "ref": "…" } ],
  "slash": "/agentline approve G1 9f2c1a7b3d4e \"<你的原话>\"",
  "created_at": "…", "due_at": null
}
```

- `kind` 取值：`question | decision_confirm | expert_reject | continue_round | round_limit | gate_approval | budget | model_change | infra_blocked | auth_required | waiting_long | interrupted | attention | merge_permission | approval_stale | config_drift`
- `severity` 取值：`blocking | action | info`

**排序：** `blocking`（完整性 > 认证 > 其他 blocked）→ `action`（gate_approval > round_limit > question > 其余）→ `info`。同级按 `created_at` 升序。

---

## 5. 界面、UX 与斜杠命令

### 5.1 全局框架

```text
┌ AgentLine ─ [项目 ▾ dsh-Agentline] ─ Studio ●──Blueprint ◐ 2/3──Build ○ ─ ⚠ 待处理 3 ─ ▶ 2 运行 ─ 额度 Claude 5h 62% ▾ ─ ↻ ⚙ ┐
│ ⛔ codex 需要登录：运行 `codex login` 后点「继续」               [继续] [详情]               │ ← 全局横幅（仅 blocked/auth）
├ 首页 │ Studio │ Blueprint │ Build │ 设置 ────────────────────────────────────────────────┤
│                                     页面内容                                              │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                                           [产物抽屉：从右侧滑出]
```

**顶栏规则**

- **阶段进度条：** 徽章**只从 `gate.status` 和 `status` 取值**，不做任何推断。

| 显示 | 条件 |
|---|---|
| `○` 灰 | 未开始 |
| `◌` 灰虚线 | 未评估 |
| `◐` 蓝 | 进行中，附 `n/max` |
| `⏸` 黄 | 待你处理 |
| `⛔` 红 | 阻塞 |
| `●` 绿 | 已通过 |
| `●̸` 橙 | 已失效 |
| `—` | 未实现 |

  点击徽章跳转到对应页面。
- **待处理计数：** blocking 用红色，否则黄色，点击回到首页。
- **运行芯片：** 最多显示 3 个，其余折叠成 `+n`。悬停显示 `阶段/步骤 · 模型 requested→resolved · 身份 · 耗时 · 重试次数`。
- **额度胶囊：** 默认只显示最紧张的一项，点击展开四个池（沿用现有采集）。
- **全局横幅：** 只在两种情况出现：任一 `blocked` 的 category 属于 `infra_user / integrity / config`，或任一 provider 为 `unavailable` 且正被已锁定的角色使用。横幅最多 1 条，多条时显示“还有 n 项”。

### 5.2 首页 / Inbox

```text
现在卡在哪
  Blueprint「AgentLine 插件与三阶段控制面」第 2/3 轮 · 评审中 · gpt-6.1-sol（身份未验证）· 6 分钟

待我处理（3）
┌ ⛔ 需要登录 · codex ───────────────────────────────────────────────────┐
│ Blueprint 评审角色无法调用 gpt-6.1-sol：CLI 报告未登录。登录后继续，不计轮次。 │
│ [我已登录，继续]   复制命令：codex login        证据：错误日志 · probe 记录  │
└────────────────────────────────────────────────────────────────────────┘
┌ ⏸ 问题 Q-03 · Studio ─ 第 1/2 轮 · 阻塞项 ──────────────────────────────┐
│ 轮次耗尽后怎么处理？                                                      │
│ (•) A 原会话硬停，按裁决新建关联会话（默认）  ( ) B 允许追加一轮，最多 4 轮    │
│ [补充说明…]                                       [提交回答] [采用默认]    │
│ 证据：minutes-final §5 · 专家 B 意见                                        │
└────────────────────────────────────────────────────────────────────────┘
┌ ✅ 可批准 · G1 ─ 12/12 通过（1 豁免） ─────────────────────────────────┐
│ 批准绑定内容 sha256:9f2c1a7b3d4e…；之后任何文件改动都会让批准失效。          │
│ [查看并批准]  [先看任务图]                                                  │
└────────────────────────────────────────────────────────────────────────┘

运行中（2）             Build 004 dev r1 · gpt-6.1-sol · 12m  │ Blueprint r2 review · 6m
最近事件（5）[展开全部]  10:41 Blueprint r2 testability 完成：0 blocker …
```

**交互**

- **卡片主按钮**就是 `default: true` 的选项。需要原话的操作（approve、waive、decide、merge、answer 的自由文本）一律先弹出对话框，**必须输入原话**，按钮才可点击。
- **确认对话框：** 标题是动作名，正文包含：
  - 绑定的内容哈希前 12 位；
  - 将要执行的等价斜杠命令（只展示，便于审计）；
  - 当前 revision。

  提交后按钮转圈；成功则卡片消失并 toast“已记录”；失败时在卡片内显示 `error.message`、`error.hint`，以及 `[刷新]`。
- **`E_REVISION_CONFLICT`：** 卡片提示“状态在你操作时已变化”，自动重新拉取一次，**不自动重发命令**。

**空状态文案**

| 场景 | 文案 |
|---|---|
| 没有流水线记录 | “这个项目还没有 Studio / Blueprint 记录。用 `/agentline studio new <标题>` 开始立项，或 `/agentline <目标>` 直接派一个独立任务。” |
| 没有待办 | “没有需要你处理的事项。”，下方显示运行中列表 |
| 核心不支持 | “当前 orchestrator（0.4.0）不支持 Studio/Blueprint（需要 api.cli ≥ 2）。Build 驾驶舱仍可使用。” 并提供 `[查看升级说明]` |
| 项目不是 git 仓库 | “该工作区不是 git 仓库，AgentLine 无法建任务分支。先 `git init`。” |

### 5.3 Studio 页

**布局：** 左侧是会话列表（宽 220px，窄屏时改为下拉框）；右侧是详情。

```text
「AgentLine 插件三阶段改造」 20261106-agentline-plugin       [⏸ 待你处理] [G0 ◌ 未评估]
角色  专家A claude-opus-5-5 ✓  专家B gpt-6.1-sol ⚠未验证  专家C gemini-4-argon ✓
      主持 kimi-k3.1-pro ✓  书记 claude-sonnet-5-5 ✓(advanced)          [角色详情]
预算  调用 7/30 · token 0.9M/4M · 估算 $9.8/$40

轮次时间线
  R1  专家A ✓ 专家B ✓ 专家C ⚠截断 → 主持 ✓ → 问题 6 → 书记 ✓ → 确认 2/3     [展开]
  R2  （等待你回答 Q-03、Q-05）

问题  [全部 6 | 待回答 2 | 阻塞 1]
  ID    标题              阻塞  轮次  状态         操作
  Q-01  控制面边界         是   1/2   已回答 A      查看
  Q-03  轮次上限           是   1/2   待回答        [回答]
  Q-05  Git 留存           是   2/2   待回答 ⚠末轮   [回答]

FACT · 纪要 · 决策     [facts.md] [minutes-final.md] [moderator-brief.md] [decisions.md]
确认   专家A accept_with_notes · 专家B accept · 专家C 未确认          [展开备注]
异议   1 条未解决（专家C：rate_limit 自动等待上限）                   [展开]

操作   [运行下一步]  [结束并评估 G0]  [批准 G0]（不可用：G0 未评估）
```

**Studio 步骤组（每次 `studio run` 执行一组，然后停下）：**

| 组 | 内容 | 停在 |
|---|---|---|
| `experts` | 三位专家并行给出观点（彼此独立、读同一份 input） | → 进入 `moderator` |
| `moderator` | 主持汇总分歧，产出 questions、facts 草稿 | `awaiting_user(question)`；没有问题时进入 `scribe` |
| `scribe` | 书记写 `minutes-final` 和 `decisions` 草稿；不参与判断 | → 进入 `confirm` |
| `confirm` | 专家逐个确认：`accept / accept_with_notes / reject(+blocking)` | 有 reject 时 `awaiting_user(expert_reject)`，否则 `awaiting_user(decision_confirm)` |

- `experts → moderator → scribe` 在没有人工点时连续执行，**同一组之内**不停。每当遇到问题或确认点就停下。
- 用户回答之后，受影响的决策 `rounds_used += 1`。如果某个决策的 `rounds_used == 2` 而阻塞仍然存在，它会进入 `round_limit` 卡片：选项是“采用默认值 / 自己给出决定 / 标记为未解决（会让 G0 失败）”。
- **决策确认交互：** 逐条显示 `decisions.json` 的每一项。每条有三个操作：确认 / 采用默认 / 修改（修改会回到 `moderator`）。全部确认完毕后，“结束并评估 G0”才可用。
- **禁用按钮的说明**放在 tooltip 里，例如：“需要先回答 2 个阻塞问题”“G0 有 1 项未通过：G0.no_open_blocking”。

### 5.4 Blueprint 页

```text
「AgentLine 插件与三阶段控制面」     来自 Studio 20261106 (G0 ● sha256:41ab…)
状态 ◐ 第 2/3 轮 · review   [G1 ◌ 未评估]
轮次  v1 设计 ✓ → 测试 ✓(2 blocker) → 评审 ✗ revise(4 blocking)
      v2 设计 ✓ → 测试 ✓(0 blocker) → 评审 ◐ 6m
      v3 —
角色  设计 claude-opus-5-5 ✓ · 评审 gpt-6.1-sol ⚠未验证 · 测试架构 gemini-4-argon ✓
Tabs: 概览 | 设计 | 评审 | 测试架构 | 任务图 | 验收矩阵 | Gate
```

**各 Tab 的内容**

- **概览：** 本轮目标、上一轮未关闭的 findings 数量、testability blocker 数量、预算、最近事件。
- **设计：** 渲染当前版本。右上角 `[v1|v2|v3]` 切换版本；`[与上一版对比]` 展开 unified diff，默认收起。版本全文来自 B 级记录，标注“过程记录 · 不进 git · 哈希 ✓”。
- **评审：** findings 表，列为：ID、严重度（blocking/major/minor）、领域、内容、设计师回应、状态（open/resolved/disputed）、首次出现轮次。默认只显示 open 和 blocking。
- **测试架构：** 测试分层表（unit / contract / integration / e2e / manual）、框架与 CI 命令、fixture 要求、`testability.json` 的 blocker。
- **任务图：**
  - 表格视图（默认）：ID、标题、里程碑、依赖、write_scope、AC、test_levels、风险、user_gate。
  - 分层视图：按依赖拓扑分层，每层一列卡片，不做画布。
  - 顶部提示条：环（红，阻止 gate）、write_scope 冲突（黄，说明会排队）、孤立 AC（红）。
- **验收矩阵：** 行是 AC，列是测试层；单元格写任务 ID。双向覆盖缺失的格子标红。
- **Gate：** 见 5.8。

**轮末交互**

- 一轮结束后：
  - 评审为 `pass` 且 testability 没有 blocker → 自动 `conclude` 并 `gate eval`，然后进入 `awaiting_user(gate_approval)`；
  - 否则进入 `awaiting_user(continue_round)`。卡片文案：“第 1 轮评审未通过：4 个阻塞项、2 个测试 blocker。继续第 2 轮（剩 2 轮）？” 按钮：`[继续第 2 轮]（默认）[先看评审] [取消 Blueprint]`。
- **轮次耗尽**（第 3 轮评审仍不通过，或仍有 testability blocker）→ `awaiting_user(round_limit)`，卡片如下：

```text
⏸ Blueprint 3 轮未收敛 · 需要你裁决
未解决：2 个 blocking finding（F-07 接口不清、F-11 依赖错误）、0 个测试 blocker。
基础设施问题造成的重试 5 次，不计入轮次。
裁决选项（⚑U3 决定可用集合）：
 ( ) 以新会话继续：把你的裁决作为输入，新建 Blueprint（关联本会话）  ← 默认
 ( ) 缩小范围：删除涉及 F-07/F-11 的任务后重新评估 G1
 ( ) 放弃本 Blueprint
 [裁决原话 …]                                        [提交裁决]
```

- **materialize：** G1 通过后，Gate tab 出现 `[生成 Build 任务]`。点击后先 `--dry-run` 预览映射表（`T-002 → 004 …`、brief 摘要、依赖顺序），再确认执行。完成后，页面顶部出现“已生成 9 个任务 → 去 Build”。

### 5.5 Build 页

在现有驾驶舱的基础上增加：

- **任务列表新增列：**
  - 来源：`BP·T-002` 链接 / `独立` 标签 / `旧任务`；
  - 测试层级；
  - T gate 徽章；
  - 视图状态，取 Supervisor 的 `view_status`：`queued / running / waiting(倒计时) / awaiting_user / blocked / pr_open / merged / held(批准失效)`。
- **筛选：** 里程碑、来源、视图状态。
- **任务详情新增卡片：**
  1. **来源：** Blueprint 节点标题、AC 列表、`node_sha256`、G1 批准是否仍有效。
  2. **模型身份：** 每个阶段一行，格式为 `requested → resolved · identity_group · verified/unverified/mismatch`。
  3. **轮次与错误：** 显示两个计数器，**业务轮次 2/3** 和 **基础设施重试 4（不计轮次）**，下面是 infra attempts 的时间线（码 · 动作 · 等待 · 模型）。
  4. **T gate：** check 列表。
  5. **合并：** 保留现有面板，增加“合并前将重新求 T gate”的说明。
- **里程碑条：** `M1 ▓▓▓▓░ 4/5 merged · E2E 未运行 · [运行 E2E]（命令 build.e2e）· [批准 G2]`。
- **兼容：** 旧任务没有 origin 和 supervisor 记录时，这些卡片显示“旧任务：无来源记录”，**其余功能照旧**。

### 5.6 设置页（子页签：模型目录 / 角色矩阵 / Provider / 预算与轮次 / 变更历史 / 插件）

**模型目录**

```text
[扫描 CLI] [手动登记] [建议 (2)]   筛选: 厂商▾ 档位▾ 状态▾   搜索…
模型                厂商       通道      档位(来源)          身份       可调用  最近验证     状态
claude-opus-5-5     anthropic  claude    top (allowlist)     verified   ✓       今天 09:12   active
gpt-6.1-sol         openai     codex     top (allowlist)     unverified ✓       今天 09:13   active
claude-opus-4-5     anthropic  claude    advanced(allowlist) verified   ✓       3 天前 ⚠过期  active
gemini-4-argon-high google     gemini    未定级 (discovered) —          —       —            discovered
```

展开某一行可以看到：别名、canonical id、identity_group、能力（context、tools、effort、readonly_mode）、发现来源（cli_scan/manual，首次和末次出现时间）、tier 证据（来源、as_of、置信度、过期时间）、最近 5 次 probe（码、耗时、resolved）、被哪些角色使用。

行内操作：`[探测] [设档位…] [下线…] [删除手工登记]`。凡是会影响已锁定角色的操作，都会先弹出影响面。

**角色矩阵（每个阶段一张表）**

```text
Blueprint                                          配置 rev 13   [编辑]
角色        主选              备选               要求        约束          probe
设计师      claude-opus-5-5   —                  top         ✓             ✓ 09:12
评审        gpt-6.1-sol       —                  top·≠设计厂商 ✓            ⚠ 身份未验证
测试架构师  （未设置）         —                  top·≠两者    ✗ 缺 top 模型  —
⛔ 硬约束未满足：三角色须两两不同且均为 top；当前只有 2 个 top 模型（⚑U1）。
```

**编辑流程：**

1. 进入草稿模式，下拉框只列出档位合格的模型；不合格的灰显，并给出原因。
2. 硬约束实时校验，未满足时“应用”按钮禁用并显示原因。偏好类约束显示黄色警告。
3. 点“预览变更”看到 diff。
4. 点“应用（rev 13 → 14）”，发送命令 `roles.set`；成功后自动对新增候选执行 `models.probe`，结果回填。
5. 正在运行的会话**不受影响**（它们用的是 `roles.lock.json`），提示“新配置从下一个会话生效”。

**Provider：** 每个 provider 一张卡片，内容为：安装（路径）、版本、二进制指纹、认证、callable（最近 probe）、readonly 能力、24 小时失败分布（按错误码）、修复命令（只显示，可复制）。

状态取值：

| 状态 | 条件 |
|---|---|
| `ready` | 一切正常 |
| `degraded` | 15 分钟内有 2 次以上基础设施错误，或版本已漂移但 probe 通过 |
| `unavailable(reason)` | 未安装 / 未认证 / probe 失败 |

**预算与轮次**

- **可编辑：** 每阶段会话预算（模型调用次数、token、估算费用）；基础设施策略（自动等待上限，默认 30 分钟，⚑U8；“重置后自动继续”开关）。
- **只读（锁图标，“协议常量，修改需改协议”）：** Studio 每决策 2 轮；Blueprint 3 轮；Build 业务轮次 3 轮（⚑U10）。

**变更历史：** 修订列表（rev、时间、通道、摘要、diff），每行有 `[回滚到此]`，回滚需要输入原话。

**插件：** 现有 DSH 插件设置项保持不变；新增字段见第 9 节。

### 5.7 产物查看器（右侧抽屉，宽 min(720px, 90vw)）

**抽屉头部：** 路径、级别徽章（`git 定稿` 或 `过程记录·不进 git`）、sha256 前 12 位与索引比对结果（✓/✗）、大小、修改时间，以及 `[复制路径] [在编辑器打开] [原始]` 三个按钮。

**渲染规则**

- `.md`：渲染成 HTML（只允许安全子集），自动生成标题锚点目录。
- `.json`：可折叠的树，默认展开 2 层；数组超过 50 项时分页。
- `.log` / raw：**默认不显示**。点击“显示原始输出”后弹出确认：“原始输出可能包含代码上下文和提示词，仅在本机显示。” 确认后显示**脱敏后**的末尾 500 行，可以继续加载。
- 大小上限：渲染 2 MB，超过只给尾部和下载链接。

**allowlist：** `ref` 只能指向 `.collab/{studio,blueprint,build,milestones,tasks}/**` 或 B 级记录目录。路径里出现 `..` 或解析后的 realpath 越界，返回 `E_VALIDATION`。

**脱敏规则：**

- `sk-[A-Za-z0-9_-]{16,}`、`Bearer\s+\S+`、`"(access|refresh)_token"\s*:\s*"[^"]+"`、`AKIA[0-9A-Z]{16}`，以及插件 secret 设置的值本身，全部替换为 `‹redacted›`。
- **prompt 永远不在 UI 显示**，只显示它的 sha256 和长度。

### 5.8 Gate 视图（Studio、Blueprint、里程碑通用）

```text
G1 · Blueprint 20261106-agentline-plugin            [ready_for_approval]
内容哈希 sha256:9f2c1a7b3d4e…   rev 7   规则 g1/1   评估于 10:52   [重新评估]
✓ G1.graph_schema            ✓ G1.graph_acyclic         ✓ G1.ac_bidirectional
✓ G1.task_fields_complete    ✓ G1.review_pass           ✓ G1.rounds_le_3
✓ G1.testability_clear       ✓ G1.roles_pairwise        ✓ G1.designer_reviewer_vendor
⊘ G1.test_arch_vendor_diverse  已豁免：「同厂商可接受，测试架构师只做可测试性」 10:50 ui
✓ G1.identity_verified       ✓ G1.studio_link
内容文件（6）[展开]
批准原话 [______________________________]   [批准 G1（绑定 9f2c1a7b3d4e）]
```

- **默认显示方式：** gate 已通过时，check 列表折叠为“12/12 通过 · 1 豁免”；gate 失败时自动展开，只显示失败项。
- **失效时：** 顶部出现橙色条：“内容已变更（task-graph.json），G1 批准已失效。已生成但未开始的任务被暂停。” 并提供 `[查看变更] [重新评估]`。

### 5.9 未实现、阻塞、认证等状态的统一文案

| 状态 / 码 | 徽章 | 标题文案 | 主动作 |
|---|---|---|---|
| `not_implemented` | — 灰 | “未实现：发布 gate（G3）尚未设计” | 无 |
| `E_UNSUPPORTED` | — 灰 | “核心版本不支持此功能（需要 {feature}）” | 查看升级说明 |
| `not_evaluated` | ◌ | “未评估” | 评估 |
| `waiting` | ⏳ 黄 | “等待恢复：{provider} 限流，{mm:ss} 后自动继续（不计轮次）” | 立即重试 / 取消等待 |
| `E_AUTH` | ⛔ | “需要登录：{provider}（运行 `{fix}`）” | 我已登录，继续 |
| `E_FORBIDDEN` | ⛔ | “{provider} 拒绝访问（403），可能是账号权限或地区限制” | 查看证据 / 换候选（需确认） |
| `E_MODEL_UNVERIFIED` | ⛔ | “无法证明实际模型是 {requested}，该阶段要求已验证身份” | 查看 probe / 修改角色 |
| `E_MODEL_MISMATCH` | ⛔ 红粗 | “实际模型 {resolved} ≠ 请求 {requested}，已硬停” | 查看证据 |
| `E_READONLY_VIOLATION` | ⛔ 红粗 | “Studio/Blueprint 运行时产品仓库被修改，已硬停并保留现场” | 查看 diff |
| `E_INTERRUPTED` | ⏸ | “上次运行被中断。保留现场继续，还是丢弃未提交改动？” | 保留并继续（默认） / 丢弃并继续 |
| `E_ROUND_LIMIT` | ⏸ | “{n} 轮未收敛 · 需要你裁决” | 裁决 |
| `E_BUDGET_EXCEEDED` | ⏸ | “预算已用 {pct}%（{what}）” | 追加预算 / 停止 |
| `E_REPEATED` | ⛔ | “{code} 连续出现 3 次，已停止自动恢复” | 查看时间线 |

### 5.10 响应式、深色模式与可见性底线

- **宽度：**
  - ≥ 900px：双栏（列表 + 详情）。
  - 600–899px：单栏，列表改成顶部下拉框。
  - **底线 360px**：页签改成下拉框；表格改成卡片（每行一张，关键 3 个字段加展开）；顶栏只保留项目、阶段条、待处理计数和 ⚙。
- **触控：** 不做专门的移动端适配。按钮可点区域 ≥ 32px，保证 DSH 窄侧栏可用。
- **主题：** 现在的 CSS 写死了深色（`#e6edf3` 等）。改用 CSS 变量：优先读取 DSH 主题变量，读不到时回退到现有深色值；同时提供浅色变量集。文字对比度 ≥ 4.5:1。状态**不只靠颜色区分**，每个徽章都带图标或文字。
- **必须一屏可见（不滚动）：** 阶段条、待处理计数及第一张 blocking 卡、全局横幅、运行芯片、当前页的状态和 gate 徽章。
- **默认收起：** 原始日志、轮次全文、版本 diff、已通过 gate 的 check 列表、probe 历史、第 6 条之后的事件、豁免详情、内容文件列表。
- **轮询：** 面板可见且有运行任务时每 5 秒拉一次 summary；可见但空闲时 30 秒；不可见时停止。依据 `revision` 做条件刷新，只有 summary 的 revision 变了才拉取详情。

### 5.11 斜杠命令

**语法**（只注册**一个** `/agentline` 命令，子命令自己解析）：

```text
/agentline                         = /agentline status
/agentline help [主题]
/agentline status [--project P]
/agentline inbox
/agentline why <对象>               解释某个 blocked/awaiting 的原因与可选动作
/agentline studio new <标题> [--input <path>]
/agentline studio run|show|conclude [S]
/agentline blueprint new [--from S]
/agentline blueprint run|continue|show|materialize [B]
/agentline task new <目标>          （等价旧 /agentline <目标>）
/agentline task start|resume|stop|show <NNN> [--keep|--discard|--now]
/agentline models [list|discover|probe <key>|suggest]
/agentline roles [studio|blueprint|build]
/agentline answer <Q-id> <选项|default|"文本">
/agentline approve <G0|G1|G2:M1|gate-id> [hash前缀] "<原话>"
/agentline waive <gate> <check-id> <hash前缀> "<原话>"
/agentline decide [B] <new_session|narrow_scope|abandon|accept_as_is> "<原话>"
/agentline merge <NNN> "<原话>" | --grant
```

**参数规则**

- 词法：支持 `"…"`、`「…」`、`“…”` 三种引号；`--project` 可以出现在任意位置。
- 省略会话 ID 时：当前项目只有一个活跃会话就用它，否则返回 `E_AMBIGUOUS`，并列出候选。

**写入类与只读类**

| 只读（同时注册为 LLM 工具） | 写入（不需要原话） | 写入 + 人类通道 + 原话（**不**注册为工具） |
|---|---|---|
| status, inbox, why, show, models list/suggest, roles, help | studio/blueprint new·run·conclude·materialize, task new/start/stop, models discover/probe | answer, approve, waive, decide, merge, continue, task resume --discard, roles set, models tier/retire/add, config rollback |

**用两步提交把批准绑定到“看过的内容”：** `/agentline approve G1 "同意"` 如果没有带 hash，**不会执行**，而是回复：

```text
G1 · Blueprint 20261106-agentline-plugin：ready_for_approval
内容 sha256:9f2c1a7b3d4e（6 个文件），12/12 通过，1 项豁免（G1.test_arch_vendor_diverse）。
确认批准请发送：
/agentline approve G1 9f2c1a7b3d4e "同意"
```

**发现与补全**

- `/agentline help` 输出分组命令表。
- 命令注册时的 `input.hint` 写成 `status | inbox | studio … | blueprint … | task … | models | answer … | approve … | help`。
- 如果 DSH 命令 API 支持补全回调，就提供子命令、会话 ID、问题 ID 和 gate ID 的补全；如果不支持，退回 hint 加 help（R7）。

**自然语言别名：** 只接受**固定词表**，不做模糊理解：

| 别名 | 等价命令 |
|---|---|
| 状态、进度 | status |
| 待办、收件箱 | inbox |
| 为什么 | why |
| 批准 | approve |
| 回答 | answer |
| 模型 | models |
| 合并 | merge |

写入类命令**不接受**自由语句。

**旧语法兼容：** `/agentline <目标>` 的处理顺序：

1. 首个词是保留子命令或别名 → 按子命令执行。
2. 首个词是纯 ASCII 单词，且与某个子命令的编辑距离 ≤ 2 → 返回 `E_UNKNOWN_SUBCOMMAND`，并提示“你是否想输入 approve？”。**不建任务**，防止把拼错的命令当成目标。
3. 其他情况 → `task new --goal` 加 `build start`，结果标记为 `adhoc`。

**回复格式：** 沿用现有的 followup 注入，固定三行：

```text
✔ 已记录：Q-03 = A（第 1/2 轮）。
状态：Studio 待运行下一步。
下一步：/agentline studio run   （或在驾驶舱点「运行下一步」）
```

失败时：

```text
✖ E_STAGE_NOT_ALLOWED：Blueprint 正在运行 r2.review，不能 approve。
原因：G1 仅在 concluded 后可批准。
下一步：等待本轮结束（约 5 分钟），或 /agentline blueprint show
```

**按钮与命令的对应（节选，完整对应关系与 4.3 白名单相同）**

| UI 按钮 | command id | 斜杠 | CLI |
|---|---|---|---|
| 运行下一步（Studio） | `studio.run` | `/agentline studio run` | `studio run` |
| 提交回答 / 采用默认 | `studio.answer` | `/agentline answer Q-03 A` / `default` | `studio answer` |
| 继续第 n 轮 | `blueprint.continue` | `/agentline blueprint continue` | `blueprint continue` |
| 批准 G1 | `gate.approve` | `/agentline approve G1 <hash> "…"` | `approve` |
| 豁免 | `gate.waive` | `/agentline waive …` | `waive` |
| 生成 Build 任务 | `blueprint.materialize` | `/agentline blueprint materialize` | `blueprint materialize` |
| 开始任务 | `build.start` | `/agentline task start 004` | `build start` |
| 保留并继续 | `build.resume` | `/agentline task resume 004 --keep` | `build resume --keep` |
| 合并 | `build.merge` | `/agentline merge 004 "…"` | `build merge` |
| 我已登录，继续 | `<stage>.resume` | `/agentline task resume 004` | `… resume` |
| 探测 | `models.probe` | `/agentline models probe k` | `models probe` |
| 应用角色 | `roles.set` | —（只在 UI 提供） | `roles set` |

**命令层面的错误码**

| 码 | 含义 |
|---|---|
| `E_UNKNOWN_SUBCOMMAND` | 子命令不存在 |
| `E_AMBIGUOUS` | 有多个候选对象 |
| `E_VALIDATION` | 参数错误 |
| `E_NOT_FOUND` | 对象不存在 |
| `E_STAGE_NOT_ALLOWED` | 当前状态不允许此操作 |
| `E_REVISION_CONFLICT` | revision 不一致 |
| `E_LOCKED` | 有其他写操作正在进行 |
| `E_PERMISSION_CHANNEL` | 人类通道命令来自工具通道 |
| `E_TEXT_REQUIRED` | 缺少原话 |
| `E_HASH_REQUIRED` / `E_HASH_MISMATCH` | 缺少哈希 / 哈希不匹配 |
| `E_GATE_NOT_READY` | gate 还不能批准 |
| `E_GATE_NOT_PASSED` | gate 未通过 |
| `E_APPROVAL_STALE` | 批准已失效 |
| `E_WAIVER_FORBIDDEN` | 该 check 不可豁免 |
| `E_UNSUPPORTED` | 核心不支持 |
| `E_CLI_UNAVAILABLE` | 插件无法启动 CLI，例如 `agentlineHome` 配置错误 |

### 5.12 防止绕过 gate 直接跑 flow

1. **任务没有 G1 就不存在：** Blueprint 来源的 `brief.md` 只由 `blueprint materialize` 生成，而它要求 G1 通过。
2. **启动必须经过 Supervisor：** UI、斜杠命令和 `agentline_flow` 工具都改走 `build start`，它会检查 `origin.json`。若 G1 已失效或节点哈希变了，返回 `E_APPROVAL_STALE`。
3. **合并时兜底：** `build merge` 会求 T gate；另外在 `agentline.mjs merge` 里新增一项前置检查（这是 CLI 分发层，不属于 flow）：若存在 `origin.json` 且 T gate 不通过，就拒绝，除非带 `--override-gate "<原话>"`。override 会写入 `deviations`，**且只能逐个任务确认，不能用 grant**。
4. **限制：** 有人手动执行 `node agentline.mjs flow` 仍然能跑（flow 零侵入，没法拦），但合并会被拦，而且 UI 会把这类任务标为 `⚠ 未经 Supervisor 启动`（`build/NNN.json` 不存在，同时 `run.json` 有记录）。

---

## 6. 模型维护与配置

### 6.1 目录条目（catalog 视图，由 discovery + local + tiers + probe 合成）

| 字段 | 说明 |
|---|---|
| `key` | 本地键，例如 `claude-opus-5-5` |
| `provider` | 执行通道：`claude / codex / gemini / codebuddy` |
| `vendor` | 原始厂商：`anthropic / openai / google / moonshot / tencent …`，用于判断“不同厂商” |
| `model_id` | 传给 CLI 的 ID |
| `canonical_id` | 规范化 ID，去掉通道前缀、统一大小写 |
| `identity_group` | `vendor/canonical_id`，用于判断“同一模型” |
| `aliases[]` | 已知别名 |
| `pinned` | 是否是固定版本；`auto / latest / 滚动别名` 一律为 false |
| `tier` / `tier_source` | 档位 `top / advanced / standard / unrated`；来源 `allowlist / manual / suggested` |
| `tier_evidence[]` | `{source, url?, as_of, confidence: high\|medium\|low, expires_at}` |
| `capabilities` | `{context_tokens?, tools, effort[], readonly_mode}` |
| `discovery` | `{found_by: cli_scan\|manual, first_seen, last_seen}` |
| `availability` | `{state: callable\|unverified\|failing\|missing\|retired, last_probe_ref, last_probe_at, consecutive_failures}` |
| `lifecycle` | `active / deprecated / retired`，附 `replaced_by?` |

### 6.2 档位认定

- **`top` 和 `advanced` 只有两个来源：**
  - `tiers.json`（进 git、带版本号、改动走 PR），每条记录 `{identity_group, tier, as_of, evidence}`；
  - 本机手工 `models tier <key> top --reason "…"`（人类通道、记录原话）。手工档位在 UI 上显示“手工”，并作为一条 gate 证据。
- **CLI 扫描只能证明模型被发现**，档位一律为 `unrated`。**不能**按名字里带 opus、pro、ultra 等字样推断档位。
- **`suggested`**（来自建议）只在 UI 上显示，不参与 gate。

### 6.3 行业建议

- **来源：** `model-advice.json`。每条建议的格式：

```json
{ "identity_group": "google/gemini-4-argon", "suggest_tier": "top",
  "sources": [ { "kind": "vendor_model_card|public_benchmark|vendor_pricing|community_consensus", "name": "…", "url": "…", "as_of": "2026-10-20" } ],
  "confidence": "medium", "expires_at": "2026-12-05", "notes": "…" }
```

- **过期：** 过了 `expires_at` 就显示“建议已过期”，不再出现在建议列表。默认有效期 45 天。
- **置信度：** `high` 要求有厂商官方资料，加上至少一个独立来源；`medium` 要求两个以上非官方来源；`low` 是单一来源。
- **维护方式：** 是人工 PR、可选的模型辅助检索（产出草稿，仍需 PR），还是不提供，待定 ⚑U5。
- **建议的作用范围：** 只出现在“建议 (n)”面板。点“采纳”只会生成一个**待应用的配置草稿**（`tier` 手工档位或 `roles` 变更），然后走 6.6 的流程。

### 6.4 角色约束（求值后写入 `roles.lock.json` 和 gate）

| ID | 规则 | 硬/软 |
|---|---|---|
| `ST.experts_top` | Studio 专家 A/B/C 均为 top | 硬（可豁免，⚑U11） |
| `ST.moderator_top` | 主持为 top | 硬（可豁免） |
| `ST.scribe_advanced` | 书记 ≥ advanced | 硬（可豁免） |
| `ST.scribe_ne_moderator` | 书记与主持的 identity_group 不同 | 硬（不可豁免） |
| `ST.experts_distinct` | 三位专家 identity_group 两两不同 | 硬（可豁免） |
| `ST.vendor_diversity` | 专家来自 ≥ 2 个厂商 | 软（警告） |
| `BP.all_top` | 设计、评审、测试架构均为 top | 硬（不可豁免） |
| `BP.pairwise_distinct` | 三者 identity_group 两两不同 | 硬（不可豁免） |
| `BP.designer_reviewer_vendor` | 设计与评审 vendor 不同 | 硬（不可豁免） |
| `BP.test_arch_vendor_diverse` | 测试架构 vendor 与另外两者都不同 | 软（可豁免） |
| `ALL.pinned` | Studio/Blueprint 候选必须 `pinned` | 硬（不可豁免） |
| `ALL.readonly_capable` | Studio/Blueprint 候选的 provider 支持只读模式 | 硬（不可豁免） |
| `ALL.callable` | 所有候选（含备选）probe 通过 | 硬 |
| `ALL.identity` | 候选 identity 为 verified（或按 ⚑U2 登记例外） | 硬 |
| `BD.review_ne_dev` | Build 评审 ≠ 开发（现有规则） | 硬 |
| `ALL.backup_same_constraints` | 每个备选单独代入时也满足该角色的全部硬约束 | 硬 |

> **当前配置的推演结果：** 只有 `claude-opus-5-5`、`gpt-6.1-sol` 两个确认的 top。在这个前提下 `BP.pairwise_distinct` **无法满足**，Blueprint 编排会停在 preflight。这正是 ⚑U1 要裁决的问题。

### 6.5 短上下文 probe

**触发条件**

1. `roles set` 成功之后，对新增候选做 probe；
2. `lock` 时，对所有候选（含备选）做 probe：若缓存超过 12 小时，或 CLI 指纹变了，或模型最近失败过，就重新 probe；
3. 运行中出现 `E_MODEL_UNAVAILABLE` 或 `E_CLI_VERSION_DRIFT` 后，该候选在下次被使用前必须重新 probe；
4. 在 UI 或命令里手动触发。

**做法**

- 在空临时目录下执行（不碰仓库），只读工具集，effort 用 provider 支持的最低档。
- prompt 不超过 200 token，内容是：“只输出一行 JSON：`{"probe":"<nonce>","ok":true}`”。不让模型自报身份；即使它自报了，也只作参考，**不采信**。
- 超时 90 秒，最多重试 2 次（只针对基础设施类错误），退避 5 秒、15 秒。

**判定：**

- `nonce_ok`：输出能解析出 nonce。
- `identity`，按优先级判断：
  - `verified`：adapter 从结构化元数据拿到 `model_resolved`（claude 的 `modelUsage` 键、codebuddy 的 `j.model` 等），且它的 identity_group 等于请求的；
  - `mismatch`：能拿到，但不相等；
  - `unverified`：拿不到（目前 codex 返回 null，gemini 只是回显请求）。

**probe 记录：**

```json
{ "schema": "agentline.probe/v1", "probe_id": "…", "at": "…", "trigger": "lock",
  "model_key": "gpt-6.1-sol", "provider": "codex", "adapter": "codex-cli",
  "cli": { "path": "C:/…/codex.cmd", "version": "0.98.0", "fingerprint": "sha256:…" },
  "model_requested": "gpt-6.1-sol", "model_resolved": null, "resolved_source": "none",
  "identity": "unverified", "nonce_ok": true,
  "duration_ms": 8120, "usage": { "in": 180, "out": 14 }, "exit_code": 0,
  "error": null, "cache_until": "…+12h" }
```

**失败处理：**

- 基础设施类错误：重试用完后，候选标为 `failing`。
- `E_AUTH`：provider 标为 `unavailable(auth)`。
- 主选失败而备选通过：**不自动交换**。生成 `awaiting_user(model_change_confirm)`，文案“主选 X probe 失败（E_…），是否以备选 Y 为主选锁定本阶段？”，并且需要人类通道确认。
- 任一硬约束因此不满足 → `lock` 失败，会话保持 `draft`，preflight 面板列出原因。

### 6.6 配置变更的审批与回滚

- **修订记录：** 所有配置写入（`roles set / models tier / retire / add`、预算、基础设施策略）都会把整份 `agentline.stages.local.json` 和 `agentline.local.json` 的快照写入 `config-history/rev-<n>.json`，格式为 `{rev, at, channel, text, diff, before_sha, after_sha}`。
- **并发：** 写入必须带 `expected_revision`。
- **生效范围：** 正在运行的会话用的是自己的 `roles.lock.json`，**不受影响**。
- **回滚：** `config rollback --to n` 本身也会生成一个新 rev，不会抹掉历史。

**需要人类原话的变更：**

- 把任何模型设为 top 或 advanced（手工档位）；
- 让某角色的候选集合**新增**一个不同 vendor 的模型；
- 下线一个正被已锁定会话使用的模型；
- 回滚。

普通的顺序调整、预算增减只需要人类通道，不要求原话。

### 6.7 下线、新版本、别名与厂商变化

| 事件 | 发现方式 | 处理 |
|---|---|---|
| CLI 扫描不到已登记模型 | `models discover` 的差异比对 | `availability=missing`，Inbox 出现 `model_change(info)`。下一次 lock 时，用到它的角色 preflight 失败（`E_MODEL_MISSING`） |
| 出现新版本（同 vendor、同系列、更高版本号） | discover 差异 + 建议文件 | Inbox 出现“发现 claude-opus-5-6，是否加入候选？”，**不会自动替换** |
| 运行中返回模型不存在或已弃用 | 错误 `E_MODEL_UNAVAILABLE` | 标记 `failing`，在锁内轮换；没有可轮换的 → blocked |
| 解析结果与请求不一致 | `E_MODEL_MISMATCH` | 硬停，不轮换，保留证据 |
| 滚动别名或 `auto` | `pinned=false` | 不能用于 Studio/Blueprint；Build 只给警告 |
| 厂商变化（同名模型换了 vendor 或通道） | identity_group 改变 | 视为新模型，原来的 tier 不继承 |
| CLI 版本或指纹变化 | `providers status` 比对 | capability 缓存失效，相关候选需要重新 probe |

---

## 7. 错误、轮次与 gate

### 7.1 错误动作表

**列说明：**

- `cat`：infra = 可逆基础设施问题；infra_user = 可逆，但需要人操作；integrity = 完整性问题；business = 业务问题；config = 配置问题；user = 用户操作。
- `rot`：在锁定候选内轮换。
- `现场`：Build 是否保留工作区。
- `计轮`：是否计入业务轮次。

| code | cat | 识别（结构化优先） | 自动动作 | 上限 | rot | 现场 | 终态 | 计轮 |
|---|---|---|---|---|---|---|---|---|
| `E_NETWORK` | infra | ECONNRESET / TLS / DNS / fetch failed | 同模型重试，退避 5/15/45 秒；然后连通性检查，离线就进入 `waiting` 并每 60 秒探测 | 3 次重试，等待 ≤ maxWait | 重试后 1 次 | 保留 | 超限 → blocked(infra) | 否 |
| `E_RATE_LIMIT` | infra | HTTP 429，或 provider_code 为 rate_limit | `retry_after ≤ 60s` 时同模型等待；否则或二次出现时轮换；没有可轮换的且 `reset ≤ maxWait` 时 `waiting` | 等待 2 次、累计 ≤ 120 秒（单次调用内） | 1 | 保留 | 超限 → blocked(infra)，可选“到点自动继续” | 否 |
| `E_SESSION_LIMIT` | infra | 5h/会话窗口文案或码，带 reset_at | 直接轮换；不能轮换且 `reset ≤ maxWait` 时 `waiting` | — | 1 | 保留 | blocked(infra) + reset_at | 否 |
| `E_QUOTA` | infra_user | 计费额度、积分用尽 | 轮换，不等待 | — | 1 | 保留 | blocked(infra_user) | 否 |
| `E_CAPACITY` | infra | 529 / overloaded | 退避 10/30/60 秒 | 3 | 之后 1 | 保留 | blocked(infra) | 否 |
| `E_TIMEOUT` / `E_STALL` | infra | 墙钟超时，或看门狗判定无输出 | 只读角色（Studio/Blueprint/review）：重试 1 次，然后轮换。写角色（design/dev）：**不重放** | 1 | 1 | 保留，并做进程树终止检查 | 写角色 → blocked(`E_UNKNOWN_SIDE_EFFECTS`) | 否 |
| `E_CLI_CRASH` | infra | 非零退出且没有结束事件 | 只读角色重试 1 次；写角色不重放 | 1 | 1 | 保留 | blocked | 否 |
| `E_AUTH` | infra_user | 401 / not logged in / 刷新 token 失败 | **不轮换**（沿用现有协议） | 0 | 否 | 保留 | blocked(auth) | 否 |
| `E_FORBIDDEN` | infra_user | 裸 403（不带认证语义） | 不轮换 | 0 | 否 | 保留 | blocked | 否 |
| `E_CONTEXT_OVERFLOW` | business-input | context length 错误码 | 若锁内有更大 context 的候选就轮换 | — | 1 | 保留 | 否则 awaiting_user(budget/scope) | 否 |
| `E_MODEL_UNAVAILABLE` | infra | 404 model / deprecated | 标记 failing，然后轮换 | — | 1 | 保留 | blocked | 否 |
| `E_MODEL_UNVERIFIED` | integrity | resolved 为空，而阶段要求已验证身份 | 无 | 0 | 否 | 保留 | blocked | 否 |
| `E_MODEL_MISMATCH` | integrity | resolved 的 identity_group 与请求不同 | 硬停 | 0 | 否 | 保留 | blocked | 否 |
| `E_ISOLATION_VIOLATION` | integrity | 轮换会破坏隔离（例如评审换成和设计相同的模型） | 跳过该候选；没有别的候选就 blocked | 0 | — | 保留 | blocked | 否 |
| `E_READONLY_VIOLATION` | integrity | 阶段调用前后产品仓库有变化 | 硬停，不回滚 | 0 | 否 | 保留并快照 diff | blocked | 否 |
| `E_CLI_MISSING` / `E_CLI_VERSION_DRIFT` | config | 找不到命令 / 未知参数 / 输出格式无法解析 | 不删参数重试 | 0 | 否 | 保留 | blocked(config) | 否 |
| `E_INVALID_OUTPUT` | model-quality | 产物结构不合格（缺 JSON、schema 不符） | 同模型格式修复 1 次（附上 schema 错误） | 1 | 否 | 保留 | awaiting_user(查看产物 / 换候选 / 重跑) | 否 |
| `E_NO_NEW_WORK` / `E_NO_CHANGES` | build（现有） | 沿用 exec 判定 | 沿用 flow | — | flow 内 | — | flow 决定 | 否 |
| `E_INTERRUPTED` | infra | 进程消失（recovery） | 无 | 0 | — | **默认保留** | awaiting_user(interrupted_choice) | 否 |
| `E_UNKNOWN_SIDE_EFFECTS` | integrity | 写角色中断或超时，且现场是脏的 | 不重放 | 0 | — | 保留 | awaiting_user(interrupted_choice) | 否 |
| `E_CI_FAILED` | business | ci-results 未全部通过 | dev 修复（flow 内） | 计轮 | — | — | — | **是** |
| `E_REVIEW_REJECTED` | business | verdict ≠ pass | 下一轮 | 计轮 | — | — | — | **是** |
| `E_TESTABILITY_BLOCKER` | business | `testability.json` 有 open blocker | 回到设计 | 计轮 | — | — | — | **是** |
| `E_ROUND_LIMIT` | business | 业务轮次用完 | 无 | — | — | — | awaiting_user(round_limit) | — |
| `E_BUDGET_EXCEEDED` | user | 已用 ≥ 上限（在步骤边界检查） | 不打断正在进行的调用 | — | — | — | awaiting_user(budget) | 否 |
| `E_USER_CANCELLED` | user | stop / cancel | — | — | — | 保留 | cancelled / blocked(halted) | 否 |
| `E_REPEATED` | integrity | 同一 subject 下同一错误码连续 3 次（跨 resume 累计） | 停止自动恢复 | — | — | 保留 | blocked(`repeated:<code>`) | 否 |

**统一恢复预算**

| 维度 | 上限 |
|---|---|
| 每个逻辑步骤的物理模型调用 | ≤ 3 次 |
| 每个角色每个阶段的自动轮换 | ≤ 1 次（跨轮次、跨 resume 累计，计数器在 `counters.rotations`） |
| 单会话的基础设施自动等待 | 累计 ≤ maxWait（默认 30 分钟） |

每次物理调用都单独写一条 `call.end` 事件。超出任一预算时，按该错误码的“终态”列处理。

**幂等与副作用**

- **只读角色**（Studio/Blueprint/review）：快照目录是只读的，产物由 `stage-exec` 写入，重放安全。
- **写角色**（Build 的 design/dev）：只有当 flow 自己判定可重试时才重放（例如 network 重试，沿用现有逻辑）。Supervisor 只对 `blocked_reason ∈ {rate_limit, capacity, transport}` **且** `state.json` 显示阶段已经结束、工作区干净（或仅有 FLOW_NOISE）时，才执行 `flow --resume --keep`。其余情况一律 `awaiting_user`。
- **默认保留现场：** Supervisor 总是带 `--keep`。丢弃改动必须由用户在 `interrupted_choice` 中显式选择。这修正了旧行为：直接 `flow --resume` 在 interrupted 时会默认丢弃改动。

**分类来源的优先级：** 先看 adapter 的结构化结束事件或 HTTP 码，再看退出码，最后才是文本模式。文本模式使用**带边界**的正则：

- `\bauth(entication|orization)?\b` 不会命中 `author`；
- `context` 只有在 `context (length|window)` 这类组合里才算 context 错误。

匹配结果标为 `classification_source: text_pattern`。现有的 `classifyError` 保持不变（flow 还在用它）；新分类器放在 `control/errors.mjs`，只供控制面和 Supervisor 使用。

**错误码与旧 `blocked_reason` 的映射（Supervisor 用）：**

| 旧 `blocked_reason` | 新码 |
|---|---|
| rate_limit | 根据证据细分为 E_RATE_LIMIT / E_SESSION_LIMIT / E_QUOTA |
| capacity | E_CAPACITY |
| transport | E_NETWORK |
| auth | 有 403 证据 → E_FORBIDDEN，否则 E_AUTH |
| stall / timeout | E_STALL / E_TIMEOUT |
| context | E_CONTEXT_OVERFLOW（需结构化确认，否则 E_CLI_CRASH） |
| interrupted | E_INTERRUPTED |
| review_exhausted | E_ROUND_LIMIT |
| awaiting_human | awaiting_user(attention) |
| amendment_pending | awaiting_user(attention) |
| write_scope_missing | E_INVALID_OUTPUT |
| run_failed | 按证据重新分类，无法分类时 E_CLI_CRASH |

### 7.2 轮次规则

| 阶段 | 业务轮次单位 | 上限 | 耗尽后 |
|---|---|---|---|
| Studio | 每个决策 | 2 | 该决策进入 round_limit 卡片：采用默认 / 用户给出决定 / unresolved（G0 失败） |
| Blueprint | 设计版本（design → testability → review 算一轮） | 3 | `awaiting_user(round_limit)`，可选裁决见 ⚑U3 |
| Build | 评审轮次（review 不通过，或 CI 失败后的 dev 修复） | 3（⚑U10） | flow 报 review_exhausted，由 Supervisor 转成 `awaiting_user(E_ROUND_LIMIT)` |

- 基础设施错误**不改变** `round`。所有尝试、模型、错误码和动作都记录在 `counters.infra_retries` 和事件里，UI 用两个独立计数器显示。
- 不能用重试掩盖业务分歧。业务码（`E_REVIEW_REJECTED`、`E_CI_FAILED`、`E_TESTABILITY_BLOCKER`）**从不**触发轮换或重试；只有 `continue` 和 `decide` 能推进。
- 用户裁决写入 `decisions.json`：`{at, kind: "round_limit", options_shown, choice, text, channel}`。如果裁决是新建会话，新会话的 `supersedes` 指向原会话，原会话进入 `superseded`。

### 7.3 Gate 定义

**G0：Studio**

内容集合：`decisions.json, decisions.md, minutes-final.md, confirmations.json, questions.json, roles.lock.json`

| check | 判定 | 可豁免 |
|---|---|---|
| `G0.minutes_final` | 文件存在且非空 | 否 |
| `G0.decisions_nonempty` | decisions 条目 ≥ 1 | 否 |
| `G0.each_decision_confirmed` | 每条都有 `confirmed` 或 `default_adopted` 记录（附通道） | 否 |
| `G0.no_open_blocking` | questions 中 `blocking ∧ status ∈ {open, unresolved}` 为 0 | 否 |
| `G0.decision_rounds_le_2` | 所有 `rounds_used ≤ 2` | 否 |
| `G0.experts_confirmed` | 每位专家都有确认，且没有 `reject` | 否 |
| `G0.scribe_ne_moderator` | 同 ST.scribe_ne_moderator | 否 |
| `G0.role_tiers` | ST.experts_top、moderator_top、scribe_advanced、experts_distinct | 是（⚑U11） |
| `G0.identity_verified` | 所有调用的 identity 为 verified | 视 ⚑U2 |
| `G0.records_index` | `audit verify` 通过 | 是 |

需要批准：是。

**G1：Blueprint**

内容集合：`design.md, interfaces.md, risks.md, task-graph.json, test-strategy.md, acceptance-matrix.md, testability.json, review-r<last>.verdict.json, roles.lock.json`，再加上 G0 的 content.hash（以字符串形式纳入）。

| check | 判定 | 可豁免 |
|---|---|---|
| `G1.studio_link` | 来源 G0 为 passed，且其 hash 等于 `from.gate_hash`；手工或独立 Blueprint 需要 waiver | 是 |
| `G1.graph_schema` | 符合 `agentline.taskgraph/v1` | 否 |
| `G1.graph_acyclic` | 依赖无环，且所有引用的 ID 都存在 | 否 |
| `G1.ac_bidirectional` | 每个 AC 至少映射到 1 个任务；每个任务至少有 1 个 AC | 否 |
| `G1.task_fields_complete` | 每个任务都有 inputs、outputs、write_scope、depends_on、acceptance_direction、test_levels | 否 |
| `G1.matrix_consistent` | acceptance-matrix 与 task-graph 的 AC 和层级一致 | 否 |
| `G1.review_pass` | 最后一轮 verdict 为 pass，且没有 open blocking finding | 否 |
| `G1.rounds_le_3` | 轮次 ≤ 3 | 否 |
| `G1.testability_clear` | testability 没有 open blocker | 否 |
| `G1.roles_pairwise` / `G1.designer_reviewer_vendor` / `G1.all_top` | 同 6.4 | 否 |
| `G1.test_arch_vendor_diverse` | 同 6.4 | 是 |
| `G1.identity_verified` | 同 G0 | 视 ⚑U2 |
| `G1.readonly_ok` | 没有 readonly.check 失败事件 | 否 |
| `G1.write_scope_overlap` | 仅报告（`pass`，detail 里列出会排队的任务对） | — |

需要批准：是。

**T：Build 任务**

内容集合：`origin.json` 指向的节点 canonical JSON、`acceptance.md`、最后一轮 `verdict*.json`、`ci-results.json`、任务分支 HEAD sha。

| check | 判定 | 可豁免 |
|---|---|---|
| `T.status` | 状态为 `pr_open` 或 `merged` | 否 |
| `T.check_task` | `check-task.ps1` 退出码 0（Blueprint 来源任务使用 `-Strict`） | 否 |
| `T.ci_all_pass` | `passed == total` | 否 |
| `T.verdict_pass` | verdict 为 pass，且 `git_sha` 是 HEAD 的祖先 | 否 |
| `T.isolation` | dev 与 review 的 resolved identity_group 不同 | 否 |
| `T.ac_coverage` | 节点里每个 AC 都被 acceptance.md 引用（`AC-xxx` 标注） | 否 |
| `T.origin_valid` | G1 批准仍有效，且 `node_sha256` 与当前节点一致 | 否 |
| `T.identity_verified` | 视 ⚑U2 | 视 ⚑U2 |

需要批准：否（合并许可沿用现有 permission/grant）。`pr_open` 时求一次，合并前再求一次。

**G2：里程碑 M**

内容集合：milestone 节点、各任务 merged sha 列表、`e2e-results.json`

| check | 判定 | 可豁免 |
|---|---|---|
| `M.all_merged` | 该里程碑的所有任务都已 merged | 否 |
| `M.task_gates` | 每个任务的 T 都 pass | 否 |
| `M.e2e_pass` | e2e 结果全部通过（在 main 的临时 worktree 上运行，复用 ci-runner） | 否 |
| `M.manual_checks` | test-strategy 中标为 manual 的项目都有用户勾选记录 | 否 |

需要批准：是。

**G3：发布** — `not_implemented`，UI 显示“未实现”。

**豁免规则**

- waiver 绑定当时的 `content_hash`，内容一变就失效，需要重新豁免。
- 同一个 gate 有效豁免 ≥ 3 条时，UI 显示黄色警告“豁免过多，gate 正在失去意义”，Inbox 也会出现一条 info。
- `waivable: false` 的 check，无论哪个通道都会返回 `E_WAIVER_FORBIDDEN`。

**下游联动**

| 情况 | 影响 |
|---|---|
| G0 失效（Studio 内容在 G0 通过后又被改了） | 相关 Blueprint 的 `G1.studio_link` 变为 fail，G1 随之失效 |
| G1 失效 | 已物化但还没开始的任务变为 `held`（`build start` 返回 `E_APPROVAL_STALE`）；正在跑的任务跑到当前阶段结束，不会被杀，但它们的 T 会失败（`T.origin_valid`），合并被拦。Inbox 出现 `approval_stale` |
| 撤销批准 | 等同于失效 |

---

## 8. 监控与审计

### 8.1 显示与不显示

| 显示（默认） | 位置 |
|---|---|
| 阶段、轮次（n/max）、步骤、模型、耗时、预算百分比 | 顶栏芯片、各页头 |
| 运行中的 Studio、Blueprint、Build 步骤 | 首页“运行中”、顶栏 |
| 待回答问题、待批准 gate、轮次裁决、中断选择 | Inbox |
| provider 健康：安装、版本、指纹、认证、callable、最近失败（按码计数） | 设置 → Provider；不健康时出现在全局横幅 |
| 模型 requested 和 resolved、identity、tier（及来源）、所在 lock | 芯片悬停、任务详情、目录 |
| 错误码、分类、动作、重试和轮换次数、是否硬停 | 错误时间线、卡片 |
| token 输入输出、估算费用（标注“估算 · 价格 as_of”）、额度池 | 页头预算条、顶栏额度胶囊 |
| 事件时间线（最近 5 条，可展开分页），每条带审计链接 | 首页和各页底部 |
| gate、approval、waiver 的历史和原话 | Gate 视图 |

| 不显示（默认） | 规则 |
|---|---|
| prompt 原文 | 永远不显示，只显示 sha256 和长度 |
| 原始 CLI 日志 | 点击并确认后才显示，且已脱敏 |
| 凭据 | 只显示“已配置 ✓”或“回退本机” |
| 专家 / 设计全文 | 收起，点击后在抽屉里显示 |
| 其他项目的产物路径 | 只在当前项目上下文中显示 |

### 8.2 耗时、费用与预算

- **耗时：** `running.elapsed_s` 由 Read API 根据 `started_at` 计算。若超过 provider `stallMinutes` 的 80%，显示黄色“可能卡住”。这只是提示，判定仍由看门狗做。
- **费用：** 用 `usage` 乘以 `model-advice.json` 中的价格表（带 as_of）；价格缺失时显示“—”。
- **预算检查：** 在步骤边界检查（不打断正在进行的调用）。达到 80% 时 Inbox 出现 info，达到 100% 时进入 `awaiting_user(budget)`。

### 8.3 审计链

- 每个会话都有一条可追溯的链：A 级的 `history` 和 `gate` 带有 `records_index_sha256`，对应 B 级的 `records.index.json`，再对应各过程文件的 sha256。
- `agentline audit verify` 输出 `{ok, missing[], mismatched[]}`；UI 在 Gate 视图显示“审计 ✓/✗”。
- 换一台机器 clone 仓库后，B 级记录不存在，审计显示“过程记录不在本机（仅定稿可验）”，不判定为篡改。
- 审批、豁免、裁决、配置变更都会记录 `channel` 和原话。CLI 无法证明调用者是人（R4），UI 会在 `channel=cli` 的审批旁标注“CLI 通道”。

---

## 9. 迁移、兼容与回滚

### 9.1 兼容承诺

| 对象 | 承诺 |
|---|---|
| `flow`、`run`、`merge`、`grant`、`stop`、`input`、`answer`、`status`、`check` | 参数和语义不变。唯一的增量是 `merge` 在**存在 `origin.json`** 时多一项检查（5.12-3）；旧任务不受影响 |
| `.collab/tasks/<NNN>/` | 文件、状态、check-task 判定都不变；`origin.json` 是可选的 |
| `agentline.config.json` / `agentline.local.json` | 结构不变。新配置写到 `agentline.stages.local.json` |
| Host v1 路由 `/agentline/{metrics,projects,tasks,task,merge,flow,control,routing,models,live,summary,notices}` | 继续可用，见 9.2 的调整 |
| 工具 `agentline_metrics/status/flow` | 名称和参数不变。`agentline_flow` 内部改走 `build start`（行为更严格：Blueprint 来源任务要求 G1 有效；旧任务和独立任务没有区别） |
| `/agentline <目标>` | 保持兼容，见 5.11 |

### 9.2 v1 路由调整

| 路由 | 调整 | 原因 |
|---|---|---|
| `GET /agentline/projects` | 去掉 `sweepInterrupted` 写操作；改由 Read API 派生 `interrupted_suspected`，UI 显示“疑似中断 [标记并处理]”（命令 `recover.sweep`） | GET 不写 |
| `GET /agentline/flow` | 保留一个过渡期，响应带 `deprecated: true`；内部改为调用 `build start`。UI 不再使用 | GET 不写 |
| `GET /agentline/control?action=stop` | 只接受 POST；GET 返回 405，并提示改用 v2 | 同上 |
| `POST /agentline/models` / `POST /agentline/routing` | 改为在内部 spawn `roles set` 等 CLI，不再在插件进程里 `saveRoleMatrix` 或 `writeProject` | 插件不写配置或 `.collab` |
| `/agentline` 命令写 `.collab/agentline.json` 和 `brief.md` | 改为调用 `task new` CLI | 插件不写 `.collab` |

### 9.3 新增的版本号

| 对象 | 版本 |
|---|---|
| CLI 信封 | `agentline.cli/2`（旧命令的人读输出不变） |
| Read API | `READ_API_VERSION = 1`。插件启动时检查，不兼容时页面降级为“核心不支持”，Build v1 功能照常 |
| Host v2 | `agentline.host/2` |
| 数据 | 每个新 JSON 都有 `schema` 字段，例如 `agentline.blueprint/v1`。读取方遇到未知的主版本号时只读显示并标注“新版本数据” |

### 9.4 迁移命令（全部提供 `plan` 和 `apply`，apply 需要人类通道）

| what | 动作 | 运行中保护 |
|---|---|---|
| `config` | 生成 `agentline.stages.local.json`（Build 角色**不复制**，仍在原文件），并写一次 config-history | 无影响 |
| `git-retention` | 写 `.collab/.gitignore`。可选的“从索引移除已提交的 logs/handoff”（`git rm --cached`）需要单独确认；**不改写历史** | 有活着的 flow 锁时拒绝（`E_BUSY`） |
| `origins` | 把 `data/flow-origins/*` 复制到 `data/plugin/origins/`；读取时同时兼容旧位置 | 无影响 |

### 9.5 升级时正在运行的任务

- flow 是 detached 子进程，插件重载不会杀掉它；origin 文件格式不变，任务结束通知照常投递。
- Supervisor 第一次看到一个已经在跑、但没有 `build/NNN.json` 的任务时，只**登记**（`adopted: true`），不干预。等它退出后再按 7.1 处理。
- 迁移命令都会检查锁（`.flow.lock`、registry、stage locks），有冲突就拒绝。

### 9.6 插件设置

现有字段不变，新增以下字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `pollSeconds` | 5 | 运行时轮询；空闲时固定 30 秒 |
| `rawLogs` | `confirm` | 取值 `confirm / never`；没有 `always`，这是刻意的 |
| `agentlineData` | `""` | 留空即 `%LOCALAPPDATA%\AgentLine`（⚑U9） |
| `theme` | `auto` | 取值 `auto / dark / light` |

### 9.7 回滚路径

1. **插件回滚到 0.17.0：** v2 路由消失。新目录（`.collab/studio`、`blueprint`、`build`、`milestones`，以及 `origin.json`）对旧插件不可见，也不影响它；旧插件的 GET 写入行为会恢复（已知）。
2. **核心回滚到 0.4.0：** 旧 `merge` 会忽略 `origin.json`（相当于失去 gate 兜底，属于已知降级）；`agentline.stages.local.json` 被忽略；`.collab/.gitignore` 保留，也无害。
3. **数据回滚：** 新数据都是新增文件，删除 `.collab/{studio,blueprint,build,milestones}` 和 `tasks/*/origin.json` 就回到原状。配置用 `config rollback`。
4. **哪些不可回滚：** 已经执行过的 `git rm --cached`（需要重新 `git add -f`）。这一点在迁移 plan 里会单独列出。

### 9.8 本仓库的引导

本次 Studio 和 Blueprint 是手工完成的，产物在 `docs/studio/…`、`docs/blueprint/…`。实现完成后，第一件事是：

1. `studio import --from docs/studio/20261106-agentline-plugin`；
2. 对 `G0.role_tiers`、`G0.identity_verified` 做豁免（⚑U11），用户批准 G0；
3. `blueprint import`，导入本设计的定稿。

这样整条链路就在自己身上验证了一遍。

---

## 10. 实现切分建议（不是任务图）

设计通过后，由 Blueprint 的 task-graph 正式产出任务。下面只给工作流和依赖方向，**不对应版本号**。

| 工作流 | 内容 | 依赖 |
|---|---|---|
| W1 契约 | 所有 JSON schema、错误码表、命令白名单、DTO，加上 fixture 和校验器 | — |
| W2 Provider 与身份 | `providers.mjs` capability、adapter `identity` 增量（重点：codex 和 gemini 的 resolved 来源调研）、只读模式参数 | W1 |
| W3 目录与 probe | `catalog.mjs`、`tiers.json`、`probe.mjs`、config-history | W1, W2 |
| W4 错误分类 | `control/errors.mjs` 加真实错误语料库 | W1 |
| W5 Gate 与审批 | `gate.mjs`、`approval.mjs`、内容哈希、waiver、派生 stale | W1 |
| W6 Read API | summary、inbox、sessions、gates、artifacts（含脱敏） | W1, W5 |
| W7 Build Supervisor | `build-ctl` start/resume/queue/merge、合并兜底、milestone e2e | W4, W5 |
| W8 Studio 引擎 | 状态机、stage-exec 只读快照、records、events、import | W3, W4, W5 |
| W9 Blueprint 引擎 | 轮次、testability、materialize、decide | W8 |
| W10 Host v2 | 路由、CommandBridge、v1 路由调整 | W6 |
| W11 UI | 首页、Studio、Blueprint、Build、设置、抽屉、主题和窄屏 | W10 |
| W12 斜杠与工具 | 命令解析、别名、两步批准、工具通道限制 | W10 |
| W13 迁移 | migrate 三项、回滚演练 | W3, W7 |
| W14 守卫 | B1–B8 静态检查进 CI | W10 |

建议的关键路径：W1 → W2/W4/W5 → W6/W7 → W10 → W11/W12。W8/W9 可以和 W10/W11 并行，由 Read API 契约解耦。W3 中“codex 身份来源”的调研结论会直接影响 ⚑U2 的落地方式，应尽早做。

---

## 11. 测试策略

| 层 | 对象 | 方法 | 关键用例 |
|---|---|---|---|
| 单元 | `errors.mjs` | 表驱动，用真实错误语料（中英文、JSON 事件、HTTP 码），每个码 ≥ 3 条正例和 2 条反例 | `author` 不命中 auth；`context` 只命中组合；`429` 与 `quota`、`session` 能区分；裸 403 → `E_FORBIDDEN` |
| 单元 | 内容哈希 | 黄金值测试 | CRLF 与 LF、BOM、文件顺序不同时哈希一致；改 1 字节哈希就变 |
| 单元 | gate 求值 | 每条 check 的 pass/fail/waived/error 夹具；不可豁免项拒绝豁免 | waiver 绑旧 hash 时失效；G1 失效会联动 T |
| 单元 | 状态机 | 迁移表穷举：合法迁移成功，非法迁移返回 `E_STAGE_NOT_ALLOWED`；blocked 与 awaiting_user 判定 | 同时存在故障和待决定时取 blocked |
| 单元 | 角色约束 | 组合测试（2 或 3 个 top、同厂商、备选破坏隔离） | 当前真实配置 → BP preflight 失败 |
| 契约 | CLI 信封、Read DTO、Host v2 | JSON schema 校验；插件端用同一份 schema 测试 | 版本不匹配时降级显示 |
| 契约 | adapters | 用假 CLI（`adapterFactory` 已存在）回放录制的输出 | `identity` 字段新增后旧字段不变 |
| 回归 | Build 零侵入 | v0.4.0 现有测试套件全部保留；`flow.mjs` hash 守卫 | `check-task` 旧夹具结果一致 |
| 集成 | Supervisor | 假 adapter 注入 429、session limit、auth、超时、中断 | 429 → 等待 → resume `--keep`，计数器正确；超时（写角色）不重放；3 次同码 → `E_REPEATED` |
| 集成 | Studio/Blueprint | 假 adapter 跑完整三轮；第 3 轮仍 revise | 到达 `round_limit`；基础设施重试不计轮；只读被破坏时硬停 |
| 集成 | probe | 假 CLI 分别返回 verified、unverified、mismatch、超时 | 主选失败不自动交换 |
| 集成 | 迁移 | 带旧任务和活着锁的夹具仓库 | `E_BUSY`；plan/apply 可逆；不改写历史 |
| 静态守卫 | B3–B6 | 扫描插件和 read 目录 | 插件里出现 `.collab` 写入时 CI 失败 |
| UI | 组件 | jsdom 渲染各状态夹具（每种 status、gate、错误码一份 summary 夹具） | 徽章只取自 gate.status；禁用按钮有原因 |
| UI 人工验收 | 视觉 | 清单：深色、浅色、360px、900px、键盘可达、对比度 | 一屏可见项检查 |
| 斜杠 | 解析 | 表驱动：引号、别名、编辑距离、两步批准 | `aprove` 不会建任务 |
| 冒烟（可选，需真实账号） | 真实 provider | 每个 provider 的 probe 和一次只读 stage 调用 | 手动执行，不进 CI |

完成前的检查：项目有 `scripts/check-fast.ps1` 时，把上面的单元、契约、守卫测试接进去。

---

## 12. 风险与待用户裁决项

### 12.1 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | codex 和 gemini 拿不到实际模型身份；在严格模式下，gpt-6.1-sol 无法参与要求身份验证的阶段 | W2 先调研结构化来源；结论影响 ⚑U2 |
| R2 | 只有 2 个 top 模型，Blueprint 三角色两两不同的硬约束无法满足 | ⚑U1 |
| R3 | flow 的 `--resume` 对轮次的计数语义（每次调用都从 1 循环到 maxRounds）可能让 Supervisor 的“业务轮次 3”与 flow 内部轮次不一致 | Supervisor 以 `verdict-r*.json` 的数量为准，并把剩余轮次作为 `--max-rounds` 传入。W7 需要先写测试确认 flow 的行为；如果确认必须改 flow，需要单开 Blueprint |
| R4 | CLI 无法证明调用者是人，agent 仍可能直接执行 `agentline approve` | 不注册为工具；记录 channel；SKILL.md 明确禁止；UI 标注 CLI 通道。这是已知的残余风险 |
| R5 | 把过程记录放到仓库外以后，换机器就无法查看讨论过程 | 只有定稿可验；审计显示“不在本机”。若需要跨机，见 ⚑U9 |
| R6 | 用 `.gitignore` 停止跟踪 logs 后，check-task 在新 clone 上会因为 `log_ref` 缺失而报错 | Blueprint 来源任务的 T gate 在本机求值；新 clone 上用 `-Lenient`。需要在 check-task 文档里说明 |
| R7 | DSH 命令 API 可能不支持参数补全或返回值渲染 | 已有 followup 注入方案；补全退回 hint 加 help |
| R8 | 豁免被常态化 | 3 条警告 + Inbox 提示；不可豁免项硬编码 |
| R9 | Studio/Blueprint 的 adapter 只读模式在部分 CLI 上不可靠 | `ALL.readonly_capable` 加调用前后的 git 检查（`E_READONLY_VIOLATION` 硬停） |
| R10 | 插件进程内导入 Read API，核心升级后与插件不同步 | `READ_API_VERSION` 检查 + `importFresh`，不兼容时降级 |

### 12.2 待用户裁决项

| # | 问题 | 选项 | 设计师倾向（仅供参考，不是决定） |
|---|---|---|---|
| **U1** | Blueprint 的 top 模型供应：三角色两两不同，且设计与评审不同厂商，至少需要 3 个 top | A：先验证第三个 top（gemini、codebuddy 等）通过身份和 probe 后再开放 Blueprint 编排。B：允许测试架构师复用设计师或评审的模型，`BP.pairwise_distinct` 降为可豁免。C：允许同厂商的不同模型担任评审，每次记录偏离 | A |
| **U2** | 身份证据：无法证明实际模型时怎么办 | strict：`blocked(E_MODEL_UNVERIFIED)`，并且同样适用于 Build（这会影响当前 dev 用的 gpt-6.1-sol）。explicit_exception：人工登记固定版本的例外，持续显示“未验证”，`*.identity_verified` 只能以豁免通过。分阶段：Studio/Blueprint 用 strict，Build 用 explicit_exception | 分阶段 |
| **U3** | 轮次耗尽后可用的裁决方式 | hard_limit：原会话结束，按裁决新建关联会话。bounded_extension：允许在原会话追加 1 轮（最多 4 轮）。repeatable：每次授权加 1 轮，逐次记录偏离。另外：是否提供 `accept_as_is`（接受当前版本，`G1.review_pass` 以用户裁决替代）？ | hard_limit，不提供 accept_as_is |
| **U4** | 模块路径：brief 写的是 `orchestrator/studio.mjs`，而 `flow.mjs` 实际在 `orchestrator/lib/` 下 | `orchestrator/lib/{studio,blueprint}.mjs`（与 flow 字面平级），或 `orchestrator/{studio,blueprint}.mjs` | lib/ |
| **U5** | 行业建议怎么维护 | A：`model-advice.json` 只通过人工 PR 更新。B：允许由 top 模型检索公开资料生成草稿，人工审核后再 PR。C：不提供建议 | B |
| **U6** | Blueprint 中间版本的留存 | 设计全文和评审全文放在外部，每轮的 `review-rN.verdict.json` 进 git（本文默认）；或者全文也进 git | 本文默认 |
| **U7** | 有活跃 Blueprint 的仓库里，独立（adhoc）任务怎么处理 | allow_labeled：允许，只打标签，合并时不能用 grant。require_reason：必须写 `--adhoc-reason`。forbid：禁止 | allow_labeled |
| **U8** | 基础设施自动等待 | 上限（默认 30 分钟）；超过上限后，“到点自动继续”默认开还是关 | 30 分钟，默认关 |
| **U9** | 过程记录目录 | `%LOCALAPPDATA%\AgentLine`（不在 OneDrive，不跨机）；或用户指定的同步目录；或仓库内 `.collab/.local/`（gitignored） | LOCALAPPDATA |
| **U10** | Build 业务轮次默认从 2（插件现值）改为 3，以对齐 Q5 | 改为 3 / 保持 2 | 改为 3 |
| **U11** | 手工完成的 Studio（例如本次）导入后，G0 的 `role_tiers` 和 `identity_verified` 是否允许豁免 | 允许豁免 / 必须补跑 | 允许豁免，但显示“导入”标记 |
| **U12** | 阶段预算默认值（Studio 和 Blueprint 每会话的模型调用、token、估算费用） | 给出具体数值，或者先不设上限、只做监控 | 调用 30 次 / 400 万 token / 估算 $60，并需要人确认 |

---

**审核提示：** 第 6.4 节末尾和 R2 已经说明，按现有配置，Blueprint 的 preflight 会失败。这个结论应在审核时确认，以免设计通过后才发现编排无法启动。
