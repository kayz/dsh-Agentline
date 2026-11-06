# Task 004 — 实现记录

## 变更清单

| 文件 | 变更 | 用途 |
|---|---|---|
| `orchestrator/lib/blueprint.mjs` | 新增，并按设计收紧 G1 | Blueprint 控制面：会话落盘、单步 `design → testability → review`、G1、内容哈希、批准与物化 |
| `orchestrator/agentline.mjs` | 修改 | `blueprint new\|run\|review\|approve\|materialize\|status` |
| `orchestrator/test/blueprint-cli.test.mjs` | 新增 | 六个命令、单步顺序、失败不推进、冲突、物化保真、批准失效后重新批准 |
| `orchestrator/test/blueprint-g1.test.mjs` | 新增，并补反例 | G1 逐项正反例；来源豁免不能通过；无标题和空任务图不能通过 |
| `plugin/lib/index.js` | 修改 | `/agentline/blueprint`：GET 读落盘，POST 每次只转发一条 CLI |
| `plugin/lib/client.js` | 修改 | Blueprint 页：真实轮次、角色、findings、任务图、G1、批准与物化；空、损坏和操作失败分开 |
| `plugin/test/blueprint-ui.test.mjs` | 新增 | 真实路由上的空、真实、错误、项目切换、单次 CLI 和原有五个页 |
| `plugin/test/studio-ui.test.mjs` | 修改 | Blueprint 页改为断言空状态「还没有 Blueprint 会话」 |

Studio、Build 和既有任务流没有改写。插件不自己写 `.collab/**`。

## 这次收紧的原因

G1 每次从落盘重新求值。两处会让无效证据被当成可批准：

- 来源 G0 被标成可豁免。`waivers.json` 里只要哈希对得上，失效、缺失或与 `from.gate_hash` 不一致的来源仍能让检查通过，从而批准和物化。设计要求保留来源 G0，不能伪造证据；来源失效必须使批准失效。现在 `G1.studio_link` 不可豁免，豁免文件只接受仍标记为可豁免的测试架构跨厂商偏好。内容哈希加入 `source/from.json` 和当前 G0 哈希，来源绑定一变，旧批准就对不上。
- 重读 `task-graph.json` 时不检查任务 `title`，也不拒绝空的 `tasks` / `acceptance`。空数组的覆盖和矩阵比较会空过；摘要刷新后，无标题或空图仍可能被批准，物化 brief 的标题会变成空。现在缺标题只让 `G1.task_fields_complete` 失败；空任务和空验收让 schema、字段、双向覆盖失败；没有 AC 行的矩阵记为 `matrix:empty`。物化在写任务前再次拒绝空图和缺标题。

## 自测结果

在仓库根用 Node 跑了与 `acceptance.md` 相同的检查（本环境是 bash，不是 pwsh）。界面没有桌面浏览器，AC-4 / AC-5 的插件测试用同一套渲染桩驱动真实 `/agentline/blueprint` 路由。

| AC | 结果 | 输出 / 退出码 |
|---|---|---|
| AC-1 | 通过 | `node --check` 三个文件后输出 `AC-1 OK`，退出码 0 |
| AC-2 | 通过 | `blueprint-cli.test.mjs` 4 通过 / 0 失败，随后 `AC-2 OK`，退出码 0 |
| AC-3 | 通过 | `blueprint-g1.test.mjs` 24 通过 / 0 失败（含 23 个子例），随后 `AC-3 OK`，退出码 0 |
| AC-4 | 通过 | `blueprint-ui.test.mjs` 7 通过 / 0 失败，随后 `AC-4 OK`，退出码 0 |
| AC-5 | 通过 | `orchestrator` 的 `npm test` 139 通过 / 0 失败；`plugin/test/*.test.mjs` 17 通过 / 0 失败；随后 `AC-5 OK`，退出码 0 |

## 与设计的偏离

无

## 遗留问题

无
