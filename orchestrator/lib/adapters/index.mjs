/**
 * adapters/index.mjs — provider adapter 注册表
 *
 * 新增平台只需实现 { check, discover, run } 并在这里注册；
 * 核心调度器不感知具体平台参数。
 */
import { claude } from './claude.mjs'
import { codex } from './codex.mjs'
import { codebuddy } from './codebuddy.mjs'
import { gemini } from './gemini.mjs'
import { cursor } from './cursor.mjs'
import { cursorWsl } from './cursor-wsl.mjs'

export const ADAPTERS = {
  'claude-cli': claude,
  'codex-cli': codex,
  'codebuddy-cli': codebuddy,
  'gemini-cli': gemini,
  'cursor-agent': cursor,
  'cursor-wsl': cursorWsl,
}

export function getAdapter(providerCfg) {
  if (!providerCfg || !providerCfg.adapter) return null
  const factory = ADAPTERS[providerCfg.adapter]
  return factory ? factory(providerCfg) : null
}

export const ADAPTER_IDS = Object.keys(ADAPTERS)
