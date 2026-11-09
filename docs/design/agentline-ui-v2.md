# AgentLine UI v2 设计

## 目标

把当前“素、长页、模型内容混在设置里”的界面，改成 DeepSeek Harness 风格的驾驶舱：

- 左侧导航 + 顶部上下文栏
- 内容按领域拆分
- 模型由 CLIWorker 管理，AgentLine 只展示“模型来源”
- 深色 / 浅色两套主题
- 空、加载、错误、未知四种状态
- 不把模型选择、Provider、价格、预测塞进 AgentLine

## 信息架构

```text
AgentLine
├─ 概览       项目组合 / Inbox / 运行中 / 最近事件
├─ Studio     Studio 会话、问题、决策、G0
├─ Blueprint  Blueprint 轮次、评审、任务图、G1
├─ Build      任务列表、阶段、CI、日志、合并
├─ 模型       CLIWorker 连接、模型目录、选择预览
└─ 设置       项目 / 角色 / 主题 / 插件
```

“模型”不再放在设置页里，而是独立入口。

## 布局

```text
┌──────────────┬─────────────────────────────────────────────┐
│ AgentLine    │ 项目: dsh-Agentline    状态: 空闲    主题 ◐  │
│              ├─────────────────────────────────────────────┤
│ ▸ 概览       │                                             │
│ ▸ Studio     │  页面标题 + 说明                             │
│ ▸ Blueprint  │  ┌─────────────┐ ┌─────────────┐             │
│ ▸ Build      │  │ 卡片         │ │ 卡片         │             │
│ ▸ 模型       │  └─────────────┘ └─────────────┘             │
│ ▸ 设置       │                                             │
│              │                                             │
│ 运行中: 2    │                                             │
└──────────────┴─────────────────────────────────────────────┘
```

- 左栏 220px，可折叠到 56px
- 顶栏 48px，显示项目、状态、主题、刷新
- 内容区最大宽 1200px，卡片 12px 圆角
- 间距 8 / 12 / 16 / 24
- 字体 13px，标题 20/15/12
- 主色使用 DSH 的 accent，不另造品牌色

## 主题

```css
:root {
  --ag-bg: var(--dsw-alias-bg-base);
  --ag-surface: var(--dsw-alias-bg-elevated);
  --ag-border: var(--dsw-alias-border-subtle);
  --ag-text: var(--dsw-alias-label-primary);
  --ag-muted: var(--dsw-alias-label-secondary);
  --ag-accent: var(--dsw-alias-brand-primary);
  --ag-danger: var(--dsw-alias-state-error);
  --ag-warn: var(--dsw-alias-state-warning);
  --ag-ok: var(--dsw-alias-state-success);
}
```

浅色主题只覆盖 token，不改组件结构。主题选择写入 `localStorage`，默认跟随 DSH。

## 模型页

模型页是 CLIWorker 的只读视图 + 选择预览，不直接管理 Provider。

```text
┌ 模型来源 ────────────────────────────────────────────────┐
│ CLIWorker  ● connected   0.2.0   C:\git\dsh-CLIWorker      │
│ 模型 28 · Provider 5 · 未验证 6 · 最近同步 10:32           │
│ [重新连接] [查看 Provider]                                 │
└──────────────────────────────────────────────────────────┘

┌ 选择预览 ────────────────────────────────────────────────┐
│ 级别 [Top ▾]  数量 [2]  用量 [Heavy ▾]  [获取模型]        │
│ 返回 CLI 调用：                                            │
│ hy4free        codebuddy  Top  verified  剩余 12 任务      │
│ claude-opus-5-5 claude    Top  verified  剩余 30 任务      │
└──────────────────────────────────────────────────────────┘

┌ 模型目录 ────────────────────────────────────────────────┐
│ 筛选 [全部 Provider ▾] [全部级别 ▾] [可用性 ▾] 搜索…      │
│                                                          │
│ Claude (3)                                                │
│  模型            级别   身份      可用性   预测    价格    │
│  claude-opus-5-5 Top    verified  callable ok      15/75  │
│  ...                                                      │
│ Codex (4)                                                 │
│  ...                                                      │
└──────────────────────────────────────────────────────────┘
```

规则：

- AgentLine 不显示“角色矩阵里选哪个模型”作为模型管理；只显示“当前模型来源”。
- 角色页只显示每个角色要求的 level / count / usage / 约束。
- 模型详情、Provider、价格、预测、白名单、排序由 CLIWorker 页面负责。
- 连接失败显示错误、重试、最后成功时间，不假装有数据。

## CLIWorker 连接

AgentLine Host 增加代理层，避免浏览器直接访问 CLIWorker 的 admin 路由：

```text
GET  /agentline/cliworker/status
GET  /agentline/cliworker/models
POST /agentline/cliworker/select
```

Host 侧调用 `modelSource` 配置的 CLIWorker CLI：

```json
{
  "kind": "cliworker",
  "command": "node",
  "args": ["C:/git/dsh-CLIWorker/bin/cliworker.mjs", "--config", "..."]
}
```

AgentLine 只转发：

- status
- models
- select（level/count/usage）
- 错误码

不在 AgentLine 里重新实现 Provider/价格/预测。

## 页面拆分

### 概览

- 项目组合表
- Inbox 卡片
- 运行中
- 最近事件

### Studio

- 左：会话列表；右：角色、预算、轮次、问题、决策、确认、G0
- 操作：运行下一步 / 结束并评估 G0
- 空/错误/等待/完成四态

### Blueprint

- 轮次、角色、预算
- Tabs：概览 / 设计 / 评审 / 测试架构 / 任务图 / 验收矩阵 / Gate
- 批准、物化、失效提示

### Build

- 任务表带项目列
- 来源、test_levels、T gate、模型、业务轮次、基础设施重试
- 错误/空/未知
- 日志抽屉

### 设置

- 项目
- 模型来源（只填 CLIWorker 指针）
- 主题
- 插件

## 组件

- `PageHeader`
- `Card`
- `Stat`
- `StatusBadge`
- `Tabs`
- `Table`
- `Drawer`
- `EmptyState`
- `ErrorState`
- `UnknownState`
- `ConfirmDialog`

## 响应式

- ≥ 1200：左栏 + 双列卡片
- 900–1199：左栏 + 单列
- < 900：左栏折叠为顶部导航；表格横向滚动
- 键盘：Tab 顺序、Esc 关抽屉、焦点回到触发按钮

## 实现顺序

1. 设计 token + 左栏/顶栏壳
2. 概览 / Build 拆页
3. 模型页 + CLIWorker Host 代理
4. Studio / Blueprint 分页
5. 设置拆子页
6. 明暗主题/可达性

## 非目标

- 不在 AgentLine 做模型白名单、价格、预测
- 不直接暴露 CLIWorker admin 路由
- 不伪造模型数据
