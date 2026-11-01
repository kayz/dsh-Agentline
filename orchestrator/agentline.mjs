#!/usr/bin/env node
/**
 * agentline — 多模型协作调度器（core）
 *
 *   node agentline.mjs init
 *   node agentline.mjs models discover|list|add
 *   node agentline.mjs roles show|set
 *   node agentline.mjs preflight
 *   node agentline.mjs run     --task 001 --role design [--repo <path>]
 *   node agentline.mjs flow    --task 001 [--repo <path>]
 *   node agentline.mjs merge   --task 001 --permission "允许合并"
 *   node agentline.mjs stop    --task 001 [--now]
 *
 * 设计：base 配置（仓库）+ local 覆盖（本机）+ 发现缓存（模型目录）。
 * 没有默认模型；角色必须由用户显式选择后才能跑 flow。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, loadProjectConfig, projectConfigPath, ROLES } from './lib/config.mjs'
import { getAdapter } from './lib/adapters/index.mjs'
import { discoverAll, saveDiscovery, discoverySummary, setRoleCandidates, addModel, formatModelTable } from './lib/models.mjs'
import { effectiveRole, readProject } from './lib/routing.mjs'
import { executeRole, readVerdict } from './lib/exec.mjs'
import { readState, writeState, appendRun } from './lib/state.mjs'
import { runCI, ciRecord } from './lib/ci.mjs'
import { ensureTaskBranch, commitAll, changedFiles, headSha } from './lib/git.mjs'
import { acquireLock, installCleanup } from './lib/lock.mjs'
import { sweepInterrupted, readLock, isPidAlive, REASON } from './lib/recovery.mjs'
import { requestStop, isStopRequested, clearControl } from './lib/control.mjs'
import { buildSummary } from './lib/summary.mjs'
import { writeNotice, printReport } from './lib/report.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const log = (m = '') => console.log(m)

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v !== undefined && !v.startsWith('--')) { out[k] = v; i++ } else out[k] = true
    } else out._.push(a)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
const repo = path.resolve(args.repo || process.cwd())

function fail(msg, code = 1) {
  console.error('ERROR: ' + msg)
  process.exit(code)
}

let loaded
try {
  loaded = loadConfig({
    orchestratorRoot: __dirname,
    configPath: args.config,
    localPath: args.local,
    modelsPath: args.models,
    repo,
  })
} catch (e) {
  fail(e.message)
}
const config = loaded.config
const paths = loaded.paths
const projectCfg = loadProjectConfig(repo)
const taskId = args.task || '001'
const taskDirRel = path.join(config.collabDir, taskId)
const dir = path.join(repo, taskDirRel)

function runnerPath() {
  const raw = args.runner || config.ci?.runner
  if (!raw) return null
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, raw)
}

function setStatus(status, by, extra = {}) {
  const st = readState(dir) || { id: taskId, history: [] }
  const next = {
    ...st, ...extra, status, updated_at: new Date().toISOString(),
    history: [...(st.history || []), { at: new Date().toISOString(), from: st.status, to: status, by }],
  }
  writeState(dir, next)
  return next
}

// ───────────────────────────── init / models / roles ─────────────────────────────
async function cmdInit() {
  const cache = await discoverAll(config, { providers: args.provider ? [args.provider] : null })
  saveDiscovery(paths, cache)
  const fresh = loadConfig({ orchestratorRoot: __dirname, configPath: args.config, localPath: args.local, modelsPath: args.models, repo })
  log('provider          source     models  warnings')
  for (const row of discoverySummary(cache)) {
    log(`${row.provider.padEnd(16)}  ${row.source.padEnd(9)}  ${String(row.models).padStart(6)}  ${row.warnings.join('; ')}`)
  }
  log('')
  if (!Object.keys(fresh.config.models).length) {
    log('没有发现任何模型。请检查 provider 是否安装/登录，或手动添加：')
    log('  node agentline.mjs models add <provider> <model-id>')
    return
  }
  log(formatModelTable(fresh.config))
  log('')
  log('下一步：为三个角色选择模型（每个角色至少一个；review 必须与 dev 不同）')
  for (const role of ROLES) log(`  node agentline.mjs roles set ${role} <model-key> [...]`)
  log('然后：node agentline.mjs preflight')
}

async function cmdModels() {
  const sub = args._[1]
  if (sub === 'discover') {
    const cache = await discoverAll(config, { providers: args.provider ? [args.provider] : null })
    saveDiscovery(paths, cache)
    for (const row of discoverySummary(cache)) {
      log(`${row.provider}: source=${row.source} models=${row.models}${row.warnings.length ? ' warnings=' + row.warnings.join('; ') : ''}`)
    }
    return
  }
  if (sub === 'list' || !sub) {
    if (!Object.keys(config.models).length) { log('(no models; run "agentline models discover")'); return }
    log(formatModelTable(config))
    return
  }
  if (sub === 'add') {
    const provider = args._[2] || args.provider
    const id = args._[3] || args.id
    if (!provider || !id) fail('usage: agentline models add <provider> <model-id> [--key <key>]')
    const r = addModel(paths, config, { provider, id, key: args.key || null })
    log(`added model ${r.key} (${r.provider}:${r.id}) to ${paths.local}`)
    return
  }
  fail(`unknown models subcommand: ${sub}`)
}

function cmdRoles() {
  const sub = args._[1]
  if (sub === 'show' || !sub) {
    for (const role of ROLES) {
      const keys = config.roles?.[role]?.candidates || []
      const order = effectiveRole(config, role, projectCfg)
      log(`${role.padEnd(7)} global=[${keys.join(', ')}]  project=[${order.order.join(' > ')}]  effort=${order.effort}`)
    }
    return
  }
  if (sub === 'set') {
    const role = args._[2] || args.role
    const keys = args._.slice(3)
    if (!role || !keys.length) fail('usage: agentline roles set <design|dev|review> <model-key...> [--project]')
    if (!ROLES.includes(role)) fail(`unknown role: ${role}`)
    const missing = keys.filter((k) => !config.models?.[k])
    if (missing.length) fail(`unknown model(s): ${missing.join(', ')}${Object.keys(config.models || {}).length ? '' : ' (run "agentline init" first)'}`)
    if (args.project) {
      const p = readProject(repo)
      p.routing = p.routing || {}
      p.routing[role] = { ...(p.routing[role] || {}), order: keys, model: keys[0] }
      fs.mkdirSync(path.dirname(projectConfigPath(repo)), { recursive: true })
      fs.writeFileSync(projectConfigPath(repo), JSON.stringify(p, null, 2), 'utf8')
      log(`set ${role} in project ${repo}: ${keys.join(' > ')}`)
    } else {
      const r = setRoleCandidates(paths, config, role, keys)
      log(`set ${role} globally: ${r.candidates.join(' > ')} (${paths.local})`)
    }
    return
  }
  fail(`unknown roles subcommand: ${sub}`)
}

// ───────────────────────────── preflight ─────────────────────────────
async function cmdPreflight() {
  let bad = 0
  for (const e of loaded.errors) { console.error(`[config] ${e}`); bad++ }
  const effOrders = {}
  for (const role of ROLES) effOrders[role] = effectiveRole(config, role, projectCfg).order
  const usedProviders = new Set()
  for (const role of ROLES) for (const k of effOrders[role]) {
    const m = config.models?.[k]
    if (m) usedProviders.add(m.provider)
  }

  log('provider          source     adapter        status')
  for (const [name, p] of Object.entries(config.providers)) {
    const adapter = getAdapter(p)
    if (!adapter) { log(`${name.padEnd(16)}  ${String(p.source).padEnd(9)}  ${String(p.adapter).padEnd(13)}  NO ADAPTER`); bad++; continue }
    let r
    if (args.fast) r = { ok: true, version: '-', detail: 'skipped' }
    else {
      try { r = await adapter.check() } catch (e) { r = { ok: false, version: '-', detail: e.message } }
    }
    const used = usedProviders.has(name)
    if (!r.ok && used) bad++
    log(`${name.padEnd(16)}  ${String(p.source).padEnd(9)}  ${String(p.adapter).padEnd(13)}  ${r.ok ? 'OK' : (used ? 'FAIL' : 'unused')} version=${r.version || '-'} ${r.detail || ''}`)
  }

  const modelCount = Object.keys(config.models).length
  log(`\nmodels: ${modelCount}${loaded.discovery?.generatedAt ? ` (discovered ${loaded.discovery.generatedAt})` : ' (no discovery cache)'}`)
  if (!modelCount) bad++

  const missing = ROLES.filter((role) => !effOrders[role].length)
  if (missing.length) { console.error(`roles not configured: ${missing.join(', ')} (run "agentline init" then "agentline roles set ...")`); bad++ }
  else {
    for (const role of ROLES) log(`role ${role.padEnd(7)} <- ${effOrders[role].join(' > ')}`)
    const dev = new Set(effOrders.dev)
    if (!effOrders.review.some((k) => !dev.has(k))) {
      console.error('review candidates all overlap dev candidates: review model must differ from dev')
      bad++
    }
  }

  const rp = runnerPath()
  if (!rp) log('ci.runner: (empty) — flow will fail until configured')
  else if (!fs.existsSync(rp)) { console.error(`ci.runner not found: ${rp}`); bad++ }
  else log(`ci.runner: ${rp}`)

  if (bad) { log(`\npreflight: ${bad} problem(s)`); process.exit(1) }
  log('\npreflight: OK')
}

// ───────────────────────────── status / run / flow ─────────────────────────────
function cmdStatus() {
  const st = readState(dir)
  if (st) { log(JSON.stringify(st, null, 2)); return }

  // 历史任务（没有 state.json）：只读推导，不写盘
  if (!fs.existsSync(dir)) fail(`no task dir: ${dir}`)
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile())
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }
  const verdicts = files.filter((f) => /^verdict.*\.json$/.test(f)).sort().map((f) => ({ file: f, ...readJson(f) }))
  const last = verdicts[verdicts.length - 1] || null
  log(JSON.stringify({
    id: taskId,
    status: 'legacy (no state.json)',
    legacy: true,
    note: '任务在状态机之前执行；以下为可推导的证据，未写入 state.json',
    artifacts: files,
    verdicts,
    inferred: last ? { verdict: last.verdict, round: last.round ?? 1, source: last.file } : null,
  }, null, 2))
}

async function cmdRun() {
  const role = args.role
  if (!role) fail('missing --role')
  if (!ROLES.includes(role)) fail(`unknown role: ${role}`)
  const eff = effectiveRole(config, role, projectCfg)
  if (!eff.order.length) fail(`role ${role} has no models; run "agentline roles set ${role} <model...>"`)
  log('routing: ' + role + ' -> ' + eff.order.join(' > '))
  const r = await executeRole({
    config, repo, taskId, role, round: Number(args.round || 1),
    modelOverride: args.model, candidateOverride: eff.order, effortOverride: eff.effort, log,
  })
  log(r.ok ? `state: ${r.state.status}` : `blocked: ${r.state.blocked_reason}`)
  process.exit(r.ok ? 0 : 1)
}

async function cmdFlow() {
  const maxRounds = Number(args['max-rounds'] ?? 2)
  const runner = runnerPath()
  const summary = []

  if (args['dry-run']) { log(`dry-run: would run design→dev→CI→review for task ${taskId} in ${repo}`); return }
  if (!runner) fail('ci.runner is not configured (set it in config/agentline.local.json)')
  if (!fs.existsSync(runner)) fail(`ci.runner not found: ${runner}`)
  if (loaded.errors.length) fail(loaded.errors.join('\n'))
  const missingRoles = ROLES.filter((role) => !effectiveRole(config, role, projectCfg).order.length)
  if (missingRoles.length) fail(`roles not configured: ${missingRoles.join(', ')} (run "agentline init" then "agentline roles set ...")`)

  let st = readState(dir)
  if (st && ['reviewed', 'pr_open', 'merged'].includes(st.status)) {
    log(`task ${taskId} is ${st.status}; nothing to do`)
    return
  }

  const lockFile = path.join(repo, '.collab', '.flow.lock')
  const lock = acquireLock(lockFile, { task: taskId, cmd: 'flow' })
  if (!lock.ok) {
    log(`another flow is running: pid=${lock.holder.pid} task=${lock.holder.task || '?'} since ${lock.holder.at}`)
    log('if that process is gone, rerun — stale locks are reclaimed automatically')
    process.exit(2)
  }
  installCleanup(lockFile)
  if (lock.stale) log(`reclaimed stale lock from pid=${lock.stale.pid} task=${lock.stale.task || '?'}`)

  const branch = await ensureTaskBranch(repo, taskId)
  log(`branch: ${branch.branch}${branch.created ? ' (created)' : ''}`)

  st = st || setStatus('draft', 'init')

  const doCI = async (label) => {
    log(`\n[CI] ${label}`)
    const ci = await runCI({ repo, taskDirRel, runnerPath: runner, outPath: path.join(dir, 'ci-results.json') })
    appendRun(dir, {
      task: taskId, role: 'ci', round: 0, backend: 'local', provider: 'local',
      model_requested: '-', model_resolved: '-', effort: '-',
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_ms: 0, exit: { code: ci.exitCode }, commands: [], artifacts: [], git: null,
      ci: ciRecord(ci, taskDirRel, repo, runner), usage: null, usage_source: 'none',
      log_ref: `${taskDirRel.replaceAll('\\', '/')}/ci-results.json`, error: ci.ok ? null : 'ci_failed',
    })
    log(ci.ok ? `CI PASS ${ci.summary?.passed}/${ci.summary?.total}` : `CI FAIL ${ci.summary?.passed ?? '?'}/${ci.summary?.total ?? '?'}`)
    return ci
  }

  const swept = sweepInterrupted(repo, { log })
  if (swept.length) log('recovery: ' + swept.map((x) => x.task + '(' + x.from + ')').join(', ') + ' 标记为中断')
  st = readState(dir) || st

  if (st.status === 'blocked') {
    if (!args.resume) {
      const why = st.blocked_reason === REASON ? '上次运行被终止（可一键继续）' : (st.blocked_reason || 'unknown')
      log('task is blocked (' + why + '); rerun with --resume to continue')
      process.exit(2)
    }
    const hist = st.history || []
    const last = [...hist].reverse().find((h) => h.to && h.to !== 'blocked')
    const back = last ? last.to : 'draft'
    log('resume: ' + st.status + ' -> ' + back)
    if (st.blocked_reason === REASON && !args.keep) {
      const discarded = await discardWorkingChanges(repo, log)
      if (discarded) log('recovery: 已丢弃中断时留下的未提交改动（--keep 可保留）')
    }
    st = setStatus(back, 'resume', { blocked_reason: null, interrupted: null })
  }

  const STOPPED = 'halted_by_user'
  const stopIfRequested = (where) => {
    if (!isStopRequested(dir)) return false
    log('stop requested -> 在 ' + where + ' 之后停止')
    clearControl(dir)
    setStatus('blocked', 'user', { blocked_reason: STOPPED })
    return true
  }

  if (st.status === 'draft') {
    const eff = effectiveRole(config, 'design', projectCfg)
    log('routing: design -> ' + eff.order.join(' > '))
    const r = await executeRole({ config, repo, taskId, role: 'design', round: 1, candidateOverride: eff.order, effortOverride: eff.effort, log })
    if (!r.ok) return finish({ ok: false, reason: r.state.blocked_reason })
    await commitAll(repo, `stage(design): task ${taskId}`)
    summary.push({ stage: 'design', model: r.model, ok: true })
    if (stopIfRequested('design')) return finish({ ok: false, reason: STOPPED })
    st = readState(dir)
  }

  if (st.status === 'designed') {
    const eff = effectiveRole(config, 'dev', projectCfg)
    log('routing: dev -> ' + eff.order.join(' > '))
    const r = await executeRole({ config, repo, taskId, role: 'dev', round: 1, candidateOverride: eff.order, effortOverride: eff.effort, log })
    if (!r.ok) return finish({ ok: false, reason: r.state.blocked_reason })
    await commitAll(repo, `stage(dev): task ${taskId}`)
    summary.push({ stage: 'dev', model: r.model, ok: true })
    if (stopIfRequested('dev')) return finish({ ok: false, reason: STOPPED })
    st = readState(dir)
  }

  let ci = await doCI('after dev')
  if (!ci.ok) {
    log('[CI] failing → one repair attempt')
    const eff = effectiveRole(config, 'dev', projectCfg)
    const r = await executeRole({ config, repo, taskId, role: 'dev', round: 1, candidateOverride: eff.order, effortOverride: eff.effort, log })
    if (!r.ok) return finish({ ok: false, reason: r.state.blocked_reason })
    await commitAll(repo, `fix(dev): repair after CI failure (task ${taskId})`)
    ci = await doCI('after repair')
    if (!ci.ok) return finish({ ok: false, reason: 'ci_failed' })
  }
  setStatus('reviewable', 'ci')
  if (stopIfRequested('CI')) return finish({ ok: false, reason: STOPPED })

  let verdict = null
  for (let round = 1; round <= maxRounds; round++) {
    const devModelId = readState(dir)?.model
    const revEff = effectiveRole(config, 'review', projectCfg)
    const allowed = revEff.order.filter((k) => config.models[k] && config.models[k].id !== devModelId)
    const reviewModel = allowed[0]
    if (!reviewModel) return finish({ ok: false, reason: 'no_candidate' })
    log(`[review r${round}] dev used ${devModelId} → review model ${reviewModel}`)

    const rv = await executeRole({ config, repo, taskId, role: 'review', round, modelOverride: reviewModel, effortOverride: revEff.effort, log })
    if (!rv.ok) return finish({ ok: false, reason: rv.state.blocked_reason })
    verdict = readVerdict(dir, round)
    summary.push({ stage: `review-r${round}`, model: rv.model, ok: verdict?.verdict === 'pass', verdict: verdict?.verdict })

    if (verdict?.verdict === 'pass') {
      await commitAll(repo, `stage(review-r${round}): pass (task ${taskId})`)
      setStatus('reviewed', 'review')
      break
    }

    log(`[review r${round}] needs_revision → repair`)
    await commitAll(repo, `stage(review-r${round}): needs_revision (task ${taskId})`)
    const eff = effectiveRole(config, 'dev', projectCfg)
    const fx = await executeRole({ config, repo, taskId, role: 'dev', round: round + 1, candidateOverride: eff.order, effortOverride: eff.effort, log })
    if (!fx.ok) return finish({ ok: false, reason: fx.state.blocked_reason })
    await commitAll(repo, `fix(dev-r${round + 1}): address review findings (task ${taskId})`)
    ci = await doCI(`after repair r${round}`)
    if (!ci.ok) return finish({ ok: false, reason: 'ci_failed' })
    setStatus('reviewable', 'ci')
    if (stopIfRequested('review-repair CI')) return finish({ ok: false, reason: STOPPED })
  }

  if (verdict?.verdict !== 'pass') return finish({ ok: false, reason: 'review_exhausted' })

  const files = await changedFiles(repo, 'main')
  setStatus('pr_open', 'agentline', {
    pr: { branch: branch.branch, state: 'open', files, sha: await headSha(repo) },
    merge_gate: { requires_human_permission: true, on_no_permission: 'stay_in_pr' },
  })
  await commitAll(repo, `chore(${taskId}): pr_open state`)
  return finish({ ok: true, branch: branch.branch, files })

  async function finish(result) {
    log('\n=== FLOW SUMMARY ===')
    for (const s of summary) log((s.ok ? 'OK  ' : 'FAIL') + '  ' + String(s.stage).padEnd(12) + ' model=' + (s.model ?? '-') + (s.verdict ? ' verdict=' + s.verdict : ''))
    log(result.ok ? 'result: PR READY (pr_open)' : 'result: BLOCKED - ' + result.reason)

    if (!result.ok) {
      try {
        const cur = readState(dir)
        if (cur && cur.status !== 'merged' && cur.status !== 'blocked') {
          setStatus('blocked', 'flow', { blocked_reason: result.reason || 'unknown' })
        }
      } catch (e) { log('persist blocked failed: ' + (e && e.message ? e.message : String(e))) }
    }

    try {
      const st2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) } catch { return null } })()
      const ci2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'ci-results.json'), 'utf8')) } catch { return null } })()
      let v2 = null
      let bestRound = -1
      for (const name of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
        const m = name.match(/^verdict(?:-r(\d+))?\.json$/)
        if (!m) continue
        const round = m[1] ? Number(m[1]) : 1
        if (round > bestRound) { bestRound = round; v2 = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }
      }
      const event = result.ok ? 'pr_open' : (String(result.reason || '') === STOPPED ? 'halted' : 'blocked')
      const text = await buildSummary({ repo, taskId, dir, event, reason: result.reason || null, branch: result.branch || (branch && branch.branch) || null })
      writeNotice(dir, {
        task: taskId, event, reason: result.reason || null,
        verdict: v2 ? v2.verdict : null, ci: ci2 ? `${ci2.passed}/${ci2.total}` : null,
        files: result.files ? result.files.length : null,
        branch: result.branch || (branch && branch.branch) || null,
        status: st2 ? st2.status : null, summary: text,
      })
    } catch (e) { log('summary/notice failed: ' + (e && e.message ? e.message : String(e))) }

    try {
      await printReport({ repo, taskId, dir, runs: null, summary, result, branch: result.branch || (branch && branch.branch) })
    } catch (e) { log('report failed: ' + (e && e.message ? e.message : String(e))) }
    process.exit(result.ok ? 0 : 1)
  }
}

async function discardWorkingChanges(repo, log) {
  const { spawn } = await import('node:child_process')
  const run = (a) => new Promise((res) => {
    const c = spawn('git', a, { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let o = ''; let e = ''
    c.stdout.on('data', (d) => { o += d })
    c.stderr.on('data', (d) => { e += d })
    c.on('close', (code) => res({ code, out: o, err: e }))
  })
  const st = await run(['status', '--porcelain'])
  const entries = st.out.split('\n').filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2).trim(), file: line.slice(3).trim() }))
    .filter((x) => x.file && !x.file.startsWith('.collab/') && x.file !== '.gitignore')
  if (!entries.length) return false
  const tracked = entries.filter((x) => x.code !== '??').map((x) => x.file)
  const untracked = entries.filter((x) => x.code === '??').map((x) => x.file)
  if (tracked.length) await run(['checkout', '--', ...tracked])
  for (const f of untracked) { try { fs.rmSync(path.join(repo, f), { force: true }) } catch { /* ignore */ } }
  log?.(`discarded: ${tracked.length} modified, ${untracked.length} untracked`)
  return true
}

