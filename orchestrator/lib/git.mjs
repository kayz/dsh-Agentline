import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function git(args, cwd, env = null) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true, env: env || process.env })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
    child.on('error', (e) => resolve({ code: -1, out: '', err: e.message }))
  })
}

export async function currentBranch(cwd) {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  return r.out
}

/** 主仓库的 .git 目录（worktree 里执行时也指向主仓库） */
export async function commonGitDir(cwd) {
  const r = await git(['rev-parse', '--git-common-dir'], cwd)
  if (r.code !== 0) throw new Error(`git rev-parse --git-common-dir failed: ${r.err || r.out}`)
  return path.isAbsolute(r.out) ? r.out : path.resolve(cwd, r.out)
}

export async function hasChangesBesides(cwd, ignored = []) {
  const r = await git(['status', '--porcelain'], cwd)
  const lines = r.out.split('\n').map((s) => s.trim()).filter(Boolean)
  return lines.some((line) => !ignored.some((re) => re.test(line)))
}

export async function isClean(cwd) {
  const r = await git(['status', '--porcelain'], cwd)
  return r.out === ''
}

export async function headSha(cwd) {
  const r = await git(['rev-parse', 'HEAD'], cwd)
  return r.out
}

export async function branchExists(cwd, name) {
  const r = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], cwd)
  return r.code === 0
}

/** 确保在任务集成分支上；不存在则从 main 建。返回 {branch, created} */
export async function ensureTaskBranch(cwd, taskId) {
  const branch = `task/${taskId}`
  if (await branchExists(cwd, branch)) {
    const cur = await currentBranch(cwd)
    if (cur !== branch) await git(['checkout', branch], cwd)
    return { branch, created: false }
  }
  const base = (await branchExists(cwd, 'main')) ? 'main' : (await currentBranch(cwd))
  const r = await git(['checkout', '-b', branch, base], cwd)
  if (r.code !== 0) throw new Error(`checkout -b ${branch} failed: ${r.err}`)
  return { branch, created: true }
}

export async function commitAll(cwd, message) {
  const dirty = !(await isClean(cwd))
  if (!dirty) return { committed: false, sha: await headSha(cwd) }
  await git(['add', '-A'], cwd)
  const r = await git(['commit', '-m', message], cwd)
  if (r.code !== 0) throw new Error(`commit failed: ${r.err || r.out}`)
  return { committed: true, sha: await headSha(cwd) }
}

export async function changedFiles(cwd, base = 'main') {
  const r = await git(['diff', '--name-only', `${base}...HEAD`], cwd)
  return r.out ? r.out.split('\n') : []
}

/** base...head 的逐文件增删行数（不跟踪重命名；二进制文件记 0 行） */
export async function diffNumstat(cwd, base, head = 'HEAD') {
  const r = await git(['diff', '--numstat', '--no-renames', `${base}...${head}`], cwd)
  if (r.code !== 0) throw new Error(`git diff --numstat ${base}...${head} failed: ${r.err || r.out}`)
  if (!r.out) return []
  return r.out.split('\n').map((line) => {
    const [added, deleted, ...rest] = line.split('\t')
    return {
      file: rest.join('\t'),
      added: added === '-' ? 0 : Number(added),
      deleted: deleted === '-' ? 0 : Number(deleted),
    }
  })
}

// ── 候选切换（交班）用 ──────────────────────────────────────────
/** git status --porcelain 的逐行结果 */
export async function statusLines(cwd) {
  const r = await git(['status', '--porcelain'], cwd)
  return r.out ? r.out.split('\n') : []
}

/** 只统计业务代码的 diff（交班单里排除 .collab 噪音） */
export async function diffStat(cwd) {
  const r = await git(['diff', 'HEAD', '--stat', '--', '.', ':(exclude).collab'], cwd)
  return r.out
}

export async function diffText(cwd, maxChars = 6000) {
  const r = await git(['diff', 'HEAD', '--', '.', ':(exclude).collab'], cwd)
  const s = r.out || ''
  return s.length <= maxChars ? s : s.slice(0, maxChars) + `\n…（diff 已截断，原长 ${s.length} 字符；完整内容用 \`git diff HEAD\`）`
}

/**
 * 最近一次「业务代码」提交的 patch（排除 .collab）。
 * 会话复用时用它说明上一轮改了什么：review/状态提交只动 .collab，
 * 不能把它们当成上一轮变更点。
 */
export async function latestProductDiff(cwd, maxChars = 6000) {
  const commit = await git(['log', '-1', '--format=%H', '--', '.', ':(exclude).collab'], cwd)
  const sha = commit.out.trim()
  if (commit.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return ''
  const r = await git(['show', '--no-color', '--format=', '--patch', sha, '--', '.', ':(exclude).collab'], cwd)
  const text = r.out || ''
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…（diff 已截断，原长 ${text.length} 字符；完整内容用 \`git show ${sha.slice(0, 7)}\`）`
}

/**
 * 工作区指纹：只覆盖业务文件（排除 .collab）。
 * 用途：切换候选后，判断新候选是否真的动了东西（防止「继承即完成」）。
 */
export async function worktreeFingerprint(cwd) {
  const st = await git(['status', '--porcelain'], cwd)
  const diff = await git(['diff', 'HEAD', '--', '.', ':(exclude).collab'], cwd)
  const kept = (st.out ? st.out.split('\n') : []).filter((l) => l && !l.includes('.collab/'))
  return crypto.createHash('sha1').update(kept.join('\n')).update('\0').update(diff.out || '').digest('hex')
}

/**
 * 把当前工作区（含未跟踪文件）打成一个不可变的 checkpoint commit，挂到 refs/agentline/<name>。
 * 不修改真实 index / 工作树：用一个临时 index（GIT_INDEX_FILE）算 tree。
 * 注意：`git stash create -u` 在「只有未跟踪文件」时会返回空，所以不能只靠它。
 */
export async function checkpointWorktree(cwd, name) {
  const clean = await isClean(cwd)
  if (clean) return null

  const gp = await git(['rev-parse', '--git-path', 'agentline-checkpoint.index'], cwd)
  if (gp.code !== 0 || !gp.out) return null
  const indexPath = path.isAbsolute(gp.out) ? gp.out : path.resolve(cwd, gp.out)
  const env = { ...process.env, GIT_INDEX_FILE: indexPath }

  try { fs.rmSync(indexPath, { force: true }) } catch { /* ignore */ }
  try {
    const read = await git(['read-tree', 'HEAD'], cwd, env)
    if (read.code !== 0) return null
    const added = await git(['add', '-A'], cwd, env)
    if (added.code !== 0) return null
    const tree = await git(['write-tree'], cwd, env)
    if (tree.code !== 0 || !/^[0-9a-f]{40}$/.test(tree.out)) return null

    const commit = await git([
      '-c', 'user.name=agentline', '-c', 'user.email=agentline@local',
      'commit-tree', tree.out, '-p', 'HEAD', '-m', `agentline checkpoint ${name}`,
    ], cwd)
    const sha = commit.out.trim()
    if (commit.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return null

    const ref = `refs/agentline/${String(name).replace(/[^A-Za-z0-9._/-]/g, '-')}`
    const r = await git(['update-ref', ref, sha], cwd)
    return r.code === 0 ? { ref, sha } : null
  } finally {
    try { fs.rmSync(indexPath, { force: true }) } catch { /* ignore */ }
  }
}

export async function dropCheckpoint(cwd, ref) {
  if (!ref) return false
  const r = await git(['update-ref', '-d', ref], cwd)
  return r.code === 0
}

