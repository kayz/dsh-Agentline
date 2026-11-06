# Task 001 — 验证报告

## 结论

needs_revision；独立评审通过 **13/14**，AC-7 不通过，发现 1 个 P2 问题。编排方 CI 的 14 项命令均退出 0，但未执行 effect 的渲染夹具和静态检查没有覆盖正常轮询覆盖路由草稿的行为。

验证的 git SHA：`bf2e819b959815a352abe433325e885544a99a9a`。只读 `.git:1` → `C:/git/dsh-Agentline/.git/worktrees/001/HEAD:1` → `C:/git/dsh-Agentline/.git/refs/heads/task/001:1`，解压 commit/tree/blob 对象并核验 SHA1；两个产品文件统一 CRLF/LF 后与该提交中的 blob 一致。未执行 git 命令。

执行类证据采用 `.collab/tasks/001/ci-results.json:4` 的 `2026-11-06T20:04:31.0583419+08:00` 记录，没有重跑验收命令。AC-9 首段与 AC-13 是同一条命令，共用 AC-13 的执行结果。CI 中 orchestrator 汇总为 71 项通过、0 项失败、0 项跳过，以此为准；impl.md 的跳过数来自不同运行，不代替本轮证据。

本轮只读计算的 SHA256：

- `plugin/lib/client.js`：`72cc28d92992fe18b2b20e52a5800145d2286ac2400052be636124bad5289d08`
- `plugin/lib/index.js`：`6599e9e9b190d3b69e44902ccaab25f119ec44d3f4df50fae996711124091157`
- `.collab/tasks/001/ci-results.json`：`aef9ef80f7bc9d11acff29fee7deac4b607d730013436c93e2b1a5ea674c2140`

上一轮的路由持续加载路径已有调整：client.js:460–468 不再清空 routing/draft，491 在项目列表恢复成功时重新请求路由。然而，该重载没有恢复条件，每次正常项目列表轮询也会执行，重新引入草稿丢失，详见问题清单。

本轮仅创建 review-r1.md、verdict-r1.json，保留既有评审文件。brief 没有指定额外验收报告路径。未执行 DSH 人工观察，该部分按 acceptance.md 不计自动判定；仓库没有 scripts/check-fast.ps1。没有因评审环境或临时文件权限扣分。

## 逐条 AC 结果

以下 CI 行号均指 `.collab/tasks/001/ci-results.json`，代码路径为 `plugin/lib/`。

