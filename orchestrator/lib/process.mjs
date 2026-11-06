/**
 * process.mjs — 命令解析 + 子进程运行（Windows 优先）
 *
 * 为什么需要解析：npm 全局命令通常是 .cmd shim（claude.cmd / codex.cmd / codebuddy.cmd），
 * Node 直接 spawn 一个 .cmd 在 Windows 上不可靠；把 shim 解析成真正的 .exe 或
 * "node + js 入口"，就能绕过 cmd.exe 的引号/换行地狱，prompt 仍作为普通参数传递。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createWatchdog } from './supervisor.mjs'

const RATE_LIMIT_RE = /(?:^|\b)429\b|rate.?limit|too many requests|quota (?:exceeded|exhausted)|usage limit|session limit|frequency limit|请求过于频繁|频率限制|限流|使用量.{0,12}(?:频率|限制)/i
const MAX_BUFFER = 8 * 1024 * 1024
const resolveCache = new Map()

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

function expandDp0(s, dir) {
  return s.replace(/%~?dp0%?/gi, dir.endsWith('\\') ? dir : dir + '\\').replace(/\\\\+/g, '\\')
}

function fromShim(shimPath) {
  const dir = path.dirname(shimPath)
  const txt = fs.readFileSync(shimPath, 'utf8')
  // codex.cmd / codebuddy.cmd: "%_prog%"  "%dp0%\...\entry.js" %*
  const mProg = txt.match(/"%_prog%"\s+"([^"]+)"/i)
  if (mProg) {
    const script = expandDp0(mProg[1], dir)
    const localNode = path.join(dir, 'node.exe')
    const node = isFile(localNode) ? localNode : process.execPath
    return { command: node, prefixArgs: [script] }
  }
  // claude.cmd: "%dp0%\...\claude.exe"   %*
  const mExe = txt.match(/"([^"]+\.exe)"\s+%\*/i)
  if (mExe) {
    const exe = expandDp0(mExe[1], dir)
    if (isFile(exe)) return { command: exe, prefixArgs: [] }
  }
  throw new Error(`cannot resolve shim ${shimPath}; set an absolute executable in agentline.local.json`)
}

function resolvePath(command) {
  const p = path.resolve(command)
  if (!isFile(p)) return null
  if (/\.(cmd|bat)$/i.test(p)) return fromShim(p)
  if (/\.(js|mjs)$/i.test(p)) return { command: process.execPath, prefixArgs: [p] }
  return { command: p, prefixArgs: [] }
}

export function resolveCommand(command) {
  if (resolveCache.has(command)) return resolveCache.get(command)
  let out
  if (command.includes('/') || command.includes('\\')) {
    out = resolvePath(command)
  } else if (process.platform === 'win32') {
    const r = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
    const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const exe = lines.find((l) => /\.exe$/i.test(l))
    const cmd = lines.find((l) => /\.(cmd|bat)$/i.test(l))
    out = exe ? { command: exe, prefixArgs: [] } : (cmd ? fromShim(cmd) : (lines[0] ? resolvePath(lines[0]) : null))
  } else {
    const r = spawnSync('which', [command], { encoding: 'utf8' })
    const p = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0]
    out = p ? resolvePath(p) : null
  }
  if (!out) throw new Error(`command not found: ${command}`)
  resolveCache.set(command, out)
  return out
}

export function commandExists(command) {
  try { resolveCommand(command); return true } catch { return false }
}

/**
 * 运行一个子进程并收集输出。日志可选、超时、静默 stall 看门狗。
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, timedOut:boolean, spawnError:string|null, abortedReason:string|null}>}
 */
