# 编排器自我进化要求（Self-Evolution Requirements）

> 本文定义 AgentLine 编排器**如何因为一次失败而变强**。
> 核心命题：编排器不能只"执行任务"，它必须在执行过程中改造自己 —— 否则同一个坑会以不同外表反复出现。
> 依据：2026-11-07/08 连续推进 13 个任务的实测（同类故障重复 4 次、单任务返工最多 12 轮）。

## 1. 总原则

```text
执行 → 归因 → 守卫 → 回归 → 复用
```

四步缺一不可。**没有守卫的修复等于没修** —— 它只解决了当前任务，没有改变下一次遇到同类问题时的结果。

编排器的进化必须满足三条硬约束：

1. **可机械验证**：每条改进都要能变成一条会红的检查，而不是一句心得
2. **可回滚**：改进本身也要有证据链，能被撤销
3. **可度量**：同类故障的复发次数必须能被统计，且目标为 0

## 2. 必须进化的六个面

| 面 | 触发 | 进化动作 |
|---|---|---|
| **契约** | 验收/接口冲突 | 把隐性约定固化成 schema + 校验器（例：`acceptance.md` 的 `## AC-xxx` 格式） |
| **模板** | 每个任务重复犯同一格式错 | 生成阶段就带正确骨架（`new-task` 生成 acceptance 骨架） |
| **前置检查** | 失败源于环境而非任务 | 把检查搬到 `preflight` / `flow` 启动（例：git 可用性、`/mnt` 污染、依赖产物可见性） |
| **状态同步** | worktree 看不到 main 的提交 | 扩权/修复必须同步到 main 与所有活跃 worktree |
| **模型路由** | stall、quota、身份不可证 | 记录每次调用的耗时/错误/证据等级，按实测数据调整候选顺序 |
| **操作者纪律** | 人工失误重复出现 | 把易错动作变成工具约束（多行文本必须经文件传递） |

## 3. 进化必须落盘为"守卫"

每条教训至少产出一种守卫：

```text
GUARD(exit-code)   脚本检查，非零即阻断（check-acceptance、check-no-collab）
GUARD(preflight)   启动前探测（provider 可用性、凭据、git 状态）
GUARD(template)    生成即正确（acceptance 骨架、brief 模板）
GUARD(invariant)   测试断言不变量而非具体值（禁止写死其他任务状态）
GUARD(routing)     路由表（stall 先重试同模型，再换候选）
```

守卫的元数据必须包含：`class`（六类之一）、`trigger`（哪种失败）、`regression`（会红的用例）、`since`（从哪个任务开始生效）。

## 4. 归因的硬要求

失败归因不能依赖模型自述。必须由编排器自己收集：

| 证据 | 来源 |
|---|---|
| `blocked_reason` | `state.json` |
| 失败 AC 与原始输出 | `ci-results.json`（**不存在 = runner 解析失败**，不是"全挂"） |
| 最后三次调用 | `run.json`（模型、耗时、error、候选切换） |
| 模型自报问题 | `notice.json` / `impl.md` |
| 证据路径 | `logs/`、`handoff/` |

缺少任何一项时，编排器必须先补齐证据再判断 —— 不允许"猜原因"。

## 5. 拆分与止损

当同一任务出现下列任一情况，编排器必须主动改变策略，而不是重试：

| 信号 | 动作 |
|---|---|
| 同一 AC 连续 3 轮失败 | 判定"任务范围过大"，拆分或缩小验收 |
| 同一 finding 连续 2 轮重复 | 判定"评审沿用陈旧证据"，重新取证后复评 |
| 单任务耗时 > 基准 3 倍 | 停止重试，输出诊断报告并升级给人 |
| 分支与 main 冲突且解冲突成本高 | 删除 worktree 从 main 重建（优于手工解冲突） |

**重试不是策略，改变假设才是。**

## 6. 度量与门槛

编排器应持续输出：

```json
{
  "by_class": { "FORMAT": 4, "DEPENDENCY": 3, "ENVIRONMENT": 2, "CONTRACT": 3, "CAPABILITY": 3, "OPERATOR": 4 },
  "recurrence_after_guard": { "FORMAT": 0, "DEPENDENCY": 2 },
  "guards_without_regression": 0,
  "mean_retries_per_task": 1.4,
  "mean_task_minutes": 38
}
```

门槛：

- `recurrence_after_guard` 必须为 0；非 0 说明守卫失效，优先级高于任何功能任务
- `guards_without_regression` 必须为 0；没有回归用例的守卫视为不存在

## 7. 进化本身的审计

每新增一条守卫，必须记录：

```yaml
guard: check-acceptance
class: FORMAT
trigger: acceptance.md 提取到 0 条命令
regression: test/unit/check-acceptance.test.mjs (expects exit 1)
since: task 007
evidence: 002/004/005/007 四次 ci_failed, exit 2, 无 ci-results.json
```

没有 `evidence` 的守卫不允许合入 —— 否则会积累一堆"看起来有用但没人知道为什么存在"的检查。

## 8. 与人协作的边界

编排器自我进化**不得越过三类决定**：

1. 改对外契约
2. 改产品范围与优先级
3. 消耗真实凭据/额度

其余（格式、模板、前置检查、路由顺序、拆任务）由编排器自行决定并记录。

## 9. 一句话

**编排器的价值不在于一次把任务做对，而在于第二次遇到同类问题时不需要人再解释一遍。**
衡量标准只有一个：同类故障的复发次数。
