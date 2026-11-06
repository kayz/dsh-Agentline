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
  决策轮次恰好为 2 时，下一步若仍要开启讨论（专家/主持/书记）则 `run` 直接拒绝
  （`E_ROUNDS_EXHAUSTED`）；本轮的确认步骤不产生新一轮，仍然可以执行。
  决策轮次已经大于 2，或轮次缺失/不是整数时，讨论和确认都不再调用任何角色。
  G0 的 `decision_rounds_le_2` 同样把缺失、非整数和大于 2 判为失败。
- 专家拒绝（`verdict=reject`）会写一条 `kind=expert_reject` 的阻塞问题，并给每个有效决策的
  `rounds_used` 加 1，不再封顶。决策还不到 2 时，新问题的 `rounds_used` 为 0 且不关联决策，
  用户可以回答这一轮；回答后三位专家重新独立确认，确认本身不加轮次。
  决策已经是 2 时，这次拒绝写成第 3 轮（例如 `[2,2]` → `[3,3]`），问题 `rounds_used` 记为该轮次
  并关联到决策。文本回答被拒绝（`E_ROUNDS_EXHAUSTED`），不能再进入下一轮确认。
  同时**撤掉全部 `confirm_*` 步骤**并删除其他专家的确认文件（旧确认是对拒绝前证据的确认），
  纪要末尾追加「修订记录（第 N 轮）」写明拒绝原因；用户 `answer` 后，用户处理也追加到同一记录。
  确认提示词包含纪要、决策、以及全部问题与用户回答，所以三位专家是对**修订后的证据**重新独立确认。
  轮次用满后若仍有阻塞问题就停在 `awaiting_user` 并呈现，不自动选默认。

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
  资格与 `model-catalog.mjs` 的 `isRoleEligible` 一致：`availability` 必须是 `callable`，
  `identity` 必须是 `verified`。`discovered` / `unknown` / `unverified`，以及 callable 但身份未验证
  （或缺省身份）都会在 `new` 和后续角色调用时明确失败，不用下一个不可用候选冒充，也不用示例结果替代。
  同一角色的候选列表里，不合格的会被跳过，后面合格的仍可选用。provider 必须已配置，且能强制只读。
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

## 第四轮修订（针对 review-r3 的 1 条 P1 finding）

| finding | 原因 | 修正 |
|---|---|---|
| P1 第二轮问题解决后无法完成专家确认 | 轮次硬停写成"任一决策 `rounds_used >= 2` 就禁止一切角色调用"。第二轮拒绝后用户回答已解除阻塞，但拒绝把三位专家的确认全部作废，会话停在 `confirm_a` 却再也调不动；而 G0 又要求三位专家各自有效确认，于是会话必然无法完成 | 把上限精确限定到"讨论轮次"：新增 `isConfirmStep` / `startsDiscussionRound`，`run` 只在下一步仍会开启讨论（专家 A/B/C、主持、书记）且轮次耗尽时抛 `E_ROUNDS_EXHAUSTED`；确认步骤是对已落盘证据的独立表态，不产生新一轮，因此继续允许。`statusAfterStep` 同步只在"还有讨论步骤"时标 `awaiting_user(round_limit)`，讨论已结束、只剩确认时保持 `running` |

配套收紧：既然确认步骤在轮次用满后仍可调用，拒绝就不能再把轮次加 1（否则会写出第 3 轮）。
`studio.mjs` 的拒绝分支改为 `Math.min(rounds_used + 1, 2)`，且 `rounds_used` 本身无效时保持原值
（不用新值掩盖坏证据，交给 G0 判失败）。于是：

- 轮次用满后的拒绝仍然落盘为阻塞证据（确认文件 `verdict=reject` + 一条 `kind=expert_reject` 的阻塞问题），
  `run` 必须先回答该问题（`E_AWAITING_USER`），永不进入第三轮讨论；
