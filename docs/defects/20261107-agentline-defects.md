# AgentLine 错误报告 · 2026-11-07

- 报告人：CLIWorker 侧（会话 `cliworker-v2`）
- 目标仓库：`C:\git\dsh-CLIWorker`
- 环境：Windows、Node v22.23.3、orchestrator 当前 HEAD
- 使用到的角色：claude / codex / codebuddy / cursor
- 结论：3 个缺陷，其中 2 个为 P1（静默失败 / 直接阻断可用渠道），1 个为 P2（策略过严）

---

## D-1（P1）Blueprint 的 JSON 提取器被正文里的 ASCII 双引号打断

**位置**：`orchestrator/lib/studio.mjs:660` `lastJsonSpan()`，被 `splitModelOutput()`（:701）与 `extractJson()`（:690）共用。

**现象**

```
ERROR: designer output is missing design prose, interfaces, risks, or a valid task-graph; step not advanced
```

而模型输出完整：38,080 字符，末尾 `{"interfaces":…,"risks":…,"task_graph":{…}}` 从 offset 15,742 起，`JSON.parse` 直接成功。同一段文本上 `splitModelOutput()` 返回 `{ prose: 全文, json: null }`。

**根因**：扫描器把 ASCII 双引号 `"` 当作字符串边界。正文里出现**奇数个**引号（引用字段名 `"schema"`、写 `--model "<id>"`）后进入 inStr 状态，此后 `{` `}` 不再计数，最后一个顶层对象永不闭合。

**复现**

```js
import { splitModelOutput } from './lib/studio.mjs'
splitModelOutput('正文提到字段 "schema" 之后就有一个奇数引号\n{"a":1}')
// => { prose: 全文, json: null }
```

**建议修复**：从尾部反向尝试 —— 对文本中每个 `{` 倒序 `JSON.parse(text.slice(i))`，第一个成功者即为结果；或扫描前剥离代码块/行内代码，失败时回退反向解析。扫描失败时应给出“引号失配位置”而非笼统的 `E_INVALID_OUTPUT`。

**影响面**：blueprint 的 design / testability / review 全部走这条路径，studio 纪要同理。

**回归测试（纳入 CI）**
1. 正文含奇数个 `"` + 末尾合法 JSON → 必须解析成功；
2. 正文含代码块 JSON 示例 + 末尾真实 JSON → 必须取最后一个；
3. JSON 内含转义引号 `\"` 与花括号字符串 → 不得错位；
4. 已知失败样本（本次 38,080 字符输出）作为 fixture 固化。

---

## D-2（P2）身份证据缺失被当成硬失败

**位置**：`orchestrator/lib/blueprint.mjs:676`（`!resolved` → `E_MODEL_UNVERIFIED`）、`:1271`（`G1.identity_verified` 硬检查）。

**现象**

```
ERROR: reviewer call did not return model_resolved; identity is not verified
```

该次调用本身成功：exit 0、32,791 input / 3,452 output tokens、正常产出评审正文。

**根因**：`codex exec --json`（codex-cli 0.166.0-alpha.2）事件流不含模型字段 —— `thread.started {thread_id}`、`turn.started {}`、`item.completed {item.text}`、`turn.completed {usage}`；`codex exec --help` 也没有让事件带上实际模型的开关。`reply.mjs` 的 `codexReply()` 据此返回 `modelResolved: null`（注释已说明为预期），blueprint 把“无证据”直接判为“调用不可信”，于是 **codex 无法担任 blueprint / studio 的任何角色**。

**已确认的修复方向**（与维护者一致）

- `modelResolved: reply.modelResolved || model` 属于**伪造身份**，已回退，不可恢复；
- 身份判定统一归 CLIWorker：`ModelHandle.identity` 提供 `verified / observed / unverified / failed` 四档与 `identity_source`；
- AgentLine 只消费 `calls[]`，`unverified` 不阻断，只有 `failed`（超时/认证/限流/非零退出）才降级候选；
- codex 的 `~/.codex/sessions/<date>/rollout-*.jsonl` 的 `turn_context.payload.model` 只能作为 `observed` 旁路证据，永不冒充本次 stdout 证据。

