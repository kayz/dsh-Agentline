/**
 * build.mjs — Build 控制面（P8）
 *
 * 复用 K1 runStep / runBuild。每次步骤前核对 Blueprint 来源；
 * 旧 design/dev/review 与新 designer/developer/verifier 映射到同一阶段；
 * T gate 从落盘证据求值。本模块不写 flow，也不伪造 model_resolved。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { canonicalHash, evaluateG1, readBlueprint } from './blueprint.mjs'
import { GATE_SCHEMA, evaluateGate, sha256Content } from './contracts/gate.mjs'
import { classifyError, isTransientError } from './exec.mjs'
import { effectiveRole } from './routing.mjs'
import { readState, writeState } from './state.mjs'

export const ORIGIN_SCHEMA = 'agentline.origin/v1'
export const ROLESLOCK_SCHEMA = 'agentline.roleslock/v1'
const HASH_RE = /^sha256:[0-9a-f]{64}$/

export const STAGE_ROLE = {
  design: { legacy: 'design', next: 'designer' },
  dev: { legacy: 'dev', next: 'developer' },
  review: { legacy: 'review', next: 'verifier' },
}

const INFRA_KINDS = new Set(['rate_limit', 'transport', 'timeout', 'capacity', 'stall'])

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

function refuse(reason, detail, extra = {}) {
  return { ok: false, legacy: false, reason, detail: detail || null, source: extra.source || 'blueprint', ...extra }
}

function configured(config, projectCfg, role) {
  const base = config && config.roles ? config.roles[role] : null
  const routing = projectCfg && projectCfg.routing ? projectCfg.routing[role] : null
  const matrix = config && config.roleModels ? config.roleModels[role] : null
  const hasBase = !!(base && ((Array.isArray(base.candidates) && base.candidates.length) || base.model))
  const hasRouting = !!(routing && ((Array.isArray(routing.order) && routing.order.length) || routing.model))
  const hasMatrix = Array.isArray(matrix) && matrix.length > 0
  return hasBase || hasRouting || hasMatrix
}

function sameOrder(a, b) {
  const left = (a && a.order) || []
  const right = (b && b.order) || []
  if (left.length !== right.length) return false
  if (left.some((key, i) => key !== right[i])) return false
  return (a && a.effort) === (b && b.effort)
}

function lockCandidates(lock, stage) {
  const names = STAGE_ROLE[stage]
  if (!names || !lock || !isObject(lock.roles)) return []
  for (const name of [names.next, names.legacy]) {
    const list = lock.roles[name] && lock.roles[name].candidates
    if (!Array.isArray(list)) continue
    const rows = list.filter((row) => isObject(row) && typeof row.id === 'string' && row.id.trim())
    if (rows.length) return rows.map((row) => ({ ...row, id: row.id.trim() }))
  }
  return []
}

export function readRoleLock(taskDir) {
  const file = path.join(taskDir, 'roles.lock.json')
  if (!fs.existsSync(file)) return { present: false, lock: null }
  let st
  try { st = fs.statSync(file) } catch (e) {
    return { present: true, error: e && e.message ? e.message : String(e) }
  }
  if (!st.isFile()) return { present: true, error: 'roles.lock.json is not a file' }
  const parsed = readJson(file)
  if (!parsed.ok || !isObject(parsed.value)) return { present: true, error: 'roles.lock.json is unreadable' }
  if (parsed.value.schema !== ROLESLOCK_SCHEMA || !isObject(parsed.value.roles)) {
    return { present: true, error: 'roles.lock.json schema is not agentline.roleslock/v1' }
  }
  return { present: true, lock: parsed.value }
}

/**
 * 旧角色名与新角色名映射到 design / dev / review。
 * 两套都写了且顺序或 effort 不一致，报 role_conflict；都没写，报 role_missing。
 * 新角色或 roles.lock.json 会收紧为锁，实际调用只能用锁内的模型 id。
 */
