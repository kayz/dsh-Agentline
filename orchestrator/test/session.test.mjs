import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { executeRole } from '../lib/exec.mjs'
import { runStep } from '../lib/step.mjs'
import {
  readSession, writeSession, sessionFile, decideSession, extractSessionId,
  tokenRef, REASON,
} from '../lib/session.mjs'
import { ADAPTERS } from '../lib/adapters/index.mjs'

const T0 = Date.parse('2026-11-08T00:00:00.000Z')
const ISO0 = new Date(T0).toISOString()

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-session-'))
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

function configFor(overrides = {}) {
  return {
    collabDir: '.collab/tasks',
    providers: {
      p1: { adapter: 'fake', command: 'fake', source: 'test' },
      p2: { adapter: 'fake', command: 'fake', source: 'test' },
    },
    models: {
      a: { provider: 'p1', id: 'model-a' },
      b: { provider: 'p2', id: 'model-b' },
    },
    roles: {
      design: { candidates: ['a'], effort: 'high' },
      dev: { candidates: ['a'], effort: 'high' },
      review: { candidates: ['a'], effort: 'high' },
    },
    policy: { maxSwitchesPerStage: 0, networkRetries: 0, handoff: false, sessionTtlMinutes: 720 },
    effort: { default: 'high' },
    ...overrides,
  }
}

function seedSession(taskDir, role, overrides = {}) {
  const record = {
    schema: 'agentline.session/v1',
    task: '001',
    role,
    provider: 'p1',
    model_key: 'a',
    model_id: 'model-a',
    cli_version: '1.0.0',
    session_token: 'old-token',
    token_ref: tokenRef('old-token'),
    created_at: ISO0,
    last_used_at: ISO0,
    state: 'active',
    invalidated_reason: null,
    invalidated_at: null,
    last_resume_error: null,
    round: 1,
    ...overrides,
  }
  writeSession(taskDir, role, record)
  return record
}

function makeFactory({ calls, repo, taskDir, version = '1.0.0', onRun = null }) {
  return () => ({
    capabilities: {
      session_resume: true,
      session: { id_from: 'stdout_json', id_path: 'session_id' },
    },
    resumeArgs: (token) => ['--resume', String(token)],
    async version() { return version },
    async run(opts) {
      calls.push(opts)
      fs.writeFileSync(opts.logPath, 'fake\n', 'utf8')
      if (onRun) return onRun(opts, calls.length)
      fs.writeFileSync(path.join(taskDir, 'design.md'), '# design\n', 'utf8')
      fs.writeFileSync(path.join(taskDir, 'acceptance.md'), '- AC\n', 'utf8')
      fs.writeFileSync(path.join(repo, `out-${calls.length}.txt`), 'x', 'utf8')
      const sessionId = opts.resumeToken || `sess-${calls.length}`
      const stdout = JSON.stringify({ type: 'result', session_id: sessionId })
      // 真实 CLI 会把 stream-json 原样写进日志；这里模拟它，验证调用后会被清理。
      fs.appendFileSync(opts.logPath, stdout + '\n', 'utf8')
      return { exitCode: 0, error: null, stdout }
    },
  })
}

function runsOf(taskDir) {
  return JSON.parse(fs.readFileSync(path.join(taskDir, 'run.json'), 'utf8'))
}

// ── 复用路径 ─────────────────────────────────────────────────────