**当前状态**：本仓库尚未修改，仍为硬拒绝；需进入 AgentLine 的下一个 Blueprint。CLIWorker 侧已就绪（design.md 第 11 节、AC-075、任务 T-031）。

---

## D-3（P1）worktree 任务拿不到 brief，且失败时不报错

**位置**：`orchestrator/lib/worktree.mjs`（创建 worktree 后未校验任务输入）、`flow` 命令的启动阶段（无前置断言）。

**现象**：`flow --task 001` 正常启动、正常调用设计师模型，设计师报告：

> 指定路径下没有 brief.md；任务目录目前只有调度状态和日志。

**根因**：`flow` 在 `<repo>/.collab/worktrees/<NNN>/` 的 worktree 里执行，而 worktree 只包含**已提交**内容。任务输入 `.collab/tasks/<NNN>/brief.md` 若未提交到 main，worktree 里就没有它。`worktree.mjs:79` 的注释已经暴露这个分裂（“主工作区里有 state.json 才算在主编排的任务；只有 brief 说明还没进 worktree”），但 `flow` 没有在启动时断言 brief 可读。

**为什么自己没发现**：`dsh-Agentline` 仓库的 `.collab` 是入库的（`git ls-files .collab` = 57 个文件），dogfooding 场景天然满足前提；新建 `.collab` 且未入库的仓库（如 CLIWorker）必然踩到。

**代价**：一次完整的设计师调用被浪费（codex 那次 design r1），且失败信息由模型转述，操作者要自己推断根因。

**建议修复**
1. `flow` 创建 worktree 后立即断言 `.collab/tasks/<NNN>/brief.md` 可读，否则以 `E_BRIEF_MISSING_IN_WORKTREE` 快速失败，并提示“任务输入必须先提交到 main”；
2. 或更彻底：任务元数据（brief / state / logs）始终从主工作区路径读取，不依赖 git 跟踪，worktree 只承载产品代码；
3. 文档补一句显式前提：**worktree 只包含已提交内容**（README「并发与 worktree」与 SKILL.md 第 151 行附近）。

**回归测试**：`flow` 在 brief 未提交时必须以非零退出并在 stderr 给出上述错误码，不得调用任何模型。

---

## 汇总与优先级

| 编号 | 缺陷 | 严重度 | 后果 | 是否已修 |
|---|---|---|---|---|
| D-1 | JSON 提取器被正文引号打断 | P1 | 设计/评审产出被误判、整轮作废 | 否 |
| D-2 | 身份证据缺失被硬拒 | P2 | codex 等渠道被整体排除 | 部分（方向已定，代码未改） |
| D-3 | worktree 缺 brief 且不报错 | P1 | 白跑一次模型调用，静默降级质量 | 否 |

建议的落地顺序：D-3（最快、最便宜，几行断言）→ D-1（改解析策略 + 回归 fixture）→ D-2（随 CLIWorker 身份契约一起切换）。

## 附：本报告的证据文件

- 设计正文与失败样本：`C:\Users\kayz\AppData\Local\Temp\designer-result.txt`（38,080 字符原始输出）
- 会话日志：`C:\git\dsh-CLIWorker\.collab\blueprint\cliworker-v2\logs\*.log`
- 评审结论：`review-v1/v2/v3.verdict.json`
- CLIWorker 侧身份契约：`.collab/blueprint/cliworker-v2/design.md` 第 11 节

---

## D-4（P1）headless 模式下安全默认拒绝工具，dev 无法删除文件/跑命令

**位置**：orchestrator/config/agentline.config.json 的 providers 默认值 + 各 adapter 的选项映射；README「安全默认」一节。

**现象**：dev（codebuddy，--permission-mode acceptEdits）报告 Bash 与 PowerShell 两个工具都被权限系统拒绝，非交互模式无法弹权限确认，只能 Write 覆盖、无法删除文件，导致 design.md §3.6 要求的「迁移后 test/select.test.mjs 必须不存在」无法完成，任务在产物不完整的情况下结束。

