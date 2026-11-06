/**
 * step.mjs — K1 single-step executor seed.
 *
 * The Supervisor owns the loop and task/worktree locking. This module executes
 * exactly one step against an already-located task directory and returns the
 * next step. It deliberately does not auto-run a second step.
 */
import fs from 'node:fs'
import path from 'node:path'
import { executeRole, readVerdict } from './exec.mjs'
import { readState, writeState } from './state.mjs'
import { runCI } from './ci.mjs'
import { commitAll, changedFiles, headSha } from './git.mjs'
import { evaluateMerge } from './merge-policy.mjs'
import { ensureTaskWorktree } from './worktree.mjs'
import { acquireTaskLock, releaseTaskLock, acquireCapacity, releaseCapacity } from './registry.mjs'
import { readWriteScope } from './scope.mjs'
import { proveTermination } from './contracts/termination.mjs'
import { getAdapter } from './adapters/index.mjs'
import { configForStage, inspectOrigin, isInfraResult, recordStepStats, resolveStageRole } from './build.mjs'

export const STEP_ORDER = ['design', 'dev', 'ci', 'review', 'pr']

export function nextStep(state) {
  const status = state && state.status
  if (!status || status === 'draft') return 'design'
  if (status === 'designed') return 'dev'
  if (status === 'implemented') return 'ci'
  if (status === 'reviewable') return 'review'
  if (status === 'reviewed') return 'pr'
  if (status === 'blocked') return 'resume'
  return 'done'
}

function setStatus(taskDir, taskId, status, by, extra = {}) {
  const st = readState(taskDir) || { id: taskId, history: [] }
  const next = {
    ...st, ...extra, status, updated_at: new Date().toISOString(),
    history: [...(st.history || []), { at: new Date().toISOString(), from: st.status, to: status, by }],
  }
  writeState(taskDir, next)
  return next
}

function fail(reason) {
  return { ok: false, reason, status: 'blocked', next: 'blocked' }
}

/**
 * @param {object} o
 * @param {object} o.config
 * @param {string} o.repo
 * @param {string} o.taskId
 * @param {string} [o.step] design|dev|ci|review|pr
 * @param {string} o.runnerPath CI runner
 * @param {function} [o.adapterFactory]
 * @param {function} [o.log]
 * @param {object} [o.projectCfg]
 * @returns {Promise<{ok:boolean, step:string, status:string, next:string, model?:string, verdict?:string, reason?:string}>}
 */
function identityGroup(config, modelId) {
  const model = Object.values((config && config.models) || {}).find((item) => item && item.id === modelId)
  if (!model) return null
  if (typeof model.identity_group === 'string' && model.identity_group.trim()) return model.identity_group.trim()
  const provider = config.providers && config.providers[model.provider]
  const vendor = (provider && provider.source) || model.provider || ''
  return vendor && model.id ? `${vendor}/${model.id}` : null
}

function wrapFactory(adapterFactory, { lock, onCall }) {
  const base = typeof adapterFactory === 'function' ? adapterFactory : (provider) => getAdapter(provider)
  return (provider) => {
    const adapter = base(provider)
    if (!adapter || typeof adapter.run !== 'function') return adapter
    return {
      ...adapter,
      async run(opts) {
        if (lock && !lock.ids.includes(opts.model)) {
          const denied = { exitCode: 1, error: 'role_lock', modelResolved: null }
          onCall(opts, denied, true)
          return denied
        }
        const result = await adapter.run(opts)
        onCall(opts, result, false)
        if (result && result.side_effects === 'unknown') {
          return {
            ...result,
            exitCode: result.exitCode === 0 ? 1 : result.exitCode,
            error: result.error || 'side_effects_unknown',
            modelResolved: result.modelResolved ?? null,
          }
        }
        if (lock && result && result.exitCode === 0 && !result.error) {
          const resolved = typeof result.modelResolved === 'string' ? result.modelResolved.trim() : ''
          if (!resolved) return { ...result, exitCode: 1, error: 'model_unverified', modelResolved: null }
          if (resolved !== opts.model) return { ...result, exitCode: 1, error: 'model_mismatch', modelResolved: resolved }
        }
        return result
      },
    }
  }
}

