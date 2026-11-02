import test from 'node:test'
import assert from 'node:assert/strict'
import { matchChunk } from '../lib/supervisor.mjs'

// 2026-11-02 回归：网络规则曾用 /i 的 `ENOTFOUND` 命中 Python 的
// `FileNotFoundError`（"fil**eNotFound**error"），把普通脚本报错误判成
// 网络中断并杀掉 codebuddy 进程。系统错误码必须大小写敏感 + 词边界。
test('network rule ignores FileNotFoundError in tool output', () => {
  assert.equal(matchChunk('FileNotFoundError: [WinError 2] 系统找不到指定的文件。'), null)
  assert.equal(matchChunk('Traceback (most recent call last):\n  File "x.py"\nFileNotFoundError'), null)
  assert.equal(matchChunk('filenotfounderror'), null)
})

test('network rule still catches real connection failures', () => {
  assert.equal(matchChunk('Error: connect ECONNREFUSED 127.0.0.1:443'), 'network')
  assert.equal(matchChunk('read ECONNRESET'), 'network')
  assert.equal(matchChunk('getaddrinfo ENOTFOUND api.example.com'), 'network')
  assert.equal(matchChunk('socket hang up'), 'network')
  assert.equal(matchChunk('Connection reset by peer'), 'network')
  assert.equal(matchChunk('network error while reading'), 'network')
})

test('other rules still classify their own failures', () => {
  assert.equal(matchChunk('rate limit exceeded'), 'rate_limit')
  assert.equal(matchChunk('HTTP 429 Too Many Requests'), 'rate_limit')
  assert.equal(matchChunk('401 Unauthorized'), 'auth')
  assert.equal(matchChunk('context length exceeded'), 'context')
  assert.equal(matchChunk('model at capacity'), 'capacity')
})
