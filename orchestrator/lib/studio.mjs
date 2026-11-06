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

export const STUDIO_DIR = '.collab/studio'
export const STUDIO_ROLES = ['expert_a', 'expert_b', 'expert_c', 'moderator', 'scribe']
export const EXPERTS = ['expert_a', 'expert_b', 'expert_c']
export const STEPS = ['expert_a', 'expert_b', 'expert_c', 'moderator', 'scribe', 'confirm_a', 'confirm_b', 'confirm_c']
export const CONFIRM_TARGET = { confirm_a: 'expert_a', confirm_b: 'expert_b', confirm_c: 'expert_c' }
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

/** 问题已结束的状态：其余状态（含缺失）都按未处理对待。 */
const CLOSED_QUESTION = new Set(['answered', 'default_adopted', 'resolved', 'closed'])

/**
 * 返回一个只读的 provider 副本；无法保证只读时返回 null。
 * 显式 capabilities.readonly_mode=false 一律拒绝；没有声明时只有能强制到只读模式的
 * adapter 才允许（例如 codex 的 sandbox=read-only），其余渠道必须显式声明。
 */
export function readonlyProvider(provider) {
  if (!provider || typeof provider !== 'object') return null
  const declared = provider.capabilities?.readonly_mode
  if (declared === false) return null
  // 显式声明 true 的渠道已经有自己的只读配置，直接用；否则只能靠能钉死的 adapter。
  const forced = declared === true ? {} : (READONLY_ADAPTER_OPTIONS[provider.adapter] || {})
  if (declared !== true && !Object.keys(forced).length) return null
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
      '（显式声明 capabilities.readonly_mode=true，或使用支持只读模式的 adapter）',
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
      if (!tierOk(role, model)) { reasons.push(`${key}: tier ${model.tier || 'unknown'}, need ${TIER_REQUIRED[role]}`); continue }
      if (model.availability === 'blocked' || model.availability === 'unavailable') {
        reasons.push(`${key}: availability ${model.availability}`)
        continue
      }
      const provider = config.providers?.[model.provider]
      if (!provider) { reasons.push(`${key}: provider ${model.provider} not configured`); continue }
      // 只读能力是渠道级问题：换一个候选也不会变好，直接报告。
      assertReadonlyProvider(provider, model.provider)
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
  if (resolved.scribe.model === resolved.moderator.model) {
    throw new StudioError('E_SCRIBE_IS_MODERATOR', 'scribe model must differ from moderator model')
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
 * 只读，不创建任何文件。
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
  const questionsInvalid = fs.existsSync(questionsPath) && (!questions.ok || !Array.isArray(questions.value))
  if (questionsInvalid) {
    errors.push(`questions.json invalid: ${questions.ok ? 'not an array' : questions.error}`)
  }
  const decisions = readJson(decisionsPath)
  const decisionsInvalid = fs.existsSync(decisionsPath) && (!decisions.ok || !Array.isArray(decisions.value))
  if (decisionsInvalid) {
    errors.push(`decisions.json invalid: ${decisions.ok ? 'not an array' : decisions.error}`)
  }

  const confirmations = {}
  const cdir = path.join(dir, 'confirmations')
  let names = []
  try { names = fs.readdirSync(cdir).filter((f) => f.endsWith('.json')) } catch { names = [] }
  for (const name of names) {
    const r = readJson(path.join(cdir, name))
    if (!r.ok) { errors.push(`confirmations/${name} unreadable: ${r.error}`); continue }
    // 以文件名为准，G0 再校验记录内的 expert 是否与之匹配，避免记录互相冒充。
    confirmations[name.replace(/\.json$/, '')] = r.value
  }

  return {
    state: 'ok',
    dir,
    session: raw.value,
    questions: Array.isArray(questions.value) ? questions.value : [],
    questionsInvalid,
    decisions: Array.isArray(decisions.value) ? decisions.value : [],
    decisionsInvalid,
    confirmations,
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
      open_blocking: r.state === 'ok' ? openBlocking(r.questions, r.questionsInvalid).length : null,
      pending_decisions: r.state === 'ok' && Array.isArray(r.decisions) ? r.decisions.filter((d) => !decisionConfirmed(d)).length : null,
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

/**
 * 未处理的阻塞问题。状态缺失时按"未处理"对待——未回答的问题不能被当成已确认。
 */
function openBlocking(questions, invalid) {
  if (invalid) return [{ id: 'questions.json', text: 'questions.json 无效，无法证明没有阻塞问题', status: 'invalid' }]
  return (questions || []).filter((q) => q && q.blocking && !CLOSED_QUESTION.has(String(q.status || 'open')))
}

export function openBlockingQuestions(repo, id) {
  const r = readStudio(repo, id)
  if (r.state !== 'ok') return []
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
  if (r.state === 'corrupt') throw new StudioError('E_CORRUPT_SESSION', `studio session ${id} is corrupt: ${r.errors.join('; ')}`)
  return r
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

function confirmPrompt(role, session, decisions, minutes) {
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
  const blocked = openBlocking(questions, false)
  if (blocked.length) return { status: 'awaiting_user', blocking_reason: `${blocked.length} 个阻塞问题待回答` }
  if (extra.roundLimit) return { status: 'awaiting_user', blocking_reason: extra.roundLimit }
  if (extra.reject) return { status: 'awaiting_user', blocking_reason: 'expert_reject' }
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
    prompt = confirmPrompt(providerRole, session, r.decisions, r.minutes)
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
      // 一次拒绝 = 一轮新的业务轮次：计入决策轮次，并允许该专家在处理后重新确认。
      decisions = decisions.map((d) => ({ ...d, rounds_used: Number(d.rounds_used || 0) + 1 }))
      writeJson(path.join(dir, 'decisions.json'), decisions)
      questions = [...r.questions, {
        id: nextQuestionId(r.questions),
        text: `专家 ${ROLE_LABEL[providerRole]} 拒绝：${record.notes || '未说明原因'}`,
        blocking: true,
        options: [],
        default: null,
        kind: 'expert_reject',
        expert: providerRole,
        status: 'open',
        rounds_used: 0,
        user_action: null,
        created_at: nowIso(),
      }]
      writeJson(path.join(dir, 'questions.json'), questions)
    }
  }

  let doneSteps = [...(session.steps_done || []), step]
  let roundLimit = null
  if (reject) {
    // 轮次耗尽就停下：不自动选默认、也不进入第三轮讨论。
    if (decisions.some((d) => Number(d.rounds_used || 0) > 2)) {
      roundLimit = 'round_limit'
    } else {
      // 撤掉这一步，等用户处理后再由该专家独立重新确认。
      doneSteps = doneSteps.filter((s) => s !== step)
    }
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
  const after = statusAfterStep(nextSession, questions, decisions, { reject, roundLimit })
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
    if (q.status !== 'open') throw new StudioError('E_QUESTION_CLOSED', `question ${question} is ${q.status}`)
    if (adoptDefault && !q.default) throw new StudioError('E_NO_DEFAULT', `question ${question} has no default`)
    const link = q.decision ? decisions.find((d) => d.id === q.decision) : null
    const rounds = Math.max(Number(q.rounds_used || 0), link ? Number(link.rounds_used || 0) : 0)
    if (!adoptDefault && rounds >= 2) {
      throw new StudioError('E_ROUND_LIMIT', `question ${question} already used ${rounds}/2 rounds; answer with --default or resolve it without another discussion round`)
    }
    const action = { kind: adoptDefault ? 'default' : 'answer', text: adoptDefault ? String(q.default) : value, at, channel }
    const nextQ = {
      ...q,
      status: adoptDefault ? 'default_adopted' : 'answered',
      user_action: action,
      rounds_used: adoptDefault ? Number(q.rounds_used || 0) : Number(q.rounds_used || 0) + 1,
    }
    questions = questions.map((x, i) => (i === idx ? nextQ : x))
    if (link && !adoptDefault) {
      decisions = decisions.map((d) => (d.id === link.id ? { ...d, rounds_used: Number(d.rounds_used || 0) + 1 } : d))
      writeJson(path.join(dir, 'decisions.json'), decisions)
    }
    writeJson(path.join(dir, 'questions.json'), questions)
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
  if (r.state !== 'ok') {
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
  const roundsOver = [
    ...(r.questions || []).filter((q) => Number(q.rounds_used || 0) > 2).map((q) => q.id),
    ...decisions.filter((d) => Number(d.rounds_used || 0) > 2).map((d) => d.id),
  ]
  // 独立有效确认：必须来自该角色自己的模型，且带结论与时间；别人代写的确认不算。
  const roleModel = (role) => session.roles?.[role]?.model || null
  const missingConf = EXPERTS.filter((role) => {
    const c = confirmations[role]
    if (!c || typeof c !== 'object') return true
    if (c.expert && c.expert !== role) return true
    if (!['accept', 'accept_with_notes'].includes(c.verdict)) return true
    if (!c.model || !c.at) return true
    const assigned = roleModel(role)
    if (assigned && c.model !== assigned) return true
    return false
  })
  const rejected = EXPERTS.filter((role) => confirmations[role] && confirmations[role].verdict === 'reject')
  const scribeModel = session.roles?.scribe?.model || null
  const moderatorModel = session.roles?.moderator?.model || null

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
      pass: roundsOver.length === 0,
      waivable: false,
      evidence: roundsOver.join(',') || 'all <= 2',
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
      pass: !!scribeModel && !!moderatorModel && scribeModel !== moderatorModel,
      waivable: false,
      evidence: `scribe=${scribeModel || 'unknown'} moderator=${moderatorModel || 'unknown'}`,
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
