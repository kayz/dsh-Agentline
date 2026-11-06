import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { evaluateG0, concludeStudio, readStudio, STEPS, decisionContentHash, confirmedEvidenceHash } from '../lib/studio.mjs'

const AT = '2026-11-06T00:00:00.000Z'

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function evidence() {
  return bindEvidence({
    session: {
      schema: 'agentline.studio/v1',
      id: 'g0',
      title: 'G0 fixture',
      input: '输入',
      status: 'ready',
      roles: {
        expert_a: { model: 'top-a', id: 'top-a', tier: 'top' },
        expert_b: { model: 'top-b', id: 'top-b', tier: 'top' },
        expert_c: { model: 'top-c', id: 'top-c', tier: 'top' },
        moderator: { model: 'top-d', id: 'top-d', tier: 'top' },
        scribe: { model: 'adv-s', id: 'adv-s', tier: 'advanced' },
      },
      steps_done: [...STEPS],
      outputs: {},
      calls: [],
      revision: 3,
      created_at: AT,
      updated_at: AT,
    },
    questions: [{
      id: 'Q-1', text: '范围？', blocking: true, status: 'answered', rounds_used: 1,
      user_action: { kind: 'answer', text: '只做 P6', at: AT, channel: 'cli' },
    }],
    decisions: [{
      id: 'D-1', title: '范围', detail: '只做 P6', default: 'P6', status: 'confirmed', rounds_used: 1,
      confirmed_by_user: { kind: 'confirm', text: '确认', at: AT, channel: 'cli' },
    }],
    confirmations: {
      expert_a: { expert: 'expert_a', verdict: 'accept', notes: '', model: 'top-a', at: AT },
      expert_b: { expert: 'expert_b', verdict: 'accept_with_notes', notes: '备注', model: 'top-b', at: AT },
      expert_c: { expert: 'expert_c', verdict: 'accept', notes: '', model: 'top-c', at: AT },
    },
    minutes: '# 纪要\n\n范围：只做 P6。\n',
  })
}

function bindEvidence(data) {
  for (const d of data.decisions) {
    if (d.confirmed_by_user && typeof d.confirmed_by_user === 'object') {
      d.confirmed_by_user.content_hash = decisionContentHash(d)
    }
  }
  const subject = confirmedEvidenceHash(data.minutes, data.decisions)
  for (const rec of Object.values(data.confirmations)) {
    if (rec && typeof rec === 'object') rec.content_hash = subject
  }
  return data
}

function makeRepo(id = 'g0') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-studio-g0-'))
  const dir = path.join(repo, '.collab', 'studio', id)
  return { repo, dir }
}

function materialize(repo, id, data) {
  const dir = path.join(repo, '.collab', 'studio', id)
  writeJson(path.join(dir, 'session.json'), data.session)
  writeJson(path.join(dir, 'questions.json'), data.questions)
  writeJson(path.join(dir, 'decisions.json'), data.decisions)
  for (const [name, rec] of Object.entries(data.confirmations)) {
    writeJson(path.join(dir, 'confirmations', `${name}.json`), rec)
  }
  fs.mkdirSync(path.join(dir, 'confirmations'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'minutes-final.md'), data.minutes, 'utf8')
  return dir
}

function check(result, id) { return result.checks.find((c) => c.id === id) }

test('g0: complete evidence passes and lists every check', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  materialize(repo, 'g0', evidence())
  const r = evaluateG0(repo, 'g0')
  assert.equal(r.status, 'pass')
  assert.equal(r.pass, true)
  assert.deepEqual(r.failed, [])
  assert.deepEqual(r.checks.map((c) => c.id), [
    'G0.minutes_final', 'G0.decisions_nonempty', 'G0.each_decision_confirmed',
    'G0.no_open_blocking', 'G0.decision_rounds_le_2', 'G0.experts_confirmed', 'G0.scribe_ne_moderator',
  ])
  assert.ok(r.content_hash.startsWith('sha256:'))
  assert.equal(r.revision, 3)
})

