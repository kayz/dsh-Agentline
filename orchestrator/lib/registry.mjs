/**
 * registry.mjs — 跨 worktree 的并发登记与排队
 *
 * 位置：<repo>/.git/agentline/（worktree 里执行时会解析到主仓库的 .git）
 *   registry.json   当前持有执行槽的任务（pid / worktree / write_scope / phase）
 *   locks/task-*.json  单任务互斥（同一任务只能有一个 flow）
 *   .registry.lock  目录锁，保证 registry 的读改写原子
 *
 * 槽位规则：最多 maxTasks 个任务同时执行；write_scope 相交的任务必须排队。
 * 进程死掉后由下一个获得锁的进程按 pid 清理，不需要手工删文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { commonGitDir } from './git.mjs'
import { scopeOverlaps, describeScope } from './scope.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function alive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

async function rootOf(repo) {
  return path.join(await commonGitDir(repo), 'agentline')
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

async function withMutex(repo, fn) {
  const root = await rootOf(repo)
  const mutex = path.join(root, '.registry.lock')
  fs.mkdirSync(root, { recursive: true })
  for (let i = 0; i < 300; i++) {
    try {
      fs.mkdirSync(mutex)
      fs.writeFileSync(path.join(mutex, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
      try {
        return await fn(root)
      } finally {
        try { fs.rmSync(mutex, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const owner = readJson(path.join(mutex, 'owner.json'))
      const stale = !owner || !alive(owner.pid) || (Date.now() - (owner.at || 0) > 60_000)
      if (stale) {
        try { fs.rmSync(mutex, { recursive: true, force: true }) } catch { /* ignore */ }
        continue
      }
      await sleep(100)
    }
  }
  throw new Error('registry lock timeout')
}

function readRegistry(root) {
  const v = readJson(path.join(root, 'registry.json'))
  return v && v.tasks ? v : { version: 1, tasks: {} }
}

function writeRegistry(root, reg) {
  writeJson(path.join(root, 'registry.json'), reg)
}

function prune(reg) {
  let changed = false
  for (const [task, entry] of Object.entries(reg.tasks || {})) {
    if (!entry || !alive(entry.pid)) { delete reg.tasks[task]; changed = true }
  }
  return changed
}

export async function acquireTaskLock(repo, taskId) {
  const root = await rootOf(repo)
  const dir = path.join(root, 'locks')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `task-${taskId}.lock`)
  for (let i = 0; i < 5; i++) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, task: taskId, host: os.hostname(), since: new Date().toISOString() }, null, 2), 'utf8')
      fs.closeSync(fd)
      return { ok: true, file }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const holder = readJson(file)
      if (holder && alive(holder.pid)) return { ok: false, file, holder }
      try { fs.rmSync(file, { force: true }) } catch { /* ignore */ }
    }
  }
  return { ok: false, file, holder: readJson(file) }
}

export async function taskLockHolder(repo, taskId) {
  const root = await rootOf(repo)
  return readJson(path.join(root, 'locks', `task-${taskId}.lock`))
}

export async function releaseTaskLock(repo, taskId) {
  const root = await rootOf(repo)
  const file = path.join(root, 'locks', `task-${taskId}.lock`)
  try {
    const holder = readJson(file)
    if (!holder || holder.pid === process.pid) fs.rmSync(file, { force: true })
  } catch { /* ignore */ }
}

/**
 * 申请执行槽。返回 {ok:true} 或 {ok:false, reason}（wait=false 时立即返回）。
 * scope：design.md 的 write_scope；null 视为 **（全仓库）。
 */
export async function acquireCapacity({
  repo, taskId, scope, worktree, phase = 'dev',
  wait = true, priority = false, maxTasks = 3, pollMs = 5000, log = null,
}) {
  const normalized = Array.isArray(scope) ? scope : (scope == null ? ['**'] : [])
  for (;;) {
    const result = await withMutex(repo, (root) => {
      const reg = readRegistry(root)
      prune(reg)
      const others = Object.values(reg.tasks).filter((t) => t.task !== taskId)
      const conflict = others.find((t) => scopeOverlaps(normalized, t.scope))
      const slotsFull = !priority && others.length >= maxTasks
      if (conflict || slotsFull) {
        return {
          ok: false,
          reason: conflict
            ? `write_scope 冲突：task ${conflict.task}（${describeScope(conflict.scope)}）↔ 本任务（${describeScope(normalized)}）`
            : `槽位已满：${others.length}/${maxTasks}`,
        }
      }
      reg.tasks[taskId] = {
        task: taskId, pid: process.pid, worktree: worktree || null,
        scope: normalized, phase, priority: Boolean(priority),
        since: new Date().toISOString(), host: os.hostname(),
      }
      writeRegistry(root, reg)
      return { ok: true }
    })
    if (result.ok) return result
    if (!wait) return result
    log?.(`[queue] ${result.reason}；${Math.round(pollMs / 1000)}s 后重试（Ctrl-C 退出）`)
    await sleep(pollMs)
  }
}

export async function releaseCapacity(repo, taskId) {
  try {
    await withMutex(repo, (root) => {
      const reg = readRegistry(root)
      if (reg.tasks[taskId]) {
        delete reg.tasks[taskId]
        writeRegistry(root, reg)
      }
    })
  } catch { /* ignore */ }
}

export async function runningTasks(repo) {
  const map = await withMutex(repo, (root) => {
    const reg = readRegistry(root)
    if (prune(reg)) writeRegistry(root, reg)
    return reg.tasks
  })
  return Object.values(map)
}

export async function updatePhase(repo, taskId, phase) {
  try {
    await withMutex(repo, (root) => {
      const reg = readRegistry(root)
      if (reg.tasks[taskId]) {
        reg.tasks[taskId].phase = phase
        writeRegistry(root, reg)
      }
    })
  } catch { /* ignore */ }
}

