/**
 * lock.mjs — 单任务/单仓库的互斥锁（R5）
 *
 * 用文件 + pid 存活检测实现：
 *   - 抢到锁 → 写 {pid, host, at, task, cmd}
 *   - 已有锁但 pid 已死 → 视为 stale，接管并记录
 *   - 已有锁且 pid 存活 → 拒绝，打印持有者信息
 *
 * 注意：kill -9 不会走清理逻辑，靠"pid 已死"兜底。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function alive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

export function acquireLock(file, meta = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const prev = readLock(file)
  let stale = null

  if (prev) {
    if (prev.pid && prev.pid !== process.pid && alive(prev.pid)) {
      return { ok: false, holder: prev }
    }
    stale = prev
  }

  const payload = {
    pid: process.pid,
    host: os.hostname(),
    at: new Date().toISOString(),
    ...meta,
  }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  return { ok: true, stale }
}

export function releaseLock(file) {
  const cur = readLock(file)
  if (!cur) return false
  if (cur.pid !== process.pid) return false   // 不是自己持有的，不动
  try { fs.unlinkSync(file); return true } catch { return false }
}

export function lockHolder(file) {
  return readLock(file)
}

/** 给进程装清理钩子：正常退出与 Ctrl-C 都会释放；kill -9 依靠 stale 接管 */
export function installCleanup(file) {
  const release = () => { try { releaseLock(file) } catch { /* ignore */ } }
  process.on('exit', release)
  process.on('SIGINT', () => { release(); process.exit(130) })
  process.on('SIGTERM', () => { release(); process.exit(143) })
}
