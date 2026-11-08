/**
 * http-openai.mjs — OpenAI 兼容的 HTTP adapter（DeepSeek 等）
 *
 * 与 CLI adapter 返回同样的结构：{ exitCode, stdout, text, modelResolved, usage, error }。
 * 凭据按 options.apiKeyEnv → DEEPSEEK_API_KEY → provider.apiKey（支持引用形式）读取，
 * 不写日志、不进错误信息；任何错误文本里的 key 都替换成 ***。
 *
 * 429 / 5xx 在本 adapter 内重试（仓库没有现成重试工具），最多 2 次、指数退避；
 * 401/403 立即失败，交给 classifyError 归到 auth，避免静默换候选。
 */
import fs from 'node:fs'
import path from 'node:path'
import { httpOpenAIReply } from './reply.mjs'

const MAX_RETRIES = 2
const RETRY_BASE_MS = 500

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

/** 把凭据从任意文本里抹掉；空凭据原样返回。导出供测试验证不落盘。 */
export function redactSecret(text, secret) {
  const body = String(text ?? '')
  const key = typeof secret === 'string' ? secret.trim() : ''
  if (!key) return body
  return body.split(key).join('***')
}

/** 解析配置里的凭据引用：env:NAME / ${NAME} / $NAME / {env:NAME}，普通字符串原样返回。 */
export function resolveSecretRef(value, env = process.env) {
  if (value == null || value === '') return null
  if (typeof value === 'object') {
    const name = value.env || value.name || value.fromEnv
    return name && env[name] ? env[name] : null
  }
  const raw = String(value).trim()
  if (!raw) return null
  const m = raw.match(/^(?:env:|\{env:|\$\{|\$)([A-Za-z_][A-Za-z0-9_]*)\}?$/)
  if (m) return env[m[1]] || null
  return raw
}

/** 凭据优先级：provider.options.apiKeyEnv → DEEPSEEK_API_KEY → provider.apiKey。 */
export function resolveApiKey(cfg, env = process.env) {
  const options = cfg?.options || {}
  if (options.apiKeyEnv) {
    const fromNamedEnv = env[options.apiKeyEnv]
    if (fromNamedEnv) return fromNamedEnv
  }
  if (env.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY
  return resolveSecretRef(cfg?.apiKey, env)
}

function endpoint(cfg) {
  const base = String(cfg?.base_url ?? cfg?.baseUrl ?? '').trim().replace(/\/+$/, '')
  return base ? `${base}/chat/completions` : ''
}

function modelsEndpoint(cfg) {
  const base = String(cfg?.base_url ?? cfg?.baseUrl ?? '').trim().replace(/\/+$/, '')
  return base ? `${base}/models` : ''
}

function appendLog(logPath, text) {
  if (!logPath) return
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    const line = String(text ?? '')
    fs.appendFileSync(logPath, line.endsWith('\n') ? line : line + '\n', 'utf8')
  } catch { /* 日志失败不影响调用 */ }
}

function usageOf(body) {
  const usage = body && body.usage
  if (!usage || typeof usage !== 'object') return null
  const input = usage.prompt_tokens ?? usage.input_tokens ?? null
  const output = usage.completion_tokens ?? usage.output_tokens ?? null
  if (input == null && output == null) return null
  return {
    input,
    output,
    cache_read: usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? null,
    cache_write: usage.prompt_cache_creation_tokens ?? usage.cache_write_input_tokens ?? null,
    cost_usd: null,
  }
}

function httpFailure(status, bodyText, key) {
  const label = status === 401
    ? 'unauthorized'
    : status === 403
      ? 'auth_error: forbidden'
      : status === 429
        ? 'rate_limit'
        : 'http_error'
  const detail = redactSecret(String(bodyText ?? '').slice(0, 1200), key).trim()
  return `HTTP ${status} (${label})${detail ? ': ' + detail : ''}`
}

/**
 * 强制超时：AbortSignal 负责中断真实 fetch，额外的 race 保证即使注入的 fetch
 * 不理会 signal 也能结束，不会把整个 flow 挂死。
 */
async function fetchWithTimeout(fetchImpl, url, init, limitMs) {
  const signal = AbortSignal.timeout(limitMs)
  let timer = null
  const request = Promise.resolve().then(() => fetchImpl(url, { ...init, signal }))
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`request timed out after ${limitMs}ms`), { name: 'TimeoutError' }))
    }, limitMs)
  })
  try {
    return await Promise.race([request, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    request.catch(() => { /* 超时后 fetch 的迟到 rejection 不再影响结果 */ })
  }
}

/**
 * @param {object} cfg provider 配置
 * @param {{ fetchImpl?: Function, sleep?: Function, env?: object }} [deps] 测试注入点
 */
export function createHttpOpenAI(cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const env = deps.env || process.env

  function finish({ exitCode, error, stdout = '', text = '', modelResolved = null, usage = null, logPath = null, key = null }) {
    const safeError = error == null ? null : redactSecret(error, key)
    appendLog(logPath, `=== RESULT exit=${exitCode}${safeError ? ' error=' + safeError : ''} ===`)
    return {
      exitCode,
      usage,
      usageSource: usage ? 'api_json' : 'none',
      stdout,
      text,
      modelResolved,
      error: safeError,
    }
  }

  return {
    id: 'http-openai',
    source: String(cfg?.source || 'openai-compatible').toLowerCase(),
    // 无状态 HTTP chat/completions：没有可复用的 CLI 会话。
    capabilities: { session_resume: false },
    resumeArgs: () => [],

    async check() {
      const key = resolveApiKey(cfg, env)
      if (!key) {
        return { ok: false, version: '-', detail: 'auth=missing (set DEEPSEEK_API_KEY or providers.deepseek-api.options.apiKeyEnv)' }
      }
      const url = modelsEndpoint(cfg)
      if (!url) return { ok: false, version: '-', detail: 'base_url is not configured' }
      try {
        const res = await fetchImpl(url, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) return { ok: false, version: '-', detail: redactSecret(`HTTP ${res.status}`, key) }
        return { ok: true, version: '-', detail: 'auth=api_key transport=http' }
      } catch (e) {
        return { ok: false, version: '-', detail: redactSecret(e?.message || String(e), key) }
      }
    },

    async discover() {
      const warnings = []
      const key = resolveApiKey(cfg, env)
      if (!key) return { models: [], source: 'none', warnings: ['DEEPSEEK_API_KEY is not set'] }
      const url = modelsEndpoint(cfg)
      if (!url) return { models: [], source: 'none', warnings: ['providers.<name>.base_url is required for http-openai'] }
      try {
        const res = await fetchImpl(url, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) {
          warnings.push(redactSecret(`models request failed: HTTP ${res.status}`, key))
          return { models: [], source: 'none', warnings }
        }
        let data = null
        try { data = JSON.parse(await res.text()) } catch { data = null }
        const models = (data && Array.isArray(data.data) ? data.data : [])
          .filter((m) => m && m.id)
          .map((m) => ({ id: String(m.id), displayName: String(m.id) }))
        if (!models.length) warnings.push('models endpoint returned no models')
        return { models, source: 'api', warnings }
      } catch (e) {
        warnings.push(redactSecret(`models request failed: ${e?.message || String(e)}`, key))
        return { models: [], source: 'none', warnings }
      }
    },

    async run({ prompt, cwd, model, effort, timeoutMs, logPath }) {
      void cwd
      void effort
      const key = resolveApiKey(cfg, env)
      if (!key) {
        return finish({
          exitCode: 1,
          error: 'auth_error: missing API key (set DEEPSEEK_API_KEY or providers.deepseek-api.options.apiKeyEnv)',
          logPath,
        })
      }
      const url = endpoint(cfg)
      if (!url) {
        return finish({
          exitCode: 1,
          error: 'http_openai_missing_base_url: providers.<name>.base_url is required',
          logPath, key,
        })
      }

      const options = cfg.options || {}
      const body = {
        model: String(model ?? ''),
        messages: [{ role: 'user', content: String(prompt ?? '') }],
      }
      if (Number.isFinite(options.maxTokens) && options.maxTokens > 0) body.max_tokens = Math.trunc(options.maxTokens)
      if (Number.isFinite(options.temperature)) body.temperature = options.temperature

      const limitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30 * 60_000
      const headers = {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      }

      appendLog(logPath, [
        '=== PROMPT ===',
        redactSecret(String(prompt ?? ''), key),
        `=== HTTP REQUEST POST ${url} ===`,
        `model=${body.model}${body.max_tokens != null ? ` max_tokens=${body.max_tokens}` : ''}`,
      ].join('\n'))

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let res
        try {
          res = await fetchWithTimeout(fetchImpl, url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }, limitMs)
        } catch (e) {
          const detail = String(e?.message || e)
          const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError' || /abort|timed? ?out/i.test(detail)
          if (timedOut) {
            appendLog(logPath, '=== HTTP TIMEOUT ===')
            return finish({ exitCode: 124, error: 'timeout', logPath, key })
          }
          return finish({ exitCode: 1, error: `network_error: ${detail}`, logPath, key })
        }

        let textBody = ''
        try {
          const raw = typeof res.text === 'function' ? await res.text() : ''
          textBody = typeof raw === 'string' ? raw : String(raw ?? '')
        } catch (e) {
          const detail = String(e?.message || e)
          const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError' || /abort|timed? ?out/i.test(detail)
          appendLog(logPath, `=== HTTP BODY READ FAILED ===\n${detail}`)
          return finish({
            exitCode: timedOut ? 124 : 1,
            error: timedOut ? 'timeout' : `network_error: ${detail}`,
            logPath, key,
          })
        }

        if (res.ok) {
          let parsed
          try { parsed = JSON.parse(textBody) } catch { parsed = null }
          if (!parsed || typeof parsed !== 'object') {
            appendLog(logPath, redactSecret(`=== HTTP 200 INVALID JSON ===\n${textBody}`, key))
            return finish({ exitCode: 1, error: 'invalid_json: response is not valid JSON', logPath, key })
          }
          appendLog(logPath, redactSecret(`=== RESPONSE HTTP ${res.status} ===\n${textBody}`, key))
          const reply = httpOpenAIReply(textBody)
          return finish({
            exitCode: 0,
            error: null,
            stdout: textBody,
            text: reply.text,
            modelResolved: reply.modelResolved,
            usage: usageOf(parsed),
            logPath,
            key,
          })
        }

        const failure = httpFailure(res.status, textBody, key)
        if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
          appendLog(logPath, `=== RETRY ${attempt + 1}/${MAX_RETRIES} after ${failure} ===`)
          await sleep(RETRY_BASE_MS * (2 ** attempt))
          continue
        }
        appendLog(logPath, `=== HTTP ${res.status} ===\n${failure}`)
        return finish({ exitCode: 1, error: failure, logPath, key })
      }

      // 循环一定会 return；保留兜底避免 future 改动后返回 undefined。
      return finish({ exitCode: 1, error: 'http_openai_retry_exhausted', logPath, key })
    },
  }
}

export const httpOpenAI = (cfg) => createHttpOpenAI(cfg)
