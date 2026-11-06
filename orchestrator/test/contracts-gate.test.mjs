import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateGate, validateGate, sha256Content, GATE_SCHEMA } from '../lib/contracts/gate.mjs'

const hash = sha256Content('subject-v1')

function gate(overrides = {}) {
  return {
    schema: GATE_SCHEMA,
    gate: 'G1_blueprint',
    subject: { kind: 'blueprint', id: 'bp-001', content_hash: hash, revision: 3 },
    evaluated_at: new Date().toISOString(),
    checks: [
      { id: 'B1', desc: 'schema ok', pass: true, waivable: false },
      { id: 'B2', desc: 'review pass', pass: true, waivable: true },
    ],
    waivers: [],
    approval: { required: true, approved: false, content_hash: null },
    ...overrides,
  }
}

test('gate: passes only after approval bound to the current hash', () => {
  assert.equal(evaluateGate(gate()).status, 'pending_approval')
  const approved = gate({ approval: { required: true, approved: true, content_hash: hash } })
  assert.deepEqual(evaluateGate(approved).status, 'pass')
})

test('gate: a changed subject hash makes the gate stale', () => {
  const approved = gate({ approval: { required: true, approved: true, content_hash: hash } })
  assert.equal(evaluateGate(approved, { currentHash: sha256Content('subject-v2') }).status, 'stale')
})

test('gate: non-waivable checks cannot be waived', () => {
  const g = gate({
    checks: [
      { id: 'B1', desc: 'schema ok', pass: false, waivable: false },
      { id: 'B2', desc: 'review pass', pass: true, waivable: true },
    ],
    waivers: [{ check: 'B1', by: 'user', at: new Date().toISOString(), reason: 'x', content_hash: hash }],
  })
  const r = evaluateGate(g)
  assert.equal(r.status, 'fail')
  assert.match(r.errors.join(' '), /not waivable/)
})

test('gate: waivable checks pass with a matching waiver', () => {
  const g = gate({
    checks: [
      { id: 'B1', desc: 'schema ok', pass: true, waivable: false },
      { id: 'B2', desc: 'review pass', pass: false, waivable: true },
    ],
    waivers: [{ check: 'B2', by: 'user', at: new Date().toISOString(), reason: 'known issue', content_hash: hash }],
    approval: { required: false, approved: false, content_hash: null },
  })
  const r = evaluateGate(g)
  assert.equal(r.status, 'pass')
  assert.deepEqual(r.waived, ['B2'])
})

test('gate: duplicate check ids are invalid', () => {
  const g = gate({
    checks: [
      { id: 'B1', desc: 'a', pass: true, waivable: false },
      { id: 'B1', desc: 'b', pass: true, waivable: false },
    ],
  })
  assert.equal(validateGate(g).ok, false)
})

test('gate: P0 fixture is valid and passes', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures', 'gate-pass.json'), 'utf8'))
  assert.equal(validateGate(fixture).ok, true)
  assert.equal(evaluateGate(fixture, { currentHash: fixture.subject.content_hash }).status, 'pass')
})
