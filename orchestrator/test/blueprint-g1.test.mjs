import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createSession, decisionContentHash, confirmedEvidenceHash, evaluateG0 } from '../lib/studio.mjs'
import { evaluateG1, currentDigests, renderAcceptanceMatrix, sessionDir } from '../lib/blueprint.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(HERE, '..', 'agentline.mjs')
const CHECKS = [
  'G1.studio_link', 'G1.graph_schema', 'G1.graph_acyclic', 'G1.ac_bidirectional',
  'G1.task_fields_complete', 'G1.matrix_consistent', 'G1.review_pass', 'G1.rounds_within_limit',
  'G1.testability_clear', 'G1.all_top', 'G1.roles_pairwise', 'G1.designer_reviewer_vendor',
  'G1.test_arch_vendor_diverse', 'G1.identity_verified', 'G1.readonly_ok', 'G1.write_scope_overlap',
]

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
      let cfg = {}
      try { cfg = JSON.parse(fs.readFileSync(process.env.BLUEPRINT_FIXTURE, 'utf8')) } catch { cfg = {} }
      const text = cfg.responses && cfg.responses[role]
      if (!text) return { exitCode: 1, error: 'no fixture for ' + role }
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(logPath, 'fixture\\n', 'utf8')
      } catch { /* ignore */ }
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
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }

function configObject() {
  return {
    configVersion: 1,
    collabDir: '.collab/tasks',
    providers: {
      claude: { source: 'anthropic', adapter: 'claude-cli', transport: 'cli', command: 'claude', capabilities: { readonly_mode: true }, effort: { supported: ['high'], cap: 'high' }, limits: { timeoutMinutes: 1 } },
      codex: { source: 'openai', adapter: 'codex-cli', transport: 'cli', command: 'codex', capabilities: { readonly_mode: true }, effort: { supported: ['high'], cap: 'high' }, limits: { timeoutMinutes: 1 } },
      codebuddy: { source: 'tencent', adapter: 'codebuddy-cli', transport: 'cli', command: 'codebuddy', capabilities: { readonly_mode: true }, effort: { supported: ['high'], cap: 'high' }, limits: { timeoutMinutes: 1 } },
    },
    models: {
      des: { provider: 'claude', id: 'claude-des', tier: 'top', availability: 'callable', identity: 'verified', identity_group: 'anthropic/claude-des' },
      rev: { provider: 'codex', id: 'codex-rev', tier: 'top', availability: 'callable', identity: 'verified', identity_group: 'openai/codex-rev' },
      ta: { provider: 'codebuddy', id: 'buddy-ta', tier: 'top', availability: 'callable', identity: 'verified', identity_group: 'tencent/buddy-ta' },
      'exp-b': { provider: 'codex', id: 'codex-b', tier: 'top', availability: 'callable', identity: 'verified', identity_group: 'openai/codex-b' },
      scribe: { provider: 'codebuddy', id: 'buddy-s', tier: 'advanced', availability: 'callable', identity: 'verified', identity_group: 'tencent/buddy-s' },
    },
    roles: { design: { candidates: [], effort: 'high' }, dev: { candidates: [], effort: 'high' }, review: { candidates: [], effort: 'high' } },
    studio: { roles: { expert_a: ['des'], expert_b: ['exp-b'], expert_c: ['ta'], moderator: ['des'], scribe: ['scribe'] } },
    blueprint: { roles: { designer: ['des'], reviewer: ['rev'], test_architect: ['ta'] } },
    policy: { handoff: false, networkRetries: 0 },
    effort: { default: 'high' },
  }
}

function seedStudio(repo, config) {
  const session = createSession(repo, { id: 'src', title: '来源', input: '来自 Studio 的结论' }, { config })
  const dir = path.join(repo, '.collab', 'studio', 'src')
  const decisions = [{ id: 'D-1', title: '范围', detail: '做 P7', default: 'P7', status: 'confirmed', rounds_used: 0 }]
  decisions[0].confirmed_by_user = { kind: 'confirm', text: '确认范围', at: '2026-11-07T00:00:00.000Z', content_hash: decisionContentHash(decisions[0]) }
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
}

