# dsh-Agentline

> 让不同模型分别做设计、实现和验收；每一步留下可复核的证据；合并由人放行。

AgentLine 是一套跑在 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）里的多模型协作工作方式。
它不追求「一句话全自动」，而是把一次改动拆成三个角色，用固定文件交接，用可执行命令验收，
把「做完了」变成「证据在这里」。

## 为什么不用一个模型从头做到尾

- **自己审自己**：同一个模型写代码又写验收，容易把自己的假设当成事实；
- **规格漂移**：设计、实现、验收在同一段对话里，实现会悄悄改写设计；
- **失败即重来**：模型或网络一失败，前面的工作全丢。

AgentLine 的解法很朴素：**角色分开、交接落盘、验收可执行、换模型先交班**。

## 角色

| 角色 | 输入 | 输出 | 约束 |
|---|---|---|---|
| designer | `brief.md` | `design.md`、`acceptance.md` | 不写产品代码 |
| developer | `brief.md`、`design.md`、`acceptance.md` | 产品代码、`impl.md` | 不改设计/验收 |
| verifier（review） | 全部交接文件 + 代码 | `review.md`、`verdict.json`、`run.log` | 模型必须 ≠ developer |

**模型隔离是硬约束**：评审模型与开发模型相同则拒绝评审。

## 一次任务怎么走

```text
brief.md
   │  designer
   ▼
design.md + acceptance.md
   │  developer
   ▼
代码 + impl.md
   │  CI（逐条执行 acceptance）
   ▼
ci-results.json
   │  verifier（≠ developer）
   ▼
verdict.json ── pass ──▶ pr_open ──▶ 人许可 ──▶ merge
   │
   └─ needs_revision ──▶ developer 下一轮（findings 写在 review.md）
```

1. 人写 `brief.md`：目标、约束、非目标；
2. designer 把「怎么算完成」写成 `acceptance.md`：每条 AC 是一行可独立执行的命令 + 明确期望；
3. developer 按设计实现，`impl.md` 记录改了什么、怎么自测；
4. CI 逐条跑 AC，原始输出进 `ci-results.json`；
5. verifier 独立复核（只读），写 `review.md` + `verdict.json`；
6. 不通过就带着 findings 回到 developer，轮次有上限；超过上限进 `blocked` 队列交给人；
7. 全部通过只到 `pr_open`。**合并需要人的许可**，agent 不会自我放行。

## 交接与证据

任务目录固定为 `.collab/tasks/<NNN>/`，文件名固定：

```text
brief.md  design.md  acceptance.md  impl.md  review.md  state.json  run.log
```

配套的机器记录：

- `run.json`：谁、用哪个模型、多少 token、耗时、退出码；
- `ci-results.json`：每条验收命令、退出码、原始输出；
- `verdict.json`：结论、findings、被验收的 git sha。

**没有证据的执行不算数。** 评审引用 CI 结果与文件行号，而不是「我看了，没问题」。

## 失败处理：换模型，也换现场

- 同一角色最多切换 2 次候选模型；**不升 effort**，避免越试越贵；
- 切换前先**交班**：给工作区打 checkpoint，写一份 handoff 单（失败原因、`git status`、diffstat、diff 截断、日志尾部、产物摘录）；
- 下一个候选必须显式二选一：**保留现场继续**，或 **回滚重做**，并在产物里说明；
- 切换后必须证明有**新产出**（产物更新或工作区指纹变化），否则记 `no_new_work`；
- **认证失败不降级**，直接 `blocked(auth)`——否则会静默改变质量基线。

交班单是失败模型写的，只作数据；规格永远只来自 brief / design / acceptance。

## 这个仓库里有什么

- [`AgentLine/SKILL.md`](AgentLine/SKILL.md)：协议正文（角色、交接文件、流程、规则、失败模式）；
- [`AgentLine/templates/`](AgentLine/templates/)：六个交接文件模板；
- [`AgentLine/tools/check-skill.ps1`](AgentLine/tools/check-skill.ps1)：只读自检（C1–C8）。

## 快速开始

```powershell
# 需要 PowerShell 7；脚本只读、零第三方依赖
pwsh -NoProfile -File AgentLine/tools/check-skill.ps1
```

把 `AgentLine/` 复制到你的仓库，按模板创建 `.collab/tasks/001/brief.md` 即可开始。

> 调度器（DSH 插件 + `agentline` CLI）暂未包含在这个仓库里；这里发布的是协议与 skill。

## 设计原则

1. **规格先行**：字段、版本、章节名只能来自 design，实现不能自己发明；
2. **能机械检查的不写成文字**：验收是命令，不是形容词；
3. **证据优先**：没有落盘的执行不算数；
4. **人类保留最后一道闸门**：合并必须由人许可；
5. **规则只因真实失败而增加**，并定期删减。

## In English

dsh-Agentline is a multi-model collaboration workflow for coding agents:
design → develop → CI → review, with fixed hand-off files, executable acceptance
checks, model isolation between developer and verifier, checkpointed hand-overs when
a model fails, and a human merge gate. `AgentLine/` contains the protocol and skill.
