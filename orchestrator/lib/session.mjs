/**
 * session.mjs — 角色级 CLI 会话复用（AgentLine 侧）
 *
 * 协议见 CLIWorker 的 SESSION-MANAGEMENT.md：
 * - CLIWorker 只声明 start/resume 与失效条件，不持有 session；
 * - AgentLine 保存 session、决定何时 resume、何时新建、按角色隔离。
 *
 * 落盘约定：
 * - 当前会话记录：`<taskDir>/sessions/<role>.json`（只在任务目录内，明文 session id 只在这里）；
 * - `run.json` / 日志只写 `sha256:` 引用（token_ref），不写明文；
 * - `sessions/.gitignore` 让会话文件不进入任务分支的 git 历史。
 *
 * 失效条件（六类）：模型变化、provider 变化、CLI 版本变化、过期、
 * 上次 resume 失败、review 新轮次。命中任一条件时旧记录先被标记，再新建会话。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { diffText, latestProductDiff } from './git.mjs'

export const SESSION_SCHEMA = 'agentline.session/v1'
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const SESSION_STATES = Object.freeze(['active', 'expired', 'invalidated'])

/** 角色级 session 策略（与协议一致）：design/dev 跨轮复用，review 每轮新建。 */
export const ROLE_SESSION_POLICY = Object.freeze({
  design: 'reuse',
  dev: 'reuse',
  review: 'new_each_round',
})

/** invalidated_reason / run.json session.invalidated_reason 的取值。 */
export const REASON = Object.freeze({
  MODEL_CHANGED: 'model_changed',
  PROVIDER_CHANGED: 'provider_changed',
  CLI_VERSION_CHANGED: 'cli_version_changed',
  EXPIRED: 'expired',
  RESUME_FAILED: 'resume_failed',
  REVIEW_NEW_ROUND: 'review_new_round',
  UNSUPPORTED: 'session_unsupported',
  DISABLED: 'session_reuse_disabled',
  ID_MISSING: 'session_id_missing',
  ROLE_UNSUPPORTED: 'role_unsupported',
})

const INVALIDATING_REASONS = new Set([
  REASON.MODEL_CHANGED,
  REASON.PROVIDER_CHANGED,
  REASON.CLI_VERSION_CHANGED,
  REASON.EXPIRED,
  REASON.RESUME_FAILED,
  REASON.REVIEW_NEW_ROUND,
])

/** 只有真正「会话不存在/已过期」的失败才值得当场换新会话；限流/超时不算。 */
const SESSION_DEAD_RE = /(?:not found|no such|does not exist|expired|invalid session|unknown session|cannot resume|could not resume|resume failed)/i

export function sessionDir(taskDir) { return path.join(taskDir, 'sessions') }
export function sessionFile(taskDir, role) { return path.join(sessionDir(taskDir), `${role}.json`) }

/** 会话文件不进入 git：否则明文 session id 会留在任务分支历史里。 */
function ensureIgnored(dir) {
  const file = path.join(dir, '.gitignore')
  if (fs.existsSync(file)) return
  try { fs.writeFileSync(file, '*\n!.gitignore\n', 'utf8') } catch { /* best effort */ }
}