- 问题回答后重新确认不增加业务轮次，`decisions.json` 始终保持 `[2,2]`。

测试（只断言真实调用序列与落盘内容）：

- 改写 `studio-cli.test.mjs` 的"两轮是硬上限"用例：第二轮问题回答后 `run` 必须能继续到 `confirm_a`
  （修复前这里会失败）；随后让 `confirm_b` 在轮次用满后再拒绝，断言 `rounds_used` 仍为 `[2,2]`、
  会话进入 `awaiting_user(expert_reject)`、未回答前不能再调用任何角色、`conclude` 失败。
- 新增"第二轮拒绝回答后仍可重新确认并通过 G0"用例：走完两轮拒绝 → 逐条回答 → 三位专家各自独立
  重新确认（调用序列 `confirm_a`/`confirm_b`/`confirm_c`，各一次）→ 状态 `ready` → `conclude` 输出
  `G0 PASS`，且 `decisions.json` 的轮次没有被确认动作抬高。这条正是 review 指出的死锁路径。

本轮同样处于禁用 shell 的执行环境（Bash / PowerShell 都无审批可用），**未能本机重跑**五条验收命令；
改动按 `node --check` 的语法约束与逐条断言做了静态核对。

## 第五轮修订（CI AC-2 / AC-5：`blocking_reason` 被问题计数盖住）

| finding | 原因 | 修正 |
|---|---|---|
| `studio cli: two rounds are the hard cap...` 断言 `blocking_reason === 'expert_reject'`，实际是 `1 个阻塞问题待回答` | 拒绝一定会写一条 `kind=expert_reject` 的 open 问题。`statusAfterStep` 先看 `openBlocking`，于是 `extra.reject` 分支永远走不到 | 专家拒绝优先：`extra.reject` 时状态仍是 `awaiting_user`，原因记为 `expert_reject`。open 问题还在，`run` 仍被 `E_AWAITING_USER` 拦住，轮次保持 `[2,2]`，不开启第三轮讨论 |

行为没有放宽：未回答前不能再调用角色，`conclude` 仍然失败。只是把已经发生的拒绝写进会话原因，而不是用问题条数代替。

自测（仓库根）：

- `node --check`：`plugin/lib/client.js`、`plugin/lib/index.js`、`orchestrator/agentline.mjs`、`orchestrator/lib/studio.mjs` 均通过。
- `node --test --test-name-pattern "two rounds are the hard cap" orchestrator/test/studio-cli.test.mjs`：1 通过。
- `cd orchestrator && npm test`：108 通过，0 失败（含 studio-cli 与 studio-g0）。
- `node --test plugin/test/studio-ui.test.mjs`：10 通过。空闲机器上 `settle` 只让出 10 个 `setTimeout(0)` 时，CLI 子进程还没写日志，`new / run / answer / conclude` 会读到 0 次调用；现改为等到进行中的 fetch 结束再断言。行为断言未改。

## 第六轮修订（针对 review 的 2 条 P1）

| finding | 原因 | 修正 |
|---|---|---|
| P1 轮次耗尽后仍能回答并继续确认 | 专家拒绝用 `Math.min(used + 1, 2)` 封顶；新建问题 `rounds_used` 为 0 且不关联决策，所以文本回答看不出决策已经用满。回答后确认步骤仍可跑，拒绝和回答可以反复发生，G0 却一直看到 2 | 拒绝改为如实 `used + 1`。决策已是 2 时写成 3，问题记同样的轮次并关联到决策。文本回答在决策轮次 `> 2` 时直接 `E_ROUNDS_EXHAUSTED`。`run` 在轮次 `> 2` 或轮次无效时不再调用任何角色，包括确认。恰好为 2 时仍只允许完成本轮确认 |
| P1 未验证或不可调用的模型能当 Studio 角色 | `resolveRoles` 只排除 `blocked` / `unavailable`，`discovered`、`unknown`、`unverified` 和未验证身份都能过 | `new` 与角色调用都走 `isRoleEligible`：必须 `callable` 且 `identity=verified`，专家/主持档位为 top，书记为 advanced 或 top。不合格给出目录里的原因（`unavailable:*` / `identity_unverified` / `tier:*`），不创建会话 |

