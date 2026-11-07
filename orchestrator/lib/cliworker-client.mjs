/**
 * cliworker-client.mjs — AgentLine's only model-layer boundary.
 *
 * AgentLine sends a ModelRequest and consumes CLIWorker's ModelHandle[].
 * AgentLine must not import CLIWorker internals, provider lists, prices or
 * forecast algorithms.
 */
import { spawn } from 'node:child_process'

export function modelSource(config = {}) {
  const src = config.modelSource
  if (!src) return null
  if (src.kind !== 'cliworker') throw new Error(`unsupported modelSource.kind: ${src.kind}`)
  if (!src.command) throw new Error('modelSource.command is required')
  return src
}

function run(source, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const sourceArgs = source.args || []
    const argv = sourceArgs.length && /\.[cm]?js$/.test(sourceArgs[0])
      ? [sourceArgs[0], ...args, ...sourceArgs.slice(1)]
      : [...args, ...sourceArgs]
    const child = spawn(source.command, argv, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, out, err }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }) })
  })
}

export async function requestModels(config, request) {
  const source = modelSource(config)
  if (!source) throw new Error('modelSource is not configured')
  const r = await run(source, ['models', 'select', '--request', JSON.stringify(request)])
  if (!r.ok) throw new Error(`CLIWorker select failed: ${(r.err || r.out || r.error || 'unknown').trim()}`)
  let data
  try { data = JSON.parse(r.out) } catch { throw new Error('CLIWorker returned invalid JSON') }
  if (!data || data.schema !== 'cliworker.selection/v1') throw new Error('CLIWorker returned unexpected schema')
  return data
}

export async function listModels(config) {
  const source = modelSource(config)
  if (!source) throw new Error('modelSource is not configured')
  const r = await run(source, ['models', 'list'])
  if (!r.ok) throw new Error(`CLIWorker list failed: ${(r.err || r.out || r.error || 'unknown').trim()}`)
  return JSON.parse(r.out)
}
