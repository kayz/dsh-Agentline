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
- `readStudio` 区分 `missing / empty / corrupt / ok`，CLI `status` 与插件 GET 都基于同一实现；
  `questions.json` / `decisions.json` 缺失或损坏时整体返回 `corrupt`（会话仍在，但界面必须显示错误，
  不能当成"没有会话"或"没有阻塞"）；确认文件无法解析或不是对象时同样算 `corrupt`，
  不能降级成"该专家未确认"而被当成正常读取。

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
- 业务轮次：回答一次问题给该问题记 1 轮（若问题关联到某个决策，同时给该决策记 1 轮）；
  达到 2 轮后拒绝再开文本讨论轮次（`E_ROUND_LIMIT`），但允许显式采用默认。轮次不因失败/重试自增。
  决策轮次用满 2/2 后 `run` 直接拒绝（`E_ROUNDS_EXHAUSTED`），不再调用任何角色；
  轮次缺失或不是整数同样无法证明还有额度，一并拒绝，G0 对应 check 也失败。
- 专家拒绝（`verdict=reject`）会写一条 `kind=expert_reject` 的阻塞问题，并给每个决策记 1 轮；
  同时**撤掉全部 `confirm_*` 步骤**并删除其他专家的确认文件（旧确认是对拒绝前证据的确认），
  纪要末尾追加「修订记录（第 N 轮）」写明拒绝原因；用户 `answer` 后，用户处理也追加到同一记录。
  确认提示词包含纪要、决策、以及全部问题与用户回答，所以三位专家是对**修订后的证据**重新独立确认。
  每次拒绝前都先检查 2 轮上限，因此拒绝最多把轮次记到 2，绝不写出第 3 轮；轮次用满后停下并呈现，
  不自动选默认。

### G0

`evaluateG0` 每次都从磁盘重新读取证据，拼内容哈希后交给
`lib/contracts/gate.mjs` 求值（`agentline.gate/v1`），输出 7 个 check：

```
G0.minutes_final         minutes-final.md 存在且非空
G0.decisions_nonempty    decisions.json 至少 1 条
G0.each_decision_confirmed  每条都有 confirmed_by_user（confirm/default）
G0.no_open_blocking     没有未处理的 blocking 问题（除 answered/default_adopted/resolved/closed 外都算未处理）
G0.decision_rounds_le_2 问题与决策 rounds_used 均 ≤ 2
G0.experts_confirmed    a/b/c 都有有效确认且无 reject
G0.scribe_ne_moderator  书记与主持模型均已知且不同
```

- 问题文件缺失、损坏或不是数组时 `G0.no_open_blocking` 直接失败（不能当作"没有阻塞"）；
  只有 `answered`/`default_adopted` **且带有效 user_action** 的问题才算关闭，其余一律按未处理。
- 证据文件"能解析但不是数组"同样算无效：`questions.json` 不是数组时按有阻塞处理，
  `decisions.json` 不是数组时 `decisions_nonempty` / `each_decision_confirmed` 直接失败。
- 用户动作必须完整：`confirmed_by_user` 需要合法的 `kind`（confirm/default）、非空 `text`
  和时间戳；只有类型、没有内容的记录不算确认。
- 专家确认必须可归因：记录里的 `expert` 必须等于角色本身（缺失也不算），`model` 必须等于
  该角色被分配的模型（角色没有分配模型时同样不算），且带 `verdict` 与 `at`。
  别的专家或别的模型代写的确认一律不算。
- 轮次证据必须显式：`rounds_used` 缺失、字符串、小数或负数都无法证明"≤ 2"，
  一律让 `G0.decision_rounds_le_2` 失败，不按 0 处理。
- 书记 ≠ 主持按**实际模型身份**判断（provider + model id），配置键只是别名：
  两个不同键指向同一模型 id 时，`new` 拒绝（`E_SCRIBE_IS_MODERATOR`），G0 也失败。
- `conclude` 通过才写 `status=concluded`；失败时若之前是 concluded，会改回
  `awaiting_user(blocking_reason=g0_failed)`，不保留过期通过状态。
- `conclude` 不写任何用户确认或专家确认。

### 角色配置与模型调用

