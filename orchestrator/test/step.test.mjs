import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runStep, nextStep, runBuild } from '../lib/step.mjs'
import { readState } from '../lib/state.mjs'

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-step-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const taskDir = path.join(repo, '.collab', 'tasks', '001')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'brief.md'), '# brief\n', 'utf8')
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { repo, taskDir }
}

function config() {
  return {
    collabDir: '.collab/tasks',
    providers: { p: { adapter: 'fake', command: 'fake', source: 'test' } },
    models: { a: { provider: 'p', id: 'model-a' } },
    roles: {
      design: { candidates: ['a'], effort: 'high' },
      dev: { candidates: ['a'], effort: 'high' },
      review: { candidates: ['a'], effort: 'high' },
    },
    policy: { maxSwitchesPerStage: 1, networkRetries: 0, handoff: false },
    effort: { default: 'high' },
  }
}

test('step: nextStep maps the Build state machine', () => {
  assert.equal(nextStep({ status: 'draft' }), 'design')
  assert.equal(nextStep({ status: 'designed' }), 'dev')
  assert.equal(nextStep({ status: 'implemented' }), 'ci')
  assert.equal(nextStep({ status: 'reviewable' }), 'review')
  assert.equal(nextStep({ status: 'reviewed' }), 'pr')
  assert.equal(nextStep({ status: 'pr_open' }), 'done')
  assert.equal(nextStep({ status: 'blocked' }), 'resume')
})

test('step: design then dev executes exactly one role each time', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const calls = []
  const adapterFactory = () => ({
    async run({ model, logPath }) {
      calls.push(model)
      fs.writeFileSync(logPath, 'fake\n', 'utf8')
      fs.writeFileSync(path.join(taskDir, 'design.md'), '# design\n', 'utf8')
      fs.writeFileSync(path.join(taskDir, 'acceptance.md'), '- AC-1\n', 'utf8')
      if (calls.length > 1) {
        fs.writeFileSync(path.join(taskDir, 'impl.md'), '# impl\n', 'utf8')
        fs.writeFileSync(path.join(repo, 'src.txt'), 'x', 'utf8')
      }
      return { exitCode: 0, error: null }
    },
  })
  const cfg = config()
  const d = await runStep({ config: cfg, repo, taskId: '001', step: 'design', adapterFactory, log: () => {}, projectCfg: {} })
  assert.equal(d.ok, true)
  assert.equal(d.status, 'designed')
  assert.equal(d.next, 'dev')
  assert.equal(readState(taskDir).status, 'designed')
  assert.equal(calls.length, 1)

  const v = await runStep({ config: cfg, repo, taskId: '001', step: 'dev', adapterFactory, log: () => {}, projectCfg: {} })
  assert.equal(v.ok, true)
  assert.equal(v.status, 'implemented')
  assert.equal(v.next, 'ci')
  assert.equal(calls.length, 2)
})

test('step: wrong step for current state is rejected without calling a model', async (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const r = await runStep({ config: config(), repo, taskId: '001', step: 'dev', adapterFactory: () => ({ run: async () => { throw new Error('must not run') } }), log: () => {}, projectCfg: {} })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'expected designed')
})

test('build: supervisor loop stops at the step budget', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  let n = 0
  const adapterFactory = () => ({
    async run({ logPath }) {
      n++
      fs.writeFileSync(logPath, 'fake\n', 'utf8')
      fs.writeFileSync(path.join(taskDir, 'design.md'), '# design\n', 'utf8')
      fs.writeFileSync(path.join(taskDir, 'acceptance.md'), '- AC-1\n', 'utf8')
      if (n > 1) {
        fs.writeFileSync(path.join(taskDir, 'impl.md'), '# impl\n', 'utf8')
        fs.writeFileSync(path.join(repo, 'src.txt'), 'x', 'utf8')
      }
      return { exitCode: 0, error: null }
    },
  })
  const r = await runBuild({ config: config(), repo, taskId: '001', adapterFactory, log: () => {}, projectCfg: {}, maxSteps: 2 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'step_budget_exceeded')
  assert.equal(r.status, 'implemented')
  assert.equal(r.steps.length, 2)
})