test('session: design 同一任务第二轮带 resume 参数并只发增量输入', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const calls = []
  const adapterFactory = makeFactory({ calls, repo, taskDir })

  const first = await executeRole({
    config: configFor(), repo, taskId: '001', role: 'design', round: 1, adapterFactory, log: () => {}, now: T0,
  })
  assert.equal(first.ok, true)
  const saved = readSession(taskDir, 'design')
  for (const field of ['role', 'provider', 'cli_version', 'session_token', 'created_at', 'last_used_at', 'state', 'invalidated_reason']) {
    assert.ok(Object.prototype.hasOwnProperty.call(saved, field), `session 记录缺少字段 ${field}`)
  }
  assert.equal(saved.state, 'active')
  assert.equal(saved.session_token, 'sess-1')
  assert.equal(saved.token_ref, tokenRef('sess-1'))

  const second = await executeRole({
    config: configFor(), repo, taskId: '001', role: 'design', round: 2,
    adapterFactory, log: () => {}, now: T0 + 60_000,
  })
  assert.equal(second.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].resumeToken, 'sess-1')
  assert.match(calls[0].prompt, /读取：/)
  assert.doesNotMatch(calls[1].prompt, /读取：/)
  assert.match(calls[1].prompt, /## 上一轮结论/)
  assert.match(calls[1].prompt, /## 本轮增量 \/ 变更点/)
  assert.match(calls[1].prompt, /design\.md（上一轮结论/)
  assert.doesNotMatch(calls[1].prompt, /都没有代码变更/, '复用时应带上一次业务 diff，而不是空占位')

  const after = readSession(taskDir, 'design')
  assert.equal(after.session_token, 'sess-1')
  assert.equal(after.created_at, saved.created_at)
  assert.notEqual(after.last_used_at, saved.last_used_at)

  const runs = runsOf(taskDir)
  assert.deepEqual(runs[0].session, { reused: false, token_ref: tokenRef('sess-1'), invalidated_reason: null })
  assert.deepEqual(runs[1].session, { reused: true, token_ref: tokenRef('sess-1'), invalidated_reason: null })

  // 明文 token 只允许出现在任务目录的 sessions/<role>.json；run.json 与日志只有哈希/***。
  const runRaw = fs.readFileSync(path.join(taskDir, 'run.json'), 'utf8')
  assert.ok(!runRaw.includes('sess-1'))
  assert.ok(runRaw.includes(tokenRef('sess-1')))
  for (const call of calls) {
    const logText = fs.readFileSync(call.logPath, 'utf8')
    assert.ok(!logText.includes('sess-1'), `日志 ${call.logPath} 不得出现明文 session id`)
    assert.match(logText, /\*\*\*/)
  }

  // 会话文件不进入 git。
  assert.equal(fs.readFileSync(path.join(taskDir, 'sessions', '.gitignore'), 'utf8').split('\n')[0], '*')
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
  assert.ok(!status.includes('sessions/design.json'))
})

// ── 六类失效条件 ─────────────────────────────────────────────────

const INVALIDATIONS = [
  { name: '模型变化', overrides: { model_id: 'model-old' }, expect: REASON.MODEL_CHANGED },
  { name: 'provider 变化', overrides: { provider: 'p2' }, expect: REASON.PROVIDER_CHANGED },
  { name: 'CLI 版本变化', overrides: { cli_version: '0.9.0' }, expect: REASON.CLI_VERSION_CHANGED },
  {
    name: '过期',
    overrides: { last_used_at: '2026-11-07T00:00:00.000Z' },
    expect: REASON.EXPIRED,
    now: Date.parse('2026-11-08T13:00:00.000Z'),
  },
  { name: '上次 resume 失败', overrides: { last_resume_error: 'exit 9' }, expect: REASON.RESUME_FAILED },
]

for (const item of INVALIDATIONS) {
  test(`session: ${item.name} → 作废旧会话并新建`, async (t) => {
    const { repo, taskDir } = makeRepo()
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
    seedSession(taskDir, 'design', item.overrides)
    const calls = []
    const adapterFactory = makeFactory({ calls, repo, taskDir })
    const now = item.now ?? T0

    const r = await executeRole({
      config: configFor(), repo, taskId: '001', role: 'design', round: 2,
      adapterFactory, log: () => {}, now,
    })
    assert.equal(r.ok, true)
    assert.equal(calls[0].resumeToken, null, '失效后不得带 resume 参数')
    assert.equal(calls[0].prompt.includes('读取：'), true, '新建会话发完整输入')

    const saved = readSession(taskDir, 'design')
    assert.notEqual(saved.session_token, 'old-token')
    assert.equal(saved.previous.at(-1).invalidated_reason, item.expect)
    assert.equal(saved.previous.at(-1).session_token_ref, tokenRef('old-token'))

    const runs = runsOf(taskDir)
    assert.deepEqual(runs.at(-1).session, {
      reused: false,
      token_ref: tokenRef(`sess-1`),
      invalidated_reason: item.expect,
    })
  })
}

