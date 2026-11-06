# 评审结论

needs_revision。评审的 Git SHA：`1935693b3521428615e3cbe0990684a09f6cc42d`（从工作树 HEAD 指向的分支引用读取）；验收通过 2/5。CI 五条命令均退出 0，但执行成功不能替代对实际行为和测试覆盖的核对。

## Findings

- **P1：缺失或无效的阻塞问题证据能使 G0 通过。** `orchestrator/lib/studio.mjs:241-245` 仅在文件存在时标记无效，缺失 `questions.json` 被转换为空数组（267 行）；311-314 行仅依赖状态字段判断关闭，`answered` 或 `default_adopted` 即使没有有效 `user_action` 也不算阻塞。878、924-928 行据此通过无阻塞检查。删除问题文件，或者将未回答阻塞问题的状态改为 answered 而不提供回答，都可让其余证据完整的会话通过 G0，违背缺失证据不可成功以及未回答或无效回答不能视为确认的要求。G0 测试覆盖损坏文件和 open 状态，但未覆盖上述两种情况（`orchestrator/test/studio-g0.test.mjs:157-187,238-251`）。
- **P1：专家拒绝后的用户答复不参与重新确认。** 拒绝后创建问题并撤回确认步骤（`orchestrator/lib/studio.mjs:733-764`），答复只写入问题记录（800-823 行）；重新执行确认时只传决策和原纪要（675-677 行），确认提示词不含问题、答复或决策确认内容（456-471 行）。因此专家可能对同一份旧内容重新接受，用户的处理没有被讨论或确认；决策和纪要也未更新，已有其他专家确认仍有效。这不满足回答或修改后重新讨论、独立确认实际决策的要求。
- **P1：只读配置声明可绕过强制只读。** `orchestrator/lib/studio.mjs:53-63` 对 `capabilities.readonly_mode=true` 不覆盖任何 adapter 参数。若 Codex provider 声明该能力但保留现有 `workspace-write`（`orchestrator/config/agentline.config.json:25`），adapter 会按该参数运行（`orchestrator/lib/adapters/codex.mjs:66-75`），Studio 因而执行可写调用。能力声明本身不能保证配置实际只读，违反无法保证只读不得静默执行的要求。
- **P2：损坏的关联证据没有作为 UI 读取错误返回。** `orchestrator/lib/studio.mjs:243-250,263-273` 对损坏的 questions/decisions 只追加 errors，仍返回 `state: ok`；`plugin/lib/index.js:935-942` 因此返回 `ok: true`。UI 无法将该损坏会话与正常详情可靠区分，违背无效数据应显示错误及重试的要求。缺失文件同样未标记无效。
- **P2：不完整的专家确认可通过 G0。** `orchestrator/lib/studio.mjs:885-893` 仅在存在 expert 字段时校验归属，且仅在角色模型存在时校验模型匹配；删除 expert 字段或对应角色模型仍可计为有效确认。缺失归属或已分配模型不能证明对应专家独立确认。

## 验收逐项结论

- AC-1 **通过**：`ci-results.json` 中 AC-1 exitCode 0，输出 `AC-1 OK`。
- AC-2 **不通过**：CI exitCode 0、`AC-2 OK`；但只读调用及拒绝后重新讨论存在上述缺陷，测试不足以证明要求（`orchestrator/lib/studio.mjs:53-63,456-471,675-677,733-764`）。
- AC-3 **不通过**：CI exitCode 0、`AC-3 OK`；缺失问题文件、无效答复及不完整专家归属仍可通过（`orchestrator/lib/studio.mjs:241-245,311-314,885-893,924-928`）。
- AC-4 **不通过**：CI exitCode 0、`AC-4 OK`；关联证据损坏仍返回成功详情（`orchestrator/lib/studio.mjs:243-250,263-273`；`plugin/lib/index.js:935-942`）。
- AC-5 **通过**：CI exitCode 0、`AC-5 OK`，输出 96 tests、96 pass、0 fail，包含 flow 与新增测试。
