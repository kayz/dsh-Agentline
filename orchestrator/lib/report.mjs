/**
 * report.mjs — 任务结束时的完整报告（只打印，不写文件）
 *
 * 数据全部来自磁盘事实：state.json / run.json / ci-results.json / verdict.json + git。
 * 目的：一次把「谁做的、做了几轮、验收过了没、改了什么、下一步」看全，
 * 不用再去翻 logs 或 git log。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

function git(repo, args) {
  return new Promise((resolve) => {
    const c = spawn('git', args, { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { err += d })
    c.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
  })
}

const fmtDur = (ms) => {
  const s = Math.round((ms || 0) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

const fmtTokens = (u) => {
  if (!u) return ''
  const n = (x) => (x == null ? '?' : Number(x).toLocaleString('en-US'))
  return `in ${n(u.input)} / out ${n(u.output)}${u.cache_read != null ? ` / cache ${n(u.cache_read)}` : ''}`
}

const RULE = '─'.repeat(64)

/** 结束通知：写成 notice.json，供插件在对话里提示（flow 是独立进程，没法直接往会话里发消息） */
export function writeNotice(dir, notice) {
  try {
    const body = { ...notice, at: new Date().toISOString() }
    fs.writeFileSync(path.join(dir, 'notice.json'), JSON.stringify(body, null, 2), 'utf8')
    return body
  } catch { return null }
}

