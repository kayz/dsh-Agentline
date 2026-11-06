/**
 * studio.mjs — Studio 控制面（P6）
 *
 * 唯一状态来源：`<repo>/.collab/studio/<id>/session.json`
 * 关联证据：questions.json / decisions.json / confirmations/*.json / minutes-final.md
 *
 * 规则（见 .collab/tasks/003/design.md）：
 *   - `run` 每次只执行一个角色调用，落盘后返回；
 *   - 主持产生 open blocking 问题时停在 awaiting_user，`answer` 记录用户动作后才继续；
 *   - 专家确认只能来自对应专家的独立调用；
 *   - G0 每次都从落盘证据重新计算，不缓存通过结果。
 */
import fs from 'node:fs'
import path from 'node:path'

import { getAdapter } from './adapters/index.mjs'
import { clampEffort } from './exec.mjs'
import { GATE_SCHEMA, evaluateGate, sha256Content } from './contracts/gate.mjs'
import { isRoleEligible, normalizeModel } from './model-catalog.mjs'

export const STUDIO_DIR = '.collab/studio'
export const STUDIO_ROLES = ['expert_a', 'expert_b', 'expert_c', 'moderator', 'scribe']
export const EXPERTS = ['expert_a', 'expert_b', 'expert_c']
export const STEPS = ['expert_a', 'expert_b', 'expert_c', 'moderator', 'scribe', 'confirm_a', 'confirm_b', 'confirm_c']
export const CONFIRM_TARGET = { confirm_a: 'expert_a', confirm_b: 'expert_b', confirm_c: 'expert_c' }

/**
 * 轮次恰好为 2 时，确认步骤只是对已落盘证据的独立表态，不产生新一轮。
 * 轮次已经超过 2，或无法证明仍有额度时，确认也不再执行。
 */
function isConfirmStep(step) { return !!CONFIRM_TARGET[step] }

/** 下一步是否还会开启新的讨论轮次（done 与确认步骤都不算）。 */
function startsDiscussionRound(session) {
  const step = currentStep(session)
  return step !== 'done' && !isConfirmStep(step)
}

export const ROLE_LABEL = {
  expert_a: '专家 A', expert_b: '专家 B', expert_c: '专家 C', moderator: '主持', scribe: '书记',
}
export const TIER_REQUIRED = {
  expert_a: 'top', expert_b: 'top', expert_c: 'top', moderator: 'top', scribe: 'advanced',
}
export const STUDIO_SCHEMA = 'agentline.studio/v1'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 只读讨论：能强制到只读模式的 adapter 及其参数。
 * 这些参数覆盖 provider.options，只影响 Studio 调用，不改变 flow 的既有语义。
 */
const READONLY_ADAPTER_OPTIONS = {
  'claude-cli': { permissionMode: 'plan', allowedTools: ['Read'] },
  'codebuddy-cli': { permissionMode: 'plan' },
  'codex-cli': { sandbox: 'read-only', approvalPolicy: 'never' },
}

/**
 * 返回一个只读的 provider 副本；无法保证只读时返回 null。
 *
 * 只认 adapter 能钉死的只读模式：声明 `capabilities.readonly_mode=true` 只是意愿，
 * 不能证明实际参数只读（例如 Codex 默认 `sandbox=workspace-write`），所以声明不会被
 * 当作放行条件；能强制只读的 adapter 一律覆盖 provider.options。声明 false 或没有
 * 已知只读模式的渠道直接拒绝。
 */
export function readonlyProvider(provider) {
  if (!provider || typeof provider !== 'object') return null
  if (provider.capabilities?.readonly_mode === false) return null
  const forced = READONLY_ADAPTER_OPTIONS[provider.adapter]
  if (!forced || !Object.keys(forced).length) return null
  return {
    ...provider,
    options: { ...(provider.options || {}), ...forced },
    capabilities: { ...(provider.capabilities || {}), readonly_mode: true },
  }
}

export function assertReadonlyProvider(provider, label) {
  const ro = readonlyProvider(provider)
  if (!ro) {
    throw new StudioError(
      'E_READONLY_UNAVAILABLE',
      `provider ${label} cannot guarantee a read-only Studio conversation` +
      '（需要 adapter 支持强制只读模式，如 claude-cli/codebuddy-cli/codex-cli；' +
      'capabilities.readonly_mode=false 一律拒绝）',
    )
  }
  return ro
}

export class StudioError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StudioError'
    this.code = code
  }
}

export function isValidSessionId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return false
  if (id === '.' || id === '..') return false
  return true
}

export function assertSessionId(id) {
  if (!isValidSessionId(id)) {
    throw new StudioError('E_SESSION_ID', `invalid studio session id: ${JSON.stringify(id)} (single safe path segment required)`)
  }
}

export function studioRoot(repo) { return path.join(repo, STUDIO_DIR) }

export function sessionDir(repo, id) {
  assertSessionId(id)
  return path.join(studioRoot(repo), id)
}

function readJson(file) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) } } catch (e) {
    return { ok: false, value: null, error: e.message }
  }
}

