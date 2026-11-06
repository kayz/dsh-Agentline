/**
 * blueprint.mjs — Blueprint 控制面（P7）
 *
 * 唯一状态来源：`<repo>/.collab/blueprint/<id>/state.json`
 * 关联证据：design.md、interfaces.md、risks.md、task-graph.json、
 * test-strategy.md、acceptance-matrix.md、testability.json、
 * review-vN.verdict.json、roles.lock.json、approvals.json、materialized.json
 *
 * 规则（见 .collab/tasks/004/design.md，单步优先于旧文档的整轮描述）：
 *   - 每轮 design → testability → review；每次命令最多完成一个角色步骤；
 *   - `run` 推进下一步；`review` 仅当下一步是 review；
 *   - 失败不推进；最多三轮，耗尽即停，不自动批准；
 *   - G1 与内容哈希每次从落盘重新计算；批准绑定该哈希；
 *   - materialize 仅在 G1 与批准同时有效时执行，并保留依赖、输入、输出、
 *     write_scope、AC 内容、验收方向和测试层级。
 */
import fs from 'node:fs'
import path from 'node:path'

import { getAdapter } from './adapters/index.mjs'
import { clampEffort } from './exec.mjs'
import { GATE_SCHEMA, evaluateGate, sha256Content } from './contracts/gate.mjs'
import { isRoleEligible, normalizeModel } from './model-catalog.mjs'
import { extractJson, splitModelOutput, readonlyProvider, evaluateG0, isValidSessionId } from './studio.mjs'

export const BLUEPRINT_DIR = '.collab/blueprint'
export const TASKS_DIR = '.collab/tasks'
export const BLUEPRINT_ROLES = ['designer', 'reviewer', 'test_architect']
export const BLUEPRINT_SCHEMA = 'agentline.blueprint/v1'
export const TASKGRAPH_SCHEMA = 'agentline.taskgraph/v1'
export const ROLESLOCK_SCHEMA = 'agentline.roleslock/v1'
export const ORIGIN_SCHEMA = 'agentline.origin/v1'
export const APPROVALS_SCHEMA = 'agentline.approvals/v1'
export const ROUND_LIMIT = 3

const ROLE_PHASE = { designer: 'design', test_architect: 'testability', reviewer: 'review' }
const PHASE_ROLE = { design: 'designer', testability: 'test_architect', review: 'reviewer' }

const DESIGN_FILES = ['design.md', 'interfaces.md', 'risks.md']
const STRATEGY_FILES = ['test-strategy.md', 'acceptance-matrix.md']
const CONTENT_FILES = [
  'design.md', 'interfaces.md', 'risks.md', 'task-graph.json',
  'test-strategy.md', 'acceptance-matrix.md', 'testability.json', 'roles.lock.json',
]

const TASK_ID_RE = /^T-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const AC_ID_RE = /^AC-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REVIEW_RE = /^review-v([1-9]\d*)\.verdict\.json$/

export class BlueprintError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BlueprintError'
    this.code = code
  }
}

export function assertSessionId(id) {
  if (!isValidSessionId(id)) {
    throw new BlueprintError('E_SESSION_ID', `invalid blueprint session id: ${JSON.stringify(id)} (single safe path segment required)`)
  }
}

export function blueprintRoot(repo) { return path.join(repo, BLUEPRINT_DIR) }
export function sessionDir(repo, id) {
  assertSessionId(id)
  return path.join(blueprintRoot(repo), id)
}

function readJson(file) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) } } catch (e) {
    return { ok: false, value: null, error: e.message }
  }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 不留下半截临时文件 */ }
    throw e
  }
}
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = String(text).endsWith('\n') ? String(text) : String(text) + '\n'
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, file)
}
function nowIso() { return new Date().toISOString() }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

function normalizeNewlines(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** RFC 8785 的子集：对象键排序、无空白。只用于字符串、布尔、有限数字、数组和对象。 */
export function canonicalJson(value) {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new BlueprintError('E_CANONICAL', 'non-finite number in canonical json')
    return JSON.stringify(value)
  }
  if (t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']'
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
  }
  throw new BlueprintError('E_CANONICAL', `cannot canonicalize ${t}`)
}

export function canonicalHash(value) {
  return sha256Content(canonicalJson(value))
}

function fileSha(text) {
  const body = text == null ? '\0missing' : normalizeNewlines(text)
  return sha256Content(body).slice('sha256:'.length)
}

/** 内容哈希：文件按路径排序，条目 {path, sha256} 再做一次规范 JSON 哈希。 */
export function hashEntries(entries) {
  const files = entries.map((e) => ({ path: e.path, sha256: fileSha(e.text) }))
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return sha256Content(canonicalJson(files))
}

function readFileText(dir, name) {
  return readText(path.join(dir, name))
}

function g0Now(repo, session) {
  const from = session && session.from
  if (!from || from.kind !== 'studio' || !isValidSessionId(from.id)) return { pass: false, content_hash: null, status: 'not_evaluated' }
  try { return evaluateG0(repo, from.id) } catch { return { pass: false, content_hash: null, status: 'fail' } }
}

function digestSet(dir, session, repo) {
  const entry = (name) => ({ path: name, text: readFileText(dir, name) })
  const g0 = g0Now(repo, session)
  return {
    design_digest: hashEntries(DESIGN_FILES.map(entry)),
    graph_digest: hashEntries([entry('task-graph.json')]),
    strategy_digest: hashEntries(STRATEGY_FILES.map(entry)),
    gate_hash: g0.content_hash || null,
  }
}

export function currentDigests(repo, id) {
  const r = readBlueprint(repo, id)
  if (!r.session) throw new BlueprintError('E_NO_SESSION', `blueprint session not found: ${id}`)
  return digestSet(r.dir, r.session, repo)
}

function sourceBindingText(session) {
  const from = session && session.from
  if (!isObject(from) || from.kind !== 'studio') return canonicalJson(null)
  return canonicalJson({
    kind: 'studio',
    id: typeof from.id === 'string' ? from.id : '',
    gate_hash: typeof from.gate_hash === 'string' ? from.gate_hash : '',
  })
}

function contentEntries(dir, session, repo) {
  const entries = CONTENT_FILES.map((name) => ({ path: name, text: readFileText(dir, name) }))
  const last = lastReviewMeta(dir)
  if (last) entries.push({ path: last.name, text: readFileText(dir, last.name) })
  const g0 = g0Now(repo, session)
  // 来源绑定和当前 G0 哈希都进入内容集合：来源失效即批准哈希失效。
  entries.push({ path: 'source/from.json', text: sourceBindingText(session) })
  entries.push({ path: 'source/g0.content_hash', text: g0.content_hash || '' })
  return entries
}

export function contentHashOf(repo, id) {
  const r = readBlueprint(repo, id)
  if (!r.session) return null
  return hashEntries(contentEntries(r.dir, r.session, repo))
}

// ───────────────────────────── 角色 ─────────────────────────────

function roleList(config, projectCfg, role) {
  const fromProject = projectCfg?.blueprint?.roles?.[role]
  const fromConfig = config?.blueprint?.roles?.[role]
  const raw = fromProject !== undefined ? fromProject : fromConfig
  if (Array.isArray(raw)) return raw.filter((k) => typeof k === 'string' && k)
  if (typeof raw === 'string' && raw) return [raw]
  return []
}

function vendorOf(providerName, provider) {
  const source = provider && typeof provider.source === 'string' ? provider.source.trim() : ''
  return source || providerName || ''
}

function eligibilityFor(key, model) {
  return isRoleEligible(normalizeModel({
    key,
    provider: model?.provider,
    id: model?.id || key,
    tier: model?.tier,
    identity: model?.identity,
    availability: model?.availability,
    source: model?.source,
  }), { tier: 'top' })
}

export function readBlueprintRoles(config = {}, projectCfg = {}) {
  const out = {}
  for (const role of BLUEPRINT_ROLES) {
    const keys = roleList(config, projectCfg, role)
    const models = keys.filter((k) => config.models?.[k])
    const primary = models[0] || null
    const model = primary ? config.models[primary] : null
    const provider = model ? config.providers?.[model.provider] : null
    out[role] = {
      role,
      tier: 'top',
      primary,
      backups: models.slice(1),
      modelId: model ? model.id : null,
      vendor: model ? vendorOf(model.provider, provider) : null,
      constraint: role === 'reviewer' ? 'top · ≠设计厂商' : (role === 'test_architect' ? 'top · ≠两者（偏好）' : 'top'),
      configured: !!primary,
    }
  }
  return out
}

