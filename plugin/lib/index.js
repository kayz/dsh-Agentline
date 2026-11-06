/**
 * dsh-agentline — host half (v0.3)
 *
 * 多项目模型：一个「项目」= 一个 DSH 工作区（workspaceRegistry 里的 path）。
 * 每个项目自己的 .collab/tasks 就是它的任务库。
 *
 * 提供：
 *   - 路由 /agentline/{metrics,projects,tasks,task,flow,pipeline,catalog}
 *   - 工具 agentline_metrics / agentline_status / agentline_flow
 *   - 斜杠命令 /agentline（为当前工作区启用）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import z from './vendor/schemastery.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_AGENTLINE_HOME = 'C:/git/dsh-Agentline/orchestrator'
let activeConfig = null

/** 读一个 Config 字段：volatile 字段是 ref，普通字段是值 */
function cfgVal(name) {
  const raw = activeConfig ? activeConfig[name] : undefined
  if (raw && typeof raw.get === 'function') {
    try { return raw.get() } catch { return undefined }
  }
  return raw
}

function agentlineHome() {
  return String(cfgVal('agentlineHome') || process.env.AGENTLINE_HOME || DEFAULT_AGENTLINE_HOME)
}
function defaultNode() {
  const p = path.join(process.resourcesPath || '', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
  return fs.existsSync(p) ? p : 'node'
}
function nodeBin() {
  return String(cfgVal('nodePath') || process.env.AGENTLINE_NODE || defaultNode())
}
function agentlineCli() { return path.join(agentlineHome(), 'agentline.mjs') }
function defaultProject() {
  return String(cfgVal('defaultRepo') || process.env.AGENTLINE_REPO || '')
}
function agentlineConfigPath() {
  const home = agentlineHome()
  const next = path.join(home, 'config', 'agentline.config.json')
  return fs.existsSync(next) ? next : path.join(home, 'agentline.config.json')
}
const cache = { at: 0, data: null }
const TTL = 60_000
let ctxRef = null
let sessionService = null

function sendJson(res, body, code = 200) {
  try {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  } catch { /* ignore */ }
}

function logPlugin(msg) {
  try {
    const dir = path.join(agentlineHome(), 'data')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'plugin.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8')
  } catch { /* ignore */ }
}

// ───────────────────────────── 工作区（= 项目） ─────────────────────────────
function registeredProjects() {
  try {
    const file = path.join(agentlineHome(), 'data', 'projects.json')
    const list = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p) : []
  } catch { return [] }
}

/**
 * 项目来源（合并去重）：
 *   1) agentline/data/projects.json —— CLI 每次 flow/stop/merge 自动登记，最可靠
 *   2) workspaceRegistry —— 尽力而为（某些宿主版本下 ctx.get 会抛注入错误，读不到就跳过）
 */
function workspaces() {
  const out = []
  const seen = new Set()
  const push = (p, title) => {
    if (!p) return
    const key = String(p).replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ title: title || path.basename(String(p)), path: p })
  }

  for (const p of registeredProjects()) push(p)
  try {
    const reg = ctxRef?.get?.('workspaceRegistry') ?? ctxRef?.get?.('workspace')
    const list = reg && typeof reg.list === 'function' ? reg.list() : []
    for (const w of list) push(w.path, w.title)
  } catch { /* 宿主不允许读工作区注册表时忽略 */ }
  push(defaultProject())
  return out
}

function projectEnabled(dir) {
  try { return fs.existsSync(path.join(dir, '.collab', 'agentline.json')) || fs.existsSync(path.join(dir, '.collab', 'tasks')) || fs.existsSync(path.join(dir, '.collab', 'worktrees')) } catch { return false }
}

function projectTaskStats(dir) {
  const tasks = listTasks(dir)
  const active = tasks.filter((t) => ['designed', 'implemented', 'reviewable', 'reviewed', 'pr_open', 'blocked'].includes(t.state?.status)).length
  return { total: tasks.length, active, last: tasks.length ? tasks[tasks.length - 1].state?.status || null : null }
}

// ───────────────────────────── 任务 ─────────────────────────────
function taskCandidates(project, taskId) {
  const id = String(taskId)
  const main = path.join(project, '.collab', 'tasks', id)
  const wt = path.join(project, '.collab', 'worktrees', id, '.collab', 'tasks', id)
  if (fs.existsSync(path.join(main, 'state.json'))) return { dir: main, worktree: false }
  if (fs.existsSync(wt)) return { dir: wt, worktree: true }
  return { dir: main, worktree: false }
}

function taskDirOf(project, taskId) { return taskCandidates(project, taskId).dir }

function readState(project, taskId) {
  try { return JSON.parse(fs.readFileSync(path.join(taskDirOf(project, taskId), 'state.json'), 'utf8')) } catch { return null }
}

function listTasks(project) {
  const found = new Map()
  const add = (id, dir, worktree) => {
    let state = null
    try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) } catch { /* no state */ }
    const prev = found.get(id)
    if (!prev) { found.set(id, { id, state, worktree }); return }
    // 主工作区的 merged 状态优先；其余以 worktree 为准
    if (worktree && prev.state?.status !== 'merged') found.set(id, { id, state, worktree })
  }
  const base = path.join(project, '.collab', 'tasks')
  try {
    for (const id of fs.readdirSync(base)) if (/^\d+$/.test(id)) add(id, path.join(base, id), false)
  } catch { /* none */ }
  const wtRoot = path.join(project, '.collab', 'worktrees')
  try {
    for (const id of fs.readdirSync(wtRoot)) {
      if (!/^\d+$/.test(id)) continue
      const dir = path.join(wtRoot, id, '.collab', 'tasks', id)
      if (fs.existsSync(dir)) add(id, dir, true)
    }
  } catch { /* none */ }
  return [...found.values()].sort((a, b) => Number(a.id) - Number(b.id))
}

async function readTaskDetail(project, taskId, tail = 160, render = false) {
  const located = taskCandidates(project, taskId)
  const dir = located.dir
  const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) } catch { return null } })()
  const runs = (() => {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))
      return Array.isArray(v) ? v : [v]
    } catch { return [] }
  })()

  let renderLog = null
  if (render) {
    try { renderLog = (await importFresh(path.join(__dirname, 'logview.mjs'))).renderLog } catch { renderLog = null }
  }

  let logs = []
  try {
    const logsDir = path.join(dir, 'logs')
    logs = fs.readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const p = path.join(logsDir, f)
        const st = fs.statSync(p)
        const raw = fs.readFileSync(p, 'utf8')
        if (renderLog) {
          try {
            const r = renderLog(raw)
            return { file: f, size: st.size, mtime: st.mtime.toISOString(), kind: r.kind, truncated: r.truncated, lines: r.lines }
          } catch { /* 渲染失败退回原始 */ }
        }
        return { file: f, size: st.size, mtime: st.mtime.toISOString(), kind: 'raw', lines: raw.split(/\r?\n/).slice(-tail) }
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
  } catch { /* 没有日志目录也正常 */ }

  const attention = readJsonFile(path.join(dir, 'attention.json'))
  let stepLedger = []
  try {
    stepLedger = fs.readFileSync(path.join(dir, 'step-ledger.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).slice(-100)
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
  } catch { /* no K1 ledger */ }
  return { project, task: taskId, dir, worktree: located.worktree, state, runs, logs, render, attention, stepLedger }
}

// ───────────────────────────── 用量 ─────────────────────────────
/** 按文件 mtime 做 import 缓存旁路：改了 lib/*.mjs 不用重启 DSH 也能生效 */
async function importFresh(absPath) {
  let v = 0
  try { v = fs.statSync(absPath).mtimeMs } catch { /* ignore */ }
  return import(pathToFileURL(absPath).href + '?v=' + v)
}

async function loadCollector() {
  return importFresh(path.join(__dirname, 'collect.mjs'))
}

async function loadRecovery() {
  return importFresh(path.join(agentlineHome(), 'lib', 'recovery.mjs'))
}

async function loadRouting() {
  return importFresh(path.join(agentlineHome(), 'lib', 'routing.mjs'))
}

/** 读 POST body（限 64KB） */
function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 65536) { try { req.destroy() } catch { /* ignore */ } }
    })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

