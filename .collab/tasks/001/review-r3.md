# Task 001 — 验证报告

## 结论

needs_revision；独立评审通过 **12/14**。AC-6 不通过，AC-12 缺少第一段命令的执行证据，无法确认完整通过。其余验收项通过。采用编排方 `ci-results.json:4` 所记录的 `2026-11-06T18:07:56.6682517+08:00` 执行证据；未重跑验收命令，也未因评审环境限制扣分。

验证的 git SHA：`a1bc9f3b4ee645b7549fcb97c918e6b3ab3b82fd`。只读 `.git:1`、`C:/git/dsh-Agentline/.git/worktrees/001/HEAD:1`、`C:/git/dsh-Agentline/.git/refs/heads/task/001:1` 取得该值；解压 loose commit object 并计算 SHA1 一致，沿 tree 读取两个产品 blob，统一 CRLF/LF 后与工作区内容一致。未执行 git 命令。

本轮只读计算的 SHA256：

- `plugin/lib/client.js`：`a93d2e350f426221193f567bf2e169d67f36bf3ab4463e886e59099225f934ea`
- `plugin/lib/index.js`：`6599e9e9b190d3b69e44902ccaab25f119ec44d3f4df50fae996711124091157`
- `.collab/tasks/001/ci-results.json`：`daf34370898b487232d7d499273d68fd1e1ffc6aec5475d0620a8020bb7122b5`

本轮重新读取规格、代码及 CI，独立确认以下问题仍存在。brief 未指定额外验收报告路径；仅创建 `review-r3.md`、`verdict-r3.json`，保留历史评审文件。DSH 人工观察未执行，依 acceptance.md:359 不计入自动判定失败。仓库不存在 `scripts/check-fast.ps1`。

## 逐条 AC 结果

以下 CI 行号指 `.collab/tasks/001/ci-results.json`，客户端与 Host 文件位于 `plugin/lib/`。每项均采用 CI 的退出码与输出，并按所列源码位置核对实际实现。

