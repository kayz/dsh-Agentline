# AgentLine Session 集成

## 状态

**Implemented**（commit `4457844`；`orchestrator/test/session.test.mjs` 覆盖）

前置条件：

- CLIWorker 完成 `ModelHandle.session` v1 契约
- `SESSION-MANAGEMENT.md` 中的 start / resume / id_from / reset_on 稳定
- CLIWorker 发布可安装版本

实现已完成；后续仅随 CLIWorker 契约变更维护。

## 背景

当前 AgentLine 主要是一次性 CLI 调用：

- 每轮重新初始化 prompt
- 不保存 provider session
- design/dev/review 之间没有上下文复用
- 多轮 build 会重复发送项目背景

目标：

- design 跨轮复用
- dev 跨轮复用，修复回原 session
- design pre-review 复用 design session
- review 每轮新建独立 session
- 减少重复背景，提高一致性
- 保持 review 独立性

## 依赖的 CLIWorker 契约

`ModelHandle.session`：

```json
{
  "supported": true,
  "start": {
    "command": "...",
    "args": [],
    "input": "stdin",
    "cwd": "<workspace>"
  },
  "resume": {
    "command": "...",
    "args": ["--resume", "{session_id}"],
    "input": "stdin",
    "cwd": "<workspace>"
  },
  "id_from": "stdout_json | stdout_regex | stderr_regex | sidecar_file",
  "id_path": "session_id",
  "reset_on": ["model_change", "provider_change", "contract_change"],
  "supports_resume": true
}
```

AgentLine 不解析 provider 的 resume 参数，只替换 `{session_id}`。

## 实施范围

### 1. 新增 `orchestrator/lib/session.mjs`

- 读写 `.collab/tasks/<id>/sessions/<role>.json`
- 原子写入
- session 校验
- start / resume / invalidate / archive
- 同 session 并发互斥
- 过期判断（可注入时钟）

### 2. 通用调用执行器

- 使用 `ModelHandle.session.start`
- 使用 `ModelHandle.session.resume`
- 从 `id_from/id_path` 提取 session id
- 不写 provider 分支
- 返回 `{ text, session_id, usage }`

### 3. 角色策略

| 角色 | 策略 |
|---|---|
| design | 同任务跨轮复用 |
| design pre-review | 复用 design |
| dev | 同任务跨轮复用 |
| review | 每轮新建 |
| test_architect | 每轮独立 |

review 不得复用 design/dev。

### 4. 上下文增量

- 不重发完整 brief/design
- 只发 diff、findings、失败证据、摘要
- 记录 `context_digest`
- 记录 token/cache 指标

### 5. 选模缓存

- 缓存 `task + role -> ModelHandle + selection_id`
- 不每轮拉全量模型列表
- 每轮只查 `/cliworker/forecast?model=<key>`
- 额度不足时重新申请

### 6. 失效与切换

以下情况结束旧 session 并新建：

- 模型变化
- provider 变化
- 契约/CLI 版本变化
- resume 失败/过期
- review 新轮次
- 上下文摘要重建

不能假装 resume 成功；用摘要 + diff 续接。

### 7. Usage

每次 start/resume 后：

- 记录 input/output/cache tokens
- 上报 CLIWorker `usage` endpoint
- 更新预测

## 非目标

- 不在 AgentLine 重新实现 provider 管理
- 不在 AgentLine 重新实现价格/额度/预测
- 不在 AgentLine 硬编码 provider resume 参数
- 不改变 CLIWorker 的选模契约

## 测试

- start 解析 session_id
- resume 复用
- model change 拒绝 resume
- review 每轮新 session
- design/dev 跨轮
- 无 session 支持报错
- 并发同 session 互斥
- 失效不写半截记录
- usage 上报
- 固定时钟过期
- 不重复发送完整 brief/design

## 完成标准

- design/dev 跨轮复用
- review 独立
- 每轮无全量背景重发
- token/cache 证据可查
- 本地测试通过
- 与 CLIWorker 契约端到端通过


