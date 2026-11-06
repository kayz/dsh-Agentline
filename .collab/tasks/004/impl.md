# Task 004 — 实现记录

## 变更清单

| 文件 | 变更 | 用途 |
|---|---|---|
| `orchestrator/lib/blueprint.mjs` | 新增，并按设计收紧 G1 与物化回滚 | Blueprint 控制面：会话落盘、单步 `design → testability → review`、G1、内容哈希、批准与物化；身份和回复只从本次 stdout 解析。三角色模型按规范身份单独比较，同一模型换渠道不能通过 |
| `orchestrator/lib/adapters/reply.mjs` | 新增 | 从 Claude、CodeBuddy、Codex、Gemini、Cursor 的 stdout 取出回复正文和实际模型 |
| `orchestrator/lib/adapters/*.mjs` | 修改 | `run()` 返回解析后的 `text`、`stdout` 和 `modelResolved`；Gemini 不再把请求模型写进 `modelResolved` |
| `orchestrator/test/adapter-reply.test.mjs` | 新增 | 各 CLI 协议的正例，以及缺模型、多模型、Gemini 回显都不算已验证身份 |
| `orchestrator/agentline.mjs` | 修改 | `blueprint new\|run\|review\|approve\|materialize\|status` |
| `orchestrator/test/blueprint-cli.test.mjs` | 新增 | 六个命令、单步顺序、失败不推进、冲突、物化保真、批准失效后重新批准；夹具 stdout 走真实解析器。回显的 `modelResolved` 不能推进，只有 stdout 里的回复和模型可以。同一模型换渠道时 `new` 失败，不创建会话，也不能批准或物化 |
| `orchestrator/test/blueprint-g1.test.mjs` | 新增，并补反例 | G1 逐项正反例；来源豁免不能通过；无标题和空任务图不能通过；损坏的 blocker/finding 不能通过；当前轮未完成不能批准；测试架构变更后必须重新评审；数字 `text` 与 `null` 层级不能通过。驱动步骤的夹具同样只提供 CLI stdout。跨渠道同模型、通道前缀或大小写、共享 `canonical_id`、缺省 identity group 都不能通过，也不能批准或物化 |
| `plugin/lib/index.js` | 修改 | `/agentline/blueprint`：GET 读落盘，POST 每次只转发一条 CLI |
| `plugin/lib/client.js` | 修改 | Blueprint 页：真实轮次、角色、findings、任务图、G1、批准与物化；空、损坏和操作失败分开 |
| `plugin/test/blueprint-ui.test.mjs` | 新增 | 真实路由上的空、真实、错误、项目切换、单次 CLI 和原有五个页 |
| `plugin/test/studio-ui.test.mjs` | 修改 | Blueprint 页改为断言空状态「还没有 Blueprint 会话」 |

Studio、Build 和既有任务流没有改写。插件不自己写 `.collab/**`。

## 这次收紧的原因

G1 每次从落盘重新求值。两处会让无效证据被当成可批准：

- 来源 G0 被标成可豁免。`waivers.json` 里只要哈希对得上，失效、缺失或与 `from.gate_hash` 不一致的来源仍能让检查通过，从而批准和物化。设计要求保留来源 G0，不能伪造证据；来源失效必须使批准失效。现在 `G1.studio_link` 不可豁免，豁免文件只接受仍标记为可豁免的测试架构跨厂商偏好。内容哈希加入 `source/from.json` 和当前 G0 哈希，来源绑定一变，旧批准就对不上。
- 重读 `task-graph.json` 时不检查任务 `title`，也不拒绝空的 `tasks` / `acceptance`。空数组的覆盖和矩阵比较会空过；摘要刷新后，无标题或空图仍可能被批准，物化 brief 的标题会变成空。现在缺标题只让 `G1.task_fields_complete` 失败；空任务和空验收让 schema、字段、双向覆盖失败；没有 AC 行的矩阵记为 `matrix:empty`。物化在写任务前再次拒绝空图和缺标题。

## 上一轮收紧的原因

审查指出两类无效结果仍能继续往下走。

