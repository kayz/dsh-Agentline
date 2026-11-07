# 缺陷报告：Blueprint 的 JSON 提取与身份硬拒

- 报告日期：2026-11-07
- 触发场景：在 `C:\git\dsh-CLIWorker` 上跑 `agentline blueprint new/run`（会话 `cliworker-v2`）
- 环境：Windows、Node v22.23.3、orchestrator 当前 HEAD、provider 为 claude / codex / codebuddy

## 一、JSON 提取器被正文里的 ASCII 双引号打断（阻断级）

### 现象

`blueprint run` 的 designer 步骤失败：

```
ERROR: designer output is missing design prose, interfaces, risks, or a valid task-graph; step not advanced
```

但模型确实输出了完整设计正文 + 末尾合法 JSON。设计内容（38,080 字符）里从 offset 15,742 起就是
`{"interfaces":…,"risks":…,"task_graph":{…}}`，`JSON.parse` 能直接解析成功。

### 根因

`lib/studio.mjs` 的 `lastJsonSpan()`（:660）用字符扫描找“最后一个顶层 `{…}`”，规则是：

```js
if (c === '"') { inStr = true; continue }   // 只按 ASCII 双引号切换字符串状态
```

它假定正文里的 `"` 一定是字符串边界。模型正文中一旦出现**奇数个** ASCII 双引号（例如引用字段名
`"schema"`、写 `--model "<id>"`），扫描器就进入“字符串内部”状态，此后所有 `{` `}` 都不再计数，
最后那个 JSON 顶点永远不闭合 → `lastJsonSpan()` 返回 `null` → `splitModelOutput()` 判定“无 JSON”，
`applyDesign()`（blueprint.mjs:953）随即抛 `E_INVALID_OUTPUT`。

实测同一段文本：

```
prose length = 38050（全文被判为正文），json = null
```

### 复现

```js
import { splitModelOutput } from './lib/studio.mjs'
const text = '正文提到字段 "schema" 之后就有一个奇数个引号\n{"a":1}'
console.log(splitModelOutput(text))   // { prose: 全文, json: null }
```

### 建议修复（任选其一）

1. **从尾部反向尝试**：对文本中每个 `{` 从后往前尝试 `JSON.parse(text.slice(i))`，第一个成功的就是结果。
   实现简单、对正文里的引号免疫。
2. 先剥离 markdown 代码块与行内代码再扫描；扫描失败时回退到方案 1。
3. 保留现有扫描，但把“奇数引号”视为不可信：扫描失败时抛出可诊断的错误（指出引号失配位置），
   而不是笼统地报 `E_INVALID_OUTPUT`。

### 建议补的回归测试

- 正文含奇数个 `"` + 末尾合法 JSON → 必须解析成功；
- 正文含代码块里的 JSON 示例 + 末尾真实 JSON → 必须取到最后一个；
- JSON 内含转义引号（`\"`）与花括号字符串 → 不得错位。

> 影响面不止 blueprint：`splitModelOutput` / `extractJson` 也服务 studio 的纪要、评审与 testability 解析，
> 同样的正文都可能被误判。

## 二、身份证据缺失被当成硬失败（策略问题）

### 现象

同一会话换用 codex 作为评审时报：

```
ERROR: reviewer call did not return model_resolved; identity is not verified
```

而那次调用本身成功（exit 0、32,791 input / 3,452 output tokens、正常产出正文）。

### 根因

- `codex exec --json`（codex-cli 0.166.0-alpha.2）的事件流**不含模型字段**：
  `thread.started {thread_id}`、`turn.started {}`、`item.completed {item.text}`、`turn.completed {usage}`；
  `codex exec --help` 也没有让事件带上实际模型的开关。
- `lib/adapters/reply.mjs` 的 `codexReply()` 据此返回 `modelResolved: null`（注释已说明是预期行为）。
- `lib/blueprint.mjs:676` 把 `!resolved` 直接升级为 `E_MODEL_UNVERIFIED`，`G1.identity_verified`（:1271）也是硬检查，
  于是 codex **无法担任 blueprint / studio 的任何角色**。

### 为什么这条规则现在代价过大

模型没有提供身份字段，不等于调用失败，也不等于模型不可用。硬拒的后果是：一个已经登录、可用、
价格合适的渠道被整体排除在设计流程之外，而真正需要防的“静默降级”并没有因为拒绝而变得可观测。

另外部分渠道（gemini 的 `stats.models`、claude 的 `modelUsage`、codebuddy 的 `event.model`）能自证身份，
部分不能（codex），这条边界应当由**模型层**统一声明和兜底，而不是每个控制面各自硬编码。

### 建议方向

1. `E_MODEL_UNVERIFIED` 降级为**警告 + 记录**（`identity:'unverified'`、`model_resolved:null`、`model_resolved_source:'none'`），
   不阻断流程；只有“实际调用失败/超时/限流”才切换候选模型。
2. `G1.identity_verified` 改为可豁免项（`waivable:true`），或拆成“身份已知”与“身份未知但有调用证据”两档。
3. 长期：身份与可用性归 **CLIWorker** 所有（provider 描述符声明证据来源：`stream-json` / `stats.models` /
   `rollout 文件` / 无法证明），AgentLine 只消费 `ModelHandle.calls[]` 并在调用失败时降级。
4. 若短期仍想支持 codex：`codex` 会在 `~/.codex/sessions/<date>/rollout-*.jsonl` 的 `turn_context.payload.model`
   里记录真实模型（实测为 `gpt-6.1-terra`），可作为一个明确标注“旁路证据”的可选来源，但不能冒充本次调用的 stdout 证据。

## 附：本次会话的事实清单

| 项 | 结论 |
|---|---|
| 设计正文 | 38,080 字符，含完整 task_graph（24 任务 / 41 AC / 6 里程碑） |
| JSON 起点 | offset 15,742，`JSON.parse` 成功 |
| `splitModelOutput` | `json: null`，`prose` = 全文 |
| codex 调用 | exit 0，正常产出，事件流无 model 字段 |
| 绕过方式 | 在 brief 里加“正文禁止出现 ASCII 双引号”约束后，同一模型同一任务一次通过 |

## 三、补充缺陷（D-3）：worktree 拿不到 brief 且不报错

详见同目录 [20261107-agentline-defects.md](./20261107-agentline-defects.md) 的 D-3 节。

要点：flow 在 .collab/worktrees/<NNN> 中执行，worktree 只含已提交内容；brief 未提交到 main 时 worktree 里没有它，flow 不报错、设计师模型照常开跑并浪费一次调用。建议 flow 启动前断言 brief 可读并以 E_BRIEF_MISSING_IN_WORKTREE 快速失败，或让任务元数据不依赖 git 跟踪。

（本文件 D-1/D-2 的完整版已合并进 20261107-agentline-defects.md，以那份为准。）