function readText(file) {
  try { return { ok: true, value: fs.readFileSync(file, 'utf8') } } catch { return { ok: false, value: null } }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function nowIso() { return new Date().toISOString() }

// ───────────────────────────── 角色配置 ─────────────────────────────

function roleList(config, projectCfg, role) {
  const fromProject = projectCfg?.studio?.roles?.[role]
  const fromConfig = config?.studio?.roles?.[role]
  const raw = fromProject !== undefined ? fromProject : fromConfig
  if (Array.isArray(raw)) return raw.filter((k) => typeof k === 'string' && k)
  if (typeof raw === 'string' && raw) return [raw]
  return []
}

function tierOk(role, model) {
  const need = TIER_REQUIRED[role]
  const tier = model?.tier
  if (role === 'scribe') return tier === 'advanced' || tier === 'top'
  return tier === need
}

/**
 * 角色资格与目录一致：必须 callable，身份必须 verified，档位必须满足。
 * discovered / unknown / unverified 以及未验证身份都不能担任 Studio 角色。
 * 书记允许 advanced 或 top；专家与主持只允许 top。
 */
function eligibilityFor(role, key, model) {
  const entry = normalizeModel({
    key,
    provider: model?.provider,
    id: model?.id || key,
    tier: model?.tier,
    identity: model?.identity,
    availability: model?.availability,
    source: model?.source,
  })
  if (role === 'scribe') {
    const asAdvanced = isRoleEligible(entry, { tier: 'advanced' })
    if (asAdvanced.ok) return asAdvanced
    const asTop = isRoleEligible(entry, { tier: 'top' })
    if (asTop.ok) return asTop
    if (asAdvanced.reason === 'invalid' || asAdvanced.reason === 'identity_unverified' || String(asAdvanced.reason || '').startsWith('unavailable:')) {
      return asAdvanced
    }
    return { ok: false, reason: `tier:${entry.tier || 'unknown'}, need advanced|top` }
  }
  return isRoleEligible(entry, { tier: TIER_REQUIRED[role] })
}

/**
 * 模型身份：以实际 model id 为准，配置键只是别名。
 * 两个不同键指向同一 provider/id 时仍是同一个模型，书记不能因此与主持重合。
 */
function modelRef(entry) {
  if (!entry || typeof entry !== 'object') return null
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  const key = typeof entry.model === 'string' ? entry.model.trim() : ''
  const name = id || key
  if (!name) return null
  const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
  return { name, provider, key }
}

/** 同一模型：配置键相同，或实际 id 相同；两边都写了 provider 时 id 相同还须 provider 一致。 */
function sameModelRef(a, b) {
  if (!a || !b) return false
  if (a.key && b.key && a.key === b.key) return true
  if (a.name !== b.name) return false
  if (a.provider && b.provider && a.provider !== b.provider) return false
  return true
}

function modelLabel(entry) {
  const ref = modelRef(entry)
  if (!ref) return 'unknown'
  return ref.provider ? `${ref.provider}:${ref.name}` : ref.name
}

/**
 * rounds_used 必须是明确的非负整数。
 * 缺失、字符串、小数和负数都不能证明"轮次 ≤ 2"，所以返回 null 而不是按 0 处理。
 */
function roundCount(record) {
  const v = record && typeof record === 'object' ? record.rounds_used : undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null
  return v
}

/** 轮次问题：`invalid` 表示无法证明，其余为超限的实际值；合格返回 null。 */
function roundsProblem(record) {
  const n = roundCount(record)
  if (n === null) return 'invalid'
  if (n > 2) return String(n)
  return null
}

function roundsExhausted(record) {
  const n = roundCount(record)
  return n === null || n >= 2
}

/**
 * 只读：把配置解析成 UI/CLI 共用的角色矩阵条目。
 * 不抛错；缺配置时 primary = null，由调用方决定是否允许启动会话。
 */
export function readStudioRoles(config = {}, projectCfg = {}) {
  const out = {}
  for (const role of STUDIO_ROLES) {
    const keys = roleList(config, projectCfg, role)
    const models = keys.filter((k) => config.models?.[k])
    const primary = models[0] || null
    out[role] = {
      role,
      tier: TIER_REQUIRED[role],
      primary,
      backups: models.slice(1),
      modelId: primary ? config.models[primary].id : null,
      constraint: role === 'scribe' ? 'scribe ≠ moderator' : (role === 'moderator' ? 'top；书记须与之不同' : 'top；独立调用'),
      tierOk: primary ? tierOk(role, config.models[primary]) : false,
      configured: !!primary,
    }
  }
  return out
}

function resolveRoles(config, projectCfg, overrides = {}) {
  const resolved = {}
  for (const role of STUDIO_ROLES) {
    const explicit = overrides[role]
    const keys = explicit ? [explicit] : roleList(config, projectCfg, role)
    if (!keys.length) {
      throw new StudioError('E_ROLE_UNSET', `studio role ${role} is not configured (set studio.roles.${role} or pass --${role.replace(/_/g, '-')})`)
    }
    let picked = null
    const reasons = []
    for (const key of keys) {
      const model = config.models?.[key]
      if (!model) { reasons.push(`${key}: unknown model`); continue }
      const eligible = eligibilityFor(role, key, model)
      if (!eligible.ok) { reasons.push(`${key}: ${eligible.reason}`); continue }
      const provider = config.providers?.[model.provider]
      if (!provider) { reasons.push(`${key}: provider ${model.provider} not configured`); continue }
      // 无法保证只读的渠道不能静默执行；换下一个候选也不会让它变好，但别的候选可能可以。
      if (!readonlyProvider(provider)) { reasons.push(`${key}: provider ${model.provider} cannot be forced read-only`); continue }
      picked = { key, model, provider }
      break
    }
    if (!picked) {
      throw new StudioError('E_ROLE_INELIGIBLE', `studio role ${role} has no eligible model: ${reasons.join('; ')}`)
    }
    resolved[role] = {
      model: picked.key,
      id: picked.model.id,
      tier: picked.model.tier || 'unknown',
      provider: picked.model.provider,
    }
  }
  if (sameModelRef(modelRef(resolved.scribe), modelRef(resolved.moderator))) {
    throw new StudioError(
      'E_SCRIBE_IS_MODERATOR',
      `scribe model must differ from moderator model (both are ${modelLabel(resolved.moderator)})`,
    )
  }
  return resolved
}

// ───────────────────────────── 读取 ─────────────────────────────

function sessionFile(dir) { return path.join(dir, 'session.json') }

function validSession(s) {
  return !!s && typeof s === 'object'
    && typeof s.id === 'string' && typeof s.status === 'string'
    && s.roles && typeof s.roles === 'object'
    && Array.isArray(s.steps_done) && typeof s.input === 'string'
}

/**
 * 读取一个会话：区分 missing / empty / corrupt / ok。
 * session.json 之外的必需证据（questions.json、decisions.json）缺失或损坏时也算 corrupt，
 * 因为它们无法证明"没有阻塞问题"，不能按空数据处理。只读，不创建任何文件。
 */
export function readStudio(repo, id) {
  const dir = sessionDir(repo, id)
  if (!fs.existsSync(dir)) return { state: 'missing', dir, session: null, errors: [] }
  if (!fs.existsSync(sessionFile(dir))) return { state: 'empty', dir, session: null, errors: [] }
  const raw = readJson(sessionFile(dir))
  if (!raw.ok) return { state: 'corrupt', dir, session: null, errors: [`session.json unreadable: ${raw.error}`] }
  if (!validSession(raw.value)) return { state: 'corrupt', dir, session: null, errors: ['session.json missing required fields'] }

  const errors = []
  const questionsPath = path.join(dir, 'questions.json')
  const decisionsPath = path.join(dir, 'decisions.json')
  const questions = readJson(questionsPath)
  const questionsInvalid = !questions.ok || !Array.isArray(questions.value)
  if (questionsInvalid) {
    errors.push(`questions.json invalid: ${!fs.existsSync(questionsPath) ? 'missing' : (questions.ok ? 'not an array' : questions.error)}`)
  }
  const decisions = readJson(decisionsPath)
  const decisionsInvalid = !decisions.ok || !Array.isArray(decisions.value)
  if (decisionsInvalid) {
    errors.push(`decisions.json invalid: ${!fs.existsSync(decisionsPath) ? 'missing' : (decisions.ok ? 'not an array' : decisions.error)}`)
  }

  const confirmations = {}
  const cdir = path.join(dir, 'confirmations')
  let names = []
  try { names = fs.readdirSync(cdir).filter((f) => f.endsWith('.json')) } catch { names = [] }
  // 无法解析的确认文件是读取错误：它既不能当作"专家已确认"，也不能静默当成缺失。
  let confirmationsInvalid = false
  for (const name of names) {
    const r = readJson(path.join(cdir, name))
    if (!r.ok) {
      confirmationsInvalid = true
      errors.push(`confirmations/${name} unreadable: ${r.error}`)
      continue
    }
    if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) {
      confirmationsInvalid = true
      errors.push(`confirmations/${name} is not a confirmation record`)
      continue
    }
    // 以文件名为准，G0 再校验记录内的 expert 是否与之匹配，避免记录互相冒充。
    confirmations[name.replace(/\.json$/, '')] = r.value
  }

  return {
    // 关联证据损坏时整体按 corrupt 返回：UI 必须能把它与"没有会话"区分开。
    state: questionsInvalid || decisionsInvalid || confirmationsInvalid ? 'corrupt' : 'ok',
    dir,
    session: raw.value,
    questions: Array.isArray(questions.value) ? questions.value : [],
    questionsInvalid,
    decisions: Array.isArray(decisions.value) ? decisions.value : [],
    decisionsInvalid,
    confirmations,
    confirmationsInvalid,
    minutes: readText(path.join(dir, 'minutes-final.md')).value || '',
    errors,
  }
}

