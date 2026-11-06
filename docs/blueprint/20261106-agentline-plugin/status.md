# Blueprint 20261106 — AgentLine 插件状态

状态：**契约冻结 v7；进入实现准备（不直接改产品代码）**
日期：2026-11-06

## 最终基线

设计按以下顺序合并，未提到的后一份保持：

1. `design-v1.md`
2. `design-v2-delta.md`
3. `design-v3-delta.md`
4. `design-v4-contract.md`
5. `design-v5-contract.md`
6. `design-v6-contract.md`
7. `design-v7-contract.md`

`design-v8-note.md` 只是待实现说明，不是正式 contract。

## 已关闭

- Studio/Blueprint/Build 控制面边界；
- UI/UX、Inbox、slash 命令、监控、模型维护/配置、probe；
- B2/G2 固定快照、B4 K 恢复、T 缓存、D3 轮次；
- B5 批准锁、M3/M5 路径保护；
- S1 输入与旧执行者范围；
- 系统 note、晚到归档；
- 大量输入/执行/恢复契约。

## 冻结时已知限制

以下不作为继续开模型回合的理由，作为实现期测试/平台限制：

1. **B7-1 hidepid**：无法证明完整可见性时返回 `unknown(enum_visibility)`；`hidepid=4` 不靠组成员身份放行。实现必须覆盖“匹配 gid、仍有隐藏后代”。
2. **B7-2 时间基准**：持久化 `boot_id/btime/starttime ticks/absolute`；同一 boot 不得由第三层放行；缺失字段返回 `unknown`。
3. **B7-3 损坏输入锁**：不得直接删除；必须证明原持有者已终止并防止并发恢复；无法证明时 `E_INPUT_LOCK_CORRUPT`/blocked。
4. **U-W1 Windows 时钟**：接受“运行期间系统时钟不被回拨”的信任边界；检测到持续跳变返回 `unknown`。
5. Minor：清零夹具候选范围、L-cur 最终目录锁、状态表时机、合并稿清理。

## 实现准备下一步

1. 把 v1–v7 合并成单一设计基线，清理 `recording`、命令 ID、错误码、D1 字母和旧术语；
2. 建立 P0 测试夹具：输入锁、hidepid、boot_id、损坏锁、旧 CLI 后代；
3. 切出实现任务（不开始产品代码）：
   - 控制面/Read API/Command API；
   - Provider/Model Catalog/probe；
   - Studio/Blueprint 状态机与 gate；
   - 插件 UI 多项目/多任务；
   - Build Supervisor 与 K1。
4. UI mockup 已有多项目/多任务，可供实现前评审。

## 当前结论

设计方向、UI/UX、模型管理、错误/gate 已足够支撑实现准备；剩余问题作为实现期验收，不再继续无限契约回合。进入实现前，先完成单一合并基线和测试夹具。
