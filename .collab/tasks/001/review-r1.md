# Task 001 — 验证报告

## 结论

**needs_revision，通过 9/12。** AC-6 的失败状态处理不符合设计；AC-9、AC-12 各缺一段必需命令的 CI 执行证据，无法确认完整通过。

被评审工作区 HEAD（verdict 的 git_sha）：`3116a59dc8c2695abc4ada546be08f6e5b74beb3`。只读读取 `.git:1` → `C:/git/dsh-Agentline/.git/worktrees/001/HEAD:1` → `C:/git/dsh-Agentline/.git/refs/heads/task/001:1`，并通过读取对象库、解压和校验对象 SHA1 确认；未执行 git 命令。本结论针对当前工作区文件，实际评审内容的 SHA256 为：

- `plugin/lib/client.js`：`a93d2e350f426221193f567bf2e169d67f36bf3ab4463e886e59099225f934ea`
- `plugin/lib/index.js`：`6599e9e9b190d3b69e44902ccaab25f119ec44d3f4df50fae996711124091157`
- `.collab/tasks/001/ci-results.json`：`7ae22dc53c3af0cb0d5d1ec7dc73c5c4b7ec6edac3efe99af423c1122dda3e1f`

只读对象比较表明：index.js 与 HEAD 的文本一致（换行符归一化后）；client.js 相对 HEAD 在 626–627 行另有首页运行摘要文案差异，以上文件哈希界定实际评审对象。当前 client.js 修改时间为 `2026-11-06T08:42:24.628Z`，早于本轮 CI 的 `2026-11-06T17:11:54.5093477+08:00`。

采用编排方 ci-results.json 的执行证据，不重跑验收。CI 自报 12/12；下表结合每项的完整证据要求和只读代码核对作独立判断。当前首页“现在卡在哪”的 live 加载、失败及成功为空分支已在 client.js:622–638 区分；首次 projects 失败造成的依赖页面无限加载仍然存在。

## 逐条 AC 结果

表中 CI 行号相对于本目录 ci-results.json，产品路径相对于仓库根；所有已记录命令的 exitCode 均为 0。

| AC | 结果 | 退出码 | 原始输出位置 / 说明 |
|---|---|---|---|
| AC-1 | 通过 | 0 | CI:10–16，无输出；client.js 语法检查通过。 |
| AC-2 | 通过 | 0 | CI:19–25，无输出；index.js 语法检查通过。 |
| AC-3 | 通过 | 0 | CI:28–34，`OK tabs+home`；client.js:61–74 页签横向滚动、窄屏单栏，108–119 五页签与命令，455–570 数据端点和持久化，617–667 首页区块，981–988 页签分派。 |
| AC-4 | 通过 | 0 | CI:37–43，`OK legacy ops`；client.js:318–385 保留合并、控制和继续运行的端点与请求体，801–974 保留任务列表、阶段、K1 ledger、回答、执行记录和日志；855–864 保留合并二次确认及仅低档 grant。272–316、483–596 核对项目访问代次、任务代次、请求序号、日志模式、定位及轮询清理。只读基准对象比较确认 SettingsPage/SettingsSection、SafeBoundary、focusTask、HeaderChips 和 apply 的对应代码段未改。 |
| AC-5 | 通过 | 0 | CI:46–52，`OK no mock data`；client.js:670–705 只投影真实会话、模型目录及 Provider，919–928 仅在有真实字段时显示模型、明确 T gate 未实现；未由评审或合并状态推导 gate。 |
| AC-6 | 不通过 | 0（静态） | CI:55–61，`OK empty states` 证明指定文字存在；client.js:252–257、455–460、519–520、558–580、672、748 的首次项目读取失败路径仍违背 design.md:279，详见问题清单第 1 条。 |
| AC-7 | 通过 | 0 | CI:64–70，`OK settings+slash`；client.js:110–117、662–666 支持的命令仅复制，未实现命令无执行按钮；745–798 路由和矩阵迁入设置，689–705 目录与 Provider 共用错误状态、按 Provider 并集排序和原始 availability 计数。依赖项目的加载问题归入 AC-6。 |
| AC-8 | 通过 | 0 | CI:73–79，`OK host routes 14`；index.js:550–852 旧十二条路由、855–874 新两条路由；857、868 拒绝非 GET，872–873 使用原始发现缓存构建目录，只返回目录与 discovery 概况。只读读取基准 `9efb19992f3d68f760082f0cda600c5e6d6b1ee9` 的对象并比较：移除新增路由块及注释中的 pipeline,catalog 后，index.js 与基准除空白外一致。 |
| AC-9 | 无法确认完整通过 | 0（第二段） | CI:82–88 只有 `OK data projection+navigation`，采信第二段的空/有会话/失败、Provider 投影及跨项目导航证据；缺 acceptance.md:80–83 首段要求的 `OK render 5 tabs` 及该段退出码。静态核对能确认分派代码存在，无法补足规定的执行证据。 |
| AC-10 | 通过 | 0 | CI:91–97，`OK host routes runtime`；对应 acceptance.md 隔离目录中的真实 Host 路由断言，覆盖空/有会话、模型目录、四种写方法 405、旧 projects 路由和请求前后目录内容不变。index.js:855–874 与证据一致。 |
| AC-11 | 通过 | 0 | CI:100–106，输出汇总 `# tests 71`、`# pass 71`、`# fail 0`、`# skipped 0`。 |
| AC-12 | 无法确认完整通过 | 0（第一段） | CI:109–115 只有 `OK write scope`，采信相对指定基准的范围检查；design.md:1–5 的 write_scope 仍仅两个产品文件。缺 acceptance.md:327–334 第二段要求的 `OK no untracked files` 及该段退出码；范围 diff 无法证明不存在未跟踪文件。 |

