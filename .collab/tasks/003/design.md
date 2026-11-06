---
write_scope:
  - orchestrator/agentline.mjs
  - orchestrator/lib/**
  - orchestrator/test/**
  - plugin/lib/**
  - plugin/test/**
---

# P6：Studio 控制面 + 渠道/11 角色 UI

## 目标

实现 brief 所列 P6。控制面属于 orchestrator，插件只读状态、收集输入并调用公开 CLI；不在插件中写 `.collab` 或另做状态机。`flow.mjs` 不修改，既有任务执行、路由和项目组合继续可用。Blueprint 和 Build 新控制面不在本次实现范围，页面只能显示真实已有数据或明确的未实现状态。

## Studio 控制面

- 以项目根 `.collab/studio/<id>/session.json` 为会话状态的唯一来源，关联持久化 `questions.json`、`decisions.json`、`confirmations/`、`minutes-final.md`。读取、恢复及 G0 必须基于落盘结果；缺失或损坏的必需内容不能当作成功。会话 ID 必须校验为单个安全路径段，拒绝遍历和越界。新建不得覆盖已有会话。
- 在 `orchestrator/agentline.mjs` 增加 `studio new|run|answer|conclude|status` 分发及帮助；沿用 `--repo` 和现有参数解析，提供明确的用法、成功结果及非零失败退出码。`status` 只读并能区分不存在、空、损坏及正常会话。CLI 和插件均经同一核心实现，避免各自计算状态。
- `new` 创建可恢复的会话，保存用户输入及明确配置的五个角色；配置缺失、不可调用或模型调用失败应显式报告，不能用示例结果替代真实调用。使用现有模型目录、配置和 adapter 能力，记录实际角色及模型；Studio 专家与主持要求 top，书记允许 advanced，且书记与主持模型不同。复用既有只读能力；无法保证只读的渠道不得静默执行。保持 Build 的 `design/dev/review` 语义及当前 dev `deepseek-v4-pro` 配置，不用 UI 角色重命名改写旧路由。
- 每次 `run` 只执行一个下一步并落盘后返回：专家 A、B、C 分别独立执行，随后主持，书记，再由 A、B、C 分别确认。下一次调用才可开始下一步；失败不跳步、不伪造输出。主持产生 open blocking 问题时状态为 `awaiting_user`，禁止 `run` 绕过；`answer` 必须显式提交回答或明确采用默认，并记录用户动作及其内容，才可继续。多个阻塞问题均需处理；未回答、缺失或无效的回答不能视作确认。决策逐条需要用户确认或明确采用默认；专家确认只能来自对应专家的独立调用，拒绝或缺失不能算通过。
- 每个决策业务轮次不超过 2；回答或修改导致重新讨论时持久化相关轮次，不因错误或重试虚增。轮次耗尽且仍有阻塞时停下并明确呈现，不自动选默认或进入第三轮。
- `conclude` 根据持久化证据重新计算 G0，并输出逐项结果：`minutes-final.md` 存在且非空；至少一个决策且每个决策有用户明确确认或采用默认的记录；三位专家各有独立有效确认且无阻塞性拒绝；无 open blocking；每个决策轮次 ≤2；书记与主持模型均已知且不同。任一条件不满足时 G0 不通过并给出原因，不能标为通过；内容改变后重新计算，不能沿用过期通过结果。`conclude` 不代用户确认或替专家确认。

## UI

- 延续现有五 Tab、Inbox、项目组合、旧任务操作和接口；Studio 页按当前项目读取真实会话列表与选中会话详情，展示角色、问题、决策、确认及 G0。无会话显示空状态；读取失败、无效数据或操作失败显示错误及可重试操作，不能混同为空状态，也不能使用 mockup 的示例作为真实数据。切换项目后重新读取，避免显示上个项目的数据。
- 提供 new/run/answer/conclude 操作，每次用户动作映射一次 CLI 调用；回答和采用默认须明确区分，提交成功后刷新真实状态，失败显示原因且不自动重发。等待用户时禁止绕过回答，禁用动作说明原因。插件验证项目与会话输入，使用参数数组调用，不经 shell 拼接；读取接口只读，写操作只转发 CLI。
- 模型目录按 Claude、Codex、CodeBuddy、Cursor、Gemini 渠道分组，每组可折叠；筛选和搜索对实际目录数据生效，空组可见且不制造模型。列为模型、渠道、id、档位、身份、可用性、来源，未知值明确显示未知。discovered 不等于 callable，未验证不显示为 verified。
- 角色矩阵展示三阶段 11 个角色：Studio 的 expert_a、expert_b、expert_c、moderator、scribe；Blueprint 的 designer、reviewer、test_architect；Build 的 designer、developer、verifier。每行显示主选、备选、档位要求、约束及 probe；缺少配置或证据时显示未设置/未知，不能捏造通过。Build 显示映射现有 design、dev、review 数据，保留原有编辑与运行语义；未实现阶段的配置与操作明确只读。
- 参考 `docs/blueprint/20261106-agentline-plugin/mockups/index.html` 和 `design-v1.md` §5 的布局、空态与错误反馈；brief 的每次单步规则优先于 §5.3 中连续执行描述。不引入前端构建步骤。

## 验收格式

下游实现需提供独立的 Node 测试文件，使用隔离的系统临时目录和可注入的确定性 adapter，不能依赖真实账号、网络或修改项目真实会话。测试必须断言实际行为和落盘内容，而非只检查源码字符串；CLI 测试应启动真实 CLI，UI 测试应驱动实际插件路由及渲染/交互。各测试失败时退出非零，包含以下覆盖：

- `orchestrator/test/studio-cli.test.mjs`：new/status、重复 ID 与非法路径；多次 run 每次仅一次角色调用、重启恢复、错误不推进；阻塞问题不能跳过，回答和显式采用默认分别记录，多个问题均处理后才继续；决策确认以及三次各自独立专家确认；conclude 成功与缺失证据失败。
- `orchestrator/test/studio-g0.test.mjs`：有效证据通过；逐一移除或破坏纪要、用户决策记录、任一专家确认，注入专家拒绝、open blocking、超两轮、主持与书记同模型或缺失模型，均失败；证据修改后重新求值，未答问题不能成为 confirmed。
- `plugin/test/studio-ui.test.mjs`：五渠道及七列、折叠与筛选、11 行角色及五类属性和未知值；真实会话、空会话、读取/操作错误、项目切换；四项操作真实转发且每次一次调用；五 Tab、Inbox、项目组合、旧任务操作和未实现阶段状态保持正确。
- 完整 orchestrator 测试回归，包含现有 flow 测试；不依赖手工模型调用。
