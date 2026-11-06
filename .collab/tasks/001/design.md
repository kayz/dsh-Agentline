---
write_scope:
  - plugin/lib/client.js
  - plugin/lib/index.js
---

# Task 001 · P5：AgentLine 驾驶舱 UI 按原型落地 — 设计

基准 commit：`9efb19992f3d68f760082f0cda600c5e6d6b1ee9`（沿用本文件已有基准；本轮 design 未执行 git 核验，不另定版本号）。
参照：`docs/blueprint/20261106-agentline-plugin/mockups/index.html`、`design-v1.md` §5、`docs/design/agentline-v2-baseline.md` §7。

## 0. 决策摘要

1. `plugin/lib/client.js` 的 `Cockpit` 改成 **Tab 式驾驶舱**：顶栏（保留）+ Tab 条（首页 / Studio / Blueprint / Build / 设置）+ 当前 Tab 页面。旧的“项目组合 + 任务列表 + ⚙ 展开面板”单页布局整体拆进各 Tab，不在旧布局上叠加。
2. **Host 需要两条新的只读路由**（brief 约束允许“如需 Host 小改动，先说明并只做只读路由”）：
   - 客户端是浏览器侧，无法直接读 `.collab/studio`、`.collab/blueprint`；orchestrator 已有只读的 `orchestrator/lib/pipeline.mjs#readPipelineSummary`，Host 只做转发。
   - Provider / 模型目录同理：orchestrator 已有 `lib/config.mjs#loadConfig` 和 `lib/model-catalog.mjs#buildCatalog`，Host 只做转发。
   - 两条路由**只接受 GET**，非 GET 返回 405；不写任何文件；不改动任何既有路由。
3. Studio / Blueprint 页**只展示 pipeline summary 已有的字段**（会话 id、status、updated_at）。轮次、问题、gate、审批等在当前内核中没有数据源，一律显示“未实现”，不推断、不造数据。
4. Build 页保留现有列表 + 详情（阶段轨迹、合并面板、K1 ledger、控制条、attention 回答、执行记录、日志）全部原样，只增加项目 / 来源 / 模型 / T gate 信息行。
5. 首页的待处理卡片**不新增写操作**：按钮只负责跳到 Build 详情，回答 / 合并仍走现有的 Build 详情控件（含二次确认）。
6. 不改 `plugin/package.json` 版本号，不改 `docs/`，不改 orchestrator。

沿用本文已有章节、字段和接口约定；原型只作为布局与信息层级参考。P5 的范围以 brief 为界：不照搬原型中的阶段进度、预算、审批哈希或模型示例，也不实现 design-v1.md §5 的完整控制面。

## 1. Host 改动（`plugin/lib/index.js`，仅只读路由）

在 `ctx.inject(['webServer'], ...)` 回调里，紧跟 `/agentline/flow` 路由之后新增两条路由；顶部注释第 8 行的路由列表补上 `pipeline,catalog`。其余代码不动。

### 1.1 `GET /agentline/pipeline?project=<path>`

```js
// 只读：Studio / Blueprint / Build 阶段摘要（转发 orchestrator/lib/pipeline.mjs，不写盘）
route('/agentline/pipeline', 'agentline: pipeline', async (req, res) => {
  try {
    if (req.method && req.method !== 'GET') return sendJson(res, { ok: false, error: 'GET only' }, 405)
    const u = new URL(req.url || '/', 'http://localhost')
    const project = resolveProject(u.searchParams.get('project'))
    const mod = await importFresh(path.join(agentlineHome(), 'lib', 'pipeline.mjs'))
    sendJson(res, { ok: true, project, summary: mod.readPipelineSummary(project) })
  } catch (e) { sendJson(res, { ok: false, error: String(e.message || e) }) }
})
```

响应：`{ ok: true, project, summary }`，`summary` 即 `readPipelineSummary` 原样返回值（`schema: 'agentline.pipeline/v1'`、`stages.studio`、`stages.blueprint`、`stages.build`、`tasks[]`）。orchestrator 太旧（没有 `lib/pipeline.mjs`）时返回 `{ ok: false, error }`。

