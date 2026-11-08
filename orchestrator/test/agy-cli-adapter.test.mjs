import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgyCli, parseAgyModels, parseAgyModelEntries } from '../lib/adapters/agy-cli.mjs'
import { agyReply, fixtureStdout, replyFromAdapter } from '../lib/adapters/reply.mjs'
import { getAdapter } from '../lib/adapters/index.mjs'

const CFG = {
  source: 'antigravity',
  adapter: 'agy-cli',
  transport: 'cli',
  command: 'C:/Users/kayz/AppData/Local/agy/bin/agy.exe',
  limits: { timeoutMinutes: 30 },
  options: {},
}

function okResult(stdout) {
  return { exitCode: 0, stdout, stderr: '', timedOut: false, spawnError: null, abortedReason: null }
}

// 实测 `agy models` 的 stdout（id<TAB>显示名），用来锁住解析行为。
const MODELS_TEXT = [
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  '',
].join('\n')

// 实测配额错误：exit 3，stderr 同时有 error: 行与 AGY_ERROR JSON。
const QUOTA_STDERR = [
  'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 62h31m12s.',
  'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 62h31m12s.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true}',
].join('\n')

test('agy-cli is registered and run passes --print=<prompt> --model without a shell', async () => {
  const calls = []
  const runProcess = async (options) => {
    calls.push(options)
    return okResult('  hello from agy\n\n')
  }
  const adapter = createAgyCli(CFG, { runProcess })
  assert.equal(adapter.id, 'agy-cli')
  assert.equal(getAdapter(CFG).id, 'agy-cli')

  const res = await adapter.run({
    prompt: '写一行 问候 带空格', cwd: 'C:/repo', model: 'gemini-4-argon-high',
    effort: 'high', timeoutMs: 9_000, logPath: 'C:/tmp/agy.log',
  })

  assert.equal(calls.length, 1)
  // prompt 与 model 各占一个 argv；--print= 必须用 = 连接。
  assert.deepEqual(calls[0].args, ['--print=写一行 问候 带空格', '--model', 'gemini-4-argon-high'])
  assert.equal(calls[0].command, CFG.command)
  assert.equal(calls[0].cwd, 'C:/repo')
  assert.equal(calls[0].timeoutMs, 9_000)
  assert.equal(calls[0].logPath, 'C:/tmp/agy.log')
  // 没有把 prompt 交给 shell 解析（runProcess 默认 shell:false，这里也不补 shell 选项）。
  assert.equal(calls[0].shell, undefined)

  assert.equal(res.exitCode, 0)
  assert.equal(res.error, null)
  assert.equal(res.text, 'hello from agy')
  // 默认 text 输出没有身份字段：不得把 --model 的入参回显成已验证身份。
  assert.equal(res.modelResolved, null)
  assert.equal(res.usage, null)
})

test('agy reply trims text mode and never fabricates model identity', () => {
  assert.deepEqual(agyReply('\n  第一行\n第二行  \n'), { text: '第一行\n第二行', modelResolved: null })
  assert.deepEqual(replyFromAdapter('agy-cli', 'body\n'), { text: 'body', modelResolved: null })
  // 夹具即使带了 model，text 输出也不含身份字段。
  const fixture = fixtureStdout('agy-cli', 'gemini-4-argon-high', 'body')
  assert.equal(replyFromAdapter('agy-cli', fixture).text, 'body')
  assert.equal(replyFromAdapter('agy-cli', fixture).modelResolved, null)
})

test('agy reply adopts a model only when this stdout actually carries one', () => {
  // 实测 --output-format json 的返回：没有 model 字段 → null。
  const observed = JSON.stringify({
    conversation_id: 'e2054a4f', status: 'SUCCESS', response: 'pong\n',
    duration_seconds: 2.68, num_turns: 1,
    usage: { input_tokens: 7062, output_tokens: 20, total_tokens: 7082 },
  })
  assert.deepEqual(agyReply(observed), { text: 'pong', modelResolved: null })

  // 未来版本若真在 stdout 里写 model，才采纳它。
  const withModel = JSON.stringify({ status: 'SUCCESS', response: 'body', model: 'gemini-4-argon-high' })
  assert.deepEqual(agyReply(withModel), { text: 'body', modelResolved: 'gemini-4-argon-high' })

  // 空 model 字段同样是未知身份。
  assert.equal(agyReply(JSON.stringify({ status: 'SUCCESS', response: 'x', model: '  ' })).modelResolved, null)
})

test('agy-cli non-zero exit is a failure with stderr detail', async () => {
  const adapter = createAgyCli(CFG, {
    runProcess: async () => ({ exitCode: 3, stdout: 'partial', stderr: 'boom: unauthorized\n', timedOut: false, spawnError: null, abortedReason: null }),
  })
  const res = await adapter.run({ prompt: 'ping', cwd: 'C:/repo', model: 'gemini-4-argon-high', timeoutMs: 9_000 })
  assert.equal(res.exitCode, 3)
  assert.ok(res.error, 'non-zero exit must produce an error')
  assert.match(res.error, /boom/)
  assert.equal(res.modelResolved, null)
})

test('agy-cli timeout maps to exit 124 and error timeout', async () => {
  const adapter = createAgyCli(CFG, {
    runProcess: async () => ({ exitCode: null, stdout: 'partial', stderr: '', timedOut: true, spawnError: null, abortedReason: null }),
  })
  const res = await adapter.run({ prompt: 'ping', cwd: 'C:/repo', model: 'gemini-3.8-flash-high', timeoutMs: 50 })
  assert.equal(res.exitCode, 124)
  assert.equal(res.error, 'timeout')
  assert.equal(res.text, 'partial')
})

