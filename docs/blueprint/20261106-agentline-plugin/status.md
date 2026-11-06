# Blueprint 20261106 — AgentLine 插件状态

状态：**契约修补 v7 完成；v8 未生成正式 contract，等待用户选择**
日期：2026-11-06

## 已完成

- `design-v1.md` / `review-v1.md`。
- `design-v2-delta.md` / `review-v2.md`。
- `design-v3-delta.md` / `review-v3.md`。
- `design-v4-contract.md` / `review-v4.md`。
- `design-v5-contract.md` / `review-v5.md`。
- `design-v6-contract.md` / `review-v6.md`。
- `design-v7-contract.md` / `review-v7.md`。
- `mockups/index.html`：含多项目/多任务的 UI mockup。

## Review v7 结果

已关闭：

- S1-1=A / S1-2=A；
- W7a/W16 和保证范围披露；
- reserved ID 优先级；
- B6-1 范围裁决；
- 系统 note、晚到归档、K 恢复、T 缓存、D3 保持关闭。

仍剩：

1. **B7-1**：`hidepid=4` 时组成员身份不能证明完整可见性，可能错误判空。
2. **B7-2**：`proc_start` 的 tick 与绝对开机时间混用，第三层可能错误放行同一 boot。
3. **B7-3**：损坏输入锁被直接删除，可能绕过互斥。
4. Minor：清零夹具候选范围、L-cur 边界、状态表时机、合并稿。

## v8 的情况

已启动 v8 局部修补，但 Claude 返回的是一份摘要，**没有写出正式的 contract 正文**；因此没有运行 review-v8，不能把 v8 当作已完成。

## 新的用户裁决 U-W1

Windows 进程创建时间使用墙钟。系统时钟回拨时，第二层可能漏掉后代：

- A（推荐）：把“运行期间系统时钟不被回拨”作为明确信任边界；检测到持续时钟跳变时返回 `unknown`。
- B：Windows 第二层始终 `unknown`，无守护时恢复一律要求重启。

## 当前判断

剩余问题已经从架构问题收敛为平台/进程边界的正确性细节。继续无限补契约的收益在下降；建议二选一：

1. 完成一次**最终 v8 正式 contract**（只修 B7-1/2/3 + U-W1），然后复核；
2. 冻结现有 v7 契约，把 B7 边界作为实现期测试/平台限制，不再继续模型回合。

在用户决定前，不进入实现切分，也不把 v7 当作已批准。
