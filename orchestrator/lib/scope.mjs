/**
 * scope.mjs — design.md 的 write_scope 解析与并发冲突判定
 *
 * write_scope 放在 design.md 的 YAML front matter：
 *   ---
 *   write_scope:
 *     - src/app/**
 *     - src/shared/util.ts
 *   ---
 *
 * 冲突判定是保守的：只比较「第一个通配符之前的字面前缀」。
 * 前缀不相交 → 不会冲突；相交 → 视为冲突（宁可排队，不可并发写同一片区域）。
 */
import fs from 'node:fs'

export function readWriteScope(designPath) {
  let text
  try { text = fs.readFileSync(designPath, 'utf8') } catch { return null }
  const lines = text.split(/\r?\n/)
  if (!lines.length || lines[0].trim() !== '---') return null
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break }
  }
  if (end < 0) return null

  const scopes = []
  let inScope = false
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    const m = line.match(/^write_scope:\s*(.*)$/)
    if (m) {
      inScope = true
      const inline = m[1].trim()
      if (inline === '' || inline === '[]') continue
      if (inline.startsWith('[')) {
        for (const part of inline.replace(/^\[|\]$/g, '').split(',')) {
          const v = part.trim().replace(/^["']|["']$/g, '')
          if (v) scopes.push(v)
        }
      } else {
        scopes.push(inline.replace(/^["']|["']$/g, ''))
      }
      continue
    }
    if (!inScope) continue
    const item = line.match(/^\s*-\s*(.+?)\s*$/)
    if (item) {
      const v = item[1].trim().replace(/^["']|["']$/g, '')
      if (v) scopes.push(v)
      continue
    }
    if (line.trim() === '') continue
    break
  }
  return scopes
}

function literalPrefix(pattern) {
  const p = String(pattern).replace(/\\/g, '/').trim()
  const i = p.search(/[*?]/)
  const prefix = i < 0 ? p : p.slice(0, i)
  return prefix.replace(/\/+$/, '').toLowerCase()
}

function globsOverlap(a, b) {
  const x = String(a).replace(/\\/g, '/').trim()
  const y = String(b).replace(/\\/g, '/').trim()
  if (!x || !y || x === '**' || y === '**') return true
  const px = literalPrefix(x)
  const py = literalPrefix(y)
  if (!px || !py) return true
  if (px === py) return true
  return px.startsWith(py + '/') || py.startsWith(px + '/')
}

/** 空数组表示「不写产品代码」，与任何任务都不冲突；null/未声明视为全仓库 */
export function scopeOverlaps(a, b) {
  const as = Array.isArray(a) ? a : (a == null ? ['**'] : [])
  const bs = Array.isArray(b) ? b : (b == null ? ['**'] : [])
  if (!as.length || !bs.length) return false
  for (const x of as) for (const y of bs) if (globsOverlap(x, y)) return true
  return false
}

export function describeScope(scope) {
  if (!Array.isArray(scope)) return '**'
  if (!scope.length) return '[]'
  return scope.join(', ')
}
