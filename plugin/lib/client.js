/**
 * dsh-agentline — browser half (v3)
 *
 * 左栏：sidebar.panellist 增加「AgentLine」入口。
 * 主区：main slot 注册驾驶舱 —— 任务列表 + 阶段轨迹 + 执行记录 + 日志尾随 + 额度。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agentline',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const css = [
      '.agl-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#0e1116);color:var(--dsw-alias-label-primary,#e6edf3);font:13px/1.55 -apple-system,"Segoe UI",sans-serif}',
      '.agl-top{display:flex;gap:14px;align-items:center;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.08);flex-wrap:wrap}',
      '.agl-title{font-weight:600;font-size:13px;letter-spacing:.02em}',
      '.agl-lamp{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.14);font-size:11px;white-space:nowrap}',
      '.agl-spin{width:9px;height:9px;border-radius:50%;border:2px solid rgba(88,166,255,.25);border-top-color:#58a6ff;animation:agl-rot .9s linear infinite}',
      '@keyframes agl-rot{to{transform:rotate(360deg)}}',
      '.agl-tok{color:#000;font-weight:600;font-variant-numeric:tabular-nums}',

      '.agl-metric{display:flex;gap:6px;align-items:baseline;font-size:12px;color:#9ba1ac}',
      '.agl-metric b{color:#e6edf3;font-weight:600;font-variant-numeric:tabular-nums}',
      '.agl-body{display:flex;flex:1;min-height:0}',
      '.agl-list{width:280px;border-right:1px solid rgba(255,255,255,.08);overflow:auto;padding:8px}',
      '.agl-item{padding:8px 10px;border-radius:8px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}',
      '.agl-item:hover{background:rgba(255,255,255,.04)}',
      '.agl-item.on{background:rgba(88,166,255,.12);border-color:rgba(88,166,255,.35)}',
      '.agl-item .r1{display:flex;justify-content:space-between;gap:8px;align-items:center}',
      '.agl-item .id{font-weight:600}',
      '.agl-item .meta{color:#8b949e;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.agl-dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:6px}',
      '.agl-detail{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}',
      '.agl-sec{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.06)}',
      '.agl-sec h4{margin:0 0 8px;font-size:11px;letter-spacing:.06em;color:#8b949e;font-weight:600;text-transform:uppercase}',
      '.agl-stages{display:flex;gap:6px;flex-wrap:wrap}',
      '.agl-stage{padding:3px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.12);font-size:11px;color:#9ba1ac}',
      '.agl-stage.done{color:#3fb950;border-color:rgba(63,185,80,.4);background:rgba(63,185,80,.08)}',
      '.agl-stage.now{color:#58a6ff;border-color:rgba(88,166,255,.5);background:rgba(88,166,255,.1)}',
      '.agl-stage.bad{color:#f85149;border-color:rgba(248,81,73,.4);background:rgba(248,81,73,.08)}',
      'table.agl-t{width:100%;border-collapse:collapse;font-size:12px}',
      '.agl-t th,.agl-t td{text-align:left;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap}',
      '.agl-t th{color:#8b949e;font-weight:500}',
      '.agl-t td.num{text-align:right;font-variant-numeric:tabular-nums}',
      '.agl-logs{flex:1;min-height:140px;display:flex;flex-direction:column;padding:0 16px 12px;overflow:hidden}',
      '.agl-logbar{display:flex;gap:8px;align-items:center;margin:8px 0}',
      '.agl-logbar select{background:#161b22;color:#e6edf3;border:1px solid rgba(255,255,255,.15);border-radius:6px;padding:2px 6px;font-size:12px;max-width:260px}',
      '.agl-pre{flex:1;min-height:0;overflow:auto;margin:0;background:#0b0e13;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px;font:11.5px/1.5 ui-monospace,Consolas,monospace;color:#c9d1d9;white-space:pre-wrap;word-break:break-word}',
      '.agl-top select{background:#161b22;color:#e6edf3;border:1px solid rgba(255,255,255,.15);border-radius:6px;padding:2px 8px;font-size:12px;max-width:260px}',
      '.agl-empty{padding:40px 16px;color:#8b949e;text-align:center}',
      '.agl-ctl{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid rgba(255,255,255,.12);border-radius:10px;background:rgba(255,255,255,.03)}',
      '.agl-icon{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:transparent;color:inherit;cursor:pointer;font-size:13px}',
      '.agl-icon:hover{background:rgba(255,255,255,.08)}',
      '.agl-input{background:rgba(255,255,255,.05);color:inherit;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:4px 10px;font-size:12px;min-width:180px;outline:none}',
      '.agl-btn{background:#21262d;border:1px solid rgba(255,255,255,.15);color:#e6edf3;border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer}',
      '.agl-btn:hover{border-color:rgba(255,255,255,.3)}',
      '.agl-fine{color:#8b949e;font-size:11px}',
      '.agl-route{display:flex;gap:8px;align-items:center;margin:4px 0}',
      '.agl-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid rgba(255,255,255,.08);overflow-x:auto;white-space:nowrap;flex-shrink:0}',
      '.agl-tab{background:transparent;border:0;border-bottom:2px solid transparent;color:#8b949e;padding:8px 12px;cursor:pointer;font-size:13px;white-space:nowrap}',
      '.agl-tab.on{color:var(--dsw-alias-label-primary,#e6edf3);border-bottom-color:#58a6ff}',
      '.agl-badge{display:inline-block;margin-left:5px;padding:0 6px;border-radius:999px;font-size:11px;background:rgba(210,153,34,.18);color:#d29922}',
      '.agl-page{flex:1;min-height:0;overflow:auto;padding:12px 16px}',
      '.agl-build{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.agl-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);gap:12px}',
      '@media(max-width:900px){.agl-grid2{grid-template-columns:1fr}}',
      '.agl-card{border:1px solid rgba(255,255,255,.1);border-left:3px solid #d29922;border-radius:8px;padding:8px 10px;margin-bottom:8px;background:rgba(255,255,255,.02)}',
      '.agl-card.bad{border-left-color:#f85149}',
      '.agl-card.ok{border-left-color:#3fb950}',
      '.agl-tag{display:inline-flex;align-items:center;padding:0 6px;border-radius:6px;border:1px solid rgba(255,255,255,.14);font-size:11px;color:#8b949e;white-space:nowrap}',
      '.agl-box{border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;margin-bottom:12px;background:rgba(255,255,255,.02);min-width:0;overflow-x:auto}',
      '.agl-box h4{margin:0 0 8px;font-size:11px;letter-spacing:.06em;color:#8b949e;font-weight:600}',
      '.agl-btn:disabled,.agl-icon:disabled{opacity:.45;cursor:default}',
    ].join('\n')

    if (typeof document !== 'undefined' && document.head) {
      try {
        const tagId = 'dsh-agentline/cockpit.css'
        if (!document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']')) {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-agentline'
          tag.dataset.pluginCss = tagId
          tag.textContent = css
          document.head.appendChild(tag)
        }
      } catch { /* never break the shell */ }
    }

    const j = async (url) => { try { return await fetch(url, { cache: 'no-store' }).then((r) => r.json()) } catch { return null } }
    const pct = (v) => (v == null ? '—' : Math.round(v) + '%')
    const money = (v) => (v == null ? '—' : '¥' + (Math.round(v * 100) / 100).toFixed(2))
    const num = (v) => (v == null ? '—' : Number(v).toLocaleString('zh-CN'))
    const compact = (v) => { if (v == null) return '—'; const n = Number(v); if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k'; return String(n) }
    // 用量配色：绿=充裕，黄=注意，红=告警
    const COLORS = { ok: '#3fb950', warn: '#d29922', bad: '#f85149' }
    const pctColor = (v) => (v == null ? COLORS.ok : (v >= 90 ? COLORS.bad : v >= 70 ? COLORS.warn : COLORS.ok))
    const creditColor = (v) => (v == null ? COLORS.ok : (v < 100 ? COLORS.bad : v < 500 ? COLORS.warn : COLORS.ok))
    const moneyColor = (v) => (v == null ? COLORS.ok : (v < 50 ? COLORS.bad : v < 200 ? COLORS.warn : COLORS.ok))
    const when = (iso) =>  { if (!iso) return '—'; try { return new Date(iso).toLocaleString('zh-CN') } catch { return iso } }

    const STATUS_COLOR = {
      draft: '#8b949e', designed: '#58a6ff', implemented: '#58a6ff', reviewable: '#d29922',
      reviewed: '#3fb950', pr_open: '#a371f7', merged: '#3fb950', blocked: '#f85149',
    }
    const STAGES = ['draft', 'designed', 'implemented', 'reviewable', 'reviewed', 'pr_open', 'merged']
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
    const STAGE_TEXT = { not_started: '未开始', idle: '空闲' }
    const SOURCE_TEXT = { blueprint: 'Blueprint', adhoc: '独立' }

    function stageClass(stage, current) {
      const c = STAGES.indexOf(current)
      if (c < 0) return ''
      const i = STAGES.indexOf(stage)
      if (i < c) return 'done'
      if (i === c) return 'now'
      return ''
    }

    function SidebarIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M4 6h16M4 12h9M4 18h6' }),
        h('circle', { cx: 18, cy: 16, r: 3 }),
      )
    }

    // ── AgentLine 插件设置：路径、Node、默认仓库、额度凭据 ──
    const SETTING_TEXT = [
      ['agentlineHome', 'AgentLine 目录', 'C:/git/dsh-Agentline/orchestrator', false],
      ['nodePath', 'Node 可执行文件', '留空使用当前 DSH 的 Node', false],
      ['defaultRepo', '默认仓库', '留空使用当前工作区', false],
    ]
    const SETTING_SECRET = [
      ['deepseekApiKey', 'DeepSeek API Key（余额查询）'],
      ['claudeAccessToken', 'Claude OAuth access token（可选）'],
      ['codexAccessToken', 'Codex access token（可选）'],
      ['buddyAccessToken', 'Buddy access token（可选）'],
    ]
    const SETTING_PLAIN = [
      ['codexAccountId', 'Codex account id'],
      ['buddyUserId', 'Buddy user id'],
    ]

    function SettingRow({ label, children, hint }) {
      return h('label', { className: 'agl-route', style: { flexDirection: 'column', alignItems: 'stretch', gap: '4px', margin: '10px 0' } },
        h('span', { style: { fontWeight: 600 } }, label),
        children,
        hint ? h('span', { className: 'agl-fine' }, hint) : null,
      )
    }

    function SettingsPage(props) {
      const { useSettings, update } = props
      const settings = useSettings((s) => s) || {}
      const [saving, setSaving] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const setField = (field, value) => {
        setSaving(true)
        setMsg('')
        Promise.resolve(update({ field, value })).then(() => setMsg('已保存')).catch((e) => setMsg('保存失败：' + (e && e.message ? e.message : String(e)))).finally(() => setSaving(false))
      }
      const text = ([field, label, placeholder]) => h(SettingRow, { key: field, label, hint: field === 'agentlineHome' ? '包含 agentline.mjs 的目录；默认公开仓库 orchestrator。' : null },
        h('input', {
          className: 'agl-input',
          style: { minWidth: '100%' },
          value: settings[field] || '',
          placeholder,
          disabled: saving,
          onChange: (e) => setField(field, e.target.value),
        }),
      )
      const secret = ([field, label]) => h(SettingRow, {
        key: field, label,
        hint: '凭据保存在当前 DSH profile 的插件设置中，不写入仓库；已设置时留空保持不变。',
      },
        h('input', {
          className: 'agl-input',
          style: { minWidth: '100%' },
          type: 'password',
          autoComplete: 'new-password',
          placeholder: settings[field] ? '已设置（留空保持不变）' : '未设置',
          disabled: saving,
          onBlur: (e) => { const v = e.target.value; if (v) { setField(field, v); e.target.value = '' } },
        }),
      )
      const plain = ([field, label]) => h(SettingRow, { key: field, label },
        h('input', {
          className: 'agl-input',
          style: { minWidth: '100%' },
          value: settings[field] || '',
          disabled: saving,
          onChange: (e) => setField(field, e.target.value),
        }),
      )
      return h('section', { style: { maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('h3', { style: { margin: '0 0 4px' } }, 'AgentLine'),
        h('p', { className: 'agl-fine', style: { margin: '0 0 8px' } }, '驾驶舱、任务路由与额度采集的运行时设置。凭据只保存在本机 profile。'),
        SETTING_TEXT.map(text),
        h(SettingRow, { label: '额度用量' },
          h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('input', {
              type: 'checkbox',
              checked: settings.metricsEnabled !== false,
              disabled: saving,
              onChange: (e) => setField('metricsEnabled', e.target.checked),
            }),
            h('span', { className: 'agl-fine' }, '在驾驶舱顶部显示 Claude / Codex / Buddy / DeepSeek 用量'),
          ),
        ),
        h('h4', { style: { margin: '12px 0 0' } }, '额度凭据'),
        h('p', { className: 'agl-fine', style: { margin: '0' } }, '留空则回退到本机 CLI 登录快照；只有填写时才覆盖。'),
        SETTING_SECRET.map(secret),
        SETTING_PLAIN.map(plain),
        msg ? h('div', { className: 'agl-fine', style: { color: msg.startsWith('保存失败') ? '#f85149' : '#3fb950' } }, msg) : null,
      )
    }

    function SettingsSection(props) {
      if (props.view === 'summary') return 'AgentLine 运行时路径、默认仓库与额度凭据'
      return h(SettingsPage, props)
    }

    function Cockpit() {
      const [tasks, setTasks] = React.useState([])
      const [tokens, setTokens] = React.useState(null)
      const [metrics, setMetrics] = React.useState(null)
      const [current, setCurrent] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [logFile, setLogFile] = React.useState(null)
      const [logMode, setLogMode] = React.useState('readable')
      const [injectText, setInjectText] = React.useState('')
      const [injectKind, setInjectKind] = React.useState('note')
      const [answerText, setAnswerText] = React.useState('')
      const [mergeAsk, setMergeAsk] = React.useState(false)
      const [merging, setMerging] = React.useState(false)
      const [mergeMsg, setMergeMsg] = React.useState('')
      const [err, setErr] = React.useState(null)
      const [projects, setProjects] = React.useState([])
      const [live, setLive] = React.useState([])
      const [pendingFocus, setPendingFocus] = React.useState(null)
      const [project, setProject] = React.useState(null)
      const [routing, setRouting] = React.useState(null)
      const [tab, setTab] = React.useState(() => { try { const v = window.localStorage.getItem('agentline.tab'); return TAB_IDS.includes(v) ? v : 'home' } catch { return 'home' } })
      const [summary, setSummary] = React.useState(null)
      const [notices, setNotices] = React.useState(null)
      const [pipeline, setPipeline] = React.useState(null)
      const [catalog, setCatalog] = React.useState(null)
      const [showAllEvents, setShowAllEvents] = React.useState(false)
      const [routeMsg, setRouteMsg] = React.useState('')
      const [sourceErrors, setSourceErrors] = React.useState({})
      const [projectsReady, setProjectsReady] = React.useState(false)
      const [liveReady, setLiveReady] = React.useState(false)
      const [listReady, setListReady] = React.useState(false)
      const [detailError, setDetailError] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [draft, setDraft] = React.useState({})
      const [modelsData, setModelsData] = React.useState(null)
      const [matrix, setMatrix] = React.useState({ design: [], dev: [], review: [] })
      const [matrixMsg, setMatrixMsg] = React.useState('')

      // 访问代次区分 A → B → A；任务代次同时隔离同项目内的切换和写操作反馈。
      const view = React.useRef({ alive: true, epoch: 0, taskEpoch: 0 })
      const requests = React.useRef({})
      const loaded = React.useRef({ routing: false, pipeline: false, list: false })
      Object.assign(view.current, { project, task: current, mode: logMode })
      const begin = (key) => { const n = (requests.current[key] || 0) + 1; requests.current[key] = n; return n }
      const scope = () => ({ ...view.current })
      const valid = (s, task = false) => view.current.alive && s.epoch === view.current.epoch && s.project === view.current.project &&
        (!task || (s.taskEpoch === view.current.taskEpoch && s.task === view.current.task))
      const latest = (key, n, s, task = false) => requests.current[key] === n && valid(s, task)
      const sourceError = (key, message) => setSourceErrors((e) => ({ ...e, [key]: message }))
      const failure = (r) => (r && r.error) || '读取失败（网络、响应格式或宿主路由不可用）'
      const clearTask = () => {
        view.current.taskEpoch++
        setDetail(null); setDetailError(''); setLogFile(null); setLogMode('readable')
        view.current.mode = 'readable'
        setInjectText(''); setInjectKind('note'); setAnswerText('')
        setMergeAsk(false); setMerging(false); setMergeMsg('')
      }
      const selectTask = (id) => {
        if (id === view.current.task) return
        clearTask()
        view.current.task = id
        setCurrent(id)
      }
      const switchProject = (p) => {
        if (p === view.current.project) return
        view.current.epoch++
        view.current.project = p
        clearTask()
        view.current.task = null
        setProject(p); setCurrent(null); setTasks([]); setTokens(null); setListReady(false)
        setPipeline(null); setRouting(null); setDraft({}); setRouteMsg(''); setSaving(false)
        setPendingFocus(null); setErr(null)
        setSourceErrors((e) => ({ ...e, routing: '' }))
        loaded.current.routing = false
        loaded.current.pipeline = false
        loaded.current.list = false
      }
      const openTask = (projectPath, taskId) => {
        setTab('build')
        if (projectPath && projectPath !== project) {
          switchProject(projectPath)
          setPendingFocus({ project: projectPath, task: taskId })
        } else selectTask(taskId)
      }
      const projTitle = (p) => { const x = projects.find((y) => y.path === p); return x ? x.title : (p ? String(p).split(/[\\/]/).pop() : '—') }
      const srcOf = (id) => { const t = pipeline && pipeline.ok ? ((pipeline.summary && pipeline.summary.tasks) || []).find((x) => x.id === id) : null; return t ? t.source : null }
      const taskReady = !!(listReady && tasks.some((t) => t.id === current) && detail && detail.task === current && project && !detailError)

      const doMerge = async (mode = 'permission') => {
        if (!taskReady || project !== view.current.project || current !== view.current.task || merging || (mode === 'permission' && !mergeAsk) || (mode === 'grant' && detail.state?.merge_risk?.tier !== 'low')) return
        const s = scope()
        setMerging(true)
        setMergeMsg('')
        try {
          const payload = mode === 'grant'
            ? { grant: true }
            : mode === 'check'
              ? { check: true }
              : { permission: '允许合并（驾驶舱点击确认 ' + new Date().toLocaleString('zh-CN') + '）' }
          const resp = await fetch('/agentline/merge?task=' + encodeURIComponent(detail.task) + '&project=' + encodeURIComponent(project), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => null)
          if (!valid(s, true)) return
          if (!resp) { setMergeMsg('合并失败：请求发不出去'); return }
          if (resp.status === 404) {
            setMergeMsg('合并失败：插件宿主还是旧版本（缺 /agentline/merge），请重启 DSH 再试')
            return
          }
          const res = await resp.json().catch(() => null)
          if (!valid(s, true)) return
          if (res && res.ok) {
            if (mode === 'check') setMergeMsg((res.output || '').trim() || '分档检查完成')
            else {
              setMergeMsg('已合并')
              setMergeAsk(false)
            }
            loadList(project)
            loadDetail(detail.task, project)
          } else {
            setMergeMsg((mode === 'check' ? '分档检查失败：' : '合并失败：') + ((res && (res.error || (res.output || '').split('\n').slice(-3).join(' '))) || 'unknown'))
          }
        } finally { if (valid(s, true)) setMerging(false) }
      }

      const control = async (action, text, kind) => {
        if (!taskReady || project !== view.current.project || current !== view.current.task) return
        const s = scope()
        const q = '/agentline/control?action=' + action + '&task=' + encodeURIComponent(detail.task) + '&project=' + encodeURIComponent(project)
        if (action === 'inject') {
          if (!text || !text.trim()) return
          await fetch(q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, kind: kind || injectKind }) }).then((r) => r.json()).catch(() => null)
          if (!valid(s, true)) return
          setInjectText('')
        } else if (action === 'answer') {
          if (!text || !text.trim()) return
          await fetch(q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).then((r) => r.json()).catch(() => null)
          if (!valid(s, true)) return
          setAnswerText('')
        } else {
          await j(q)
        }
        if (!valid(s, true)) return
        loadList(project)
        loadDetail(detail.task, project)
      }

      const resumeFlow = async (task) => {
        if (!taskReady || project !== view.current.project || current !== view.current.task || task !== current) return
        const s = scope()
        const q = '/agentline/flow?task=' + encodeURIComponent(task) + '&project=' + encodeURIComponent(project) + '&resume=1'
        await j(q)
        if (!valid(s, true)) return
        loadList(project)
        loadDetail(task, project)
      }

      const loadModels = async () => {
        const n = begin('models')
        const r = await j('/agentline/models')
        if (!view.current.alive || requests.current.models !== n) return
        sourceError('models', r && r.ok ? '' : failure(r))
        if (!r || !r.ok) { setModelsData(null); return }
        setModelsData(r)
        setMatrix({ design: (r.roles && r.roles.design) || [], dev: (r.roles && r.roles.dev) || [], review: (r.roles && r.roles.review) || [] })
      }

      const toggleRole = (role, key) => setMatrix((m) => {
        const cur = new Set(m[role] || [])
        if (cur.has(key)) cur.delete(key)
        else cur.add(key)
        setMatrixMsg('')
        return { ...m, [role]: [...cur] }
      })

      const saveModels = async () => {
        if (!modelsData) return
        const n = begin('models')
        const res = await fetch('/agentline/models', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ roles: matrix }),
        }).then((r) => r.json()).catch(() => null)
        if (!view.current.alive || requests.current.models !== n) return
        if (res && res.ok) {
          setModelsData(res)
          setMatrixMsg('已保存（下一个 flow 生效）')
        } else {
          setMatrixMsg('保存失败：' + ((res && res.error) || 'unknown'))
        }
      }

      const loadRouting = async (proj) => {
        if (!proj || proj !== view.current.project) return
        const s = scope(), n = begin('routing')
        const r = await j('/agentline/routing?project=' + encodeURIComponent(proj))
        if (!latest('routing', n, s)) return
        sourceError('routing', r && r.ok ? '' : failure(r))
        if (!r || !r.ok) { loaded.current.routing = false; setRouting(null); setDraft({}); return }
        loaded.current.routing = true
        setRouting(r)
        const d = {}
        for (const role of ['design', 'dev', 'review']) {
          const eff = (r.roles && r.roles[role]) || {}
          d[role] = { model: eff.model || '', policy: eff.policy || 'quality' }
        }
        setDraft(d)
      }

      const saveRouting = async () => {
        if (!project || project !== view.current.project || !routing || saving) return
        const s = scope(), n = begin('routing')
        setSaving(true)
        setRouteMsg('')
        try {
          const res = await fetch('/agentline/routing?project=' + encodeURIComponent(project), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ routing: draft }),
          }).then((x) => x.json()).catch(() => null)
          if (!latest('routing', n, s)) return
          if (res && res.ok) { setRouting(res); setRouteMsg('已保存（下一次 flow 生效）') }
          else setRouteMsg('保存失败：' + ((res && res.error) || 'unknown'))
        } finally { if (valid(s)) setSaving(false) }
      }

      const loadProjects = async () => {
        const s = scope(), n = begin('projects')
        const p = await j('/agentline/projects')
        if (!view.current.alive || requests.current.projects !== n) return
        sourceError('projects', p && p.ok ? '' : failure(p))
        if (!p || !p.ok) {
          const msg = failure(p)
          sourceError('projects', msg)
          setProjectsReady(false)
          if (valid(s)) {
            sourceError('pipeline', '项目读取失败：' + msg)
            if (!loaded.current.routing) sourceError('routing', '项目读取失败：' + msg)
            setPipeline({ ok: false, error: '项目读取失败：' + msg })
            loaded.current.pipeline = false
          }
          return
        }
        sourceError('projects', '')
        if (valid(s)) sourceError('pipeline', '')
        const list = p.projects || []
        setProjects(list)
        setProjectsReady(true)
        if (valid(s)) {
          let saved = null
          let focus = null
          let focusTaskId = null
          try {
            saved = window.localStorage.getItem('agentline.lastProject')
            focus = window.localStorage.getItem('agentline.focusProject')
            focusTaskId = window.localStorage.getItem('agentline.focusTask')
            window.localStorage.removeItem('agentline.focusProject')
            window.localStorage.removeItem('agentline.focusTask')
          } catch { /* ignore */ }
          const wanted = focus || saved
          const exists = wanted && list.some((x) => x.path === wanted)
          const target = focus && exists ? focus : (view.current.project || (exists ? wanted : (p.default || (list[0] && list[0].path) || null)))
          if (target !== view.current.project) switchProject(target)
          else if (target) {
            if (!loaded.current.routing) loadRouting(target)
            if (!loaded.current.pipeline) loadPipeline(target)
            if (!loaded.current.list) loadList(target)
          }
          if (focusTaskId) { setPendingFocus({ project: target, task: focusTaskId }); setTab('build') }
        }
      }

      const loadList = async (proj) => {
        if (!proj || proj !== view.current.project) return
        const s = scope(), n = begin('list')
        const q = proj ? '?project=' + encodeURIComponent(proj) : ''
        const [t, m] = await Promise.all([j('/agentline/tasks' + q), j('/agentline/metrics')])
        if (!latest('list', n, s)) return
        if (!t || !t.ok) { loaded.current.list = false; setErr((t && t.error) || '无法读取任务列表'); setListReady(false); return }
        loaded.current.list = true
        setErr(null)
        setListReady(true)
        setTasks(t.tasks || [])
        setTokens(t.tokens || null)
        setMetrics(m)
      }

      const loadDetail = async (task, proj, mode) => {
        if (!task || proj !== view.current.project || task !== view.current.task) return
        const s = scope(), n = begin('detail')
        const requestedMode = mode || logMode
        if (requestedMode !== view.current.mode) return
        const readable = (mode || logMode) !== 'raw'
        const q = '?task=' + encodeURIComponent(task) +
          '&tail=200' +
          (proj ? '&project=' + encodeURIComponent(proj) : '') +
          (readable ? '&render=1' : '')
        const d = await j('/agentline/task' + q)
        if (!latest('detail', n, s, true) || requestedMode !== view.current.mode) return
        if (!d || !d.ok || d.task !== task) { setDetail(null); setDetailError(failure(d)); return }
        setDetailError('')
        setDetail(d)
        setLogFile((prev) => {
          const files = (d.logs || []).map((x) => x.file)
          if (prev && files.includes(prev)) return prev
          return files[0] || null
        })
      }

      const loadPipeline = async (proj) => {
        if (!proj || proj !== view.current.project) return
        const s = scope(), n = begin('pipeline')
        const r = await j('/agentline/pipeline?project=' + encodeURIComponent(proj))
        if (!latest('pipeline', n, s)) return
        setPipeline(r && r.ok && r.summary ? { ok: true, summary: r.summary } :
          { ok: false, error: (r && r.error) || '读取失败（宿主可能未提供 /agentline/pipeline）' })
        loaded.current.pipeline = !!(r && r.ok && r.summary)
      }
      const loadCatalog = async () => {
        const n = begin('catalog')
        const r = await j('/agentline/catalog')
        if (!view.current.alive || requests.current.catalog !== n) return
        setCatalog(r && r.ok && r.catalog ? { ok: true, catalog: r.catalog, discovery: r.discovery } : { ok: false, error: failure(r) })
      }
      const loadSummary = async () => {
        const n = begin('summary'), r = await j('/agentline/summary')
        if (!view.current.alive || requests.current.summary !== n) return
        sourceError('summary', r && r.ok ? '' : failure(r))
        setSummary(r && r.ok ? { running: r.running || [], prOpen: r.prOpen || [], blocked: r.blocked || [] } : null)
      }
      const loadNotices = async () => {
        const n = begin('notices'), r = await j('/agentline/notices')
        if (!view.current.alive || requests.current.notices !== n) return
        sourceError('notices', r && r.ok ? '' : failure(r))
        setNotices(r && r.ok ? r.notices || [] : null)
      }
      const loadLive = async () => {
        const n = begin('live'), r = await j('/agentline/live')
        if (!view.current.alive || requests.current.live !== n) return
        sourceError('live', r && r.ok ? '' : failure(r))
        setLiveReady(!!(r && r.ok))
        setLive(r && r.ok ? r.running || [] : [])
      }
      const refresh = () => {
        loadProjects(); loadLive()
        if (tab === 'settings') { loadRouting(project); loadModels(); loadCatalog() }
        else { loadSummary(); loadNotices(); loadPipeline(project); loadList(project); loadDetail(current, project) }
      }

      React.useEffect(() => {
        view.current.alive = true
        loadProjects()
        loadLive(); loadSummary(); loadNotices()
        const timers = [[loadLive, 3000], [loadSummary, 5000], [loadNotices, 10000], [loadProjects, 10000]].map(([f, ms]) => window.setInterval(f, ms))
        return () => { view.current.alive = false; view.current.epoch++; Object.keys(requests.current).forEach(begin); timers.forEach((it) => window.clearInterval(it)) }
      }, [])

      React.useEffect(() => { try { window.localStorage.setItem('agentline.tab', tab) } catch { /* ignore */ } }, [tab])

      React.useEffect(() => {
        if (tab === 'settings') { loadRouting(project); loadModels(); loadCatalog() }
      }, [tab, project])

      React.useEffect(() => {
        if (!project) return
        try { window.localStorage.setItem('agentline.lastProject', project) } catch { /* ignore */ }
        loadList(project)
        loadPipeline(project)
        const it = window.setInterval(() => loadList(project), 5000)
        const pit = window.setInterval(() => loadPipeline(project), 15000)
        return () => { begin('list'); begin('pipeline'); begin('routing'); window.clearInterval(it); window.clearInterval(pit) }
      }, [project])

      React.useEffect(() => {
        if (!current || !project) return
        loadDetail(current, project)
        const it = window.setInterval(() => loadDetail(current, project), 5000)
        return () => { begin('detail'); window.clearInterval(it) }
      }, [current, project, logMode])

      React.useEffect(() => {
        if (pendingFocus && pendingFocus.task && (!pendingFocus.project || pendingFocus.project === project) && tasks.some((t) => t.id === pendingFocus.task)) {
          selectTask(pendingFocus.task)
          setPendingFocus(null)
          return
        }
        if (!current && tasks.length) selectTask(tasks[tasks.length - 1].id)
      }, [tasks, pendingFocus])

      const recs = (metrics && metrics.records) || []
      const pick = (src, key) => recs.find((x) => x.source === src && x.key === key) || { value: null }

      const logLines = (() => {
        if (!detail || !logFile) return []
        const f = (detail.logs || []).find((x) => x.file === logFile)
        return f ? f.lines || [] : []
      })()

      const table = (headers, rows) => h('table', { className: 'agl-t' },
        h('thead', null, h('tr', null, headers.map((v) => h('th', { key: v }, v)))),
        h('tbody', null, rows))
      const box = (title, ...children) => h('section', { className: 'agl-box' }, h('h4', null, title), ...children)
      const fine = (text) => h('div', { className: 'agl-fine' }, text)
      const label = (it) => (it.project || projTitle(it.projectPath)) + ' #' + it.task
      const runningText = (it) => label(it) + ' · ' + it.role + (it.round ? ' r' + it.round : '') + ' · ' +
        (it.modelId || it.model || '—') + ' · ' + (it.backend || '—') + ' · ' + Math.round((it.age_s || 0) / 60) + 'm'
      const pending = summary ? summary.blocked.length + summary.prOpen.length : 0

      const renderHome = () => {
        const blocked = summary ? summary.blocked : []
        const prOpen = summary ? summary.prOpen : []
        const human = blocked.filter((it) => it.reason === 'awaiting_human')
        const other = blocked.filter((it) => it.reason !== 'awaiting_human')
        const focus = human[0] || other[0] || prOpen[0] || live[0]
        const focusText = human.length ? '⏸ ' + label(focus) + ' designer 等待回答' :
          other.length ? '⛔ ' + label(focus) + ' 阻塞：' + focus.reason :
          prOpen.length ? '✅ ' + label(focus) + ' 评审通过，等待合并许可' :
          focus ? '▶ ' + label(focus) + ' ' + focus.role + ' · ' + (focus.modelId || focus.model || '—') + ' · ' + Math.round((focus.age_s || 0) / 60) + 'm' :
            sourceErrors.live || (liveReady ? '没有需要你处理的事项。' : '读取中…')
        const cards = [
          ...other.map((it) => ({ it, tag: '阻塞', style: ' bad', text: '原因：' + it.reason, button: '查看任务' })),
          ...human.map((it) => ({ it, tag: '问题', style: '', text: 'designer 等待回答；在 Build 详情中回答后 flow 会继续', button: '去回答' })),
          ...prOpen.map((it) => ({ it, tag: '可批准', style: ' ok', text: '评审通过，等待人类合并许可', button: '去合并' })),
        ]
        const summaryStatus = sourceErrors.summary || '读取中…'
        return h('div', { className: 'agl-grid2' },
          h('div', null,
            box('现在卡在哪', summary === null ? fine(summaryStatus) : h('div', { className: 'agl-route' },
              h('span', { style: { flex: 1 } }, focusText),
              focus ? h('button', { className: 'agl-btn', onClick: () => openTask(focus.projectPath, focus.task) }, '打开') : null)),
            box('项目组合' + (projectsReady || projects.length ? ' (' + projects.length + ')' : ''),
              sourceErrors.projects ? fine(sourceErrors.projects) : projects.length ? table(['项目', '任务', '进行中', '最近状态', '待处理', '运行中'], projects.map((p) => h('tr', {
                key: p.path, title: p.path, tabIndex: 0, style: { cursor: 'pointer' },
                onClick: () => switchProject(p.path), onKeyDown: (e) => { if (e.key === 'Enter') switchProject(p.path) },
              },
                h('td', null, p.title, p.path === project ? h('span', { className: 'agl-tag' }, '当前') : null),
                h('td', null, p.tasks ? p.tasks.total : '—'), h('td', null, p.tasks ? p.tasks.active : '—'),
                h('td', null, (p.tasks && p.tasks.last) || '—'),
                h('td', null, summary === null ? '—' : blocked.concat(prOpen).filter((it) => it.projectPath === p.path).length),
                h('td', null, liveReady ? live.filter((it) => it.projectPath === p.path).length : '—'),
              ))) : fine(projectsReady ? '没有已登记的项目（在某个工作区用 /agentline 派活后会自动登记）' : '读取中…')),
            box('待处理' + (summary ? ' (' + pending + ')' : ''), summary === null ? fine(summaryStatus) :
              cards.length ? cards.map(({ it, tag, style, text, button }, i) => h('div', { key: i, className: 'agl-card' + style },
                h('div', { className: 'agl-route' }, h('span', { className: 'agl-tag' }, tag), h('b', null, label(it))),
                fine(text), h('button', { className: 'agl-btn', onClick: () => openTask(it.projectPath, it.task) }, button))) : fine('没有需要你处理的事项。')),
            box('运行中' + (liveReady || live.length ? ' (' + live.length + ')' : ''), sourceErrors.live ? fine(sourceErrors.live) :
              live.length ? live.map((it, i) => h('div', { key: i, className: 'agl-item', onClick: () => openTask(it.projectPath, it.task) }, runningText(it))) :
                fine(liveReady ? '当前没有运行中的任务' : '读取中…')),
            box('最近事件', notices === null ? fine(sourceErrors.notices || '读取中…') : notices.length ? h(React.Fragment, null,
              (showAllEvents ? notices : notices.slice(0, 6)).map((it, i) => h('div', { key: i, className: 'agl-item', onClick: () => openTask(it.projectPath, it.task) },
                when(it.at) + ' · ' + label(it) + ' · ' + ({ pr_open: '评审通过', merged: '已合并', blocked: '阻塞' }[it.event] || it.event) + (it.reason ? '：' + it.reason : ''))),
              notices.length > 6 ? h('button', { className: 'agl-btn', onClick: () => setShowAllEvents(!showAllEvents) }, showAllEvents ? '收起' : '展开全部') : null) : fine('暂无事件')),
          ),
          h('div', null, box('斜杠命令', SLASH_COMMANDS.map((it) => h('div', { key: it.cmd, style: { marginBottom: '12px', opacity: it.ok ? 1 : .55 } },
            h('code', null, it.cmd), ' ', it.ok ? h('button', { className: 'agl-btn', onClick: async () => {
              try { await navigator.clipboard.writeText(it.cmd) } catch { /* ignore */ }
            } }, '复制') : h('span', { className: 'agl-tag' }, '未实现'), fine(it.desc))),
          fine('LLM 工具：agentline_status · agentline_flow · agentline_metrics'))),
        )
      }

      const renderStage = (kind, title) => {
        let content
        if (pipeline === null) content = fine('读取中…')
        else if (!pipeline.ok) content = fine('无法读取 ' + title + ' 数据：' + pipeline.error)
        else {
          const stage = pipeline.summary?.stages?.[kind]
          if (!stage || !Array.isArray(stage.sessions)) content = fine('无法读取 ' + title + ' 数据：阶段摘要格式无效')
          else if (!stage.sessions.length) content = h(React.Fragment, null,
            fine(kind === 'studio' ? '这个项目还没有 Studio 记录（.collab/studio 下没有会话）。' : '这个项目还没有 Blueprint 记录（.collab/blueprint 下没有会话）。'),
            fine(kind === 'studio' ? 'Studio 状态机尚未接入驾驶舱；这里只读展示已有数据，不推断状态。' : '状态：未开始'))
          else content = h(React.Fragment, null, fine('状态：' + (STAGE_TEXT[stage.status] || stage.status)),
            table(['会话', '状态', '更新时间'], stage.sessions.map((s) => h('tr', { key: s.id }, h('td', null, s.id), h('td', null, s.status), h('td', null, when(s.updated_at))))),
            kind === 'studio' ? fine('轮次、问题、G0 等详情：未实现') : null)
        }
        return box(title + ' 会话', content, kind === 'blueprint' ? fine('G1：未实现') : null)
      }
      const renderStudio = () => renderStage('studio', 'Studio')
      const renderBlueprint = () => renderStage('blueprint', 'Blueprint')

      const renderCatalog = () => {
        const status = catalog === null ? '读取中…' : !catalog.ok ? '无法读取模型目录：' + catalog.error : null
        const models = catalog && catalog.ok ? catalog.catalog.models || [] : []
        const discovery = catalog && catalog.ok ? catalog.discovery : null
        const providers = [...new Set([...(discovery?.providers || []), ...models.map((m) => m.provider).filter(Boolean)])].sort()
        return h(React.Fragment, null,
          box('模型目录（只读）', status ? fine(status) : !models.length ? fine('暂无模型目录数据（运行 agentline models discover 或 agentline models add）') :
            table(['模型', 'Provider', 'id', '档位', '身份', '可用性', '来源'], models.map((m) => h('tr', { key: m.key },
              [m.key, m.provider || '—', m.id, m.tier, m.identity, m.availability, m.source].map((v, i) => h('td', { key: i }, v)))))),
          box('Provider（只读）', status ? fine(status) : h(React.Fragment, null,
            discovery?.generatedAt ? fine('发现缓存：' + when(discovery.generatedAt)) : null,
            providers.length ? table(['Provider', '模型数', 'callable', 'discovered'], providers.map((p) => {
              const ms = models.filter((m) => m.provider === p)
              return h('tr', { key: p }, h('td', null, p), h('td', null, ms.length),
                h('td', null, ms.filter((m) => m.availability === 'callable').length), h('td', null, ms.filter((m) => m.availability === 'discovered').length))
            })) : fine('暂无 Provider 数据'))),
        )
      }

      const renderTop = () => h('div', { className: 'agl-top' },
          h('span', { className: 'agl-title' }, 'AgentLine 驾驶舱'),
          live.length ? h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
            live.map((l, i) => h('span', {
              key: (l.projectPath || l.project) + '#' + l.task + i,
              className: 'agl-lamp',
              title: `${l.project} #${l.task} · ${l.role}${l.round ? ' r' + l.round : ''} · ${l.modelId || l.model} · ${l.backend} · 已跑 ${l.age_s}s`,
            },
              h('span', { className: 'agl-spin' }),
              `${l.project} #${l.task} ${l.role}·${String(l.modelId || l.model || '').replace('claude-', '').replace('gpt-', '')}`,
              h('span', { className: 'agl-fine', style: { marginLeft: '2px' } }, Math.round((l.age_s || 0) / 60) + 'm'),
            )),
          ) : h('span', { className: 'agl-fine' }, sourceErrors.live || (liveReady ? '空闲' : '读取中…')),
          h('span', { style: { width: '1px', height: '14px', background: 'rgba(255,255,255,.12)' } }),
          h('select', {
            value: project || '',
            title: '项目（DSH 工作区）',
            disabled: !projectsReady,
            onChange: (e) => switchProject(e.target.value),
          }, projects.length === 0
            ? h('option', { value: '' }, sourceErrors.projects ? '项目读取失败' : projectsReady ? '(无工作区)' : '读取中…')
            : projects.map((p) => h('option', { key: p.path, value: p.path }, p.title + (p.tasks && p.tasks.total ? ' · ' + p.tasks.total : '')))),
          h('span', { className: 'agl-metric' }, 'Claude 5h ', h('b', { style: { color: pctColor(pick('claude', 'claude.session').value), display: 'inline-block', minWidth: '38px', textAlign: 'right' } }, pct(pick('claude', 'claude.session').value))),
          h('span', { className: 'agl-metric' }, '7d ', h('b', { style: { color: pctColor(pick('claude', 'claude.weekly').value), display: 'inline-block', minWidth: '38px', textAlign: 'right' } }, pct(pick('claude', 'claude.weekly').value))),
          h('span', { className: 'agl-metric' }, 'Codex 周 ', h('b', { style: { color: pctColor(pick('codex', 'codex.weekly').value), display: 'inline-block', minWidth: '38px', textAlign: 'right' } }, pct(pick('codex', 'codex.weekly').value))),
          h('span', { className: 'agl-metric' }, 'Buddy ', h('b', { style: { color: creditColor(pick('buddy', 'buddy.remaining').value), display: 'inline-block', minWidth: '64px', textAlign: 'right' } }, num(pick('buddy', 'buddy.remaining').value))),
          h('span', { className: 'agl-metric' }, 'DeepSeek ', h('b', { style: { color: moneyColor(pick('deepseek', 'deepseek.balance').value), display: 'inline-block', minWidth: '74px', textAlign: 'right' } }, money(pick('deepseek', 'deepseek.balance').value))),
          h('span', { style: { flex: 1 } }),
          tokens ? h('span', {
            className: 'agl-tok',
            style: { minWidth: '190px', textAlign: 'right', display: 'inline-block' },
            title: '本项目（' + (project || '') + '）累计 token：输入 / 输出',
          }, '本项目 token ' + compact(tokens.total.input) + ' in · ' + compact(tokens.total.output) + ' out') : null,
          h('button', { className: 'agl-icon', title: '刷新：重新读取当前页数据', onClick: refresh }, '↻'),
          h('button', { className: 'agl-icon', title: '设置', onClick: () => setTab('settings') }, '⚙'),
        )

      const renderSettings = () => h(React.Fragment, null,
        h('div', { className: 'agl-box' },
          h('h4', null, '角色路由 · 仅影响本项目'),
          sourceErrors.routing ? h('div', { className: 'agl-fine' }, sourceErrors.routing) : !routing ? h('div', { className: 'agl-fine' }, '读取中…') : null,
          ['design', 'dev', 'review'].map((role) => h('div', { key: role, className: 'agl-route' },
            h('span', { className: 'agl-fine', style: { width: '60px' } }, role),
            h('select', {
              disabled: !routing || saving,
              value: (draft[role] && draft[role].model) || '',
              onChange: (e) => setDraft((d) => ({ ...d, [role]: { ...(d[role] || {}), model: e.target.value } })),
            }, ((routing && routing.models) || []).map((m) => h('option', { key: m.key, value: m.key }, m.key + ' · ' + m.backend))),
            h('select', {
              disabled: !routing || saving,
              value: (draft[role] && draft[role].policy) || 'quality',
              onChange: (e) => setDraft((d) => ({ ...d, [role]: { ...(d[role] || {}), policy: e.target.value } })),
            },
              h('option', { value: 'quality' }, '质量优先'),
              h('option', { value: 'speed' }, '速度优先')),
            h('span', { className: 'agl-fine' }, '当前顺序：' + (((routing && routing.roles && routing.roles[role] && routing.roles[role].order) || []).join(' > '))),
          )),
          h('div', { className: 'agl-route' },
            h('button', { className: 'agl-btn', onClick: saveRouting, disabled: saving || !routing || !project }, saving ? '保存中…' : '保存'),
            h('span', { className: 'agl-fine' }, routeMsg)),
          h('div', { className: 'agl-fine' }, '保存后下一次 flow 生效（写入 .collab/agentline.json）'),
        ),
        h('div', { className: 'agl-box' },
          h('h4', null, '全局：哪些模型可以在哪些角色上使用'),
          modelsData ? h('div', { style: { marginTop: '12px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,.1)' } },
            h('div', { className: 'agl-fine', style: { marginBottom: '6px' } },
              '这里只影响候选顺序（所有工作区通用）；每个工作区的首选模型在上一节设置。勾选 = 允许该角色使用。'),
            h('table', { className: 'agl-t' },
              h('thead', null, h('tr', null,
                h('th', null, 'model'), h('th', null, '渠道'), h('th', null, 'id'),
                ['design', 'dev', 'review'].map((r) => h('th', { key: r }, r)))),
              h('tbody', null, (modelsData.models || []).map((m) => h('tr', { key: m.key },
                h('td', null, m.key),
                h('td', { className: 'agl-fine' }, (m.backend || '—').replace('-cli', '')),
                h('td', { className: 'agl-fine' }, m.id),
                ['design', 'dev', 'review'].map((role) => h('td', { key: role },
                  h('input', {
                    type: 'checkbox',
                    checked: (matrix[role] || []).includes(m.key),
                    onChange: () => toggleRole(role, m.key),
                  }))),
              ))),
            ),
            h('div', { style: { marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' } },
              h('button', { className: 'agl-btn', onClick: saveModels }, '保存全局设置'),
              matrixMsg ? h('span', { className: 'agl-fine' }, matrixMsg) : null,
            ),
          ) : h('div', { className: 'agl-fine' }, sourceErrors.models || '读取中…'),
        ),
        renderCatalog(),
        h('div', { className: 'agl-fine' }, '路径、Node、默认仓库与额度凭据在 DSH「插件 → AgentLine」中设置。'),
      )

      const renderBuild = () => h('div', { className: 'agl-build' },
        h('div', { className: 'agl-body' },
          h('div', { className: 'agl-list' },
            tasks.length === 0
              ? h('div', { className: 'agl-fine', style: { padding: '10px' } }, sourceErrors.projects ? '项目读取失败：' + sourceErrors.projects : project && !listReady ? (err || '读取中…') : '暂无任务')
              : tasks.slice().reverse().map((t) => {
                  const st = (t.state && t.state.status) || '?'
                  return h('div', {
                    key: t.id,
                    className: 'agl-item' + (current === t.id ? ' on' : ''),
                    onClick: () => selectTask(t.id),
                  },
                    h('div', { className: 'r1' },
                      h('span', { className: 'id' }, '#', t.id),
                      h('span', { className: 'agl-fine' }, st),
                    ),
                    h('div', { className: 'meta' },
                      h('span', { className: 'agl-dot', style: { background: STATUS_COLOR[st] || '#8b949e' } }),
                      h('span', { className: 'agl-tag' }, projTitle(project)), ' ',
                      SOURCE_TEXT[srcOf(t.id)] ? h('span', { className: 'agl-tag' }, SOURCE_TEXT[srcOf(t.id)]) : null, ' ',
                      (t.state && t.state.model) || '—',
                      ' · ',
                      when(t.state && t.state.updated_at),
                    ),
                  )
                }),
          ),
          h('div', { className: 'agl-detail' },
            !detail
              ? h('div', { className: 'agl-empty' }, detailError || '选择一个任务查看详情')
              : h(React.Fragment, null,
                  h('div', { className: 'agl-sec' },
                    h('h4', null, '阶段轨迹 · task #' + detail.task),
                    h('div', { className: 'agl-stages' },
                      STAGES.map((s) => h('span', { key: s, className: 'agl-stage ' + stageClass(s, detail.state && detail.state.status) }, s)),
                      (detail.state && detail.state.status) === 'blocked' ? h('span', { className: 'agl-stage bad' }, 'blocked · ' + (detail.state.blocked_reason || '?')) : null,
                    ),
                    (detail.state && detail.state.blocked_reason === 'interrupted') ? h('div', { style: { marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' } },
                      h('span', { className: 'agl-stage bad' }, '中断'),
                      h('span', { className: 'agl-fine' }, '上次运行被终止，停在 ' + ((detail.state.interrupted && detail.state.interrupted.from) || '?') + '；继续会丢弃未提交改动'),
                      h('button', { className: 'agl-btn', disabled: !taskReady, onClick: () => resumeFlow(detail.task) }, '继续运行'),
                    ) : null,
                    (detail.state && detail.state.status === 'pr_open') ? h('div', {
                      style: {
                        marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
                        padding: '8px 10px', borderRadius: '10px', border: '1px solid rgba(63,185,80,.45)', background: 'rgba(63,185,80,.08)',
                      },
                    },
                      h('span', { style: { color: '#3fb950', fontWeight: 600 } }, '✅ 评审通过，等待人类许可'),
                      detail.state.merge_risk
                        ? h('span', { className: 'agl-fine', title: (detail.state.merge_risk.reasons || []).join('；') },
                            '档位：' + detail.state.merge_risk.tier
                            + (detail.state.merge_risk.tier === 'low' ? '（可用预授权）' : '（需逐个确认）'))
                        : null,
                      mergeAsk
                        ? h(React.Fragment, null,
                            h('span', { className: 'agl-fine' }, '确认把这个分支合进 main？'),
                            h('button', { className: 'agl-btn', disabled: merging || !taskReady, onClick: () => doMerge('permission'), style: { borderColor: 'rgba(63,185,80,.6)' } }, merging ? '合并中…' : '确认合并'),
                            h('button', { className: 'agl-btn', onClick: () => setMergeAsk(false) }, '取消'))
                        : h('button', { className: 'agl-btn', disabled: !taskReady, onClick: () => setMergeAsk(true), title: '合并需要人类确认：点击后还要再确认一次' }, '🔀 确认合并'),
                      detail.state.merge_risk?.tier === 'low'
                        ? h('button', { className: 'agl-btn', disabled: merging || !taskReady, onClick: () => doMerge('grant'), title: '仅低档：使用当前仓库内有效的预授权合并' }, '⚡ 预授权合并')
                        : null,
                      h('button', { className: 'agl-btn', disabled: merging || !taskReady, onClick: () => doMerge('check') }, '分档检查'),
                      mergeMsg ? h('span', { className: 'agl-fine' }, mergeMsg) : null,
                    ) : null,
                    (detail.stepLedger && detail.stepLedger.length) ? h('div', { className: 'agl-sec' },
                      h('h4', null, 'K1 step ledger'),
                      h('table', { className: 'agl-t' },
                        h('thead', null, h('tr', null,
                          h('th', null, 'time'), h('th', null, 'event'), h('th', null, 'step'),
                          h('th', null, 'status'), h('th', null, 'model'), h('th', null, 'reason'))),
                        h('tbody', null, detail.stepLedger.slice(-12).reverse().map((x, i) => h('tr', { key: i },
                          h('td', { className: 'agl-fine' }, String(x.at || '').slice(11, 19)),
                          h('td', null, x.event || '-'),
                          h('td', null, x.step || '-'),
                          h('td', { className: 'agl-fine' }, x.status || '-'),
                          h('td', { className: 'agl-fine' }, x.model || '-'),
                          h('td', { className: 'agl-fine' }, x.reason || ''))))),
                    ) : null,
                    h('div', { className: 'agl-ctl', style: { marginTop: '8px' } },
                      h('button', { className: 'agl-icon', disabled: !taskReady, title: '阶段末停止：当前阶段跑完后停下，不留半个阶段', onClick: () => control('stop') }, '⏸'),
                      h('button', { className: 'agl-icon', disabled: !taskReady, title: '立即终止：杀掉进程树，任务标记为已停止', onClick: () => control('stop-now') }, '⏹'),
                      h('select', {
                        className: 'agl-btn',
                        title: 'note：下一阶段提示；amendment：当前轮作废并回到 design',
                        value: injectKind,
                        onChange: (e) => setInjectKind(e.target.value),
                      },
                        h('option', { value: 'note' }, 'note'),
                        h('option', { value: 'amendment' }, 'amend'),
                      ),
                      h('input', {
                        className: 'agl-input',
                        title: injectKind === 'amendment' ? '规格修正：阶段末作废当前轮，下一次 flow 回到 design' : '实现提示：会在下一个阶段生效（正在跑的模型收不到）',
                        placeholder: injectKind === 'amendment' ? '规格修正…（阶段末生效）' : '插话…（下一阶段生效）',
                        value: injectText,
                        onChange: (e) => setInjectText(e.target.value),
                        onKeyDown: (e) => { if (e.key === 'Enter') control('inject', injectText, injectKind) },
                      }),
                      h('button', { className: 'agl-icon', title: '提交输入', disabled: !taskReady || !injectText.trim(), onClick: () => control('inject', injectText, injectKind) }, '⏎'),
                    ),
                    (detail.attention && detail.attention.question) ? h('div', {
                      style: { marginTop: '8px', padding: '8px 10px', borderRadius: '10px', border: '1px solid rgba(224,168,62,.45)', background: 'rgba(224,168,62,.08)' },
                    },
                      h('div', { style: { color: '#e0a83e', fontWeight: 600 } }, '⏸ designer 等待回答'),
                      h('div', { className: 'agl-fine', style: { margin: '4px 0' } }, detail.attention.question),
                      h('div', { className: 'agl-ctl' },
                        h('input', {
                          className: 'agl-input',
                          placeholder: '回答…（提交后 flow --resume 继续）',
                          value: answerText,
                          onChange: (e) => setAnswerText(e.target.value),
                          onKeyDown: (e) => { if (e.key === 'Enter') control('answer', answerText) },
                        }),
                        h('button', { className: 'agl-btn', disabled: !taskReady || !answerText.trim(), onClick: () => control('answer', answerText) }, '回答'),
                      ),
                    ) : null,
                    h('div', { className: 'agl-fine', style: { marginTop: '8px' } },
                      h('div', null, '项目：' + projTitle(project)),
                      h('div', null, '来源：' + (pipeline === null ? '读取中…' : !pipeline.ok ? '读取失败：' + pipeline.error : (SOURCE_TEXT[srcOf(detail.task)] || '旧任务：无来源记录'))),
                      (() => {
                        const run = (detail.runs || []).slice(-1)[0]
                        if (!run || !(run.model_requested || run.model_resolved || run.provider)) return null
                        const models = [run.model_requested, run.model_resolved].filter(Boolean).join(' → ')
                        return h('div', null, '模型：' + [models, run.provider].filter(Boolean).join(' · '))
                      })(),
                      h('div', null, 'T gate：未实现（核心尚未产出 T gate 记录）')),
                    detail.state ? h('div', { className: 'agl-fine', style: { marginTop: '8px' } },
                      'model ' + (detail.state.model || '—') + ' · effort ' + (detail.state.effort || '—') +
                      ' · switches ' + (detail.state.switches ?? 0) +
                      (detail.state.pr ? ' · pr ' + detail.state.pr.state + ' (' + String(detail.state.pr.sha || '').slice(0, 7) + ')' : '')) : null,
                  ),
                  h('div', { className: 'agl-sec', style: { maxHeight: '220px', overflow: 'auto' } },
                    h('h4', null, '执行记录 (' + (detail.runs || []).length + ')'),
                    h('div', { className: 'agl-fine', style: { marginBottom: '6px' } },
                      '同一阶段可能因换模型出现多行：role 后 #n 表示该阶段第 n 个候选模型。'
                      + ' 失败尝试若没等到模型返回 usage，token 显示 —（CLI 未上报）。'),
                    h('table', { className: 'agl-t' },
                      h('thead', null, h('tr', null,
                        h('th', null, 'role'), h('th', null, 'backend'), h('th', null, 'model'), h('th', null, 'effort'),
                        h('th', null, 'exit'), h('th', null, '耗时'), h('th', null, 'input'), h('th', null, 'output'))),
                      h('tbody', null,
                        (detail.runs || []).map((r, i) => h('tr', { key: i },
                          h('td', null, r.role + (r.round ? ' r' + r.round : '') + (r.candidate > 1 ? ' #' + r.candidate : '')),
                          h('td', { className: 'agl-fine' }, (r.backend || '—').replace('-cli', '')),
                          h('td', null, r.model_requested || '—'),
                          h('td', null, r.effort || '—'),
                          h('td', { title: r.error || '' }, r.exit && r.exit.code === 125 ? '中断' : String(r.exit && r.exit.code)),
                          h('td', null, Math.round((r.duration_ms || 0) / 1000) + 's'),
                          h('td', { className: 'num', title: r.usage ? '' : ('用量未上报（' + (r.error || r.usage_source || '') + '）') }, compact(r.usage && r.usage.input)),
                          h('td', { className: 'num', title: r.usage ? '' : ('用量未上报（' + (r.error || r.usage_source || '') + '）') }, compact(r.usage && r.usage.output)),
                        ))),
                    ),
                  ),
                  h('div', { className: 'agl-logs' },
                    h('div', { className: 'agl-logbar' },
                      h('h4', { style: { margin: 0 } }, '日志'),
                      h('select', { value: logFile || '', onChange: (e) => setLogFile(e.target.value) },
                        (detail.logs || []).map((l) => h('option', { key: l.file, value: l.file },
                          l.file + ' · ' + (l.kind || 'raw') + ' · ' + Math.round(l.size / 1024) + 'KB'))),
                      h('button', {
                        className: 'agl-btn',
                        onClick: () => {
                          const next = logMode === 'raw' ? 'readable' : 'raw'
                          begin('detail')
                          view.current.mode = next
                          setDetail(null); setMergeAsk(false)
                          setLogMode(next)
                        },
                      }, logMode === 'raw' ? '原始 JSON' : '可读视图'),
                      h('span', { className: 'agl-fine' }, '自动刷新 5s' + (logMode === 'raw' ? ' · 最后 200 行' : '')),
                    ),
                    h('pre', { className: 'agl-pre' }, logLines.join('\n') || '(空)'),
                  ),
                ),
          ),
        ),
      )

      return h('div', { className: 'agl-panel' },
        renderTop(),
        h('nav', { className: 'agl-tabs', 'aria-label': '驾驶舱页面' }, TABS.map(([id, title]) => h('button', {
          key: id, className: 'agl-tab' + (tab === id ? ' on' : ''), 'aria-current': tab === id ? 'page' : undefined, onClick: () => setTab(id),
        }, title, id === 'home' && pending > 0 ? h('span', { className: 'agl-badge' }, pending) : null))),
        err ? h('div', { className: 'agl-empty' }, err) : null,
        tab === 'build' ? renderBuild() : h('div', { className: 'agl-page' },
          tab === 'home' ? renderHome() : tab === 'studio' ? renderStudio() : tab === 'blueprint' ? renderBlueprint() : renderSettings()),
      )
    }

    class SafeBoundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError() { return { err: true } }
      componentDidCatch(e) { try { console.error('[agentline] ui error:', e) } catch { /* ignore */ } }
      render() { return this.state.err ? null : this.props.children }
    }
    const Safe = (C) => (props) => h(SafeBoundary, null, h(C, props))

    /** 从对话头部这里跳到驾驶舱：记住目标任务，再点一下左栏 AgentLine 入口 */
    function focusTask(project, task) {
      try {
        window.localStorage.setItem('agentline.focusProject', project || '')
        window.localStorage.setItem('agentline.focusTask', task || '')
      } catch { /* ignore */ }
      // 宿主没有暴露"切换主面板"的 API，这里用最朴素的方式点一下左栏入口
      try {
        const els = Array.from(document.querySelectorAll('[title],[aria-label]'))
        const hit = els.find((el) => /agentline/i.test(el.getAttribute('title') || el.getAttribute('aria-label') || ''))
        if (hit) hit.click()
      } catch { /* ignore */ }
    }

    // 顶部紧凑读数：只读展示，详细状态在驾驶舱里
    function HeaderChips() {
      const [recs, setRecs] = React.useState([])
      const [sum, setSum] = React.useState({ running: [], prOpen: [], blocked: [], records: [] })
      const [open, setOpen] = React.useState(false)
      const [toasts, setToasts] = React.useState([])
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          const r = await j('/agentline/summary')
          if (alive && r && r.ok) {
            setSum({ running: r.running || [], prOpen: r.prOpen || [], blocked: r.blocked || [], records: r.records || [] })
          }
        }
        tick()
        const it = window.setInterval(tick, 5000)
        return () => { alive = false; window.clearInterval(it) }
      }, [])

      // 任务结束通知：轮询 notice.json，新的就弹一条（并尝试系统通知）
      React.useEffect(() => {
        let alive = true
        const seen = (() => {
          try { return JSON.parse(window.localStorage.getItem('agentline.seenNotices') || '{}') } catch { return {} }
        })()
        const tick = async () => {
          const r = await j('/agentline/notices')
          if (!alive || !r || !r.ok) return
          const fresh = []
          for (const n of r.notices || []) {
            const key = n.projectPath + '#' + n.task
            if (seen[key] === n.at) continue
            seen[key] = n.at
            fresh.push(n)
          }
          if (fresh.length) {
            try { window.localStorage.setItem('agentline.seenNotices', JSON.stringify(seen)) } catch { /* ignore */ }
            setToasts((prev) => [...fresh.map((n) => ({ ...n, key: n.projectPath + '#' + n.task + n.at })), ...prev].slice(0, 4))
            try {
              if (window.Notification && window.Notification.permission === 'granted') {
                for (const n of fresh) {
                  const ok = n.event === 'pr_open' || n.event === 'merged'
                  new window.Notification(`AgentLine: ${n.project} #${n.task} ${ok ? '完成' : '被阻塞'}`, {
                    body: ok ? `verdict=${n.verdict || '-'} ci=${n.ci || '-'} 等待合并许可` : `原因：${n.reason || n.status || '?'}`,
                  })
                }
              }
            } catch { /* ignore */ }
          }
        }
        tick()
        const it = window.setInterval(tick, 10000)
        return () => { alive = false; window.clearInterval(it) }
      }, [])
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          const m = await j('/agentline/metrics')
          if (alive && m && m.records) setRecs(m.records)
        }
        tick()
        const it = window.setInterval(tick, 60000)
        return () => { alive = false; window.clearInterval(it) }
      }, [])
      const pick = (src, key) => recs.find((x) => x.source === src && x.key === key) || { value: null, ok: false }
      const chip = (ok, k, v, title, color) => h('span', {
        key: k,
        title,
        style: {
          display: 'inline-flex', gap: '5px', alignItems: 'center', padding: '2px 8px', borderRadius: '999px',
          border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.04)',
          fontSize: '11px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          color: ok ? 'inherit' : '#f85149',
        },
      }, h('span', { style: { opacity: .65 } }, k), h('b', { style: { fontWeight: 600, color } }, v))
      const running = sum.running || []
      const prOpen = sum.prOpen || []
      const blocked = sum.blocked || []
      // 灯色反映"需要人看一眼"的程度：跑着=黄，有阻塞=红，只待合并=黄，全空闲=绿
      const lampState = running.length ? 'busy' : blocked.length ? 'bad' : prOpen.length ? 'warn' : 'ok'
      const lampColor = { busy: '#d29922', bad: '#f85149', warn: '#d29922', ok: '#3fb950' }[lampState]
      const lampTitle = `运行中 ${running.length} · 待合并 ${prOpen.length} · 阻塞 ${blocked.length}（点击查看）`

      const lamp = h('span', {
        key: 'tasks',
        title: lampTitle,
        onClick: () => {
          setOpen(!open)
          try { if (window.Notification && window.Notification.permission === 'default') window.Notification.requestPermission() } catch { /* ignore */ }
        },
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer',
          padding: '2px 8px', borderRadius: '999px', border: `1px solid ${lampColor}55`,
          background: `${lampColor}18`, fontSize: '11px', minWidth: '46px', justifyContent: 'center',
        },
      },
        running.length
          ? h('span', { className: 'agl-spin', style: { borderTopColor: lampColor } })
          : h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: lampColor, display: 'inline-block' } }),
        h('b', { style: { fontWeight: 600 } }, 'AG'),
        h('span', { style: { opacity: .75 } }, running.length ? String(running.length) : ''),
      )

      const popover = open ? h('div', {
        style: {
          position: 'fixed', top: '44px', right: '16px', zIndex: 9999, width: '380px', maxHeight: '320px', overflow: 'auto',
          background: '#161b22', color: '#e6edf3', border: '1px solid rgba(255,255,255,.15)', borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(0,0,0,.45)', padding: '10px', fontSize: '12px',
        },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' } },
          h('b', null, 'AgentLine 任务'),
          h('span', { style: { cursor: 'pointer', opacity: .7 }, onClick: () => setOpen(false) }, '✕')),
        (() => {
          const row = (key, label, color, items, extra) => items.length ? h('div', { key, style: { marginBottom: '6px' } },
            h('div', { style: { fontSize: '11px', opacity: .6, margin: '2px 0 4px' } }, `${label} (${items.length})`),
            items.map((it, i) => h('div', {
              key: i,
              onClick: () => { focusTask(it.projectPath, it.task); setOpen(false) },
              style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '5px 6px', borderRadius: '6px', cursor: 'pointer' },
            },
              h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' } }),
              h('span', { style: { flex: 1 } }, `${it.project} #${it.task}`),
              h('span', { style: { opacity: .65 } }, extra(it)),
            )),
          ) : null
          const nodes = [
            row('run', '运行中', '#d29922', running, (it) => `${it.role}·${String(it.modelId || '').replace('claude-', '')} ${Math.round((it.age_s || 0) / 60)}m`),
            row('pr', '待合并', '#d29922', prOpen, () => 'pr_open'),
            row('bad', '阻塞', '#f85149', blocked, (it) => it.reason || '?'),
          ].filter(Boolean)
          return nodes.length ? nodes : h('div', { style: { opacity: .7 } }, '当前没有任务')
        })(),
        h('div', { style: { marginTop: '8px', opacity: .55, fontSize: '11px' } }, '点击某一行 → 打开驾驶舱并定位该任务'),
      ) : null

      const toastNodes = toasts.length ? h('div', {
        style: { position: 'fixed', top: '52px', right: '16px', zIndex: 10000, display: 'flex', flexDirection: 'column', gap: '8px', width: '340px' },
      }, toasts.map((t) => {
        const ok = t.event === 'pr_open' || t.event === 'merged'
        return h('div', {
          key: t.key,
          onClick: () => { focusTask(t.projectPath, t.task); setToasts((p) => p.filter((x) => x.key !== t.key)) },
          style: {
            cursor: 'pointer', background: '#161b22', color: '#e6edf3', borderRadius: '10px', padding: '10px 12px',
            border: `1px solid ${ok ? 'rgba(63,185,80,.5)' : 'rgba(248,81,73,.5)'}`,
            boxShadow: '0 8px 24px rgba(0,0,0,.45)', fontSize: '12px',
          },
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('b', null, `${ok ? '✅' : '⛔'} ${t.project} #${t.task} ${ok ? '完成' : '被阻塞'}`),
            h('span', { style: { opacity: .5 }, onClick: (e) => { e.stopPropagation(); setToasts((p) => p.filter((x) => x.key !== t.key)) } }, '✕')),
          h('div', { style: { marginTop: '4px', opacity: .8 } },
            ok ? `verdict=${t.verdict || '-'} · ci=${t.ci || '-'} · ${t.files ?? '?'} 文件 · 等待合并许可`
               : `原因：${t.reason || t.status || '?'}`),
          h('div', { style: { marginTop: '4px', opacity: .5, fontSize: '11px' } }, '点击 → 打开驾驶舱定位该任务'),
        )
      })) : null

      return h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        lamp,
        popover,
        toastNodes,
        chip(pick('claude', 'claude.session').ok, 'C5h', pct(pick('claude', 'claude.session').value), 'Claude 5 小时窗口', pctColor(pick('claude', 'claude.session').value)),
        chip(pick('claude', 'claude.weekly').ok, 'C7d', pct(pick('claude', 'claude.weekly').value), 'Claude 7 天窗口', pctColor(pick('claude', 'claude.weekly').value)),
        chip(pick('codex', 'codex.weekly').ok, 'CX', pct(pick('codex', 'codex.weekly').value), 'Codex 周额度', pctColor(pick('codex', 'codex.weekly').value)),
        chip(pick('buddy', 'buddy.remaining').ok, 'BD', num(pick('buddy', 'buddy.remaining').value), 'Buddy 剩余积分', creditColor(pick('buddy', 'buddy.remaining').value)),
        chip(pick('deepseek', 'deepseek.balance').ok, 'DS', money(pick('deepseek', 'deepseek.balance').value), 'DeepSeek 余额', moneyColor(pick('deepseek', 'deepseek.balance').value)),
      )
    }

    function apply(ctx) {
      let slots
      try { slots = ctx && ctx.slots } catch { return }
      if (!slots || typeof slots.inject !== 'function') return

      try {
        slots.inject('sidebar.panellist', () =>
          slots.register({ name: 'sidebar.panellist', id: 'agentline', order: 30, label: 'AgentLine' }, Safe(SidebarIcon)))
      } catch (e) { try { console.error('[agentline] sidebar register failed', e) } catch { /* ignore */ } }

      try {
        slots.inject('main', () =>
          slots.register({ name: 'main', key: 'agentline' }, Safe(Cockpit)))
      } catch (e) { try { console.error('[agentline] main register failed', e) } catch { /* ignore */ } }

      try {
        slots.inject('conversation.session.header.actions', () =>
          slots.register({ name: 'conversation.session.header.actions', id: 'agentline-chips', order: 20 }, Safe(HeaderChips)))
      } catch { /* 头部 slot 不可用时忽略 */ }

      // 插件设置页（Plugins → AgentLine）
      try {
        const cf = ctx && ctx.configForms
        const form = cf && typeof cf.get === 'function' ? (cf.get('agentline') || cf.get('dsh-agentline')) : null
        if (form) {
          const snapshot = {
            getSnapshot: () => (form.getSnapshot().value || {}),
            subscribe: (listener) => form.subscribe(listener),
          }
          const register = () => slots.inject('plugins.item', () => slots.register({
            name: 'plugins.item', id: 'agentline-settings', order: 40, label: 'AgentLine',
            inject: () => ({
              hooks: { settings: snapshot },
              update: async (u) => { await form.set(u.field, u.value) },
            }),
          }, Safe(SettingsSection)))
          if (cf.whileServed && typeof ctx.effect === 'function') ctx.effect(() => cf.whileServed(['agentline', 'dsh-agentline'], register), 'agentline: settings item')
          else register()
        }
      } catch (e) { try { console.error('[agentline] settings registration failed', e) } catch { /* ignore */ } }
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms']
    exports.name = 'dsh-agentline'
    return module.exports
  },
})



