function setup() {
  const root = tmp('agentline-bp-g1-')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  const cfgDir = path.join(root, 'config')
  const base = path.join(cfgDir, 'agentline.config.json')
  const local = path.join(cfgDir, 'agentline.local.json')
  const models = path.join(cfgDir, 'agentline.models.json')
  const fixtureCfg = path.join(root, 'fixture.json')
  const adapterModule = path.join(root, 'fixture-adapter.mjs')
  const config = configObject()
  fs.writeFileSync(adapterModule, ADAPTER, 'utf8')
  writeJson(fixtureCfg, {
    responses: {
      designer: '# 设计\n\n范围：Blueprint 控制面。\n\n' + JSON.stringify({
        interfaces: '# 接口\n\nagentline blueprint\n',
        risks: '# 风险\n\n批准哈希失效\n',
        task_graph: GRAPH,
      }),
      test_architect: JSON.stringify({ strategy: '# 策略\n\n按任务层级验证。\n', blockers: [] }),
      reviewer: JSON.stringify({ verdict: 'pass', findings: [] }),
    },
  })
  writeJson(base, config)
  writeJson(models, { version: 1, generatedAt: '2026-11-07T00:00:00Z', providers: {} })
  seedStudio(repo, config)
  const run = (args) => spawnSync(process.execPath, [
    CLI, 'blueprint', ...args,
    '--repo', repo, '--config', base, '--local', local, '--models', models,
    '--adapter-module', adapterModule,
  ], { encoding: 'utf8', env: { ...process.env, BLUEPRINT_FIXTURE: fixtureCfg } })
  return { root, repo, run }
}

function drive(ctx, id, fromStudio) {
  const created = ctx.run(['new', '--id', id, '--title', 'P7', '--input', '实现 Blueprint 控制面', ...(fromStudio ? ['--from-studio', fromStudio] : [])])
  assert.equal(created.status, 0, created.stderr + created.stdout)
  for (const step of ['run', 'run', 'review']) {
    const r = ctx.run([step, '--id', id])
    assert.equal(r.status, 0, step + '\n' + r.stderr + '\n' + r.stdout)
  }
}

function check(g, id) {
  const item = (g.checks || []).find((c) => c.id === id)
  assert.ok(item, 'missing check ' + id)
  return item
}

function branch(repo, fromId, toId) {
  const dest = sessionDir(repo, toId)
  fs.cpSync(sessionDir(repo, fromId), dest, { recursive: true })
  const statePath = path.join(dest, 'state.json')
  const state = readJson(statePath)
  state.id = toId
  writeJson(statePath, state)
  return toId
}

function refresh(repo, id) {
  const digests = currentDigests(repo, id)
  const dir = sessionDir(repo, id)
  const tb = readJson(path.join(dir, 'testability.json'))
  tb.input_digests = {
    design_digest: digests.design_digest,
    graph_digest: digests.graph_digest,
    strategy_digest: digests.strategy_digest,
  }
  writeJson(path.join(dir, 'testability.json'), tb)
  const reviewPath = path.join(dir, 'review-v1.verdict.json')
  const review = readJson(reviewPath)
  review.input_digests = { ...tb.input_digests, gate_hash: digests.gate_hash }
  writeJson(reviewPath, review)
}

function graphFile(repo, id) { return path.join(sessionDir(repo, id), 'task-graph.json') }

function writeWaiver(repo, id, checkId, contentHash) {
  writeJson(path.join(sessionDir(repo, id), 'waivers.json'), [{
    check: checkId,
    by: 'user',
    at: '2026-11-07T00:00:00.000Z',
    reason: '尝试豁免',
    content_hash: contentHash,
  }])
}