## 问题清单

1. **P2 — AC-6：首次项目读取失败后，依赖页面持续显示加载中，页签重入和现有轮询不能恢复。** 初始 project、routing、pipeline 均为 null（client.js:252–257）。首次 `/agentline/projects` 网络失败、非 JSON 或 ok:false 时，455–460 仅设置 projects 错误并返回；loadPipeline（519–520）和 loadRouting（422–423）因无项目提前返回。Studio/Blueprint 的 672 行及设置项目路由的 748 行仍显示“读取中…”，没有传播依赖数据源的失败状态。558–564 只在挂载时读取一次 projects；572–580 的轮询依赖已选项目，568–570 的设置页重入仍无法在无项目时重试路由。因此等待轮询或重新进入这些页面不能恢复，手动刷新才能重新请求 projects。design.md:279 明确禁止失败伪装为无限加载，并要求下一次轮询或重新进入页面可恢复。请在依赖区块显示项目读取失败，并提供符合该要求的重试路径；不要把尚未确定的项目显示成空会话。此结论来自只读控制流核对，未声称完成浏览器复现。

2. **P2 — AC-9：缺少五页渲染与默认首页检查的 CI 执行证据。** acceptance.md:75–85 要求首段五页渲染检查与随后快照交互检查都执行。本轮 CI:82–88 的完整 output 仅为 `OK data projection+navigation`，未记录首段退出码或 `OK render 5 tabs`。请编排方补执行原首段并留存退出码及输出，同时保留第二段证据；不要修改验收断言。该项暂记无法确认完整通过，未断言首段运行失败。

3. **P2 — AC-12：缺少未跟踪文件检查的 CI 执行证据。** acceptance.md:327–334 明确要求第二段检查，本轮 CI:109–115 的完整 output 仅为 `OK write scope`。第一段检查已跟踪改动范围，不能代替第二段。请编排方补执行原第二段并留存退出码及 `OK no untracked files`；review 按授权不执行 git。该项暂记无法确认完整通过，未断言存在未跟踪产品文件。

brief 未指定另行追加的验收报告路径。本轮只创建 review-r1.md、verdict-r1.json，保留 review.md、verdict.json 历史内容；未修改产品、规格、实现说明、state/run 或其他文件。仓库不存在 scripts/check-fast.ps1。未执行 DSH 人工观察；acceptance.md 将其列为非自动判定项，未因此扣分，也未将只读核对表述为真实浏览器操作验证。

---

## 结论

2026-11-06 本轮追加：**needs_revision，通过 12/14。** 按当前 acceptance.md 的 AC-1 至 AC-14 逐条计数。AC-6 不符合失败状态要求；AC-12 缺少第一段范围检查的有效执行证据。历史小节保留，上述历史 9/12 不代表本轮结果。

验证的 git_sha：`fede8c4c2a6d5de2a62401488871dd3a15549501`。只读读取 `.git:1` → `C:/git/dsh-Agentline/.git/worktrees/001/HEAD:1` → `C:/git/dsh-Agentline/.git/refs/heads/task/001:1`，解压该提交的 loose object 并计算 SHA1，输出 `HEAD fede8c4c2a6d5de2a62401488871dd3a15549501 object SHA1 fede8c4c2a6d5de2a62401488871dd3a15549501`。只读遍历提交 tree，读取对应 blob，与工作区统一 CRLF/LF 后比较，输出 `plugin/lib/client.js equals HEAD normalized: true`、`plugin/lib/index.js equals HEAD normalized: true`。未执行 git 命令。