已核对当前模块实际读取 `.collab/studio/<id>/session.json` 和 `.collab/blueprint/<id>/state.json`，仅投影 `id/status/updated_at`。当前读取器会跳过无法解析的会话文件；UI 不得宣称“目录不存在”或“文件有效”，只说明没有可展示的记录。本任务不改变该核心行为。

### 1.2 `GET /agentline/catalog`

```js
// 只读：模型目录与 Provider 发现缓存（转发 orchestrator 的 config + model-catalog，不写盘）
route('/agentline/catalog', 'agentline: catalog', async (req, res) => {
  try {
    if (req.method && req.method !== 'GET') return sendJson(res, { ok: false, error: 'GET only' }, 405)
    const cfgMod = await importFresh(path.join(agentlineHome(), 'lib', 'config.mjs'))
    const mc = await importFresh(path.join(agentlineHome(), 'lib', 'model-catalog.mjs'))
    const loaded = cfgMod.loadConfig({ orchestratorRoot: agentlineHome() })
    const cache = readJsonFile(loaded.paths.models)
    sendJson(res, { ok: true, catalog: mc.buildCatalog({ config: loaded.config, discovery: cache }), discovery: loaded.discovery || null })
  } catch (e) { sendJson(res, { ok: false, error: String(e.message || e) }) }
})
```

响应：`{ ok: true, catalog: { schema, generated_at, models: [...] }, discovery: null | { generatedAt, providers: [...] } }`。`models[]` 的字段就是 `normalizeModel` 的输出（`key, provider, id, tier, identity, availability, source, ...`）。

注意两种 discovery 形状：传给 `buildCatalog` 的 `cache.providers` 是按 Provider 名称索引的对象；返回浏览器的 `loaded.discovery.providers` 是名称字符串数组。不得把后者传给 `buildCatalog`，也不得将原始 config、Provider 命令配置或凭据返回浏览器。`discovered`、`unverified` 按原值展示，不视为 `callable`。

### 1.3 不变的部分

既有 12 条路由（`metrics, projects, tasks, task, merge, models, routing, live, control, summary, notices, flow`）的路径、方法、响应保持原样。斜杠命令、工具、sweep 逻辑不动。

## 2. 客户端结构（`plugin/lib/client.js`）

写法保持现状：`const h = React.createElement`，不引入 JSX/构建步骤，不新增 `require`。`HeaderChips`、`SettingsSection`/`SettingsPage`（DSH 插件设置页）、`focusTask`、`SafeBoundary`、`apply` 的注册逻辑**不改**。

### 2.1 新常量

```js
const TABS = [['home', '首页'], ['studio', 'Studio'], ['blueprint', 'Blueprint'], ['build', 'Build'], ['settings', '设置']]
const TAB_IDS = TABS.map((t) => t[0])
const SLASH_COMMANDS = [
  { cmd: '/agentline', desc: '显示当前工作区的任务数与运行中数量', ok: true },
  { cmd: '/agentline <目标>', desc: '在当前工作区新建任务并启动 flow（design → dev → CI → review）', ok: true },
  { cmd: '/agentline --project <路径> <目标>', desc: '指定工作区派活', ok: true },
  { cmd: '/agentline studio …', desc: 'Studio 立项与讨论', ok: false },
  { cmd: '/agentline blueprint …', desc: 'Blueprint 设计与 G1', ok: false },
  { cmd: '/agentline approve …', desc: 'gate 批准（需原话）', ok: false },
]
const STAGE_TEXT = { not_started: '未开始', idle: '空闲' }   // 其它 status 原样显示
const SOURCE_TEXT = { blueprint: 'Blueprint', adhoc: '独立' } // 'unknown' 或缺失 → 不显示标签
```

### 2.2 `Cockpit` 新增状态

在现有 state 基础上：

