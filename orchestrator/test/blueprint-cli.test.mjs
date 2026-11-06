import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createSession, decisionContentHash, confirmedEvidenceHash, evaluateG0 } from '../lib/studio.mjs'
import { canonicalHash } from '../lib/blueprint.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(HERE, '..', 'agentline.mjs')

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

function goodResponses() {
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

const ADAPTER = `import fs from 'node:fs'
import path from 'node:path'

function roleOf(prompt) {
  const s = String(prompt || '')
  if (s.startsWith('你是 Blueprint 的设计师')) return 'designer'
  if (s.startsWith('你是 Blueprint 的测试架构师')) return 'test_architect'
  if (s.startsWith('你是 Blueprint 的评审')) return 'reviewer'
  return 'unknown'
}

export default function () {
  return {
    async run({ prompt, model, logPath }) {
      const role = roleOf(prompt)
      try { fs.appendFileSync(process.env.BLUEPRINT_CALLS, role + '\\n') } catch { /* ignore */ }
      if (process.env.BLUEPRINT_FAIL === role) return { exitCode: 1, error: 'fixture failure: ' + role }
      let cfg = {}
      try { cfg = JSON.parse(fs.readFileSync(process.env.BLUEPRINT_FIXTURE, 'utf8')) } catch { cfg = {} }
      const text = cfg.responses && cfg.responses[role]
      if (!text) return { exitCode: 1, error: 'no fixture for ' + role }
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(logPath, 'fixture\\n', 'utf8')
      } catch { /* ignore */ }
      if (process.env.BLUEPRINT_NO_IDENTITY === '1') return { exitCode: 0, text, modelResolved: null }
      return { exitCode: 0, text, modelResolved: model }
    },
  }
}
`

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
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
      design: { candidates: [], effort: 'high' },
      dev: { candidates: [], effort: 'high' },
      review: { candidates: [], effort: 'high' },
    },
    studio: {
      roles: { expert_a: ['des'], expert_b: ['exp-b'], expert_c: ['ta'], moderator: ['des'], scribe: ['scribe'] },
    },
    blueprint: { roles: { designer: ['des'], reviewer: ['rev'], test_architect: ['ta'] } },
    policy: { handoff: false, networkRetries: 0 },
    effort: { default: 'high' },
  }
}

function seedStudio(repo, config) {
  const session = createSession(repo, { id: 'src', title: '来源', input: '来自 Studio 的结论' }, { config })
  const dir = path.join(repo, '.collab', 'studio', 'src')
  const decisions = [{
    id: 'D-1', title: '范围', detail: '做 P7', default: 'P7', status: 'confirmed', rounds_used: 0,
  }]
  decisions[0].confirmed_by_user = {
    kind: 'confirm', text: '确认范围', at: '2026-11-07T00:00:00.000Z', content_hash: decisionContentHash(decisions[0]),
  }
  fs.writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify(decisions, null, 2))
  fs.writeFileSync(path.join(dir, 'minutes-final.md'), '纪要：做 P7 Blueprint。\n')
  const minutes = fs.readFileSync(path.join(dir, 'minutes-final.md'), 'utf8')
  const hash = confirmedEvidenceHash(minutes, decisions)
  for (const role of ['expert_a', 'expert_b', 'expert_c']) {
    writeJson(path.join(dir, 'confirmations', `${role}.json`), {
      expert: role, verdict: 'accept', notes: '同意', model: session.roles[role].model,
      at: '2026-11-07T00:00:00.000Z', content_hash: hash,
    })
  }
  const g0 = evaluateG0(repo, 'src')
  if (!g0.pass) throw new Error('seed G0 failed: ' + JSON.stringify(g0))
  return g0
}

