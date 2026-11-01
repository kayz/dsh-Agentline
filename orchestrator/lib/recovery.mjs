/**
 * recovery.mjs — 进程被杀后的现场判定
 *
 * 背景：整个 DSH 被 kill 时，agentline 的 flow 进程和它 spawn 的 CLI 会一起死，
 * 任务会停在「某个阶段已经开始但没有结果」的位置。此时磁盘上会有三个线索：
 *   1. .collab/.flow.lock           —— 持有者 pid（可能已死）
 *   2. .collab/tasks/<id>/live.json —— 正在跑的角色（可能已死）
 *   3. state.json 停在中间状态      —— designed / implemented / reviewable
 *
 * 判定原则：**不自动续跑**。中断时可能有半成品改动，自动接着跑会把它和新的尝试混在一起；
 * 这里只负责把状态标成 blocked(interrupted)，把决定权交给人（驾驶舱一键继续）。
 */
import fs from 'node:fs'
import path from 'node:path'

export const ACTIVE_STATUSES = ['draft', 'designed', 'implemented', 'reviewable', 'reviewed']

export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export const REASON = 'interrupted'
export const NOTE = '上次运行被终止（进程消失），需要显式继续'

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

/** 读锁文件里的 pid（没有锁返回 null） */
export function readLock(repo) {
  return readJson(path.join(repo, '.collab', '.flow.lock'))
}

/** 判断当前仓库是否有活着的 flow */
export function flowAlive(repo) {
  const lock = readLock(repo)
  return !!(lock && isPidAlive(lock.pid))
}

/**
 * 扫描所有任务，把「中间状态 + 进程已死」的任务标成 blocked(interrupted)。
 * 返回本次改动的任务列表（幂等：已标记过的不再改）。
 */
export function sweepInterrupted(repo, { log } = {}) {
  const tasksDir = path.join(repo, '.collab', 'tasks')
  const alive = flowAlive(repo)
  const changed = []

  let ids = []
  try { ids = fs.readdirSync(tasksDir).filter((d) => /^\d+$/.test(d)) } catch { return changed }

  for (const id of ids) {
    const dir = path.join(tasksDir, id)
    const statePath = path.join(dir, 'state.json')
    const st = readJson(statePath)
    if (!st) continue

    // 清理死掉的 live.json（灯的假阳性）
    const livePath = path.join(dir, 'live.json')
    const live = readJson(livePath)
    if (live && !isPidAlive(live.pid)) {
      try { fs.rmSync(livePath, { force: true }) } catch { /* ignore */ }
    }

    if (!ACTIVE_STATUSES.includes(st.status)) continue
    if (alive) continue // flow 还活着，别动
    if (st.blocked_reason === REASON) continue // 已经标过

    const next = {
      ...st,
      status: 'blocked',
      blocked_reason: REASON,
      interrupted: {
        from: st.status,
        role: st.role || null,
        model: st.model || null,
        at: new Date().toISOString(),
        note: NOTE,
      },
      updated_at: new Date().toISOString(),
      history: [...(st.history || []), { at: new Date().toISOString(), from: st.status, to: 'blocked', by: 'recovery:interrupted' }],
    }
    try {
      fs.writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf8')
      changed.push({ task: id, from: st.status })
      log?.(`[recovery] task ${id}: ${st.status} → blocked(interrupted)`)
    } catch { /* ignore */ }
  }

  // 锁文件持有者已死 → 删掉，否则下次 flow 会被挡
  const lock = readLock(repo)
  if (lock && !isPidAlive(lock.pid)) {
    try { fs.rmSync(path.join(repo, '.collab', '.flow.lock'), { force: true }) } catch { /* ignore */ }
    if (!changed.length) log?.('[recovery] 清理了失效的 flow lock')
  }

  return changed
}
