import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(HERE, '..', 'agentline.mjs')

const FIXTURE = `import fs from 'node:fs'
import path from 'node:path'

const DEFAULTS = {
  expert_a: 'A 的关键判断：先锁定 P6 边界。',
  expert_b: 'B 的关键判断：把 UI 分组与角色矩阵一起交付。',
  expert_c: 'C 的关键判断：G0 必须机器可校验。',
  moderator: '汇总：分歧在于轮次与确认顺序。\\n' + JSON.stringify({
    summary: '先锁定范围与验收',
    questions: [
      { text: '范围是否只做 P6？', blocking: true, options: ['A', 'B'], default: 'A' },
      { text: '验收以 acceptance.md 为准？', blocking: true, options: ['是', '否'], default: '是' },
    ],
  }),
  scribe: '# 纪要\\n\\n范围：只做 P6。验收：acceptance.md。\\n\\n' + JSON.stringify({
    decisions: [
      { title: '范围', detail: '只做 P6', default: 'P6' },
      { title: '验收', detail: '以 acceptance.md 为准', default: 'acceptance.md' },
    ],
  }),
  confirm_a: JSON.stringify({ verdict: 'accept', notes: '同意' }),
  confirm_b: JSON.stringify({ verdict: 'accept_with_notes', notes: '补充 UI 空态' }),
  confirm_c: JSON.stringify({ verdict: 'accept', notes: '' }),
}

function roleOf(prompt) {
  const s = String(prompt || '')
  if (s.includes('现在独立确认')) {
    const m = /专家 ([ABC])/.exec(s)
    return m ? 'confirm_' + m[1].toLowerCase() : 'confirm_x'
  }
  if (s.includes('讨论的主持')) return 'moderator'
  if (s.includes('讨论的书记')) return 'scribe'
  const m = /讨论的专家 ([ABC])/.exec(s)
  return m ? 'expert_' + m[1].toLowerCase() : 'unknown'
}

export default function (provider) {
  try {
    fs.appendFileSync(process.env.STUDIO_PROVIDERS, JSON.stringify({
      adapter: (provider && provider.adapter) || null,
      options: (provider && provider.options) || {},
    }) + '\\n')
  } catch { /* ignore */ }
  return {
    async run({ prompt, logPath }) {
      const role = roleOf(prompt)
      try { fs.appendFileSync(process.env.STUDIO_CALLS, role + '\\n') } catch { /* ignore */ }
      try { fs.appendFileSync(process.env.STUDIO_PROMPTS, JSON.stringify({ role, prompt }) + '\\n') } catch { /* ignore */ }
      if (process.env.STUDIO_FAIL === role) return { exitCode: 1, error: 'fixture failure: ' + role }
      let cfg = {}
      try { cfg = JSON.parse(fs.readFileSync(process.env.STUDIO_FIXTURE, 'utf8')) } catch { cfg = {} }
      const text = (cfg.responses && cfg.responses[role]) || DEFAULTS[role] || 'ok'
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(logPath, 'fixture\\n', 'utf8')
      } catch { /* ignore */ }
      return { exitCode: 0, text }
    },
  }
}
`

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function setup() {
  const root = tmp('agentline-studio-cli-')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  const cfgDir = path.join(root, 'config')
  const base = path.join(cfgDir, 'agentline.config.json')
  const local = path.join(cfgDir, 'agentline.local.json')
  const models = path.join(cfgDir, 'agentline.models.json')
  const calls = path.join(root, 'calls.log')
  const prompts = path.join(root, 'prompts.jsonl')
  const providers = path.join(root, 'providers.jsonl')
  const fixtureCfg = path.join(root, 'fixture.json')
  const adapterModule = path.join(root, 'fixture-adapter.mjs')
  fs.writeFileSync(adapterModule, FIXTURE, 'utf8')
  fs.writeFileSync(calls, '', 'utf8')
  fs.writeFileSync(prompts, '', 'utf8')
  fs.writeFileSync(providers, '', 'utf8')
  writeJson(fixtureCfg, {})

  writeJson(base, {
    configVersion: 1,
    collabDir: '.collab/tasks',
    providers: {
      claude: {
        source: 'anthropic', adapter: 'claude-cli', transport: 'cli', command: 'claude',
        capabilities: { readonly_mode: true },
        effort: { supported: ['high'], cap: 'high' },
        limits: { timeoutMinutes: 1 },
      },
    },
    models: {
      'top-a': { provider: 'claude', id: 'top-a', tier: 'top', availability: 'callable' },
      'top-b': { provider: 'claude', id: 'top-b', tier: 'top', availability: 'callable' },
      'top-c': { provider: 'claude', id: 'top-c', tier: 'top', availability: 'callable' },
      'top-d': { provider: 'claude', id: 'top-d', tier: 'top', availability: 'callable' },
      'adv-s': { provider: 'claude', id: 'adv-s', tier: 'advanced', availability: 'callable' },
    },
    roles: {
      design: { candidates: [], effort: 'high' },
      dev: { candidates: [], effort: 'high' },
      review: { candidates: [], effort: 'high' },
    },
    studio: {
      roles: {
        expert_a: ['top-a'], expert_b: ['top-b'], expert_c: ['top-c'],
        moderator: ['top-d'], scribe: ['adv-s'],
      },
    },
    policy: { handoff: false, networkRetries: 0 },
    effort: { default: 'high' },
  })
  writeJson(models, { version: 1, generatedAt: '2026-11-06T00:00:00Z', providers: {} })

  const env = { STUDIO_CALLS: calls, STUDIO_PROMPTS: prompts, STUDIO_PROVIDERS: providers, STUDIO_FIXTURE: fixtureCfg }
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [
    CLI, 'studio', ...args,
    '--repo', repo, '--config', base, '--local', local, '--models', models,
    '--adapter-module', adapterModule,
  ], { encoding: 'utf8', env: { ...process.env, ...env, ...extraEnv } })
  const status = (id) => {
    const r = run(['status', '--id', id, '--json'])
    let json = null
    try { json = JSON.parse(r.stdout) } catch { json = null }
    return { ...r, json }
  }
  const callsList = () => fs.readFileSync(calls, 'utf8').split(/\r?\n/).filter(Boolean)
  const promptsList = () => fs.readFileSync(prompts, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  const providerLog = () => fs.readFileSync(providers, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  const sessionFile = (id) => path.join(repo, '.collab', 'studio', id, 'session.json')
  const readSession = (id) => JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'))
  const dir = (id) => path.join(repo, '.collab', 'studio', id)
  return { root, repo, base, local, models, calls, prompts, providers, fixtureCfg, run, status, callsList, promptsList, providerLog, sessionFile, readSession, dir }
}

function newSession(ctx, id) {
  const r = ctx.run(['new', '--id', id, '--title', `会话 ${id}`, '--input', '把 P6 的 Studio 控制面做出来'])
  assert.equal(r.status, 0, r.stderr || r.stdout)
}

test('studio cli: new creates a recoverable session and refuses duplicates / unsafe ids', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))

  newSession(ctx, 's1')
  const session = ctx.readSession('s1')
  assert.equal(session.status, 'running')
  assert.deepEqual(session.steps_done, [])
  assert.equal(session.input, '把 P6 的 Studio 控制面做出来')
  assert.deepEqual(Object.keys(session.roles).sort(), ['expert_a', 'expert_b', 'expert_c', 'moderator', 'scribe'])
  assert.equal(session.roles.moderator.model, 'top-d')
  assert.equal(session.roles.scribe.model, 'adv-s')
  assert.ok(fs.existsSync(path.join(ctx.dir('s1'), 'questions.json')))
  assert.ok(fs.existsSync(path.join(ctx.dir('s1'), 'decisions.json')))

  const before = fs.readFileSync(ctx.sessionFile('s1'), 'utf8')
  const dup = ctx.run(['new', '--id', 's1', '--title', 'x', '--input', 'y'])
  assert.notEqual(dup.status, 0)
  assert.match(dup.stderr, /already exists/)
  assert.equal(fs.readFileSync(ctx.sessionFile('s1'), 'utf8'), before)

  for (const bad of ['../evil', 'a/b', '..', '.', '']) {
    const r = ctx.run(['new', '--id', bad, '--title', 'x', '--input', 'y'])
    assert.notEqual(r.status, 0, `expected failure for id ${JSON.stringify(bad)}`)
  }
  assert.equal(fs.existsSync(path.join(ctx.repo, '.collab', 'evil')), false)

  const missing = ctx.status('nope')
  assert.equal(missing.status, 0)
  assert.equal(missing.json.state, 'missing')

  fs.mkdirSync(ctx.dir('blank'), { recursive: true })
  assert.equal(ctx.status('blank').json.state, 'empty')

  fs.mkdirSync(ctx.dir('broken'), { recursive: true })
  fs.writeFileSync(ctx.sessionFile('broken'), '{ not json', 'utf8')
  const broken = ctx.run(['status', '--id', 'broken'])
  assert.notEqual(broken.status, 0)
  assert.match(broken.stdout + broken.stderr, /corrupt/)
})

