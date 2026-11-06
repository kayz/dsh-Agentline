# Cursor Provider（P2）

状态：P2 待接入
日期：2026-11-06
本机：Cursor 3.29.9

## 本机检查结果

- `cursor` 可执行：`C:\Users\kayz\AppData\Local\Programs\cursor\resources\app\bin\cursor.cmd`
- `cursor --version`：3.29.9
- `cursor --help` 的子命令包含：`agent  Start the Cursor agent in your terminal.`
- 目前没有发现稳定的非交互式 `models` 子命令；`cursor agent --help` 返回的是编辑器全局 help，`cursor agent models` 没有模型列表输出。
- 模型名称/能力/可调用性不能从 CLI 直接当作已认证事实；必须通过 Cursor Agent Service 或会话 probe 验证。不要把模型名硬编码进 AgentLine。

## P2 设计

- Provider id：`cursor`
- adapter 类型：`cursor-agent`（优先 Cursor CLI/Agent Service 的非交互调用；若只能打开终端，则标记 `interactive_only`，不进入自动编排）
- 版本探测：`cursor --version`；记录 executable path/fingerprint
- 认证探测：`cursor agent` 能否在目标账户下完成短上下文 probe
- 模型发现：
  - 从 Cursor 账户/模型配置读取候选；
  - 结果只进入 `discovered`；
  - 人工登记可补充 provider model id / 显示名 / 能力；
  - 只有短上下文 probe 成功后才进入 `callable`
- 短上下文 probe：
  - `reply OK`，限制 token/时间；
  - 记录 requested/resolved、CLI 版本、耗时、错误；
  - 失败不自动降级，不自动换模型。
- 角色约束：
  - Cursor 模型若进入 Studio/Blueprint，必须满足 top allowlist 和角色隔离；
  - 未确认身份的模型持续显示 `unverified`；
  - 手工登记是兜底。
- UI：
  - 设置 → 模型目录新增 Cursor 行；
  - 显示 discovered/callable、版本、认证、最近 probe；
  - 角色矩阵中可手动指定 Cursor 模型；
  - 不能把 discovered 直接选进 top 角色。

## 待验证

1. `cursor agent` 是否有非交互 prompt/JSON 输出模式。
2. Cursor Agent Service 是否提供模型列表/账户信息。
3. 能否在不打开 GUI 的情况下完成短上下文 probe。
4. Windows 下进程树与 Job Object 的终止行为。

## P2 任务

- [ ] `cursor` provider manifest + version/probe
- [ ] 模型发现/手工登记
- [ ] 短上下文 probe 与 `unverified` 状态
- [ ] 设置页模型目录/角色矩阵
- [ ] 契约测试：auth/429/空输出/截断/模型不存在