test('g0: removing or emptying minutes-final fails', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  materialize(repo, 'g0', evidence())
  fs.writeFileSync(path.join(repo, '.collab', 'studio', 'g0', 'minutes-final.md'), '   \n', 'utf8')
  let r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.minutes_final').pass, false)

  fs.rmSync(path.join(repo, '.collab', 'studio', 'g0', 'minutes-final.md'))
  r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.minutes_final').pass, false)
})

test('g0: decisions require a user confirm/default record', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const data = evidence()
  materialize(repo, 'g0', data)
  writeJson(path.join(repo, '.collab', 'studio', 'g0', 'decisions.json'), [
    { ...data.decisions[0], status: 'draft', confirmed_by_user: null },
  ])
  const r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.each_decision_confirmed').pass, false)
  assert.match(check(r, 'G0.each_decision_confirmed').evidence, /D-1/)
})

test('g0: no decisions at all fails', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  materialize(repo, 'g0', evidence())
  writeJson(path.join(repo, '.collab', 'studio', 'g0', 'decisions.json'), [])
  const r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.decisions_nonempty').pass, false)
  assert.equal(check(r, 'G0.each_decision_confirmed').pass, false)
})

test('g0: every expert confirmation is required', (t) => {
  for (const missing of ['expert_a', 'expert_b', 'expert_c']) {
    const { repo } = makeRepo()
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
    const data = evidence()
    materialize(repo, 'g0', data)
    fs.rmSync(path.join(repo, '.collab', 'studio', 'g0', 'confirmations', `${missing}.json`))
    const r = evaluateG0(repo, 'g0')
    assert.equal(r.pass, false, `missing ${missing} must fail`)
    assert.equal(check(r, 'G0.experts_confirmed').pass, false)
    assert.match(check(r, 'G0.experts_confirmed').evidence, new RegExp(`${missing}:missing`))
  }
})

test('g0: an expert reject blocks G0 even if other evidence is intact', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const data = evidence()
  data.confirmations.expert_b = { ...data.confirmations.expert_b, verdict: 'reject', notes: '不同意' }
  materialize(repo, 'g0', data)
  const r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.experts_confirmed').pass, false)
  assert.match(check(r, 'G0.experts_confirmed').evidence, /expert_b:reject/)
})

test('g0: open blocking questions fail, answered/defaulted ones pass', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const data = evidence()
  data.questions = [
    ...data.questions,
    { id: 'Q-2', text: '轮次？', blocking: true, status: 'open', rounds_used: 0, user_action: null },
  ]
  materialize(repo, 'g0', data)
  let r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.no_open_blocking').pass, false)
  assert.match(check(r, 'G0.no_open_blocking').evidence, /Q-2:open/)

  data.questions[1] = { ...data.questions[1], status: 'default_adopted', user_action: { kind: 'default', text: 'A', at: AT } }
  materialize(repo, 'g0', data)
  r = evaluateG0(repo, 'g0')
  assert.equal(check(r, 'G0.no_open_blocking').pass, true)
  assert.equal(r.pass, true)
})

test('g0: corrupt questions.json cannot be treated as "no blocking"', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  materialize(repo, 'g0', evidence())
  fs.writeFileSync(path.join(repo, '.collab', 'studio', 'g0', 'questions.json'), '{oops', 'utf8')
  const r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.no_open_blocking').pass, false)
})

test('g0: a missing questions.json cannot be treated as "no blocking"', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  materialize(repo, 'g0', evidence())
  fs.rmSync(path.join(repo, '.collab', 'studio', 'g0', 'questions.json'))
  const r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.no_open_blocking').pass, false)
})

test('g0: a "closed" question without a valid user action is still open', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))

  for (const patch of [
    { status: 'answered', user_action: null },
    { status: 'answered', user_action: { kind: 'answer' } },
    { status: 'answered', user_action: { kind: 'answer', text: '   ', at: AT } },
    { status: 'default_adopted', user_action: { kind: 'answer', text: 'A', at: AT } },
    { status: 'default_adopted', user_action: { kind: 'default', text: 'A' } },
  ]) {
    const data = evidence()
    data.questions = [{ ...data.questions[0], ...patch }]
    materialize(repo, 'g0', data)
    const r = evaluateG0(repo, 'g0')
    assert.equal(r.pass, false, JSON.stringify(patch))
    assert.equal(check(r, 'G0.no_open_blocking').pass, false, JSON.stringify(patch))
  }
})