test('studio cli: each run performs exactly one role call and survives a restart', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))
  newSession(ctx, 's2')

  const r1 = ctx.run(['run', '--id', 's2'])
  assert.equal(r1.status, 0, r1.stderr || r1.stdout)
  assert.equal(ctx.callsList().length, 1)
  assert.equal(ctx.callsList()[0], 'expert_a')
  assert.deepEqual(ctx.readSession('s2').steps_done, ['expert_a'])
  assert.deepEqual(ctx.readSession('s2').outputs.expert_a, 'A 的关键判断：先锁定 P6 边界。')

  // 新进程（重启）只从落盘状态恢复
  const st = ctx.status('s2')
  assert.equal(st.json.state, 'ok')
  assert.deepEqual(st.json.session.steps_done, ['expert_a'])

  const r2 = ctx.run(['run', '--id', 's2'])
  assert.equal(r2.status, 0, r2.stderr || r2.stdout)
  assert.equal(ctx.callsList().length, 2)
  assert.deepEqual(ctx.readSession('s2').steps_done, ['expert_a', 'expert_b'])

  // 失败不推进
  ctx.run(['run', '--id', 's2'])
  assert.deepEqual(ctx.readSession('s2').steps_done, ['expert_a', 'expert_b', 'expert_c'])
  const failing = ctx.run(['run', '--id', 's2'], { STUDIO_FAIL: 'moderator' })
  assert.notEqual(failing.status, 0)
  assert.match(failing.stderr, /moderator call failed/)
  const afterFail = ctx.readSession('s2')
  assert.deepEqual(afterFail.steps_done, ['expert_a', 'expert_b', 'expert_c'])
  assert.equal(afterFail.calls.filter((c) => c.ok === false).length, 1)
  assert.equal(afterFail.last_error.includes('moderator'), true)

  // 恢复后同一步可以继续，且不跳步
  const retry = ctx.run(['run', '--id', 's2'])
  assert.equal(retry.status, 0, retry.stderr || retry.stdout)
  assert.deepEqual(ctx.readSession('s2').steps_done, ['expert_a', 'expert_b', 'expert_c', 'moderator'])
})

