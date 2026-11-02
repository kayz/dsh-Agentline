/**
 * worktree.mjs — 每个任务一个 git worktree
 *
 * 目的：主工作区永远停在 main，任务在独立目录里跑；分支状态、未提交改动、
 * `.collab` 证据都只属于该任务，不会和别的任务互相污染。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { commonGitDir } from './git.mjs'

function git(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
    child.on('error', (e) => resolve({ code: -1, out: '', err: e.message }))
  })
}

export function worktreePath(repo, taskId, dirRel = '.collab/worktrees') {
  return path.resolve(repo, dirRel, String(taskId))
}

function ensureExclude(commonDir, dirRel) {
  try {
    const infoDir = path.join(commonDir, 'info')
    fs.mkdirSync(infoDir, { recursive: true })
    const file = path.join(infoDir, 'exclude')
    const line = String(dirRel).replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (!cur.split(/\r?\n/).includes(line)) {
      fs.appendFileSync(file, (cur.endsWith('\n') || !cur ? '' : '\n') + line + '\n', 'utf8')
    }
  } catch { /* ignore */ }
}

/** 创建/复用任务 worktree；主工作区分支不变 */
export async function ensureTaskWorktree(repo, taskId, { baseRef = 'main', dirRel = '.collab/worktrees' } = {}) {
  const dir = worktreePath(repo, taskId, dirRel)
  const branch = `task/${taskId}`
  if (fs.existsSync(path.join(dir, '.git'))) return { path: dir, branch, created: false }

  const common = await commonGitDir(repo)
  ensureExclude(common, dirRel)

  const hasBranch = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
  let base = baseRef
  if (!hasBranch) {
    const ok = (await git(repo, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])).code === 0
    if (!ok) base = 'HEAD'
  }

  const args = hasBranch
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, base]
  const r = await git(repo, args)
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.err || r.out}`)
  return { path: dir, branch, created: true }
}

export async function removeTaskWorktree(repo, taskId, { dirRel = '.collab/worktrees' } = {}) {
  const dir = worktreePath(repo, taskId, dirRel)
  if (!fs.existsSync(dir)) return false
  const r = await git(repo, ['worktree', 'remove', '--force', dir])
  await git(repo, ['worktree', 'prune'])
  if (r.code !== 0) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  return true
}

/** 同步解析任务目录：优先主工作区，其次任务 worktree */
export function resolveTaskDir(repo, taskId, { collabDir = '.collab/tasks', dirRel = '.collab/worktrees' } = {}) {
  const mainDir = path.resolve(repo, collabDir, String(taskId))
  // 主工作区里有 state.json 才算「在主编排的任务」；只有 brief 说明还没进 worktree
  if (fs.existsSync(path.join(mainDir, 'state.json'))) return { repo, dir: mainDir, worktree: false }
  const wt = worktreePath(repo, taskId, dirRel)
  const wtDir = path.join(wt, collabDir, String(taskId))
  if (fs.existsSync(wtDir)) return { repo: wt, dir: wtDir, worktree: true }
  if (fs.existsSync(mainDir)) return { repo, dir: mainDir, worktree: false }
  return null
}

