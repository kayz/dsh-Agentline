/**
 * pipeline.mjs — read-only pipeline summary.
 *
 * This is the first control-plane read surface: it derives the current
 * Studio / Blueprint / Build state from disk and never writes anything.
 * The plugin uses this instead of walking `.collab` itself.
 */
import fs from 'node:fs'
import path from 'node:path'

const STATUS = new Set([
  'draft', 'designed', 'implemented', 'reviewable', 'reviewed',
  'pr_open', 'merged', 'blocked', 'halted',
])

const RUNNING = new Set(['draft', 'designed', 'implemented', 'reviewable', 'reviewed'])
const WAITING = new Set(['awaiting_user'])

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { return [] }
}

function taskRecord(repo, id) {
  const dir = path.join(repo, '.collab', 'tasks', id)
  const st = readJson(path.join(dir, 'state.json')) || {}
  const status = STATUS.has(st.status) ? st.status : (st.status || 'unknown')
  const stage = status === 'pr_open' || status === 'merged' ? 'build' : 'build'
  return {
    id: String(id),
    stage,
    status,
    role: st.role || null,
    model: st.model || null,
    blocked_reason: st.blocked_reason || null,
    updated_at: st.updated_at || null,
    pr: st.pr ? { branch: st.pr.branch || null, sha: st.pr.sha || null } : null,
    source: st.origin?.kind || st.origin?.blueprint ? 'blueprint' : (st.adhoc ? 'adhoc' : 'unknown'),
  }
}

function stageState(repo, kind, stateFile) {
  const root = path.join(repo, '.collab', kind)
  const ids = listDirs(root)
  const sessions = []
  for (const id of ids) {
    const st = readJson(path.join(root, id, stateFile))
    if (st) sessions.push({ id, status: st.status || 'unknown', updated_at: st.updated_at || null })
  }
  if (!sessions.length) return { status: 'not_started', sessions: [] }
  const active = sessions.find((s) => ['draft', 'running', 'reviewing', 'awaiting_user', 'blocked'].includes(s.status))
  return { status: active ? active.status : 'idle', sessions }
}

export function readPipelineSummary(repo) {
  const abs = path.resolve(repo)
  const tasksDir = path.join(abs, '.collab', 'tasks')
  const tasks = listDirs(tasksDir).filter((id) => /^\d+$/.test(id)).sort().map((id) => taskRecord(abs, id))
  const counts = {
    total: tasks.length,
    running: tasks.filter((t) => RUNNING.has(t.status)).length,
    waiting: tasks.filter((t) => WAITING.has(t.status)).length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    pr_open: tasks.filter((t) => t.status === 'pr_open').length,
    merged: tasks.filter((t) => t.status === 'merged').length,
  }
  return {
    schema: 'agentline.pipeline/v1',
    generated_at: new Date().toISOString(),
    repo: abs,
    project: path.basename(abs),
    stages: {
      studio: stageState(abs, 'studio', 'session.json'),
      blueprint: stageState(abs, 'blueprint', 'state.json'),
      build: { status: counts.blocked ? 'blocked' : (counts.running ? 'running' : (counts.merged === counts.total && counts.total > 0 ? 'done' : 'idle')), counts },
    },
    tasks,
  }
}

export function formatPipelineSummary(summary) {
  const c = summary.stages.build.counts
  const lines = [
    `项目：${summary.project}`,
    `Studio：${summary.stages.studio.status}   Blueprint：${summary.stages.blueprint.status}   Build：${summary.stages.build.status}`,
    `任务：${c.total}  running=${c.running}  waiting=${c.waiting}  blocked=${c.blocked}  pr_open=${c.pr_open}  merged=${c.merged}`,
  ]
  for (const t of summary.tasks) {
    const bits = [`#${t.id}`, t.status]
    if (t.role) bits.push(t.role)
    if (t.model) bits.push(t.model)
    if (t.blocked_reason) bits.push(`blocked=${t.blocked_reason}`)
    lines.push(`  ${bits.join(' · ')}`)
  }
  return lines.join('\n')
}

export default readPipelineSummary