- 角色模型来自 `config.studio.roles.<role>`（或项目 `.collab/agentline.json` 的同名字段），
  也可用 `--expert-a/--expert-b/--expert-c/--moderator/--scribe` 显式覆盖。
- 专家与主持要求 `tier=top`，书记允许 `top|advanced`；书记与主持必须是不同的实际模型
  （比较 provider + model id，配置键别名不能绕过）。
  模型需要存在、provider 已配置，`availability` 不能是 `blocked/unavailable`。
- 任一条件不满足都会给出明确错误，不会用示例结果冒充真实调用。
- 只读：Studio 每次调用都用"只读 provider 副本"，把能强制只读的 adapter 钉死在只读模式
  （`claude-cli` → `permission-mode=plan` + 仅 `Read`；`codebuddy-cli` → `plan`；
  `codex-cli` → `sandbox=read-only`）。只以 adapter 能钉死的参数为准：`capabilities.readonly_mode=true`
  只是意愿，不会跳过强制参数；声明 `false` 或 adapter 没有已知只读模式的渠道（Cursor、Gemini）
  一律拒绝，不静默执行。该判定只作用于 Studio，`flow.mjs` 与既有 adapter 行为不变。
- 书记纪要与机器 JSON 分离：`minutes-final.md` 只写正文，末尾的控制 JSON 不落进纪要；
  正文为空时整步失败（不能拿空的"纪要"去过 G0）。决策由书记一次产出，重跑时替换而非追加。

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
  `ok:false + state`，不与空列表混淆。`project` 必须是真实存在的目录，否则 400。
- `POST /agentline/studio`：body `{ project, action, id, ... }`，只允许
  `new|run|answer|conclude`，校验会话 ID、必填输入与 answer 二选一后，
  用**参数数组** spawn 一条 CLI；每次请求恰好一次调用，不经 shell 拼接。
- 读取路径不写任何文件；所有写操作仍在 CLI/核心内完成。

### UI（`plugin/lib/client.js`）

- **Studio 页**：左列真实会话列表（按项目重新读取）+ 新建表单；右侧展示角色、会话状态、
  下一步、问题（回答 / 采用默认）、决策（确认 / 采用默认）、三位专家确认、G0 逐项结果。
  操作按钮在存在 open blocking 问题时禁用，并用 tooltip 说明原因；操作失败显示原因、不自动重发；
  项目切换会清空上一个项目的会话状态。会话读取失败时错误信息附带 `missing/empty/corrupt` 状态，
  与"该项目没有会话"的空态区分开。
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
  conclude 通过/证据缺失失败、轮次上限、专家拒绝后必须重新独立确认、无法保证只读的渠道拒绝建会话。
- `studio-g0`：先构造完整证据求值通过，再逐项破坏（纪要、决策非空、用户确认、任一专家确认、
  专家 reject、open blocking、轮次 >2、书记=主持、主持缺失、questions.json 损坏），
  以及通过后修改证据必须重新求值为失败；另覆盖"别人代写/别的模型写的确认不算"、
  "确认记录缺内容或时间不算"、"questions.json 不是数组不能证明无阻塞"。
- `studio-ui`：用最小 React 运行时真实执行 `client.js` 的 `apply` 与 `Cockpit` 渲染，
  驱动点击/输入；`POST /agentline/studio` 走真实插件路由并统计 fake CLI 调用次数。
  覆盖五渠道七列、折叠/筛选/搜索、11 行角色及未知值、真实/空/错误/项目切换状态、
  四项操作各一次调用、五 Tab/Inbox/项目组合/旧任务/未实现阶段。
- 全部测试只用系统临时目录；不读写仓库内 `.collab/studio`，不需要任何真实模型账号。

本次修订所处的执行环境禁用了 shell（Bash/PowerShell 均无审批可用），因此**未能在本机重跑**
上述命令；改动按 `node --check` 的语法约束与逐条断言的语义做了静态核对。CI 会跑
`acceptance.md` 里的 5 条命令，若有失败按输出定位。

## 本轮修订（针对 review 的 5 条 findings）

