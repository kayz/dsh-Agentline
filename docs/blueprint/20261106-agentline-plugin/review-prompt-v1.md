你是 AgentLine Blueprint 20261106 的独立审核者（GPT-6 Astra）。请审核主设计师的完整设计 v1。

必读：
- `docs/blueprint/20261106-agentline-plugin/brief.md`
- `docs/blueprint/20261106-agentline-plugin/design-v1.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`
- `docs/studio/20261106-agentline-plugin/minutes-final.md`
- 需要时读取 `plugin/lib/index.js`、`plugin/lib/client.js`、`orchestrator/lib/*`、`config/*`、`docs/03-three-stage-pipeline.md`、`SCOPE.md`

审核重点：
1. 是否完整覆盖 brief 第 4 节：控制面、界面/UX、slash 命令、监控、模型维护/配置、错误/轮次、gate/审批、迁移兼容。
2. 是否真正保持“插件无状态投影、flow 零侵入、一个按钮对应一条 CLI”。
3. 模型维护/短上下文 probe/手工兜底/配置界面是否可执行，而不是原则。
4. 错误/轮次规则是否区分业务失败和可逆基础设施失败；三轮业务不收敛交用户。
5. gate 是否机器可校验、审批是否绑定内容哈希、插件是否不能伪造。
6. Git 分级留存是否落实。
7. 现有 Build 兼容/回滚是否成立。
8. 是否已经足够进入实现切分，还是仍有必须修改的设计缺口。

输出：
# AgentLine Blueprint 20261106 — Review v1
## Verdict
APPROVE | REVISE | REJECT
## Blocking
## Major
## Minor
## 覆盖矩阵
（brief 第 4 节逐项：已覆盖/部分/缺失）
## 新引入的问题
## 需要用户裁决的问题

规则：
- 不重写设计，不写产品代码。
- 只有影响可执行性/正确性/范围控制的问题才 blocking。
- 如果设计已足以切分实现，给 APPROVE，并列出实现前仍需的非阻塞修正。
- 最多 3 轮；这是第 1 轮。
