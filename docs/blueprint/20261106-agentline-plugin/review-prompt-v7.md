你是 AgentLine Blueprint 20261106 的独立终审者（GPT-6 Astra）。这是最终局部收口复核。

请合并审核：
- `docs/blueprint/20261106-agentline-plugin/design-v1.md`
- `docs/blueprint/20261106-agentline-plugin/design-v2-delta.md`
- `docs/blueprint/20261106-agentline-plugin/design-v3-delta.md`
- `docs/blueprint/20261106-agentline-plugin/design-v4-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v5-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v6-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v7-contract.md`
- `docs/blueprint/20261106-agentline-plugin/review-v6.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`

审核范围：
1. review-v6 的 B6-2 是否关闭。
2. S1（S1-1=A、S1-2=A）是否按用户决定落地，W7a/W16/验收边界是否同步。
3. L-cur 输入锁、reserved ID、清零验收夹具、合并稿清理是否关闭。
4. 是否引入新矛盾或范围膨胀。
5. 设计是否足以进入实现切分。

输出：
# AgentLine Blueprint 20261106 — Review v7
## Verdict
APPROVE | REVISE | REJECT
## Blocking
## Major
## Minor
## Review-v6 逐项核对
## 新引入的问题
## 是否可进入实现切分
（yes/no + 前置条件）
## 仍需用户裁决的问题

规则：
- 不重写设计，不写产品代码。
- 只有影响可执行性/正确性/范围控制的问题才 blocking。
- 如果只剩实现细节，给 APPROVE，并标为“实现前契约整理”。
- 不再要求新架构；不再重裁 S1/D1–D4。
