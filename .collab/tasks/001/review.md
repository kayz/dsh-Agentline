# Task 001 — 验证报告

## 结论

needs_revision；独立评审通过 **13/14**，AC-7 不通过，发现 1 个 P2 问题。编排方本轮 CI 的 14 项命令均退出 0；静态检查与禁用 effect 的渲染夹具没有覆盖设置编辑被后台轮询覆盖的行为。

验证的 git SHA：`935419af3d52ef11a2b5817a67501f0bfb283572`。只读 `.git:1` → `C:/git/dsh-Agentline/.git/worktrees/001/HEAD:1` → `C:/git/dsh-Agentline/.git/refs/heads/task/001:1`，解压 loose commit/tree/blob 对象并校验 SHA1；两个产品文件统一 CRLF/LF 后与该提交的 blob 一致。未执行 git 命令。

执行类验收采用 `.collab/tasks/001/ci-results.json:4` 中 `2026-11-06T18:46:42.3047922+08:00` 的运行证据，未重跑验收命令。AC-9 首段与 AC-13 命令相同，共用其执行证据。client.js:493 已加入实际路由重试，上一版路由失败后无请求却无限加载的问题已修复。

本轮只读计算的 SHA256：

- `plugin/lib/client.js`：`9d4d7ab8f697c328e7785f6ba26291904972e7872064d16d47df1ba359d1f08f`
- `plugin/lib/index.js`：`6599e9e9b190d3b69e44902ccaab25f119ec44d3f4df50fae996711124091157`
- `.collab/tasks/001/ci-results.json`：`c9e63b32914c34592aeefefd0ac87286dbd9ce17dded39c42ccb4d20aaee0bc3`

本轮仅更新 review.md、verdict.json，保留其他轮次文件；brief 未指定额外验收报告路径。未在 DSH 中执行人工观察，按 acceptance.md:351 不计自动验收失败。仓库未发现 scripts/check-fast.ps1。评审不因环境或临时文件权限扣分。

## 逐条 AC 结果

以下 CI 行号均指 `.collab/tasks/001/ci-results.json`，产品代码路径为 `plugin/lib/`。

| AC | 结果 | 退出码 | 原始输出位置 / 说明 |
|---|---|---|---|
| AC-1 | 通过 | 0 | CI:10–16，output 为空，符合 client.js 语法检查期望。 |
| AC-2 | 通过 | 0 | CI:19–25，output 为空，符合 index.js 语法检查期望。 |
| AC-3 | 通过 | 0 | CI:28–34，`OK tabs+home`；client.js:61–74、108–119、534–611、632–681、996–1004 核对滚动页签、首页区块、真实端点、轮询、持久化和页面分派。 |
| AC-4 | 通过 | 0 | CI:37–43，`OK legacy ops`；client.js:318–385 保留操作端点和请求体，816–990 保留全部任务操作、二次合并确认、ledger、执行记录和日志；272–316、498–531、573–611 核对项目/任务/日志请求隔离及卸载清理。只读对照基准对象，SettingsPage/SettingsSection、SafeBoundary、focusTask、HeaderChips、apply 的既有实现未变。 |
| AC-5 | 通过 | 0 | CI:46–52，`OK no mock data`；client.js:685–719 投影真实会话与目录，934–943 缺失模型字段时省略，G1/T gate 明示未实现。 |
| AC-6 | 通过 | 0 | CI:55–61，`OK empty states`；client.js:548–565、642–675、685–719、763、810、820、845、936 分离加载/失败/空状态；493 对当前项目实际重试路由，422–435 回写成功或失败，先前无在途请求却持续加载的问题已修复。 |
| AC-7 | 不通过 | 0（静态命令） | CI:64–70，`OK settings+slash`；client.js:677–681 的命令只复制或标为未实现，704–719 为只读目录和 Provider；但 493、577 的正常项目轮询会触发 435 覆盖设置草稿，并可使 449 丢弃保存反馈，违反 design.md:108–112、229。详见问题清单。 |
| AC-8 | 通过 | 0 | CI:73–79，`OK host routes 14`；index.js:855–874 新路由只读转发，857、868 拒绝非 GET，872–873 使用原始发现缓存且不返回原始配置。只读比较指定基准，排除新增两路由与顶部路由注释后，Host 非空行完全一致。 |
| AC-9 | 通过 | 0 | CI:91–97，`OK data projection+navigation`；首段同 AC-13，共用 CI:82–88 的 `OK render 5 tabs`。client.js:307–315、604–611、685–719、996–1004 与默认首页、五页渲染、数据投影、项目切换及跨项目回答定位断言一致。夹具未执行异步轮询，未覆盖 AC-7 finding。 |
| AC-10 | 通过 | 0 | CI:100–106，`OK host routes runtime`；原断言覆盖空/已有会话、目录、四种非 GET 方法 405、旧 projects 路由和隔离目录内容不变；index.js:855–874 与结果一致。 |
| AC-11 | 通过 | 0 | CI:109–115，`# tests 71`、`# pass 71`、`# fail 0`、`# skipped 0`。 |
| AC-12 | 通过 | 0 | CI:118–124，`OK write scope`；对应 acceptance.md:323–334 相对指定基准检查 client.js、index.js、.gitignore 的原命令，按当前 acceptance 判定。 |
| AC-13 | 通过 | 0 | CI:82–88，`OK render 5 tabs`；client.js:254 默认首页、996–1004 五页分派。 |
| AC-14 | 通过 | 0 | CI:127–133，`OK no untracked files`；对应 acceptance.md:339–345 的独立未跟踪文件检查。 |

## 问题清单

1. **P2 / AC-7：正常项目轮询覆盖角色路由草稿，并可能吞掉保存反馈。** client.js:577 每 10 秒调用 loadProjects。只要当前项目不变，493 就会无条件调用 loadRouting；424 增加 routing 请求序号，435 根据服务器响应重新初始化整个 draft。用户在设置页修改模型和质量/速度策略后，即使没有切项目、切 Tab 或手动刷新，下一次项目轮询也会恢复服务器上的旧值。若保存 POST 尚未完成，轮询产生的新请求序号还会使 saveRouting 在 449 直接返回，丢弃保存成功或失败的结果，不能按 design.md:110 显示结果提示。这不满足 design.md:108 的既有 handler 行为保留、112 的设置读取时机以及 229 的设置保存约定。

   本轮直接从当前 client.js 提取 begin/scope/valid/latest/sourceError/failure 和 loadRouting/saveRouting/loadProjects，在内存中提供同项目列表、服务器路由与延迟 POST 响应。未联网、未执行 Host 初始化、未创建测试文件。断言全部成立，命令退出码 0：

   ```text
   Before projects poll: {"model":"edited-model","policy":"speed"}
   After projects poll: {"model":"saved-model","policy":"quality"}
   POST success after projects poll: routeMsg="", draft={"model":"saved-model","policy":"quality"}
   Confirmed: poll overwrites dirty draft and invalidates in-flight save feedback
   ```

   对照指定基准的 loadProjects，旧实现仅更新项目列表和初始项目选择，没有每次轮询重载当前路由。建议将项目列表刷新与路由草稿初始化分开，恢复路由读取失败时才按需重试，并保护未保存草稿和在途保存的反馈。修复不需要新增 Host 字段、改变接口或修改验收断言。
