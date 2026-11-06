/**
 * model-catalog.mjs — explicit model identity and availability.
 *
 * A discovered model is not automatically callable, and a manually registered
 * model is not automatically verified. Role eligibility is deliberately strict:
 * the caller must pass a tier and the entry must be callable.
 */
export const MODEL_SCHEMA = 'agentline.model/v1'
export const TIERS = new Set(['top', 'advanced', 'standard', 'unknown'])
export const AVAILABILITY = new Set(['unknown', 'discovered', 'unverified', 'callable', 'unavailable', 'blocked'])
export function normalizeModel(input = {}) {
  const entry = {
    schema: MODEL_SCHEMA,
    key: String(input.key || input.id || ''),
    provider: String(input.provider || ''),
    id: String(input.id || input.key || ''),
    canonical_id: input.canonical_id || null,
    origin_vendor: input.origin_vendor || null,
    identity_group: input.identity_group || null,
    tier: input.tier === undefined ? 'unknown' : input.tier,
    identity: input.identity === 'verified' ? 'verified' : 'unverified',
    availability: input.availability === undefined ? 'unknown' : input.availability,
    source: input.source || 'config',
    capabilities: Array.isArray(input.capabilities) ? [...new Set(input.capabilities)] : [],
    observed_at: input.observed_at || null,
    expires_at: input.expires_at || null,
    error: input.error || null,
  }
  return entry
}

export function validateModel(entry) {
  const errors = []
  if (!entry || typeof entry !== 'object') return { ok: false, errors: ['model must be an object'] }
  if (!entry.key) errors.push('key is required')
  if (!entry.provider) errors.push('provider is required')
  if (!entry.id) errors.push('id is required')
  if (!TIERS.has(entry.tier)) errors.push(`unknown tier: ${entry.tier}`)
  if (!AVAILABILITY.has(entry.availability)) errors.push(`unknown availability: ${entry.availability}`)
  if (entry.identity !== 'verified' && entry.identity !== 'unverified') errors.push('identity must be verified|unverified')
  if (entry.expires_at && Number.isNaN(Date.parse(entry.expires_at))) errors.push('expires_at must be ISO date-time')
  return { ok: errors.length === 0, errors }
}

export function buildCatalog({ config = {}, discovery = null } = {}) {
  const entries = []
  for (const [key, m] of Object.entries(config.models || {})) {
    entries.push(normalizeModel({
      key,
      provider: m.provider,
      id: m.id,
      source: m.source || 'config',
      tier: m.tier || 'unknown',
      identity: m.identity || 'unverified',
      availability: m.availability || 'unverified',
    }))
  }
  // Discovery rows are evidence of existence only. They must never auto-promote.
  for (const [provider, data] of Object.entries(discovery?.providers || {})) {
    for (const m of data.models || []) {
      const key = m.key || m.id
      if (!key || entries.some((e) => e.key === key)) continue
      entries.push(normalizeModel({
        key, provider, id: m.id || key, source: 'discovery',
        availability: 'discovered', tier: 'unknown', identity: 'unverified',
      }))
    }
  }
  return { schema: 'agentline.catalog/v1', generated_at: new Date().toISOString(), models: entries }
}

/** A probe result is evidence, not a role assignment. */
export function applyProbe(entry, { ok, modelResolved = null, at = new Date().toISOString(), error = null } = {}) {
  const next = normalizeModel(entry)
  next.observed_at = at
  next.error = error
  if (ok) {
    next.availability = 'callable'
    next.identity = modelResolved ? 'verified' : 'unverified'
  } else {
    next.availability = error === 'auth' ? 'blocked' : 'unavailable'
    next.identity = 'unverified'
  }
  return next
}

/** Strict role eligibility: unknown tier/unverified identity is not enough. */
export function isRoleEligible(entry, { tier = 'top', allowUnverified = false } = {}) {
  if (!entry || !validateModel(entry).ok) return { ok: false, reason: 'invalid' }
  if (entry.availability !== 'callable') return { ok: false, reason: `unavailable:${entry.availability}` }
  if (tier && entry.tier !== tier) return { ok: false, reason: `tier:${entry.tier}` }
  if (!allowUnverified && entry.identity !== 'verified') return { ok: false, reason: 'identity_unverified' }
  return { ok: true, reason: null }
}

export const CURSOR_PROVIDER = Object.freeze({
  provider: 'cursor',
  source: 'cursor',
  adapter: 'cursor-agent',
  transport: 'cli',
  command: 'cursor',
  experimental: true,
  capabilities: {
    agent_subcommand: true,
    non_interactive: false,
    model_list: false,
    readonly_mode: false,
  },
  discovery: {
    mode: 'manual_or_probe',
    trust: 'discovered_only',
    note: 'Cursor 3.29.9 exposes the agent subcommand but no stable non-interactive model list in the checked environment.',
  },
})