export function runProcess({
  command, prefixArgs = [], args = [], cwd = process.cwd(), env = null,
  timeoutMs = 600_000, logPath = null, header = null, stallMinutes = null,
  classify = null, apiStallSeconds = 120, toolStallMinutes = 60,
} = {}) {
  let stream = null
  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      stream = fs.createWriteStream(logPath, { flags: 'a' })
      if (header) stream.write(header + '\n')
    } catch { stream = null }
  }

  return new Promise((resolve) => {
    let child
    let resolved
    try {
      resolved = resolveCommand(command)
    } catch (e) {
      resolve({ exitCode: -1, stdout: '', stderr: e.message, timedOut: false, spawnError: e.message, abortedReason: null })
      return
    }
    try {
      child = spawn(resolved.command, [...resolved.prefixArgs, ...prefixArgs, ...args], {
        cwd,
        windowsHide: true,
        env: env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ exitCode: -1, stdout: '', stderr: e.message, timedOut: false, spawnError: e.message, abortedReason: null })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let abortedReason = null
    const watchdog = (!classify && stallMinutes !== 0)
      ? createWatchdog({ stallMs: (stallMinutes ?? 10) * 60_000 })
      : null

    const killTree = () => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        }
        child.kill()
      } catch { /* ignore */ }
    }

    const timer = setTimeout(() => { timedOut = true; killTree() }, timeoutMs)
    const stallTimer = watchdog
      ? setInterval(() => {
          if (watchdog.checkStall() === 'stall') { abortedReason = 'stall'; killTree() }
        }, 30_000)
      : null

    // 事件级心跳：区分「API 静默」与「工具/命令在跑」
    const lineBuf = { stdout: '', stderr: '' }
    const activeTools = new Set()
    let toolSeq = 0
    let lastActivity = Date.now()
    const heartbeat = classify
      ? setInterval(() => {
          if (abortedReason) return
          const idle = Date.now() - lastActivity
          const limitMs = activeTools.size > 0
            ? Math.max(0.01, toolStallMinutes) * 60_000
            : Math.max(0.01, apiStallSeconds) * 1000
          if (idle > limitMs) {
            abortedReason = activeTools.size > 0 ? 'tool_stall' : 'stall'
            killTree()
          }
        }, 5_000)
      : null

    const onData = (s, channel) => {
      lastActivity = Date.now()
      if (!classify) {
        if (!watchdog || abortedReason) return
        const hit = watchdog.onData(s, { channel })
        if (hit) { abortedReason = hit; killTree() }
        return
      }
      lineBuf[channel] += s
      if (lineBuf[channel].length > 2_000_000) lineBuf[channel] = lineBuf[channel].slice(-1_000_000)
      for (;;) {
        const idx = lineBuf[channel].indexOf('\n')
        if (idx < 0) break
        const line = lineBuf[channel].slice(0, idx).trim()
        lineBuf[channel] = lineBuf[channel].slice(idx + 1)
        if (!line) continue
        const stdoutRateLimit = channel === 'stdout' && /^\s*(?:error\b[:\s]*)?429\b|^\s*(?:error|fatal|panic)\b.*(?:rate.?limit|quota|频率限制|使用量)/i.test(line)
        if (RATE_LIMIT_RE.test(line) && (channel === 'stderr' || stdoutRateLimit)) {
          abortedReason = 'rate_limit'
          killTree()
          return
        }
        let evt = null
        try { evt = classify(line, channel) } catch { evt = null }
        if (!evt) continue
        if (evt.kind === 'error') {
          abortedReason = evt.reason || 'error'
          killTree()
          return
        }
        if (evt.kind === 'tool_start') activeTools.add(evt.id || ('t' + (++toolSeq)))
        else if (evt.kind === 'tool_end') {
          if (evt.id) activeTools.delete(evt.id)
          else activeTools.clear()
        }
      }
    }

    child.stdout.on('data', (d) => {
      const s = d.toString()
      stdout += s
      if (stdout.length > MAX_BUFFER) stdout = stdout.slice(-MAX_BUFFER)
      if (stream) stream.write(s)
      onData(s, 'stdout')
    })
    child.stderr.on('data', (d) => {
      const s = d.toString()
      stderr += s
      if (stderr.length > MAX_BUFFER) stderr = stderr.slice(-MAX_BUFFER)
      if (stream) stream.write(s)
      onData(s, 'stderr')
    })

    const finish = (payload) => {
      clearTimeout(timer)
      if (stallTimer) clearInterval(stallTimer)
      if (heartbeat) clearInterval(heartbeat)
      if (abortedReason) payload = { ...payload, exitCode: 125, abortedReason, error: abortedReason }
      if (stream) {
        try {
          stream.write(`\n=== EXIT ${payload.exitCode} timedOut=${payload.timedOut}${abortedReason ? ' aborted=' + abortedReason : ''} ===\n`)
          stream.end()
        } catch { /* ignore */ }
      }
      resolve({ abortedReason: null, ...payload })
    }

    child.on('error', (err) => {
      finish({ exitCode: -1, stdout, stderr: stderr + '\n' + err.message, timedOut, spawnError: err.message })
    })
    child.on('close', (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

/** 一次性命令（用于 preflight / 模型发现），短超时、不写日志 */
export async function runCapture(command, args = [], { env = null, timeoutMs = 30_000, cwd = process.cwd() } = {}) {
  const r = resolveCommand(command)
  return runProcess({
    command: r.command, prefixArgs: r.prefixArgs, args,
    cwd, env, timeoutMs, stallMinutes: 0,
  })
}

/** 给 CLI 参数用的模型/文本安全化：只做去空校验，不改变内容 */
export function assertArg(name, value) {
  if (value == null || String(value).length === 0) throw new Error(`${name} is empty`)
  return String(value)
}