async function metrics(force) {
  if (cfgVal('metricsEnabled') === false) return { records: [], updated_at: new Date().toISOString() }
  if (!force && cache.data && Date.now() - cache.at < TTL) return cache.data
  const collector = await loadCollector()
  collector.setCredentialOverrides?.({
    deepseekApiKey: cfgVal('deepseekApiKey'),
    claudeAccessToken: cfgVal('claudeAccessToken'),
    codexAccessToken: cfgVal('codexAccessToken'),
    codexAccountId: cfgVal('codexAccountId'),
    buddyAccessToken: cfgVal('buddyAccessToken'),
    buddyUserId: cfgVal('buddyUserId'),
  })
  const records = await collector.collectAll()
  const data = { records, updated_at: new Date().toISOString() }
  cache.at = Date.now()
  cache.data = data
  return data
}

// ───────────────────── 任务结束 → 回到开启它的对话框 ─────────────────────
function originDir() { return path.join(agentlineHome(), 'data', 'flow-origins') }
const TERMINAL_STATUS = new Set(['pr_open', 'merged', 'blocked'])
const EVENT_LABEL = { pr_open: '任务完成（等待合并）', merged: '任务已合并', blocked: '任务被阻塞', halted: '任务已停止' }

function readJsonFile(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
function writeJsonFile(p, data) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); return true } catch { return false }
}

/** agent 的两个来源字段：session.header.id（普通 JSON）或 agent.id */
function sessionIdOf(agent) {
  try {
    const h = agent?.session?.header
    if (h && typeof h.id === 'string' && h.id) return h.id
  } catch { /* gateway 读不到就退回 id */ }
  try { const id = agent?.id; if (typeof id === 'string' && id) return id } catch { /* ignore */ }
  return null
}

function originPath(project, taskId) {
  const key = crypto.createHash('sha1').update(String(project).toLowerCase()).digest('hex').slice(0, 10)
  return path.join(originDir(), `${key}-${taskId}.json`)
}
function readOrigin(project, taskId) { return readJsonFile(originPath(project, taskId)) }
function saveOrigin(project, taskId, patch) {
  const p = originPath(project, taskId)
  const next = { ...(readJsonFile(p) || {}), ...patch, project, task: String(taskId), updatedAt: new Date().toISOString() }
  writeJsonFile(p, next)
  return next
}

/** 会话可能已被卸载：交货时按 session id 重新解析，比缓存的 agent 可靠 */
async function resolveAgentById(sessionId) {
  if (!sessionId) return null
  try {
    const sc = sessionService || ctxRef?.get?.('sessionController')
    if (sc && typeof sc.resolveAgent === 'function') {
      const r = await sc.resolveAgent(sessionId)
      if (r && r.agent) return r.agent
      if (r && r.error) logPlugin(`resolveAgent(${sessionId}) error: ${r.error.message || JSON.stringify(r.error)}`)
    } else {
      logPlugin('sessionController unavailable; cannot resolve ' + sessionId)
    }
  } catch (e) { logPlugin('resolveAgent threw: ' + (e && e.message ? e.message : String(e))) }
  return null
}

/** 往指定会话注入一条消息；模型随后会把总结讲给用户听 */
async function postToSession(agent, text) {
  if (!agent || typeof agent.followup !== 'function') return false
  const llm = await import('@deepseek-ai/dsh-llm')
  const msg = llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  agent.followup(msg)
  return true
}

async function buildSummaryText(project, taskId, event, reason, branch) {
  try {
    const mod = await importFresh(path.join(agentlineHome(), 'lib', 'summary.mjs'))
    return await mod.buildSummary({ repo: project, taskId, dir: taskDirOf(project, taskId), event, reason, branch })
  } catch (e) {
    logPlugin('summary build failed: ' + (e && e.message ? e.message : String(e)))
    return null
  }
}

/** 同一终态的去重键；插件与 sweep 共用，保证只发一次 */
function noticeKey(project, taskId, event) {
  const dir = taskDirOf(project, taskId)
  const notice = readJsonFile(path.join(dir, 'notice.json'))
  const state = readJsonFile(path.join(dir, 'state.json'))
  return `${event}@${(notice && notice.at) || (state && state.updated_at) || ''}`
}

/**
 * 任务结束时，把总结发言送回「开启这个任务的那个对话框」。
 * 每个终态（pr_open / merged / blocked…）只发一次；失败最多重试 3 次。
 */
async function deliverSummary({ project, taskId, event, reason, summary, fallbackAgent, via, post, resolveAgent }) {
  const origin = readOrigin(project, taskId)
  if (!origin || !origin.sessionId) {
    logPlugin(`summary skip ${path.basename(project)}#${taskId}: no chat origin`)
    return { ok: false, skipped: 'no-origin' }
  }
  const dir = taskDirOf(project, taskId)
  const notice = readJsonFile(path.join(dir, 'notice.json'))
  const key = noticeKey(project, taskId, event)
  if (origin.deliveredKey === key) return { ok: true, deduped: true }
  const attempts = (origin.lastAttemptKey === key ? Number(origin.attempts || 0) : 0) + 1
  if (attempts > 3) return { ok: false, error: 'too many attempts' }

  const text = summary || (await buildSummaryText(project, taskId, event, reason, notice && notice.branch))
  if (!text) return { ok: false, error: 'no summary' }

  const injected = `【AgentLine 任务通知】${path.basename(project)} / task ${taskId}：${EVENT_LABEL[event] || '任务结束'}。\n请把下面这段总结原样发给用户（不要改写、不要补充、不要省略）：\n\n${text}`
  const tryPost = async (a) => {
    try { return await (post ? post(a, injected) : postToSession(a, injected)) } catch (e) {
      logPlugin('post failed: ' + (e && e.message ? e.message : String(e)))
      return false
    }
  }
  let agent = fallbackAgent || (resolveAgent ? await resolveAgent(origin.sessionId) : await resolveAgentById(origin.sessionId))
  let posted = await tryPost(agent)
  if (!posted && fallbackAgent) {
    // 缓存的 agent 可能已失效：按 session id 重新解析后再试一次
    const fresh = resolveAgent ? await resolveAgent(origin.sessionId) : await resolveAgentById(origin.sessionId)
    if (fresh && fresh !== agent) posted = await tryPost(fresh)
  }

  if (posted) {
    saveOrigin(project, taskId, { deliveredKey: key, deliveredAt: new Date().toISOString(), lastEvent: event, lastAttemptKey: key, attempts, lastError: null })
    logPlugin(`summary delivered ${path.basename(project)}#${taskId} (${event}) via ${via || 'flow'} -> ${origin.sessionId}`)
    return { ok: true }
  }
  saveOrigin(project, taskId, { lastAttemptKey: key, attempts, lastError: 'session unavailable', lastEvent: event })
  logPlugin(`summary pending ${path.basename(project)}#${taskId}: session ${origin.sessionId} unavailable`)
  return { ok: false, error: 'session unavailable' }
}

