你是 AgentLine Blueprint 20261106 的主设计师（Claude Opus 5.5）。用户已授权继续局部契约修补。请阅读：

- `docs/blueprint/20261106-agentline-plugin/review-v5.md`
- `docs/blueprint/20261106-agentline-plugin/design-v5-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v4-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v3-delta.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`
- 需要时读取 `orchestrator/lib/inputs.mjs`、`exec.mjs`、`agentline.mjs`、`flow.mjs`、`git.mjs`、`lock.mjs`、`check-task.ps1`

输出 `design-v6-contract.md`，只修补 review-v5 的剩余 B1 和 M4，以及 Minor；不重开架构，不再询问 D1–D4：

1. **B1-1 输入账本**：
   - 定义系统 note / keep / design_scope 在 beforeCall 前完成 `input.intent` id、content_sha256 和账本写入的位置；
   - 旧 CLI 输入命令与 `markConsumed` 的整读/rename 竞争如何消除；是否改为 append-only 状态事件、共享锁或禁用旧路径；
   - 明确正常 keep、design_scope、旧 CLI 并发追加的验收。
2. **B1-2 晚到归档**：
   - 原归档与晚到归档分别使用不可变目录/ref；
   - “late 已写、end 未写时再次崩溃”的唯一恢复结果；
   - 原 `call.archive` 校验不能因 late 归档而改变。
3. **B1-3 POSIX 终止证明**：
   - 无守护、无法排除 subreaper 重新挂接时返回 `unknown`，不能放行；
   - 给出“守护退出、后代被外部旧 subreaper 接管”的反例和恢复动作。
4. **M4 旧 CLI drain**：
   - 旧 `cmdRun` 入口退出、模型子进程仍存活时，如何保持非零或 `unknown`；
   - 升级前已运行的旧 CLI 如何处理；是否要求先排空旧运行；
   - 给出 A6-15 的“入口退出、后代存活”验收。
5. **Minor**：`C_auth` 包含初始 adopt consumed；A3 编号去重；合并稿清理清单（recording、命令 ID、错误码、D1 字母）。

要求：
- 只写替换/新增章节，不重写 105k 全文。
- 每个 blocking 给验收例子。
- 不新增产品范围；不自行放宽“无法证明终止就不续跑”。
- 如果要缩小旧 CLI 兼容承诺，作为明确的范围决定列出，并说明是否需用户裁决。
- 完成后交 GPT-6 Astra 最终复核；通过后进入实现切分。

直接输出 Markdown 正文。