function resolveRoles(config, projectCfg, overrides = {}) {
  const resolved = {}
  for (const role of BLUEPRINT_ROLES) {
    const explicit = overrides[role]
    const keys = explicit ? [explicit] : roleList(config, projectCfg, role)
    if (!keys.length) {
      throw new BlueprintError('E_ROLE_UNSET', `blueprint role ${role} is not configured (set blueprint.roles.${role} or pass --${role.replace(/_/g, '-')})`)
    }
    let picked = null
    const reasons = []
    for (const key of keys) {
      const model = config.models?.[key]
      if (!model) { reasons.push(`${key}: unknown model`); continue }
      const eligible = eligibilityFor(key, model)
      if (!eligible.ok) { reasons.push(`${key}: ${eligible.reason}`); continue }
      const provider = config.providers?.[model.provider]
      if (!provider) { reasons.push(`${key}: provider ${model.provider} not configured`); continue }
      if (!readonlyProvider(provider)) { reasons.push(`${key}: provider ${model.provider} cannot be forced read-only`); continue }
      picked = { key, model, provider }
      break
    }
    if (!picked) throw new BlueprintError('E_ROLE_INELIGIBLE', `blueprint role ${role} has no eligible model: ${reasons.join('; ')}`)
    const vendor = vendorOf(picked.model.provider, picked.provider)
    const identityGroup = (typeof picked.model.identity_group === 'string' && picked.model.identity_group.trim())
      ? picked.model.identity_group.trim()
      : `${vendor}/${picked.model.id}`
    resolved[role] = {
      model: picked.key,
      id: picked.model.id,
      tier: picked.model.tier || 'unknown',
      provider: picked.model.provider,
      vendor,
      identity_group: identityGroup,
      identity: picked.model.identity === 'verified' ? 'verified' : 'unverified',
    }
  }
  const groups = BLUEPRINT_ROLES.map((r) => resolved[r].identity_group)
  const ids = BLUEPRINT_ROLES.map((r) => `${resolved[r].provider}:${resolved[r].id}`)
  if (new Set(groups).size !== 3 || new Set(ids).size !== 3) {
    throw new BlueprintError('E_ROLE_INELIGIBLE', `blueprint roles must be pairwise distinct (identity_group and model): ${ids.join(', ')}`)
  }
  if (!resolved.designer.vendor || resolved.designer.vendor === resolved.reviewer.vendor) {
    throw new BlueprintError('E_ROLE_INELIGIBLE', `designer and reviewer must use different vendors (both ${resolved.designer.vendor || 'unknown'})`)
  }
  for (const role of BLUEPRINT_ROLES) {
    if (resolved[role].tier !== 'top') {
      throw new BlueprintError('E_ROLE_INELIGIBLE', `blueprint role ${role} must be top (is ${resolved[role].tier})`)
    }
  }
  return resolved
}

function lockFromRoles(roles) {
  const one = (role) => ({
    key: roles[role].model,
    id: roles[role].id,
    identity_group: roles[role].identity_group,
    vendor: roles[role].vendor,
    tier: roles[role].tier,
    identity: roles[role].identity,
  })
  return {
    schema: ROLESLOCK_SCHEMA,
    stage: 'blueprint',
    locked_at: nowIso(),
    roles: {
      designer: { candidates: [one('designer')] },
      reviewer: { candidates: [one('reviewer')] },
      test_architect: { candidates: [one('test_architect')] },
    },
  }
}

function candidateOf(lock, role) {
  const list = lock && lock.roles && lock.roles[role] && lock.roles[role].candidates
  if (!Array.isArray(list) || !list.length || !isObject(list[0])) return null
  return list[0]
}

// ───────────────────────────── 读取 ─────────────────────────────

function validState(s) {
  return isObject(s)
    && s.schema === BLUEPRINT_SCHEMA
    && typeof s.id === 'string'
    && typeof s.status === 'string'
    && typeof s.input === 'string'
    && (s.phase === 'design' || s.phase === 'testability' || s.phase === 'review')
    && isObject(s.round) && Number.isInteger(s.round.current) && s.round.current >= 1 && Number.isInteger(s.round.max)
    && isObject(s.roles)
    && BLUEPRINT_ROLES.every((r) => isObject(s.roles[r]))
}

function listReviewFiles(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    const m = REVIEW_RE.exec(name)
    if (m) out.push({ name, round: Number(m[1]) })
  }
  out.sort((a, b) => a.round - b.round)
  return out
}

function lastReviewMeta(dir) {
  const all = listReviewFiles(dir)
  return all.length ? all[all.length - 1] : null
}

export function readBlueprint(repo, id) {
  const dir = sessionDir(repo, id)
  if (!fs.existsSync(dir)) return { state: 'missing', dir, session: null, errors: [] }
  const statePath = path.join(dir, 'state.json')
  if (!fs.existsSync(statePath)) return { state: 'empty', dir, session: null, errors: [] }
  const raw = readJson(statePath)
  if (!raw.ok) return { state: 'corrupt', dir, session: null, errors: [`state.json unreadable: ${raw.error}`] }
  if (!validState(raw.value)) return { state: 'corrupt', dir, session: null, errors: ['state.json missing required fields'] }

  const errors = []
  const mark = (name) => {
    const p = path.join(dir, name)
    if (!fs.existsSync(p)) return { value: null, present: false }
    const parsed = readJson(p)
    if (!parsed.ok) {
      errors.push(`${name} unreadable: ${parsed.error}`)
      return { value: null, present: true, invalid: true }
    }
    return { value: parsed.value, present: true, invalid: false }
  }

  const rolesLock = mark('roles.lock.json')
  const taskGraph = mark('task-graph.json')
  const testability = mark('testability.json')
  const approvals = mark('approvals.json')
  const materialized = mark('materialized.json')
  const reviews = []
  for (const meta of listReviewFiles(dir)) {
    const parsed = readJson(path.join(dir, meta.name))
    if (!parsed.ok) errors.push(`${meta.name} unreadable: ${parsed.error}`)
    else if (!isObject(parsed.value)) errors.push(`${meta.name} is not an object`)
    else reviews.push({ ...meta, value: parsed.value })
  }

  return {
    state: errors.length ? 'corrupt' : 'ok',
    dir,
    session: raw.value,
    errors,
    rolesLock: rolesLock.value,
    taskGraph: taskGraph.invalid ? null : taskGraph.value,
    matrixText: readFileText(dir, 'acceptance-matrix.md'),
    testability: testability.invalid ? null : testability.value,
    reviews,
    approvals: approvals.value,
    materialized: materialized.invalid ? null : materialized.value,
  }
}

export function listSessions(repo) {
  const root = blueprintRoot(repo)
  let names = []
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  const out = []
  for (const id of names) {
    if (!isValidSessionId(id)) continue
    const r = readBlueprint(repo, id)
    out.push({
      id,
      state: r.state,
      title: r.session?.title || id,
      status: r.session?.status || r.state,
      phase: r.session?.phase || null,
      round: r.session?.round?.current ?? null,
      updated_at: r.session?.updated_at || null,
    })
  }
  out.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || a.id.localeCompare(b.id))
  return out
}

function loadForWrite(repo, id) {
  const r = readBlueprint(repo, id)
  if (r.state === 'missing') throw new BlueprintError('E_NO_SESSION', `blueprint session not found: ${id}`)
  if (r.state === 'empty') throw new BlueprintError('E_EMPTY_SESSION', `blueprint session ${id} has no state.json`)
  if (r.state === 'corrupt' || !r.session) throw new BlueprintError('E_CORRUPT_SESSION', `blueprint session ${id} is corrupt: ${r.errors.join('; ')}`)
  return r
}

function saveSession(dir, session) {
  const next = { ...session, revision: Number(session.revision || 0) + 1, updated_at: nowIso() }
  writeJson(path.join(dir, 'state.json'), next)
  return next
}