实际评审文件 SHA256：

- client.js：`a93d2e350f426221193f567bf2e169d67f36bf3ab4463e886e59099225f934ea`
- index.js：`6599e9e9b190d3b69e44902ccaab25f119ec44d3f4df50fae996711124091157`
- ci-results.json：`ab975441135bb5cb85f4f231fb13da4aea15329e4031c1cff7d6eaf1795e34a3`

执行证据采用编排方 ci-results.json:4 的 `2026-11-06T17:54:55.3525677+08:00` 运行记录；未重跑验收，未因 review 环境限制扣分。CI 自报 14/14，独立结论如下。brief 未指定其他验收报告路径。

## 逐条 AC 结果

CI 行号均指本目录 ci-results.json；产品文件行号相对仓库根。以下已记录命令的退出码均为 0。

| AC | 结果 | 证据与独立核对 |
|---|---|---|
| AC-1 | 通过 | CI:10–16，exitCode=0、output 为空，符合 client.js 语法检查要求。 |
| AC-2 | 通过 | CI:19–25，exitCode=0、output 为空，符合 index.js 语法检查要求。 |
| AC-3 | 通过 | CI:28–34，`OK tabs+home`；client.js:61–74 页签横向滚动及窄屏样式，108–119 页签/命令常量，455–570 数据端点与页签持久化，617–667 首页区块，981–988 五页分派。 |
| AC-4 | 通过 | CI:37–43，`OK legacy ops`；client.js:318–385 合并/控制/继续运行端点与请求体，801–974 列表、详情、阶段、ledger、回答、执行记录和日志；855–864 二次确认及仅低档 grant。272–316、483–596 的访问/任务代次、请求序号、模式检查和卸载清理隔离旧响应；1001 起保留 focusTask/HeaderChips 入口。 |
| AC-5 | 通过 | CI:46–52，`OK no mock data`；client.js:670–705 从真实会话与目录投影数据，919–928 只在有真实字段时展示模型、G1/T gate 明示未实现，没有推导 gate 通过。 |
| AC-6 | 不通过 | CI:55–61，`OK empty states` 仅证明文字存在。client.js:455–460 首次 projects 失败后，519–520/422–423 因无项目不请求 pipeline/routing，672/748 持续加载；558–580 没有 projects 自动恢复路径。违反 design.md:279，详见问题清单。首页 live 的加载/失败/成功为空分支在 622–638 已正确区分。 |
| AC-7 | 通过 | CI:64–70，`OK settings+slash`；client.js:662–666 支持命令仅复制、未实现项无执行按钮；745–798 设置页路由和矩阵，689–705 只读目录与 Provider 并集/计数，二者共享加载/错误分支。项目依赖错误归入 AC-6。 |
| AC-8 | 通过 | CI:73–79，`OK host routes 14`；index.js:550–852 旧路由、855–874 新路由；857/868 非 GET 返回 405，872–873 使用原始发现缓存构建归一化目录，只返回 catalog/discovery；新路由不写文件。 |
| AC-9 | 通过 | CI:91–97，`OK data projection+navigation`，覆盖空/有会话/读取失败、目录/Provider、项目切换和跨项目回答导航；首段五页渲染及默认首页与 AC-13 的命令相同，CI:82–88 的 exitCode=0、`OK render 5 tabs` 补足该段证据。client.js:307–312、589–596、670–705、981–988 与投影/导航断言一致。 |
| AC-10 | 通过 | CI:100–106，`OK host routes runtime`；acceptance.md 原断言覆盖隔离目录空/已有会话、目录、四种写方法 405、旧 projects 及目录快照不变。index.js:855–874 与执行证据一致。 |
| AC-11 | 通过 | CI:109–115，exitCode=0，输出 `# tests 71`、`# pass 71`、`# fail 0`、`# skipped 0`。 |
| AC-12 | 无法确认完整通过 | CI:118–124，output 只有 `OK no untracked files`，可以确认第二段；但 acceptance.md:323–334 第一段还要求相对指定基准的路径检查并输出 `OK write scope`，当前 CI 没有该输出或独立退出码。design.md:1–5 的 write_scope 仍仅两个产品文件。详见问题清单。 |
| AC-13 | 通过 | CI:82–88，exitCode=0、`OK render 5 tabs`；client.js:254 默认 home 并校验存储页签，981–988 分派五页，符合首段要求。 |
| AC-14 | 通过 | CI:127–133，exitCode=0、`OK no untracked files`，符合未跟踪文件检查；不等价于 AC-12 第一段范围 diff 检查。 |