| finding | 原因 | 修正 |
|---|---|---|
| P1 只读未被保证 | 只检查 `readonly_mode === false`，而现有 4 个 provider 都没声明该字段，Codex 还是 `sandbox=workspace-write`，等于默认放行可写渠道 | 新增 `readonlyProvider` / `assertReadonlyProvider`：能强制只读的 adapter 钉死只读参数，其余必须显式声明 `true`，`false` 或无声明一律 `E_READONLY_UNAVAILABLE` |
| P1 G0 证据不严 | `decisions.json` / `questions.json` 解析成功但不是数组时被当成空；`confirmed_by_user` 只看 `kind`；专家确认不绑定角色模型 | 无效结构单独标记 `questionsInvalid/decisionsInvalid` 并让对应 check 失败；用户动作要求 `kind + 非空 text + at`；确认要求 `expert`、`model` 与角色分配一致 |
| P1 确认/轮次不可恢复 | 专家拒绝后无法重新确认，拒绝不计轮次，`run` 会继续往下走 | 拒绝写阻塞问题 + 决策记 1 轮 + 撤回该确认步骤；轮次超限则停在 `awaiting_user(round_limit)` |
| P2 空/损坏会话与错误混淆 | 插件不校验 project，UI 错误文案没有状态信息 | 路由校验 project 必须是真实目录；详情错误附带 `missing/empty/corrupt` 中文状态，仍与空列表空态区分 |
| P2 纪要与机器 JSON 混写 | `minutes-final.md` 整段写入模型输出（含控制 JSON），G0 只判非空；书记重跑会追加旧决策 | 新增 `splitModelOutput` 只落正文，正文为空则整步失败；决策改为替换写入 |

## 第二轮修订（针对 review-r1 的 5 条 findings）

| finding | 原因 | 修正 |
|---|---|---|
| P1 缺失/无效证据仍可通过 G0 | `readStudio` 只在文件存在时判无效，缺失的 `questions.json` 变成空数组；关闭判定只看 `status` 字段 | 缺失也算无效并整体返回 `state=corrupt`；新增 `questionClosed`，`answered`/`default_adopted` 必须有 kind 匹配、内容非空、带时间戳的 `user_action` 才算关闭。CLI `run` 遇到关联证据无效直接报错，`conclude` 对应 check 失败 |
| P1 拒绝后的答复不参与重新确认 | 确认提示词只有决策和纪要；其他专家的旧确认仍然有效；纪要不记录修订 | 拒绝时撤掉全部 `confirm_*` 步骤、删除其他专家的确认文件，并在纪要追加「修订记录」；用户回答写入同一条记录；`confirmPrompt` 增加完整的问题与用户回答；轮次耗尽后 `run` 报 `E_ROUNDS_EXHAUSTED` |
| P1 能力声明可绕过强制只读 | `readonly_mode=true` 时跳过强制参数，Codex 仍按 `workspace-write` 运行 | `readonlyProvider` 只认 adapter 的强制只读参数：有映射就一律覆盖 provider.options，没有映射或声明 `false` 就返回 null，`new` 直接失败 |
| P2 损坏的关联证据仍返回成功 | 只追加 errors，`state` 仍是 ok | 关联证据无效 → `state=corrupt`，插件 GET 返回 `ok:false + state`，UI 显示可重试错误；列表仍能看到该会话及 `state=corrupt` |
| P2 不完整的专家确认可通过 | 只在字段存在时校验归属，角色模型缺失时跳过校验 | 要求 `expert === role` 且角色已分配模型且 `model` 与之相等，否则计为缺失 |

关于决策：拒绝不会改写决策正文（决策是用户逐条确认过的内容），所以用户的确认保持有效；
专家重新确认的对象是「修订后的纪要 + 决策 + 问题与用户答复」。若书记重跑（重新产出决策），
决策按新内容整体替换，`confirmed_by_user` 归零，用户必须重新逐条确认——这是
`normalizeDecisions(parsed, [])` 的既有行为，不是本轮新增。

新增/加强的测试（全部断言落盘内容或真实调用，不看源码字符串）：

- `studio-cli`：假 adapter 记录 provider 参数、prompt 和调用序列。新增
  「只读由 adapter 强制」——`readonly_mode=true` + `workspace-write` 必须被改成 `read-only`、
  claude 的 `acceptEdits` 必须被改成 `plan/Read`、声明 `false` 必须拒绝建会话；
  「缺失 questions.json」必须 `status=corrupt`、`run`/`conclude` 均失败；
  拒绝用例改为断言三位专家全部重新确认、旧确认文件被删除、纪要与确认提示词包含拒绝原因和用户答复。
