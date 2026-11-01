/**
 * config.mjs — 分层配置：base（仓库） + local（本机） + discovered（模型发现缓存）
 *
 * base：providers / policy / 空 models / 空 roles，可提交。
 * local：命令路径、环境变量、模型补充、角色选择，.gitignore。
 * discovered：`agentline models discover` 的产物，.gitignore。
 *
 * 设计原则：仓库里不出现任何本机路径、密钥或作者私有模型；没有默认模型，
 * 角色必须由用户显式选择后才能运行 flow。
 */
import fs from 'node:fs'
import path from 'node:path'

export const CONFIG_VERSION = 1
export const ROLES = ['design', 'dev', 'review']

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return [...patch]
  if (patch === null || typeof patch !== 'object') return patch
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v
  }
  return out
}

export function resolveConfigPaths({ orchestratorRoot, configPath, localPath, modelsPath }) {
  const base = path.resolve(configPath || path.join(orchestratorRoot, 'config', 'agentline.config.json'))
  const configDir = path.dirname(base)
  return {
    base,
    local: path.resolve(localPath || path.join(configDir, 'agentline.local.json')),
    models: path.resolve(modelsPath || path.join(configDir, 'agentline.models.json')),
  }
}

/** 把发现缓存里的模型并入配置；用户显式定义的模型优先 */
function mergeDiscovered(config, cache, warnings) {
  if (!cache || !cache.providers) return
  const seen = new Set(Object.keys(config.models))
  for (const [provider, data] of Object.entries(cache.providers)) {
    if (!config.providers[provider]) continue
    for (const m of data.models || []) {
      if (!m || !m.id) continue
      if (seen.has(m.id)) continue
      seen.add(m.id)
      config.models[m.id] = {
        provider,
        id: m.id,
        display: m.displayName || m.display || m.id,
        family: config.providers[provider].source || provider,
        source: data.source || 'unknown',
        discoveredAt: cache.generatedAt || null,
        efforts: Array.isArray(m.efforts) && m.efforts.length ? m.efforts : undefined,
      }
    }
    if (data.warnings && data.warnings.length) {
      for (const w of data.warnings) warnings.push(`${provider}: ${w}`)
    }
  }
}

export function validateConfig(config) {
  const errors = []
  const warnings = []
  if (!config || typeof config !== 'object') return { errors: ['config is empty'], warnings }
  if (config.configVersion !== CONFIG_VERSION) errors.push(`configVersion must be ${CONFIG_VERSION}`)

  if (!config.providers || typeof config.providers !== 'object') errors.push('providers is required')
  else {
    for (const [name, p] of Object.entries(config.providers)) {
      if (!p || typeof p !== 'object') { errors.push(`providers.${name} must be an object`); continue }
      if (!p.adapter) errors.push(`providers.${name}.adapter is required`)
      if (!p.command) errors.push(`providers.${name}.command is required`)
      if (p.transport && p.transport !== 'cli') errors.push(`providers.${name}.transport: only "cli" is supported`)
    }
  }

  if (!config.models || typeof config.models !== 'object') errors.push('models must be an object')
  else {
    for (const [key, m] of Object.entries(config.models)) {
      if (!m || typeof m !== 'object') { errors.push(`models.${key} must be an object`); continue }
      if (!m.provider) errors.push(`models.${key}.provider is required`)
      else if (config.providers && !config.providers[m.provider]) errors.push(`models.${key}.provider "${m.provider}" is not defined`)
      if (!m.id) errors.push(`models.${key}.id is required`)
    }
  }

  if (!config.roles) errors.push('roles is required')
  else {
    for (const role of ROLES) {
      const r = config.roles[role]
      if (!r) { errors.push(`roles.${role} is required`); continue }
      if (!Array.isArray(r.candidates)) errors.push(`roles.${role}.candidates must be an array`)
      else {
        for (const key of r.candidates) {
          if (config.models && !config.models[key]) errors.push(`roles.${role}.candidates references unknown model "${key}"`)
        }
      }
    }
  }

  if (config.ci && config.ci.runner == null) warnings.push('ci.runner is empty: CI step will fail until configured')
  return { errors, warnings }
}

/** 是否已经完成「强制填写」：每个角色至少一个候选，且候选都存在 */
export function missingRoleSetup(config) {
  const missing = []
  for (const role of ROLES) {
    const list = config.roles?.[role]?.candidates || []
    if (!list.length) missing.push(role)
  }
  return missing
}

export function loadConfig({ orchestratorRoot, configPath, localPath, modelsPath, repo }) {
  const paths = resolveConfigPaths({ orchestratorRoot, configPath, localPath, modelsPath })
  const base = readJson(paths.base)
  if (!base) throw new Error(`config not found or invalid JSON: ${paths.base}`)

  const local = fs.existsSync(paths.local) ? readJson(paths.local) : null
  if (fs.existsSync(paths.local) && !local) throw new Error(`local config is invalid JSON: ${paths.local}`)

  const merged = deepMerge(base, local || {})
  merged.collabDir = merged.collabDir || '.collab/tasks'
  merged.effort = merged.effort || { default: 'high' }
  merged.policy = merged.policy || {}
  merged.discovery = merged.discovery || {}

  const cache = fs.existsSync(paths.models) ? readJson(paths.models) : null
  const warnings = []
  mergeDiscovered(merged, cache, warnings)
  if (!cache) warnings.push(`models cache not found: ${paths.models} (run "agentline models discover")`)

  if (repo) merged.repo = path.resolve(repo)
  const { errors, warnings: vw } = validateConfig(merged)
  return {
    config: merged,
    paths,
    errors,
    warnings: [...warnings, ...vw],
    discovery: cache ? { generatedAt: cache.generatedAt || null, providers: Object.keys(cache.providers || {}) } : null,
  }
}

export function projectConfigPath(repo) {
  return path.join(repo, '.collab', 'agentline.json')
}

export function loadProjectConfig(repo) {
  return readJson(projectConfigPath(repo)) || {}
}

export function writeLocalConfig(paths, patch) {
  const cur = fs.existsSync(paths.local) ? (readJson(paths.local) || {}) : {}
  const next = deepMerge(cur, patch)
  fs.mkdirSync(path.dirname(paths.local), { recursive: true })
  const tmp = paths.local + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(tmp, paths.local)
  return next
}

export function writeDiscoveryCache(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return data
}
