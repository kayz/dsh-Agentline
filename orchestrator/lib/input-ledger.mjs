/**
 * input-ledger.mjs — append-only evidence for inputs.
 *
 * `inputs.jsonl` remains the kernel projection. This ledger records what was
 * appended/consumed, with a content hash, so recovery has an independent
 * trail. It is intentionally append-only and never rewrites prior lines.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function inputLedgerPath(taskDir) { return path.join(taskDir, 'input-ledger.jsonl') }

function sha256(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text)).digest('hex')
}

function canonical(entry) {
  return JSON.stringify({
    id: entry.id, at: entry.at, kind: entry.kind, by: entry.by, text: entry.text,
    ...(entry.meta ? { meta: entry.meta } : {}),
  })
}

export function appendInputEvent(taskDir, { event, entry = null, ids = null, by = 'agentline' }) {
  const row = {
    at: new Date().toISOString(),
    event,
    by,
    ...(entry ? {
      id: entry.id,
      kind: entry.kind,
      content_sha256: sha256(canonical(entry)),
      status: entry.status || null,
    } : {}),
    ...(ids ? { ids: [...ids] } : {}),
  }
  fs.mkdirSync(taskDir, { recursive: true })
  fs.appendFileSync(inputLedgerPath(taskDir), JSON.stringify(row) + '\n', 'utf8')
  return row
}

export function readInputLedger(taskDir) {
  try {
    return fs.readFileSync(inputLedgerPath(taskDir), 'utf8')
      .split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

export function consumedIds(taskDir) {
  const out = new Set()
  for (const row of readInputLedger(taskDir)) {
    if (row.event === 'input.consume' && Array.isArray(row.ids)) for (const id of row.ids) out.add(id)
  }
  return out
}
