# Task 005 — 实现记录

## 变更清单

| 文件 | 变更 | 用途 |
|---|---|---|
| `orchestrator/lib/build.mjs` | 新增 | Build 控制面：来源重验、旧/新角色映射与角色锁、业务轮次和基础设施重试、T gate、只读任务/看板投影 |
| `orchestrator/lib/step.mjs` | 修改 | `runStep` 在调用模型前核对来源和角色；锁内每次物理调用写入 `step-ledger.jsonl`；身份不符或副作用未知时不推进。状态已是 `side_effects === 'unknown'` 时，`runStep` / `runBuild` 直接拒绝，不再进入下一步 |
| `orchestrator/lib/exec.mjs` | 修改 | `executeRole` 增加 `observeIdentity`。Build 锁开启时只记录适配器返回的模型；未返回则记 `null` 和 `model_resolved_source: 'none'`。flow 不传该标志，仍用原来的回退。返回 `side_effects === 'unknown'` 时立刻写入状态，并停止同一步里的网络重试和候选切换 |
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

新角色名或 `roles.lock.json` 才启用身份观察。锁外模型在进适配器前拒绝。适配器没返回模型记为未验证；返回的 id 和请求不一致记为不匹配。没有未知副作用时，网络重试仍沿用 `executeRole` 的原模型重试，不会换成锁外候选。`model_resolved` 只来自这次调用，不再用请求 id 回填。

T gate 仍是 `agentline.gate/v1`。检查只有 `T.origin_valid`、`T.ci_all_pass`、`T.verdict_pass`、`T.isolation`，字段仍是 `id`、`desc`、`pass`、`waivable`、`evidence`。未知、失败和过期写在 `evidence`（`unknown:…`、`fail` / `fail:…`、`stale`、`pass`）。`T.ci_all_pass` 在文件缺失、损坏、空结果、计数对不上、结果盖不住 `acceptance.md` 里的可执行条目、缺少 `ranAt` 或读不出 HEAD 时间时为未知且 `pass: false`。可以通过的每一条还必须有 `exitCode === 0`，并且 `lastLine` 正好是 `<AC-id> OK`；`output` 若存在，其最后一个非空行也必须是这一句。`passed: true` 但退出码或末行对不上、缺这些字段，都是未知，不能当成通过。结果里有明确 `passed: false` 才是失败。CI 的 `ranAt` 早于 HEAD 记为 `stale`。评审 `git_sha` 必须就是当前 HEAD：只是祖先、或者已经不在当前历史上，都记为 `stale`。四项都不可豁免，豁免非通过项时 `evaluateGate` 报 `not waivable`。

业务轮次和基础设施重试用已有的 `counters.business_rounds` / `counters.infra_retries`。基础设施重试不增加业务轮次。每次物理调用在 ledger 里是 `event: 'call'`。隔离检查看每一次物理调用：失败或基础设施重试若没有可验证的实际身份，证据是 `unknown:identity`，不能因为同任务里还有成功调用就通过。`step-ledger.jsonl` 里有任何读不出的非空行时，整份账本视为损坏，隔离同样是 `unknown:identity`，不再丢掉坏行后用剩下的调用放行，也不回退到 `run.json`。投影缺计数时是未知；来源损坏是错误。节点变更、批准撤销或过期仍投影为 Blueprint，不落到旧任务。插件只读 `/agentline/pipeline` 和 `/agentline/task`。

## 自测

本机是 bash。验收脚本里的 `node` / `npm test` 按同样顺序执行，退出码都是 0。没有桌面浏览器；Build 页用插件渲染桩点真实宿主路由，和 Blueprint 页同一套方式。

