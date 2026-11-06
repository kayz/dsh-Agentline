我已读完必读文档，也看了核心的错误分类（`exec.mjs` 的 `classifyError`）、`flow.mjs` 里的 blocked 原因和插件路由。下面是评审结论，没有改动仓库。

## 1. 核心判断

1. **方向对，但顺序反了。** 现在最痛的是 Build 出错要人看日志、手动 resume，而 Studio/Blueprint 还完全没有核心实现。路线却先做三阶段外壳（0.18）。三阶段 UI 不该先于核心状态机，否则 0.18 只能展示空页面，或者只能靠推断状态来填，这正是 input 里说不做的事。
2. **用户眼里不该是三个页面，而是一个"待我处理"队列加一条进度条。** 用户关心三件事：现在卡在哪、要我决定什么、凭什么证据决定。Studio 的轮次和 participants、Blueprint 的 review-v1/v2 都是内部过程，默认收起。首页应该是收件箱（Inbox）：G1/G2/G3 闸门、`awaiting_user` 问题、`blocked(*)` 任务，每条都是"一个问题 + 默认选项 + 证据链接"。三阶段只是 Inbox 条目上的标签和顶部的进度条。
3. **现有错误分类不够当规则引擎的底座。** `orchestrator/lib/exec.mjs:268` 用子串匹配：`'context'` 排在 `auth` 前面，`'auth'` 还能匹配到 `author`，quota 和 rate_limit 被归成一类，`capacity/stall/timeout/transport/run_failed` 也没有对应动作。另外 `rate_limit` 目前会触发换候选（`exec.mjs:217`），而 Studio/Blueprint 要求不静默降级，两者冲突。**结构化错误码和动作表是三阶段的前置条件，应该排在 Studio/Blueprint 之前。**
4. **当前配置撑不起 docs/03 的角色要求。** `agentline.local.json` 里 design=`claude-opus-5-5`、review=`claude-opus-4-5`，同厂商，而且 4-5 显然不算顶级。Blueprint 要求评审换厂商，Studio 要 3 位顶级专家 + 主持。按本机实际可用的 anthropic/openai（gemini/codebuddy 是否能用未验证），顶级模型可能凑不够。这一点在做任何 UI 之前就要由用户决定（见第 7 节）。

## 2. 插件/核心边界

**原则：核心拥有所有"会改变下一步行为"的状态，插件只拥有"怎么呈现"。** 判断方法：如果删掉插件、只用 CLI，流程还能跑完、审计也完整，边界就是对的。

| 状态 / 能力 | 归属 | 说明 |
|---|---|---|
| 阶段状态机（`studio/<id>/session.json`、`blueprint/<id>/state.json`） | **核心** | 只有核心写，插件只读 |
| Gate 求值结果（`gate.json`：每条条件 pass/fail + 证据路径） | **核心** | 插件只渲染，不自己算 |
| 错误码、重试计数、`next_action` | **核心** | 插件不判断"能不能重试" |
| `model_requested` / `model_resolved` / `tier` 判定 | **核心**（provider 层） | |
| 用户决定（批准 / 豁免 / 授权加轮） | **核心落盘**，插件只调 CLI | 记录 `by/at/via=plugin|cli` |
| Provider manifest（CLI 能力、版本、参数） | **核心**下面的独立 provider 层 | 不进插件 |
| Inbox 聚合、排序、折叠、通知去重 | 插件 | 纯视图，丢了也能重建 |
| raw 输出展开、diff 视图、额度胶囊 | 插件 | |
| 凭据（secret 设置） | 插件设置，以 env 方式注入核心 | 现状保持 |

**防止插件变成第二套 orchestrator 的硬约束**（可以写进插件 CI）：

