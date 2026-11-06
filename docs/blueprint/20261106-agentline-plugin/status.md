# Blueprint 20261106 — AgentLine 插件状态

状态：**Round 3 完成；Review v3 = REVISE；按协议停止，等待用户裁决**
日期：2026-11-06

## 已完成

- `brief.md`：完整 Blueprint 需求（控制面、UI/UX、slash 命令、监控、模型维护/配置、错误/轮次、gate、迁移）。
- `design-v1.md`：主设计 v1（105k）。
- `review-v1.md`：REVISE（4 blocking + 6 major）。
- `design-v2-delta.md`：第 2 轮修订。
- `review-v2.md`：REVISE（B1/B2/B4 部分关闭）。
- `design-v3-delta.md`：第 3 轮修订。
- `review-v3.md`：REVISE；协议内最后一轮，不自动开第 4 轮。

## Review v3 结论

已实质关闭：

- G2 固定集成快照与证据绑定；
- 角色锁的配置来源；
- 补封存移出范围；
- 兼容矩阵收口；
- 大量 UI/UX、slash 命令、监控、模型配置、错误/gate 设计已经具体化。

仍剩：

### Blocking

1. **B1（K1 恢复契约）**：正常计轮已成立，但调用结束、归档、步骤提交、step.end 之间的崩溃窗口未闭合；中断证据可能被下一次尝试覆盖；同一 amendment 可能重复开启 epoch。
2. **B4（合并校验循环）**：`T.reachable` 要求 `merged.json`，但合并流程要等 K 完成才写；重入判据过宽；T 缓存键未覆盖 K/可达性/批准状态。
3. **B5（批准竞态）**：批准检查在 MainWrite 锁外，撤销批准可在检查后、合并前插入。

### Major

- MainWrite 目标路径已有的未跟踪文件未被统一拒绝；
- drain 尚未覆盖旧 `cmdRun` 和“已准入未启动”的 worker；
- amendment/epoch、步骤提交和证据归档需要统一恢复协议。

## 需要用户裁决

### D1：是否授权 K1

v3 证明 v2 的“flow 零侵入 + CallGuard”无法兑现 Q5 的三轮/恢复承诺。K1 需要在 `flow.mjs` 增加单步入口 `runStep`，由 Supervisor 驱动循环。

- A：授权 K1（违反 Q1 字面“flow 零侵入”，但保留 flow 的步骤实现）；
- B：不授权，缩短/降级 Q5 的自动恢复承诺，只做外层监督；
- C：把 Build 控制器拆成独立执行器（范围更大）。

**未裁决前不能进入实现切分。**

### D2：身份未验证策略与手工导入例外

strict / 显式例外的适用阶段；任何例外都不能显示为“已验证”。

### D3：三轮后人工追加

未裁决前保持三轮后停下；`accept_as_is` 已删除。

### D4：本机账户信任约定

Host 签名只能提高伪造门槛，不能证明操作者是人；是否接受本机 CLI 作为受信任的审批入口。

## 当前结论

设计方向、UI/UX、slash 命令、监控、模型管理已有实质方案；但 **B1/B4/B5 是正确性问题，不能带病进入完整实现切分**。需要用户先裁 D1，并决定是否继续做局部契约收口。