| 验收 | 结果 |
|---|---|
| AC-1 `node --check` `plugin/lib/client.js`、`plugin/lib/index.js`、`orchestrator/agentline.mjs` | 退出码 0，输出 `AC-1 OK` |
| AC-2 `node --test orchestrator/test/build-source.test.mjs` | 3 通过 |
| AC-3 `node --test orchestrator/test/build-execution.test.mjs` | 4 通过，含 `runBuild` 到 `pr_open`（真实 `ci-runner.ps1`），以及未知副作用不在同一步重试或换候选 |
| AC-4 `node --test orchestrator/test/build-gate.test.mjs` | 4 通过。自洽但缺验收项、没有 `ranAt`、读不出 HEAD 时间都是未知且不通过 |
| AC-5 `node --test orchestrator/test/build-roles.test.mjs` | 4 通过。失败和基础设施重试缺少实际身份时隔离不通过 |
| AC-6 `node --test plugin/test/build-ui.test.mjs` | 3 通过。节点变更、撤销和过期显示 Blueprint，不显示旧任务 |
| AC-7 `cd orchestrator && npm test`，再 `node --test plugin/test/*.test.mjs` | orchestrator 179 通过；插件 20 通过 |

## 修订

评审指出四处缺口，这次只补这些行为：

- 适配器返回 `side_effects === 'unknown'` 时，`executeRole` 先把标记写入 `state.json`，再结束本次候选。网络错误不会原模型重试，其他错误也不会换候选。下一步入口看到这个标记就拒绝，不再调用模型。
- `T.ci_all_pass` 用 `acceptance.md` 里可执行的条目标题核对 `ci-results.json`。只留下一部分并把 `passed` / `total` 改成与结果条数一致，仍是未知。可以通过的报告还必须有可解析的 `ranAt`，并且能读到 HEAD 的提交时间；缺任何一项都不能当成通过。明确的 `passed: false` 仍是失败。
- `T.isolation` 检查 ledger 里每一次物理调用。失败或基础设施重试没有 `model_resolved` 时记 `unknown:identity`，不能被同一次任务里已成功的开发或评审调用带过。
- 节点哈希变了、批准被撤销或内容过期时，`readBuildTask` 的 `source` 固定为 `blueprint`。只有本来就没有 Blueprint 来源、或 `kind` 为旧任务 / 有效 adhoc 的，才投影成旧任务。损坏来源仍是错误。

## 再修订

评审又指出三处证据缺口，这次只补这些判定：

- `T.ci_all_pass` 不再只看 `passed`。每一条要能证明命令通过：`exitCode` 必须是 0，`lastLine` 必须是该条的 `AC-n OK`。报告里若带了 `output`，最后一个非空行也必须是这一句。`passed: true` 但退出码是 1，或末行对不上，证据是 `unknown:undetermined`，不通过。
- `T.verdict_pass` 要求 `git_sha` 解析后等于当前 HEAD。评审之后又有提交时，旧 SHA 仍是祖先，但已经不是这次要合并的代码，记为 `stale`。解析不了仍是未知。
- `step-ledger.jsonl` 出现损坏行时，隔离检查直接是 `unknown:identity`。不再静默丢掉该行，也不在账本损坏时改读 `run.json`。

这一轮自测：`node --check` 三个入口通过；`node --test` 覆盖 `build-gate` 与 `build-roles` 共 8 项通过；`cd orchestrator && npm test` 为 179 通过；`node --test plugin/test/*.test.mjs` 为 20 通过。

## 新鲜度绑到产品代码

评审指出：正常跑到 `pr_open` 之后，T gate 会把本次评审标成过期，CI 也可能过期。原因是 CI 在 review 之前执行，review 和 PR 随后各自 `commitAll`。这两次提交只写入 `.collab` 里的评审产物和状态。旧判定拿最新 HEAD 的时间比 `ranAt`，并要求 `git_sha` 等于最新 HEAD，所以审计提交一落地，证据就变成 `stale`。

现在两处都只看产品代码，`.collab/**` 不算在内：

