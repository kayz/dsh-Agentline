/**
 * cursor.mjs — Cursor Agent CLI adapter.
 *
 * The installed `agent.cmd` is a PowerShell launcher; running it through the
 * generic shim resolver is brittle. The provider config points at the version's
 * node.exe + index.js instead, so args are ordinary argv.
 */
import fs from 'node:fs'
import path from 'node:path'
import { runCapture, runProcess } from '../process.mjs'
import { parseEventLines, envFor, failureText } from './shared.mjs'
import { cursorReply } from './reply.mjs'

function cursorEntry(cfg) {
  if (cfg.entry) return cfg.entry
  const base = cfg.home || path.join(process.env.LOCALAPPDATA || '', 'cursor-agent', 'versions')
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(base, d.name))
    .sort()
    .reverse()
  for (const dir of dirs) {
    const entry = path.join(dir, 'index.js')
    if (fs.existsSync(entry)) return entry
  }
  throw new Error(`cursor agent entry not found under ${base}`)
}

/** Parse `agent models` text: "grok-4.7-high - Grok 4.7 High". */
export function parseCursorModels(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([a-z0-9][a-z0-9._-]*)\s+-\s+(.+?)\s*$/i)
    if (!m) continue
    if (m[1] === 'auto') continue
    out.push({ id: m[1], displayName: m[2] })
  }
  return out
}

export const cursor = (cfg) => ({
  id: 'cursor-agent',
  source: 'cursor',
  // `cursor-agent --help` 有 `--resume [chatId]`，但本机无法验证非交互输出里的
  // session/chat id（模型列表与登录状态探测都因网络失败），因此按「未实现可用」
  // 声明 false；只有声明 true 且实现可用的 provider 才允许传 resume 参数。
  capabilities: { session_resume: false },
  resumeArgs: () => [],
  async check() {
    const env = envFor(cfg)
    const entry = cursorEntry(cfg)
    const v = await runCapture(cfg.command, [entry, '--version'], { env })
    const version = String(v.stdout || '').match(/\d{4}\.\d{2}\.\d{2}-[a-f0-9]+/)?.[0] || ''
    const s = await runCapture(cfg.command, [entry, 'status'], { env })
    const auth = /not logged in/i.test(String(s.stdout || '') + String(s.stderr || '')) ? 'not logged in' : 'ok'
    return { ok: v.exitCode === 0 && auth === 'ok', version, detail: `auth=${auth}` }
  },
  async discover() {
    const warnings = []
    try {
      const r = await runCapture(cfg.command, [cursorEntry(cfg), 'models'], { env: envFor(cfg), timeoutMs: 60_000 })
      const models = parseCursorModels(String(r.stdout || '') + '\n' + String(r.stderr || ''))
      if (models.length) return { models, source: 'cli', warnings }
      warnings.push('no cursor models parsed')
      return { models: [], source: 'cli', warnings }
    } catch (e) {
      warnings.push(`cursor models failed: ${e.message}`)
      return { models: [], source: 'none', warnings }
    }
  },
  async run({ prompt, cwd, model, timeoutMs, logPath }) {
    const env = envFor(cfg)
    const entry = cursorEntry(cfg)
    const args = [
      '-p', '--force', '--output-format', 'stream-json',
      '--model', model, '--workspace', cwd,
    ]
    const res = await runProcess({
      command: cfg.command, prefixArgs: [entry], args, cwd, env, timeoutMs, logPath,
      input: prompt,
      header: '=== PROMPT ===\n' + prompt + '\n=== STREAM ===',
      stallMinutes: cfg.limits?.stallMinutes,
      apiStallSeconds: cfg.limits?.apiStallSeconds ?? 120,
      toolStallMinutes: cfg.limits?.toolStallMinutes ?? 60,
    })
    let usage = null
    let failure = null
    for (const evt of parseEventLines(res.stdout)) {
      if (evt.type === 'result' && evt.usage) {
        usage = {
          input: evt.usage.input_tokens ?? null,
          output: evt.usage.output_tokens ?? null,
          cache_read: evt.usage.cache_read_input_tokens ?? null,
          cache_write: evt.usage.cache_creation_input_tokens ?? null,
          cost_usd: evt.total_cost_usd ?? null,
        }
      }
      if (evt.type === 'error') failure = evt.message || evt.error?.message || 'error event'
    }
    const reply = cursorReply(res.stdout)
    return {
      exitCode: res.timedOut ? 124 : res.exitCode,
      usage,
      usageSource: usage ? 'cli_json' : 'none',
      stdout: res.stdout,
      text: reply.text,
      modelResolved: reply.modelResolved,
      error: res.abortedReason || (res.timedOut ? 'timeout' : (res.spawnError || failure || (res.exitCode === 0 ? null : (failureText(res) || `exit ${res.exitCode}`)))),
    }
  },
})