1. 插件只能通过 `agentline.mjs <cmd> --json` 和读 `.collab/**` 两种方式拿状态。**插件代码里不允许出现对 `.collab/**` 的写入**（用 grep `writeFile.*\.collab` 拦）。
2. 插件里每个"按钮"必须对应且只对应一条核心 CLI 命令，不能组合编排。现在 `/agentline/control` 直接 spawn `input/answer/flow`，可以接受。但不能出现"插件先 stop 再改 state 再 flow"这类多步逻辑。
3. 插件里不允许出现 `if (status === 'blocked' && reason === 'rate_limit') 自动 resume` 这种策略代码。自动恢复只在核心做，插件最多显示"核心将在 HH:MM 自动重试"。
4. 核心新增一个 `agentline pipeline summary --json`，插件的 Home 只读它。现在 `/agentline/summary`（`index.js:767`）在插件里遍历任务自己汇总，应该下沉到核心。

## 3. 三阶段与用户闸门

统一的 gate 文件格式（核心写，插件读）：

```json
{ "gate": "G0_studio_exit", "evaluated_at": "...", "pass": false,
  "checks": [
    { "id": "S3", "desc": "每个 decision 有用户确认或采用默认值", "pass": false,
      "evidence": "decisions.json#D-04", "fix": "answer D-04" } ],
  "waivers": [ { "check": "S5", "by": "user", "at": "...", "reason": "..." } ] }
```

`pass = 所有 checks 通过，或被 waiver 覆盖`。只有标了 `waivable:false` 的项不能豁免。UI 上每条 check 都有一句人话（`desc`）和一个动作（`fix`），这就是"用户能看懂、机器能校验"。

**G0 Studio 准出**（docs/03 没把这一步列为闸门，但退出条件需要用户确认）：

| id | 条件（机器可校验） | 可豁免 |
|---|---|---|
| S1 | `decisions.json` 非空，每项有 `id/question/default/options` | 否 |
| S2 | 每位专家在 `confirmations/<expert>.json` 里给出 `accept / accept_with_notes / reject` | 是（豁免要写理由） |
| S3 | 每个 decision 的 `status ∈ {user_confirmed, default_adopted}` | 否 |
| S4 | 没有 `blocking:true` 且 `status=open` 的问题 | 否 |
| S5 | 每个 decision 的 `rounds ≤ 2`；超过的必须 `status=dissent_recorded` | 否 |
| S6 | `minutes-final.md` 存在，且书记的模型 ≠ 主持的模型（看 `model_resolved`） | 否 |

**G1 Blueprint 准出 → 可进入 Build**：

| id | 条件 | 可豁免 |
|---|---|---|
| B1 | `task-graph.json` 通过 schema 校验：每个任务有 `id/depends_on/write_scope(非空)/acceptance(非空)/test_levels(非空)` | 否 |
| B2 | 依赖图无环，`depends_on` 都能解析 | 否 |
| B3 | `acceptance-matrix.md` 的每个 AC-ID 至少被一个任务引用，任务引用的 AC 都存在（双向覆盖） | 否 |
| B4 | 最新 `review-vN.json.verdict == "pass"`，且 `N ≤ 3` | 不收敛时由用户裁决，记为 `user_override` |
| B5 | `testability.json` 里没有 `status=open` 的 blocker | 否 |
| B6 | 设计师、评审、测试架构师的 `model_resolved` 两两不同；评审与设计师不同厂商 | 是（用户豁免，记入偏离） |
| B7 | `approvals.json` 里有用户对 `sha256(task-graph.json + test-strategy.md)` 的批准 | 否 |

B7 很关键：**批准绑定内容哈希**。批准后再改任务图，批准自动失效，杜绝"伪造已批准"。

**Build（沿用现有内核，只补两条）**：

- 任务完成：`state.status ∈ {pr_open, merged}`，`check-task.ps1` 通过，且 `acceptance.md` 覆盖了 brief 里的 AC-ID。
- G2 里程碑：里程碑内所有任务已 `merged`，跨任务 E2E 命令退出码为 0，用户写入 `milestone-approval.json`。
- G3 发布：第一版不做（见第 5 节）。

**轮次上限的表达**：到上限时状态变成 `awaiting_user`，`next_action: ["accept_current", "user_decide", "authorize_extra_round(1)", "abandon"]`。`authorize_extra_round` 每次只能加 1 轮，写进 `deviations.json`，Inbox 显示"本阶段已偏离协议 1 次"。

