/**
 * cursor-wsl.mjs — Cursor Agent CLI running inside WSL.
 *
 * Windows native Cursor CLI is unreliable for long tool-using runs; WSL's
 * `agent` binary is the supported path here. The provider config supplies
 * `wsl.exe` as command and `agent` is resolved inside the distro.
 */
import { runCapture, runProcess } from '../process.mjs'
import { parseEventLines, envFor, failureText } from './shared.mjs'
import { parseCursorModels } from './cursor.mjs'

function toWslPath(p) {
  const s = String(p || '')
  const m = s.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!m) return s.replaceAll('\\', '/')
  return `/mnt/${m[1].toLowerCase()}/` + m[2].replaceAll('\\', '/')
}

function q(s) { return "'" + String(s).replaceAll("'", "'\\''") + "'" }

function shell(cfg, cwd, model) {
  const args = ['agent', '-p', '--force', '--trust', '--output-format', 'stream-json', '--model', q(model)]
  return `cd ${q(toWslPath(cwd))} && ${args.join(' ')}`
}

export const cursorWsl = (cfg) => ({
  id: 'cursor-wsl',
  source: 'cursor',
  async check() {
    const env = envFor(cfg)
    const v = await runCapture(cfg.command, ['-e', 'bash', '-lc', 'agent --version'], { env })
    const s = await runCapture(cfg.command, ['-e', 'bash', '-lc', 'agent status'], { env })
    const auth = /not logged in/i.test(String(s.stdout || '') + String(s.stderr || '')) ? 'not logged in' : 'ok'
    return { ok: v.exitCode === 0 && auth === 'ok', version: String(v.stdout || '').trim().split(/\s+/).pop(), detail: `auth=${auth}` }
  },
  async discover() {
    const warnings = []
    try {
      const r = await runCapture(cfg.command, ['-e', 'bash', '-lc', 'agent models'], { env: envFor(cfg), timeoutMs: 60_000 })
      const models = parseCursorModels(String(r.stdout || '') + '\n' + String(r.stderr || ''))
      if (models.length) return { models, source: 'cli', warnings }
      warnings.push('no cursor models parsed')
      return { models: [], source: 'cli', warnings }
    } catch (e) {
      warnings.push(`agent models failed: ${e.message}`)
      return { models: [], source: 'none', warnings }
    }
  },
  async run({ prompt, cwd, model, timeoutMs, logPath }) {
    const env = envFor(cfg)
    const res = await runProcess({
      command: cfg.command, args: ['-e', 'bash', '-lc', shell(cfg, cwd, model)], cwd, env, timeoutMs, logPath,
      input: prompt,
      header: '=== PROMPT ===\n' + prompt + '\n=== STREAM ===',
      stallMinutes: cfg.limits?.stallMinutes,
      apiStallSeconds: cfg.limits?.apiStallSeconds ?? 300,
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
    return {
      exitCode: res.timedOut ? 124 : res.exitCode,
      usage,
      usageSource: usage ? 'cli_json' : 'none',
      modelResolved: null,
      error: res.abortedReason || (res.timedOut ? 'timeout' : (res.spawnError || failure || (res.exitCode === 0 ? null : (failureText(res) || `exit ${res.exitCode}`)))),
    }
  },
})
