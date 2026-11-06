你是 AgentLine Blueprint 20261106 的主设计师（Claude Opus 5.5）。第 1 轮设计被 GPT-6 Astra 审核为 REVISE。请阅读：

- `docs/blueprint/20261106-agentline-plugin/brief.md`
- `docs/blueprint/20261106-agentline-plugin/design-v1.md`
- `docs/blueprint/20261106-agentline-plugin/review-v1.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`
- 需要时读取 `orchestrator/lib/flow.mjs`、`exec.mjs`、`agentline.mjs`、`check-task.ps1`、`plugin/lib/index.js`、`plugin/lib/client.js`

输出 `design-v2-delta.md`，只修正 review-v1 的 blocking 和 major，不重开整体架构。必须：

1. **B1**：明确在“flow 零侵入”约束下，Supervisor 能否真正兑现三轮上限、统一恢复预算和逐调用证据；如果能，给出持久化轮次依据/控制接口/时序；如果不能，明确最小内核接口调整方案和需要用户裁决的点，不要继续声称外层足够。
2. **B2**：定义每类证据的输入摘要（设计、任务图、测试策略、代码快照、验收命令）、执行身份、新鲜度；旧 pass + 新内容不能复用。
3. **B3**：取消或限定 `--override-gate`，不得绕过不可豁免项；若必须保留，作为协议变更交用户。
4. **B4**：合并前证据归档、合并后可定位不可变提交、worktree/分支删除后严格 T gate 仍可校验；本机和新 clone 都要成立。
5. **M1–M6**：补齐单 CLI 命令表、角色锁定/probe 超时、Git 分级留存、版本兼容矩阵、materialize/worktree 交接、人工授权信任边界。
6. **Minor**：统一 Studio 轮次语义、错误终态、重试术语、summary revision、模块路径等。

输出要求：
- 只写变更/替换章节，不重写 105k 全文；给出合并后的设计清单和需要替换的章节。
- 每个 blocking 给“修复内容 + 验收例子”。
- 不得用“后续实现再决定”绕过 blocking。
- 若某个问题必须用户裁决，单列，不要自行拍板。
- 这是第 2 轮，最多 3 轮。

直接输出 Markdown 正文。