## 4. 四个特例化问题

### 4.1 外部 CLI 导入：UI 应该暴露到什么程度？

- **放在独立 provider 层（核心目录下的 `providers/`），不放插件。** 配置里已经有雏形（`agentline.config.json` 的 `providers.*.adapter/auth/effort/limits`），升级成 manifest：

```json
{ "provider": "codex", "cli": { "command": "codex", "version_cmd": ["--version"], "tested_range": ">=0.9 <0.11" },
  "capabilities": { "json_stream": true, "effort": ["low","medium","high","xhigh","max"], "model_flag": "--model" },
  "error_map": [ { "match": "turn.failed.*429", "code": "rate_limit" } ],
  "probe": ["exec", "--model", "{model}", "reply OK"] }
```

- **UI 只暴露一个状态灯和一句话**，每个 provider 三态：
  - `ready`：已安装、已登录、版本在测试范围内、probe 通过；
  - `degraded`：版本超出 `tested_range`，或 probe 没跑过；
  - `unavailable(reason)`：reason ∈ `not_installed | auth | version_unsupported`。
  点开后显示修复命令（比如 `codex login`），**不暴露参数和输出格式**。
- **"可见"和"可调用"要分开**：模型表加两列。`discovered`：扫描到了。`callable`：最近 24h 内 probe 成功，或最近一次真实调用成功，带时间戳。角色选择器里只有 `callable` 的模型能选进 Studio/Blueprint；Build 允许选 `discovered`，但要标黄。
- 版本漂移的处理：版本超出 `tested_range` 时**不阻止运行**，但 run 记录写 `cli_version`；第一次解析失败就归入 `invalid_output`（见 4.3），不再兜底成 `run_failed`。

### 4.2 模型认定

- **顶级模型以用户维护的显式 allowlist 为准**，provider 元数据只当参考。不要自动推断"顶级"，厂商命名没法可靠推断。

```json
"tiers": { "top": ["claude-opus-5-5", "gpt-6.1-sol"], "high": ["claude-opus-4-5"] },
"aliases": { "opus": "claude-opus-5-5" }
```

- **阶段开始前做 preflight**（核心命令 `agentline stage preflight --stage blueprint`），失败就不启动，直接给出 `blocked(preflight)` 和具体是哪条：
  1. 每个角色的候选都在 `tiers.top` 中，且 `callable`；
  2. 冲突规则：主持≠书记，设计≠评审，测试架构师≠评审，按**解析后的模型 ID** 比较，不按别名；
  3. 厂商规则：评审与设计师的 `source` 不同（硬性），测试架构师尽量不同（软性，只警告）。
- **不静默降级**：Studio/Blueprint 阶段的候选列表**只允许同档换模**；没有同档候选就停在 `waiting(model)`，不往下走。现在 Build 的 `maxSwitchesPerStage` 保持不变。
- **审计**：每条 run 记录写 `model_requested`、`model_resolved`（从 CLI 输出取，现在已有 `record.model_resolved`）和 `tier_at_run`。两者不一致时，`resolved ∉ tiers.top` 就判定为 `model_mismatch` 硬停，`resolved` 只是同档别名则只记录。UI 只在不一致时显示 `requested → resolved`，平时只显示一个名字。
- 下线、403、额度耗尽都通过 provider 的 `error_map` 映射到统一错误码（见下表），不在流程代码里写 `if provider`。

### 4.3 出错时：自动恢复，还是用户决定？

判断原则：**重试同一件事、不改变质量基线的，自动做；改变模型、范围、预算或丢弃产物的，要用户决定；产出可疑的，硬停并保留现场。**

