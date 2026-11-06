你是 AgentLine Blueprint 20261106 的主设计师（Claude Opus 5.5）。用户已裁决 D1–D4：

- D1=A：授权 K1（在 flow.mjs 增加 `runStep`，Supervisor 驱动循环；runFlow/exec 旧语义不变）；
- D2：允许人工登记模型身份例外，但必须持续标记 unverified；
- D3：允许显式追加轮次，每次只加一轮并记录 deviations；
- D4：接受本机 CLI 作为受信任审批入口，但明确这是账户信任约定，不是机器证明。

请阅读：
- `docs/blueprint/20261106-agentline-plugin/review-v3.md`
- `docs/blueprint/20261106-agentline-plugin/design-v3-delta.md`
- `docs/blueprint/20261106-agentline-plugin/design-v2-delta.md`
- `docs/blueprint/20261106-agentline-plugin/design-v1.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`
- 需要时读取 flow/exec/git/routing/inputs/check-task/plugin

输出 `design-v4-contract.md`，这是**局部契约收口**，不是第四轮范式重开。只修 review-v3 的 blocking/major：

1. **B1**：在 K1 下补齐崩溃恢复窗口：
   - call.end → 步骤提交 → step.end → round.close 的恢复结果；
   - 中断调用先归档日志/部分产物，再允许重试；
   - 同一 amendment 只开启一次 epoch；
   - 续跑前确认旧执行者已终止；
   - 给出具体 ledger/transaction 字段和验收例子。
2. **B4**：拆清 pre-merge T 与 post-merge final T；正常合并 `C→S→M→K` 的校验顺序；重入必须关联本次受控合并事务；缓存键/失效覆盖 K、可达性、批准状态。
3. **B5**：在 MainWrite 共享锁内做最终批准/来源/许可检查；materialize 计划与批准同事务边界。
4. **M3/M5**：MainWrite 拒绝目标路径已有未跟踪文件；失败恢复校验原定路径；drain 覆盖旧 cmdRun 和已准入未启动 worker。
5. Minor：命令名、预算措辞、G2 下游条件、合并稿清理。
6. 给出替换章节清单和审核检查清单。

要求：
- 不重写 105k 全文；只写可合并的契约变更。
- 每个 blocking 给验收例子。
- D1–D4 已授权，不要再把它们列为待裁决；只列仍然必须用户决定的新问题（如有）。
- 不写产品代码，不修改仓库。
- 完成后交 GPT-6 Astra 做最终契约复核；如果通过，再进入实现切分。

直接输出 Markdown 正文。
