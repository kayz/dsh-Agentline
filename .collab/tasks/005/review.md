# 评审结论：needs_revision

评审提交：`068f72737de3ed1574b389af5e7f7c550a71a2c1`。验收 5/7 通过。执行证据采用编排方的 `ci-results.json`：AC-1 至 AC-7 均退出码 0，末行为对应的 `AC-n OK`；以下结论另对照实现和测试独立判断。

## Findings

- **P1 — 未提交的产品代码变更不会使证据过期。** `orchestrator/lib/build.mjs:651` 的 CI 新鲜度只读取 HEAD 的产品提交时间；`orchestrator/lib/build.mjs:767` 的评审新鲜度只比较提交，SHA 等于 HEAD 时在第 777 行直接通过。产品文件在 CI 和评审后被修改但尚未提交时，两项仍可通过，无法证明当前工作区的代码已通过 CI 和评审。应让工作区中产品文件的变更使对应证据不通过，并覆盖该场景，同时保留仅 `.collab` 审计变动的行为。
- **P2 — 结构损坏的状态被显示为正常任务。** `orchestrator/lib/build.mjs:951` 将非对象的 JSON 状态当作缺失状态，而第 953 行仅将解析失败视为错误。例如 `state.json` 内容为 `[]`、`null` 或字符串时，最终第 984–993 行返回 `state: 'ok'` 和未知状态，而不是要求的损坏错误。应将存在但结构无效的状态标记为错误，并在 UI 测试中验证。

## 验收逐项

| 项目 | 结论 | 证据 |
|---|---|---|
| AC-1 | 通过 | `ci-results.json` AC-1：退出码 0，末行 `AC-1 OK`。 |
| AC-2 | 通过 | CI AC-2 通过；`orchestrator/lib/step.mjs:106` 执行前检查来源；`orchestrator/test/build-source.test.mjs:200`、`:221`、`:279`、`:335` 覆盖批准、拒绝、节点及来源情形。 |
| AC-3 | 通过 | CI AC-3 通过；`orchestrator/test/build-execution.test.mjs:76`、`:92`、`:135`、`:181` 覆盖单步、完整运行、失败和恢复约束。 |
| AC-4 | 不通过 | CI AC-4 通过，缺失和无效报告判定见 `orchestrator/lib/build.mjs:610`；但上述 P1 使工作区产品变更后的 CI 和评审证据仍可通过。 |
| AC-5 | 通过 | CI AC-5 通过；`orchestrator/lib/step.mjs:69`、`:125` 约束并记录调用；`orchestrator/test/build-roles.test.mjs:63`、`:102`、`:128`、`:219` 覆盖角色、锁、身份和重试。 |
| AC-6 | 不通过 | CI AC-6 通过；`plugin/test/build-ui.test.mjs` 覆盖真实、空、错误、重试和切换；但 P1 的错误 gate 会被投影，P2 的结构损坏状态不会显示错误。 |
| AC-7 | 通过 | CI AC-7：退出码 0，orchestrator 184 项、插件 22 项通过，末行 `AC-7 OK`。 |
