# Blueprint 20261106 — AgentLine 插件状态

状态：**契约收口 v4 完成；Review v4 = REVISE；无新的用户裁决，仍有局部契约待修补**
日期：2026-11-06

## 已完成

- `brief.md`：完整 Blueprint 需求。
- `design-v1.md`：主设计 v1（105k）。
- `design-v2-delta.md` / `review-v2.md`：第 2 轮。
- `design-v3-delta.md` / `review-v3.md`：第 3 轮。
- `design-v4-contract.md` / `review-v4.md`：用户 D1–D4 后的契约收口。
- `docs/studio/20261106-agentline-plugin/decisions.md`：D1=A、D2=人工登记、D3=显式追加、D4=本机 CLI 信任。

## Review v4 结论

已关闭：

- B5 批准竞态；
- M3/M5 原问题；
- B4 正常合并校验循环；
- D1 K1 授权边界、D2 人工例外、D4 本机信任落地。

仍剩：

### B1 部分关闭

1. `rebindInputs` 依赖 `HEAD:inputs.jsonl`，但 `inputs.jsonl` 按 Q6 外置/gitignore；消费后、提交前崩溃无法恢复。
2. `call.archive` 已落盘、`call.end` 未落盘的窗口没有恢复分支。
3. Windows 进程终止证明仍可能漏掉存活的后代进程。

### B4 部分关闭

1. K 已提交、`phase=recorded` 之前崩溃，会被误判为分歧；K 写入/暂存未提交窗口也未定义。
2. `T_content` 缓存键没有覆盖 `check-task -Sealed` 的本机日志检查；修改本机日志后缓存仍可能命中。

### M4 部分关闭

旧 `executeRole` 在 adapter 调用结束到下一候选之间会短暂 `clearLive`；drain 可能误报零运行。旧 CLI 没有 admission/任务锁。

### D3 部分落地

- 调度规则仍要求 `k < 3`；
- G1 的不可豁免检查仍是 `rounds_le_3`；
- 追加的第 4 轮无法通过调度和 G1。

## 无新的用户裁决

D1–D4 不需要重裁。剩余是现有授权内的局部契约修补；不需要重开架构，不需要新增产品功能。

## 是否可进入实现切分

**no。**

前置条件：

1. 关闭 B1 输入恢复、archive/end 窗口、进程终止证明；
2. 关闭 B4 K 恢复窗口与 T 缓存边界；
3. 修正旧 CLI drain 生命周期；
4. 同步 D3 到调度和 G1；
5. 拼装最终设计合并稿。

## 当前建议

继续一次**局部契约修补**（不重开 Blueprint 范式，不新增用户决策），只修上述四项，再复核。现有 UI/UX、slash 命令、监控、模型配置、控制面架构可以保留。
