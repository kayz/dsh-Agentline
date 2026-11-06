import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runStep } from '../lib/step.mjs'
import { evaluateBuildGate } from '../lib/build.mjs'
import { readState } from '../lib/state.mjs'

function git(repo, args) {
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-role-'))
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

function base() {
  return {
    collabDir: '.collab/tasks',
    providers: {
      claude: { adapter: 'fake', command: 'fake', source: 'anthropic' },
      codex: { adapter: 'fake', command: 'fake', source: 'openai' },
    },
    models: {
      a: { provider: 'claude', id: 'model-a', identity_group: 'anthropic/model-a' },
      b: { provider: 'codex', id: 'model-b', identity_group: 'openai/model-b' },
    },
    roles: {},
    policy: { maxSwitchesPerStage: 1, networkRetries: 0, handoff: false },
    effort: { default: 'high' },
  }
}

function writingAdapter(calls, mutate) {
  return () => ({
    async run(opts) {
      calls.push(opts.model)
      fs.mkdirSync(path.dirname(opts.logPath), { recursive: true })
      fs.writeFileSync(opts.logPath, 'ok\n', 'utf8')
      const dir = path.dirname(path.dirname(opts.logPath))
      fs.writeFileSync(path.join(dir, 'design.md'), '# design\n', 'utf8')
      return mutate ? mutate(opts) : { exitCode: 0, modelResolved: opts.model }
    },
  })
}

function runs(taskDir) {
  return JSON.parse(fs.readFileSync(path.join(taskDir, 'run.json'), 'utf8'))
}

test('legacy role names and new role names both execute the mapped stage', async (t) => {
  const legacy = makeRepo()
  t.after(() => fs.rmSync(legacy.repo, { recursive: true, force: true }))
  const legacyCalls = []
  const legacyCfg = base()
  legacyCfg.roles = {
    design: { candidates: ['a'], effort: 'high' },
    dev: { candidates: ['a'], effort: 'high' },
    review: { candidates: ['b'], effort: 'high' },
  }
  const old = await runStep({
    config: legacyCfg, repo: legacy.repo, taskId: '001', step: 'design',
    adapterFactory: writingAdapter(legacyCalls), log() {}, projectCfg: {},
  })
  assert.equal(old.ok, true, old.reason)
  assert.equal(old.status, 'designed')
  assert.deepEqual(legacyCalls, ['model-a'])

  const modern = makeRepo()
  t.after(() => fs.rmSync(modern.repo, { recursive: true, force: true }))
  const modernCalls = []
  const modernCfg = base()
  modernCfg.roles = {
    designer: { candidates: ['a'], effort: 'high' },
    developer: { candidates: ['a'], effort: 'high' },
    verifier: { candidates: ['b'], effort: 'high' },
  }
  const next = await runStep({
    config: modernCfg, repo: modern.repo, taskId: '001', step: 'design',
    adapterFactory: writingAdapter(modernCalls), log() {}, projectCfg: {},
  })
  assert.equal(next.ok, true, next.reason)
  assert.equal(next.status, 'designed')
  assert.deepEqual(modernCalls, ['model-a'])
  const record = runs(modern.taskDir).at(-1)
  assert.equal(record.model_resolved, 'model-a')
  assert.equal(record.model_resolved_source, 'adapter')
})

test('conflicting or missing role config is rejected without a model call', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const calls = []
  const conflict = base()
  conflict.roles = {
    design: { candidates: ['a'], effort: 'high' },
    designer: { candidates: ['b'], effort: 'high' },
  }
  const bad = await runStep({
    config: conflict, repo, taskId: '001', step: 'design',
    adapterFactory: writingAdapter(calls), log() {}, projectCfg: {},
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'role_conflict')
  assert.equal(calls.length, 0)
  assert.equal(fs.existsSync(path.join(taskDir, 'state.json')), false)

  const missing = await runStep({
    config: base(), repo, taskId: '001', step: 'design',
    adapterFactory: writingAdapter(calls), log() {}, projectCfg: {},
  })
  assert.equal(missing.reason, 'role_missing')
  assert.equal(calls.length, 0)
})

test('role lock uses the locked model, keeps real identity, and retries do not switch away', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const cfg = base()
  cfg.roles = {
    designer: { candidates: ['a'], effort: 'high' },
    developer: { candidates: ['a'], effort: 'high' },
    verifier: { candidates: ['b'], effort: 'high' },
  }
  cfg.policy.networkRetries = 1
  fs.writeFileSync(path.join(taskDir, 'roles.lock.json'), JSON.stringify({
    schema: 'agentline.roleslock/v1',
    stage: 'build',
    roles: {
      designer: { candidates: [{ key: 'a', id: 'model-a', identity_group: 'anthropic/model-a' }] },
      developer: { candidates: [{ key: 'a', id: 'model-a', identity_group: 'anthropic/model-a' }] },
      verifier: { candidates: [{ key: 'b', id: 'model-b', identity_group: 'openai/model-b' }] },
    },
  }))

  const missingCalls = []
  const unverified = await runStep({
    config: cfg, repo, taskId: '001', step: 'design',
    adapterFactory: writingAdapter(missingCalls, () => ({ exitCode: 0 })),
    log() {}, projectCfg: {},
  })
  assert.equal(unverified.ok, false)
  assert.notEqual(readState(taskDir).status, 'designed')
  assert.deepEqual(missingCalls, ['model-a'])
  const missingRecord = runs(taskDir).at(-1)
  assert.equal(missingRecord.model_resolved, null)
  assert.equal(missingRecord.model_resolved_source, 'none')
  const missingGate = evaluateBuildGate(repo, taskDir, { config: cfg })
  const missingIsolation = missingGate.gate.checks.find((item) => item.id === 'T.isolation')
  assert.equal(missingIsolation.pass, false)
  assert.equal(missingIsolation.evidence, 'unknown:identity')
  assert.equal(missingGate.result.pass, false)

  fs.rmSync(path.join(taskDir, 'state.json'))
  fs.rmSync(path.join(taskDir, 'run.json'))
  const mismatchCalls = []
  const mismatch = await runStep({
    config: cfg, repo, taskId: '001', step: 'design',
    adapterFactory: writingAdapter(mismatchCalls, () => ({ exitCode: 0, modelResolved: 'model-b' })),
    log() {}, projectCfg: {},
  })
  assert.equal(mismatch.ok, false)
  assert.notEqual(readState(taskDir).status, 'designed')
  assert.deepEqual(mismatchCalls, ['model-a'])
  assert.equal(runs(taskDir).at(-1).model_resolved, 'model-b')
  const mismatchIsolation = evaluateBuildGate(repo, taskDir, { config: cfg }).gate.checks.find((item) => item.id === 'T.isolation')
  assert.equal(mismatchIsolation.pass, false)
  assert.equal(mismatchIsolation.evidence, 'fail:mismatch')

  fs.rmSync(path.join(taskDir, 'state.json'))
  fs.rmSync(path.join(taskDir, 'run.json'))
  fs.rmSync(path.join(taskDir, 'step-ledger.jsonl'))
  let attempt = 0
  const retryCalls = []
  const retried = await runStep({
    config: cfg, repo, taskId: '001', step: 'design',
    adapterFactory: () => ({
      async run(opts) {
        retryCalls.push(opts.model)
        attempt += 1
        fs.mkdirSync(path.dirname(opts.logPath), { recursive: true })
        fs.writeFileSync(opts.logPath, 'try\n', 'utf8')
        if (attempt === 1) return { exitCode: 1, error: 'network error' }
        fs.writeFileSync(path.join(taskDir, 'design.md'), '# design\n', 'utf8')
        return { exitCode: 0, modelResolved: opts.model }
      },
    }),
    log() {}, projectCfg: {},
  })
  assert.equal(retried.ok, true, retried.reason)
  assert.equal(readState(taskDir).status, 'designed')
  assert.deepEqual(retryCalls, ['model-a', 'model-a'])
  const counters = readState(taskDir).counters
  assert.equal(counters.infra_retries, 1)
  assert.equal(counters.business_rounds, 1)
  const ledger = fs.readFileSync(path.join(taskDir, 'step-ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const physical = ledger.filter((row) => row.event === 'call' && !row.denied)
  assert.equal(physical.length, 2)
  assert.deepEqual(physical.map((row) => row.model_requested), ['model-a', 'model-a'])
  const gate = evaluateBuildGate(repo, taskDir, { config: cfg })
  const isolation = gate.gate.checks.find((item) => item.id === 'T.isolation')
  assert.notEqual(isolation.evidence, 'fail:mismatch')
  assert.equal(isolation.pass, false)
  assert.equal(runs(taskDir).at(-1).model_resolved, 'model-a')
})

test('failed and infra calls without identity do not pass isolation', (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const dev = { event: 'call', role: 'dev', model_requested: 'model-a', model_resolved: 'model-a', identity_group: 'anthropic/model-a', infra: false }
  const review = { event: 'call', role: 'review', model_requested: 'model-b', model_resolved: 'model-b', identity_group: 'openai/model-b', infra: false }
  const write = (rows) => {
    fs.writeFileSync(path.join(taskDir, 'step-ledger.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  }
  const isolation = () => evaluateBuildGate(repo, taskDir, { config: base() }).gate.checks.find((item) => item.id === 'T.isolation')

  write([
    dev,
    { event: 'call', role: 'dev', model_requested: 'model-a', infra: true, error: 'network error' },
    review,
  ])
  assert.equal(isolation().pass, false)
  assert.equal(isolation().evidence, 'unknown:identity')

  write([
    dev,
    { event: 'call', role: 'review', model_requested: 'model-b', infra: false, error: 'review failed' },
    review,
  ])
  assert.equal(isolation().pass, false)
  assert.equal(isolation().evidence, 'unknown:identity')

  write([
    dev,
    { event: 'call', role: 'dev', model_requested: 'model-a', model_resolved: 'model-a', identity_group: 'anthropic/model-a', infra: true, error: 'network error' },
    review,
  ])
  assert.equal(isolation().pass, true)
  assert.equal(isolation().evidence, 'pass')
})
