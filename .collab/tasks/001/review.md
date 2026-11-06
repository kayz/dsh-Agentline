# Task 001 — 验证报告

## 结论

needs_revision；独立评审通过 **13/14**。AC-6 不通过，其余验收项通过。编排方本轮 CI 的 14 项命令均退出 0；静态文案检查未覆盖下述错误状态被项目轮询清除的行为。

验证的 git SHA：`71c164dcb43297b8e381bb6a8d16644065a3e407`。只读 `.git:1` → `C:/git/dsh-Agentline/.git/worktrees/001/HEAD:1` → `C:/git/dsh-Agentline/.git/refs/heads/task/001:1`，解压对应 loose commit object 并计算 SHA1，与该 SHA 一致；两个产品文件统一 CRLF/LF 后与该提交的 blob 一致。未执行 git 命令。

执行类验收采用 `.collab/tasks/001/ci-results.json:4` 的 `2026-11-06T18:39:26.3164228+08:00` 运行证据，未重跑验收命令。AC-9 首段与 AC-13 命令相同，其运行证据共用；AC-12 和 AC-14 分别包含正确输出。本轮重新核对规格、代码行号与提交对象，并直接提取当前实现的函数，在内存中复现下述问题；结论不依赖历史评审或 impl.md 的自测陈述。

本轮只读计算的 SHA256：

- `plugin/lib/client.js`：`527f086a104769aee75880ca0aaac7b08fc3b5d8c8790eec6db7f1656fc9892a`
- `plugin/lib/index.js`：`6599e9e9b190d3b69e44902ccaab25f119ec44d3f4df50fae996711124091157`
- `.collab/tasks/001/ci-results.json`：`0105fcb35116d977240f7d06eeb57c372f20732aec9527cade311c4b6823b3e9`

本轮仅更新 review.md、verdict.json，保留其他轮次文件。brief 未指定额外验收报告路径。未在 DSH 中执行人工观察；按 acceptance.md:351 的约定，不计为自动验收失败。未因评审环境或临时权限限制扣分。仓库未发现 scripts/check-fast.ps1。

## 逐条 AC 结果

以下 CI 行号均指 `.collab/tasks/001/ci-results.json`，产品代码路径为 `plugin/lib/`。

