# Studio 20261106 — AgentLine 插件三阶段改造评审

状态：Round 1 完成；专家已确认；待用户回答 Q1–Q6
日期：2026-11-06

## 输入

- `input.md`：评审对象、提议的插件变化、四个特例化问题。
- `docs/03-three-stage-pipeline.md`：Studio / Blueprint / Build 协议。
- `plugin/README.md`、`plugin/lib/index.js`、`plugin/lib/client.js`：当前插件基线。
- `orchestrator/config/agentline.config.json`、`agentline.local.json`：当前角色和 provider 配置。
- `SCOPE.md`：单任务 Build 内核边界。

## 专家

- A：Claude Opus 5.5（产品/流水线/交互）
- B：GPT-6 Astra（技术/CLI/模型/错误状态机）
- C：Gemini 4 Argon High（风险/运维/安全）
- Moderator：Kimi K3.1 Pro
- 书记：当前 agent

## 产物

- `expert-A.md` / `expert-B.md` / `expert-C.md`：专家原始意见。
- `moderator.json`：问题分级、冲突图、议程、审计标记。
- `minutes-v1.md` / `minutes-v2.md` / `minutes-final.md`：纪要及修订。
- `confirm-A.json` / `confirm-B.json` / `confirm-C.json`：第一轮确认。
- `confirm2-B.json`：B 的最终复核。
- `questions.md`：待用户拍板的 Q1–Q6。

## 确认状态

| 专家 | 状态 |
|---|---|
| A | accept_with_notes |
| B | accept |
| C | accept_with_notes（原始输出截断，仅使用可见部分） |

## 主要共识

1. Studio/Blueprint 不塞进现有 `flow.mjs` 或插件 Host；独立控制面模块，`flow` 保持零侵入。
2. 插件只做投影、输入收集、公开 CLI 调用；不写业务状态、不做自动恢复策略。
3. 先补 provider 能力、模型身份、结构化错误、gate 公共契约，再做三阶段 UI。
4. gate 用机器可校验的 JSON；批准绑定内容哈希；轮次耗尽硬停/待用户。
5. 禁止静默降级；无法证明实际模型身份时 `blocked(model_unverified)`。

## 注意

专家 C 的原始输出在传输中截断 28,267 字节；纪要只使用其可见部分，未推断缺失内容。