## 问题清单

1. **P2 — AC-6：首次项目读取失败后，依赖页面持续显示加载中且无法通过轮询或重入恢复。** client.js:252–257 初值 project/routing/pipeline 为 null，455–460 在 `/agentline/projects` 失败时只设置 projects 错误并返回；422–423、519–520 因无项目直接退出。Studio/Blueprint 在 672 行、设置项目路由在 748 行没有传播 projects 错误，持续显示“读取中…”。558–564 仅挂载时读取 projects，572–580 的轮询依赖已有项目，568–570 设置重入也不重试 projects。因此首次网络失败、非 JSON 或 ok:false 后，依赖页无法依 design.md:279 在下一轮询或重入时恢复。手动刷新可以重试，但不能满足该设计要求。请传播依赖数据源的错误并提供规定的恢复路径。该问题经只读控制流确认，未声称浏览器复现。

2. **P2 — AC-12：相对基准的写入范围检查缺少执行证据。** acceptance.md:323–334 要求第一段执行 `git diff --name-only 9efb19992f3d68f760082f0cda600c5e6d6b1ee9` 并校验路径集合，输出 `OK write scope`。本轮 CI:118–124 与 127–133 都只有 `OK no untracked files`，不足以确认第一段通过。ci-runner.ps1:45 在进入下一 AC 标题时用最后一个 fenceBody 覆盖 Command，54 行在第二代码块开始时重置 fenceBody，解释了同一 AC 多段命令丢失的风险。请编排方补执行 acceptance.md 第一段原命令并记录退出码及完整输出，保留现有未跟踪检查证据；review 按用户要求不执行 git，不修改断言。未据此断言存在越界产品改动。acceptance.md 第一段 expected 列表包含 `.gitignore`，本报告沿用原断言，不自行更改规格。

历史 AC-9 缺首段渲染、AC-12 缺第二段未跟踪检查的问题已由当前 CI 补足；本轮 AC-12 缺的是第一段范围检查。仅追加本文件并更新 verdict-r1.json；未修改历史小节、review.md/verdict.json、产品、规格、实现说明或 state/run。人工观察按 acceptance.md 约定不计自动判定；本轮未执行 DSH UI 抽查，也未以只读审查替代真实浏览器观察。

## 结论

本轮（CI ranAt：2026-11-06T18:16:02.7132839+08:00）结论：**needs_revision，通过 13/14**。全部 14 条 CI 命令退出码均为 0；独立审查发现 AC-6 对应的错误恢复仍有缺陷，不能仅凭静态文案检查判通过。此前首次 projects 失败不传播错误的问题已有修正，AC-9/AC-12 的执行证据本轮也已齐全。

验证的 git SHA：`92fedaa20d13378e89f72f829acedb32cffff8f5`。只读 .git:1 → C:/git/dsh-Agentline/.git/worktrees/001/HEAD:1 → C:/git/dsh-Agentline/.git/refs/heads/task/001:1，解压 loose commit 并校验 SHA1；没有执行 git 命令。index.js 与该 commit 的 blob 换行归一化后相同；client.js 工作区与 commit 不同，差异区间为原 460–805 行 / 当前 460–818 行。因此本结论针对工作区，不能声称该 SHA 单独包含全部被评审实现。实际文件 SHA256：

- client.js：`527f086a104769aee75880ca0aaac7b08fc3b5d8c8790eec6db7f1656fc9892a`
- index.js：`6599e9e9b190d3b69e44902ccaab25f119ec44d3f4df50fae996711124091157`
- ci-results.json：`42d4f8f844c507034d99f2502a36732ae9ac5e312f4464e45cf79ed26a1ffc6e`

执行类证据全部直接采用编排方 CI；未重跑验收、未执行 git、未创建测试或临时脚本。补充验证只在内存中执行原 loadProjects 函数以核对错误恢复控制流。brief 未另指定验收报告路径。仅追加 review-r1.md、更新 verdict-r1.json，历史小节保留。

## 逐条 AC 结果

CI 行号均指本目录 ci-results.json；产品行号指 plugin/lib 下对应文件。