| state | 初值 | 来源 / 说明 |
|---|---|---|
| `tab` | `useState(() => { try { const v = window.localStorage.getItem('agentline.tab'); return TAB_IDS.includes(v) ? v : 'home' } catch { return 'home' } })` | 每次变化写回 `localStorage['agentline.tab']`（try/catch） |
| `summary` | `null` | `GET /agentline/summary`，存 `{ running, prOpen, blocked }`；挂载时立即拉取，之后每 5s |
| `notices` | `null` | `GET /agentline/notices` 的 `notices`；挂载时立即拉取，之后每 10s |
| `pipeline` | `null` | `GET /agentline/pipeline?project=`；成功存 `{ ok: true, summary }`，失败存 `{ ok: false, error: (r && r.error) \|\| '读取失败（宿主可能未提供 /agentline/pipeline）' }`；`project` 变化时立即拉取，之后每 15s |
| `catalog` | `null` | `GET /agentline/catalog`；成功存 `{ ok: true, catalog, discovery }`，失败存 `{ ok: false, error }`；进入设置 Tab 时拉取 |
| `showAllEvents` | `false` | 最近事件“展开全部 / 收起” |
| `routeMsg` | `''` | 角色路由保存结果提示 |

删除 `routeOpen` 状态（⚙ 面板并入设置 Tab）。`tasks`、`detail`、`current` 等其余 state 与全部 handler（`doMerge`、`control`、`resumeFlow`、`loadModels`、`toggleRole`、`saveModels`、`loadRouting`、`saveRouting`、`loadProjects`、`loadList`、`loadDetail`）保留，行为不变，只有以下调整：

- `saveRouting` 成功：原来 `setRouteOpen(false)` 改为 `setRouteMsg('已保存（下一次 flow 生效）')`；失败：`setRouteMsg('保存失败：' + ((res && res.error) || 'unknown'))`。
- `loadProjects` 读到 `agentline.focusTask` 时，除原有 `setPendingFocus(...)` 外再 `setTab('build')`。
- 设置 Tab 进入（以及处在设置 Tab 时 `project` 变化）：`loadRouting(project)`、`loadModels()`、`loadCatalog()`。用 `useEffect(..., [tab, project])` 实现。

### 2.3 新 helper（Cockpit 内部）

```js
const switchProject = (p) => { setProject(p); setCurrent(null); setDetail(null); setTasks([]) }
const openTask = (projectPath, taskId) => {
  setTab('build')
  if (projectPath && projectPath !== project) { switchProject(projectPath); setPendingFocus({ project: projectPath, task: taskId }) }
  else setCurrent(taskId)
}
const projTitle = (p) => { const x = projects.find((y) => y.path === p); return x ? x.title : (p ? String(p).split(/[\\/]/).pop() : '—') }
const srcOf = (id) => { const t = pipeline && pipeline.ok ? ((pipeline.summary && pipeline.summary.tasks) || []).find((x) => x.id === id) : null; return t ? t.source : null }
```

- 顶栏项目下拉框的 `onChange` 与项目组合行点击都改用 `switchProject`。
- `pendingFocus` 生效的 effect 依赖由 `[tasks.length, pendingFocus]` 改为 `[tasks, pendingFocus]`，且只有当 `!pendingFocus.project || pendingFocus.project === project` 时才消费（防止切项目时任务数相同导致不触发、或命中旧项目的同号任务）。

以上 helper 为最小逻辑示意，落地时必须同时处理请求竞态：切项目立即清空 pipeline、routing、draft、日志选择、回答/注入文本、合并确认与提示；先取消旧请求或使其失效，再拉新项目数据。tasks、detail、pipeline、routing 的响应仅在请求项目仍等于当前项目时应用；detail 还须匹配当前 task 和日志模式。同项目切任务也清空旧详情和合并确认，防止把旧任务操作发给新任务。轮询卸载时清理定时器，已失效请求不得回写。无需为此新增持久化或 Host 字段。

清空项目时同时清空项目 token 统计；返回同一项目也不能接受上一次访问遗留的响应，使用组件内请求序号或取消标志区分请求。项目或任务尚未加载完成时禁用相关写操作；已提交操作的反馈只允许更新原项目/任务。手动刷新覆盖当前页的数据源；设置页重新读取目录与路由，其它页重新读取 summary、notices、pipeline 及现有列表/详情。

