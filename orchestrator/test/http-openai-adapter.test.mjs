import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createHttpOpenAI, redactSecret, resolveApiKey, resolveSecretRef,
} from '../lib/adapters/http-openai.mjs'
import { getAdapter } from '../lib/adapters/index.mjs'
import { httpOpenAIReply, replyFromAdapter } from '../lib/adapters/reply.mjs'

const KEY = 'sk-test-deepseek-secret'
const tempDirs = []
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-http-openai-'))
  tempDirs.push(dir)
  return dir
}
test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function providerConfig(overrides = {}) {
  return {
    source: 'DeepSeek',
    adapter: 'http-openai',
    transport: 'http',
    base_url: 'https://api.deepseek.com',
    limits: { timeoutMinutes: 30 },
    options: {},
    ...overrides,
  }
}

function jsonResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text },
  }
}

function successBody(overrides = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'deepseek-flash-2026',
    choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 5, prompt_cache_hit_tokens: 2 },
    ...overrides,
  }
}

test('http-openai run posts the prompt and resolves text, model and usage from the response', async () => {
  const dir = tmpDir()
  const logPath = path.join(dir, 'logs', 'dev.log')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse(successBody())
  }
  const adapter = createHttpOpenAI(providerConfig(), { fetchImpl, env: { DEEPSEEK_API_KEY: KEY } })
  const res = await adapter.run({
    prompt: '说一句 pong', cwd: dir, model: 'deepseek-flash', effort: 'high', timeoutMs: 5_000, logPath,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`)
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.model, 'deepseek-flash')
  assert.deepEqual(sent.messages, [{ role: 'user', content: '说一句 pong' }])

  assert.equal(res.exitCode, 0)
  assert.equal(res.error, null)
  assert.equal(res.text, 'pong')
  // 服务端回传的 model 才可信：它和请求里的 model 不同。
  assert.equal(res.modelResolved, 'deepseek-flash-2026')
  assert.deepEqual(res.usage, { input: 7, output: 5, cache_read: 2, cache_write: null, cost_usd: null })
  assert.equal(res.usageSource, 'api_json')
  assert.deepEqual(replyFromAdapter('http-openai', res.stdout), { text: 'pong', modelResolved: 'deepseek-flash-2026' })

  const log = fs.readFileSync(logPath, 'utf8')
  assert.match(log, /POST https:\/\/api\.deepseek\.com\/chat\/completions/)
  assert.match(log, /说一句 pong/)
  assert.ok(!log.includes(KEY), 'API key must never be written to the log')
})

test('http-openai identity comes from body.model, never from the requested model', () => {
  const body = successBody({ model: 'server-reported-model' })
  assert.deepEqual(httpOpenAIReply(JSON.stringify(body)), { text: 'pong', modelResolved: 'server-reported-model' })
  const noModel = successBody()
  delete noModel.model
  assert.deepEqual(httpOpenAIReply(JSON.stringify(noModel)), { text: 'pong', modelResolved: null })
})

test('http-openai 401 fails immediately, reports the status, and redacts the key', async () => {
  const dir = tmpDir()
  const logPath = path.join(dir, 'unauthorized.log')
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return jsonResponse({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401)
  }
  const adapter = createHttpOpenAI(providerConfig(), { fetchImpl, env: { DEEPSEEK_API_KEY: KEY } })
  const res = await adapter.run({ prompt: 'ping', cwd: dir, model: 'deepseek-flash', timeoutMs: 5_000, logPath })

  assert.equal(calls, 1, '401 must not be retried')
  assert.equal(res.exitCode, 1)
  assert.match(res.error, /401/)
  assert.match(res.error, /unauthorized/)
  assert.match(res.error, /\*\*\*/)
  assert.ok(!res.error.includes(KEY), 'the key must be redacted from the error')
  const log = fs.readFileSync(logPath, 'utf8')
  assert.ok(!log.includes(KEY), 'the key must never be written to the log')
  assert.match(log, /\*\*\*/)
})

test('http-openai 403 fails immediately with an auth error', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return jsonResponse({ error: { message: 'forbidden' } }, 403)
  }
  const adapter = createHttpOpenAI(providerConfig(), { fetchImpl, env: { DEEPSEEK_API_KEY: KEY } })
  const res = await adapter.run({ prompt: 'ping', model: 'deepseek-flash', timeoutMs: 5_000 })
  assert.equal(calls, 1)
  assert.equal(res.exitCode, 1)
  assert.match(res.error, /403/)
  assert.match(res.error, /auth/)
})

test('http-openai retries 429 and 5xx with exponential backoff, then succeeds', async () => {
  const dir = tmpDir()
  const logPath = path.join(dir, 'retry.log')
  const sleeps = []
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) return jsonResponse({ error: { message: 'rate limited' } }, 429)
    if (calls === 2) return jsonResponse('<html>bad gateway</html>', 502)
    return jsonResponse(successBody())
  }
  const adapter = createHttpOpenAI(providerConfig(), {
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms) },
    env: { DEEPSEEK_API_KEY: KEY },
  })
  const res = await adapter.run({ prompt: 'ping', cwd: dir, model: 'deepseek-flash', timeoutMs: 5_000, logPath })

  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [500, 1000])
  assert.equal(res.exitCode, 0)
  assert.equal(res.text, 'pong')
  const log = fs.readFileSync(logPath, 'utf8')
  assert.match(log, /RETRY 1\/2/)
  assert.match(log, /RETRY 2\/2/)
})

test('http-openai gives up after two retries on persistent 429', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return jsonResponse({ error: { message: 'rate limit reached' } }, 429)
  }
  const adapter = createHttpOpenAI(providerConfig(), {
    fetchImpl,
    sleep: async () => {},
    env: { DEEPSEEK_API_KEY: KEY },
  })
  const res = await adapter.run({ prompt: 'ping', model: 'deepseek-flash', timeoutMs: 5_000 })
  assert.equal(calls, 3)
  assert.equal(res.exitCode, 1)
  assert.match(res.error, /429/)
  assert.match(res.error, /rate_limit/)
})

test('http-openai timeout aborts the request and maps it to exit 124', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    // AbortSignal.timeout 的定时器是 unref 的；用一个 ref 的定时器模拟真实网络请求占住事件循环。
    const keepAlive = setTimeout(() => {}, 30_000)
    const fail = () => {
      clearTimeout(keepAlive)
      reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
    }
    if (init.signal.aborted) fail()
    else init.signal.addEventListener('abort', fail, { once: true })
  })
  const adapter = createHttpOpenAI(providerConfig(), { fetchImpl, env: { DEEPSEEK_API_KEY: KEY } })
  const res = await adapter.run({ prompt: 'ping', model: 'deepseek-flash', timeoutMs: 60 })
  assert.equal(res.exitCode, 124)
  assert.equal(res.error, 'timeout')
})

test('http-openai credential precedence is apiKeyEnv, then DEEPSEEK_API_KEY, then provider.apiKey references', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.authorization)
    return jsonResponse(successBody())
  }

  const named = createHttpOpenAI(providerConfig({ options: { apiKeyEnv: 'MY_DEEPSEEK_KEY' } }), {
    fetchImpl,
    env: { MY_DEEPSEEK_KEY: 'sk-from-named-env', DEEPSEEK_API_KEY: 'sk-from-fallback' },
  })
  await named.run({ prompt: 'ping', model: 'deepseek-flash', timeoutMs: 5_000 })

  const fallback = createHttpOpenAI(providerConfig(), {
    fetchImpl,
    env: { DEEPSEEK_API_KEY: 'sk-from-fallback' },
  })
  await fallback.run({ prompt: 'ping', model: 'deepseek-flash', timeoutMs: 5_000 })

  const referenced = createHttpOpenAI(providerConfig({ apiKey: 'env:CUSTOM_KEY' }), {
    fetchImpl,
    env: { CUSTOM_KEY: 'sk-from-reference' },
  })
  await referenced.run({ prompt: 'ping', model: 'deepseek-flash', timeoutMs: 5_000 })

  assert.deepEqual(seen, ['Bearer sk-from-named-env', 'Bearer sk-from-fallback', 'Bearer sk-from-reference'])
  assert.equal(resolveApiKey(providerConfig({ apiKey: 'env:CUSTOM_KEY' }), { CUSTOM_KEY: 'x' }), 'x')
  assert.equal(resolveSecretRef('${OTHER_KEY}', { OTHER_KEY: 'y' }), 'y')
  assert.equal(resolveSecretRef('plain-key'), 'plain-key')
  assert.equal(redactSecret('a secret-key b secret-key', 'secret-key'), 'a *** b ***')
})

test('http-openai without any credential fails before touching the network', async () => {
  let calls = 0
  const adapter = createHttpOpenAI(providerConfig(), {
    fetchImpl: async () => { calls += 1; return jsonResponse(successBody()) },
    env: {},
  })
  const res = await adapter.run({ prompt: 'ping', model: 'deepseek-flash', timeoutMs: 5_000 })
  assert.equal(calls, 0)
  assert.equal(res.exitCode, 1)
  assert.match(res.error, /auth/)
  assert.match(res.error, /DEEPSEEK_API_KEY/)
})

test('http-openai and grok-cli are registered adapters', () => {
  assert.equal(getAdapter(providerConfig()).id, 'http-openai')
  assert.equal(getAdapter({ source: 'xai', adapter: 'grok-cli', transport: 'cli', command: 'grok.exe' }).id, 'grok-cli')
})
