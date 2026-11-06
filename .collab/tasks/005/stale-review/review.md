# Review

结论：needs_revision。验收 3/7；执行证据显示七条命令均成功，但下列代码缺口不满足规格。评审 HEAD：75f4d54a896bc61a145328b169a901294bf1fcb7，从工作树 HEAD 指向的引用文件读取。

## Findings

- **P1** 未知副作用仍可在当前步骤自动重放：网络错误立即重试，其他错误可切换候选，状态标记在步骤结束后才写入。 证据：orchestrator/lib/step.mjs:82-90,320-324；orchestrator/lib/exec.mjs:146-154,221-248；orchestrator/lib/build.mjs:277-295。
- **P1** 自洽但缺少必要验收结果的 CI 报告可通过；缺少 ranAt 或无法读取 HEAD 时间也沿用通过结果，无法证明新鲜度。 证据：orchestrator/lib/build.mjs:357-374,387-394；orchestrator/test/build-gate.test.mjs:72-75。例如七项验收的任务，只留下一个通过结果并将 total/passed 改为 1，即可通过；现有部分报告测试仅覆盖计数不一致。
- **P1** 失败或基础设施重试的物理调用缺少实际身份时被隔离检查忽略，可随其他调用一起通过。 证据：orchestrator/lib/build.mjs:481-508；orchestrator/test/build-roles.test.mjs:160-163,200-214。
- **P2** 节点变更、批准撤销或过期时，失效的 Blueprint 来源被投影为旧任务。 证据：orchestrator/lib/build.mjs:215-241,651-656；plugin/test/build-ui.test.mjs:479-510。

## 逐项结论

- AC-1 通过：ci-results.json AC-1：exitCode 0，AC-1 OK。
- AC-2 通过：ci-results.json AC-2：exitCode 0，3 项通过；orchestrator/test/build-source.test.mjs:233-246,258-274,291-320,326-330；orchestrator/lib/build.mjs:183-241。
- AC-3 不通过：ci-results.json AC-3：exitCode 0，3 项通过；step.mjs:82-90 和 exec.mjs:146-154,221-248 存在未知副作用重放缺口。
- AC-4 不通过：ci-results.json AC-4：exitCode 0，4 项通过；build.mjs:357-374,387-394 未确认全部必要项及新鲜度。
- AC-5 不通过：ci-results.json AC-5：exitCode 0，3 项通过；build.mjs:481-508 忽略有错误的调用缺失身份。
- AC-6 不通过：ci-results.json AC-6：exitCode 0；plugin/test/build-ui.test.mjs:437-562；build.mjs:215-241,651-656 将失效 Blueprint 来源显示为 legacy。
- AC-7 通过：ci-results.json AC-7：exitCode 0，orchestrator 177 项及插件 20 项通过，AC-7 OK。