- G1 重读 `testability.json` / `review-vN.verdict.json` 时，只看 blocker 的 status，也不检查 finding 的 id、text 是否为非空白字符串。把已完成的 blocker 改成 `{"status":"resolved"}` 后，输入摘要不变，`G1.testability_clear` 仍通过，重新批准后可以物化。现在重读走和写入相同的 `normalizeBlockers` / `normalizeFindings`：缺 id、缺 text、空白、类型不对、severity/status 非法，或 finding 编号重复，都记为 `blocker:invalid` 或 `findings:invalid`，对应检查失败，不能批准，也不能物化。字段完整的 resolved blocker，以及仍开放的 blocker，行为不变。
- 物化先写 `materialized.json` 再保存 session。session 保存失败时，catch 只删掉已移动的任务目录，记录文件还在，后面的读取会指向不存在的任务。现在同一段 catch 会删掉这次写出的 `materialized.json`（以及写入失败留下的临时文件），并删掉已移动的任务和暂存目录。session 本身仍是写入前的内容。失败之后可以再次 materialize，不会跳号，也不会重复创建。CLI 不增加参数；测试通过 `beforeSessionSave` 在记录落盘之后、session 写入之前抛错，专门走这条回滚。

## 这一轮收紧的原因

审查指出两类过期证据仍能批准和物化。

- 新一轮只做完 design 时，G1 仍看磁盘上最新一份评审和 `testability.json`。若新设计和上一轮相同，上一轮摘要还对得上；外部条件（例如角色锁里的厂商）恢复后，`checks_pass` 会变成真，批准就能跳过本轮 testability 和 review。现在评审文件和 `testability.json` 的 `round` 必须等于 `state.round.current`，而且当前轮的 `rN.design`、`rN.testability`、`rN.review` 都要有成功调用。对不上时 `G1.review_pass` 和 `G1.testability_clear` 失败，不能批准，也不能物化。本轮三步走完之后，仍然可以批准。
- 评审提示读了 `testability.json`，但 `input_digests` 只有设计、任务图、策略/矩阵和来源 G0。把一份完整的 open blocker 改成 resolved 后，内容哈希会让旧批准失效，G1 却仍承认旧评审。现在评审摘要增加 `testability_digest`，覆盖当时落盘的 `testability.json`。只改 blocker 会使 `G1.review_pass` 记为 `stale_evidence:testability_digest`。重新跑完一轮 review、让新评审盖住新的测试架构结果之后，才能再批准和物化。

## 落盘验收类型

G1 重读 `task-graph.json` 时，验收 `text` 用 `String(...)` 判断，`levels` 只要求非空数组。生成入口却要求 `text` 是去空白后的非空字符串，`levels` 是非空字符串数组。design 之后把某条 AC 改成 `text: 123`、`levels: [null]`，testability 仍会把 `null` 收成字符串 `"null"` 写进矩阵，评审再记下当前摘要。评审可以通过，schema 不拒绝，批准和物化会把数字写进 brief 的验收正文。

现在写入和重读共用 `acceptanceRecord`：类型不对就记入 `G1.graph_schema`，矩阵记为 `matrix:acceptance-type`，不能批准，也不能物化。矩阵渲染不再把 `null` 或数字收成层级名。物化在写 brief 之前再查一次，正文只拼非空字符串。字段完整的字符串验收行为不变。

## 自测结果（上一轮）

下面是接上真实 CLI 协议之前的数字。本轮结果见文末。当时在仓库根用 Node 跑了与 `acceptance.md` 相同的检查（本环境是 bash，不是 pwsh）。界面没有桌面浏览器，AC-4 / AC-5 的插件测试用同一套渲染桩驱动真实 `/agentline/blueprint` 路由。

| AC | 结果 | 输出 / 退出码 |
|---|---|---|
| AC-1 | 通过 | `node --check` 三个文件后输出 `AC-1 OK`，退出码 0 |
| AC-2 | 通过 | `blueprint-cli.test.mjs` 7 通过 / 0 失败，退出码 0 |
| AC-3 | 通过 | `blueprint-g1.test.mjs` 29 通过 / 0 失败（含 28 个子例），退出码 0 |
| AC-4 | 通过 | `blueprint-ui.test.mjs` 7 通过 / 0 失败，退出码 0 |
| AC-5 | 通过 | `orchestrator` 的 `npm test` 147 通过 / 0 失败；`plugin/test/*.test.mjs` 17 通过 / 0 失败；退出码 0 |

## 与设计的偏离

无

## 遗留问题

无

## 真实 CLI 回复和身份

上一轮评审指出两处：真实 adapter 的返回值没有模型回复，Blueprint 读 `text` / `stdout` 得到空字符串，设计步骤无法完成；Gemini 把请求参数 `model` 写进 `modelResolved`，缺少调用结果里的身份也能被当成已验证。

现在六个 adapter 都从自己的 stdout 协议取出回复和模型，放进返回值的 `text`、`modelResolved` 和原始 `stdout`：

