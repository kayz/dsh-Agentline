import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runBuild, runStep } from '../lib/step.mjs'
import { evaluateBuildGate } from '../lib/build.mjs'
import { acquireTaskLock, releaseTaskLock } from '../lib/registry.mjs'
import { readState } from '../lib/state.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.resolve(HERE, '..', 'tools', 'ci-runner.ps1')

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-exec-'))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  const taskDir = path.join(repo, '.collab', 'tasks', '001')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'brief.md'), '# brief\n', 'utf8')
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])
  return { repo, taskDir }
}

function config() {
  return {
    collabDir: '.collab/tasks',
    providers: { p: { adapter: 'fake', command: 'fake', source: 'test' } },
    models: {
      a: { provider: 'p', id: 'model-a', identity_group: 'test/model-a' },
      b: { provider: 'p', id: 'model-b', identity_group: 'test/model-b' },
    },
    roles: {
      design: { candidates: ['a'], effort: 'high' },
      dev: { candidates: ['a'], effort: 'high' },
      review: { candidates: ['b'], effort: 'high' },
    },
    policy: { maxSwitchesPerStage: 1, networkRetries: 0, handoff: false },
    effort: { default: 'high' },
    concurrency: { maxTasks: 2, wait: false, pollSeconds: 1 },
  }
}

function adapter(calls) {
  return () => ({
    async run({ model, prompt, logPath }) {
      calls.push({ model, role: String(prompt).includes('【dev】') ? 'dev' : String(prompt).includes('【review】') ? 'review' : 'design' })
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(logPath, 'ok\n', 'utf8')
      const dir = path.dirname(path.dirname(logPath))
      const repo = path.resolve(dir, '../../..')
      if (String(prompt).includes('【design】')) {
        fs.writeFileSync(path.join(dir, 'design.md'), '# design\n', 'utf8')
        fs.writeFileSync(path.join(dir, 'acceptance.md'), "## AC-1 ok\n- 命令: `Write-Output 'AC-1 OK'`\n- 期望: AC-1 OK\n", 'utf8')
      } else if (String(prompt).includes('【dev】')) {
        fs.writeFileSync(path.join(dir, 'impl.md'), '# impl\n', 'utf8')
        fs.writeFileSync(path.join(repo, 'src.txt'), 'x\n', 'utf8')
      } else if (String(prompt).includes('【review】')) {
        const sha = git(repo, ['rev-parse', 'HEAD']).trim()
        fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'pass', git_sha: sha }), 'utf8')
      }
      return { exitCode: 0, modelResolved: model }
    },
  })
}

test('one step runs one stage and does not start the next', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const calls = []
  const step = await runStep({
    config: config(), repo, taskId: '001', step: 'design', runnerPath: RUNNER,
    adapterFactory: adapter(calls), log() {}, projectCfg: {},
  })
  assert.equal(step.ok, true, step.reason)
  assert.equal(step.status, 'designed')
  assert.equal(step.next, 'dev')
  assert.equal(readState(taskDir).status, 'designed')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].role, 'design')
})

test('runBuild reaches pr_open and a failed dev step does not advance', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const calls = []
  const done = await runBuild({
    config: config(), repo, taskId: '001', runnerPath: RUNNER,
    adapterFactory: adapter(calls), log() {}, projectCfg: {}, maxSteps: 8, args: { inPlace: true },
  })
  assert.equal(done.ok, true, done.reason)
  assert.equal(done.status, 'pr_open')
  assert.equal(readState(taskDir).status, 'pr_open')
  assert.deepEqual(calls.map((c) => c.role), ['design', 'dev', 'review'])
  const gate = evaluateBuildGate(repo, taskDir, { config: config() })
  const evidence = Object.fromEntries(gate.gate.checks.map((item) => [item.id, item.evidence]))
  assert.equal(evidence['T.origin_valid'], 'legacy')
  assert.equal(evidence['T.ci_all_pass'], 'pass', JSON.stringify(evidence))
  assert.equal(evidence['T.verdict_pass'], 'pass', JSON.stringify(evidence))
  assert.equal(evidence['T.isolation'], 'pass', JSON.stringify(evidence))
  assert.equal(gate.result.pass, true, JSON.stringify(gate.gate.checks))

  const again = makeRepo()
  t.after(() => fs.rmSync(again.repo, { recursive: true, force: true }))
  fs.writeFileSync(path.join(again.taskDir, 'design.md'), '# design\n', 'utf8')
  fs.writeFileSync(path.join(again.taskDir, 'state.json'), JSON.stringify({ id: '001', status: 'designed', history: [] }))
  const failed = []
  const bad = await runStep({
    config: config(), repo: again.repo, taskId: '001', step: 'dev',
    adapterFactory: () => ({
      async run({ logPath }) {
        failed.push(1)
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(logPath, 'no\n', 'utf8')
        return { exitCode: 1, error: 'dev failed' }
      },
    }),
    log() {}, projectCfg: {},
  })
  assert.equal(bad.ok, false)
  assert.notEqual(readState(again.taskDir).status, 'implemented')
  assert.equal(readState(again.taskDir).status, 'blocked')
  assert.equal(failed.length, 1)
})

