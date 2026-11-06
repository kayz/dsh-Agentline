import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acquireInputLock, releaseInputLock, withInputLock, inputLockPath, inputLockStatus,
} from '../lib/contracts/input-lock.mjs'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-input-lock-'))
}

test('input lock: acquire, release, status', () => {
  const dir = tmp()
  const lock = acquireInputLock(dir)
  assert.equal(lock.ok, true)
  assert.deepEqual(inputLockStatus(dir).held, true)
  assert.equal(releaseInputLock(lock), true)
  assert.deepEqual(inputLockStatus(dir).held, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('input lock: same process cannot re-enter', () => {
  const dir = tmp()
  const first = acquireInputLock(dir)
  const second = acquireInputLock(dir, { timeoutMs: 100 })
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.code, 'E_INPUT_LOCK_REENTRANT')
  releaseInputLock(first)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('input lock: corrupted owner is not deleted', () => {
  const dir = tmp()
  const lockDir = inputLockPath(dir)
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'owner.json'), '{not-json', 'utf8')
  const r = acquireInputLock(dir, { timeoutMs: 100 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_INPUT_LOCK_CORRUPT')
  assert.equal(fs.existsSync(lockDir), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('input lock: dead owner is taken over', () => {
  const dir = tmp()
  const lockDir = inputLockPath(dir)
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    pid: 999999, token: 'dead', host: 'x', at: new Date().toISOString(),
  }), 'utf8')
  const r = acquireInputLock(dir, { timeoutMs: 1000 })
  assert.equal(r.ok, true)
  assert.ok(r.stale && r.stale.pid === 999999)
  releaseInputLock(r)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('input lock: withInputLock releases on throw', () => {
  const dir = tmp()
  assert.throws(() => withInputLock(dir, () => { throw new Error('boom') }), /boom/)
  assert.deepEqual(inputLockStatus(dir).held, false)
  fs.rmSync(dir, { recursive: true, force: true })
})
