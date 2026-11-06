# Review

结论：needs_revision。验收 4/7；执行证据中七条命令均成功。评审 SHA：cd175082109c4b516f15e92f6fdd154079769010（读取工作树 HEAD 引用文件）。

## Findings

- **P1** 工作树的物化记录被删除或损坏时，删除来源文件仍可绕过 Blueprint 校验。 `orchestrator/lib/build.mjs:180-196` 只扫描当前工作树的 `materialized.json`，将缺失、不可读、损坏或结构不符的记录跳过；`build.mjs:206-211` 随即把缺失 `origin.json` 的任务当作 legacy 放行，`orchestrator/lib/step.mjs:106-115` 继续执行。即使 main 上仍有该任务的物化记录，也不会读取；`docs/blueprint/20261106-agentline-plugin/design-v2-delta.md:446-449` 指定依据 main 上的物化记录识别任务。结果是模型可被调用，`build.mjs:665-667` 的来源 gate 通过，`build.mjs:839-865` 将其投影为旧任务。现有 `orchestrator/test/build-source.test.mjs:335-364` 只删除 origin、保留工作树物化记录，没有覆盖此情况。应依据权威物化记录识别并对损坏或无法确认的证据拒绝，补充单步、完整运行、零调用、gate 和投影反例。

## 逐项结论

- AC-1 通过：`ci-results.json` AC-1 退出码 0，末行为 `AC-1 OK`。
- AC-2 不通过：CI 退出码 0、5 项通过；`build.mjs:180-196,206-211` 存在上述来源绕过。
- AC-3 通过：CI 退出码 0、4 项通过；`orchestrator/test/build-execution.test.mjs` 覆盖单步、完整运行、失败及锁和恢复。
- AC-4 不通过：CI 退出码 0、6 项通过；`build.mjs:665-667` 将上述无法确认的来源判为通过，影响真实证据 gate。
- AC-5 通过：CI 退出码 0、4 项通过；`orchestrator/test/build-roles.test.mjs` 覆盖角色、锁、身份和重试。
- AC-6 不通过：CI 退出码 0、4 项通过；`build.mjs:839-865` 将上述来源投影为 legacy，未显示错误。
- AC-7 通过：CI 退出码 0；orchestrator 183 项、插件 21 项通过，末行为 `AC-7 OK`。
