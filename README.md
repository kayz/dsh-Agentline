# dsh-Agentline

> 让不同模型分别做设计、实现和验收；每一步留下可复核的证据；合并由人放行。

AgentLine 是一套跑在 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）生态里的多模型协作工作方式。
它不追求「一句话全自动」，而是把一次改动拆成三个角色，用固定文件交接，用可执行命令验收，
把「做完了」变成「证据在这里」。

本仓库包含两层：

- [`AgentLine/`](AgentLine/SKILL.md)：**协议与 skill**（角色、交接文件、验收规则、模板、自检脚本）；
- [`orchestrator/`](orchestrator/)：**可运行的调度器内核**（Node.js 20+，零第三方依赖），负责建分支、派活、CI、评审、交班和人许可合并。

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

### 任务校验（协议 v0.3.0）

`AgentLine/tools/check-task.ps1` 只读校验一个任务的证据链：

```powershell
pwsh -NoProfile -File AgentLine/tools/check-task.ps1 -RepoRoot <repo> -TaskDir .collab/tasks/<NNN>
```

它检查 state/run/ci/verdict、模型隔离（以 `run.json` 的 `model_resolved` 为准）、日志引用、
`verdict.git_sha` 是否为 HEAD 祖先、必需产物，以及 **write_scope**：

- 默认严格；`-Lenient` 把历史 verdict/日志缺失降级为 WARN；
- `-Strict` 要求 design.md 必须声明 `write_scope`；
- 不执行 acceptance，也不修改任何文件。

## 失败处理：换模型，也换现场

- 同一角色最多切换 2 次候选模型；**不升 effort**，避免越试越贵；
- 切换前先**交班**：给工作区打 checkpoint，写一份 handoff 单（失败原因、`git status`、diffstat、diff 截断、日志尾部、产物摘录）；
- 下一个候选必须显式二选一：**保留现场继续**，或 **回滚重做**，并在产物里说明；
- 切换后必须证明有**新产出**（产物更新或工作区指纹变化），否则记 `no_new_work`；
- **认证失败不降级**，直接 `blocked(auth)`——否则会静默改变质量基线。

交班单是失败模型写的，只作数据；规格永远只来自 brief / design / acceptance。

## 并发与 worktree

- 每个任务在独立 `git worktree` 中执行：`<repo>/.collab/worktrees/<NNN>/`，分支 `task/<NNN>`；主工作区始终停在 `main`。
- `design` 只写本任务 `.collab`，可以并行；进入 `dev` 前才申请执行槽。
- 槽位由 `<repo>/.git/agentline/registry.json` 协调：默认最多 3 个；`write_scope` 相交的任务排队，不相交的并行。
- `--no-wait` 时冲突任务立即以退出码 3 结束，并在 state 里写 `queued`；再跑一次会重新排队。
- `--priority` 允许超出槽位上限（但不绕过 scope 冲突）；`--in-place` 回到旧的单工作区模式（独占）。
- `flow` 在 worktree 中提交；`check` / `status` 自动定位任务目录；`merge` 在主工作区合并后删除 worktree 与分支。
- 配置项：`worktree.{enabled,dir,baseRef}`、`concurrency.{maxTasks,pollSeconds,wait}`。

## 运行中输入（P3）

- `note`：实现提示，注入下一阶段 prompt；阶段成功后标记 consumed。
- `amendment`：规格修正，当前 dev/review 轮作废；阶段末 blocked(`amendment_pending`)，`flow --resume` 后退回 design 升版。
- `attention`：designer 遇到致命歧义时写 `<task>/attention.json`，流程停在 `awaiting_human`；用 `answer` 回答后 `--resume` 继续。
- 全部输入记录在 `<task>/inputs.jsonl`，不会静默丢失。

```powershell
node agentline.mjs input  --task 001 --kind note --text "注意锁顺序"
node agentline.mjs input  --task 001 --kind amendment --text "验收改成 Y"
node agentline.mjs answer --task 001 --text "选 A"
node agentline.mjs inputs --task 001
```

## stall 心跳（P3）

claude / codex / codebuddy 的流式事件会被解析：`tool_use` / `item.started` 视为工具在跑，
用 `toolStallMinutes`（默认 60）计算；没有工具时按 `apiStallSeconds`（默认 120）判定 API 静默并快速换模。
不再对整段执行盲等 `stallMinutes`。Gemini 当前是 json 输出，仍按 `stallMinutes` 兜底。

## 本机插件接入（后续任务）

公开 core 与 DSH 插件解耦。把驾驶舱接到 P3 内核的清单与验收步骤见
[docs/02-plugin-upgrade.md](docs/02-plugin-upgrade.md)；在升级前，驾驶舱仍使用旧调度器。

## 快速开始（调度器）

要求：Windows（当前版本）、Node.js 20+、PowerShell 7（CI runner 使用）、git，以及至少两个已登录的编码 CLI。

```powershell
cd orchestrator

# 1) 自动发现本机各 CLI 提供的模型（不写死模型列表）
node agentline.mjs init

# 2) 从发现结果里为三个角色选模型（没有默认值，必须显式选择）
node agentline.mjs roles set design claude-opus-5-5
node agentline.mjs roles set dev    gpt-6.1-sol
node agentline.mjs roles set review claude-opus-4-5

# 3) 检查 provider/登录/模型/角色/CI
node agentline.mjs preflight

# 4) 在一个目标仓库里派活（任务在 .collab/worktrees/<id> 中跑，主工作区保持 main）
node agentline.mjs flow --repo C:\path\to\repo --task 001
node agentline.mjs check --repo C:\path\to\repo --task 001   # 证据链校验
node agentline.mjs merge --repo C:\path\to\repo --task 001 --permission "允许合并"
```

