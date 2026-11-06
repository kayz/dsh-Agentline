# 评审结论：needs_revision

评审提交 `1b31e79181d4e21388abba2a74a57f0a67319e3e`，验收 5/7 通过。编排方 CI 七项命令均退出码 0，末行均为对应的 `AC-n OK`；下列结论同时依据实现独立判断。

## Findings

- **P1 — 真实 CLI 无法取得 Build 模型适配器。** `orchestrator/agentline.mjs:371`、`:381` 调用 `runStep` / `runBuild` 时未传 `adapterFactory`；`orchestrator/lib/step.mjs:69`–`:71` 将缺省工厂替换成始终返回 `null` 的函数，并在 `:156` 将包装函数传给 `executeRole`，使 `orchestrator/lib/exec.mjs:118` 的默认 `getAdapter` 回退失效。模型候选因无 adapter 被跳过，真实 CLI 无法执行设计、开发和评审，也无法到达 `pr_open`。执行测试 `orchestrator/test/build-execution.test.mjs:82`、`:98` 均注入桩工厂，未覆盖此路径。应恢复默认 adapter，并验证真实入口仍经过锁与身份记录。

上一轮两项问题已修复：未提交产品变更检查见 `orchestrator/lib/build.mjs:681`、`:699`、`:812`；非对象状态的错误判定见 `:981`–`:986`，对应测试见 `orchestrator/test/build-gate.test.mjs:249`、`plugin/test/build-ui.test.mjs:768`、`:828`。

## 验收逐项

| 项目 | 结论 | 证据 |
|---|---|---|
| AC-1 | 通过 | `ci-results.json` AC-1 退出码 0，末行 `AC-1 OK`。 |
| AC-2 | 通过 | CI AC-2 通过；`orchestrator/lib/step.mjs:108` 执行前检查来源；`orchestrator/test/build-source.test.mjs:200`、`:221`、`:279`、`:335`、`:423`、`:459` 覆盖来源正反例。 |
| AC-3 | 不通过 | CI AC-3 通过，但上述 P1 使真实 CLI 的默认 adapter 路径无法运行；`orchestrator/test/build-execution.test.mjs:98` 注入测试 adapter。 |
| AC-4 | 通过 | CI AC-4 通过；`orchestrator/lib/build.mjs:610`、`:724` 判定 CI 证据；`orchestrator/test/build-gate.test.mjs:64`、`:111`、`:191`、`:249`、`:341` 覆盖缺失、失败、通过和新鲜度。 |
| AC-5 | 不通过 | CI AC-5 通过；`orchestrator/lib/step.mjs:69`–`:97` 约束调用，但 P1 导致真实 CLI 无法进行物理调用。 |
| AC-6 | 通过 | CI AC-6 通过；`plugin/test/build-ui.test.mjs:487`、`:507`、`:633`、`:768`、`:828` 覆盖真实、空、错误、重试和切换。 |
| AC-7 | 通过 | CI AC-7 退出码 0，orchestrator 185 项、插件 24 项通过，末行 `AC-7 OK`。 |