export function createBlueprint(repo, { id, title, input, fromStudio = null }, { config, projectCfg = {}, overrides = {} } = {}) {
  assertSessionId(id)
  const dir = sessionDir(repo, id)
  if (fs.existsSync(dir)) throw new BlueprintError('E_SESSION_EXISTS', `blueprint session already exists: ${id}`)
  const text = String(input || '').trim()
  if (!text) throw new BlueprintError('E_NO_INPUT', 'blueprint new requires --input "<用户输入>"')
  const roles = resolveRoles(config, projectCfg, overrides)
  let from = null
  if (fromStudio) {
    if (!isValidSessionId(fromStudio)) throw new BlueprintError('E_SESSION_ID', `invalid studio session id: ${JSON.stringify(fromStudio)}`)
    const g0 = evaluateG0(repo, fromStudio)
    if (!g0.pass || !g0.content_hash) {
      throw new BlueprintError('E_GATE_NOT_READY', `studio ${fromStudio} G0 is not passed (${(g0.failed || []).join(', ') || g0.status})`)
    }
    from = { kind: 'studio', id: fromStudio, gate_hash: g0.content_hash }
  }
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
  const session = {
    schema: BLUEPRINT_SCHEMA,
    id,
    title: String(title || '').trim() || id,
    input: text,
    from,
    status: 'running',
    phase: 'design',
    round: { current: 1, max: ROUND_LIMIT },
    roles,
    awaiting: null,
    last_error: null,
    calls: [],
    created_at: nowIso(),
    updated_at: nowIso(),
    revision: 1,
  }
  writeJson(path.join(dir, 'state.json'), session)
  writeJson(path.join(dir, 'roles.lock.json'), lockFromRoles(roles))
  return session
}

// ───────────────────────────── 下一步 ─────────────────────────────

/**
 * 下一步只看落盘状态。`passed` 且检查仍通过时不再调用模型；
 * 检查已失败且轮次未用尽时，下一次 `run` 开始新一轮 design。
 */
export function decide(session, g1) {
  if (!session) return { kind: 'stop', code: 'E_NO_SESSION', role: null }
  if (session.status === 'materialized') return { kind: 'stop', code: 'E_ALREADY_MATERIALIZED', role: null }
  const awaiting = session.awaiting && session.awaiting.kind
  if (awaiting === 'round_limit') return { kind: 'stop', code: 'E_ROUND_LIMIT', role: null }
  if (awaiting === 'gate_approval') return { kind: 'stop', code: 'E_AWAITING_USER', role: null }
  if (session.status === 'passed' && g1 && g1.checks_pass) return { kind: 'stop', code: 'E_NO_STEP', role: null }
  const startNextRound = () => {
    if (session.round.current >= ROUND_LIMIT) return { kind: 'stop', code: 'E_ROUND_LIMIT', role: null }
    return { kind: 'step', role: 'designer', phase: 'design', round: session.round.current + 1, startRound: true }
  }
  if (session.status === 'passed' && g1 && !g1.checks_pass) return startNextRound()
  if (awaiting === 'continue_round') return startNextRound()
  const role = PHASE_ROLE[session.phase]
  if (!role) return { kind: 'stop', code: 'E_NO_STEP', role: null }
  return { kind: 'step', role, phase: session.phase, round: session.round.current, startRound: false }
}

function stopMessage(step) {
  if (step.code === 'E_ROUND_LIMIT') return 'blueprint round limit reached (3); not starting another round and not auto-approving'
  if (step.code === 'E_AWAITING_USER') return 'awaiting approval; run "blueprint approve" (review cannot skip ahead)'
  if (step.code === 'E_NO_STEP') return 'no further blueprint step; G1 checks still pass — approve is already recorded, next is materialize'
  if (step.code === 'E_ALREADY_MATERIALIZED') return 'blueprint is already materialized'
  return `cannot run blueprint step (${step.code})`
}

// ───────────────────────────── 模型调用 ─────────────────────────────

function section(text) { return String(text || '').trim() || '(空)' }

function designerPrompt(session, repo) {
  const dir = sessionDir(repo, session.id)
  const lines = [
    '你是 Blueprint 的设计师（designer）。这是只读讨论：不要修改、创建或删除任何文件，也不要运行会改变工作区的命令。',
    '',
    '用户输入：',
    section(session.input),
    '',
  ]
  const prev = lastReviewMeta(dir)
  if (prev) {
    lines.push(`上一轮评审文件：${prev.name}`, section(readFileText(dir, prev.name)), '')
  }
  lines.push(
    '请给出设计正文，并在最后只输出一个 JSON 对象（不要加代码块标记）：',
    '{"interfaces":"接口说明","risks":"风险说明","task_graph":{"schema":"agentline.taskgraph/v1","milestones":[{"id":"M1","title":"里程碑"}],"acceptance":[{"id":"AC-001","text":"验收内容","levels":["unit"]}],"tasks":[{"id":"T-001","title":"任务","milestone":"M1","inputs":["输入"],"outputs":["输出"],"depends_on":[],"write_scope":["path/**"],"acceptance":["AC-001"],"acceptance_direction":["可执行验收命令"],"test_levels":["unit"]}]}}',
    '每个任务都要有 inputs、outputs、write_scope、depends_on、acceptance、acceptance_direction、test_levels。AC 必须双向覆盖。依赖只能引用存在的任务 ID。',
  )
  return lines.join('\n')
}

function testabilityPrompt(session, dir) {
  return [
    '你是 Blueprint 的测试架构师（test_architect）。这是只读讨论：不要修改、创建或删除任何文件。',
    '',
    '设计：',
    section(readFileText(dir, 'design.md')),
    '',
    '任务图：',
    section(readFileText(dir, 'task-graph.json')),
    '',
    '请只输出一个 JSON 对象（不要加代码块标记）：',
    '{"strategy":"测试策略正文","blockers":[{"id":"TB-1","status":"open","text":"阻塞说明"}]}',
    '没有阻塞时 blockers 为空数组。status 只能是 open 或 resolved。',
  ].join('\n')
}

function reviewPrompt(session, dir) {
  return [
    '你是 Blueprint 的评审（reviewer）。这是只读讨论：不要修改、创建或删除任何文件。',
    '',
    '设计：',
    section(readFileText(dir, 'design.md')),
    '',
    '任务图：',
    section(readFileText(dir, 'task-graph.json')),
    '',
    '验收矩阵：',
    section(readFileText(dir, 'acceptance-matrix.md')),
    '',
    '测试架构：',
    section(readFileText(dir, 'testability.json')),
    '',
    '请只输出一个 JSON 对象（不要加代码块标记）：',
    '{"verdict":"pass","findings":[{"id":"F-01","severity":"blocking","status":"open","text":"问题"}]}',
    'verdict 只能是 pass 或 revise。severity 只能是 blocking、major 或 minor。status 只能是 open、resolved 或 disputed。',
  ].join('\n')
}

async function callRole({ repo, dir, role, prompt, config, adapterFactory, log, session }) {
  const assigned = session.roles[role]
  if (!assigned) throw new BlueprintError('E_ROLE_UNASSIGNED', `role ${role} has no assigned model`)
  const model = config.models?.[assigned.model]
  if (!model) throw new BlueprintError('E_MODEL_MISSING', `model ${assigned.model} is no longer configured`)
  const eligible = eligibilityFor(assigned.model, model)
  if (!eligible.ok) throw new BlueprintError('E_ROLE_INELIGIBLE', `blueprint role ${role} model ${assigned.model} is not eligible: ${eligible.reason}`)
  const providerCfg = config.providers?.[model.provider]
  if (!providerCfg) throw new BlueprintError('E_PROVIDER_MISSING', `provider ${model.provider} is not configured`)
  const provider = readonlyProvider(providerCfg)
  if (!provider) throw new BlueprintError('E_READONLY_UNAVAILABLE', `provider ${model.provider} cannot guarantee a read-only Blueprint step`)
  const adapter = adapterFactory ? adapterFactory(provider) : getAdapter(provider)
  if (!adapter || typeof adapter.run !== 'function') throw new BlueprintError('E_NO_ADAPTER', `no adapter for provider ${model.provider}`)
  const logsDir = path.join(dir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const logPath = path.join(logsDir, `${role}.log`)
  const effort = clampEffort(config.effort?.default || 'high', provider)
  log?.(`[blueprint ${role}] model=${assigned.model}(${model.id}) provider=${model.provider} effort=${effort ?? '-'}`)
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
    throw new BlueprintError('E_MODEL_CALL', `${role} call failed: ${e && e.message ? e.message : String(e)}`)
  }
  if (!res || res.exitCode !== 0 || res.error) {
    throw new BlueprintError('E_MODEL_FAILED', `${role} call failed: ${(res && (res.error || `exit ${res.exitCode}`)) || 'no result'}`)
  }
  const resolved = res.modelResolved == null ? '' : String(res.modelResolved)
  if (!resolved) throw new BlueprintError('E_MODEL_UNVERIFIED', `${role} call did not return model_resolved; identity is not verified`)
  if (resolved !== model.id) throw new BlueprintError('E_MODEL_MISMATCH', `${role} model_resolved ${resolved} != requested ${model.id}`)
  return {
    text: String(res.text ?? res.stdout ?? ''),
    model: assigned.model,
    modelId: model.id,
    modelResolved: resolved,
    vendor: assigned.vendor,
    identity: 'verified',
    readonly: true,
  }
}