| 错误码 | 自动动作 | 最大次数 | 换模型 | 保留现场 | 结果状态 | 需要用户 |
|---|---|---|---|---|---|---|
| `transient_network` | 指数退避重试同模型 | 2 | 否 | 是 | 超限转 `blocked(transient_network)` | 超限后 |
| `capacity`（overloaded） | 退避重试同模型 | 3 | Build 可平级换，S/B 否 | 是 | 同上 | 超限后 |
| `rate_limit` | 有 `reset_at` 且 ≤ 30min 时等到重置再续跑；否则停 | 1 次等待 | Build 按现策略，S/B 否 | 是 | `waiting(rate_limit, until)` | >30min 时 |
| `quota`（额度/周额度耗尽） | 不重试 | 0 | 否 | 是 | `blocked(quota)` | **是**：换模型或等 |
| `auth` | 不重试（与现状一致） | 0 | 否 | 是 | `blocked(auth)` + 修复命令 | **是** |
| `model_unavailable`（403/下线） | 不重试 | 0 | 只能同档换，S/B 也允许 | 是 | 没有同档就 `blocked` | 无同档时 |
| `cli_crash` / `stall` / `timeout` | 用交班单重试一次 | 1 | 否 | 是（checkpoint） | `blocked(cli_crash)` | 超限后 |
| `invalid_output`（产物缺失、JSON 坏、退出码为 0 但没产出） | **硬停** | 0 | 否 | 是，raw 全留 | `blocked(invalid_output)` | **是** |
| `model_mismatch` | **硬停** | 0 | — | 是 | `blocked(model_mismatch)` | **是** |
| `ci_failed` | 交回 dev 修（现有 review-repair 轮次内） | 按现有轮次 | 否 | 是 | 超限转 `review_exhausted` | 超限后 |
| `review_rejected` / 轮次上限 | 不加轮 | 0 | 否 | 是 | `awaiting_user` | **是** |
| `budget_exceeded` | 不再发起调用 | 0 | 否 | 是 | `awaiting_user` | **是** |
| `interrupted`（进程死了） | 不自动续（现状），UI 一键继续 | 0 | 否 | 是 | `blocked(interrupted)` | 一键确认 |
| `user_cancelled` | 不动 | — | — | 是 | `halted` | — |

**必须硬停、不能自动重试掩盖的**：`invalid_output`、`model_mismatch`、`auth`，以及**同一错误码在同一任务里连续出现 3 次**（不论哪类，都升级为 `blocked(repeated:<code>)`），防止退避重试一直空转。

**实现前提**：分类从正则子串改成"adapter 先给结构化码（Claude 的 `api_error_status`、Codex 的 `turn.failed`），正则只做兜底"，并修掉 `'context'`、`'auth'` 子串误匹配。这一项比任何 UI 都优先。

### 4.4 准入/准出

见第 3 节的 S1–S6、B1–B7。补充两条：

- **准入**也走同一套 gate 文件格式：Blueprint 准入 = G0 通过；Build 从 Blueprint 导入任务的准入 = G1 通过，且批准里的哈希与当前 `task-graph.json` 一致。
- 插件的阶段徽章只有 `gate.pass` 一个数据源。gate 文件不存在就显示"未评估"，**不显示"进行中"**。

## 5. 路线与最小切片

0.18–0.21 按"三个阶段各一版"切分，是**按 UI 切，不是按用户价值切**，而且 0.18 本身没有能读的数据。建议改成：

| 版本 | 内容 | 位置 |
|---|---|---|
| **0.18（最小切片）** | ① 结构化错误码 + 上面的动作表，在 Build 落地；② `rate_limit` 带 reset 时等待自动续跑；③ 插件 Home 改成 Inbox，只显示 Build 的 `blocked/awaiting_user/pr_open`，每条附错误码、人话说明和一个按钮；④ `pipeline summary --json` 下沉到核心 | 核心为主，插件少量 |
| 0.19 | 模型 `tiers` allowlist、`callable` probe、`stage preflight`；Blueprint 的 **G1 gate 校验器**（`agentline blueprint check <dir>`）。Blueprint 产物**仍由人或现有 design 角色手工产出**，核心只负责校验和批准（哈希绑定）；`task-graph → brief.md` 导入命令 | 核心 |
| 0.20 | Blueprint 编排（设计 → 评审 → 测试架构，三轮上限）；插件在 Inbox 中显示 G1 卡片 | 核心 + 插件 |
| 0.21+ | Studio 编排 | 后置，看 0.20 的使用频率再定 |

