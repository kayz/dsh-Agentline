# 03 · Studio / Blueprint / Build 三阶段协议

状态：**协议层已采纳；调度器实现待做**
日期：2026-11-05

这份文档定义 AgentLine 外围的三阶段协作方式。它不改变 AgentLine 内核的边界：**内核仍然只负责一个 Build 任务**；Studio 和 Blueprint 是可选的上游控制面，最终把任务图和 brief 交给 AgentLine。

## 1. 三个阶段

| 阶段 | 目的 | 角色 | 主要产物 | 用户闸门 |
|---|---|---|---|---|
| **Studio** | 发散、立项、拍板 | 3 个顶级专家 + 1 个顶级主持 + 1 个书记 | `minutes-final`、`project-goals`、`decisions` | 用户确认范围与关键决策 |
| **Blueprint** | 系统设计、任务拆分、测试架构 | 顶级设计师 + 顶级评审 + 顶级测试架构师 | 架构、接口、任务图、验收矩阵、测试策略/框架 | 用户确认设计、范围和测试策略 |
| **Build** | 逐任务实现、CI、评审 | AgentLine 现有 designer / developer / verifier | 代码、测试、CI 结果、验收证据 | 里程碑验收、最终发布验收 |

Studio 不写产品代码；Blueprint 不写产品代码；Build 才修改产品仓库。

## 2. Studio 的退出条件

- 三位专家完成观点、拆台和确认；
- 书记员完成纪要；
- 用户确认 `decisions` 中每一项，或明确采用默认值；
- 没有“待后续讨论”才能启动的阻塞项。

Studio 的讨论轮次按决策计，不按“再聊一轮”计。一个决策最多两轮；两轮后采用默认值或标记未解决异议。

## 3. Blueprint 的硬规则

### 3.1 角色

- **设计师**：写系统架构、接口、任务图、每任务 `write_scope`、依赖和验收方向；不写产品代码。
- **评审**：找不可实现、不可测试、范围过大、接口不清和依赖错误；不替设计师重写。
- **测试架构师**：在最终设计评审前检查可测试性，设计测试分层、框架和验收矩阵；不参与产品设计。

设计师、评审、测试架构师必须使用不同模型；测试架构师尽量来自不同厂商。

### 3.2 最多三轮

```text
设计 v1 → 评审意见 → 设计 v2 → 评审意见 → 设计 v3 → 定稿或 blocked
```

- 第三轮仍不收敛：停止模型讨论，交用户裁决或 `blocked`；
- 不允许“再开一轮讨论”；
- 每轮必须留下评审意见和设计差异，不能只留结论。

测试架构师的 testability blocker 必须在第三轮定稿前解决；否则 Blueprint 不通过。

### 3.3 Blueprint 退出条件

- 每个验收项都能映射到任务；
- 每个任务有输入、输出、`write_scope`、依赖、验收命令和测试层级；
- 没有未决的架构空白；
- 测试架构师确认可测试；
- 用户确认设计、范围和测试策略。

### 3.4 产物

```text
blueprint/
  architecture.md
  interfaces.md
  task-graph.json
  acceptance-matrix.md
  test-strategy.md
  test-framework/
  risks.md
```

`task-graph.json` 至少包含：

```json
{
  "milestone": "M1",
  "tasks": [
    {
      "id": "002",
      "title": "宿主状态机与角色包加载",
      "depends_on": [],
      "write_scope": ["crates/", "packages/"],
      "acceptance": ["AC-001", "AC-002"],
      "test_levels": ["unit", "integration"],
      "user_gate": false
    }
  ]
}
```

这份任务图用来生成 AgentLine 的 `brief.md` 和任务顺序；不是另一套执行器。

## 4. 测试设计在什么时候做

测试不是等代码写完再补，也不是在 Blueprint 阶段一次写完全部用例。

### 4.1 Blueprint 阶段：测试架构

测试架构师在 Blueprint 定稿前产出：