**根因**：codebuddy --help 明确写着 *Headless tool use must be pre-authorized (for example with -y)*。cceptEdits 只放行文件编辑，Bash/PowerShell 必须预先授权。AgentLine 的安全默认表只写了「默认值」，没写「headless 下这些默认会导致工具被拒」。

**同类问题（多 CLI）**

| CLI | 当前配置 | headless 下的表现 | 需要 |
|---|---|---|---|
| codebuddy | --permission-mode acceptEdits | Bash/PowerShell 被拒 | ypassPermissions 或 -y + --allowedTools |
| claude | --permission-mode acceptEdits（README 安全默认） | 同上，编辑可、命令被拒 | ypassPermissions 或 --allowedTools Bash |
| codex | -s workspace-write + pproval_policy=never | 命令可跑，但写范围受限 | 需要更大范围时改 -s，属预期差异 |
| cursor / cursor-wsl | orce: true | 已放开 | 需确认是否等价于 bypass |
| gemini | --approval-mode auto_edit | 只自动批准编辑 | 需 --approval-mode yolo 或等价 |

**建议修复（分两层）**

1. **AgentLine（本次运行先用配置兜住）**：providers.<name>.options 增加显式的 permissionMode / llowedTools，并在 preflight 里报告「该 provider 在 headless 下是否允许工具执行」；README 安全默认表补一列「headless 可用性」。
2. **CLIWorker（结构性修复，落在 T-009 / T-015）**：provider 描述符必须分别声明 call.readonly_args 与 call.exec_args（可执行姿态），由 CLIWorker 生成调用方式时按 postures（readonly / write）选择；这样权限不再由每个上层各自记忆。对应 AC-025（调用方式 golden 覆盖 11 个 CLI × 4 平台）需要扩展一列 posture。

**回归测试**：对一个会写文件的 fixture 任务，dev 必须能执行删除与测试命令；若 provider 未预授权，preflight 或 flow 启动阶段应以 E_TOOL_PERMISSION 快速失败，而不是让模型跑完再报「我删不了文件」。
---

## D-5（P1）静默超时（stall）被当成模型失败，且发现得太晚

**位置**：`orchestrator/lib/exec.mjs` 的 stall 判定与候选切换逻辑；`orchestrator/config/agentline.local.json` 的 `limits.apiStallSeconds`。

**现象**：`flow --task 001` 两次以 `error: "stall"` 结束，第一次在 review（gpt-6-astra / codex），第二次在 dev r2（deepseek-v4.1-flash / codebuddy）。两次日志都只有 15 行左右的中断记录，没有任何 provider 侧错误。

**根因**：stall 是活性超时（liveness timeout）—— 进程起来了、认证正常，但一段时间没有任何输出。当前实现把它与「模型不可用」合并处理：

1. 直接换候选模型，等于惩罚了根本没有产出任何内容的模型；
2. 发现得太晚：`apiStallSeconds` 配成 codebuddy 900s、claude 600s、codex 300s，一次静默要等 15 分钟；
3. 没有区分首字节（TTFT）与中途静默，模型还没开口和说到一半停住用同一个阈值；
4. 进程被杀后 provider 侧请求可能仍在跑并计费，而 `usage: null` 让消耗不可见。

**建议修复与时间安排**

| 项 | 内容 | 建议时间 | 理由 |
|---|---|---|---|
| 1 | 拆成 `E_STALL_FIRST_BYTE`（首字节超时，默认 90s）与 `E_STALL_MID_STREAM`（中途静默） | 本周内 | 纯判定逻辑改动，无协议变更 |
| 2 | 同一模型先重试 1 次，仍 stall 才换候选 | 本周内 | 传输抖动不应触发换模型 |
| 3 | 下调默认阈值：codebuddy 900→180、claude 600→300、codex 保持 300 | 立即（配置即可） | 零风险，立刻见效 |
| 4 | 开工前对目标模型做 1-token 冷启动探针，失败直接换候选 | 下一个 Blueprint（P2） | 需要新增探针与缓存 |
| 5 | stall 时记录「errored at / waited seconds / last event type」 | 本周内 | 现在只有 `error: stall`，无法归因 |

