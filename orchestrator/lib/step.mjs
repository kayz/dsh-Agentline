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
import { effectiveRole } from './routing.mjs'
import { commitAll, changedFiles, headSha } from './git.mjs'
import { evaluateMerge } from './merge-policy.mjs'

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
export async function runStep({
  config, repo, taskId, step, runnerPath, adapterFactory, log = console.log, projectCfg = {},
}) {
  const taskDir = path.join(repo, config.collabDir, String(taskId))
  if (!fs.existsSync(taskDir)) return fail('task_dir_missing')
  let st = readState(taskDir)
  if (!st) st = setStatus(taskDir, taskId, 'draft', 'step:init')

  if (st.status === 'pr_open' || st.status === 'merged') {
    return { ok: true, step: 'done', status: st.status, next: 'done' }
  }
  if (st.status === 'blocked' && !step) return fail(st.blocked_reason || 'blocked')

  const chosen = step || nextStep(st)
  const runRole = (opts) => executeRole({ ...opts, adapterFactory, log })

  if (chosen === 'design') {
    if (st.status !== 'draft') return fail('expected draft')
    const eff = effectiveRole(config, 'design', projectCfg)
    const r = await runRole({ config, repo, taskId, role: 'design', round: 1, candidateOverride: eff.order, effortOverride: eff.effort })
    if (!r.ok) return fail(r.state.blocked_reason)
    await commitAll(repo, `stage(design): task ${taskId}`)
    const next = setStatus(taskDir, taskId, 'designed', 'step:design')
    return { ok: true, step: chosen, status: next.status, next: nextStep(next), model: r.model }
  }

  if (chosen === 'dev') {
    if (st.status !== 'designed') return fail('expected designed')
    const eff = effectiveRole(config, 'dev', projectCfg)
    const r = await runRole({ config, repo, taskId, role: 'dev', round: 1, candidateOverride: eff.order, effortOverride: eff.effort })
    if (!r.ok) return fail(r.state.blocked_reason)
    await commitAll(repo, `stage(dev): task ${taskId}`)
    const next = setStatus(taskDir, taskId, 'implemented', 'step:dev')
    return { ok: true, step: chosen, status: next.status, next: nextStep(next), model: r.model }
  }

  if (chosen === 'ci') {
    if (st.status !== 'implemented') return fail('expected implemented')
    if (!runnerPath || !fs.existsSync(runnerPath)) return fail('ci_runner_missing')
    const ci = await runCI({ repo, taskDirRel: path.join(config.collabDir, String(taskId)), runnerPath, outPath: path.join(taskDir, 'ci-results.json') })
    if (!ci.ok) {
      const next = setStatus(taskDir, taskId, 'blocked', 'step:ci', { blocked_reason: 'ci_failed' })
      return { ok: false, step: chosen, status: next.status, next: 'blocked', reason: 'ci_failed' }
    }
    const next = setStatus(taskDir, taskId, 'reviewable', 'step:ci')
    return { ok: true, step: chosen, status: next.status, next: nextStep(next) }
  }

  if (chosen === 'review') {
    if (st.status !== 'reviewable') return fail('expected reviewable')
    const devModelId = st.model
    const revEff = effectiveRole(config, 'review', projectCfg)
    const reviewModel = revEff.order.find((k) => config.models[k] && config.models[k].id !== devModelId)
    if (!reviewModel) return fail('no_candidate')
    const round = Number(st.review_round || 1)
    const r = await runRole({ config, repo, taskId, role: 'review', round, modelOverride: reviewModel, effortOverride: revEff.effort })
    if (!r.ok) return fail(r.state.blocked_reason)
    const verdict = readVerdict(taskDir, round)
    await commitAll(repo, `stage(review-r${round}): ${verdict?.verdict || 'unknown'} (task ${taskId})`)
    if (verdict?.verdict === 'pass') {
      const next = setStatus(taskDir, taskId, 'reviewed', 'step:review', { review_round: round })
      return { ok: true, step: chosen, status: next.status, next: nextStep(next), model: r.model, verdict: 'pass' }
    }
    const next = setStatus(taskDir, taskId, 'reviewable', 'step:review', {
      review_round: round + 1,
      review_feedback: verdict?.verdict || 'needs_revision',
    })
    return { ok: true, step: chosen, status: next.status, next: nextStep(next), model: r.model, verdict: verdict?.verdict || 'needs_revision' }
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
    return { ok: true, step: chosen, status: next.status, next: 'done', verdict: 'pass' }
  }

  return fail(`unknown step: ${chosen}`)
}

export default runStep

/**
 * Minimal Supervisor loop for one task. It intentionally does not create a
 * worktree or acquire the task lock yet; those stay in the caller until the
 * full P4 integration. Each iteration executes exactly one step.
 */
export async function runBuild({
  config, repo, taskId, runnerPath, adapterFactory, log = console.log, projectCfg = {}, maxSteps = 10,
}) {
  const completed = []
  for (let i = 0; i < maxSteps; i++) {
    const taskDir = path.join(repo, config.collabDir, String(taskId))
    const st = readState(taskDir)
    const step = nextStep(st)
    if (step === 'done' || step === 'resume') {
      return { ok: step === 'done', status: st?.status || 'missing', next: step, steps: completed }
    }
    const r = await runStep({ config, repo, taskId, step, runnerPath, adapterFactory, log, projectCfg })
    completed.push(r)
    if (!r.ok) return { ok: false, status: r.status, next: r.next, reason: r.reason, steps: completed }
  }
  const st = readState(path.join(repo, config.collabDir, String(taskId)))
  return { ok: false, status: st?.status || 'unknown', next: nextStep(st), reason: 'step_budget_exceeded', steps: completed }
}