- `T.ci_all_pass` 的时间比较对象是最近一次改动产品文件的提交。读不出这份提交、缺少 `ranAt`，或产品提交比 `ranAt` 晚超过 1 秒，仍是未知或 `stale`。只追加 `.collab` 不会把一份本来新鲜的报告标过期。
- `T.verdict_pass` 在 `git_sha` 就是 HEAD 时通过。它是 HEAD 的祖先时，再用 `git ls-tree` 比较两边排除 `.collab` 之后的产品快照；快照相同则通过，产品文件变了则 `stale`。不是祖先（例如 amend 掉的旧提交）仍是 `stale`。解析不了仍是 `unknown:git_sha`。

`build-execution.test.mjs` 在 `runBuild` 到达 `pr_open` 后求值 T gate，四项证据分别为 `legacy`、`pass`、`pass`、`pass`，总结果通过。`build-gate.test.mjs` 另加一条：只提交 `.collab` 时 CI 和评审保持通过；再提交产品文件 `later.txt` 后两项都是 `stale`。

这一轮自测：`node --check` 三个入口后输出 `AC-1 OK`；`node --test` 四份 Build 测试 16 项通过；`cd orchestrator && npm test` 为 180 通过；`node --test plugin/test/*.test.mjs` 为 20 通过。

## 偏差与剩余

没有改验收要求以外的字段或章节。`plugin/locale/**` 未改，Build 文案和现有驾驶舱一样写在 `client.js`。完整运行到 `pr_open` 依赖 PATH 上的 `pwsh` 和 `orchestrator/tools/ci-runner.ps1`，这是原有 CI 入口。

## 来源损坏与验收命令

评审指出两处会把无效证据放行，这次只补这两处。

- 有 `origin.json` 时，先看 schema 和 Blueprint 来源字段，再决定能不能执行。`{"kind":"legacy"}`，以及带了 `agentline.origin/v1` 但 `kind` 仍是 `legacy` 的文件，都是 `origin_corrupt`。`runStep` 和 `runBuild` 都不调用模型，也不写 `state.json`。没有这个文件的旧任务仍走原路径。有效的 `kind: adhoc` 且写了 `reason` 的临时任务也不变。投影里这种损坏来源是错误「来源损坏」，不会显示成旧任务。
- `T.ci_all_pass` 在条目 ID、退出码和末行都对得上之后，还要核对验收命令正文。命令来自 `acceptance.md` 里的代码块或「命令:」行，顺序和正文都要一致。文件已经进 git 时，当前命令必须等于 `ranAt` 之前最后一版已提交的命令；工作区改过但还没提交，或者后来提交了另一版命令，证据都是 `stale`，不通过。验收文件还没进 git 时，仍按条目核对，避免把现有的未提交报告误判成过期。只追加 `.collab` 里的审计文件、不改命令，产品提交时间的比较方式不变。

这一轮自测：

| 验收 | 结果 |
|---|---|
| AC-1 `node --check` 三个入口 | 退出码 0，输出 `AC-1 OK` |
| AC-2 `node --test orchestrator/test/build-source.test.mjs` | 4 通过。物化任务的来源被写成 `{"kind":"legacy"}` 后，单步和 `runBuild` 都是 `origin_corrupt`，模型调用为 0 |
| AC-3 `node --test orchestrator/test/build-execution.test.mjs` | 4 通过，`runBuild` 到 `pr_open` 后四项 T gate 仍通过 |
| AC-4 `node --test orchestrator/test/build-gate.test.mjs` | 6 通过。保留 AC id、改掉命令并提交后，旧报告是 `stale` 且总 gate 不通过；只提交 `.collab` 审计的报告仍通过 |
| AC-5 `node --test orchestrator/test/build-roles.test.mjs` | 含在下面的 orchestrator 全量里，通过 |
| AC-6 `node --test plugin/test/build-ui.test.mjs` | 4 通过。`kind: legacy` 的损坏来源显示错误；命令改提交后 T.ci_all_pass 显示过期 |
| AC-7 `cd orchestrator && npm test`，再 `node --test plugin/test/*.test.mjs` | orchestrator 182 通过；插件 21 通过 |
