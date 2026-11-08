import fs from 'node:fs'
import { runCapture, runProcess, resolveCommand } from '../process.mjs'
import { lastJson, parseEventLines, envFor, effortArgs, failureText } from './shared.mjs'
import { claudeReply } from './reply.mjs'

/** 解析 Claude stream-json 行：tool_use/tool_result 用于区分「工具在跑」与「API 静默」 */
export function classifyClaudeLine(line) {
  const t = String(line || '').trim()
  if (!t.startsWith('{')) return null
  let e
  try { e = JSON.parse(t) } catch { return null }
  if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    const tool = e.message.content.find((b) => b && b.type === 'tool_use')
    if (tool) return { kind: 'tool_start', id: tool.id }
    return { kind: 'activity' }
  }
  if (e.type === 'user' && Array.isArray(e.message?.content)) {
    const res = e.message.content.find((b) => b && b.type === 'tool_result')
    if (res) return { kind: 'tool_end', id: res.tool_use_id }
    return { kind: 'activity' }
  }
  if (e.type === 'rate_limit_event') {
    const status = e.rate_limit_info?.status
    if (/rejected|blocked|exceeded|denied/i.test(String(status || ''))) {
      return { kind: 'error', reason: `rate_limit ${status}` }
    }
    return { kind: 'activity' }
  }
  if (e.type === 'result') return e.is_error ? { kind: 'error', reason: e.result || 'result error' } : { kind: 'activity' }
  if (e.type === 'error') return { kind: 'error', reason: e.message || 'error' }
  return { kind: 'activity' }
}
const MODEL_ID_RE = /claude-(?:opus|sonnet|haiku)-[0-9][0-9A-Za-z.-]*/g

/** 从 Claude 可执行文件/JS 包中抽取模型 id；导出供测试 */
export function normalizeClaudeIds(ids) {
  const set = new Set()
  for (const raw of ids) {
    let id = String(raw).replace(/["'`]/g, '').trim()
    if (!/^claude-(opus|sonnet|haiku)-\d/.test(id)) continue
    id = id.replace(/-v\d+$/, '')
    if (id.length > 60) continue
    set.add(id)
  }
  const bases = new Set()
  for (const id of set) {
    const m = id.match(/^(claude-(?:opus|sonnet|haiku)-\d+(?:-\d+)?)-\d{8}$/)
    if (m) bases.add(m[1])
  }
  const out = []
  for (const id of set) {
    const m = id.match(/^(claude-(?:opus|sonnet|haiku)-\d+(?:-\d+)?)-\d{8}$/)
    if (m && bases.has(m[1])) continue
    out.push(id)
  }
  return out.sort()
}

function scanIds(cfg) {
  const r = resolveCommand(cfg.command)
  const file = r.prefixArgs[0] || r.command
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > 400 * 1024 * 1024) return { ids: [], warning: `skip scan: ${file} is too large` }
    const text = fs.readFileSync(file).toString('latin1')
    return { ids: normalizeClaudeIds(text.match(MODEL_ID_RE) || []), warning: null }
  } catch (e) {
    return { ids: [], warning: `scan failed: ${e.message}` }
  }
}

async function discoverViaApi(key) {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return (data.data || []).map((m) => ({ id: m.id, displayName: m.display_name || m.id }))
}

/**
 * Claude Code 的会话参数（本机 `claude --help` 实测）：
 *   -r, --resume [value]   Resume a conversation by session ID or name
 *   --session-id <uuid>    Use a specific session ID for the conversation
 * stream-json 的 system/init 与 result 事件都带 `session_id`，可直接作为 resume token。
 */
const resumeArgs = (token) => ['--resume', String(token)]

export const claude = (cfg) => ({
  id: 'claude-cli',
  source: 'anthropic',
  capabilities: {
    session_resume: true,
    session: {
      id_from: 'stdout_json',
      id_path: 'session_id',
      reset_on: ['model_change', 'provider_change', 'contract_change'],
    },
  },
  resumeArgs,
  async version() {
    const res = await runCapture(cfg.command, ['--version'], { env: envFor(cfg) })
    return (String(res.stdout || '').match(/\d+\.\d+\.\d+/) || [''])[0] || null
  },
  async check() {
    const env = envFor(cfg)
    const v = await runCapture(cfg.command, ['--version'], { env })
    const version = (String(v.stdout || '').match(/\d+\.\d+\.\d+/) || [''])[0]
    let auth = 'unknown'
    const checkArgs = cfg.auth?.check || ['auth', 'status']
    if (checkArgs.length) {
      const a = await runCapture(cfg.command, checkArgs, { env })
      const j = lastJson(a.stdout)
      auth = a.exitCode === 0 && (!j || j.loggedIn !== false) ? 'ok' : 'not logged in'
    }
    return { ok: v.exitCode === 0 && auth !== 'not logged in', version, detail: `auth=${auth}` }
  },
  async discover() {
    const warnings = []
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const models = await discoverViaApi(process.env.ANTHROPIC_API_KEY)
        if (models.length) return { models, source: 'api', warnings }
      } catch (e) {
        warnings.push(`api discovery failed: ${e.message}`)
      }
    }
    const scanned = scanIds(cfg)
    if (scanned.warning) warnings.push(scanned.warning)
    if (scanned.ids.length) {
      return { models: scanned.ids.map((id) => ({ id, displayName: id })), source: 'cli-scan', warnings }
    }
    warnings.push('no model list found; set ANTHROPIC_API_KEY or add models manually')
    return { models: [], source: 'none', warnings }
  },
  async run({ prompt, cwd, model, effort, timeoutMs, logPath, resumeToken = null }) {
    const env = envFor(cfg)
    const options = cfg.options || {}
    const args = [
      '-p', prompt, '--model', model,
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', options.permissionMode || 'acceptEdits',
      '--allowedTools', (options.allowedTools || ['Read', 'Write', 'Edit']).join(','),
    ]
    if (resumeToken) args.push(...resumeArgs(resumeToken))
    const level = effortArgs(cfg, effort)
    if (level) args.push('--effort', level)

    const res = await runProcess({
      command: cfg.command, args, cwd, env, timeoutMs, logPath,
      header: '=== PROMPT ===\n' + prompt + '\n=== STREAM ===',
      stallMinutes: cfg.limits?.stallMinutes,
      classify: classifyClaudeLine,
      apiStallSeconds: cfg.limits?.apiStallSeconds ?? 120,
      toolStallMinutes: cfg.limits?.toolStallMinutes ?? 60,
    })
    const events = parseEventLines(res.stdout)
    const final = events.filter((e) => e && e.type === 'result').pop() || null
    const j = final || lastJson(res.stdout)
    const usage = j && j.usage ? {
      input: j.usage.input_tokens ?? null,
      output: j.usage.output_tokens ?? null,
      cache_read: j.usage.cache_read_input_tokens ?? null,
      cache_write: j.usage.cache_creation_input_tokens ?? null,
      cost_usd: j.total_cost_usd ?? null,
    } : null
    const reply = claudeReply(res.stdout)
    const apiError = final && final.is_error ? (final.result || 'is_error') : null
    return {
      exitCode: res.timedOut ? 124 : res.exitCode,
      usage,
      usageSource: usage ? 'cli_json' : 'none',
      stdout: res.stdout,
      text: reply.text,
      modelResolved: reply.modelResolved,
      error: res.abortedReason || (res.timedOut ? 'timeout' : (res.spawnError || apiError || (res.exitCode === 0 ? null : (failureText(res) || `exit ${res.exitCode}`)))),
    }
  },
})

