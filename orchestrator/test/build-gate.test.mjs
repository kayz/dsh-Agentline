import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { evaluateBuildGate } from '../lib/build.mjs'
import { validateGate } from '../lib/contracts/gate.mjs'

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-gate-'))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  const taskDir = path.join(repo, '.collab', 'tasks', '001')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])
  return { repo, taskDir }
}

function writeCi(taskDir, value) {
  fs.writeFileSync(path.join(taskDir, 'ci-results.json'), typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

function ciCheck(repo, taskDir) {
  const evaluated = evaluateBuildGate(repo, taskDir)
  return evaluated.gate.checks.find((item) => item.id === 'T.ci_all_pass')
}

function passReport(ranAt) {
  return {
    ranAt,
    passed: 2,
    total: 2,
    ok: true,
    results: [
      { id: 'AC-1', passed: true },
      { id: 'AC-2', passed: true },
    ],
  }
}

test('missing, corrupt, empty and partial CI evidence are unknown and not pass', (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const missing = ciCheck(repo, taskDir)
  assert.equal(missing.pass, false)
  assert.equal(missing.evidence, 'unknown:missing')
  assert.equal(missing.waivable, false)

  writeCi(taskDir, '{')
  const corrupt = ciCheck(repo, taskDir)
  assert.equal(corrupt.pass, false)
  assert.equal(corrupt.evidence, 'unknown:corrupt')

  writeCi(taskDir, {})
  const empty = ciCheck(repo, taskDir)
  assert.equal(empty.pass, false)
  assert.match(empty.evidence, /^unknown/)

  writeCi(taskDir, { passed: 0, total: 0, ok: true, results: [] })
  const blank = ciCheck(repo, taskDir)
  assert.equal(blank.pass, false)
  assert.match(blank.evidence, /^unknown/)

  writeCi(taskDir, { passed: 1, total: 2, ok: true, results: [{ id: 'AC-1', passed: true }] })
  const partial = ciCheck(repo, taskDir)
  assert.equal(partial.pass, false)
  assert.equal(partial.evidence, 'unknown:partial')

  writeCi(taskDir, { passed: 1, total: 1, ok: true })
  const noRows = ciCheck(repo, taskDir)
  assert.equal(noRows.pass, false)
  assert.match(noRows.evidence, /^unknown/)
  assert.equal(evaluateBuildGate(repo, taskDir).result.pass, false)
})

test('explicit CI failure fails and a complete fresh report passes', (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  writeCi(taskDir, {
    ranAt: new Date(Date.now() + 60_000).toISOString(),
    passed: 1,
    total: 2,
    ok: false,
    results: [{ id: 'AC-1', passed: true }, { id: 'AC-2', passed: false }],
  })
  const failed = ciCheck(repo, taskDir)
  assert.equal(failed.pass, false)
  assert.equal(failed.evidence, 'fail')

  writeCi(taskDir, passReport(new Date(Date.now() + 60_000).toISOString()))
  const ok = ciCheck(repo, taskDir)
  assert.equal(ok.pass, true)
  assert.equal(ok.evidence, 'pass')
})

test('CI older than HEAD and a verdict that is not an ancestor are stale', (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const first = git(repo, ['rev-parse', 'HEAD']).trim()
  git(repo, ['commit', '--amend', '-qm', 'rewritten'])
  writeCi(taskDir, passReport('2000-01-01T00:00:00.000Z'))
  const staleCi = ciCheck(repo, taskDir)
  assert.equal(staleCi.pass, false)
  assert.equal(staleCi.evidence, 'stale')

  fs.writeFileSync(path.join(taskDir, 'verdict.json'), JSON.stringify({ verdict: 'pass', git_sha: first }))
  const verdict = evaluateBuildGate(repo, taskDir).gate.checks.find((item) => item.id === 'T.verdict_pass')
  assert.equal(verdict.pass, false)
  assert.equal(verdict.evidence, 'stale')
})

test('non-waivable CI failure cannot be waived and a consistent gate can pass', (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const head = git(repo, ['rev-parse', 'HEAD']).trim()
  writeCi(taskDir, {
    ranAt: new Date(Date.now() + 60_000).toISOString(),
    passed: 1,
    total: 1,
    ok: false,
    results: [{ id: 'AC-1', passed: false }],
  })
  fs.writeFileSync(path.join(taskDir, 'waivers.json'), JSON.stringify([
    {
      check: 'T.ci_all_pass',
      by: 'tester',
      at: '2026-11-07T00:00:00.000Z',
      reason: 'try to skip CI',
      content_hash: 'sha256:' + 'ab'.repeat(32),
    },
  ]))
  const blocked = evaluateBuildGate(repo, taskDir)
  assert.equal(blocked.result.pass, false)
  assert.match(blocked.errors.join('\n'), /not waivable/)
  assert.equal(validateGate({ ...blocked.gate, waivers: [] }).ok, true)

  fs.rmSync(path.join(taskDir, 'waivers.json'))
  writeCi(taskDir, passReport(new Date(Date.now() + 60_000).toISOString()))
  fs.writeFileSync(path.join(taskDir, 'verdict.json'), JSON.stringify({ verdict: 'pass', git_sha: head }))
  fs.writeFileSync(path.join(taskDir, 'step-ledger.jsonl'), [
    JSON.stringify({ event: 'call', role: 'dev', model_requested: 'model-a', model_resolved: 'model-a', identity_group: 'anthropic/model-a', infra: false }),
    JSON.stringify({ event: 'call', role: 'review', model_requested: 'model-b', model_resolved: 'model-b', identity_group: 'openai/model-b', infra: false }),
  ].join('\n') + '\n')
  const ready = evaluateBuildGate(repo, taskDir)
  assert.equal(validateGate(ready.gate).ok, true, ready.errors.join('; '))
  assert.equal(ready.gate.checks.find((item) => item.id === 'T.origin_valid').evidence, 'legacy')
  assert.equal(ready.gate.checks.every((item) => item.waivable === false), true)
  assert.equal(ready.result.pass, true, JSON.stringify(ready.gate.checks))
  assert.equal(ready.result.status, 'pass')
})
