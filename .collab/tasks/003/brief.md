# P6：Studio 控制面 + 渠道/11 角色 UI

## 目标

从 `main` 实现 P6。不要把 P7/P8 一起做；P7/P8 是后续独立 Build。

P6 包含两部分：

1. **Studio 控制面**：真实的会话、专家/主持/书记、问题、决策、G0。
2. **共享 UI 修正**：渠道/模型按渠道分组；角色矩阵展示全部 11 个阶段角色，不再只有 design/dev/review。

## 必读

- `docs/blueprint/20261106-agentline-plugin/mockups/index.html`
- `docs/blueprint/20261106-agentline-plugin/design-v1.md` §5
- `docs/design/agentline-v2-baseline.md`
- 当前 `plugin/lib/client.js`、`plugin/lib/index.js`
- `orchestrator/lib/pipeline.mjs`、`routing.mjs`、`config.mjs`

## Studio 控制面

- `.collab/studio/<id>/session.json`
- 命令：`agentline studio new|run|answer|conclude|status`
- 角色：`expert_a`、`expert_b`、`expert_c`、`moderator`、`scribe`
- `run` 每次只前进一步；不自动连续跑
- `moderator` 产生阻塞问题时停为 `awaiting_user`；`answer` 后才继续
- 用户确认/采用默认必须显式记录；不能把未回答问题当 confirmed
- 专家确认必须逐步收集，不能由 moderator 代写
- G0 gate 机器可校验：minutes-final、决策、专家确认、无 open blocking、轮次≤2、书记≠主持模型
- 持久化 `questions.json`、`decisions.json`、`confirmations/`、`minutes-final.md`

## UI

- 渠道分组：Claude / Codex / CodeBuddy / Cursor / Gemini，可折叠、可筛选
- 模型列：模型、渠道、id、档位、身份、可用性、来源
- 角色矩阵三个阶段：
  - Studio：expert_a、expert_b、expert_c、moderator、scribe
  - Blueprint：designer、reviewer、test_architect
  - Build：designer、developer、verifier
- 每个角色显示主选、备选、档位要求、约束、probe
- Studio 页读取真实 session，提供 new/run/answer/conclude 操作；没有数据时显示空状态
- 保留五 Tab、Inbox、项目组合和旧任务操作
- 不伪造 Blueprint/Build 状态；它们可以保持只读/未实现

## 验收格式

`acceptance.md` 必须使用可被 `tools/ci-runner.ps1` 解析的格式：

```text
## AC-1 ...
```pwsh
...命令...
```
期望：...
```

至少覆盖：

1. 插件/client/index 语法；
2. Studio CLI new/run 单步/answer/conclude；
3. G0 正反例；
4. UI 五渠道分组、11 角色、Studio 真实/空/错误状态；
5. orchestrator 完整回归。

## 约束

- 从 `main` 创建 `task/003`。
- 只做 P6；P7/P8 不进入本任务。
- 不修改 `flow.mjs` 旧语义。
- 不新增前端构建步骤。
- 当前 dev 使用 `deepseek-v4-pro`。