test('g0: a confirmation without expert attribution or an assigned model does not count', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))

  const anonymous = evidence()
  delete anonymous.confirmations.expert_a.expert
  materialize(repo, 'g0', anonymous)
  let r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.experts_confirmed').pass, false)

  const unassigned = evidence()
  delete unassigned.session.roles.expert_a
  materialize(repo, 'g0', unassigned)
  r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false, '没有分配模型的角色无法证明独立确认')
  assert.equal(check(r, 'G0.experts_confirmed').pass, false)
})

test('g0: a missing decisions.json fails instead of reading as "no decisions"', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  materialize(repo, 'g0', evidence())
  fs.rmSync(path.join(repo, '.collab', 'studio', 'g0', 'decisions.json'))
  const r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.decisions_nonempty').pass, false)
  assert.equal(check(r, 'G0.each_decision_confirmed').pass, false)
})

test('g0: more than two business rounds fails', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const data = evidence()
  data.decisions[0] = { ...data.decisions[0], rounds_used: 3 }
  materialize(repo, 'g0', data)
  const r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.decision_rounds_le_2').pass, false)
  assert.match(check(r, 'G0.decision_rounds_le_2').evidence, /D-1/)
})

test('g0: rounds_used must be explicit, integral and within 0..2', (t) => {
  for (const patch of [
    { rounds_used: null },
    { rounds_used: '1' },
    { rounds_used: 1.5 },
    { rounds_used: -1 },
  ]) {
    const { repo } = makeRepo()
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
    const data = evidence()
    data.decisions[0] = { ...data.decisions[0], ...patch }
    materialize(repo, 'g0', data)
    const r = evaluateG0(repo, 'g0')
    assert.equal(r.pass, false, 'decision ' + JSON.stringify(patch))
    assert.equal(check(r, 'G0.decision_rounds_le_2').pass, false)
    assert.match(check(r, 'G0.decision_rounds_le_2').evidence, /D-1:invalid/)
  }

  // 缺失字段不能被当成 0
  const missing = makeRepo()
  t.after(() => fs.rmSync(missing.repo, { recursive: true, force: true }))
  const data = evidence()
  delete data.decisions[0].rounds_used
  materialize(missing.repo, 'g0', data)
  const r = evaluateG0(missing.repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.decision_rounds_le_2').pass, false)

  // 问题轮次同样是证据
  const qBad = makeRepo()
  t.after(() => fs.rmSync(qBad.repo, { recursive: true, force: true }))
  const data2 = evidence()
  data2.questions[0] = { ...data2.questions[0], rounds_used: '2' }
  materialize(qBad.repo, 'g0', data2)
  const r2 = evaluateG0(qBad.repo, 'g0')
  assert.equal(r2.pass, false)
  assert.equal(check(r2, 'G0.decision_rounds_le_2').pass, false)
  assert.match(check(r2, 'G0.decision_rounds_le_2').evidence, /Q-1:invalid/)
})

test('g0: scribe and moderator aliases of one model do not count as different', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const data = evidence()
  data.session.roles.moderator = { model: 'mod-main', id: 'shared-model', tier: 'top', provider: 'claude' }
  data.session.roles.scribe = { model: 'adv-alias', id: 'shared-model', tier: 'advanced', provider: 'claude' }
  materialize(repo, 'g0', data)
  const r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false, '同一个实际模型换了两个配置键仍然不能同时担任书记和主持')
  assert.equal(check(r, 'G0.scribe_ne_moderator').pass, false)
  assert.match(check(r, 'G0.scribe_ne_moderator').evidence, /claude:shared-model/)
})

test('g0: a corrupt confirmation file is a read error, not a missing confirmation', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  materialize(repo, 'g0', evidence())
  fs.writeFileSync(path.join(repo, '.collab', 'studio', 'g0', 'confirmations', 'expert_a.json'), '{oops', 'utf8')

  const read = readStudio(repo, 'g0')
  assert.equal(read.state, 'corrupt')
  assert.equal(read.confirmationsInvalid, true)
  assert.match(read.errors.join('; '), /confirmations\/expert_a\.json/)

  const r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.experts_confirmed').pass, false)
})

