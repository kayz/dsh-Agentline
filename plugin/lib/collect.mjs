/**
 * collect.mjs — 四个用量源的采集与聚合（R3）
 *
 * 被 metrics.mjs（CLI）与 lib/dashboard.mjs（看板）共同引用，
 * 单独成文件以避免 metrics ⇄ dashboard 的循环依赖。
 *
 * 设计原则：任一源失败只影响自己，返回 ok=false + 原因，绝不阻塞其它源。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
const JSONL = path.join(DATA_DIR, 'metrics.jsonl')
export const DATA_FILE = JSONL
const HOME = os.homedir()

/** 插件设置提供的凭据覆盖（避免依赖本机 CLI 快照） */
let overrides = {}
export function setCredentialOverrides(v) { overrides = v && typeof v === 'object' ? v : {} }
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
function readText(p) { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

function rec(source, key, value, unit, extra = {}) {
  return { source, key, value, unit, ok: true, error: null, fetched_at: new Date().toISOString(), ...extra }
}
function fail(source, key, error, unit = null) {
  return { source, key, value: null, unit, ok: false, error, fetched_at: new Date().toISOString() }
}

async function getJson(url, headers = {}, timeoutMs = 15000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: ac.signal })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text }
    return { status: res.status, ok: res.ok, body }
  } finally { clearTimeout(timer) }
}

// ───────────────────────────── Claude ─────────────────────────────
// 注意：Claude 的 refresh 是 **轮换式**（换发后旧 access+refresh 立即失效）。
// 所以这里的原则是：换到就立刻落盘，失败了绝不改动原文件。
// 2026-10-28 教训：手工试验 refresh 却没保存新 token，导致 CLI 被登出。
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_CRED = path.join(HOME, '.claude', '.credentials.json')

function claudeCreds() {
  if (overrides.claudeAccessToken) return { file: null, oauth: { accessToken: String(overrides.claudeAccessToken), expiresAt: Date.now() + 3600_000, refreshToken: '' } }
  const c = readJson(CLAUDE_CRED)
  return c?.claudeAiOauth ? { file: c, oauth: c.claudeAiOauth } : null
}

function persistClaudeCreds(all, oauth) {
  try {
    const backup = CLAUDE_CRED + '.agentline-bak'
    if (!fs.existsSync(backup)) fs.copyFileSync(CLAUDE_CRED, backup)
    const next = { ...all, claudeAiOauth: { ...oauth } }
    const tmp = CLAUDE_CRED + '.agentline-tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, CLAUDE_CRED) // 原子替换，避免 CLI 读到半个文件
    return true
  } catch { return false }
}

async function refreshClaudeToken(creds) {
  const { file, oauth } = creds
  if (!oauth.refreshToken) return { ok: false, error: 'no refresh_token；请运行 claude auth login' }
  let r
  try {
    r = await fetch('https://console.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
    })
  } catch (e) { return { ok: false, error: String(e.message || e) } }

  const text = await r.text()
  if (r.status !== 200) {
    let why = `HTTP ${r.status}`
    try { why = `${why} ${JSON.parse(text).error || ''}`.trim() } catch { /* ignore */ }
    return { ok: false, error: `${why}；请运行 claude auth login` }
  }

  let t
  try { t = JSON.parse(text) } catch { return { ok: false, error: 'refresh 返回非 JSON' } }
  if (!t.access_token) return { ok: false, error: 'refresh 未返回 access_token' }

  const now = Date.now()
  const next = {
    ...oauth,
    accessToken: t.access_token,
    refreshToken: t.refresh_token || oauth.refreshToken,
    expiresAt: now + (t.expires_in ?? 28800) * 1000,
    refreshTokenExpiresAt: t.refresh_token_expires_in ? now + t.refresh_token_expires_in * 1000 : oauth.refreshTokenExpiresAt,
  }
  // 换到就立刻写回；写失败也必须返回新 token（内存里先用着）
  const persisted = persistClaudeCreds(file, next)
  return { ok: true, token: next.accessToken, persisted }
}

