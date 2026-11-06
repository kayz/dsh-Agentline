# Blueprint 20261106 — AgentLine 插件状态

状态：**契约修补 v6 完成；Review v6 = REVISE；仅剩 S1 范围裁决 + POSIX 判空收口**
日期：2026-11-06

## 已完成

- `design-v1.md` / `review-v1.md`：完整设计 v1。
- `design-v2-delta.md` / `review-v2.md`：第 2 轮。
- `design-v3-delta.md` / `review-v3.md`：第 3 轮。
- `design-v4-contract.md` / `review-v4.md`：D1–D4 后契约收口。
- `design-v5-contract.md` / `review-v5.md`：输入账本、K 恢复、T 缓存、drain、D3。
- `design-v6-contract.md` / `review-v6.md`：系统 note、晚到归档、POSIX 终止证明、旧 cmdRun 后代。
- `mockups/index.html`：含多项目/多任务的静态 UI mockup。

## Review v6 结论

已关闭：

- B1-1 系统 note 的确定性 ID、P1b 持久化、P2 去重、W0 恢复；
- B1-2 晚到归档：主/late 独立目录与 ref，W1b-L 唯一结果；
- C_auth 包含 initial adopt；
- B4 K 恢复、T 缓存、D3 保持关闭；
- M4 入口退出后的记录保留、来源 g/h/i 已补计数对象。

仍剩：

1. **S1 用户范围裁决**：运行期间的 L-foreign 输入兼容，以及“从未观测、无残留证据的旧执行者”是否排除出 drain 保证。
2. **B6-2 POSIX 判空条件**：`Cand = ∅ → proven_dead` 需要进程枚举完整性前提；`hidepid`、权限可见性变化、枚举期间进程创建/退出都会使“扫描无报错”不等于完整快照。无法建立完整性时必须返回 `unknown`。
3. 实现前契约整理（Minor）：L-cur 锁接入、reserved ID 优先级、清零验收夹具、合并稿清理。

## 需要用户裁决（仅 S1，两项）

### S1-1 输入兼容

- **A（推荐）**：接受运行期间不支持 L-foreign 输入；新版输入命令与 runStep 通过输入锁互斥；不修改 `inputs.mjs` 的 append-only 格式。
- B：追加授权修改 `inputs.mjs` 为 append-only 状态事件，同时保留回滚格式转换。仍不能覆盖无证据的旧外部写入者。

### S1-2 旧执行者保证

- **A（推荐）**：接受把“从未被观测、且没有残留证据的旧 L-foreign 执行者”排除出 drain 保证；可证明的旧执行者仍保持非零/unknown，直到终止证明。
- B：不接受排除；需要额外机制才能覆盖无证据旧执行者（范围更大，需单独立项）。

## 当前结论

B6-2 是正确性收口，不能通过人工批准跳过。S1 裁决后，只需一次局部收口（POSIX 判空 + Minor 合并稿），即可尝试进入实现切分。
