import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createSession, decisionContentHash, confirmedEvidenceHash, evaluateG0 } from '../lib/studio.mjs'
import {
  approveBlueprint, createBlueprint, materializeBlueprint, reviewBlueprint, runBlueprintStep,
} from '../lib/blueprint.mjs'
import { fixtureStdout, replyFromAdapter } from '../lib/adapters/reply.mjs'
import { runBuild, runStep } from '../lib/step.mjs'

const GRAPH = {
  schema: 'agentline.taskgraph/v1',
  milestones: [{ id: 'M1', title: 'Blueprint', user_gate: false }],
  acceptance: [
    { id: 'AC-001', text: '插件语法检查输出 AC-1 OK', levels: ['unit'] },
    { id: 'AC-002', text: '物化保留依赖与验收方向', levels: ['integration'] },
  ],
  tasks: [
    {
      id: 'T-001', milestone: 'M1', title: '控制面',
      inputs: ['docs/design/agentline-v2-baseline.md'],
      outputs: ['orchestrator/lib/blueprint.mjs'],
      depends_on: [],
      write_scope: ['orchestrator/lib/**'],
      acceptance: ['AC-001'],
      acceptance_direction: ['node --check orchestrator/lib/blueprint.mjs'],
      test_levels: ['unit'],
      user_gate: false,
    },
    {
      id: 'T-002', milestone: 'M1', title: '物化',
      inputs: ['orchestrator/lib/blueprint.mjs'],
      outputs: ['orchestrator/test/blueprint-cli.test.mjs'],
      depends_on: ['T-001'],
      write_scope: ['orchestrator/test/**'],
      acceptance: ['AC-002'],
      acceptance_direction: ['node --test orchestrator/test/blueprint-cli.test.mjs'],
      test_levels: ['integration'],
      user_gate: false,
    },
  ],
}

function responses() {
  return {
    designer: '# 设计\n\n范围：Blueprint 控制面。\n\n' + JSON.stringify({
      interfaces: '# 接口\n\nagentline blueprint\n',
      risks: '# 风险\n\n批准哈希失效\n',
      task_graph: GRAPH,
    }),
    test_architect: JSON.stringify({ strategy: '# 策略\n\n按任务层级验证。\n', blockers: [] }),
    reviewer: JSON.stringify({ verdict: 'pass', findings: [] }),
  }
}

function configObject() {
  return {
    configVersion: 1,
    collabDir: '.collab/tasks',
    providers: {
      claude: {
        source: 'anthropic', adapter: 'claude-cli', transport: 'cli', command: 'claude',
        capabilities: { readonly_mode: true },
        effort: { supported: ['high'], cap: 'high' },
        limits: { timeoutMinutes: 1 },
      },
      codex: {
        source: 'openai', adapter: 'codex-cli', transport: 'cli', command: 'codex',
        capabilities: { readonly_mode: true },
        effort: { supported: ['high'], cap: 'high' },
        limits: { timeoutMinutes: 1 },
      },
      codebuddy: {
        source: 'tencent', adapter: 'codebuddy-cli', transport: 'cli', command: 'codebuddy',
        capabilities: { readonly_mode: true },
        effort: { supported: ['high'], cap: 'high' },
        limits: { timeoutMinutes: 1 },
      },
    },
    models: {
      des: { provider: 'claude', id: 'claude-des', tier: 'top', availability: 'callable', identity: 'verified', identity_group: 'anthropic/claude-des' },
      rev: { provider: 'codex', id: 'codex-rev', tier: 'top', availability: 'callable', identity: 'verified', identity_group: 'openai/codex-rev' },
      ta: { provider: 'codebuddy', id: 'buddy-ta', tier: 'top', availability: 'callable', identity: 'verified', identity_group: 'tencent/buddy-ta' },
      'exp-b': { provider: 'codex', id: 'codex-b', tier: 'top', availability: 'callable', identity: 'verified', identity_group: 'openai/codex-b' },
      scribe: { provider: 'codebuddy', id: 'buddy-s', tier: 'advanced', availability: 'callable', identity: 'verified', identity_group: 'tencent/buddy-s' },
    },
    roles: {
      design: { candidates: ['des'], effort: 'high' },
      dev: { candidates: ['des'], effort: 'high' },
      review: { candidates: ['rev'], effort: 'high' },
    },
    studio: { roles: { expert_a: ['des'], expert_b: ['exp-b'], expert_c: ['ta'], moderator: ['des'], scribe: ['scribe'] } },
    blueprint: { roles: { designer: ['des'], reviewer: ['rev'], test_architect: ['ta'] } },
    policy: { handoff: false, networkRetries: 0, maxSwitchesPerStage: 1 },
    effort: { default: 'high' },
  }
}