| AC | 结果 | 退出码 | 原始输出位置 / 说明 |
|---|---|---|---|
| AC-1 | 通过 | 0 | CI:10–16，output 为空，符合 client.js 语法检查期望。 |
| AC-2 | 通过 | 0 | CI:19–25，output 为空，符合 index.js 语法检查期望。 |
| AC-3 | 通过 | 0 | CI:28–34，`OK tabs+home`；client.js:61–74、108–119、532–609、630–680、994–1002 核对滚动页签、首页区块、端点、持久化和页面分派。 |
| AC-4 | 通过 | 0 | CI:37–43，`OK legacy ops`；client.js:318–385 保留任务操作端点与请求体，814–988 保留列表、阶段轨迹、ledger、停止、输入、回答、合并确认、执行记录和日志；272–316、496–539、571–609 核对任务/项目/日志请求隔离、写操作反馈保护及卸载清理。只读对照基准 blob，SettingsPage/SettingsSection、SafeBoundary、focusTask、HeaderChips、apply 的既有实现未变。 |
| AC-5 | 通过 | 0 | CI:46–52，`OK no mock data`；client.js:683–718 按真实会话/目录投影，932–941 只展示存在的模型字段，G1/T gate 明示未实现，不从任务状态推导 gate 通过。 |
| AC-6 | 不通过 | 0（静态命令） | CI:55–61，`OK empty states`；但 client.js:471–473 会清除独立路由错误，且不重试路由，761 随后持续显示“读取中…”，违反 design.md:279。详见问题清单。 |
| AC-7 | 通过 | 0 | CI:64–70，`OK settings+slash`；client.js:675–679 命令仅复制或标为未实现，758–812 路由/矩阵迁入设置，702–718 只读目录与 Provider 共用加载/错误状态、取 Provider 并集并按 availability 计数。路由错误展示问题归入 AC-6。 |
| AC-8 | 通过 | 0 | CI:73–79，`OK host routes 14`；index.js:550–852 旧路由、855–874 两条新只读路由，857、868 拒绝非 GET，872–873 使用原始发现缓存构造目录，仅返回目录和 discovery 概况。只读对照基准 blob，排除新路由及路由注释后，Host 非空行完全一致。 |
| AC-9 | 通过 | 0 | CI:91–97，`OK data projection+navigation`；首段同 AC-13，CI:82–88 的 `OK render 5 tabs` 补足证据。client.js:307–315、602–609、683–718、994–1002 与默认首页、数据投影、项目切换及跨项目回答导航断言一致。 |
| AC-10 | 通过 | 0 | CI:100–106，`OK host routes runtime`；原断言覆盖空/已有会话、模型目录、四种非 GET 方法 405、旧 projects 路由及隔离目录内容不变。index.js:855–874 为既有模块的只读转发，与结果一致。 |
| AC-11 | 通过 | 0 | CI:109–115，输出 `# tests 71`、`# pass 71`、`# fail 0`、`# skipped 0`。 |
| AC-12 | 通过 | 0 | CI:118–124，`OK write scope`；依据 acceptance.md:323–334 的原命令，相对指定基准检查预期路径 client.js、index.js、.gitignore；不沿用旧报告中缺少第一段证据的结论。 |
| AC-13 | 通过 | 0 | CI:82–88，`OK render 5 tabs`；client.js:254 默认首页、994–1002 五页分派，与首段渲染命令一致。 |
| AC-14 | 通过 | 0 | CI:127–133，`OK no untracked files`；对应 acceptance.md:339–345 的独立未跟踪文件检查。 |

## 问题清单

1. **P2 / AC-6：项目列表轮询成功会掩盖路由读取失败，使设置页持续加载。** 设置页进入时 `loadRouting` 请求失败会设置 `sourceErrors.routing`，并将 routing 清为 null（client.js:422–428）。随后独立的 `/agentline/projects` 请求成功，无条件清除 `sourceErrors.routing`（471–473），但没有调用 loadRouting。项目列表每 10 秒轮询（575）；当前项目未变时不会触发 `[tab, project]` 的设置页 effect（581–583）。设置页最终呈现 routing=null、错误为空，761 只能显示“读取中…”，后续项目列表轮询仍不重试路由。即使路由端点一直失败，其真实错误也会被正常的项目列表请求隐藏。这违反 design.md:279 要求的错误隔离和失败不得伪装成无限加载。

   只读内存复现直接提取当前 client.js 的 loadRouting/loadProjects 函数，替换网络和 setter，不创建夹具、不执行 effect 或定时器。先令路由返回 `{ok:false,error:'routing-unavailable'}`，再令 projects 返回成功且包含同一项目，输出：

   ```text
   After routing failure: {"routing":null,"draft":{},"sourceErrors":{"routing":"routing-unavailable"}}
   After projects success: {"routing":null,"draft":{},"sourceErrors":{"routing":"","projects":"","pipeline":""},"projects":[{"path":"A","title":"A"}],"projectsReady":true}
   Routing calls=1; no retry; settings selects loading branch at client.js:761
   Projects failure followed by success also leaves routing=null and error empty
   ```

   同一复现还验证：项目列表请求失败会清空 routing（client.js:460–468）；随后项目列表恢复成功、当前项目不变时，同样只清错误而不重新读取路由。复现命令退出码 0，所有断言成立；未联网、未创建文件、未执行 Host 初始化。

   请由路由数据源自己的成功响应清除路由错误；项目列表成功时仅清除属于项目列表的错误。如需传播、撤销上游项目错误，应区分其来源，并在撤销时实际重试当前项目路由，避免留下没有在途请求的加载状态。无需扩展 Host 接口或修改验收断言。