/** flow 进程退出后收尾：读终态 → 发总结 */
async function notifyFlowDone(job) {
  const dir = taskDirOf(job.project, job.taskId)
  const state = readJsonFile(path.join(dir, 'state.json'))
  const notice = readJsonFile(path.join(dir, 'notice.json'))
  // 只认本次 flow 写的 notice，避免复跑时把上次的终态再发一遍
  const startedAt = new Date(job.startedAt).getTime() - 5000
  const fresh = notice && notice.at && new Date(notice.at).getTime() >= startedAt ? notice : null
  const stateEvent = state ? (state.status === 'merged' ? 'merged' : state.status === 'blocked' ? 'blocked' : null) : null
  const event = (fresh && fresh.event) || stateEvent || (job.exitCode === 0 ? 'pr_open' : 'blocked')
  const reason = (fresh && fresh.reason) || (state && state.blocked_reason) || (job.exitCode === 0 ? null : `flow exit ${job.exitCode}`)
  job.status = job.exitCode === 0 ? 'done' : 'failed'
  job.event = event
  await deliverSummary({
    project: job.project,
    taskId: job.taskId,
    event,
    reason,
    summary: fresh && fresh.summary,
    fallbackAgent: job.origin && job.origin.agent,
    via: 'flow',
  })
}

function watchFlow(job, child) {
  const settle = (code) => {
    if (job.settled) return
    job.settled = true
    job.exitCode = typeof code === 'number' ? code : -1
    // 等 CLI 写完 notice.json / state.json 再读
    setTimeout(() => { notifyFlowDone(job).catch((e) => logPlugin('notifyFlowDone failed: ' + (e && e.message ? e.message : String(e)))) }, 1200)
  }
  try {
    child.on('exit', (code) => settle(code))
    child.on('error', () => settle(-1))
  } catch (e) { logPlugin('watchFlow failed: ' + (e && e.message)) }
}

/** 补投：DSH 重启 / 漏掉 exit 事件 / 用户在合并后回来时，把还没发过的总结补上 */
async function sweepOrigins() {
  let names = []
  try { names = fs.readdirSync(originDir()) } catch { return }
  let delivered = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const origin = readJsonFile(path.join(originDir(), name))
    if (!origin || !origin.project || !origin.sessionId) continue
    if (origin.pid) { try { process.kill(origin.pid, 0); continue } catch { /* 进程已退出 */ } }
    const project = origin.project
    const taskId = String(origin.task || '')
    const dir = taskDirOf(project, taskId)
    const state = readJsonFile(path.join(dir, 'state.json'))
    const notice = readJsonFile(path.join(dir, 'notice.json'))
    const status = state && state.status
    if (!notice && !(status && TERMINAL_STATUS.has(status))) continue
    const event = (notice && notice.event) || (status === 'merged' ? 'merged' : (status === 'blocked' ? 'blocked' : 'pr_open'))
    const key = noticeKey(project, taskId, event)
    if (origin.deliveredKey === key) continue
    if (origin.lastAttemptKey === key && Number(origin.attempts || 0) >= 3) continue
    const r = await deliverSummary({ project, taskId, event, reason: (notice && notice.reason) || (state && state.blocked_reason), summary: notice && notice.summary, via: 'sweep' })
    if (r && r.ok) delivered++
  }
  if (delivered) logPlugin(`sweep: delivered ${delivered} notice(s)`)
}