async function claudeUsage(token) {
  return getJson('https://api.anthropic.com/api/oauth/usage', {
    authorization: `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
    accept: 'application/json',
  })
}

const claudeSource = {
  id: 'claude',
  async read() {
    const creds = claudeCreds()
    if (!creds) return [fail('claude', 'claude.session', 'no credentials (~/.claude/.credentials.json)')]

    let { accessToken, expiresAt } = creds.oauth
    if (!accessToken) return [fail('claude', 'claude.session', 'no accessToken；请运行 claude auth login')]

    // 过期前 60 秒当作过期，主动刷新（避免正好在请求时失效）
    if (expiresAt && expiresAt - 60_000 < Date.now()) {
      const refreshed = await refreshClaudeToken(creds)
      if (!refreshed.ok) return [fail('claude', 'claude.session', `token 已过期：${refreshed.error}`)]
      accessToken = refreshed.token
    }

    try {
      let r = await claudeUsage(accessToken)
      // 401 可能是 CLI 刚轮换过 token（文件里已是新的）或我们手上的是旧的：重读一次文件再试
      if (r.status === 401) {
        const again = claudeCreds()
        if (again?.oauth?.accessToken && again.oauth.accessToken !== accessToken) {
          accessToken = again.oauth.accessToken
          r = await claudeUsage(accessToken)
        }
        // 仍然 401 且本地有 refresh_token：刷新一次再试
        if (r.status === 401 && again?.oauth?.refreshToken) {
          const refreshed = await refreshClaudeToken(again)
          if (refreshed.ok) r = await claudeUsage(refreshed.token)
        }
      }
      if (!r.ok || typeof r.body !== 'object') {
        return [fail('claude', 'claude.session', `HTTP ${r.status}`)]
      }
      const b = r.body
      const out = [
        rec('claude', 'claude.session', b.five_hour?.utilization ?? null, 'percent', { resets_at: b.five_hour?.resets_at || null }),
        rec('claude', 'claude.weekly', b.seven_day?.utilization ?? null, 'percent', { resets_at: b.seven_day?.resets_at || null }),
      ]
      const split = (b.seven_day_breakdown?.rows || []).map((x) => `${x.display_name}:${x.percent}%`).join(' / ')
      if (split) out.push(rec('claude', 'claude.split', split, 'text'))
      return out
    } catch (e) {
      return [fail('claude', 'claude.session', String(e.message || e))]
    }
  },
}

// ───────────────────────────── Codex ─────────────────────────────
const CODEX_AUTH = path.join(HOME, '.codex', 'auth.json')
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

function jwtExpMs(token) {
  try {
    const p = String(token).split('.')[1]
    const s = p.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (p.length % 4)) % 4)
    const claims = JSON.parse(Buffer.from(s, 'base64').toString('utf8'))
    return (claims.exp || 0) * 1000
  } catch { return 0 }
}

/** Codex 刷新：只读过期的，换到就立刻原子写回；失败不动原文件 */
async function refreshCodexToken() {
  const auth = readJson(CODEX_AUTH)
  const rt = auth?.tokens?.refresh_token
  if (!rt) return { ok: false, error: 'no refresh_token；请运行 codex login' }
  let r
  try {
    r = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: rt, client_id: CODEX_CLIENT_ID, scope: 'openid profile email offline_access' }),
    })
  } catch (e) { return { ok: false, error: String(e.message || e) } }

  const text = await r.text()
  if (r.status !== 200) {
    return { ok: false, error: `HTTP ${r.status}` + (() => { try { return ' ' + (JSON.parse(text).error || '') } catch { return '' } })() }
  }
  let t
  try { t = JSON.parse(text) } catch { return { ok: false, error: 'refresh 返回非 JSON' } }
  if (!t.access_token) return { ok: false, error: 'refresh 未返回 access_token' }

  const next = {
    ...auth,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...auth.tokens,
      access_token: t.access_token,
      refresh_token: t.refresh_token || auth.tokens.refresh_token,
      id_token: t.id_token || auth.tokens.id_token,
    },
  }
  try {
    const backup = CODEX_AUTH + '.agentline-bak'
    if (!fs.existsSync(backup)) fs.copyFileSync(CODEX_AUTH, backup)
    const tmp = CODEX_AUTH + '.agentline-tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, CODEX_AUTH)
  } catch { /* 写失败也在内存里用新 token */ }
  return { ok: true, token: t.access_token }
}

const codexSource = {
  id: 'codex',
  async read() {
    let auth = readJson(CODEX_AUTH)
    let token = overrides.codexAccessToken || auth?.tokens?.access_token
    const acct = overrides.codexAccountId || auth?.tokens?.account_id
    if (!token) return [fail('codex', 'codex.weekly', 'no token (~/.codex/auth.json)')]

    // 过期就先用 refresh_token 换新（Codex 的 access token 是 10 天有效）
    if (jwtExpMs(token) - 60_000 < Date.now()) {
      const refreshed = await refreshCodexToken()
      if (refreshed.ok) token = refreshed.token
      else return [fail('codex', 'codex.weekly', `token 已过期：${refreshed.error}`)]
    }
    try {
      const r = await getJson('https://chatgpt.com/backend-api/wham/usage', {
        authorization: `Bearer ${token}`,
        'chatgpt-account-id': acct || '',
        accept: 'application/json',
        originator: 'codex_cli_rs',
      })
      if (!r.ok || typeof r.body !== 'object') return [fail('codex', 'codex.weekly', `HTTP ${r.status}`)]
      const b = r.body
      const w = b.rate_limit?.primary_window || {}
      return [
        rec('codex', 'codex.weekly', w.used_percent ?? null, 'percent', {
          resets_at: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
          window_seconds: w.limit_window_seconds ?? null,
        }),
        rec('codex', 'codex.plan', b.plan_type ?? null, 'text'),
        rec('codex', 'codex.credits', b.credits?.balance ?? '0', 'credits'),
        rec('codex', 'codex.resets_left', b.rate_limit_reset_credits?.available_count ?? null, 'count'),
      ]
    } catch (e) {
      return [fail('codex', 'codex.weekly', String(e.message || e))]
    }
  },
}

// ───────────────────────────── Buddy 积分 ─────────────────────────────
function buddyAuth() {
  if (overrides.buddyAccessToken) return { token: String(overrides.buddyAccessToken), uid: overrides.buddyUserId || '', file: 'settings' }
  const dir = path.join(LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  for (const f of ['Tencent-Cloud.coding-copilot.info', 'workbuddy-desktop.info']) {
    const j = readJson(path.join(dir, f))
    if (!j) continue
    const tok = j?.auth?.accessToken || j?.account?.accessToken
    if (typeof tok === 'string' && tok) return { token: tok, uid: j?.account?.uid || j?.uid, file: f }
  }
  return null
}

const buddySource = {
  id: 'buddy',
  async read() {
    const a = buddyAuth()
    if (!a) return [fail('buddy', 'buddy.remaining', 'no credential (CLI 快照缺失或已加密)')]
    try {
      const r = await fetch('https://www.workbuddy.cn/billing/meter/get-user-resource-summary', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${a.token}`,
          'X-User-Id': String(a.uid || ''),
          'X-Client-Platform': 'web',
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          origin: 'https://www.workbuddy.cn',
          referer: 'https://www.workbuddy.cn/profile/plans-usage',
        },
        body: '{}',
      })
      const body = await r.json().catch(() => null)
      if (!r.ok || !body || body.code !== 0) return [fail('buddy', 'buddy.remaining', `HTTP ${r.status} code=${body?.code}`)]
      const pkgs = body.data?.Packages || []
      const num = (v) => Number(v) || 0
      const total = pkgs.reduce((s, p) => s + num(p.CycleTotalCapacity), 0)
      const remain = pkgs.reduce((s, p) => s + num(p.CycleRemainCapacity), 0)
      const used = pkgs.reduce((s, p) => s + num(p.CycleUsedCapacity), 0)
      return [
        rec('buddy', 'buddy.remaining', Math.round(remain * 100) / 100, 'credits'),
        rec('buddy', 'buddy.total', Math.round(total * 100) / 100, 'credits'),
        rec('buddy', 'buddy.used', Math.round(used * 100) / 100, 'credits'),
        rec('buddy', 'buddy.percent', total ? Math.round((used / total) * 1000) / 10 : null, 'percent'),
        rec('buddy', 'buddy.plan', body.data?.SubscriptionPackageName ?? null, 'text'),
      ]
    } catch (e) {
      return [fail('buddy', 'buddy.remaining', String(e.message || e))]
    }
  },
}