test('studio cli: blocking questions stop run until every question is answered or defaulted', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))
  newSession(ctx, 's3')
  for (let i = 0; i < 4; i++) {
    const r = ctx.run(['run', '--id', 's3'])
    assert.equal(r.status, 0, r.stderr || r.stdout)
  }
  const blocked = ctx.readSession('s3')
  assert.equal(blocked.status, 'awaiting_user')
  assert.equal(blocked.steps_done.includes('scribe'), false)
  const questions = JSON.parse(fs.readFileSync(path.join(ctx.dir('s3'), 'questions.json'), 'utf8'))
  assert.equal(questions.length, 2)
  assert.deepEqual(questions.map((q) => q.status), ['open', 'open'])

  const callsBefore = ctx.callsList().length
  const skipped = ctx.run(['run', '--id', 's3'])
  assert.notEqual(skipped.status, 0)
  assert.match(skipped.stderr, /awaiting_user/)
  assert.equal(ctx.callsList().length, callsBefore)

  // 未回答的问题不能成为已确认
  const g0 = ctx.run(['conclude', '--id', 's3'])
  assert.notEqual(g0.status, 0)
  assert.match(g0.stdout, /G0\.no_open_blocking/)

  const a1 = ctx.run(['answer', '--id', 's3', '--question', questions[0].id, '--text', '只做 P6'])
  assert.equal(a1.status, 0, a1.stderr || a1.stdout)
  let qs = JSON.parse(fs.readFileSync(path.join(ctx.dir('s3'), 'questions.json'), 'utf8'))
  assert.equal(qs[0].status, 'answered')
  assert.equal(qs[0].user_action.kind, 'answer')
  assert.equal(qs[0].user_action.text, '只做 P6')
  assert.equal(qs[0].rounds_used, 1)

  const stillBlocked = ctx.run(['run', '--id', 's3'])
  assert.notEqual(stillBlocked.status, 0, '第二个阻塞问题未处理前不能继续')

  const a2 = ctx.run(['answer', '--id', 's3', '--question', questions[1].id, '--default'])
  assert.equal(a2.status, 0, a2.stderr || a2.stdout)
  qs = JSON.parse(fs.readFileSync(path.join(ctx.dir('s3'), 'questions.json'), 'utf8'))
  assert.equal(qs[1].status, 'default_adopted')
  assert.equal(qs[1].user_action.kind, 'default')
  assert.equal(qs[1].user_action.text, '是')
  assert.equal(qs[1].rounds_used, 0)

  const afterAnswers = ctx.readSession('s3')
  assert.equal(afterAnswers.status, 'running')

  const scribe = ctx.run(['run', '--id', 's3'])
  assert.equal(scribe.status, 0, scribe.stderr || scribe.stdout)
  assert.equal(ctx.readSession('s3').steps_done.includes('scribe'), true)
  assert.ok(fs.statSync(path.join(ctx.dir('s3'), 'minutes-final.md')).size > 0)
  const decisions = JSON.parse(fs.readFileSync(path.join(ctx.dir('s3'), 'decisions.json'), 'utf8'))
  assert.equal(decisions.length, 2)
  assert.equal(decisions[0].id, 'D-1')
  assert.equal(decisions.every((d) => !d.confirmed_by_user), true)
})

