# Review

结论：needs_revision。CI 的五项执行均成功，但 AC-4 的实际读取错误路径不满足设计。

## Findings

- **P2 — Blueprint 列表读取失败被误报为空项目（AC-4）**：`orchestrator/lib/blueprint.mjs:454-457` 对 `readdirSync` 的所有异常返回空数组，包括 `.collab/blueprint` 为普通文件、访问被拒绝或 I/O 错误；`plugin/lib/index.js:995-996` 随即返回 `ok: true`。因此 UI 会显示空状态，而不是可重试的读取错误，违反 `design.md` 对空数据和读取损坏分别显示的要求。`plugin/test/blueprint-ui.test.mjs:507-525` 的列表读取失败用例将项目路径本身设为普通文件，实际在项目校验处被拒绝，未覆盖有效项目内 Blueprint 根目录读取失败。应仅将目录确实不存在视为空，并传播其他读取错误，补充通过真实路由的对应测试。

## 逐项核对

- AC-1：通过。`ci-results.json` AC-1 退出码 0，末行为 `AC-1 OK`。
- AC-2：通过。CI AC-2 退出码 0；`orchestrator/test/blueprint-cli.test.mjs:224,279,330,351,429,466` 覆盖命令、单步、恢复、物化及批准失效。
- AC-3：通过。CI AC-3 退出码 0；`orchestrator/test/blueprint-g1.test.mjs:250-925` 构造任务字段、依赖、覆盖、矩阵、模型身份、评审、来源和内容变更反例。
- AC-4：不通过。CI AC-4 退出码 0，但上述 finding 表明真实列表读取错误被吞掉，测试未覆盖该路径。
- AC-5：通过。CI AC-5 退出码 0，输出 orchestrator 163 项、插件 17 项通过，末行为 `AC-5 OK`。

评审基准 HEAD：`30e1e258c4535c8588df5be01dffc7d95403bccf`（直接读取 worktree HEAD 指向的引用）；同时审阅了当前工作区文件。执行证据来自 `.collab/tasks/004/ci-results.json`，未重跑。
