import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyError, parseRateLimitReset } from '../lib/exec.mjs'

test('classifyError: 429 and Chinese quota messages are rate_limit', () => {
  const text = '429 您的使用量已超出频率限制，将在 2026-11-05 00:15:26 UTC+8 重置，您也可以切换其他模型继续使用。'
  assert.equal(classifyError(text), 'rate_limit')
  assert.equal(parseRateLimitReset(text), '2026-11-05 00:15:26 UTC+8')
  assert.equal(classifyError('HTTP 429 Too Many Requests'), 'rate_limit')
  assert.equal(classifyError('you have hit your session limit'), 'rate_limit')
  assert.equal(classifyError('401 unauthorized'), 'auth')
})
