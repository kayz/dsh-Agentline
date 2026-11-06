## 1. 核心判断

1. **三阶段方向成立，但当前提案存在一条致命的架构边界冲突，必须先裁断再动工**：
   - [SCOPE.md](file:///C:/git/dsh-Agentline/SCOPE.md#L5-L6) 与 [03-three-stage-pipeline.md](file:///C:/git/dsh-Agentline/docs/03-three-stage-pipeline.md#L6) 明确规定：**“内核仍然只负责一个 Build 任务；Studio 和 Blueprint 是可选的上游控制面，不属于内核”**；而 [input.md](file:///C:/git/dsh-Agentline/docs/studio/20261106-agentline-plugin/input.md#L75) 却要求“Studio/Blueprint 应先在 AgentLine 核心有正式命令和状态机”。
   - **裁断建议**：严禁把 Studio/Blueprint 塞进单任务执行器 [`runFlow`](file:///C:/git/dsh-Agentline/orchestrator/lib/flow.mjs#L61-L406)，也严禁塞进插件 Host（[plugin/lib/index.js](file:///C:/git/dsh-Agentline/plugin/lib/index.js)）。应在 `orchestrator/` 同仓新增独立的控制面模块（如 `agentline studio` / `agentline blueprint` 子命令，与 `flow` 平级解耦），**插件只做无状态投影与意图转发（Stateless Projection & Intent Relay）**。
2. **三阶段不是“三个页面”，而是把外部 CLI 的故障面放大了 3.6 倍**：
   - 单任务 Build 只有 3 个角色槽位（`design` / `dev` / `review`）；三阶段扩充为 **11 个角色槽位**（Studio 5 个 + Blueprint 3 个 + Build 3 个），横跨 4 个外部 CLI（Claude / Codex / CodeBuddy / Gemini）。
   - 现有代码里已经暴露的真实隐患——**OAuth refresh token 轮换互踢**（[collect.mjs](file:///C:/git/dsh-Agentline/plugin/lib/collect.mjs#L52-L55)）、**输出正则看门狗误杀**（[supervisor.mjs](file:///C:/git/dsh-Agentline/orchestrator/lib/supervisor.mjs#L7-L15)）、**恢复时默认清空未提交改动**（[flow.mjs](file:///C:/git/dsh-Agentline/orchestrator/lib/flow.mjs#L269-L272)）、**Codex 实际模型解析缺失**（[codex.mjs](file:///C:/git/dsh-Agentline/orchestrator/lib/adapters/codex.mjs#L121)）——在单任务里还能靠人看日志兜
<truncated 28267 bytes>
先锁定落点，0.18–0.20 的路由与目录契约无法开工。",
    "options": [
      "A（推荐）：同仓分层——在 orchestrator/ 下新增与 flow.mjs 平级解耦的 studio.mjs / blueprint.mjs，通过 agentline.mjs studio|blueprint 子命令暴露；Build 单任务内核（flow.mjs）保持零侵入，插件只通过 spawn CLI 调用",
      "B：独立控制面包——新建独立的 pipeline-cli 包管理 Studio/Blueprint，产出的 brief.md 再喂给现有的 agentline.mjs flow，插件同时调用两个 CLI",
      "C：修改 SCOPE.md——正式将 AgentLine 的定义从“单任务执行器”扩展为“三阶段全周期调度器”"
    ],
    "default": "A"
  },
  {
    "id": "Q2_COLLAB_GIT_RETENTION",
    "question": "Studio 的多轮讨论记录（rounds/）、用户回答（questions.json）及原始 CLI 日志（logs/）是否允许进入产品仓库的 git 提交历史？",
    "why_blocking": "当前 flow.mjs 在每个阶段结束时执行 commitAll 把 .collab/ 全部提交进分支并最终合入 main。但 Studio/Blueprint 包含未公开的商业决策、废弃方案及包含完整代码上下文的原始 Prompt 日志，一旦随 main 分支推送或开源将造成不可逆的数据暴露；若完全不进 git，则需要单独定义跨机器/恢复时的证据校验方式。",
    "options": [
      "A（推荐）：分级留存——仅定稿契约文件（minutes-final.md、decisions.md、architecture.md、task-graph.json、acceptance-matrix.md、state.json、run.json、verdict*.json）随 git 提交；过程原始日志（logs/、rounds/、handoff/）存放在 .git/agentline/artifacts/（或 gitignore），只在本地保留哈希索引供审计",
      "B：全量进 Git——所有 Studio/Blueprint 讨论轮次与日志均提交进产品仓库（仅适用于纯内部私有仓库）",
      "C：全量外置——整个 .collab/ 目录均不进入产品仓库 git 历史，全部存放在工作区外的控制面数据目录中"
    ],
    "default": "A"
  }
]
```