export function listSessions(repo) {
  const root = studioRoot(repo)
  let names = []
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  const out = []
  for (const id of names) {
    if (!isValidSessionId(id)) continue
    const r = readStudio(repo, id)
    out.push({
      id,
      state: r.state,
      title: r.session?.title || id,
      status: r.session?.status || r.state,
      step: currentStep(r.session),
      updated_at: r.session?.updated_at || null,
      open_blocking: r.session ? openBlocking(r.questions, r.questionsInvalid).length : null,
      pending_decisions: r.session && Array.isArray(r.decisions) ? r.decisions.filter((d) => !decisionConfirmed(d)).length : null,
    })
  }
  out.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || a.id.localeCompare(b.id))
  return out
}

// ───────────────────────────── 状态推导 ─────────────────────────────

export function currentStep(session) {
  if (!session) return null
  const done = new Set(session.steps_done || [])
  return STEPS.find((s) => !done.has(s)) || 'done'
}

/** 用户动作必须带类型、内容和时间：只有类型不算确认。 */
function userActionOf(record) {
  const a = record && record.user_action
  if (!a || typeof a !== 'object') return null
  if (a.kind !== 'answer' && a.kind !== 'default' && a.kind !== 'confirm') return null
  if (!String(a.text || '').trim()) return null
  if (!a.at || typeof a.at !== 'string') return null
  return a
}

/**
 * 问题是否真的结束：除状态字段外，还必须有内容匹配的有效用户动作。
 * 只有 `status=answered` 而没有 user_action 的记录既不能算关闭，也不能算确认。
 */
function questionClosed(q) {
  if (!q || typeof q !== 'object') return false
  const a = userActionOf(q)
  if (!a) return false
  const status = String(q.status || 'open')
  if (status === 'answered' || status === 'resolved') return a.kind === 'answer'
  if (status === 'default_adopted') return a.kind === 'default'
  if (status === 'closed') return a.kind === 'answer' || a.kind === 'default'
  return false
}

/**
 * 未处理的阻塞问题。状态或用户动作缺失时按"未处理"对待——
 * 未回答的问题不能被当成已确认。
 */
function openBlocking(questions, invalid) {
  if (invalid) return [{ id: 'questions.json', text: 'questions.json 无效，无法证明没有阻塞问题', status: 'invalid' }]
  return (questions || []).filter((q) => q && q.blocking && !questionClosed(q))
}

export function openBlockingQuestions(repo, id) {
  const r = readStudio(repo, id)
  if (!r.session) return [{ id: 'session', text: `studio session ${id} is ${r.state}`, status: 'invalid' }]
  return openBlocking(r.questions, r.questionsInvalid)
}

/** 供 CLI/UI 复用同一阻塞判定。 */
export function blockingQuestions(questions, invalid = false) {
  return openBlocking(questions, invalid)
}

/** 用户动作必须带类型、内容和时间：只有类型不算确认。 */
function decisionAction(d) {
  const a = d && d.confirmed_by_user
  if (!a || typeof a !== 'object') return null
  if (a.kind !== 'confirm' && a.kind !== 'default') return null
  if (!String(a.text || '').trim()) return null
  if (!a.at || typeof a.at !== 'string') return null
  return a
}

function decisionConfirmed(d) { return !!decisionAction(d) }

function allDecisionsConfirmed(decisions) {
  return Array.isArray(decisions) && decisions.length > 0 && decisions.every(decisionConfirmed)
}

// ───────────────────────────── 写入 ─────────────────────────────

function saveSession(dir, session) {
  const next = { ...session, revision: Number(session.revision || 0) + 1, updated_at: nowIso() }
  writeJson(sessionFile(dir), next)
  return next
}