export function resolveStageRole(config, projectCfg, stage, taskDir) {
  const names = STAGE_ROLE[stage]
  if (!names) return { ok: true, order: [], effort: null, lock: null, stage, role: stage }
  const cfg = config || {}
  const project = projectCfg || {}
  const legacyOn = configured(cfg, project, names.legacy)
  const nextOn = configured(cfg, project, names.next)
  const legacy = legacyOn ? effectiveRole(cfg, names.legacy, project) : null
  const modern = nextOn ? effectiveRole(cfg, names.next, project) : null
  if (legacyOn && nextOn && !sameOrder(legacy, modern)) {
    return { ok: false, reason: 'role_conflict', detail: `${names.legacy} vs ${names.next}` }
  }
  const chosen = (nextOn ? modern : null) || (legacyOn ? legacy : null)
  const lockFile = taskDir ? readRoleLock(taskDir) : { present: false, lock: null }
  if (lockFile && lockFile.error) return { ok: false, reason: 'role_lock_corrupt', detail: lockFile.error }
  if ((!chosen || !chosen.order || !chosen.order.length) && !(lockFile && lockFile.lock)) {
    return { ok: false, reason: 'role_missing', detail: names.next }
  }
  let order = chosen && chosen.order ? chosen.order.slice() : []
  let effort = chosen ? chosen.effort : (cfg.effort && cfg.effort.default) || 'high'
  let lock = null
  if (nextOn) {
    lock = {
      ids: order.map((key) => cfg.models && cfg.models[key] && cfg.models[key].id).filter(Boolean),
      keys: order.slice(),
      source: 'config',
      candidates: order.map((key) => {
        const model = cfg.models && cfg.models[key]
        return model ? { key, id: model.id, identity_group: model.identity_group || null } : null
      }).filter(Boolean),
    }
  }
  if (lockFile && lockFile.lock) {
    const candidates = lockCandidates(lockFile.lock, stage)
    if (!candidates.length) return { ok: false, reason: 'role_missing', detail: 'lock' }
    const ids = candidates.map((row) => row.id)
    if (!order.length) {
      order = candidates.map((row) => row.key).filter((key) => key && cfg.models && cfg.models[key])
      if (!order.length) return { ok: false, reason: 'role_missing', detail: 'lock' }
    }
    const outside = order.filter((key) => {
      const id = cfg.models && cfg.models[key] && cfg.models[key].id
      return !id || !ids.includes(id)
    })
    if (outside.length) return { ok: false, reason: 'role_conflict', detail: 'lock' }
    order = order.filter((key) => ids.includes(cfg.models[key].id))
    if (!order.length) return { ok: false, reason: 'role_missing', detail: 'lock' }
    lock = { ids, keys: order.slice(), source: 'roles.lock.json', candidates }
  }
  if (!order.length) return { ok: false, reason: 'role_missing', detail: names.legacy }
  return {
    ok: true,
    order,
    effort,
    lock,
    stage,
    role: names.legacy,
  }
}

/** 给本次调用补上旧角色名，避免 exec 因缺 roles.design 抛错。不改调用方的配置对象。 */
export function configForStage(config, stage, resolved) {
  const names = STAGE_ROLE[stage]
  const role = names ? names.legacy : stage
  const baseRoles = config && config.roles ? config.roles : {}
  const prev = baseRoles[role] || {}
  return {
    ...(config || {}),
    roles: {
      ...baseRoles,
      [role]: { ...prev, candidates: resolved.order.slice(), effort: resolved.effort || prev.effort },
    },
  }
}

function taskIdOf(taskDir) {
  return path.basename(taskDir)
}

function approvalItems(doc) {
  if (!doc) return { ok: true, items: [] }
  if (!isObject(doc) || !Array.isArray(doc.items)) return { ok: false, items: [] }
  return { ok: true, items: doc.items.filter((item) => isObject(item)) }
}

/**
 * Blueprint 物化任务在每次步骤前重新核对来源。
 * 没有 origin.json 的旧任务放行。文件在就必须先通过 schema 和来源字段；
 * 缺字段、kind 被改成 legacy，或读不出来，都是损坏，不能当成旧任务。
 */
