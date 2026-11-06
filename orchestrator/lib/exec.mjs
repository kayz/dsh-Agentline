import fs from 'node:fs'
import path from 'node:path'
import { buildPrompt, ROLE_SPECS } from './prompt.mjs'
import { readState, writeState, appendRun } from './state.mjs'
import { getAdapter } from './adapters/index.mjs'
import { readMailbox, archiveMailbox } from './control.mjs'
import { hasChangesBesides, worktreeFingerprint, dropCheckpoint } from './git.mjs'
import { writeHandoff } from './handoff.mjs'
import { pendingInputs, markConsumed } from './inputs.mjs'

// 网络抖动（TLS 断流、连接重置）不是模型能力问题：应重试同一模型，而不是换候选
const TRANSIENT = /tls handshake|stream disconnected|econnreset|etimedout|socket hang up|socket disconnected|secure tls|fetch failed|reconnecting|network error|workspace routing discovery|timed out/i
export function isTransientError(error) { return !!error && TRANSIENT.test(String(error)) }

// 流程自身产生的文件不算产出（日志/交班单/锁/live 等）
const FLOW_NOISE = [
  /^\.collab\/\.flow\.lock$/,
  /\/live\.json$/,
  /\/mailbox(-used)?\.md$/,
  /\/control\.json$/,
  /\.collab\/tasks\/[^/]+\/logs\//,
  /\.collab\/tasks\/[^/]+\/handoff\//,
]

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const HEALTH_RANK = { green: 0, unknown: 1, yellow: 2, red: 3 }

function livePath(dir) { return path.join(dir, 'live.json') }
function writeLive(dir, payload) {
  try {
    const f = livePath(dir)
    const tmp = f + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ ...payload, pid: process.pid, at: new Date().toISOString() }, null, 2), 'utf8')
    fs.renameSync(tmp, f)
  } catch { /* ignore */ }
}
function clearLive(dir) {
  try { fs.rmSync(livePath(dir), { force: true }) } catch { /* ignore */ }
}