function ensureLayout(dir) {
  fs.mkdirSync(path.join(dir, 'confirmations'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
}

function loadForWrite(repo, id) {
  const r = readStudio(repo, id)
  if (r.state === 'missing') throw new StudioError('E_NO_SESSION', `studio session not found: ${id}`)
  if (r.state === 'empty') throw new StudioError('E_EMPTY_SESSION', `studio session ${id} has no session.json`)
  // session.json 损坏时没有可恢复的会话；关联证据损坏交给各操作具体的错误码。
  if (!r.session) throw new StudioError('E_CORRUPT_SESSION', `studio session ${id} is corrupt: ${r.errors.join('; ')}`)
  return r
}

/**
 * 把一段修订记录追加到纪要末尾：拒绝原因和用户处理都必须留在落盘证据里。
 * 纪要不存在时不做任何事——不能凭空用修订记录冒充一份纪要。
 */
function appendMinutesRevision(dir, text) {
  const body = String(text || '').trim()
  if (!body) return
  const file = path.join(dir, 'minutes-final.md')
  const prev = readText(file)
  if (!prev.ok) return
  const head = prev.value.trim() ? prev.value.replace(/\s+$/, '') + '\n\n' : ''
  writeText(file, head + body + '\n')
}

export function createSession(repo, { id, title, input }, { config, projectCfg = {}, overrides = {} } = {}) {
  assertSessionId(id)
  const dir = sessionDir(repo, id)
  if (fs.existsSync(dir)) throw new StudioError('E_SESSION_EXISTS', `studio session already exists: ${id}`)
  const text = String(input || '').trim()
  if (!text) throw new StudioError('E_NO_INPUT', 'studio new requires --input "<用户输入>"')
  const roles = resolveRoles(config, projectCfg, overrides)
  ensureLayout(dir)
  const session = {
    schema: STUDIO_SCHEMA,
    id,
    title: String(title || '').trim() || id,
    input: text,
    status: 'running',
    roles,
    steps_done: [],
    outputs: {},
    calls: [],
    last_error: null,
    blocking_reason: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    revision: 1,
  }
  writeJson(sessionFile(dir), session)
  writeJson(path.join(dir, 'questions.json'), [])
  writeJson(path.join(dir, 'decisions.json'), [])
  return session
}

// ───────────────────────────── 模型调用 ─────────────────────────────

function section(text) { return String(text || '').trim() || '(空)' }

function expertPrompt(role, session) {
  return [
    `你是本次 Studio 讨论的${ROLE_LABEL[role]}（${role}）。这是只读讨论：不要修改、创建或删除任何文件，也不要运行会改变工作区的命令。`,
    '',
    '用户输入：',
    section(session.input),
    '',
    '请独立给出你的判断：关键结论、主要风险、可执行建议。不要假设其他专家会得出相同结论。300 字以内。',
  ].join('\n')
}

function moderatorPrompt(session, expertOutputs) {
  const lines = [
    '你是本次 Studio 讨论的主持。这是只读讨论：不要修改、创建或删除任何文件。',
    '',
    '用户输入：',
    section(session.input),
    '',
  ]
  for (const role of EXPERTS) lines.push(`${ROLE_LABEL[role]}：`, section(expertOutputs[role]), '')
  lines.push(
    '请汇总分歧，提出必须由用户回答的问题与待确认的决策。最后只输出一个 JSON 对象（不要加代码块标记）：',
    '{"summary":"一句话汇总","questions":[{"text":"问题","blocking":true,"options":["A","B"],"default":"A"}],"decisions":[{"title":"决策标题","detail":"说明","default":"默认选项"}]}',
    'blocking 为 true 的问题必须等用户回答后才能继续。',
  )
  return lines.join('\n')
}

function answeredQuestions(questions) {
  return (questions || []).map((q) => ({
    id: q.id,
    text: q.text,
    status: q.status,
    blocking: !!q.blocking,
    answer: q.user_action ? q.user_action.text : null,
    action: q.user_action ? q.user_action.kind : null,
  }))
}

function scribePrompt(session, questions) {
  const lines = [
    '你是本次 Studio 讨论的书记。这是只读讨论：不要修改、创建或删除任何文件。',
    '',
    '用户输入：',
    section(session.input),
    '',
  ]
  for (const role of EXPERTS) lines.push(`${ROLE_LABEL[role]}：`, section(session.outputs[role]), '')
  lines.push('主持汇总：', section(session.outputs.moderator), '')
  lines.push('问题与用户回答：', JSON.stringify(answeredQuestions(questions), null, 2), '')
  lines.push(
    '请写出最终会议纪要（Markdown：背景、观点、问题与回答、决策）。纪要之后单独输出一个 JSON 对象（不要加代码块标记）：',
    '{"decisions":[{"title":"决策标题","detail":"说明","default":"默认选项"}]}',
    '纪要不得替用户做决定；没有用户确认的决策只能作为草稿。',
  )
  return lines.join('\n')
}

function confirmPrompt(role, session, decisions, minutes, questions) {
  return [
    `你是本次 Studio 讨论的${ROLE_LABEL[role]}（${role}），现在独立确认最终纪要与决策。这是只读操作：不要修改、创建或删除任何文件。`,
    '',
    '用户输入：',
    section(session.input),
    '',
    '会议纪要：',
    section(minutes),
    '',
    '决策：',
    decisions.map((d) => `${d.id} ${d.title}：${d.detail || ''}（默认：${d.default || '无'}）`).join('\n') || '(无)',
    '',
    '问题与用户处理（含上一轮拒绝后的答复；没有用户回答的问题不算已确认）：',
    JSON.stringify(answeredQuestions(questions), null, 2),
    '',
    '请判断是否可以接受这些决策。最后只输出一个 JSON 对象（不要加代码块标记）：',
    '{"verdict":"accept|accept_with_notes|reject","notes":"说明"}',
    'reject 表示你反对，需要用户处理；accept_with_notes 表示接受但有备注。',
  ].join('\n')
}

/** 定位最后一个顶层 JSON 对象的区间（忽略字符串与代码块标记） */
function lastJsonSpan(text) {
  const s = String(text || '')
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  let last = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) last = [start, i]
      }
    }
  }
  return last
}

/** 从模型输出里取最后一个完整 JSON 对象（忽略代码块标记） */
export function extractJson(text) {
  const s = String(text || '')
  const span = lastJsonSpan(s)
  if (!span) return null
  try { return JSON.parse(s.slice(span[0], span[1] + 1)) } catch { return null }
}

/**
 * 把模型输出拆成「给人看的正文」与「机器 JSON」。
 * 纪要只保留正文：JSON 块属于控制数据，不能当成纪要内容。
 */
export function splitModelOutput(text) {
  const s = String(text || '')
  const span = lastJsonSpan(s)
  if (!span) return { prose: s.trim(), json: null }
  const prose = (s.slice(0, span[0]) + '\n' + s.slice(span[1] + 1)).replace(/\n{3,}/g, '\n\n').trim()
  let json = null
  try { json = JSON.parse(s.slice(span[0], span[1] + 1)) } catch { json = null }
  return { prose, json }
}

