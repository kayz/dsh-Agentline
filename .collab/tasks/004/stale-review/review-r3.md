# 第三轮评审

结论：needs_revision。逐条验收通过 3/5；CI 执行结果为 5/5，但 AC-2、AC-3 的行为仍有以下缺陷。评审对象为当前工作区，HEAD 指向 `cc50bbf82d2bb901b2e4aa86462eada4b1870615`；CI 报告未记录 SHA，不能据此声称 CI 验证了该提交的独立干净快照。

## Findings

- **P1：新一轮未完成仍可沿用上一轮评审批准。** `orchestrator/lib/blueprint.mjs:950-967` 在评审 verdict 为 pass 但其他 G1 项未通过时允许进入下一轮；`:861-871` 在新一轮 designer 完成后将 phase 置为 testability。若新设计内容与上轮相同，且导致上轮 G1 失败的外部条件恢复，`:1131-1142` 只检查最新存在的评审及摘要，没有要求评审和测试架构结果属于当前轮次或当前轮已完成；`:1275-1282` 仅凭 checks_pass 批准。于是可以跳过本轮 testability 和 review 批准并物化，违反每轮顺序及最后一轮评审要求。应将 G1 和批准绑定当前轮完整步骤及对应证据，并增加覆盖此路径的测试。
- **P1：最终评审未绑定其看到的测试架构结果。** review 输入包含 `testability.json`（`orchestrator/lib/blueprint.mjs:548-560`），但 `:147-155,921-943` 的 review 摘要只含设计、任务图、策略/矩阵和来源 G0，不含 testability.json；`:1136-1142` 独立读取 blocker 而不验证评审所见的该文件。一次 pass 评审之后，若把完整的 open blocker 改为 resolved，旧批准虽因内容哈希变化失效（`:174-181`），G1 却仍可沿用旧 review 并允许重新批准、物化，评审没有审查更新后的测试架构结果。应将该结果绑定到评审输入摘要，并测试内容变化后必须重新评审。

## 验收逐项结论

- AC-1：通过。`.collab/tasks/004/ci-results.json` 的 AC-1 退出码 0，末行 AC-1 OK。
- AC-2：不通过。CI 中 5 个测试通过、退出码 0、末行 AC-2 OK；但上述两项允许不完整或过期评审的内容获批并物化。现有 CLI 测试见 `orchestrator/test/blueprint-cli.test.mjs:211,266,317,338,416`。
- AC-3：不通过。CI 中 26 个测试通过、退出码 0、末行 AC-3 OK；G1 对当前轮和评审输入的检查存在上述缺口。反例测试见 `orchestrator/test/blueprint-g1.test.mjs:217-660`。
- AC-4：通过。CI 中 7 个 UI 测试通过、退出码 0、末行 AC-4 OK；真实、空、错误、项目切换、操作及既有功能测试见 `plugin/test/blueprint-ui.test.mjs:435-639`。
- AC-5：通过。CI 记录 orchestrator 142 通过、插件 17 通过，退出码 0，末行 AC-5 OK。

上一轮两个 finding 的针对性修复已核对：无效 blocker/finding 通过规范化拒绝，见 `orchestrator/lib/blueprint.mjs:778-822`；session 保存失败时删除物化记录，见 `:1526-1540`。本轮未重跑执行类命令，依据编排方 CI 记录。
