# AgentLine Blueprint 20261106 — Review v5

## Verdict

**REVISE**

**B4、D3 已关闭；B1 部分关闭，M4 仍有缺口。** v5 的主要修补方向成立，但输入账本、晚到归档和无守护进程的终止证明仍存在影响正确性的契约冲突，不能全部归为实现细节。

本次合并审阅七份指定文档，并静态核对相关输入、执行源码。未修改设计、未写产品代码；文档中的验收例子未视为已经通过的测试。

## Blocking

### B1-1：输入账本尚未覆盖所有受支持的写入时序

**系统 note 的正常路径会撞上 I-IN。**

`input.intent` 只保存 `{kind,text,meta.key}`，没有实际输入的 `id`、完整 entry 或内容摘要；随后 runStep 在 P2 调用现有 `appendInput`，才生成随机 id。对账发生在 W5、`next()` 之前，而 beforeCall 要求文件中不得存在账本以外的 id。因此，keep 提示和 `WRITE_SCOPE_NOTE` 在既定时序中没有完成身份绑定的机会，就会触发 `G_INPUT_UNRECONCILED`。这不是仅补一个 schema 字段就能消除的措辞问题。[v5 输入事件与对账时机](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v5-contract.md:79)、[输入 ID 的实际生成](/C:/git/dsh-Agentline/orchestrator/lib/inputs.mjs:20)

**旧版输入命令仍可能成功返回后丢失原文。**

v5 允许旧 CLI 写入后由下次对账 adopt。但若旧 CLI 在 `markConsumed` 的整读与 rename 之间追加 Y，rename 会删除 Y；旧 CLI 不写 `input.append`，下次对账时文件和账本都没有 Y。§1.4 所称“通过 input.append 自愈”只适用于新版命令，不能覆盖这里。[v5 写入兼容规则](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v5-contract.md:91)、[覆盖窗口](/C:/git/dsh-Agentline/orchestrator/lib/inputs.mjs:53)

**关闭条件：**明确系统 note 在 beforeCall 前完成持久化身份绑定的位置及 W0 恢复结果；明确受支持的旧输入写入如何避免在 adopt 前丢失。补充正常 keep、design_scope，以及旧 CLI 并发追加的验收。

### B1-2：`call.archive_late` 与原归档的不可变校验冲突

W1b 要求晚到写入再次调用 `archiveCall`，但该函数仍固定写入 `calls/<call_id>/`，checkpoint 也沿用该 call 的 ref。目录冲突分支只处理“目录存在、没有 call.archive”的情况，W1b 恰恰已经有该事件。

因此，按现有契约执行，要么无法完成第二次归档，要么改变第一次归档的目录或 ref，使原 `call.archive` 校验失败。尤其在 `call.archive_late` 已写、`call.end` 未写时再次崩溃，恢复仍从原归档校验开始，不能保证 A1-8i 和归档前置条件同时成立。[归档写入规则及 W1b](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v5-contract.md:173)、[后续动作的硬前置](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v5-contract.md:192)

**关闭条件：**明确原归档与晚到归档各自不可变的存储、引用和重入规则；补充“late 已持久化、end 尚未持久化时再次崩溃”的唯一恢复结果。

### B1-3：第二层孤儿扫描尚不能作为跨平台终止证明

受守护的 Windows Job 路径已经解决 review-v4 的漏后代反例；问题在无守护时的 POSIX 回退。

§3.3 允许遇到早于 target 创建的祖先就排除 Q。但孤儿可以被重新挂到一个更早创建的 subreaper，原 target 已不在当前父链中。Linux 文档明确规定这种重新挂接行为。[Linux subreaper 语义](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html)