### 2.4 渲染骨架

```
agl-panel
├─ agl-top        顶栏：保留现有内容（标题、运行灯、项目下拉、额度、token、↻）；⚙ 按钮改为 setTab('settings')，title '设置'
├─ agl-tabs       Tab 条：TABS.map → button.agl-tab(.on)；'首页' 后面在 pending>0 时追加计数徽章
├─ err ? agl-empty
└─ 当前页：tab==='build' ? div.agl-build（flex 列，内含原 agl-body） : div.agl-page（可滚动）
```

页面用 Cockpit 内部的普通渲染函数 `renderHome()` / `renderStudio()` / `renderBlueprint()` / `renderBuild()` / `renderSettings()` 实现（不含 hooks，避免 hooks 顺序问题）。`pending = summary ? summary.blocked.length + summary.prOpen.length : 0`。

## 3. 各 Tab 规格

文案中引号内的字符串是**必须逐字出现**的界面文本（验收会做静态检查）。

### 3.1 首页（`home`）

两栏：`div.agl-grid2`，左栏主内容，右栏辅助；窄屏（≤900px）变单栏。

左栏：

1. **现在卡在哪**：标题 `'现在卡在哪'`。按下列优先级从 `summary`（跨项目）取第一条：
   1. `blocked` 中 `reason === 'awaiting_human'` → `⏸ <project> #<task> designer 等待回答`
   2. `blocked` 其它 → `⛔ <project> #<task> 阻塞：<reason>`
   3. `prOpen` → `✅ <project> #<task> 评审通过，等待合并许可`
   4. `live`（已有 3s 轮询）→ `▶ <project> #<task> <role> · <modelId||model> · <n>m`
   5. 都没有 → `'没有需要你处理的事项。'`

   有条目时右侧按钮 `'打开'` → `openTask(projectPath, task)`。`summary === null` 时显示 `'读取中…'`。
2. **项目组合**：标题 `'项目组合'` + `(n)`。表格 `table.agl-t`，列：`项目 | 任务 | 进行中 | 最近状态 | 待处理 | 运行中`。
   - 任务 / 进行中 / 最近状态：`p.tasks.total`、`p.tasks.active`、`p.tasks.last || '—'`（来自 `/agentline/projects`）。
   - 待处理：`summary` 中 `projectPath === p.path` 的 `blocked + prOpen` 条数；`summary === null` 时 `'—'`。
   - 运行中：`live` 中 `projectPath === p.path` 的条数。
   - 当前项目行标 `'当前'`；整行可点击 → `switchProject(p.path)`。
   - `projects` 为空：`'没有已登记的项目（在某个工作区用 /agentline 派活后会自动登记）'`。
3. **待处理**：标题 `'待处理'` + `(n)`。卡片 `div.agl-card`，顺序：非 awaiting_human 的 blocked → awaiting_human → prOpen。

   | 来源 | 标签 | 卡片样式 | 正文 | 按钮 |
   |---|---|---|---|---|
   | `blocked`，`reason !== 'awaiting_human'` | `阻塞` | `.bad` | `原因：<reason>` | `查看任务` |
   | `blocked`，`reason === 'awaiting_human'` | `问题` | 默认（黄） | `designer 等待回答；在 Build 详情中回答后 flow 会继续` | `去回答` |
   | `prOpen` | `可批准` | `.ok` | `评审通过，等待人类合并许可` | `去合并` |

   卡片标题 `<project> #<task>`；按钮都只调用 `openTask(projectPath, task)`。`summary === null` → `'读取中…'`；三类都为空 → `'没有需要你处理的事项。'`。