这个切片的理由：**gate 校验器加导入命令**，让用户今天就能手工写 Blueprint 并得到机器校验和受控交接，不依赖多模型编排。编排只是在这之上自动产出这些文件。Studio 的价值最不确定、成本最高（5 个模型），放最后。

**插件最有价值的三项改动**：

1. **Inbox 首页**：所有需要人处理的事放进一个队列，每条有错误码、一句人话和一个按钮。
2. **错误码驱动的状态展示与一键动作**：auth 给修复命令；rate_limit 显示倒计时和"将自动续跑"；quota 给"换模型/等待"二选一。
3. **G1 批准卡片**：任务图、AC 覆盖率、测试层级摘要、批准按钮，批准时写入内容哈希。

**最应该砍掉或后置的三项**：

1. **0.18 的"三阶段只读外壳"**：没有核心数据，只会做出空页面，或者诱发插件推断状态。
2. **Studio 的 participants / rounds / scribe 完整 UI 和 `/studio/*` 五条路由**：后置到 Studio 编排存在之后。Studio 第一版可以只是"导入 `decisions.json` → 用户逐项确认"。
3. **9 角色矩阵的配置 UI**（Studio 5 + Blueprint 3 + Build 3）：改成每阶段一个"preflight 结果"面板，只显示是否满足规则、冲突在哪；角色候选继续用 CLI 和配置文件维护。

## 6. 风险

1. **模型供给不足，导致协议形同虚设**：如果可用、已登录的顶级模型凑不齐 3 个厂商，Blueprint 的"评审不同厂商"和 Studio 的"5 个顶级模型"会被频繁豁免，豁免一常态化，gate 就失去意义。对策：先跑 preflight，看本机实际能满足几条规则，再决定协议是否放宽，不要先做 UI。
2. **状态双写**：插件为了填充三阶段页面，自己推断或缓存阶段状态，和核心不一致后，用户会根据错误的状态批准或合并。对策：第 2 节的四条硬约束，再加上"gate 文件不存在就显示未评估"。
3. **自动恢复掩盖真实失败或静默降级**：错误分类仍靠子串匹配，`rate_limit` 会触发换候选，quota 和 rate_limit 混在一起。自动化越多，被误分类的失败越容易变成"跑完了但质量变低"。对策：结构化错误码先行，`model_mismatch` 硬停，同码连续 3 次就升级。

## 7. 需要用户裁决的问题

```json
[
  {
    "id": "Q1",
    "blocking": true,
    "question": "Studio/Blueprint 的“顶级模型”名单怎么定？本机现有组合（claude-opus-5-5 / gpt-6.1-sol / claude-opus-4-5）不满足“评审不同厂商且均为顶级”的要求。",
    "options": [
      "A：tiers.top 只放 claude-opus-5-5 和 gpt-6.1-sol；Blueprint 的设计师和评审各用一个，测试架构师复用其中之一（违反“尽量不同厂商”，只警告不阻断）",
      "B：接入 gemini/codebuddy 的顶级模型并通过 probe 后再启动 Blueprint；在此之前只做 0.18/0.19 的 Build 加固和 gate 校验",
      "C：放宽协议，允许同厂商不同模型担任评审，每次记入 deviations"
    ],
    "default": "A",
    "why_blocking": "决定 preflight 规则能否通过，以及 0.20 能不能实际运行"
  },
  {
    "id": "Q2",
    "blocking": true,
    "question": "是否同意把路线改成“0.18 先做 Build 错误规则化 + Inbox，0.19 做 Blueprint gate 校验器与手工产物导入，编排后置”，取代“0.18 三阶段只读外壳”？",
    "options": [
      "A：同意改序（推荐）",
      "B：保持原路线，0.18 做三阶段外壳，但没有核心数据的阶段显示“未实现”",
      "C：改序，并且 Studio 编排整体推迟到出现明确需求之后"
    ],
    "default": "A",
    "why_blocking": "决定下一个版本的工作内容，以及插件和核心谁先动"
  }
]
```
