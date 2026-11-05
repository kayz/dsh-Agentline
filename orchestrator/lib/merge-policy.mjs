/**
 * merge-policy.mjs — 合并分档与预授权
 *
 * 两档：
 *   low      可以用预授权（grant）合并
 *   confirm  必须逐个任务给出 --permission
 *
 * 低档要同时满足（阈值见 DEFAULT_MERGE_POLICY，可在 config.policy.merge 或 .collab/agentline.json 的 merge 覆盖）：
 *   - 评审轮次 ≤ maxReviewRounds（history 里 review:* 写入 reviewed 的次数，跨 --resume 累计）
 *   - design.md 声明了 write_scope，且所有改动都落在其中（write_scope: [] 表示不改产品代码）
 *   - 改动的文件数 ≤ maxFiles，增删行数 ≤ maxLines
 * 任务自己的 .collab/tasks/<id>/ 目录不计入。
 *
 * 预授权存放在 <repo>/.git/agentline/grants.json（worktree 共用，不进版本库）：
 *   [{ id, tasks: ['016', …], text, created_at, expires_at, revoked_at }]
 * 它把用户的口头授权变成有范围、有时限、可审计的记录。CLI 无法验证调用者是不是人，
 * 所以它防的是“临场批量放行”，不是恶意伪造。
 */
import fs from 'node:fs'
import path from 'node:path'
import { commonGitDir, diffNumstat } from './git.mjs'
import { deepMerge } from './config.mjs'
import { readWriteScope } from './scope.mjs'

export const DEFAULT_MERGE_POLICY = {
  low: { maxReviewRounds: 3, maxFiles: 8, maxLines: 3000 },
}

export function mergePolicy(config, projectCfg) {
  return deepMerge(deepMerge(DEFAULT_MERGE_POLICY, config?.policy?.merge || {}), projectCfg?.merge || {})
}

// ── write_scope 匹配 ─────────────────────────────────────────────────────

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').trim()

export function globToRegExp(glob) {
  const g = norm(glob)
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** 没有通配符的条目按“文件本身或其下的目录”匹配 */
export function inScope(file, scopes) {
  const f = norm(file)
  return (scopes || []).some((s) => {
    const p = norm(s)
    if (!/[*?]/.test(p)) {
      const dirPrefix = p.replace(/\/$/, '')
      return f === dirPrefix || f.startsWith(dirPrefix + '/')
    }
    return globToRegExp(p).test(f)
  })
}

// ── 分档 ─────────────────────────────────────────────────────────────────

export function reviewRounds(state) {
  return (state?.history || []).filter((h) => h.to === 'reviewed' && String(h.by || '').startsWith('review:')).length
}

/**
 * 纯函数：根据状态、write_scope 和 numstat 给出档位。
 * @returns {{ tier: 'low'|'confirm', reasons: string[], metrics: object }}
 */
export function assessMerge({ state, writeScope, numstat, policy, taskId, collabDir = '.collab/tasks' }) {
  const low = { ...DEFAULT_MERGE_POLICY.low, ...(policy?.low || {}) }
  const own = `${norm(collabDir).replace(/\/$/, '')}/${taskId}/`
  const changes = (numstat || []).filter((c) => !norm(c.file).startsWith(own))
  const files = changes.length
  const lines = changes.reduce((n, c) => n + (c.added || 0) + (c.deleted || 0), 0)
  const rounds = reviewRounds(state)
  const outOfScope = Array.isArray(writeScope) ? changes.map((c) => norm(c.file)).filter((f) => !inScope(f, writeScope)) : []

  const reasons = []
  if (rounds > low.maxReviewRounds) reasons.push(`评审 ${rounds} 轮，超过 ${low.maxReviewRounds} 轮`)
  if (!Array.isArray(writeScope)) reasons.push('design.md 未声明 write_scope')
  else if (outOfScope.length) reasons.push(`${outOfScope.length} 个文件在 write_scope 之外：${outOfScope.slice(0, 3).join(', ')}${outOfScope.length > 3 ? ' …' : ''}`)
  if (files > low.maxFiles) reasons.push(`改动 ${files} 个文件，超过 ${low.maxFiles} 个`)
  if (lines > low.maxLines) reasons.push(`增删 ${lines} 行，超过 ${low.maxLines} 行`)

  return {
    tier: reasons.length ? 'confirm' : 'low',
    reasons,
    metrics: { files, lines, review_rounds: rounds, out_of_scope: outOfScope.length, write_scope: Array.isArray(writeScope) ? writeScope.length : 0 },
    limits: low,
  }
}

/** 从仓库读取实际数据再分档。head 为任务分支（主仓库里）或 HEAD（worktree 里）。 */
export async function evaluateMerge({ repo, taskDir, taskId, head, base = 'main', config, projectCfg, state }) {
  const st = state || JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'))
  const numstat = await diffNumstat(repo, base, head)
  const writeScope = readWriteScope(path.join(taskDir, 'design.md'))
  const result = assessMerge({
    state: st, writeScope, numstat, policy: mergePolicy(config, projectCfg), taskId, collabDir: config?.collabDir,
  })
  return { ...result, assessed_at: new Date().toISOString(), base, head }
}

export function describeTier(risk) {
  if (!risk) return '未评估'
  return risk.tier === 'low' ? '低档：可以用预授权合并' : `需逐个确认：${risk.reasons.join('；')}`
}

// ── 预授权 ───────────────────────────────────────────────────────────────

async function grantsPath(repo) {
  return path.join(await commonGitDir(repo), 'agentline', 'grants.json')
}

function readGrantsFile(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : [] } catch { return [] }
}