async function cmdMerge() {
  const permission = args.permission
  const st = readState(dir)
  if (!st) fail(`no state.json in ${dir}`)
  if (!permission || typeof permission !== 'string') fail('refuse: merge 需要人类许可：agentline merge --task <id> --permission "允许合并"')
  if (st.status !== 'pr_open') fail(`refuse: task status is ${st.status}, expected pr_open`)

  const branchName = `task/${taskId}`
  log(`human permission: "${permission}"`)
  log(`merging ${branchName} → main`)

  const { spawn } = await import('node:child_process')
  const run = (a) => new Promise((res) => {
    const c = spawn('git', a, { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let o = ''; let e = ''
    c.stdout.on('data', (d) => { o += d })
    c.stderr.on('data', (d) => { e += d })
    c.on('close', (code) => res({ code, out: o.trim(), err: e.trim() }))
  })

  const co = await run(['checkout', 'main'])
  if (co.code !== 0) fail(`checkout main failed (工作区可能不干净): ${co.err || co.out}`)
  const m = await run(['merge', '--no-ff', branchName, '-m', `merge: ${branchName} (human permission: ${permission})`])
  if (m.code !== 0) fail(`merge failed: ${m.err || m.out}`)
  const anc = await run(['merge-base', '--is-ancestor', branchName, 'main'])
  if (anc.code !== 0) fail(`merge verification failed: ${branchName} is not contained in main`)

  const sha = await headSha(repo)
  const next = setStatus('merged', 'human', {
    pr: { ...(st.pr || {}), state: 'merged', sha, merged_at: new Date().toISOString(), permission },
  })
  await commitAll(repo, `chore(${taskId}): mark merged after human permission`)
  log(`merged: ${sha}`)

  let deleted = false
  if (!args['keep-branch']) {
    const d = await run(['branch', '-d', branchName])
    deleted = d.code === 0
    log(deleted ? `branch deleted: ${branchName}（--keep-branch 可保留）` : `branch kept: ${d.err || d.out}`)
  }

  try {
    const ci = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'ci-results.json'), 'utf8')) } catch { return null } })()
    const text = await buildSummary({ repo, taskId, dir, event: 'merged', branch: deleted ? `${branchName}（已删除）` : branchName })
    writeNotice(dir, { task: taskId, event: 'merged', status: next.status, ci: ci ? `${ci.passed}/${ci.total}` : null, branch: branchName, summary: text })
  } catch { /* ignore */ }
  log(`state: ${next.status}`)
}

