你是 AgentLine Blueprint 20261106 的主设计师（Claude Opus 5.5）。用户已确认 D1–D4，且授权启动上一轮的局部契约修补。请阅读：

- `docs/blueprint/20261106-agentline-plugin/review-v4.md`
- `docs/blueprint/20261106-agentline-plugin/design-v4-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v3-delta.md`
- `docs/blueprint/20261106-agentline-plugin/design-v2-delta.md`
- `docs/blueprint/20261106-agentline-plugin/design-v1.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`
- 需要时读取 flow/exec/inputs/git/lock/check-task

输出 `design-v5-contract.md`，只修补 review-v4 的剩余问题，不重开架构：

1. **B1 输入恢复**：不能用 `HEAD:inputs.jsonl` 作为恢复依据；给出不依赖产品仓库原文的 B 级输入账本/哈希恢复契约；覆盖“输入已消费、步骤未提交”的 amendment 恢复。
2. **B1 归档窗口**：补齐 `call.archive` 已落盘、`call.end` 未落盘的恢复分支；中断调用先封存日志/部分产物，再允许重试。
3. **B1 终止证明**：Windows 上无法证明完整后代已终止时返回 `unknown`，不能续跑；给出可操作判定和反例测试。
4. **B4 K 恢复**：覆盖 K 已写入/暂存未提交、K 已提交但 phase 未更新两类窗口；恢复必须关联本次受控事务。
5. **B4 缓存**：`T_content` 不能缓存 `check-task -Sealed` 的本机日志检查；本机日志状态变化必须使 gate 失效，给出缓存键/动态检查规则。
6. **M4 旧 CLI drain**：旧 `cmdRun` 的完整生命周期（首次调用前、候选切换间隙、清除 live 后）纳入存活登记；无法完整读取时 drain 返回 `unknown`，不能当 0。
7. **D3**：调度规则 2 改为使用实际轮次上限 L；G1 的 `rounds_le_3` 改为 `rounds <= L`，显式追加的第 4 轮可被合法表达。
8. **Minor**：命令 ID/命名、准入与进程创建顺序、合并稿清理清单。

要求：
- 只写替换/新增章节，不重写 105k 全文。
- 每个 blocking 给验收例子。
- 不再询问 D1–D4；只列真正的新用户裁决项（如果有）。
- 不写产品代码，不修改仓库。
- 完成后交 GPT-6 Astra 做最终契约复核；通过后进入实现切分。

直接输出 Markdown 正文。