export function readSession(taskDir, role) {
  try {
    const value = JSON.parse(fs.readFileSync(sessionFile(taskDir, role), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch { return null }
}

/** 原子写入：先写 .tmp 再 rename，失败时不留下半截记录。 */
export function writeSession(taskDir, role, record) {
  const dir = sessionDir(taskDir)
  fs.mkdirSync(dir, { recursive: true })
  ensureIgnored(dir)
  const target = path.join(dir, `${role}.json`)
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, target)
  return record
}

/** 明文 token 只用于调用 provider；对外/日志只暴露这个哈希引用。 */
export function tokenRef(token) {
  const value = typeof token === 'string' ? token.trim() : ''
  if (!value) return null
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}`
}

/** provider 是否声明并实现了 session resume。两个条件都满足才允许传 resume 参数。 */
export function isSessionSupported(adapter) {
  return Boolean(
    adapter
    && adapter.capabilities
    && adapter.capabilities.session_resume === true
    && typeof adapter.resumeArgs === 'function'
    && adapter.capabilities.session
    && adapter.capabilities.session.id_from,
  )
}

/**
 * 从 provider 输出里取 session id（协议 id_from=stdout_json + id_path）。
 * 支持逐行 JSON（stream-json / --json）和整段 JSON 两种形态。
 */
export function extractSessionId(adapter, result) {
  const meta = adapter && adapter.capabilities && adapter.capabilities.session
  if (!meta || meta.id_from !== 'stdout_json') return null
  const keys = String(meta.id_path || 'session_id').split('.')
  const pick = (value) => keys.reduce((cur, key) => (cur && typeof cur === 'object' ? cur[key] : undefined), value)
  const stdout = String(result && result.stdout != null ? result.stdout : '')
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    let event
    try { event = JSON.parse(text) } catch { continue }
    const id = pick(event)
    if (typeof id === 'string' && id.trim()) return id.trim()
  }
  try {
    const id = pick(JSON.parse(stdout.trim()))
    if (typeof id === 'string' && id.trim()) return id.trim()
  } catch { /* not a single JSON document */ }
  return null
}

function start(reason) { return { action: 'start', reason: reason || null } }

/**
 * 复用决策（纯函数，固定时钟可测）。顺序固定：
 * 角色策略 → 记录状态 → 上次 resume 失败 → 模型 → provider → CLI 版本 → 过期。
 */
export function decideSession({
  role, record = null, modelKey = null, modelId = null, provider = null,
  cliVersion = null, now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS,
} = {}) {
  const policy = ROLE_SESSION_POLICY[role]
  if (!policy) return start(REASON.ROLE_UNSUPPORTED)
  if (policy === 'new_each_round') return start(record ? REASON.REVIEW_NEW_ROUND : null)
  if (!record) return start(null)
  if (record.state === 'expired') return start(record.invalidated_reason || REASON.EXPIRED)
  if (record.state === 'invalidated') return start(record.invalidated_reason || 'invalidated')
  if (record.state !== 'active') return start('inactive')
  if (!record.session_token) return start(REASON.ID_MISSING)
  if (record.last_resume_error) return start(REASON.RESUME_FAILED)
  if (modelKey != null && record.model_key != null && String(record.model_key) !== String(modelKey)) return start(REASON.MODEL_CHANGED)
  if (modelId != null && record.model_id != null && String(record.model_id) !== String(modelId)) return start(REASON.MODEL_CHANGED)
  if (provider != null && record.provider != null && String(record.provider) !== String(provider)) return start(REASON.PROVIDER_CHANGED)
  if (cliVersion && record.cli_version && String(record.cli_version) !== String(cliVersion)) return start(REASON.CLI_VERSION_CHANGED)
  const stamp = Date.parse(record.last_used_at || record.created_at || '')
  if (!Number.isFinite(stamp) || Number(now) - stamp > ttlMs) return start(REASON.EXPIRED)
  return { action: 'resume', reason: null }
}

export function isInvalidatingReason(reason) { return INVALIDATING_REASONS.has(reason) }

/** 旧记录的最小归档（只保留引用，不保留明文 token）。 */
export function previousEntry(record) {
  if (!record) return null
  return {
    session_token_ref: record.token_ref || tokenRef(record.session_token),
    state: record.state || 'unknown',
    invalidated_reason: record.invalidated_reason || null,
    invalidated_at: record.invalidated_at || null,
    created_at: record.created_at || null,
    last_used_at: record.last_used_at || null,
    model_key: record.model_key || null,
    provider: record.provider || null,
    cli_version: record.cli_version || null,
  }
}

/** 把旧记录标记为 expired/invalidated；记录不存在时返回 null。 */
export function markSession(taskDir, role, {
  state = 'invalidated', reason = null, at = new Date().toISOString(), error = null,
} = {}) {
  const current = readSession(taskDir, role)
  if (!current) return null
  const next = {
    ...current,
    state,
    invalidated_reason: reason,
    invalidated_at: at,
    last_resume_error: error == null ? (current.last_resume_error || null) : error,
  }
  return writeSession(taskDir, role, next)
}

export function buildSessionRecord({
  taskId, role, modelKey, modelId, provider, cliVersion, token = null,
  round = null, nowIso = new Date().toISOString(), createdAt = null,
  previous = [], invalidatedReason = null,
} = {}) {
  const active = typeof token === 'string' && token.trim() !== ''
  return {
    schema: SESSION_SCHEMA,
    task: taskId,
    role,
    provider: provider || null,
    model_key: modelKey || null,
    model_id: modelId || null,
    cli_version: cliVersion || null,
    session_token: active ? token.trim() : null,
    token_ref: active ? tokenRef(token) : null,
    created_at: createdAt || nowIso,
    last_used_at: nowIso,
    state: active ? 'active' : 'invalidated',
    invalidated_reason: active ? null : (invalidatedReason || REASON.ID_MISSING),
    invalidated_at: active ? null : nowIso,
    last_resume_error: null,
    round,
    ...(previous && previous.filter(Boolean).length ? { previous: previous.filter(Boolean).slice(-3) } : {}),
  }
}

/**
 * 单次角色调用的 session 计划：读记录、检查六类失效条件、必要时先把旧记录标记失效。
 * 返回 { supported, prior, cliVersion, action, invalidatedReason, resumeToken, previous }。
 */
export async function prepareSession({
  adapter, taskDir, role, model, provider, policy = {}, now = Date.now(),
} = {}) {
  const prior = readSession(taskDir, role)
  const supported = isSessionSupported(adapter)
  const reuseEnabled = policy.sessionReuse !== false
  const ttlMs = Number(policy.sessionTtlMinutes) > 0
    ? Number(policy.sessionTtlMinutes) * 60_000
    : DEFAULT_SESSION_TTL_MS

  if (!supported || !reuseEnabled) {
    return {
      supported,
      reuseEnabled,
      prior,
      cliVersion: null,
      action: 'start',
      invalidatedReason: supported ? REASON.DISABLED : REASON.UNSUPPORTED,
      resumeToken: null,
      previous: [],
    }
  }

  const cliVersion = await readAdapterVersion(adapter)
  const decision = decideSession({
    role, record: prior, modelKey: model.key, modelId: model.id,
    provider: model.provider, cliVersion, now, ttlMs,
  })

  const previous = []
  if (decision.action === 'start' && prior && isInvalidatingReason(decision.reason)) {
    const at = new Date(Number(now)).toISOString()
    const state = decision.reason === REASON.EXPIRED ? 'expired' : 'invalidated'
    const marked = markSession(taskDir, role, { state, reason: decision.reason, at })
    if (marked) previous.push(previousEntry(marked))
  }

  return {
    supported,
    reuseEnabled,
    prior,
    cliVersion,
    action: decision.action,
    invalidatedReason: decision.reason || null,
    resumeToken: decision.action === 'resume' && prior ? prior.session_token : null,
    previous,
  }
}

export async function readAdapterVersion(adapter) {
  if (!adapter || typeof adapter.version !== 'function') return null
  try {
    const version = await adapter.version()
    return typeof version === 'string' && version.trim() ? version.trim() : null
  } catch { return null }
}

export function isSessionDeadError(error) {
  return SESSION_DEAD_RE.test(String(error || ''))
}

/** provider 的报错里偶尔会回显 session id；落盘/上日志前先抹掉。 */
export function redactToken(text, token) {
  const value = typeof token === 'string' ? token : ''
  if (!value) return text
  return String(text == null ? '' : text).split(value).join('***')
}

/**
 * 把日志文件里的 session id 替换成 ***。
 * CLI 的 stream-json/--json 原样回显 session_id，日志与交班单会引用日志尾部，
 * 因此调用结束后必须清理，避免明文 token 进入任务分支的 git 历史。
 */
export function redactFileSecrets(file, secrets = []) {
  if (!file) return 0
  const values = [...new Set(secrets.filter((s) => typeof s === 'string' && s.trim().length >= 4))]
  if (!values.length) return 0
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return 0 }
  let hits = 0
  for (const value of values) {
    const parts = text.split(value)
    if (parts.length > 1) {
      hits += parts.length - 1
      text = parts.join('***')
    }
  }
  if (hits) {
    try { fs.writeFileSync(file, text, 'utf8') } catch { return 0 }
  }
  return hits
}

function roundOf(name) {
  const match = String(name).match(/verdict-r(\d+)\.json$/)
  return match ? Number(match[1]) : 0
}

function latestVerdict(dir) {
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => /^verdict(-r\d+)?\.json$/.test(n)) } catch { return null }
  if (!names.length) return null
  names.sort((a, b) => roundOf(b) - roundOf(a))
  try { return JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf8')) } catch { return null }
}

function clip(text, max) {
  const value = String(text == null ? '' : text).trim()
  if (!value) return ''
  return value.length <= max ? value : `${value.slice(0, max)}\n…（已截断）`
}

/**
 * 从任务目录现有产物提取续接摘要（不做智能压缩）：
 * design：design.md + acceptance.md 节选；dev：impl.md 尾部 + 上一轮 verdict。
 */
export function artifactSummary(dir, role) {
  const read = (name) => {
    try { return fs.readFileSync(path.join(dir, name), 'utf8') } catch { return '' }
  }
  const parts = []
  if (role === 'design') {
    const design = read('design.md')
    if (design) parts.push(`design.md（上一轮结论，节选）：\n${clip(design, 1600)}`)
    const acceptance = read('acceptance.md')
    if (acceptance) parts.push(`acceptance.md（节选）：\n${clip(acceptance, 1000)}`)
  } else if (role === 'dev') {
    const impl = read('impl.md')
    if (impl) parts.push(`impl.md（上一轮实现说明，节选）：\n${clip(impl.slice(-2400), 1600)}`)
    const verdict = latestVerdict(dir)
    if (verdict) parts.push(`上一轮评审结论：\n${clip(JSON.stringify(verdict, null, 2), 1600)}`)
  }
  return parts.join('\n\n')
}

/** 复用会话时的增量输入：上一轮结论 + 本轮/最近一次业务代码 diff。 */
export async function collectIncrementalInput({ repo, dir, role, maxChars = 4000 } = {}) {
  const summary = artifactSummary(dir, role)
  const half = Math.max(400, Math.floor(maxChars / 2))
  let diff = ''
  try { diff = await diffText(repo, half) } catch { diff = '' }
  if (!diff) {
    try { diff = await latestProductDiff(repo, half) } catch { diff = '' }
  }
  return { summary, diff }
}