文档虽然另列“父进程为某个 reaper → 候选”，却没有给出如何从规定的 `(pid,ppid,create_time)` 快照识别这种情况。这些字段不能证明父链没有发生重新挂接；`PR_GET_CHILD_SUBREAPER` 也只查询调用进程自身。[v5 排除规则与可靠性论证](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v5-contract.md:248)、[查询接口语义](https://man7.org/linux/man-pages/man2/PR_GET_CHILD_SUBREAPER.2const.html)

**关闭条件：**在无法排除重新挂接的情况下明确返回 `unknown`，不得仅凭较早祖先排除候选；补充“守护退出，后代被外部旧 subreaper 接管”的反例。无需更换架构。

## Major

### M4：入口进程存活期间已覆盖，退出后的遗留后代仍可能漏计

来源 (f) 解决了首次调用前、候选切换间隙和 `clearLive` 后的计数问题。但仍存在：

1. 升级前的 `cmdRun` 没有 admission、任务锁或 job 登记。
2. 它启动模型子进程后被杀，子进程继续运行。
3. 来源 (f) 已找不到旧入口；模型进程不匹配 `ENTRYPOINTS`。
4. (d) 已被排除出汇总，其他来源也没有该运行的记录。

此时两次 drain 扫描都可能得到 0。§3 的终止证明没有自动接入这类无登记旧执行者的清除过程；“检查两次”不能弥补缺少计数对象。[v5 drain 汇总](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v5-contract.md:365)、[旧 cmdRun](/C:/git/dsh-Agentline/orchestrator/agentline.mjs:304)

**关闭条件：**旧入口消失后，相关运行必须保持非零或 `unknown`，直到其后代终止得到证明。A6-15 应增加“入口退出、后代仍存活”的分支。

## Minor

以下属于**实现前契约整理**，不单独阻塞：

- `C_auth` 的正式公式应包含初始 adopt 的 consumed 集合，与 §1.3 第 3 条一致。
- v5 的 A3-1 至 A3-4 与 v2 的反绕过 gate 用例重号；应区分编号并保留两组验收。
- 按替换清单生成单一合并稿，更新 `recording` 阶段、命令 ID、错误码及失效术语。D1 统一为 decisions.md 的 **A＝授权 K1**。

## Review-v4 逐项核对

| 项目 | 结论 | 核对结果 |
|---|---|---|
| B1：输入恢复 | **部分关闭** | 不再读取 Git 原文，符合 Q6；系统 note 绑定及旧输入并发写入仍未闭合。 |
| B1：archive/end 窗口 | **部分关闭** | 普通 W1b/W1c 已明确，usage 有恢复依据；晚到归档及其再次崩溃仍有冲突。 |
| B1：终止证明 | **部分关闭** | 受守护路径及原 Windows 反例已覆盖；无守护 POSIX 回退不能据现有规则可靠放行。 |
| B4：K 恢复 | **已关闭** | `recording`、预计算 blob 和 R-TXN 覆盖未写、部分写入、已暂存及提交后 phase 未更新。 |
| B4：T 缓存 | **已关闭** | T-PURE 与动态 `T.local_evidence` 分离；缓存命中不能跳过本机哈希校验。 |
| M4 | **部分关闭** | 原候选切换间隙已覆盖；旧入口退出后的后代仍可能漏计。 |
| D3 | **已关闭** | Build 的 `L_e`、Blueprint 的 `L_bp`、调度规则及 G1/T 检查已贯通；合法追加轮次可通过 gate。 |
| 原 Minor | **基本关闭** | 命令别名及创建／登记／放行顺序已明确，剩余为合并稿整理。 |
| B5、M3/M5、B2/G2、M2 | **保持关闭** | 本轮未发现对锁内权威检查、路径保护、固定快照及 LockedConfig 来源的破坏。 |
| D1、D2、D4 | **保持已裁决** | 无需重裁；D1 的恢复验收仍受上述 B1 影响。 |

## 新引入的问题

新增问题集中在四处衔接：

- `input.intent` 与实际输入 ID、beforeCall 不变量之间。
- 晚到归档与原归档不可变校验之间。
- 无守护进程的当前父链与历史后代关系之间。
- 旧入口进程消失与 drain 清零之间。

**未发现新的架构性依赖环。** K 恢复、T 缓存和 D3 已可作为实现契约；K1 的输入与恢复链、旧 CLI drain 尚不能整体视为闭合。

## 是否可进入实现切分

**no。**

前置条件：

1. 关闭上述 B1 三组问题及 M4 遗留后代计数问题，补齐对应反例的确定结果。
2. 拼装合并稿，完成标为“实现前契约整理”的项目。

已有架构、UX、K 恢复、T 缓存及 D3 方案可以保留，不需要重写设计。

## 仍需用户裁决的问题

**没有新的产品裁决，D1–D4 不需要重裁。**

上述缺口应在现有授权内局部修补。只有选择取消旧 CLI 并发输入兼容、缩小无守护平台恢复范围等承诺时，才需要用户明确裁决；不能把范围缩减作为默认实现细节。