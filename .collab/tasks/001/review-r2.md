# Task 001 — 验证报告

## 结论

needs_revision；独立评审通过 **12/14**。AC-6 不通过，AC-12 无法确认完整通过。采用编排方 `ci-results.json:4` 的 `2026-11-06T18:01:32.5223737+08:00` 执行证据；其自报 14/14 不能替代规格核对和多段命令证据核对。

验证的 git SHA：`27110905bb9b9d7bf50f4ea3f333cb7932a5b513`。只读 `.git:1` → `C:/git/dsh-Agentline/.git/worktrees/001/HEAD:1` → `C:/git/dsh-Agentline/.git/refs/heads/task/001:1`，解压对应 loose commit object 后计算 SHA1，结果与该 SHA 一致；遍历该提交的 tree，两个产品文件统一 CRLF/LF 后均与提交 blob 一致。未执行 git 命令。

本轮只读计算的 SHA256：

- `plugin/lib/client.js`：`a93d2e350f426221193f567bf2e169d67f36bf3ab4463e886e59099225f934ea`
- `plugin/lib/index.js`：`6599e9e9b190d3b69e44902ccaab25f119ec44d3f4df50fae996711124091157`
- `.collab/tasks/001/ci-results.json`：`4189cb41a796d04508c3cb8131c8d5fde97ebde8fef2d173193ee26a3e8c3db0`

执行类验收直接采用 CI，未重跑会创建夹具或调用 Git 的测试。没有因评审环境缺少 PowerShell 7 或临时权限扣分。brief 未指定额外验收报告路径；本轮仅创建 review-r2.md、verdict-r2.json，保留历史文件。DSH 人工观察未执行，按 acceptance.md:359 的约定不计为自动判定失败。仓库没有 scripts/check-fast.ps1。

## 逐条 AC 结果

以下 CI 行号均指 `.collab/tasks/001/ci-results.json`；产品代码路径为 `plugin/lib/`。

| 验收项 | 结论 | 证据 |
|---|---|---|
| AC-1 | 通过 | CI:10–16，exitCode=0，output 为空，符合 client.js 语法检查期望。 |
| AC-2 | 通过 | CI:19–25，exitCode=0，output 为空，符合 index.js 语法检查期望。 |
| AC-3 | 通过 | CI:28–34，exitCode=0，`OK tabs+home`；client.js:61–74 的滚动页签与响应布局、108–119 的页签常量、533–570 的数据读取和持久化、617–667 首页、981–988 页签分派相符。 |
| AC-4 | 通过 | CI:37–43，exitCode=0，`OK legacy ops`；client.js:318–385 保留端点与请求体；801–974 保留列表、阶段轨迹、ledger、停止、注入、回答、执行记录与日志；855–864 保留二次确认及低档 grant；272–316、483–596 核对项目/任务代次、日志模式、反馈隔离与卸载清理。 |
| AC-5 | 通过 | CI:46–52，exitCode=0，`OK no mock data`；client.js:670–705 从真实摘要和目录投影会话、Provider；919–928 模型字段缺失时省略，T gate 明示未实现，无 gate 通过推断。 |
| AC-6 | 不通过 | CI:55–61 静态命令 exitCode=0，`OK empty states`；但首次 projects 失败路径在 client.js:455–460 只记录 projects 错误，672、748 仍无限显示加载，违反 design.md:279。详见问题清单。 |
| AC-7 | 通过 | CI:64–70，exitCode=0，`OK settings+slash`；client.js:662–666 命令仅复制/标记未实现，745–798 路由与矩阵迁入设置，689–705 目录/Provider 共享加载错误、取 Provider 并集并按真实 availability 计数。项目依赖失败问题计入 AC-6。 |
| AC-8 | 通过 | CI:73–79，exitCode=0，`OK host routes 14`；index.js:550–852 保留十二条旧路由，855–874 新增两条只读路由，857、868 拒绝非 GET，872–873 将原始发现缓存传入 buildCatalog，仅返回目录与 discovery 概况。 |
| AC-9 | 通过 | CI:91–97，exitCode=0，`OK data projection+navigation`；首段五页渲染命令与 AC-13 相同，CI:82–88 的 `OK render 5 tabs` 补足证据。client.js:307–312、589–596、670–705、981–988 与夹具数据投影、跨项目问题导航及默认首页断言一致。 |
| AC-10 | 通过 | CI:100–106，exitCode=0，`OK host routes runtime`；原断言验证空/已有会话、发现目录、四种非 GET 方法 405、旧 projects 及隔离目录内容不变；index.js:855–874 与 orchestrator/lib/pipeline.mjs:60–87、config.mjs:121–149 的只读实现一致。 |
| AC-11 | 通过 | CI:109–115，exitCode=0；输出 `# tests 71`、`# pass 71`、`# fail 0`、`# skipped 0`。 |
| AC-12 | 无法确认完整通过 | CI:118–124 只有第二段 exitCode=0、`OK no untracked files`；缺 acceptance.md:323–334 第一段相对指定基准的范围检查运行证据。design.md:1–5 的 write_scope 仍仅两个产品文件；未据此断言实际越界。 |
| AC-13 | 通过 | CI:82–88，exitCode=0，`OK render 5 tabs`；client.js:254 默认 home，981–988 渲染五页，与首段命令相符。 |
| AC-14 | 通过 | CI:127–133，exitCode=0，`OK no untracked files`；该证据验证未跟踪文件，不能替代 AC-12 的相对基准范围检查。 |

## 问题清单

1. **P2 / AC-6：首次项目读取失败后，依赖项目的页面无限加载且不能通过规定路径恢复。** 初始 project、routing、pipeline 为 null（client.js:252–257）。`loadProjects` 失败只设置 projects 错误并返回（455–460）；loadRouting/loadPipeline 因没有项目直接返回（422–423、519–520）。Studio/Blueprint 仅检查 pipeline，设置路由仅检查 routing 错误，因此持续显示“读取中…”（672、748），没有呈现项目读取失败。挂载仅调用一次 loadProjects，三个全局轮询均不包含它（558–564）；页签重入只会触发设置数据读取（568–570），项目为 null 时也不会安装项目轮询（572–580）。所以后端恢复后，等待轮询或切换页签均无法恢复；手动刷新虽能重试，仍未满足 design.md:279 明确要求的失败展示及“下一次轮询或重新进入页面可恢复”。请在依赖页面呈现上游项目错误，并提供符合规格的自动轮询或页面重入恢复路径；无需新增 Host 字段。

2. **P2 / AC-12：缺少第一段范围检查的有效执行证据。** acceptance.md:323–334 要求相对 `9efb19992f3d68f760082f0cda600c5e6d6b1ee9` 执行范围检查并输出 `OK write scope`。当前 CI 的 AC-12 输出仅为 `OK no untracked files`（118–124），AC-14 也只有相同输出（127–133）；两者均不能证明第一段通过。请编排方补执行第一段原命令，记录独立退出码和输出，并保留已有第二段结果。review 不执行 git、不修改验收断言，也不以实现报告中的自述代替 CI 证据。
