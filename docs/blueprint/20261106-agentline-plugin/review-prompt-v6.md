你是 AgentLine Blueprint 20261106 的独立终审者（GPT-6 Astra）。这是最终契约修补 v6 的复核。

请合并审核：
- `docs/blueprint/20261106-agentline-plugin/design-v1.md`
- `docs/blueprint/20261106-agentline-plugin/design-v2-delta.md`
- `docs/blueprint/20261106-agentline-plugin/design-v3-delta.md`
- `docs/blueprint/20261106-agentline-plugin/design-v4-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v5-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v6-contract.md`
- `docs/blueprint/20261106-agentline-plugin/review-v5.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`

审核范围：
1. review-v5 的 B1-1、B1-2、B1-3、M4 是否关闭。
2. C_auth/adopt、系统 note 确定性 id、输入锁/旧 CLI 并发、晚到归档、POSIX 终止证明、旧 cmdRun 后代保留是否形成唯一恢复契约。
3. 是否引入新的循环、范围膨胀或不可实现承诺。
4. 是否足以进入实现切分。

输出：
# AgentLine Blueprint 20261106 — Review v6
## Verdict
APPROVE | REVISE | REJECT
## Blocking
## Major
## Minor
## Review-v5 逐项核对
## 新引入的问题
## 是否可进入实现切分
（yes/no + 前置条件）
## 仍需用户裁决的问题

规则：
- 不重写设计，不写产品代码。
- 只有影响可执行性/正确性/范围控制的问题才 blocking。
- 如果只剩实现细节，给 APPROVE，并标为“实现前契约整理”。
- 不再要求新架构。