- `studio-g0`：新增缺失 `questions.json`、缺失 `decisions.json`、
  「answered/default_adopted 但 user_action 缺失或无效」、确认记录缺 `expert`、
  角色未分配模型五类反例。
- `studio-ui`：新增真实 host 路由用例——`questions.json` 损坏或缺失时详情返回
  `ok:false + state=corrupt`（列表仍可读），与空态区分。

## 第三轮修订（针对 review-r2 的 4 条 findings）

| finding | 原因 | 修正 |
|---|---|---|
| P1 可以进入第三轮 | `run` 只在轮次 `> 2` 时阻止；已有 2 轮仍调用专家，拒绝后才把轮次加到 3 | 新增启动前硬停：任一决策 `rounds_used >= 2`（或无效）时直接 `E_ROUNDS_EXHAUSTED`，不发起任何角色调用；拒绝只可能把 1 记到 2，永不写第 3 轮；`statusAfterStep` 把“用满 2/2”标成 `awaiting_user(round_limit)`，UI 同时禁用 run 并说明原因 |
| P1 G0 把损坏的轮次当合格 | `Number(d.rounds_used || 0)` 把缺失当 0、把字符串变 NaN，而 `NaN > 2` 为 false | 新增 `roundCount` / `roundsProblem`：必须是显式的非负整数且 ≤ 2，缺失、字符串、小数、负数一律让 `G0.decision_rounds_le_2` 失败（问题与决策都检查）；`answer` 遇到无效轮次只允许 `--default` 收尾 |
| P1 别名可绕过“书记≠主持” | 比较的是配置键，两个键指向同一 provider/id 仍被当作不同模型 | `resolveRoles` 与 G0 共用 `modelRef` / `sameModelRef`：按实际 `provider + id` 判断，配置键相同也算同一模型；`new` 直接拒绝（`E_SCRIBE_IS_MODERATOR`），G0 evidence 显示 `provider:id` |
| P2 损坏的确认文件仍返回 ok | 无法解析的确认文件只追加 `errors`，`state` 仍由 questions/decisions 决定 | `readStudio` 增加 `confirmationsInvalid`：确认文件不可解析或不是对象时整体 `state=corrupt`，插件 GET 返回 `ok:false + state=corrupt`（列表仍可见该会话及 corrupt 状态），不再混同为“该专家未确认” |

本轮新增/加强的测试（仍只断言真实行为或落盘内容）：

- `studio-cli`：「两轮是硬上限」——真实跑完两轮专家拒绝、用户回答后，第三次 `run` 必须非零退出且**不产生新调用**，`decisions.json` 的 `rounds_used` 保持 `[2,2]`，`conclude` 失败；
  「书记/主持同模型别名」——两个配置键指向同一 model id 时 `new` 失败且不留目录。
- `studio-g0`：`rounds_used` 为 `null`/字符串/小数/负数/缺失时均失败并标记 `:invalid`（问题记录同样检查）；
  书记与主持使用同一 model id 的两个别名时失败；损坏的确认文件让 `readStudio` 返回 `corrupt` 且 G0 失败。
- `studio-ui`（host 路由）：确认文件损坏时详情返回 `ok:false + state=corrupt` 并带 `confirmations/...` 错误，列表仍展示 corrupt。

本轮执行环境同样禁用了 shell（Bash / PowerShell 均无审批可用），**未能本机重跑** `acceptance.md` 的五条命令；
改动按逐条断言与语法约束做了静态核对，CI 会执行验收命令。

## 已知边界

- Blueprint / Build 新控制面不在本任务范围；Blueprint 页面仍为只读"未实现"。
- 只读是"按 adapter 能力强制 + 显式声明"：`gemini-cli` 当前没有可钉死的只读开关，若把它配成
  Studio 角色会明确报错，需要先在 provider 配置里声明或补 adapter 能力（P7/P8）。
- `--adapter-module` 仅作为可注入 adapter 的接缝，正常使用不需要。
