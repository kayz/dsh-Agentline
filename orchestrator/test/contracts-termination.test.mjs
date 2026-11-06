import test from 'node:test'
import assert from 'node:assert/strict'
import { pidAlive, proveTermination, canResume } from '../lib/contracts/termination.mjs'

test('termination: live target is alive', () => {
  const r = proveTermination({ pid: process.pid })
  assert.equal(r.status, 'alive')
  assert.equal(canResume(r), false)
})

test('termination: dead target without a tree guard is unknown', () => {
  const r = proveTermination({ pid: 999999 })
  assert.equal(r.status, 'unknown')
  assert.equal(r.reason, 'target_dead_tree_unproven')
  assert.equal(canResume(r), false)
})

test('termination: only a tree guard can prove the whole tree is gone', () => {
  const r = proveTermination({ pid: 999999, guard: { covers: 'tree', proven_dead: true, kind: 'job-object' } })
  assert.equal(r.status, 'proven_dead')
  assert.equal(canResume(r), true)
})

test('termination: a target-only guard is insufficient', () => {
  const r = proveTermination({ pid: 999999, guard: { covers: 'process', proven_dead: true, kind: 'pid' } })
  assert.equal(r.status, 'unknown')
})

test('termination: pidAlive rejects invalid ids', () => {
  assert.equal(pidAlive(0), false)
  assert.equal(pidAlive(-1), false)
  assert.equal(pidAlive(null), false)
})