export async function runStep({
  config, repo, taskId, step, runnerPath, adapterFactory, log = console.log, projectCfg = {},
}) {
  const taskDir = path.join(repo, config.collabDir, String(taskId))
  if (!fs.existsSync(taskDir)) return fail('task_dir_missing')
  const origin = inspectOrigin(repo, taskDir)
  if (!origin.ok) {
    const current = readState(taskDir)
    return {
      ok: false, reason: origin.reason, detail: origin.detail, step: step || null,
      status: current && current.status ? current.status : null, next: 'blocked',
    }
  }
  let st = readState(taskDir)
  if (st && st.side_effects === 'unknown') {
    return { ok: false, reason: 'side_effects_unknown', step: step || null, status: st.status || 'blocked', next: 'blocked' }
  }
  if (st && (st.status === 'pr_open' || st.status === 'merged')) {
    return { ok: true, step: 'done', status: st.status, next: 'done' }
  }
  if (st && st.status === 'blocked' && !step) return fail(st.blocked_reason || 'blocked')
  const chosen = step || nextStep(st || { status: 'draft' })
  const calls = []
  const note = (stage, modelId) => (opts, result, denied) => {
    calls.push({
      role: stage,
      model_requested: opts && opts.model,
      model_resolved: result && typeof result.modelResolved === 'string' && result.modelResolved.trim() ? result.modelResolved.trim() : null,
      identity_group: identityGroup(config, (result && result.modelResolved) || (opts && opts.model)),
      infra: !denied && isInfraResult(result),
      side_effects: result && result.side_effects || null,
      denied: !!denied,
      error: result && result.error || null,
      exit: result && result.exitCode,
    })
    appendStepEvent(taskDir, {
      event: 'call', role: stage, denied: !!denied,
      model_requested: opts && opts.model,
      model_resolved: result && typeof result.modelResolved === 'string' && result.modelResolved.trim() ? result.modelResolved.trim() : null,
      identity_group: identityGroup(config, (result && result.modelResolved) || null),
      infra: !denied && isInfraResult(result),
      side_effects: result && result.side_effects || null,
      error: result && result.error || null,
      exit: result && result.exitCode,
    })
  }
  const prepare = (stage) => {
    const resolved = resolveStageRole(config, projectCfg, stage, taskDir)
    if (!resolved.ok) return { ok: false, resolved }
    return {
      ok: true,
      resolved,
      runConfig: configForStage(config, stage, resolved),
      factory: wrapFactory(adapterFactory, { lock: resolved.lock, onCall: note(stage) }),
    }
  }
  if (chosen === 'design' || chosen === 'dev' || chosen === 'review') {
    const ready = prepare(chosen)
    if (!ready.ok) {
      return {
        ok: false, reason: ready.resolved.reason, detail: ready.resolved.detail, step: chosen,
        status: st && st.status ? st.status : null, next: 'blocked',
      }
    }
  }
  if (!st) st = setStatus(taskDir, taskId, 'draft', 'step:init')

  const finish = (stage, result) => {
    recordStepStats(taskDir, stage, calls, result)
    return result
  }

  if (chosen === 'design') {
    if (st.status !== 'draft') return fail('expected draft')
    const ready = prepare('design')
    const r = await executeRole({
      config: ready.runConfig, repo, taskId, role: 'design', round: 1,
      candidateOverride: ready.resolved.order, effortOverride: ready.resolved.effort,
      adapterFactory: ready.factory, log, observeIdentity: !!ready.resolved.lock,
    })
    if (!r.ok) return finish(chosen, fail(r.state.blocked_reason))
    await commitAll(repo, `stage(design): task ${taskId}`)
    const next = setStatus(taskDir, taskId, 'designed', 'step:design')
    return finish(chosen, { ok: true, step: chosen, status: next.status, next: nextStep(next), model: r.model, record: r.record })
  }

  if (chosen === 'dev') {
    if (st.status !== 'designed') return fail('expected designed')
    const ready = prepare('dev')
    const r = await executeRole({
      config: ready.runConfig, repo, taskId, role: 'dev', round: 1,
      candidateOverride: ready.resolved.order, effortOverride: ready.resolved.effort,
      adapterFactory: ready.factory, log, observeIdentity: !!ready.resolved.lock,
    })
    if (!r.ok) return finish(chosen, fail(r.state.blocked_reason))
    await commitAll(repo, `stage(dev): task ${taskId}`)
    const next = setStatus(taskDir, taskId, 'implemented', 'step:dev')
    return finish(chosen, { ok: true, step: chosen, status: next.status, next: nextStep(next), model: r.model, record: r.record })
  }

  if (chosen === 'ci') {
    if (st.status !== 'implemented') return fail('expected implemented')
    if (!runnerPath || !fs.existsSync(runnerPath)) return fail('ci_runner_missing')
    const ci = await runCI({ repo, taskDirRel: path.join(config.collabDir, String(taskId)), runnerPath, outPath: path.join(taskDir, 'ci-results.json') })
    if (!ci.ok) {
      const next = setStatus(taskDir, taskId, 'blocked', 'step:ci', { blocked_reason: 'ci_failed' })
      return finish(chosen, { ok: false, step: chosen, status: next.status, next: 'blocked', reason: 'ci_failed' })
    }
    const next = setStatus(taskDir, taskId, 'reviewable', 'step:ci')
    return finish(chosen, { ok: true, step: chosen, status: next.status, next: nextStep(next) })
  }

  if (chosen === 'review') {
    if (st.status !== 'reviewable') return fail('expected reviewable')
    const ready = prepare('review')
    const devModelId = st.model
    const order = ready.resolved.order.filter((k) => config.models[k] && config.models[k].id !== devModelId)
    if (!order.length) return fail('no_candidate')
    const round = Number(st.review_round || 1)
    const r = await executeRole({
      config: ready.runConfig, repo, taskId, role: 'review', round,
      candidateOverride: order, effortOverride: ready.resolved.effort,
      adapterFactory: ready.factory, log, observeIdentity: !!ready.resolved.lock,
    })
    if (!r.ok) return finish(chosen, fail(r.state.blocked_reason))
    const verdict = readVerdict(taskDir, round)
    await commitAll(repo, `stage(review-r${round}): ${verdict?.verdict || 'unknown'} (task ${taskId})`)
    if (verdict?.verdict === 'pass') {
      const next = setStatus(taskDir, taskId, 'reviewed', 'step:review', { review_round: round })
      return finish(chosen, { ok: true, step: chosen, status: next.status, next: nextStep(next), model: r.model, verdict: 'pass', record: r.record })
    }
    const next = setStatus(taskDir, taskId, 'reviewable', 'step:review', {
      review_round: round + 1,
      review_feedback: verdict?.verdict || 'needs_revision',
    })
    return finish(chosen, { ok: true, step: chosen, status: next.status, next: nextStep(next), model: r.model, verdict: verdict?.verdict || 'needs_revision', record: r.record })
  }

  if (chosen === 'pr') {
    if (st.status !== 'reviewed') return fail('expected reviewed')
    const files = await changedFiles(repo, 'main')
    let mergeRisk = null
    try { mergeRisk = await evaluateMerge({ repo, taskDir, taskId, head: 'HEAD', config, projectCfg }) } catch { /* keep null */ }
    const next = setStatus(taskDir, taskId, 'pr_open', 'step:pr', {
      pr: { branch: `task/${taskId}`, state: 'open', files, sha: await headSha(repo) },
      merge_gate: { requires_human_permission: true, on_no_permission: 'stay_in_pr' },
      merge_risk: mergeRisk,
    })
    await commitAll(repo, `chore(${taskId}): pr_open state`)
    return finish(chosen, { ok: true, step: chosen, status: next.status, next: 'done', verdict: 'pass' })
  }

  return fail(`unknown step: ${chosen}`)
}

