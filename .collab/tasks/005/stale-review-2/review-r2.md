# Review

结论：needs_revision。验收 4/7；CI 七条命令均通过。评审 SHA：9b7d0fd6593f34db8ee886071deb6ab4cf2526b8（读取工作树 HEAD 引用文件）。

## Findings

- **P1** 已物化的 Blueprint 任务缺失来源时被当作旧任务执行。`orchestrator/lib/build.mjs:184-186` 在 `origin.json` 不存在时直接返回 legacy，没有查找现存的 Blueprint 物化记录；`orchestrator/lib/step.mjs:106-115` 因此继续执行，`build.mjs:638-640` 还将来源 gate 判为通过。`orchestrator/test/build-source.test.mjs:311-330` 从物化任务删除来源文件，并断言成功、状态推进、调用模型一次，证实该反例。物化记录仍存在时，缺失或改写为 adhoc 的来源应拒绝；需覆盖单步和完整运行、零模型调用以及 gate 和投影。

## 逐项结论

- AC-1 通过：`ci-results.json` AC-1 退出码 0，末行为 `AC-1 OK`。
- AC-2 不通过：CI 退出码 0，4 项通过；`build.mjs:184-186` 和 `build-source.test.mjs:311-330` 证明缺失来源会调用模型并推进。
- AC-3 通过：CI 退出码 0，4 项通过；`build-execution.test.mjs:76,92,135,181` 覆盖单步、完整运行、失败及锁与恢复。
- AC-4 不通过：CI 退出码 0，6 项通过；`build.mjs:638-640,717-727` 将上述缺失来源误判为通过。
- AC-5 通过：CI 退出码 0，4 项通过；`build-roles.test.mjs:63,102,128,219` 和 `step.mjs:69-97,125-147` 覆盖角色、锁、身份及重试证据。
- AC-6 不通过：CI 退出码 0，4 项通过；`build.mjs:184-186,812-838` 将上述物化任务投影为旧任务及其 gate。
- AC-7 通过：CI 退出码 0；orchestrator 182 项、插件 21 项通过，末行为 `AC-7 OK`。