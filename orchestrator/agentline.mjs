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
import { runFlow } from './lib/flow.mjs'
import { resolveTaskDir } from './lib/worktree.mjs'
import { runningTasks, releaseCapacity, releaseTaskLock, taskLockHolder } from './lib/registry.mjs'
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

function setStatusAt(taskDir, status, by, extra = {}) {
  const st = readState(taskDir) || { id: taskId, history: [] }
  const next = {
    ...st, ...extra, status, updated_at: new Date().toISOString(),
    history: [...(st.history || []), { at: new Date().toISOString(), from: st.status, to: status, by }],
  }
  writeState(taskDir, next)
  return next
}
function setStatus(status, by, extra = {}) {
  return setStatusAt(dir, status, by, extra)
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
  const located = resolveTaskDir(repo, taskId, { collabDir: config.collabDir, dirRel: config.worktree?.dir })
  const taskDir = located?.dir || dir
  const st = readState(taskDir)
  if (st) {
    log(JSON.stringify({ ...st, _worktree: located?.worktree ? located.repo : null }, null, 2))
    return
  }

  // 历史任务（没有 state.json）：只读推导，不写盘
  if (!fs.existsSync(taskDir)) fail(`no task dir: ${taskDir}`)
  const files = fs.readdirSync(taskDir).filter((f) => fs.statSync(path.join(taskDir, f)).isFile())
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf8')) } catch { return null } }
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
  const code = await runFlow({ config, repo, taskId, args, runnerPath: runnerPath(), log })
  process.exit(code)
}

async function cmdMerge() {
  const permission = args.permission
  const located = resolveTaskDir(repo, taskId, { collabDir: config.collabDir, dirRel: config.worktree?.dir })
  const taskDir = located?.dir || dir
  const st = readState(taskDir)
  if (!st) fail(`no state.json in ${taskDir}`)
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

  if (located?.worktree && !args['keep-worktree']) {
    const { removeTaskWorktree } = await import('./lib/worktree.mjs')
    await removeTaskWorktree(repo, taskId, { dirRel: config.worktree?.dir })
    log(`worktree removed: ${located.repo}`)
  }

  const sha = await headSha(repo)
  const mainDir = path.join(repo, config.collabDir, taskId)
  if (!fs.existsSync(mainDir)) fail(`merged task dir missing in main: ${mainDir}`)
  const next = setStatusAt(mainDir, 'merged', 'human', {
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
    const ci = (() => { try { return JSON.parse(fs.readFileSync(path.join(mainDir, 'ci-results.json'), 'utf8')) } catch { return null } })()
    const text = await buildSummary({ repo, taskId, dir: mainDir, event: 'merged', branch: deleted ? `${branchName}（已删除）` : branchName })
    writeNotice(mainDir, { task: taskId, event: 'merged', status: next.status, ci: ci ? `${ci.passed}/${ci.total}` : null, branch: branchName, summary: text })
  } catch { /* ignore */ }
  log(`state: ${next.status}`)
}

async function cmdCheck() {
  const script = path.resolve(__dirname, '..', 'AgentLine', 'tools', 'check-task.ps1')
  if (!fs.existsSync(script)) fail(`check-task.ps1 not found: ${script}`)
  const located = resolveTaskDir(repo, taskId, { collabDir: config.collabDir, dirRel: config.worktree?.dir })
  if (!located) fail(`task dir not found for ${taskId}`)
  const rel = path.relative(located.repo, located.dir)
  const argv = ['-NoProfile', '-File', script, '-RepoRoot', located.repo, '-TaskDir', rel]
  if (args.strict) argv.push('-Strict')
  if (args.lenient) argv.push('-Lenient')
  const { spawn } = await import('node:child_process')
  const child = spawn('pwsh', argv, { cwd: located.repo, stdio: 'inherit', windowsHide: false })
  child.on('close', (code) => process.exit(code ?? 1))
}

async function cmdStop() {
  const tasks = await runningTasks(repo)
  const entry = tasks.find((t) => t.task === taskId)
  const holder = await taskLockHolder(repo, taskId)
  let pid = entry?.pid || holder?.pid || null
  let taskDir = resolveTaskDir(repo, taskId, { collabDir: config.collabDir, dirRel: config.worktree?.dir })?.dir || dir

  if (!pid) {
    const lock = readLock(repo)
    if (lock && lock.task === taskId) pid = lock.pid
  }
  if (!pid || !isPidAlive(pid)) {
    log('没有正在运行的 flow（registry/lock 不存在或持有者已退出）')
    process.exit(1)
  }

  if (args.now) {
    log(`立即终止 flow pid=${pid}`)
    const { spawn } = await import('node:child_process')
    await new Promise((res) => {
      const c = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      c.on('close', () => res())
    })
    const st = readState(taskDir)
    if (st && st.status !== 'merged') setStatusAt(taskDir, 'blocked', 'user', { blocked_reason: 'halted_by_user' })
    clearControl(taskDir)
    await releaseCapacity(repo, taskId)
    await releaseTaskLock(repo, taskId)
    log('已终止；下次 flow --resume 可继续')
    return
  }
  requestStop(taskDir, 'after_stage')
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
  node agentline.mjs flow  --task <id> [--max-rounds 2] [--resume] [--in-place] [--no-wait] [--priority] [--base <ref>]
  node agentline.mjs merge --task <id> --permission "允许合并"
  node agentline.mjs stop  --task <id> [--now]
  node agentline.mjs check --task <id> [--strict|--lenient]
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
  case 'check': await cmdCheck(); break
  case 'help': case '--help': case undefined: help(); break
  default: help(); process.exit(2)
}