| AC | 结果 | 退出码 | 证据与独立核对 |
|---|---|---|---|
| AC-1 | 通过 | 0 | CI:10–16，output 为空，符合 client.js 语法检查期望。 |
| AC-2 | 通过 | 0 | CI:19–25，output 为空，符合 index.js 语法检查期望。 |
| AC-3 | 通过 | 0 | CI:28–34，`OK tabs+home`；client.js:61–74、108–119、532–609、630–680、994–1002 核对滚动页签、端点、轮询、持久化、首页区块和五页分派。 |
| AC-4 | 通过 | 0 | CI:37–43，`OK legacy ops`；client.js:318–385、814–988 保留任务端点与请求体、阶段轨迹、停止/输入/回答/继续、合并二次确认/预授权/分档、ledger、执行记录和日志。272–316、496–529、571–609 核对项目/任务/日志模式隔离、禁用操作与卸载清理。只读对照基准提交，SettingsPage/SettingsSection、SafeBoundary、focusTask、HeaderChips、apply 未变。路由编辑问题统一计入 AC-7。 |
| AC-5 | 通过 | 0 | CI:46–52，`OK no mock data`；client.js:683–718 使用真实会话和目录字段，935–941 只展示存在的模型字段，不补造 resolved，697、941 明示 G1/T gate 未实现。 |
| AC-6 | 通过 | 0 | CI:55–61，`OK empty states`；client.js:646–673、683–718、758–811、817–843、933–941 核对加载、失败、空值和未实现分支，Provider 与目录共享失败状态。460–491 的改动使项目列表恢复时重新请求路由，上一轮没有在途请求却持续加载的路径已调整；重载覆盖草稿的问题计入 AC-7。 |
| AC-7 | 不通过 | 0（静态命令） | CI:64–70，`OK settings+slash`；client.js:758–811 确有路由、矩阵与只读目录，675–679 的命令只复制或显示未实现。但 575 每 10 秒轮询项目，491 对当前项目无条件 loadRouting，422–435 在响应后无条件 setDraft，正常编辑会丢失未保存选择。违反 design.md:106–112 保留 handler 行为及设置读取时机、229 的编辑保存约定，详见问题清单。 |
| AC-8 | 通过 | 0 | CI:73–79，`OK host routes 14`；index.js:854–874 的两个入口只读转发，857、868 非 GET 返回 405，872–873 使用原始发现缓存，不返回原始配置或凭据。只读解压基准对象比较：剔除新增两路由及顶部路由注释后，Host 非空行完全一致。 |
| AC-9 | 通过 | 0 | CI:91–97，`OK data projection+navigation`；首段共用 CI:82–88 的 `OK render 5 tabs`。client.js:254、296–312、602–609、683–718、994–1002 与默认首页、五页渲染、真实字段投影、项目切换及跨项目回答定位断言一致。夹具不执行异步轮询，不覆盖 AC-7 finding。 |
| AC-10 | 通过 | 0 | CI:100–106，`OK host routes runtime`；原断言覆盖空项目、已有会话、模型目录、POST/PUT/PATCH/DELETE 返回 405、旧 projects 路由及隔离目录前后内容一致；index.js:854–874 与执行结果一致。 |
| AC-11 | 通过 | 0 | CI:109–115，output 含 `# tests 71`、`# pass 71`、`# fail 0`、`# skipped 0`，符合验收期望。 |
| AC-12 | 通过 | 0 | CI:118–124，`OK write scope`；采用 acceptance.md:323–334 相对指定基准的原命令证据，包含 client.js、index.js、.gitignore，未自行执行 git 命令。 |
| AC-13 | 通过 | 0 | CI:82–88，`OK render 5 tabs`；client.js:254 默认首页，994–1002 分派五页。 |
| AC-14 | 通过 | 0 | CI:127–133，`OK no untracked files`；采用 acceptance.md:339–345 的独立未跟踪文件检查证据。 |

## 问题清单

1. **P2 / AC-7：正常项目轮询每 10 秒覆盖未保存的角色路由草稿，并可能丢弃保存反馈。**

   触发：进入设置页，修改某个角色的模型或质量/速度策略，暂不点保存；等待下一次 `/agentline/projects` 成功响应。client.js:575 每 10000ms 调用 loadProjects；当项目没有变化时，491 的 `else if (target)` 仍无条件执行 `loadRouting(target)`。该请求在 424 递增 routing 请求序号，响应在 429–435 用服务端 roles 重新生成 draft。764–775 的选择框绑定 draft，因此未保存选择被恢复为服务端旧值。这个条件在每次正常轮询都成立，用户只需编辑跨过轮询边界即可遇到，不依赖网络失败。

   同一原因也影响正在提交的路由保存：saveRouting 在 440 使用同一个 `begin('routing')`；若项目轮询在 POST 返回前发起 loadRouting，424 的新序号会使 449 的 `latest('routing', n, s)` 为 false，保存响应无法显示成功或失败。GET 若先读到旧配置，还会先把正在保存的选择恢复为旧值。

   规格依据：design.md:106 要求既有 handler 行为保留，112 将路由读取时机定义为进入设置或设置页切项目，132 允许手动刷新重读，229 要求保留路由编辑和保存。例行项目轮询无条件改写正在编辑的表单不符合上述行为。impl.md:1 声称项目列表轮询不再重置未保存草稿，与当前代码矛盾。

   修复建议：正常同项目轮询只更新项目列表；错误恢复时只按需重试未加载或失败的数据源，并保护已有草稿及在途保存的响应。保持进入设置、切项目和手动刷新的既有读取行为，不新增接口字段或修改验收断言。此结论来自只读控制流及行号核对，没有新建测试文件或重跑执行类验收。