async function cmdStop() {
  const lock = readLock(repo)
  if (!lock || !isPidAlive(lock.pid)) {
    log('没有正在运行的 flow（lock 不存在或持有者已退出）')
    process.exit(1)
  }
  if (args.now) {
    log(`立即终止 flow pid=${lock.pid}`)
    const { spawn } = await import('node:child_process')
    await new Promise((res) => {
      const c = spawn('taskkill', ['/PID', String(lock.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      c.on('close', () => res())
    })
    const st = readState(dir)
    if (st && st.status !== 'merged') setStatus('blocked', 'user', { blocked_reason: 'halted_by_user' })
    clearControl(dir)
    log('已终止；下次 flow --resume 可继续')
    return
  }
  requestStop(dir, 'after_stage')
  log('已请求停止：当前阶段结束后退出（flow 会自己收尾）')
}

function help() {
  log(`agentline — 多模型协作调度器

用法：
  node agentline.mjs init
  node agentline.mjs models discover|list|add
  node agentline.mjs roles show|set
  node agentline.mjs preflight
  node agentline.mjs run   --task <id> --role <design|dev|review>
  node agentline.mjs flow  --task <id> [--max-rounds 2] [--resume]
  node agentline.mjs merge --task <id> --permission "允许合并"
  node agentline.mjs stop  --task <id> [--now]
  node agentline.mjs status --task <id>

公共参数：
  --repo <path>      目标仓库（默认当前目录）
  --config <path>    base 配置
  --local <path>     本机覆盖配置
  --models <path>    发现缓存
`)
}

switch (cmd) {
  case 'init': await cmdInit(); break
  case 'preflight': await cmdPreflight(); break
  case 'models': await cmdModels(); break
  case 'roles': cmdRoles(); break
  case 'status': cmdStatus(); break
  case 'run': await cmdRun(); break
  case 'flow': await cmdFlow(); break
  case 'merge': await cmdMerge(); break
  case 'stop': await cmdStop(); break
  case 'help': case '--help': case undefined: help(); break
  default: help(); process.exit(2)
}