test('studio cli: decisions need explicit user confirmation, experts confirm independently', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))
  newSession(ctx, 's4')
  for (let i = 0; i < 4; i++) assert.equal(ctx.run(['run', '--id', 's4']).status, 0)
  const qs = JSON.parse(fs.readFileSync(path.join(ctx.dir('s4'), 'questions.json'), 'utf8'))
  for (const q of qs) assert.equal(ctx.run(['answer', '--id', 's4', '--question', q.id, '--text', '按默认']).status, 0)
  assert.equal(ctx.run(['run', '--id', 's4']).status, 0) // scribe

  const early = ctx.run(['conclude', '--id', 's4'])
  assert.notEqual(early.status, 0)
  assert.match(early.stdout, /G0\.each_decision_confirmed/)

  const c1 = ctx.run(['answer', '--id', 's4', '--decision', 'D-1', '--text', '确认只做 P6'])
  assert.equal(c1.status, 0, c1.stderr || c1.stdout)
  const c2 = ctx.run(['answer', '--id', 's4', '--decision', 'D-2', '--default'])
  assert.equal(c2.status, 0, c2.stderr || c2.stdout)
  const decisions = JSON.parse(fs.readFileSync(path.join(ctx.dir('s4'), 'decisions.json'), 'utf8'))
  assert.equal(decisions[0].confirmed_by_user.kind, 'confirm')
  assert.equal(decisions[0].confirmed_by_user.text, '确认只做 P6')
  assert.equal(decisions[1].confirmed_by_user.kind, 'default')
  assert.equal(decisions[1].status, 'default_adopted')

  // 三次独立专家确认
  for (const step of ['a', 'b', 'c']) {
    const before = ctx.callsList().length
    const r = ctx.run(['run', '--id', 's4'])
    assert.equal(r.status, 0, r.stderr || r.stdout)
    assert.equal(ctx.callsList().length, before + 1)
    assert.equal(ctx.callsList().slice(-1)[0], `confirm_${step}`)
  }
  const confDir = path.join(ctx.dir('s4'), 'confirmations')
  const files = fs.readdirSync(confDir).filter((f) => f.endsWith('.json')).sort()
  assert.deepEqual(files, ['expert_a.json', 'expert_b.json', 'expert_c.json'])
  const session = ctx.readSession('s4')
  for (const role of ['expert_a', 'expert_b', 'expert_c']) {
    const rec = JSON.parse(fs.readFileSync(path.join(confDir, `${role}.json`), 'utf8'))
    assert.equal(rec.expert, role)
    assert.equal(rec.model, session.roles[role].model)
    assert.ok(rec.at)
  }
  assert.equal(ctx.readSession('s4').status, 'ready')

  const pass = ctx.run(['conclude', '--id', 's4'])
  assert.equal(pass.status, 0, pass.stdout + pass.stderr)
  assert.match(pass.stdout, /G0 PASS/)
  assert.match(pass.stdout, /G0\.minutes_final/)
  assert.match(pass.stdout, /G0\.scribe_ne_moderator/)
  assert.equal(ctx.readSession('s4').status, 'concluded')

  // 证据缺失后重新求值必须失败（不沿用旧通过结果）
  fs.rmSync(path.join(ctx.dir('s4'), 'minutes-final.md'))
  const broken = ctx.run(['conclude', '--id', 's4'])
  assert.notEqual(broken.status, 0)
  assert.match(broken.stdout, /G0\.minutes_final/)
})