| AC | 结果 | 退出码 | 原始输出位置 / 说明 |
|---|---|---|---|
| AC-1 | 通过 | 0 | CI:10–16，output 为空，符合 client.js 语法检查期望。 |
| AC-2 | 通过 | 0 | CI:19–25，output 为空，符合 index.js 语法检查期望。 |
| AC-3 | 通过 | 0 | CI:28–34，`OK tabs+home`；client.js:61–74 页签滚动与响应布局、108–119 常量、519–550 数据读取、566 持久化、617–667 首页、981–988 五页分派与规格一致。 |
| AC-4 | 通过 | 0 | CI:37–43，`OK legacy ops`；client.js:318–385 保留合并/控制/继续运行端点及请求体，801–974 保留列表、阶段、ledger、回答、执行记录与日志，855–864 保留二次确认及低档 grant。272–316、483–516、558–596 核对项目/任务访问代次、日志模式、迟到响应隔离与轮询清理。只读比较基准 blob，SettingsPage/SettingsSection 及 SafeBoundary/focusTask/HeaderChips/apply 所在尾段未改。 |
| AC-5 | 通过 | 0 | CI:46–52，`OK no mock data`；client.js:670–705 从 pipeline/catalog 真实字段投影会话、模型和 Provider，919–928 缺失模型字段时省略，并将 T gate 明示未实现，无 gate 通过推断。 |
| AC-6 | 不通过 | 0（静态命令） | CI:55–61，`OK empty states`；文案存在，但首次 projects 失败时 client.js:455–460 只记录 projects 错误，672、748 的依赖页面持续加载，558–580 的轮询及页签 effect 不能恢复，违反 design.md:279。详见问题清单。 |
| AC-7 | 通过 | 0 | CI:64–70，`OK settings+slash`；client.js:662–666 命令只复制，未实现命令无执行入口；745–798 迁入角色路由和全局矩阵；689–705 的模型目录/Provider 共用加载错误状态，Provider 为并集且按真实 availability 计数，discovered/unverified 保持原值。上游项目失败问题计入 AC-6。 |
| AC-8 | 通过 | 0 | CI:73–79，`OK host routes 14`；index.js:855–874 为两条新增只读路由，857、868 拒绝非 GET，872 将原始缓存传入 buildCatalog，873 仅返回目录与 discovery 概况。只读比较指定基准对象，去掉这两条路由及第 8 行注释增量后 Host 全文一致，输出 `OK host unchanged outside new read-only routes and route-list comment`，确认旧十二条路由未改。 |
| AC-9 | 通过 | 0 | CI:91–97，`OK data projection+navigation`；其首段与 AC-13 相同，CI:82–88 的 `OK render 5 tabs` 补足默认首页及五页渲染证据。client.js:307–312、589–596、670–705、981–988 与空/已有会话、错误、Provider 投影、项目切换及跨项目问题导航断言一致。 |
| AC-10 | 通过 | 0 | CI:100–106，`OK host routes runtime`；原断言覆盖空/已有会话、模型发现、四种非 GET 方法 405、旧 projects 路由及隔离目录内容不变。index.js:855–874 与 orchestrator/lib/pipeline.mjs:48–83、config.mjs:121–149 的只读实现一致。 |
| AC-11 | 通过 | 0 | CI:109–115，输出含 `# tests 71`、`# pass 71`、`# fail 0`、`# skipped 0`，符合要求。未再次运行会调用 Git 夹具的测试。 |
| AC-12 | 无法确认完整通过 | 0（仅第二段有证据） | CI:118–124 仅有 `OK no untracked files`；缺 acceptance.md:323–334 第一段相对指定基准的检查及 `OK write scope` 输出。AC-14 不能代替这一段。design.md:1–5 的 write_scope 仍仅两个产品文件；没有据此断言实际越界。 |
| AC-13 | 通过 | 0 | CI:82–88，`OK render 5 tabs`；client.js:254 未存 tab 时默认 home，981–988 按五个 Tab 分派。 |
| AC-14 | 通过 | 0 | CI:127–133，`OK no untracked files`，符合该项未跟踪文件检查期望。 |

## 问题清单

1. **P2 / AC-6：首次项目读取失败后，依赖项目的页面无限加载，规定的恢复路径不可用。** 初始 project、routing、pipeline 均为 null（client.js:252–257）。`loadProjects` 收到失败响应后只设置 `sourceErrors.projects` 并返回（455–460），没有设置 pipeline/routing 的错误；`loadPipeline`、`loadRouting` 在没有项目时直接返回（519–520、422–423）。Studio/Blueprint 的渲染只检查 pipeline（672–684），项目路由只检查 routing 及其自身错误（748），所以虽已确认项目请求失败，页面仍显示“读取中…”。挂载只调用一次 loadProjects，三个全局轮询不含它（558–564）；页签重入只在设置页读取设置数据（568–570），project 为 null 时也不会安装项目轮询（572–580）。因此服务恢复后，等待轮询、重新进入 Studio/Blueprint 或设置页均不能恢复。Build 此时还会因 project 为空显示“暂无任务”（805），将上游读取失败呈现为空结果。手动刷新（552–555）虽能重试，但不能满足 design.md:279 的失败展示及“下一次轮询或重新进入页面可恢复”。请将上游项目错误传到依赖页面，并提供规定的轮询或页面重入恢复路径；无需新增 Host 字段。

2. **P2 / AC-12：第一段范围检查缺少有效执行证据。** acceptance.md:323–334 要求以 `9efb19992f3d68f760082f0cda600c5e6d6b1ee9` 为基准运行检查，退出码 0 且输出 `OK write scope`。本轮 CI 的 AC-12 仅记录第二段 `OK no untracked files`（118–124），AC-14 也只有该输出（127–133）；CI 总计自报 14/14 不能补足缺少的命令结果。请编排方补执行第一段原命令，记录其退出码和输出，并保留第二段证据。评审不执行 Git，不修改验收断言，也不以实现报告自述或两个产品 blob 相符代替整项范围检查。
