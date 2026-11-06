# Task 001 — 验证报告

## 结论

needs_revision；独立评审通过 **13/14**，AC-6 不通过，发现 1 个 P2 问题。编排方 CI 的 14 项命令均退出 0，但静态文案检查和不执行 effect 的渲染夹具未覆盖路由错误恢复路径。

验证的 git SHA：`0736c4372b526e92eaef9e9bec4c294be6df15d0`。只读 `.git:1` → `C:/git/dsh-Agentline/.git/worktrees/001/HEAD:1` → `C:/git/dsh-Agentline/.git/refs/heads/task/001:1`；解压 commit/tree/blob 对象并校验 SHA1，两个产品文件统一 CRLF/LF 后与该提交 blob 一致。未执行 git 命令。

执行类验收直接采用 `.collab/tasks/001/ci-results.json:4` 的 `2026-11-06T18:58:01.2755773+08:00` 运行证据，未重跑验收命令。AC-9 首段与 AC-13 命令相同，共用其执行证据。上一轮正常项目轮询重载路由、覆盖未保存草稿的问题已修复：client.js:478–494 现在只在目标项目变化时切换项目，不再无条件调用 loadRouting。

本轮只读计算的 SHA256：

- `plugin/lib/client.js`：`edfbc522ca99e0d1df538c81fee0815eba61da3d9e77d5829e714ac484eff0c7`
- `plugin/lib/index.js`：`6599e9e9b190d3b69e44902ccaab25f119ec44d3f4df50fae996711124091157`
- `.collab/tasks/001/ci-results.json`：`08fbb04debd01216ffbbe1422b2151d0c0617da772a0190d0b79d35023ab5503`

本轮仅更新 review.md、verdict.json。brief 未指定额外验收报告路径；未在 DSH 中执行人工观察，按 acceptance.md 的说明不计自动验收失败。仓库没有 scripts/check-fast.ps1。未因评审环境或临时文件权限扣分。

## 逐条 AC 结果

以下 CI 行号均指 `.collab/tasks/001/ci-results.json`，产品代码路径为 `plugin/lib/`。

| AC | 结果 | 退出码 | 证据与独立核对 |
|---|---|---|---|
| AC-1 | 通过 | 0 | CI:10–16，output 为空，符合 client.js 语法检查期望。 |
| AC-2 | 通过 | 0 | CI:19–25，output 为空，符合 index.js 语法检查期望。 |
| AC-3 | 通过 | 0 | CI:28–34，`OK tabs+home`；client.js:61–74、108–119、533–610、631–680、995–1002 核对页签滚动、真实端点、轮询、持久化、首页区块与五页分派。 |
| AC-4 | 通过 | 0 | CI:37–43，`OK legacy ops`；client.js:318–385 保留操作端点及请求体，815–988 保留任务列表/详情、二次合并确认、ledger、执行记录和日志；272–316、497–530、572–610 核对项目/任务/日志请求隔离和卸载清理。只读对照指定基准对象，SettingsPage/SettingsSection、SafeBoundary、focusTask、HeaderChips、apply 的既有实现未变。 |
| AC-5 | 通过 | 0 | CI:46–52，`OK no mock data`；client.js:684–719 只投影真实会话/目录字段，937–940 仅展示实际存在的模型字段，698、942 明示 G1/T gate 未实现。 |
| AC-6 | 不通过 | 0（静态命令） | CI:55–61，`OK empty states`；大部分加载/失败/空分支符合规格，但 client.js:460–474 在项目列表失败时清空独立路由及草稿，恢复时仅清除错误而不重新请求路由，762 随后持续显示“读取中…”。违反 design.md:279 的错误隔离和不得无限加载要求，详见问题清单。 |
| AC-7 | 通过 | 0 | CI:64–70，`OK settings+slash`；client.js:759–812 保留路由编辑/保存、模型矩阵与目录展示；438–452 显示保存结果，478–494 不再因正常项目轮询重载路由，583 的读取时机为进入设置或切项目；676–680 命令只复制或显示未实现，703–719 的目录/Provider 只读。异常恢复问题统一计入 AC-6，不重复扣项。 |
| AC-8 | 通过 | 0 | CI:73–79，`OK host routes 14`；index.js:855–874 为只读转发，857、868 拒绝非 GET，872–873 使用原始发现缓存且不返回原始配置。只读比较指定基准，排除新增两路由及顶部路由注释后，Host 非空行完全一致。 |
| AC-9 | 通过 | 0 | CI:91–97，`OK data projection+navigation`；首段同 AC-13，共用 CI:82–88 的 `OK render 5 tabs`。client.js:307–315、603–610、684–719、995–1002 与默认首页、五页渲染、数据投影、项目切换和跨项目回答定位断言一致。夹具未执行异步轮询，不覆盖 AC-6 问题。 |
| AC-10 | 通过 | 0 | CI:100–106，`OK host routes runtime`；原断言覆盖空/已有会话、目录、四种非 GET 方法返回 405、旧 projects 路由及隔离目录内容不变，index.js:855–874 与结果一致。 |
| AC-11 | 通过 | 0 | CI:109–115，输出含 `# tests 71`、`# pass 71`、`# fail 0`、`# skipped 0`。采用本轮 CI，而非 impl.md 中不同的跳过数。 |
| AC-12 | 通过 | 0 | CI:118–124，`OK write scope`；对应 acceptance.md:323–334 相对指定基准检查 client.js、index.js、.gitignore 的原命令。按当前验收脚本判定，未执行 git 命令。 |
| AC-13 | 通过 | 0 | CI:82–88，`OK render 5 tabs`；client.js:254 默认首页，995–1002 分派五页。 |
| AC-14 | 通过 | 0 | CI:127–133，`OK no untracked files`；对应 acceptance.md:339–345 的独立未跟踪文件检查。 |

## 问题清单

1. **P2 / AC-6：项目列表请求恢复后，角色路由无在途请求却永久显示加载，并丢失草稿。** 在已进入设置页、路由成功加载后，client.js:576 每 10 秒触发的 loadProjects 只要失败一次，就会在 464–469 清空 routing 和 draft。下一次项目列表成功时，474 清除 routing 错误；478–494 对未变化的当前项目既不调用 loadRouting，也不改变 tab/project，因此 582–584 的设置 effect 不会重新执行。762 随后进入 `!routing` 分支显示“读取中…”，766、771、780 禁用编辑与保存；继续成功轮询也不会恢复。即使只是 routing 自身读取失败，后续成功的项目轮询也会在 474 抹掉该错误而不发起重试。违反 design.md:279 的各区块错误隔离、失败不得无限加载，以及 229 的路由编辑保存约定。

   本轮从当前 client.js 只读提取 Cockpit 的状态与 handler，在内存中注入网络桩，顺序执行项目列表失败和成功两次响应；未联网、未初始化 Host、未创建测试文件。断言通过，命令退出码 0：

   ```text
   Before projects failure: {"routing":{"roles":{}},"draft":{"design":{"model":"edited-model","policy":"speed"}}}
   After failure then successful projects poll: {"projectsReady":true,"routing":null,"routingError":"","draft":{},"calls":["/agentline/projects","/agentline/projects"]}
   Confirmed: routing renders loading without a routing request after project-list recovery
   ```

   建议由各数据源管理自己的状态：项目列表失败不要清空已成功读取的路由和未保存草稿，也不要在项目列表成功时清除独立路由错误；若确需恢复路由，应在错误恢复时按需请求，并保护草稿和在途保存反馈。修复不需要新增 Host 字段、修改接口或放宽验收断言。