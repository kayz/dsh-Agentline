# P6–P8：AgentLine 控制面与角色/模型 UI

## 目标

在 P5 驾驶舱壳的基础上，按 `docs/blueprint/20261106-agentline-plugin/mockups/index.html` 的 UI 设计严格实现：

- **P6 Studio 控制面**
- **P7 Blueprint 控制面**
- **P8 Build 接入**
- **修正设置页**：渠道/模型不能平铺；角色不能只有 design/dev/review。

## 必读

- `docs/blueprint/20261106-agentline-plugin/mockups/index.html`
- `docs/blueprint/20261106-agentline-plugin/mockups/README.md`
- `docs/blueprint/20261106-agentline-plugin/design-v1.md` §5
- `docs/design/agentline-v2-baseline.md`
- `docs/design/k1-step.md`
- 当前 `plugin/lib/client.js`、`plugin/lib/index.js`
- `orchestrator/lib/pipeline.mjs`、`routing.mjs`、`config.mjs`、`models.mjs`、`step.mjs`

## P6：Studio 控制面

实现最小但真实的状态机：

- `.collab/studio/<id>/session.json`
- `agentline studio new|run|answer|conclude|status`
- 角色：`expert_a`、`expert_b`、`expert_c`、`moderator`、`scribe`
- 轮次：专家 → 主持 → 问题 → 书记 → 确认
- 每步只执行一个动作；不自动连续跑
- `questions.json`、`decisions.json`、`confirmations/`、`minutes-*.md`
- G0 gate：可机器校验的 checks，批准/默认需用户明确采用
- 插件 Studio 页读取真实 session，不再伪造状态

## P7：Blueprint 控制面

- `.collab/blueprint/<id>/state.json`
- `agentline blueprint new|run|review|approve|materialize|status`
- 角色：`designer`、`reviewer`、`test_architect`
- 设计 → 测试架构 → 评审；每轮停下等待用户/继续
- `task-graph.json`、`acceptance-matrix.md`、`review-vN.json`
- G1 gate：任务字段、依赖无环、AC 双向覆盖、模型隔离、内容哈希批准
- 插件 Blueprint 页读取真实轮次、findings、任务图、Gate

## P8：Build 接入

- 复用 K1 `runStep` / `runBuild`
- Build 任务来源：Blueprint task graph / 独立任务
- 新增角色：`designer`、`developer`、`verifier`（Build 内部），保留旧 design/dev/review 兼容
- 插件 Build 页按真实状态显示：来源、test_levels、T gate、模型、业务轮次/基础设施重试
- 不重写 `flow.mjs` 旧语义；K1 是 Build 的新入口

## UI 严格要求

设置页必须改为：

1. **模型目录按渠道分组**：Claude / Codex / CodeBuddy / Cursor / Gemini；可折叠；
2. **角色矩阵按阶段分页/分表**：
   - Studio：expert A/B/C、moderator、scribe
   - Blueprint：designer、reviewer、test_architect
   - Build：designer、developer、verifier
3. 每个角色显示：主选、备选、档位要求、约束、probe 状态；
4. 模型目录显示：模型、渠道、id、档位、身份、可用性、来源；
5. 不再把角色硬编码为只有 design/dev/review；
6. 渠道/模型不能平铺成长列表，必须有分组、折叠、筛选；
7. 严格保留 P5 的五 Tab、Inbox、项目组合和既有任务操作。

## 验收

- `node --check plugin/lib/client.js` / `plugin/lib/index.js`
- `node --test`（orchestrator）通过
- Studio：`studio new` 创建 session，`studio run` 只前进一步，`studio answer` 记录回答
- Blueprint：`blueprint new` 创建 state，`blueprint run` 只前进一步，G1 可求值
- Build：新任务可走 `build step` / `runBuild` 到 pr_open
- UI 静态断言：
  - 渠道分组存在（Claude/Codex/CodeBuddy/Cursor/Gemini）
  - 角色矩阵包含 11 个角色，不只 3 个
  - 五 Tab、Inbox、项目组合仍在
- 不能删除 P5 已有操作和只读路由

## 约束

- 不要修改 `flow.mjs` 的旧语义；K1 独立。
- 不伪造 Studio/Blueprint 数据；没有真实 session 时显示空状态。
- 不引入构建步骤；保持现有 React `h` 写法。
- 每完成一个阶段提交一次，最后统一 PR。
- 当前 P5 已有代码在 `main`，从 `main` 创建 `task/002`。