test('session: review 每轮新建（第二轮命中 review_new_round）', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const calls = []
  const adapterFactory = makeFactory({ calls, repo, taskDir })

  const first = await executeRole({
    config: configFor(), repo, taskId: '001', role: 'review', round: 1,
    adapterFactory, log: () => {}, now: T0,
  })
  assert.equal(first.ok, true)
  assert.equal(calls[0].resumeToken, null)
  const firstRecord = readSession(taskDir, 'review')
  assert.equal(firstRecord.state, 'active')

  const second = await executeRole({
    config: configFor(), repo, taskId: '001', role: 'review', round: 2,
    adapterFactory, log: () => {}, now: T0 + 60_000,
  })
  assert.equal(second.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].resumeToken, null, 'review 不得复用上一轮会话')
  assert.equal(calls[1].prompt.includes('读取：'), true)

  const saved = readSession(taskDir, 'review')
  assert.notEqual(saved.session_token, firstRecord.session_token)
  assert.equal(saved.previous.at(-1).invalidated_reason, REASON.REVIEW_NEW_ROUND)

  const runs = runsOf(taskDir)
  assert.equal(runs[0].session.invalidated_reason, null)
  assert.deepEqual(runs[1].session, {
    reused: false,
    token_ref: tokenRef('sess-2'),
    invalidated_reason: REASON.REVIEW_NEW_ROUND,
  })
})

// ── 不支持 / resume 失败 ────────────────────────────────────────

test('session: 不支持的 provider 降级为新建并记录原因', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  seedSession(taskDir, 'design')
  const calls = []
  const adapterFactory = () => ({
    async run(opts) {
      calls.push(opts)
      fs.writeFileSync(opts.logPath, 'fake\n', 'utf8')
      fs.writeFileSync(path.join(taskDir, 'design.md'), '# design\n', 'utf8')
      fs.writeFileSync(path.join(repo, 'out.txt'), 'x', 'utf8')
      return { exitCode: 0, error: null, stdout: JSON.stringify({ session_id: 'ignored' }) }
    },
  })

  const r = await executeRole({
    config: configFor(), repo, taskId: '001', role: 'design', round: 2,
    adapterFactory, log: () => {}, now: T0,
  })
  assert.equal(r.ok, true)
  assert.equal(calls[0].resumeToken, null)
  assert.equal(calls[0].prompt.includes('读取：'), true)

  const runs = runsOf(taskDir)
  assert.deepEqual(runs.at(-1).session, {
    reused: false,
    token_ref: null,
    invalidated_reason: REASON.UNSUPPORTED,
  })
  // 没有实现 session 的 provider 不写会话文件，旧记录也不被冒充复用。
  assert.equal(readSession(taskDir, 'design').session_token, 'old-token')
})

test('session: resume 明确失效时当场新建会话，不假装复用成功', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  seedSession(taskDir, 'design')
  const calls = []
  const adapterFactory = makeFactory({
    calls, repo, taskDir,
    onRun: (opts, count) => {
      if (opts.resumeToken) return { exitCode: 1, error: 'session not found' }
      fs.writeFileSync(path.join(taskDir, 'design.md'), '# design\n', 'utf8')
      fs.writeFileSync(path.join(repo, `out-${count}.txt`), 'x', 'utf8')
      return { exitCode: 0, error: null, stdout: JSON.stringify({ session_id: 'sess-new' }) }
    },
  })

  const r = await executeRole({
    config: configFor(), repo, taskId: '001', role: 'design', round: 2,
    adapterFactory, log: () => {}, now: T0,
  })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].resumeToken, 'old-token')
  assert.equal(calls[1].resumeToken, null)
  assert.equal(calls[1].prompt.includes('读取：'), true, '新建会话发完整输入')

  const saved = readSession(taskDir, 'design')
  assert.equal(saved.session_token, 'sess-new')
  assert.equal(saved.previous.at(-1).invalidated_reason, REASON.RESUME_FAILED)

  const runs = runsOf(taskDir)
  assert.deepEqual(runs.at(-1).session, {
    reused: false,
    token_ref: tokenRef('sess-new'),
    invalidated_reason: REASON.RESUME_FAILED,
  })
})

// ── 纯函数 / capability 声明 ────────────────────────────────────

