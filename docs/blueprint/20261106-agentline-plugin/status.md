# Blueprint 20261106 — AgentLine 插件状态

状态：**契约修补 v5 完成；Review v5 = REVISE；无新的用户裁决**
日期：2026-11-06

## 已完成

- `brief.md`：完整 Blueprint 需求。
- `design-v1.md` / `review-v1.md`：v1。
- `design-v2-delta.md` / `review-v2.md`：v2。
- `design-v3-delta.md` / `review-v3.md`：v3。
- `design-v4-contract.md` / `review-v4.md`：D1–D4 后的契约收口。
- `design-v5-contract.md` / `review-v5.md`：输入账本、K 恢复、T 缓存、旧 CLI drain、D3 修补。
- `mockups/index.html`：含多项目/多任务的静态 UI mockup。
- `docs/studio/20261106-agentline-plugin/decisions.md`：D1=A、D2=人工登记、D3=显式追加、D4=本机 CLI 信任。

## Review v5 结论

已关闭：

- **B4**：K 恢复（recording 阶段、预计算 blob、R-TXN）；
- **B4 缓存**：T-PURE + 动态 `T.local_evidence`；
- **D3**：Build 的 `L_e`、Blueprint 的 `L_bp`、调度和 G1/T gate 贯通；
- M3/M5、B5、B2/G2、M2 保持关闭。

仍剩：

### B1-1 输入账本

- 系统 note 的正常路径没有在 beforeCall 前完成 `input.intent` 与实际输入 id 的绑定，会触发 `G_INPUT_UNRECONCILED`；
- 旧 CLI 在 `markConsumed` 整读与 rename 之间追加输入，可能丢失原文；旧 CLI 不写 `input.append`，不能靠下一次对账自愈。

### B1-2 晚到归档

- `call.archive_late` 复用原 `calls/<call_id>/` 目录，但原归档不可变；
- “late 已写、end 未写时再次崩溃”没有唯一恢复结果。

### B1-3 POSIX 终止证明

- 受守护的 Windows Job 路径已解决漏后代；
- 无守护 POSIX 回退遇到外部旧 subreaper 接管时，无法仅凭 `(pid,ppid,create_time)` 排除；
- 必须返回 `unknown`，不能放行。

### M4 旧 CLI drain

- 旧 `cmdRun` 没有 admission/任务锁/job 登记；
- 入口进程被杀后，模型子进程仍存活时，来源 (f) 找不到旧入口，drain 可能误报 0；
- 需要入口退出后仍保持非零或 `unknown`，直到后代终止被证明。

## 是否可进入实现切分

**no。** B1 三组和 M4 仍需局部契约修补；不需要重开架构、不需要新用户裁决。

## 当前建议

继续一次只修 B1-1/B1-2/B1-3/M4 的局部修补，然后再复核并拼装最终合并稿。UI mockup 已包含多项目、多任务，可供同时评审。
