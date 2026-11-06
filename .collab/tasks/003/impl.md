# P6 实现说明（task 003）

## 改动范围

只改了 design.md `write_scope` 允许的路径，外加本文件：

| 文件 | 类型 | 作用 |
|---|---|---|
| `orchestrator/lib/studio.mjs` | 新增 | Studio 控制面核心：会话落盘、单步执行、用户回答、G0 求值 |
| `orchestrator/agentline.mjs` | 修改 | 新增 `studio new\|run\|answer\|conclude\|status` 分发与帮助 |
| `orchestrator/test/studio-cli.test.mjs` | 新增 | 真实 CLI 的单步 / 恢复 / 阻塞 / 确认 / G0 测试 |
| `orchestrator/test/studio-g0.test.mjs` | 新增 | G0 正例与逐项反例、证据变化后重新求值 |
| `plugin/lib/index.js` | 修改 | 新增 `/agentline/studio`：GET 只读，POST 每条动作转发一条 CLI |
| `plugin/lib/client.js` | 修改 | Studio 页（真实数据/空态/错误态/四项操作）、按渠道分组的模型目录、11 角色矩阵 |
| `plugin/test/studio-ui.test.mjs` | 新增 | 真实历史插件路由 + 真实渲染/交互的 UI 测试 |

`flow.mjs`、`exec.mjs`、路由（design/dev/review）与 Build 驾驶舱语义未改。

## Studio 控制面

### 数据布局（唯一状态来源）

```
<repo>/.collab/studio/<id>/
  session.json          会话状态（status / steps_done / roles / outputs / calls / revision）
  questions.json        主持提出的问题（blocking / status / rounds_used / user_action）
  decisions.json        书记产出的决策（status / rounds_used / confirmed_by_user）
  confirmations/*.json  三位专家各自的确认（verdict / notes / model / at）
  minutes-final.md      最终纪要
  logs/<role>.log       每次角色调用的原始输出落点（由 adapter 写）
```

- 会话 ID 只接受单个安全路径段（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，拒绝 `.`/`..`/`/`/`\`）；
  新建不覆盖已有目录。
- `readStudio` 区分 `missing / empty / corrupt / ok`，CLI `status` 与插件 GET 都基于同一实现。

### 单步状态机

`steps_done` 决定下一步，顺序固定：

```
expert_a → expert_b → expert_c → moderator → scribe → confirm_a → confirm_b → confirm_c
```

- 每次 `studio run` **只调用一个角色**，成功后才写入 `steps_done`；调用失败只追加一条
  `calls[ok=false]` 与 `last_error`，不推进、不编造输出。
- 三个专家的提示词只包含用户输入，彼此独立；主持读取三份专家输出；书记读取主持人输出、
  问题与用户回答；确认阶段由对应专家独立调用（`confirm_a` 只使用 `expert_a` 的模型）。
- 主持人返回的 JSON 解析失败、书记缺少纪要/决策、确认缺少合法 verdict 时，整步失败。

### 用户动作

- 主持产生 `blocking && status=open` 的问题时，`session.status=awaiting_user`；
  存在任一 open blocking 问题时 `run` 直接拒绝（`E_AWAITING_USER`），必须先 `answer`。
- `studio answer --question <Q-n> --text "..."` 记录 `user_action.kind=answer`；
  `--default` 记录 `user_action.kind=default` 且文本取问题/决策的默认值。两者互斥，
  缺省值不存在时拒绝。
- 决策逐条确认：`--decision <D-n> --text` 记 `confirm`，`--default` 记 `default`；
  `statusAfterStep` 只在全部决策都有用户动作后才把会话标成 `ready`。
- 业务轮次：回答一次问题会同时给该问题与关联决策记 1 轮；达到 2 轮后拒绝再开文本讨论
  轮次（`E_ROUND_LIMIT`），但允许显式采用默认。轮次不因失败/重试自增。

### G0

`evaluateG0` 每次都从磁盘重新读取证据，拼内容哈希后交给
`lib/contracts/gate.mjs` 求值（`agentline.gate/v1`），输出 7 个 check：

```
G0.minutes_final         minutes-final.md 存在且非空
G0.decisions_nonempty    decisions.json 至少 1 条
G0.each_decision_confirmed  每条都有 confirmed_by_user（confirm/default）
G0.no_open_blocking     没有 open/unresolved 的 blocking 问题
G0.decision_rounds_le_2 问题与决策 rounds_used 均 ≤ 2
G0.experts_confirmed    a/b/c 都有有效确认且无 reject
G0.scribe_ne_moderator  书记与主持模型均已知且不同
```

- 问题文件损坏时 `G0.no_open_blocking` 直接失败（不能当作"没有阻塞"）。
- `conclude` 通过才写 `status=concluded`；失败时若之前是 concluded，会改回
  `awaiting_user(blocking_reason=g0_failed)`，不保留过期通过状态。
- `conclude` 不写任何用户确认或专家确认。

### 角色配置与模型调用

- 角色模型来自 `config.studio.roles.<role>`（或项目 `.collab/agentline.json` 的同名字段），
  也可用 `--expert-a/--expert-b/--expert-c/--moderator/--scribe` 显式覆盖。
- 专家与主持要求 `tier=top`，书记允许 `top|advanced`；书记与主持必须不同；
  模型需要存在、provider 已配置，`availability` 不能是 `blocked/unavailable`。
- 任一条件不满足都会给出明确错误，不会用示例结果冒充真实调用。
- 复用 `adapters/index.mjs` 与 `clampEffort`；提示词要求只读，且 provider 显式声明
  `capabilities.readonly_mode=false` 时拒绝执行（不静默地跑在会写盘的模式下）。

### CLI

```
agentline studio new      --repo <path> --id <id> --title <标题> --input "<用户输入>"
agentline studio run      --repo <path> --id <id>
agentline studio answer   --repo <path> --id <id> --question <Q-n> --text "..." | --default
agentline studio answer   --repo <path> --id <id> --decision <D-n> --text "..." | --default
agentline studio conclude --repo <path> --id <id>
agentline studio status   [--id <id>] [--json]
```

`--adapter-module <path>` 是新增的测试/扩展接缝：用它替换 `getAdapter`，模块默认导出
`(provider) => { run(...) }`。测试用它注入确定性的假 adapter，不依赖账号、网络或本机 CLI。

## 插件

### Host（`plugin/lib/index.js`）

- `GET /agentline/studio?project=P[&id=S]`：只读。列表来自 `lib/studio.mjs`，详情附带
  角色矩阵与实时求值的 G0；`readStudio` 的 `missing/empty/corrupt` 原样返回为
  `ok:false + state`，不与空列表混淆。
- `POST /agentline/studio`：body `{ project, action, id, ... }`，只允许
  `new|run|answer|conclude`，校验会话 ID、必填输入与 answer 二选一后，
  用**参数数组** spawn 一条 CLI；每次请求恰好一次调用，不经 shell 拼接。
- 读取路径不写任何文件；所有写操作仍在 CLI/核心内完成。

### UI（`plugin/lib/client.js`）

- **Studio 页**：左列真实会话列表（按项目重新读取）+ 新建表单；右侧展示角色、会话状态、
  下一步、问题（回答 / 采用默认）、决策（确认 / 采用默认）、三位专家确认、G0 逐项结果。
  操作按钮在存在 open blocking 问题时禁用，并用 tooltip 说明原因；操作失败显示原因、不自动重发；
  项目切换会清空上一个项目的会话状态。
- **设置页 → 模型目录**：固定 5 个渠道分组（Claude / Codex / CodeBuddy / Cursor / Gemini，
  有未知 provider 时追加"其他渠道"），每组可折叠、空组可见；列固定为
  模型 / 渠道 / id / 档位 / 身份 / 可用性 / 来源；支持渠道筛选与搜索；缺失值显示"未知"，
  `discovered` 不会被显示成 `callable`。
- **设置页 → 角色矩阵**：三阶段 11 行（Studio 5 / Blueprint 3 / Build 3），每行含
  主选、备选、档位要求、约束、probe。Studio 取真实 `studio.roles`；Blueprint 标注"只读"且
  不伪造配置；Build 映射现有 design/dev/review 路由（编辑仍在原「角色路由」小节）。
- 五 Tab、Inbox、项目组合、旧任务（停止 / 插话 / 回答 / 合并）保持不变；
  Blueprint 页仍明确显示"未实现"。

## 自测

与 `acceptance.md` 一一对应（在仓库根执行）：

```pwsh
& node --check plugin/lib/client.js
& node --check plugin/lib/index.js
& node --check orchestrator/agentline.mjs