function roleOf(prompt) {
  const s = String(prompt || '')
  if (s.startsWith('你是 Blueprint 的设计师')) return 'designer'
  if (s.startsWith('你是 Blueprint 的测试架构师')) return 'test_architect'
  if (s.startsWith('你是 Blueprint 的评审')) return 'reviewer'
  return 'unknown'
}

function blueprintAdapter(config) {
  const text = responses()
  return (provider) => ({
    async run({ prompt, model, logPath }) {
      const role = roleOf(prompt)
      const body = text[role]
      if (!body) return { exitCode: 1, error: 'no fixture for ' + role }
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      const stdout = fixtureStdout(provider.adapter, model, body)
      fs.writeFileSync(logPath, stdout, 'utf8')
      const parsed = replyFromAdapter(provider.adapter, stdout)
      return { exitCode: 0, stdout, text: parsed.text, modelResolved: parsed.modelResolved }
    },
  })
}

function seedStudio(repo, config) {
  const session = createSession(repo, { id: 'src', title: '来源', input: '来自 Studio 的结论' }, { config })
  const dir = path.join(repo, '.collab', 'studio', 'src')
  const decisions = [{
    id: 'D-1', title: '范围', detail: '做 P8', default: 'P8', status: 'confirmed', rounds_used: 0,
  }]
  decisions[0].confirmed_by_user = {
    kind: 'confirm', text: '确认范围', at: '2026-11-07T00:00:00.000Z', content_hash: decisionContentHash(decisions[0]),
  }
  fs.writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify(decisions, null, 2))
  fs.writeFileSync(path.join(dir, 'minutes-final.md'), '纪要：做 P8 Build。\n')
  const minutes = fs.readFileSync(path.join(dir, 'minutes-final.md'), 'utf8')
  const hash = confirmedEvidenceHash(minutes, decisions)
  for (const role of ['expert_a', 'expert_b', 'expert_c']) {
    fs.mkdirSync(path.join(dir, 'confirmations'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'confirmations', `${role}.json`), JSON.stringify({
      expert: role, verdict: 'accept', notes: '同意', model: session.roles[role].model,
      at: '2026-11-07T00:00:00.000Z', content_hash: hash,
    }))
  }
  const g0 = evaluateG0(repo, 'src')
  if (!g0.pass) throw new Error('seed G0 failed: ' + JSON.stringify(g0.failed || g0))
}

function gitInit(repo) {
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'init')
}

async function makeTask() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-src-'))
  gitInit(repo)
  const config = configObject()
  seedStudio(repo, config)
  const adapterFactory = blueprintAdapter(config)
  createBlueprint(repo, { id: 'bp', title: 'P8', input: '实现 Build 接入', fromStudio: 'src' }, { config })
  await runBlueprintStep(repo, 'bp', { config, adapterFactory, log() {} })
  await runBlueprintStep(repo, 'bp', { config, adapterFactory, log() {} })
  await reviewBlueprint(repo, 'bp', { config, adapterFactory, log() {} })
  approveBlueprint(repo, 'bp', { text: '批准 G1', channel: 'cli', now: '2026-11-07T03:00:00.000Z' })
  const made = materializeBlueprint(repo, 'bp', { now: '2026-11-07T03:00:00.000Z' })
  assert.equal(made.ok, true)
  const taskDir = path.join(repo, '.collab', 'tasks', '001')
  assert.equal(fs.existsSync(path.join(taskDir, 'origin.json')), true)
  return { repo, config, taskDir }
}

