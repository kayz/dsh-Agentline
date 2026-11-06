# Review

结论：needs_revision。审查时 HEAD 为 `5c005cbb47e87d97d5e0756c784f5877bc42e525`，通过只读 worktree HEAD 和分支引用确认。CI 记录未提供 SHA，无法证明当前工作树与该提交完全一致。

## Findings

- **P1：来源 G0 可被豁免。** `orchestrator/lib/blueprint.mjs:1105-1107,1171` 将来源缺失、G0 失效或哈希不一致标为可豁免；`1082-1087,1195-1203` 读取匹配哈希的豁免，`orchestrator/lib/contracts/gate.mjs:102-109` 接受豁免。`blueprint.mjs:1245-1253,1391-1399` 依赖 Gate 结果，因而允许失效来源继续批准和物化，违反设计要求。测试 `orchestrator/test/blueprint-g1.test.mjs:431-447` 只检查失败并确认可豁免，没有覆盖绕过。
- **P1：落盘任务图必需字段与空图校验不完整。** `orchestrator/lib/blueprint.mjs:984-1017` 未检查任务 title 或拒绝空 tasks、acceptance；`1041-1052,1056-1066` 对空数组的覆盖和矩阵比较会空遍历通过。尽管模型输出入口 `638-673,692` 校验这些字段，G1 必须重新检查落盘内容；修改图后重新执行测试架构与评审可产生匹配摘要，从而让无标题或空图通过相关检查。无标题任务生成的 brief 标题为 undefined（`1347-1353`）。

## 验收结论

- AC-1 通过：`ci-results.json` 退出码 0，末行 AC-1 OK。
- AC-2 不通过：CI 退出码 0，4 通过、0 失败，末行 AC-2 OK；来源豁免允许失效来源批准和物化。
- AC-3 不通过：CI 退出码 0，21 通过、0 失败，末行 AC-3 OK；上述 G1 反例未正确阻断。
- AC-4 通过：CI 退出码 0，7 通过、0 失败，末行 AC-4 OK；`plugin/test/blueprint-ui.test.mjs` 覆盖真实、空、错误、项目切换与动作。
- AC-5 通过：CI 退出码 0，orchestrator 136 通过、插件 17 通过，末行 AC-5 OK。

验收通过 3/5。执行证据引用 `.collab/tasks/004/ci-results.json`，实现结论依据上述独立静态核查。
