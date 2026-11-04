import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { runProcess } from '../lib/process.mjs'

const classify = (line) => {
  const t = String(line).trim()
  if (t === 'tool') return { kind: 'tool_start', id: 't1' }
  if (t === 'event') return { kind: 'activity' }
  return null
}

test('heartbeat: an active tool gets the tool budget, not the API budget', { timeout: 30_000 }, async () => {
  const script = "process.stdout.write('tool\\n'); setTimeout(() => {}, 20000)"
  const res = await runProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: os.tmpdir(),
    timeoutMs: 20_000,
    stallMinutes: 0,
    classify,
    apiStallSeconds: 1,
    toolStallMinutes: 0.05, // 3s
  })
  assert.equal(res.exitCode, 125)
  assert.equal(res.abortedReason, 'tool_stall')
})

test('heartbeat: streaming events keep the run alive past the API stall window', { timeout: 30_000 }, async () => {
  const script = "const t=setInterval(()=>process.stdout.write('event\\n'),400); setTimeout(()=>{clearInterval(t); process.exit(0)},6000)"
  const res = await runProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: os.tmpdir(),
    timeoutMs: 20_000,
    stallMinutes: 0,
    classify,
    apiStallSeconds: 1,
    toolStallMinutes: 1,
  })
  assert.equal(res.exitCode, 0)
  assert.equal(res.abortedReason, null)
})

test('heartbeat: a 429 rate-limit line aborts immediately', { timeout: 15_000 }, async () => {
  const script = "process.stderr.write('429 您的使用量已超出频率限制，将在 2026-11-05 00:15:26 UTC+8 重置\\n'); setTimeout(() => {}, 20000)"
  const res = await runProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: os.tmpdir(),
    timeoutMs: 20_000,
    stallMinutes: 0,
    classify: () => null,
    apiStallSeconds: 10,
    toolStallMinutes: 10,
  })
  assert.equal(res.exitCode, 125)
  assert.equal(res.abortedReason, 'rate_limit')
})