function stateText(taskDir) {
  const file = path.join(taskDir, 'state.json')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

function buildAdapter(bucket, { write = true } = {}) {
  return () => ({
    async run({ model, logPath }) {
      bucket.push(model)
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(logPath, 'build\n', 'utf8')
      if (write) {
        const dir = path.dirname(path.dirname(logPath))
        fs.writeFileSync(path.join(dir, 'design.md'), '# design\n', 'utf8')
        fs.writeFileSync(path.join(dir, 'acceptance.md'), '## AC-1 ok\n- 命令: `Write-Output \'AC-1 OK\'`\n', 'utf8')
      }
      return { exitCode: 0, modelResolved: model }
    },
  })
}

test('approved blueprint origin can run one design step', async (t) => {
  const ctx = await makeTask()
  t.after(() => fs.rmSync(ctx.repo, { recursive: true, force: true }))
  const calls = []
  const step = await runStep({
    config: ctx.config, repo: ctx.repo, taskId: '001', step: 'design',
    adapterFactory: buildAdapter(calls), log() {}, projectCfg: {},
  })
  assert.equal(step.ok, true, step.reason)
  assert.equal(step.status, 'designed')
  assert.equal(calls.length, 1)
  const run = await runBuild({
    config: ctx.config, repo: ctx.repo, taskId: '002', adapterFactory: buildAdapter(calls),
    log() {}, projectCfg: {}, maxSteps: 1, args: { inPlace: true },
  })
  assert.equal(run.ok, false)
  assert.equal(run.reason, 'step_budget_exceeded')
  assert.equal(run.status, 'designed')
  assert.equal(calls.length, 2)
})

test('unapproved, revoked and expired approvals refuse both step and run', async (t) => {
  const base = await makeTask()
  t.after(() => fs.rmSync(base.repo, { recursive: true, force: true }))
  const approvalPath = path.join(base.repo, '.collab', 'blueprint', 'bp', 'approvals.json')

  const unapproved = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-src-'))
  fs.cpSync(base.repo, unapproved, { recursive: true })
  t.after(() => fs.rmSync(unapproved, { recursive: true, force: true }))
  fs.writeFileSync(approvalPath.replace(base.repo, unapproved), JSON.stringify({ schema: 'agentline.approvals/v1', items: [] }))
  const calls = []
  const before = stateText(path.join(unapproved, '.collab', 'tasks', '001'))
  const step = await runStep({
    config: base.config, repo: unapproved, taskId: '001', step: 'design',
    adapterFactory: buildAdapter(calls), log() {}, projectCfg: {},
  })
  assert.equal(step.ok, false)
  assert.equal(step.reason, 'E_APPROVAL_STALE')
  assert.equal(step.detail, 'unapproved')
  assert.equal(calls.length, 0)
  assert.equal(stateText(path.join(unapproved, '.collab', 'tasks', '001')), before)
  const ran = await runBuild({
    config: base.config, repo: unapproved, taskId: '001',
    adapterFactory: buildAdapter(calls), log() {}, projectCfg: {}, maxSteps: 3, args: { inPlace: true },
  })
  assert.equal(ran.ok, false)
  assert.equal(ran.reason, 'E_APPROVAL_STALE')
  assert.equal(calls.length, 0)

  const revokedRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-src-'))
  fs.cpSync(base.repo, revokedRepo, { recursive: true })
  t.after(() => fs.rmSync(revokedRepo, { recursive: true, force: true }))
  const revokedFile = path.join(revokedRepo, '.collab', 'blueprint', 'bp', 'approvals.json')
  const revoked = JSON.parse(fs.readFileSync(revokedFile, 'utf8'))
  revoked.items[revoked.items.length - 1].revoked_at = '2026-11-07T04:00:00.000Z'
  fs.writeFileSync(revokedFile, JSON.stringify(revoked))
  const revokedStep = await runStep({
    config: base.config, repo: revokedRepo, taskId: '001',
    adapterFactory: () => ({ async run() { calls.push('x'); return { exitCode: 0 } } }),
    log() {}, projectCfg: {},
  })
  assert.equal(revokedStep.reason, 'E_APPROVAL_REVOKED')
  assert.equal(calls.length, 0)

  const expiredRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-src-'))
  fs.cpSync(base.repo, expiredRepo, { recursive: true })
  t.after(() => fs.rmSync(expiredRepo, { recursive: true, force: true }))
  fs.appendFileSync(path.join(expiredRepo, '.collab', 'blueprint', 'bp', 'design.md'), '\n变更\n')
  const expired = await runStep({
    config: base.config, repo: expiredRepo, taskId: '001', step: 'design',
    adapterFactory: () => ({ async run() { calls.push('y'); return { exitCode: 0 } } }),
    log() {}, projectCfg: {},
  })
  assert.equal(expired.reason, 'E_APPROVAL_STALE')
  assert.equal(expired.detail, 'expired')
  assert.equal(calls.length, 0)
  assert.equal(stateText(path.join(expiredRepo, '.collab', 'tasks', '001')), null)
})

test('node edits, mapping drift, corrupt origin and legacy tasks', async (t) => {
  const base = await makeTask()
  t.after(() => fs.rmSync(base.repo, { recursive: true, force: true }))
  const calls = []
  const adapter = () => ({ async run() { calls.push('no'); return { exitCode: 0, modelResolved: 'claude-des' } } })

  const nodeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-src-'))
  fs.cpSync(base.repo, nodeRepo, { recursive: true })
  t.after(() => fs.rmSync(nodeRepo, { recursive: true, force: true }))
  const graphPath = path.join(nodeRepo, '.collab', 'blueprint', 'bp', 'task-graph.json')
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'))
  graph.tasks[0].title = '控制面已改'
  fs.writeFileSync(graphPath, JSON.stringify(graph))
  const node = await runStep({ config: base.config, repo: nodeRepo, taskId: '001', step: 'design', adapterFactory: adapter, log() {}, projectCfg: {} })
  assert.equal(node.reason, 'E_APPROVAL_STALE')
  assert.equal(node.detail, 'node')
  assert.equal(calls.length, 0)

  const mapRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-src-'))
  fs.cpSync(base.repo, mapRepo, { recursive: true })
  t.after(() => fs.rmSync(mapRepo, { recursive: true, force: true }))
  const mappedPath = path.join(mapRepo, '.collab', 'blueprint', 'bp', 'materialized.json')
  const mapped = JSON.parse(fs.readFileSync(mappedPath, 'utf8'))
  mapped.tasks.find((row) => row.task === '001').node = 'T-002'
  fs.writeFileSync(mappedPath, JSON.stringify(mapped))
  const mapping = await runBuild({
    config: base.config, repo: mapRepo, taskId: '001', adapterFactory: adapter,
    log() {}, projectCfg: {}, maxSteps: 2, args: { inPlace: true },
  })
  assert.equal(mapping.reason, 'E_APPROVAL_STALE')
  assert.equal(mapping.detail, 'mapping')
  assert.equal(calls.length, 0)

  const badRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-src-'))
  fs.cpSync(base.repo, badRepo, { recursive: true })
  t.after(() => fs.rmSync(badRepo, { recursive: true, force: true }))
  const originPath = path.join(badRepo, '.collab', 'tasks', '001', 'origin.json')
  const before = fs.readFileSync(originPath, 'utf8')
  fs.writeFileSync(originPath, '{')
  const corrupt = await runStep({ config: base.config, repo: badRepo, taskId: '001', step: 'dev', adapterFactory: adapter, log() {}, projectCfg: {} })
  assert.equal(corrupt.reason, 'origin_corrupt')
  assert.equal(calls.length, 0)
  assert.equal(stateText(path.join(badRepo, '.collab', 'tasks', '001')), null)
  fs.writeFileSync(originPath, before)
  fs.rmSync(originPath)
  const legacyCalls = []
  const legacy = await runStep({
    config: base.config, repo: badRepo, taskId: '001', step: 'design',
    adapterFactory: buildAdapter(legacyCalls), log() {}, projectCfg: {},
  })
  assert.equal(legacy.ok, true, legacy.reason)
  assert.equal(legacy.status, 'designed')
  assert.equal(legacyCalls.length, 1)
  assert.equal(calls.length, 0)
})