| AC | 结论 | 证据 |
|---|---|---|
| AC-1 | 通过 | CI:10–16，exitCode=0，无语法错误输出。 |
| AC-2 | 通过 | CI:19–25，exitCode=0，无语法错误输出。 |
| AC-3 | 通过 | CI:28–34，OK tabs+home；client.js:254、565–609、630–679、994–1001，核对持久化、首页真实数据、五页分派；Tab 样式含 overflow-x:auto。 |
| AC-4 | 通过 | CI:37–43，OK legacy ops；client.js:272–385、510–529、585–609、845–987，核对项目/任务/日志请求隔离、卸载保护、阶段轨迹、继续运行、合并二次确认、低档预授权、分档、ledger、控制/回答、执行记录和日志。 |
| AC-5 | 通过 | CI:46–52，OK no mock data；client.js:683–717、932–941，会话、目录、模型由响应字段投影，模型字段全部缺失时省略，未从评审或合并推断 gate。 |
| AC-6 | 不通过 | CI:55–61 虽输出 OK empty states，但只检查文案；client.js:460–473、490–491、575、581–583、761 的恢复路径与 design.md:279 矛盾，见问题清单。 |
| AC-7 | 通过 | CI:64–70，OK settings+slash；client.js:675–679、702–717、758–810，路由/矩阵迁入，命令只复制、未实现入口无执行按钮，Provider 并集与真实 availability 计数共用目录错误状态。恢复缺陷统一计入 AC-6。 |
| AC-8 | 通过 | CI:73–79，OK host routes 14；index.js:855–874，新路由只转发只读模块，857、868 拒绝非 GET；872–873 使用原始 cache 构造目录，仅返回归一化目录和发现概况。 |
| AC-9 | 通过 | CI:82–88 的 OK render 5 tabs 补足首段；91–97 的 OK data projection+navigation 覆盖第二段；client.js:307–312、602–609、683–717 与跨项目定位、空/已有会话/失败投影相符。 |
| AC-10 | 通过 | CI:100–106，OK host routes runtime；原断言覆盖空/已有会话、发现目录、四种写方法 405、旧 projects 及夹具目录请求前后一致；index.js:855–874 与之相符。 |
| AC-11 | 通过 | CI:109–115，exitCode=0；输出 # tests 71、# pass 71、# fail 0、# skipped 0。 |
| AC-12 | 通过 | CI:118–124，exitCode=0、OK write scope，已补足指定基准的范围检查；沿用 acceptance.md:323–334 的原 expected（含 .gitignore），不自行改规格。 |
| AC-13 | 通过 | CI:82–88，exitCode=0、OK render 5 tabs；client.js:254 默认 home，994–1001 分派五页。 |
| AC-14 | 通过 | CI:127–133，exitCode=0、OK no untracked files。 |

## 问题清单

1. **P2 — AC-6：项目列表短暂失败后，设置页的角色路由在项目列表恢复时转为无限加载。** 在已有项目 A、设置 Tab 保持打开时，10 秒 projects 轮询（client.js:575）失败会在 460–468 行设置错误，并清空 routing/draft。下一次轮询成功在 471–473 行清除错误，但 490–491 行保留当前项目 A，不触发项目变化。角色路由只在进入设置或 project 改变时读取（581–583 行），没有路由轮询。结果 routing 仍为 null、sourceErrors.routing 已为空，761 行持续显示“读取中…”，保存按钮禁用。类似地，单独 routing 请求失败的错误也会被成功的 projects 轮询清除，未伴随路由重试。违反 design.md:279 对失败不得伪装成无限加载、区块错误隔离和恢复的要求。

   独立内存验证执行当前文件原 loadProjects 函数，依次注入失败与项目 A 的成功响应，输出：
   `after projects failure {"routing":null,"draft":{},"errors":{"projects":"temporary registry outage","pipeline":"项目读取失败：temporary registry outage","routing":"项目读取失败：temporary registry outage"}}`
   `after recovery same project {"routing":null,"draft":{},"errors":{"projects":"","pipeline":"","routing":""},"projectsReady":true}`
   断言 routing===null、errors.routing==='' 均成立；project 没变，故 [tab,project] effect 不重跑。此为原函数的内存控制流验证，未声称 DSH 浏览器复现。请将项目注册列表错误与独立的路由读取状态隔离；恢复后应实际重新读取路由，或保留准确失败状态并提供设计要求的恢复路径，不能只清错误。重新进入设置或手动刷新可绕过当前问题，不消除自动轮询把失败伪装成无限加载的缺陷。

DSH 人工布局/交互观察未执行，按 acceptance.md“人工观察（不作为自动判定）”不计失败。仓库无 scripts/check-fast.ps1。