function writeGrantsFile(file, grants) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(grants, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** "016-023" / "016,018,020-021" → ['016', …]；补零宽度跟随区间起点 */
export function parseTaskRange(spec) {
  const out = []
  for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/)
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])]
      if (b < a) throw new Error(`任务区间倒序：${part}`)
      if (b - a > 500) throw new Error(`任务区间过大：${part}`)
      for (let n = a; n <= b; n++) out.push(String(n).padStart(m[1].length, '0'))
    } else if (/^[\w.-]+$/.test(part)) out.push(part)
    else throw new Error(`无法解析任务编号：${part}`)
  }
  if (!out.length) throw new Error('缺少任务编号（--tasks 016-023）')
  return [...new Set(out)]
}

export function isGrantActive(g, now = Date.now()) {
  return !g.revoked_at && Date.parse(g.expires_at) > now
}

export function activeGrantFor(grants, taskId, now = Date.now()) {
  return grants.find((g) => isGrantActive(g, now) && g.tasks.includes(String(taskId))) || null
}

export async function listGrants(repo) {
  return readGrantsFile(await grantsPath(repo))
}

export async function addGrant(repo, { tasks, hours, text, now = Date.now() }) {
  if (!text || typeof text !== 'string' || !text.trim()) throw new Error('预授权必须记录用户原话（--text "…"）')
  const h = Number(hours)
  if (!Number.isFinite(h) || h <= 0 || h > 168) throw new Error('--hours 必须在 (0, 168] 之间')
  const file = await grantsPath(repo)
  const grants = readGrantsFile(file)
  const grant = {
    id: `g${now.toString(36)}`,
    tasks: parseTaskRange(tasks),
    text: text.trim(),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + h * 3600_000).toISOString(),
    revoked_at: null,
  }
  grants.push(grant)
  writeGrantsFile(file, grants)
  return grant
}

export async function revokeGrant(repo, id, now = Date.now()) {
  const file = await grantsPath(repo)
  const grants = readGrantsFile(file)
  const g = grants.find((x) => x.id === id)
  if (!g) throw new Error(`没有这条预授权：${id}`)
  if (!g.revoked_at) g.revoked_at = new Date(now).toISOString()
  writeGrantsFile(file, grants)
  return g
}
