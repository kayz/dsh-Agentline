你是 AgentLine Blueprint 20261106 的独立审核者（GPT-6 Astra）。第 2 轮设计以 `design-v1.md` + `design-v2-delta.md` 合并审核。

必读：
- `docs/blueprint/20261106-agentline-plugin/brief.md`
- `docs/blueprint/20261106-agentline-plugin/design-v1.md`
- `docs/blueprint/20261106-agentline-plugin/review-v1.md`
- `docs/blueprint/20261106-agentline-plugin/design-v2-delta.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`

审核范围：
1. review-v1 的 B1–B4 是否真正关闭，不是改措辞。
2. M1–M6 是否补齐。
3. v2 是否引入新矛盾、范围膨胀或不可实现承诺。
4. 设计是否已经足以进入实现切分；如仍差，必须区分“可在实现中处理”和“必须设计前解决”。

输出：
# AgentLine Blueprint 20261106 — Review v2
## Verdict
APPROVE | REVISE | REJECT
## Blocking
## Major
## Minor
## Review-v1 逐项核对
## 新引入的问题
## 是否可进入实现切分
（yes/no + 前置条件）
## 需要用户裁决的问题

规则：
- 不重写设计，不写产品代码。
- 只有影响可执行性/正确性/范围控制的问题才 blocking。
- 如果只剩非阻塞改进，给 APPROVE。
- 这是第 2 轮，最多 3 轮。
