你是 AgentLine Blueprint 20261106 的独立审核者（GPT-6 Astra）。这是第 3 轮、也是协议内最后一轮审核。

请合并审核：
- `docs/blueprint/20261106-agentline-plugin/design-v1.md`
- `docs/blueprint/20261106-agentline-plugin/design-v2-delta.md`
- `docs/blueprint/20261106-agentline-plugin/design-v3-delta.md`
- `docs/blueprint/20261106-agentline-plugin/review-v2.md`
- `docs/blueprint/20261106-agentline-plugin/brief.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`

审核范围：
1. review-v2 的 B1/B2/B4 和 M2/M3/M4/M5 是否关闭。
2. v3 的 K1（修改 flow 新增 runStep）是否清楚标为需要用户裁决，是否真的能兑现三轮/恢复/逐调用证据。
3. G2 固定快照、合并封存拓扑（普通合并，补封存移出范围）是否成立。
4. 角色锁、Git MainWrite、drain、兼容矩阵是否闭合。
5. v3 是否引入新矛盾或范围膨胀。

输出：
# AgentLine Blueprint 20261106 — Review v3
## Verdict
APPROVE | REVISE | REJECT
## Blocking
## Major
## Minor
## Review-v2 逐项核对
## 新引入的问题
## 是否可进入实现切分
（yes/no + 前置条件）
## 需要用户裁决的问题

规则：
- 不重写设计，不写产品代码。
- 只有影响可执行性/正确性/范围控制的问题才 blocking。
- 如果只剩非阻塞改进，给 APPROVE。
- 这是第 3 轮；如仍 REVISE，明确剩余项是“可带条件切分”还是“必须再设计”。