async function callRole({ repo, dir, role, prompt, config, adapterFactory, log, session }) {
  const assigned = session.roles[role]
  if (!assigned) throw new StudioError('E_ROLE_UNASSIGNED', `role ${role} has no assigned model`)
  const model = config.models?.[assigned.model]
  if (!model) throw new StudioError('E_MODEL_MISSING', `model ${assigned.model} is no longer configured`)
  const eligible = eligibilityFor(role, assigned.model, model)
  if (!eligible.ok) {
    throw new StudioError('E_ROLE_INELIGIBLE', `studio role ${role} model ${assigned.model} is not eligible: ${eligible.reason}`)
  }
  const providerCfg = config.providers?.[model.provider]
  if (!providerCfg) throw new StudioError('E_PROVIDER_MISSING', `provider ${model.provider} is not configured`)
  const provider = assertReadonlyProvider(providerCfg, model.provider)
  const adapter = adapterFactory ? adapterFactory(provider) : getAdapter(provider)
  if (!adapter || typeof adapter.run !== 'function') throw new StudioError('E_NO_ADAPTER', `no adapter for provider ${model.provider}`)

  const logsDir = path.join(dir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const logPath = path.join(logsDir, `${role}.log`)
  const effort = clampEffort(config.effort?.default || 'high', provider)
  log?.(`[studio ${role}] model=${assigned.model}(${model.id}) provider=${model.provider} effort=${effort ?? '-'}`)
  let res
  try {
    res = await adapter.run({
      prompt,
      cwd: repo,
      model: model.id,
      effort,
      timeoutMs: (provider.limits?.timeoutMinutes || 60) * 60_000,
      logPath,
    })
  } catch (e) {
    throw new StudioError('E_MODEL_CALL', `${role} call failed: ${e && e.message ? e.message : String(e)}`)
  }
  if (!res || res.exitCode !== 0 || res.error) {
    throw new StudioError('E_MODEL_FAILED', `${role} call failed: ${(res && (res.error || `exit ${res.exitCode}`)) || 'no result'}`)
  }
  return { text: String(res.text ?? res.stdout ?? ''), model: assigned.model, modelId: model.id }
}

// ───────────────────────────── 步骤 ─────────────────────────────

function nextQuestionId(items) {
  let max = 0
  for (const q of items) {
    const m = /^Q-(\d+)$/.exec(String(q.id || ''))
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `Q-${max + 1}`
}

function nextDecisionId(items) {
  let max = 0
  for (const d of items) {
    const m = /^D-(\d+)$/.exec(String(d.id || ''))
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `D-${max + 1}`
}

function normalizeQuestions(parsed, existing) {
  const raw = Array.isArray(parsed?.questions) ? parsed.questions : []
  const items = [...existing]
  for (const q of raw) {
    const text = String(q?.text || '').trim()
    if (!text) continue
    items.push({
      id: nextQuestionId(items),
      text,
      blocking: q.blocking !== false,
      options: Array.isArray(q.options) ? q.options.map(String) : [],
      default: q.default === undefined || q.default === null ? null : String(q.default),
      kind: 'discussion',
      status: 'open',
      rounds_used: 0,
      user_action: null,
      created_at: nowIso(),
    })
  }
  return items
}

function normalizeDecisions(parsed, existing) {
  const raw = Array.isArray(parsed?.decisions) ? parsed.decisions : []
  const items = [...existing]
  for (const d of raw) {
    const title = String(d?.title || '').trim()
    if (!title) continue
    items.push({
      id: nextDecisionId(items),
      title,
      detail: String(d?.detail || ''),
      default: d?.default === undefined || d.default === null ? null : String(d.default),
      status: 'draft',
      rounds_used: 0,
      confirmed_by_user: null,
      created_at: nowIso(),
    })
  }
  return items
}

function statusAfterStep(session, questions, decisions, extra = {}) {
  // 刚刚发生的专家拒绝优先于“还有 N 个阻塞问题”：拒绝本身会落一条 open 问题，
  // 但会话原因必须是 expert_reject，否则调用方无法区分普通阻塞与拒绝后的等待。
  if (extra.reject) return { status: 'awaiting_user', blocking_reason: 'expert_reject' }
  const blocked = openBlocking(questions, false)
  if (blocked.length) return { status: 'awaiting_user', blocking_reason: `${blocked.length} 个阻塞问题待回答` }
  // 2/2 已用满或轮次无法证明、且下一步仍要开启讨论时停住：
  // 不自动选默认、也不进入第三轮。讨论已结束、只剩确认时不算“还有阻塞”，可以继续。
  const exhausted = (decisions || []).filter((d) => roundsExhausted(d))
  if (exhausted.length && startsDiscussionRound(session)) {
    return {
      status: 'awaiting_user',
      blocking_reason: exhausted.some((d) => roundCount(d) === null) ? 'rounds_invalid' : 'round_limit',
    }
  }
  if (currentStep(session) === 'done') {
    return allDecisionsConfirmed(decisions)
      ? { status: 'ready', blocking_reason: null }
      : { status: 'awaiting_user', blocking_reason: 'decision_confirm' }
  }
  return { status: 'running', blocking_reason: null }
}

/**
 * 执行一个下一步（一次角色调用）。成功才推进；失败不跳步。
 */
export async function runStudioStep(repo, id, { config, adapterFactory = null, log, now } = {}) {
  const r = loadForWrite(repo, id)
  const session = r.session
  if (session.status === 'concluded') throw new StudioError('E_CONCLUDED', `studio session ${id} is already concluded`)
  if (r.questionsInvalid) throw new StudioError('E_CORRUPT_QUESTIONS', `questions.json invalid in ${id}`)
  if (r.decisionsInvalid) throw new StudioError('E_CORRUPT_DECISIONS', `decisions.json invalid in ${id}`)
  const blocked = openBlocking(r.questions, false)
  if (blocked.length) {
    const limited = blocked.filter((q) => Number(q.rounds_used || 0) >= 2)
    const extra = limited.length
      ? ` (round_limit: ${limited.map((q) => q.id).join(', ')} used 2/2 rounds; use --default or resolve without another round)`
      : ''
    throw new StudioError('E_AWAITING_USER', `awaiting_user: ${blocked.map((q) => q.id).join(', ')} must be answered before running${extra}`)
  }
  const step = currentStep(session)
  if (step === 'done') {
    const ok = allDecisionsConfirmed(r.decisions)
    if (!ok) throw new StudioError('E_AWAITING_DECISION', 'all decisions must be confirmed (or default adopted) before conclude')
    throw new StudioError('E_NO_STEP', 'no further studio step; run "studio conclude"')
  }
  // 轮次已经超过 2，或无法证明仍有额度：任何角色调用都不再发生，包括确认。
  // 轮次恰好为 2：不能再开启讨论（专家/主持/书记），但本轮的独立确认仍可完成。
  const counted = r.decisions.map((d) => ({ id: d.id, rounds: roundCount(d) }))
  const beyond = counted.filter((x) => x.rounds === null || x.rounds > 2)
  if (beyond.length) {
    throw new StudioError(
      'E_ROUNDS_EXHAUSTED',
      `decision rounds exhausted (${beyond.map((x) => `${x.id}:${x.rounds === null ? 'rounds_used invalid' : `${x.rounds}/2`}`).join(', ')}); ` +
      'no further role call is made and G0 cannot pass — stop instead of starting another discussion round',
    )
  }
  const atCap = counted.filter((x) => x.rounds >= 2)
  if (atCap.length && !isConfirmStep(step)) {
    throw new StudioError(
      'E_ROUNDS_EXHAUSTED',
      `decision rounds exhausted (${atCap.map((x) => `${x.id}:${x.rounds}/2`).join(', ')}); ` +
      'no further discussion round is started',
    )
  }

  const dir = r.dir
  let output = ''
  let questions = r.questions
  let decisions = r.decisions
  let reject = null
  let providerRole = step
  let prompt = ''

  if (step === 'expert_a' || step === 'expert_b' || step === 'expert_c') {
    prompt = expertPrompt(step, session)
  } else if (step === 'moderator') {
    prompt = moderatorPrompt(session, session.outputs || {})
  } else if (step === 'scribe') {
    prompt = scribePrompt(session, r.questions)
  } else {
    providerRole = CONFIRM_TARGET[step]
    prompt = confirmPrompt(providerRole, session, r.decisions, r.minutes, r.questions)
  }

  let result
  try {
    result = await callRole({ repo, dir, role: providerRole, prompt, config, adapterFactory, log, session })
  } catch (e) {
    const failed = {
      ...session,
      last_error: e.message,
      calls: [...(session.calls || []), {
        step, role: providerRole, model: session.roles?.[providerRole]?.model || null,
        at: now || nowIso(), ok: false, error: e.message,
      }],
    }
    saveSession(dir, failed)
    throw e
  }
  output = result.text

  if (step === 'moderator') {
    const parsed = extractJson(output)
    if (!parsed) {
      saveSession(dir, { ...session, last_error: 'moderator output is not valid JSON', calls: [...(session.calls || []), { step, role: providerRole, model: result.model, at: nowIso(), ok: false, error: 'invalid_json' }] })
      throw new StudioError('E_INVALID_OUTPUT', 'moderator output is not valid JSON; step not advanced')
    }
    questions = normalizeQuestions(parsed, r.questions)
    writeJson(path.join(dir, 'questions.json'), questions)
  } else if (step === 'scribe') {
    const split = splitModelOutput(output)
    const parsed = split.json
    if (!parsed || !Array.isArray(parsed.decisions) || !split.prose) {
      saveSession(dir, { ...session, last_error: 'scribe output is missing minutes/decisions', calls: [...(session.calls || []), { step, role: providerRole, model: result.model, at: nowIso(), ok: false, error: 'invalid_output' }] })
      throw new StudioError('E_INVALID_OUTPUT', 'scribe output is missing minutes prose or decisions JSON; step not advanced')
    }
    // 决策由书记一次产出：重跑时替换，不追加，避免旧决策与纪要不一致。
    decisions = normalizeDecisions(parsed, [])
    writeJson(path.join(dir, 'decisions.json'), decisions)
    writeText(path.join(dir, 'minutes-final.md'), split.prose)
  } else if (CONFIRM_TARGET[step]) {
    const parsed = extractJson(output)
    const verdict = parsed?.verdict
    if (!['accept', 'accept_with_notes', 'reject'].includes(verdict)) {
      saveSession(dir, { ...session, last_error: `${providerRole} confirmation is not valid`, calls: [...(session.calls || []), { step, role: providerRole, model: result.model, at: nowIso(), ok: false, error: 'invalid_verdict' }] })
      throw new StudioError('E_INVALID_OUTPUT', `${providerRole} confirmation must include verdict accept|accept_with_notes|reject; step not advanced`)
    }
    const record = {
      expert: providerRole,
      step,
      verdict,
      notes: String(parsed?.notes || ''),
      model: result.model,
      model_id: result.modelId,
      at: nowIso(),
    }
    writeJson(path.join(dir, 'confirmations', `${providerRole}.json`), record)
    if (verdict === 'reject') {
      reject = record
      // 一次拒绝 = 一轮新的业务轮次，如实累加，不再封顶成 2：
      //   - 决策还不到 2 时，问题 rounds_used 保持 0 且不关联决策，用户仍可回答本轮；
      //   - 决策已经是 2（或轮次无法证明）时，这次拒绝就是超出上限的证据，
      //     rounds_used 写成 used+1（第 3 轮可见），问题关联到决策且轮次 > 2，
      //     文本回答会被拒绝，确认也不再继续。
      //   - rounds_used 本身无效时保持无效，由 G0 判失败，不用新值掩盖坏证据。
      const priorCounts = decisions.map((d) => roundCount(d))
      const opensAnotherRound = priorCounts.some((n) => n === null || n >= 2)
      decisions = decisions.map((d) => {
        const used = roundCount(d)
        if (used === null) return d
        return { ...d, rounds_used: used + 1 }
      })
      writeJson(path.join(dir, 'decisions.json'), decisions)
      const nextRound = decisions.reduce((max, d) => {
        const n = roundCount(d)
        return n === null ? max : Math.max(max, n)
      }, 0)
      questions = [...r.questions, {
        id: nextQuestionId(r.questions),
        text: `专家 ${ROLE_LABEL[providerRole]} 拒绝：${record.notes || '未说明原因'}`,
        blocking: true,
        options: [],
        default: null,
        kind: 'expert_reject',
        expert: providerRole,
        decision: opensAnotherRound ? (decisions[0]?.id || null) : null,
        status: 'open',
        rounds_used: opensAnotherRound ? (nextRound > 2 ? nextRound : null) : 0,
        user_action: null,
        created_at: nowIso(),
      }]
      writeJson(path.join(dir, 'questions.json'), questions)
      // 其他专家的确认是针对拒绝前的旧证据：作废，修订后必须各自重新独立确认。
      for (const role of EXPERTS) {
        if (role === providerRole) continue
        try { fs.rmSync(path.join(dir, 'confirmations', `${role}.json`), { force: true }) } catch { /* ignore */ }
      }
      const round = Math.max(1, ...decisions.map((d) => roundCount(d) ?? 0))
      appendMinutesRevision(dir, [
        `## 修订记录（第 ${round} 轮）`,
        `- 专家 ${providerRole} 拒绝：${record.notes || '未说明原因'}`,
        '- 状态：等待用户处理',
      ].join('\n'))
    }
  }

  let doneSteps = [...(session.steps_done || []), step]
  if (reject) {
    // 撤掉全部确认步骤：修订后的纪要和决策要三位专家重新各自确认。
    doneSteps = doneSteps.filter((s) => !CONFIRM_TARGET[s])
  }
  const outputs = { ...(session.outputs || {}) }
  if (!CONFIRM_TARGET[step] && step !== 'scribe') outputs[step] = output
  const nextSession = {
    ...session,
    steps_done: doneSteps,
    outputs,
    last_error: null,
    calls: [...(session.calls || []), { step, role: providerRole, model: result.model, at: nowIso(), ok: true, error: null }],
  }
  const after = statusAfterStep(nextSession, questions, decisions, { reject })
  const saved = saveSession(dir, { ...nextSession, ...after })
  return { ok: true, step, session: saved, questions, decisions }
}

// ───────────────────────────── 回答 / 确认 ─────────────────────────────

/**
 * 用户动作：回答阻塞问题，或确认/采用默认决策。
 * 必须显式区分 answer 与 default；记录动作内容与通道。
 */
export function answerStudio(repo, id, { question, decision, text, adoptDefault = false, channel = 'cli' } = {}) {
  const r = loadForWrite(repo, id)
  const dir = r.dir
  if (r.questionsInvalid) throw new StudioError('E_CORRUPT_QUESTIONS', 'questions.json invalid')
  if (r.decisionsInvalid) throw new StudioError('E_CORRUPT_DECISIONS', 'decisions.json invalid')
  const value = String(text || '').trim()
  if (!!question === !!decision) throw new StudioError('E_USAGE', 'answer requires exactly one of --question <id> or --decision <id>')
  if (!adoptDefault && !value) throw new StudioError('E_USAGE', 'answer requires --text "<内容>" or --default')
  if (adoptDefault && value) throw new StudioError('E_USAGE', '--text and --default are mutually exclusive')

  const at = nowIso()
  let questions = r.questions
  let decisions = r.decisions

  if (question) {
    const idx = questions.findIndex((q) => q.id === question)
    if (idx < 0) throw new StudioError('E_NO_QUESTION', `question not found: ${question}`)
    const q = questions[idx]
    // 只有带有效用户动作的关闭状态才算真的关闭；否则允许补答（例如手工改坏的状态字段）。
    if (q.status !== 'open' && questionClosed(q)) throw new StudioError('E_QUESTION_CLOSED', `question ${question} is ${q.status}`)
    if (adoptDefault && !q.default) throw new StudioError('E_NO_DEFAULT', `question ${question} has no default`)
    const link = q.decision ? decisions.find((d) => d.id === q.decision) : null
    const qRounds = roundCount(q)
    const linkRounds = link ? roundCount(link) : 0
    // 轮次缺失或无效时无法证明还剩额度：只允许显式采用默认收尾，不再开一轮讨论。
    if (!adoptDefault && (qRounds === null || linkRounds === null)) {
      throw new StudioError('E_ROUNDS_INVALID', `question ${question} has invalid rounds_used; only --default can resolve it`)
    }
    const rounds = Math.max(qRounds ?? 0, linkRounds ?? 0)
    const decisionOver = decisions.some((d) => {
      const n = roundCount(d)
      return n !== null && n > 2
    })
    if (!adoptDefault && decisionOver) {
      throw new StudioError(
        'E_ROUNDS_EXHAUSTED',
        `question ${question} cannot start another discussion: decision rounds already exceed 2`,
      )
    }
    if (!adoptDefault && rounds >= 2) {
      throw new StudioError('E_ROUND_LIMIT', `question ${question} already used ${rounds}/2 rounds; answer with --default or resolve it without another discussion round`)
    }
    const action = { kind: adoptDefault ? 'default' : 'answer', text: adoptDefault ? String(q.default) : value, at, channel }
    const nextQ = {
      ...q,
      status: adoptDefault ? 'default_adopted' : 'answered',
      user_action: action,
      rounds_used: adoptDefault ? q.rounds_used : qRounds + 1,
    }
    questions = questions.map((x, i) => (i === idx ? nextQ : x))
    if (link && !adoptDefault) {
      decisions = decisions.map((d) => (d.id === link.id ? { ...d, rounds_used: linkRounds + 1 } : d))
      writeJson(path.join(dir, 'decisions.json'), decisions)
    }
    writeJson(path.join(dir, 'questions.json'), questions)
    // 专家拒绝的答复也是证据：留在纪要的修订记录里，后续确认必须看到它。
    if (q.kind === 'expert_reject') {
      appendMinutesRevision(dir, `- 用户处理（${action.kind}）：${action.text}`)
    }
  } else {
    const idx = decisions.findIndex((d) => d.id === decision)
    if (idx < 0) throw new StudioError('E_NO_DECISION', `decision not found: ${decision}`)
    const d = decisions[idx]
    if (decisionConfirmed(d)) throw new StudioError('E_DECISION_CLOSED', `decision ${decision} is already ${d.status}`)
    if (adoptDefault && !d.default) throw new StudioError('E_NO_DEFAULT', `decision ${decision} has no default`)
    const action = { kind: adoptDefault ? 'default' : 'confirm', text: adoptDefault ? String(d.default) : value, at, channel }
    const nextD = { ...d, status: adoptDefault ? 'default_adopted' : 'confirmed', confirmed_by_user: action }
    decisions = decisions.map((x, i) => (i === idx ? nextD : x))
    writeJson(path.join(dir, 'decisions.json'), decisions)
  }

  const after = statusAfterStep(r.session, questions, decisions)
  const saved = saveSession(dir, { ...r.session, last_error: null, ...after })
  return { ok: true, session: saved, questions, decisions }
}

// ───────────────────────────── G0 ─────────────────────────────

function evidenceContent(dir) {
  const parts = []
  const push = (name) => {
    const p = path.join(dir, name)
    try { parts.push(`${name}\n${fs.readFileSync(p, 'utf8')}`) } catch { parts.push(`${name}\n\u0000missing`) }
  }
  push('session.json')
  push('questions.json')
  push('decisions.json')
  push('minutes-final.md')
  let names = []
  try { names = fs.readdirSync(path.join(dir, 'confirmations')).filter((f) => f.endsWith('.json')).sort() } catch { names = [] }
  for (const name of names) push(`confirmations/${name}`)
  return parts.join('\n')
}

/**
 * 按落盘证据重新计算 G0。不缓存通过结果：证据变了，结论随之改变。
 */
export function evaluateG0(repo, id, { now } = {}) {
  const r = readStudio(repo, id)
  // 没有可读会话时无法求值：缺失是 not_evaluated，损坏是 fail。
  // 会话本身可读、但关联证据损坏时继续逐项求值（对应 check 会失败）。
  if (!r.session) {
    return {
      gate: 'G0', pass: false, status: r.state === 'missing' ? 'not_evaluated' : 'fail',
      failed: ['G0.session'], checks: [], errors: r.errors.length ? r.errors : [`studio session ${id} is ${r.state}`],
      content_hash: null, revision: 0,
    }
  }
  const dir = r.dir
  const session = r.session
  const minutes = String(r.minutes || '').trim()
  const decisions = Array.isArray(r.decisions) ? r.decisions : []
  const confirmations = r.confirmations || {}
  const decisionsInvalid = !!r.decisionsInvalid

  const open = openBlocking(r.questions, r.questionsInvalid)
  // 轮次必须写明且是 0..2 的整数：缺失/损坏不能按 0 处理，否则无法证明"没超两轮"。
  const roundsOver = [
    ...(r.questions || []).map((q) => ({ id: q.id || 'question', problem: roundsProblem(q) })),
    ...decisions.map((d) => ({ id: d.id || 'decision', problem: roundsProblem(d) })),
  ].filter((x) => x.problem)
  // 独立有效确认：必须来自该角色自己的模型，且带结论与时间；别人代写的确认不算。
  // 记录里的 expert 必须等于角色本身（缺失也不行），model 必须等于该角色被分配的模型
  // （角色没有分配模型时同样无法证明独立确认）。
  const roleModel = (role) => session.roles?.[role]?.model || null
  const missingConf = EXPERTS.filter((role) => {
    const c = confirmations[role]
    if (!c || typeof c !== 'object') return true
    if (c.expert !== role) return true
    if (!['accept', 'accept_with_notes'].includes(c.verdict)) return true
    if (!c.model || !c.at) return true
    const assigned = roleModel(role)
    if (!assigned || c.model !== assigned) return true
    return false
  })
  const rejected = EXPERTS.filter((role) => confirmations[role] && confirmations[role].verdict === 'reject')
  // 比较实际模型身份（provider + id），配置键只是别名：两个键指向同一模型仍然算同一个。
  const scribeRole = session.roles?.scribe
  const moderatorRole = session.roles?.moderator
  const scribeRef = modelRef(scribeRole)
  const moderatorRef = modelRef(moderatorRole)

  const checks = [
    {
      id: 'G0.minutes_final',
      desc: 'minutes-final.md 存在且非空',
      pass: minutes.length > 0,
      waivable: false,
      evidence: path.join(STUDIO_DIR, id, 'minutes-final.md'),
    },
    {
      id: 'G0.decisions_nonempty',
      desc: 'decisions.json 至少包含一个决策',
      pass: !decisionsInvalid && decisions.length > 0,
      waivable: false,
      evidence: decisionsInvalid ? 'decisions.json invalid' : `decisions=${decisions.length}`,
    },
    {
      id: 'G0.each_decision_confirmed',
      desc: '每个决策都有用户确认或明确采用默认的记录',
      pass: !decisionsInvalid && decisions.length > 0 && decisions.every(decisionConfirmed),
      waivable: false,
      evidence: decisionsInvalid ? 'decisions.json invalid'
        : decisions.length === 0 ? 'no decisions'
          : (decisions.filter((d) => !decisionConfirmed(d)).map((d) => d.id).join(',') || 'all confirmed'),
    },
    {
      id: 'G0.no_open_blocking',
      desc: '没有 open/unresolved 的阻塞问题',
      pass: open.length === 0,
      waivable: false,
      evidence: open.map((q) => `${q.id}:${q.status || 'invalid'}`).join(',') || 'none',
    },
    {
      id: 'G0.decision_rounds_le_2',
      desc: '每个决策与问题的业务轮次 ≤ 2',
      pass: !r.questionsInvalid && !decisionsInvalid && roundsOver.length === 0,
      waivable: false,
      evidence: decisionsInvalid ? 'decisions.json invalid'
        : r.questionsInvalid ? 'questions.json invalid'
          : (roundsOver.map((x) => `${x.id}:${x.problem}`).join(',') || 'all <= 2'),
    },
    {
      id: 'G0.experts_confirmed',
      desc: '三位专家各有独立有效确认，且无阻塞性拒绝',
      pass: missingConf.length === 0 && rejected.length === 0,
      waivable: false,
      evidence: [...missingConf.map((x) => `${x}:missing`), ...rejected.map((x) => `${x}:reject`)].join(',') || 'a/b/c accepted',
    },
    {
      id: 'G0.scribe_ne_moderator',
      desc: '书记与主持模型均已知且不同',
      pass: !!scribeRef && !!moderatorRef && !sameModelRef(scribeRef, moderatorRef),
      waivable: false,
      evidence: `scribe=${modelLabel(scribeRole)} moderator=${modelLabel(moderatorRole)}`,
    },
  ]

  const contentHash = sha256Content(evidenceContent(dir))
  const gate = {
    schema: GATE_SCHEMA,
    gate: 'G0',
    subject: { kind: 'studio', id, content_hash: contentHash, revision: Number(session.revision || 0) },
    evaluated_at: now || nowIso(),
    checks,
    waivers: [],
  }
  const result = evaluateGate(gate, { currentHash: contentHash })
  return {
    gate: 'G0',
    status: result.status,
    pass: result.pass,
    failed: result.failed,
    checks,
    content_hash: contentHash,
    revision: gate.subject.revision,
    errors: result.errors,
  }
}

/** conclude：按最新证据求 G0；通过才把会话标为 concluded，失败则撤销过期的 concluded。 */
export function concludeStudio(repo, id, { now } = {}) {
  const result = evaluateG0(repo, id, { now })
  const r = loadForWrite(repo, id)
  if (result.pass) {
    saveSession(r.dir, { ...r.session, status: 'concluded', blocking_reason: null, last_error: null })
    return { ...result, session: readStudio(repo, id).session }
  }
  if (r.session.status === 'concluded') {
    saveSession(r.dir, { ...r.session, status: 'awaiting_user', blocking_reason: 'g0_failed' })
    return { ...result, session: readStudio(repo, id).session }
  }
  return { ...result, session: r.session }
}
