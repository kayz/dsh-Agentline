/**
 * flow.mjs — design → dev → CI → review → pr_open
 *
 * P2：每个任务在独立 git worktree 中执行；主工作区停在 main。
 * 并发：先跑 design（只写任务自己的 .collab），进入 dev 前申请执行槽；
 * 槽位（maxTasks）与 write_scope 冲突由 .git/agentline/registry.json 协调。
 */
import fs from 'node:fs'
import path from 'node:path'
import { executeRole, readVerdict } from './exec.mjs'
import { readState, writeState, appendRun } from './state.mjs'
import { runCI, ciRecord } from './ci.mjs'
import { ensureTaskWorktree, resolveTaskDir, assertTaskBrief } from './worktree.mjs'
import { acquireTaskLock, releaseTaskLock, acquireCapacity, releaseCapacity, updatePhase } from './registry.mjs'
import { readWriteScope } from './scope.mjs'
import { acquireLock, installCleanup, releaseLock } from './lock.mjs'
import { sweepInterrupted, REASON } from './recovery.mjs'
import { isStopRequested, clearControl } from './control.mjs'
import { ensureTaskBranch, commitAll, changedFiles, headSha } from './git.mjs'
import { buildSummary } from './summary.mjs'
import { writeNotice, printReport } from './report.mjs'
import { effectiveRole } from './routing.mjs'
import { appendInput, pendingInputs, readAttention, removeAttention } from './inputs.mjs'
import { evaluateMerge, describeTier } from './merge-policy.mjs'

const STOPPED = 'halted_by_user'
const WRITE_SCOPE_NOTE = 'design.md 缺少 write_scope。请只在 design.md 最顶部补一段 YAML front matter：第一行 ---，接着 write_scope:，下面每行 "  - 路径或 glob"（相对仓库根，* 单段、** 多段），最后一行 ---。列出 developer 允许修改的全部路径；不改产品代码就写 write_scope: []。design.md 其余内容和 acceptance.md 保持不变。'

