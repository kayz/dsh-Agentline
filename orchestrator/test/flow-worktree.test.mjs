import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runFlow } from '../lib/flow.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CI_RUNNER = path.join(ROOT, 'tools', 'ci-runner.ps1')
const CHECK_TASK = path.resolve(ROOT, '..', 'AgentLine', 'tools', 'check-task.ps1')
const skip = process.platform !== 'win32' || spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status !== 0

test('flow runs in a worktree, passes CI/review, leaves main clean', { skip, timeout: 60_000 }, async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-flowwt-'))
  t.after(() => {
    try { execFileSync('git', ['worktree', 'remove', '--force', path.join(repo, '.collab', 'worktrees', '001')], { cwd: repo }) } catch { /* ignore */ }
    fs.rmSync(repo, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const task = path.join(repo, '.collab', 'tasks', '001')
  fs.mkdirSync(task, { recursive: true })
  fs.writeFileSync(path.join(task, 'brief.md'), '# brief\n', 'utf8')
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'init')

  const config = {
    collabDir: '.collab/tasks',
    worktree: { enabled: true, dir: '.collab/worktrees', baseRef: 'main' },
    concurrency: { maxTasks: 3, wait: true, pollSeconds: 1 },
    providers: {
      p1: { adapter: 'design', command: 'x', source: 'test' },
      p2: { adapter: 'dev', command: 'x', source: 'test' },
      p3: { adapter: 'review', command: 'x', source: 'test' },
    },
    models: {
      d: { provider: 'p1', id: 'model-design' },
      v: { provider: 'p2', id: 'model-dev' },
      r: { provider: 'p3', id: 'model-review' },
    },
    roles: {
      design: { candidates: ['d'], effort: 'high' },
      dev: { candidates: ['v'], effort: 'high' },
      review: { candidates: ['r'], effort: 'high' },
    },
    policy: { maxSwitchesPerStage: 1, networkRetries: 0, handoff: true },
    effort: { default: 'high' },
  }

  const adapterFactory = (provider) => ({
    async run({ cwd, logPath }) {
      fs.writeFileSync(logPath, 'fake\n', 'utf8')
      if (provider.adapter === 'design') {
        const dir = path.join(cwd, '.collab', 'tasks', '001')
        fs.writeFileSync(path.join(dir, 'design.md'), '---\nwrite_scope:\n  - src/**\n---\n\n# design\n', 'utf8')
        fs.writeFileSync(path.join(dir, 'acceptance.md'), '## AC-1 demo\n\n- 命令: `\'AC-1 OK\'`\n- 期望: AC-1 OK\n', 'utf8')
      } else if (provider.adapter === 'dev') {
        fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
        fs.writeFileSync(path.join(cwd, 'src', 'a.txt'), 'code\n', 'utf8')
        fs.writeFileSync(path.join(cwd, '.collab', 'tasks', '001', 'impl.md'), '# impl\n', 'utf8')
      } else {
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
        const dir = path.join(cwd, '.collab', 'tasks', '001')
        fs.writeFileSync(path.join(dir, 'review.md'), '# pass\n', 'utf8')
        fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'pass', passed: 1, total: 1, findings: [], git_sha: sha }, null, 2), 'utf8')
      }
      return { exitCode: 0, error: null }
    },
  })

  const code = await runFlow({ config, repo, taskId: '001', args: {}, runnerPath: CI_RUNNER, log: () => {}, adapterFactory })
  assert.equal(code, 0)

  const wt = path.join(repo, '.collab', 'worktrees', '001')
  const state = JSON.parse(fs.readFileSync(path.join(wt, '.collab', 'tasks', '001', 'state.json'), 'utf8'))
  assert.equal(state.status, 'pr_open')
  assert.equal(fs.existsSync(path.join(repo, '.collab', 'tasks', '001', 'state.json')), false)
  assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), 'main')

  const check = spawnSync('pwsh', ['-NoProfile', '-File', CHECK_TASK, '-RepoRoot', wt, '-TaskDir', '.collab/tasks/001'], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stdout + check.stderr)

  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo })
  fs.rmSync(repo, { recursive: true, force: true })
})
