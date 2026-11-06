# Task 004 — 实现记录

## 变更清单

| 文件 | 变更 | 用途 |
|---|---|---|
| `orchestrator/lib/blueprint.mjs` | 新增 | Blueprint 控制面：会话落盘、单步 `design → testability → review`、G1、内容哈希、批准与物化 |
| `orchestrator/agentline.mjs` | 修改 | `blueprint new\|run\|review\|approve\|materialize\|status` |
| `orchestrator/test/blueprint-cli.test.mjs` | 新增 | 六个命令、单步顺序、失败不推进、冲突、物化保真、批准失效后重新批准 |
| `orchestrator/test/blueprint-g1.test.mjs` | 新增 | G1 逐项正反例，以及内容变更使批准失效 |
| `plugin/lib/index.js` | 修改 | `/agentline/blueprint`：GET 读落盘，POST 每次只转发一条 CLI |
| `plugin/lib/client.js` | 修改 | Blueprint 页：真实轮次、角色、findings、任务图、G1、批准与物化；空、损坏和操作失败分开 |
| `plugin/test/blueprint-ui.test.mjs` | 新增 | 真实路由上的空、真实、错误、项目切换、单次 CLI 和原有五个页 |
| `plugin/test/studio-ui.test.mjs` | 修改 | Blueprint 页改为断言空状态「还没有 Blueprint 会话」 |

Studio、Build 和既有任务流没有改写。插件不自己写 `.collab/**`。

## 自测结果

在仓库根用 Node 跑了与 `acceptance.md` 相同的检查（本环境是 bash，不是 pwsh）。界面没有桌面浏览器，AC-4 / AC-5 的插件测试用同一套渲染桩驱动真实 `/agentline/blueprint` 路由。

| AC | 结果 | 输出 / 退出码 |
|---|---|---|
| AC-1 | 通过 | `node --check` 三个文件后输出 `AC-1 OK`，退出码 0 |
| AC-2 | 通过 | `blueprint-cli.test.mjs` 4 通过 / 0 失败，随后 `AC-2 OK`，退出码 0 |
| AC-3 | 通过 | `blueprint-g1.test.mjs` 21 通过 / 0 失败，随后 `AC-3 OK`，退出码 0 |
| AC-4 | 通过 | `blueprint-ui.test.mjs` 7 通过 / 0 失败，随后 `AC-4 OK`，退出码 0 |
| AC-5 | 通过 | `orchestrator` 的 `npm test` 136 通过 / 0 失败；`plugin/test/*.test.mjs` 17 通过 / 0 失败；随后 `AC-5 OK`，退出码 0 |

## 与设计的偏离

无

## 遗留问题

无
