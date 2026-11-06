/**
 * routing.mjs — 每个项目（工作区）的角色→模型路由
 *
 * 存放位置：<project>/.collab/agentline.json 的 routing 段。
 * CLI 与插件共用同一份规则，保证"界面上选什么，flow 就用什么"。
 */
import fs from 'node:fs'
import path from 'node:path'

export const ROLES = ['design', 'dev', 'review']

export function projectFile(project) {
  return path.join(project, '.collab', 'agentline.json')
}

export function readProject(project) {
  try { return JSON.parse(fs.readFileSync(projectFile(project), 'utf8')) } catch { return {} }
}

export function writeProject(project, data) {
  const f = projectFile(project)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8')
}

/** 按策略排序：quality = 质量优先（rank 小者先），speed = 速度优先 */
export function sortByPolicy(keys, models, policy) {
  const field = policy === 'speed' ? 'speed' : 'quality'
  return [...keys].sort((a, b) => {
    const ra = models[a]?.rank?.[field] ?? 99
    const rb = models[b]?.rank?.[field] ?? 99
    return ra - rb
  })
}

/**
 * 计算某个角色的生效配置。
 * 优先级：项目 routing > 全局 roles > 默认。
 */
export function effectiveRole(config, role, projectCfg = {}) {
  const base = config.roles?.[role] || {}
  const r = (projectCfg.routing || {})[role] || {}
  const policy = r.policy || 'quality'

  // 全局「角色可用模型」：影响所有工作区的候选顺序（项目只决定首选）
  const globalForRole = Array.isArray(config.roleModels?.[role]) && config.roleModels[role].length
    ? config.roleModels[role].filter((k) => config.models[k])
    : null

  let order = Array.isArray(r.order) && r.order.length
    ? r.order.filter((k) => config.models[k])
    : null

  if (!order) {
    const pool = globalForRole || (base.candidates || (base.model ? [base.model] : []))
    const seed = r.model && config.models[r.model]
      ? [r.model, ...pool.filter((k) => k !== r.model)]
      : pool
    order = seed.filter((k) => config.models[k])
    if (policy === 'speed') order = sortByPolicy(order, config.models, 'speed')
  }

  return {
    model: order[0] || base.model,
    order,
    policy,
    effort: r.effort || base.effort || config.effort?.default || 'high',
  }
}

/** 每个角色当前允许的模型（全局设置，供 UI 显示） */
export function roleMatrix(config) {
  const out = {}
  for (const role of ROLES) {
    const list = Array.isArray(config.roleModels?.[role]) && config.roleModels[role].length
      ? config.roleModels[role]
      : (config.roles?.[role]?.candidates || (config.roles?.[role]?.model ? [config.roles[role].model] : []))
    out[role] = list.filter((k) => config.models[k])
  }
  return out
}

/** 保存全局角色→模型矩阵（写回 agentline.config.json） */
export function saveRoleMatrix(configPath, config, matrix) {
  const next = { ...config, roleModels: {} }
  for (const role of ROLES) {
    const list = (matrix[role] || []).filter((k) => next.models[k])
    if (list.length) next.roleModels[role] = list
  }
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8')
  return next.roleModels
}

/** 模型目录（给 UI 下拉用） */
export function catalog(config) {
  return Object.entries(config.models || {}).map(([key, m]) => ({
    key,
    id: m.id,
    backend: m.backend || m.provider || null,
    pool: m.pool,
    family: m.family,
    rank: m.rank || {},
  }))
}

