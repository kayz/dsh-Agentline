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

---

## 附：任务级验收必须包含"全量回归"门禁（2026-11-08 实测）

**问题**：任务只验收自己那几条 AC，无法发现"弄坏了别人的测试"。

**实例**：

| 任务 | 自身 CI | 合并到 main 后 |
|---|---|---|
| T-016（discover 命令） | 4/4 全绿 | `AC-006` 失败 —— discover 的错误写到了 stdout 而非 `ctx.stderr` |
| T-003（追踪分片） | 通过 | 破坏了 `traceability.test.mjs` 的断言 |
| T-014（配置 v2） | 通过 | 破坏了 `config-v2.test.mjs` |

**修法**：每个任务的 `acceptance.md` 固定追加一条：

```pwsh
## AC-XXX 既有单元测试不得被破坏
node --test "test/unit/*.test.mjs"
if ($LASTEXITCODE -ne 0) { throw "existing unit tests broken" }
Write-Output "AC-XXX OK"
```

**效果（已实测）**：T-016 加上这条后，**它自己的 CI 就红了**（4/5），不需要等到合并时由人工发现并回滚。

**成本对比**：

| 方式 | 代价 |
|---|---|
| 合并时发现 | 一次合并尝试 + 手工回滚 + 判定责任归属 |
| 任务内门禁 | 零额外操作，dev 可从自身 CI 输出直接看到原因并修正 |

**结论**：跨任务的破坏必须由"任务自己的 CI"承担，而不是由"合并流程"事后兜底。这条应作为 `brief` 模板的固定段落，而不是靠人记得加。
---

## 附：共享文件是任务并行度的硬上限（2026-11-08 实测）

单个会话内，`lib/cli.mjs`（静态路由表）被 5 个任务依次修改，产生 **8 次冲突或扩权申请**、**2 次 worktree 重建**：

| 任务 | 需求 |
|---|---|
| T-005 | 注册 `paths`、`init` |
| T-013 | 注册 `auth set/status/clear` |
| T-014 | 注册 `config migrate` |
| T-016 | 注册 `discover` |
| T-017 | 注册 `models enumerate/add` |
| T-019 | 注册 `models allow/deny/level/alias` |

每次都要：申请扩权 → 改 main 与 worktree 的 `task-graph.json` → 修改共享文件 → 合并时解冲突。**任务并行度被这一个文件锁死。**

**修法**：静态路由表改为注册表模式（命令模块自注册，`cli.mjs` 只做收集与分发）。判定标准：若某文件在任务图里被 **≥2 个任务的 write_scope 命中**，它就必须先被重构为可扩展结构，或由单一属主任务先行交付骨架。

**衍生规律**：任务时长与分支分叉强相关。8 小时内 4 次因分叉而重建 worktree 的，全部是耗时 > 2 小时的任务；耗时 < 30 分钟的任务无一次分叉。**长任务应主动缩短交付周期，而不是靠"再跑一轮"**。
---

## 附：清理任务目录时必须保留 brief.md（2026-11-08 实测）

清理失败任务时执行了 `Remove-Item .collab/tasks/016 -Recurse -Force`，连带删除了 `brief.md` —— 导致该任务此后每次启动都报：

```
E_BRIEF_MISSING_IN_WORKTREE: .collab/tasks/016/brief.md 不可读
任务输入必须先提交到 main，worktree 才能看到它
```

**任务目录同时存放两类东西**：

| 类型 | 文件 | 清理策略 |
|---|---|---|
| 运行时状态 | `state.json`、`run.json`、`notice.json`、`live.json`、`ci-results.json`、`logs/`、`sessions/` | 可删 |
| 必须进 git 的输入 | `brief.md`、`design.md`、`acceptance.md`、`handoff/` | **不可删** |

**正确做法**：按文件名白名单清理，或 `git clean -fd` 只清未跟踪文件。禁止对 `.collab/tasks/<id>` 直接 `-Recurse -Force`。

排查方式：`git show "$(git log --format=%h -1 -- .collab/tasks/<id>/brief.md):.collab/tasks/<id>/brief.md"` 可从历史恢复。
---

## 附：注册表化受阻于"文件系统 seam 约束"（2026-11-08 实测）

按本文前述结论对 `lib/cli.mjs` 做注册表化时，第一次实现被既有门禁拦下：

```
FAIL seams.fs lib/routes.mjs:9
check-seams: FAILED (1 violations)
```

`check-seams` 规定只有 `lib/context.mjs`、`lib/store.mjs`（原计划含 `lib/fsx.mjs`，该项目未建）可以 `import node:fs`。而"扫描命令目录自动注册路由"必须读目录。

**可行方案（按约束排序）**

| 方案 | 是否越 seam | 新增命令的改动面 | 冲突面 |
|---|---|---|---|
| A. 目录扫描（本次尝试） | ❌ 越界 | 0 行 | 无 |
| B. 扫描能力放进 `lib/context.mjs` | ✅ | 0 行 | 无 |
| C. 静态 manifest 文件（每个命令追加 1 行） | ✅ | 1 行 | 1 个共享文件 |
| D. 维持现状（改 `lib/cli.mjs` 静态表） | ✅ | 2 行 | 最热共享文件 |

**结论**：正确的下一步是 **B** —— 把"列出命令模块文件"的能力加到被允许的 seam 模块（`lib/context.mjs`），再由 `lib/routes.mjs` 负责动态导入与匹配。这样既不越 seam，又能把新增命令的改动面降到 0。

本文前述"共享文件是并行度硬上限"的结论不变，但补一条：**重构本身也会撞上既有的架构约束；先确认该约束允许的落点，再动手**。