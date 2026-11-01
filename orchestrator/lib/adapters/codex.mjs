import { runCapture, runProcess } from '../process.mjs'
import { lastJson, envFor, effortArgs } from './shared.mjs'

/** 把 `codex debug models` 的 JSON 归一化；导出供测试 */
export function parseCodexModels(data) {
  if (!data || !Array.isArray(data.models)) return []
  return data.models
    .filter((m) => m && m.slug && m.visibility !== 'hidden')
    .map((m) => ({
      id: m.slug,
      displayName: m.display_name || m.slug,
      efforts: (m.supported_reasoning_levels || []).map((x) => x.effort).filter(Boolean),
    }))
}

export const codex = (cfg) => ({
  id: 'codex-cli',
  source: 'openai',
  async check() {
    const env = envFor(cfg)
    const v = await runCapture(cfg.command, ['--version'], { env })
    const version = (String(v.stdout || '').match(/\d+\.\d+\.\d+(?:-alpha\.\d+)?/) || [''])[0]
    let auth = 'unknown'
    const checkArgs = cfg.auth?.check || ['login', 'status']
    if (checkArgs.length) {
      const l = await runCapture(cfg.command, checkArgs, { env })
      auth = l.exitCode === 0 && /logged in/i.test(String(l.stdout || '') + String(l.stderr || '')) ? 'ok' : 'not logged in'
    }
    return { ok: v.exitCode === 0 && auth !== 'not logged in', version, detail: `auth=${auth}` }
  },
  async discover() {
    const warnings = []
    try {
      const r = await runCapture(cfg.command, ['debug', 'models'], { env: envFor(cfg), timeoutMs: 60_000 })
      const data = lastJson(r.stdout)
      if (!data || !Array.isArray(data.models)) throw new Error('unexpected output')
      const models = parseCodexModels(data)
      if (models.length) return { models, source: 'cli', warnings }
      warnings.push('debug models returned no models')
      return { models: [], source: 'cli', warnings }
    } catch (e) {
      warnings.push(`debug models failed: ${e.message}`)
      return { models: [], source: 'none', warnings }
    }
  },
  async run({ prompt, cwd, model, effort, timeoutMs, logPath }) {
    const env = envFor(cfg)
    const options = cfg.options || {}
    const sandbox = options.sandbox || 'workspace-write'
    const approval = options.approvalPolicy || 'never'
    const args = [
      'exec', prompt, '--model', model,
      '-c', `approval_policy="${approval}"`,
      '-s', sandbox,
      '-C', cwd, '--skip-git-repo-check', '--json',
    ]
    const level = effortArgs(cfg, effort)
    if (level) args.push('-c', `model_reasoning_effort=${level}`)

    const res = await runProcess({
      command: cfg.command, args, cwd, env, timeoutMs, logPath,
      header: '=== PROMPT ===\n' + prompt + '\n=== STREAM ===',
      stallMinutes: cfg.limits?.stallMinutes,
    })

    let usage = null
    let failure = null
    for (const line of String(res.stdout || '').split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      let evt
      try { evt = JSON.parse(t) } catch { continue }
      if (!usage && evt.usage && evt.usage.input_tokens != null) {
        usage = {
          input: evt.usage.input_tokens ?? null,
          output: evt.usage.output_tokens ?? null,
          cache_read: evt.usage.cached_input_tokens ?? null,
          cache_write: evt.usage.cache_write_input_tokens ?? null,
          cost_usd: null,
        }
      }
      if (evt.type === 'turn.completed' && evt.usage) {
        usage = {
          input: evt.usage.input_tokens ?? null,
          output: evt.usage.output_tokens ?? null,
          cache_read: evt.usage.cached_input_tokens ?? null,
          cache_write: evt.usage.cache_write_input_tokens ?? null,
          cost_usd: null,
        }
      }
      if (evt.type === 'turn.failed') failure = evt.error?.message || 'turn failed'
      if (evt.type === 'error' && !failure) failure = evt.message || 'error event'
    }
    return {
      exitCode: res.timedOut ? 124 : res.exitCode,
      usage,
      usageSource: usage ? 'cli_json' : 'none',
      modelResolved: null,
      error: res.abortedReason || (res.timedOut ? 'timeout' : (res.spawnError || failure || (res.exitCode === 0 ? null : `exit ${res.exitCode}`))),
    }
  },
})