test('g0: scribe and moderator must be known and different', (t) => {
  const same = makeRepo('same')
  t.after(() => fs.rmSync(same.repo, { recursive: true, force: true }))
  const data = evidence()
  data.session.roles.scribe = { model: 'top-d', id: 'top-d', tier: 'top' }
  materialize(same.repo, 'same', data)
  let r = evaluateG0(same.repo, 'same')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.scribe_ne_moderator').pass, false)
  assert.match(check(r, 'G0.scribe_ne_moderator').evidence, /scribe=top-d moderator=top-d/)

  const missing = makeRepo('missing')
  t.after(() => fs.rmSync(missing.repo, { recursive: true, force: true }))
  const data2 = evidence()
  delete data2.session.roles.moderator
  materialize(missing.repo, 'missing', data2)
  r = evaluateG0(missing.repo, 'missing')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.scribe_ne_moderator').pass, false)
})

test('g0: changed minutes or decision text invalidates the confirmations that were bound to the old content', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const data = evidence()
  const dir = materialize(repo, 'g0', data)
  const first = concludeStudio(repo, 'g0')
  assert.equal(first.pass, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).status, 'concluded')

  const minutesFile = path.join(dir, 'minutes-final.md')
  const decisionsFile = path.join(dir, 'decisions.json')
  const confirmFile = path.join(dir, 'confirmations', 'expert_a.json')
  const originalMinutes = fs.readFileSync(minutesFile, 'utf8')
  const confirmBefore = fs.readFileSync(confirmFile, 'utf8')
  const decisionsBefore = fs.readFileSync(decisionsFile, 'utf8')

  // 纪要改成另一段非空正文，用户确认和专家确认原样保留
  fs.writeFileSync(minutesFile, originalMinutes.replace('只做 P6', '改做 P6 和 P7'), 'utf8')
  const minutesChanged = concludeStudio(repo, 'g0')
  assert.equal(minutesChanged.pass, false)
  assert.equal(check(minutesChanged, 'G0.minutes_final').pass, true, '纪要仍然非空，失败原因不是缺纪要')
  assert.equal(check(minutesChanged, 'G0.each_decision_confirmed').pass, true, '决策正文没变，用户确认仍然对应当前决策')
  assert.equal(check(minutesChanged, 'G0.experts_confirmed').pass, false)
  assert.match(check(minutesChanged, 'G0.experts_confirmed').evidence, /expert_a:stale/)
  assert.match(check(minutesChanged, 'G0.experts_confirmed').evidence, /expert_b:stale/)
  assert.match(check(minutesChanged, 'G0.experts_confirmed').evidence, /expert_c:stale/)
  assert.equal(fs.readFileSync(confirmFile, 'utf8'), confirmBefore, 'conclude 不改写专家确认')
  assert.equal(fs.readFileSync(decisionsFile, 'utf8'), decisionsBefore, 'conclude 不改写用户确认')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).status, 'awaiting_user')

  // 纪要恢复后，只改决策正文，两条确认记录仍是改之前的那一份
  fs.writeFileSync(minutesFile, originalMinutes, 'utf8')
  const decisions = JSON.parse(decisionsBefore)
  decisions[0] = { ...decisions[0], title: '范围已改', detail: '改做 P7' }
  writeJson(decisionsFile, decisions)
  const decisionChanged = concludeStudio(repo, 'g0')
  assert.equal(decisionChanged.pass, false)
  assert.equal(check(decisionChanged, 'G0.each_decision_confirmed').pass, false)
  assert.match(check(decisionChanged, 'G0.each_decision_confirmed').evidence, /D-1:stale/)
  assert.equal(check(decisionChanged, 'G0.experts_confirmed').pass, false)
  assert.match(check(decisionChanged, 'G0.experts_confirmed').evidence, /stale/)
  assert.equal(fs.readFileSync(confirmFile, 'utf8'), confirmBefore, '决策改文案后专家确认仍是旧记录')

  // 确认记录里根本没有内容哈希：即使正文没动，也不能当成确认了当前内容
  const unbound = evidence()
  delete unbound.decisions[0].confirmed_by_user.content_hash
  for (const rec of Object.values(unbound.confirmations)) delete rec.content_hash
  materialize(repo, 'g0', unbound)
  const missingBinding = evaluateG0(repo, 'g0')
  assert.equal(missingBinding.pass, false)
  assert.equal(check(missingBinding, 'G0.each_decision_confirmed').pass, false)
  assert.match(check(missingBinding, 'G0.each_decision_confirmed').evidence, /D-1:stale/)
  assert.equal(check(missingBinding, 'G0.experts_confirmed').pass, false)
  assert.match(check(missingBinding, 'G0.experts_confirmed').evidence, /expert_a:stale/)
})

