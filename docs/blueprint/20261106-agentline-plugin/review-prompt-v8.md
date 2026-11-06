你是 AgentLine Blueprint 20261106 的独立终审者（GPT-6 Astra）。这是**最后一轮局部修补**的最终复核；若仍不能通过，由用户决定冻结范围或带着已知问题进入实现，不再开新一轮设计。

请合并审核：
- `docs/blueprint/20261106-agentline-plugin/design-v1.md`
- `docs/blueprint/20261106-agentline-plugin/design-v2-delta.md`
- `docs/blueprint/20261106-agentline-plugin/design-v3-delta.md`
- `docs/blueprint/20261106-agentline-plugin/design-v4-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v5-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v6-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v7-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v8-contract.md`
- `docs/blueprint/20261106-agentline-plugin/review-v7.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`
- 必要时核对源码：`orchestrator/agentline.mjs`、`orchestrator/lib/{inputs,lock,exec,flow,worktree}.mjs`

审核范围：
1. review-v7 的 B7-1（hidepid 可见性，含第二层与 drain 来源 (f)）、B7-2（时间基准：boot_id/btime、starttime tick、绝对时间；同 boot 第三层不放行）、B7-3（损坏输入锁的恢复与并发接管）是否关闭；各自反例是否有唯一结果和验收。
2. review-v7 的四项 Minor（清零夹具候选范围、L-cur 边界、状态表时机、合并稿）是否得到必要整理。
3. v8 是否引入新矛盾或范围膨胀（重点核对：§3 输入锁按 inode/文件名识别持有者与 boot 分区；§4.1 扫描者自身排除规则；§4.3 按阶段的第 6、7 行）。
4. v8 §6.2 的 U-W1 是否确属需用户裁决的新问题，还是应当阻塞。
5. 设计是否足以进入实现切分。

输出：
# AgentLine Blueprint 20261106 — Review v8
## Verdict
APPROVE | REVISE | REJECT
## Blocking
## Major
## Minor
## Review-v7 逐项核对
## 新引入的问题
## 是否可进入实现切分
（yes/no + 前置条件）
## 仍需用户裁决的问题

规则：
- 不重写设计，不写产品代码。
- 只有影响可执行性/正确性/范围控制的问题才 blocking；每个 blocking 必须给出具体反例。
- 如果只剩实现细节，给 APPROVE，并标为“实现前契约整理”。
- 不再要求新架构；不再重裁 S1/D1–D4。
