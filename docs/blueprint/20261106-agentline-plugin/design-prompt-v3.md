你是 AgentLine Blueprint 20261106 的主设计师（Claude Opus 5.5）。第 2 轮设计被 GPT-6 Astra 审核为 REVISE。请阅读：

- `docs/blueprint/20261106-agentline-plugin/design-v1.md`
- `docs/blueprint/20261106-agentline-plugin/design-v2-delta.md`
- `docs/blueprint/20261106-agentline-plugin/review-v2.md`
- `docs/blueprint/20261106-agentline-plugin/brief.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`
- 需要时读取 `flow.mjs`、`exec.mjs`、`agentline.mjs`、`check-task.ps1`、`git.mjs`、`routing.mjs`、`inputs.mjs`、`config.mjs`、`plugin/lib/index.js`

输出 `design-v3-delta.md`，只处理 review-v2 的 blocking 和 major，不重写全文。必须：

1. **B1 CallGuard 恢复契约**：
   - 用实际 flow 状态迁移解释 S1/S3/S4；覆盖单评审候选、失败后 keep/discard、重复摘要、第三轮评审；
   - 明确业务轮次与物理调用预算分别何时占用、何时结束；
   - 如果 K0 无法兑现，给出 K1 最小内核改动和用户裁决；不能继续声称 K0 足够。
2. **B2 G2 验证对象**：
   - 明确 G2 是固定历史集成快照，还是当前 main；
   - 定义 `I` 的更新/失效、manual-checks 进入批准哈希、下游准入检查同一目标。
3. **B4 合并/封存**：
   - 普通合并、补封存、内部调用边界、提交拓扑、`M^2==S`、派生 gate 结果存储；
   - 若不支持补封存，明确移出范围。
4. **M2**：角色锁的执行配置唯一来源；项目 routing 不得改变锁定候选/effort；provider 参数可重建。
5. **M3**：显式 git add 不包含用户已暂存内容；旧 merge `commitAll` 复用边界；materialize 事务/锁/失败恢复。
6. **M4**：删除“新插件配旧核心时写 brief.md”的例外，或提交用户裁决；drain 覆盖所有启动 worker 的命令。
7. **Minor**：命令表补齐、恢复预算矛盾、materialize 首次有效性链、D3/U1 越界选项。
8. 给出替换章节清单、完整命令/gate 变更和审核检查清单。

要求：
- 只写变更，不重写 105k 全文。
- 每个 blocking 给验收例子。
- 需要用户裁决的单列，不能自行放宽已确认边界。
- 这是第 3 轮；如果仍不通过，交用户裁决，不再自动开第 4 轮。

直接输出 Markdown 正文。
