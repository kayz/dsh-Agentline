/**
 * inputs.mjs — 运行中的人类输入（note / amendment / answer / attention）
 *
 * 与原 mailbox 的区别：输入有类型和消费状态，可被流程按语义路由：
 *   note       实现提示：注入下一次角色提示词，阶段成功后标记 consumed
 *   amendment  需求/规格修正：当前 dev/review 轮作废，回到 design 升版
 *   answer     对 attention 问题的回答：design 重新读取后继续
 *
 * 存储：<task>/inputs.jsonl（追加写） + <task>/attention.json（designer 发出）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const KINDS = new Set(['note', 'amendment', 'answer'])

export function inputsPath(taskDir) { return path.join(taskDir, 'inputs.jsonl') }
export function attentionPath(taskDir) { return path.join(taskDir, 'attention.json') }

export function appendInput(taskDir, { kind, text, by = 'user', meta = null }) {
  if (!KINDS.has(kind)) throw new Error(`unknown input kind: ${kind} (allowed: note, amendment, answer)`)
  if (!text || !String(text).trim()) throw new Error('input text is required')
  fs.mkdirSync(taskDir, { recursive: true })
  const entry = {
    id: 'in-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    at: new Date().toISOString(),
    kind,
    by,
    text: String(text).trim(),
    status: 'pending',
    ...(meta ? { meta } : {}),
  }
  fs.appendFileSync(inputsPath(taskDir), JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

export function readInputs(taskDir) {
  let raw = ''
  try { raw = fs.readFileSync(inputsPath(taskDir), 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { const v = JSON.parse(line); if (v && v.id) out.push(v) } catch { /* skip bad line */ }
  }
  return out
}

export function pendingInputs(taskDir, kinds = null) {
  const allow = kinds ? new Set(kinds) : null
  return readInputs(taskDir).filter((i) => i.status === 'pending' && (!allow || allow.has(i.kind)))
}

export function markConsumed(taskDir, ids) {
  if (!ids || !ids.length) return
  const set = new Set(ids)
  const all = readInputs(taskDir)
  let changed = false
  for (const i of all) {
    if (i.status === 'pending' && set.has(i.id)) { i.status = 'consumed'; changed = true }
  }
  if (!changed) return
  const tmp = inputsPath(taskDir) + '.tmp'
  fs.writeFileSync(tmp, all.map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf8')
  fs.renameSync(tmp, inputsPath(taskDir))
}

export function readAttention(taskDir) {
  try { return JSON.parse(fs.readFileSync(attentionPath(taskDir), 'utf8')) } catch { return null }
}

export function removeAttention(taskDir) {
  try { fs.rmSync(attentionPath(taskDir), { force: true }) } catch { /* ignore */ }
}

export function formatInput(i) {
  return `[${i.kind}] ${i.text}`
}
