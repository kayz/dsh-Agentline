---
write_scope:
  - orchestrator/agentline.mjs
  - orchestrator/lib/**
  - orchestrator/test/**
  - orchestrator/config/**
  - plugin/lib/**
  - plugin/test/**
  - plugin/locale/**
---

# P8：Build 接入

从 P7 合并后的 main 开始；P7 未合并前不启动实现。dev 使用 `cursor-wsl-grok-4.7`（WSL Cursor）。遵循 `docs/design/agentline-v2-baseline.md` 及其后续 delta，复用现有契约，不更改 `flow.mjs` 旧语义。

## 目标

- Build 控制面复用 K1 的 `runStep` / `runBuild`，单步只执行一个步骤，完整运行沿现有状态机到 `pr_open`；保留 worktree、锁、容量、恢复和终止证明约束，失败不推进。旧任务和旧 `design`/`dev`/`review` 配置继续可用，新角色 `designer`/`developer`/`verifier` 映射至对应阶段；配置冲突或缺失明确报错。
- Blueprint 物化任务以 `origin.json` 和当前 Blueprint 落盘证据为准：每次执行步骤前重新求值 G1 和批准，核对来源中的批准、节点及 `node_sha256` 与当前任务图的规范哈希；缺失、损坏、撤销、过期、节点变更或映射不一致均拒绝执行，不调用模型、不推进状态。完整运行和直接单步入口均执行校验。没有 Blueprint 来源的旧任务继续走原有路径；存在但损坏的来源不能当成旧任务放行。
- 角色锁约束实际 adapter 的模型选择和每次物理调用；调用返回的实际模型身份写入证据并参与 T gate。身份缺失、不可验证或与锁不符不得通过隔离检查；重试不能绕过锁。沿用已有角色锁、模型目录及调用记录约定，不伪造实际身份。
- 核心依据真实证据求值 Build T gate，包括来源、CI、review、隔离和证据新鲜度；不可豁免检查不能被豁免。`T.ci_all_pass` 在报告不存在、损坏、空报告、缺少必要结果或无法判定时为未知且不通过；只有有效、非空且全部通过的对应证据才能通过，有明确失败时失败。保持既有通用 gate 契约兼容。
- 控制面只读投影真实来源、节点的 `test_levels`、T gate、状态、实际模型、业务轮次和基础设施重试；缺失显示未知，损坏和读取失败显示错误。可逆基础设施重试与业务轮次分别计数，重试不消耗业务轮次，每次物理调用保留证据；未知副作用或无法证明终止时不自动重放。插件只通过既有公开接口读取并渲染，不直接修改 `.collab`；Build 页支持真实、空、错误和项目切换状态，不使用示例数据。保留现有页面及旧任务行为。

## 验收格式（必须）

下游新增 `orchestrator/test/build-source.test.mjs`、`orchestrator/test/build-execution.test.mjs`、`orchestrator/test/build-gate.test.mjs`、`orchestrator/test/build-roles.test.mjs` 和 `plugin/test/build-ui.test.mjs`。使用隔离临时仓库和确定性 adapter，不依赖网络、真实账户或项目；断言真实入口、落盘与 UI 行为，而非仅匹配源码。来源测试覆盖有效批准、未批准、撤销/过期、节点修改、缺失/损坏来源与旧任务，并在拒绝时断言模型调用次数为零；执行测试覆盖单步、完整运行至 `pr_open`、失败不推进及既有锁/恢复约束；gate 测试覆盖缺失、损坏、空、部分、失败、全部通过及过期证据；角色测试覆盖新旧角色、锁与实际调用一致、身份缺失/不符和重试；UI 测试覆盖真实、空、错误、重试、项目切换与既有功能。各测试验证对应正反例及状态、证据和 gate 的一致性。验收命令见 acceptance.md。