export async function printReport({ repo, taskId, dir, state, runs, summary = [], result, branch }) {
  const lines = []
  const push = (s = '') => lines.push(s)

  const st = state || readJson(path.join(dir, 'state.json')) || {}
  const allRuns = (runs || readJson(path.join(dir, 'run.json')) || [])
  const runList = Array.isArray(allRuns) ? allRuns : [allRuns]
  const ci = readJson(path.join(dir, 'ci-results.json'))
  // 取「轮次最高」的 verdict（verdict.json 视为第 1 轮，verdict-rN.json 为第 N 轮）
  const verdict = (() => {
    let best = null
    let bestRound = -1
    let names = []
    try { names = fs.readdirSync(dir) } catch { return null }
    for (const name of names) {
      const m = name.match(/^verdict(?:-r(\d+))?\.json$/)
      if (!m) continue
      const round = m[1] ? Number(m[1]) : 1
      if (round > bestRound) { bestRound = round; best = readJson(path.join(dir, name)) }
    }
    return best
  })()

  // 分支与提交
  const br = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const commits = await git(repo, ['rev-list', '--count', `main..${branch || br.out}`])
  const filesOut = await git(repo, ['diff', '--name-only', `main...${branch || br.out}`])
  const statOut = await git(repo, ['diff', '--stat', `main...${branch || br.out}`])
  const gitFiles = filesOut.code === 0 ? filesOut.out.split('\n').filter(Boolean) : []
  // 分支已并入 main 时 main..branch 为空：退回 pr_open 时记录的文件清单
  const merged = !(commits.out && commits.out !== '0')
  const files = merged ? (st.pr?.files || gitFiles) : gitFiles

  // 时间跨度：最早开始 → 最晚结束（而不是到"现在"，否则看报告的时间也会被算进去）
  const marks = []
  for (const r of runList) {
    if (!r) continue
    if (r.started_at) marks.push(new Date(r.started_at).getTime())
    if (r.finished_at) marks.push(new Date(r.finished_at).getTime())
    else if (r.started_at && r.duration_ms) marks.push(new Date(r.started_at).getTime() + r.duration_ms)
  }
  const span = marks.length ? fmtDur(Math.max(...marks) - Math.min(...marks)) : '-'

  const status = (result && result.ok) ? 'pr_open（等待人类许可合并）' : `blocked（${result?.reason || st.blocked_reason || '?'}）`
  const icon = (result && result.ok) ? '✅' : '⛔'

  push('')
  push(RULE)
  push(`  AgentLine 任务报告   ${path.basename(repo)} / task ${taskId}`)
  push(RULE)
  push(`  ${icon} 结果       ${status}`)
  push(`     分支       ${branch || br.out}${merged ? '（已并入 main）' : `  ·  ${commits.out} commits`}  ·  ${files.length} files`)
  push(`     耗时       ${span}`)
  push('')

  // 阶段表
  push('  阶段')
  const stageRows = runList.filter((r) => r && r.role && r.role !== 'ci')
  if (!stageRows.length) push('     （无记录）')
  for (const r of stageRows) {
    const ok = r.exit?.code === 0
    const mark = ok ? '✅' : (r.exit?.code === 125 ? '⏱ ' : '❌')
    const model = String(r.model_requested || '-').padEnd(22)
    push(`     ${mark} ${String(r.role).padEnd(7)} r${r.round || 1}${r.candidate > 1 ? ' #' + r.candidate : ''}  ${model} ${String(fmtDur(r.duration_ms)).padStart(6)}  ${r.error ? 'error=' + r.error : ''}`)
  }
  const ciRuns = runList.filter((r) => r && r.role === 'ci')
  const lastCi = ciRuns[ciRuns.length - 1]
  if (lastCi) {
    const pass = lastCi.exit?.code === 0
    const p = lastCi.ci?.passed
    const t = lastCi.ci?.total
    push(`     ${pass ? '✅' : '❌'} ci      ${p != null ? `${p}/${t}` : (pass ? 'pass' : 'fail')}${ciRuns.length > 1 ? `  （共 ${ciRuns.length} 次）` : ''}`)
  }
  push('')

  // 验收
  push('  验收')
  if (ci?.results) {
    const bad = ci.results.filter((x) => !x.passed)
    push(`     CI ${ci.passed ?? '?'}/${ci.total ?? '?'}${bad.length ? '  ✗ ' + bad.map((b) => b.id).join(', ') : ''}`)
    const testCase = ci.results.find((x) => /cargo test/.test(String(x.command || '')))
    if (testCase) {
      const m = String(testCase.output || '').match(/passed=(\d+)\s+failed=(\d+)\s+ignored=(\d+)/)
      if (m) push(`     cargo test ${m[1]} passed / ${m[2]} failed / ${m[3]} ignored`)
    }
  } else push('     CI 未运行')

  if (verdict) {
    push(`     评审 verdict=${verdict.verdict}  sha=${String(verdict.git_sha || '').slice(0, 7)}  通过 ${verdict.passed ?? '?'}/${verdict.total ?? '?'}`)
    const fs2 = verdict.findings || []
    if (fs2.length) {
      push(`     findings ${fs2.length}:`)
      for (const f of fs2.slice(0, 5)) push(`       · [${f.severity || '?'}] ${f.id || ''} ${String(f.problem || '').slice(0, 70)}`)
    } else push('     findings 0')
  } else push('     评审未完成（无 verdict.json）')
  push('')

  // 变更
  if (statOut.code === 0 && statOut.out) {
    push('  变更（相对 main）')
    const rows = statOut.out.split('\n').slice(0, 12)
    for (const r of rows) push('     ' + r.replace(/\s+\|\s+/, '  |  '))
    if (statOut.out.split('\n').length > 12) push('     …')
    push('')
  }

  // 下一步
  push('  下一步')
  if (result && result.ok) {
    const risk = st.merge_risk
    if (risk?.tier === 'low') push('     · 低档：有覆盖本任务的预授权时可以  agentline merge --repo <path> --task ' + taskId + ' --grant')
    else if (risk) push(`     · 需逐个确认：${risk.reasons.join('；')}`)
    push('     · 需要人类许可合并：  agentline merge --repo <path> --task ' + taskId + ' --permission "允许合并"')
    push('     · 合并后可继续：      task 002（未修项）或 P3 控制面')
  } else {
    push(`     · 阻塞原因：${result?.reason || st.blocked_reason || '?'}`)
    push(`     · 排查：      agentline status --repo <path> --task ${taskId}`)
    push('     · 修好后：    agentline flow --repo <path> --task ' + taskId + ' --resume')
  }
  push(RULE)
  push('')

  process.stdout.write(lines.join('\n') + '\n')
  return lines.join('\n')
}