自测（仓库根，均退出码 0）：

- `node --check`：`plugin/lib/client.js`、`plugin/lib/index.js`、`orchestrator/agentline.mjs`、`orchestrator/lib/studio.mjs`。
- `node --test orchestrator/test/studio-cli.test.mjs orchestrator/test/studio-g0.test.mjs`：36 通过，0 失败。其中「两轮是硬上限」在第三次拒绝后断言 `rounds_used` 为 `[3,3]`、问题关联 `D-1`、文本回答被拒绝且不再产生调用、`conclude` 失败在 `G0.decision_rounds_le_2`；第二轮回答后的重新确认仍可通过 G0。新增「discovered / unknown / unverified / 缺身份不能建会话，合格后备候选仍可用」。
- `node --test plugin/test/studio-ui.test.mjs`：10 通过，0 失败。
- `cd orchestrator && npm test`：109 通过，0 失败。

## 第七轮修订（针对 review 的 1 条 P1）

| finding | 原因 | 修正 |
|---|---|---|
| P1 决策或纪要改文案后，G0 仍接受旧确认 | 专家确认只记角色、结论、模型和时间；用户确认只记动作类型、文本和时间。`evaluateG0` 把**当前**整包文件哈希同时当作 gate 的 subject 和 currentHash，没有和确认当时的内容比较 | 用户确认写入 `confirmed_by_user.content_hash`，绑定该条决策的编号、标题、说明、默认值。专家确认写入 `content_hash`，绑定当时的纪要正文和全部决策的这四项。G0 重新计算这两份哈希：对不上、或记录里没有哈希，`G0.each_decision_confirmed` / `G0.experts_confirmed` 失败，证据标 `stale`。`conclude` 不改写这两类确认。只改纪要时，决策正文没变，用户确认仍然有效，但专家确认失效，整体不通过 |

轮次、状态和确认记录本身不进哈希。否则专家拒绝后累加轮次，或用户在专家确认之后补上决策确认，会把仍然指向同一份正文的确认全部判成过期。

自测（仓库根，均退出码 0）：

- `node --check`：`plugin/lib/client.js`、`plugin/lib/index.js`、`orchestrator/agentline.mjs`、`orchestrator/lib/studio.mjs`。
- `node --test orchestrator/test/studio-g0.test.mjs`：24 通过，0 失败。纪要改成另一段非空正文后 `conclude` 失败且专家确认为 `stale`，用户确认仍对应未改的决策；只改决策标题和说明后，用户确认与专家确认都是 `stale`；去掉 `content_hash` 后即使正文没动也不能通过。确认文件和 `decisions.json` 在失败的 `conclude` 前后字节不变，已通过的会话被改回 `awaiting_user`。
- `node --test orchestrator/test/studio-cli.test.mjs`：14 通过，0 失败。真实 CLI 跑到 `G0 PASS` 后，确认记录上的哈希等于当时落盘的纪要和决策；改纪要或改决策说明后再 `conclude` 为 `G0 FAIL`，且不改写确认文件。
- `node --test plugin/test/studio-ui.test.mjs`：10 通过，0 失败。
- `cd orchestrator && npm test`：111 通过，0 失败。

## 已知边界

- Blueprint / Build 新控制面不在本任务范围；Blueprint 页面仍为只读"未实现"。
- 只读是"按 adapter 能力强制 + 显式声明"：`gemini-cli` 当前没有可钉死的只读开关，若把它配成
  Studio 角色会明确报错，需要先在 provider 配置里声明或补 adapter 能力（P7/P8）。
- `--adapter-module` 仅作为可注入 adapter 的接缝，正常使用不需要。