test('studio cli: round limit is explicit and refuses a third discussion round', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))
  newSession(ctx, 's5')
  for (let i = 0; i < 4; i++) assert.equal(ctx.run(['run', '--id', 's5']).status, 0)
  const qs = JSON.parse(fs.readFileSync(path.join(ctx.dir('s5'), 'questions.json'), 'utf8'))
  const q = qs[0].id
  assert.equal(ctx.run(['answer', '--id', 's5', '--question', q, '--text', '第一轮回答']).status, 0)
  const q2 = JSON.parse(fs.readFileSync(path.join(ctx.dir('s5'), 'questions.json'), 'utf8')).find((x) => x.id === q)
  assert.equal(q2.rounds_used, 1)
  // 人为把轮次推到上限，验证 CLI 不再接受第三轮讨论
  const all = JSON.parse(fs.readFileSync(path.join(ctx.dir('s5'), 'questions.json'), 'utf8'))
  const idx = all.findIndex((x) => x.id === q)
  all[idx] = { ...all[idx], rounds_used: 2, status: 'open', user_action: null }
  fs.writeFileSync(path.join(ctx.dir('s5'), 'questions.json'), JSON.stringify(all, null, 2), 'utf8')
  const limited = ctx.run(['answer', '--id', 's5', '--question', q, '--text', '第三轮讨论'])
  assert.notEqual(limited.status, 0)
  assert.match(limited.stderr, /round/)
  assert.equal(ctx.readSession('s5').status, 'awaiting_user')
})