test('blueprint g1: each check is judged from disk', async (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))
  drive(ctx, 'base', 'src')
  const approved = ctx.run(['approve', '--id', 'base', '--text', '批准这一版任务图'])
  assert.equal(approved.status, 0, approved.stderr + approved.stdout)

  await t.test('positive: every check passes and the approval is valid', () => {
    const listed = ctx.run(['status', '--id', 'base', '--json'])
    assert.equal(listed.status, 0, listed.stderr)
    const body = JSON.parse(listed.stdout)
    assert.equal(body.g1.pass, true)
    assert.equal(body.g1.approval_valid, true)
    assert.equal(body.state, 'ok')
    for (const id of CHECKS) assert.equal(check(body.g1, id).pass, true, id)
  })

  await t.test('missing task fields fail only task_fields_complete', () => {
    const id = branch(ctx.repo, 'base', 'fields')
    const graph = readJson(graphFile(ctx.repo, id))
    delete graph.tasks[0].inputs
    writeJson(graphFile(ctx.repo, id), graph)
    refresh(ctx.repo, id)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.task_fields_complete').pass, false)
    assert.match(check(g, 'G1.task_fields_complete').evidence, /inputs/)
    assert.equal(check(g, 'G1.review_pass').pass, true)
    assert.equal(check(g, 'G1.graph_schema').pass, true)
  })

  await t.test('dangling dependency fails graph_acyclic', () => {
    const id = branch(ctx.repo, 'base', 'dangle')
    const graph = readJson(graphFile(ctx.repo, id))
    graph.tasks[1].depends_on = ['T-999']
    writeJson(graphFile(ctx.repo, id), graph)
    refresh(ctx.repo, id)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.graph_acyclic').pass, false)
    assert.match(check(g, 'G1.graph_acyclic').evidence, /T-999/)
    assert.equal(check(g, 'G1.review_pass').pass, true)
    assert.equal(check(g, 'G1.task_fields_complete').pass, true)
  })

  await t.test('a cycle fails graph_acyclic', () => {
    const id = branch(ctx.repo, 'base', 'cycle')
    const graph = readJson(graphFile(ctx.repo, id))
    graph.tasks[0].depends_on = ['T-002']
    graph.tasks[1].depends_on = ['T-001']
    writeJson(graphFile(ctx.repo, id), graph)
    refresh(ctx.repo, id)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.graph_acyclic').pass, false)
    assert.match(check(g, 'G1.graph_acyclic').evidence, /cycle:/)
    assert.equal(check(g, 'G1.review_pass').pass, true)
  })

  await t.test('duplicate task ids fail graph_schema', () => {
    const id = branch(ctx.repo, 'base', 'dup')
    const graph = readJson(graphFile(ctx.repo, id))
    graph.tasks.push({ ...graph.tasks[0] })
    writeJson(graphFile(ctx.repo, id), graph)
    refresh(ctx.repo, id)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.graph_schema').pass, false)
    assert.match(check(g, 'G1.graph_schema').evidence, /duplicate-task/)
  })

  await t.test('an AC with no task fails bidirectional coverage while the matrix can still match', () => {
    const id = branch(ctx.repo, 'base', 'cover')
    const graph = readJson(graphFile(ctx.repo, id))
    graph.tasks[1].acceptance = []
    writeJson(graphFile(ctx.repo, id), graph)
    fs.writeFileSync(path.join(sessionDir(ctx.repo, id), 'acceptance-matrix.md'), renderAcceptanceMatrix(graph), 'utf8')
    refresh(ctx.repo, id)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.ac_bidirectional').pass, false)
    assert.match(check(g, 'G1.ac_bidirectional').evidence, /AC-002:unmapped|T-002:no-ac/)
    assert.equal(check(g, 'G1.matrix_consistent').pass, true)
    assert.equal(check(g, 'G1.review_pass').pass, true)
    assert.equal(check(g, 'G1.task_fields_complete').pass, true)
  })

  await t.test('a matrix level that disagrees with the graph fails matrix_consistent', () => {
    const id = branch(ctx.repo, 'base', 'matrix')
    const file = path.join(sessionDir(ctx.repo, id), 'acceptance-matrix.md')
    const text = fs.readFileSync(file, 'utf8').replace('| AC-001 | unit |', '| AC-001 | e2e |')
    fs.writeFileSync(file, text, 'utf8')
    refresh(ctx.repo, id)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.matrix_consistent').pass, false)
    assert.match(check(g, 'G1.matrix_consistent').evidence, /AC-001/)
    assert.equal(check(g, 'G1.review_pass').pass, true)
    assert.equal(check(g, 'G1.ac_bidirectional').pass, true)
  })

  await t.test('editing design.md without refreshing digests fails review and invalidates approval', () => {
    const id = branch(ctx.repo, 'base', 'stale')
    fs.appendFileSync(path.join(sessionDir(ctx.repo, id), 'design.md'), '\n补充一句。\n')
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.review_pass').pass, false)
    assert.match(check(g, 'G1.review_pass').evidence, /stale_evidence:design_digest/)
    assert.equal(g.approval_valid, false)
    assert.equal(g.pass, false)
  })

  await t.test('same-vendor designer and reviewer fail the vendor check only', () => {
    const id = branch(ctx.repo, 'base', 'vendor')
    const lockPath = path.join(sessionDir(ctx.repo, id), 'roles.lock.json')
    const lock = readJson(lockPath)
    lock.roles.reviewer.candidates[0].vendor = lock.roles.designer.candidates[0].vendor
    writeJson(lockPath, lock)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.designer_reviewer_vendor').pass, false)
    assert.equal(check(g, 'G1.roles_pairwise').pass, true)
    assert.equal(check(g, 'G1.review_pass').pass, true)
  })

  await t.test('a shared identity group fails pairwise isolation', () => {
    const id = branch(ctx.repo, 'base', 'pair')
    const lockPath = path.join(sessionDir(ctx.repo, id), 'roles.lock.json')
    const lock = readJson(lockPath)
    lock.roles.reviewer.candidates[0].identity_group = lock.roles.designer.candidates[0].identity_group
    writeJson(lockPath, lock)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.roles_pairwise').pass, false)
    assert.equal(check(g, 'G1.designer_reviewer_vendor').pass, true)
  })

  await t.test('an advanced test architect fails all_top', () => {
    const id = branch(ctx.repo, 'base', 'tier')
    const lockPath = path.join(sessionDir(ctx.repo, id), 'roles.lock.json')
    const lock = readJson(lockPath)
    lock.roles.test_architect.candidates[0].tier = 'advanced'
    writeJson(lockPath, lock)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.all_top').pass, false)
    assert.equal(check(g, 'G1.roles_pairwise').pass, true)
  })

  await t.test('test architect sharing a vendor is a waivable failure and does not pass G1', () => {
    const id = branch(ctx.repo, 'base', 'pref')
    const lockPath = path.join(sessionDir(ctx.repo, id), 'roles.lock.json')
    const lock = readJson(lockPath)
    lock.roles.test_architect.candidates[0].vendor = lock.roles.designer.candidates[0].vendor
    writeJson(lockPath, lock)
    const g = evaluateG1(ctx.repo, id)
    const item = check(g, 'G1.test_arch_vendor_diverse')
    assert.equal(item.pass, false)
    assert.equal(item.waivable, true)
    assert.equal(g.pass, false)
    assert.equal(check(g, 'G1.designer_reviewer_vendor').pass, true)
    assert.equal(check(g, 'G1.roles_pairwise').pass, true)
  })

  await t.test('a call without a resolved model is not identity verified', () => {
    const id = branch(ctx.repo, 'base', 'ident')
    const statePath = path.join(sessionDir(ctx.repo, id), 'state.json')
    const state = readJson(statePath)
    const call = state.calls.find((c) => c.ok && c.role === 'designer')
    assert.ok(call)
    call.model_resolved = null
    writeJson(statePath, state)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.identity_verified').pass, false)
    assert.match(check(g, 'G1.identity_verified').evidence, /designer:unverified/)
    assert.equal(check(g, 'G1.readonly_ok').pass, true)
  })

  await t.test('a completed step that was not readonly fails readonly_ok', () => {
    const id = branch(ctx.repo, 'base', 'ro')
    const statePath = path.join(sessionDir(ctx.repo, id), 'state.json')
    const state = readJson(statePath)
    const call = state.calls.find((c) => c.ok && c.role === 'reviewer')
    assert.ok(call)
    call.readonly = false
    writeJson(statePath, state)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.readonly_ok').pass, false)
    assert.equal(check(g, 'G1.identity_verified').pass, true)
  })

  await t.test('an unresolved blocking finding fails review; a resolved one does not', () => {
    const openId = branch(ctx.repo, 'base', 'block')
    const openPath = path.join(sessionDir(ctx.repo, openId), 'review-v1.verdict.json')
    const open = readJson(openPath)
    open.findings = [{ id: 'F-1', severity: 'blocking', status: 'open', text: '还没解决' }]
    writeJson(openPath, open)
    const openG = evaluateG1(ctx.repo, openId)
    assert.equal(check(openG, 'G1.review_pass').pass, false)
    assert.match(check(openG, 'G1.review_pass').evidence, /F-1/)

    const doneId = branch(ctx.repo, 'base', 'resolved')
    const donePath = path.join(sessionDir(ctx.repo, doneId), 'review-v1.verdict.json')
    const done = readJson(donePath)
    done.findings = [{ id: 'F-1', severity: 'blocking', status: 'resolved', text: '已解决' }]
    writeJson(donePath, done)
    const doneG = evaluateG1(ctx.repo, doneId)
    assert.equal(check(doneG, 'G1.review_pass').pass, true)
  })

  await t.test('an open testability blocker fails testability_clear', () => {
    const id = branch(ctx.repo, 'base', 'tb')
    const file = path.join(sessionDir(ctx.repo, id), 'testability.json')
    const tb = readJson(file)
    tb.blockers.push({ id: 'TB-1', status: 'open', text: '还不能测' })
    writeJson(file, tb)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.testability_clear').pass, false)
    assert.match(check(g, 'G1.testability_clear').evidence, /TB-1/)
    assert.equal(check(g, 'G1.review_pass').pass, true)
  })

  await t.test('a resolved blocker missing id or text stays a failed testability check', () => {
    const id = branch(ctx.repo, 'base', 'tbbad')
    const file = path.join(sessionDir(ctx.repo, id), 'testability.json')
    const tb = readJson(file)
    const digests = { ...tb.input_digests }
    tb.blockers = [{ status: 'resolved' }, { id: '   ', status: 'resolved', text: '空白编号' }, { id: 'TB-2', status: 'resolved', text: '   ' }]
    writeJson(file, tb)
    assert.deepEqual(readJson(file).input_digests, digests)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.testability_clear').pass, false)
    assert.match(check(g, 'G1.testability_clear').evidence, /blocker:invalid/)
    assert.doesNotMatch(check(g, 'G1.testability_clear').evidence, /stale_evidence/)
    assert.equal(check(g, 'G1.review_pass').pass, true)
    assert.equal(g.checks_pass, false)
    assert.equal(g.approval_valid, false)
    const approved = ctx.run(['approve', '--id', id, '--text', '坏掉的 blocker 也批准'])
    assert.notEqual(approved.status, 0)
    assert.match(approved.stderr, /G1\.testability_clear|not ready/)
    const mat = ctx.run(['materialize', '--id', id])
    assert.notEqual(mat.status, 0)
    assert.equal(fs.existsSync(path.join(ctx.repo, '.collab', 'tasks', '001', 'brief.md')), false)

    const okId = branch(ctx.repo, 'base', 'tbok')
    const okFile = path.join(sessionDir(ctx.repo, okId), 'testability.json')
    const ok = readJson(okFile)
    ok.blockers = [{ id: 'TB-9', status: 'resolved', text: '已经可测' }]
    writeJson(okFile, ok)
    const okG = evaluateG1(ctx.repo, okId)
    assert.equal(check(okG, 'G1.testability_clear').pass, true)
  })

  await t.test('a finding missing id or text is not a passing review', () => {
    const id = branch(ctx.repo, 'base', 'findbad')
    const file = path.join(sessionDir(ctx.repo, id), 'review-v1.verdict.json')
    const review = readJson(file)
    const digests = { ...review.input_digests }
    review.verdict = 'pass'
    review.findings = [
      { status: 'resolved', severity: 'blocking' },
      { id: '   ', severity: 'major', status: 'resolved', text: '空白编号' },
      { id: 'F-2', severity: 'minor', status: 'resolved', text: '   ' },
      { id: 1, severity: 'minor', status: 'resolved', text: '编号不是字符串' },
    ]
    writeJson(file, review)
    assert.deepEqual(readJson(file).input_digests, digests)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.review_pass').pass, false)
    assert.match(check(g, 'G1.review_pass').evidence, /findings:invalid/)
    assert.doesNotMatch(check(g, 'G1.review_pass').evidence, /stale_evidence/)
    assert.equal(check(g, 'G1.testability_clear').pass, true)
    assert.equal(g.checks_pass, false)
    assert.equal(g.approval_valid, false)
    const approved = ctx.run(['approve', '--id', id, '--text', '坏掉的 finding 也批准'])
    assert.notEqual(approved.status, 0)
    assert.match(approved.stderr, /G1\.review_pass|not ready/)
    const mat = ctx.run(['materialize', '--id', id])
    assert.notEqual(mat.status, 0)
    assert.equal(fs.existsSync(path.join(ctx.repo, '.collab', 'tasks', '001', 'brief.md')), false)

    const dupId = branch(ctx.repo, 'base', 'finddup')
    const dupFile = path.join(sessionDir(ctx.repo, dupId), 'review-v1.verdict.json')
    const dup = readJson(dupFile)
    dup.findings = [
      { id: 'F-1', severity: 'blocking', status: 'resolved', text: '第一条' },
      { id: 'F-1', severity: 'minor', status: 'resolved', text: '重复编号' },
    ]
    writeJson(dupFile, dup)
    const dupG = evaluateG1(ctx.repo, dupId)
    assert.equal(check(dupG, 'G1.review_pass').pass, false)
    assert.match(check(dupG, 'G1.review_pass').evidence, /findings:invalid/)
  })

  await t.test('a fourth review round fails the round limit while the latest pass can still match', () => {
    const id = branch(ctx.repo, 'base', 'rounds')
    const dir = sessionDir(ctx.repo, id)
    const review = readJson(path.join(dir, 'review-v1.verdict.json'))
    review.round = 4
    writeJson(path.join(dir, 'review-v4.verdict.json'), review)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.rounds_within_limit').pass, false)
    assert.match(check(g, 'G1.rounds_within_limit').evidence, /4/)
    assert.equal(check(g, 'G1.review_pass').pass, true)
  })

  await t.test('a task without a title fails task fields after digests are refreshed', () => {
    const id = branch(ctx.repo, 'base', 'notitle')
    const graph = readJson(graphFile(ctx.repo, id))
    delete graph.tasks[0].title
    graph.tasks[1].title = '   '
    writeJson(graphFile(ctx.repo, id), graph)
    fs.writeFileSync(path.join(sessionDir(ctx.repo, id), 'acceptance-matrix.md'), renderAcceptanceMatrix(graph), 'utf8')
    refresh(ctx.repo, id)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.task_fields_complete').pass, false)
    assert.match(check(g, 'G1.task_fields_complete').evidence, /T-001\.title/)
    assert.match(check(g, 'G1.task_fields_complete').evidence, /T-002\.title/)
    assert.equal(check(g, 'G1.graph_schema').pass, true)
    assert.equal(check(g, 'G1.ac_bidirectional').pass, true)
    assert.equal(check(g, 'G1.matrix_consistent').pass, true)
    assert.equal(check(g, 'G1.review_pass').pass, true)
    assert.equal(g.checks_pass, false)
    const approved = ctx.run(['approve', '--id', id, '--text', '无标题也批准'])
    assert.notEqual(approved.status, 0)
    assert.match(approved.stderr, /G1\.task_fields_complete|not ready/)
    const mat = ctx.run(['materialize', '--id', id])
    assert.notEqual(mat.status, 0)
    assert.equal(fs.existsSync(path.join(ctx.repo, '.collab', 'tasks', '001', 'brief.md')), false)
  })

  await t.test('an empty task graph fails schema, fields, coverage and the matrix', () => {
    const id = branch(ctx.repo, 'base', 'empty')
    const graph = readJson(graphFile(ctx.repo, id))
    graph.tasks = []
    graph.acceptance = []
    writeJson(graphFile(ctx.repo, id), graph)
    fs.writeFileSync(path.join(sessionDir(ctx.repo, id), 'acceptance-matrix.md'), renderAcceptanceMatrix(graph), 'utf8')
    refresh(ctx.repo, id)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.graph_schema').pass, false)
    assert.match(check(g, 'G1.graph_schema').evidence, /tasks:empty/)
    assert.match(check(g, 'G1.graph_schema').evidence, /acceptance:empty/)
    assert.equal(check(g, 'G1.task_fields_complete').pass, false)
    assert.match(check(g, 'G1.task_fields_complete').evidence, /tasks:empty/)
    assert.equal(check(g, 'G1.ac_bidirectional').pass, false)
    assert.match(check(g, 'G1.ac_bidirectional').evidence, /acceptance:empty|tasks:empty/)
    assert.equal(check(g, 'G1.matrix_consistent').pass, false)
    assert.match(check(g, 'G1.matrix_consistent').evidence, /matrix:empty/)
    assert.equal(check(g, 'G1.review_pass').pass, true)
    assert.equal(g.checks_pass, false)
    const approved = ctx.run(['approve', '--id', id, '--text', '空图也批准'])
    assert.notEqual(approved.status, 0)
    const mat = ctx.run(['materialize', '--id', id])
    assert.notEqual(mat.status, 0)
    assert.equal(fs.existsSync(path.join(ctx.repo, '.collab', 'tasks', '001', 'brief.md')), false)
  })

  await t.test('a stored studio hash that is not the current G0 fails studio_link only', () => {
    const id = branch(ctx.repo, 'base', 'link')
    const statePath = path.join(sessionDir(ctx.repo, id), 'state.json')
    const state = readJson(statePath)
    state.from.gate_hash = 'sha256:' + 'ab'.repeat(32)
    writeJson(statePath, state)
    const g = evaluateG1(ctx.repo, id)
    assert.equal(check(g, 'G1.studio_link').pass, false)
    assert.equal(check(g, 'G1.studio_link').waivable, false)
    assert.equal(check(g, 'G1.review_pass').pass, true)
    assert.equal(g.pass, false)
    assert.equal(g.checks_pass, false)
    assert.equal(g.approval_valid, false)
    writeWaiver(ctx.repo, id, 'G1.studio_link', g.content_hash)
    const waived = evaluateG1(ctx.repo, id)
    assert.equal(check(waived, 'G1.studio_link').pass, false)
    assert.equal(waived.pass, false)
    assert.equal(waived.checks_pass, false)
    assert.equal((waived.waived || []).includes('G1.studio_link'), false)
    assert.equal((waived.failed || []).includes('G1.studio_link'), true)
    const approved = ctx.run(['approve', '--id', id, '--text', '豁免后来源仍批准'])
    assert.notEqual(approved.status, 0)
    assert.match(approved.stderr, /G1\.studio_link|not ready/)
    const mat = ctx.run(['materialize', '--id', id])
    assert.notEqual(mat.status, 0)
    assert.equal(fs.existsSync(path.join(ctx.repo, '.collab', 'tasks', '001', 'brief.md')), false)
  })

  await t.test('a failed source G0 cannot be waived after digests are refreshed', () => {
    const id = branch(ctx.repo, 'base', 'g0fail')
    const minutesPath = path.join(ctx.repo, '.collab', 'studio', 'src', 'minutes-final.md')
    const original = fs.readFileSync(minutesPath, 'utf8')
    try {
      fs.appendFileSync(minutesPath, '\n来源纪要已改。\n')
      refresh(ctx.repo, id)
      const g = evaluateG1(ctx.repo, id)
      assert.equal(check(g, 'G1.studio_link').pass, false)
      assert.equal(check(g, 'G1.studio_link').waivable, false)
      assert.equal(check(g, 'G1.review_pass').pass, true)
      assert.equal(g.approval_valid, false)
      writeWaiver(ctx.repo, id, 'G1.studio_link', g.content_hash)
      const waived = evaluateG1(ctx.repo, id)
      assert.equal(waived.pass, false)
      assert.equal(waived.checks_pass, false)
      assert.equal((waived.failed || []).includes('G1.studio_link'), true)
      const approved = ctx.run(['approve', '--id', id, '--text', '来源坏了也批准'])
      assert.notEqual(approved.status, 0)
      assert.match(approved.stderr, /G1\.studio_link|not ready/)
      const mat = ctx.run(['materialize', '--id', id])
      assert.notEqual(mat.status, 0)
      assert.equal(fs.existsSync(path.join(ctx.repo, '.collab', 'tasks', '001', 'brief.md')), false)
    } finally {
      fs.writeFileSync(minutesPath, original)
    }
  })

  await t.test('a blueprint with no studio source cannot pass studio_link', () => {
    drive(ctx, 'solo')
    const g = evaluateG1(ctx.repo, 'solo')
    assert.equal(check(g, 'G1.studio_link').pass, false)
    assert.equal(check(g, 'G1.studio_link').waivable, false)
    assert.equal(check(g, 'G1.graph_schema').pass, true)
    assert.equal(check(g, 'G1.identity_verified').pass, true)
    assert.equal(g.pass, false)
    assert.equal(g.checks_pass, false)
    writeWaiver(ctx.repo, 'solo', 'G1.studio_link', g.content_hash)
    const waived = evaluateG1(ctx.repo, 'solo')
    assert.equal(waived.pass, false)
    assert.equal(waived.checks_pass, false)
    const approved = ctx.run(['approve', '--id', 'solo', '--text', '没有来源也批准'])
    assert.notEqual(approved.status, 0)
    assert.match(approved.stderr, /G1\.studio_link|not ready/)
  })

  await t.test('changing locked evidence invalidates the approval without failing the checks', () => {
    const id = branch(ctx.repo, 'base', 'reapprove')
    const before = evaluateG1(ctx.repo, id)
    assert.equal(before.approval_valid, true)
    assert.equal(before.pass, true)
    const lockPath = path.join(sessionDir(ctx.repo, id), 'roles.lock.json')
    const lock = readJson(lockPath)
    lock.locked_at = '2000-01-01T00:00:00.000Z'
    writeJson(lockPath, lock)
    const listed = ctx.run(['status', '--id', id, '--json'])
    assert.equal(listed.status, 0, listed.stderr)
    const g = JSON.parse(listed.stdout).g1
    assert.equal(g.approval_valid, false)
    assert.equal(g.pass, false)
    assert.equal(g.checks_pass, true)
    for (const name of CHECKS) assert.equal(check(g, name).pass, true, name)
  })
})
