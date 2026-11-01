/**
 * models.mjs — 模型发现、目录与角色选择
 *
 * 发现结果写入 agentline.models.json（本机缓存，gitignore）；角色选择写入
 * agentline.local.json（本机覆盖）。仓库里不保存作者私有模型。
 */
import { getAdapter } from './adapters/index.mjs'
import { writeDiscoveryCache, writeLocalConfig, ROLES } from './config.mjs'

export async function discoverAll(config, { providers = null } = {}) {
  const names = Array.isArray(providers) && providers.length ? providers : Object.keys(config.providers || {})
  const out = { version: 1, generatedAt: new Date().toISOString(), providers: {} }
  for (const name of names) {
    const p = config.providers?.[name]
    if (!p) { out.providers[name] = { source: 'none', models: [], warnings: ['provider is not defined'] }; continue }
    const adapter = getAdapter(p)
    if (!adapter) { out.providers[name] = { source: 'none', models: [], warnings: [`unknown adapter: ${p.adapter}`] }; continue }
    try {
      const r = await adapter.discover()
      out.providers[name] = {
        source: r.source || 'none',
        models: r.models || [],
        warnings: r.warnings || [],
      }
    } catch (e) {
      out.providers[name] = { source: 'none', models: [], warnings: [e.message] }
    }
  }
  return out
}

export function saveDiscovery(paths, cache) {
  return writeDiscoveryCache(paths.models, cache)
}

export function discoverySummary(cache) {
  const rows = []
  for (const [provider, data] of Object.entries(cache.providers || {})) {
    rows.push({ provider, source: data.source, models: (data.models || []).length, warnings: data.warnings || [] })
  }
  return rows
}

/** 角色选择：写 local overlay。keys 必须是已发现的模型 key（= config.models 的 key） */
export function setRoleCandidates(paths, config, role, keys) {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role} (allowed: ${ROLES.join(', ')})`)
  if (!Array.isArray(keys) || !keys.length) throw new Error('at least one model is required')
  const missing = keys.filter((k) => !config.models?.[k])
  if (missing.length) {
    const available = Object.keys(config.models || {}).sort()
    throw new Error(`unknown model(s): ${missing.join(', ')}${available.length ? `\navailable: ${available.join(', ')}` : '\nrun "agentline models discover" first'}`)
  }
  const patch = { roles: { [role]: { candidates: keys } } }
  writeLocalConfig(paths, patch)
  return { role, candidates: keys }
}

export function addModel(paths, config, { provider, id, key = null }) {
  if (!config.providers?.[provider]) throw new Error(`unknown provider: ${provider}`)
  if (!id) throw new Error('model id is required')
  const modelKey = key || id
  if (config.models?.[modelKey]) throw new Error(`model key already exists: ${modelKey}`)
  writeLocalConfig(paths, { models: { [modelKey]: { provider, id } } })
  return { key: modelKey, provider, id }
}

export function formatModelTable(config) {
  const rows = Object.entries(config.models || {}).map(([key, m]) => {
    const provider = config.providers?.[m.provider]
    return {
      key,
      provider: m.provider,
      id: m.id,
      source: m.source || 'config',
      family: m.family || provider?.source || '-',
    }
  }).sort((a, b) => (a.provider + a.key).localeCompare(b.provider + b.key))
  const width = (list, field) => Math.max(field.length, ...list.map((r) => String(r[field]).length), 0)
  const w = { key: width(rows, 'key'), provider: width(rows, 'provider'), id: width(rows, 'id'), source: width(rows, 'source') }
  const header = ['KEY'.padEnd(w.key), 'PROVIDER'.padEnd(w.provider), 'MODEL ID'.padEnd(w.id), 'SOURCE'.padEnd(w.source)].join('  ')
  const lines = [header, '-'.repeat(header.length)]
  for (const r of rows) {
    lines.push([String(r.key).padEnd(w.key), String(r.provider).padEnd(w.provider), String(r.id).padEnd(w.id), String(r.source).padEnd(w.source)].join('  '))
  }
  return lines.join('\n')
}