4. **运行中**：标题 `'运行中'` + `(n)`，数据 `live`。每行 `<project> #<task> · <role>[ r<round>] · <modelId||model> · <backend> · <n>m`，点击 → `openTask`。空：`'当前没有运行中的任务'`。
5. **最近事件**：标题 `'最近事件'`，数据 `notices`（Host 已按 `at` 倒序，最多 20 条）。默认显示前 6 条，多于 6 条时显示按钮 `'展开全部'` / `'收起'`。每行：`when(at)` · `<project> #<task>` · 事件文本（`pr_open→评审通过`、`merged→已合并`、`blocked→阻塞`，其它原样）+ （有 `reason` 时 `：<reason>`）。点击 → `openTask`。`notices === null` → `'读取中…'`；空数组 → `'暂无事件'`。

右栏：

6. **斜杠命令**：标题 `'斜杠命令'`。逐行渲染 `SLASH_COMMANDS`：等宽字体显示 `cmd` + `desc`；`ok: true` 的行有 `'复制'` 按钮（`navigator.clipboard.writeText(cmd)`，try/catch，失败忽略）；`ok: false` 的行灰显并带标签 `'未实现'`，无按钮。底部小字：`'LLM 工具：agentline_status · agentline_flow · agentline_metrics'`。这里只展示，不执行任何命令。

### 3.2 Studio（`studio`）

标题 `'Studio 会话'`。数据：`pipeline.summary.stages.studio`。

- `pipeline === null` → `'读取中…'`
- `pipeline.ok === false` → `'无法读取 Studio 数据：' + pipeline.error`
- `sessions.length === 0` → `'这个项目还没有 Studio 记录（.collab/studio 下没有会话）。'`，下一行小字 `'Studio 状态机尚未接入驾驶舱；这里只读展示已有数据，不推断状态。'`
- 否则：一行 `'状态：' + (STAGE_TEXT[status] || status)`；表格 `会话 | 状态 | 更新时间`（`id`、`status`、`when(updated_at)`）；表下小字 `'轮次、问题、G0 等详情：未实现'`。

### 3.3 Blueprint（`blueprint`）

标题 `'Blueprint 会话'`。数据：`pipeline.summary.stages.blueprint`，规则同 3.2：

- 读取中 / 失败：`'读取中…'` / `'无法读取 Blueprint 数据：' + pipeline.error`
- 空：`'这个项目还没有 Blueprint 记录（.collab/blueprint 下没有会话）。'` + 一行 `'状态：未开始'`
- 有会话：状态行 + `会话 | 状态 | 更新时间` 表格
- 不论有无会话，都显示一行 `'G1：未实现'`（不造 gate 数据）。

### 3.4 Build（`build`）

容器 `div.agl-build`（`flex:1;min-height:0;display:flex;flex-direction:column`），内部就是原来的 `agl-body`（列表 + 详情），保证日志区仍能占满剩余高度。

列表项（`agl-item`）改动：

- `r1` 不变（`#id` + 状态）。
- `meta` 行改为：状态点 + 项目标签（`projTitle(project)`）+ 来源标签（`SOURCE_TEXT[srcOf(t.id)]`，没有就不显示）+ `t.state.model || '—'` + `when(updated_at)`。
- 空列表仍是 `'暂无任务'`。

详情改动：在“阶段轨迹”那个 `agl-sec` 的状态行（`model … effort … switches …`）之前，插入一个任务信息块（`agl-fine`，每行一项）：

| 行 | 内容 |
|---|---|
| 项目 | `projTitle(project)` |
| 来源 | `SOURCE_TEXT[srcOf(detail.task)]`；没有 → `'旧任务：无来源记录'` |
| 模型 | 取 `detail.runs` 最后一条：`model_requested → model_resolved · provider`（缺哪个字段就省略哪段）；没有 runs → 不显示该行 |
| T gate | `'T gate：未实现（核心尚未产出 T gate 记录）'` |

其余详情内容（阶段轨迹、中断后“继续运行”、pr_open 合并面板含“确认合并 / 预授权合并 / 分档检查”、K1 step ledger、⏸/⏹/note/amend 控制条、attention 回答框、执行记录表、日志选择与原始/可读切换）**原样保留**。

### 3.5 设置（`settings`）

可滚动页，依次：