test('studio cli: an expert reject blocks progress and must be re-confirmed independently', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))
  newSession(ctx, 's6')
  for (let i = 0; i < 4; i++) assert.equal(ctx.run(['run', '--id', 's6']).status, 0)
  const qs = JSON.parse(fs.readFileSync(path.join(ctx.dir('s6'), 'questions.json'), 'utf8'))
  for (const q of qs) assert.equal(ctx.run(['answer', '--id', 's6', '--question', q.id, '--text', '按默认']).status, 0)
  assert.equal(ctx.run(['run', '--id', 's6']).status, 0) // scribe
  assert.equal(ctx.run(['answer', '--id', 's6', '--decision', 'D-1', '--text', '确认']).status, 0)
  assert.equal(ctx.run(['answer', '--id', 's6', '--decision', 'D-2', '--default']).status, 0)
  assert.equal(ctx.run(['run', '--id', 's6']).status, 0) // confirm_a

  // 让 expert_b 拒绝
  writeJson(ctx.fixtureCfg, { responses: { confirm_b: JSON.stringify({ verdict: 'reject', notes: '范围需要收窄' }) } })
  const rejected = ctx.run(['run', '--id', 's6'])
  assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout)
  const afterReject = ctx.readSession('s6')
  assert.equal(afterReject.status, 'awaiting_user')
  // 修订后所有专家的旧确认都作废：必须各自重新独立确认
  assert.equal(afterReject.steps_done.includes('confirm_a'), false, '旧确认必须重做')
  assert.equal(afterReject.steps_done.includes('confirm_b'), false, '被拒绝的确认步骤必须重做')
  assert.equal(afterReject.steps_done.includes('confirm_c'), false, '旧确认必须重做')

  const confDir = path.join(ctx.dir('s6'), 'confirmations')
  assert.equal(fs.existsSync(path.join(confDir, 'expert_a.json')), false, '别人的旧确认被作废')
  assert.equal(JSON.parse(fs.readFileSync(path.join(confDir, 'expert_b.json'), 'utf8')).verdict, 'reject')

  const rejectQuestions = JSON.parse(fs.readFileSync(path.join(ctx.dir('s6'), 'questions.json'), 'utf8'))
  const last = rejectQuestions[rejectQuestions.length - 1]
  assert.equal(last.kind, 'expert_reject')
  assert.equal(last.status, 'open')
  assert.equal(last.expert, 'expert_b')

  // 拒绝写入一轮业务轮次，并进入纪要的修订记录
  const rejectedDecisions = JSON.parse(fs.readFileSync(path.join(ctx.dir('s6'), 'decisions.json'), 'utf8'))
  assert.deepEqual(rejectedDecisions.map((d) => d.rounds_used), [1, 1])
  const rejectMinutes = fs.readFileSync(path.join(ctx.dir('s6'), 'minutes-final.md'), 'utf8')
  assert.match(rejectMinutes, /修订记录/)
  assert.match(rejectMinutes, /范围需要收窄/)

  const blockedAgain = ctx.run(['run', '--id', 's6'])
  assert.notEqual(blockedAgain.status, 0)
  assert.match(blockedAgain.stderr, /awaiting_user/)
  const failedG0 = ctx.run(['conclude', '--id', 's6'])
  assert.notEqual(failedG0.status, 0)
  assert.match(failedG0.stdout, /G0\.experts_confirmed/)

  // 用户处理后：答复必须落盘的纪要里，也要出现在重新确认的提示词里
  assert.equal(ctx.run(['answer', '--id', 's6', '--question', last.id, '--text', '收窄到 P6']).status, 0)
  const answeredMinutes = fs.readFileSync(path.join(ctx.dir('s6'), 'minutes-final.md'), 'utf8')
  assert.match(answeredMinutes, /用户处理/)
  assert.match(answeredMinutes, /收窄到 P6/)

  writeJson(ctx.fixtureCfg, {})
  const before = ctx.callsList().length
  for (const step of ['a', 'b', 'c']) {
    assert.equal(ctx.run(['run', '--id', 's6']).status, 0)
  }
  const afterCalls = ctx.callsList()
  assert.deepEqual(afterCalls.slice(before), ['confirm_a', 'confirm_b', 'confirm_c'])

  const confirmPromptText = ctx.promptsList().filter((p) => p.role === 'confirm_b').pop()
  assert.ok(confirmPromptText, 'expert_b re-confirmed independently')
  assert.match(confirmPromptText.prompt, /收窄到 P6/, 're-confirmation sees the user answer')
  assert.match(confirmPromptText.prompt, /范围需要收窄/, 're-confirmation sees the recorded rejection')

  const record = JSON.parse(fs.readFileSync(path.join(ctx.dir('s6'), 'confirmations', 'expert_b.json'), 'utf8'))
  assert.match(record.verdict, /^accept/)
  assert.equal(record.model, ctx.readSession('s6').roles.expert_b.model)

  const pass = ctx.run(['conclude', '--id', 's6'])
  assert.equal(pass.status, 0, pass.stdout + pass.stderr)
  assert.match(pass.stdout, /G0 PASS/)
})