// ───────────────────────────── DeepSeek ─────────────────────────────
function deepseekKey() {
  if (overrides.deepseekApiKey) return String(overrides.deepseekApiKey).trim()
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim()
  const y = readText(path.join(HOME, '.dsh', '.credentials.yaml'))
  const m = y && y.match(/^\s+DEEPSEEK_API_KEY:\s*(\S+)\s*$/m)
  return m ? m[1].trim() : null
}

const deepseekSource = {
  id: 'deepseek',
  async read() {
    const key = deepseekKey()
    if (!key) return [fail('deepseek', 'deepseek.balance', 'no key (env 或 ~/.dsh/.credentials.yaml)')]
    try {
      const r = await getJson('https://api.deepseek.com/user/balance', { authorization: `Bearer ${key}`, accept: 'application/json' })
      if (!r.ok || typeof r.body !== 'object') return [fail('deepseek', 'deepseek.balance', `HTTP ${r.status}`)]
      const b = r.body
      const info = (b.balance_infos || [])[0] || {}
      return [
        rec('deepseek', 'deepseek.balance', info.total_balance != null ? Number(info.total_balance) : null, 'cny'),
        rec('deepseek', 'deepseek.granted', info.granted_balance != null ? Number(info.granted_balance) : null, 'cny'),
        rec('deepseek', 'deepseek.available', !!b.is_available, 'bool'),
      ]
    } catch (e) {
      return [fail('deepseek', 'deepseek.balance', String(e.message || e))]
    }
  },
}