test('session: decideSession 覆盖六类失效条件', () => {
  const active = {
    state: 'active', session_token: 't', model_key: 'a', model_id: 'model-a',
    provider: 'p1', cli_version: '1.0.0', created_at: ISO0, last_used_at: ISO0,
  }
  const base = { role: 'design', record: active, modelKey: 'a', modelId: 'model-a', provider: 'p1', cliVersion: '1.0.0', now: T0, ttlMs: 12 * 3600_000 }
  assert.equal(decideSession(base).action, 'resume')
  assert.equal(decideSession({ ...base, modelId: 'model-b' }).reason, REASON.MODEL_CHANGED)
  assert.equal(decideSession({ ...base, provider: 'p2' }).reason, REASON.PROVIDER_CHANGED)
  assert.equal(decideSession({ ...base, cliVersion: '2.0.0' }).reason, REASON.CLI_VERSION_CHANGED)
  assert.equal(decideSession({ ...base, now: T0 + 13 * 3600_000 }).reason, REASON.EXPIRED)
  assert.equal(decideSession({ ...base, record: { ...active, last_resume_error: 'exit 1' } }).reason, REASON.RESUME_FAILED)
  assert.equal(decideSession({ ...base, role: 'review' }).reason, REASON.REVIEW_NEW_ROUND)
})

test('session: 从 claude/codebuddy/codex 输出里提取 session id', () => {
  const claude = { capabilities: { session_resume: true, session: { id_from: 'stdout_json', id_path: 'session_id' } } }
  const codex = { capabilities: { session_resume: true, session: { id_from: 'stdout_json', id_path: 'thread_id' } } }
  assert.equal(extractSessionId(claude, { stdout: '{"type":"system","subtype":"init","session_id":"s-1"}' }), 's-1')
  assert.equal(extractSessionId(codex, { stdout: '{"type":"thread.started","thread_id":"t-1"}' }), 't-1')
  assert.equal(extractSessionId(claude, { stdout: 'not json' }), null)
  assert.equal(extractSessionId({ capabilities: { session_resume: false } }, { stdout: '{"session_id":"x"}' }), null)
})

test('session: adapter 声明 session_resume 与 resumeArgs', () => {
  const claude = ADAPTERS['claude-cli']({ command: 'claude', source: 'anthropic' })
  const codex = ADAPTERS['codex-cli']({ command: 'codex', source: 'openai' })
  const codebuddy = ADAPTERS['codebuddy-cli']({ command: 'codebuddy', source: 'tencent' })
  assert.equal(claude.capabilities.session_resume, true)
  assert.deepEqual(claude.resumeArgs('s1'), ['--resume', 's1'])
  assert.equal(codex.capabilities.session_resume, true)
  assert.deepEqual(codex.resumeArgs('t1'), ['resume', 't1'])
  assert.equal(codebuddy.capabilities.session_resume, true)
  assert.deepEqual(codebuddy.resumeArgs('s2'), ['--resume', 's2'])

  for (const id of ['gemini-cli', 'cursor-agent', 'cursor-wsl', 'http-openai', 'grok-cli', 'agy-cli']) {
    const adapter = ADAPTERS[id]({ command: id, source: 'test', base_url: 'http://example.invalid' })
    assert.equal(adapter.capabilities.session_resume, false, `${id} 应显式声明不支持`)
    assert.deepEqual(adapter.resumeArgs('x'), [], `${id} 不得返回 resume 参数`)
  }
})

test('session: runStep 包装器保留 adapter 的 session capability（flow/step 共用 executeRole）', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const calls = []
  const adapterFactory = makeFactory({ calls, repo, taskDir })
  const opts = { config: configFor(), repo, taskId: '001', step: 'design', adapterFactory, log: () => {}, projectCfg: {} }

  const first = await runStep(opts)
  assert.equal(first.ok, true)
  const stateFile = path.join(taskDir, 'state.json')
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  fs.writeFileSync(stateFile, JSON.stringify({ ...st, status: 'draft' }), 'utf8')

  const second = await runStep(opts)
  assert.equal(second.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].resumeToken, 'sess-1')
  assert.equal(readSession(taskDir, 'design').session_token, 'sess-1')
})

test('session: 会话记录原子写入且路径固定在 sessions/<role>.json', (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  seedSession(taskDir, 'dev')
  assert.equal(sessionFile(taskDir, 'dev'), path.join(taskDir, 'sessions', 'dev.json'))
  assert.equal(readSession(taskDir, 'dev').session_token, 'old-token')
  assert.equal(fs.existsSync(path.join(taskDir, 'sessions', 'dev.json.tmp')), false)
  assert.equal(readSession(taskDir, 'review'), null)
})
