/**
 * control.mjs — 运行中的控制面（停止 / 插话）
 *
 * 停止：
 *   - stop=after_stage：当前阶段跑完就停（推荐，不会留下半个阶段）
 *   - 立即终止由 CLI 的 stop --now 处理（杀进程树 + 标记 halted）
 *
 * 插话：
 *   mailbox.md 里的内容会在**下一个阶段**的提示词里注入。
 *   正在跑的那个模型收不到（CLI 是一次性进程，这是物理限制，不假装能做到）。
 */
import fs from 'node:fs'
import path from 'node:path'

export function controlPath(dir) { return path.join(dir, 'control.json') }
export function mailboxPath(dir) { return path.join(dir, 'mailbox.md') }
export function mailboxUsedPath(dir) { return path.join(dir, 'mailbox-used.md') }

export function readControl(dir) {
  try { return JSON.parse(fs.readFileSync(controlPath(dir), 'utf8')) } catch { return null }
}

export function requestStop(dir, mode = 'after_stage', by = 'user') {
  const f = controlPath(dir)
  fs.writeFileSync(f, JSON.stringify({ stop: mode, by, at: new Date().toISOString() }, null, 2), 'utf8')
  return readControl(dir)
}

export function clearControl(dir) {
  try { fs.rmSync(controlPath(dir), { force: true }) } catch { /* ignore */ }
}

export function isStopRequested(dir) {
  const c = readControl(dir)
  return !!(c && c.stop)
}

export function appendMailbox(dir, text) {
  const f = mailboxPath(dir)
  const line = `- [${new Date().toISOString()}] ${String(text).trim()}\n`
  fs.appendFileSync(f, line, 'utf8')
  return line.trim()
}

/** 读插话（不消费；用于构建提示词） */
export function readMailbox(dir) {
  try { return fs.readFileSync(mailboxPath(dir), 'utf8').trim() } catch { return '' }
}

/** 阶段成功后再归档，避免失败重试时把插话弄丢 */
export function archiveMailbox(dir) {
  const text = readMailbox(dir)
  if (!text) return
  try {
    fs.appendFileSync(mailboxUsedPath(dir), `\n## 已用于 ${new Date().toISOString()}\n${text}\n`, 'utf8')
    fs.rmSync(mailboxPath(dir), { force: true })
  } catch { /* ignore */ }
}