function setup() {
  const root = tmp('agentline-bp-cli-')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  const cfgDir = path.join(root, 'config')
  const base = path.join(cfgDir, 'agentline.config.json')
  const local = path.join(cfgDir, 'agentline.local.json')
  const models = path.join(cfgDir, 'agentline.models.json')
  const calls = path.join(root, 'calls.log')
  const fixtureCfg = path.join(root, 'fixture.json')
  const adapterModule = path.join(root, 'fixture-adapter.mjs')
  const config = configObject()
  fs.writeFileSync(adapterModule, ADAPTER, 'utf8')
  fs.writeFileSync(calls, '', 'utf8')
  writeJson(fixtureCfg, { responses: goodResponses() })
  writeJson(base, config)
  writeJson(models, { version: 1, generatedAt: '2026-11-07T00:00:00Z', providers: {} })
  seedStudio(repo, config)
  const env = { BLUEPRINT_CALLS: calls, BLUEPRINT_FIXTURE: fixtureCfg }
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [
    CLI, 'blueprint', ...args,
    '--repo', repo, '--config', base, '--local', local, '--models', models,
    '--adapter-module', adapterModule,
  ], { encoding: 'utf8', env: { ...process.env, ...env, ...extraEnv } })
  const callsList = () => fs.readFileSync(calls, 'utf8').split(/\r?\n/).filter(Boolean)
  const dir = (id) => path.join(repo, '.collab', 'blueprint', id)
  const readState = (id) => JSON.parse(fs.readFileSync(path.join(dir(id), 'state.json'), 'utf8'))
  const status = (id) => {
    const r = run(['status', '--id', id, '--json'])
    let json = null
    try { json = JSON.parse(r.stdout) } catch { json = null }
    return { ...r, json }
  }
  return { root, repo, config, run, callsList, dir, readState, status, fixtureCfg }
}

function drive(ctx, id) {
  const created = ctx.run(['new', '--id', id, '--title', 'P7', '--input', '实现 Blueprint 控制面', '--from-studio', 'src'])
  assert.equal(created.status, 0, created.stderr + created.stdout)
  for (const step of ['run', 'run', 'review']) {
    const r = ctx.run([step, '--id', id])
    assert.equal(r.status, 0, step + '\n' + r.stderr + '\n' + r.stdout)
  }
}

test('blueprint cli: six commands, safe ids, and status is read-only', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))

  const usage = ctx.run(['nope'])
  assert.notEqual(usage.status, 0)
  assert.match(usage.stderr, /new\|run\|review\|approve\|materialize\|status/)

  const empty = ctx.run(['status'])
  assert.equal(empty.status, 0, empty.stderr)
  assert.match(empty.stdout, /no blueprint sessions/)

  const created = ctx.run(['new', '--id', 'bp1', '--title', 'P7', '--input', '实现 Blueprint', '--from-studio', 'src'])
  assert.equal(created.status, 0, created.stderr)
  const state = ctx.readState('bp1')
  assert.equal(state.schema, 'agentline.blueprint/v1')
  assert.equal(state.phase, 'design')
  assert.equal(state.round.current, 1)
  assert.equal(state.round.max, 3)
  assert.equal(state.from.kind, 'studio')
  assert.equal(state.from.id, 'src')
  assert.match(state.from.gate_hash, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(Object.keys(state.roles).sort(), ['designer', 'reviewer', 'test_architect'])
  assert.ok(fs.existsSync(path.join(ctx.dir('bp1'), 'roles.lock.json')))

  const before = fs.readFileSync(path.join(ctx.dir('bp1'), 'state.json'), 'utf8')
  const dup = ctx.run(['new', '--id', 'bp1', '--input', '再次'])
  assert.notEqual(dup.status, 0)
  assert.match(dup.stderr, /already exists/)
  assert.equal(fs.readFileSync(path.join(ctx.dir('bp1'), 'state.json'), 'utf8'), before)

  for (const bad of ['../evil', 'a/b', '..', '.']) {
    const r = ctx.run(['new', '--id', bad, '--input', 'x'])
    assert.notEqual(r.status, 0, bad)
  }

  const listed = ctx.run(['status', '--json'])
  assert.equal(listed.status, 0, listed.stderr)
  const summary = JSON.parse(listed.stdout)
  assert.equal(summary.sessions.length, 1)
  assert.equal(summary.sessions[0].id, 'bp1')
  assert.equal(fs.readFileSync(path.join(ctx.dir('bp1'), 'state.json'), 'utf8'), before, 'status does not write')

  const missing = ctx.run(['status', '--id', 'missing'])
  assert.equal(missing.status, 0)
  assert.match(missing.stdout, /missing/)

  const corruptDir = path.join(ctx.repo, '.collab', 'blueprint', 'bad')
  fs.mkdirSync(corruptDir, { recursive: true })
  fs.writeFileSync(path.join(corruptDir, 'state.json'), '{', 'utf8')
  const corrupt = ctx.run(['status', '--id', 'bad'])
  assert.notEqual(corrupt.status, 0)
  assert.match(corrupt.stdout + corrupt.stderr, /corrupt/)
})

