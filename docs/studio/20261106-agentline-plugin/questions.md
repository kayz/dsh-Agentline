# Studio 20261106 — 待用户决策

状态：Round 1 完成，专家已确认；以下 6 项需要用户拍板。

## Q1 控制面边界

Studio/Blueprint 控制面落在哪里？

- **A（推荐）**：同仓分层，`orchestrator/studio.mjs` / `blueprint.mjs`，`agentline studio|blueprint` 暴露；`flow` 零侵入；插件只调用公开 CLI。
- B：独立 `pipeline-cli` 控制面包，插件分别调用控制面 CLI 与 Build CLI。
- C：修改 `SCOPE.md`，正式扩展为三阶段全周期调度器。

## Q2 版本顺序与首个最小切片

- **A（推荐）**：0.18 Build 结构化错误/动作表/rate_limit 自动续跑/Inbox/pipeline summary；0.19 tiers/probe/Blueprint gate 校验器/手工产物导入；0.20 Blueprint 编排；Studio 后置。
- B：0.18 能力查询/只读 summary/版本化 DTO/模型身份；0.19 Studio 最小闭环；0.20 Blueprint；0.21 Build 集成。
- C：保持输入原路线，0.18 三阶段只读外壳，未实现阶段显示 unsupported/not_started。

## Q3 顶级模型供应

- **A（推荐）**：top 仅纳入 `claude-opus-5-5` 与 `gpt-6.1-sol`；测试架构师复用其中之一，跨厂商仅警告。
- B：先验证 gemini/codebuddy 顶级模型通过身份与 callable probe，再启动 Blueprint 编排；此前只做 Build 加固和 gate 校验。
- C：放宽协议，允许同厂商不同模型担任评审，每次记录 deviation。

## Q4 实际模型身份证据

- **strict（推荐）**：无法可信证明实际模型时，不允许参与要求隔离的阶段，`blocked(model_unverified)`；不得用请求模型冒充 resolved。
- explicit_exception：允许人工登记的固定版本例外，但持续显示 unverified，且不得宣称隔离已验证。

## Q5 轮次上限

- **hard_limit（推荐）**：原会话最多三轮，超限 `blocked(E_ROUND_LIMIT)`；用户裁决后建立有来源关联的新会话。
- bounded_extension：允许一次追加一轮，最多四轮。
- repeatable_single_round：进入 awaiting_user，每次显式授权加一轮，逐次记录 deviations。

## Q6 讨论记录的 Git 留存

- **A（推荐）**：定稿契约/状态/run/verdict 进 git；`logs/`、`rounds/`、`handoff/` 外置或 gitignore，本地保留哈希索引。
- B：全部进 git，仅限纯内部私有仓库。
- C：整个 `.collab/` 不进产品仓库，外置控制面数据目录。

## 回答格式

```text
Q1=A
Q2=A
Q3=A
Q4=strict
Q5=hard_limit
Q6=A
```
