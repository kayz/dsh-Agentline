# Review

结论：needs_revision。CI 五项命令均成功，但 AC-2 的缺失数据处理不符合设计。

## Findings

- **P2 — status 将缺失会话或 state.json 作为成功结果返回（AC-2）**：设计要求损坏或缺失数据报告错误（design.md 控制面第一条）。`orchestrator/lib/blueprint.mjs:405-410` 将不存在的会话标为 missing、已存在会话目录但缺少 state.json 标为 empty；`orchestrator/agentline.mjs:726-735` 对这两种状态无论 JSON 还是文本输出均正常返回，进程退出码为 0。调用方无法按 CLI 错误约定识别丢失数据，已有会话缺少核心状态文件被当作空会话。应将指定会话的缺失状态作为错误报告并返回非零退出码，同时覆盖文本和 JSON 路径及缺失 state.json 的情形。

## 逐项核对

- AC-1：通过。CI AC-1 退出码 0，末行为 AC-1 OK。
- AC-2：不通过。CI AC-2 退出码 0、10 项通过；`orchestrator/test/blueprint-cli.test.mjs:224,295,346,367,445,482` 覆盖命令、顺序、恢复、冲突和物化，但上述缺失数据路径违反设计。
- AC-3：通过。CI AC-3 退出码 0、34 项通过；`orchestrator/test/blueprint-g1.test.mjs:250-925` 覆盖字段、引用、依赖环、覆盖、矩阵、身份、评审、来源和内容变更，`orchestrator/lib/blueprint.mjs:1084-1187,1207-1355` 从落盘证据求值。
- AC-4：通过。CI AC-4 退出码 0、7 项通过；`plugin/test/blueprint-ui.test.mjs:435-642` 覆盖真实、空、错误、项目切换、动作和现有功能。上一轮的列表读取问题已修复：`orchestrator/lib/blueprint.mjs:454-467` 仅对 ENOENT 返回空列表，并传播其他错误。
- AC-5：通过。CI AC-5 退出码 0，orchestrator 164 项、插件 17 项通过，末行为 AC-5 OK。

评审基准 HEAD：`dd4985189b9eccb0fc96383627b10258034e93c2`（直接读取 worktree HEAD 及其引用）；同时审阅当前工作区文件。执行证据来自 `.collab/tasks/004/ci-results.json`，未重跑。
