# 教训闭环（Lesson Loop）：把每次故障变成一道守卫

> 来源：2026-11-07/08 在 `dsh-CLIWorker` 连续推进 13 个任务的过程中，同一类问题反复出现（验收格式 4 次、写域不足 3 次、worktree 陈旧 3 次、`/mnt` 污染 2 次）。
> 本文定义：**发现问题的能力必须变成流程的一部分**，而不是依赖操作者的记忆。

## 1. 核心原则

每一次故障，必须同时产出三样东西，缺一不可：

| 产出 | 形式 | 作用 |
|---|---|---|
| **分类** | 一个固定枚举值 | 让"又是这类问题"可统计 |
| **守卫** | 一条可执行检查 | 让同类问题在**下一轮**被自动发现 |
| **回归** | 一个最小用例 | 证明守卫真的会红 |

只有"修好了当前任务"不算完成 —— 那只是把症状按下去。

## 2. 故障分类（固定枚举）

```text
FORMAT      验收脚本不可解析 / 断言写错
DEPENDENCY  前置产物缺失、worktree 陈旧、依赖未提交
ENVIRONMENT git 配置污染、路径跨平台、凭据缺失
CONTRACT    write_scope 不足、接口冲突、语义未定义
CAPABILITY  模型 stall、quota、身份不可证
OPERATOR    操作者自身失误（引号、全局替换、未执行动作）
```

`OPERATOR` 必须单列 —— 实测中操作者的失误占比不比模型少，把它计入统计才有改进压力。

## 3. 从分类到守卫（对应关系）

| 分类 | 守卫形式 | 挂载点 |
|---|---|---|
| FORMAT | `check-acceptance`：提取命令数为 0 即失败 | `check-fast` |
| DEPENDENCY | flow 启动前断言 brief/依赖产物可读；worktree 与 main 的差异检查 | `flow` 启动 |
| ENVIRONMENT | `git rev-parse --abbrev-ref HEAD` 可用性；`.git/config` 无 `/mnt`；`DEEPSEEK_API_KEY` 存在性 | `preflight` |
| CONTRACT | 扩权必须同时写入 main 与所有活跃 worktree | `scope` 子命令 |
| CAPABILITY | stall 记录 `waited_seconds` 与 `last_event`；quota 错误归类 | `exec` |
| OPERATOR | 多行文本必须经文件传递（禁止字符串拼接）；声明动作必须伴随工具调用 | 操作规范 + 复核 |

## 4. 实操：一条教训的完整生命周期

以"验收脚本格式"为例：

```text
1. 现象   002/004/005/007 连续 ci_failed，exit 2，无 ci-results.json
2. 分类   FORMAT
3. 守卫   新增 scripts/check-acceptance.mjs：解析 acceptance.md，
          若提取到的命令数为 0 → 退出码 1，并打印"第 N 行无法识别"
4. 挂载   加入 check-fast 的第一步
5. 回归   test/unit/check-acceptance.test.mjs：喂一个只有表格的 acceptance.md，断言失败
6. 效果   007 之后同类失败 0 次
```

没有第 3–5 步，第 1 步会在下个任务重演。

## 5. 度量

巡检应持续统计：

| 指标 | 目标 |
|---|---|
| 同类故障复发次数 | **0**（出现即说明守卫缺失或失效） |
| 从故障到守卫上线的时间 | ≤ 1 天 |
| 有守卫但未拦截的次数 | 0（否则守卫本身失效） |

**"同类问题第二次出现"是流程缺陷，不是运气不好。**

## 6. 建议的插件实现

```text
patrol lesson add --task 007 --class FORMAT --guard check-acceptance --test test/unit/check-acceptance.test.mjs
patrol lesson list --class FORMAT
patrol lesson verify            # 逐条跑守卫的回归用例，确认仍然会红
patrol report                   # 复发统计、守卫覆盖率
```

落地要求：

1. 每条缺陷（缺陷报告里的 D-n）**必须**关联至少一个守卫或明确标注"暂无法守卫"及原因
2. `merge` 前检查：本次任务是否引入了新的 guard（若其故障分类属于已有类别则强制要求）
3. 报告里"已修复"必须写成"已修复 + 守卫位置 + 回归用例"，否则视为未完成

## 7. 一个反面教材（本次真实发生）

操作者在同一天内：

| 失误 | 次数 |
|---|---|
| 字符串拼接命令导致引号截断 | 3 |
| 对语义文件做全局替换（越改越坏） | 4 |
| 回退到错误的提交基线 | 4 |
| 在回复里声称已执行、实际未执行 | 2 |

这些都不是模型的问题，但消耗了大量时间。**它们同样应该被守卫**：

- 多行文本 → 先写文件再传（已在巡检 prompt 中固化）
- 声明动作 → 必须紧邻一次工具调用（复核规则）
- 修改语义文件 → 只允许整段替换或整份重写

## 8. 一句话

**改进能力不是"更聪明地临场应对"，而是把每次临场应对沉淀成下一次的自动检查。** 沉淀不下来，同一个坑就会以不同的外表再踩一次 —— 本次 8 小时内踩了 4 次。