export function inspectOrigin(repo, taskDir) {
  const file = path.join(taskDir, 'origin.json')
  if (!fs.existsSync(file)) return { ok: true, legacy: true, source: 'legacy', reason: null, detail: null }
  let st
  try { st = fs.statSync(file) } catch (e) {
    return refuse('origin_corrupt', 'unreadable', { source: 'error' })
  }
  if (!st.isFile()) return refuse('origin_corrupt', 'not-a-file', { source: 'error' })
  const parsed = readJson(file)
  if (!parsed.ok || !isObject(parsed.value)) return refuse('origin_corrupt', 'unreadable', { source: 'error' })
  const origin = parsed.value
  if (origin.kind === 'adhoc' && typeof origin.reason === 'string' && origin.reason.trim()) {
    return { ok: true, legacy: true, source: 'adhoc', reason: null, detail: null }
  }
  const blueprintId = typeof origin.blueprint === 'string' ? origin.blueprint.trim() : ''
  const nodeId = typeof origin.node === 'string' ? origin.node.trim() : ''
  const approvalId = typeof origin.g1_approval_id === 'string' ? origin.g1_approval_id.trim() : ''
  if (origin.schema !== ORIGIN_SCHEMA || origin.kind !== 'blueprint' || !blueprintId || !nodeId || !HASH_RE.test(String(origin.node_sha256 || '')) || !approvalId) {
    return refuse('origin_corrupt', 'fields', { source: 'error' })
  }
  let session
  try { session = readBlueprint(repo, blueprintId) } catch (e) {
    return refuse('origin_corrupt', 'blueprint', { source: 'error' })
  }
  if (!session || !session.session || session.state === 'missing' || session.state === 'empty' || session.state === 'corrupt') {
    return refuse('origin_corrupt', session && session.state ? session.state : 'blueprint', { source: 'error' })
  }
  const tasks = session.taskGraph && Array.isArray(session.taskGraph.tasks) ? session.taskGraph.tasks : null
  if (!tasks) return refuse('origin_corrupt', 'task-graph', { source: 'error' })
  const node = tasks.find((item) => item && item.id === nodeId)
  const levels = node && Array.isArray(node.test_levels) ? node.test_levels.filter((x) => typeof x === 'string' && x.trim()) : null
  if (!node) return refuse('E_APPROVAL_STALE', 'node', { levels: null, node: nodeId, blueprint: blueprintId })
  let hash = null
  try { hash = canonicalHash(node) } catch {
    return refuse('origin_corrupt', 'node-hash', { source: 'error' })
  }
  if (hash !== origin.node_sha256) {
    return refuse('E_APPROVAL_STALE', 'node', { levels, node: nodeId, blueprint: blueprintId })
  }
  const mapped = session.materialized && Array.isArray(session.materialized.tasks) ? session.materialized.tasks : null
  const taskId = taskIdOf(taskDir)
  const row = mapped && mapped.find((item) => item && String(item.task) === taskId)
  if (!row || row.node !== nodeId || row.node_sha256 !== origin.node_sha256) {
    return refuse('E_APPROVAL_STALE', 'mapping', { levels, node: nodeId, blueprint: blueprintId })
  }
  const items = approvalItems(session.approvals)
  if (!items.ok) return refuse('origin_corrupt', 'approvals', { source: 'error' })
  const mine = items.items.find((item) => item.approval_id === approvalId)
  if (!mine) return refuse('E_APPROVAL_STALE', 'unapproved', { levels, node: nodeId, blueprint: blueprintId })
  if (mine.revoked_at) return refuse('E_APPROVAL_REVOKED', 'revoked', { levels, node: nodeId, blueprint: blueprintId })
  let g1
  try { g1 = evaluateG1(repo, blueprintId) } catch (e) {
    return refuse('origin_corrupt', 'g1', { source: 'error' })
  }
  if (!g1 || g1.content_hash !== mine.content_hash || g1.approval_id !== approvalId || !g1.approval_valid) {
    return refuse('E_APPROVAL_STALE', 'expired', { levels, node: nodeId, blueprint: blueprintId })
  }
  if (!g1.checks_pass) return refuse('E_GATE_NOT_READY', 'g1', { levels, node: nodeId, blueprint: blueprintId })
  return {
    ok: true,
    legacy: false,
    source: 'blueprint',
    reason: null,
    detail: null,
    levels,
    node: nodeId,
    blueprint: blueprintId,
    origin,
  }
}

export function isInfraResult(result) {
  if (!result || result.side_effects === 'unknown') return false
  const err = result.error || ''
  if (!err) return false
  if (isTransientError(err)) return true
  return INFRA_KINDS.has(classifyError(err))
}

export function nextBusinessRound(current, step, result) {
  const cur = Number.isInteger(current) ? current : 0
  if (step === 'review' && result && result.ok && result.verdict && result.verdict !== 'pass') {
    return Math.max(cur, 1) + 1
  }
  if (step === 'ci' && result && !result.ok && result.reason === 'ci_failed') {
    return Math.max(cur, 1) + 1
  }
  if (result && result.ok && (step === 'design' || step === 'dev' || step === 'review')) {
    return Math.max(cur, 1)
  }
  return cur
}

export function recordStepStats(taskDir, step, calls, result) {
  const st = readState(taskDir)
  if (!st) return null
  const prev = isObject(st.counters) ? st.counters : {}
  const infra = (Array.isArray(calls) ? calls : []).filter((call) => call && call.infra && !call.denied).length
  const business = nextBusinessRound(
    Number.isInteger(prev.business_rounds) ? prev.business_rounds : 0,
    step,
    result,
  )
  const side = (Array.isArray(calls) ? calls : []).some((call) => call && call.side_effects === 'unknown')
  const next = {
    ...st,
    counters: {
      business_rounds: business,
      infra_retries: (Number.isInteger(prev.infra_retries) ? prev.infra_retries : 0) + infra,
    },
    ...(side ? { side_effects: 'unknown' } : {}),
  }
  writeState(taskDir, next)
  return next.counters
}

