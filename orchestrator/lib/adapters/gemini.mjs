import fs from 'node:fs'
import path from 'node:path'
import { runCapture, runProcess, resolveCommand } from '../process.mjs'
import { lastJson, envFor, failureText } from './shared.mjs'
import { geminiReply } from './reply.mjs'

const GEMINI_ID_RE = /gemini-[0-9][0-9A-Za-z.-]{1,40}/g

/** 过滤掉明显不是文本生成模型的 id；导出供测试 */
export function normalizeGeminiIds(ids) {
  const bad = /(?:-image|-tts|-embedding|-vision|-audio|-live|-robotics|-computer|nano-banana)/
  const set = new Set()
  for (const raw of ids) {
    const id = String(raw).replace(/["'`]/g, '').trim().replace(/[.,;)]+$/, '')
    if (!/^gemini-[0-9]/.test(id)) continue
    if (bad.test(id)) continue
    if (id.length > 60) continue
    set.add(id)
  }
  return [...set].sort()
}

function scanInstalled(cfg) {
  const warnings = []
  try {
    const r = resolveCommand(cfg.command)
    const entry = r.prefixArgs[0]
    const files = []
    if (entry && fs.existsSync(entry)) {
      files.push(entry)
      const dir = path.dirname(entry)
      let total = 0
      for (const f of fs.readdirSync(dir)) {
        if (!/\.(js|mjs|cjs)$/i.test(f)) continue
        const p = path.join(dir, f)
        try {
          const size = fs.statSync(p).size
          if (total + size > 200 * 1024 * 1024) break
          total += size
          files.push(p)
        } catch { /* ignore */ }
      }
    }
    const ids = []
    for (const f of files) {
      try {
        const size = fs.statSync(f).size
        if (size > 120 * 1024 * 1024) continue
        const text = fs.readFileSync(f, 'utf8')
        ids.push(...(text.match(GEMINI_ID_RE) || []))
      } catch { /* ignore */ }
    }
    return { ids: normalizeGeminiIds(ids), warnings }
  } catch (e) {
    return { ids: [], warnings: [`scan failed: ${e.message}`] }
  }
}

async function discoverViaApi(key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({
      id: String(m.name || '').replace(/^models\//, ''),
      displayName: m.displayName || String(m.name || '').replace(/^models\//, ''),
    }))
    .filter((m) => m.id)
}

export const gemini = (cfg) => ({
  id: 'gemini-cli',
  source: 'google',
  async check() {
    const env = envFor(cfg)
    const v = await runCapture(cfg.command, ['--version'], { env })
    const version = (String(v.stdout || '').match(/\d+\.\d+\.\d+/) || [''])[0]
    const hasKey = Boolean(process.env.GEMINI_API_KEY)
    return {
      ok: v.exitCode === 0,
      version,
      detail: hasKey ? 'auth=GEMINI_API_KEY' : 'auth=cli login (run gemini once to sign in)',
    }
  },
  async discover() {
    const warnings = []
    if (process.env.GEMINI_API_KEY) {
      try {
        const models = await discoverViaApi(process.env.GEMINI_API_KEY)
        if (models.length) return { models, source: 'api', warnings }
      } catch (e) {
        warnings.push(`api discovery failed: ${e.message}`)
      }
    }
    const scanned = scanInstalled(cfg)
    warnings.push(...scanned.warnings)
    if (scanned.ids.length) {
      return { models: scanned.ids.map((id) => ({ id, displayName: id })), source: 'cli-scan', warnings }
    }
    warnings.push('no model list found; set GEMINI_API_KEY or add models manually')
    return { models: [], source: 'none', warnings }
  },
  async run({ prompt, cwd, model, effort, timeoutMs, logPath }) {
    const env = envFor(cfg)
    const options = cfg.options || {}
    const args = [
      '-p', prompt, '-m', model, '-o', 'json',
      '--approval-mode', options.approvalMode || 'auto_edit',
      '--skip-trust',
    ]
    if (options.sandbox === true) args.push('--sandbox')

    const res = await runProcess({
      command: cfg.command, args, cwd, env, timeoutMs, logPath,
      header: '=== PROMPT ===\n' + prompt + '\n=== STREAM ===',
      stallMinutes: cfg.limits?.stallMinutes,
    })
    const j = lastJson(res.stdout)
    const reply = geminiReply(res.stdout)
    return {
      exitCode: res.timedOut ? 124 : res.exitCode,
      usage: null,
      usageSource: 'none',
      stdout: res.stdout,
      text: reply.text,
      modelResolved: reply.modelResolved,
      error: res.abortedReason || (res.timedOut ? 'timeout' : (res.spawnError || (j && j.error ? (j.error.message || j.error) : (res.exitCode === 0 ? null : (failureText(res) || `exit ${res.exitCode}`))))),
    }
  },
})
