import fs from 'node:fs'
import path from 'node:path'

export function readState(dir) {
  const p = path.join(dir, 'state.json')
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

export function writeState(dir, state) {
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8')
}

export function readRuns(dir) {
  const p = path.join(dir, 'run.json')
  if (!fs.existsSync(p)) return []
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(v) ? v : [v]
  } catch { return [] }
}

export function appendRun(dir, record) {
  const runs = readRuns(dir)
  runs.push(record)
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(runs, null, 2), 'utf8')
}

export function nextRunIndex(dir, role) {
  return readRuns(dir).filter((r) => r.role === role).length + 1
}
