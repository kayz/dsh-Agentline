/**
 * grok-cli.mjs — xAI Grok CLI adapter.
 *
 * 实测可用调用：grok.exe -p "<prompt>" -m grok-4.7
 * 参数作为普通 argv 传给 runProcess（child_process.spawn，shell 默认 false），不做 shell 拼接。
 * 普通文本输出不含模型身份字段，因此 modelResolved 永远由解析器返回 null（见 reply.mjs）。
 */
import { runProcess } from '../process.mjs'
import { envFor, failureText } from './shared.mjs'
import { grokReply } from './reply.mjs'

/** `grok models` 的文本行 → 模型 id；导出供测试。 */
export function parseGrokModels(text) {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.trim().match(/^[-*]?\s*(grok-[a-z0-9][a-z0-9._-]*)\b/i)
    if (!m || out.includes(m[1])) continue
    out.push(m[1])
  }
  return out
}

/**
 * @param {object} cfg provider 配置
 * @param {{ runProcess?: Function }} [deps] 测试注入点
 */
export function createGrokCli(cfg, deps = {}) {
  const runProcessImpl = deps.runProcess || runProcess

  return {
    id: 'grok-cli',
    source: String(cfg?.source || 'xai').toLowerCase(),
    // 本机没有安装 grok，adapter 的实测调用形态（-p/-m）没有 resume/session 参数；
    // 声明 false，由调度器显式降级为新建会话。
    capabilities: { session_resume: false },
    resumeArgs: () => [],

    async check() {
      const res = await runProcessImpl({
        command: cfg.command, args: ['models'], cwd: process.cwd(),
        env: envFor(cfg), timeoutMs: 30_000, stallMinutes: 0,
      })
      const models = parseGrokModels(res.stdout)
      if (res.timedOut) return { ok: false, version: '-', detail: 'timeout' }
      if (res.exitCode !== 0) {
        return { ok: false, version: '-', detail: failureText(res) || `exit ${res.exitCode}` }
      }
      return {
        ok: models.length > 0,
        version: '-',
        detail: models.length ? `models=${models.length}` : 'no grok models parsed',
      }
    },

    async discover() {
      const warnings = []
      try {
        const res = await runProcessImpl({
          command: cfg.command, args: ['models'], cwd: process.cwd(),
          env: envFor(cfg), timeoutMs: 60_000, stallMinutes: 0,
        })
        if (res.timedOut) throw new Error('timeout')
        const models = parseGrokModels(res.stdout)
        if (models.length) {
          return {
            models: models.map((id) => ({ id, displayName: id })),
            source: 'cli',
            warnings,
          }
        }
        warnings.push(failureText(res) || 'no grok models parsed')
        return { models: [], source: 'cli', warnings }
      } catch (e) {
        warnings.push(`grok models failed: ${e?.message || String(e)}`)
        return { models: [], source: 'none', warnings }
      }
    },

    async run({ prompt, cwd, model, effort, timeoutMs, logPath }) {
      void effort
      // 实测可用形态，顺序固定；prompt 与 model 分别占一个 argv。
      const args = ['-p', String(prompt ?? ''), '-m', String(model ?? '')]
      const res = await runProcessImpl({
        command: cfg.command, args, cwd, env: envFor(cfg), timeoutMs, logPath,
        header: '=== PROMPT ===\n' + prompt + '\n=== STREAM ===',
        stallMinutes: cfg.limits?.stallMinutes,
      })
      const reply = grokReply(res.stdout)
      const error = res.abortedReason
        || (res.timedOut ? 'timeout' : (res.spawnError || (res.exitCode === 0 ? null : (failureText(res) || `exit ${res.exitCode}`))))
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

export const grokCli = (cfg) => createGrokCli(cfg)
