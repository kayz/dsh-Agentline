你是 AgentLine Blueprint 20261106 的主设计师（Claude Opus 5.5）。用户已授权继续局部契约修补。请阅读：

- `docs/blueprint/20261106-agentline-plugin/design-v7-contract.md`
- `docs/blueprint/20261106-agentline-plugin/review-v7.md`
- `docs/blueprint/20261106-agentline-plugin/design-v6-contract.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`
- 仅需的源码：`inputs.mjs`、`lock.mjs`、`exec.mjs`、`flow.mjs`、`agentline.mjs`

输出 `design-v8-contract.md`，**只修 review-v7 的三个 blocking**，不重开架构、不新增范围：

1. **B7-1 hidepid 可见性**：按实际 hidepid 模式定义枚举完整性；无法证明完整可见性就 `unknown(enum_visibility)`。覆盖第二层证明与 drain 来源 (f)。给出“匹配 gid、仍有隐藏后代”的反例。
2. **B7-2 时间基准**：持久化身份同时记录 boot_id/btime、starttime tick 和可比较绝对时间；第二层用 tick，第三层用 boot_id + 绝对时间；同一 boot 不能由第三层放行；缺失信息返回 `unknown`。给出“同 boot 不得放行”和“重启后可放行”的验收。
3. **B7-3 损坏锁恢复**：锁损坏时不得直接删除；必须证明原持有者已终止（用同一终止证明/身份）并防止并发恢复误删新锁；证明不了就 blocked/unknown。给出“锁损坏但原持有者仍存活”的反例。
4. 仅在必要处修 Minor（清零夹具候选范围、L-cur 边界、状态表时机、合并稿），不要扩大。

要求：
- 只写替换/新增章节，不重写全文；不写产品代码。
- 每个 blocking 给唯一恢复结果和验收例子。
- 不询问 D1–D4/S1；如仍有必须用户裁决的新问题单列。
- 完成后交 GPT-6 Astra 最终复核；这是**最后一轮局部修补**，若仍不能通过，则由用户决定冻结范围或进入实现。
