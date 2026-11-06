import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendInput, markConsumed } from '../lib/inputs.mjs'
import { readInputLedger, consumedIds } from '../lib/input-ledger.mjs'

test('input ledger: append and consume are append-only evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-input-ledger-'))
  const a = appendInput(dir, { kind: 'note', text: 'A' })
  const b = appendInput(dir, { kind: 'amendment', text: 'B' })
  const first = readInputLedger(dir)
  assert.equal(first.length, 2)
  assert.equal(first[0].event, 'input.append')
  assert.match(first[0].content_sha256, /^sha256:[0-9a-f]{64}$/)
  markConsumed(dir, [a.id])
  const second = readInputLedger(dir)
  assert.equal(second.length, 3)
  assert.deepEqual(second[2].ids, [a.id])
  assert.deepEqual([...consumedIds(dir)], [a.id])
  assert.equal(second.filter((x) => x.event === 'input.append').length, 2)
  assert.ok(b.id)
  fs.rmSync(dir, { recursive: true, force: true })
})
