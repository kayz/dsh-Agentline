import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureTaskWorktree, removeTaskWorktree, resolveTaskDir } from '../lib/worktree.mjs'
import { acquireTaskLock, releaseTaskLock, acquireCapacity, releaseCapacity, runningTasks } from '../lib/registry.mjs'

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-wt-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return repo
}

test('worktree: created outside main branch, removable, resolvable', async () => {
  const repo = makeRepo()
  const wt = await ensureTaskWorktree(repo, '001')
  assert.ok(fs.existsSync(path.join(wt.path, '.git')))
  const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: repo, encoding: 'utf8' })
  assert.match(branches, /task\/001/)
  const mainBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  assert.equal(mainBranch, 'main')

  fs.mkdirSync(path.join(wt.path, '.collab', 'tasks', '001'), { recursive: true })
  fs.writeFileSync(path.join(wt.path, '.collab', 'tasks', '001', 'state.json'), '{}', 'utf8')
  const located = resolveTaskDir(repo, '001')
  assert.equal(located?.worktree, true)
  assert.equal(located?.repo, wt.path)

  await removeTaskWorktree(repo, '001')
  assert.equal(fs.existsSync(wt.path), false)
  fs.rmSync(repo, { recursive: true, force: true })
})

test('queue: scope conflict waits, disjoint scope runs, task lock is exclusive', async () => {
  const repo = makeRepo()
  const a = await acquireTaskLock(repo, '001')
  assert.equal(a.ok, true)
  const again = await acquireTaskLock(repo, '001')
  assert.equal(again.ok, false)
  await releaseTaskLock(repo, '001')

  const r1 = await acquireCapacity({ repo, taskId: '001', scope: ['src/app/**'], wait: false })
  assert.equal(r1.ok, true)
  const conflict = await acquireCapacity({ repo, taskId: '002', scope: ['src/app/ui/**'], wait: false })
  assert.equal(conflict.ok, false)
  assert.match(conflict.reason, /write_scope/)
  const disjoint = await acquireCapacity({ repo, taskId: '003', scope: ['docs/**'], wait: false })
  assert.equal(disjoint.ok, true)
  const running = await runningTasks(repo)
  assert.deepEqual(running.map((x) => x.task).sort(), ['001', '003'])

  await releaseCapacity(repo, '001')
  const after = await acquireCapacity({ repo, taskId: '002', scope: ['src/app/**'], wait: false })
  assert.equal(after.ok, true)
  await releaseCapacity(repo, '002')
  await releaseCapacity(repo, '003')
  fs.rmSync(repo, { recursive: true, force: true })
})
