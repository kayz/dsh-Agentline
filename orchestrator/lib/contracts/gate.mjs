/**
 * gate.mjs — machine-checkable gate contract.
 *
 * A gate is data, not a UI convention:
 *   - checks are explicit pass/fail facts with evidence;
 *   - non-waivable checks can never be waived;
 *   - approval is bound to the exact subject content hash;
 *   - a changed hash makes the previous approval stale.
 *
 * This module intentionally has no filesystem or model dependency.
 */

import { createHash } from 'node:crypto'

export const GATE_SCHEMA = 'agentline.gate/v1'

const HASH_RE = /^sha256:[0-9a-f]{64}$/

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

/**
 * Validate the shape and internal consistency of a gate document.
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateGate(gate) {
  const errors = []
  const push = (msg) => errors.push(msg)
  if (!isObject(gate)) return { ok: false, errors: ['gate must be an object'] }
  if (gate.schema !== GATE_SCHEMA) push(`schema must be ${GATE_SCHEMA}`)
  if (!gate.gate || typeof gate.gate !== 'string') push('gate is required')
  if (!isObject(gate.subject)) push('subject is required')
  else {
    for (const k of ['kind', 'id', 'content_hash', 'revision']) {
      if (gate.subject[k] === undefined || gate.subject[k] === null) push(`subject.${k} is required`)
    }
    if (gate.subject.content_hash && !HASH_RE.test(gate.subject.content_hash)) push('subject.content_hash must be sha256:<64 hex>')
    if (!Number.isInteger(gate.subject.revision) || gate.subject.revision < 0) push('subject.revision must be a non-negative integer')
  }
  if (!gate.evaluated_at || typeof gate.evaluated_at !== 'string') push('evaluated_at is required')

  const checks = Array.isArray(gate.checks) ? gate.checks : null
  if (!checks) push('checks must be an array')
  else {
    const ids = new Set()
    checks.forEach((c, i) => {
      if (!isObject(c)) { push(`checks[${i}] must be an object`); return }
      if (!c.id || ids.has(c.id)) push(`checks[${i}].id must be unique and non-empty`)
      else ids.add(c.id)
      if (!c.desc || typeof c.desc !== 'string') push(`checks[${i}].desc is required`)
      if (typeof c.pass !== 'boolean') push(`checks[${i}].pass must be boolean`)
      if (typeof c.waivable !== 'boolean') push(`checks[${i}].waivable must be boolean`)
    })
  }

  const waivers = gate.waivers === undefined ? [] : gate.waivers
  if (!Array.isArray(waivers)) push('waivers must be an array')
  else {
    const checkIds = new Set((checks || []).map((c) => c && c.id).filter(Boolean))
    const seen = new Set()
    waivers.forEach((w, i) => {
      if (!isObject(w)) { push(`waivers[${i}] must be an object`); return }
      if (!w.check || !checkIds.has(w.check)) push(`waivers[${i}].check must reference a check`)
      if (w.check && seen.has(w.check)) push(`waivers[${i}] duplicates a check`)
      seen.add(w.check)
      if (!w.by || !w.at || !w.reason) push(`waivers[${i}] requires by/at/reason`)
      if (!w.content_hash || !HASH_RE.test(w.content_hash)) push(`waivers[${i}].content_hash must be sha256:<64 hex>`)
    })
  }

  if (gate.approval !== undefined) {
    if (!isObject(gate.approval)) push('approval must be an object')
    else {
      if (typeof gate.approval.required !== 'boolean') push('approval.required must be boolean')
      if (typeof gate.approval.approved !== 'boolean') push('approval.approved must be boolean')
      if (gate.approval.content_hash !== null && !HASH_RE.test(String(gate.approval.content_hash || ''))) {
        push('approval.content_hash must be sha256:<64 hex> or null')
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Evaluate a gate. `current_hash` is the hash of the content being checked now;
 * it is supplied by the caller, never trusted from the gate document.
 *
 * @returns {{status:string, pass:boolean, failed:string[], waived:string[], errors:string[]}}
 */
export function evaluateGate(gate, { currentHash } = {}) {
  const validation = validateGate(gate)
  if (!validation.ok) return { status: 'fail', pass: false, failed: [], waived: [], errors: validation.errors }

  const checks = gate.checks
  if (!checks.length) return { status: 'not_evaluated', pass: false, failed: [], waived: [], errors: [] }

  const current = currentHash || gate.subject.content_hash
  if (current !== gate.subject.content_hash) {
    return { status: 'stale', pass: false, failed: [], waived: [], errors: ['subject hash changed'] }
  }

  const checkMap = new Map(checks.map((c) => [c.id, c]))
  const waiverMap = new Map((gate.waivers || []).map((w) => [w.check, w]))
  const failed = []
  const waived = []

  for (const c of checks) {
    if (c.pass) continue
    const w = waiverMap.get(c.id)
    if (w && c.waivable && w.content_hash === current) { waived.push(c.id); continue }
    if (w && !c.waivable) {
      return { status: 'fail', pass: false, failed: [...failed, c.id], waived, errors: [`check ${c.id} is not waivable`] }
    }
    failed.push(c.id)
  }

  if (failed.length) return { status: 'fail', pass: false, failed, waived, errors: [] }

  if (gate.approval && gate.approval.required) {
    const approved = gate.approval.approved && gate.approval.content_hash === current
    if (!approved) return { status: 'pending_approval', pass: false, failed: [], waived, errors: [] }
  }

  return { status: 'pass', pass: true, failed: [], waived, errors: [] }
}

/**
 * Produce a canonical hash for a subject's content. Callers must pass the bytes
 * that are actually being approved (not a rendered summary).
 */
export function sha256Content(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex')
}