- Claude：`result.result`；身份只取唯一的 `modelUsage` 键，多个键不算通过。
- CodeBuddy：`result.result` 和结果事件上的 `model`。
- Codex：`agent_message` 的正文。公开事件没有模型字段时身份为空；只有 `thread.started` / `turn.started` / `turn.completed` 自己带了 `model` 才采纳。
- Gemini：`response` 正文；身份只取 `stats.models` 里唯一的键。请求参数不再写入 `modelResolved`。顶层 `model` 字段也不算。
- Cursor 与 Cursor WSL：`result.result`（否则是 assistant 文本）；身份只取事件里唯一的 `model`。

Blueprint 的 `callRole` 不再采用 adapter 对象上的 `modelResolved`。它按 provider 的 adapter id 重新解析 `stdout`。解析不到回复或唯一模型时，这一步记失败且不推进。缺失身份不能批准，也不能物化。

控制面测试夹具改为写出上述协议的 stdout，再交给同一套解析函数。`BLUEPRINT_NO_IDENTITY` 会把请求模型回填到 `modelResolved`，但 stdout 里没有模型字段，步骤不推进。`BLUEPRINT_STDOUT_ONLY` 不返回 `text`，只返回协议 stdout，设计正文和 `claude-des` 身份仍能落盘。

## 自测（本轮）

在仓库根用 Node 跑了与 `acceptance.md` 相同的检查（本环境是 bash，不是 pwsh）。界面没有桌面浏览器，插件测试用同一套渲染桩驱动真实 `/agentline/blueprint` 路由。

| AC | 结果 | 输出 / 退出码 |
|---|---|---|
| AC-1 | 通过 | `node --check` 三个文件后语法检查通过，退出码 0 |
| AC-2 | 通过 | `blueprint-cli.test.mjs` 8 通过 / 0 失败，退出码 0 |
| AC-3 | 通过 | `blueprint-g1.test.mjs` 29 通过 / 0 失败（含 28 个子例），退出码 0 |
| AC-4 | 通过 | `blueprint-ui.test.mjs` 含在插件测试中，7 通过 / 0 失败 |
| AC-5 | 通过 | `orchestrator` 的 `npm test` 157 通过 / 0 失败；`plugin/test/*.test.mjs` 17 通过 / 0 失败；退出码 0 |

协议解析另有 `orchestrator/test/adapter-reply.test.mjs` 9 通过，已包含在 orchestrator 的 157 里。

## 模型规范身份

审查指出：同一模型走不同供应渠道时，默认 `identity_group` 是 `vendor/model.id`，预检用 `provider:model.id` 比较，G1 重算用 `vendor:id`。identity group 不同或缺省时，两个角色会被当成不同模型；各自的调用又能对上锁定的同一个 ID，于是模型隔离通过，批准和物化也能继续。

现在每个角色的模型身份单独取规范 ID：配置里的 `canonical_id`，否则是 `id`；去掉通道前缀并统一大小写，不把厂商或渠道算进去。规范 ID 或 `id` 有交集，或者 `identity_group` 缺失、重复，`G1.roles_pairwise` 失败。`new` 在写会话前用同一条规则拒绝。身份核对仍要求这次调用的 `model_resolved` 等于该角色锁定的 `id`，所以调用对得上也不能把同一个模型算成两个。厂商检查不变：设计与评审仍必须跨厂商，测试架构跨厂商仍是可豁免偏好。

因此这几种都不能批准，也不能物化：同一 `id` 但 identity group 和厂商都不同；`openai/CLAUDE-DES` 与 `claude-des`；通道 ID 不同但 `canonical_id` 相同；identity group 被删掉。

## 自测（模型规范身份）

在仓库根用 Node 跑了与 `acceptance.md` 相同的检查（本环境是 bash，不是 pwsh）。界面没有桌面浏览器，插件测试用同一套渲染桩驱动真实 `/agentline/blueprint` 路由。

| AC | 结果 | 输出 / 退出码 |
|---|---|---|
| AC-1 | 通过 | `node --check` 三个文件后语法检查通过，退出码 0 |
| AC-2 | 通过 | `blueprint-cli.test.mjs` 9 通过 / 0 失败，退出码 0 |
| AC-3 | 通过 | `blueprint-g1.test.mjs` 34 通过 / 0 失败（含 32 个子例），退出码 0 |
| AC-4 | 通过 | `blueprint-ui.test.mjs` 含在插件测试中，7 通过 / 0 失败 |
| AC-5 | 通过 | `orchestrator` 的 `npm test` 163 通过 / 0 失败；`plugin/test/*.test.mjs` 17 通过 / 0 失败；退出码 0 |