**回归测试**：模拟一个只连接不输出的假 CLI，断言 90 秒内以 `E_STALL_FIRST_BYTE` 结束、重试一次后才换候选，且 run.json 记录等待时长与最后事件类型。

---

## D-6（P2）失败归因缺少结构化证据，且越界修复没有一等公民流程

**现象**：`task 002` 因 CI 失败阻塞时，失败原因只能靠开发者模型自己在 `impl.md` 里自述；调度器输出被截断后，失败的具体 AC 与原始输出没有聚合视图。同时，dev 发现两处**不在自己 write_scope 内**的一行修复，只能停下等待人工把文件加进写域（改 `task-graph.json` + 塞一条 `note`），这是一条旁路操作，没有记录、不可审计、也无法复用。

**根因**

1. 失败证据散落在 `state.json` / `notice.json` / `impl.md` / `ci-results.json` / `run.json` / `handoff/*.md`，没有统一的 `failure.json` 汇总「卡在哪一步、哪条 AC、原始输出、最后一次模型调用、换过几次模型」。
2. `write_scope` 只参与合并分档与证据链校验，**不是运行期沙箱**：越界写入不会被阻止，只会事后发现；反过来，合理的越界修复也没有申请通道。
3. 跨任务腐蚀没有拦截点：`task 001` 在共享文件（`scripts/check-ci.mjs`、`test/unit/traceability.test.mjs`）里留下的缺陷，直到 `task 002` 才显形。

**建议修复与时间安排**

| 项 | 内容 | 建议时间 |
|---|---|---|
| 1 | 每次 flow 结束落一份 `failure.json`：`blocked_reason`、失败 AC 列表（含 id/title/exitCode/output 尾部）、最后三次调用记录、候选切换次数 | 本周内 |
| 2 | 增加 `scope` 子命令：dev 提交越界请求（文件、原因、diff 大小）→ 操作者批准 → 记入 `inputs.jsonl` 与 state，替代改图 + note 的旁路 | 下一个 Blueprint |
| 3 | 合并前跑一次下游客任务验收的可用性检查（至少覆盖共享文件被改动的场景） | 下一个 Blueprint |
| 4 | 共享文件单一属主：`scripts/check-*.mjs`、`test/unit/traceability.test.mjs` 这类基础设施文件只归一个任务写，其他任务走 scope 申请 | 下一个 Blueprint |

**操作侧纪律（不进代码，进流程文档）**：任何 flow 结束，必须无条件读取 `state.json` / `notice.json` / `impl.md` / `ci-results.json` / `run.json` 五件套再下结论，不得依赖人工转述失败摘要。

---

## D-7（P1）验收判据可被实现方改写，且绑定实现细节

**现象**：T-013 的验收要求 TAP 输出出现特定测试标题，测试实际标题不同 —— 功能通过、验收变红；dev 补一条标题，验收又要下一条，形成无限追列表。

**根因（两条）**

1. **判据绑定实现细节**：验收断言测试标题而非退出码，等于把内部命名变成对外契约。
2. **作者归属错误**：cceptance.md 在 dev 轮次里被反复重写。让实现方写判决标准是利益冲突 —— 写不动就改判据。

**建议修复**

| 项 | 内容 |
|---|---|
| 契约 | AC 判据只允许断言退出码 / 输出子串 / 文件状态 / 显式哨兵；禁止测试标题、函数名、行号、其他任务状态 |
| 归属 | cceptance.md 由 design 阶段产出，不在 dev 的 write_scope 内；改动须走 amendment |
| 守卫 | check-acceptance：(a) 提取命令数为 0 → 失败；(b) 出现标题断言模式 → 失败；(c) 缺 AC-xxx OK 哨兵 → 失败 |
| review | 增加一条 checklist：验收是否绑定实现细节？ |