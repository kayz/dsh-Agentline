import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHECK_TASK = path.resolve(__dirname, '..', '..', 'AgentLine', 'tools', 'check-task.ps1')
const skip = process.platform !== 'win32' || spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status !== 0

function makeTaskRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-checktask-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'init')

  const task = path.join(repo, '.collab', 'tasks', '001')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'code\n', 'utf8')
  fs.mkdirSync(task, { recursive: true })
  fs.writeFileSync(path.join(task, 'brief.md'), '# brief\n', 'utf8')
  fs.writeFileSync(path.join(task, 'design.md'), '---\nwrite_scope:\n  - src/**\n---\n\n# design\n', 'utf8')
  fs.writeFileSync(path.join(task, 'acceptance.md'), '# acceptance\n', 'utf8')
  fs.writeFileSync(path.join(task, 'impl.md'), '# impl\n', 'utf8')
  fs.writeFileSync(path.join(task, 'review.md'), '# review\n', 'utf8')
  fs.writeFileSync(path.join(task, 'state.json'), JSON.stringify({ id: '001', status: 'reviewed', pr: { branch: 'task/001' } }, null, 2), 'utf8')
  fs.writeFileSync(path.join(task, 'run.json'), JSON.stringify([
    { role: 'design', model_requested: 'model-a', model_resolved: 'model-a', exit: { code: 0 }, duration_ms: 1, candidate: 1 },
    { role: 'dev', model_requested: 'model-b', model_resolved: 'model-b', exit: { code: 0 }, duration_ms: 1, candidate: 1 },
    { role: 'review', model_requested: 'model-c', model_resolved: 'model-c', exit: { code: 0 }, duration_ms: 1, candidate: 1 },
  ], null, 2), 'utf8')
  fs.writeFileSync(path.join(task, 'ci-results.json'), JSON.stringify({ passed: 2, total: 2, ok: true, results: [{ id: 'AC-1', passed: true }] }, null, 2), 'utf8')

  git('checkout', '-q', '-b', 'task/001')
  git('add', '-A')
  git('commit', '-qm', 'task work')
  const sha = git('rev-parse', 'HEAD').trim()
  fs.writeFileSync(path.join(task, 'verdict.json'), JSON.stringify({ verdict: 'pass', passed: 2, total: 2, findings: [], git_sha: sha }, null, 2), 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'verdict')
  return { repo, task }
}

const runCheck = (repo) => spawnSync('pwsh', [
  '-NoProfile', '-File', CHECK_TASK,
  '-RepoRoot', repo, '-TaskDir', '.collab/tasks/001',
], { encoding: 'utf8' })

test('check-task passes a complete task', { skip }, () => {
  const { repo } = makeTaskRepo()
  const r = runCheck(repo)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /PASS/)
  fs.rmSync(repo, { recursive: true, force: true })
})

test('check-task rejects identical dev/review models', { skip }, () => {
  const { repo, task } = makeTaskRepo()
  const runs = JSON.parse(fs.readFileSync(path.join(task, 'run.json'), 'utf8'))
  runs[2].model_resolved = 'model-b'
  fs.writeFileSync(path.join(task, 'run.json'), JSON.stringify(runs, null, 2), 'utf8')
  const r = runCheck(repo)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /\[FAIL\] C3 model isolation/)
  fs.rmSync(repo, { recursive: true, force: true })
})

test('check-task rejects files outside write_scope', { skip }, () => {
  const { repo } = makeTaskRepo()
  fs.writeFileSync(path.join(repo, 'out-of-scope.txt'), 'x\n', 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'oops'], { cwd: repo })
  const r = runCheck(repo)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /out of write_scope/)
  fs.rmSync(repo, { recursive: true, force: true })
})