function readLedger(taskDir) {
  const file = path.join(taskDir, 'step-ledger.jsonl')
  if (!fs.existsSync(file)) return { present: false, corrupt: false, lines: [] }
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch {
    return { present: true, corrupt: true, lines: [] }
  }
  const lines = []
  let corrupt = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (!isObject(row)) corrupt = true
      else lines.push(row)
    } catch {
      corrupt = true
    }
  }
  return { present: true, corrupt, lines }
}

function readRuns(taskDir) {
  const parsed = readJson(path.join(taskDir, 'run.json'))
  if (!parsed.ok || parsed.value == null) return []
  if (Array.isArray(parsed.value)) return parsed.value.filter(isObject)
  return isObject(parsed.value) ? [parsed.value] : []
}

function mapLedgerCall(row) {
  return {
    role: row.role || null,
    model_requested: row.model_requested || null,
    model_resolved: typeof row.model_resolved === 'string' && row.model_resolved.trim() ? row.model_resolved.trim() : null,
    identity_group: typeof row.identity_group === 'string' ? row.identity_group : null,
    infra: !!row.infra,
    error: row.error || null,
    exit: row.exit,
    source: row.model_resolved ? 'adapter' : 'none',
  }
}

function callsFromDisk(taskDir) {
  const ledger = readLedger(taskDir)
  if (ledger.present && ledger.corrupt) return { corrupt: true, calls: [] }
  if (ledger.present) {
    const calls = ledger.lines.filter((row) => row && row.event === 'call' && !row.denied).map(mapLedgerCall)
    if (calls.length) return { corrupt: false, calls }
  }
  return {
    corrupt: false,
    calls: readRuns(taskDir).map((row) => {
      const source = row.model_resolved_source || null
      const resolved = typeof row.model_resolved === 'string' && row.model_resolved.trim() ? row.model_resolved.trim() : null
      const forged = !source && resolved && resolved === row.model_requested
      return {
        role: row.role || null,
        model_requested: row.model_requested || null,
        model_resolved: source === 'none' || forged ? null : resolved,
        identity_group: typeof row.identity_group === 'string' ? row.identity_group : null,
        infra: false,
        error: row.error || null,
        exit: row.exit && row.exit.code,
        source: source || (forged ? 'none' : (resolved ? 'adapter' : 'none')),
      }
    }),
  }
}

const ACCEPTANCE_HEADING = /^#{2,4}\s+((?:AC-?\d+)|(?:[A-Z]{1,3}\d+)|(?:\d+(?:\.\d+)*))\b/

