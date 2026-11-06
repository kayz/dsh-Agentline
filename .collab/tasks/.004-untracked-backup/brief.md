# P7：Blueprint 控制面

状态：等待 P6 完成后再启动（不要与 P6 并行修改同一批文件）。

## 目标

在 P6 的 Studio 控制面与共享 UI 角色/渠道基础上，实现 Blueprint：

- `.collab/blueprint/<id>/state.json`
- `agentline blueprint new|run|review|approve|materialize|status`
- 角色：`designer`、`reviewer`、`test_architect`
- 每轮 design → testability → review，只前进一步
- `task-graph.json`、`acceptance-matrix.md`、`review-vN.verdict.json`
- G1：任务字段、依赖无环、AC 双向覆盖、矩阵一致、模型隔离、内容哈希批准
- 插件 Blueprint 页读取真实轮次/findings/任务图/Gate
- 物化必须保留依赖、输入输出、验收方向，不能只写 AC ID
- 批准内容变化后失效，重新批准才能 materialize

## 约束

- 从 P6 合并后的 `main` 创建 `task/004`。
- 不重写 Studio/Build；复用 P6 的 roles/channels/stages。
- dev 使用 `deepseek-v4-pro`。
