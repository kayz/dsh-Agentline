# AgentLine 的边界

日期：2026-11-03

AgentLine 只管**一个任务**：在任意 git 仓库里，让不同模型分别做设计、实现和验收，留下可复核的证据，
最后由人决定是否合并。

## 负责

- 三个角色（designer / developer / verifier）和固定文件交接：`brief.md`、`design.md`、`acceptance.md`、
  `impl.md`、`review.md`。
- 可执行验收：`acceptance.md` 的每条命令由 CI runner 逐条执行，原始输出进 `ci-results.json`。
- 跨模型隔离：以 `run.json` 里实际解析出的模型为准，评审模型与开发模型相同则拒绝评审。
- 失败处理：平级换模、换模前交班、`no_new_work` 判定、认证失败直接 `blocked(auth)`。
- 并发：每个任务一个 worktree，`write_scope` 相交的任务排队。
- 运行中输入：`note`、`amendment`、`attention`。
- 证据链校验（`check-task.ps1`）和人工合并闸门。
- 对外状态：任务状态文件 `state.json`。五态汇报（progress / waiting / ready / blocked / failed）
  是路线阶段三的计划，尚未实现。

## 不负责

| 事项                                 | 说明                                                         |
| ------------------------------------ | ------------------------------------------------------------ |
| 事件入口、群聊或 Issue 监听、主动接单 | 由调用方或控制面决定什么时候派活，AgentLine 只接收任务       |
| 跨任务的路由和优先级                 | 同上；AgentLine 只做执行槽和 `write_scope` 冲突排队          |
| 项目结构和项目规则                   | 由仓库自己维护，AgentLine 只读取任务需要的文件               |
| 跨项目共享的领域知识                 | 需要时由调用方写进 `brief.md`，AgentLine 不去别处取          |
| 自动合并、发布和部署                 | 最多推进到 `pr_open`，合并必须有人的许可                     |

## 对外接口

- **输入**：目标仓库路径、任务编号和 `brief.md`；运行中通过 `input` / `answer` 命令追加输入。
- **输出**：`.collab/tasks/<NNN>/` 下的固定文件、`state.json`、`run.json`、`ci-results.json`、`verdict.json`。
- **驱动方式**：`agentline.mjs` CLI 是主入口。DSH 插件（`dsh-agentline-plugin`）只是一个可选外壳，
  调用的是同一个 CLI。

这些文件格式和命令由 AgentLine 自己定义并维护版本；调用方只依赖它们，不依赖内部实现。

## 独立性检验

1. 调度器内核只需要 Node.js 20+、PowerShell 7、git 和至少两个已登录的编码 CLI，不需要 DSH，
   也不需要任何控制面。
2. 目标仓库不需要使用特定的项目模板；只要是 git 仓库、验收能写成命令，就能跑通一个任务。
3. 内核代码里不出现具体控制面或项目模板的名字。

## 与其他工具配合

- **控制面**：将来如果接入 DSH Super-agent 这类控制面，适配层做成独立的可选包，把对方的任务分派
  转换成 `brief.md` 和一次 `flow` 调用，把任务状态回传给对方。内核不为某个控制面改动。
  Super-agent 目前只有研究原型，接口只作参照，不作依赖。
- **Studio / Blueprint（可选上游）**：多模型讨论、系统设计和测试架构属于控制面，不属于内核。
  AgentLine 只接收 Blueprint 产出的任务图和 `brief.md`，仍然按单任务执行。三阶段协议见
  [`docs/03-three-stage-pipeline.md`](docs/03-three-stage-pipeline.md)；在 `blueprint` 命令实现前，
  这些阶段由调用方手动完成，不声称内核已支持。
- **项目检查**：目标仓库已有检查脚本时，由 designer 把它写成一条验收命令。以后如果要做成配置项，
  也只做一个通用的“项目检查命令”，不识别具体模板。

## 现有偏离

- `docs/01-positioning-and-roadmap.md` 的“挂载态 / v1.0 挂载”应理解为上面所说的可选适配层；
  它链接的 `02-v0.2-requirements.md` 和 `03-v0.2-technical-design.md` 在仓库里不存在。
