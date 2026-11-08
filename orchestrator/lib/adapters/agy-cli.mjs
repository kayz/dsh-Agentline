/**
 * agy-cli.mjs — antigravity CLI（`agy`）adapter。
 *
 * 实测可用调用（3/3 成功）：
 *   agy.exe --print=<完整 prompt> --model <model-id>
 * `--print=` 必须用 `=` 连接（`-p <prompt>` 会报错）；prompt 里的空格没问题，因为参数作为
 * 普通 argv 交给 runProcess（child_process.spawn，shell 默认 false），不经过 shell 拼接。
 *
 * 输出默认 text。`--output-format json` 实测返回
 *   { conversation_id, status, response, duration_seconds, num_turns, usage }
 * 不含任何 model 字段，所以 modelResolved 恒为 null（见 reply.mjs）。
 *
 * 配额错误实测：exit 3，stderr 同时给出
 *   error: Individual quota reached. ...
 *   AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): ...","error_code":429,...}
 * 这里映射成 `quota_exceeded (429): ...`，保留原文与 429，交给 classifyError 归到 rate_limit。
 */
import { runProcess } from '../process.mjs'
import { envFor, failureText, lastJson } from './shared.mjs'
import { agyReply } from './reply.mjs'

/** 模型 id 只由字母数字和 . _ - 组成；用来跳过 "Available models:" 之类表头。 */
const AGY_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 表头/提示行即使只有一个词，也不能当模型 id。 */
const AGY_NOT_MODEL_RE = /^(?:available|fetching|models?|id|name|usage|model)$/i

/** quota 类失败的关键字；命中后单独成码，避免被普通 stderr 折叠掉。 */
const QUOTA_RE = /individual quota reached|insufficient_quota|resource_exhausted|quota (?:exceeded|exhausted|reached)|usage limit|额度|配额/i

/**
 * `agy models` 的文本行 → [{id, displayName}]。
 * 实测格式是「id<TAB>显示名」；同时兼容多空格、` - ` 与只给 id 的行。导出供测试。
 */
export function parseAgyModelEntries(text) {
  const out = []
  const seen = new Set()
  for (const raw of String(text || '').split(/\r?\n/)) {
    // models 列表有时带 ANSI 颜色；去掉后再解析。
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim()
    if (!line) continue
    const stripped = line.replace(/^[-*]\s+/, '')
    const parts = stripped.split(/\t+|\s{2,}|\s+-\s+/)
    const id = String(parts[0] || '').trim()
    if (!AGY_MODEL_ID_RE.test(id) || AGY_NOT_MODEL_RE.test(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    const displayName = parts.slice(1).join(' ').trim() || id
    out.push({ id, displayName })
  }
  return out
}

/** `agy models` 的文本行 → 模型 id 列表；导出供测试。 */
export function parseAgyModels(text) {
  return parseAgyModelEntries(text).map((m) => m.id)
}

/** 从 stdout JSON 或 stderr 里摘出 quota 原文；找不到时返回空串。 */
function quotaDetail(res) {
  const parsed = lastJson(res?.stdout)
  if (parsed && typeof parsed.error === 'string' && QUOTA_RE.test(parsed.error)) {
    return parsed.error.trim()
  }
  for (const line of String(res?.stderr || '').split(/\r?\n/)) {
    const t = line.trim()
    if (t && QUOTA_RE.test(t)) return t.replace(/^error:\s*/i, '').trim()
  }
  return ''
}

/**
 * 失败文案：quota 单独成码并保留原文，其余沿用 stderr 尾部。
 * 不吞掉 stderr，否则 classifyError 没法把 429/限流识别出来。
 */
export function agyFailureText(res) {
  const parsed = lastJson(res?.stdout)
  const stdoutError = parsed && typeof parsed.error === 'string' ? parsed.error.trim() : ''
  if (QUOTA_RE.test([String(res?.stderr || ''), stdoutError, String(res?.stdout || '')].join('\n'))) {
    const detail = quotaDetail(res)
    return `quota_exceeded (429): ${detail || 'quota reached'}`
  }
  return failureText(res) || (stdoutError ? `agy_error: ${stdoutError}` : `exit ${res?.exitCode}`)
}

/**
 * @param {object} cfg provider 配置
 * @param {{ runProcess?: Function }} [deps] 测试注入点（不发起真实网络/子进程）
 */
export function createAgyCli(cfg, deps = {}) {
  const runProcessImpl = deps.runProcess || runProcess

  return {
    id: 'agy-cli',
    source: String(cfg?.source || 'antigravity').toLowerCase(),
    // 本机没有安装 agy；已知调用形态只有 --print=/--model，没有可核实的 resume 参数。
    capabilities: { session_resume: false },
    resumeArgs: () => [],

    async check() {
      const res = await runProcessImpl({
        command: cfg.command, args: ['--version'], cwd: process.cwd(),
        env: envFor(cfg), timeoutMs: 30_000, stallMinutes: 0,
      })
      const version = (String(res.stdout || '').match(/\d+\.\d+\.\d+/) || [''])[0]
      if (res.timedOut) return { ok: false, version: version || '-', detail: 'timeout' }
      if (res.exitCode !== 0) {
        return { ok: false, version: version || '-', detail: failureText(res) || `exit ${res.exitCode}` }
      }
      return { ok: true, version: version || '-', detail: version ? `version=${version}` : 'version not reported' }
    },

    async discover() {
      const warnings = []
      try {
        const res = await runProcessImpl({
          command: cfg.command, args: ['models'], cwd: process.cwd(),
          env: envFor(cfg), timeoutMs: 60_000, stallMinutes: 0,
        })
        if (res.timedOut) throw new Error('timeout')
        const entries = parseAgyModelEntries(res.stdout)
        if (entries.length) {
          return { models: entries, source: 'cli', warnings }
        }
        warnings.push(failureText(res) || 'no agy models parsed')
        return { models: [], source: 'cli', warnings }
      } catch (e) {
        warnings.push(`agy models failed: ${e?.message || String(e)}`)
        return { models: [], source: 'none', warnings }
      }
    },

    async run({ prompt, cwd, model, effort, timeoutMs, logPath }) {
      void effort
      // 实测可用形态：--print= 必须与 prompt 用 `=` 连接，两者各占一个 argv。
      const args = ['--print=' + String(prompt ?? ''), '--model', String(model ?? '')]
      const res = await runProcessImpl({
        command: cfg.command, args, cwd, env: envFor(cfg), timeoutMs, logPath,
        header: '=== PROMPT ===\n' + prompt + '\n=== STREAM ===',
        stallMinutes: cfg.limits?.stallMinutes,
      })
      const reply = agyReply(res.stdout)
      const error = res.abortedReason
        || (res.timedOut ? 'timeout' : (res.spawnError || (res.exitCode === 0 ? null : agyFailureText(res))))
      return {
        exitCode: res.timedOut ? 124 : res.exitCode,
        usage: null,
        usageSource: 'none',
        stdout: res.stdout,
        text: reply.text,
        modelResolved: reply.modelResolved,
        error,
      }
    },
  }
}

export const agyCli = (cfg) => createAgyCli(cfg)
