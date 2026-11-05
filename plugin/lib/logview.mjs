/**
 * logview.mjs — 把各 CLI 的原始日志渲染成「人能读」的转录
 *
 * 现实中三种 CLI 的输出格式都不统一，而且还会变：
 *   - codex  --json     : 事件对象（有的是 JSONL，有的被 pretty-print 成多行）
 *   - codebuddy --json  : 一个 JSON 数组（流式写入时可能被截断）
 *   - claude            : 单个 result 对象，夹在 `=== STDOUT ===` 段里
 *
 * 所以这里不按「行」解析，而是**先把文本里的完整 JSON 对象抽出来，再按形状分类渲染**。
 * 原则：只做可读化，不改内容；原始文件仍在 logs/ 下可对照。
 */

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const LIMIT_TEXT = 700
const LIMIT_LINES = 600
const LIMIT_OBJECTS = 8000

const stripAnsi = (s) => String(s ?? '').replace(ANSI, '')
const clip = (s, n = LIMIT_TEXT) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + ` …(+${t.length - n})` : t
}

/** 从任意文本里抽出完整 JSON 对象（容忍外层数组、被截断、夹杂日志行） */
function extractObjects(text) {
  const objs = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') { if (depth === 0) start = i; depth++ }
    else if (c === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        try { objs.push(JSON.parse(text.slice(start, i + 1))) } catch { /* skip */ }
        start = -1
        if (objs.length >= LIMIT_OBJECTS) break
      }
    }
  }
  return objs
}

const textOfBlocks = (content) => (Array.isArray(content) ? content : [content])
  .filter((c) => c && (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text'))
  .map((c) => c.text || '')
  .join('\n')

// ─────────────────────────── codex ───────────────────────────
function renderCodex(objs) {
  const out = []
  let usage = null
  let errors = 0
  for (const e of objs) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'thread.started') { out.push(`── thread ${String(e.thread_id || '').slice(0, 8)} ──`); continue }
    if (e.type === 'turn.started') continue
    if (e.type === 'turn.completed') {
      const u = e.usage || {}
      usage = u
      out.push(`\n── 完成 in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'} cached=${u.cached_input_tokens ?? '?'} ──`)
      continue
    }
    if (e.type === 'error') { errors++; out.push(`\n❌ ${clip(stripAnsi(e.message || ''), 300)}`); continue }
    if (e.type === 'turn.failed') { errors++; out.push(`\n❌ turn failed: ${clip(stripAnsi(e.error?.message || ''), 300)}`); continue }
    if (e.type !== 'item.completed' && e.type !== 'item.started') continue
    if (e.type === 'item.started') continue
    const it = e.item || {}
    if (it.type === 'agent_message') out.push(`\n🤖 ${clip(stripAnsi(it.text))}`)
    else if (it.type === 'reasoning') out.push(`\n💭 ${clip(stripAnsi(it.text), 220)}`)
    else if (it.type === 'command_execution') {
      const cmd = stripAnsi(it.command || '')
        .replace(/^.*?pwsh(?:\.exe)?"?\s*/i, '')
        .replace(/^-Command\s+/i, '')
        .replace(/^["']|["']$/g, '')
      out.push(`\n$ ${clip(cmd, 300)}`)
      const body = typeof it.output === 'string' ? it.output : (it.aggregated_output || '')
      for (const l of stripAnsi(body).split(/\r?\n/).slice(0, 5)) if (l.trim()) out.push('  │ ' + clip(l, 200))
    } else if (it.type === 'file_change') out.push(`\n📝 ${it.path || it.file || '?'}`)
  }
  return { lines: out, usage, errors }
}

// ─────────────────────────── codebuddy ───────────────────────────
function renderCodebuddy(objs) {
  const out = []
  let usage = null
  let errors = 0
  for (const e of objs) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'message') {
      const role = e.role || e.message?.role
      const text = textOfBlocks(e.content || e.message?.content || [])
      if (!text.trim()) continue
      if (role === 'user') {
        const cleaned = text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '[system-reminder]')
        // 用户消息开头通常是系统提示的复述，只留前 300 字符
        out.push(`\n👤 ${clip(stripAnsi(cleaned), 300)}`)
      } else if (role === 'assistant') out.push(`\n🤖 ${clip(stripAnsi(text))}`)
    } else if (e.type === 'function_call' || e.type === 'tool_use') {
      const args = typeof e.arguments === 'string' ? e.arguments : JSON.stringify(e.arguments || {})
      out.push(`\n🔧 ${e.name || e.tool || '?'} ${clip(stripAnsi(args), 240)}`)
    } else if (e.type === 'function_call_result' || e.type === 'tool_result') {
      const o = e.output?.text ?? e.output ?? e.content ?? ''
      const body = typeof o === 'string' ? o : JSON.stringify(o)
      for (const l of stripAnsi(body).split(/\r?\n/).slice(0, 4)) if (l.trim()) out.push('  │ ' + clip(l, 180))
    } else if (e.type === 'result') {
      usage = e.usage || null
      out.push(`\n── 完成: ${clip(stripAnsi(e.result || ''), 160)}${e.is_error ? ' ❌is_error' : ''} ──`)
    }
  }
  return { lines: out, usage, errors }
}