function setStatusAt(taskDir, taskId, status, by, extra = {}) {
  const st = readState(taskDir) || { id: taskId, history: [] }
  const next = {
    ...st, ...extra, status, updated_at: new Date().toISOString(),
    history: [...(st.history || []), { at: new Date().toISOString(), from: st.status, to: status, by }],
  }
  writeState(taskDir, next)
  return next
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

export async function runFlow({ config, repo, taskId, args = {}, runnerPath, log = console.log, adapterFactory }) {
  const taskDirRel = path.join(config.collabDir, taskId)
  const wtCfg = config.worktree || {}
  const wtDir = wtCfg.dir || '.collab/worktrees'
  const projectCfg = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(repo, '.collab', 'agentline.json'), 'utf8')) } catch { return {} }
  })()
  const maxRounds = Number(args['max-rounds'] ?? 2)
  const summary = []
  // 会话复用统一在 executeRole 内完成（lib/session.mjs）：flow 只按角色/轮次调用。
  // design/dev 跨轮复用同一 CLI session；review 每轮由角色策略强制新建。
  const runRole = (opts) => executeRole({ ...opts, adapterFactory })

  if (args['dry-run']) { log(`dry-run: would run design→dev→CI→review for task ${taskId} in ${repo}`); return 0 }
  if (!runnerPath) { log('ERROR: ci.runner is not configured'); return 1 }
  if (!fs.existsSync(runnerPath)) { log(`ERROR: ci.runner not found: ${runnerPath}`); return 1 }
  const missingRoles = ['design', 'dev', 'review'].filter((role) => !effectiveRole(config, role, projectCfg).order.length)
  if (missingRoles.length) { log(`ERROR: roles not configured: ${missingRoles.join(', ')}`); return 1 }

  // ── 定位执行目录：worktree 优先，旧任务退回主工作区 ──────────────
  const located = resolveTaskDir(repo, taskId, { collabDir: config.collabDir, dirRel: wtDir })
  const legacy = located && !located.worktree && fs.existsSync(path.join(located.dir, 'state.json'))
  const useWorktree = !args['in-place'] && wtCfg.enabled !== false && !legacy
  let runRepo = located?.repo || repo
  let runDir = located?.dir || path.join(repo, taskDirRel)
  let worktree = Boolean(located?.worktree)
  let inPlace = false
  let taskLock = false
  let legacyLockFile = null
  let capacity = false

  if (useWorktree) {
    const lock = await acquireTaskLock(repo, taskId)
    if (!lock.ok) {
      log(`another flow owns task ${taskId}: pid=${lock.holder?.pid || '?'} since ${lock.holder?.since || '?'}`)
      return 2
    }
    taskLock = true
    if (worktree) {
      log(`worktree: ${runRepo}`)
    } else {
      const wt = await ensureTaskWorktree(repo, taskId, { baseRef: args.base || wtCfg.baseRef || 'main', dirRel: wtDir })
      runRepo = wt.path
      runDir = path.join(runRepo, taskDirRel)
      worktree = true
      log(`worktree: ${runRepo}${wt.created ? ' (created)' : ''}`)
    }
  } else {
    if (legacy) log('legacy in-place task detected: running in main worktree')
    const lockFile = path.join(repo, '.collab', '.flow.lock')
    const lock = acquireLock(lockFile, { task: taskId, cmd: 'flow' })
    if (!lock.ok) {
      log(`another flow is running: pid=${lock.holder.pid} task=${lock.holder.task || '?'} since ${lock.holder.at}`)
      return 2
    }
    installCleanup(lockFile)
    legacyLockFile = lockFile
    if (lock.stale) log(`reclaimed stale lock from pid=${lock.stale.pid}`)
  }

  inPlace = !worktree

  const releaseAll = async () => {
    if (capacity) { capacity = false; await releaseCapacity(repo, taskId) }
    if (taskLock) { taskLock = false; await releaseTaskLock(repo, taskId) }
    if (legacyLockFile) { releaseLock(legacyLockFile); legacyLockFile = null }
  }

  // worktree 只包含已提交内容。任务输入缺失时必须在这里失败，不能先调用模型。
  try {
    assertTaskBrief(runDir)
  } catch (e) {
    log(`ERROR: ${e.message}`)
    log('任务输入（.collab/tasks/<id>/brief.md）必须先提交到 main，worktree 才能看到它。')
    await releaseAll()
    return 1
  }

  const setStatus = (status, by, extra = {}) => setStatusAt(runDir, taskId, status, by, extra)
  const stopIfRequested = (where) => {
    if (!isStopRequested(runDir)) return false
    log('stop requested -> 在 ' + where + ' 之后停止')
    clearControl(runDir)
    setStatus('blocked', 'user', { blocked_reason: STOPPED })
    return true
  }

  const midAmendment = (where) => {
    const am = pendingInputs(runDir, ['amendment'])
    if (!am.length) return false
    log(`[input] ${am.length} 条 amendment（${where}）→ 当前轮作废，回到 design`)
    setStatus('blocked', 'input', { blocked_reason: 'amendment_pending' })
    return true
  }
  const attentionBlock = (where) => {
    const att = readAttention(runDir)
    if (!att) return false
    log(`[attention] ${where}: ${att.question || '(no question)'}`)
    if (Array.isArray(att.options) && att.options.length) log('options: ' + att.options.join(' | '))
    setStatus('blocked', 'input', { blocked_reason: 'awaiting_human' })
    return true
  }

  const scopeNow = () => {
    const s = readWriteScope(path.join(runDir, 'design.md'))
    return s // null = 未声明（视为 **），[] = 不写产品代码
  }

  const ensureSlot = async (phase) => {
    if (capacity) return { ok: true }
    const r = await acquireCapacity({
      repo, taskId, scope: inPlace ? ['**'] : scopeNow(), worktree: runRepo, phase,
      wait: !args['no-wait'] && config.concurrency?.wait !== false,
      priority: Boolean(args.priority),
      maxTasks: Number(args['max-tasks'] || config.concurrency?.maxTasks || 3),
      pollMs: Math.max(1, Number(config.concurrency?.pollSeconds || 5)) * 1000,
      log,
    })
    if (!r.ok) {
      const cur = readState(runDir) || {}
      writeState(runDir, { ...cur, queued: { at: new Date().toISOString(), reason: r.reason, phase } })
      log(`[queue] ${r.reason}`)
      return { ok: false }
    }
    capacity = true
    const cur = readState(runDir)
    if (cur?.queued) { delete cur.queued; writeState(runDir, cur) }
    await updatePhase(repo, taskId, phase)
    return { ok: true }
  }

  const finish = async (result) => {
    log('\n=== FLOW SUMMARY ===')
    for (const s of summary) log((s.ok ? 'OK  ' : 'FAIL') + '  ' + String(s.stage).padEnd(12) + ' model=' + (s.model ?? '-') + (s.verdict ? ' verdict=' + s.verdict : ''))
    log(result.ok ? 'result: PR READY (pr_open)' : 'result: BLOCKED - ' + result.reason)

    if (!result.ok) {
      try {
        const cur = readState(runDir)
        if (cur && cur.status !== 'merged' && cur.status !== 'blocked') {
          setStatus('blocked', 'flow', { blocked_reason: result.reason || 'unknown' })
        }
      } catch (e) { log('persist blocked failed: ' + (e && e.message ? e.message : String(e))) }
    }

    try {
      const st2 = readState(runDir)
      const ci2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'ci-results.json'), 'utf8')) } catch { return null } })()
      let v2 = null
      let bestRound = -1
      for (const name of (fs.existsSync(runDir) ? fs.readdirSync(runDir) : [])) {
        const m = name.match(/^verdict(?:-r(\d+))?\.json$/)
        if (!m) continue
        const round = m[1] ? Number(m[1]) : 1
        if (round > bestRound) { bestRound = round; v2 = JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8')) }
      }
      const event = result.ok ? 'pr_open' : (String(result.reason || '') === STOPPED ? 'halted' : 'blocked')
      const text = await buildSummary({ repo: runRepo, taskId, dir: runDir, event, reason: result.reason || null, branch: result.branch || `task/${taskId}` })
      writeNotice(runDir, {
        task: taskId, event, reason: result.reason || null,
        verdict: v2 ? v2.verdict : null, ci: ci2 ? `${ci2.passed}/${ci2.total}` : null,
        files: result.files ? result.files.length : null,
        branch: result.branch || `task/${taskId}`, status: st2?.status || null, summary: text,
      })
    } catch (e) { log('summary/notice failed: ' + (e && e.message ? e.message : String(e))) }

    try {
      await printReport({ repo: runRepo, taskId, dir: runDir, runs: null, summary, result, branch: result.branch || `task/${taskId}` })
    } catch (e) { log('report failed: ' + (e && e.message ? e.message : String(e))) }

    await releaseAll()
    return result.ok ? 0 : 1
  }

  let branchName = `task/${taskId}`
  if (!worktree) {
    const branch = await ensureTaskBranch(repo, taskId)
    branchName = branch.branch
    log(`branch: ${branchName}${branch.created ? ' (created)' : ''}`)
  }

  let st = readState(runDir)
  if (st && ['reviewed', 'pr_open', 'merged'].includes(st.status)) {
    log(`task ${taskId} is ${st.status}; nothing to do`)
    await releaseAll()
    return 0
  }

  st = st || setStatus('draft', 'init')

  const doCI = async (label) => {
    log(`\n[CI] ${label}`)
    const ci = await runCI({ repo: runRepo, taskDirRel, runnerPath, outPath: path.join(runDir, 'ci-results.json') })
    appendRun(runDir, {
      task: taskId, role: 'ci', round: 0, backend: 'local', provider: 'local',
      model_requested: '-', model_resolved: '-', effort: '-',
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_ms: 0, exit: { code: ci.exitCode }, commands: [], artifacts: [], git: null,
      ci: ciRecord(ci, taskDirRel, runRepo, runnerPath), usage: null, usage_source: 'none',
      log_ref: `${taskDirRel.replaceAll('\\', '/')}/ci-results.json`, error: ci.ok ? null : 'ci_failed',
    })
    log(ci.ok ? `CI PASS ${ci.summary?.passed}/${ci.summary?.total}` : `CI FAIL ${ci.summary?.passed ?? '?'}/${ci.summary?.total ?? '?'}`)
    return ci
  }

  const swept = sweepInterrupted(repo, { log })
  if (swept.length) log('recovery: ' + swept.map((x) => x.task + '(' + x.from + ')').join(', ') + ' 标记为中断')
  st = readState(runDir) || st

  if (st.status === 'blocked') {
    if (!args.resume) {
      const why = st.blocked_reason === REASON ? '上次运行被终止（可一键继续）' : (st.blocked_reason || 'unknown')
      log('task is blocked (' + why + '); rerun with --resume to continue')
      await releaseAll()
      return 2
    }
    const hist = st.history || []
    const last = [...hist].reverse().find((h) => h.to && h.to !== 'blocked')
    const back = last ? last.to : 'draft'
    log('resume: ' + st.status + ' -> ' + back)
    if (st.blocked_reason === REASON && !args.keep) {
      const discarded = await discardWorkingChanges(runRepo, log)
      if (discarded) log('recovery: 已丢弃中断时留下的未提交改动（--keep 可保留）')
    }
    st = setStatus(back, 'resume', { blocked_reason: null, interrupted: null })
  }


  const att0 = readAttention(runDir)
  if (att0) {
    const answers = pendingInputs(runDir, ['answer'])
    if (answers.length) {
      removeAttention(runDir)
      log('attention answer received -> design')
      if (st.status !== 'draft') st = setStatus('draft', 'input', { blocked_reason: null })
    } else {
      log(`等待人类回答：${att0.question || '(no question)'}`)
      if (Array.isArray(att0.options) && att0.options.length) log('options: ' + att0.options.join(' | '))
      return finish({ ok: false, reason: 'awaiting_human' })
    }
  }
  if (pendingInputs(runDir, ['amendment']).length && st.status !== 'draft') {
    log('amendment pending -> back to design')
    st = setStatus('draft', 'input', { blocked_reason: null })
  }

  if (st.status === 'draft') {
    const eff = effectiveRole(config, 'design', projectCfg)
    log('routing: design -> ' + eff.order.join(' > '))
    const r = await runRole({ config, repo: runRepo, taskId, role: 'design', round: 1, candidateOverride: eff.order, effortOverride: eff.effort, log })
    if (!r.ok) return finish({ ok: false, reason: r.state.blocked_reason })
    await commitAll(runRepo, `stage(design): task ${taskId}`)
    // write_scope 是并发排队和合并分档的依据：缺失时让 designer 补写一次，仍缺则停下
    if (scopeNow() === null) {
      log('[design] design.md 未声明 write_scope → 请 designer 补写')
      appendInput(runDir, { kind: 'note', by: 'agentline', text: WRITE_SCOPE_NOTE })
      const r2 = await runRole({ config, repo: runRepo, taskId, role: 'design', round: 2, candidateOverride: eff.order, effortOverride: eff.effort, log })
      if (!r2.ok) return finish({ ok: false, reason: r2.state.blocked_reason })
      await commitAll(runRepo, `stage(design): declare write_scope (task ${taskId})`)
      if (scopeNow() === null) return finish({ ok: false, reason: 'write_scope_missing' })
    }
    summary.push({ stage: 'design', model: r.model, ok: true })
    if (stopIfRequested('design')) return finish({ ok: false, reason: STOPPED })
    if (attentionBlock('design')) return finish({ ok: false, reason: 'awaiting_human' })
    if (midAmendment('design')) return finish({ ok: false, reason: 'amendment_pending' })
    st = readState(runDir)
  }

  // 进入 dev 前才申请执行槽：design 只写本任务 .collab，可以并行
  if (['designed', 'blocked'].includes(st.status)) {
    const slot = await ensureSlot('dev')
    if (!slot.ok) { await releaseAll(); return 3 }
    if (midAmendment('before dev')) return finish({ ok: false, reason: 'amendment_pending' })
  }

  if (st.status === 'designed') {
    const eff = effectiveRole(config, 'dev', projectCfg)
    log('routing: dev -> ' + eff.order.join(' > '))
    const r = await runRole({ config, repo: runRepo, taskId, role: 'dev', round: 1, candidateOverride: eff.order, effortOverride: eff.effort, log })
    if (!r.ok) return finish({ ok: false, reason: r.state.blocked_reason })
    await commitAll(runRepo, `stage(dev): task ${taskId}`)
    summary.push({ stage: 'dev', model: r.model, ok: true })
    if (stopIfRequested('dev')) return finish({ ok: false, reason: STOPPED })
    if (midAmendment('dev')) return finish({ ok: false, reason: 'amendment_pending' })
    st = readState(runDir)
  }

  // 恢复在 implemented/reviewable 的任务也要占槽
  if (['implemented', 'reviewable'].includes(st.status)) {
    const slot = await ensureSlot(st.status === 'implemented' ? 'dev' : 'review')
    if (!slot.ok) { await releaseAll(); return 3 }
  }

  let ci = await doCI('after dev')
  if (!ci.ok) {
    log('[CI] failing → one repair attempt')
    const eff = effectiveRole(config, 'dev', projectCfg)
    const r = await runRole({ config, repo: runRepo, taskId, role: 'dev', round: 1, candidateOverride: eff.order, effortOverride: eff.effort, log })
    if (!r.ok) return finish({ ok: false, reason: r.state.blocked_reason })
    await commitAll(runRepo, `fix(dev): repair after CI failure (task ${taskId})`)
    ci = await doCI('after repair')
    if (!ci.ok) return finish({ ok: false, reason: 'ci_failed' })
  }
  setStatus('reviewable', 'ci')
  if (stopIfRequested('CI')) return finish({ ok: false, reason: STOPPED })
  if (midAmendment('CI')) return finish({ ok: false, reason: 'amendment_pending' })

  let verdict = null
  for (let round = 1; round <= maxRounds; round++) {
    const devModelId = readState(runDir)?.model
    const revEff = effectiveRole(config, 'review', projectCfg)
    const allowed = revEff.order.filter((k) => config.models[k] && config.models[k].id !== devModelId)
    const reviewModel = allowed[0]
    if (!reviewModel) return finish({ ok: false, reason: 'no_candidate' })
    log(`[review r${round}] dev used ${devModelId} → review model ${reviewModel}`)

    const rv = await runRole({ config, repo: runRepo, taskId, role: 'review', round, modelOverride: reviewModel, effortOverride: revEff.effort, log })
    if (!rv.ok) return finish({ ok: false, reason: rv.state.blocked_reason })
    verdict = readVerdict(runDir, round)
    summary.push({ stage: `review-r${round}`, model: rv.model, ok: verdict?.verdict === 'pass', verdict: verdict?.verdict })

    if (verdict?.verdict === 'pass') {
      await commitAll(runRepo, `stage(review-r${round}): pass (task ${taskId})`)
      setStatus('reviewed', 'review')
      if (midAmendment('review')) return finish({ ok: false, reason: 'amendment_pending' })
      break
    }

    log(`[review r${round}] needs_revision → repair`)
    await commitAll(runRepo, `stage(review-r${round}): needs_revision (task ${taskId})`)
    const eff = effectiveRole(config, 'dev', projectCfg)
    const fx = await runRole({ config, repo: runRepo, taskId, role: 'dev', round: round + 1, candidateOverride: eff.order, effortOverride: eff.effort, log })
    if (!fx.ok) return finish({ ok: false, reason: fx.state.blocked_reason })
    await commitAll(runRepo, `fix(dev-r${round + 1}): address review findings (task ${taskId})`)
    ci = await doCI(`after repair r${round}`)
    if (!ci.ok) return finish({ ok: false, reason: 'ci_failed' })
    setStatus('reviewable', 'ci')
    if (stopIfRequested('review-repair CI')) return finish({ ok: false, reason: STOPPED })
    if (midAmendment('review-repair')) return finish({ ok: false, reason: 'amendment_pending' })
  }

  if (verdict?.verdict !== 'pass') return finish({ ok: false, reason: 'review_exhausted' })
  if (midAmendment('pr_open')) return finish({ ok: false, reason: 'amendment_pending' })

  const files = await changedFiles(runRepo, 'main')
  let mergeRisk = null
  try {
    mergeRisk = await evaluateMerge({ repo: runRepo, taskDir: runDir, taskId, head: 'HEAD', config, projectCfg })
    log(`[merge] ${describeTier(mergeRisk)}`)
  } catch (e) { log(`[merge] 分档失败，按需逐个确认处理：${e.message}`) }
  setStatus('pr_open', 'agentline', {
    pr: { branch: branchName, state: 'open', files, sha: await headSha(runRepo) },
    merge_gate: { requires_human_permission: true, on_no_permission: 'stay_in_pr' },
    merge_risk: mergeRisk,
  })
  await commitAll(runRepo, `chore(${taskId}): pr_open state`)
  return finish({ ok: true, branch: branchName, files })
}



