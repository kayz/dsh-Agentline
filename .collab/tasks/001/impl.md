按 design.md 实现，产品改动仅涉及 `plugin/lib/client.js`、`plugin/lib/index.js`；本文件为实现报告。未修改任务说明、设计、验收、review/verdict、state/run 或 docs，也未调整版本号或 orchestrator。

- `client.js`：将驾驶舱拆为首页、Studio、Blueprint、Build、设置五个 Tab，保存当前页签，窄屏页签横向滚动。首页接入跨项目待处理、项目组合、运行中、最近事件及仅供复制的斜杠命令说明，卡片按钮只导航到 Build。
- Studio/Blueprint 仅显示 pipeline 摘要的会话 id、status、updated_at。加载、失败、成功但为空分别渲染；G0 详情、G1、T gate 使用设计指定的未实现说明。
- Build 保留阶段轨迹、继续运行、合并二次确认、低档预授权、分档检查、K1 ledger、停止、note/amend、回答、执行记录和日志切换；增加真实项目、来源与最后一次执行的模型信息。模型字段缺失时省略，不将 requested 当作 resolved。
- 设置页迁入原角色路由和全局矩阵，并增加只读模型目录、Provider 并集及 availability 计数。目录与 Provider 共用加载/错误状态，discovered、unverified 保持原值。
- 项目访问代次、任务代次及请求序号共同隔离迟到响应，覆盖 A→B→A、同号任务及日志模式切换。切换时清空任务详情、token、pipeline、路由草稿、日志选择、输入/回答、合并确认和提示；未加载完成时禁用相关写操作，旧写操作反馈不会更新新项目或新任务。卸载时清理全部轮询并使请求失效；手动刷新覆盖当前页数据源。
- `index.js`：紧接 flow 增加 `/agentline/pipeline`、`/agentline/catalog` 两条 GET 路由，非 GET 返回 405。浏览器无法直接读取本机控制面文件，因而按设计转发既有只读模块；仅返回摘要、归一化目录和发现概况，不返回原始配置或凭据。既有十二条路由及其他 Host 逻辑未改。

自测使用 acceptance.md 原断言，未修改验收内容：

- AC-1、AC-2：两个文件 `node --check` 退出码均为 0，无输出。
- AC-3 至 AC-8：分别输出 `OK tabs+home`、`OK legacy ops`、`OK no mock data`、`OK empty states`、`OK settings+slash`、`OK host routes 14`。
- AC-9：输出 `OK render 5 tabs`、`OK data projection+navigation`，覆盖默认首页、五页渲染、空/有会话/失败、Provider 投影和跨项目回答导航。
- AC-10：输出 `OK host routes runtime`，覆盖空/已有会话、发现目录、四种写方法被拒绝、旧 projects 路由，以及隔离目录内容在请求前后完全一致。夹具仅在系统临时目录创建并由原验收代码清理。
- AC-11：在 orchestrator 目录直接执行 `node --test`，退出码 0；`# tests 71`、`# pass 64`、`# fail 0`、`# skipped 7`。既有测试内部使用系统临时目录的 git 夹具。
- 补充内存测试未创建测试文件：输出 `OK async project+task+log isolation, write feedback and unmount guards`；覆盖旧 tasks/token/pipeline/routing 响应、跨任务详情、日志模式响应、迟到合并反馈及卸载回写保护。另输出 `OK mount, settings project switch, repeated task IDs and timer cleanup`，验证挂载、设置页切项目、跨项目同号任务、六个轮询计时器及卸载清理。
- 两个产品文件均无 UTF-8 BOM。仓库不存在 `scripts/check-fast.ps1`。

执行环境限制：工具参数指定 pwsh 后实际仍启动 Windows PowerShell 5.1，且当前工具环境无法找到 pwsh 7。因此未将其视为规定的 pwsh 验收环境；AC-1 至 AC-10 通过 Node 从验收 Markdown 在内存提取并执行原 JavaScript 断言，AC-11 直接执行同一 Node 测试命令，未创建仓库内脚本。完整 pwsh 7 命令仍需下游复核。用户明确禁止执行 git 命令，因此未执行 AC-12 的两条 git 范围检查，未声称已通过该项；写入操作仅针对上述两个产品路径及本报告。DSH 内的人工布局与操作抽查留给 review。

沿用设计已知限制：`pipeline.mjs` 的 `st.origin?.kind || st.origin?.blueprint ? 'blueprint' : …` 存在运算符优先级问题，任意非空 origin.kind 都可能被核心标记为 blueprint；UI 原样展示，未越过 write_scope 修改核心。Studio/Blueprint 状态机和 gate 详情仍未实现。

本次复核保留工作区已有的五个 Tab、Build 操作和只读 Host 路由，仅补充修正 `client.js` 首页“现在卡在哪”的兜底分支：summary 无待处理项但 live 请求尚未完成时显示“读取中…”，live 失败时显示该数据源错误，成功且为空才显示“没有需要你处理的事项。”。已有阻塞、问题和合并待办仍优先展示，符合 design.md 对加载、错误和空数据分支的要求；本次没有再次修改 `index.js`。

修正后重新执行 AC-1 至 AC-10 的全部原 JavaScript 断言，退出码均为 0，输出与验收期望一致；未修改验收断言。补充内存快照验证 live 加载、失败、成功为空及问题优先级，输出 `OK live loading+failure+empty priority`。本次 orchestrator `node --test` 退出码为 0，汇总仍为 71 tests、64 pass、0 fail、7 skipped。再次确认两个产品文件无 BOM，且不存在 `scripts/check-fast.ps1`。工具仍未提供可用的 pwsh 7，故通过 Node 直接执行原断言；未执行 AC-12 的 git 命令，未创建仓库内测试文件，DSH 人工观察仍待 review。

本轮复核保留现有产品实现：两条 Host 路由均为只读转发，非 GET 返回 405；客户端已有五页、数据投影与请求代次保护。再次执行两个 `node --check` 均退出 0；在 orchestrator 目录直接运行 `node --test` 输出 71 项、64 通过、0 失败、7 跳过。测试内部调用了 Git 夹具，发现后未继续执行任何 Git 范围检查。本轮环境未找到 PowerShell 7，未重新运行验收中的 PowerShell 多步骤脚本，也未复核 DSH 中的实际布局和交互；上文其他检查结果为此前工作区记录，不代表本轮重跑。
