/**
 * input-lock.mjs — a small, fail-closed cross-process lock for inputs.jsonl.
 *
 * Why not lock.mjs? That lock is JSON-file based and its read-then-write is not
 * atomic. This lock uses mkdir() as the atomic acquisition primitive and keeps
 * the owner in a separate JSON file. A corrupted lock is never deleted: the
 * caller must resolve it explicitly.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const OWNER = 'owner.json'
export const LOCK_DIR = '.inputs.lock'

export function inputLockPath(taskDir) {
  return path.join(taskDir, LOCK_DIR)
}

function isAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function readOwner(lockDir) {
  try {
    const raw = fs.readFileSync(path.join(lockDir, OWNER), 'utf8')
    const owner = JSON.parse(raw)
    if (!owner || typeof owner !== 'object') return { ok: false, reason: 'corrupt' }
    if (!Number.isInteger(owner.pid) || !owner.token) return { ok: false, reason: 'corrupt' }
    return { ok: true, owner }
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'corrupt' }
  }
}

function makeOwner() {
  return {
    pid: process.pid,
    token: crypto.randomBytes(12).toString('hex'),
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
    at: new Date().toISOString(),
  }
}

/**
 * Acquire the input lock. The caller must call releaseInputLock in a finally.
 * @returns {{ok:true, dir:string, token:string, stale:object|null}|{ok:false, code:string, holder?:object}}
 */
export function acquireInputLock(taskDir, { timeoutMs = 10_000, pollMs = 25 } = {}) {
  fs.mkdirSync(taskDir, { recursive: true })
  const dir = inputLockPath(taskDir)
  const deadline = Date.now() + timeoutMs
  let stale = null

  for (;;) {
    try {
      fs.mkdirSync(dir)
      const owner = makeOwner()
      try {
        fs.writeFileSync(path.join(dir, OWNER), JSON.stringify(owner, null, 2), 'utf8')
      } catch (e) {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
        throw e
      }
      return { ok: true, dir, token: owner.token, stale }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }

    const cur = readOwner(dir)
    if (!cur.ok) {
      return { ok: false, code: cur.reason === 'missing' ? 'E_INPUT_LOCK_INCOMPLETE' : 'E_INPUT_LOCK_CORRUPT' }
    }
    if (cur.owner.pid === process.pid) {
      return { ok: false, code: 'E_INPUT_LOCK_REENTRANT', holder: cur.owner }
    }
    if (isAlive(cur.owner.pid)) {
      if (Date.now() >= deadline) return { ok: false, code: 'E_INPUT_LOCKED', holder: cur.owner }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs)
      continue
    }

    // The owner is dead. Move the whole directory aside atomically, then retry.
    const quarantine = dir + '.stale-' + crypto.randomBytes(4).toString('hex')
    try {
      fs.renameSync(dir, quarantine)
      stale = cur.owner
      try { fs.rmSync(quarantine, { recursive: true, force: true }) } catch { /* ignore */ }
    } catch {
      // another process won the takeover race; retry
    }
    if (Date.now() >= deadline) return { ok: false, code: 'E_INPUT_LOCKED', holder: cur.owner }
  }
}

export function releaseInputLock(lock) {
  if (!lock || !lock.ok) return false
  const cur = readOwner(lock.dir)
  if (!cur.ok || cur.owner.token !== lock.token) return false
  try { fs.rmSync(lock.dir, { recursive: true, force: true }); return true } catch { return false }
}

/** Run fn while holding the lock. The lock is always released. */
export function withInputLock(taskDir, fn, opts) {
  const lock = acquireInputLock(taskDir, opts)
  if (!lock.ok) {
    const err = new Error(`cannot acquire input lock: ${lock.code}`)
    err.code = lock.code
    err.holder = lock.holder
    throw err
  }
  try {
    return fn()
  } finally {
    releaseInputLock(lock)
  }
}

export function inputLockStatus(taskDir) {
  const dir = inputLockPath(taskDir)
  if (!fs.existsSync(dir)) return { held: false }
  const cur = readOwner(dir)
  if (!cur.ok) return { held: true, corrupt: true, reason: cur.reason }
  return { held: isAlive(cur.owner.pid), stale: !isAlive(cur.owner.pid), owner: cur.owner }
}
