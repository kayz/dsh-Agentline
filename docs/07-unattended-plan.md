# 无人值守推进计划（2026-11-09 00:25 起，约 7 小时）

## 目标

1. 完成 M3 最后一个任务 T-033（HTTP 直连 provider：DeepSeek 官网）
2. 完成 M4（用量选模）
3. 依据 `docs/ui/cliworker-console.html` 完成客户端开发，直到 M5 全部任务合并

## 模型配置（本次设定）

| 角色 | 链 | 说明 |
|---|---|---|
| dev | `deepseek-v4.1-flash` > `gpt-6.1-terra` > `gpt-6.1-sol` | 按用户要求主力切回 deepseek flash |
| design | `gpt-6.1-sol` > `claude-sonnet-5-5` > `gemini-3.8-flash-high` | 困难任务手动切 `claude-sonnet-5-5`，注意用量 |
| review | `claude-sonnet-5-5` > `gpt-6.1-sol` > `gpt-6.1-terra` | 评审用 sonnet，避免自我评审 |

## 硬性约束

- 主干 `node --test "test/unit/*.test.mjs"` 必须保持全绿（基线 386 pass），**任何提交前先跑**
- 每个任务独立 worktree；合并后立即清理 worktree 与分支
- **禁止**直接删 `.collab/tasks/<id>/` 整目录（会连 `brief.md` 一起删掉，导致任务无法启动）
- 发现的问题同步写入本目录（缺陷报告 + 教训闭环），不要只留在对话里

## 已知高频失败模式与对策

| 模式 | 对策 |
|---|---|
| acceptance 格式不合规 | 已有 `scripts/check-acceptance.mjs` 门禁 + brief 模板内置要求；仍失败就直接重写 |
| `run.no_match AC-xxx` | 说明缺带标签的测试 → 派子代理补，给出同类已合并任务作模板 |
| 分支与 main 分叉 | 优先让子代理 `git merge main`，不要写兼容 shim；冲突复杂时重建 worktree |
| 合并后主干变红 | 立即定位是契约不同步还是真实回归，修好再继续 |

## 时间线（供 7 小时后验收参考）

| 时段 | 预期 |
|---|---|
| 00:25–02:00 | T-033 完成并合并，M3 收口 |
| 02:00–04:30 | M4 任务推进（用量选模） |
| 04:30–07:00 | M5 客户端开发 |
| 07:00+ | 汇总报告：合并任务数、主干状态、遗留缺口 |