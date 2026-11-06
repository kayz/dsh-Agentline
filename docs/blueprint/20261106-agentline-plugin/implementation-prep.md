# AgentLine 插件实现准备

状态：设计冻结 v7，准备切分实现；尚未修改产品代码
日期：2026-11-06

## 基线

- 设计：`design-v1.md` + `design-v2-delta.md` + `design-v3-delta.md` + `design-v4-contract.md` + `design-v5-contract.md` + `design-v6-contract.md` + `design-v7-contract.md`
- UI：`mockups/index.html`（含多项目/多任务）
- 用户决策：`docs/studio/20261106-agentline-plugin/decisions.md`

## 实现前必须先做的整理

1. 合并成单一基线文档，清理：
   - K0 旧方案、摘要计轮；
   - `recording` 阶段、命令 ID、错误码；
   - D1 字母统一为 decisions.md 的 A＝K1；
   - A3/A3L 编号。
2. 建立测试夹具，不写产品代码：
   - 输入锁与 L-foreign 拒绝；
   - `hidepid=0/1/2/4` + 隐藏后代；
   - `boot_id/btime/starttime` 的同一 boot / reboot；
   - 损坏输入锁 + 原持有者存活；
   - 旧 `cmdRun` 入口退出、后代存活。
3. 把 B7-1/B7-2/B7-3/U-W1 写成实现验收，不再作为设计阻塞。

## 实现切分建议

### P0：基础契约与夹具

- 单一合并基线：`docs/design/agentline-v2-baseline.md`；
- `orchestrator/lib/contracts/gate.mjs` + `gate.schema.json`；
- `orchestrator/lib/contracts/input-lock.mjs`，并接入 `inputs.mjs`；
- `orchestrator/lib/contracts/termination.mjs`；
- 契约测试与故障注入。

### P1：控制面

- `pipeline summary` / Read API；
- Command API 白名单（单命令、idempotency、expected_revision）；
- Studio/Blueprint 状态机骨架；
- gate/approval/hash。

### P2：模型管理

- Provider manifest + runtime descriptor；
- Model Catalog/tier/allowlist；
- 手工登记 + unverified；
- 短上下文 probe 与 job；
- 设置页配置 UI；
- **Cursor provider**：本机已安装 Cursor 3.29.9，`cursor agent` 子命令存在；模型发现/probe/自动调用方式待验证，详见 `docs/design/cursor-provider.md`。Cursor 的 discovered 模型不得自动进入 top allowlist。

### P3：插件 UI

- 多项目组合视图；
- Inbox；
- Studio/Blueprint/Build 页面；
- slash 命令与命令面板；
- 监控/错误/模型状态。

### P4：Build 接入

- K1 `runStep` + Supervisor；
- 输入账本、归档、drain；
- 任务图 materialize；
- T/G2 gate。

## 不做什么

- 不再开泛化模型契约回合；
- 不直接把 v7 当作已实现；
- 不在实现前重写 UI 信息架构；
- 不用普通 gate 豁免替代终止证明/输入互斥。
