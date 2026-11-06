你是 AgentLine Blueprint 20261106 的主设计师（Claude Opus 5.5）。用户已裁决 S1：

- S1-1=A：运行期间不支持 L-foreign 外部 CLI 并发写输入；新版输入命令和 runStep 用输入锁互斥；不改 `inputs.mjs` 的 append-only 格式；
- S1-2=A：可证明的旧执行者仍保持非零/unknown，直到终止证明；“从未被观测、且没有残留证据的旧 L-foreign 执行者”排除出 drain 保证，但必须显式写明。

请阅读：
- `docs/blueprint/20261106-agentline-plugin/review-v6.md`
- `docs/blueprint/20261106-agentline-plugin/design-v6-contract.md`
- `docs/blueprint/20261106-agentline-plugin/design-v5-contract.md`
- `docs/studio/20261106-agentline-plugin/decisions.md`

输出 `design-v7-contract.md`，只做最终局部收口：

1. **B6-2 POSIX 判空**：
   - 明确 `Cand = ∅ → proven_dead` 所需条件；无法证明进程枚举完整（hidepid、权限、pid namespace、枚举期间创建/退出）时返回 `unknown`，不得放行；
   - 给出“有效 anc，但后代未被枚举”和“外部旧 subreaper 接管”的反例与唯一恢复结果；
   - 如果结论是 POSIX 无守护时永远 `unknown`，明确写出，并说明这不会阻塞已证明/受守护路径。
2. **S1 落地**：
   - 输入锁覆盖当前核心 `run/flow`、新版 input/answer、P2、对账、P6；
   - 明确“运行期不支持 L-foreign 输入”的错误码/提示/审计；
   - drain 对“无可证明证据的旧执行者”的显式排除、日志和 UI 披露；
   - 同步 W7a、W16 和验收边界。
3. **Minor**：L-cur 锁接入、reserved ID 优先级、清零验收夹具、合并稿清理清单（recording、命令 ID、错误码、D1 字母）。
4. 给出替换章节清单、验收例子和最终审核检查清单。

要求：
- 只写变更，不重写全文；不写产品代码，不修改仓库。
- 不再询问 D1–D4/S1；只列真正的新用户裁决项（如果有）。
- 目标是让设计进入可实现切分；不要用“实现时再说”绕过终止证明。
- 完成后交 GPT-6 Astra 最终复核。

直接输出 Markdown 正文。