test('agy-cli maps spawn errors (missing executable) to a readable failure', async () => {
  const adapter = createAgyCli(CFG, {
    runProcess: async () => ({
      exitCode: -1, stdout: '', timedOut: false, abortedReason: null,
      stderr: 'command not found: C:/nope/agy.exe',
      spawnError: 'command not found: C:/nope/agy.exe',
    }),
  })
  const res = await adapter.run({ prompt: 'ping', cwd: 'C:/repo', model: 'gemini-3.8-flash-high', timeoutMs: 50 })
  assert.equal(res.exitCode, -1)
  assert.match(res.error, /command not found/)
  assert.match(res.error, /agy\.exe/)
})

test('agy-cli surfaces quota errors with an identifiable code instead of swallowing them', async () => {
  const adapter = createAgyCli(CFG, {
    runProcess: async () => ({ exitCode: 3, stdout: '', stderr: QUOTA_STDERR, timedOut: false, spawnError: null, abortedReason: null }),
  })
  const res = await adapter.run({ prompt: 'hi', cwd: 'C:/repo', model: 'claude-opus-5-5-low', timeoutMs: 9_000 })
  assert.equal(res.exitCode, 3)
  assert.match(res.error, /quota/i)
  assert.match(res.error, /Individual quota reached/)
  // 保留 429，让 exec.classifyError 能归到 rate_limit。
  assert.match(res.error, /429/)
})

test('agy-cli keeps a non-quota JSON-only error instead of reducing it to exit N', async () => {
  const stdout = JSON.stringify({ status: 'ERROR', response: '', error: 'model not available for this account' })
  const adapter = createAgyCli(CFG, {
    runProcess: async () => ({ exitCode: 3, stdout, stderr: '', timedOut: false, spawnError: null, abortedReason: null }),
  })
  const res = await adapter.run({ prompt: 'hi', cwd: 'C:/repo', model: 'gemini-4-argon-high', timeoutMs: 9_000 })
  assert.equal(res.exitCode, 3)
  assert.match(res.error, /model not available/)
})

test('agy-cli maps a quota error reported only inside the JSON stdout', async () => {
  const stdout = JSON.stringify({
    conversation_id: '09ef3d6d', status: 'ERROR', response: '',
    error: 'Individual quota reached. Please upgrade your subscription to increase your limits.',
    usage: { input_tokens: 0, output_tokens: 0 },
  })
  const adapter = createAgyCli(CFG, {
    runProcess: async () => ({ exitCode: 3, stdout, stderr: '', timedOut: false, spawnError: null, abortedReason: null }),
  })
  const res = await adapter.run({ prompt: 'hi', cwd: 'C:/repo', model: 'gpt-oss-120b-medium', timeoutMs: 9_000 })
  assert.equal(res.exitCode, 3)
  assert.match(res.error, /quota_exceeded/)
  assert.match(res.error, /Individual quota reached/)
})

test('agy model list parses id<TAB>display, multi-space, bullets and skips headers', () => {
  const text = [
    'Available models:',
    'Fetching available models...',
    ...MODELS_TEXT.trim().split('\n'),
    'gemini-3.8-flash-high   Gemini 3.8 Flash (High)',
    '* claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
    'gpt-oss-120b-medium - GPT-OSS 120B (Medium)',
    '\u001b[36mgemini-4-argon-low\u001b[0m\tGemini 4 Argon (Low)',
    'gemini-4-argon-high',
    '',
  ].join('\n')

  assert.deepEqual(parseAgyModels(text), [
    'gemini-4-argon-medium',
    'gemini-4-argon-high',
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-high',
    'claude-sonnet-5-5-low',
    'gpt-oss-120b-medium',
    'gemini-4-argon-low',
  ])
  assert.deepEqual(parseAgyModelEntries(MODELS_TEXT)[0], {
    id: 'gemini-4-argon-medium',
    displayName: 'Gemini 4 Argon (Medium)',
  })
  assert.deepEqual(parseAgyModels('Available models:\nFetching available models...\n'), [])
})

test('agy-cli check probes --version and reports it', async () => {
  const calls = []
  const ok = createAgyCli(CFG, {
    runProcess: async (options) => { calls.push(options); return okResult('1.5.3\n') },
  })
  const res = await ok.check()
  assert.deepEqual(calls[0].args, ['--version'])
  assert.equal(res.ok, true)
  assert.equal(res.version, '1.5.3')

  const bad = createAgyCli(CFG, {
    runProcess: async () => ({ exitCode: 2, stdout: '', stderr: 'not logged in\n', timedOut: false, spawnError: null, abortedReason: null }),
  })
  const failed = await bad.check()
  assert.equal(failed.ok, false)
  assert.match(failed.detail, /not logged in/)
})

test('agy-cli discover parses `agy models` and degrades with warnings', async () => {
  const adapter = createAgyCli(CFG, {
    runProcess: async (options) => {
      assert.deepEqual(options.args, ['models'])
      return okResult(MODELS_TEXT)
    },
  })
  const found = await adapter.discover()
  assert.equal(found.source, 'cli')
  assert.deepEqual(found.models.map((m) => m.id), [
    'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-3.8-flash-low',
  ])
  assert.equal(found.models[0].displayName, 'Gemini 4 Argon (Medium)')
  assert.deepEqual(found.warnings, [])

  const empty = createAgyCli(CFG, {
    runProcess: async () => ({ exitCode: 1, stdout: '', stderr: 'network down\n', timedOut: false, spawnError: null, abortedReason: null }),
  })
  const none = await empty.discover()
  assert.deepEqual(none.models, [])
  assert.equal(none.warnings.length, 1)
  assert.match(none.warnings[0], /network down/)
})
