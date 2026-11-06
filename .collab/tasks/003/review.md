# 评审结论

needs_revision；验收通过 3/5。只读 worktree HEAD 和分支引用得到 Git SHA `5061745f4a6476c7bd7afa4ee188f3a84f3b83a1`；该 SHA 不证明工作区没有未提交修改。CI 五条命令均退出 0，但仍存在以下缺陷。

## Findings

- **P1 — G0 对变更后的决策或纪要沿用旧确认。** 专家确认记录只保存角色、结论、模型和时间，未绑定确认时的决策或纪要内容（`orchestrator/lib/studio.mjs:900-916`）。G0 校验确认时只检查这些字段（1112-1124、1173-1178 行）；它虽重新计算当前内容哈希，却把该新哈希同时作为 gate 的 subject 和 currentHash（1189-1198 行），没有与确认时的证据比较。因此三位专家确认后修改非空纪要或决策内容、保留原用户及专家确认记录，重新 conclude 仍可通过，无法证明专家及用户确认的是当前内容。这违反内容改变后不能沿用过期通过结果及有效确认要求。现有重算测试只删除用户确认记录（`orchestrator/test/studio-g0.test.mjs:350-365`），未验证内容变更后旧确认失效。

## 验收逐项结论

- **AC-1 通过**：`ci-results.json` AC-1 退出码 0，输出 `AC-1 OK`。
- **AC-2 不通过**：CI AC-2 退出码 0，输出 `AC-2 OK`；conclude 对改动后的内容仍接受旧确认（`orchestrator/lib/studio.mjs:900-916,1112-1124,1189-1198`）。
- **AC-3 不通过**：CI AC-3 退出码 0，输出 `AC-3 OK`；内容修改后旧确认仍有效，测试未覆盖此反例（`orchestrator/test/studio-g0.test.mjs:350-365`）。
- **AC-4 通过**：CI AC-4 退出码 0，输出 `AC-4 OK`；`plugin/test/studio-ui.test.mjs:482,516,600,616,731,794,835,856,927,951` 驱动渲染、路由及交互并覆盖列出的状态与操作。
- **AC-5 通过**：CI AC-5 退出码 0，输出 `AC-5 OK`，109 项测试通过、0 项失败，包括现有 flow 测试。