function callRecord(stepId, role, result, ok, error) {
  return {
    step: stepId,
    role,
    model: result?.model || null,
    model_id: result?.modelId || null,
    model_resolved: result?.modelResolved || null,
    identity: ok ? 'verified' : 'unverified',
    readonly: ok ? true : false,
    at: nowIso(),
    ok,
    error: error || null,
  }
}

function failStep(dir, session, stepId, role, result, error) {
  saveSession(dir, {
    ...session,
    status: 'blocked',
    last_error: error.message,
    calls: [...(session.calls || []), callRecord(stepId, role, result, false, error.message)],
  })
}

// ───────────────────────────── 产物校验 ─────────────────────────────

function stringList(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) return null
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return null
    out.push(item.trim())
  }
  if (!allowEmpty && out.length === 0) return null
  return out
}

function normalizeGraph(raw) {
  if (!isObject(raw) || raw.schema !== TASKGRAPH_SCHEMA) return null
  if (!Array.isArray(raw.acceptance) || !Array.isArray(raw.tasks)) return null
  const acceptance = []
  const seenAc = new Set()
  for (const ac of raw.acceptance) {
    if (!isObject(ac) || typeof ac.id !== 'string' || !AC_ID_RE.test(ac.id)) return null
    if (seenAc.has(ac.id)) return null
    seenAc.add(ac.id)
    const text = typeof ac.text === 'string' ? ac.text.trim() : ''
    if (!text) return null
    const levels = stringList(ac.levels, { allowEmpty: false })
    if (!levels) return null
    acceptance.push({
      id: ac.id,
      text,
      levels: [...levels].sort(),
      ...(typeof ac.manual === 'boolean' ? { manual: ac.manual } : {}),
    })
  }
  const tasks = []
  const seenTask = new Set()
  for (const t of raw.tasks) {
    if (!isObject(t) || typeof t.id !== 'string' || !TASK_ID_RE.test(t.id)) return null
    if (seenTask.has(t.id)) return null
    seenTask.add(t.id)
    const inputs = stringList(t.inputs)
    const outputs = stringList(t.outputs)
    const writeScope = stringList(t.write_scope)
    const depends = stringList(t.depends_on, { allowEmpty: true })
    const direction = stringList(t.acceptance_direction)
    const levels = stringList(t.test_levels)
    const owned = stringList(t.acceptance)
    if (!inputs || !outputs || !writeScope || !depends || !direction || !levels || !owned) return null
    const title = typeof t.title === 'string' ? t.title.trim() : ''
    if (!title) return null
    const task = {
      id: t.id,
      title,
      inputs, outputs,
      depends_on: depends,
      write_scope: writeScope,
      acceptance: owned,
      acceptance_direction: direction,
      test_levels: [...levels].sort(),
    }
    if (t.milestone != null) {
      if (typeof t.milestone !== 'string' || !t.milestone.trim()) return null
      task.milestone = t.milestone.trim()
    }
    if (typeof t.risk === 'string' && t.risk.trim()) task.risk = t.risk.trim()
    if (typeof t.user_gate === 'boolean') task.user_gate = t.user_gate
    tasks.push(task)
  }
  if (!acceptance.length || !tasks.length) return null
  const milestones = []
  if (raw.milestones != null) {
    if (!Array.isArray(raw.milestones)) return null
    for (const m of raw.milestones) {
      if (!isObject(m) || typeof m.id !== 'string' || !m.id.trim()) return null
      milestones.push({
        id: m.id.trim(),
        ...(typeof m.title === 'string' ? { title: m.title } : {}),
        ...(Array.isArray(m.e2e) ? { e2e: m.e2e.map(String) } : {}),
        ...(typeof m.user_gate === 'boolean' ? { user_gate: m.user_gate } : {}),
      })
    }
  }
  return { schema: TASKGRAPH_SCHEMA, milestones, acceptance, tasks }
}

