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