1. `'角色路由 · 仅影响本项目'`：原 ⚙ 面板中 design/dev/review 三行（模型下拉 + 质量/速度策略 + 当前顺序），按钮 `'保存'`（`saveRouting`），右侧显示 `routeMsg`；小字 `'保存后下一次 flow 生效（写入 .collab/agentline.json）'`。
2. `'全局：哪些模型可以在哪些角色上使用'`：标题常显；`modelsData` 为空时显示 `'读取中…'`，否则原矩阵表 + `'保存全局设置'` + `matrixMsg`（逻辑不变）。
3. `'模型目录（只读）'`：
   - `catalog === null` → `'读取中…'`；`catalog.ok === false` → `'无法读取模型目录：' + catalog.error`
   - `catalog.catalog.models` 为空 → `'暂无模型目录数据（运行 agentline models discover 或 agentline models add）'`
   - 否则表格：`模型 | Provider | id | 档位 | 身份 | 可用性 | 来源`（`key, provider || '—', id, tier, identity, availability, source`）。
4. `'Provider（只读）'`：行 = `discovery.providers` 与 `models[].provider`（非空）的并集，按名字排序；列 `Provider | 模型数 | callable | discovered`（按 `availability` 计数）。有 `discovery.generatedAt` 时表上方小字 `'发现缓存：' + when(generatedAt)`。并集为空 → `'暂无 Provider 数据'`。无任何编辑控件。
5. 小字：`'路径、Node、默认仓库与额度凭据在 DSH「插件 → AgentLine」中设置。'`

## 4. 样式

追加到现有 `css` 数组，沿用现有色值和 `var(--dsw-alias-…, 回退值)` 写法：

```css
.agl-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid rgba(255,255,255,.08);overflow-x:auto;white-space:nowrap;flex-shrink:0}
.agl-tab{background:transparent;border:0;border-bottom:2px solid transparent;color:#8b949e;padding:8px 12px;cursor:pointer;font-size:13px;white-space:nowrap}
.agl-tab.on{color:var(--dsw-alias-label-primary,#e6edf3);border-bottom-color:#58a6ff}
.agl-badge{display:inline-block;margin-left:5px;padding:0 6px;border-radius:999px;font-size:11px;background:rgba(210,153,34,.18);color:#d29922}
.agl-page{flex:1;min-height:0;overflow:auto;padding:12px 16px}
.agl-build{flex:1;min-height:0;display:flex;flex-direction:column}
.agl-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);gap:12px}
@media(max-width:900px){.agl-grid2{grid-template-columns:1fr}}
.agl-card{border:1px solid rgba(255,255,255,.1);border-left:3px solid #d29922;border-radius:8px;padding:8px 10px;margin-bottom:8px;background:rgba(255,255,255,.02)}
.agl-card.bad{border-left-color:#f85149}
.agl-card.ok{border-left-color:#3fb950}
.agl-tag{display:inline-flex;align-items:center;padding:0 6px;border-radius:6px;border:1px solid rgba(255,255,255,.14);font-size:11px;color:#8b949e;white-space:nowrap}
.agl-box{border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;margin-bottom:12px;background:rgba(255,255,255,.02)}
.agl-box h4{margin:0 0 8px;font-size:11px;letter-spacing:.06em;color:#8b949e;font-weight:600}
```

状态不只靠颜色：卡片都带文字标签（阻塞 / 问题 / 可批准），“未实现”是文字。

## 5. 数据源与空状态总表

