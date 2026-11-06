# AgentLine v2 设计基线

状态：P0 冻结基线（2026-11-06）
来源：`docs/blueprint/20261106-agentline-plugin/` 的 v1–v7
规范顺序：本文件是规范索引；v1→v7 的具体替换章节仍保留在 Blueprint 目录。若本文件与旧 v1 冲突，以本文件和后序 delta 为准。

## 1. 边界

- `flow.mjs` 继续负责单任务 Build。
- Studio / Blueprint / Build Supervisor 是控制面，与 `flow.mjs` 平级，不塞进 flow 或插件 Host。
- 插件只做投影、输入收集、公开 CLI 调用；不写 `.collab/**`，不做第二套 orchestrator。
- 所有会改变下一步行为的状态由核心/控制面写入；插件只读。
- K1 已获授权：在 `flow.mjs` 增加 `runStep` 单步入口，由 Supervisor 驱动；`runFlow`/`exec` 旧语义不变。

## 2. 数据与命令

- A 级（git）：定稿契约、state、run、verdict、gate、approval、`records_index_sha256`。
- B 级（外置/gitignore）：原始日志、rounds、handoff、输入原文、CI 原始输出。
- 控制面目录：`.collab/{pipeline.json,studio,blueprint,build,milestones}/`。
- 新命令：`pipeline summary`、`studio *`、`blueprint *`、`build *`、`roles *`、`models *`。
- 所有写命令带 `--expected-revision`、`--idempotency-key`、`--channel ui|slash|cli`。
- Host v2：只读走 Read API；写入走单一 `/agentline/v2/command` 白名单，每条映射一条 CLI。

## 3. 阶段与 gate

- G0 Studio：决策有用户确认或明确采用默认；专家确认；无 open blocking；每个 decision ≤2 轮；书记模型 ≠ 主持。
- G1 Blueprint：task-graph schema/无环/AC 双向覆盖；review pass ≤3（追加轮按 L）；testability 无 open blocker；模型隔离；用户批准绑定内容哈希。
- Build T gate：来源有效、CI、review、隔离、证据新鲜；不可豁免项不能 waiver。
- G2：固定历史集成快照 I，不是当前 main；人工检查进入批准哈希。
- gate JSON：`agentline.gate/v1`，checks/waivers/approval/content_hash/revision；`pass` 由核心求值，插件只渲染。
- 批准绑定 `sha256`；内容变化 → stale；普通 gate 不能绕过不可豁免项。

## 4. 输入、锁与终止证明

- 输入账本：`<B>/build/NNN/inputs.ledger.jsonl` 是原文权威来源；`inputs.jsonl` 是内核投影。
- 消费状态以 `step.end{ok:true}.inputs_consumed` 为准；输入 id 必须稳定；系统 note 使用确定性 id。
- 输入锁：`orchestrator/lib/contracts/input-lock.mjs`；`mkdir` 原子获取，owner 文件，损坏锁不自动删除，stale 仅当 owner 已死。
- `inputs.mjs` 的 append/markConsumed 已使用输入锁；运行期不支持 L-foreign 并发写输入（S1-1=A）。
- 终止证明：只有 Job Object / subreaper / 等价 tree guard 能证明整棵树已终止；仅 pid 死亡返回 `unknown`。
- POSIX 无守护：无法证明枚举完整 → `unknown`；macOS 第二层始终 `unknown`。
- Windows 时钟：接受“运行期不被回拨”的信任边界；检测到持续跳变 → `unknown`。

## 5. 模型与 provider

- provider manifest + runtime descriptor；版本/二进制指纹变化使能力缓存失效。
- 模型目录：provider、origin、canonical id、identity_group、tier、availability、scope、observed/expires。
- top 档位必须显式 allowlist；CLI discovered 不等于 callable。
- 角色先锁定，再短上下文 probe；probe 失败不静默降级。
- 手工登记是兜底；人工例外必须持续标记 `unverified`。
- Studio：专家/主持 top，书记允许 advanced；Blueprint：三角色 top 且两两不同，设计/评审不同厂商，测试架构跨厂商为偏好。
- Cursor provider：P2 接入；详见 `docs/design/cursor-provider.md`。

## 6. 错误与轮次

- 结构化错误：code/category/provider_code/http_status/exit_code/scope/retry_after/reset_at/evidence_ref/side_effects/recovery_action。
- 可逆基础设施问题（429/断网/模型限制）→ 轮换/重试，不计业务轮次。
- 业务三轮不收敛 → `awaiting_user`；用户可显式追加一轮并记录 deviations。
- 未知副作用、无法证明终止、输入锁损坏 → blocked/unknown，不自动重放。
- 每次物理调用独立记录；重试/切换计入预算。

## 7. UI/UX

- 顶栏：项目选择（全部/单项目）、Studio/Blueprint/Build 阶段、待处理、运行中、额度。
- 首页：项目组合 + Inbox（问题、审批、阻塞）+ 跨项目运行队列。
- Studio：角色/预算/轮次/问题/FACT/纪要/确认/异议。
- Blueprint：轮次、设计/评审/测试架构、任务图、验收矩阵、Gate、materialize。
- Build：项目列、来源、测试层级、T gate、状态、模型、业务轮次 vs 基础设施重试。
- 设置：模型目录、角色矩阵、Provider、预算/轮次、变更历史。
- slash：`/agentline status|studio|blueprint|task|models|approve|answer`；写操作对应单条 CLI。
- 静态 mockup：`docs/blueprint/20261106-agentline-plugin/mockups/index.html`。

## 8. 已知实现限制（P0 冻结）

1. `hidepid` 无法证明完整可见性 → `unknown`。
2. 同一 boot 不得由开机时间层放行。
3. 损坏输入锁不自动删除；无法证明原持有者死亡 → blocked。
4. Windows 时钟回拨接受信任边界；持续跳变 → `unknown`。
5. 旧 CLI 无 admission 的“从未观测、无残留证据”执行者，排除出 drain 保证；可证明的旧执行者仍保持非零/unknown。
6. 清零验收必须在无其他候选、无未清除屏障的夹具下进行；环境噪声判 `inconclusive`。

## 9. P0 代码契约

- `orchestrator/lib/contracts/gate.mjs` + `gate.schema.json`：gate 校验/求值。
- `orchestrator/lib/contracts/input-lock.mjs`：输入锁。
- `orchestrator/lib/contracts/termination.mjs`：保守终止证明。
- `orchestrator/test/contracts-*.test.mjs`：P0 契约测试。
- `inputs.mjs` 的 append/markConsumed 已接入输入锁。

## 10. 实现顺序

P0 契约/夹具 → P1 控制面/Read API → P2 模型目录（含 Cursor）→ P3 插件 UI → P4 Build K1/Supervisor。