export const SOURCES = [claudeSource, codexSource, buddySource, deepseekSource]

export async function collectAll() {
  const results = await Promise.all(SOURCES.map(async (s) => {
    try { return await s.read() } catch (e) { return [fail(s.id, `${s.id}.error`, String(e.message || e))] }
  }))
  return results.flat()
}

export function appendJsonl(records) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.appendFileSync(JSONL, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

/** 聚合各任务 run.json 的 token 消耗 */
export function aggregateTokens(repo) {
  const base = path.join(repo, '.collab', 'tasks')
  const out = { byRole: {}, byModel: {}, total: { input: 0, output: 0, cache_read: 0, cost_usd: 0 }, tasks: [] }
  let dirs = []
  try { dirs = fs.readdirSync(base).map((d) => ({ id: d, dir: path.join(base, d) })) } catch { dirs = [] }
  const wtRoot = path.join(repo, '.collab', 'worktrees')
  try {
    for (const wt of fs.readdirSync(wtRoot)) {
      const d = path.join(wtRoot, wt, '.collab', 'tasks', wt)
      if (fs.existsSync(d)) dirs.push({ id: wt, dir: d })
    }
  } catch { /* no worktrees */ }
  for (const { id: taskId, dir: taskDir } of dirs) {
    const runs = readJson(path.join(taskDir, 'run.json'))
    if (!Array.isArray(runs)) continue
    const st = readJson(path.join(taskDir, 'state.json'))
    let inSum = 0; let outSum = 0
    for (const r of runs) {
      const u = r.usage
      if (!u) continue
      const role = r.role || 'unknown'
      const model = r.model_resolved || r.model_requested || 'unknown'
      out.byRole[role] = out.byRole[role] || { input: 0, output: 0, calls: 0 }
      out.byModel[model] = out.byModel[model] || { input: 0, output: 0, calls: 0 }
      out.byRole[role].input += u.input || 0; out.byRole[role].output += u.output || 0; out.byRole[role].calls++
      out.byModel[model].input += u.input || 0; out.byModel[model].output += u.output || 0; out.byModel[model].calls++
      out.total.input += u.input || 0; out.total.output += u.output || 0
      out.total.cache_read += u.cache_read || 0; out.total.cost_usd += u.cost_usd || 0
      inSum += u.input || 0; outSum += u.output || 0
    }
    out.tasks.push({ id: taskId, status: st?.status || '?', model: st?.model || '-', input: inSum, output: outSum })
  }
  return out
}


