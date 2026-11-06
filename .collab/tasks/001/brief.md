# P5：AgentLine 驾驶舱 UI 按原型落地

## 目标

把 AgentLine 插件驾驶舱从“单页任务列表”升级为 `docs/blueprint/20261106-agentline-plugin/mockups/index.html` 所表达的 Tab 式驾驶舱。  
P5 首先完成可用的 UI 壳和真实数据接入；不要继续在旧布局上打补丁。

## 必读

- `docs/blueprint/20261106-agentline-plugin/mockups/index.html`
- `docs/blueprint/20261106-agentline-plugin/mockups/README.md`
- `docs/blueprint/20261106-agentline-plugin/design-v1.md` §5（界面、UX、slash）
- `plugin/lib/client.js`（当前 UI）
- `plugin/lib/index.js`（Host 路由）
- `docs/design/agentline-v2-baseline.md`

## 范围

在 `plugin/lib/client.js` 中实现：

1. **Tab 壳**：首页 / Studio / Blueprint / Build / 设置；窄屏可横向滚动。
2. **首页 Inbox**：
   - 现在卡在哪；
   - 待处理卡片（阻塞、问题、可批准）；
   - 项目组合（多项目、每项目任务总数/进行中/最近状态）；
   - 运行中与最近事件。
3. **Studio 页**：读取现有 `.collab/studio` 数据；没有数据时显示空状态；不伪造状态。
4. **Blueprint 页**：读取现有 `.collab/blueprint` 数据；没有数据时显示“未开始/未实现”；不伪造 gate。
5. **Build 页**：保留现有任务列表 + 阶段轨迹 + 日志 + 合并/控制动作；增加项目列/来源/T gate/模型信息（有数据才显示）。
6. **设置页**：现有角色路由/模型矩阵迁入设置 Tab；新增 Provider/模型目录的只读展示（有数据才显示）。
7. **斜杠命令面板**：保留/展示 `/agentline ...` 的命令入口与说明，不实现新的写命令。
8. **多项目切换**：复用 `/agentline/projects`，点击项目组合卡片切换当前项目。
9. **兼容**：现有任务操作（启停/输入/回答/合并/分档）不能丢失；不破坏 `plugin/lib/index.js` 旧路由。

## 非目标

- 不新增 Studio/Blueprint 的完整 Host 状态机；
- 不伪造 Studio/Blueprint 的轮次、gate、审批数据；
- 不重写 AgentLine 内核；
- 不实现新的 merge/gate 语义。

## 验收

- `node --check plugin/lib/client.js` 通过；
- `node --test`（orchestrator）通过；
- 静态检查 client.js 包含 `首页`、`Studio`、`Blueprint`、`Build`、`设置` 和 `项目组合`；
- 现有 `ProjectTask` 列表/详情操作仍存在；
- 没有数据时显示空状态，不显示假数据。

## 约束

- 只改插件前端；如需 Host 小改动，先说明并只做只读路由。
- 保持 React 通过现有 `require('react')` + `h` 写法，不引入构建步骤。
- 保持现有深色/CSS 变量风格。
- 不修改 `docs/` 之外的设计基线。