// ───────────────────────────── flow ─────────────────────────────
const jobs = new Map()
function startFlow(project, taskId, maxRounds = 2, opts = {}) {
  const extra = []
  if (opts.resume) extra.push('--resume')
  if (opts.keep) extra.push('--keep')
  const id = `flow-${taskId}-${Date.now().toString(36)}`
  const logPath = path.join(agentlineHome(), 'data', `${id}.log`)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const out = fs.openSync(logPath, 'a')
  const child = spawn(nodeBin(), [path.join(agentlineHome(), 'agentline.mjs'), 'flow',
    '--repo', project, '--task', String(taskId), '--max-rounds', String(maxRounds), ...extra], {
    cwd: agentlineHome(),
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  try { fs.closeSync(out) } catch { /* 子进程已继承句柄 */ }
  child.unref()
  const origin = opts.origin && opts.origin.sessionId
    ? { sessionId: opts.origin.sessionId, agent: opts.origin.agent || null, via: opts.origin.via || 'unknown' }
    : null
  const job = { id, project, taskId, pid: child.pid, logPath, startedAt: new Date().toISOString(), status: 'running', origin, settled: false }
  jobs.set(id, job)
  if (origin) {
    // 记下「谁开的这个任务」：DSH 重启后靠它补投
    saveOrigin(project, taskId, { sessionId: origin.sessionId, via: origin.via, jobId: id, pid: child.pid, startedAt: job.startedAt, lastAttemptKey: null, attempts: 0, lastError: null })
  }
  watchFlow(job, child)
  return job
}

function resolveProject(v) {
  const raw = (v && String(v).trim()) || ''
  if (!raw) return defaultProject() || (workspaces()[0] && workspaces()[0].path) || ''
  return raw
}

/** Studio 只接受真实存在的目录，避免把路径拼进 .collab/studio 之外。 */
function projectDirOrNull(v) {
  const p = resolveProject(v)
  if (!p) return null
  try { return fs.statSync(p).isDirectory() ? path.resolve(p) : null } catch { return null }
}

/** 尝试从命令调用里取出当前工作区路径（不同版本字段名不同，逐个试） */
function explicitProject(rawInput) {
  const m = String(rawInput || '').match(/--project\s+("?)([^"\s]+)\1\s*/)
  return m ? { path: m[2], rest: String(rawInput).slice(m[0].length).trim() } : { path: null, rest: String(rawInput || '').trim() }
}

/** 只读 agent.session.header.cwd（header 是普通 JSON；其它 agent.* 是 gateway，读未知属性会抛 inject 错误） */
function workspaceFromHeader(inv) {
  try {
    const h = inv?.agent?.session?.header
    return h && typeof h.cwd === 'string' && h.cwd ? h.cwd : null
  } catch { return null }
}

/** 往对话里注入一条消息（命令返回值这个版本不渲染，必须走 followup 才看得见） */
async function injectDirective(invocation, text) {
  try {
    const llm = await import('@deepseek-ai/dsh-llm')
    const msg = llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    invocation.agent.followup(msg)
    logPlugin('/agentline injected ok')
    return true
  } catch (e) {
    logPlugin('inject failed: ' + (e && e.message ? e.message : String(e)))
    return false
  }
}

/** 记一次 invocation 结构，便于排查字段变化（每次进程只记第一条） */
let invocationLogged = false
function logInvocationShape(inv) {
  if (invocationLogged) return
  invocationLogged = true
  try {
    const shape = {
      top: Object.keys(inv || {}),
      agent: Object.keys(inv?.agent || {}),
      header: (() => { try { return JSON.stringify(inv?.agent?.session?.header || {}).slice(0, 700) } catch { return '?' } })(),
      options: Object.keys(inv?.agent?.options || {}),
      loopCtx: Object.keys(inv?.agent?.loopCtx || {}),
      scope: Object.keys(inv?.agent?.scope || {}),
    }
    logPlugin('invocation shape: ' + JSON.stringify(shape))
  } catch { /* ignore */ }
}

export function apply(ctx, config) {
  ctxRef = ctx
  activeConfig = config || null
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
    logPlugin('apply v' + pkg.version)
  } catch { /* ignore */ }

  // ---- 会话服务（投递总结用；拿不到也不影响其它功能） ----
  try {
    ctx.inject(['sessionController'], (c) => {
      sessionService = c.sessionController
      logPlugin('sessionController ready')
    })
  } catch (e) {
    logPlugin('sessionController inject failed: ' + (e && e.message ? e.message : String(e)))
  }

  // ---- 路由 ----
  try {
    ctx.inject(['webServer'], (httpCtx) => {
      const route = (p, name, handler) => httpCtx.effect(() => httpCtx.webServer.register({ kind: 'exact', path: p, handler }), name)

      route('/agentline/metrics', 'agentline: metrics', async (req, res) => {
        try {
          const force = (req.url || '').includes('force=1')
          sendJson(res, { ok: true, ...(await metrics(force)) })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e), records: [] }) }
      })

      route('/agentline/projects', 'agentline: projects', async (req, res) => {
        try {
          const ws = workspaces()
          const R = await loadRecovery().catch(() => null)
          for (const w of ws) { try { R?.sweepInterrupted(w.path) } catch { /* ignore */ } }
          const projects = ws.map((w) => ({ ...w, enabled: projectEnabled(w.path), tasks: projectTaskStats(w.path) }))
          const def = defaultProject() || (projects[0] && projects[0].path) || ''
          if (def && !projects.some((p) => p.path === def)) {
            projects.unshift({ title: path.basename(def), path: def, enabled: projectEnabled(def), tasks: projectTaskStats(def) })
          }
          sendJson(res, { ok: true, default: def, projects })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e), projects: [] }) }
      })

      route('/agentline/tasks', 'agentline: tasks', async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://localhost')
          const project = resolveProject(u.searchParams.get('project'))
          const { aggregateTokens } = await loadCollector()
          sendJson(res, { ok: true, project, tasks: listTasks(project), tokens: aggregateTokens(project) })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e), tasks: [] }) }
      })

      route('/agentline/task', 'agentline: task', async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://localhost')
          const task = u.searchParams.get('task')
          const project = resolveProject(u.searchParams.get('project'))
          const tail = Math.max(20, Math.min(500, Number(u.searchParams.get('tail') || 160)))
          const render = u.searchParams.get('render') === '1'
          if (!task) return sendJson(res, { ok: false, error: 'missing ?task=' }, 400)
          sendJson(res, { ok: true, ...(await readTaskDetail(project, task, tail, render)) })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e) }, 500) }
      })

      // 人工确认后合并：必须有 permission 文案（人类许可），成功才改 state
      route('/agentline/merge', 'agentline: merge', async (req, res) => {
        try {
          if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'POST only' }, 405)
          const u = new URL(req.url || '/', 'http://localhost')
          const task = u.searchParams.get('task')
          const project = resolveProject(u.searchParams.get('project'))
          const body = await readBody(req)
          const permission = String((body && body.permission) || '').trim()
          const grant = body?.grant === true
          const check = body?.check === true
          if (!task) return sendJson(res, { ok: false, error: 'missing ?task=' }, 400)
          if (!grant && !check && !permission) return sendJson(res, { ok: false, error: 'merge 需要人类许可文案，或 --grant / --check' }, 400)

          const argv = [agentlineCli(), 'merge', '--repo', project, '--task', String(task)]
          if (check) argv.push('--check')
          else if (grant) argv.push('--grant')
          else argv.push('--permission', permission)
          const child = spawn(nodeBin(), argv, {
            cwd: agentlineHome(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
          })
          let out = ''
          child.stdout.on('data', (d) => { out += d.toString() })
          child.stderr.on('data', (d) => { out += d.toString() })
          const code = await new Promise((resolve) => {
            const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolve(124) }, 120_000)
            child.on('close', (c) => { clearTimeout(timer); resolve(c ?? -1) })
          })
          logPlugin(`merge ${project}#${task} -> code=${code}${check ? ' (check)' : grant ? ' (grant)' : ''}`)
          if (code === 0 && !check) {
            // 合并 = 任务完全结束：把最终总结送回开启它的对话框
            try {
              const notice = readJsonFile(path.join(taskDirOf(project, String(task)), 'notice.json'))
              await deliverSummary({ project, taskId: String(task), event: 'merged', summary: notice && notice.summary, via: 'merge' })
            } catch (e) { logPlugin('merge summary failed: ' + (e && e.message ? e.message : String(e))) }
          }
          sendJson(res, { ok: code === 0, code, output: out.slice(-4000) })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e) }, 500) }
      })

      // 人工确认后合并
      // 全局模型矩阵：哪些渠道的模型可以在哪些角色上使用（影响所有工作区的候选顺序）
      route('/agentline/models', 'agentline: models', async (req, res) => {
        try {
          const r = await loadRouting()
          const cfgMod = await importFresh(path.join(agentlineHome(), 'lib', 'config.mjs'))
          const cfgPath = cfgMod.resolveConfigPaths({ orchestratorRoot: agentlineHome() }).local
          const conf = cfgMod.loadConfig({ orchestratorRoot: agentlineHome() }).config
          if (req.method === 'POST') {
            const body = await readBody(req)
            const matrix = (body && body.roles) || {}
            const saved = r.saveRoleMatrix(cfgPath, conf, matrix)
            logPlugin('role matrix saved: ' + JSON.stringify(saved))
            const conf2 = cfgMod.loadConfig({ orchestratorRoot: agentlineHome() }).config
            return sendJson(res, { ok: true, models: r.catalog(conf2), roles: r.roleMatrix(conf2) })
          }
          sendJson(res, { ok: true, models: r.catalog(conf), roles: r.roleMatrix(conf) })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e) }, 500) }
      })

      // 角色 → 模型路由（每个工作区各自一份，存在 <project>/.collab/agentline.json）
      route('/agentline/routing', 'agentline: routing', async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://localhost')
          const project = resolveProject(u.searchParams.get('project'))
          const r = await loadRouting()
          const cfgMod = await importFresh(path.join(agentlineHome(), 'lib', 'config.mjs'))
          const loaded = cfgMod.loadConfig({ orchestratorRoot: agentlineHome(), repo: project })
          const conf = loaded.config

          if (req.method === 'POST') {
            const body = await readBody(req)
            const data = r.readProject(project)
            const incoming = (body && body.routing) || {}
            data.routing = { ...(data.routing || {}) }
            for (const role of r.ROLES) {
              if (incoming[role]) data.routing[role] = { ...(data.routing[role] || {}), ...incoming[role] }
            }
            data.enabled = true
            data.updatedAt = new Date().toISOString()
            r.writeProject(project, data)
            logPlugin(`routing saved for ${project}`)
            const roles = {}
            for (const role of r.ROLES) roles[role] = r.effectiveRole(conf, role, data)
            return sendJson(res, { ok: true, project, models: r.catalog(conf), roles, routing: data.routing })
          }

          const pcfg = r.readProject(project)
          const roles = {}
          for (const role of r.ROLES) roles[role] = r.effectiveRole(conf, role, pcfg)
          sendJson(res, { ok: true, project, models: r.catalog(conf), roles, routing: pcfg.routing || {} })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e) }, 500) }
      })

      // 当前正在跑的 agentline（跨项目）：读各任务目录下的 live.json，并校验 pid 存活
      route('/agentline/live', 'agentline: live', async (req, res) => {
        try {
          const list = workspaces()
          { const def = defaultProject(); if (def && !list.some((w) => w.path === def)) list.push({ title: path.basename(def), path: def }) }
          const out = []
          for (const p of list) {
            let tasks = []
            try { tasks = listTasks(p.path) } catch { tasks = [] }
            for (const { id } of tasks) {
              const f = path.join(taskDirOf(p.path, id), 'live.json')
              let live = null
              try { live = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
              let alive = false
              try { process.kill(live.pid, 0); alive = true } catch { alive = false }
              if (!alive) continue
              out.push({
                project: p.title, projectPath: p.path, task: id,
                role: live.role, round: live.round, model: live.model, modelId: live.modelId,
                backend: live.backend, effort: live.effort,
                started_at: live.started_at, at: live.at,
                age_s: Math.max(0, Math.round((Date.now() - new Date(live.started_at || live.at).getTime()) / 1000)),
              })
            }
          }
          sendJson(res, { ok: true, running: out })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e), running: [] }) }
      })

      // 控制面：stop（阶段末）/ stop-now（立即终止）/ inject（插话，下一阶段生效）
      route('/agentline/control', 'agentline: control', async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://localhost')
          const action = u.searchParams.get('action')
          const task = u.searchParams.get('task')
          const project = resolveProject(u.searchParams.get('project'))
          if (!task) return sendJson(res, { ok: false, error: 'missing ?task=' }, 400)
          const body = req.method === 'POST' ? await readBody(req) : {}
          const dir = taskDirOf(project, task)

          const runInput = (kind, text) => new Promise((resolve) => {
            const child = spawn(nodeBin(), [agentlineCli(), 'input', '--repo', project, '--task', String(task), '--kind', kind, '--text', text], {
              cwd: agentlineHome(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
            })
            let out = ''
            child.stdout.on('data', (d) => { out += d.toString() })
            child.stderr.on('data', (d) => { out += d.toString() })
            const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolve(124) }, 30_000)
            child.on('close', (c) => { clearTimeout(timer); resolve({ code: c ?? -1, out }) })
          })

          if (action === 'inject') {
            const text = String(body.text || '').trim()
            if (!text) return sendJson(res, { ok: false, error: 'empty text' }, 400)
            const kind = body.kind === 'amendment' ? 'amendment' : 'note'
            const r = await runInput(kind, text)
            logPlugin(`input ${kind} into ${project}#${task} code=${r.code}: ${text.slice(0, 60)}`)
            return sendJson(res, { ok: r.code === 0, code: r.code, output: r.out.slice(-2000), note: kind === 'amendment' ? '当前轮作废，下一次 flow 回到 design' : '下一个阶段生效（正在跑的模型收不到）' })
          }

          if (action === 'answer') {
            const text = String(body.text || '').trim()
            if (!text) return sendJson(res, { ok: false, error: 'empty text' }, 400)
            const child = spawn(nodeBin(), [agentlineCli(), 'answer', '--repo', project, '--task', String(task), '--text', text], {
              cwd: agentlineHome(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
            })
            let out = ''
            child.stdout.on('data', (d) => { out += d.toString() })
            child.stderr.on('data', (d) => { out += d.toString() })
            const code = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? -1)))
            logPlugin(`answer into ${project}#${task} code=${code}`)
            return sendJson(res, { ok: code === 0, code, output: out.slice(-2000) })
          }

          if (action === 'stop' || action === 'stop-now') {
            const argv = [agentlineCli(), 'stop', '--repo', project, '--task', String(task)]
            if (action === 'stop-now') argv.push('--now')
            const child = spawn(nodeBin(), argv, { cwd: agentlineHome(), detached: true, stdio: 'ignore', windowsHide: true })
            child.unref()
            logPlugin(`${action} ${project}#${task}`)
            return sendJson(res, { ok: true, action })
          }

          sendJson(res, { ok: false, error: 'unknown action' }, 400)
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e) }, 500) }
      })

      // 汇总：AG 状态灯用它一眼判断（运行中 / 待合并 / 有阻塞 / 空闲）+ 额度
      route('/agentline/summary', 'agentline: summary', async (req, res) => {
        try {
          const list = workspaces()
          { const def = defaultProject(); if (def && !list.some((w) => w.path === def)) list.push({ title: path.basename(def), path: def }) }
          const running = []
          const prOpen = []
          const blocked = []
          for (const p of list) {
            const tasksDir = path.join(p.path, '.collab', 'tasks')
            let lockAlive = false
            try {
              const lock = JSON.parse(fs.readFileSync(path.join(p.path, '.collab', '.flow.lock'), 'utf8'))
              process.kill(lock.pid, 0)
              lockAlive = true
            } catch { lockAlive = false }
            let tasks = []
            try { tasks = listTasks(p.path) } catch { tasks = [] }
            for (const { id, state: st } of tasks) {
              const dir = taskDirOf(p.path, id)
              try {
                const live = JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8'))
                let alive = false
                try { process.kill(live.pid, 0); alive = true } catch { alive = false }
                if (alive) running.push({ project: p.title, projectPath: p.path, task: id, role: live.role, modelId: live.modelId, age_s: Math.max(0, Math.round((Date.now() - new Date(live.started_at || live.at).getTime()) / 1000)) })
              } catch { /* not running */ }
              if (st) {
                if (st.status === 'pr_open') prOpen.push({ project: p.title, projectPath: p.path, task: id })
                if (st.status === 'blocked') blocked.push({ project: p.title, projectPath: p.path, task: id, reason: st.blocked_reason || '?' })
                const ACTIVE = ['draft', 'designed', 'implemented', 'reviewable', 'reviewed']
                const already = running.some((r) => r.projectPath === p.path && r.task === id)
                if (!already && ACTIVE.includes(st.status) && lockAlive) {
                  running.push({
                    project: p.title, projectPath: p.path, task: id,
                    role: st.role || '?', modelId: st.model || null,
                    age_s: Math.max(0, Math.round((Date.now() - new Date(st.updated_at || Date.now()).getTime()) / 1000)),
                  })
                }
              }
            }
          }
          let records = []
          try { const m = await metrics(false); records = m.records || [] } catch { /* ignore */ }
          sendJson(res, { ok: true, running, prOpen, blocked, records })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e) }, 500) }
      })

      // 任务结束通知（flow 结束时写 notice.json）
      route('/agentline/notices', 'agentline: notices', async (req, res) => {
        try {
          const list = workspaces()
          { const def = defaultProject(); if (def && !list.some((w) => w.path === def)) list.push({ title: path.basename(def), path: def }) }
          const out = []
          for (const p of list) {
            let tasks = []
            try { tasks = listTasks(p.path) } catch { tasks = [] }
            for (const { id } of tasks) {
              const f = path.join(taskDirOf(p.path, id), 'notice.json')
              try {
                const n = JSON.parse(fs.readFileSync(f, 'utf8'))
                out.push({ project: p.title, projectPath: p.path, task: id, ...n })
              } catch { /* 没有通知就是没结束 */ }
            }
          }
          out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
          sendJson(res, { ok: true, notices: out.slice(0, 20) })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e), notices: [] }) }
      })

      route('/agentline/flow', 'agentline: flow', async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://localhost')
          const task = u.searchParams.get('task')
          if (!task) return sendJson(res, { ok: false, error: 'missing ?task=' }, 400)
          const project = resolveProject(u.searchParams.get('project'))
          const resume = u.searchParams.get('resume') === '1'
          const keep = u.searchParams.get('keep') === '1'
          sendJson(res, { ok: true, job: startFlow(project, task, Number(u.searchParams.get('rounds') || 2), { resume, keep }) })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e) }, 500) }
      })

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

      // 只读：Studio 控制面。读取走 lib/studio.mjs；写操作每次只转发一条公开 CLI（参数数组，不经 shell）
      route('/agentline/studio', 'agentline: studio', async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://localhost')
          const studioMod = await importFresh(path.join(agentlineHome(), 'lib', 'studio.mjs'))

          if (req.method === 'POST') {
            const body = await readBody(req)
            const action = String((body && body.action) || '')
            const id = String((body && body.id) || '')
            const project = projectDirOrNull((body && body.project) || u.searchParams.get('project'))
            if (!project) return sendJson(res, { ok: false, error: 'project not found' }, 400)
            if (!['new', 'run', 'answer', 'conclude'].includes(action)) return sendJson(res, { ok: false, error: 'unknown studio action' }, 400)
            if (!studioMod.isValidSessionId(id)) return sendJson(res, { ok: false, error: 'invalid studio session id' }, 400)

            const argv = [agentlineCli(), 'studio', action, '--repo', project, '--id', id]
            if (action === 'new') {
              const title = String((body && body.title) || '').trim()
              const input = String((body && body.input) || '').trim()
              if (!input) return sendJson(res, { ok: false, error: 'new requires input' }, 400)
              if (title) argv.push('--title', title)
              argv.push('--input', input)
            }
            if (action === 'answer') {
              const question = String((body && body.question) || '').trim()
              const decision = String((body && body.decision) || '').trim()
              const text = String((body && body.text) || '').trim()
              const adoptDefault = !!(body && body.default === true)
              if (!!question === !!decision) return sendJson(res, { ok: false, error: 'answer requires exactly one of question|decision' }, 400)
              if (adoptDefault && text) return sendJson(res, { ok: false, error: 'text and default are mutually exclusive' }, 400)
              if (!adoptDefault && !text) return sendJson(res, { ok: false, error: 'answer requires text or default' }, 400)
              if (question) argv.push('--question', question)
              if (decision) argv.push('--decision', decision)
              if (text) argv.push('--text', text)
              argv.push('--channel', 'ui')
              if (adoptDefault) argv.push('--default')
            }

            const child = spawn(nodeBin(), argv, { cwd: agentlineHome(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
            let out = ''
            child.stdout.on('data', (d) => { out += d.toString() })
            child.stderr.on('data', (d) => { out += d.toString() })
            const code = await new Promise((resolve) => {
              const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolve(124) }, 600_000)
              child.on('close', (c) => { clearTimeout(timer); resolve(c ?? -1) })
            })
            logPlugin(`studio ${action} ${project}#${id} -> code=${code}`)
            return sendJson(res, { ok: code === 0, code, output: out.slice(-4000) })
          }

          if (req.method && req.method !== 'GET') return sendJson(res, { ok: false, error: 'GET or POST only' }, 405)
          const queryProject = projectDirOrNull(u.searchParams.get('project'))
          if (!queryProject) return sendJson(res, { ok: false, error: 'project not found' }, 400)
          const id = u.searchParams.get('id')
          if (id && !studioMod.isValidSessionId(id)) {
            return sendJson(res, { ok: false, error: 'invalid studio session id' }, 400)
          }
          const cfgMod = await importFresh(path.join(agentlineHome(), 'lib', 'config.mjs'))
          const loaded = cfgMod.loadConfig({ orchestratorRoot: agentlineHome(), repo: queryProject })
          const roles = studioMod.readStudioRoles(loaded.config, readJsonFile(path.join(queryProject, '.collab', 'agentline.json')) || {})
          if (!id) {
            return sendJson(res, { ok: true, project: queryProject, sessions: studioMod.listSessions(queryProject), roles })
          }
          const detail = studioMod.readStudio(queryProject, id)
          if (detail.state !== 'ok') {
            return sendJson(res, {
              ok: false, state: detail.state, project: queryProject, id,
              error: (detail.errors || []).join('; ') || `studio session ${id} is ${detail.state}`,
            })
          }
          sendJson(res, { ok: true, project: queryProject, id, ...detail, g0: studioMod.evaluateG0(queryProject, id), roles })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e) }, 500) }
      })

      // Blueprint 控制面。读取走 lib/blueprint.mjs；写操作每次只转发一条公开 CLI。
      route('/agentline/blueprint', 'agentline: blueprint', async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://localhost')
          const bp = await importFresh(path.join(agentlineHome(), 'lib', 'blueprint.mjs'))

          if (req.method === 'POST') {
            const body = await readBody(req)
            const action = String((body && body.action) || '')
            const id = String((body && body.id) || '')
            const project = projectDirOrNull((body && body.project) || u.searchParams.get('project'))
            if (!project) return sendJson(res, { ok: false, error: 'project not found' }, 400)
            if (!['new', 'run', 'review', 'approve', 'materialize'].includes(action)) return sendJson(res, { ok: false, error: 'unknown blueprint action' }, 400)
            if (!bp.isValidSessionId(id)) return sendJson(res, { ok: false, error: 'invalid blueprint session id' }, 400)

            const argv = [agentlineCli(), 'blueprint', action, '--repo', project, '--id', id]
            if (action === 'new') {
              const title = String((body && body.title) || '').trim()
              const input = String((body && body.input) || '').trim()
              const fromStudio = String((body && body.fromStudio) || '').trim()
              if (!input) return sendJson(res, { ok: false, error: 'new requires input' }, 400)
              if (title) argv.push('--title', title)
              argv.push('--input', input)
              if (fromStudio) argv.push('--from-studio', fromStudio)
            }
            if (action === 'approve') {
              const text = String((body && body.text) || '').trim()
              if (!text) return sendJson(res, { ok: false, error: 'approve requires text' }, 400)
              argv.push('--text', text, '--channel', 'ui')
            }
            if (action === 'materialize' && body && body.dryRun === true) argv.push('--dry-run')

            const child = spawn(nodeBin(), argv, { cwd: agentlineHome(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
            let out = ''
            child.stdout.on('data', (d) => { out += d.toString() })
            child.stderr.on('data', (d) => { out += d.toString() })
            const code = await new Promise((resolve) => {
              const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolve(124) }, 600_000)
              child.on('close', (c) => { clearTimeout(timer); resolve(c ?? -1) })
            })
            logPlugin(`blueprint ${action} ${project}#${id} -> code=${code}`)
            return sendJson(res, { ok: code === 0, code, output: out.slice(-4000) })
          }

          if (req.method && req.method !== 'GET') return sendJson(res, { ok: false, error: 'GET or POST only' }, 405)
          const queryProject = projectDirOrNull(u.searchParams.get('project'))
          if (!queryProject) return sendJson(res, { ok: false, error: 'project not found' }, 400)
          const id = u.searchParams.get('id')
          if (id && !bp.isValidSessionId(id)) return sendJson(res, { ok: false, error: 'invalid blueprint session id' }, 400)
          if (!id) {
            return sendJson(res, { ok: true, project: queryProject, sessions: bp.listSessions(queryProject) })
          }
          const detail = bp.readBlueprint(queryProject, id)
          if (detail.state !== 'ok') {
            return sendJson(res, {
              ok: false, state: detail.state, project: queryProject, id,
              error: (detail.errors || []).join('; ') || `blueprint session ${id} is ${detail.state}`,
            })
          }
          const g1 = bp.evaluateG1(queryProject, id)
          const next = bp.decide(detail.session, g1)
          const last = (detail.reviews || [])[(detail.reviews || []).length - 1]
          const findings = last && last.value && Array.isArray(last.value.findings) ? last.value.findings : []
          sendJson(res, { ok: true, project: queryProject, id, ...detail, g1, next, findings })
        } catch (e) { sendJson(res, { ok: false, error: String(e.message || e) }, 500) }
      })

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
    })
  } catch (e) {
    logPlugin('route registration failed: ' + e.message)
    try { ctx.logger?.warn?.('[agentline] route registration failed: ' + e.message) } catch { /* ignore */ }
  }

  // ---- 斜杠命令 ----
  try {
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.effect(() => commandCtx.commands.register({
        name: 'agentline',
        description: '在当前工作区派活给 AgentLine（多模型 design→dev→CI→review 闭环）',
        input: { hint: '<目标>；不给目标则显示状态' },
        async handler(invocation) {
          logInvocationShape(invocation)
          const { path: explicit, rest: goal } = explicitProject(invocation?.rawInput)
          const wsPath = explicit || workspaceFromHeader(invocation)

          // 有了可靠路径：直接建任务 + 起 flow，并把结果注入对话（命令返回值这个版本不渲染）
          if (wsPath) {
            let reply = ""
            try {
              fs.mkdirSync(path.join(wsPath, ".collab"), { recursive: true })
              fs.writeFileSync(path.join(wsPath, ".collab", "agentline.json"), JSON.stringify({ enabled: true, at: new Date().toISOString(), goal: goal || null }, null, 2), "utf8")
              if (!goal) {
                const tasks = listTasks(wsPath)
                let running = 0
                for (const tk of tasks) { if (fs.existsSync(path.join(wsPath, ".collab", "tasks", tk.id, "live.json"))) running++ }
                reply = `AgentLine @ ${wsPath}：任务 ${tasks.length} 个，正在跑 ${running} 个。用法：/agentline <目标>`
              } else if (!fs.existsSync(path.join(wsPath, ".git"))) {
                reply = `已定位工作区 ${wsPath}，但它不是 git 仓库（缺 .git），无法建分支。先 git init 再重试。`
              } else {
                let ids = []
                try { ids = fs.readdirSync(path.join(wsPath, ".collab", "tasks")).filter((d) => /^\d+$/.test(d)).map(Number) } catch { /* none */ }
                const next = String((ids.length ? Math.max(...ids) : 0) + 1).padStart(3, "0")
                const dir = path.join(wsPath, ".collab", "tasks", next)
                fs.mkdirSync(dir, { recursive: true })
                const brief = [`# Task ${next} — ${goal.split("\n")[0].slice(0, 80)}`, "", "## 目标", goal, "", "## 约束", "- 改动聚焦本目标，不修改无关文件。", "- 不删除既有测试；新增或调整测试需在 impl.md 说明等价性。", "", "## 验收方向（设计角色细化为可执行命令）", "1. 项目现有测试全绿（有测试框架时）；", "2. 新行为有对应测试；", "3. 构建与 lint 通过（项目提供时）；", "4. 若项目有 docs/，在 docs/ 追加一节记录本轮改动。", ""].join("\n")
                fs.writeFileSync(path.join(dir, "brief.md"), brief, "utf8")
                const job = startFlow(wsPath, next, 2, {
                  origin: { sessionId: sessionIdOf(invocation.agent), agent: invocation.agent, via: 'command' },
                })
                logPlugin(`/agentline task ${next} started: ${job.id} @ ${wsPath}`)
                reply = `已派活：task ${next} @ ${wsPath}（job ${job.id}）\n任务结束时会回到这个对话框给你总结；过程可在左侧 AgentLine 驾驶舱观察。`
              }
            } catch (e) {
              reply = `AgentLine 启动失败：${e && e.message ? e.message : String(e)}`
              logPlugin("command action failed: " + (e && e.message ? e.message : String(e)))
            }
            await injectDirective(invocation, `请把下面这条 AgentLine 结果原样告诉用户，不要补充其它内容：\n\n${reply}`)
            return { kind: "success", text: reply }
          }

          // 拿不到路径：让模型自己 pwd 后调工具
          const directive = goal
            ? [`用 AgentLine 完成这个目标：${goal}`, "", "步骤：", "1) 跑 pwsh 的 pwd 取当前工作区绝对路径；", "2) 调 agentline_status(project=<路径>) 看现有任务，得到下一个编号；", "3) 在 <路径>/.collab/tasks/<编号>/brief.md 写目标与约束；", "4) 调 agentline_flow(project=<路径>, task=<编号>) 启动；", "5) 告诉用户已启动，可在左侧 AgentLine 驾驶舱观察。"].join("\n")
            : ["用 AgentLine 报告当前状态：跑 pwsh 的 pwd 取工作区路径，再调 agentline_status(project=<路径>)，用一两句话告诉用户任务数与是否有正在跑的。"].join("\n")
          const injected = await injectDirective(invocation, directive)
          return { kind: "success", text: injected ? "已转交 AgentLine" : "无法注入消息：" + directive.slice(0, 100) }
        },
      }), 'agentline: /agentline command')
    })
  } catch (e) {
    logPlugin('command registration failed: ' + e.message)
  }

  // ---- 工具 ----（必须 inject，直接 registerTools(ctx) 会拿不到 ctx.tools）
  try {
    ctx.inject(['tools'], (toolCtx) => {
      registerTools(toolCtx).catch((e) => logPlugin('tool registration failed: ' + (e && e.message ? e.message : String(e))))
    })
  } catch (e) {
    logPlugin('tools inject failed: ' + (e && e.message))
  }

  // ---- 结束通知补投：DSH 重启前跑完 / 漏掉 exit 事件的任务，仍能把总结送回对话框 ----
  const sweepNow = () => sweepOrigins().catch((e) => logPlugin('sweep failed: ' + (e && e.message ? e.message : String(e))))
  setTimeout(sweepNow, 6000)
  const sweepTimer = setInterval(sweepNow, 60_000)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
  try { ctx.effect(() => () => clearInterval(sweepTimer), 'agentline: notice sweep') } catch { /* ignore */ }
}

