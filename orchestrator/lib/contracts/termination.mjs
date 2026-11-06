/**
 * termination.mjs — conservative process-termination proof.
 *
 * "The pid is not alive" is not enough to resume: descendants may still be
 * alive, and a pid may have been reused. Callers may only resume when a guard
 * (Windows Job Object, POSIX subreaper, or an equivalent tree-owning primitive)
 * proves that the whole tree is gone.
 *
 * This module deliberately returns `unknown` rather than guessing.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** Best-effort process start time; used only for evidence, never as a proof. */
export function processStartTime(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
      { encoding: 'utf8', windowsHide: true })
    if (r.status === 0) return String(r.stdout || '').trim() || null
    return null
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] || null // starttime in clock ticks, not an absolute time
  } catch { return null }
}

/**
 * @param {{pid:number, guard?:{covers:'tree', proven_dead:boolean, kind:string}}} input
 * @returns {{status:'alive'|'proven_dead'|'unknown', pid:number, reason:string}}
 */
export function proveTermination({ pid, guard = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'unknown', pid: pid || null, reason: 'no_pid' }
  if (pidAlive(pid)) return { status: 'alive', pid, reason: 'target_alive' }
  if (guard && guard.covers === 'tree' && guard.proven_dead === true) {
    return { status: 'proven_dead', pid, reason: `guard:${guard.kind || 'tree'}` }
  }
  return { status: 'unknown', pid, reason: 'target_dead_tree_unproven' }
}

export function canResume(proof) {
  return !!proof && proof.status === 'proven_dead'
}