/** 稳定排序：健康度可选；未提供时保持原顺序 */
export function rankByHealth(candidates, health) {
  if (!health || !Array.isArray(candidates) || candidates.length < 2) return candidates
  return candidates
    .map((m, i) => ({ m, i, rank: HEALTH_RANK[health[m.provider] ?? 'unknown'] ?? 1 }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .map((x) => x.m)
}

/** 把角色请求的 effort 夹到 provider 支持的范围内；provider 不支持 effort 时返回 null */
export function clampEffort(effort, provider) {
  const supported = provider?.effort?.supported || []
  if (!supported.length) return null
  let e = effort
  const cap = provider.effort.cap
  if (!supported.includes(e)) e = supported.includes(cap) ? cap : supported[supported.length - 1]
  if (cap && supported.includes(cap) && EFFORT_ORDER.indexOf(e) > EFFORT_ORDER.indexOf(cap)) e = cap
  if ((provider.effort.banned || []).includes(e)) e = supported.includes(cap) ? cap : supported[0]
  return e
}

function resolveModels(config, role, override, candidateOverride) {
  const roleCfg = config.roles?.[role]
  if (!roleCfg) throw new Error(`role not configured: ${role}`)
  const list = Array.isArray(candidateOverride) && candidateOverride.length
    ? candidateOverride
    : (override ? [override] : (roleCfg.candidates || []))
  if (!list.length) throw new Error(`role ${role} has no candidates; run "agentline roles set ${role} <model...>"`)
  return list.map((key) => {
    const m = config.models?.[key]
    if (!m) throw new Error(`unknown model "${key}" for role ${role}`)
    return { key, ...m }
  })
}

const ARTIFACTS = { design: ['design.md', 'acceptance.md'], dev: ['impl.md'] }

/** 切换候选后的成功判定：产物必须是本候选写的，或工作区确实动了 */
function artifactFresh(dir, role, round, sinceMs) {
  let names = []
  if (role === 'review') {
    try {
      names = fs.readdirSync(dir).filter((f) => /^review(-r\d+)?\.md$/.test(f) || /^verdict(-r\d+)?\.json$/.test(f))
    } catch { names = [] }
  } else names = ARTIFACTS[role] || []
  return names.some((f) => {
    try { return fs.statSync(path.join(dir, f)).mtimeMs > sinceMs } catch { return false }
  })
}

/**
 * 执行一个角色（含候选模型切换）。成功返回 { ok, model, run, state }。
 * 换候选时：保留工作区 + 写交班单 + checkpoint，让下一个候选显式选择「继续」或「回滚重做」。
 */
export async function executeRole({
  config, repo, taskId, role, round = 1, modelOverride, candidateOverride, effortOverride, log,
  adapterFactory, health = null, observeIdentity = false,
}) {
  const spec = ROLE_SPECS[role]
  const dir = path.join(repo, config.collabDir, taskId)
  const st = readState(dir) || { id: taskId, status: 'draft', role: null, history: [], switches: 0, attempt: 0 }

  const rawCandidates = resolveModels(config, role, modelOverride, candidateOverride)
  const candidates = rankByHealth(rawCandidates, health)
  if (health && candidates.length > 1) {
    const tags = rawCandidates.map((m) => `${m.key}=${health[m.provider] ?? 'unknown'}`).join(' ')
    log?.(`[health] ${tags} -> order ${candidates.map((m) => m.key).join(' > ')}`)
  }

  const makeAdapter = adapterFactory || ((provider) => getAdapter(provider))
  const policy = config.policy || {}
  const maxSwitches = policy.maxSwitchesPerStage ?? 2
  const netRetries = policy.networkRetries ?? 2
  const handoffEnabled = policy.handoff !== false
  const prevSwitches = st.switches || 0
  let switches = 0
  let lastError = null
  let handoff = null
  const checkpointRefs = []

  for (let idx = 0; idx < candidates.length; idx++) {
    const model = candidates[idx]
    const provider = config.providers?.[model.provider]
    if (!provider) { lastError = `provider not configured: ${model.provider}`; continue }
    const adapter = makeAdapter(provider)
    if (!adapter) { lastError = `no adapter: ${provider.adapter}`; continue }

    const effort = clampEffort(effortOverride || config.roles[role].effort || config.effort.default, provider)
    const mailbox = readMailbox(dir)
    const pending = pendingInputs(dir)
    const userInputs = pending.map((i) => ({ kind: i.kind, text: i.text }))
    const prompt = buildPrompt({ role, repo, dir, taskId, round, mailbox, handoff, userInputs })
    const logsDir = path.join(dir, 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    const logPath = path.join(logsDir, `${role}-r${round}-${idx + 1}.log`)

    log?.(`[${role} r${round}] model=${model.key}(${model.id}) provider=${model.provider} effort=${effort ?? '-'}`)
    const startedAt = new Date()
    writeLive(dir, {
      task: taskId, role, round, model: model.key, modelId: model.id,
      provider: model.provider, backend: provider.adapter, effort,
      log: path.relative(repo, logPath).replaceAll('\\\\', '/'),
      started_at: startedAt.toISOString(),
    })

    let res = null
    for (let net = 0; net <= netRetries; net++) {
      res = await adapter.run({
        prompt, cwd: repo, model: model.id, effort,
        timeoutMs: (provider.limits?.timeoutMinutes || 60) * 60_000, logPath,
      })
      if ((res.exitCode === 0 && !res.error) || !isTransientError(res.error)) break
      if (net < netRetries) log?.(`[${role} r${round}] ${model.key} 网络中断，原模型重试 ${net + 1}/${netRetries}: ${res.error}`)
    }
    clearLive(dir)
    const endedAt = new Date()

    const observed = typeof res.modelResolved === 'string' && res.modelResolved.trim() ? res.modelResolved.trim() : ''
    const record = {
      task: taskId, role, round, candidate: idx + 1, backend: provider.adapter,
      model_requested: model.id,
      // Build 步骤要求真实身份。flow 仍保持原来的回退，避免改变旧语义。
      model_resolved: observeIdentity ? (observed || null) : (res.modelResolved || model.id),
      ...(observeIdentity ? { model_resolved_source: observed ? 'adapter' : 'none' } : {}),
      provider: model.provider,
      effort, started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(),
      duration_ms: endedAt - startedAt, exit: { code: res.exitCode },
      commands: [], artifacts: [], git: null, ci: null,
      usage: res.usage || null,
      usage_source: res.usage ? (res.usageSource || 'unknown') : (res.error ? 'unavailable' : 'none'),
      log_ref: path.relative(repo, logPath).replaceAll('\\', '/'),
      error: res.error || null,
    }

    let ok = res.exitCode === 0 && !res.error
    if (ok && (role === 'dev' || role === 'design')) {
      if (!(await hasChangesBesides(repo, FLOW_NOISE))) {
        ok = false
        res.error = 'no_changes'
      }
    }
    if (ok && handoff) {
      const fresh = artifactFresh(dir, role, round, startedAt.getTime())
      const workspaceChanged = (await worktreeFingerprint(repo)) !== handoff.fingerprint
      record.freshness = { artifact: fresh, workspace: workspaceChanged }
      if (!fresh && !workspaceChanged) {
        ok = false
        res.error = 'no_new_work'
      }
    }
    record.error = res.error || null
    if (handoff) record.inherited_from = { candidate: handoff.fromIndex, model: handoff.model, file: handoff.file }

    if (ok) {
      const nextState = {
        ...st, status: spec.to, role, model: model.id, model_resolved: record.model_resolved,
        effort, attempt: (st.attempt || 0) + 1, switches: prevSwitches + switches,
        blocked_reason: null, updated_at: new Date().toISOString(),
        handoff: null,
        history: [...(st.history || []), { at: new Date().toISOString(), from: st.status, to: spec.to, by: `${role}:${model.key}${handoff ? ' (inherited c' + handoff.fromIndex + ')' : ''}` }],
      }
      appendRun(dir, record)
      markConsumed(dir, pending.map((i) => i.id))
      archiveMailbox(dir)
      for (const ref of checkpointRefs) { try { await dropCheckpoint(repo, ref) } catch { /* ignore */ } }
      writeState(dir, nextState)
      return { ok: true, model: model.key, modelId: model.id, record, state: nextState }
    }

    lastError = res.error || `exit ${res.exitCode}`
    const reasonClass = classifyError(lastError)
    log?.(`[${role} r${round}] ${model.key} failed: ${lastError}`)

    // 认证失败不降级：换一个同样没登录的模型只会再失败一次，还会静默改变质量基线
    if (reasonClass === 'auth') {
      log?.(`[${role} r${round}] 认证失败：按协议不切换候选，直接 blocked`)
      appendRun(dir, record)
      break
    }

    switches += 1
    if (switches >= maxSwitches || idx + 1 >= candidates.length) {
      appendRun(dir, record)
      break
    }

    if (handoffEnabled) {
      try {
        handoff = await writeHandoff({
          repo, dir, taskId, role, round,
          fromIndex: idx + 1, toIndex: idx + 2,
          model: model.key, modelId: model.id, backend: provider.adapter, effort,
          durationMs: record.duration_ms, exitCode: res.exitCode,
          error: lastError, classReason: reasonClass, logPath,
        })
        record.handoff = {
          file: handoff.file,
          checkpoint: handoff.checkpoint?.ref || null,
          sha: handoff.checkpoint?.sha || null,
        }
        if (handoff.checkpoint?.ref) checkpointRefs.push(handoff.checkpoint.ref)
        log?.(`[${role} r${round}] 交班单：${handoff.file}${handoff.checkpoint ? '（checkpoint ' + String(handoff.checkpoint.sha).slice(0, 7) + '）' : '（无改动）'}`)
      } catch (e) {
        handoff = null
        log?.(`[${role} r${round}] 交班单写入失败：${e && e.message ? e.message : String(e)}`)
      }
    }
    appendRun(dir, record)
  }

  const blockedReason = classifyError(lastError)
  const blocked = {
    ...st, status: 'blocked', role, blocked_reason: blockedReason,
    ...(blockedReason === 'rate_limit' ? { rate_limit_reset: parseRateLimitReset(lastError) } : {}),
    switches: prevSwitches + switches, updated_at: new Date().toISOString(),
    handoff: handoff ? handoff.file : null,
    history: [...(st.history || []), { at: new Date().toISOString(), from: st.status, to: 'blocked', by: role, reason: lastError }],
  }
  writeState(dir, blocked)
  return { ok: false, error: lastError, state: blocked, handoff: handoff ? handoff.file : null }
}

/** 从限流文案里摘出重置时间，原样保留时区（例如 "2026-11-05 00:15:26 UTC+8"） */
export function parseRateLimitReset(err) {
  const s = String(err || '')
  const m = s.match(/将在\s*([^。\n]+?)\s*重置/)
  if (m) return m[1].trim()
  const at = s.match(/reset(?:s)?\s*(?:at|in)?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:.]+(?:\s*UTC[+-][0-9]{1,2}(?::[0-9]{2})?)?)/i)
  return at ? at[1].trim() : null
}

export function classifyError(err) {
  const s = String(err || '').toLowerCase()
  if (s.includes('capacity') || s.includes('overloaded')) return 'capacity'
  if (/\b429\b/.test(s)
    || /usage limit|session limit|hit your .{0,20}limit|rate.?limit|too many requests|quota (?:exceeded|exhausted)|frequency limit|请求过于频繁|频率限制|限流|使用量.{0,12}(?:频率|限制)|额度.{0,8}(?:用尽|超出)/i.test(s)) return 'rate_limit'
  if (s.includes('stall')) return 'stall'
  if (s.includes('context')) return 'context'
  if (s.includes('timeout')) return 'timeout'
  if (s.includes('login') || s.includes('auth') || s.includes('unauthor')) return 'auth'
  if (s.includes('network') || s.includes('connect') || s.includes('transport')) return 'transport'
  return 'run_failed'
}

export function readVerdict(dir, round) {
  const names = [`verdict-r${round}.json`, 'verdict.json']
  const files = names
    .map((f) => path.join(dir, f))
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { p } of files) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* ignore */ }
  }
  return null
}


