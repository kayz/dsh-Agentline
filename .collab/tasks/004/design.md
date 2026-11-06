---
write_scope:
  - orchestrator/agentline.mjs
  - orchestrator/lib/**
  - orchestrator/test/**
  - plugin/lib/**
  - plugin/test/**
---

# P7：Blueprint 控制面

从 P6 合并后的 main 开始，P6 未合并前不启动实现。复用 Studio 的角色、渠道、阶段执行与配置，不重写 Studio、Build 或旧 flow。dev 使用 `cursor-wsl-grok-4.7`。参考 `docs/design/agentline-v2-baseline.md` 和其指向的后续 delta；本 brief 的单步要求优先于旧文档的一次运行整轮描述。

## 控制面

- 在 orchestrator 实现 `agentline blueprint new|run|review|approve|materialize|status`，沿用现有 CLI 参数及错误约定。以项目内 `.collab/blueprint/<id>/state.json` 和关联文件为准；校验 ID 和路径，禁止覆盖已有会话，损坏或缺失数据须报告错误。`status` 只读。使用真实配置的三个角色和现有只读阶段执行能力，不以样例冒充调用结果。
- 每轮依次 design → testability → review；每次命令最多完成一个角色步骤，持久化后返回，失败不推进。`run` 推进下一步骤；`review` 仅在下一步骤为 review 时执行，不能绕过前置步骤。重启后恢复，未通过时由用户再次调用开始下一轮；最多三轮，耗尽时停止，不自动批准。
- 生成并读取 `task-graph.json`、`acceptance-matrix.md`、各轮 `review-vN.verdict.json` 和测试架构结果。任务图字段及格式遵循既有蓝图规范；findings 的状态和阻塞性须可机器判断。失败、缺失或无效输出不可视为通过。
- G1 从落盘内容重新求值，逐项验证任务必需字段、ID 唯一和引用有效、依赖无环、全局 AC 与任务双向覆盖、矩阵中 AC 和测试层级与任务图一致、最后一轮评审通过且无未解决阻塞 finding、testability 无未解决 blocker、轮次限制，以及三角色 top、模型两两不同、设计与评审跨厂商和实际身份验证。缺失身份或证据不得当通过；测试架构跨厂商按基线偏好处理。保留既有来源 G0 和只读约束，不能伪造证据。
- 批准由用户显式提交并绑定所见内容哈希。哈希覆盖任务图、矩阵、设计、测试架构结果、最终评审、角色和来源等影响 G1 的证据；稳定计算并记录内容集合。批准及 materialize 前重新读取并计算 G1 和哈希；内容变化、来源失效或证据无效即批准失效，须重新评估并批准。
- materialize 仅在当前 G1 及批准有效时执行；映射节点为现有 Build 任务，生成 brief 和来源映射，保留映射后的依赖、输入、输出、write_scope、AC 内容、可执行验收方向及测试层级，不只复制 AC ID。预先检查目标冲突与全部输入，失败不得留下部分任务或覆盖已有任务；重复执行不得重复创建。不得改写 Build 实现。

## UI

Blueprint 页面通过现有插件读取和调用控制面，展示实际轮次、角色、findings、任务图及逐项 Gate、批准有效性和物化结果；空数据、读取损坏和操作错误分别显示，可重试，不显示虚构示例。切换项目重新读取；动作一次转发一次 CLI，失败显示原因。保留五 Tab、Studio、Build、Inbox、项目组合及旧任务行为，不增加前端构建步骤。

## 验收

下游提供独立 Node 测试 `orchestrator/test/blueprint-cli.test.mjs`、`orchestrator/test/blueprint-g1.test.mjs`、`plugin/test/blueprint-ui.test.mjs`。使用隔离临时目录和可注入的确定性 adapter，不依赖网络、真实账户或真实项目数据；断言实际 CLI、落盘、Gate 和 UI 行为，不只匹配源码。CLI 测试覆盖六个命令、单步顺序、失败恢复、冲突、物化保真及批准失效后重新批准；G1 测试逐项构造正反例，包括缺字段、悬空依赖、环、双向 AC、矩阵、身份与模型隔离、评审和 testability、内容变更；UI 测试驱动真实路由及渲染交互，覆盖真实、空、错误、项目切换与现有功能。验收命令见 acceptance.md。