async function registerTools(ctx) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') { logPlugin('no ctx.tools.register'); return }
  let defineTool = null
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
    logPlugin('dsh-tools import ok, defineTool=' + !!defineTool)
  } catch (e) {
    logPlugin('dsh-tools import failed: ' + (e && e.message))
  }
  const wrap = (spec) => (defineTool ? defineTool(spec) : spec)

  ctx.tools.register(wrap({
    name: 'agentline_metrics',
    description: '读取四个额度池的实时用量：Claude 5h/7d 窗口百分比、Codex 周额度、Buddy 积分、DeepSeek 余额。',
    parameters: {},
    output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: (value.lines || []).join('\n') }],
    },
    async execute() {
      const data = await metrics(true)
      const lines = data.records.map((r) => `${r.ok ? 'OK' : 'FAIL'} ${r.source}/${r.key} = ${r.ok ? r.value + ' ' + (r.unit || '') : r.error}`)
      return { ok: true, updated_at: data.updated_at, lines, records: data.records }
    },
  }))

  ctx.tools.register(wrap({
    name: 'agentline_status',
    description: '查看某个项目（DSH 工作区）的 AgentLine 任务状态；不传 task 时列出全部任务与 token 汇总。',
    parameters: {
      task: { type: 'string', description: '任务号，例如 004；省略则列出全部' },
      project: { type: 'string', description: '项目根目录（DSH 工作区路径）；省略用默认项目' },
    },
    output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.state
              ? `task ${value.task} @ ${path.basename(value.project || '')}: ${value.state.status} (model=${value.state.model || '-'})`
              : value.legacy
                ? `task ${value.task} @ ${path.basename(value.project || '')}: legacy（无 state.json；${(value.artifacts || []).length} 个历史文件）`
                : `${(value.tasks || []).length} task(s) @ ${path.basename(value.project || '')}; token input=${value.tokens?.total?.input ?? 0}`)
          : `error: ${value.error}`,
      }],
    },
    async execute(args) {
      const project = resolveProject(args && args.project)
      if (args && args.task) {
        const st = readState(project, String(args.task))
        if (st) return { ok: true, project, task: String(args.task), state: st }
        // 状态机之前手工跑的任务没有 state.json：列出证据文件，而不是直接报错
        const dir = taskDirOf(project, String(args.task))
        if (fs.existsSync(dir)) {
          let artifacts = []
          try { artifacts = fs.readdirSync(dir).filter((f) => { try { return fs.statSync(path.join(dir, f)).isFile() } catch { return false } }) } catch { /* ignore */ }
          return { ok: true, project, task: String(args.task), legacy: true, artifacts, note: '该任务在引入 state.json 之前执行：文件是唯一证据，可跑一次 backfill 补录' }
        }
        return { ok: false, project, error: `no state.json for task ${args.task}` }
      }
      const { aggregateTokens } = await loadCollector()
      return { ok: true, project, tasks: listTasks(project), tokens: aggregateTokens(project) }
    },
  }))

  ctx.tools.register(wrap({
    name: 'agentline_flow',
    description: '为某个项目的任务启动完整闭环（design → dev → CI → review → pr_open）。后台执行，立即返回 jobId。合并需人类许可。',
    parameters: {
      task: { type: 'string', required: true, description: '任务号' },
      project: { type: 'string', description: '项目根目录（DSH 工作区路径）；省略用默认项目' },
      max_rounds: { type: 'number', description: '评审最多轮次，默认 2' },
    },
    output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `flow started: ${value.job?.id} (pid ${value.job?.pid}) @ ${path.basename(value.job?.project || '')} — 结束后会回到本对话给总结`
          : `error: ${value.error}`,
      }],
    },
    async execute(args, exec) {
      if (!args || !args.task) return { ok: false, error: 'task is required' }
      const project = resolveProject(args.project)
      const agent = exec && exec.agent
      return {
        ok: true,
        job: startFlow(project, String(args.task), Number(args.max_rounds || 2), {
          origin: { sessionId: sessionIdOf(agent), agent, via: 'tool' },
        }),
      }
    },
  }))
}