### 模型目录是自动发现的

| provider | 发现方式 | 说明 |
|---|---|---|
| Codex | `codex debug models` | 直接读取 CLI 自带的模型目录（slug / 显示名 / reasoning levels） |
| CodeBuddy | `codebuddy --help` | 解析 `--model` 的帮助文本 |
| Claude | `ANTHROPIC_API_KEY` 或扫描本机 CLI | 有 API key 时调 `/v1/models`；否则从已安装 CLI 中提取模型 id |
| Gemini | `GEMINI_API_KEY` 或扫描本机 CLI | 有 key 时调 `models.list`；否则扫描已安装的 CLI bundle |

- 发现结果写入 `orchestrator/config/agentline.models.json`（本机缓存，已被 `.gitignore` 忽略）；
- **仓库里没有默认模型**；角色候选为空时 `preflight` 会拒绝运行；
- 平台没给出某个模型时，可以手动补：`node agentline.mjs models add <provider> <model-id>`；
- 发现结果只代表「本机 CLI 知道这个模型」，是否在你的套餐可用，以第一次实际调用为准。

### 配置分三层

| 层 | 文件 | 提交? | 内容 |
|---|---|---|---|
| base | `orchestrator/config/agentline.config.json` | 是 | providers、policy、空 models / 空 roles |
| local | `orchestrator/config/agentline.local.json` | 否 | 本机命令路径、`env`、模型补充、角色选择 |
| discovered | `orchestrator/config/agentline.models.json` | 否 | 最近一次 `models discover` 的结果 |

项目级路由写在目标仓库的 `.collab/agentline.json` 的 `routing` 段；优先级：项目 > 全局 local > base。

**密钥不写入配置**：只写环境变量名或依赖 CLI 自己的登录态；`preflight` 只显示 `set/unset` 与登录状态，不打印值。

### 安全默认

- Codex：`-s workspace-write`、`approval_policy=never`；
- CodeBuddy：`--permission-mode acceptEdits`；
- Claude：`--permission-mode acceptEdits` + 最小工具集；
- Gemini：`--approval-mode auto_edit`。

需要更宽的权限（如 `danger-full-access` / `bypassPermissions`）时，在 local 配置的 `providers.<name>.options` 里显式放开，风险自负。CI 会执行 `acceptance.md` 里的命令，只应在可信仓库中使用。

### 本机覆盖示例

```jsonc
// orchestrator/config/agentline.local.json
{
  "providers": {
    "claude": { "command": "C:/tools/claude/claude.exe" },
    "codebuddy": { "env": { "CODEBUDDY_CONFIG_DIR": "C:/Users/me/.agentline/cbc-home" } }
  },
  "roles": {
    "design": { "candidates": ["claude-opus-5-5"] },
    "dev":    { "candidates": ["gpt-6.1-sol"] },
    "review": { "candidates": ["claude-opus-4-5"] }
  }
}
```

## 仓库内容

- [`AgentLine/SKILL.md`](AgentLine/SKILL.md)：协议正文（v0.3.0：状态/产物、write_scope、模型隔离、运行中输入）；
- [`AgentLine/templates/`](AgentLine/templates/)：六个交接文件模板（design 含 write_scope 示例）；
- [`AgentLine/tools/check-skill.ps1`](AgentLine/tools/check-skill.ps1)：skill 只读自检（C1–C9）；
- [`AgentLine/tools/check-task.ps1`](AgentLine/tools/check-task.ps1)：任务证据链只读校验；
- [`orchestrator/`](orchestrator/)：调度器内核（`agentline.mjs` + `lib/` + `config/` + `test/`）；
- [`docs/01-positioning-and-roadmap.md`](docs/01-positioning-and-roadmap.md)：定位与路线（与 DSH Super-agent 的关系）；
- [`docs/02-plugin-upgrade.md`](docs/02-plugin-upgrade.md)：本机 DSH 插件接入新内核的后续任务与验收清单。

## 测试

```powershell
cd orchestrator
npm test
```

测试覆盖配置分层、模型发现解析、候选切换交班、`no_new_work`、worktree/队列、check-task、stall 心跳与运行中输入；不调用真实模型。

## 设计原则

1. **规格先行**：字段、版本、章节名只能来自 design，实现不能自己发明；
2. **能机械检查的不写成文字**：验收是命令，不是形容词；
3. **证据优先**：没有落盘的执行不算数；
4. **人类保留最后一道闸门**：合并必须由人许可；
5. **规则只因真实失败而增加**，并定期删减。

## License

[MIT](LICENSE)

## In English

dsh-Agentline is a multi-model collaboration workflow for coding agents:
design → develop → CI → review, with fixed hand-off files, executable acceptance
checks, model isolation between developer and verifier, checkpointed hand-overs when
a model fails, and a human merge gate.

This repository contains the protocol/skill (`AgentLine/`) and a runnable scheduler
core (`orchestrator/`, Node.js 20+, zero dependencies) with automatic model discovery
and no built-in model defaults.

