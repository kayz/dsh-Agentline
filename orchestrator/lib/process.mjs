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
    try {
      child = spawn(command, [...prefixArgs, ...args], {
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
    const watchdog = stallMinutes === 0 ? null : createWatchdog({ stallMs: (stallMinutes ?? 10) * 60_000 })

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

    const feed = (s, channel) => {
      if (!watchdog || abortedReason) return
      const hit = watchdog.onData(s, { channel })
      if (hit) { abortedReason = hit; killTree() }
    }

    child.stdout.on('data', (d) => {
      const s = d.toString()
      stdout += s
      if (stdout.length > MAX_BUFFER) stdout = stdout.slice(-MAX_BUFFER)
      if (stream) stream.write(s)
      feed(s, 'stdout')
    })
    child.stderr.on('data', (d) => {
      const s = d.toString()
      stderr += s
      if (stderr.length > MAX_BUFFER) stderr = stderr.slice(-MAX_BUFFER)
      if (stream) stream.write(s)
      feed(s, 'stderr')
    })

    const finish = (payload) => {
      clearTimeout(timer)
      if (stallTimer) clearInterval(stallTimer)
      if (abortedReason) payload = { ...payload, exitCode: 125, abortedReason, error: abortedReason }
      if (stream) {
        try {
          stream.write(`\n=== EXIT ${payload.exitCode} timedOut=${payload.timedOut}${abortedReason ? ' aborted=' + abortedReason : ''} ===\n`)
          stream.end()
        } catch { /* ignore */ }
      }
      resolve(payload)
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