& node --test orchestrator/test/studio-cli.test.mjs
& node --test orchestrator/test/studio-g0.test.mjs
& node --test plugin/test/studio-ui.test.mjs

Push-Location orchestrator; try { & npm test } finally { Pop-Location }
```

- `studio-cli`：真实 spawn CLI（临时仓库 + `--adapter-module` 假 adapter），覆盖
  new/status、重复 ID、非法路径、每次 run 仅一次调用、进程重启后从磁盘恢复、失败不推进、
  阻塞问题不能跳过、answer 与 default 分别记录、多问题全部处理、决策确认、三次独立专家确认、
  conclude 通过/证据缺失失败、轮次上限。
- `studio-g0`：先构造完整证据求值通过，再逐项破坏（纪要、决策非空、用户确认、任一专家确认、
  专家 reject、open blocking、轮次 >2、书记=主持、主持缺失、questions.json 损坏），
  以及通过后修改证据必须重新求值为失败。
- `studio-ui`：用最小 React 运行时真实执行 `client.js` 的 `apply` 与 `Cockpit` 渲染，
  驱动点击/输入；`POST /agentline/studio` 走真实插件路由并统计 fake CLI 调用次数。
  覆盖五渠道七列、折叠/筛选/搜索、11 行角色及未知值、真实/空/错误/项目切换状态、
  四项操作各一次调用、五 Tab/Inbox/项目组合/旧任务/未实现阶段。
- 全部测试只用系统临时目录；不读写仓库内 `.collab/studio`，不需要任何真实模型账号。

## 已知边界

- Blueprint / Build 新控制面不在本任务范围；Blueprint 页面仍为只读"未实现"。
- adapter 层没有统一的只读隔离能力，因此只对显式声明 `readonly_mode:false` 的 provider 拒绝执行，
  其余渠道依赖提示词约束；需要更强的隔离时应由 provider 能力字段扩展（P7/P8）。
- `--adapter-module` 仅作为可注入 adapter 的接缝，正常使用不需要。
