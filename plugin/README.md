# dsh-agentline

DSH 的 AgentLine 驾驶舱插件（Host + Web Client）。

- 对话内派活：`agentline_flow` / `agentline_status` / 驾驶舱
- P3 内核：每任务独立 worktree、`write_scope` 队列、note / amendment / attention
- 任务状态、阶段轨迹、日志尾随、额度胶囊
- 合并仍需人类许可

## 设置

DSH **Plugins → AgentLine**（或 Settings → Plugins）里配置：

| 字段 | 说明 |
|---|---|
| `agentlineHome` | 包含 `agentline.mjs` 的 orchestrator 目录，默认 `C:/git/dsh-Agentline/orchestrator` |
| `nodePath` | 运行 AgentLine CLI 的 Node；留空使用当前 DSH 的 Node |
| `defaultRepo` | 默认项目仓库；留空使用当前工作区 |
| `metricsEnabled` | 是否显示四个额度池 |
| `deepseekApiKey` | DeepSeek 余额查询（secret） |
| `claudeAccessToken` | Claude OAuth token（可选 secret） |
| `codexAccessToken` / `codexAccountId` | Codex 周额度（可选 secret / id） |
| `buddyAccessToken` / `buddyUserId` | Buddy 积分（可选 secret / id） |

凭据只保存在当前 DSH profile 的插件设置里（插件 schema 的 `role('secret')` 字段），
不会写入仓库；留空时回退到本机 CLI 登录快照或环境变量。

## 安装

```powershell
dsh plugin --profile desktop add file:C:\git\dsh-Agentline\plugin
```

然后确认 profile 的 `package.json` `dsh.profile.bundles` 含 `dsh-agentline`，重启/刷新 DSH。

## 许可

MIT