function parseAcceptance(text) {
  const items = []
  let current = null
  let inFence = false
  let fence = []
  const close = () => {
    if (!current) return
    if (!current.command && fence.length) current.command = fence.join('\n')
    if (current.command && String(current.command).trim()) {
      items.push({ id: current.id, command: String(current.command) })
    }
    current = null
    fence = []
    inFence = false
  }
  for (const line of String(text).split(/\r?\n/)) {
    if (!inFence && ACCEPTANCE_HEADING.test(line)) {
      close()
      const id = line.match(ACCEPTANCE_HEADING)[1]
      current = { id, command: null }
      fence = []
      continue
    }
    if (!current) continue
    if (/^\s*```/.test(line)) {
      if (!inFence) { inFence = true; fence = [] }
      else {
        inFence = false
        if (!current.command && fence.length) current.command = fence.join('\n')
      }
      continue
    }
    if (inFence) { fence.push(line); continue }
    if (!current.command && fence.length) current.command = fence.join('\n')
    const cmd = line.match(/^-\s*命令:\s*`(.+)`\s*$/)
    if (!current.command && cmd) current.command = cmd[1]
  }
  close()
  return items
}

function requiredAcceptance(taskDir) {
  const file = path.join(taskDir, 'acceptance.md')
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' }
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return { ok: false, reason: 'unreadable' } }
  const items = parseAcceptance(text)
  if (!items.length) return { ok: false, reason: 'empty' }
  return { ok: true, items }
}

function sameCommands(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((item, i) => item.id === right[i].id && item.command === right[i].command)
}

function acceptanceRel(repo, taskDir) {
  return path.relative(repo, path.join(taskDir, 'acceptance.md')).split(path.sep).join('/')
}

function gitText(repo, args) {
  try {
    return execFileSync('git', args, {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/**
 * 当前验收命令必须等于 ranAt 之前已提交的命令。
 * 只改 ID 仍能对上的旧报告不算通过；未纳入 git 的验收仍只按条目核对。
 */
function commandsBound(repo, taskDir, ranAt, items) {
  const rel = acceptanceRel(repo, taskDir)
  if (gitText(repo, ['cat-file', '-e', `HEAD:${rel}`]) == null) return { ok: true }
  const headText = gitText(repo, ['show', `HEAD:${rel}`])
  if (headText == null) return { ok: false, evidence: 'unknown:undetermined' }
  if (!sameCommands(parseAcceptance(headText), items)) return { ok: false, evidence: 'stale' }
  const sha = gitText(repo, ['rev-list', '-1', `--before=${new Date(ranAt).toISOString()}`, 'HEAD', '--', rel])
  const rev = sha && sha.trim()
  if (!rev) return { ok: false, evidence: 'stale' }
  const thenText = gitText(repo, ['show', `${rev}:${rel}`])
  if (thenText == null) return { ok: false, evidence: 'unknown:undetermined' }
  if (!sameCommands(parseAcceptance(thenText), items)) return { ok: false, evidence: 'stale' }
  return { ok: true }
}

function classifyCiValue(taskDir, value) {
  if (!isObject(value)) return { status: 'unknown', pass: false, evidence: 'unknown:corrupt' }
  const results = value.results
  if (!Array.isArray(results) || results.length === 0 || value.total === 0) {
    return { status: 'unknown', pass: false, evidence: 'unknown:empty' }
  }
  const flags = results.map((row) => (isObject(row) ? row.passed : undefined))
  if (flags.some((flag) => flag !== true && flag !== false)) {
    return { status: 'unknown', pass: false, evidence: 'unknown:partial' }
  }
  if (flags.some((flag) => flag === false)) {
    return { status: 'fail', pass: false, evidence: 'fail' }
  }
  const passed = flags.filter(Boolean).length
  if (value.passed !== passed || value.total !== results.length || value.ok !== true) {
    return { status: 'unknown', pass: false, evidence: 'unknown:partial' }
  }
  const required = requiredAcceptance(taskDir)
  if (!required.ok) return { status: 'unknown', pass: false, evidence: 'unknown:partial' }
  const got = results.map((row) => (isObject(row) && typeof row.id === 'string' ? row.id.trim() : ''))
  const need = required.items.map((item) => item.id)
  const same = got.length === need.length && need.every((id) => got.includes(id)) && got.every((id) => need.includes(id))
  if (!same) return { status: 'unknown', pass: false, evidence: 'unknown:partial' }
  if (!results.every(commandProved)) return { status: 'unknown', pass: false, evidence: 'unknown:undetermined' }
  return { status: 'pass', pass: true, evidence: 'pass', commands: required.items }
}

function commandProved(row) {
  if (!isObject(row) || row.passed !== true) return false
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (!id || row.exitCode !== 0) return false
  const marker = `${id} OK`
  if (typeof row.lastLine !== 'string' || row.lastLine.trim() !== marker) return false
  if (typeof row.output === 'string') {
    const lines = row.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (!lines.length || lines[lines.length - 1] !== marker) return false
  }
  return true
}

/** 最近一次改动产品文件的提交时间。.collab 里的审计、评审和 PR 状态不算。 */
function productCommitMs(repo) {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%ct', 'HEAD', '--', '.', ':(exclude).collab'],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    if (!out) return null
    const sec = Number(out)
    return Number.isFinite(sec) ? sec * 1000 : null
  } catch {
    return null
  }
}

function ciFreshness(repo, taskDir, value, classified) {
  if (!classified.pass) return classified
  if (!isObject(value) || typeof value.ranAt !== 'string' || !value.ranAt.trim()) {
    return { status: 'unknown', pass: false, evidence: 'unknown:undetermined' }
  }
  const ran = Date.parse(value.ranAt)
  if (!Number.isFinite(ran)) return { status: 'unknown', pass: false, evidence: 'unknown:undetermined' }
  const productMs = productCommitMs(repo)
  if (productMs == null) return { status: 'unknown', pass: false, evidence: 'unknown:undetermined' }
  if (productMs > ran + 1000) return { status: 'stale', pass: false, evidence: 'stale' }
  const bound = commandsBound(repo, taskDir, ran, classified.commands)
  if (!bound.ok) {
    return bound.evidence === 'stale'
      ? { status: 'stale', pass: false, evidence: 'stale' }
      : { status: 'unknown', pass: false, evidence: bound.evidence || 'unknown:undetermined' }
  }
  return classified
}

export function readCiReport(taskDir) {
  const file = path.join(taskDir, 'ci-results.json')
  if (!fs.existsSync(file)) return { state: 'missing', value: null }
  let st
  try { st = fs.statSync(file) } catch {
    return { state: 'corrupt', value: null }
  }
  if (!st.isFile() || st.size === 0) return { state: 'corrupt', value: null }
  const parsed = readJson(file)
  if (!parsed.ok) return { state: 'corrupt', value: null }
  return { state: 'ok', value: parsed.value }
}

function classifyCi(repo, taskDir) {
  const report = readCiReport(taskDir)
  if (report.state === 'missing') return { status: 'unknown', pass: false, evidence: 'unknown:missing' }
  if (report.state === 'corrupt') return { status: 'unknown', pass: false, evidence: 'unknown:corrupt' }
  return ciFreshness(repo, taskDir, report.value, classifyCiValue(taskDir, report.value))
}

function gitAncestor(repo, sha) {
  if (!sha || typeof sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(sha)) return 'unknown'
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: repo, stdio: 'ignore' })
    return 'yes'
  } catch (e) {
    if (e && e.status === 1) return 'no'
    return 'unknown'
  }
}

function latestVerdict(taskDir) {
  let names = []
  try { names = fs.readdirSync(taskDir) } catch { return { state: 'missing', value: null } }
  const files = names.filter((name) => name === 'verdict.json' || /^verdict-r\d+\.json$/.test(name))
  if (!files.length) return { state: 'missing', value: null }
  files.sort((a, b) => {
    const ra = a === 'verdict.json' ? 0 : Number(a.replace(/\D/g, ''))
    const rb = b === 'verdict.json' ? 0 : Number(b.replace(/\D/g, ''))
    return ra - rb
  })
  const parsed = readJson(path.join(taskDir, files[files.length - 1]))
  if (!parsed.ok || !isObject(parsed.value)) return { state: 'corrupt', value: null }
  return { state: 'ok', value: parsed.value }
}

function resolveCommit(repo, rev) {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase()
    return /^[0-9a-f]{40}$/.test(out) ? out : null
  } catch {
    return null
  }
}

/** 产品代码快照：排除 .collab。审计提交和 PR 状态不改变这份快照。 */
function codeDigest(repo, rev) {
  let out
  try {
    out = execFileSync('git', ['ls-tree', '-r', '-z', rev], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  const rows = []
  for (const line of out.split('\0')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const file = line.slice(tab + 1).replaceAll('\\', '/')
    if (file === '.collab' || file.startsWith('.collab/')) continue
    const meta = line.slice(0, tab).split(' ')
    if (meta.length < 3 || meta[1] !== 'blob') continue
    rows.push(`${meta[0]} ${meta[2]} ${file}`)
  }
  rows.sort()
  return sha256Content(rows.join('\n'))
}

function classifyVerdict(repo, taskDir) {
  const verdict = latestVerdict(taskDir)
  if (verdict.state === 'missing') return { status: 'unknown', pass: false, evidence: 'unknown:missing' }
  if (verdict.state === 'corrupt') return { status: 'unknown', pass: false, evidence: 'unknown:corrupt' }
  if (verdict.value.verdict !== 'pass') return { status: 'fail', pass: false, evidence: 'fail' }
  const sha = typeof verdict.value.git_sha === 'string' ? verdict.value.git_sha.trim() : ''
  if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return { status: 'unknown', pass: false, evidence: 'unknown:git_sha' }
  const head = resolveCommit(repo, 'HEAD')
  const reviewed = resolveCommit(repo, sha)
  if (!head || !reviewed) return { status: 'unknown', pass: false, evidence: 'unknown:git_sha' }
  if (head === reviewed) return { status: 'pass', pass: true, evidence: 'pass' }
  const ancestor = gitAncestor(repo, sha)
  if (ancestor === 'unknown') return { status: 'unknown', pass: false, evidence: 'unknown:git_sha' }
  if (ancestor !== 'yes') return { status: 'stale', pass: false, evidence: 'stale' }
  const reviewedTree = codeDigest(repo, reviewed)
  const headTree = codeDigest(repo, head)
  if (!reviewedTree || !headTree) return { status: 'unknown', pass: false, evidence: 'unknown:git_sha' }
  if (reviewedTree !== headTree) return { status: 'stale', pass: false, evidence: 'stale' }
  return { status: 'pass', pass: true, evidence: 'pass' }
}

function classifyOrigin(inspected) {
  if (inspected.ok && inspected.legacy) return { status: 'pass', pass: true, evidence: inspected.source === 'adhoc' ? 'adhoc' : 'legacy' }
  if (inspected.ok) return { status: 'pass', pass: true, evidence: 'pass' }
  if (inspected.reason === 'origin_corrupt') return { status: 'fail', pass: false, evidence: 'fail:corrupt' }
  if (inspected.detail === 'expired' || inspected.reason === 'E_APPROVAL_REVOKED') {
    return { status: 'stale', pass: false, evidence: 'stale' }
  }
  if (inspected.detail === 'unapproved' || inspected.detail === 'node' || inspected.detail === 'mapping' || inspected.reason === 'E_GATE_NOT_READY') {
    return { status: 'fail', pass: false, evidence: `fail:${inspected.detail || inspected.reason}` }
  }
  return { status: 'unknown', pass: false, evidence: 'unknown:origin' }
}

function groupOf(call, config) {
  if (call && typeof call.identity_group === 'string' && call.identity_group.trim()) return call.identity_group.trim()
  if (!call || !call.model_resolved || !config || !config.models) return null
  const model = Object.values(config.models).find((item) => item && item.id === call.model_resolved)
  if (!model) return null
  if (typeof model.identity_group === 'string' && model.identity_group.trim()) return model.identity_group.trim()
  const provider = config.providers && config.providers[model.provider]
  const vendor = (provider && provider.source) || model.provider || ''
  return vendor && model.id ? `${vendor}/${model.id}` : null
}

function classifyIsolation(taskDir, config) {
  const found = callsFromDisk(taskDir)
  if (found.corrupt) return { status: 'unknown', pass: false, evidence: 'unknown:identity' }
  const calls = found.calls
  const dev = calls.filter((call) => call.role === 'dev')
  const review = calls.filter((call) => call.role === 'review')
  const problems = []
  const seen = { dev: new Set(), review: new Set() }
  for (const call of calls) {
    const verified = !!(call.model_resolved && call.source !== 'none')
    if (!verified) {
      problems.push('unknown:identity')
      continue
    }
    if (call.role === 'dev' || call.role === 'review') {
      const group = groupOf(call, config)
      if (!group) problems.push('unknown:identity')
      else seen[call.role].add(group)
    }
    if (call.model_requested && call.model_resolved !== call.model_requested) problems.push('fail:mismatch')
  }
  if (problems.includes('fail:mismatch')) return { status: 'fail', pass: false, evidence: 'fail:mismatch' }
  if (problems.includes('unknown:identity')) return { status: 'unknown', pass: false, evidence: 'unknown:identity' }
  if (!dev.length || !review.length) return { status: 'unknown', pass: false, evidence: 'unknown:missing' }
  const left = [...seen.dev]
  const right = [...seen.review]
  if (!left.length || !right.length) return { status: 'unknown', pass: false, evidence: 'unknown:identity' }
  if (left.some((group) => right.includes(group))) return { status: 'fail', pass: false, evidence: 'fail:same' }
  return { status: 'pass', pass: true, evidence: 'pass' }
}

function readWaivers(taskDir) {
  const file = path.join(taskDir, 'waivers.json')
  if (!fs.existsSync(file)) return { ok: true, waivers: [] }
  const parsed = readJson(file)
  if (!parsed.ok) return { ok: false, waivers: [] }
  const list = Array.isArray(parsed.value) ? parsed.value : (isObject(parsed.value) && Array.isArray(parsed.value.waivers) ? parsed.value.waivers : null)
  if (!list) return { ok: false, waivers: [] }
  return { ok: true, waivers: list }
}

function check(id, desc, classified) {
  return {
    id,
    desc,
    pass: classified.pass === true,
    waivable: false,
    evidence: classified.evidence,
  }
}

/**
 * 求值 Build T gate。T.ci_all_pass 在报告缺失、损坏、空、缺结果或无法判定时为未知且不通过。
 * 不可豁免的检查被豁免时，沿用通用 gate 契约拒绝。
 */
export function evaluateBuildGate(repo, taskDir, { config = {} } = {}) {
  const taskId = taskIdOf(taskDir)
  const origin = inspectOrigin(repo, taskDir)
  const ci = classifyCi(repo, taskDir)
  const verdict = classifyVerdict(repo, taskDir)
  const isolation = classifyIsolation(taskDir, config)
  const checks = [
    check('T.origin_valid', '来源批准仍然有效，且 node_sha256 与当前节点一致', classifyOrigin(origin)),
    check('T.ci_all_pass', 'CI 报告有效、非空且全部通过', ci),
    check('T.verdict_pass', '评审 verdict 为 pass，且 git_sha 的产品代码与当前 HEAD 一致', verdict),
    check('T.isolation', '开发与评审的实际身份不同，且每次调用与锁一致', isolation),
  ]
  let head = null
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { head = null }
  const contentHash = sha256Content(JSON.stringify({
    task: taskId,
    origin: origin.ok ? origin.source : origin.reason,
    detail: origin.detail || null,
    ci: ci.evidence,
    verdict: verdict.evidence,
    isolation: isolation.evidence,
    head,
  }))
  const waivers = readWaivers(taskDir)
  const gate = {
    schema: GATE_SCHEMA,
    gate: `T:${taskId}`,
    subject: { kind: 'task', id: taskId, content_hash: contentHash, revision: 0 },
    evaluated_at: new Date().toISOString(),
    checks,
    waivers: waivers.ok ? waivers.waivers : [],
  }
  const state = readState(taskDir)
  if (state && Number.isInteger(state.revision) && state.revision >= 0) gate.subject.revision = state.revision
  const evaluated = evaluateGate(gate, { currentHash: contentHash })
  const errors = waivers.ok ? evaluated.errors : ['waivers.json is unreadable', ...evaluated.errors]
  const pass = waivers.ok && evaluated.pass === true
  const result = {
    status: pass ? evaluated.status : (evaluated.status === 'pass' ? 'fail' : evaluated.status),
    pass,
    failed: evaluated.failed,
    waived: evaluated.waived,
  }
  gate.result = result
  return { gate, result, errors, origin, ci, verdict, isolation }
}

function countersOf(state) {
  const counters = state && isObject(state.counters) ? state.counters : null
  return {
    business_rounds: counters && Number.isInteger(counters.business_rounds) ? counters.business_rounds : null,
    infra_retries: counters && Number.isInteger(counters.infra_retries) ? counters.infra_retries : null,
  }
}

function actualModel(taskDir) {
  const calls = callsFromDisk(taskDir).calls.filter((call) => call.model_resolved && call.source !== 'none')
  if (!calls.length) return null
  return calls[calls.length - 1].model_resolved
}

export function readBuildTask(repo, taskId) {
  const taskDir = path.join(repo, '.collab', 'tasks', String(taskId))
  if (!fs.existsSync(taskDir)) {
    return {
      id: String(taskId), state: 'error', error: 'task dir missing', source: null,
      test_levels: null, status: null, model: null, business_rounds: null, infra_retries: null, gate: null,
    }
  }
  let dirStat
  try { dirStat = fs.statSync(taskDir) } catch (e) {
    return {
      id: String(taskId), state: 'error', error: e && e.message ? e.message : String(e), source: null,
      test_levels: null, status: null, model: null, business_rounds: null, infra_retries: null, gate: null,
    }
  }
  if (!dirStat.isDirectory()) {
    return {
      id: String(taskId), state: 'error', error: 'task path is not a directory', source: null,
      test_levels: null, status: null, model: null, business_rounds: null, infra_retries: null, gate: null,
    }
  }
  const stateParsed = readJson(path.join(taskDir, 'state.json'))
  const state = stateParsed.ok && isObject(stateParsed.value) ? stateParsed.value : null
  const stateError = fs.existsSync(path.join(taskDir, 'state.json')) && !stateParsed.ok
  let evaluated = null
  try { evaluated = evaluateBuildGate(repo, taskDir) } catch (e) {
    return {
      id: String(taskId), state: 'error', error: e && e.message ? e.message : String(e), source: null,
      test_levels: null, status: state && state.status ? state.status : null, model: null,
      ...countersOf(state), gate: null,
    }
  }
  const origin = evaluated.origin
  if (!origin.ok) {
    const corrupt = origin.reason === 'origin_corrupt' || origin.source === 'error'
    return {
      id: String(taskId),
      state: corrupt ? 'error' : 'ok',
      error: corrupt ? '来源损坏' : null,
      source: corrupt ? null : 'blueprint',
      test_levels: corrupt ? null : (Array.isArray(origin.levels) ? origin.levels : null),
      status: state && state.status ? state.status : null,
      model: actualModel(taskDir),
      ...countersOf(state),
      gate: evaluated.gate,
    }
  }
  if (stateError) {
    return {
      id: String(taskId), state: 'error', error: 'state.json 无法读取', source: origin.source || null,
      test_levels: origin.levels || null, status: null, model: actualModel(taskDir),
      business_rounds: null, infra_retries: null, gate: evaluated.gate,
    }
  }
  return {
    id: String(taskId),
    state: 'ok',
    error: null,
    source: origin.legacy ? (origin.source || 'legacy') : 'blueprint',
    test_levels: Array.isArray(origin.levels) ? origin.levels : null,
    status: state && state.status ? state.status : null,
    model: actualModel(taskDir),
    ...countersOf(state),
    gate: evaluated.gate,
  }
}

export function readBuildBoard(repo) {
  const tasksDir = path.join(repo, '.collab', 'tasks')
  if (!fs.existsSync(tasksDir)) return { state: 'empty', error: null, tasks: [] }
  let st
  try { st = fs.statSync(tasksDir) } catch (e) {
    return { state: 'error', error: e && e.message ? e.message : String(e), tasks: [] }
  }
  if (!st.isDirectory()) return { state: 'error', error: 'tasks path is not a directory', tasks: [] }
  let names = []
  try {
    names = fs.readdirSync(tasksDir, { withFileTypes: true }).filter((ent) => ent.isDirectory() && /^\d+$/.test(ent.name)).map((ent) => ent.name)
  } catch (e) {
    return { state: 'error', error: e && e.message ? e.message : String(e), tasks: [] }
  }
  names.sort((a, b) => Number(a) - Number(b))
  if (!names.length) return { state: 'empty', error: null, tasks: [] }
  return { state: 'ok', error: null, tasks: names.map((id) => readBuildTask(repo, id)) }
}

export default evaluateBuildGate