test('g0: evidence changes are re-evaluated instead of reusing a previous pass', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const data = evidence()
  materialize(repo, 'g0', data)
  const first = concludeStudio(repo, 'g0')
  assert.equal(first.pass, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.collab', 'studio', 'g0', 'session.json'), 'utf8')).status, 'concluded')

  // 通过后再改证据：必须重新计算为失败
  const decisions = JSON.parse(fs.readFileSync(path.join(repo, '.collab', 'studio', 'g0', 'decisions.json'), 'utf8'))
  writeJson(path.join(repo, '.collab', 'studio', 'g0', 'decisions.json'), [{ ...decisions[0], confirmed_by_user: null, status: 'draft' }])
  const second = evaluateG0(repo, 'g0')
  assert.equal(second.pass, false)
  assert.notEqual(second.content_hash, first.content_hash)
})

test('g0: unanswered question never becomes a confirmation', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const data = evidence()
  delete data.decisions[0].confirmed_by_user
  data.decisions[0].status = 'confirmed'
  data.questions[0] = { ...data.questions[0], status: 'open', user_action: null }
  materialize(repo, 'g0', data)
  const r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.each_decision_confirmed').pass, false)
  assert.equal(check(r, 'G0.no_open_blocking').pass, false)
})

test('g0: missing or corrupt session is not evaluated as success', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  let r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(r.status, 'not_evaluated')
  assert.deepEqual(r.failed, ['G0.session'])

  fs.mkdirSync(path.join(repo, '.collab', 'studio', 'g0'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.collab', 'studio', 'g0', 'session.json'), 'not json', 'utf8')
  r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(r.status, 'fail')
})

test('g0: a confirmation written by another model or expert does not count', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))

  const foreign = evidence()
  foreign.confirmations.expert_a = { ...foreign.confirmations.expert_a, expert: 'expert_b', model: 'top-b' }
  materialize(repo, 'g0', foreign)
  let r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.experts_confirmed').pass, false)
  assert.match(check(r, 'G0.experts_confirmed').evidence, /expert_a:missing/)

  const swapped = evidence()
  swapped.confirmations.expert_a = { ...swapped.confirmations.expert_a, model: 'top-d' }
  materialize(repo, 'g0', swapped)
  r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false, 'confirmation must come from the assigned model')
  assert.equal(check(r, 'G0.experts_confirmed').pass, false)
})

test('g0: a decision confirmation without recorded content or time does not count', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))

  for (const userAction of [{ kind: 'confirm' }, { kind: 'confirm', text: '   ', at: AT }, { kind: 'default', text: 'P6' }]) {
    const data = evidence()
    data.decisions[0] = { ...data.decisions[0], status: 'confirmed', confirmed_by_user: userAction }
    materialize(repo, 'g0', data)
    const r = evaluateG0(repo, 'g0')
    assert.equal(r.pass, false, JSON.stringify(userAction))
    assert.equal(check(r, 'G0.each_decision_confirmed').pass, false)
  }
})

test('g0: questions.json that is not an array cannot prove "no blocking"', (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  materialize(repo, 'g0', evidence())
  fs.writeFileSync(path.join(repo, '.collab', 'studio', 'g0', 'questions.json'), '{"open":[]}', 'utf8')
  const r = evaluateG0(repo, 'g0')
  assert.equal(r.pass, false)
  assert.equal(check(r, 'G0.no_open_blocking').pass, false)
})