// ─────────────────────────── claude ───────────────────────────
// 兼容两种：旧的整段 json（一个 result 对象）与 stream-json（assistant/result 事件流）
function renderClaude(objs) {
  const out = []
  let errors = 0
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue
    if (o.is_error || o.type === 'error') { errors++; out.push(`\n❌ ${clip(stripAnsi(o.message || o.result || 'error'))}`); continue }

    // stream-json: {"type":"assistant","message":{"content":[{type:"text",...},{type:"tool_use",...}]}}
    if (o.type === 'assistant' && o.message) {
      for (const block of (Array.isArray(o.message.content) ? o.message.content : [])) {
        if (block.type === 'text' && block.text) out.push(`\n🤖 ${clip(stripAnsi(block.text))}`)
        else if (block.type === 'tool_use') out.push(`\n🔧 ${block.name || '?'} ${clip(stripAnsi(JSON.stringify(block.input || {})), 200)}`)
      }
      continue
    }
    if (o.type === 'user' && o.message) {
      for (const block of (Array.isArray(o.message.content) ? o.message.content : [])) {
        if (block.type !== 'tool_result') continue
        const body = Array.isArray(block.content)
          ? block.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
          : (block.content || '')
        for (const line of stripAnsi(body).split(/\r?\n/).slice(0, 4)) {
          if (line.trim()) out.push('  │ ' + clip(line, 180))
        }
      }
      continue
    }
    if (o.type === 'system') continue

    const result = typeof o.result === 'string' ? o.result : null
    if (result && result.trim()) out.push(`\n🤖 ${clip(stripAnsi(result), 2000)}`)
    if (o.total_cost_usd != null || o.usage) {
      const u = o.usage || {}
      out.push(`\n── 完成 cost=$${o.total_cost_usd ?? '?'} turns=${o.num_turns ?? '?'} ──`)
      out.push(`   in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'} cache_read=${u.cache_read_input_tokens ?? '?'} cache_write=${u.cache_creation_input_tokens ?? '?'}`)
    }
  }
  return { lines: out, usage: null, errors }
}

function classify(objs) {
  for (const e of objs) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'thread.started' || e.type === 'turn.completed' || (e.item && e.type?.startsWith('item.'))) return 'codex'
    if (e.type === 'result' || e.duration_api_ms != null) return 'claude'
    if (e.type === 'assistant' || (e.type === 'user' && e.message)) return 'claude'
    if (e.type === 'message' && (e.role || e.message)) return 'codebuddy'
    if (e.type === 'function_call' || e.type === 'function_call_result') return 'codebuddy'
  }
  return null
}

/** 提取 `=== PROMPT ===` 段（只保留前 6 行做上下文） */
function promptHeader(text) {
  const m = text.match(/=== PROMPT ===\r?\n([\s\S]*?)(?:\r?\n=== STREAM ===|$)/)
  if (!m) return []
  const lines = m[1].split(/\r?\n/).filter((l) => l.trim()).slice(0, 6)
  return ['── 提示词 ──', ...lines.map((l) => '  ' + clip(l, 160)), '']
}

export function renderLog(raw) {
  const text = String(raw ?? '')
  const objs = extractObjects(text)
  const kind = classify(objs)

  let body
  if (kind === 'codex') body = renderCodex(objs)
  else if (kind === 'codebuddy') body = renderCodebuddy(objs)
  else if (kind === 'claude') body = renderClaude(objs)
  else {
    // 纯文本兜底
    const lines = []
    for (const l of stripAnsi(text).split(/\r?\n/)) {
      if (!l.trim()) continue
      if (/^=== /.test(l)) { lines.push(`── ${l.replace(/=\s*/g, '').trim()} ──`); continue }
      lines.push(clip(l, 400))
    }
    body = { lines, usage: null, errors: 0 }
  }

  const header = promptHeader(text)
  const lines = [...header, ...body.lines]
  const truncated = lines.length > LIMIT_LINES
  return {
    kind: kind || 'text',
    usage: body.usage || null,
    errors: body.errors || 0,
    truncated,
    lines: truncated ? lines.slice(-LIMIT_LINES) : lines,
  }
}