export default runStep

function ledgerPath(taskDir) { return path.join(taskDir, 'step-ledger.jsonl') }

export function appendStepEvent(taskDir, event) {
  try {
    fs.mkdirSync(taskDir, { recursive: true })
    fs.appendFileSync(ledgerPath(taskDir), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', 'utf8')
  } catch { /* evidence is best-effort in P4.2 */ }
}

function copyTaskIntoWorktree(mainRepo, worktreeRepo, collabDir, taskId) {
  const src = path.join(mainRepo, collabDir, String(taskId))
  const dst = path.join(worktreeRepo, collabDir, String(taskId))
  if (!fs.existsSync(src) || fs.existsSync(path.join(dst, 'state.json'))) return
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.cpSync(src, dst, { recursive: true, force: true })
}

function terminationProofFor(runDir) {
  let live = null
  try { live = JSON.parse(fs.readFileSync(path.join(runDir, 'live.json'), 'utf8')) } catch { /* no live */ }
  if (!live || !live.pid) return { status: 'unknown', pid: null, reason: 'no_live_record' }
  return proveTermination({ pid: Number(live.pid), guard: live.guard || null })
}

/**
 * Minimal Supervisor loop for one task.
 *
 * P4.2: creates/reuses a worktree, takes the task lock, acquires an execution
 * slot before dev/review, and writes a step ledger. P4.3: a blocked task is
 * only resumed when the process-tree termination proof succeeds; otherwise it
 * stays blocked/unknown.
 */
export async function runBuild({
  config, repo, taskId, runnerPath, adapterFactory, log = console.log, projectCfg = {},
  maxSteps = 10, args = {},
}) {
  const completed = []
  const wtCfg = config.worktree || {}
  let runRepo = repo
  let runDir = path.join(repo, config.collabDir, String(taskId))
  let taskLock = null
  let capacity = false
  let worktree = null

  const useWorktree = wtCfg.enabled !== false && !args.inPlace
  try {
    if (useWorktree) {
      taskLock = await acquireTaskLock(repo, taskId)
      if (!taskLock.ok) return { ok: false, status: 'blocked', next: 'blocked', reason: 'task_locked', steps: [] }
      worktree = await ensureTaskWorktree(repo, taskId, {
        baseRef: args.base || wtCfg.baseRef || 'main', dirRel: wtCfg.dir || '.collab/worktrees',
      })
      runRepo = worktree.path
      copyTaskIntoWorktree(repo, runRepo, config.collabDir, taskId)
      runDir = path.join(runRepo, config.collabDir, String(taskId))
    }

    for (let i = 0; i < maxSteps; i++) {
      const st = readState(runDir)
      if (st?.side_effects === 'unknown') {
        appendStepEvent(runDir, { event: 'resume.refused', task: taskId, reason: 'side_effects_unknown' })
        return { ok: false, status: st.status || 'blocked', next: 'blocked', reason: 'side_effects_unknown', steps: completed, repo: runRepo }
      }
      const step = nextStep(st)
      if (step === 'done') {
        return { ok: true, status: st?.status || 'done', next: 'done', steps: completed, repo: runRepo }
      }
      if (step === 'resume') {
        if (st?.side_effects === 'unknown') {
          appendStepEvent(runDir, { event: 'resume.refused', task: taskId, reason: 'side_effects_unknown' })
          return { ok: false, status: 'blocked', next: 'resume', reason: 'side_effects_unknown', steps: completed, repo: runRepo }
        }
        if (st?.blocked_reason !== 'interrupted') {
          return { ok: false, status: 'blocked', next: 'resume', reason: st?.blocked_reason || 'blocked', steps: completed, repo: runRepo }
        }
        const proof = terminationProofFor(runDir)
        if (proof.status !== 'proven_dead') {
          appendStepEvent(runDir, { event: 'resume.refused', task: taskId, proof: proof.status, reason: proof.reason })
          return { ok: false, status: 'blocked', next: 'resume', reason: `termination_${proof.status}`, proof, steps: completed, repo: runRepo }
        }
        const back = (st.interrupted && st.interrupted.from) || 'designed'
        writeState(runDir, {
          ...st, status: back, blocked_reason: null, interrupted: null,
          updated_at: new Date().toISOString(),
          history: [...(st.history || []), { at: new Date().toISOString(), from: 'blocked', to: back, by: 'step:resume' }],
        })
        appendStepEvent(runDir, { event: 'resume.accepted', task: taskId, to: back, proof: proof.reason })
        continue
      }

      if (step !== 'design' && !capacity) {
        const scope = readWriteScope(path.join(runDir, 'design.md')) || ['**']
        const cap = await acquireCapacity({
          repo: runRepo, taskId, scope, worktree: runRepo, phase: step,
          wait: !args['no-wait'] && config.concurrency?.wait !== false,
          priority: Boolean(args.priority),
          maxTasks: Number(args['max-tasks'] || config.concurrency?.maxTasks || 3),
          pollMs: Math.max(1, Number(config.concurrency?.pollSeconds || 5)) * 1000,
          log,
        })
        if (!cap.ok) return { ok: false, status: 'blocked', next: step, reason: 'capacity_wait', steps: completed, repo: runRepo }
        capacity = true
      }

      appendStepEvent(runDir, { event: 'step.begin', task: taskId, step, status: st?.status || null })
      const r = await runStep({
        config, repo: runRepo, taskId, step, runnerPath, adapterFactory, log, projectCfg,
      })
      appendStepEvent(runDir, {
        event: 'step.end', task: taskId, step, ok: r.ok, status: r.status,
        next: r.next, reason: r.reason || null,
        model: r.model || null, run_ref: (r.record && r.record.log_ref) || null,
      })
      completed.push(r)
      if (!r.ok) return { ok: false, status: r.status, next: r.next, reason: r.reason, detail: r.detail || null, steps: completed, repo: runRepo }
    }
    const st = readState(runDir)
    return { ok: false, status: st?.status || 'unknown', next: nextStep(st), reason: 'step_budget_exceeded', steps: completed, repo: runRepo }
  } finally {
    if (capacity) await releaseCapacity(repo, taskId).catch(() => {})
    if (taskLock && taskLock.ok) await releaseTaskLock(repo, taskId).catch(() => {})
  }
}


