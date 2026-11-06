# AgentLine Blueprint 20261106 — Review v6

## Verdict

**REVISE**

v6 已关闭系统 note 身份绑定和晚到归档的主要冲突，但**尚未形成完整、唯一的恢复契约**：S1 的兼容范围仍待用户裁决；POSIX 第二层的判空放行仍缺少进程枚举完整性的前置条件。

只需局部收口，不要求新架构。本次为静态契约复核，未修改文档或产品代码，未将验收表视为已通过的测试。

## Blocking

### B6-1：S1 未裁决，输入兼容与 drain 的最终保证范围仍不唯一

v6 明确承认：

- S1-A 缩减运行期间的 L-foreign 输入兼容，以及未观测、无残留证据的旧执行者保证。
- S1-B 需要追加授权修改 `inputs.mjs`，而且仍不能覆盖上述无证据执行者。

这些都是范围或授权选择，不能归为实现细节。当前 `decisions.md` 尚未包含 S1，因此不能把推荐选项视为已接受，也不能宣告 B1-1、M4 整体关闭。[v6 S1](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v6-contract.md:469)

此外，§8.1 所称“只有 W7a 的输入部分需要等待”不准确：**W16 的 drain 保证范围和验收同样受影响。**

**关闭条件：**记录最终输入兼容选择，以及无证据 L-foreign 执行者是否明确排除；同步更新 W7a、W16 和验收边界。选择 B 时，另记录内核修改及回滚格式转换的授权。

### B6-2：POSIX 的 `Cand = ∅ → proven_dead` 缺少枚举完整性条件

记录祖先链并构造 R，已经覆盖 review-v5 的“外部旧 subreaper 接管”反例。问题转移到了 §3.3P 第一步：文档将“全量快照”作为既得条件，却只规定读取失败时返回 `unknown`，没有规定如何确认**不存在未枚举的进程**。[v6 第二层判定](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v6-contract.md:287)

Linux 的 `hidepid=2/4` 可以直接隐藏进程目录；遍历成功不一定产生任何读取错误。内核的 `/proc` 枚举还会逐项遍历、跳过无权限对象，并非冻结进程集合的原子快照。[Linux procfs 文档](https://docs.kernel.org/filesystems/proc.html#mount-options)、[Linux 枚举实现](https://github.com/torvalds/linux/blob/master/fs/proc/base.c)

因此，**根据上述接口语义推导**，有效 `anc` 和匹配的 `pidns` 仍不足以保证候选集合完整；权限可见性变化，以及枚举期间的进程创建、退出，都不能仅凭“扫描没有报错”排除。空集合可能只是观测结果，不能直接授权续跑或清除 drain 记录。

**关闭条件：**明确第二层允许判空放行所需的可见性、完整性条件；无法建立这些条件时返回 `unknown`，保留现有重启证明路径。补充“有效 anc，但后代未被枚举”的反例。无需新增跟踪架构。

## Major

**无独立新增 Major。**

M4 的记录保留方案成立，但其完整关闭依赖 B6-1 的范围裁决和 B6-2 的终止证明；这里不重复计数。

## Minor

以下均为**实现前契约整理**，不单独阻塞：

- **补齐 L-cur 的锁接入说明。**§1.4 明确包含当前核心的 `run/flow`，但持锁表主要描述 runStep／CallGuard 路径。合并稿应明确旧入口的包裹点、返回／异常释放点，并覆盖 `runFlow` 自身的 note 写入；验收应包含当前核心 `run/flow` 与新版输入命令并发。[v6 输入锁](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v6-contract.md:97)
- **统一 reserved ID 的处理优先级。**通用 reconcile 的“文件有、账本无则 adopt”，必须明确受 `in-sys-` 缺失账本时的 `E_LEDGER_ORDER` 规则约束。[v6 adopt 规则](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v6-contract.md:129)
- **限定清零验收的夹具条件。**A6-15b–e 等“结束后为 0”应注明无其他候选、无未清除屏障；否则与 N15、N17 允许保守返回 `unknown` 的规则冲突。[v6 M4 验收](/C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin/design-v6-contract.md:373)
- 按替换清单生成单一合并稿，统一输入锁名称、`recording`、命令 ID、错误码及 D1 字母。A3／A3L 的去重方案已明确。

## Review-v5 逐项核对

| 项目 | 结论 | 核对结果 |
|---|---|---|
| B1-1：系统 note | **已关闭** | 确定性 ID、完整 entry、P1b 先持久化、P2 按 ID 去重及 W0 四种结果已明确。 |
| B1-1：输入并发 | **部分关闭** | 新版输入与 P6 的互斥方案成立；旧外部写入者仍取决于 S1，L-cur 接入说明需整理。 |
| B1-2：晚到归档 | **已关闭** | 主／late 目录、ref、事件和校验分离；W1b-L 明确复用账本载荷，不重新归档，再次崩溃结果唯一。 |
| B1-3：POSIX 终止证明 | **部分关闭** | 原 subreaper 反例已覆盖；新增判空规则仍受 B6-2 的完整性缺口影响。 |
| M4：入口退出后的后代 | **部分关闭** | exited 记录保留、来源 g/h/i 补上计数对象；最终范围和安全清除仍有上述依赖。 |
| Minor：`C_auth` | **已关闭** | 公式包含 `C_init`；只有 initial adopt 可引入既有 consumed 状态。 |
| Minor：编号与合并稿 | **方案已关闭，待整理** | A3L 改号及清理清单足够具体。 |
| B4、D3 及其他已关闭项 | **保持关闭** | 本轮未发现对 K 恢复、T 缓存边界、追加轮次、权威检查及路径保护的破坏。 |

## 新引入的问题

未发现新的架构性依赖环。

新增问题集中在两处：**把进程枚举完整性隐含为已满足条件**，以及**低估 S1 对 drain 工作流的影响**。S1-B 的额外修改已显式列出，没有被默认授权；但也不能在裁决前当作既定实现方案。

晚到归档的双存储、确定性系统 note、退出记录保留，均属于现有契约的局部补强。

## 是否可进入实现切分

**no，尚不能整体进入正式实现切分。**

前置条件：

1. 落盘 S1 的输入与执行者范围决定。
2. 收口 POSIX 判空放行的完整性前提；无法证明时明确返回 `unknown`。
3. 完成标为“实现前契约整理”的合并稿。

已关闭的架构、UX、归档、K/T 和 D3 内容可以保留，无需重新设计。

## 仍需用户裁决的问题

**仅 S1，但应分别确认两项：**

1. 是否接受运行期间不支持 L-foreign 输入，或追加授权采用 S1-B。
2. 是否接受将“从未观测、没有残留证据的 L-foreign 执行者”排除出 drain 保证；**选择 B 也不能省略这一决定。**

D1–D4 不需要重裁。B6-2 属于正确性收口，不应通过人工批准跳过终止证明。