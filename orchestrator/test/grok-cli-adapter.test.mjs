import test from 'node:test'
import assert from 'node:assert/strict'
import { createGrokCli, parseGrokModels } from '../lib/adapters/grok-cli.mjs'
import { fixtureStdout, grokReply, replyFromAdapter } from '../lib/adapters/reply.mjs'

const CFG = {
  source: 'xai',
  adapter: 'grok-cli',
  transport: 'cli',
  command: 'C:/Users/kayz/.grok/bin/grok.exe',
  limits: { timeoutMinutes: 30 },
  options: {},
}

function okResult(stdout) {
  return { exitCode: 0, stdout, stderr: '', timedOut: false, spawnError: null, abortedReason: null }
}

test('grok-cli run passes -p prompt -m model and returns plain stdout without an identity', async () => {
  const calls = []
  const runProcess = async (options) => {
    calls.push(options)
    return okResult('  hello from grok\n\n')
  }
  const adapter = createGrokCli(CFG, { runProcess })
  const res = await adapter.run({
    prompt: '写一行问候', cwd: 'C:/repo', model: 'grok-4.7', effort: 'high', timeoutMs: 9_000, logPath: 'C:/tmp/grok.log',
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['-p', '写一行问候', '-m', 'grok-4.7'])
  assert.equal(calls[0].command, CFG.command)
  assert.equal(calls[0].cwd, 'C:/repo')
  assert.equal(calls[0].timeoutMs, 9_000)
  assert.equal(calls[0].logPath, 'C:/tmp/grok.log')

  assert.equal(res.exitCode, 0)
  assert.equal(res.error, null)
  assert.equal(res.text, 'hello from grok')
  // 普通文本输出没有身份字段：不得把 -m 的入参回显成已验证身份。
  assert.equal(res.modelResolved, null)
  assert.equal(res.usage, null)
})

test('grok reply trims stdout and never fabricates model identity', () => {
  assert.deepEqual(grokReply('\n  第一行\n第二行  \n'), { text: '第一行\n第二行', modelResolved: null })
  assert.deepEqual(replyFromAdapter('grok-cli', 'body\n'), { text: 'body', modelResolved: null })
  // 夹具即使带了 model，grok 的文本输出也不含身份字段。
  assert.equal(replyFromAdapter('grok-cli', fixtureStdout('grok-cli', 'grok-4.7', 'body')).modelResolved, null)
  assert.equal(replyFromAdapter('grok-cli', fixtureStdout('grok-cli', 'grok-4.7', 'body')).text, 'body')
})

test('grok-cli non-zero exit is a failure with stderr detail', async () => {
  const adapter = createGrokCli(CFG, {
    runProcess: async () => ({ exitCode: 3, stdout: 'partial', stderr: 'boom: unauthorized\n', timedOut: false, spawnError: null, abortedReason: null }),
  })
  const res = await adapter.run({ prompt: 'ping', cwd: 'C:/repo', model: 'grok-4.7', timeoutMs: 9_000 })
  assert.equal(res.exitCode, 3)
  assert.ok(res.error, 'non-zero exit must produce an error')
  assert.match(res.error, /boom/)
  assert.equal(res.modelResolved, null)
})

test('grok-cli timeout maps to exit 124 and error timeout', async () => {
  const adapter = createGrokCli(CFG, {
    runProcess: async () => ({ exitCode: null, stdout: 'partial', stderr: '', timedOut: true, spawnError: null, abortedReason: null }),
  })
  const res = await adapter.run({ prompt: 'ping', cwd: 'C:/repo', model: 'grok-4.7', timeoutMs: 50 })
  assert.equal(res.exitCode, 124)
  assert.equal(res.error, 'timeout')
  assert.equal(res.text, 'partial')
})

test('grok-cli maps spawn errors to a failure', async () => {
  const adapter = createGrokCli(CFG, {
    runProcess: async () => ({ exitCode: -1, stdout: '', stderr: 'ENOENT', timedOut: false, spawnError: 'command not found: grok.exe', abortedReason: null }),
  })
  const res = await adapter.run({ prompt: 'ping', cwd: 'C:/repo', model: 'grok-4.7', timeoutMs: 50 })
  assert.equal(res.exitCode, -1)
  assert.match(res.error, /command not found/)
})

test('grok model list parses ids and skips headers', () => {
  const text = [
    'Available models:',
    'grok-4.7',
    'grok-4.7-build-fast - Grok 4.7 Build Fast',
    '* grok-4.6',
    'grok-4.5',
    'grok-4.7',
    '',
  ].join('\n')
  assert.deepEqual(parseGrokModels(text), ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'])
  assert.deepEqual(parseGrokModels('Available models:\n'), [])
})