export const Config = z.object({
  agentlineHome: z.string().default(DEFAULT_AGENTLINE_HOME).volatile()
    .description('AgentLine orchestrator 目录（包含 agentline.mjs）'),
  nodePath: z.string().default('').volatile()
    .description('运行 AgentLine CLI 的 Node 可执行文件；留空使用当前 DSH 的 Node'),
  defaultRepo: z.string().default('').volatile()
    .description('默认项目仓库路径；留空使用当前工作区'),
  metricsEnabled: z.boolean().default(true).volatile()
    .description('是否在驾驶舱显示额度用量'),
  deepseekApiKey: z.string().role('secret').default('').volatile()
    .description('DeepSeek API Key（仅用于余额查询；留空回退环境变量/本机凭据）'),
  claudeAccessToken: z.string().role('secret').default('').volatile()
    .description('Claude OAuth access token（可选；留空读取本机 ~/.claude）'),
  codexAccessToken: z.string().role('secret').default('').volatile()
    .description('Codex access token（可选；留空读取本机 ~/.codex）'),
  codexAccountId: z.string().default('').volatile()
    .description('Codex account id（配合 access token）'),
  buddyAccessToken: z.string().role('secret').default('').volatile()
    .description('Buddy / CodeBuddy access token（可选；留空读取本机快照）'),
  buddyUserId: z.string().default('').volatile()
    .description('Buddy user id（配合 access token）'),
})

export const name = 'agentline'

// 供本地测试与排查使用；不影响宿主加载
export { deliverSummary, sweepOrigins, sessionIdOf, noticeKey }




