test('blueprint cli: one step at a time, review cannot skip, failure does not advance', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))

  const created = ctx.run(['new', '--id', 'step', '--input', '单步', '--from-studio', 'src'])
  assert.equal(created.status, 0, created.stderr)

  const early = ctx.run(['review', '--id', 'step'])
  assert.notEqual(early.status, 0)
  assert.match(early.stderr, /next step is review/)
  assert.deepEqual(ctx.callsList(), [])
  assert.equal(ctx.readState('step').phase, 'design')
  assert.equal(fs.existsSync(path.join(ctx.dir('step'), 'task-graph.json')), false)

  const bad = ctx.run(['run', '--id', 'step'], { BLUEPRINT_NO_IDENTITY: '1' })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /not verified/)
  assert.equal(ctx.readState('step').phase, 'design')
  assert.equal(ctx.callsList().length, 1)

  const design = ctx.run(['run', '--id', 'step'])
  assert.equal(design.status, 0, design.stderr + design.stdout)
  assert.match(design.stdout, /OK step=r1\.design/)
  assert.equal(ctx.readState('step').phase, 'testability')
  assert.ok(fs.existsSync(path.join(ctx.dir('step'), 'design.md')))
  assert.ok(fs.existsSync(path.join(ctx.dir('step'), 'task-graph.json')))

  const failed = ctx.run(['run', '--id', 'step'], { BLUEPRINT_FAIL: 'test_architect' })
  assert.notEqual(failed.status, 0)
  assert.equal(ctx.readState('step').phase, 'testability')
  assert.equal(ctx.readState('step').round.current, 1)
  assert.equal(fs.existsSync(path.join(ctx.dir('step'), 'testability.json')), false)

  const again = ctx.run(['run', '--id', 'step'])
  assert.equal(again.status, 0, again.stderr + again.stdout)
  assert.match(again.stdout, /OK step=r1\.testability/)
  assert.equal(ctx.readState('step').phase, 'review')

  const reviewed = ctx.run(['review', '--id', 'step'])
  assert.equal(reviewed.status, 0, reviewed.stderr + reviewed.stdout)
  assert.match(reviewed.stdout, /OK step=r1\.review/)
  assert.equal(ctx.readState('step').awaiting.kind, 'gate_approval')
  assert.ok(fs.existsSync(path.join(ctx.dir('step'), 'review-v1.verdict.json')))
  assert.deepEqual(ctx.callsList(), ['designer', 'designer', 'test_architect', 'test_architect', 'reviewer'])

  const stopped = ctx.run(['run', '--id', 'step'])
  assert.notEqual(stopped.status, 0)
  assert.match(stopped.stderr, /approve/)
  assert.equal(ctx.callsList().length, 5, 'a stopped command does not call a model')
})

test('blueprint cli: run can execute review, invalid output does not advance, restart resumes', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))
  writeJson(ctx.fixtureCfg, { responses: { ...goodResponses(), designer: '不是 JSON' } })
  assert.equal(ctx.run(['new', '--id', 'resume', '--input', '恢复', '--from-studio', 'src']).status, 0)
  const invalid = ctx.run(['run', '--id', 'resume'])
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /not advanced|valid task-graph|missing design/)
  assert.equal(ctx.readState('resume').phase, 'design')
  assert.equal(fs.existsSync(path.join(ctx.dir('resume'), 'task-graph.json')), false)

  writeJson(ctx.fixtureCfg, { responses: goodResponses() })
  assert.equal(ctx.run(['run', '--id', 'resume']).status, 0)
  assert.equal(ctx.readState('resume').phase, 'testability')
  assert.equal(ctx.run(['run', '--id', 'resume']).status, 0)
  const reviewByRun = ctx.run(['run', '--id', 'resume'])
  assert.equal(reviewByRun.status, 0, reviewByRun.stderr)
  assert.match(reviewByRun.stdout, /OK step=r1\.review/)
  assert.equal(ctx.readState('resume').phase, 'review')
})