export function renderAcceptanceMatrix(graph) {
  const tasks = Array.isArray(graph?.tasks) ? graph.tasks : []
  const acs = Array.isArray(graph?.acceptance) ? [...graph.acceptance] : []
  acs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const lines = [
    '# 验收矩阵',
    '',
    '| AC | levels | tasks | task_levels |',
    '|---|---|---|---|',
  ]
  for (const ac of acs) {
    const owners = tasks.filter((t) => Array.isArray(t.acceptance) && t.acceptance.includes(ac.id))
    const levels = (Array.isArray(ac.levels) ? ac.levels.map(String) : []).slice().sort()
    const taskIds = owners.map((t) => t.id).sort()
    const taskLevels = owners.map((t) => {
      const lv = (Array.isArray(t.test_levels) ? t.test_levels.map(String) : []).slice().sort()
      return `${t.id}:${lv.join(',')}`
    }).sort()
    lines.push(`| ${ac.id} | ${levels.join(',')} | ${taskIds.join(',')} | ${taskLevels.join(';')} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function parseMatrix(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const rows = []
  for (const line of normalizeNewlines(text).split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 4) continue
    if (!AC_ID_RE.test(cells[0])) continue
    const levels = cells[1] ? cells[1].split(',').map((s) => s.trim()).filter(Boolean).sort() : []
    const tasks = cells[2] ? cells[2].split(',').map((s) => s.trim()).filter(Boolean).sort() : []
    const taskLevels = cells[3]
      ? cells[3].split(';').map((s) => s.trim()).filter(Boolean).sort()
      : []
    rows.push({ id: cells[0], levels, tasks, task_levels: taskLevels })
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return rows
}

function matrixModel(graph) {
  return parseMatrix(renderAcceptanceMatrix(graph))
}

function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

function normalizeBlockers(raw) {
  if (!Array.isArray(raw)) return null
  const out = []
  for (const b of raw) {
    if (!isObject(b) || typeof b.id !== 'string' || !b.id.trim()) return null
    if (b.status !== 'open' && b.status !== 'resolved') return null
    if (typeof b.text !== 'string' || !b.text.trim()) return null
    out.push({ id: b.id.trim(), status: b.status, text: b.text.trim() })
  }
  return out
}

function normalizeFindings(raw) {
  if (!Array.isArray(raw)) return null
  const out = []
  const seen = new Set()
  for (const f of raw) {
    if (!isObject(f) || typeof f.id !== 'string' || !f.id.trim()) return null
    if (seen.has(f.id)) return null
    seen.add(f.id)
    if (f.severity !== 'blocking' && f.severity !== 'major' && f.severity !== 'minor') return null
    if (f.status !== 'open' && f.status !== 'resolved' && f.status !== 'disputed') return null
    if (typeof f.text !== 'string' || !f.text.trim()) return null
    out.push({ id: f.id.trim(), severity: f.severity, status: f.status, text: f.text.trim() })
  }
  return out
}

function unresolvedBlocking(findings) {
  // 与写入时的 normalizeFindings 同一套：非空 id/text、合法 severity/status。
  // 缺字段或空白不能因为 status 是 resolved 就当成已通过的评审。
  const normalized = normalizeFindings(findings)
  if (!normalized) return ['findings:invalid']
  return normalized.filter((f) => f.severity === 'blocking' && f.status !== 'resolved').map((f) => f.id)
}

function openBlockers(testability) {
  if (!testability || !Array.isArray(testability.blockers)) return ['testability:invalid']
  // 与写入时的 normalizeBlockers 同一套：非空 id/text、status 只能是 open|resolved。
  const normalized = normalizeBlockers(testability.blockers)
  if (!normalized) return ['blocker:invalid']
  return normalized.filter((b) => b.status === 'open').map((b) => b.id)
}

// ───────────────────────────── 执行一步 ─────────────────────────────

async function executeStep(repo, id, { config, adapterFactory = null, log, onlyRole = null } = {}) {
  const r = loadForWrite(repo, id)
  const session = r.session
  const g1 = evaluateG1(repo, id)
  const step = decide(session, g1)
  if (step.kind !== 'step') throw new BlueprintError(step.code, stopMessage(step))
  if (onlyRole && step.role !== onlyRole) {
    throw new BlueprintError('E_STEP_ORDER', `review only runs when the next step is review (next=${step.role})`)
  }
  const dir = r.dir
  const round = step.round
  const phase = step.phase
  const role = step.role
  const stepId = `r${round}.${phase}`
  let prompt = ''
  if (role === 'designer') prompt = designerPrompt(session, repo)
  else if (role === 'test_architect') prompt = testabilityPrompt(session, dir)
  else prompt = reviewPrompt(session, dir)

  let result
  try {
    result = await callRole({ repo, dir, role, prompt, config, adapterFactory, log, session })
  } catch (e) {
    if (e instanceof BlueprintError) failStep(dir, session, stepId, role, null, e)
    throw e
  }

  try {
    if (role === 'designer') applyDesign(dir, result.text)
    else if (role === 'test_architect') applyTestability(repo, dir, session, round, result)
    else applyReview(repo, dir, session, round, result)
  } catch (e) {
    const err = e instanceof BlueprintError ? e : new BlueprintError('E_INVALID_OUTPUT', e.message)
    failStep(dir, session, stepId, role, result, err)
    throw err
  }

  const base = {
    ...session,
    round: { current: round, max: ROUND_LIMIT },
    phase,
    last_error: null,
    calls: [...(session.calls || []), callRecord(stepId, role, result, true, null)],
  }
  let next = { ...base, status: 'running', awaiting: null }
  if (role === 'designer') next.phase = 'testability'
  else if (role === 'test_architect') next.phase = 'review'
  else next = finishReview(repo, id, dir, next, round)
  const saved = saveSession(dir, next)
  return { ok: true, step: stepId, role, round, session: saved }
}

function applyDesign(dir, text) {
  const split = splitModelOutput(text)
  const graph = normalizeGraph(split.json && split.json.task_graph)
  const interfaces = split.json && typeof split.json.interfaces === 'string' ? split.json.interfaces.trim() : ''
  const risks = split.json && typeof split.json.risks === 'string' ? split.json.risks.trim() : ''
  if (!split.prose || !graph || !interfaces || !risks) {
    throw new BlueprintError('E_INVALID_OUTPUT', 'designer output is missing design prose, interfaces, risks, or a valid task-graph; step not advanced')
  }
  writeText(path.join(dir, 'design.md'), split.prose)
  writeText(path.join(dir, 'interfaces.md'), interfaces)
  writeText(path.join(dir, 'risks.md'), risks)
  writeJson(path.join(dir, 'task-graph.json'), graph)
}

function applyTestability(repo, dir, session, round, result) {
  const parsed = extractJson(result.text)
  const strategy = parsed && typeof parsed.strategy === 'string' ? parsed.strategy.trim() : ''
  const blockers = parsed ? normalizeBlockers(parsed.blockers) : null
  if (!strategy || !blockers) {
    throw new BlueprintError('E_INVALID_OUTPUT', 'testability output must include strategy text and a blockers array; step not advanced')
  }
  if (!readFileText(dir, 'design.md') || !readFileText(dir, 'task-graph.json')) {
    throw new BlueprintError('E_INVALID_OUTPUT', 'testability requires design.md and task-graph.json on disk')
  }
  const graph = readJson(path.join(dir, 'task-graph.json'))
  writeText(path.join(dir, 'test-strategy.md'), strategy)
  writeText(path.join(dir, 'acceptance-matrix.md'), renderAcceptanceMatrix(graph.value))
  const digests = digestSet(dir, { ...session, round: { current: round, max: ROUND_LIMIT } }, repo)
  writeJson(path.join(dir, 'testability.json'), {
    round,
    role: 'test_architect',
    model: result.model,
    id: result.modelId,
    model_resolved: result.modelResolved,
    identity: 'verified',
    vendor: result.vendor,
    input_digests: {
      design_digest: digests.design_digest,
      graph_digest: digests.graph_digest,
      strategy_digest: digests.strategy_digest,
    },
    blockers,
  })
}

function applyReview(repo, dir, session, round, result) {
  const parsed = extractJson(result.text)
  const verdict = parsed && parsed.verdict
  const findings = parsed ? normalizeFindings(parsed.findings) : null
  if ((verdict !== 'pass' && verdict !== 'revise') || !findings) {
    throw new BlueprintError('E_INVALID_OUTPUT', 'review output must include verdict pass|revise and a findings array; step not advanced')
  }
  const digests = digestSet(dir, { ...session, round: { current: round, max: ROUND_LIMIT } }, repo)
  writeJson(path.join(dir, `review-v${round}.verdict.json`), {
    round,
    reviewer: {
      model: result.model,
      id: result.modelId,
      model_resolved: result.modelResolved,
      identity: 'verified',
      vendor: result.vendor,
    },
    input_digests: {
      design_digest: digests.design_digest,
      graph_digest: digests.graph_digest,
      strategy_digest: digests.strategy_digest,
      gate_hash: digests.gate_hash,
    },
    model_output_sha256: sha256Content(result.text),
    verdict,
    findings,
  })
}

function finishReview(repo, id, dir, session, round) {
  const review = readJson(path.join(dir, `review-v${round}.verdict.json`))
  const testability = readJson(path.join(dir, 'testability.json'))
  const blocking = unresolvedBlocking(review.value && review.value.findings)
  const blockers = openBlockers(testability.value)
  const passed = review.value && review.value.verdict === 'pass' && blocking.length === 0 && blockers.length === 0
  const refs = [`review-v${round}.verdict.json`]
  const since = nowIso()
  if (passed) {
    const g1 = evaluateG1(repo, id, { session })
    if (g1.checks_pass) {
      return { ...session, status: 'awaiting_user', awaiting: { kind: 'gate_approval', refs, since } }
    }
  }
  if (round >= ROUND_LIMIT) {
    return { ...session, status: 'awaiting_user', awaiting: { kind: 'round_limit', refs, since } }
  }
  return { ...session, status: 'awaiting_user', awaiting: { kind: 'continue_round', refs, since } }
}

export async function runBlueprintStep(repo, id, opts = {}) {
  return executeStep(repo, id, opts)
}

export async function reviewBlueprint(repo, id, opts = {}) {
  return executeStep(repo, id, { ...opts, onlyRole: 'reviewer' })
}

// ───────────────────────────── G1 ─────────────────────────────

function check(id, desc, pass, waivable, evidence) {
  return { id, desc, pass: !!pass, waivable: !!waivable, evidence: evidence || '' }
}

function digestsMatch(stored, current, keys) {
  if (!isObject(stored)) return keys.map((k) => k)
  const stale = []
  for (const k of keys) {
    if (!stored[k] || stored[k] !== current[k]) stale.push(k)
  }
  return stale
}

function graphProblems(graph) {
  const problems = { schema: [], fields: [], acyclic: [], coverage: [] }
  if (!isObject(graph) || graph.schema !== TASKGRAPH_SCHEMA || !Array.isArray(graph.tasks) || !Array.isArray(graph.acceptance)) {
    problems.schema.push('schema')
    problems.fields.push('graph')
    problems.acyclic.push('graph')
    problems.coverage.push('graph')
    return problems
  }
  // 空数组不能靠“每条都满足”空过。落盘重读必须拒绝空任务和空验收。
  if (graph.acceptance.length === 0) {
    problems.schema.push('acceptance:empty')
    problems.coverage.push('acceptance:empty')
  }
  if (graph.tasks.length === 0) {
    problems.schema.push('tasks:empty')
    problems.fields.push('tasks:empty')
    problems.coverage.push('tasks:empty')
  }
  const acIds = []
  for (const ac of graph.acceptance) {
    if (!isObject(ac) || typeof ac.id !== 'string' || !AC_ID_RE.test(ac.id) || !String(ac.text || '').trim() || !Array.isArray(ac.levels) || !ac.levels.length) {
      problems.schema.push(ac && ac.id ? ac.id : 'acceptance')
    } else acIds.push(ac.id)
  }
  if (new Set(acIds).size !== acIds.length) problems.schema.push('duplicate-ac')
  const taskIds = []
  const milestones = new Set((graph.milestones || []).filter((m) => m && m.id).map((m) => m.id))
  for (const t of graph.tasks) {
    if (!isObject(t) || typeof t.id !== 'string' || !TASK_ID_RE.test(t.id)) {
      problems.schema.push('task')
      problems.fields.push('task')
      continue
    }
    taskIds.push(t.id)
    const title = typeof t.title === 'string' ? t.title.trim() : ''
    if (!title) problems.fields.push(`${t.id}.title`)
    const need = ['inputs', 'outputs', 'write_scope', 'acceptance_direction', 'test_levels']
    for (const k of need) {
      const list = stringList(t[k], { allowEmpty: false })
      if (!list) problems.fields.push(`${t.id}.${k}`)
    }
    if (!Array.isArray(t.depends_on) || t.depends_on.some((d) => typeof d !== 'string' || !d)) problems.fields.push(`${t.id}.depends_on`)
    if (!Array.isArray(t.acceptance)) problems.fields.push(`${t.id}.acceptance`)
  }
  if (new Set(taskIds).size !== taskIds.length) problems.schema.push('duplicate-task')
  const idSet = new Set(taskIds)
  const acSet = new Set(acIds)
  const adj = new Map()
  for (const t of graph.tasks) {
    if (!t || !t.id) continue
    const deps = Array.isArray(t.depends_on) ? t.depends_on : []
    adj.set(t.id, deps)
    for (const d of deps) if (!idSet.has(d)) problems.acyclic.push(`${t.id}->${d}`)
    if (Array.isArray(t.acceptance)) {
      for (const a of t.acceptance) if (!acSet.has(a)) problems.acyclic.push(`${t.id}:${a}`)
    }
    if (t.milestone && !milestones.has(t.milestone)) problems.acyclic.push(`${t.id}:milestone:${t.milestone}`)
  }
  const color = new Map()
  const dfs = (node, stack) => {
    color.set(node, 1)
    for (const n of adj.get(node) || []) {
      if (!idSet.has(n)) continue
      if (color.get(n) === 1) problems.acyclic.push(`cycle:${[...stack, node, n].join('>')}`)
      else if (!color.get(n)) dfs(n, [...stack, node])
    }
    color.set(node, 2)
  }
  for (const id of idSet) if (!color.get(id)) dfs(id, [])
  const covered = new Set()
  for (const t of graph.tasks) {
    if (!t || !Array.isArray(t.acceptance) || t.acceptance.length === 0) {
      problems.coverage.push(`${t && t.id ? t.id : 'task'}:no-ac`)
      continue
    }
    let any = false
    for (const a of t.acceptance) if (acSet.has(a)) { covered.add(a); any = true }
    if (!any) problems.coverage.push(`${t.id}:no-ac`)
  }
  for (const a of acSet) if (!covered.has(a)) problems.coverage.push(`${a}:unmapped`)
  return problems
}

function matrixProblems(graph, matrixText) {
  if (!isObject(graph) || !Array.isArray(graph.acceptance) || !Array.isArray(graph.tasks)) return ['matrix:no-graph']
  // 没有 AC 行时，空矩阵和空任务图会逐行比较通过。这不是一致的验收矩阵。
  if (graph.acceptance.length === 0) return ['matrix:empty']
  const parsed = parseMatrix(matrixText)
  const expected = matrixModel(graph)
  if (!parsed || !expected) return ['matrix:unreadable']
  if (parsed.length !== expected.length) return ['matrix:rows']
  const bad = []
  for (let i = 0; i < expected.length; i++) {
    const a = parsed[i]
    const b = expected[i]
    if (a.id !== b.id || !sameList(a.levels, b.levels) || !sameList(a.tasks, b.tasks) || !sameList(a.task_levels, b.task_levels)) {
      bad.push(b.id)
    }
  }
  return bad
}

function latestApproval(doc) {
  const items = doc && Array.isArray(doc.items) ? doc.items : []
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item && !item.revoked_at) return item
  }
  return null
}

function waiversFor(dir, currentHash) {
  const p = path.join(dir, 'waivers.json')
  if (!fs.existsSync(p)) return []
  const parsed = readJson(p)
  if (!parsed.ok || !Array.isArray(parsed.value)) return []
  return parsed.value.filter((w) => isObject(w) && w.content_hash === currentHash)
}

export function evaluateG1(repo, id, { now, session: sessionOverlay = null } = {}) {
  const r = readBlueprint(repo, id)
  if (!r.session || r.state === 'corrupt') {
    return {
      gate: 'G1', pass: false, checks_pass: false, status: r.state === 'missing' ? 'not_evaluated' : 'fail',
      failed: ['G1.session'], checks: [], errors: r.errors.length ? r.errors : [`blueprint session ${id} is ${r.state}`],
      content_hash: null, approval_valid: false, revision: 0,
    }
  }
  // 刚写完评审、尚未落盘的调用记录要算进身份检查，否则通过的一轮会被误判为未执行。
  const session = sessionOverlay || r.session
  const dir = r.dir
  const graph = r.taskGraph
  const gp = graphProblems(graph)
  const digests = digestSet(dir, session, repo)
  const g0 = g0Now(repo, session)
  const from = session.from
  const studioOk = !!(from && from.kind === 'studio' && from.gate_hash && g0.pass && g0.content_hash === from.gate_hash)
  const reviews = r.reviews || []
  const last = reviews.length ? reviews[reviews.length - 1] : null
  const reviewRounds = listReviewFiles(dir).map((m) => m.round)
  const roundsOk = Number.isInteger(session.round?.current) && session.round.current >= 1
    && session.round.current <= ROUND_LIMIT && reviewRounds.every((n) => n <= ROUND_LIMIT)
  const reviewStale = last ? digestsMatch(last.value && last.value.input_digests, digests, ['design_digest', 'graph_digest', 'strategy_digest', 'gate_hash']) : ['review:missing']
  const blocking = last ? unresolvedBlocking(last.value && last.value.findings) : ['review:missing']
  const verdictPass = !!(last && last.value && last.value.verdict === 'pass')
  const reviewOk = verdictPass && blocking.length === 0 && reviewStale.length === 0
  const tbStale = digestsMatch(r.testability && r.testability.input_digests, digests, ['design_digest', 'graph_digest', 'strategy_digest'])
  const blockers = openBlockers(r.testability)
  const testOk = blockers.length === 0 && tbStale.length === 0
  const lock = r.rolesLock
  const cDesign = candidateOf(lock, 'designer')
  const cReview = candidateOf(lock, 'reviewer')
  const cTest = candidateOf(lock, 'test_architect')
  const candidates = [cDesign, cReview, cTest]
  const allTop = candidates.every((c) => c && c.tier === 'top')
  const groups = candidates.map((c) => c && c.identity_group).filter(Boolean)
  const keys = candidates.map((c) => c && `${c.vendor || ''}:${c.id || c.key || ''}`)
  const pairwise = candidates.every(Boolean) && new Set(groups).size === 3 && new Set(keys).size === 3
  const vendorSplit = !!(cDesign && cReview && cDesign.vendor && cReview.vendor && cDesign.vendor !== cReview.vendor)
  const testDiverse = !!(cTest && cDesign && cReview && cTest.vendor && cTest.vendor !== cDesign.vendor && cTest.vendor !== cReview.vendor)
  const calls = Array.isArray(session.calls) ? session.calls : []
  const okCalls = calls.filter((c) => c && c.ok)
  const identityBad = []
  for (const role of BLUEPRINT_ROLES) {
    const cand = candidateOf(lock, role)
    const mine = okCalls.filter((c) => c.role === role)
    if (!cand || cand.identity !== 'verified' || !cand.id) identityBad.push(`${role}:lock`)
    if (!mine.length) identityBad.push(`${role}:no-call`)
    for (const call of mine) {
      if (call.identity !== 'verified' || !call.model_resolved) identityBad.push(`${role}:unverified`)
      else if (cand && call.model_resolved !== cand.id) identityBad.push(`${role}:mismatch`)
      else if (cand && call.model && cand.key && call.model !== cand.key) identityBad.push(`${role}:key`)
    }
  }
  if (last && last.value && last.value.reviewer) {
    const rev = last.value.reviewer
    if (rev.identity !== 'verified' || !rev.model_resolved || (cReview && rev.model_resolved !== cReview.id)) identityBad.push('reviewer:artifact')
  } else identityBad.push('reviewer:artifact')
  if (r.testability) {
    if (r.testability.identity !== 'verified' || !r.testability.model_resolved || (cTest && r.testability.model_resolved !== cTest.id)) {
      identityBad.push('test_architect:artifact')
    }
  } else identityBad.push('test_architect:artifact')
  const readonlyBad = []
  if (!okCalls.length) readonlyBad.push('no-call')
  for (const call of okCalls) if (call.readonly !== true) readonlyBad.push(call.step || call.role || 'call')
  const matrixBad = matrixProblems(graph, r.matrixText)
  const contentHash = hashEntries(contentEntries(dir, session, repo))
  const approval = latestApproval(r.approvals)
  const approvalValid = !!(approval && approval.content_hash === contentHash && !approval.revoked_at)

  let reviewEvidence = 'missing'
  if (!last) reviewEvidence = 'missing'
  else if (reviewStale.length) reviewEvidence = 'stale_evidence:' + reviewStale.join(',')
  else if (!verdictPass) reviewEvidence = `verdict:${last.value && last.value.verdict || 'missing'}`
  else if (blocking.length) reviewEvidence = 'blocking:' + blocking.join(',')
  else reviewEvidence = 'pass'

  const checks = [
    check('G1.studio_link', '来源 G0 为 passed，且其 hash 等于 from.gate_hash', studioOk, false, studioOk ? from.gate_hash : (from ? `gate_hash:${from.gate_hash || 'missing'}` : 'no-source')),
    check('G1.graph_schema', '任务图符合 agentline.taskgraph/v1，且 ID 唯一', gp.schema.length === 0, false, gp.schema.join(',') || 'ok'),
    check('G1.graph_acyclic', '依赖无环，且任务、AC、里程碑引用都存在', gp.acyclic.length === 0 && gp.schema.length === 0, false, gp.acyclic.join(',') || 'ok'),
    check('G1.ac_bidirectional', '每个 AC 至少映射到 1 个任务，每个任务至少有 1 个 AC', gp.coverage.length === 0 && gp.schema.length === 0, false, gp.coverage.join(',') || 'ok'),
    check('G1.task_fields_complete', '每个任务都有 title、inputs、outputs、write_scope、depends_on、acceptance_direction、test_levels', gp.fields.length === 0, false, gp.fields.join(',') || 'ok'),
    check('G1.matrix_consistent', '验收矩阵中的 AC 与测试层级和任务图一致', matrixBad.length === 0, false, matrixBad.join(',') || 'ok'),
    check('G1.review_pass', '最后一轮 verdict 为 pass，没有未解决的 blocking finding，且 input_digests 等于当前值', reviewOk, false, reviewEvidence),
    check('G1.rounds_within_limit', '业务轮次 ≤ 3', roundsOk, false, `round=${session.round && session.round.current};reviews=${reviewRounds.join(',') || 'none'}`),
    check('G1.testability_clear', 'testability 没有 open blocker，且 input_digests 等于当前值', testOk, false, tbStale.length ? 'stale_evidence:' + tbStale.join(',') : (blockers.join(',') || 'clear')),
    check('G1.all_top', '设计、评审、测试架构均为 top', allTop, false, candidates.map((c, i) => `${BLUEPRINT_ROLES[i]}=${c ? c.tier : 'missing'}`).join(',')),
    check('G1.roles_pairwise', '三角色模型两两不同', pairwise, false, keys.join(',')),
    check('G1.designer_reviewer_vendor', '设计与评审跨厂商', vendorSplit, false, `designer=${cDesign && cDesign.vendor};reviewer=${cReview && cReview.vendor}`),
    check('G1.test_arch_vendor_diverse', '测试架构厂商与另外两者都不同（偏好，可豁免）', testDiverse, true, `test_architect=${cTest && cTest.vendor}`),
    check('G1.identity_verified', '三角色都有已验证的实际模型身份', identityBad.length === 0, false, identityBad.join(',') || 'verified'),
    check('G1.readonly_ok', '已完成的步骤都在强制只读模式下执行', readonlyBad.length === 0, false, readonlyBad.join(',') || 'readonly'),
    check('G1.write_scope_overlap', 'write_scope 重叠只报告，不单独否决', true, false, scopeOverlap(graph)),
  ]

  // 只有标记为可豁免的检查才能进入 gate。来源 G0、只读和其余硬检查不能靠 waiver 通过。
  const waivers = waiversFor(dir, contentHash).filter((w) => {
    const target = checks.find((c) => c.id === w.check)
    return !!(target && target.waivable === true)
  })

  const gate = {
    schema: GATE_SCHEMA,
    gate: 'G1',
    subject: { kind: 'blueprint', id, content_hash: contentHash, revision: Number(session.revision || 0) },
    evaluated_at: now || nowIso(),
    checks,
    waivers,
    approval: {
      required: true,
      approved: approvalValid,
      content_hash: approval ? approval.content_hash : null,
    },
  }
  const result = evaluateGate(gate, { currentHash: contentHash })
  const hardOpen = checks.filter((c) => c.waivable !== true && c.pass !== true).map((c) => c.id)
  const failed = [...new Set([...(result.failed || []), ...hardOpen])]
  const checksPass = hardOpen.length === 0 && result.failed.length === 0 && result.errors.length === 0 && result.status !== 'fail' && result.status !== 'not_evaluated' && result.status !== 'stale'
  return {
    gate: 'G1',
    status: hardOpen.length ? 'fail' : result.status,
    pass: result.pass === true && hardOpen.length === 0,
    checks_pass: hardOpen.length === 0 && (checksPass || result.status === 'pending_approval'),
    failed,
    waived: result.waived,
    checks,
    content_hash: contentHash,
    approval_valid: approvalValid,
    approval_id: approval ? approval.approval_id : null,
    revision: gate.subject.revision,
    errors: result.errors,
  }
}

function scopeOverlap(graph) {
  if (!graph || !Array.isArray(graph.tasks)) return 'not_evaluated'
  const pairs = []
  const tasks = graph.tasks.filter((t) => t && Array.isArray(t.write_scope))
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const shared = tasks[i].write_scope.filter((s) => tasks[j].write_scope.includes(s))
      if (shared.length) pairs.push(`${tasks[i].id}+${tasks[j].id}:${shared.join('&')}`)
    }
  }
  return pairs.join(',') || 'none'
}

// ───────────────────────────── 批准 ─────────────────────────────

function approvalDoc(dir) {
  const p = path.join(dir, 'approvals.json')
  if (!fs.existsSync(p)) return { schema: APPROVALS_SCHEMA, items: [] }
  const parsed = readJson(p)
  if (!parsed.ok || !isObject(parsed.value) || !Array.isArray(parsed.value.items)) {
    throw new BlueprintError('E_CORRUPT_SESSION', 'approvals.json is unreadable')
  }
  return parsed.value
}

export function approveBlueprint(repo, id, { text, channel = 'cli', now } = {}) {
  const r = loadForWrite(repo, id)
  const value = String(text || '').trim()
  if (!value) throw new BlueprintError('E_USAGE', 'approve requires --text "<用户原话>"')
  if (!['cli', 'ui', 'slash'].includes(channel)) throw new BlueprintError('E_USAGE', `unsupported channel: ${channel}`)
  const g1 = evaluateG1(repo, id, { now })
  if (!g1.checks_pass) {
    throw new BlueprintError('E_GATE_NOT_READY', `G1 is not ready: ${(g1.failed || []).join(', ') || g1.errors.join('; ') || g1.status}`)
  }
  const doc = approvalDoc(r.dir)
  const existing = latestApproval(doc)
  if (existing && existing.content_hash === g1.content_hash) {
    const session = saveSession(r.dir, {
      ...r.session,
      status: 'passed',
      awaiting: null,
      last_error: null,
    })
    return { ok: true, replayed: true, approval: existing, session, g1 }
  }
  const seq = String(doc.items.length + 1).padStart(2, '0')
  const day = (now || nowIso()).slice(0, 10).replace(/-/g, '')
  const approval = {
    approval_id: `apv-${day}-${seq}`,
    gate_id: `G1:${id}`,
    content_hash: g1.content_hash,
    gate_revision: Number(r.session.revision || 0),
    text: value,
    channel,
    at: now || nowIso(),
    revoked_at: null,
    revoked_text: null,
  }
  doc.schema = APPROVALS_SCHEMA
  doc.items = [...doc.items, approval]
  writeJson(path.join(r.dir, 'approvals.json'), doc)
  const session = saveSession(r.dir, {
    ...r.session,
    status: 'passed',
    awaiting: null,
    last_error: null,
  })
  const again = evaluateG1(repo, id, { now })
  return { ok: true, replayed: false, approval, session, g1: again }
}

// ───────────────────────────── 物化 ─────────────────────────────

function taskNumber(n) { return String(n).padStart(3, '0') }

function allocatedMax(repo) {
  let max = 0
  const root = path.join(repo, TASKS_DIR)
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { entries = [] }
  for (const ent of entries) {
    if (ent.isDirectory() && /^\d+$/.test(ent.name)) max = Math.max(max, Number(ent.name))
  }
  const bp = blueprintRoot(repo)
  let sessions = []
  try { sessions = fs.readdirSync(bp) } catch { sessions = [] }
  for (const id of sessions) {
    const parsed = readJson(path.join(bp, id, 'materialized.json'))
    const tasks = parsed.ok && parsed.value && Array.isArray(parsed.value.tasks) ? parsed.value.tasks : []
    for (const t of tasks) if (t && /^\d+$/.test(String(t.task || ''))) max = Math.max(max, Number(t.task))
  }
  return max
}

function topoTasks(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const indeg = new Map()
  const next = new Map()
  for (const t of tasks) { indeg.set(t.id, 0); next.set(t.id, []) }
  for (const t of tasks) {
    for (const d of t.depends_on || []) {
      if (!byId.has(d)) throw new BlueprintError('E_INVALID_OUTPUT', `dangling dependency ${t.id}->${d}`)
      indeg.set(t.id, indeg.get(t.id) + 1)
      next.get(d).push(t.id)
    }
  }
  const ready = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort()
  const out = []
  while (ready.length) {
    ready.sort()
    const id = ready.shift()
    out.push(byId.get(id))
    for (const n of next.get(id)) {
      indeg.set(n, indeg.get(n) - 1)
      if (indeg.get(n) === 0) ready.push(n)
    }
  }
  if (out.length !== tasks.length) throw new BlueprintError('E_INVALID_OUTPUT', 'task graph has a cycle')
  return out
}

function planDigest(mapping, graphDigest, approvalId) {
  const tasks = mapping.map((m) => ({ node: m.node, task: m.task, node_sha256: m.node_sha256 }))
  tasks.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0))
  return sha256Content(canonicalJson({ g1_approval_id: approvalId, graph_digest: graphDigest, tasks }))
}

function taskTitle(task) {
  const title = task && typeof task.title === 'string' ? task.title.trim() : ''
  if (!title) throw new BlueprintError('E_INVALID_OUTPUT', `task ${task && task.id ? task.id : '?'} is missing title`)
  return title
}

function assertMaterializableGraph(graph) {
  if (!isObject(graph) || graph.schema !== TASKGRAPH_SCHEMA || !Array.isArray(graph.tasks) || !Array.isArray(graph.acceptance)) {
    throw new BlueprintError('E_INVALID_OUTPUT', 'task-graph.json is missing or not a task graph')
  }
  if (graph.tasks.length === 0 || graph.acceptance.length === 0) {
    throw new BlueprintError('E_INVALID_OUTPUT', 'task-graph.json must contain tasks and acceptance')
  }
  for (const task of graph.tasks) taskTitle(task)
}

function renderBrief(task, taskId, depLines, acLines) {
  const title = taskTitle(task)
  const lines = [
    `# Task ${taskId} — ${title}`,
    '',
    '## 目标',
    '',
    title,
    '',
    '输出：',
    ...task.outputs.map((o) => `- ${o}`),
    '',
    '验收：',
    ...acLines.map((a) => `- ${a.id}: ${a.text}`),
    '',
    `节点：${task.id}`,
    '',
    '## 约束',
    '',
    'write_scope：',
    ...task.write_scope.map((s) => `- ${s}`),
    '',
    '依赖：',
    ...(depLines.length ? depLines.map((d) => `- ${d}`) : ['- （无）']),
    '',
    '输入：',
    ...task.inputs.map((s) => `- ${s}`),
    '',
  ]
  if (typeof task.user_gate === 'boolean') lines.push(`user_gate: ${task.user_gate}`, '')
  lines.push(
    '## 建议验收方向',
    '',
    ...task.acceptance_direction.map((s) => `- ${s}`),
    '',
    `测试层级：${task.test_levels.join(', ')}`,
    '',
    '## 非目标',
    '',
    '（未单列）',
    '',
  )
  return lines.join('\n')
}

export function materializeBlueprint(repo, id, { dryRun = false, now, beforeSessionSave = null } = {}) {
  const r = loadForWrite(repo, id)
  const g1 = evaluateG1(repo, id, { now })
  if (!g1.checks_pass) {
    throw new BlueprintError('E_GATE_NOT_READY', `G1 is not ready: ${(g1.failed || []).join(', ') || g1.status}`)
  }
  if (!g1.approval_valid) {
    throw new BlueprintError('E_APPROVAL_STALE', 'approval is stale for the current content hash; approve again before materialize')
  }
  const graph = r.taskGraph
  assertMaterializableGraph(graph)
  const ordered = topoTasks(graph.tasks)
  const digests = digestSet(r.dir, r.session, repo)
  const existing = r.materialized
  if (existing && Array.isArray(existing.tasks) && existing.tasks.length) {
    const replayDigest = planDigest(existing.tasks.map((t) => ({
      node: t.node,
      task: t.task,
      node_sha256: canonicalHash(ordered.find((n) => n.id === t.node) || {}),
    })), digests.graph_digest, g1.approval_id)
    const sameNodes = existing.tasks.length === ordered.length
      && ordered.every((t) => existing.tasks.some((m) => m.node === t.id && m.node_sha256 === canonicalHash(t)))
    const present = existing.tasks.every((t) => fs.existsSync(path.join(repo, TASKS_DIR, String(t.task), 'brief.md'))
      && fs.existsSync(path.join(repo, TASKS_DIR, String(t.task), 'origin.json')))
    if (existing.plan_digest === replayDigest && existing.g1_approval_id === g1.approval_id && sameNodes && present) {
      if (r.session.status !== 'materialized') {
        saveSession(r.dir, { ...r.session, status: 'materialized', awaiting: null, last_error: null })
      }
      return { ok: true, replayed: true, dry_run: false, tasks: existing.tasks, plan_digest: existing.plan_digest, g1 }
    }
    throw new BlueprintError('E_ALREADY_MATERIALIZED', `blueprint ${id} is already materialized with a different plan`)
  }

  let max = allocatedMax(repo)
  const acById = new Map(graph.acceptance.map((a) => [a.id, a]))
  const mapping = ordered.map((task) => {
    max += 1
    return { node: task.id, task: taskNumber(max), node_sha256: canonicalHash(task), title: task.title }
  })
  const byNode = new Map(mapping.map((m) => [m.node, m.task]))
  const plan = planDigest(mapping, digests.graph_digest, g1.approval_id)
  const tasksRoot = path.join(repo, TASKS_DIR)
  for (const m of mapping) {
    const dest = path.join(tasksRoot, m.task)
    if (fs.existsSync(dest)) throw new BlueprintError('E_PATH_CONFLICT', `target already exists: ${path.join(TASKS_DIR, m.task)}`)
  }
  if (dryRun) return { ok: true, replayed: false, dry_run: true, tasks: mapping, plan_digest: plan, g1 }

  const staged = path.join(r.dir, '.stage')
  const recordPath = path.join(r.dir, 'materialized.json')
  fs.rmSync(staged, { recursive: true, force: true })
  const moved = []
  let recordWritten = false
  try {
    for (const task of ordered) {
      const m = mapping.find((x) => x.node === task.id)
      const deps = (task.depends_on || []).map((d) => `${byNode.get(d)}（${d}）`)
      const acLines = (task.acceptance || []).map((aid) => acById.get(aid)).filter(Boolean)
      const brief = renderBrief(task, m.task, deps, acLines)
      const origin = {
        schema: ORIGIN_SCHEMA,
        kind: 'blueprint',
        blueprint: id,
        node: task.id,
        node_sha256: m.node_sha256,
        g1_approval_id: g1.approval_id,
        created_at: now || nowIso(),
      }
      const taskDir = path.join(staged, m.task)
      fs.mkdirSync(taskDir, { recursive: true })
      writeText(path.join(taskDir, 'brief.md'), brief)
      writeJson(path.join(taskDir, 'origin.json'), origin)
    }
    fs.mkdirSync(tasksRoot, { recursive: true })
    for (const m of mapping) {
      const dest = path.join(tasksRoot, m.task)
      if (fs.existsSync(dest)) throw new BlueprintError('E_PATH_CONFLICT', `target already exists: ${path.join(TASKS_DIR, m.task)}`)
      fs.renameSync(path.join(staged, m.task), dest)
      moved.push(dest)
    }
    const record = {
      plan_digest: plan,
      g1_approval_id: g1.approval_id,
      graph_digest: digests.graph_digest,
      blueprint: id,
      tasks: mapping.map((m) => ({ node: m.node, task: m.task, node_sha256: m.node_sha256 })),
      created_at: now || nowIso(),
    }
    writeJson(recordPath, record)
    recordWritten = true
    fs.rmSync(staged, { recursive: true, force: true })
    if (typeof beforeSessionSave === 'function') beforeSessionSave()
    saveSession(r.dir, { ...r.session, status: 'materialized', awaiting: null, last_error: null })
    return { ok: true, replayed: false, dry_run: false, tasks: record.tasks, plan_digest: plan, g1 }
  } catch (e) {
    for (const dest of moved) { try { fs.rmSync(dest, { recursive: true, force: true }) } catch { /* rollback */ } }
    try { fs.rmSync(staged, { recursive: true, force: true }) } catch { /* ignore */ }
    // 会话没写上时，物化记录也不能留下，否则会指向已经删掉的任务。
    if (recordWritten) {
      try { fs.rmSync(recordPath, { force: true }) } catch { /* rollback */ }
      try { fs.rmSync(recordPath + '.tmp', { force: true }) } catch { /* rollback */ }
    }
    throw e
  }
}

export { ROLE_PHASE, isValidSessionId }
