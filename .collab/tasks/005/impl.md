# Task 005 — 实现记录

## 变更清单

| 文件 | 变更 | 用途 |
|---|---|---|
| `orchestrator/lib/build.mjs` | 新增 | Build 控制面：来源重验、旧/新角色映射与角色锁、业务轮次和基础设施重试、T gate、只读任务/看板投影 |
| `orchestrator/lib/step.mjs` | 修改 | `runStep` 在调用模型前核对来源和角色；锁内每次物理调用写入 `step-ledger.jsonl`；身份不符或副作用未知时不推进。`runBuild` 在终止证明之前拒绝 `side_effects === 'unknown'` |
| `orchestrator/lib/exec.mjs` | 修改 | `executeRole` 增加 `observeIdentity`。Build 锁开启时只记录适配器返回的模型；未返回则记 `null` 和 `model_resolved_source: 'none'`。flow 不传该标志，仍用原来的回退 |
| `orchestrator/lib/pipeline.mjs` | 修改 | `readPipelineSummary` 附带 `build: readBuildBoard(repo)`。原有 `tasks` 与阶段计数字段不变 |
| `orchestrator/test/build-source.test.mjs` | 新增 | 有效批准、未批准、撤销、过期、节点变更、映射不一致、损坏来源和旧任务。拒绝时模型调用为 0，`state.json` 不出现 |
| `orchestrator/test/build-execution.test.mjs` | 新增 | 单步只跑 design；`runBuild` 到 `pr_open`；dev 失败停在 blocked；任务锁、终止未知、副作用未知都不重放 |
| `orchestrator/test/build-gate.test.mjs` | 新增 | CI 缺失、损坏、空、部分、明确失败、全部通过、过期；不可豁免的 `T.ci_all_pass` 不能被豁免；通过的 gate 文档仍能 `validateGate` |
| `orchestrator/test/build-roles.test.mjs` | 新增 | 旧 `design`/`dev`/`review` 与新 `designer`/`developer`/`verifier`；冲突和缺失不调用模型；锁内重试仍是同一模型；缺失身份和不匹配身份进入 run 记录和 `T.isolation` |
| `plugin/lib/index.js` | 修改 | `/agentline/task` 用 orchestrator 的 `readBuildTask` 附加 `build`。读失败时返回错误形状，不写 `.collab` |
| `plugin/lib/client.js` | 修改 | Build 页渲染来源、测试层级、状态、实际模型、业务轮次、基础设施重试和 T gate。空、错误、重试和项目切换分开，不再显示「未实现」示例 |
| `plugin/test/build-ui.test.mjs` | 新增 | 驱动真实 `/agentline/pipeline`、`/agentline/tasks`、`/agentline/task`。覆盖真实、旧任务、来源损坏、空、目录被文件占用、重试、项目切换，以及首页、Studio、Blueprint、设置和停止按钮 |

`orchestrator/agentline.mjs` 已有 `step` / `run` 入口，继续调用 `runStep` / `runBuild`，这次没有改。`flow.mjs` 没有改。

## 为什么这样接

K1 已经规定单步、完整运行、worktree、锁、容量和终止证明。Build 只在 `runStep` 前面加上来源和角色判断，失败时直接返回，不写 `state.json`，也不调用适配器。完整运行仍走原来的状态机，所以一次 `runBuild` 可以到 `pr_open`，dev 失败则停在 blocked。

来源以任务目录里的 `origin.json` 为准，再对当前 Blueprint 落盘重算。没有这个文件，或 `kind` 为 `legacy` / 有效 `adhoc`，沿旧路径。文件在但读不出、字段不齐或 Blueprint 会话损坏，原因是 `origin_corrupt`，不能当成旧任务。节点规范哈希用现有 `canonicalHash`。哈希不一致是 `E_APPROVAL_STALE` / `node`，映射不一致是 `mapping`，批准不在是 `unapproved`，`revoked_at` 已写是 `E_APPROVAL_REVOKED`，内容哈希或批准不再有效是 `expired`。这些分支都不调用模型。

新角色名或 `roles.lock.json` 才启用身份观察。锁外模型在进适配器前拒绝。适配器没返回模型记为未验证；返回的 id 和请求不一致记为不匹配。网络重试沿用 `executeRole` 的原模型重试，不会换成锁外候选。`model_resolved` 只来自这次调用，不再用请求 id 回填。

T gate 仍是 `agentline.gate/v1`。检查只有 `T.origin_valid`、`T.ci_all_pass`、`T.verdict_pass`、`T.isolation`，字段仍是 `id`、`desc`、`pass`、`waivable`、`evidence`。未知、失败和过期写在 `evidence`（`unknown:…`、`fail` / `fail:…`、`stale`、`pass`）。`T.ci_all_pass` 在文件缺失、损坏、空结果或计数对不上时为未知且 `pass: false`；结果里有明确 `passed: false` 才是失败。CI 的 `ranAt` 早于 HEAD、评审 `git_sha` 不是 HEAD 祖先，记为 `stale`。四项都不可豁免，豁免非通过项时 `evaluateGate` 报 `not waivable`。

业务轮次和基础设施重试用已有的 `counters.business_rounds` / `counters.infra_retries`。基础设施重试不增加业务轮次。每次物理调用在 ledger 里是 `event: 'call'`。投影缺计数时是未知；来源损坏是错误。插件只读 `/agentline/pipeline` 和 `/agentline/task`。

## 自测

本机是 bash。验收脚本里的 `node` / `npm test` 按同样顺序执行，退出码都是 0。没有桌面浏览器；Build 页用插件渲染桩点真实宿主路由，和 Blueprint 页同一套方式。

| 验收 | 结果 |
|---|---|
| AC-1 `node --check` `plugin/lib/client.js`、`plugin/lib/index.js`、`orchestrator/agentline.mjs` | 退出码 0，输出 `AC-1 OK` |
| AC-2 `node --test orchestrator/test/build-source.test.mjs` | 3 通过 |
| AC-3 `node --test orchestrator/test/build-execution.test.mjs` | 3 通过，含 `runBuild` 到 `pr_open`（真实 `ci-runner.ps1`） |
| AC-4 `node --test orchestrator/test/build-gate.test.mjs` | 4 通过 |
| AC-5 `node --test orchestrator/test/build-roles.test.mjs` | 3 通过 |
| AC-6 `node --test plugin/test/build-ui.test.mjs` | 3 通过 |
| AC-7 `cd orchestrator && npm test`，再 `node --test plugin/test/*.test.mjs` | orchestrator 177 通过；插件 20 通过 |

## 偏差与剩余

没有改验收要求以外的字段或章节。`plugin/locale/**` 未改，Build 文案和现有驾驶舱一样写在 `client.js`。完整运行到 `pr_open` 依赖 PATH 上的 `pwsh` 和 `orchestrator/tools/ci-runner.ps1`，这是原有 CI 入口。
