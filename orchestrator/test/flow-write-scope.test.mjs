import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runFlow } from '../lib/flow.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CI_RUNNER = path.join(path.resolve(__dirname, '..'), 'tools', 'ci-runner.ps1')
const skip = process.platform !== 'win32' || spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status !== 0

function makeConfig() {
  return {
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
}

function makeRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-scope-'))
  t.after(() => {
    try { execFileSync('git', ['worktree', 'remove', '--force', path.join(repo, '.collab', 'worktrees', '001')], { cwd: repo }) } catch { /* ignore */ }
    fs.rmSync(repo, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.mkdirSync(path.join(repo, '.collab', 'tasks', '001'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.collab', 'tasks', '001', 'brief.md'), '# brief\n', 'utf8')
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return repo
}

/** designer 首轮不写 write_scope；看到补写提示后是否补上由 fixWhenAsked 决定 */
function adapters({ fixWhenAsked, prompts }) {
  return (provider) => ({
    async run({ cwd, prompt, logPath }) {
      fs.writeFileSync(logPath, 'fake\n', 'utf8')
      const dir = path.join(cwd, '.collab', 'tasks', '001')
      if (provider.adapter === 'design') {
        prompts.push(prompt)
        const asked = prompt.includes('design.md 缺少 write_scope')
        const head = asked && fixWhenAsked ? '---\nwrite_scope:\n  - src/**\n---\n\n' : ''
        fs.writeFileSync(path.join(dir, 'design.md'), `${head}# design\n`, 'utf8')
        fs.writeFileSync(path.join(dir, 'acceptance.md'), '## AC-1\n\n- 命令: `\'AC-1 OK\'`\n- 期望: AC-1 OK\n', 'utf8')
      } else if (provider.adapter === 'dev') {
        fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
        fs.writeFileSync(path.join(cwd, 'src', 'a.txt'), 'code\n', 'utf8')
        fs.writeFileSync(path.join(dir, 'impl.md'), '# impl\n', 'utf8')
      } else {
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
        fs.writeFileSync(path.join(dir, 'review.md'), '# pass\n', 'utf8')
        fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'pass', passed: 1, total: 1, findings: [], git_sha: sha }, null, 2), 'utf8')
      }
      return { exitCode: 0, error: null }
    },
  })
}

const stateOf = (repo) => JSON.parse(fs.readFileSync(path.join(repo, '.collab', 'worktrees', '001', '.collab', 'tasks', '001', 'state.json'), 'utf8'))

test('missing write_scope: designer is asked once, then flow continues and records a low merge tier', { skip, timeout: 60_000 }, async (t) => {
  const repo = makeRepo(t)
  const prompts = []
  const code = await runFlow({ config: makeConfig(), repo, taskId: '001', args: {}, runnerPath: CI_RUNNER, log: () => {}, adapterFactory: adapters({ fixWhenAsked: true, prompts }) })
  assert.equal(code, 0)
  assert.equal(prompts.length, 2)
  const st = stateOf(repo)
  assert.equal(st.status, 'pr_open')
  assert.equal(st.merge_risk.tier, 'low', JSON.stringify(st.merge_risk))
  assert.equal(st.merge_risk.metrics.files, 1)
})

test('missing write_scope after the retry blocks the task', { skip, timeout: 60_000 }, async (t) => {
  const repo = makeRepo(t)
  const prompts = []
  const code = await runFlow({ config: makeConfig(), repo, taskId: '001', args: {}, runnerPath: CI_RUNNER, log: () => {}, adapterFactory: adapters({ fixWhenAsked: false, prompts }) })
  assert.equal(code, 1)
  assert.equal(prompts.length, 2)
  const st = stateOf(repo)
  assert.equal(st.status, 'blocked')
  assert.equal(st.blocked_reason, 'write_scope_missing')
})