- 测试分层：单元、契约、集成、E2E、人工验收；
- 每个验收项对应的测试层；
- 测试框架、目录、CI 命令和环境；
- fixture、mock、测试数据和隔离要求；
- 哪些必须自动化，哪些必须人工（视觉、音色、口型、桌面交互）；
- 每个任务的测试责任：谁写、何时写、CI 跑什么。

产物是 `test-strategy.md`、`acceptance-matrix.md` 和 `test-framework/` 骨架，不是全部测试代码。

### 4.2 Build 阶段：每个任务补测试

- 任务设计阶段确定该任务的测试点；
- 开发者实现代码时同时写测试；
- CI 跑该任务的单元/契约/集成测试；
- 评审检查测试是否覆盖任务验收项。

### 4.3 集成与用户验收前：完整测试

- 跨任务 E2E；
- 全量回归；
- 用户验收场景；
- 桌面特有检查：透明窗口、点击穿透、性能、音画同步；
- 全套通过后才交给用户验收。

## 5. 用户闸门与自动化

默认只在三个位置停：

| 闸门 | 用户看什么 | 谁可以自动通过 |
|---|---|---|
| **G1 Blueprint** | 架构、任务图、测试策略、范围 | 不能自动通过 |
| **G2 里程碑** | 可运行演示、验收结果、已知问题 | 不能自动通过 |
| **G3 发布** | 交付包、激活/额度、最终验收 | 不能自动通过 |

任务内部默认自动执行：

- Blueprint 生成的任务按依赖自动排队；
- 任务 design → dev → CI → review 自动执行；
- 低风险任务在已批准 Blueprint 范围内可使用预授权合并；
- 高风险任务仍需人工合并；
- 只有 `blocked`、`attention`、验收失败或模型耗尽才升级给用户。

自动化不改变 AgentLine 的合并闸门和证据链；只是在已批准范围内减少逐任务干预。

## 6. 模型分配与隔离

```text
Studio：
  专家 3 个顶级模型
  主持 1 个顶级模型
  书记 1 个高级模型（不参与判断）

Blueprint：
  设计师 1 个顶级模型
  评审 1 个顶级模型（不同厂商）
  测试架构师 1 个顶级模型（尽量不同厂商）

Build：
  designer / developer / verifier 按 AgentLine 配置
  verifier 必须 ≠ developer
```

规则：

- Studio 和 Blueprint 只用顶级模型；不可用就等待或换同档，不静默降级；
- 同一模型不能同时担任设计师和评审、测试架构师和评审；
- 设计师、评审、测试架构师使用独立上下文；
- 模型的实际解析结果写入 run 记录，不以自报模型名为准。

## 7. 与 AgentLine 内核的交接

Blueprint 的输出进入 Build 时，必须转换成 AgentLine 已经认识的格式：

- 每个任务一个 `.collab/tasks/<NNN>/brief.md`；
- `brief.md` 写明目标、非目标、约束、建议验收方向；
- AgentLine designer 再写该任务的 `design.md`、`acceptance.md` 和 `write_scope`；
- Blueprint 的 `task-graph.json` 只用于排序和依赖，不替代 AgentLine 的任务状态机。

Blueprint 不是新的执行器；Studio/Blueprint 是控制面，AgentLine 是执行面。

## 8. 失败与停止

- Blueprint 三轮不收敛 → 用户裁决或 `blocked`；
- 测试架构师判定不可测试 → 回到设计，但计入三轮上限；仍不收敛则 `blocked`；
- Build 任务超过轮次上限 → `blocked`，不继续自动换模型；
- 用户验收失败 → 回到对应任务或 Blueprint，不在聊天里重新发散；
- 任何阶段都不以“再讨论一轮”为默认下一步。

## 9. 尚未实现

本文是协议层改动，调度器尚未实现：

- 独立的 `blueprint` 命令/状态机；
- 测试架构师角色和测试框架任务类型；
- 从 `task-graph.json` 自动生成 AgentLine 任务；
- 低风险任务自动合并的默认策略；
- Studio/Blueprint 的 DSH 插件入口。

在这些实现完成前，Blueprint 可以用手动任务和现有 `design` 角色完成；不要声称内核已经支持三阶段。