test('task lock, missing termination proof and unknown side effects do not replay', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const held = await acquireTaskLock(repo, '001')
  assert.equal(held.ok, true)
  const calls = []
  const locked = await runBuild({
    config: config(), repo, taskId: '001',
    adapterFactory: () => ({ async run() { calls.push(1); return { exitCode: 0 } } }),
    log() {}, projectCfg: {}, maxSteps: 2,
  })
  assert.equal(locked.ok, false)
  assert.equal(locked.reason, 'task_locked')
  assert.equal(calls.length, 0)
  await releaseTaskLock(repo, '001')

  fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
    id: '001', status: 'blocked', blocked_reason: 'interrupted',
    interrupted: { from: 'design' }, history: [],
  }))
  const resumed = await runBuild({
    config: config(), repo, taskId: '001',
    adapterFactory: () => ({ async run() { calls.push(1); throw new Error('replayed') } }),
    log() {}, projectCfg: {}, maxSteps: 2, args: { inPlace: true },
  })
  assert.equal(resumed.ok, false)
  assert.equal(resumed.reason, 'termination_unknown')
  assert.equal(calls.length, 0)

  const sideRepo = makeRepo()
  t.after(() => fs.rmSync(sideRepo.repo, { recursive: true, force: true }))
  fs.writeFileSync(path.join(sideRepo.taskDir, 'state.json'), JSON.stringify({
    id: '001', status: 'blocked', blocked_reason: 'interrupted', side_effects: 'unknown',
    interrupted: { from: 'dev' }, history: [],
  }))
  const side = await runBuild({
    config: config(), repo: sideRepo.repo, taskId: '001',
    adapterFactory: () => ({ async run() { calls.push('side'); return { exitCode: 0 } } }),
    log() {}, projectCfg: {}, maxSteps: 2, args: { inPlace: true },
  })
  assert.equal(side.ok, false)
  assert.equal(side.reason, 'side_effects_unknown')
  assert.equal(calls.length, 0)
  assert.equal(readState(sideRepo.taskDir).status, 'blocked')
})

test('unknown side effects are not retried or switched inside the current step', async (t) => {
  const network = makeRepo()
  t.after(() => fs.rmSync(network.repo, { recursive: true, force: true }))
  const cfg = config()
  cfg.policy.networkRetries = 2
  cfg.policy.maxSwitchesPerStage = 2
  cfg.roles.design = { candidates: ['a', 'b'], effort: 'high' }
  const calls = []
  const step = await runStep({
    config: cfg, repo: network.repo, taskId: '001', step: 'design',
    adapterFactory: () => ({
      async run({ model }) {
        calls.push(model)
        return { exitCode: 1, error: 'network error', side_effects: 'unknown' }
      },
    }),
    log() {}, projectCfg: {},
  })
  assert.equal(step.ok, false)
  assert.deepEqual(calls, ['model-a'])
  assert.equal(readState(network.taskDir).side_effects, 'unknown')
  assert.notEqual(readState(network.taskDir).status, 'designed')
  const again = await runStep({
    config: cfg, repo: network.repo, taskId: '001', step: 'design',
    adapterFactory: () => ({
      async run({ model }) {
        calls.push(model)
        return { exitCode: 0, modelResolved: model }
      },
    }),
    log() {}, projectCfg: {},
  })
  assert.equal(again.reason, 'side_effects_unknown')
  assert.deepEqual(calls, ['model-a'])

  const switched = makeRepo()
  t.after(() => fs.rmSync(switched.repo, { recursive: true, force: true }))
  const other = []
  const bad = await runStep({
    config: cfg, repo: switched.repo, taskId: '001', step: 'design',
    adapterFactory: () => ({
      async run({ model }) {
        other.push(model)
        return { exitCode: 1, error: 'compile failed', side_effects: 'unknown' }
      },
    }),
    log() {}, projectCfg: {},
  })
  assert.equal(bad.ok, false)
  assert.deepEqual(other, ['model-a'])
  assert.equal(readState(switched.taskDir).side_effects, 'unknown')
  assert.notEqual(readState(switched.taskDir).status, 'designed')
})
