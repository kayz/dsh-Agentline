/**
 * adapters/shared.mjs — adapter 共用的小工具
 */
export function lastJson(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null
  try { return JSON.parse(trimmed) } catch { /* fall through */ }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)) } catch { /* ignore */ }
  }
  return null
}

export function parseEventLines(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { out.push(JSON.parse(t)) } catch { /* partial line */ }
  }
  return out
}

export function uniqModels(list) {
  const seen = new Set()
  const out = []
  for (const m of list) {
    if (!m || !m.id || seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}

export function envFor(cfg) {
  return { ...process.env, ...(cfg.env || {}) }
}

export function effortArgs(cfg, effort) {
  const supported = cfg.effort?.supported || []
  return effort && supported.includes(effort) ? effort : (supported[0] || null)
}

/** 失败时保留 stderr 尾部，供 classifyError 识别 429/限流等文案 */
export function failureText(res) {
  const s = String(res?.stderr || '').trim()
  if (!s) return ''
  return s.split(/\r?\n/).slice(-8).join('\n').slice(-1200)
}
