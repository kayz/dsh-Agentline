import { runCapture, runProcess } from '../process.mjs'
import { lastJson, parseEventLines, envFor, effortArgs, failureText } from './shared.mjs'
import { codebuddyReply } from './reply.mjs'
import { classifyClaudeLine } from './claude.mjs'

/** 从 `--help` 文本里解析 CodeBuddy 支持的模型；导出供测试 */
export function parseCodebuddyModels(helpText) {
  const text = String(helpText || '').replace(/\r/g, '')
  const m = text.match(/Currently supported:\s*\(([^)]+)\)/i)
  if (!m) return []
  return m[1].split(',').map((s) => s.trim()).filter(Boolean)
}

export const codebuddy = (cfg) => ({
  id: 'codebuddy-cli',
  source: 'tencent',
  async check() {
    const env = envFor(cfg)
    const v = await runCapture(cfg.command, ['--version'], { env })
    const version = (String(v.stdout || '').match(/\d+\.\d+\.\d+/) || [''])[0]
    return { ok: v.exitCode === 0, version, detail: version ? 'auth via workbuddy account' : (String(v.stderr || '').trim().slice(0, 120) || 'no version') }
  },
  async discover() {
    const warnings = []
    try {
      const r = await runCapture(cfg.command, ['--help'], { env: envFor(cfg), timeoutMs: 30_000 })
      const models = parseCodebuddyModels(String(r.stdout || '') + '\n' + String(r.stderr || ''))
      if (models.length) return { models: models.map((id) => ({ id, displayName: id })), source: 'cli', warnings }
      warnings.push('no model list found in --help')
      return { models: [], source: 'cli', warnings }
    } catch (e) {
      warnings.push(`--help failed: ${e.message}`)
      return { models: [], source: 'none', warnings }
    }
  },
  async run({ prompt, cwd, model, effort, timeoutMs, logPath }) {
    const env = envFor(cfg)
    const options = cfg.options || {}
    const args = [
      '-p', prompt, '--model', model,
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', options.permissionMode || 'acceptEdits',
    ]
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
    const results = events.filter((x) => x && x.type === 'result')
    const j = results.length ? results[results.length - 1] : lastJson(res.stdout)
    const usage = j && j.usage ? {
      input: j.usage.input_tokens ?? null,
      output: j.usage.output_tokens ?? null,
      cache_read: j.usage.cache_read_input_tokens ?? null,
      cache_write: j.usage.cache_creation_input_tokens ?? null,
      cost_usd: j.total_cost_usd ?? null,
    } : null
    const reply = codebuddyReply(res.stdout)
    const apiError = j && j.is_error ? (j.result || j.error?.message || 'is_error') : null
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
