# Task <NNN> — 任务简报

## 目标

填写期望交付和可观察到的行为。

## 约束

填写平台、依赖、执行限制和允许写入的路径。

## 建议验收方向

列出需要证明的行为，由 designer 转化为独立验收命令。

## 非目标

列出本次明确不实现的内容。

## 验收格式（生成 acceptance.md 时必须遵守，否则 CI 解析失败）

- 每个 AC 一个二级标题：`## AC-<三位数字> <标题>`；**同一 AC 的多条检查放进同一小节**，不要重复同一个 id
- 小节内必须包含可执行命令：`- 命令:` 行，或 ```pwsh 代码块
- 命令成功时必须在 stdout 打印 `<AC-id> OK` 作为哨兵，runner 按此判定通过
- 判据只断言可观察结果（退出码 / stdout 子串 / 文件状态），不要断言测试标题、函数名、行号
- 每条任务额外保留一条回归门禁：`node --test "test/unit/*.test.mjs"` 全绿

自检：`node scripts/check-acceptance.mjs .collab/tasks/<NNN>/acceptance.md`