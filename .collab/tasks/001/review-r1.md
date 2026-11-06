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