test('blueprint cli: approval goes stale, re-approve, then materialize keeps fidelity and does not duplicate', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))
  drive(ctx, 'mat')

  const tooSoon = ctx.run(['materialize', '--id', 'mat'])
  assert.notEqual(tooSoon.status, 0)
  assert.match(tooSoon.stderr, /approve|not ready|stale/)
  assert.equal(fs.existsSync(path.join(ctx.repo, '.collab', 'tasks', '001')), false)

  const approved = ctx.run(['approve', '--id', 'mat', '--text', '批准这一版任务图'])
  assert.equal(approved.status, 0, approved.stderr + approved.stdout)
  assert.match(approved.stdout, /G1 APPROVED/)

  const lockPath = path.join(ctx.dir('mat'), 'roles.lock.json')
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  lock.locked_at = '2000-01-01T00:00:00.000Z'
  writeJson(lockPath, lock)
  const stale = ctx.run(['materialize', '--id', 'mat'])
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /stale/)
  assert.equal(fs.existsSync(path.join(ctx.repo, '.collab', 'tasks', '001')), false)

  const again = ctx.run(['approve', '--id', 'mat', '--text', '内容变了，重新批准'])
  assert.equal(again.status, 0, again.stderr + again.stdout)
  assert.match(again.stdout, /G1 APPROVED/)

  fs.mkdirSync(path.join(ctx.repo, '.collab', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(ctx.repo, '.collab', 'tasks', '001'), 'keep', 'utf8')
  const conflict = ctx.run(['materialize', '--id', 'mat'])
  assert.notEqual(conflict.status, 0)
  assert.match(conflict.stderr, /already exists|target/)
  assert.equal(fs.readFileSync(path.join(ctx.repo, '.collab', 'tasks', '001'), 'utf8'), 'keep')
  assert.equal(fs.existsSync(path.join(ctx.repo, '.collab', 'tasks', '002')), false)
  fs.rmSync(path.join(ctx.repo, '.collab', 'tasks', '001'), { force: true })

  const done = ctx.run(['materialize', '--id', 'mat'])
  assert.equal(done.status, 0, done.stderr + done.stdout)
  assert.match(done.stdout, /materialized/)
  assert.match(done.stdout, /T-001->001/)
  assert.match(done.stdout, /T-002->002/)

  const brief = fs.readFileSync(path.join(ctx.repo, '.collab', 'tasks', '002', 'brief.md'), 'utf8')
  assert.match(brief, /## 目标/)
  assert.match(brief, /## 约束/)
  assert.match(brief, /## 建议验收方向/)
  assert.match(brief, /001（T-001）/)
  assert.match(brief, /orchestrator\/lib\/blueprint\.mjs/)
  assert.match(brief, /orchestrator\/test\/blueprint-cli\.test\.mjs/)
  assert.match(brief, /orchestrator\/test\/\*\*/)
  assert.match(brief, /物化保留依赖与验收方向/)
  assert.match(brief, /node --test orchestrator\/test\/blueprint-cli\.test\.mjs/)
  assert.match(brief, /测试层级：integration/)
  assert.doesNotMatch(brief, /^- AC-002$/m)

  const origin = JSON.parse(fs.readFileSync(path.join(ctx.repo, '.collab', 'tasks', '002', 'origin.json'), 'utf8'))
  assert.equal(origin.schema, 'agentline.origin/v1')
  assert.equal(origin.kind, 'blueprint')
  assert.equal(origin.node, 'T-002')
  assert.equal(origin.blueprint, 'mat')
  const graph = JSON.parse(fs.readFileSync(path.join(ctx.dir('mat'), 'task-graph.json'), 'utf8'))
  const node = graph.tasks.find((item) => item.id === 'T-002')
  assert.equal(origin.node_sha256, canonicalHash(node))

  const brief1 = fs.readFileSync(path.join(ctx.repo, '.collab', 'tasks', '001', 'brief.md'), 'utf8')
  assert.match(brief1, /插件语法检查输出 AC-1 OK/)
  assert.match(brief1, /orchestrator\/lib\/\*\*/)
  assert.match(brief1, /docs\/design\/agentline-v2-baseline\.md/)
  assert.match(brief1, /测试层级：unit/)

  const replay = ctx.run(['materialize', '--id', 'mat'])
  assert.equal(replay.status, 0, replay.stderr + replay.stdout)
  assert.match(replay.stdout, /replayed/)
  assert.equal(fs.existsSync(path.join(ctx.repo, '.collab', 'tasks', '003')), false)
  const ids = fs.readdirSync(path.join(ctx.repo, '.collab', 'tasks')).filter((name) => /^\d+$/.test(name)).sort()
  assert.deepEqual(ids, ['001', '002'])
})
