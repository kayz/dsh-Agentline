# Task 001 — 验证报告

## 结论

needs_revision。独立核对通过 **9/12**：AC-6 不满足设计的失败状态要求；AC-9、AC-12 各缺少一段必需命令的 CI 运行证据，无法确认完整通过。

被评审工作区 HEAD：`918a770cae725a3bcd6f00d856d94fdf8c3a4c1a`。通过只读读取工作区 `.git`、`C:/git/dsh-Agentline/.git/worktrees/001/HEAD:1` 与 `C:/git/dsh-Agentline/.git/refs/heads/task/001:1` 确认；未执行 git 命令。检查对象为此 HEAD 下当前工作区文件，产品文件 SHA256：
- `plugin/lib/client.js`：`53e7a644ba15f9e9f61c6a02645bee71007a6b1f80ab71ae564d4eb0b29b3618`
- `plugin/lib/index.js`：`6599e9e9b190d3b69e44902ccaab25f119ec44d3f4df50fae996711124091157`

采用编排方 `ci-results.json`（2026-11-06T16:34:16.7917509+08:00）的执行证据，不重跑验收，不以评审环境限制判失败。CI 自报 12/12；以下结合代码与实际覆盖范围独立判断。CI 文件 SHA256：`bbda6fecf33bfa71857c1d8bdbaf648674ec06a7d6bef8c4e231dfdb1a64c9fb`。

## 逐条 AC 结果

下表 CI 行号均相对于本目录 `ci-results.json`；产品路径相对于仓库根。

| AC | 结果 | 退出码 | 原始输出位置 / 说明 |
|---|---|---|---|
| AC-1 | 通过 | 0 | CI:10–16，client.js 语法检查，无输出。 |
| AC-2 | 通过 | 0 | CI:19–25，index.js 语法检查，无输出。 |
| AC-3 | 通过 | 0 | CI:28–34，`OK tabs+home`；client.js:61–74 页签滚动与响应式布局，108–119 页签及命令，455–570 数据读取、轮询与持久化，617–665 首页，980–987 页面分派。 |
| AC-4 | 通过 | 0 | CI:37–43，`OK legacy ops`；client.js:318–385 合并/控制/恢复请求及反馈隔离，800–974 列表、阶段、ledger、回答、执行记录和日志，163–232 设置页，1000 起 focusTask/HeaderChips。278–316、483–587 核对项目/任务/日志请求隔离及清理；合并仍需二次确认，grant 限低档。 |
| AC-5 | 通过 | 0 | CI:46–52，`OK no mock data`；client.js:669–703 只读投影会话与目录，918–927 模型字段缺失时省略、T gate 明示未实现，没有从评审状态推断 gate。 |
| AC-6 | 不通过 | 0（静态） | CI:55–61，`OK empty states` 只证明文案存在；client.js:252–257、455–460、519–520、671、747 与 design.md:279 矛盾，详见问题清单。 |
| AC-7 | 通过 | 0 | CI:64–70，`OK settings+slash`；client.js:110–117、661–665 仅复制已支持命令；744–797 路由/矩阵迁入设置，688–703 目录/Provider 同步错误状态、并集及原始 availability 计数。首次项目读取失败的路由加载问题计入 AC-6，不重复扣项。 |
| AC-8 | 通过 | 0 | CI:73–79，`OK host routes 14`；index.js:550–852 旧十二个路由，855–874 新只读路由，857、868 非 GET 返回 405；catalog 将原始发现缓存传给 buildCatalog，只返回目录和 discovery 概况。 |
| AC-9 | 无法确认完整通过 | 0（第二段） | CI:82–88 仅有 `OK data projection+navigation`，可采信空/有会话/失败、Provider 投影及跨项目导航；缺 acceptance.md:80–83 要求的 `OK render 5 tabs` 运行证据。ci-runner.ps1:45、54、60 解释了第一段被覆盖。 |
| AC-10 | 通过 | 0 | CI:91–97，`OK host routes runtime`；对应 acceptance.md 的隔离目录快照、空/有会话、目录、写方法 405、旧 projects 断言。index.js:855–874 与该证据一致。 |
| AC-11 | 通过 | 0 | CI:100–106，输出汇总 `# tests 71`、`# pass 64`、`# fail 0`、`# skipped 7`。 |
| AC-12 | 无法确认完整通过 | 0（第一段） | CI:109–115 仅有 `OK write scope`，采信相对指定基准的范围检查；design.md:1–5 write_scope 仍仅两个产品文件。缺 acceptance.md:327–334 的 `OK no untracked files` 运行证据；ci-runner.ps1:60、65 在文件末尾保留首段命令，未执行第二段。 |

## 问题清单

1. **P2 — AC-6：首次项目读取失败导致依赖页面永久显示加载中。** 首次挂载时 project、pipeline、routing 均为空（client.js:252–257）；让 /agentline/projects 网络失败、非 JSON 或返回 ok:false，loadProjects 在 459–460 仅记录 projects 错误并返回。loadPipeline（519–520）和 loadRouting（422–423）均因无 project 返回，Studio/Blueprint（671）与设置页项目路由（747）仍显示“读取中…”，这些区块看不到项目错误。挂载只调一次 loadProjects（558–564），重新进入 Studio/Blueprint 也不重试，设置页再次进入仍因无 project 提前返回。因此首次失败后，即使网络恢复也不会经这些页面或现有轮询恢复，必须手动刷新。design.md:279 明确禁止失败伪装成无限加载，并要求轮询或重新进入页面可恢复。修复应传播项目读取的加载/失败状态到依赖区块，并提供重新进入页面或轮询恢复路径；不要把未选定项目伪装成空会话。

2. **P2 — AC-9：五页渲染与默认首页的运行证据缺失。** acceptance.md:75–85 的首段与随后快照交互段都必须执行，但 CI:82–88 只有第二段输出。只读核对 ci-runner.ps1:45、54、60：第二个 fence 重置缓冲，遇到 AC-10 标题时将当前 Command 覆盖为最后一个 fence，所以当前 12/12 汇总不能证明首段执行。请编排方补执行原首段并留存退出码和 `OK render 5 tabs`；保留现有第二段证据，不修改验收断言。

3. **P2 — AC-12：未跟踪文件检查的运行证据缺失。** acceptance.md:327–334 明确要求第二段；CI:109–115 仅有首段输出 `OK write scope`。ci-runner.ps1:60 首段已设置 Command，65 在文件结束仅于 Command 为空时赋值，因此末项第二段被忽略。范围 diff 不能证明没有未跟踪文件。请编排方补执行原第二段并留存退出码和 `OK no untracked files`；review 按授权不执行 git，不修改验收或执行器。

本轮仅创建 review.md、verdict.json。brief 未指定另行追加的验收报告路径；未修改任何历史文档。未执行 DSH 人工观察，不把静态代码检查表述为浏览器交互验证；acceptance.md 将该观察列为非自动判定项。仓库不存在 scripts/check-fast.ps1。