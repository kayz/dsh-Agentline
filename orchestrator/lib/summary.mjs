/**
 * summary.mjs — 任务结束时的「总结发言」文本（给对话框用，不是日志）
 *
 * 只依据磁盘事实：state.json / run.json / ci-results.json / verdict*.json + git。
 * 输出控制在 10 行内：一眼看清 项目/任务、结果、阶段、验收、变更、下一步。
 *
 * 被两处共用：
 *   - CLI finish() / merge：写进 notice.json 的 summary 字段
 *   - DSH 插件：任务结束时把 summary 注入「开启任务的对话框」
 */
import fs from 'node:fs'
import path from 'node:path'

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

const fmtDur = (ms) => {
  const s = Math.round((ms || 0) / 1000)
  if (!s) return '-'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** 取轮次最高的 verdict（verdict.json 视为第 1 轮） */
function bestVerdict(dir) {
  let best = null
  let bestRound = -1
  let names = []
  try { names = fs.readdirSync(dir) } catch { return null }
  for (const name of names) {
    const m = name.match(/^verdict(?:-r(\d+))?\.json$/)
    if (!m) continue
    const round = m[1] ? Number(m[1]) : 1
    if (round <= bestRound) continue
    const v = readJson(path.join(dir, name))
    if (!v) continue
    bestRound = round
    best = { ...v, round }
  }
  return best
}

const EVENT_LABEL = {
  pr_open: '任务完成（等待合并）',
  merged: '任务已合并',
  blocked: '任务被阻塞',
  halted: '任务已停止',
}

/**
 * @param {object} o
 * @param {string} o.repo      仓库绝对路径
 * @param {string} o.taskId    任务号
 * @param {string} o.dir       任务目录（.collab/tasks/<id>）
 * @param {string} [o.event]   pr_open | merged | blocked | halted
 * @param {string} [o.reason]  blocked 原因
 * @param {string} [o.branch]  分支名
 * @returns {string} 多行紧凑总结（≤ 12 行）
 */
export async function buildSummary({ repo, taskId, dir, event, reason, branch } = {}) {
  const project = path.basename(String(repo || '')) || '?'
  const st = readJson(path.join(dir, 'state.json')) || {}
  const runsRaw = readJson(path.join(dir, 'run.json'))
  const runs = Array.isArray(runsRaw) ? runsRaw.filter(Boolean) : (runsRaw ? [runsRaw] : [])
  const ci = readJson(path.join(dir, 'ci-results.json'))
  const verdict = bestVerdict(dir)

  const ev = event || (st.status === 'merged' ? 'merged' : (st.status === 'blocked' ? 'blocked' : 'pr_open'))
  const why = reason || st.blocked_reason || null
  const br = branch || st.pr?.branch || `task/${taskId}`
  const files = Array.isArray(st.pr?.files) ? st.pr.files.length : null
  const sha = String(st.pr?.sha || '').slice(0, 7) || null

  const lines = []
  lines.push(`【AgentLine ${EVENT_LABEL[ev] ? EVENT_LABEL[ev] : '任务结束'}】${project} / task ${taskId}`)

  if (ev === 'merged') {
    lines.push(`结果：已并入 main${sha ? `（${sha}）` : ''}`)
  } else if (ev === 'blocked' || ev === 'halted') {
    lines.push(`结果：blocked — ${why || '未知原因'}`)
  } else {
    lines.push('结果：pr_open — 分支已准备好，等你许可合并')
  }

  // 阶段链：design → dev → CI → review
  const bits = []
  for (const role of ['design', 'dev']) {
    const r = [...runs].reverse().find((x) => x && x.role === role)
    if (r) bits.push(`${role} ${r.exit?.code === 0 ? '✅' : '❌'}`)
  }
  if (ci) bits.push(`CI ${ci.passed ?? '?'}/${ci.total ?? '?'} ${ci.ok ? '✅' : '❌'}`)
  if (verdict) bits.push(`review r${verdict.round || 1} ${verdict.verdict || '?'} ${verdict.verdict === 'pass' ? '✅' : '❌'}`)
  if (bits.length) lines.push(`阶段：${bits.join(' · ')}`)

  // 变更规模 + 耗时
  const marks = []
  for (const r of runs) {
    if (!r) continue
    if (r.started_at) marks.push(new Date(r.started_at).getTime())
    if (r.ended_at) marks.push(new Date(r.ended_at).getTime())
    else if (r.started_at && r.duration_ms) marks.push(new Date(r.started_at).getTime() + r.duration_ms)
  }
  const span = marks.length ? fmtDur(Math.max(...marks) - Math.min(...marks)) : null

  const change = [`分支 ${br}`]
  if (files != null) change.push(`${files} 个文件`)
  if (span && span !== '-') change.push(`耗时 ${span}`)
  lines.push(`变更：${change.join(' · ')}`)

  // 验收
  const acc = []
  if (ci) acc.push(`CI ${ci.passed ?? '?'}/${ci.total ?? '?'}`)
  if (verdict) acc.push(`verdict=${verdict.verdict || '?'}`, `findings ${(verdict.findings || []).length}`)
  if (acc.length) lines.push(`验收：${acc.join(' · ')}`)

  // 下一步
  if (ev === 'pr_open') {
    const risk = st.merge_risk
    const tier = risk?.tier === 'low' ? '（低档：有预授权时可直接合并）' : (risk ? `（需逐个确认：${risk.reasons.join('；')}）` : '')
    lines.push(`下一步：要合并就回复「允许合并 task ${taskId}」${tier}；想改就说明要改什么`)
  }
  else if (ev === 'merged') lines.push('下一步：无，任务已结束')
  else lines.push(`下一步：修好后让我继续（flow --resume）；或告诉我调整验收/范围`)

  return lines.join('\n')
}

export default buildSummary
