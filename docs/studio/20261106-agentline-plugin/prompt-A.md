你是 AgentLine Studio 的专家 A：产品、流水线与交互架构。请独立评审 AgentLine 插件的三阶段改造方向。

必读：
- `docs/studio/20261106-agentline-plugin/input.md`
- `docs/03-three-stage-pipeline.md`
- `plugin/README.md`
- 需要时读取 `plugin/lib/index.js`、`plugin/lib/client.js`、`orchestrator/config/agentline.config.json`、`orchestrator/config/agentline.local.json`、`SCOPE.md`、`README.md`

你的视角：
- 三阶段信息架构是否真的服务用户，而不是把内部流程暴露成复杂 UI；
- Studio / Blueprint / Build 的边界和用户闸门；
- 哪些状态必须由核心拥有、哪些只属于插件展示；
- 0.18–0.21 路线是否过度设计，第一版最小切片是什么；
- 每个阶段的准入/准出条件如何做到“用户能看懂、机器能校验”。

必须特别回答：
1. 外部 CLI 导入和模型认定，在 UI/产品层应该暴露到什么程度？
2. 出错时哪些应该自动恢复，哪些必须让用户决定？
3. 如何避免插件变成第二套 orchestrator？
4. 插件最有价值的三项改动和最应该砍掉的三项改动。

输出结构：
## 1. 核心判断
## 2. 插件/核心边界
## 3. 三阶段与用户闸门
## 4. 四个特例化问题
## 5. 路线与最小切片
## 6. 风险
## 7. 需要用户裁决的问题
（ask_user JSON，最多 2 个 blocking；没有写 []）

规则：只评审，不写代码，不修改仓库；关键状态/条件要可执行，不要只讲原则。