test('studio cli: a provider that cannot guarantee read-only refuses to start a session', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))

  const cfg = JSON.parse(fs.readFileSync(ctx.base, 'utf8'))
  cfg.providers.claude = { source: 'anthropic', adapter: 'cursor-agent', transport: 'cli', command: 'cursor' }
  fs.writeFileSync(ctx.base, JSON.stringify(cfg, null, 2), 'utf8')

  const r = ctx.run(['new', '--id', 'ro', '--title', 'x', '--input', '只读讨论'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /read-only/)
  assert.equal(fs.existsSync(ctx.dir('ro')), false, '不能创建无法保证只读的会话')
})

test('studio cli: read-only is pinned on the adapter instead of trusting a capability flag', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))

  const cfg = JSON.parse(fs.readFileSync(ctx.base, 'utf8'))
  // 声明 readonly_mode=true，但 provider.options 本身是可写的：不能因此放行。
  cfg.providers.claude = {
    source: 'openai', adapter: 'codex-cli', transport: 'cli', command: 'codex',
    capabilities: { readonly_mode: true },
    options: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
    effort: { supported: ['high'], cap: 'high' },
    limits: { timeoutMinutes: 1 },
  }
  fs.writeFileSync(ctx.base, JSON.stringify(cfg, null, 2), 'utf8')

  newSession(ctx, 'ro2')
  assert.equal(ctx.run(['run', '--id', 'ro2']).status, 0)
  const codexOpts = ctx.providerLog().pop()
  assert.equal(codexOpts.adapter, 'codex-cli')
  assert.equal(codexOpts.options.sandbox, 'read-only')
  assert.equal(codexOpts.options.approvalPolicy, 'never')

  // claude-cli：覆盖 acceptEdits，只留 Read
  cfg.providers.claude = {
    ...cfg.providers.claude,
    adapter: 'claude-cli',
    command: 'claude',
    options: { permissionMode: 'acceptEdits', allowedTools: ['Read', 'Write', 'Edit'] },
  }
  fs.writeFileSync(ctx.base, JSON.stringify(cfg, null, 2), 'utf8')
  newSession(ctx, 'ro4')
  assert.equal(ctx.run(['run', '--id', 'ro4']).status, 0)
  const claudeOpts = ctx.providerLog().pop()
  assert.equal(claudeOpts.adapter, 'claude-cli')
  assert.equal(claudeOpts.options.permissionMode, 'plan')
  assert.deepEqual(claudeOpts.options.allowedTools, ['Read'])

  // 显式声明不可只读时，即使 adapter 支持也只拒绝
  cfg.providers.claude = { ...cfg.providers.claude, capabilities: { readonly_mode: false } }
  fs.writeFileSync(ctx.base, JSON.stringify(cfg, null, 2), 'utf8')
  const refused = ctx.run(['new', '--id', 'ro5', '--title', 'x', '--input', '只读讨论'])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /read-only/)
  assert.equal(fs.existsSync(ctx.dir('ro5')), false)
})

test('studio cli: missing questions.json is an error, never "no blocking"', (t) => {
  const ctx = setup()
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }))
  newSession(ctx, 's7')
  for (let i = 0; i < 4; i++) assert.equal(ctx.run(['run', '--id', 's7']).status, 0)

  fs.rmSync(path.join(ctx.dir('s7'), 'questions.json'))

  assert.equal(ctx.status('s7').json.state, 'corrupt')
  const human = ctx.run(['status', '--id', 's7'])
  assert.notEqual(human.status, 0)
  assert.match(human.stdout + human.stderr, /corrupt/)

  const run = ctx.run(['run', '--id', 's7'])
  assert.notEqual(run.status, 0, '缺失的问题证据不能继续跑')
  const g0 = ctx.run(['conclude', '--id', 's7'])
  assert.notEqual(g0.status, 0)
  assert.match(g0.stdout, /G0\.no_open_blocking/)
})