| 位置 | 数据源 | 空 / 不可用时 |
|---|---|---|
| 现在卡在哪 | `/agentline/summary` + `/agentline/live` | `没有需要你处理的事项。` |
| 项目组合 | `/agentline/projects` | `没有已登记的项目（…）` |
| 待处理 | `/agentline/summary` | `没有需要你处理的事项。` |
| 运行中 | `/agentline/live` | `当前没有运行中的任务` |
| 最近事件 | `/agentline/notices` | `暂无事件` |
| Studio | `/agentline/pipeline`（新） | `这个项目还没有 Studio 记录（…）` |
| Blueprint | `/agentline/pipeline`（新） | `这个项目还没有 Blueprint 记录（…）`、`状态：未开始`、`G1：未实现` |
| Build 列表 / 详情 | `/agentline/tasks`、`/agentline/task`（既有） | `暂无任务` / `选择一个任务查看详情` |
| Build 来源 | `/agentline/pipeline` 的 `tasks[].source` | `旧任务：无来源记录` |
| Build T gate | 无（内核未产出） | `T gate：未实现（核心尚未产出 T gate 记录）` |
| 设置 · 路由 / 矩阵 | `/agentline/routing`、`/agentline/models`（既有） | `读取中…` |
| 设置 · 模型目录 | `/agentline/catalog`（新） | `暂无模型目录数据（…）` |
| 设置 · Provider | `/agentline/catalog`（新） | `暂无 Provider 数据` |

本表的空文案只适用于成功读取且结果为空。数据还没回来时显示 `读取中…`，不能显示 0 或任何示例值；网络失败、非 JSON、`ok: false` 与旧 Host 缺失路由显示读取失败，不得伪装成空项目、零待办或无限加载。各区块错误隔离，Studio/Blueprint/catalog 失败不妨碍 Build 使用；下一次轮询或重新进入页面可恢复。Provider 区与模型目录共享加载/错误状态，不得在目录请求失败时显示“暂无 Provider 数据”。允许用组件内状态实现这些分支，不扩展接口字段。

client.js 里不得出现 mockup 的示例数据（模型名、项目名 Shimeji、问题号、哈希、任务图节点号等）。模型行只在至少有一个真实模型字段时出现；不得把缺失 resolved 显示成 requested。当前 pipeline 摘要没有 T gate 字段，所以只显示未实现说明，不由 pr_open、review 或合并结果推导 gate 通过。

## 6. 兼容清单（实现后必须仍然成立）

- 任务操作：`control('stop')`、`control('stop-now')`、`control('inject', …)`（note/amendment）、`control('answer', …)`、`resumeFlow`、`doMerge('permission')`（两步确认）、`doMerge('grant')`（仅低档）、`doMerge('check')`。调用的端点与请求体不变。
- 从对话头部 `HeaderChips` 的弹层或 toast 点进来（`focusTask`）时，仍能定位到任务，并自动切到 Build Tab。
- DSH 插件设置页（`plugins.item` → `SettingsSection`）不变。
- `index.js` 既有 12 条路由不变；新路由只读。

## 7. 实施步骤（给 dev）

1. `index.js`：按 §1 加两条路由并改注释；`node --check plugin/lib/index.js`。
2. `client.js`：加常量（§2.1）、CSS（§4）、state 与 effect（§2.2）、helper（§2.3）。
3. 把原 `Cockpit` return 拆成 §2.4 的骨架：原“项目组合”块迁到 `renderHome`（改成表格），原 `agl-body` 迁到 `renderBuild`，原 `routeOpen` 面板迁到 `renderSettings`。
4. 补齐 §3 各页内容与空状态文案。
5. 下游 dev 按 acceptance.md 逐条自测；在其角色允许的 `impl.md` 记录 Host 改动只读的理由与自测输出。本轮 design 只修改本目录 design.md、acceptance.md；front matter 的 write_scope 指下游产品代码范围，不授权 design 修改代码或实现报告。

## 8. 已知限制 / 不做

- 不实现 Studio/Blueprint 状态机、gate、审批、materialize，也不实现 v2 `/agentline/v2/command`；新的斜杠子命令只以“未实现”展示。
- `pipeline.mjs` 的 `source` 判定写成了 `st.origin?.kind || st.origin?.blueprint ? 'blueprint' : …`（运算符优先级导致任意 `origin.kind` 都算 blueprint）。orchestrator 不在本任务写入范围内，UI 原样展示，只在 impl.md 记录。
- Build 列表仍只显示当前项目（跨项目切换走首页的项目组合 / 待处理卡片）；“项目”信息以标签形式出现在每一行。
- 轮询节奏沿用简单定时器（live 3s、summary 5s、notices 10s、pipeline 15s、tasks/detail 5s），不做可见性暂停。
