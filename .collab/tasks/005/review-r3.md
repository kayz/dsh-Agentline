# Review

结论：needs_revision。验收 4/7；CI 七条命令均通过。评审 HEAD：ad27fef64453c126617c8a83b01f5326baa2ecce（读取工作树 HEAD 指向的引用文件）。

## Findings

- **P1** 正常运行到 pr_open 后，T gate 会将本次评审标为过期，也可能将 CI 标为过期。CI 在 review 之前执行（orchestrator/lib/step.mjs:203-212），review 随后提交评审产物（step.mjs:228-229），PR 阶段又提交状态（step.mjs:241-251；git.mjs:65-68 使用 git add -A）。CI 新鲜度比较报告时间与最新提交时间（build.mjs:455-475），评审 SHA 必须等于最新 HEAD（build.mjs:535-547）。评审绑定的是评审前的提交，提交评审产物或 PR 状态后 HEAD 改变，因此评审证据 stale；后续提交比 CI 晚超过容差时 CI 也 stale。执行测试只断言到达 pr_open（build-execution.test.mjs:68,91-101），没有断言完整流程后的 gate 一致性。应将新鲜度绑定到实际被测、被评审的代码版本并验证完整流程。

## 逐项结论

- AC-1 通过：ci-results.json AC-1 退出码 0，末行 AC-1 OK。
- AC-2 通过：CI 退出码 0，3 项通过；build.mjs:183-241 和 step.mjs:108 核验来源。
- AC-3 不通过：CI 退出码 0，4 项通过；正常完整运行的状态与 gate 不一致，见 P1。
- AC-4 不通过：CI 退出码 0，4 项通过；缺失证据判断见 build.mjs:415-452，但正常流程的新鲜度错误，见 P1。上一轮的退出码、末行和 SHA 校验已在 build.mjs:442-452,535-547 加入。
- AC-5 通过：CI 退出码 0，4 项通过；step.mjs:125-156 记录调用并包装锁，build.mjs:300-319,574-602 拒绝损坏或缺失身份的隔离证据。
- AC-6 不通过：CI 退出码 0，3 项通过；build.mjs:717,750-755 将受 P1 影响的 gate 投影至 UI。
- AC-7 通过：CI 退出码 0，orchestrator 179 项和插件 20 项通过，末行 AC-7 OK。