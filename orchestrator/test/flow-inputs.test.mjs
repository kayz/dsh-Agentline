import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runFlow } from '../lib/flow.mjs'
import { appendInput, readInputs } from '../lib/inputs.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CI_RUNNER = path.join(ROOT, 'tools', 'ci-runner.ps1')
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

test('attention pauses for a human answer, then resumes design', { skip, timeout: 60_000 }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-attn-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.mkdirSync(path.join(repo, '.collab', 'tasks', '001'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.collab', 'tasks', '001', 'brief.md'), '# brief\n', 'utf8')
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'init')

  let sawAnswer = false
  const adapterFactory = (provider) => ({
    async run({ cwd, prompt, logPath }) {
      fs.writeFileSync(logPath, 'fake\n', 'utf8')
      if (provider.adapter === 'design') {
        if (prompt.includes('[answer]')) sawAnswer = true
        const dir = path.join(cwd, '.collab', 'tasks', '001')
        fs.writeFileSync(path.join(dir, 'design.md'), '---\nwrite_scope:\n  - src/**\n---\n\n# design\n', 'utf8')
        fs.writeFileSync(path.join(dir, 'acceptance.md'), '## AC-1\n\n- 命令: `\'AC-1 OK\'`\n- 期望: AC-1 OK\n', 'utf8')
        if (!prompt.includes('[answer]')) {
          fs.writeFileSync(path.join(dir, 'attention.json'), JSON.stringify({ question: '验收口径选 A 还是 B?', options: ['A', 'B'], default: 'A' }), 'utf8')
        }
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

  const config = makeConfig()
  const first = await runFlow({ config, repo, taskId: '001', args: {}, runnerPath: CI_RUNNER, log: () => {}, adapterFactory })
  assert.equal(first, 1)
  const wt = path.join(repo, '.collab', 'worktrees', '001')
  const st1 = JSON.parse(fs.readFileSync(path.join(wt, '.collab', 'tasks', '001', 'state.json'), 'utf8'))
  assert.equal(st1.status, 'blocked')
  assert.equal(st1.blocked_reason, 'awaiting_human')

  appendInput(path.join(wt, '.collab', 'tasks', '001'), { kind: 'answer', text: '选 A' })
  const second = await runFlow({ config, repo, taskId: '001', args: { resume: true }, runnerPath: CI_RUNNER, log: () => {}, adapterFactory })
  assert.equal(second, 0)
  assert.equal(sawAnswer, true)
  const st2 = JSON.parse(fs.readFileSync(path.join(wt, '.collab', 'tasks', '001', 'state.json'), 'utf8'))
  assert.equal(st2.status, 'pr_open')
  assert.equal(readInputs(path.join(wt, '.collab', 'tasks', '001')).find((i) => i.kind === 'answer').status, 'consumed')

  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo })
  fs.rmSync(repo, { recursive: true, force: true })
})
